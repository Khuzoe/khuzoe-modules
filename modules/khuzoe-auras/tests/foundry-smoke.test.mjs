import test from "node:test";
import assert from "node:assert/strict";
import {auraRadiusPixels, tokenCenter, tokenPixelBounds, isWithinAura} from "../scripts/distance.js";
import {createDefaultAura} from "../scripts/model.js";

const onceHooks = new Map();
const recurringHooks = new Map();
const registeredSettings = [];

class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    this.options = options;
  }
  async _prepareContext() { return {}; }
  async _onRender() {}
  render() { return this; }
}

class DialogV2 {
  static async confirm() { return true; }
};

globalThis.Hooks = {
  once: (name, callback) => onceHooks.set(name, callback),
  on: (name, callback) => recurringHooks.set(name, callback),
  callAll: () => undefined
};

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      DialogV2,
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  },
  utils: {
    hasProperty: () => false,
    setProperty: () => undefined
  }
};

globalThis.game = {
  settings: {
    register: (moduleId, key, config) => registeredSettings.push({ moduleId, key, config })
  }
};

await import("../scripts/main.js");

test("main module registers lifecycle hooks without evaluating Foundry-only UI code", () => {
  assert.equal(typeof onceHooks.get("init"), "function");
  assert.equal(typeof onceHooks.get("ready"), "function");
  assert.equal(typeof recurringHooks.get("combatTurnChange"), "function");
  assert.equal(typeof recurringHooks.get("updateCombat"), "function");
  assert.equal(typeof recurringHooks.get("renderTokenHUD"), "function");
});

test("configuration window uses Foundry v14 ApplicationV2", async () => {
  const { AuraConfigApplication } = await import("../scripts/config.js");
  assert.equal(AuraConfigApplication.prototype instanceof ApplicationV2, true);
  assert.equal(AuraConfigApplication.DEFAULT_OPTIONS.tag, "form");
  assert.equal(AuraConfigApplication.PARTS.main.template.endsWith("aura-config.hbs"), true);
});

test("init exposes the public API and registers module settings", () => {
  globalThis.game = {
    settings: {
      register: (moduleId, key, config) => registeredSettings.push({ moduleId, key, config })
    }
  };
  onceHooks.get("init")();
  assert.equal(typeof game.khuzoeAuras.registerActionType, "function");
  assert.equal(typeof game.khuzoeAuras.registerVisualProvider, "function");
  assert.equal(typeof game.khuzoeAuras.getAuras, "function");
  assert.equal(typeof game.khuzoeAuras.getAura, "function");
  assert.equal(typeof game.khuzoeAuras.getAuraSources, "function");
  assert.equal(typeof game.khuzoeAuras.getEligibleTargets, "function");
  assert.equal(typeof game.khuzoeAuras.isTargetEligible, "function");
  assert.equal(typeof game.khuzoeAuras.activateAura, "function");
  assert.equal(game.khuzoeAuras.geometry.auraRadiusPixels, auraRadiusPixels);
  assert.equal(game.khuzoeAuras.geometry.tokenCenter, tokenCenter);
  assert.equal(game.khuzoeAuras.geometry.tokenPixelBounds, tokenPixelBounds);
  assert.equal(game.khuzoeAuras.geometry.isWithinAura, isWithinAura);
  assert.equal(registeredSettings.length, 2);
});

test("effect refresh during movement cannot consume an aura entry before arrival", async () => {
  class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
  const aura = createDefaultAura({area: {distance: 10}, targets: {relation: "ally", includeSource: false},
    triggers: [{event: "enter", subject: "affected", frequency: "always"}],
    actions: [{id: "heal", type: "healing"}]});
  const source = {id: "source", x: 0, y: 0, width: 1, height: 1, disposition: 1, elevation: 0,
    actor: {uuid: "Actor.source", system: {attributes: {hp: {value: 10}}}},
    getFlag: (_scope, key) => key === "auras" ? {[aura.id]: aura} : {}};
  const target = {...source, id: "target", x: 400, actor: {uuid: "Actor.target", system: {attributes: {hp: {value: 10}}}}, getFlag: () => ({})};
  const scene = {id: "movementScene", grid: {size: 100, distance: 5, isGridless: true},
    tokens: new Collection([[source.id, source], [target.id, target]])};
  source.parent = target.parent = scene;
  game.user = {id: "gm", isGM: true, isActiveGM: true}; game.scenes = [scene];
  game.settings.get = () => false; game.i18n = {localize: x => x, format: x => x};
  globalThis.canvas = {}; globalThis.ui = {notifications: {warn() {}, error() {}}};
  globalThis.requestAnimationFrame = callback => setImmediate(callback);
  globalThis.renderTemplate = async () => "";
  globalThis.ChatMessage = {create: async () => ({}), getSpeaker: () => ({})};
  let actions = 0;
  game.khuzoeAuras.registerActionType("healing", async () => { actions++; return {}; }, {replace: true});
  await game.khuzoeAuras.refresh(scene);
  let arrive;
  target.object = {movementAnimationPromise: new Promise(resolve => { arrive = resolve; })};
  target.x = 100;
  recurringHooks.get("updateToken")(target, {x: 100});
  await new Promise(resolve => setImmediate(resolve));
  recurringHooks.get("updateActiveEffect")({parent: target.actor});
  await game.khuzoeAuras.refresh(scene);
  assert.equal(actions, 0, "No aura entry fires during the animation");
  arrive();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 1, "The deferred actor refresh preserves exactly one entry at arrival");
});
