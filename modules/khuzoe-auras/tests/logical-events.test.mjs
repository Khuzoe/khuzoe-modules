import test from "node:test";
import assert from "node:assert/strict";
import {AuraEngine} from "../scripts/engine.js";
import {AuraActionRegistry} from "../scripts/registry.js";
import {registerBuiltInActions} from "../scripts/actions.js";
import {createDefaultAura} from "../scripts/model.js";

class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
function setup(aura) {
  const source = {id: "source", name: "Source", x: 0, y: 0, width: 1, height: 1, elevation: 0, disposition: 1,
    actor: {system: {attributes: {hp: {value: 10, max: 20}}}},
    getFlag: (_scope, key) => key === "auras" ? {[aura.id]: aura} : {}};
  const target = {...source, id: "target", name: "Target", x: 100, getFlag: () => ({})};
  const scene = {id: "scene", name: "Scene", grid: {size: 100, sizeX: 100, sizeY: 100, distance: 5, isGridless: true},
    tokens: new Collection([[source.id, source], [target.id, target]])};
  source.parent = target.parent = scene;
  globalThis.game = {user: {id: "gm", isGM: true, isActiveGM: true}, scenes: [scene],
    settings: {get: () => false}, i18n: {localize: x => x, format: x => x}};
  globalThis.ui = {notifications: {error() {}, warn() {}}};
  globalThis.CONFIG = {DND5E: {abilities: {}, damageTypes: {}}};
  globalThis.renderTemplate = async () => "summary";
  globalThis.ChatMessage = {getSpeaker: () => ({}), create: async () => ({})};
  return {scene, source, target};
}

test("shared healing keeps maximization local to each target in either order", async () => {
  class Roll {
    constructor(formula) { this.formula = formula; this.total = 3; }
    async evaluate() { return this; }
    async reroll() { return {formula: this.formula, total: 6}; }
  }
  globalThis.Roll = Roll;
  const registry = new AuraActionRegistry(); registerBuiltInActions(registry);
  const aura = createDefaultAura();
  const {source, target} = setup(aura);
  source.actor.getRollData = () => ({});
  const action = {id: "heal", type: "healing", formula: "1d6", rollMode: "shared"};
  for (const order of [[true, false], [false, true]]) {
    const rollCache = new Map();
    for (const maximum of order) {
      target.actor = {flags: {"midi-qol": {grants: {max: {damage: {heal: maximum}}}}},
        system: {attributes: {hp: {value: 1, max: 20}}},
        async applyDamage(parts) { this.system.attributes.hp.value += parts[0].value; }};
      const result = await registry.execute(action, {source, target, aura, rollCache, eventContext: {eventId: "same"}});
      assert.equal(result.total, maximum ? 6 : 3);
    }
  }
});

test("retry only a failed aura action; duplicate native notifications never repeat successful actions", async () => {
  for (const frequency of ["oncePerPhase", "always"]) {
    const aura = createDefaultAura({targets: {relation: "ally", includeSource: false},
      triggers: [{event: "turnStart", subject: "affected", frequency}],
      actions: [{id: "first", type: "healing"}, {id: "second", type: "healing"}]});
    const {scene, target} = setup(aura);
    const registry = new AuraActionRegistry(); const calls = [];
    let fail = true;
    registry.register("healing", async action => {
      calls.push(action.id);
      if (action.id === "second" && fail) throw new Error("Expected cancelled action");
      return {status: "applied", actionType: "healing"};
    });
    const engine = new AuraEngine(registry);
    const combat = {id: "combat", scene, round: 1, turn: 0};
    const previous = {round: 0, turn: null};
    const current = {round: 1, turn: 0, tokenId: target.id};
    await engine.handleCombatTurnChange(combat, previous, current);
    fail = false;
    await engine.handleCombatTurnChange(combat, previous, current);
    await engine.handleCombatTurnChange(combat, previous, current);
    assert.deepEqual(calls, ["first", "second", "second"]);
  }
});

test("outside combat every re-entry is eligible instead of remaining stamped forever", async () => {
  const aura = createDefaultAura({targets: {relation: "ally", includeSource: false},
    triggers: [{event: "enter", subject: "affected", frequency: "oncePerPhase"}]});
  const {scene, target} = setup(aura);
  const registry = new AuraActionRegistry(); let calls = 0;
  registry.register("healing", async () => { calls++; return {status: "applied", actionType: "healing"}; });
  const engine = new AuraEngine(registry);
  target.x = 2000; await engine.refreshMembership(scene, {emit: false});
  for (let entry = 0; entry < 2; entry++) {
    target.x = 100; await engine.refreshMembership(scene, {emit: true});
    target.x = 2000; await engine.refreshMembership(scene, {emit: true});
  }
  assert.equal(calls, 2);
});
