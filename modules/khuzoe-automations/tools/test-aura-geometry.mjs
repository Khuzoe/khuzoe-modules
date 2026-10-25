import assert from "node:assert/strict";
import {circularAuraTokenDistance, sceneUnitsPerFoot, tokenDistanceFeet} from "../scripts/geometry.mjs";
import {PALADIN_AURA_DISTANCE_FLAG, PALADIN_IDS, PALADIN_EFFECT_IDS, paladinAuraVisuals} from "../scripts/paladin.mjs";
import * as renderedGeometry from "../../khuzoe-auras/scripts/distance.js";

const scene = {
  id: "AuraCircle",
  grid: {
    size: 100, distance: 5, units: "ft",
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})
  }
};
const source = {id: "source", parent: scene, x: 0, y: 0, width: 1, height: 1, elevation: 0};
const target = {id: "target", parent: scene, x: 600, y: 400, width: 1, height: 1, elevation: 0};

// A square-grid range of 30 ft can include a centre outside the visible 30 ft circle.
globalThis.game = {};
assert.equal(tokenDistanceFeet(source, target), 30);
assert.ok(circularAuraTokenDistance(source, target) > 30);
const aura = {area: {distance: 30, elevation: true}, targets: {includeSource: true}};
assert.equal(renderedGeometry.isWithinAura(scene, source, target, aura), false);

let comparisons = 0;
for (const [units, gridFeet] of [["ft", 5], ["m", 5], ["m", 1]]) {
  scene.grid.units = units;
  scene.grid.distance = gridFeet * sceneUnitsPerFoot(scene);
  for (const gridless of [false, true]) {
    scene.grid.isGridless = gridless;
    for (const sourceSize of [0.01, 0.5, 1, 2, 4]) {
      source.width = sourceSize;
      source.height = sourceSize;
      for (const targetSize of [0.5, 1, 2, 4]) {
        target.width = targetSize;
        target.height = targetSize;
        for (const range of [10, 30]) {
          aura.area.distance = range * sceneUnitsPerFoot(scene);
          const radius = renderedGeometry.auraRadiusPixels(source, aura, scene);
          const sourceCentre = renderedGeometry.tokenCenter(scene, source);
          for (const angle of [0, Math.PI / 4, Math.PI / 2]) {
            for (const offset of [-1, 0, 1]) {
              // Include exact axial boundaries and nearby points on either side.
              const centreDistance = radius + offset;
              target.x = sourceCentre.x + centreDistance * Math.cos(angle) - target.width * 50;
              target.y = sourceCentre.y + centreDistance * Math.sin(angle) - target.height * 50;
              for (const elevation of [0, 5 * sceneUnitsPerFoot(scene)]) {
                target.elevation = elevation;
                const expected = Math.hypot(centreDistance, elevation / scene.grid.distance * 100) <= radius + 1e-9;
                game.khuzoeAuras = undefined;
                const fallback = circularAuraTokenDistance(source, target);
                game.khuzoeAuras = {geometry: renderedGeometry};
                const shared = circularAuraTokenDistance(source, target);
                assert.equal(shared, fallback, "Con e senza Khuzoe Auras il confine deve coincidere");
                assert.equal(shared <= range + 1e-6, expected, `${units}, source ${sourceSize}, target ${targetSize}, angle ${angle}, offset ${offset}, elevation ${elevation}`);
                // Avoid floating-point ties when comparing the renderer's strict boundary.
                if (offset !== 0) assert.equal(shared <= range + 1e-6, renderedGeometry.isWithinAura(scene, source, target, aura));
                comparisons++;
              }
            }
          }
        }
      }
    }
  }
}

assert.equal(circularAuraTokenDistance(source, {...target, parent: {id: "OtherScene"}}), Infinity);
assert.equal(circularAuraTokenDistance(source, source), 0);
assert.equal(circularAuraTokenDistance(source, null), Infinity);
assert.equal(circularAuraTokenDistance(source, {...target, x: NaN}), Infinity);

// Visual providers express ranges in scene units; mechanical feature ranges stay in feet.
source.actor = {
  items: [{system: {identifier: PALADIN_IDS.auraProtection}, flags: {cat: {
    automation: {source: "khuzoe-automations"}, config: {[PALADIN_AURA_DISTANCE_FLAG]: 30}
  }}}],
  effects: [{active: true, disabled: false, flags: {cat: {identifier: PALADIN_EFFECT_IDS.holyNimbus}}}],
  statuses: new Set(), system: {attributes: {hp: {value: 20}}}
};
for (const units of ["ft", "m", "metri"]) {
  scene.grid.units = units;
  const visuals = paladinAuraVisuals(source);
  assert.equal(visuals.length, 2);
  for (const visual of visuals) assert.equal(visual.area.distance, 30 * sceneUnitsPerFoot(scene));
}

console.log(`Geometria aure: diagonali, confini, taglie, quote, metri, visuali e fallback OK (${comparisons} confronti)`);
