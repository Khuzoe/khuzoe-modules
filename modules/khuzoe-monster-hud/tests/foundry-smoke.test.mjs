import assert from "node:assert/strict";
import test from "node:test";

const onceHooks = new Map();
const recurringHooks = new Map();
const settings = [];
let randomId = 0;

class ApplicationV2 {
  constructor(options = {}) { this.options = options; }
  async _prepareContext() { return {}; }
  render() { return this; }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      HandlebarsApplicationMixin: Base => class extends Base {}
    }
  },
  utils: {
    randomID: () => `random-id-${++randomId}`
  }
};
globalThis.Hooks = {
  once: (name, callback) => onceHooks.set(name, callback),
  on: (name, callback) => recurringHooks.set(name, callback),
  callAll: () => undefined
};
globalThis.game = {
  i18n: {
    lang: "en",
    localize: key => key,
    format: key => key
  },
  settings: {
    register: (moduleId, key, definition) => settings.push({ moduleId, key, definition })
  }
};
globalThis.CONFIG = {
  DND5E: {
    activityActivationTypes: {
      action: { label: "Action", passive: false },
      legendary: { label: "Legendary", passive: false }
    },
    spellLevels: {}
  }
};

await import("../scripts/main.js");

test("module registers Foundry v14 and D&D5e lifecycle hooks", () => {
  assert.equal(typeof onceHooks.get("init"), "function");
  assert.equal(typeof onceHooks.get("ready"), "function");
  assert.equal(typeof recurringHooks.get("renderTokenHUD"), "function");
  assert.equal(typeof recurringHooks.get("dnd5e.postUseActivity"), "function");
});

test("init exposes the API and registers six settings", () => {
  onceHooks.get("init")();
  assert.equal(typeof game.khuzoeMonsterHud.configure, "function");
  assert.equal(typeof game.khuzoeMonsterHud.render, "function");
  assert.equal(settings.length, 6);
});
