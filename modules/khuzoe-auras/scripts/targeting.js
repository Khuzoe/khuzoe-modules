import { isWithinAura } from "./distance.js";

/** Keep independent of Merchant's activation and of Khuzoe Automations:
 * persisted map-object markers distinguish its NPC proxies from creatures.
 * The optional Automations module uses the same predicate for its own auras.
 */
export function isAuraCreature(value) {
  const token = value?.document ?? value;
  const flags = token?.flags?.["khuzoe-merchant"];
  return Boolean(token?.actor && !flags?.container && !flags?.groundLoot
    && token.actor.flags?.["khuzoe-merchant"]?.groundLootProxy !== true);
}

export function tokenRelation(source, target) {
  if (!source || !target) return "none";
  if (source.id === target.id) return "self";

  const sourceDisposition = Number(source.disposition ?? 0);
  const targetDisposition = Number(target.disposition ?? 0);
  if (sourceDisposition === 0 || targetDisposition === 0) return "neutral";
  return sourceDisposition === targetDisposition ? "ally" : "enemy";
}

export function isSourceOperational(source, aura) {
  if (!isAuraCreature(source) || !aura?.enabled) return false;
  if (!aura.source?.requiresConscious) return true;

  const statuses = source.actor.statuses;
  if (statuses?.has?.("dead") || statuses?.has?.("unconscious")) return false;

  const hp = source.actor.system?.attributes?.hp;
  return !hp || Number(hp.value ?? 0) > 0;
}

export function isTargetEligible(scene, source, target, aura, { ignoreRange = false } = {}) {
  if (!isAuraCreature(source) || !isAuraCreature(target)) return false;
  if ((source.parent?.id && source.parent.id !== scene?.id) || (target.parent?.id && target.parent.id !== scene?.id)) return false;
  if (source.id === target.id) {
    if (!aura.targets?.includeSource) return false;
  } else {
    const relation = tokenRelation(source, target);
    const requested = aura.targets?.relation ?? "ally";
    if (requested !== "all" && relation !== requested) return false;
  }

  return ignoreRange || isWithinAura(scene, source, target, aura);
}

export function getEligibleTargets(scene, source, aura) {
  const targets = [];
  for (const target of scene?.tokens ?? []) {
    if (isTargetEligible(scene, source, target, aura)) targets.push(target);
  }
  return targets;
}
