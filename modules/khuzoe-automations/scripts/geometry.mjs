export function sceneUnitsPerFoot(scene) {
  const units = String(scene?.grid?.units ?? "ft").trim().toLowerCase();
  return /^(m|mt|meter|meters|metre|metres|metro|metri)$/.test(units) ? 0.3048 : 1;
}

/** Distance from the source's circular aura edge to the target centre, in feet.
 * Use the renderer's geometry when Khuzoe Auras is present. The fallback keeps
 * the same circle when Automations runs without that optional module.
 */
export function circularAuraTokenDistance(source, target) {
  source = source?.document ?? source; target = target?.document ?? target;
  if (!source || !target || source.parent?.id !== target.parent?.id) return Infinity;
  if (source === target || (source.uuid && source.uuid === target.uuid)) return 0;
  const scene = source.parent ?? globalThis.canvas?.scene;
  const grid = scene?.grid;
  if (!grid) return Infinity;
  const size = Math.max(1, Number(grid.size ?? grid.sizeX ?? 100));
  const distance = Number(grid.distance) > 0 ? Number(grid.distance) : 5;
  const sizeX = Number(grid.sizeX ?? grid.size ?? 1), sizeY = Number(grid.sizeY ?? grid.size ?? 1);
  const geometry = globalThis.game?.khuzoeAuras?.geometry;
  const centre = token => geometry?.tokenCenter?.(scene, token) ?? {
    x: Number(token.x ?? 0) + Math.max(0, Number(token.width ?? 1) * sizeX) / 2,
    y: Number(token.y ?? 0) + Math.max(0, Number(token.height ?? 1) * sizeY) / 2
  };
  const sourceCentre = centre(source), targetCentre = centre(target);
  const sourceBounds = geometry?.tokenPixelBounds?.(scene, source) ?? {
    width: Math.max(0, Number(source.width ?? 1) * sizeX), height: Math.max(0, Number(source.height ?? 1) * sizeY)
  };
  const sourceRadius = Math.max(sourceBounds.width, sourceBounds.height) / 2;
  const elevation = (Number(target.elevation ?? 0) - Number(source.elevation ?? 0)) / distance * size;
  const centreDistance = Math.hypot(targetCentre.x - sourceCentre.x, targetCentre.y - sourceCentre.y, elevation);
  if (!Number.isFinite(centreDistance)) return Infinity;
  return Math.max(0, centreDistance - sourceRadius) / size * distance / sceneUnitsPerFoot(scene);
}

/** Nearest occupied grid-space centers, using current document coordinates. */
export function tokenDistanceFeet(source, target) {
  source = source?.document ?? source; target = target?.document ?? target;
  if (!source || !target || source.parent?.id !== target.parent?.id) return Infinity;
  if (source.uuid && source.uuid === target.uuid) return 0;
  const scene = source.parent ?? globalThis.canvas?.scene;
  const size = Number(scene?.grid?.size ?? scene?.dimensions?.size ?? globalThis.canvas?.dimensions?.size);
  const grid = scene?.grid?.measurePath ? scene.grid : globalThis.canvas?.grid;
  if (!(size > 0) || !grid?.measurePath) return Number(globalThis.cat?.utils?.tokenUtils?.getDistance?.(source, target) ?? Infinity);
  const rectangle = token => {
    const w = Number(token.width ?? 1), h = Number(token.height ?? 1);
    return {x: Number(token.x ?? 0), y: Number(token.y ?? 0), w, h,
      cx: Number(token.x ?? 0) + w * size / 2, cy: Number(token.y ?? 0) + h * size / 2};
  };
  const a = rectangle(source), b = rectangle(target);
  const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
  const nearest = (r, p, elevation) => ({
    x: clamp(p.cx, r.x + Math.min(1, r.w) * size / 2, r.x + (r.w - Math.min(1, r.w) / 2) * size),
    y: clamp(p.cy, r.y + Math.min(1, r.h) * size / 2, r.y + (r.h - Math.min(1, r.h) / 2) * size), elevation
  });
  const distance = Number(grid.measurePath([nearest(a, b, source.elevation), nearest(b, a, target.elevation)])?.distance);
  return Number.isFinite(distance) ? distance / sceneUnitsPerFoot(scene) : Infinity;
}

export function tokenSizeForCategory(size) {
  const dimension = ({tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4})[size] ?? 1;
  return {width: dimension, height: dimension};
}
