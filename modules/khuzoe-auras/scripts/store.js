import { FLAGS, MODULE_ID } from "./constants.js";
import { auraMapFromArray, normalizeAura } from "./model.js";

export class AuraStore {
  static getAuras(tokenDocument) {
    const stored = tokenDocument?.getFlag?.(MODULE_ID, FLAGS.AURAS);
    if (!stored || typeof stored !== "object") return [];
    return Object.values(stored).map(normalizeAura);
  }

  static getAura(tokenDocument, auraId) {
    return this.getAuras(tokenDocument).find(aura => aura.id === auraId) ?? null;
  }

  static async setAuras(tokenDocument, auras) {
    if (!tokenDocument?.setFlag) throw new Error("Token document is not writable.");
    const auraMap = auraMapFromArray(auras);
    const result = await tokenDocument.setFlag(MODULE_ID, FLAGS.AURAS,
      replaceFlagObject(tokenDocument.getFlag?.(MODULE_ID, FLAGS.AURAS), auraMap));
    const immunityAuraIds = new Set(Object.values(auraMap)
      .filter(aura => aura.enabled && aura.actions.some(action => action.save.immunityOnSuccess))
      .map(aura => aura.id));
    await this.pruneImmunities(tokenDocument, immunityAuraIds);
    return result;
  }

  static getSources(scene, { enabledOnly = true } = {}) {
    const sources = [];
    for (const token of scene?.tokens ?? []) {
      for (const aura of this.getAuras(token)) {
        if (enabledOnly && !aura.enabled) continue;
        sources.push({ token, aura });
      }
    }
    return sources;
  }

  static getImmunities(tokenDocument, auraId) {
    const stored = tokenDocument?.getFlag?.(MODULE_ID, FLAGS.IMMUNITIES);
    const values = stored?.[auraId];
    return new Set(Array.isArray(values) ? values.map(String) : []);
  }

  static isImmune(tokenDocument, auraId, targetId) {
    return this.getImmunities(tokenDocument, auraId).has(String(targetId));
  }

  static async grantImmunity(tokenDocument, auraId, targetId) {
    if (!tokenDocument?.setFlag) throw new Error("Token document is not writable.");
    const stored = tokenDocument.getFlag?.(MODULE_ID, FLAGS.IMMUNITIES);
    const map = stored && typeof stored === "object" ? structuredClone(stored) : {};
    const immunities = new Set(Array.isArray(map[auraId]) ? map[auraId].map(String) : []);
    immunities.add(String(targetId));
    map[auraId] = [...immunities];
    await tokenDocument.setFlag(MODULE_ID, FLAGS.IMMUNITIES, map);
    return immunities;
  }

  static async pruneImmunities(tokenDocument, activeAuraIds) {
    if (!tokenDocument?.setFlag) return false;
    const stored = tokenDocument.getFlag?.(MODULE_ID, FLAGS.IMMUNITIES);
    if (!stored || typeof stored !== "object") return false;

    const allowed = activeAuraIds instanceof Set ? activeAuraIds : new Set(activeAuraIds ?? []);
    const next = Object.fromEntries(Object.entries(stored).filter(([auraId]) => allowed.has(auraId)));
    if (Object.keys(next).length === Object.keys(stored).length) return false;
    await tokenDocument.setFlag(MODULE_ID, FLAGS.IMMUNITIES, replaceFlagObject(stored, next));
    return true;
  }
}

// Replace only this flag, retaining other module/token data. Foundry v14's
// operator avoids both recursive merging and legacy deletion warnings.
function replaceFlagObject(current, next) {
  const Replacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (typeof Replacement === "function") return new Replacement(structuredClone(next));
  const replacement = structuredClone(next);
  for (const key of Object.keys(current ?? {})) {
    if (!Object.hasOwn(next, key)) replacement[`-=${key}`] = null;
    else if (isObject(current[key]) && isObject(next[key])) replacement[key] = replaceFlagObject(current[key], next[key]);
  }
  return replacement;
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
