import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultAura,
  normalizeAura,
  triggerToPresetKey
} from "../scripts/model.js";

test("default aura is a 15-unit healing aura", () => {
  const aura = createDefaultAura();
  assert.equal(aura.area.distance, 15);
  assert.equal(aura.actions[0].type, "healing");
  assert.equal(aura.actions[0].formula, "1d6");
  assert.equal(aura.actions[0].save.showFailureEffectIcon, true);
  assert.equal(aura.visualOnly, false);
  assert.equal(triggerToPresetKey(aura.triggers[0]), "sourceTurnStart");
});

test("visual-only mode survives normalization without removing configured actions", () => {
  const aura = normalizeAura({
    visualOnly: true,
    actions: [{ type: "damage", formula: "2d6", damageType: "fire" }]
  });

  assert.equal(aura.visualOnly, true);
  assert.equal(aura.actions.length, 1);
  assert.equal(aura.actions[0].type, "damage");
  assert.equal(aura.actions[0].formula, "2d6");
});

test("save immunity and failed-save effects survive normalization safely", () => {
  const aura = normalizeAura({
    actions: [{
      type: "effect",
      save: {
        enabled: true,
        immunityOnSuccess: true,
        failureEffects: ["status:frightened", "status:frightened", "uuid:Actor.test.ActiveEffect.effect"],
        effectDurationRounds: 2.9,
        showFailureEffectIcon: false
      }
    }]
  });
  const save = aura.actions[0].save;

  assert.equal(save.immunityOnSuccess, true);
  assert.deepEqual(save.failureEffects, ["status:frightened", "uuid:Actor.test.ActiveEffect.effect"]);
  assert.equal(save.effectDurationRounds, 2);
  assert.equal(save.showFailureEffectIcon, false);
});

test("normalization clamps unsafe numeric values and removes duplicate triggers", () => {
  const aura = normalizeAura({
    name: "Test",
    area: { distance: -50 },
    visual: { opacity: 4, color: "not-a-color", lineOpacity: -2, lineWidth: 99 },
    triggers: [
      { event: "turnStart", subject: "affected" },
      { event: "turnStart", subject: "affected" }
    ]
  });

  assert.equal(aura.area.distance, 0);
  assert.equal(aura.visual.opacity, 0.5);
  assert.equal(aura.visual.color, "#55d68b");
  assert.equal(aura.visual.lineOpacity, 0);
  assert.equal(aura.visual.lineWidth, 10);
  assert.equal(aura.triggers.length, 1);
});

test("custom action types survive normalization while invalid fields use safe defaults", () => {
  const aura = normalizeAura({
    actions: [{
      type: "arbitrary-code",
      formula: "",
      rollMode: "unknown",
      save: { onSuccess: "double" }
    }]
  });

  assert.equal(aura.actions[0].type, "arbitrary-code");
  assert.equal(aura.actions[0].formula, "1d6");
  assert.equal(aura.actions[0].rollMode, "perTarget");
  assert.equal(aura.actions[0].save.onSuccess, "half");

  const invalidType = normalizeAura({ actions: [{ type: "invalid type!" }] });
  assert.equal(invalidType.actions[0].type, "healing");
});
