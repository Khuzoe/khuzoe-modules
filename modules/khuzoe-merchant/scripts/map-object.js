import { MODULE_ID } from "./constants.js";

export const GROUND_LOOT_PROXY_FLAG = "groundLootProxy";

export function asDocument(value) {
  return value?.document || value || null;
}

/** Identify the scene document, never every NPC sharing its Actor type. */
export function mapObjectKind(value) {
  const document = asDocument(value);
  if (document?.getFlag?.(MODULE_ID, "groundLoot")) return "groundLoot";
  if (document?.getFlag?.(MODULE_ID, "container")) return "container";
  return null;
}

export function isMapObject(value) {
  return mapObjectKind(value) !== null;
}

export function isProxyActor(actor) {
  return actor?.getFlag?.(MODULE_ID, GROUND_LOOT_PROXY_FLAG) === true;
}

export function isInventoryActor(actor) {
  return Boolean(actor && !isProxyActor(actor) && !isMapObject(actor.token));
}

export function isInventoryToken(value) {
  const token = asDocument(value);
  return Boolean(token && !isMapObject(token) && isInventoryActor(token.actor));
}

export function objectTokenDefaults() {
  return {
    displayBars: globalThis.CONST?.TOKEN_DISPLAY_MODES?.NONE ?? 0,
    bar1: { attribute: null },
    bar2: { attribute: null },
    sight: { enabled: false }
  };
}

export function tokenRepresentsActor(value, actor) {
  const token = asDocument(value);
  return isInventoryToken(token) && isInventoryActor(actor)
    && Boolean(token.actor?.uuid && token.actor.uuid === actor.uuid);
}

/** Prefer an explicit/synthetic token, then the unique controlled or scene token. */
export function resolveActorToken(actor, scene, { tokenId = "", controlled = [] } = {}) {
  if (!scene || !isInventoryActor(actor)) return null;
  const explicitId = tokenId || actor.token?.id;
  if (explicitId) {
    const token = scene.tokens?.get(explicitId);
    return tokenRepresentsActor(token, actor) ? token : null;
  }
  const candidates = Array.from(scene.tokens || []).filter(token => tokenRepresentsActor(token, actor));
  const selectedIds = new Set(controlled.map(token => asDocument(token)?.id));
  const selected = candidates.filter(token => selectedIds.has(token.id));
  if (selected.length) return selected.length === 1 ? selected[0] : null;
  return candidates.length === 1 ? candidates[0] : null;
}

/** Normalize only positional fields; client data must not carry arbitrary Token updates. */
export function groundMovementWaypoints(source) {
  if (!Array.isArray(source) || !source.length || source.length > 1000) return null;
  const result = [];
  for (const value of source) {
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) return null;
    const point = { x: value.x, y: value.y };
    if (value.elevation !== undefined) {
      if (!Number.isFinite(value.elevation)) return null;
      point.elevation = value.elevation;
    }
    if (value.level !== undefined) {
      if (value.level !== null && typeof value.level !== "string") return null;
      point.level = value.level;
    }
    result.push(point);
  }
  return result;
}

/** v14 returns [updates, options]; legacy Tile handlers return position updates. */
export function groundDragWaypoints(prepared, tokenId) {
  if (!Array.isArray(prepared)) return null;
  const [updates, options] = Array.isArray(prepared[0]) ? prepared : [prepared, {}];
  const update = updates.find(entry => entry?._id === tokenId);
  if (!update) return null;
  return groundMovementWaypoints(options?.movement?.[tokenId]?.waypoints || [update]);
}
