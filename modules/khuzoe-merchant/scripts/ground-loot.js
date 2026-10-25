import { MODULE_ID } from "./constants.js";
import { handleContainerCanvasCurrencyDrop, handleContainerCanvasItemDrop } from "./container.js";
import { ensureGroundLootProxyActor, getGroundLoot, groundLootDistance, legacyTileTokenData } from "./ground-loot-data.js";
import { currencyById } from "./economy.js";
import { readWallet } from "./currency-v2.js";
import { initializeLootSocket, requestDropCurrency, requestDropItem, requestMoveLoot, requestPickupLoot, requestTransferItem } from "./loot-socket.js";
import { promptQuantity } from "./quantity-dialog.js";
import { DialogV2 } from "./foundry-compat.js";
import { isActorOwner, localize, logError, notifyError, primaryGM } from "./utils.js";
import { asDocument, isMapObject, isInventoryActor, isInventoryToken, groundDragWaypoints } from "./map-object.js";
import { enqueueTransaction } from "./transaction-coordinator.js";
import { groundLootContainerPreview, confirmGroundContainerPickup } from "./ground-loot-preview.js";

const DND5E_GROUND_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
let lastDragIntent = { altKey: false, at: 0 };
let preferredBuyer = null;

function rememberDragIntent(event) {
  lastDragIntent = { altKey: Boolean(event.altKey), at: Date.now() };
}

function isCurrencyDragData(data) {
  return String(data?.type || "") === "KhuzoeCurrency";
}

function itemDropSelection(item) {
  const raw = foundry.utils.getProperty(item, "system.quantity");
  const value = Number(typeof raw === "object" ? raw?.value : raw);
  const total = Number.isSafeInteger(value) && value > 0 ? value : 1;
  const dropOne = lastDragIntent.altKey && (Date.now() - lastDragIntent.at) < 10_000;
  lastDragIntent = { altKey: false, at: 0 };
  return { total, dropOne };
}

async function chooseItemQuantity(item, mode = "deposit") {
  const { total, dropOne } = itemDropSelection(item);
  if (dropOne || total <= 1) return 1;
  return promptQuantity({
    itemName: cleanGroundItemName(item?.name || "Oggetto"),
    maximum: total,
    precision: 0,
    mode
  });
}

function resolveCurrencySourceActor(data) {
  if (data?.sourceSceneId && data?.sourceTokenId) {
    const actor = game.scenes.get(data.sourceSceneId)?.tokens?.get(data.sourceTokenId)?.actor;
    if (actor) return actor;
  }
  return data?.sourceActorId ? game.actors.get(data.sourceActorId) || null : null;
}

function isGroundDroppableItem(item) {
  return game.system?.id !== "dnd5e" || DND5E_GROUND_ITEM_TYPES.has(String(item?.type || "").toLowerCase());
}

function isItemDragData(data) {
  const type = String(data?.type || data?.documentName || "");
  if (type === "Item") return true;
  const uuid = String(data?.uuid || data?.documentUuid || "");
  return uuid.includes(".Item.") || uuid.startsWith("Item.");
}

async function resolveDroppedItem(data) {
  const uuid = String(data?.uuid || data?.documentUuid || "").trim();
  if (uuid && typeof globalThis.fromUuid === "function") {
    try {
      const document = await globalThis.fromUuid(uuid);
      if (document?.documentName === "Item") return document;
    } catch (_error) {
      // The authoritative GM-side request performs the same lookup and validation.
    }
  }

  const itemId = data?.id || data?.itemId || data?.data?._id;
  if (data?.pack && itemId) {
    try {
      const document = await game.packs.get(data.pack)?.getDocument(itemId);
      if (document?.documentName === "Item") return document;
    } catch (_error) {
      // Fall through to world and Actor Items.
    }
  }
  if (data?.actorId && itemId) {
    const actorItem = game.actors.get(data.actorId)?.items?.get(itemId);
    if (actorItem) return actorItem;
  }
  return itemId ? game.items?.get(itemId) || null : null;
}

export function selectGroundLootBuyer() {
  if (!canvas?.ready) return { token: null, errorKey: "KM.GroundLoot.Errors.NoBuyerToken" };
  const selected = (canvas.tokens.controlled || []).filter((token) => isInventoryToken(token) && isActorOwner(token.actor));
  if (!selected.length) return { token: null, errorKey: "KM.GroundLoot.Errors.NoBuyerToken" };
  if (selected.length > 1) return { token: null, errorKey: "KM.GroundLoot.Errors.MultipleBuyerTokens" };
  return { token: selected[0], errorKey: "" };
}

function rememberPreferredBuyerToken(groundObject) {
  const document = asDocument(groundObject);
  const selection = selectGroundLootBuyer();
  // Preserve the first click's selection only for the second click of this object.
  if (!selection.token && selection.errorKey.endsWith("NoBuyerToken")
    && preferredBuyer?.lootId === document?.id && preferredBuyer?.sceneId === document?.parent?.id
    && Date.now() - preferredBuyer.at < 1000) return;
  preferredBuyer = {
    tokenId: selection.token?.id,
    errorKey: selection.errorKey,
    sceneId: document?.parent?.id,
    lootId: document?.id,
    at: Date.now()
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function actorTokenAtPoint(x, y, sourceActor) {
  const tokens = Array.from(globalThis.canvas?.tokens?.placeables || []).reverse();
  return tokens.find((token) => {
    if (!isInventoryToken(token) || (token.document?.hidden && !game.user?.isGM)) return false;
    if (sourceActor && token.actor?.uuid === sourceActor.uuid) return false;
    const bounds = token.bounds || token.getBounds?.();
    return Boolean(bounds?.contains?.(x, y));
  }) || null;
}

async function confirmActorTransfer(item, target, quantity, { declineDrops = true } = {}) {
  const itemName = escapeHtml(cleanGroundItemName(item?.name || "Oggetto"));
  const actorName = escapeHtml(target?.actor?.name || target?.name || "questo Actor");
  return DialogV2.confirm({
    window: { title: "Dare l'oggetto?", icon: "fa-solid fa-hand-holding" },
    content: `<p>Vuoi dare <strong>${quantity}× ${itemName}</strong> a <strong>${actorName}</strong>?</p><p>${declineDrops ? "Scegliendo No, l'oggetto verrà lasciato a terra." : "Scegliendo No, gli inventari resteranno invariati."}</p>`,
    yes: { default: true },
    rejectClose: false
  });
}

function cleanGroundItemName(value) {
  return String(value || "").replace(/\s*\(Copy\)\s*$/i, "").trim();
}
async function handleCanvasItemDrop(canvasInstance, data) {
  const scene = canvasInstance?.scene || globalThis.canvas?.scene;
  const x = Number(data?.x);
  const y = Number(data?.y);
  if (!scene || !Number.isFinite(x) || !Number.isFinite(y)) {
    notifyError("KM.GroundLoot.Errors.InvalidPosition");
    return false;
  }

  const item = await resolveDroppedItem(data);
  if (!item) {
    notifyError("KM.GroundLoot.Errors.SourceUnavailable");
    return false;
  }
  if (await handleContainerCanvasItemDrop(canvasInstance, data, item)) return true;
  if (!isGroundDroppableItem(item)) {
    notifyError("KM.GroundLoot.Errors.NotDroppable");
    return false;
  }

  const sourceActor = item.parent?.documentName === "Actor" ? item.parent : null;
  if (sourceActor && !isInventoryActor(sourceActor)) {
    notifyError("KM.GroundLoot.Errors.InvalidTarget");
    return false;
  }
  if (sourceActor && !isActorOwner(sourceActor)) {
    notifyError("KM.Errors.NotOwner");
    return false;
  }
  if (!sourceActor && !game.user?.isGM) {
    notifyError("KM.GroundLoot.Errors.DirectoryGmOnly");
    return false;
  }

  const quantity = await chooseItemQuantity(item, "deposit");
  if (quantity === null) return false;
  const targetToken = sourceActor ? actorTokenAtPoint(x, y, sourceActor) : null;
  if (targetToken && await confirmActorTransfer(item, targetToken, quantity)) {
    const transfer = await requestTransferItem({ item, targetToken, quantity });
    if (!transfer.ok) {
      notifyError(transfer.errorKey || "KM.GroundLoot.Errors.TransferFailed", transfer.errorData);
      return false;
    }
    ui.notifications.info(localize("KM.GroundLoot.Transferred", {
      quantity: transfer.quantity,
      item: transfer.itemName,
      actor: transfer.actorName
    }));
    return true;
  }

  const result = await requestDropItem({ item, scene, x, y, quantity });
  if (!result.ok) {
    notifyError(result.errorKey || "KM.GroundLoot.Errors.DropFailed", result.errorData);
    return false;
  }
  ui.notifications.info(localize("KM.GroundLoot.Dropped", {
    quantity: result.quantity,
    item: result.itemName
  }));
  return true;
}

async function handleActorSheetItemDrop(targetActor, data) {
  const item = await resolveDroppedItem(data);
  const sourceActor = item?.parent?.documentName === "Actor" ? item.parent : null;
  if (!item || !sourceActor || sourceActor.uuid === targetActor?.uuid) return false;
  if (!isInventoryActor(sourceActor) || !isInventoryActor(targetActor)) return false;
  if (!isActorOwner(sourceActor)) {
    notifyError("KM.Errors.NotOwner");
    return false;
  }
  const quantity = await chooseItemQuantity(item, "deposit");
  if (quantity === null) return false;
  const confirmed = await confirmActorTransfer(item, targetActor, quantity, { declineDrops: false });
  if (!confirmed) return false;
  const result = await requestTransferItem({ item, targetActor, quantity });
  if (!result.ok) {
    notifyError(result.errorKey || "KM.GroundLoot.Errors.TransferFailed", result.errorData);
    return false;
  }
  ui.notifications.info(localize("KM.GroundLoot.Transferred", {
    quantity: result.quantity,
    item: result.itemName,
    actor: result.actorName
  }));
  return true;
}

function itemDragSourceActorId(data) {
  const direct = String(data?.actorId || data?.parentId || "").trim();
  if (direct) return direct;
  const uuid = String(data?.uuid || data?.documentUuid || "");
  return uuid.match(/(?:^|\.)Actor\.([^.]+)\.Item\./)?.[1] || "";
}

function onDropActorSheetData(actor, _sheet, data) {
  if (!isItemDragData(data)) return;
  const sourceActorId = itemDragSourceActorId(data);
  if (!sourceActorId || sourceActorId === actor?.id) return;
  void handleActorSheetItemDrop(actor, data);
  return false;
}
async function handleCanvasCurrencyDrop(canvasInstance, data) {
  const scene = canvasInstance?.scene || globalThis.canvas?.scene;
  const x = Number(data?.x);
  const y = Number(data?.y);
  const sourceActor = resolveCurrencySourceActor(data);
  const currency = currencyById(data?.currencyId, { includeInactive: true });
  const balance = sourceActor ? Number(readWallet(sourceActor, { includeInactive: true })[currency?.id]) || 0 : 0;
  const amount = Number(data?.amount);
  if (!scene || !Number.isFinite(x) || !Number.isFinite(y)) {
    notifyError("KM.GroundLoot.Errors.InvalidPosition");
    return false;
  }
  if (await handleContainerCanvasCurrencyDrop(canvasInstance, data)) return true;
  if (!sourceActor || !currency || !isActorOwner(sourceActor) || !(amount > 0) || amount > balance) {
    notifyError("KM.GroundLoot.Errors.InvalidCurrency");
    return false;
  }
  const selectedAmount = await promptQuantity({
    itemName: currency.name || currency.symbol || currency.id,
    maximum: amount,
    precision: currency.precision,
    mode: "deposit"
  });
  if (selectedAmount === null) return false;
  const result = await requestDropCurrency({
    sourceActor,
    currencyId: currency.id,
    amount: selectedAmount,
    scene,
    x,
    y
  });
  if (!result.ok) {
    notifyError(result.errorKey || "KM.GroundLoot.Errors.DropFailed", result.errorData);
    return false;
  }
  ui.notifications.info(localize("KM.GroundLoot.Dropped", { quantity: result.quantity, item: result.itemName }));
  return true;
}

function onDropCanvasData(canvasInstance, data) {
  if (isCurrencyDragData(data)) {
    void handleCanvasCurrencyDrop(canvasInstance, data);
    return false;
  }
  if (!isItemDragData(data)) return;
  void handleCanvasItemDrop(canvasInstance, data);
  return false;
}

export async function openGroundLoot(groundObject) {
  const loot = getGroundLoot(groundObject);
  if (!loot) return false;
  const selection = selectGroundLootBuyer();
  let buyerToken = selection.token;
  const document = asDocument(groundObject);
  const remembered = preferredBuyer;
  preferredBuyer = null;
  if (!buyerToken && selection.errorKey === "KM.GroundLoot.Errors.NoBuyerToken"
    && remembered?.sceneId === document?.parent?.id && remembered?.lootId === document?.id
    && Date.now() - remembered.at < 1500) {
    const preferred = canvas?.tokens?.get?.(remembered.tokenId);
    if (isInventoryToken(preferred) && isActorOwner(preferred.actor)) buyerToken = preferred;
    else if (remembered.errorKey) selection.errorKey = remembered.errorKey;
  }
  if (!buyerToken) {
    notifyError(selection.errorKey);
    return false;
  }
  if (document.hidden && !game.user?.isGM) {
    notifyError("KM.GroundLoot.Errors.AlreadyTaken");
    return false;
  }
  const pickupDistance = Math.max(0, Number(game.settings.get(MODULE_ID, "groundLootDistance")) || 0);
  if (groundLootDistance(buyerToken, document) > pickupDistance + 1e-6) {
    notifyError("KM.GroundLoot.Errors.OutOfRange", {distance: pickupDistance, unit: document.parent?.grid?.units || ""});
    return false;
  }
  const currency = loot.kind === "currency"
    ? currencyById(loot.currencyId, { includeInactive: true })
    : null;
  const maximum = Number(loot.kind === "currency" ? (loot.amount ?? loot.quantity) : loot.quantity) || 1;
  const preview = groundLootContainerPreview(loot);
  if (preview && !await confirmGroundContainerPickup(preview, maximum)) return false;
  // A filled D&D5e container is already transferred as a complete bundle by
  // the GM. Do not offer a partial quantity which that validation would reject.
  const quantity = preview?.wholeBundle ? maximum : await promptQuantity({
    itemName: loot.label || loot.name || "Oggetto",
    maximum,
    precision: currency?.precision || 0,
    mode: "take"
  });
  if (quantity === null) return false;
  const result = await requestPickupLoot({ groundObject, buyerToken, quantity });
  if (!result.ok) {
    notifyError(result.errorKey || "KM.GroundLoot.Errors.PickupFailed", result.errorData);
    return false;
  }
  ui.notifications.info(localize("KM.GroundLoot.PickedUp", {
    quantity: result.quantity,
    item: result.itemName,
    actor: buyerToken.actor?.name || ""
  }));
  buyerToken.control?.({ releaseOthers: true });
  return true;
}

function canMoveGroundLoot(groundObject, user = game.user) {
  const loot = getGroundLoot(groundObject);
  return Boolean(loot && (user?.isGM || (user?.id && String(loot.droppedBy || "") === user.id)));
}
export function patchGroundLootPlaceableClass(placeableClass) {
  const prototype = placeableClass?.prototype;
  if (!prototype) return;
  for (const methodName of ["_canView", "_canHover"]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._khuzoeGroundLootPatched) continue;
    const patched = function khuzoeGroundLootPermission(user, event) {
      if (getGroundLoot(this)) return !this.document?.hidden || Boolean(user?.isGM);
      return original.call(this, user, event);
    };
    patched._khuzoeGroundLootPatched = true;
    patched._khuzoeGroundLootOriginal = original;
    prototype[methodName] = patched;
  }
  for (const methodName of ["_canControl", "_canDrag", "_canUpdate"]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._khuzoeGroundLootPatched) continue;
    const patched = function khuzoeGroundLootMovePermission(user, event) {
      if (getGroundLoot(this)) {
        if (!canMoveGroundLoot(this, user) || (this.document?.hidden && !user?.isGM)) return false;
        if (methodName === "_canControl") {
          return this.layer?.active !== false && !canvas?.regions?._placementContext
            && !this.layer?._draggedToken && !canvas?.controls?.ruler?.active
            && !(globalThis.CONFIG?.Canvas?.rulerClass?.canMeasure && event?.type === "pointerdown");
        }
        if (methodName === "_canDrag") return this.controlled && !this.document?.locked
          && !canvas?.regions?._placementContext && game.activeTool === "select" && (user?.isGM || !game.paused);
        return true;
      }
      return original.call(this, user, event);
    };
    patched._khuzoeGroundLootPatched = true;
    patched._khuzoeGroundLootOriginal = original;
    prototype[methodName] = patched;
  }

  const originalLeftClick = prototype._onClickLeft;
  if (typeof originalLeftClick === "function" && !originalLeftClick._khuzoeGroundLootPatched) {
    const patchedLeftClick = function khuzoeGroundLootLeftClick(event) {
      if (getGroundLoot(this)) rememberPreferredBuyerToken(this);
      return originalLeftClick.call(this, event);
    };
    patchedLeftClick._khuzoeGroundLootPatched = true;
    patchedLeftClick._khuzoeGroundLootOriginal = originalLeftClick;
    prototype._onClickLeft = patchedLeftClick;
  }

  const originalDragDrop = prototype._onDragLeftDrop;
  if (typeof originalDragDrop === "function" && !originalDragDrop._khuzoeGroundLootPatched) {
    const patchedDragDrop = async function khuzoeGroundLootDragDrop(event) {
      if (!getGroundLoot(this)) return originalDragDrop.call(this, event);
      const interaction = event.interactionData;
      if (!interaction.dropped && this._shouldPreventDragLeftDrop?.(event)) {
        interaction.released = true;
        event.preventDefault?.();
        return;
      }
      interaction.dropped = true;
      interaction.clearPreviewContainer = false;
      try {
        if (!canMoveGroundLoot(this) || interaction.cancelled) return false;
        const prepared = this._prepareDragLeftDropUpdates?.(event);
        const waypoints = groundDragWaypoints(prepared, this.document?.id);
        if (!waypoints) return false;
        const result = await requestMoveLoot({ groundObject: this, waypoints });
        if (!result.ok) notifyError(result.errorKey || "KM.GroundLoot.Errors.MoveFailed", result.errorData);
      } catch (error) {
        logError("Ground loot drag failed", error);
        notifyError("KM.GroundLoot.Errors.MoveFailed");
      } finally {
        this.layer?.clearPreviewContainer?.();
      }
      return false;
    };
    patchedDragDrop._khuzoeGroundLootPatched = true;
    patchedDragDrop._khuzoeGroundLootOriginal = originalDragDrop;
    prototype._onDragLeftDrop = patchedDragDrop;
  }
  const originalConstrain = prototype._getDragConstrainOptions;
  if (typeof originalConstrain === "function" && !originalConstrain._khuzoeGroundLootPatched) {
    const patched = function (...args) {
      const options = originalConstrain.apply(this, args);
      return getGroundLoot(this) ? { ...options, ignoreCost: true } : options;
    };
    patched._khuzoeGroundLootPatched = true;
    prototype._getDragConstrainOptions = patched;
  }
  const originalDoubleClick = prototype._onClickLeft2;
  if (typeof originalDoubleClick === "function" && !originalDoubleClick._khuzoeGroundLootPatched) {
    const patchedDoubleClick = async function khuzoeGroundLootDoubleClick(event) {
      if (getGroundLoot(this)) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return openGroundLoot(this);
      }
      return originalDoubleClick.call(this, event);
    };
    patchedDoubleClick._khuzoeGroundLootPatched = true;
    patchedDoubleClick._khuzoeGroundLootOriginal = originalDoubleClick;
    prototype._onClickLeft2 = patchedDoubleClick;
  }
}

function patchGroundLootInteractions() {
  const TokenClass = globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.foundry?.canvas?.placeables?.Token;
  const TileClass = globalThis.foundry?.canvas?.placeables?.Tile
    ?? globalThis.CONFIG?.Tile?.objectClass;
  const classes = new Set([
    TokenClass,
    TileClass
  ].filter(Boolean));
  for (const placeableClass of classes) patchGroundLootPlaceableClass(placeableClass);
}

async function migrateGroundLootTokensToProxyActor(proxyActor) {
  if (!proxyActor) return 0;
  let migrated = 0;
  for (const scene of game.scenes || []) {
    const updates = Array.from(scene.tokens || [])
      .filter((token) => getGroundLoot(token) && token.actorId !== proxyActor.id)
      .map((token) => ({ _id: token.id, actorId: proxyActor.id, actorLink: false }));
    if (!updates.length) continue;
    try {
      await scene.updateEmbeddedDocuments("Token", updates, { khuzoeMerchantGroundMigration: true });
      migrated += updates.length;
    } catch (error) {
      logError("Ground loot proxy Actor migration failed", { scene: scene.name, error });
    }
  }
  return migrated;
}
async function migrateGroundLootInfrastructure() {
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return 0;
  const proxyActor = await ensureGroundLootProxyActor();
  if (!proxyActor) return 0;
  let migrated = await migrateGroundLootTokensToProxyActor(proxyActor);
  for (const scene of game.scenes || []) {
    const legacyTiles = Array.from(scene.tiles || []).filter((tile) => getGroundLoot(tile));
    for (const tile of legacyTiles) {
      try {
        const tokenData = legacyTileTokenData(scene, tile, { actorId: proxyActor.id });
        if (!tokenData) continue;
        const created = await scene.createEmbeddedDocuments("Token", [tokenData], { khuzoeMerchantGroundMigration: true });
        const createdToken = created?.[0];
        if (!createdToken) continue;
        try {
          await scene.deleteEmbeddedDocuments("Tile", [tile.id], { khuzoeMerchantGroundMigration: true });
        } catch (error) {
          try {
            await scene.deleteEmbeddedDocuments("Token", [createdToken.id], { khuzoeMerchantRollback: true });
          } catch (rollbackError) {
            logError("Ground loot migration rollback failed", { scene: scene.name, token: createdToken.id, rollbackError });
          }
          throw error;
        }
        migrated += 1;
      } catch (error) {
        logError("Ground loot legacy Tile migration failed", { scene: scene.name, tile: tile.id, error });
      }
    }
  }
  return migrated;
}

/** Explicit maintenance only. A preview never updates a scene or its Actor. */
export async function migrateGroundLootTokenSettings({ apply = false } = {}) {
  if (!game.user?.isGM || primaryGM()?.id !== game.user.id) return { ok: false, changes: [] };
  return enqueueTransaction(async () => {
    const changes = [];
    for (const scene of game.scenes || []) {
      const updates = [];
      for (const token of scene.tokens || []) {
        if (!isMapObject(token)) continue;
        const update = { _id: token.id };
        if (token.displayBars !== CONST.TOKEN_DISPLAY_MODES.NONE) update.displayBars = CONST.TOKEN_DISPLAY_MODES.NONE;
        for (const bar of ["bar1", "bar2"]) {
          if (token[bar]?.attribute != null) update[`${bar}.attribute`] = null;
        }
        if (Object.keys(update).length > 1) updates.push(update);
      }
      if (!updates.length) continue;
      changes.push({ sceneId: scene.id, updates });
      if (apply) await scene.updateEmbeddedDocuments("Token", updates, { khuzoeMerchantGroundMigration: true });
    }
    return { ok: true, applied: apply, changes };
  }, "ground loot token settings maintenance");
}

export function registerGroundLoot() {
  game.settings.register(MODULE_ID, "groundLootDistance", {
    name: "KM.GroundLoot.Settings.Distance.Name",
    hint: "KM.GroundLoot.Settings.Distance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });
  game.settings.register(MODULE_ID, "groundLootScale", {
    name: "KM.GroundLoot.Settings.Scale.Name",
    hint: "KM.GroundLoot.Settings.Scale.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0.72,
    range: { min: 0.35, max: 1.25, step: 0.05 }
  });
  patchGroundLootInteractions();
  document.addEventListener("dragstart", rememberDragIntent, true);
  Hooks.on("dropCanvasData", onDropCanvasData);
  Hooks.on("dropActorSheetData", onDropActorSheetData);
  Hooks.on("canvasReady", () => { preferredBuyer = null; });
}

export function initializeGroundLoot() {
  initializeLootSocket();
  void migrateGroundLootInfrastructure();
}

export function groundLootApi() {
  return {
    drop: handleCanvasItemDrop,
    open: openGroundLoot,
    get: getGroundLoot,
    tokenSettings: migrateGroundLootTokenSettings,
    migrateLegacyTiles: migrateGroundLootInfrastructure
  };
}
