import test from "node:test";
import assert from "node:assert/strict";

import { AuraEngine } from "../scripts/engine.js";
import { AuraActionRegistry } from "../scripts/registry.js";
import { createDefaultAura } from "../scripts/model.js";

class DocumentCollection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
}

test("visual-only auras never execute actions or create chat summaries", async () => {
  let executions = 0;
  const messages = [];
  const registry = new AuraActionRegistry();
  registry.register("healing", async () => {
    executions += 1;
    return { status: "applied", actionType: "healing", applied: 1 };
  });

  const aura = createDefaultAura({
    visualOnly: true,
    targets: { relation: "ally", includeSource: true },
    triggers: [{ event: "turnStart", subject: "source", frequency: "always" }]
  });
  const actor = { system: { attributes: { hp: { value: 10, max: 10 } } } };
  const source = {
    id: "visual-source", name: "Visual Source", x: 0, y: 0, width: 1, height: 1,
    elevation: 0, disposition: 1, actor,
    getFlag: () => ({ [aura.id]: aura })
  };
  const scene = {
    id: "visual-scene",
    name: "Visual Scene",
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    tokens: new DocumentCollection([[source.id, source]])
  };
  source.parent = scene;

  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    scenes: [scene],
    settings: { get: () => false },
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.ui = { notifications: { error: () => undefined, warn: () => undefined } };
  globalThis.CONFIG = { DND5E: { damageTypes: {}, abilities: {} } };
  globalThis.renderTemplate = async () => "<p>summary</p>";
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    create: async data => messages.push(data)
  };

  const engine = new AuraEngine(registry);
  engine.initialize();
  await engine.handleCombatTurnChange(
    { id: "combat", scene, round: 1, turn: 0 },
    { round: 1, turn: null, tokenId: null },
    { round: 1, turn: 0, tokenId: source.id }
  );

  assert.equal(executions, 0);
  assert.equal(messages.length, 0);
});

test("a successful save immunity prevents later executions of the same aura", async () => {
  let executions = 0;
  const messages = [];
  const registry = new AuraActionRegistry();
  registry.register("healing", async (_action, context) => {
    executions += 1;
    return {
      status: "applied",
      actionType: "healing",
      sourceId: context.source.id,
      sourceName: context.source.name,
      targetId: context.target.id,
      targetName: context.target.name,
      auraId: context.aura.id,
      auraName: context.aura.name,
      total: 0,
      applied: 0,
      grantAuraImmunity: true
    };
  });

  const aura = createDefaultAura({
    targets: { relation: "ally", includeSource: true },
    triggers: [{ event: "turnStart", subject: "source", frequency: "oncePerPhase" }],
    actions: [{ id: "save-action", type: "healing", save: { immunityOnSuccess: true } }]
  });
  const flags = { auras: { [aura.id]: aura }, immunities: {} };
  const actor = { system: { attributes: { hp: { value: 10, max: 10 } } } };
  const source = {
    id: "immune-source", name: "Immune Source", x: 0, y: 0, width: 1, height: 1,
    elevation: 0, disposition: 1, actor,
    getFlag: (_moduleId, key) => flags[key],
    setFlag: async (_moduleId, key, value) => {
      flags[key] = structuredClone(value);
      return value;
    }
  };
  const scene = {
    id: "immune-scene",
    name: "Immune Scene",
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    tokens: new DocumentCollection([[source.id, source]])
  };
  source.parent = scene;

  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    scenes: [scene],
    settings: { get: () => false },
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.ui = { notifications: { error: () => undefined, warn: () => undefined } };
  globalThis.CONFIG = { DND5E: { damageTypes: {}, abilities: {} } };
  globalThis.renderTemplate = async () => "<p>summary</p>";
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    create: async data => messages.push(data)
  };

  const engine = new AuraEngine(registry);
  engine.initialize();
  await engine.handleCombatTurnChange(
    { id: "combat", scene, round: 1, turn: 0 },
    { round: 1, turn: null, tokenId: null },
    { round: 1, turn: 0, tokenId: source.id }
  );
  await engine.handleCombatTurnChange(
    { id: "combat", scene, round: 2, turn: 0 },
    { round: 1, turn: 0, tokenId: source.id },
    { round: 2, turn: 0, tokenId: source.id }
  );

  assert.equal(executions, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(flags.immunities[aura.id], [source.id]);
});

test("affected token can trigger the same aura at both turn start and turn end", async () => {
  let executions = 0;
  const messages = [];
  const registry = new AuraActionRegistry();
  registry.register("healing", async (_action, context) => {
    executions += 1;
    return {
      status: "applied",
      actionType: "healing",
      sourceId: context.source.id,
      sourceName: context.source.name,
      targetId: context.target.id,
      targetName: context.target.name,
      auraId: context.aura.id,
      auraName: context.aura.name,
      total: 1,
      applied: 1
    };
  });

  const aura = createDefaultAura({
    targets: { relation: "ally", includeSource: false },
    triggers: [
      { event: "turnStart", subject: "affected", frequency: "oncePerPhase" },
      { event: "turnEnd", subject: "affected", frequency: "oncePerPhase" }
    ]
  });
  const auraMap = { [aura.id]: aura };
  const actor = { system: { attributes: { hp: { value: 10, max: 10 } } } };
  const source = {
    id: "source",
    name: "Source",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    elevation: 0,
    disposition: 1,
    actor,
    getFlag: () => auraMap
  };
  const target = {
    id: "target",
    name: "Target",
    x: 100,
    y: 0,
    width: 1,
    height: 1,
    elevation: 0,
    disposition: 1,
    actor,
    getFlag: () => ({})
  };
  const scene = {
    id: "scene",
    name: "Scene",
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    tokens: new DocumentCollection([[source.id, source], [target.id, target]])
  };
  source.parent = scene;
  target.parent = scene;

  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    scenes: [scene],
    settings: { get: () => false },
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.ui = { notifications: { error: () => undefined, warn: () => undefined } };
  globalThis.CONFIG = { DND5E: { damageTypes: {}, abilities: {} } };
  globalThis.renderTemplate = async () => "<p>summary</p>";
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    create: async data => messages.push(data)
  };

  const combat = { id: "combat", scene, round: 1, turn: 0 };
  const engine = new AuraEngine(registry);
  engine.initialize();

  await engine.handleCombatTurnChange(
    combat,
    { round: 1, turn: null, tokenId: null },
    { round: 1, turn: 0, tokenId: target.id }
  );
  // updateCombat e combatTurnChange possono segnalare la stessa transizione:
  // il ledger deve impedire una seconda cura.
  await engine.handleCombatTurnChange(
    combat,
    { round: 1, turn: null, tokenId: null },
    { round: 1, turn: 0, tokenId: target.id }
  );
  await engine.handleCombatTurnChange(
    { ...combat, turn: 1 },
    { round: 1, turn: 0, tokenId: target.id },
    { round: 1, turn: 1, tokenId: source.id }
  );

  assert.equal(executions, 2);
  assert.equal(messages.length, 2);
});
test("enter triggers honor highest-priority stacking across overlapping auras", async () => {
  const executedAuras = [];
  const registry = new AuraActionRegistry();
  registry.register("healing", async (_action, context) => {
    executedAuras.push(context.aura.id);
    return {
      status: "applied",
      actionType: "healing",
      sourceId: context.source.id,
      sourceName: context.source.name,
      targetId: context.target.id,
      targetName: context.target.name,
      auraId: context.aura.id,
      auraName: context.aura.name,
      total: 1,
      applied: 1
    };
  });

  const shared = {
    targets: { relation: "ally", includeSource: false },
    triggers: [{ event: "enter", subject: "affected", frequency: "oncePerPhase" }],
    stacking: { group: "overlapping-blessing", mode: "highest" }
  };
  const lowAura = createDefaultAura({ ...shared, name: "Low", stacking: { ...shared.stacking, priority: 1 } });
  const highAura = createDefaultAura({ ...shared, name: "High", stacking: { ...shared.stacking, priority: 10 } });
  const actor = { system: { attributes: { hp: { value: 10, max: 10 } } } };
  const lowSource = {
    id: "low-source", name: "Low Source", x: 0, y: 0, width: 1, height: 1,
    elevation: 0, disposition: 1, actor,
    getFlag: () => ({ [lowAura.id]: lowAura })
  };
  const highSource = {
    id: "high-source", name: "High Source", x: 100, y: 0, width: 1, height: 1,
    elevation: 0, disposition: 1, actor,
    getFlag: () => ({ [highAura.id]: highAura })
  };
  const target = {
    id: "moving-target", name: "Moving Target", x: 2000, y: 0, width: 1, height: 1,
    elevation: 0, disposition: 1, actor,
    getFlag: () => ({})
  };
  const scene = {
    id: "movement-scene",
    name: "Movement Scene",
    grid: { isGridless: true, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    tokens: new DocumentCollection([
      [lowSource.id, lowSource],
      [highSource.id, highSource],
      [target.id, target]
    ])
  };
  lowSource.parent = scene;
  highSource.parent = scene;
  target.parent = scene;

  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    scenes: [scene],
    combat: null,
    settings: { get: () => false },
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.ui = { notifications: { error: () => undefined, warn: () => undefined } };
  globalThis.CONFIG = { DND5E: { damageTypes: {}, abilities: {} } };
  globalThis.renderTemplate = async () => "<p>summary</p>";
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => undefined };

  const engine = new AuraEngine(registry);
  engine.initialize();
  target.x = 200;
  await engine.refreshMembership(scene, { emit: true });

  assert.deepEqual(executedAuras, [highAura.id]);
});
