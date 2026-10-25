import test from "node:test";
import assert from "node:assert/strict";
import {isTargetEligible as checkSceneTarget} from "../scripts/targeting.js";

test("tokens from another scene never belong to the aura", () => {
  const scene = {id: "here", grid: {size: 100, distance: 5}};
  const source = {id: "source", parent: scene, actor: {}, x: 0, y: 0, disposition: 1};
  const target = {id: "target", parent: {id: "elsewhere"}, actor: {}, x: 0, y: 0, disposition: 1};
  assert.equal(checkSceneTarget(scene, source, target, {area: {distance: 30}, targets: {relation: "ally"}}), false);
});

import { isSourceOperational, tokenRelation, getEligibleTargets } from "../scripts/targeting.js";

test("Merchant objects cannot receive or project any configured aura, including ignored-range events", () => {
  const scene = {id: "merchant", grid: {size: 100, distance: 5}};
  const source = {id: "source", actor: {}, parent: scene, disposition: 1, x: 0, y: 0};
  const target = {id: "target", actor: {type: "npc"}, parent: scene, disposition: 1, x: 100, y: 0};
  const aura = {enabled: true, area: {distance: 30}, targets: {relation: "all", includeSource: true}};
  scene.tokens = [source, target];
  for (const marker of ["container", "groundLoot", "groundLootProxy"]) {
    const flagged = marker === "groundLootProxy" ? target.actor : target;
    flagged.flags = {"khuzoe-merchant": {[marker]: marker === "groundLootProxy" ? true : {}}};
    assert.equal(checkSceneTarget(scene, source, target, aura), false, marker);
    assert.equal(checkSceneTarget(scene, source, target, aura, {ignoreRange: true}), false, marker);
    assert.equal(checkSceneTarget(scene, target, source, aura), false, marker);
    assert.equal(checkSceneTarget(scene, target, target, aura), false, marker);
    assert.equal(isSourceOperational(target, aura), false, marker);
    assert.deepEqual(getEligibleTargets(scene, source, aura), [source]);
    delete flagged.flags;
  }
  target.actor.flags = {"khuzoe-merchant": {enabled: true}};
  assert.equal(checkSceneTarget(scene, source, target, aura), true, "Real merchant NPC");
  target.actor.system = {details: {type: {value: "construct"}}};
  assert.equal(checkSceneTarget(scene, source, target, aura), true, "A construct creature is not an object token");
});

test("same non-neutral disposition is allied", () => {
  assert.equal(
    tokenRelation({ id: "a", disposition: 1 }, { id: "b", disposition: 1 }),
    "ally"
  );
});

test("opposite dispositions are enemies", () => {
  assert.equal(
    tokenRelation({ id: "a", disposition: 1 }, { id: "b", disposition: -1 }),
    "enemy"
  );
});

test("a neutral participant makes the relation neutral", () => {
  assert.equal(
    tokenRelation({ id: "a", disposition: 0 }, { id: "b", disposition: 0 }),
    "neutral"
  );
});

test("a token recognizes itself separately", () => {
  assert.equal(
    tokenRelation({ id: "a", disposition: 1 }, { id: "a", disposition: 1 }),
    "self"
  );
});

test("an unconscious source does not project an aura that requires consciousness", () => {
  const source = {
    actor: {
      statuses: new Set(["unconscious"]),
      system: { attributes: { hp: { value: 8 } } }
    }
  };
  assert.equal(isSourceOperational(source, {
    enabled: true,
    source: { requiresConscious: true }
  }), false);
});
