import { DEFAULT_CONTAINER, MODULE_ID } from "./constants.js";
import { buildContainerTokenData, containerIsLocked, getContainer } from "./container-data.js";
import { ContainerConfig } from "./container-config.js";
import { ContainerSheet, rememberContainerBuyerToken } from "./container-sheet.js";
import { initializeContainerSocket, requestContainerDeposit, requestContainerKey } from "./container-socket.js";
import { currencyById } from "./economy.js";
import { ensureGroundLootProxyActor } from "./ground-loot-data.js";
import { promptQuantity } from "./quantity-dialog.js";
import { duplicate, isActorOwner, itemDescription, localize, logError, notifyError, primaryGM, refreshMerchantEntry } from "./utils.js";
import { enqueueTransaction } from "./transaction-coordinator.js";
import { prepareItemBundle } from "./item-transfer.js";
import { getAuthoritativeContainer, saveAuthoritativeContainer } from "./container-store.js";
import { rerenderApplication } from "./foundry-compat.js";

let placementState = null;

function tokenDocument(value) {
  return value?.document || value || null;
}

function containerTokenAtPoint(x, y) {
  const tokens = Array.from(globalThis.canvas?.tokens?.placeables || []).reverse();
  return tokens.find((token) => {
    if (!getContainer(token) || (token.document?.hidden && !game.user?.isGM)) return false;
    const bounds = token.bounds || token.getBounds?.();
    return Boolean(bounds?.contains?.(x, y));
  }) || null;
}

function itemQuantity(item) {
  const raw = foundry.utils.getProperty(item, "system.quantity");
  const quantity = Number(typeof raw === "object" ? raw?.value : raw);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

function actorTokenForDrop(actor, data = {}) {
  const directId = String(data.sourceTokenId || actor?.token?.id || "");
  if (directId) {
    const direct = canvas?.tokens?.get?.(directId);
    if (direct?.actor?.uuid === actor?.uuid) return direct;
  }
  const candidates = Array.from(canvas?.tokens?.placeables || []).filter((token) => token.actor?.uuid === actor?.uuid);
  return candidates.find((token) => token.controlled) || candidates[0] || null;
}

function currencySourceToken(data) {
  const direct = data?.sourceTokenId ? canvas?.tokens?.get?.(data.sourceTokenId) : null;
  if (direct?.actor) return direct;
  const actorId = String(data?.sourceActorId || "");
  return Array.from(canvas?.tokens?.placeables || []).find((token) => token.actor?.id === actorId) || null;
}

async function notifyContainerDeposit(result, containerToken) {
  if (!result.ok) {
    notifyError(result.errorKey || "KM.Container.Errors.DepositFailed", result.errorData || {});
    return false;
  }
  ui.notifications.info(localize(result.copied ? "KM.Container.DepositCopied" : "KM.Container.Deposited", {
    quantity: result.quantity,
    item: result.itemName,
    actor: result.actorName,
    container: getContainer(containerToken)?.name || ""
  }));
  return true;
}

function refreshActorInventory(actor) {
  if (!actor) return;
  rerenderApplication(actor.sheet);
  globalThis.setTimeout?.(() => rerenderApplication(actor.sheet), 150);
}

export async function handleContainerCanvasItemDrop(canvasInstance, data, item) {
  const x = Number(data?.x);
  const y = Number(data?.y);
  const target = containerTokenAtPoint(x, y);
  if (!target) return false;
  const container = getContainer(target);
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  if (sourceActor && !isActorOwner(sourceActor)) {
    notifyError("KM.Errors.NotOwner");
    return true;
  }
  if (!sourceActor && !game.user?.isGM) {
    notifyError("KM.Container.Errors.KeyFromInventory");
    return true;
  }
  const sourceToken = sourceActor ? actorTokenForDrop(sourceActor, data) : null;

  if (containerIsLocked(container)) {
    const result = await requestContainerKey({
      containerToken: target,
      sourceToken,
      item,
      mode: "insert"
    });
    if (!result.ok) {
      notifyError(result.errorKey || "KM.Container.Errors.KeyTransferFailed", result.errorData || {});
      return true;
    }
    ui.notifications.info(localize("KM.Container.KeyInsertedOpened", { key: result.keyName, container: container.name }));
    refreshActorInventory(sourceToken?.actor || sourceActor);
    await ContainerSheet.openForToken(target, { buyerToken: sourceToken });
    return true;
  }

  const quantity = await promptQuantity({
    itemName: item?.name || "Oggetto",
    maximum: itemQuantity(item),
    precision: 0,
    mode: "deposit"
  });
  if (quantity === null) return true;
  const result = await requestContainerDeposit({ containerToken: target, sourceToken, item, kind: "item", quantity });
  await notifyContainerDeposit(result, target);
  return true;
}

export async function handleContainerCanvasCurrencyDrop(canvasInstance, data) {
  const x = Number(data?.x);
  const y = Number(data?.y);
  const target = containerTokenAtPoint(x, y);
  if (!target) return false;
  const container = getContainer(target);
  if (containerIsLocked(container)) {
    notifyError("KM.Container.Errors.Locked");
    return true;
  }
  const currency = currencyById(data?.currencyId, { includeInactive: false });
  const amount = Number(data?.amount);
  const sourceToken = currencySourceToken(data);
  if (!currency || !(amount > 0) || (!sourceToken && !game.user?.isGM)) {
    notifyError("KM.GroundLoot.Errors.InvalidCurrency");
    return true;
  }
  const selected = await promptQuantity({
    itemName: currency.name || currency.symbol || currency.id,
    maximum: amount,
    precision: currency.precision,
    mode: "deposit"
  });
  if (selected === null) return true;
  const result = await requestContainerDeposit({
    containerToken: target,
    sourceToken,
    kind: "currency",
    currencyId: currency.id,
    amount: selected,
    sourceActorId: data.sourceActorId,
    sourceSceneId: data.sourceSceneId,
    sourceTokenId: data.sourceTokenId
  });
  await notifyContainerDeposit(result, target);
  return true;
}

function eventCanvasPosition(event) {
  if (typeof event?.data?.getLocalPosition === "function") return event.data.getLocalPosition(canvas.stage);
  const global = event?.global || event?.data?.global;
  if (global && typeof canvas?.stage?.toLocal === "function") return canvas.stage.toLocal(global);
  return null;
}

function cancelContainerPlacement({ silent = false } = {}) {
  if (!placementState) return;
  const { stage, pointerHandler, keyHandler, previousCursor } = placementState;
  stage?.off?.("pointerdown", pointerHandler);
  document.removeEventListener("keydown", keyHandler, true);
  if (stage) stage.cursor = previousCursor;
  placementState = null;
  if (!silent) ui.notifications.info(localize("KM.Container.PlacementCancelled"));
}

export async function createContainerAt(scene, x, y) {
  if (!game.user?.isGM || !scene || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    notifyError("KM.Container.Errors.InvalidPosition");
    return null;
  }
  const proxyActor = await ensureGroundLootProxyActor();
  if (!proxyActor) {
    notifyError("KM.Container.Errors.CreateFailed");
    return null;
  }
  const initial = duplicate(DEFAULT_CONTAINER);
  const tokenData = buildContainerTokenData(scene, initial, { x: Number(x), y: Number(y), actorId: proxyActor.id });
  try {
    const created = await scene.createEmbeddedDocuments("Token", [tokenData], { khuzoeMerchantContainerCreate: true });
    const document = created?.[0] || null;
    if (!document) throw new Error("Foundry did not create the container Token.");
    const placeable = canvas?.tokens?.get?.(document.id);
    placeable?.control?.({ releaseOthers: true });
    await ContainerConfig.openForToken(document);
    return document;
  } catch (error) {
    logError("Container creation failed", error);
    notifyError("KM.Container.Errors.CreateFailed");
    return null;
  }
}

function beginContainerPlacement() {
  if (!game.user?.isGM || !canvas?.ready || !canvas?.scene || !canvas?.stage) {
    notifyError("KM.Container.Errors.SceneUnavailable");
    return;
  }
  cancelContainerPlacement({ silent: true });
  const scene = canvas.scene;
  const stage = canvas.stage;
  const previousCursor = stage.cursor;

  const keyHandler = (event) => {
    if (event.key === "Escape") cancelContainerPlacement();
  };
  const pointerHandler = async (event) => {
    if (event.button !== undefined && event.button !== 0) {
      cancelContainerPlacement();
      return;
    }
    const point = eventCanvasPosition(event);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || canvas.scene?.id !== scene.id) {
      cancelContainerPlacement({ silent: true });
      notifyError("KM.Container.Errors.InvalidPosition");
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    cancelContainerPlacement({ silent: true });
    await createContainerAt(scene, point.x, point.y);
  };

  placementState = { stage, pointerHandler, keyHandler, previousCursor };
  stage.cursor = "crosshair";
  stage.on("pointerdown", pointerHandler);
  document.addEventListener("keydown", keyHandler, true);
  ui.notifications.info(localize("KM.Container.PlacementHint"));
}

function addContainerSceneControl(controls) {
  if (!game.user?.isGM) return;
  const tokenControls = Array.isArray(controls)
    ? controls.find((control) => control.name === "token")
    : controls?.tokens || controls?.token;
  if (!tokenControls) return;
  if (Array.isArray(tokenControls.tools)) {
    const tool = {
      name: "khuzoe-container-create",
      title: localize("KM.Container.CreateTool"),
      icon: "fas fa-box-open",
      button: true,
      onClick: beginContainerPlacement
    };
    if (!tokenControls.tools.some((candidate) => candidate.name === tool.name)) tokenControls.tools.push(tool);
  } else if (tokenControls.tools && typeof tokenControls.tools === "object") {
    const name = "khuzoe-container-create";
    if (tokenControls.tools[name]) return;
    tokenControls.tools[name] = {
      name,
      title: localize("KM.Container.CreateTool"),
      icon: "fa-solid fa-box-open",
      order: Object.keys(tokenControls.tools).length,
      button: true,
      visible: true,
      onChange: beginContainerPlacement
    };
  }
}

function patchContainerTokenClass(tokenClass) {
  const prototype = tokenClass?.prototype;
  if (!prototype) return;
  for (const methodName of ["_canView", "_canHover"]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._khuzoeContainerPatched) continue;
    const patched = function khuzoeContainerPermission(user, event) {
      if (getContainer(this)) return true;
      return original.call(this, user, event);
    };
    patched._khuzoeContainerPatched = true;
    patched._khuzoeContainerOriginal = original;
    prototype[methodName] = patched;
  }

  const originalLeftClick = prototype._onClickLeft;
  if (typeof originalLeftClick === "function" && !originalLeftClick._khuzoeContainerPatched) {
    const patchedLeftClick = function khuzoeContainerLeftClick(event) {
      if (getContainer(this)) rememberContainerBuyerToken();
      return originalLeftClick.call(this, event);
    };
    patchedLeftClick._khuzoeContainerPatched = true;
    patchedLeftClick._khuzoeContainerOriginal = originalLeftClick;
    prototype._onClickLeft = patchedLeftClick;
  }

  const originalDoubleClick = prototype._onClickLeft2;
  if (typeof originalDoubleClick === "function" && !originalDoubleClick._khuzoeContainerPatched) {
    const patchedDoubleClick = async function khuzoeContainerDoubleClick(event) {
      const container = getContainer(this);
      if (container) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (game.user?.isGM) {
          await ContainerConfig.openForToken(tokenDocument(this));
          return true;
        }
        return ContainerSheet.openForToken(this);
      }
      return originalDoubleClick.call(this, event);
    };
    patchedDoubleClick._khuzoeContainerPatched = true;
    patchedDoubleClick._khuzoeContainerOriginal = originalDoubleClick;
    prototype._onClickLeft2 = patchedDoubleClick;
  }
}

function patchContainerInteractions() {
  const TokenClass = globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.foundry?.canvas?.placeables?.Token;
  const classes = new Set([TokenClass].filter(Boolean));
  for (const tokenClass of classes) patchContainerTokenClass(tokenClass);
}

export async function synchronizeContainerSourceItem(item) {
  ContainerConfig.refreshForItem(item);
  ContainerSheet.refreshForDocument(item);
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return 0;
  return enqueueTransaction(async () => {
    let updated = 0;
    const preparedBundle = await prepareItemBundle(item, { quantity: 1 });
    const dataBundle = preparedBundle.length > 1 ? preparedBundle : undefined;
    for (const scene of game.scenes || []) {
      for (const token of scene.tokens || []) {
        const visible = getContainer(token);
        if (!visible || !(visible.sourceUuids || []).includes(item.uuid)) continue;
        const current = await getAuthoritativeContainer(token);
        const updatesInventory = current?.inventory.some((entry) => entry.sourceUuid === item.uuid);
        const updatesProduction = current?.production?.rules?.some((rule) => rule.sourceUuid === item.uuid);
        if (!updatesInventory && !updatesProduction) continue;
        const inventory = await Promise.all(current.inventory.map(async (entry) => {
          if (entry.sourceUuid !== item.uuid) return entry;
          return {
            ...(await refreshMerchantEntry(entry, item)),
            dataBundle: dataBundle ? duplicate(dataBundle) : undefined
          };
        }));
        const production = duplicate(current.production);
        production.rules = production.rules.map((rule) => {
          if (rule.sourceUuid !== item.uuid) return rule;
          return {
            ...rule,
            name: String(item.name ?? rule.name ?? "Item").slice(0, 120),
            img: item.img || rule.img || "icons/svg/item-bag.svg",
            type: String(item.type ?? rule.type ?? "item").slice(0, 60),
            description: itemDescription(item),
            data: duplicate(item.toObject()),
            dataBundle: dataBundle ? duplicate(dataBundle) : undefined
          };
        });
        const next = { ...current, schemaVersion: 2, revision: current.revision + 1, inventory, production };
        try {
          await saveAuthoritativeContainer(token, next, {}, { khuzoeMerchantContainerSourceSync: true });
          updated += 1;
        } catch (error) {
          logError("Container source Item synchronization failed", { token: token.id, error });
        }
      }
    }
    return updated;
  }, "container source synchronization");
}

export function registerContainers() {
  game.settings.register(MODULE_ID, "containerDistance", {
    name: "KM.Container.Settings.Distance.Name",
    hint: "KM.Container.Settings.Distance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });
  game.settings.register(MODULE_ID, "containerViewMode", {
    name: "KM.Container.Settings.View.Name",
    hint: "KM.Container.Settings.View.Hint",
    scope: "client",
    config: false,
    type: String,
    choices: { list: "KM.Shop.ViewList", full: "KM.Shop.ViewFull" },
    default: "list"
  });
  patchContainerInteractions();
  Hooks.on("getSceneControlButtons", addContainerSceneControl);
  Hooks.on("canvasTearDown", () => cancelContainerPlacement({ silent: true }));
}

export function initializeContainers() {
  initializeContainerSocket();
}

export function containerApi() {
  return {
    create: createContainerAt,
    configure: (token) => ContainerConfig.openForToken(tokenDocument(token)),
    open: ContainerSheet.openForToken,
    get: getContainer
  };
}
