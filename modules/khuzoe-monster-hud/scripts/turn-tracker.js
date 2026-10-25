import { FLAGS, MODULE_ID } from "./constants.js";
import { referenceKey } from "./model.js";

const localUsage = new Map();
let writeQueue = Promise.resolve();

export function emptyUsage(turnKey = "") {
  return { turnKey, activeGroupId: "", groups: {} };
}

export function currentTurnKey(combat = globalThis.game?.combat) {
  const combatant = combat?.combatant;
  if (!combat || !combatant) return "";
  return [combat.id, combat.round ?? 0, combat.turn ?? 0, combatant.id].join(":");
}

export function getTurnUsage(tokenDocument) {
  const combat = globalThis.game?.combat;
  const combatant = combat?.combatant;
  const key = currentTurnKey(combat);

  if (combatant?.tokenId === tokenDocument?.id && key) {
    return normalizeUsage(combatant.getFlag?.(MODULE_ID, FLAGS.TURN_USAGE), key);
  }

  if (combat) return emptyUsage(`waiting:${combat.id}:${tokenDocument?.id ?? ""}`);

  const localKey = tokenDocument?.uuid ?? tokenDocument?.id ?? "";
  return normalizeUsage(localUsage.get(localKey), `free:${localKey}`);
}

export function recordGroupUse(tokenDocument, group, reference) {
  const task = writeQueue.then(() => performRecordGroupUse(tokenDocument, group, reference));
  writeQueue = task.catch(() => undefined);
  return task;
}

async function performRecordGroupUse(tokenDocument, group, reference) {
  if (!tokenDocument || !group || !reference) return null;
  const combat = globalThis.game?.combat;
  const combatant = combat?.combatant;
  const key = currentTurnKey(combat);
  const actionKey = referenceKey(reference);

  if (combat && combatant?.tokenId !== tokenDocument.id) return null;

  const usage = getTurnUsage(tokenDocument);
  usage.turnKey = key || usage.turnKey;
  usage.activeGroupId ||= group.id;
  usage.groups[group.id] ??= { used: {}, total: 0 };
  usage.groups[group.id].used[actionKey] = (usage.groups[group.id].used[actionKey] ?? 0) + 1;
  usage.groups[group.id].total += 1;

  if (combatant && key) {
    await combatant.setFlag(MODULE_ID, FLAGS.TURN_USAGE, usage);
  } else {
    localUsage.set(tokenDocument.uuid ?? tokenDocument.id, usage);
  }
  return usage;
}

export function resetTurnUsage(tokenDocument) {
  const task = writeQueue.then(() => performResetTurnUsage(tokenDocument));
  writeQueue = task.catch(() => undefined);
  return task;
}

async function performResetTurnUsage(tokenDocument) {
  const combat = globalThis.game?.combat;
  const combatant = combat?.combatant;
  const key = currentTurnKey(combat);
  if (combatant?.tokenId === tokenDocument?.id && key) {
    await combatant.setFlag(MODULE_ID, FLAGS.TURN_USAGE, emptyUsage(key));
    return;
  }
  localUsage.delete(tokenDocument?.uuid ?? tokenDocument?.id);
}

export function groupUsage(group, usage) {
  const stored = usage?.groups?.[group.id] ?? { used: {}, total: 0 };
  const total = group.mode === "shared"
    ? Math.max(1, Number(group.capacity) || 1)
    : group.entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.limit) || 1), 0);
  const used = Math.max(0, Number(stored.total) || 0);
  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    exhausted: used >= total,
    active: !usage?.activeGroupId || usage.activeGroupId === group.id,
    entryUsed: reference => Math.max(0, Number(stored.used?.[referenceKey(reference)]) || 0)
  };
}

function normalizeUsage(value, expectedTurnKey) {
  if (!value || value.turnKey !== expectedTurnKey) return emptyUsage(expectedTurnKey);
  return {
    turnKey: expectedTurnKey,
    activeGroupId: String(value.activeGroupId ?? ""),
    groups: typeof value.groups === "object" && value.groups ? value.groups : {}
  };
}
