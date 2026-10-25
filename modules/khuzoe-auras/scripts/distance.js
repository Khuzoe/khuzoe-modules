export function tokenPixelBounds(scene, token) {
  const grid = scene?.grid;
  const sizeX = Number(grid?.sizeX ?? grid?.size ?? 1);
  const sizeY = Number(grid?.sizeY ?? grid?.size ?? 1);

  return {
    x: Number(token?.x ?? 0),
    y: Number(token?.y ?? 0),
    width: Math.max(0, Number(token?.width ?? 1) * sizeX),
    height: Math.max(0, Number(token?.height ?? 1) * sizeY)
  };
}

export function rectangleGapPixels(first, second) {
  const firstRight = first.x + first.width;
  const firstBottom = first.y + first.height;
  const secondRight = second.x + second.width;
  const secondBottom = second.y + second.height;

  const dx = Math.max(first.x - secondRight, second.x - firstRight, 0);
  const dy = Math.max(first.y - secondBottom, second.y - firstBottom, 0);
  return Math.hypot(dx, dy);
}

export function tokenCenter(scene, token) {
  const bounds = tokenPixelBounds(scene, token);
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
}

/**
 * Return the radius, in canvas pixels, of the circle used to display an aura.
 * The configured distance starts at the edge of the source token, while the
 * target is affected only when its centre is inside this exact circle.
 */
export function auraRadiusPixels(source, aura, scene) {
  const grid = scene?.grid;
  const gridDistance = Number(grid?.distance) > 0 ? Number(grid.distance) : 5;
  const gridSize = Math.max(1, Number(grid?.size ?? grid?.sizeX ?? 100));
  const outwardRadius = Number(aura?.area?.distance ?? 0) / gridDistance * gridSize;
  const sourceDocument = source?.document ?? source;
  const sourceBounds = tokenPixelBounds(scene, sourceDocument);
  const footprintRadius = Math.max(sourceBounds.width, sourceBounds.height) / 2;
  return Math.max(1, outwardRadius + footprintRadius);
}

export function distanceBetweenTokens(scene, source, target, { elevation = false } = {}) {
  if (!scene?.grid || !source || !target) return Number.POSITIVE_INFINITY;
  if (source.id === target.id) return 0;

  const horizontal = scene.grid.isGridless
    ? gridlessDistance(scene, source, target)
    : griddedDistance(scene, source, target);

  if (!elevation) return horizontal;
  const vertical = Math.abs(Number(source.elevation ?? 0) - Number(target.elevation ?? 0));
  return Math.hypot(horizontal, vertical);
}

export function isWithinAura(scene, source, target, aura) {
  const radius = Number(aura?.area?.distance ?? 0);
  if (!Number.isFinite(radius) || radius < 0) return false;
  if (source?.id === target?.id) return Boolean(aura?.targets?.includeSource);

  const grid = scene?.grid;
  if (!grid) return false;

  // The rendered aura is a circle. Use the very same geometry for targeting so
  // a token whose footprint merely touches the circle is not affected while its
  // centre remains outside it.
  const sourcePoint = tokenCenter(scene, source);
  const targetPoint = tokenCenter(scene, target);
  const horizontalPixels = Math.hypot(
    targetPoint.x - sourcePoint.x,
    targetPoint.y - sourcePoint.y
  );
  const gridSize = Math.max(1, Number(grid.size ?? grid.sizeX ?? 1));
  const gridDistance = Number(grid.distance) > 0 ? Number(grid.distance) : 5;
  const verticalPixels = aura?.area?.elevation
    ? Math.abs(Number(source.elevation ?? 0) - Number(target.elevation ?? 0)) / gridDistance * gridSize
    : 0;
  const centreDistancePixels = Math.hypot(horizontalPixels, verticalPixels);
  const visualRadius = auraRadiusPixels(source, aura, scene);
  if (!Number.isFinite(centreDistancePixels) || !Number.isFinite(visualRadius) || centreDistancePixels > visualRadius + 1e-6) return false;

  return !aura?.area?.walls || !isWallBlocked(scene, source, target);
}

export function isWallBlocked(scene, source, target) {
  if (!globalThis.canvas?.ready || globalThis.canvas.scene?.id !== scene?.id) return false;

  const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.sight;
  if (!backend?.testCollision) return false;

  try {
    const origin = {
      ...tokenCenter(scene, source),
      elevation: Number(source?.elevation ?? 0)
    };
    const destination = {
      ...tokenCenter(scene, target),
      elevation: Number(target?.elevation ?? source?.elevation ?? 0)
    };
    if (typeof source?.object?.checkCollision === "function") {
      return Boolean(source.object.checkCollision(destination, {
        origin,
        type: "sight",
        mode: "any"
      }));
    }

    return Boolean(backend.testCollision(
      origin,
      destination,
      { type: "sight", mode: "any" }
    ));
  } catch (error) {
    console.warn("Khuzoe Auras | Wall collision test failed.", error);
    return false;
  }
}

function gridlessDistance(scene, source, target) {
  const gapPixels = rectangleGapPixels(
    tokenPixelBounds(scene, source),
    tokenPixelBounds(scene, target)
  );
  const grid = scene.grid;
  return gapPixels / Math.max(1, Number(grid.size ?? grid.sizeX ?? 1)) * Number(grid.distance ?? 1);
}

function griddedDistance(scene, source, target) {
  const grid = scene.grid;
  const sourceOffsets = occupiedOffsets(grid, tokenPixelBounds(scene, source));
  const targetOffsets = occupiedOffsets(grid, tokenPixelBounds(scene, target));

  let minimum = Number.POSITIVE_INFINITY;
  for (const sourceOffset of sourceOffsets) {
    const origin = grid.getCenterPoint(sourceOffset);
    for (const targetOffset of targetOffsets) {
      const destination = grid.getCenterPoint(targetOffset);
      const measurement = grid.measurePath([origin, destination]);
      const centerDistance = Number(measurement?.distance ?? Number.POSITIVE_INFINITY);
      const edgeDistance = Math.max(0, centerDistance - Number(grid.distance ?? 0));
      minimum = Math.min(minimum, edgeDistance);
      if (minimum === 0) return 0;
    }
  }

  return minimum;
}

function occupiedOffsets(grid, bounds) {
  const rectangle = globalThis.PIXI?.Rectangle
    ? new globalThis.PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height)
    : bounds;
  const [i0, j0, i1, j1] = grid.getOffsetRange(rectangle);
  const offsets = [];

  for (let i = i0; i < i1; i += 1) {
    for (let j = j0; j < j1; j += 1) offsets.push({ i, j });
  }

  if (!offsets.length) offsets.push(grid.getOffset(tokenCenterFromBounds(bounds)));
  return offsets;
}

function tokenCenterFromBounds(bounds) {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
}
