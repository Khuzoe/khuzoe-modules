import assert from "node:assert/strict";
import test from "node:test";

import { currentTurnKey, emptyUsage, groupUsage } from "../scripts/turn-tracker.js";

test("combat turn keys distinguish combatants and turns", () => {
  const combat = { id: "combat", round: 2, turn: 3, combatant: { id: "orc" } };
  assert.equal(currentTurnKey(combat), "combat:2:3:orc");
});

test("fixed multiattack tracks each entry and complete group capacity", () => {
  const claw = { itemId: "claw", activityId: "attack" };
  const bite = { itemId: "bite", activityId: "attack" };
  const group = {
    id: "fixed", mode: "fixed", capacity: 9,
    entries: [{ ref: claw, limit: 2 }, { ref: bite, limit: 1 }]
  };
  const usage = emptyUsage("turn");
  usage.groups.fixed = { used: { "claw:attack": 2 }, total: 2 };
  const measured = groupUsage(group, usage);
  assert.equal(measured.total, 3);
  assert.equal(measured.remaining, 1);
  assert.equal(measured.entryUsed(claw), 2);
  assert.equal(measured.entryUsed(bite), 0);
});

test("shared multiattack uses one common pool", () => {
  const group = { id: "shared", mode: "shared", capacity: 3, entries: [] };
  const usage = emptyUsage("turn");
  usage.groups.shared = { used: {}, total: 3 };
  assert.equal(groupUsage(group, usage).exhausted, true);
});
