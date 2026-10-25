import { MODULE_ID, SOCKET_NAME } from "./constants.js";
import { containerDistance, containerIsEmpty, containerIsLocked, containerKeyMatches, getContainer, normalizeContainer } from "./container-data.js";
import { currencyById } from "./economy.js";
import { planCurrencyTransfer } from "./currency-v2.js";
import { duplicate, isActorOwner, itemDescription, logError, primaryGM } from "./utils.js";
import { enqueueAuthoritativeRequest, requestTrackedOperation } from "./transaction-coordinator.js";
import { getAuthoritativeContainer, saveAuthoritativeContainer } from "./container-store.js";
import { isInventoryActor, isInventoryToken } from "./map-object.js";
import {
  applyItemBundle,
  consumeSourceItem,
  itemStack,
  itemStackKey,
  prepareItemBundle,
  prepareStoredItemBundle,
  rollbackAppliedItems,
  rollbackConsumedSource
} from "./item-transfer.js";

let containerSocketInitialized = false;
const DND5E_CONTAINER_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);

function emitResponse(request, result) {
  if (!request.local) {
    game.socket.emit(SOCKET_NAME, {
      type: String(request.type || "container-take-request").replace(/-request$/, "-response"),
      requestId: request.requestId,
      targetUserId: request.userId,
      ...result
    });
  }
  return result;
}

function fail(request, errorKey, errorData = {}) {
  return emitResponse(request, { ok: false, errorKey, errorData });
}

function normalizedAmount(value, precision = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  const factor = 10 ** Math.max(0, Math.min(4, Math.floor(Number(precision) || 0)));
  return Math.round(number * factor) / factor;
}

function isAllowedItem(item) {
  return game.system?.id !== "dnd5e" || DND5E_CONTAINER_ITEM_TYPES.has(String(item?.type || "").toLowerCase());
}

async function resolveSourceItem(request) {
  if (request.itemUuid && typeof globalThis.fromUuid === "function") {
    try {
      const document = await globalThis.fromUuid(request.itemUuid);
      if (document?.documentName === "Item") return document;
    } catch (_error) {
      // Continue through safe ID-based fallbacks for synthetic Actors.
    }
  }
  if (request.sourceSceneId && request.sourceTokenId && request.itemId) {
    const tokenItem = game.scenes.get(request.sourceSceneId)?.tokens?.get(request.sourceTokenId)?.actor?.items?.get(request.itemId);
    if (tokenItem) return tokenItem;
  }
  if (request.sourceActorId && request.itemId) {
    const actorItem = game.actors.get(request.sourceActorId)?.items?.get(request.itemId);
    if (actorItem) return actorItem;
  }
  return request.itemId ? game.items?.get(request.itemId) || null : null;
}

function resolveSourceActor(request) {
  if (request.sourceSceneId && request.sourceTokenId) {
    const actor = game.scenes.get(request.sourceSceneId)?.tokens?.get(request.sourceTokenId)?.actor;
    if (actor) return actor;
  }
  return request.sourceActorId ? game.actors.get(request.sourceActorId) || null : null;
}

function validateSourceToken(scene, containerToken, sourceActor, user, request) {
  if (!isInventoryActor(sourceActor)) return { errorKey: "KM.Container.Errors.InvalidRecipient", errorData: {} };
  if (user.isGM) return null;
  const sourceToken = scene?.tokens?.get(request.sourceTokenId);
  if (!sourceToken?.actor || sourceToken.actor.uuid !== sourceActor?.uuid) {
    return { errorKey: "KM.Container.Errors.InvalidRecipient", errorData: {} };
  }
  const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "containerDistance")) || 0);
  if (containerDistance(sourceToken, containerToken) > maximum + 1e-6) {
    return {
      errorKey: "KM.Container.Errors.OutOfRange",
      errorData: { distance: maximum, unit: scene.grid?.units || "" }
    };
  }
  return null;
}

function requestedContents(container, request, user) {
  if (request.mode === "all") {
    return {
      items: container.inventory.map((entry) => ({ entry, quantity: entry.quantity })),
      currency: Object.entries(container.currency)
        .filter(([currencyId, amount]) => currencyById(currencyId, { includeInactive: Boolean(user?.isGM) }) && Number(amount) > 0)
        .map(([currencyId, amount]) => ({ currencyId, amount }))
    };
  }

  if (request.kind === "item") {
    const entry = container.inventory.find((candidate) => candidate.id === request.entryId);
    const quantity = Number(request.quantity);
    if (!entry) return { errorKey: "KM.Container.Errors.ItemUnavailable" };
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > entry.quantity) {
      return { errorKey: "KM.Container.Errors.InvalidQuantity" };
    }
    if (entry.dataBundleMode === "single" && entry.dataBundle?.length > 1 && quantity !== entry.quantity) {
      return { errorKey: "KM.Errors.ContainerWholeOnly" };
    }
    return { items: [{ entry, quantity }], currency: [] };
  }

  if (request.kind === "currency") {
    const currencyId = String(request.currencyId || "").toLowerCase();
    const stored = Number(container.currency[currencyId] || 0);
    const amount = Number(request.amount);
    if (!currencyById(currencyId, { includeInactive: Boolean(user?.isGM) }) || !(amount > 0) || amount > stored + 0.0000001) {
      return { errorKey: "KM.Container.Errors.CurrencyUnavailable" };
    }
    return { items: [], currency: [{ currencyId, amount }] };
  }

  return { errorKey: "KM.Container.Errors.InvalidRequest" };
}

async function prepareItemTransfers(items, user) {
  const transfers = [];
  for (const request of items) {
    const bundle = await prepareStoredItemBundle(request.entry, request.quantity, {
      moduleFlag: "containerTransfer",
      flagData: {
        containerEntryId: request.entry.id,
        takenBy: user.id,
        takenAt: new Date().toISOString()
      }
    });
    if (!bundle?.length || bundle.some((data) => !data?.name || !data?.type)) return null;
    transfers.push({ bundle, name: request.entry.name || bundle[0].name, quantity: request.quantity });
  }
  return transfers;
}

async function applyItemTransfers(actor, transfers) {
  const createdIds = [];
  const updatedStacks = [];
  try {
    for (const transfer of transfers) {
      const applied = await applyItemBundle(actor, transfer.bundle, { khuzoeMerchantContainerTake: true });
      createdIds.push(...applied.createdIds);
      updatedStacks.push(...applied.updatedStacks);
    }
    return { createdIds, updatedStacks };
  } catch (error) {
    await rollbackItemTransfers(actor, { createdIds, updatedStacks });
    throw error;
  }
}

async function rollbackItemTransfers(actor, transaction) {
  await rollbackAppliedItems(actor, transaction, { khuzoeMerchantRollback: true });
}

function planCurrencyDeposits(actor, currencyRequests) {
  const update = {};
  const rollback = {};
  const transfers = [];
  for (const request of currencyRequests) {
    const transfer = planCurrencyTransfer(actor, request.currencyId, request.amount, { direction: "deposit" });
    if (!transfer.valid || !transfer.currency) return null;
    for (const [path, next] of Object.entries(transfer.update)) {
      const previous = Number(transfer.rollback[path]) || 0;
      const delta = Number(next) - previous;
      if (!(path in rollback)) rollback[path] = previous;
      update[path] = (path in update ? Number(update[path]) : previous) + delta;
    }
    transfers.push({
      currencyId: transfer.currency.id,
      name: transfer.currency.name || transfer.currency.symbol || transfer.currency.id,
      symbol: transfer.currency.symbol || transfer.currency.id,
      amount: transfer.amount
    });
  }
  return { update, rollback, transfers };
}

function remainingContainer(container, selection) {
  const itemAmounts = new Map(selection.items.map(({ entry, quantity }) => [entry.id, quantity]));
  const currencyAmounts = new Map(selection.currency.map(({ currencyId, amount }) => [currencyId, amount]));
  const inventory = container.inventory
    .map((entry) => ({ ...entry, quantity: entry.quantity - (itemAmounts.get(entry.id) || 0) }))
    .filter((entry) => entry.quantity > 0);
  const currency = { ...container.currency };
  for (const [currencyId, amount] of currencyAmounts) {
    const remaining = Math.max(0, Math.round(((Number(currency[currencyId]) || 0) - amount) * 10000) / 10000);
    if (remaining > 0) currency[currencyId] = remaining;
    else delete currency[currencyId];
  }
  return normalizeContainer({ ...container, revision: container.revision + 1, inventory, currency });
}

async function containerWithDepositedItem(container, item, quantity, user, sourceActor) {
  const dataBundle = await prepareItemBundle(item, {
    quantity,
    moduleFlag: "containerDeposit",
    flagData: { depositedBy: user.id, depositedAt: new Date().toISOString() }
  });
  const data = dataBundle[0];
  const key = dataBundle.length === 1 ? itemStackKey(data) : null;
  const inventory = container.inventory.map((entry) => duplicate(entry));
  const existing = key ? inventory.find((entry) => itemStackKey(entry.data) === key) : null;
  if (existing) {
    existing.quantity += quantity;
    if (foundry.utils.getProperty(existing.data, "system.quantity") !== undefined) {
      foundry.utils.setProperty(existing.data, "system.quantity", existing.quantity);
    }
  } else {
    inventory.push({
      id: foundry.utils.randomID(12),
      sourceUuid: sourceActor ? "" : (item.uuid || ""),
      name: String(item.name || "Oggetto").slice(0, 120),
      img: item.img || "icons/svg/item-bag.svg",
      type: String(item.type || "item").slice(0, 60),
      description: itemDescription(item),
      quantity,
      sort: inventory.length,
      data,
      dataBundleMode: dataBundle.length > 1 ? "single" : "copies",
      dataBundle: dataBundle.length > 1 ? dataBundle : undefined
    });
  }
  return normalizeContainer({ ...container, revision: container.revision + 1, inventory });
}

function containerWithDepositedCurrency(container, currency, amount) {
  const currencyAmounts = { ...container.currency };
  currencyAmounts[currency.id] = normalizedAmount(
    (Number(currencyAmounts[currency.id]) || 0) + amount,
    currency.precision
  );
  return normalizeContainer({ ...container, revision: container.revision + 1, currency: currencyAmounts });
}

async function processContainerDeposit(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "KM.Errors.UserUnavailable");
  if (user.viewedScene !== request.sceneId) return fail(request, "KM.Errors.SceneUnavailable");

  const scene = game.scenes.get(request.sceneId);
  const containerToken = scene?.tokens?.get(request.containerTokenId);
  const container = await getAuthoritativeContainer(containerToken);
  if (!scene || !containerToken || !container) return fail(request, "KM.Container.Errors.Unavailable");
  if (containerToken.hidden && !user.isGM) return fail(request, "KM.Container.Errors.Unavailable");
  if (containerIsLocked(container) && !user.isGM) return fail(request, "KM.Container.Errors.Locked");

  if (request.kind === "currency") {
    const sourceActor = resolveSourceActor(request);
    if (!sourceActor || !isActorOwner(sourceActor, user)) return fail(request, "KM.Errors.NotOwner");
    const sourceError = validateSourceToken(scene, containerToken, sourceActor, user, request);
    if (sourceError) return fail(request, sourceError.errorKey, sourceError.errorData);
    const transfer = planCurrencyTransfer(sourceActor, request.currencyId, request.amount, { direction: "withdraw" });
    if (!transfer.valid || !transfer.currency) return fail(request, "KM.GroundLoot.Errors.InvalidCurrency");
    if (!transfer.sufficient) return fail(request, "KM.GroundLoot.Errors.InsufficientCurrency");
    const next = containerWithDepositedCurrency(container, transfer.currency, transfer.amount);
    try {
      await sourceActor.update(transfer.update, { khuzoeMerchantContainerDeposit: true });
      try {
        await saveAuthoritativeContainer(containerToken, next, {}, { khuzoeMerchantContainerDeposit: true });
      } catch (error) {
        try {
          await sourceActor.update(transfer.rollback, { khuzoeMerchantRollback: true });
        } catch (rollbackError) {
          logError("Container deposit currency rollback failed", rollbackError);
        }
        throw error;
      }
      return emitResponse(request, {
        ok: true,
        copied: false,
        actorName: sourceActor.name || "",
        itemName: transfer.currency.name || transfer.currency.symbol || transfer.currency.id,
        quantity: transfer.amount,
        revision: next.revision
      });
    } catch (error) {
      logError("Container currency deposit failed", error);
      return fail(request, "KM.Container.Errors.DepositFailed");
    }
  }

  if (request.kind !== "item") return fail(request, "KM.Container.Errors.InvalidRequest");
  const item = await resolveSourceItem(request);
  if (!item || !isAllowedItem(item)) return fail(request, "KM.Container.Errors.NotStorable");
  const sourceActor = item.parent?.documentName === "Actor" ? item.parent : null;
  if (sourceActor && !isActorOwner(sourceActor, user)) return fail(request, "KM.Errors.NotOwner");
  if (!sourceActor && !user.isGM) return fail(request, "KM.Errors.NotOwner");
  const sourceError = sourceActor ? validateSourceToken(scene, containerToken, sourceActor, user, request) : null;
  if (sourceError) return fail(request, sourceError.errorKey, sourceError.errorData);

  const stack = itemStack(item);
  const quantity = Number(request.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > stack.total) {
    return fail(request, "KM.Container.Errors.InvalidQuantity");
  }

  let next;
  try {
    next = await containerWithDepositedItem(container, item, quantity, user, sourceActor);
  } catch (error) {
    logError("Container Item bundle preparation failed", error);
    return fail(request, "KM.Container.Errors.InvalidData");
  }
  let sourceTransaction = { changed: false };
  try {
    if (sourceActor) {
      sourceTransaction = await consumeSourceItem(item, quantity, { khuzoeMerchantContainerDeposit: true });
    }
    try {
      await saveAuthoritativeContainer(containerToken, next, {}, { khuzoeMerchantContainerDeposit: true });
    } catch (error) {
      await rollbackConsumedSource(sourceTransaction, { khuzoeMerchantRollback: true });
      throw error;
    }
    return emitResponse(request, {
      ok: true,
      copied: !sourceActor,
      actorName: sourceActor?.name || "",
      itemName: String(item.name || "Oggetto"),
      quantity,
      revision: next.revision
    });
  } catch (error) {
    logError("Container Item deposit failed", error);
    return fail(request, error?.code === "PARTIAL_ITEM_CONTAINER"
      ? "KM.Errors.ContainerWholeOnly"
      : "KM.Container.Errors.DepositFailed");
  }
}

async function processContainerKey(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "KM.Errors.UserUnavailable");
  if (user.viewedScene !== request.sceneId) return fail(request, "KM.Errors.SceneUnavailable");

  const scene = game.scenes.get(request.sceneId);
  const containerToken = scene?.tokens?.get(request.containerTokenId);
  const container = await getAuthoritativeContainer(containerToken);
  if (!scene || !containerToken || !container) return fail(request, "KM.Container.Errors.Unavailable");
  if (containerToken.hidden && !user.isGM) return fail(request, "KM.Container.Errors.Unavailable");
  if (!container.key) return fail(request, "KM.Container.Errors.KeyNotConfigured");

  if (request.mode === "insert") {
    if (container.key.inserted) return fail(request, "KM.Container.Errors.KeyAlreadyInserted");
    const item = await resolveSourceItem(request);
    const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
    if (!item || !sourceActor) return fail(request, "KM.Container.Errors.KeyFromInventory");
    if (!isActorOwner(sourceActor, user)) return fail(request, "KM.Errors.NotOwner");
    const sourceError = validateSourceToken(scene, containerToken, sourceActor, user, request);
    if (sourceError) return fail(request, sourceError.errorKey, sourceError.errorData);
    if (!containerKeyMatches(item, container.key)) {
      return fail(request, "KM.Container.Errors.WrongKey");
    }

    const stack = itemStack(item);
    if (stack.total < 1) return fail(request, "KM.Container.Errors.InvalidQuantity");
    const insertedData = duplicate(item.toObject());
    if (foundry.utils.getProperty(insertedData, "system.quantity") !== undefined) {
      foundry.utils.setProperty(insertedData, "system.quantity", 1);
    }
    const identityId = String(container.key.identityId || foundry.utils.randomID(24));
    foundry.utils.setProperty(insertedData, `flags.${MODULE_ID}.keyIdentity`, identityId);
    const next = normalizeContainer({
      ...container,
      revision: container.revision + 1,
      key: { ...container.key, identityId, identityBound: true, inserted: true, insertedData }
    });
    let sourceTransaction = { changed: false };
    let containerUpdated = false;
    try {
      sourceTransaction = await consumeSourceItem(item, 1, { khuzoeMerchantContainerKey: true });

      const currentSourceItem = sourceActor.items?.get?.(item.id) || null;
      const sourceTransferConfirmed = sourceTransaction.deleted
        ? !currentSourceItem
        : Boolean(currentSourceItem && itemStack(currentSourceItem).total === sourceTransaction.remaining);
      if (!sourceTransferConfirmed) throw new Error("The key was not removed from its source inventory.");

      await saveAuthoritativeContainer(containerToken, next, {}, { khuzoeMerchantContainerKey: true });
      containerUpdated = true;
      return emitResponse(request, {
        ok: true,
        mode: "insert",
        actorName: sourceActor.name || "",
        keyName: container.key.name,
        remaining: sourceTransaction.remaining,
        revision: next.revision
      });
    } catch (error) {
      if (!containerUpdated) await rollbackConsumedSource(sourceTransaction, { khuzoeMerchantRollback: true });
      logError("Container key insertion failed", error);
      return fail(request, "KM.Container.Errors.KeyTransferFailed");
    }
  }

  if (request.mode !== "remove") return fail(request, "KM.Container.Errors.InvalidRequest");
  if (!container.key.inserted) return fail(request, "KM.Container.Errors.KeyNotInserted");
  const buyerToken = scene.tokens.get(request.buyerTokenId);
  const buyerActor = buyerToken?.actor || null;
  if (!buyerToken || !buyerActor || getContainer(buyerToken)) return fail(request, "KM.Container.Errors.InvalidRecipient");
  if (buyerToken.hidden && !user.isGM) return fail(request, "KM.Container.Errors.Unavailable");
  if (!isInventoryToken(buyerToken)) return fail(request, "KM.Container.Errors.InvalidRecipient");
  if (!isActorOwner(buyerActor, user)) return fail(request, "KM.Errors.NotOwner");
  const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "containerDistance")) || 0);
  if (!user.isGM && containerDistance(buyerToken, containerToken) > maximum + 1e-6) {
    return fail(request, "KM.Container.Errors.OutOfRange", { distance: maximum, unit: scene.grid?.units || "" });
  }

  const keyData = duplicate(container.key.insertedData || container.key.data || {});
  if (!keyData.name || !keyData.type) return fail(request, "KM.Container.Errors.InvalidData");
  delete keyData._id;
  delete keyData.folder;
  delete keyData.sort;
  delete keyData.ownership;
  delete keyData._stats;
  if (foundry.utils.getProperty(keyData, "system.quantity") !== undefined) {
    foundry.utils.setProperty(keyData, "system.quantity", 1);
  }
  if (foundry.utils.getProperty(keyData, "system.container") !== undefined) {
    foundry.utils.setProperty(keyData, "system.container", null);
  }
  keyData.flags ??= {};
  keyData.flags[MODULE_ID] ??= {};
  keyData.flags[MODULE_ID].keyIdentity = String(container.key.identityId || "");
  keyData.flags[MODULE_ID] = {
    ...(keyData.flags[MODULE_ID] || {}),
    containerKey: {
      schemaVersion: 1,
      containerTokenUuid: containerToken.uuid || "",
      returnedBy: user.id,
      returnedAt: new Date().toISOString()
    }
  };
  const next = normalizeContainer({
    ...container,
    revision: container.revision + 1,
    key: { ...container.key, inserted: false, insertedData: null }
  });
  let createdKey = null;
  let rolledBack = false;
  try {
    const created = await buyerActor.createEmbeddedDocuments(
      "Item",
      [keyData],
      { khuzoeMerchantContainerKey: true }
    );
    createdKey = created?.[0] || null;
    const receivedKey = createdKey ? buyerActor.items?.get?.(createdKey.id) : null;
    if (!createdKey || !receivedKey || itemStack(receivedKey).total < 1) {
      throw new Error("The returned key is not present in the recipient inventory.");
    }
    try {
      await saveAuthoritativeContainer(containerToken, next, {}, { khuzoeMerchantContainerKey: true });
    } catch (error) {
      await buyerActor.deleteEmbeddedDocuments("Item", [createdKey.id], { khuzoeMerchantRollback: true });
      rolledBack = true;
      throw error;
    }
    return emitResponse(request, {
      ok: true,
      mode: "remove",
      actorName: buyerActor.name || "",
      keyName: container.key.name,
      itemId: createdKey.id,
      revision: next.revision
    });
  } catch (error) {
    if (!rolledBack && createdKey?.id) {
      try {
        await buyerActor.deleteEmbeddedDocuments("Item", [createdKey.id], { khuzoeMerchantRollback: true });
      } catch (rollbackError) {
        logError("Returned key rollback failed", rollbackError);
      }
    }
    logError("Container key removal failed", error);
    return fail(request, "KM.Container.Errors.KeyTransferFailed");
  }
}

async function processContainerTake(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "KM.Errors.UserUnavailable");
  if (user.viewedScene !== request.sceneId) return fail(request, "KM.Errors.SceneUnavailable");

  const scene = game.scenes.get(request.sceneId);
  const containerToken = scene?.tokens?.get(request.containerTokenId);
  const buyerToken = scene?.tokens?.get(request.buyerTokenId);
  const buyerActor = buyerToken?.actor || null;
  const container = await getAuthoritativeContainer(containerToken);
  if (!scene || !containerToken || !buyerToken || !buyerActor || !container) {
    return fail(request, "KM.Container.Errors.Unavailable");
  }
  if (buyerToken.id === containerToken.id || !isInventoryToken(buyerToken)) {
    return fail(request, "KM.Container.Errors.InvalidRecipient");
  }
  if ((containerToken.hidden || buyerToken.hidden) && !user.isGM) return fail(request, "KM.Container.Errors.Unavailable");
  if (containerIsLocked(container) && !user.isGM) return fail(request, "KM.Container.Errors.Locked");
  if (!isActorOwner(buyerActor, user)) return fail(request, "KM.Errors.NotOwner");

  const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "containerDistance")) || 0);
  if (!user.isGM && containerDistance(buyerToken, containerToken) > maximum + 1e-6) {
    return fail(request, "KM.Container.Errors.OutOfRange", { distance: maximum, unit: scene.grid.units || "" });
  }

  const selection = requestedContents(container, request, user);
  if (selection.errorKey) return fail(request, selection.errorKey);
  if (!selection.items.length && !selection.currency.length) return fail(request, "KM.Container.Errors.Empty");

  const itemTransfers = await prepareItemTransfers(selection.items, user);
  const currencyPlan = planCurrencyDeposits(buyerActor, selection.currency);
  if (!itemTransfers || !currencyPlan) return fail(request, "KM.Container.Errors.InvalidData");

  let itemTransaction = { createdIds: [], updatedStacks: [] };
  let currencyApplied = false;
  let rolledBack = false;
  try {
    itemTransaction = await applyItemTransfers(buyerActor, itemTransfers);
    if (Object.keys(currencyPlan.update).length) {
      await buyerActor.update(currencyPlan.update, { khuzoeMerchantContainerTake: true });
      currencyApplied = true;
    }

    const next = remainingContainer(container, selection);
    try {
      if (containerIsEmpty(next) && next.emptyBehavior === "delete") {
        await scene.deleteEmbeddedDocuments("Token", [containerToken.id], { khuzoeMerchantContainerTake: true });
      } else {
        await saveAuthoritativeContainer(containerToken, next, {}, { khuzoeMerchantContainerTake: true });
      }
    } catch (error) {
      if (currencyApplied) {
        try {
          await buyerActor.update(currencyPlan.rollback, { khuzoeMerchantRollback: true });
        } catch (rollbackError) {
          logError("Container currency rollback failed", rollbackError);
        }
      }
      await rollbackItemTransfers(buyerActor, itemTransaction);
      rolledBack = true;
      throw error;
    }

    return emitResponse(request, {
      ok: true,
      deleted: containerIsEmpty(next) && next.emptyBehavior === "delete",
      actorName: buyerActor.name || "",
      items: itemTransfers.map((item) => ({ name: item.name, quantity: item.quantity })),
      currency: currencyPlan.transfers
    });
  } catch (error) {
    if (!rolledBack) {
      if (currencyApplied) {
        try {
          await buyerActor.update(currencyPlan.rollback, { khuzoeMerchantRollback: true });
        } catch (rollbackError) {
          logError("Container currency rollback failed", rollbackError);
        }
      }
      await rollbackItemTransfers(buyerActor, itemTransaction);
    }
    logError("Container take failed", error);
    return fail(request, "KM.Container.Errors.TransferFailed");
  }
}

function handleContainerSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;
  const requestProcessor = message.type === "container-take-request"
    ? processContainerTake
    : message.type === "container-deposit-request"
      ? processContainerDeposit
      : message.type === "container-key-request"
        ? processContainerKey
        : null;
  if (requestProcessor) {
    if (!senderUserId || message.userId !== senderUserId) return;
    const gm = primaryGM();
    if (!game.user?.isGM || gm?.id !== game.user.id) return;
    const errorKey = message.type === "container-take-request"
      ? "KM.Container.Errors.TransferFailed"
      : message.type === "container-key-request"
        ? "KM.Container.Errors.KeyTransferFailed"
        : "KM.Container.Errors.DepositFailed";
    void enqueueAuthoritativeRequest({
      request: message,
      senderUserId,
      execute: () => requestProcessor(message, senderUserId),
      replay: (result) => emitResponse(message, result),
      label: message.type,
      failureResult: { ok: false, errorKey, errorData: {} }
    });
    return;
  }
}
export function initializeContainerSocket() {
  if (containerSocketInitialized) return;
  containerSocketInitialized = true;
  game.socket.on(SOCKET_NAME, handleContainerSocketMessage);
}

export function requestContainerTake({ containerToken, buyerToken, mode = "single", kind = "item", entryId = "", currencyId = "", quantity = 1, amount = 0 }) {
  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  const document = containerToken?.document || containerToken;
  const requestId = foundry.utils.randomID(20);
  const payload = {
    type: "container-take-request",
    requestId,
    userId: game.user.id,
    sceneId: document?.parent?.id || "",
    containerTokenId: document?.id || "",
    buyerTokenId: buyerToken?.document?.id || buyerToken?.id || "",
    mode,
    kind,
    entryId: String(entryId || ""),
    currencyId: String(currencyId || ""),
    quantity: Number(quantity),
    amount: Number(amount)
  };

  if (gm.id === game.user.id) {
    payload.local = true;
    return enqueueAuthoritativeRequest({
      request: payload,
      senderUserId: game.user.id,
      execute: () => processContainerTake(payload, game.user.id),
      label: "local container take",
      failureResult: { ok: false, errorKey: "KM.Container.Errors.TransferFailed", errorData: {} }
    });
  }
  return requestTrackedOperation(payload, { errorKey: "KM.Container.Errors.TransferFailed" });
}
export function requestContainerDeposit({
  containerToken,
  kind = "item",
  item = null,
  currencyId = "",
  quantity = 1,
  amount = 0,
  sourceActorId = "",
  sourceSceneId = "",
  sourceTokenId = "",
  sourceToken = null
}) {
  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  const document = containerToken?.document || containerToken;
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  const actorToken = sourceActor?.token || null;
  const explicitSourceToken = sourceToken?.document || sourceToken || null;
  const requestId = foundry.utils.randomID(20);
  const payload = {
    type: "container-deposit-request",
    requestId,
    userId: game.user.id,
    sceneId: document?.parent?.id || "",
    containerTokenId: document?.id || "",
    kind,
    itemUuid: item?.uuid || "",
    itemId: item?.id || "",
    sourceActorId: sourceActor?.id || String(sourceActorId || ""),
    sourceSceneId: explicitSourceToken?.parent?.id || actorToken?.parent?.id || String(sourceSceneId || ""),
    sourceTokenId: explicitSourceToken?.id || actorToken?.id || String(sourceTokenId || ""),
    currencyId: String(currencyId || ""),
    quantity: kind === "item" ? Number(quantity) : 0,
    amount: kind === "currency" ? Number(amount) : 0
  };

  if (gm.id === game.user.id) {
    payload.local = true;
    return enqueueAuthoritativeRequest({
      request: payload,
      senderUserId: game.user.id,
      execute: () => processContainerDeposit(payload, game.user.id),
      label: "local container deposit",
      failureResult: { ok: false, errorKey: "KM.Container.Errors.DepositFailed", errorData: {} }
    });
  }
  return requestTrackedOperation(payload, { errorKey: "KM.Container.Errors.DepositFailed" });
}
export function requestContainerKey({ containerToken, mode, item = null, sourceToken = null, buyerToken = null }) {
  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  const document = containerToken?.document || containerToken;
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  const actorToken = sourceActor?.token || null;
  const explicitSourceToken = sourceToken?.document || sourceToken || null;
  const requestId = foundry.utils.randomID(20);
  const payload = {
    type: "container-key-request",
    requestId,
    userId: game.user.id,
    sceneId: document?.parent?.id || "",
    containerTokenId: document?.id || "",
    buyerTokenId: buyerToken?.document?.id || buyerToken?.id || "",
    mode: String(mode || ""),
    itemUuid: item?.uuid || "",
    itemId: item?.id || "",
    sourceActorId: sourceActor?.id || "",
    sourceSceneId: explicitSourceToken?.parent?.id || actorToken?.parent?.id || "",
    sourceTokenId: explicitSourceToken?.id || actorToken?.id || ""
  };

  if (gm.id === game.user.id) {
    payload.local = true;
    return enqueueAuthoritativeRequest({
      request: payload,
      senderUserId: game.user.id,
      execute: () => processContainerKey(payload, game.user.id),
      label: "local container key",
      failureResult: { ok: false, errorKey: "KM.Container.Errors.KeyTransferFailed", errorData: {} }
    });
  }
  return requestTrackedOperation(payload, { errorKey: "KM.Container.Errors.KeyTransferFailed" });
}
