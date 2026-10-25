import {circularAuraTokenDistance, sceneUnitsPerFoot} from "./geometry.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {isAuraCreature} from "./aura-targeting.mjs";

const MODULE_ID = "khuzoe-automations";
const INSTALLED = Symbol.for(`${MODULE_ID}.circularAuras`);
const locks = new Map();
const pendingScenes = new Map();
const values = collection => Array.isArray(collection) ? collection : Array.from(collection?.values?.() ?? []);
const refs = document => Object.values(document?.flags?.cat?.macros ?? {}).flat();
const owned = document => refs(document).some(ref => ref.source === MODULE_ID)
  || Boolean(document?.flags?.[MODULE_ID]?.circularAura || document?.flags?.[MODULE_ID]?.expandedSpell?.kind === "aura-target"
    || document?.flags?.[MODULE_ID]?.auraLifeTarget || document?.flags?.[MODULE_ID]?.protectorItemUuid);
const writer = () => game.users?.activeGM ? game.users.activeGM.id === game.user?.id : Boolean(game.user?.isGM);
const isOurs = trigger => trigger?.macroClass?.source === MODULE_ID;
const actorEffects = actor => actor ? globalThis.cat?.utils?.actorUtils?.getEffects?.(actor) ?? values(actor.effects) : [];
const documents = token => [...values(token?.actor?.items), ...actorEffects(token?.actor).filter(effect => effect.active !== false && !effect.disabled)];

function sceneHasAuras(scene) {
  return values(scene?.tokens).some(token => documents(token).some(document =>
    document.flags?.cat?.macros?.aura?.some(ref => ref.source === MODULE_ID)
  ) || actorEffects(token.actor).some(effect => effect.flags?.cat?.auraEffect && owned(effect)));
}

function spiritAuraId(document) {
  return document?.system?.identifier === "spirito-elementale-fatato-p-quando-una-creatura-n"
    ? "khz-fey-spirit-reinvigorating" : null;
}

/** CAT supplies the receiving token as `token` and the aura source as `targetToken`.
 * Keep other providers and their distance tables intact, including mixed documents.
 */
export function filterCircularAura(original, macro) {
  const ours = this.fnMacros?.some(group => group.source === MODULE_ID && group.macros.includes(macro));
  if (!ours) return original.call(this, macro);
  const source = this.targetToken, target = this.token;
  if (!isAuraCreature(source) || !isAuraCreature(target) || source.parent?.id !== target.parent?.id) return false;
  const storedId = spiritAuraId(this.document);
  if (storedId && !globalThis.game?.khuzoeAuras?.isTargetEligible?.(source, target, storedId)) return false;
  const distance = storedId ? 0 : circularAuraTokenDistance(source, target);
  if (!Number.isFinite(distance)) return false;
  const context = Object.create(this);
  context.distances = {...this.distances, [source.id]: Math.max(0, distance - 1e-6)};
  return original.call(context, macro);
}

function put(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((entry, key) => entry[key] ??= {}, object);
  parent[last] = value;
}

/** Preserve CAT's trigger collection, stacking and macro contracts. Own effects
 * are matched by source UUID: expanded spells share a CAT handler identifier.
 */
async function reconcileEvent(event) {
  const triggers = event.sortedTriggers;
  const effects = actorEffects(event.actor).filter(effect => effect.flags?.cat?.auraEffect);
  const remove = [], seen = new Set();
  const canWrite = writer();
  for (const effect of effects) {
    const origin = effect.origin ? await fromUuid(effect.origin) : null;
    const ours = owned(effect) || owned(origin);
    if (ours && !canWrite) continue;
    const sceneId = effect.flags?.[MODULE_ID]?.circularAura?.sceneId;
    if (ours && sceneId && sceneId !== event.scene?.id) continue;
    const identifier = origin ? globalThis.cat.utils.documentUtils.getIdentifier(origin) : null;
    const trigger = ours
      ? triggers.find(entry => isOurs(entry) && entry.document.uuid === effect.origin)
      : triggers.find(entry => entry.identifier === identifier);
    const duplicate = ours && seen.has(effect.origin);
    if (!origin || !trigger || trigger.document.uuid !== effect.origin || duplicate) remove.push(effect.id);
    else if (ours) seen.add(effect.origin);
  }
  if (remove.length) await cat.utils.documentUtils.deleteEmbeddedDocuments(event.actor, "ActiveEffect", remove);

  const results = [], create = [];
  for (const trigger of triggers) {
    const ours = isOurs(trigger);
    if (ours && !canWrite) continue;
    let result;
    try {
      result = typeof trigger.macro === "string"
        ? await event.executeScript(trigger.macro, trigger) : await trigger.macro(trigger);
    } catch (error) {
      cat.lib.Logging?.addMacroError?.(trigger, error);
      console.error("Khuzoe Automations | Aura macro failed", error);
      continue;
    }
    if (!result) continue;
    if (result.effectData) {
      const data = result.effectData;
      put(data, "flags.cat.auraEffect", true);
      put(data, "origin", trigger.document.uuid);
      put(data, "flags.cat.identifier", `${trigger.identifier}Aura`);
      if (ours) {
        put(data, `flags.${MODULE_ID}.circularAura`, {sceneId: event.scene.id});
        const existing = actorEffects(event.actor).find(effect => effect.flags?.cat?.auraEffect && effect.origin === data.origin);
        if (existing) {
          const changes = {};
          for (const key of ["name", "img", "showIcon"]) if (data[key] !== undefined && data[key] !== existing[key]) changes[key] = data[key];
          if (JSON.stringify(data.system?.changes ?? []) !== JSON.stringify(existing.system?.changes ?? [])) changes["system.changes"] = data.system?.changes ?? [];
          for (const [scope, flags] of Object.entries(data.flags)) {
            for (const [key, value] of Object.entries(flags)) {
              if (JSON.stringify(existing.flags?.[scope]?.[key]) !== JSON.stringify(value)) changes[`flags.${scope}.${key}`] = value;
            }
          }
          if (Object.keys(changes).length) await updateDocumentSafely(existing, changes);
          results.push({existingEffect: existing});
          continue;
        }
      }
      create.push(data);
    }
    results.push(result);
  }
  if (create.length) await cat.utils.effectUtils.createEffects(event.actor, create);
  return results;
}

export function installCircularAuras() {
  const Trigger = globalThis.cat?.lib?.Triggers?.AuraTrigger;
  const Event = globalThis.cat?.lib?.Events?.AuraEvent;
  if (!Trigger?.prototype?.filterDistance || !Event?.prototype?.run) return false;
  if (Event.prototype.run[INSTALLED]) return true;
  const filter = Trigger.prototype.filterDistance;
  Trigger.prototype.filterDistance = function(macro) { return filterCircularAura.call(this, filter, macro); };
  const run = Event.prototype.run;
  const guarded = function(...args) {
    if (!this.actor || (!sceneHasAuras(this.scene) && !locks.has(this.actor.uuid ?? this.actor.id))) return run.apply(this, args);
    const key = this.actor.uuid ?? this.actor.id;
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      // A queued event's initial distance/trigger cache can already be obsolete.
      this.setContext(this.actor, {token: this.token});
      this._sortedTriggers = undefined;
      return reconcileEvent(this);
    });
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  };
  Object.defineProperty(guarded, INSTALLED, {value: true});
  Event.prototype.run = guarded;
  return true;
}

/** Read configured CAT ranges to draw the exact same area without writing flags. */
export function circularSpellAuraVisuals(token) {
  const result = [], seen = new Set();
  if (!isAuraCreature(token)) return result;
  for (const document of documents(token)) {
    if (spiritAuraId(document)) continue; // The actual configurable spirit aura is already drawn.
    for (const ref of document.flags?.cat?.macros?.aura ?? []) {
      if (ref.source !== MODULE_ID) continue;
      const group = cat.lib.constants.macros.getFnMacros(ref.source, ref.rules, ref.identifier, "aura", "update");
      for (const macro of group?.macros ?? []) {
        const distance = Number(macro.configDistance ? cat.utils.automationUtils.getConfigValue(document, macro.configDistance) : macro.distance);
        if (!Number.isFinite(distance) || distance < 0) continue;
        const key = `${document.uuid}:${distance}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(circleVisual(key, document.name, distance * sceneUnitsPerFoot(token.parent)));
      }
    }
    if (document.flags?.cat?.identifier === "khuzoe-aura-vitality") {
      result.push(circleVisual(document.uuid, document.name, 30 * sceneUnitsPerFoot(token.parent)));
    }
    const state = document.flags?.[MODULE_ID]?.expandedSpell;
    if (state?.identifier === "spirit-shroud" && state.kind === "self-buff") {
      result.push(circleVisual(document.uuid, document.name, 10 * sceneUnitsPerFoot(token.parent)));
    }
  }
  return result;
}

function circleVisual(id, name, distance) {
  return {id, name, enabled: true, visualOnly: true,
    area: {distance, elevation: true, walls: false}, source: {requiresConscious: false},
    visual: {visible: true, color: "#a8d5e5", opacity: 0.025, lineOpacity: 0.3, lineWidth: 1.25}};
}

export async function refreshCircularAuras(scene = globalThis.canvas?.scene) {
  if (!writer() || !sceneHasAuras(scene) || !installCircularAuras()) return;
  const Event = cat.lib.Events.AuraEvent;
  for (const token of values(scene?.tokens)) {
    if (token.actor) await new Event(token, "update", {eventSource: "khuzoeCircularAura"}).run();
  }
}

export function scheduleCircularAuras(scene = globalThis.canvas?.scene) {
  if (!scene?.id || !writer()) return;
  clearTimeout(pendingScenes.get(scene.id));
  pendingScenes.set(scene.id, setTimeout(() => {
    pendingScenes.delete(scene.id);
    void refreshCircularAuras(scene).catch(error => console.error("Khuzoe Automations | Aura reconciliation failed", error));
  }, 50));
}

export function registerCircularAuraHooks(hooks = globalThis.Hooks) {
  if (!hooks?.on || hooks[INSTALLED]) return;
  Object.defineProperty(hooks, INSTALLED, {value: true});
  hooks.on("canvasReady", canvas => scheduleCircularAuras(canvas.scene));
  for (const hook of ["createToken", "deleteToken"]) hooks.on(hook, token => scheduleCircularAuras(token.parent));
  hooks.on("updateToken", async (token, changed) => {
    if (!["x", "y", "elevation", "width", "height", "disposition", "actorId", "actorLink", "level", "flags"]
      .some(key => Object.keys(changed).some(path => path === key || path.startsWith(`${key}.`)))) return;
    await (token.object?.movementAnimationPromise ?? token.object?.animationContexts?.get?.(token.object?.animationName)?.promise);
    scheduleCircularAuras(token.parent);
  });
  const actorChanged = document => {
    const actor = document?.actor ?? (document?.parent?.documentName === "Actor" ? document.parent : document);
    for (const scene of values(game.scenes)) {
      if (values(scene.tokens).some(token => token.actor?.uuid === actor?.uuid)) scheduleCircularAuras(scene);
    }
  };
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) hooks.on(hook, effect => {
    if (!effect.flags?.cat?.auraEffect) actorChanged(effect);
  });
  for (const hook of ["createItem", "updateItem", "deleteItem", "updateActor"]) hooks.on(hook, actorChanged);
}
