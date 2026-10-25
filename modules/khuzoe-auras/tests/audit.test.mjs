import test from "node:test";
import assert from "node:assert/strict";
import { AuraEngine } from "../scripts/engine.js";
import { AuraActionRegistry } from "../scripts/registry.js";
import { applyFailureEffects, registerBuiltInActions } from "../scripts/actions.js";
import { createDefaultAura } from "../scripts/model.js";

class Collection extends Map { [Symbol.iterator]() { return this.values(); } }

function setup(t, overrides = {}) {
  const globals = ["game", "ui", "CONFIG", "foundry", "ChatMessage", "renderTemplate", "Roll", "fromUuid"];
  const original = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
  t.after(() => { for (const key of globals) globalThis[key] = original[key]; });
  const aura = createDefaultAura({
    id: "aura", targets: { relation: "ally", includeSource: false },
    triggers: [{ event: "manual", subject: "source", frequency: "always" }], ...overrides
  });
  const flags = { auras: { [aura.id]: aura }, immunities: {} };
  const source = {
    id: "source", uuid: "Scene.scene.Token.source", name: "Portatore",
    x: 0, y: 0, width: 1, height: 1, elevation: 0, disposition: 1,
    actor: { statuses: new Set(), system: { attributes: { hp: { value: 10, max: 20 } } }, getRollData: () => ({}) },
    getFlag: (_scope, key) => flags[key]
  };
  const target = {
    ...source, id: "target", uuid: "Scene.scene.Token.target", name: "Bersaglio", x: 100,
    actor: {
      effects: [], system: { traits: { ci: { value: new Set() } }, attributes: { hp: { value: 2, max: 20, temp: 3 } } },
      async rollSavingThrow() { return [{ total: 4 }]; },
      async createEmbeddedDocuments(_type, data) {
        const created = data.map(entry => ({ ...entry, statuses: new Set(entry.statuses), async update(change) { Object.assign(this, change); } }));
        this.effects.push(...created);
        return created;
      }
    }, getFlag: () => ({})
  };
  const scene = { id: "scene", grid: { size: 100, sizeX: 100, sizeY: 100, distance: 5, isGridless: true },
    tokens: new Collection([[source.id, source], [target.id, target]]) };
  source.parent = target.parent = scene;
  const messages = [];
  const summaries = [];
  globalThis.foundry = undefined;
  globalThis.game = {
    user: { id: "gm", isGM: true, isActiveGM: true }, scenes: [scene],
    combat: null, time: { worldTime: 100 },
    settings: { get: (scope, key) => key === "messageMode" ? "gm" : false },
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.ui = { notifications: { warn() {}, error() {} } };
  globalThis.CONFIG = {
    DND5E: { abilities: {}, damageTypes: {}, conditionTypes: { frightened: { name: "Frightened" } } },
    ActiveEffect: { documentClass: { fromStatusEffect: async id => ({ toObject: () => ({ name: id, statuses: [id], flags: {} }) }) } }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ alias }) => ({ alias }), create: async data => { messages.push(data); return data; }
  };
  globalThis.renderTemplate = async (_path, data) => { summaries.push(data); return "<p>summary</p>"; };
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; this.total = Number(formula) || 6; }
    async evaluate() { return this; }
  };
  return { aura, source, target, scene, flags, messages, summaries };
}

function failureAction() {
  return { id: "effect", type: "effect", save: { enabled: true, ability: "wis", dc: "12",
    failureEffects: ["status:frightened"], effectDurationRounds: 2 } };
}

test("inactive foreign effects do not prevent application; own expired effects are reused", async t => {
  const { aura, source, target } = setup(t);
  const action = failureAction();
  const context = { aura, source, target };
  for (const inactive of [{ disabled: true }, { isSuppressed: true }, { duration: { expired: true } }]) {
    const foreign = { name: "Foreign", statuses: new Set(["frightened"]), ...inactive };
    target.actor.effects = [foreign];
    const [result] = await applyFailureEffects(action, context);
    assert.equal(result.applied, true);
    assert.equal(target.actor.effects.length, 2);
    assert.deepEqual(foreign, { name: "Foreign", statuses: new Set(["frightened"]), ...inactive });
  }
  const owned = target.actor.effects[1];
  owned.disabled = true;
  owned.duration.expired = true;
  target.actor.effects.unshift({ name: "Active foreign", statuses: new Set(["frightened"]) });
  const [renewed] = await applyFailureEffects(action, context);
  assert.equal(renewed.refreshed, true);
  assert.equal(target.actor.effects.length, 3);
  assert.equal(owned.disabled, false);
  assert.equal(owned.duration.expired, false);
});

test("copied source tokens cannot refresh each other's existing effects", async t => {
  const { aura, source, target } = setup(t);
  const action = failureAction();
  const context = { aura, source, target };
  await applyFailureEffects(action, context);
  const existing = target.actor.effects[0];
  let updates = 0;
  existing.update = async () => { updates++; };
  for (const other of [
    { ...source, id: "copy", uuid: "Scene.scene.Token.copy" },
    { ...source, uuid: "Scene.other.Token.source" }
  ]) {
    const [result] = await applyFailureEffects(action, { ...context, source: other });
    assert.equal(result.existing, true);
    assert.equal(result.applied, false);
  }
  assert.equal(updates, 0);
  assert.equal(target.actor.effects.length, 1);
});

test("effect-only failures distinguish immune, existing, and missing effects", async t => {
  const { aura, source, target } = setup(t);
  const registry = new AuraActionRegistry(); registerBuiltInActions(registry);
  const action = failureAction();
  const context = { aura, source, target };
  target.actor.system.traits.ci.value.add("frightened");
  const immune = await registry.execute(action, context);
  assert.equal(immune.reason, "KHZ_AURAS.Chat.NoEffectsApplied");
  assert.equal(immune.effects[0].immune, true);
  assert.equal(immune.status, "skipped");
  target.actor.system.traits.ci.value.clear();
  target.actor.effects = [{ name: "Existing", statuses: new Set(["frightened"]) }];
  const existing = await registry.execute(action, context);
  assert.equal(existing.effects[0].existing, true);
  globalThis.fromUuid = async () => null;
  const missing = await registry.execute({ ...action, save: { ...action.save, failureEffects: ["uuid:Actor.missing.ActiveEffect.gone"] } }, context);
  assert.equal(missing.status, "error");
  assert.equal(missing.effects[0].missing, true);
});

test("manual activation obeys consciousness and allows an explicitly independent aura", async t => {
  const { aura, source, flags } = setup(t);
  let calls = 0;
  const registry = new AuraActionRegistry();
  registry.register("healing", async () => { calls++; return { status: "applied", actionType: "healing", applied: 1 }; });
  const engine = new AuraEngine(registry);
  source.actor.statuses.add("unconscious");
  await engine.activateAura(source, aura.id);
  source.actor.statuses.clear(); source.actor.system.attributes.hp.value = 0;
  await engine.activateAura(source, aura.id);
  assert.equal(calls, 0);
  flags.auras[aura.id].source.requiresConscious = false;
  await engine.activateAura(source, aura.id);
  assert.equal(calls, 1);
});

test("queued manual activations revalidate the source and latest configuration", async t => {
  const { aura, source, flags, scene } = setup(t);
  let calls = 0;
  const registry = new AuraActionRegistry();
  registry.register("healing", async () => { calls++; return { status: "applied", actionType: "healing" }; });
  const mutations = [
    () => { flags.auras = {}; },
    () => { flags.auras[aura.id].enabled = false; },
    () => { flags.auras[aura.id].visualOnly = true; },
    () => { flags.auras[aura.id].triggers = [{ event: "turnStart", subject: "source" }]; },
    () => { scene.tokens.delete(source.id); },
    () => { game.user.isActiveGM = false; }
  ];
  for (const mutate of mutations) {
    flags.auras = { [aura.id]: structuredClone(aura) };
    scene.tokens.set(source.id, source); game.user.isActiveGM = true;
    const engine = new AuraEngine(registry);
    let release;
    const blocker = engine.enqueue(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const activation = engine.activateAura(source, aura.id);
    mutate(); release();
    await blocker; await activation;
  }
  assert.equal(calls, 0);
});

test("summary uses Foundry v14 message visibility without invoking the deprecated API", async t => {
  const { aura, source, messages, summaries } = setup(t);
  const registry = new AuraActionRegistry();
  registry.register("healing", async () => ({ status: "applied", actionType: "healing", applied: 2 }));
  ChatMessage.applyMode = data => { data.whisper = ["gm"]; data.blind = false; };
  ChatMessage.applyRollMode = () => { throw new Error("Deprecated API must not be used in v14"); };
  await new AuraEngine(registry).activateAura(source, aura.id);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].whisper, ["gm"]);
  assert.equal(summaries[0].groups[0].sourceName, source.name);
  assert.equal(summaries[0].groups[0].rows[0].targetName, "Bersaglio");
});

test("temporary hit point results report the actual non-stacking pool", async t => {
  const { aura, source, target } = setup(t);
  const registry = new AuraActionRegistry(); registerBuiltInActions(registry);
  target.actor.applyTempHP = async amount => { target.actor.system.attributes.hp.temp = Math.max(amount, target.actor.system.attributes.hp.temp); };
  const context = { aura, source, target, eventContext: { eventId: "manual" }, rollCache: new Map() };
  const result = await registry.execute({ id: "temp", type: "temphp", formula: "6" }, context);
  assert.equal(result.applied, 3);
  assert.equal(result.tempAfter, 6);
  const kept = await registry.execute({ id: "temp", type: "temphp", formula: "2" }, context);
  assert.equal(kept.applied, 0);
  assert.equal(kept.tempAfter, 6);
});

test("a batch involving different sources is not attributed entirely to its first aura", async t => {
  const { aura, source, target, scene, messages, summaries } = setup(t, {
    triggers: [{ event: "turnStart", subject: "affected", frequency: "always" }]
  });
  const secondAura = createDefaultAura({ ...aura, id: "second-aura", name: "Second aura" });
  const secondSource = { ...source, id: "second-source", uuid: "Scene.scene.Token.second-source", name: "Second source",
    getFlag: (_scope, key) => key === "auras" ? { [secondAura.id]: secondAura } : {} };
  scene.tokens.set(secondSource.id, secondSource);
  const registry = new AuraActionRegistry();
  registry.register("healing", async () => ({ status: "applied", actionType: "healing", applied: 1 }));
  await new AuraEngine(registry).handleCombatTurnChange({ id: "combat", scene, round: 1, turn: 0 },
    { round: 0, turn: null }, { round: 1, turn: 0, tokenId: target.id });
  assert.equal(messages.length, 1);
  assert.equal(summaries[0].groups.length, 2);
  assert.equal(messages[0].speaker.alias, "KHZ_AURAS.Chat.Title");
  assert.equal(messages[0].flavor, "KHZ_AURAS.Chat.Title");
});
