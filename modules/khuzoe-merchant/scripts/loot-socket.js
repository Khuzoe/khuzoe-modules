import { MODULE_ID, SOCKET_NAME } from "./constants.js";
import { planCurrencyTransfer } from "./currency-v2.js";
import { buildGroundLootTokenData, cleanGroundLootName, ensureGroundLootProxyActor, getGroundLoot, groundLootDistance } from "./ground-loot-data.js";
import { duplicate, isActorOwner, logError, primaryGM } from "./utils.js";
import { enqueueAuthoritativeRequest, requestTrackedOperation } from "./transaction-coordinator.js";
import { isInventoryActor, isInventoryToken, resolveActorToken, tokenRepresentsActor, groundMovementWaypoints } from "./map-object.js";
import {
  applyItemBundle,
  cleanTransferItemData,
  consumeSourceItem,
  itemStack,
  itemStackKey,
  prepareItemBundle,
  rollbackAppliedItems
} from "./item-transfer.js";

const DND5E_GROUND_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);

function emitResponse(request, operation, result) {
  if (!request.local) {
    game.socket.emit(SOCKET_NAME, {
      type: "ground-loot-" + operation + "-response",
      requestId: request.requestId,
      targetUserId: request.userId,
      ...result
    });
  }
  return result;
}

function fail(request, operation, errorKey, errorData = {}) {
  return emitResponse(request, operation, { ok: false, errorKey, errorData });
}

function cleanItemData(item, quantity, transfer = {}) {
  return cleanTransferItemData(item, { quantity, moduleFlag: "groundTransfer", flagData: transfer });
}

function validItemData(data) {
  return Boolean(data && typeof data === "object" && data.name && data.type);
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

function currencyIcon(currency) {
  const raw = String(currency?.icon || "").trim();
  if (raw.toLowerCase().startsWith("media/")) return "https://sigillo-api.khuzoe.workers.dev/" + raw;
  if (raw) return raw;
  const defaults = {
    pp: "icons/commodities/currency/coins-assorted-mix-platinum.webp",
    gp: "icons/commodities/currency/coins-plain-stack-gold.webp",
    ep: "icons/commodities/currency/coin-engraved-oval-steel.webp",
    sp: "icons/commodities/currency/coins-plain-stack-silver.webp",
    cp: "icons/commodities/currency/coins-wheat-stack-copper.webp"
  };
  return defaults[currency?.id] || "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp";
}

async function rollbackCreatedGroundToken(scene, token) {
  if (!token || !scene.tokens.get(token.id)) return;
  try {
    await scene.deleteEmbeddedDocuments("Token", [token.id], { khuzoeMerchantRollback: true });
  } catch (error) {
    logError("Ground loot rollback could not remove the Token", error);
  }
}

function verifyCreatedGroundToken(scene, token, loot) {
  const stored = getGroundLoot(token && scene.tokens.get(token.id));
  if (!stored || stored.dropId !== loot.dropId || stored.quantity !== loot.quantity
    || (loot.kind === "currency" && stored.amount !== loot.amount)
    || (loot.itemBundle && stored.itemBundle?.length !== loot.itemBundle.length)) {
    throw new Error("The ground loot was not stored completely.");
  }
}

async function processCurrencyDrop(request, user, scene, x, y) {
  const sourceActor = resolveSourceActor(request);
  if (!isInventoryActor(sourceActor) || !isActorOwner(sourceActor, user)) return fail(request, "drop", "KM.Errors.NotOwner");
  const transfer = planCurrencyTransfer(sourceActor, request.currencyId, request.amount, { direction: "withdraw" });
  if (!transfer.valid || !transfer.currency) return fail(request, "drop", "KM.GroundLoot.Errors.InvalidCurrency");
  if (!transfer.sufficient) return fail(request, "drop", "KM.GroundLoot.Errors.InsufficientCurrency");
  const label = transfer.currency.name || transfer.currency.symbol || transfer.currency.id;
  const loot = {
    schemaVersion: 2,
    kind: "currency",
    dropId: foundry.utils.randomID(24),
    name: String(transfer.amount) + " " + (transfer.currency.symbol || label),
    label,
    img: currencyIcon(transfer.currency),
    type: "currency",
    quantity: transfer.amount,
    amount: transfer.amount,
    currencyId: transfer.currency.id,
    droppedBy: user.id,
    droppedAt: new Date().toISOString()
  };
  const proxyActor = await ensureGroundLootProxyActor();
  if (!proxyActor) return fail(request, "drop", "KM.GroundLoot.Errors.DropFailed");
  const tokenData = buildGroundLootTokenData(scene, loot, { x, y, elevation: Number(request.elevation) || 0, actorId: proxyActor.id });
  let groundToken = null;
  try {
    const created = await scene.createEmbeddedDocuments("Token", [tokenData], { khuzoeMerchantGroundDrop: true });
    groundToken = created?.[0] || null;
    if (!groundToken) throw new Error("Foundry did not create the currency Token.");
    verifyCreatedGroundToken(scene, groundToken, loot);
    try {
      await applyCurrencyTransfer(sourceActor, transfer, { khuzoeMerchantGroundDrop: true });
    } catch (error) {
      await rollbackCreatedGroundToken(scene, groundToken);
      throw error;
    }
  } catch (error) {
    groundToken ||= Array.from(scene.tokens).find(token => getGroundLoot(token)?.dropId === loot.dropId);
    await rollbackCreatedGroundToken(scene, groundToken);
    logError("Ground currency drop failed", error);
    return fail(request, "drop", "KM.GroundLoot.Errors.DropFailed");
  }
  return emitResponse(request, "drop", {
    ok: true,
    lootId: groundToken.id,
    lootDocumentName: "Token",
    itemName: label,
    quantity: transfer.amount,
    copied: false
  });
}

async function processDrop(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "drop", "KM.Errors.UserUnavailable");
  if (user.viewedScene !== request.sceneId) return fail(request, "drop", "KM.Errors.SceneUnavailable");

  const scene = game.scenes.get(request.sceneId);
  const x = Number(request.x);
  const y = Number(request.y);
  if (!scene || !Number.isFinite(x) || !Number.isFinite(y)) {
    return fail(request, "drop", "KM.GroundLoot.Errors.InvalidPosition");
  }
  if (request.lootKind === "currency") return processCurrencyDrop(request, user, scene, x, y);

  const item = await resolveSourceItem(request);
  if (!item) return fail(request, "drop", "KM.GroundLoot.Errors.SourceUnavailable");
  if (game.system?.id === "dnd5e" && !DND5E_GROUND_ITEM_TYPES.has(String(item.type || "").toLowerCase())) {
    return fail(request, "drop", "KM.GroundLoot.Errors.NotDroppable");
  }

  const sourceActor = item.parent?.documentName === "Actor" ? item.parent : null;
  const consumeSource = Boolean(sourceActor);
  if (sourceActor && !isInventoryActor(sourceActor)) return fail(request, "drop", "KM.GroundLoot.Errors.InvalidTarget");
  if (sourceActor && !isActorOwner(sourceActor, user)) return fail(request, "drop", "KM.Errors.NotOwner");
  if (!sourceActor && !user.isGM) return fail(request, "drop", "KM.GroundLoot.Errors.DirectoryGmOnly");

  const stack = itemStack(item);
  const quantity = Number(request.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || (consumeSource && quantity > stack.total)) {
    return fail(request, "drop", "KM.GroundLoot.Errors.InvalidQuantity");
  }

  const dropId = foundry.utils.randomID(24);
  const droppedAt = new Date().toISOString();
  const transferData = {
    dropId,
    sourceKind: consumeSource ? "actor" : "template",
    sourceItemUuid: item.uuid || "",
    sourceActorUuid: sourceActor?.uuid || "",
    droppedBy: user.id,
    droppedAt
  };
  let itemBundle;
  try {
    itemBundle = await prepareItemBundle(item, { quantity, moduleFlag: "groundTransfer", flagData: transferData });
  } catch (error) {
    logError("Ground Item bundle preparation failed", error);
    return fail(request, "drop", "KM.GroundLoot.Errors.SourceUnavailable");
  }
  const itemData = itemBundle[0] || cleanItemData(item, quantity, transferData);
  itemData.name = cleanGroundLootName(itemData.name || item.name);
  if (!validItemData(itemData)) return fail(request, "drop", "KM.GroundLoot.Errors.SourceUnavailable");

  const loot = {
    schemaVersion: 2,
    dropId,
    name: cleanGroundLootName(item.name),
    img: String(item.img || "icons/svg/item-bag.svg"),
    type: String(item.type || "item").slice(0, 80),
    quantity,
    stackKey: itemStackKey(item),
    item: itemData,
    itemBundle,
    droppedBy: user.id,
    droppedAt
  };
  const proxyActor = await ensureGroundLootProxyActor();
  if (!proxyActor) return fail(request, "drop", "KM.GroundLoot.Errors.DropFailed");
  const tokenData = buildGroundLootTokenData(scene, loot, {
    x,
    y,
    elevation: Number(request.elevation) || 0,
    actorId: proxyActor.id
  });

  let groundToken = null;
  try {
    const created = await scene.createEmbeddedDocuments("Token", [tokenData], { khuzoeMerchantGroundDrop: true });
    groundToken = created?.[0] || null;
    if (!groundToken) throw new Error("Foundry did not create the ground loot Token.");
    verifyCreatedGroundToken(scene, groundToken, loot);

    if (consumeSource) {
      try {
        await consumeSourceItem(item, quantity, { khuzoeMerchantGroundDrop: true });
      } catch (error) {
        await rollbackCreatedGroundToken(scene, groundToken);
        if (error?.code === "PARTIAL_ITEM_CONTAINER") {
          return fail(request, "drop", "KM.Errors.ContainerWholeOnly");
        }
        throw error;
      }
    }
  } catch (error) {
    groundToken ||= Array.from(scene.tokens).find(token => getGroundLoot(token)?.dropId === loot.dropId);
    await rollbackCreatedGroundToken(scene, groundToken);
    logError("Ground loot drop failed", error);
    return fail(request, "drop", "KM.GroundLoot.Errors.DropFailed");
  }

  return emitResponse(request, "drop", {
    ok: true,
    lootId: groundToken.id,
    lootDocumentName: "Token",
    itemName: loot.name,
    quantity,
    copied: !consumeSource
  });
}

function resolveTargetToken(request) {
  const scene = game.scenes.get(request.targetSceneId || request.sceneId);
  return scene?.tokens?.get(request.targetTokenId) || null;
}

function resolveTargetActor(request, targetToken) {
  return targetToken?.actor || (request.targetActorId ? game.actors.get(request.targetActorId) : null) || null;
}

async function processTransfer(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "transfer", "KM.Errors.UserUnavailable");

  const item = await resolveSourceItem(request);
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  let targetToken = resolveTargetToken(request);
  const targetActor = resolveTargetActor(request, targetToken);
  if (!item || !sourceActor) return fail(request, "transfer", "KM.GroundLoot.Errors.SourceUnavailable");
  if (!isInventoryActor(sourceActor) || !isInventoryActor(targetActor)
    || (targetToken && !isInventoryToken(targetToken))) {
    return fail(request, "transfer", "KM.GroundLoot.Errors.InvalidTarget");
  }
  if (!isActorOwner(sourceActor, user)) return fail(request, "transfer", "KM.Errors.NotOwner");
  if (!user.isGM && !targetToken) targetToken = resolveActorToken(targetActor, game.scenes.get(user.viewedScene));
  const targetVisible = targetToken
    ? targetToken.parent?.id === user.viewedScene && (!targetToken.hidden || user.isGM)
    : Boolean(user.isGM || targetActor?.testUserPermission?.(user, "LIMITED"));
  const allowUnowned = Boolean(game.settings.get(MODULE_ID, "allowUnownedActorTransfers"));
  const targetAuthorized = user.isGM || isActorOwner(targetActor, user) || allowUnowned;
  if (!targetActor || !targetVisible || !targetAuthorized) {
    return fail(request, "transfer", "KM.GroundLoot.Errors.TargetPermission");
  }
  if (sourceActor.uuid === targetActor.uuid) return fail(request, "transfer", "KM.GroundLoot.Errors.SameActor");
  if (!user.isGM) {
    const scene = game.scenes.get(user.viewedScene);
    if (!targetToken || targetToken.parent?.id !== scene?.id || (request.sourceSceneId && request.sourceSceneId !== scene?.id)) {
      return fail(request, "transfer", "KM.GroundLoot.Errors.NoSourceToken");
    }
    const sourceToken = resolveActorToken(sourceActor, scene, { tokenId: request.sourceTokenId });
    const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "groundLootDistance")) || 0);
    if (!sourceToken || !tokenRepresentsActor(sourceToken, sourceActor)) {
      return fail(request, "transfer", "KM.GroundLoot.Errors.NoSourceToken");
    }
    if (groundLootDistance(sourceToken, targetToken) > maximum + 1e-6) {
      return fail(request, "transfer", "KM.GroundLoot.Errors.OutOfRange", {
        distance: maximum,
        unit: targetToken.parent?.grid?.units || ""
      });
    }
  }

  const sourceStack = itemStack(item);
  const quantity = Number(request.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > sourceStack.total) {
    return fail(request, "transfer", "KM.GroundLoot.Errors.InvalidQuantity");
  }

  const transferData = {
    sourceKind: "actor-transfer",
    sourceItemUuid: item.uuid || "",
    sourceActorUuid: sourceActor.uuid || "",
    targetActorUuid: targetActor.uuid || "",
    transferredBy: user.id,
    transferredAt: new Date().toISOString()
  };
  let itemBundle;
  try {
    itemBundle = await prepareItemBundle(item, { quantity, moduleFlag: "groundTransfer", flagData: transferData });
  } catch (error) {
    logError("Actor transfer bundle preparation failed", error);
    return fail(request, "transfer", "KM.GroundLoot.Errors.SourceUnavailable");
  }
  const itemData = itemBundle[0] || cleanItemData(item, quantity, transferData);
  itemData.name = cleanGroundLootName(itemData.name || item.name);
  if (!validItemData(itemData)) return fail(request, "transfer", "KM.GroundLoot.Errors.SourceUnavailable");

  let itemTransaction = { createdIds: [], updatedStacks: [] };
  try {
    itemTransaction = await applyItemBundle(targetActor, itemBundle, { khuzoeMerchantTransfer: true });

    try {
      await consumeSourceItem(item, quantity, { khuzoeMerchantTransfer: true });
    } catch (error) {
      await rollbackAppliedItems(targetActor, itemTransaction, { khuzoeMerchantRollback: true });
      throw error;
    }
  } catch (error) {
    logError("Actor-to-Actor Item transfer failed", error);
    return fail(request, "transfer", error?.code === "PARTIAL_ITEM_CONTAINER"
      ? "KM.Errors.ContainerWholeOnly"
      : "KM.GroundLoot.Errors.TransferFailed");
  }

  return emitResponse(request, "transfer", {
    ok: true,
    itemName: itemData.name,
    quantity,
    actorName: targetActor.name || ""
  });
}

async function processMove(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "move", "KM.Errors.UserUnavailable");
  const scene = game.scenes.get(request.sceneId);
  const token = resolveGroundLootDocument(scene, request);
  const loot = getGroundLoot(token);
  const waypoints = groundMovementWaypoints(request.waypoints || [{ x: request.x, y: request.y }]);
  if (!scene || user.viewedScene !== scene.id || !token || !loot || !waypoints) {
    return fail(request, "move", "KM.GroundLoot.Errors.InvalidPosition");
  }
  if (!user.isGM && (String(loot.droppedBy || "") !== user.id || token.hidden || game.paused)) {
    return fail(request, "move", "KM.Errors.NotOwner");
  }
  if (token.locked) return fail(request, "move", "KM.GroundLoot.Errors.MoveFailed");
  for (const point of waypoints) {
    if (point.level != null && !scene.levels?.get?.(point.level)) {
      return fail(request, "move", "KM.GroundLoot.Errors.InvalidPosition");
    }
  }
  try {
    if (typeof token.move === "function") {
      const completed = await token.move(waypoints, {
        khuzoeMerchantGroundMove: true,
        autoRotate: false,
        constrainOptions: {
          ignoreCost: true,
          ignoreWalls: Boolean(user.isGM && game.settings.get("core", "unconstrainedMovement"))
        }
      });
      if (!completed) throw new Error("Ground loot movement was stopped or prevented.");
    } else {
      const destination = waypoints.at(-1);
      await token.update(destination, { khuzoeMerchantGroundMove: true });
      if (token.x !== destination.x || token.y !== destination.y) throw new Error("Ground loot did not move.");
    }
  } catch (error) {
    logError("Ground loot move failed", error);
    return fail(request, "move", "KM.GroundLoot.Errors.MoveFailed");
  }
  return emitResponse(request, "move", { ok: true, lootId: token.id, x: token.x, y: token.y });
}
async function rollbackActorUpdate(actor, rollback, label) {
  try {
    await actor.update(rollback, { khuzoeMerchantRollback: true });
  } catch (error) {
    logError(label, error);
  }
}

async function applyCurrencyTransfer(actor, transfer, options) {
  try {
    await actor.update(transfer.update, options);
    for (const [path, value] of Object.entries(transfer.update)) {
      const actual = Number(foundry.utils.getProperty(actor, path));
      if (!Number.isFinite(actual) || Math.abs(actual - Number(value)) > 1e-7) {
        throw new Error("The currency transfer did not update the wallet.");
      }
    }
  } catch (error) {
    await rollbackActorUpdate(actor, transfer.rollback, "Ground currency verification rollback failed");
    throw error;
  }
}

function resolveGroundLootDocument(scene, request) {
  if (!scene) return null;
  const id = request.lootId || request.tokenId || request.tileId;
  if (!id) return null;
  if (request.lootDocumentName === "Tile") return scene.tiles.get(id) || null;
  if (request.lootDocumentName === "Token") return scene.tokens.get(id) || null;
  return scene.tokens.get(id) || scene.tiles.get(id) || null;
}

function roundedLootAmount(value) {
  return Math.max(0, Math.round((Number(value) || 0) * 10000) / 10000);
}

async function consumeGroundLootDocument(scene, groundDocument, loot, remaining) {
  const amount = roundedLootAmount(remaining);
  if (!(amount > 0)) {
    const collection = groundDocument.documentName === "Tile" ? scene.tiles : scene.tokens;
    const snapshot = groundDocument.toObject();
    try {
      await scene.deleteEmbeddedDocuments(groundDocument.documentName, [groundDocument.id], {
        khuzoeMerchantGroundPickup: true
      });
      if (collection.get(groundDocument.id)) throw new Error("Ground loot was not removed.");
    } catch (error) {
      if (!collection.get(groundDocument.id)) {
        try {
          await scene.createEmbeddedDocuments(groundDocument.documentName, [snapshot], { keepId: true, khuzoeMerchantRollback: true });
        } catch (rollbackError) {
          logError("Ground loot deletion rollback failed", rollbackError);
        }
      }
      throw error;
    }
    return true;
  }

  const previousLoot = duplicate(loot);
  const nextLoot = duplicate(loot);
  nextLoot.quantity = amount;
  if (nextLoot.kind === "currency") {
    nextLoot.amount = amount;
    nextLoot.name = `${amount} ${nextLoot.currencyId || nextLoot.label || ""}`.trim();
  } else if (foundry.utils.getProperty(nextLoot.item, "system.quantity") !== undefined) {
    foundry.utils.setProperty(nextLoot.item, "system.quantity", amount);
    if (Array.isArray(nextLoot.itemBundle) && nextLoot.itemBundle[0]) {
      foundry.utils.setProperty(nextLoot.itemBundle[0], "system.quantity", amount);
    }
  }
  const update = { [`flags.${MODULE_ID}.groundLoot`]: nextLoot };
  const previousName = groundDocument.name;
  if (groundDocument.documentName === "Token") update.name = cleanGroundLootName(nextLoot.name || loot.name);
  try {
    await groundDocument.update(update, { khuzoeMerchantGroundPickup: true });
    const remainingLoot = getGroundLoot(groundDocument);
    if (Number(remainingLoot?.quantity) !== amount
      || (loot.kind === "currency" && Number(remainingLoot?.amount) !== amount)) {
      throw new Error("Ground loot quantity was not consumed.");
    }
  } catch (error) {
    const rollback = { [`flags.${MODULE_ID}.groundLoot`]: previousLoot };
    if (groundDocument.documentName === "Token") rollback.name = previousName;
    try {
      await groundDocument.update(rollback, { khuzoeMerchantRollback: true });
    } catch (rollbackError) {
      logError("Ground loot quantity rollback failed", rollbackError);
    }
    throw error;
  }
  return false;
}

async function processPickup(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user?.isGM || electedGM?.id !== game.user.id) return;
  if (!senderUserId || request.userId !== senderUserId) return;
  const user = game.users.get(senderUserId);
  if (!user?.active) return fail(request, "pickup", "KM.Errors.UserUnavailable");
  if (user.viewedScene !== request.sceneId) return fail(request, "pickup", "KM.Errors.SceneUnavailable");

  const scene = game.scenes.get(request.sceneId);
  const groundDocument = resolveGroundLootDocument(scene, request);
  const buyerToken = scene?.tokens.get(request.buyerTokenId);
  const buyerActor = buyerToken?.actor || null;
  const loot = getGroundLoot(groundDocument);
  if (!scene || !groundDocument || !buyerToken || !buyerActor || !loot) {
    return fail(request, "pickup", "KM.GroundLoot.Errors.AlreadyTaken");
  }
  if (groundDocument.hidden && !user.isGM) return fail(request, "pickup", "KM.GroundLoot.Errors.AlreadyTaken");
  if (!isInventoryToken(buyerToken)) return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidTarget");
  if (!isActorOwner(buyerActor, user)) return fail(request, "pickup", "KM.Errors.NotOwner");

  const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "groundLootDistance")) || 0);
  if (groundLootDistance(buyerToken, groundDocument) > maximum + 1e-6) {
    return fail(request, "pickup", "KM.GroundLoot.Errors.OutOfRange", {
      distance: maximum,
      unit: scene.grid.units || ""
    });
  }

  if (loot.kind === "currency") {
    const available = roundedLootAmount(loot.amount ?? loot.quantity);
    const requestedAmount = roundedLootAmount(request.quantity);
    if (!(requestedAmount > 0) || requestedAmount > available + 0.0000001) {
      return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidQuantity");
    }
    const transfer = planCurrencyTransfer(buyerActor, loot.currencyId, requestedAmount, { direction: "deposit" });
    if (!transfer.valid || !transfer.currency) return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidCurrency");
    const remaining = roundedLootAmount(available - transfer.amount);
    let deleted = false;
    try {
      await applyCurrencyTransfer(buyerActor, transfer, { khuzoeMerchantGroundPickup: true });
      try {
        deleted = await consumeGroundLootDocument(scene, groundDocument, loot, remaining);
      } catch (error) {
        await rollbackActorUpdate(buyerActor, transfer.rollback, "Ground currency pickup rollback failed");
        throw error;
      }
    } catch (error) {
      logError("Ground currency pickup failed", error);
      return fail(request, "pickup", "KM.GroundLoot.Errors.PickupFailed");
    }
    return emitResponse(request, "pickup", {
      ok: true,
      itemName: loot.label || transfer.currency.name || transfer.currency.id,
      quantity: transfer.amount,
      remaining,
      deleted
    });
  }

  const storedBundle = Array.isArray(loot.itemBundle) && loot.itemBundle.length
    ? duplicate(loot.itemBundle)
    : [duplicate(loot.item)];
  const itemData = storedBundle[0];
  if (storedBundle.some(data => !validItemData(data))) return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidData");
  const available = Number(loot.quantity);
  const quantity = Number(request.quantity);
  if (!Number.isSafeInteger(available) || available < 1
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > available) {
    return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidQuantity");
  }
  // Keep every ID until applyItemBundle rebuilds the complete graph once.
  for (const data of storedBundle) {
    delete data.folder;
    delete data.sort;
    delete data.ownership;
    delete data._stats;
  }
  if (foundry.utils.getProperty(itemData, "system.container") !== undefined) {
    foundry.utils.setProperty(itemData, "system.container", null);
  }
  itemData.name = cleanGroundLootName(itemData.name || loot.name);
  itemData.flags ??= {};
  itemData.flags[MODULE_ID] = {
    ...(itemData.flags[MODULE_ID] ?? {}),
    groundTransfer: {
      ...(itemData.flags[MODULE_ID]?.groundTransfer ?? {}),
      pickedUpBy: user.id,
      pickedUpAt: new Date().toISOString()
    }
  };
  if (foundry.utils.getProperty(itemData, "system.quantity") !== undefined) {
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
  } else if (quantity !== 1) {
    return fail(request, "pickup", "KM.GroundLoot.Errors.InvalidQuantity");
  }
  if (storedBundle.length > 1 && quantity !== available) {
    return fail(request, "pickup", "KM.Errors.ContainerWholeOnly");
  }
  const itemBundle = storedBundle;
  const remaining = available - quantity;
  let itemTransaction = { createdIds: [], updatedStacks: [] };
  let deleted = false;
  try {
    itemTransaction = await applyItemBundle(buyerActor, itemBundle, { khuzoeMerchantGroundPickup: true });
    try {
      deleted = await consumeGroundLootDocument(scene, groundDocument, loot, remaining);
    } catch (error) {
      await rollbackAppliedItems(buyerActor, itemTransaction, { khuzoeMerchantRollback: true });
      throw error;
    }
  } catch (error) {
    logError("Ground loot pickup failed", error);
    return fail(request, "pickup", "KM.GroundLoot.Errors.PickupFailed");
  }

  return emitResponse(request, "pickup", {
    ok: true,
    itemName: cleanGroundLootName(loot.name || itemData.name),
    quantity,
    remaining,
    deleted,
    stacked: itemTransaction.updatedStacks.length > 0
  });
}
function handleSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;
  const processors = {
    "ground-loot-drop-request": ["drop", processDrop, "KM.GroundLoot.Errors.DropFailed"],
    "ground-loot-pickup-request": ["pickup", processPickup, "KM.GroundLoot.Errors.PickupFailed"],
    "ground-loot-transfer-request": ["transfer", processTransfer, "KM.GroundLoot.Errors.TransferFailed"],
    "ground-loot-move-request": ["move", processMove, "KM.GroundLoot.Errors.MoveFailed"]
  };
  const definition = processors[message.type];
  if (!definition || !senderUserId || message.userId !== senderUserId) return;
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return;
  const [operation, processor, errorKey] = definition;
  void enqueueAuthoritativeRequest({
    request: message,
    senderUserId,
    execute: () => processor(message, senderUserId),
    replay: (result) => emitResponse(message, operation, result),
    label: `ground ${operation} request`,
    failureResult: { ok: false, errorKey, errorData: {} }
  });
}

function requestOperation(operation, data) {
  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  const requestId = foundry.utils.randomID(20);
  const payload = {
    type: "ground-loot-" + operation + "-request",
    requestId,
    userId: game.user.id,
    ...data
  };
  if (gm.id === game.user.id) {
    payload.local = true;
    const processors = { drop: processDrop, pickup: processPickup, transfer: processTransfer, move: processMove };
    const processor = processors[operation];
    return enqueueAuthoritativeRequest({
      request: payload,
      senderUserId: game.user.id,
      execute: () => processor(payload, game.user.id),
      label: `local ground ${operation} request`,
      failureResult: {
        ok: false,
        errorKey: operation === "pickup" ? "KM.GroundLoot.Errors.PickupFailed" : operation === "transfer" ? "KM.GroundLoot.Errors.TransferFailed" : operation === "move" ? "KM.GroundLoot.Errors.MoveFailed" : "KM.GroundLoot.Errors.DropFailed",
        errorData: {}
      }
    });
  }
  const errorKey = operation === "pickup" ? "KM.GroundLoot.Errors.PickupFailed"
    : operation === "transfer" ? "KM.GroundLoot.Errors.TransferFailed"
      : operation === "move" ? "KM.GroundLoot.Errors.MoveFailed"
        : "KM.GroundLoot.Errors.DropFailed";
  return requestTrackedOperation(payload, { errorKey });
}

export function initializeLootSocket() {
  game.socket.on(SOCKET_NAME, handleSocketMessage);
}

export function requestDropCurrency({ sourceActor, currencyId, amount, scene, x, y }) {
  const sourceToken = resolveActorToken(sourceActor, scene, { controlled: globalThis.canvas?.tokens?.controlled || [] });
  return requestOperation("drop", {
    lootKind: "currency",
    sceneId: scene?.id,
    x: Number(x),
    y: Number(y),
    elevation: Number(sourceToken?.elevation) || 0,
    sourceActorId: sourceActor?.id || "",
    sourceSceneId: sourceToken?.parent?.id || "",
    sourceTokenId: sourceToken?.id || "",
    currencyId: String(currencyId || ""),
    amount: Number(amount)
  });
}

export function requestDropItem({ item, scene, x, y, quantity = 1 }) {
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  const sourceToken = resolveActorToken(sourceActor, scene, { controlled: globalThis.canvas?.tokens?.controlled || [] });
  return requestOperation("drop", {
    sceneId: scene?.id,
    x: Number(x),
    y: Number(y),
    elevation: Number(sourceToken?.elevation) || 0,
    itemUuid: item?.uuid || "",
    itemId: item?.id || "",
    sourceActorId: sourceActor?.id || "",
    sourceSceneId: sourceToken?.parent?.id || "",
    sourceTokenId: sourceToken?.id || "",
    quantity: Number(quantity)
  });
}

export function requestTransferItem({ item, targetToken, targetActor, quantity = 1 }) {
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  const scene = targetToken?.document?.parent || targetToken?.parent || globalThis.canvas?.scene;
  const sourceToken = resolveActorToken(sourceActor, scene, { controlled: globalThis.canvas?.tokens?.controlled || [] });
  targetToken ||= resolveActorToken(targetActor, scene, { controlled: globalThis.canvas?.tokens?.controlled || [] });
  return requestOperation("transfer", {
    itemUuid: item?.uuid || "",
    itemId: item?.id || "",
    sourceActorId: sourceActor?.id || "",
    sourceSceneId: sourceToken?.parent?.id || "",
    sourceTokenId: sourceToken?.id || "",
    targetSceneId: targetToken?.document?.parent?.id || targetToken?.parent?.id || "",
    targetTokenId: targetToken?.document?.id || targetToken?.id || "",
    targetActorId: targetActor?.id || targetToken?.actor?.id || "",
    quantity: Number(quantity)
  });
}

export function requestMoveLoot({ groundObject, x, y, waypoints }) {
  const document = groundObject?.document || groundObject;
  return requestOperation("move", {
    sceneId: document?.parent?.id || "",
    lootId: document?.id || "",
    lootDocumentName: document?.documentName,
    waypoints: groundMovementWaypoints(waypoints || [{ x, y }]),
    x: Number(x),
    y: Number(y)
  });
}
export function requestPickupLoot({ groundObject, tile, buyerToken, quantity = 1 }) {
  const document = groundObject?.document || groundObject || tile?.document || tile;
  return requestOperation("pickup", {
    sceneId: document?.parent?.id,
    lootId: document?.id,
    lootDocumentName: document?.documentName,
    buyerTokenId: buyerToken?.id,
    quantity: Number(quantity)
  });
}
