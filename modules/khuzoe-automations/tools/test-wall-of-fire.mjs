import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  WALL_OF_FIRE_AUTOMATION,
  WALL_OF_FIRE_CAST_ACTIVITY_ID,
  WALL_OF_FIRE_DAMAGE_ACTIVITY_ID,
  WALL_OF_FIRE_DAMAGE_IDENTIFIER,
  WALL_OF_FIRE_HOT_REGION_IDENTIFIER,
  WALL_OF_FIRE_WALL_REGION_IDENTIFIER,
  buildCircleRegionShapes,
  buildLineRegionShapes,
  damageWallOfFireAtTurnEnd,
  damageWallOfFireOnMovement,
  chooseWallSideWithPreview,
  placeWallOfFire,
  prepareWallOfFireItemUpdate,
  registerWallOfFireCombatHooks,
  triggerWallOfFireTurnEnd,
  registerWallOfFire
} from "../scripts/wall-of-fire.mjs";

const itemPath = new URL(
  "../packData/khuzoe-spells-2014/Wall_of_Fire_KhzWallFire14001.json",
  import.meta.url
);
const itemData = JSON.parse(await readFile(itemPath, "utf8"));
const cast = itemData.system.activities[WALL_OF_FIRE_CAST_ACTIVITY_ID];
const regionDamage = itemData.system.activities[WALL_OF_FIRE_DAMAGE_ACTIVITY_ID];

assert.match(itemData._id, /^[A-Za-z0-9]{16}$/);
assert.match(cast._id, /^[A-Za-z0-9]{16}$/);
assert.match(regionDamage._id, /^[A-Za-z0-9]{16}$/);
assert.equal(itemData.system.identifier, "wall-of-fire");
assert.equal(itemData.system.level, 4);
assert.ok(itemData.system.properties.includes("concentration"));
assert.deepEqual(cast.save.ability, ["dex"]);
assert.equal(cast.damage.onSave, "half");
assert.equal(cast.damage.parts[0].number, 5);
assert.equal(cast.damage.parts[0].denomination, 8);
assert.equal(cast.damage.parts[0].scaling.mode, "whole");
assert.equal(cast.damage.parts[0].scaling.number, 1);
assert.equal(regionDamage.midiProperties.identifier, WALL_OF_FIRE_DAMAGE_IDENTIFIER);
assert.equal(regionDamage.midiProperties.automationOnly, true);
assert.equal(regionDamage.damage.parts[0].number, 5);
assert.equal(regionDamage.damage.parts[0].scaling.number, 1);
assert.deepEqual(itemData.flags.dnd5e.riders.activity, [WALL_OF_FIRE_DAMAGE_ACTIVITY_ID]);

const lineLeft = buildLineRegionShapes({
  start: {x: 0, y: 0},
  end: {x: 1200, y: 0},
  pixelsPerUnit: 20,
  side: "left"
});
assert.deepEqual(lineLeft.wall[0].points, [0, 10, 1200, 10, 1200, -10, 0, -10]);
assert.deepEqual(lineLeft.hot[0].points, [0, -10, 1200, -10, 1200, 210, 0, 210]);

const lineRight = buildLineRegionShapes({
  start: {x: 0, y: 0},
  end: {x: 1200, y: 0},
  pixelsPerUnit: 20,
  side: "right"
});
assert.deepEqual(lineRight.hot[0].points, [0, 10, 1200, 10, 1200, -210, 0, -210]);

const inward = buildCircleRegionShapes({
  center: {x: 500, y: 400},
  radiusFeet: 10,
  pixelsPerUnit: 20,
  facing: "inward"
});
assert.equal(inward.wall.length, 2);
assert.equal(inward.wall[0].radiusX, 210);
assert.equal(inward.wall[1].radiusX, 190);
assert.equal(inward.wall[1].hole, true);
assert.equal(inward.hot.length, 1);
assert.equal(inward.hot[0].radiusX, 210);

const outward = buildCircleRegionShapes({
  center: {x: 500, y: 400},
  radiusFeet: 10,
  pixelsPerUnit: 20,
  facing: "outward"
});
assert.equal(outward.hot[0].radiusX, 410);
assert.equal(outward.hot[1].radiusX, 190);
assert.equal(outward.hot[1].hole, true);

const macros = [];
const automations = [];
registerWallOfFire({
  registerFnMacro(data) { macros.push(data); return data; },
  registerAutomation(data) { automations.push(data); return data; }
});
assert.equal(macros.length, 3);
assert.equal(automations.length, 1);
assert.equal(automations[0], WALL_OF_FIRE_AUTOMATION);
assert.ok(macros.some(macro => macro.identifier === "wall-of-fire"
  && macro.roll.some(entry => entry.pass === "itemPreambleComplete")));
assert.ok(!macros.some(macro => macro.identifier === "wall-of-fire"
  && macro.roll.some(entry => entry.pass === "preambleComplete")));
assert.ok(macros.some(macro => macro.identifier === WALL_OF_FIRE_WALL_REGION_IDENTIFIER
  && macro.region.some(entry => entry.pass === "enter")
  && macro.region.some(entry => entry.pass === "passedThrough")));
assert.ok(macros.some(macro => macro.identifier === WALL_OF_FIRE_HOT_REGION_IDENTIFIER
  && macro.combat.some(entry => entry.pass === "regionTurnEnd")));

let previewAdded = 0;
let previewRemoved = 0;
let previewDestroyed = 0;
let previewPolygons = 0;
class PreviewGraphics {
  lineStyle() { return this; }
  beginFill() { return this; }
  beginHole() { return this; }
  endHole() { return this; }
  drawPolygon() { previewPolygons += 1; return this; }
  drawEllipse() { return this; }
  endFill() { return this; }
  destroy() { previewDestroyed += 1; }
}
class PreviewButton {
  constructor(action) {
    this.dataset = {action};
    this.listeners = new Map();
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
}
const previewInterface = {
  addChild(graphics) {
    previewAdded += 1;
    graphics.parent = this;
    return graphics;
  },
  removeChild(graphics) {
    previewRemoved += 1;
    graphics.parent = null;
  }
};
globalThis.PIXI = {Graphics: PreviewGraphics};
globalThis.canvas = {interface: previewInterface};
globalThis.foundry = {
  applications: {api: {DialogV2: class {
    static async wait(config) {
      const buttons = config.buttons.map(button => new PreviewButton(button.action));
      config.render(null, {element: {querySelectorAll: () => buttons}});
      buttons.find(button => button.dataset.action === "right").listeners.get("pointerenter")();
      return "right";
    }
  }}}
};
assert.equal(await chooseWallSideWithPreview("Wall of Fire", "Scegli il lato.", {
  left: lineLeft,
  right: lineRight
}), "right");
assert.equal(previewAdded, 1);
assert.equal(previewRemoved, 1);
assert.equal(previewDestroyed, 1);
assert.equal(previewPolygons, 2, "l'anteprima deve mostrare area calda e parete");

const changes = {
  system: {identifier: "wall-of-fire"},
  flags: {cat: {automation: {source: "khuzoe-automations"}}},
  img: "icons/replacement.webp"
};
prepareWallOfFireItemUpdate({
  system: {identifier: "wall-of-fire"},
  img: "custom/wall.webp"
}, changes);
assert.equal(changes.img, "custom/wall.webp");

// Regressione v14/CAT: il pass deve arrivare alla macro dell'Item, creare
// entrambe le Region e restituire un valore falsy, altrimenti CAT interrompe
// il workflow subito dopo il posizionamento.
const placementChoices = ["line", 60, "left", 20];
const createdRegions = [];
const deletedDocuments = [];
const placementScene = {
  id: "scene-placement",
  uuid: "Scene.placement",
  grid: {size: 100, distance: 5}
};
const caster = {
  id: "caster",
  effects: [],
  system: {attributes: {spelldc: 16}}
};
const wallItem = {
  id: "wall-item",
  uuid: "Actor.caster.Item.wall-item",
  name: "Wall of Fire",
  actor: caster,
  system: {level: 4}
};
const casterToken = {
  id: "caster-token",
  parent: placementScene,
  elevation: 0,
  object: {center: {x: 100, y: 100}}
};

class TestTemplateDocument {
  constructor(data, {parent}) {
    Object.assign(this, data);
    this.parent = parent;
  }
}
class TestAbilityTemplate {
  async drawPreview() {
    return [{
      id: "template",
      uuid: "Scene.placement.MeasuredTemplate.template",
      x: 100,
      y: 100,
      parent: placementScene,
      object: {ray: {A: {x: 100, y: 100}, B: {x: 1300, y: 100}}}
    }];
  }
}

globalThis.CONFIG = {
  MeasuredTemplate: {documentClass: TestTemplateDocument},
  specialStatusEffects: {CONCENTRATING: "concentrating"}
};
globalThis.canvas = {scene: placementScene};
globalThis.foundry = {utils: {randomID: () => "WallCastTest0001"}};
globalThis.game = {
  user: {id: "player", color: "#ff6a00", isGM: false},
  dnd5e: {canvas: {AbilityTemplate: TestAbilityTemplate}}
};
globalThis.cat = {
  utils: {
    activityUtils: {getSaveDC: () => 16},
    dialogUtils: {buttonDialog: async () => placementChoices.shift()},
    documentUtils: {
      async createEmbeddedDocuments(_parent, type, documents) {
        assert.equal(type, "Region");
        const data = documents[0];
        const region = {
          ...data,
          id: `region-${createdRegions.length + 1}`,
          uuid: `Scene.placement.Region.region-${createdRegions.length + 1}`,
          documentName: "Region",
          tokens: new Set(),
          isOwner: true,
          async update() { return this; }
        };
        createdRegions.push(region);
        return [region];
      },
      async deleteDocument(document) { deletedDocuments.push(document); }
    },
    workflowUtils: {async updateTargets(_workflow, targets) { assert.deepEqual(targets, []); }}
  }
};

const placementWorkflow = {
  actor: caster,
  item: wallItem,
  token: casterToken,
  castData: {castLevel: 4, saveDC: 16},
  targets: new Set()
};
assert.equal(await placeWallOfFire({
  workflow: placementWorkflow,
  activity: {id: WALL_OF_FIRE_CAST_ACTIVITY_ID},
  actor: caster,
  item: wallItem,
  token: casterToken
}), false);
assert.equal(placementWorkflow.aborted, undefined);
assert.equal(createdRegions.length, 2);
assert.equal(createdRegions[0].flags["khuzoe-automations"].wallOfFire.kind, "wall");
assert.equal(createdRegions[1].flags["khuzoe-automations"].wallOfFire.kind, "hot");
assert.equal(placementWorkflow["khuzoe-automations.wallOfFireRegions"].length, 2);
assert.equal(deletedDocuments.length, 1, "il template guida deve essere rimosso dopo la creazione delle Region");

const activity = {_id: WALL_OF_FIRE_DAMAGE_ACTIVITY_ID, id: WALL_OF_FIRE_DAMAGE_ACTIVITY_ID};
const item = {
  uuid: "Actor.caster.Item.wall",
  system: {activities: new Map([[WALL_OF_FIRE_DAMAGE_ACTIVITY_ID, activity]])}
};
const controller = {
  uuid: "Scene.test.Region.wall",
  isOwner: true,
  flags: {
    "khuzoe-automations": {
      wallOfFire: {
        kind: "wall",
        originItemUuid: item.uuid,
        castId: "cast-1",
        castLevel: 6,
        saveDC: 17
      }
    }
  },
  async update(update) {
    for (const [path, value] of Object.entries(update)) {
      const parts = path.split(".");
      let object = this;
      for (const part of parts.slice(0, -1)) object = object[part] ??= {};
      object[parts.at(-1)] = value;
    }
    return this;
  }
};
const hot = {
  uuid: "Scene.test.Region.hot",
  flags: {
    "khuzoe-automations": {
      wallOfFire: {
        kind: "hot",
        originItemUuid: item.uuid,
        castId: "cast-1",
        castLevel: 6,
        saveDC: 17,
        controllerRegionUuid: controller.uuid
      }
    }
  }
};
const target = {id: "target-1", documentName: "Token"};
let damageUses = 0;
let lastUse;

globalThis.game = {
  user: {id: "gm", isGM: true},
  combat: {id: "combat", started: true, isActive: true, round: 2, turn: 3}
};
globalThis.cat = {
  utils: {
    workflowUtils: {
      async completeActivityUse(usedActivity, targets, options) {
        damageUses += 1;
        lastUse = {usedActivity, targets, options};
        return {};
      }
    }
  }
};
globalThis.fromUuid = async uuid => {
  if (uuid === item.uuid) return item;
  if (uuid === controller.uuid) return controller;
};

assert.equal(await damageWallOfFireOnMovement({document: controller, tokens: new Set([target])}), true);
assert.equal(damageUses, 1);
assert.equal(lastUse.usedActivity, activity);
assert.equal(lastUse.targets[0], target);
assert.equal(lastUse.options.atLevel, 6);
assert.equal(lastUse.options.fast, true, "Region damage must not wait for a damage dialog");
assert.equal(lastUse.options.autoDamage, true, "Region damage must roll even with manual Midi settings");
assert.equal(lastUse.options.options.workflowOptions.autoRollDamage, "always");
assert.equal(lastUse.options.consumeUsage, false);
assert.equal(lastUse.options.consumeResources, false);
assert.equal(lastUse.options.spellSlot, false);
assert.equal(lastUse.options.config.consume.action, false);

// Entry and turn end are distinct; duplicate events in each phase remain suppressed.
assert.equal(await damageWallOfFireOnMovement({document: controller, tokens: new Set([target])}), false);
assert.equal(await damageWallOfFireAtTurnEnd({document: hot, token: target}), true);
assert.equal(await damageWallOfFireAtTurnEnd({document: hot, token: target}), false);
assert.equal(damageUses, 2);

globalThis.game.combat.turn = 4;
assert.equal(await damageWallOfFireAtTurnEnd({document: hot, token: target}), true);
assert.equal(damageUses, 3);

game.combat.turn = 5;
const successUse = cat.utils.workflowUtils.completeActivityUse;
cat.utils.workflowUtils.completeActivityUse = async () => ({aborted: true});
assert.equal(await damageWallOfFireAtTurnEnd({document: hot, token: target}), false);
cat.utils.workflowUtils.completeActivityUse = successUse;
assert.equal(await damageWallOfFireAtTurnEnd({document: hot, token: target}), true, "An aborted workflow does not consume the trigger");

// Run the installed CAT event/trigger classes and its completeActivityUse
// implementation. Keep only the Foundry documents and the Midi boundary mocked.
const sourceMap = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
function original(file, deps, name) {
  const index = sourceMap.sources.findIndex(path => path.endsWith(`/scripts/${file}.mjs`));
  assert.ok(index >= 0, file);
  let code = sourceMap.sourcesContent[index];
  if (name) {
    code = code.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n}`))[0] + `\nreturn ${name};`;
  } else code = code.replace(/^import .*;\r?\n/gm, "").replace("export default", "return");
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}
String.prototype.slugify ??= function() { return String(this).toLowerCase().replace(/\W+/g, "-"); };
String.prototype.capitalize ??= function() { return this[0].toUpperCase() + this.slice(1); };
function mergeObject(base, extra) {
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === "object" && !Array.isArray(value)) base[key] = mergeObject(base[key] ?? {}, value);
    else base[key] = value;
  }
  return base;
}
const genericUtils = {mergeObject};
const actorUtils = {
  getEquivalentSpellSlotName: (_actor, level) => `spell${level}`,
  getEffects: actor => actor.effects, getGroups: () => [], getEncounters: () => [], getVehicles: () => []
};
const queryUtils = {isTheGM: () => game.user.id === "gm", firstOwner: () => "gm", hasPermission: () => true};
const tokenUtils = {getDistance: () => 0};
const documentUtils = {
  getIdentifier: document => document.flags?.cat?.identifier ?? document.name,
  getSavedCastData: document => document.flags?.cat?.castData ?? {castLevel: 6, saveDC: 17}
};
const constants = {combatPasses: {turnEnd: "turnEnd", turnStart: "turnStart", everyTurn: "everyTurn"},
  macros: {getFnMacros(source, rules, identifier, type, pass) {
    const entry = macros.find(macro => macro.source === source && macro.rules === rules && macro.identifier === identifier);
    const matches = entry?.[type]?.filter(macro => macro.pass === pass);
    return matches?.length ? {source, rules, identifier, macros: matches} : undefined;
  }}};
const Logging = {addEntry() {}, addMacroError(_trigger, error) { throw error; }};
const Triggers = original("lib/trigger", {automationUtils: {}, documentUtils, tokenUtils, constants,
  EmbeddedMacros: class { getMacros() { return []; } }});
const Events = original("lib/event", {actorUtils, documentUtils, tokenUtils, genericUtils,
  effectUtils: {}, utils: {}, Triggers, Logging, constants, DamageBonus: class {}, D20Bonus: class {}});
const regions = {async processRegionActivities() {}};
const catCombat = original("events/combat", {constants, Events, genericUtils, queryUtils, regions});
const catComplete = original("utilities/workflowUtils", {actorUtils, queryUtils, genericUtils}, "completeActivityUse");
cat.utils.queryUtils = queryUtils;
cat.utils.workflowUtils.completeActivityUse = catComplete;
game.userId = "gm";
game.settings = {get: () => false};
const midiCalls = [];
globalThis.MidiQOL = {
  configSettings: () => ({autoRollDamage: "none", gmAutoDamage: "none"}),
  async completeActivityUse(usedActivity, config) {
    midiCalls.push({usedActivity, config});
    return {aborted: false};
  }
};
const targetActor = {name: "Target", items: [], effects: []};
const testScene = {id: "test", tokens: [target], levels: new Map()};
Object.assign(target, {uuid: "Scene.test.Token.target-1", actor: targetActor, parent: testScene, regions: [hot]});
Object.assign(hot, {name: "Wall of Fire — Hot", documentName: "Region", parent: testScene});
hot.flags.cat = structuredClone(createdRegions[1].flags.cat);
activity.actor = {id: "caster"};
const combat = game.combat;
Object.assign(combat, {scene: testScene, combatants: new Map([["ending", {token: target}]])});
function setTransition(round, turn, nextRound = round, nextTurn = turn + 1) {
  combat.previous = {round, turn, combatantId: "ending"};
  combat.current = {round: nextRound, turn: nextTurn, combatantId: "next"};
  combat.round = nextRound; combat.turn = nextTurn;
}

await catComplete(activity, [target], {atLevel: 6});
assert.equal(midiCalls[0].config.midiOptions.workflowOptions.autoRollDamage, undefined,
  "The old call leaves Midi's manual damage setting in control");
assert.equal(midiCalls[0].config.midiOptions.workflowOptions.autoFastDamage, false);
midiCalls.length = 0;
setTransition(7, 2);
await catCombat.updateCombat(combat, {turn: 3}, {});
assert.equal(midiCalls.length, 1, "CAT resolves the registered hot-side Region macro on the ending token");
const config = midiCalls[0].config;
assert.equal(config.midiOptions.workflowOptions.autoRollDamage, "always");
assert.equal(config.midiOptions.workflowOptions.autoFastDamage, true);
assert.deepEqual(config.midiOptions.targetUuids, [target.uuid]);
assert.equal(config.spell.slot, "spell6");
assert.deepEqual(config.consume, {resources: false, spellSlot: false, action: false});
assert.equal(config.consumeUsage, false);
assert.equal(controller.flags["khuzoe-automations"].wallOfFire.stamps.end.turnKey, "combat:7:2:end");
await triggerWallOfFireTurnEnd(combat);
assert.equal(midiCalls.length, 1, "CAT and fallback deduplicate using the turn that ended");

const combatHooks = new Map();
registerWallOfFireCombatHooks({on: (name, callback) => combatHooks.set(name, callback)});
const drain = () => new Promise(resolve => setImmediate(resolve));
setTransition(7, 3);
regions.processRegionActivities = async () => { throw new Error("Earlier Region activity failed"); };
await assert.rejects(() => catCombat.updateCombat(combat, {turn: 4}, {}), /Earlier Region activity failed/);
assert.equal(midiCalls.length, 1, "An earlier error prevents CAT from reaching Wall of Fire");
combatHooks.get("updateCombat")(combat, {turn: 4}, {});
await drain();
assert.equal(midiCalls.length, 2, "The early native hook recovers a skipped CAT callback");
combatHooks.get("combatTurnChange")(combat, combat.previous, combat.current);
await drain();
assert.equal(midiCalls.length, 2, "The later native hook must not damage twice");

regions.processRegionActivities = async () => {};
setTransition(7, 4);
await Promise.all([catCombat.updateCombat(combat, {turn: 5}, {}), triggerWallOfFireTurnEnd(combat)]);
assert.equal(midiCalls.length, 3, "Concurrent dispatch paths cannot start duplicate Midi workflows");
await damageWallOfFireAtTurnEnd({document: hot, token: target, combat, round: 7, turn: 2});
assert.equal(midiCalls.length, 3, "A late callback from an older turn is still suppressed");

setTransition(7, 5, 8, 0);
combatHooks.get("updateCombat")(combat, {round: 8, turn: 0}, {});
await drain();
assert.equal(midiCalls.length, 4, "The last turn in a round also deals hot-side damage");
setTransition(8, 0);
target.regions = [controller];
assert.equal(await triggerWallOfFireTurnEnd(combat), false, "Only hot-side membership triggers turn-end damage");
target.regions = [hot];
combatHooks.get("updateCombat")(combat, {turn: 1}, {turnEvents: false});
combatHooks.get("updateCombat")(combat, {combatants: []}, {});
combatHooks.get("updateCombat")(combat, {name: "Renamed"}, {});
await drain();
assert.equal(midiCalls.length, 4, "Suppressed turn events and unrelated edits do not deal damage");
game.user = {id: "player", isGM: false};
assert.equal(await triggerWallOfFireTurnEnd(combat), false);
game.user = {id: "other-gm", isGM: true};
game.users = {activeGM: game.user};
assert.equal(await triggerWallOfFireTurnEnd(combat), false, "Respect CAT/Midi's preferred GM");
game.user = {id: "gm", isGM: true};
assert.equal(await triggerWallOfFireTurnEnd(combat), true, "The selected GM can run even if another is activeGM");
assert.equal(midiCalls.length, 5);

setTransition(8, 2, 8, 1);
assert.equal(await triggerWallOfFireTurnEnd(combat), false, "Rewinding is not another end of turn");
setTransition(8, 2, 8, 2);
assert.equal(await triggerWallOfFireTurnEnd(combat), false);
setTransition(0, 0, 1, 0);
assert.equal(await triggerWallOfFireTurnEnd(combat), false, "Starting combat does not end a previous turn");
setTransition(8, 3);
combat.isActive = false;
assert.equal(await triggerWallOfFireTurnEnd(combat), false);
combat.isActive = true;
combat.started = false;
assert.equal(await triggerWallOfFireTurnEnd(combat), false);
combat.started = true;
assert.equal(midiCalls.length, 5);
console.log("Khuzoe Wall of Fire: geometry, placement, CAT dispatch, automatic damage, native fallback and duplicate/GM/turn guards OK");
