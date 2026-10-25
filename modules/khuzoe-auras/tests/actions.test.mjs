import test from "node:test";
import assert from "node:assert/strict";

import { registerBuiltInActions } from "../scripts/actions.js";
import { AuraActionRegistry } from "../scripts/registry.js";

class FixedRoll {
  constructor(formula) {
    this.formula = formula;
    this.total = formula === "12" ? 12 : 4;
  }

  async evaluate() {
    return this;
  }

  async reroll({ maximize } = {}) {
    const roll = new FixedRoll(this.formula);
    if (maximize) roll.total = 6;
    return roll;
  }
}

globalThis.Roll = FixedRoll;

test("healing action uses dnd5e applyDamage with the healing type", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let application = null;

  const targetActor = {
    system: { attributes: { hp: { value: 6, max: 10, effectiveMax: 10, temp: 0 } } },
    async applyDamage(damages, options) {
      application = { damages, options };
      this.system.attributes.hp.value = 10;
    }
  };
  const context = {
    source: { id: "source", name: "Source", actor: { getRollData: () => ({}) } },
    target: { id: "target", name: "Target", actor: targetActor },
    aura: { id: "aura", name: "Aura" },
    eventContext: { eventId: "event" },
    rollCache: new Map()
  };

  const result = await registry.execute({
    id: "action",
    type: "healing",
    formula: "1d6",
    rollMode: "perTarget"
  }, context);

  assert.equal(application.damages[0].type, "healing");
  assert.equal(application.options.only, "healing");
  assert.equal(result.applied, 4);
});

test("healing action honors Midi-QOL maximum-healing effects", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let amount = 0;
  const actor = {
    flags: {"midi-qol": {grants: {max: {damage: {heal: "1"}}}}},
    system: {attributes: {hp: {value: 1, max: 20, effectiveMax: 20, temp: 0}}},
    async applyDamage(damages) {
      amount = damages[0].value;
      this.system.attributes.hp.value += amount;
    }
  };
  const result = await registry.execute({
    id: "maximum",
    type: "healing",
    formula: "1d6",
    rollMode: "perTarget"
  }, {
    source: {id: "source", name: "Source", actor: {getRollData: () => ({})}},
    target: {id: "target", name: "Target", actor},
    aura: {id: "aura", name: "Aura"},
    eventContext: {eventId: "event"},
    rollCache: new Map()
  });
  assert.equal(amount, 6);
  assert.equal(result.total, 6);
});
test("damage action applies a successful-save multiplier through dnd5e", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let application = null;

  const targetActor = {
    system: { attributes: { hp: { value: 10, max: 10, temp: 0 } } },
    async rollSavingThrow() {
      return [{ total: 14 }];
    },
    async applyDamage(damages, options) {
      application = { damages, options };
      this.system.attributes.hp.value -= damages[0].value * options.multiplier;
    }
  };
  const context = {
    source: { id: "source", name: "Source", actor: { getRollData: () => ({}) } },
    target: { id: "target", name: "Target", actor: targetActor },
    aura: { id: "aura", name: "Damaging Aura" },
    eventContext: { eventId: "event" },
    rollCache: new Map()
  };

  const result = await registry.execute({
    id: "action",
    type: "damage",
    formula: "1d6",
    damageType: "fire",
    rollMode: "perTarget",
    save: { enabled: true, ability: "dex", dc: "12", onSuccess: "half" }
  }, context);

  assert.equal(application.damages[0].type, "fire");
  assert.equal(application.options.only, "damage");
  assert.equal(application.options.multiplier, 0.5);
  assert.equal(result.save.success, true);
  assert.equal(result.applied, 2);
});

test("effect action applies selected Active Effects after a failed save", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let createdData = null;

  globalThis.game = {
    combat: { round: 3, turn: 2 },
    time: { worldTime: 900 },
    i18n: { localize: key => key }
  };
  globalThis.CONFIG = {
    DND5E: { conditionTypes: { frightened: { name: "Frightened" } } },
    ActiveEffect: {
      documentClass: {
        getEffectStart: () => ({time: 900, combat: "combat", combatant: "combatant", initiative: 15, round: 3, turn: 2}),
        fromStatusEffect: async statusId => ({
          toObject: () => ({ name: statusId, statuses: [statusId], flags: {} })
        })
      }
    },
    statusEffects: []
  };

  const targetActor = {
    effects: [],
    system: { traits: { ci: { value: new Set() } } },
    async rollSavingThrow() { return [{ total: 4 }]; },
    async createEmbeddedDocuments(_type, [data]) {
      createdData = data;
      return [{ name: data.name }];
    }
  };
  const result = await registry.execute({
    id: "effect-action",
    type: "effect",
    save: {
      enabled: true,
      ability: "wis",
      dc: "12",
      immunityOnSuccess: true,
      failureEffects: ["status:frightened"],
      effectDurationRounds: 2,
      showFailureEffectIcon: false
    }
  }, {
    source: { id: "source", uuid: "Scene.scene.Token.source", name: "Source", actor: { uuid: "Actor.source", getRollData: () => ({}) } },
    target: { id: "target", name: "Target", actor: targetActor },
    aura: { id: "aura", name: "Frightening Aura" },
    eventContext: { eventId: "event" },
    rollCache: new Map()
  });

  assert.equal(result.save.success, false);
  assert.equal(result.effects[0].applied, true);
  assert.equal(result.grantAuraImmunity, false);
  assert.deepEqual(createdData.statuses, ["frightened"]);
  assert.equal(createdData.duration.value, 2);
  assert.equal(createdData.duration.units, "rounds");
  assert.equal(createdData.duration.expired, false);
  assert.equal(createdData.start.round, 3);
  assert.equal(createdData.showIcon, 0);
  assert.equal(createdData.flags["khuzoe-auras"].auraId, "aura");
});

test("a repeated failed save refreshes the same effect and restarts its v14 duration", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let creations = 0;
  let updateData = null;

  globalThis.game = {
    combat: {round: 3, turn: 2},
    time: {worldTime: 900},
    i18n: {localize: key => key}
  };
  globalThis.CONFIG = {
    DND5E: {conditionTypes: {frightened: {name: "Frightened"}}},
    ActiveEffect: {
      documentClass: {
        getEffectStart: () => ({
          time: game.time.worldTime,
          combat: "combat",
          combatant: "combatant",
          initiative: 15,
          round: game.combat.round,
          turn: game.combat.turn
        }),
        fromStatusEffect: async statusId => ({
          toObject: () => ({name: statusId, statuses: [statusId], flags: {}})
        })
      }
    },
    statusEffects: []
  };

  const targetActor = {
    effects: [],
    system: {traits: {ci: {value: new Set()}}},
    async rollSavingThrow() { return [{total: 4}]; },
    async createEmbeddedDocuments(_type, [data]) {
      creations += 1;
      const effect = {
        name: data.name,
        statuses: new Set(data.statuses),
        flags: data.flags,
        async update(update) {
          updateData = update;
        }
      };
      this.effects.push(effect);
      return [effect];
    }
  };
  const action = {
    id: "effect-action",
    type: "effect",
    save: {
      enabled: true,
      ability: "wis",
      dc: "12",
      failureEffects: ["status:frightened"],
      effectDurationRounds: 2,
      showFailureEffectIcon: true
    }
  };
  const context = {
    source: {id: "source", name: "Source", actor: {uuid: "Actor.source", getRollData: () => ({})}},
    target: {id: "target", name: "Target", actor: targetActor},
    aura: {id: "aura", name: "Frightening Aura"},
    eventContext: {eventId: "first"},
    rollCache: new Map()
  };

  await registry.execute(action, context);
  game.combat.round = 4;
  game.time.worldTime = 906;
  const repeated = await registry.execute(action, {
    ...context,
    eventContext: {eventId: "second"}
  });

  assert.equal(creations, 1);
  assert.equal(repeated.effects[0].refreshed, true);
  assert.equal(updateData.disabled, false);
  assert.equal(updateData.duration.value, 2);
  assert.equal(updateData.duration.units, "rounds");
  assert.equal(updateData.duration.expired, false);
  assert.equal(updateData.start.round, 4);
  assert.equal(updateData.showIcon, 2);
});

test("a successful save can grant immunity without applying failure effects", async () => {
  const registry = new AuraActionRegistry();
  registerBuiltInActions(registry);
  let creations = 0;
  const targetActor = {
    effects: [],
    system: { traits: { ci: { value: new Set() } } },
    async rollSavingThrow() { return [{ total: 14 }]; },
    async createEmbeddedDocuments() { creations += 1; return []; }
  };

  const result = await registry.execute({
    id: "effect-action",
    type: "effect",
    save: {
      enabled: true,
      ability: "wis",
      dc: "12",
      immunityOnSuccess: true,
      failureEffects: ["status:frightened"],
      effectDurationRounds: 1
    }
  }, {
    source: { id: "source", name: "Source", actor: { getRollData: () => ({}) } },
    target: { id: "target", name: "Target", actor: targetActor },
    aura: { id: "aura", name: "Frightening Aura" },
    eventContext: { eventId: "event" },
    rollCache: new Map()
  });

  assert.equal(result.save.success, true);
  assert.equal(result.grantAuraImmunity, true);
  assert.equal(creations, 0);
});
