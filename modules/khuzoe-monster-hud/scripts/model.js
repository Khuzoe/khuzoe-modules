import { CONFIG_VERSION, GROUP_MODES } from "./constants.js";

export function createId(prefix = "id") {
  const random = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function referenceKey(reference) {
  const item = String(reference?.itemId || reference?.itemIdentifier || reference?.itemName || "item");
  const activity = String(reference?.activityId || reference?.activityName || "item");
  return `${item}:${activity}`;
}

export function normalizeReference(reference = {}) {
  return {
    itemId: clean(reference.itemId, 80),
    activityId: clean(reference.activityId, 80),
    itemIdentifier: clean(reference.itemIdentifier, 160),
    itemName: clean(reference.itemName, 160),
    activityName: clean(reference.activityName, 160),
    itemType: clean(reference.itemType, 40),
    activityType: clean(reference.activityType, 40),
    img: clean(reference.img, 500)
  };
}

export function normalizeConfig(config = {}) {
  const quick = uniqueReferences(config.quick);
  const groups = Array.isArray(config.groups) ? config.groups.map(normalizeGroup) : [];
  return {
    version: CONFIG_VERSION,
    autoQuick: config.autoQuick !== false,
    quick,
    groups: uniqueBy(groups, group => group.id)
  };
}

export function createGroup(overrides = {}) {
  return normalizeGroup({
    id: createId("group"),
    name: "Multiattack",
    mode: "fixed",
    capacity: 2,
    entries: [],
    ...overrides
  });
}

export function normalizeGroup(group = {}) {
  const mode = GROUP_MODES.includes(group.mode) ? group.mode : "fixed";
  const storedName = clean(group.name, 120);
  const name = /^(?:new|nuovo) multiattack$/i.test(storedName) ? "Multiattack" : storedName;
  return {
    id: clean(group.id, 100) || createId("group"),
    name: name || "Multiattack",
    mode,
    capacity: clampInteger(group.capacity, 1, 99, 2),
    entries: uniqueBy(
      (Array.isArray(group.entries) ? group.entries : []).map(entry => ({
        ref: normalizeReference(entry.ref ?? entry),
        limit: clampInteger(entry.limit, 1, 99, 1)
      })),
      entry => referenceKey(entry.ref)
    )
  };
}

export function referencesMatch(left, right) {
  if (!left || !right) return false;
  if (left.itemId && right.itemId && left.itemId === right.itemId) {
    if (!left.activityId || !right.activityId) return true;
    return Boolean(left.activityId && right.activityId && left.activityId === right.activityId);
  }
  if (left.itemIdentifier && right.itemIdentifier && left.itemIdentifier === right.itemIdentifier) {
    if (!hasActivityReference(left) || !hasActivityReference(right)) return true;
    if (left.activityName || right.activityName) {
      return left.activityName === right.activityName
        && (!left.activityType || !right.activityType || left.activityType === right.activityType);
    }
    return left.activityType === right.activityType;
  }
  if (left.itemName !== right.itemName || left.itemType !== right.itemType) return false;
  if (!hasActivityReference(left) || !hasActivityReference(right)) return true;
  return left.activityName === right.activityName;
}

function hasActivityReference(reference) {
  return Boolean(reference.activityId || reference.activityName || reference.activityType);
}

function uniqueReferences(values) {
  return uniqueBy(
    (Array.isArray(values) ? values : []).map(normalizeReference),
    referenceKey
  );
}

function uniqueBy(values, keyFor) {
  const seen = new Set();
  return values.filter(value => {
    const key = keyFor(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clean(value, maximum) {
  return String(value ?? "").trim().slice(0, maximum);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
