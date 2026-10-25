import { isMapObject, isInventoryToken } from "./map-object.js";
import { logError } from "./utils.js";
import { MODULE_ID } from "./constants.js";

const registeredLibWrappers = new WeakMap();

function wrap(target, name, handler, { path, type = "MIXED" } = {}) {
  const original = target?.[name];
  if (typeof original !== "function" || original._khuzoeMapObject) return;
  if (path && typeof globalThis.libWrapper?.register === "function") {
    if (registeredLibWrappers.get(target)?.has(name)) return;
    globalThis.libWrapper.register(MODULE_ID, path, handler, type);
    const registered = registeredLibWrappers.get(target) || new Set();
    registered.add(name);
    registeredLibWrappers.set(target, registered);
    return;
  }
  const patched = function (...args) { return handler.call(this, original, ...args); };
  patched._khuzoeMapObject = true;
  target[name] = patched;
}

export function patchObjectTokenDocument(documentClass) {
  // Applies to old tokens too, without updating their stored bars or Actor data.
  wrap(documentClass?.prototype, "getBarAttribute", function (original, ...args) {
    // Always continue the chain so Bar Brawl and other bar providers can coexist.
    const result = original.apply(this, args);
    return isMapObject(this) ? null : result;
  }, {
    path: documentClass === globalThis.CONFIG?.Token?.documentClass
      ? "CONFIG.Token.documentClass.prototype.getBarAttribute" : null,
    type: "WRAPPER"
  });
}

export function patchObjectTokenPlaceable(tokenClass) {
  wrap(tokenClass?.prototype, "setTarget", function (original, targeted, ...args) {
    if (targeted && isMapObject(this)) return;
    return original.call(this, targeted, ...args);
  }, {
    path: tokenClass === globalThis.CONFIG?.Token?.objectClass
      ? "CONFIG.Token.objectClass.prototype.setTarget" : null
  });
}

export function patchHealthEstimate(provider) {
  wrap(provider, "breakCondition", function (original, token, ...args) {
    return isMapObject(token) || original.call(this, token, ...args);
  });
}

export function patchActionHud(api) {
  const utils = api?.Utils || api?.api?.Utils;
  wrap(utils, "getControlledTokens", function (original, ...args) {
    return (original.apply(this, args) || []).filter(isInventoryToken);
  });
  wrap(utils, "getFirstControlledToken", function (original, ...args) {
    const controlled = globalThis.canvas?.tokens?.controlled || [];
    if (controlled.length) return controlled.find(isInventoryToken) || null;
    const token = original.apply(this, args);
    return isInventoryToken(token) ? token : null;
  });
}

export function patchMonsterHud(controllerClass) {
  wrap(controllerClass?.prototype, "currentTokenDocument", function (original, ...args) {
    const token = original.apply(this, args);
    return isMapObject(token) ? null : token;
  });
}

export function canCreateObjectCombatant(combatant, data) {
  const token = combatant?.token
    || game.scenes?.get(data?.sceneId)?.tokens?.get(data?.tokenId);
  if (isMapObject(token)) return false;
}

export function prepareObjectTokenHud(app, html) {
  const root = html?.classList ? html : html?.[0];
  root?.classList?.toggle("km-map-object-hud", isMapObject(app?.object || app?.document));
}

export function registerGroundLootIntegration() {
  patchObjectTokenDocument(globalThis.CONFIG?.Token?.documentClass);
  patchObjectTokenPlaceable(globalThis.CONFIG?.Token?.objectClass);
  Hooks.on("preCreateCombatant", canCreateObjectCombatant);
  Hooks.on("renderTokenHUD", prepareObjectTokenHud);
  Hooks.on("tokenActionHudCoreApiReady", patchActionHud);
  Hooks.on("canvasReady", initializeGroundLootIntegration);
}

let monsterHudImport = null;
export function initializeGroundLootIntegration() {
  patchObjectTokenDocument(globalThis.CONFIG?.Token?.documentClass);
  patchObjectTokenPlaceable(globalThis.CONFIG?.Token?.objectClass);
  patchHealthEstimate(game.healthEstimate?.provider);
  patchActionHud(game.modules?.get("token-action-hud-core")?.api);
  if (game.modules?.get("khuzoe-monster-hud")?.active && !monsterHudImport) {
    // The optional adapter lives here; no other module or saved configuration is edited.
    monsterHudImport = import("../../khuzoe-monster-hud/scripts/hud.js")
      .then(({ MonsterHudController }) => {
        patchMonsterHud(MonsterHudController);
        game.khuzoeMonsterHud?.render?.();
      }).catch(error => logError("Optional Monster HUD loot adapter unavailable", error));
  }
}
