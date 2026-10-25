import assert from "node:assert/strict";
import test from "node:test";

import {
  createGroup,
  normalizeConfig,
  referenceKey,
  referencesMatch
} from "../scripts/model.js";

test("configuration normalizes quick actions and both multiattack modes", () => {
  const config = normalizeConfig({
    autoQuick: false,
    quick: [{ itemId: "claw", activityId: "attack" }, { itemId: "claw", activityId: "attack" }],
    groups: [{
      id: "multi",
      name: "Claws",
      mode: "shared",
      capacity: 3,
      entries: [{ ref: { itemId: "claw", activityId: "attack" }, limit: 99 }]
    }]
  });

  assert.equal(config.autoQuick, false);
  assert.equal(config.quick.length, 1);
  assert.equal(config.groups[0].mode, "shared");
  assert.equal(config.groups[0].capacity, 3);
  assert.equal(config.groups[0].entries[0].limit, 99);
});

test("references survive an embedded item id change through the item identifier", () => {
  const stored = {
    itemId: "old-id", itemIdentifier: "claw", itemName: "Claw",
    activityId: "old-activity", activityName: "Attack", activityType: "attack"
  };
  const current = {
    itemId: "new-id", itemIdentifier: "claw", itemName: "Claw",
    activityId: "new-activity", activityName: "Attack", activityType: "attack"
  };
  assert.equal(referencesMatch(stored, current), true);
  assert.equal(referenceKey(stored), "old-id:old-activity");
});

test("new multiattack groups use safe defaults", () => {
  const group = createGroup();
  assert.equal(group.mode, "fixed");
  assert.equal(group.capacity, 2);
  assert.deepEqual(group.entries, []);
});

test("legacy default group names become simply Multiattack", () => {
  assert.equal(createGroup({ name: "New Multiattack" }).name, "Multiattack");
  assert.equal(createGroup({ name: "Nuovo Multiattack" }).name, "Multiattack");
});

test("an Item-level ability reference matches any of its D&D5e Activities", () => {
  const ability = { itemId: "bite", itemName: "Bite", itemType: "feat" };
  const attack = {
    itemId: "bite", itemName: "Bite", itemType: "feat",
    activityId: "attack", activityName: "Attack", activityType: "attack"
  };
  assert.equal(referencesMatch(ability, attack), true);
  assert.equal(referencesMatch(attack, ability), true);
});
