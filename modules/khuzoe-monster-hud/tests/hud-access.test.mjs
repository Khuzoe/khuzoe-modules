import assert from "node:assert/strict";
import test from "node:test";

import { canUserAccessHudActor } from "../scripts/hud.js";

test("GMs can use the HUD for NPCs and player characters", () => {
  const gm = { isGM: true };
  assert.equal(canUserAccessHudActor({ type: "npc", isOwner: true }, gm), true);
  assert.equal(canUserAccessHudActor({ type: "character", isOwner: true }, gm), true);
});

test("players always access every owned supported actor", () => {
  const player = { isGM: false };
  assert.equal(canUserAccessHudActor({ type: "character", isOwner: true }, player), true);
  assert.equal(canUserAccessHudActor({ type: "character", isOwner: false }, player), false);
  assert.equal(canUserAccessHudActor({ type: "npc", isOwner: true }, player), true);
  assert.equal(canUserAccessHudActor({ type: "npc", isOwner: false }, player), false);
});

test("unsupported Actor types never receive the HUD", () => {
  assert.equal(canUserAccessHudActor({ type: "vehicle", isOwner: true }, { isGM: true }), false);
});
