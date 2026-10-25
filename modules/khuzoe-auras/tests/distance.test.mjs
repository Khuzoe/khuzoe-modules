import test from "node:test";
import assert from "node:assert/strict";

test("fractional scene distances preserve a 15 ft aura and elevation", () => {
  const metricScene = {grid: {size: 100, distance: 0.3048}};
  const source = {id: "source", x: 0, y: 0, width: 1, height: 1};
  const target = {id: "target", x: 1500, y: 0, width: 1, height: 1};
  const aura = {area: {distance: 4.572, elevation: true}};
  assert.equal(auraRadiusPixels(source, aura, metricScene), 1550);
  assert.equal(isWithinAura(metricScene, source, target, aura), true);
  target.elevation = 4.572;
  assert.equal(isWithinAura(metricScene, source, target, aura), false);
});

import {
  auraRadiusPixels,
  distanceBetweenTokens,
  isWithinAura,
  rectangleGapPixels,
  tokenCenter,
  tokenPixelBounds
} from "../scripts/distance.js";

const scene = {
  grid: {
    size: 100,
    sizeX: 100,
    sizeY: 100
  }
};

test("token bounds account for token grid size", () => {
  assert.deepEqual(
    tokenPixelBounds(scene, { x: 100, y: 200, width: 2, height: 3 }),
    { x: 100, y: 200, width: 200, height: 300 }
  );
});

test("rectangle gap is zero for touching tokens", () => {
  const first = { x: 0, y: 0, width: 100, height: 100 };
  const second = { x: 100, y: 0, width: 100, height: 100 };
  assert.equal(rectangleGapPixels(first, second), 0);
});

test("rectangle gap is euclidean across both axes", () => {
  const first = { x: 0, y: 0, width: 100, height: 100 };
  const second = { x: 400, y: 500, width: 100, height: 100 };
  assert.equal(rectangleGapPixels(first, second), 500);
});

test("token center is based on the complete footprint", () => {
  assert.deepEqual(
    tokenCenter(scene, { x: 100, y: 200, width: 2, height: 1 }),
    { x: 200, y: 250 }
  );
});

test("gridded distance is measured from token borders", () => {
  const griddedScene = {
    grid: {
      isGridless: false,
      size: 100,
      sizeX: 100,
      sizeY: 100,
      distance: 5,
      getOffsetRange: bounds => [
        Math.floor(bounds.y / 100),
        Math.floor(bounds.x / 100),
        Math.ceil((bounds.y + bounds.height) / 100),
        Math.ceil((bounds.x + bounds.width) / 100)
      ],
      getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
      measurePath: ([origin, destination]) => ({
        distance: Math.hypot(destination.x - origin.x, destination.y - origin.y) / 100 * 5
      })
    }
  };
  const source = { id: "source", x: 0, y: 0, width: 1, height: 1 };
  const target = { id: "target", x: 400, y: 0, width: 1, height: 1 };

  assert.equal(distanceBetweenTokens(griddedScene, source, target), 15);
});

test("visual radius adds the source token footprint to the configured range", () => {
  assert.equal(
    auraRadiusPixels(
      { width: 1, height: 1 },
      { area: { distance: 15 } },
      { grid: { size: 100, sizeX: 100, sizeY: 100, distance: 5 } }
    ),
    350
  );
});

test("target centre on the visual aura boundary is eligible", () => {
  const gridlessScene = {
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 }
  };
  const source = { id: "source", x: 0, y: 0, width: 1, height: 1, elevation: 0 };
  const target = { id: "target", x: 350, y: 0, width: 1, height: 1, elevation: 0 };
  const aura = {
    area: { distance: 15, elevation: false, walls: false },
    targets: { includeSource: false }
  };

  assert.equal(isWithinAura(gridlessScene, source, target, aura), true);
});

test("target footprint touching the aura is not enough when its centre is outside", () => {
  const gridlessScene = {
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 }
  };
  const source = { id: "source", x: 0, y: 0, width: 1, height: 1, elevation: 0 };
  const target = { id: "target", x: 351, y: 0, width: 2, height: 2, elevation: 0 };
  const aura = {
    area: { distance: 15, elevation: false, walls: false },
    targets: { includeSource: false }
  };

  assert.equal(rectangleGapPixels(
    tokenPixelBounds(gridlessScene, source),
    tokenPixelBounds(gridlessScene, target)
  ) < 300, true);
  assert.equal(isWithinAura(gridlessScene, source, target, aura), false);
});

test("elevation uses the target centre against the same visual radius", () => {
  const gridlessScene = {
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 }
  };
  const source = { id: "source", x: 0, y: 0, width: 1, height: 1, elevation: 0 };
  const target = { id: "target", x: 250, y: 0, width: 1, height: 1, elevation: 15 };
  const aura = {
    area: { distance: 15, elevation: true, walls: false },
    targets: { includeSource: false }
  };

  assert.equal(isWithinAura(gridlessScene, source, target, aura), false);
});
