import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {khuzoeRegistrationApi} from "../scripts/activity-compat.mjs";
import {triggerCombatFallback, registerCombatFallbackHooks} from "../scripts/combat-events.mjs";
import {registerExpandedSpells2014, expandedFlameMotion, finishExpandedSpell} from "../scripts/expanded-spells-2014.mjs";
import {createSpellArea, registerPersistentSpellAreas} from "../scripts/persistent-spell-areas.mjs";
import {triggerBoomingBladeMovement, triggerGuardianOfFaith, SPELL_2014_ACTIVITY_IDS} from "../scripts/spells-2014.mjs";
import {grantTemporaryHP, removeOwnedTemporaryHP} from "../scripts/temporary-hp.mjs";
import {nearbyTokens, slideTokenFeet, teleportTokenFeet} from "../scripts/movement-compat.mjs";

const MODULE = "khuzoe-automations";
const sourceMap = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
function original(file, deps) {
  const index = sourceMap.sources.findIndex(path => path.endsWith(`/scripts/${file}.mjs`));
  assert.ok(index >= 0);
  const code = sourceMap.sourcesContent[index].replace(/^import .*;\r?\n/gm, "").replace("export default", "return");
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}
String.prototype.slugify ??= function() { return String(this).toLowerCase().replace(/\W+/g, "-"); };
String.prototype.capitalize ??= function() { return this[0].toUpperCase() + this.slice(1); };
const docs = new Map();
function put(object, path, value) {
  const keys = path.split("."), last = keys.pop();
  keys.reduce((entry, key) => entry[key] ??= {}, object)[last] = structuredClone(value);
}
let serial = 0;
function document(data) {
  const entry = {...data, isOwner: true, id: data.id ?? `doc${++serial}`,
    async update(changes) { for (const [path, value] of Object.entries(changes)) put(this, path, value); return this; }};
  entry.uuid ??= `${data.documentName ?? "Actor"}.${entry.id}`;
  docs.set(entry.uuid, entry); return entry;
}
const registrations = new Map();
const api = {registerAutomation() {}, registerFnMacro(data) { registrations.set(data.identifier, data); return data; }};
const constants = {macros: {getFnMacros(source, rules, identifier, type, pass) {
  const entry = registrations.get(identifier);
  const macros = entry?.[type]?.filter(macro => macro.pass === pass);
  return macros?.length ? {source, rules, identifier, macros} : undefined;
}}};
const actorUtils = {getEffects: actor => actor.effects, getGroups: () => [], getEncounters: () => [], getVehicles: () => [],
  getFirstToken: actor => actor.token, applyConditions: async actor => { actor.prone = true; }};
let distance = 5;
const tokenUtils = {getDistance: () => distance};
const documentUtils = {getIdentifier: entry => entry.flags?.cat?.identifier ?? entry.name,
  getSavedCastData: () => ({castLevel: 6, saveDC: 17}), async makeDependent() {}};
const Logging = {addEntry() {}, addMacroError(_trigger, error) { throw error; }};
const Triggers = original("lib/trigger", {automationUtils: {}, documentUtils, tokenUtils, constants,
  EmbeddedMacros: class { getMacros() { return []; } }});
const Events = original("lib/event", {actorUtils, documentUtils, tokenUtils, genericUtils: {}, effectUtils: {}, utils: {},
  Triggers, Logging, constants, DamageBonus: class {}, D20Bonus: class {}});
globalThis.game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, time: {worldTime: 50}, settings: {get: () => false}};
globalThis.foundry = {utils: {deepClone: structuredClone}};
globalThis.fromUuid = async uuid => docs.get(uuid);
globalThis.cat = {lib: {Events}, utils: {actorUtils, tokenUtils, documentUtils, workflowUtils: {},
  queryUtils: {isTheGM: () => game.user.id === "gm"}, effectUtils: {getConcentrationEffect: () => null}}};
const actor = document({name: "Target", items: [], effects: [], system: {attributes: {hp: {value: 20, max: 20, temp: 0}}}});
const caster = document({name: "Caster", items: [], effects: [], system: {attributes: {spell: {mod: 4}}}});
const scene = {id: "scene", tokens: [], regions: [], levels: new Map(), grid: {size: 100, distance: 5, units: "ft"}};
const target = document({documentName: "Token", name: "Target", actor, parent: scene, regions: [], x: 100, y: 0, width: 1, height: 1});
const source = document({documentName: "Token", name: "Caster", actor: caster, parent: scene, regions: [], x: 0, y: 0, width: 1, height: 1});
actor.token = target; caster.token = source; scene.tokens.push(target, source);
const combat = game.combat = {id: "combat", started: true, isActive: true, scene,
  combatants: new Map([["target", {token: target}], ["caster", {token: source}]])};
function turn(round, previousTurn = 0, nextRound = round, nextTurn = 1) {
  combat.previous = {round, turn: previousTurn, combatantId: "target"};
  combat.current = {round: nextRound, turn: nextTurn, combatantId: "caster"};
  combat.round = nextRound; combat.turn = nextTurn;
}
const ref = identifier => ({source: MODULE, rules: "2014", identifier});
function effect(owner, identifier, state = {}) {
  const entry = document({name: identifier, documentName: "ActiveEffect", parent: owner, active: true, flags: {
    cat: {identifier, macros: {combat: [ref(identifier)]}}, [MODULE]: {expandedSpell: state}
  }});
  owner.effects.push(entry); return entry;
}

// Reproduce CAT's short circuit with actual installed Event/Trigger code.
let calls = [];
api.registerFnMacro({source: MODULE, rules: "2014", identifier: "first", combat: [{pass: "actorTurnEnd", priority: 10,
  macro: async () => { calls.push("first"); return true; }}]});
api.registerFnMacro({source: MODULE, rules: "2014", identifier: "second", combat: [{pass: "actorTurnEnd", priority: 20,
  macro: async () => { calls.push("second"); }}]});
effect(actor, "first"); effect(actor, "second"); turn(1);
const end = () => new Events.CombatEvent(combat, "turnEnd", target, {round: combat.previous.round, turn: combat.previous.turn}).run();
await end(); assert.deepEqual(calls, ["first"], "The previous return contract stops the following effect");
const guardedApi = khuzoeRegistrationApi(api);
for (const definition of [...registrations.values()]) guardedApi.registerFnMacro(definition);
calls = []; turn(2);
await Promise.all([end(), triggerCombatFallback(combat)]);
assert.deepEqual(calls, ["first", "second"], "CAT and fallback share execution; truthy success no longer stops later effects");
await triggerCombatFallback(combat); assert.equal(calls.length, 2);
turn(3);
const hookMap = new Map();
registerCombatFallbackHooks({on: (name, callback) => hookMap.set(name, callback)});
hookMap.get("updateCombat")(combat, {turn: 1}, {turnEvents: false});
await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
hookMap.get("updateCombat")(combat, {turn: 1}, {});
await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 4, "Native hook runs without CAT dispatch");
hookMap.get("combatTurnChange")(combat, combat.previous, combat.current);
await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 4);
turn(3, 1, 3, 0); await triggerCombatFallback(combat); assert.equal(calls.length, 4, "Rewinding is excluded");
turn(4); game.user = {id: "player", isGM: false}; await triggerCombatFallback(combat); assert.equal(calls.length, 4);
game.user = {id: "gm", isGM: true};
actor.effects.length = 0;

// Repeated hazard damage: movement/end are distinct; cancellation must remain retryable.
registerExpandedSpells2014(api);
const flameEnd = registrations.get("khuzoe-expanded-spell-effect").combat.find(entry => entry.pass === "sceneTurnEnd").macro;
const spell = document({documentName: "Item", name: "Investiture of Flame", actor: caster,
  system: {identifier: "investiture-of-flame", activities: new Map()}});
const flame = effect(caster, "khuzoe-expanded-spell-effect", {identifier: "investiture-of-flame", kind: "self-buff"});
flame.origin = spell.uuid;
let damages = 0, abort = false;
cat.utils.workflowUtils.syntheticActivityDataRoll = async () => { if (abort) return {aborted: true}; damages++; return {}; };
turn(10);
await expandedFlameMotion(target); await expandedFlameMotion(target); assert.equal(damages, 1);
await flameEnd({document: flame, token: target, combat, round: 10, turn: 1});
await flameEnd({document: flame, token: target, combat, round: 10, turn: 1});
assert.equal(damages, 2, "Moving near the flames does not prevent end-of-turn damage");
turn(11); abort = true;
assert.equal(await flameEnd({document: flame, token: target, combat, round: 11, turn: 0}), false);
abort = false;
await flameEnd({document: flame, token: target, combat, round: 11, turn: 0}); assert.equal(damages, 3);
turn(12); distance = 10;
await flameEnd({document: flame, token: target, combat, round: 12, turn: 0}); assert.equal(damages, 3);
distance = 5; flame.disabled = true;
await flameEnd({document: flame, token: target, combat, round: 12, turn: 0}); assert.equal(damages, 3);
flame.disabled = false;

// Grease: every new entry, once per end turn; do not commit a failed save workflow.
registerPersistentSpellAreas(api);
const greaseMacros = registrations.get("khuzoe-persistent-area");
const grease = document({documentName: "Region", name: "Grease", flags: {[MODULE]: {spellArea: {
  rule: "grease", itemUuid: spell.uuid, saveDC: 17
}}}});
let saves = 0;
cat.utils.workflowUtils.syntheticActivityDataRoll = async () => {
  if (abort) return {aborted: true}; saves++; return {failedSaves: new Set([target])};
};
const enter = () => greaseMacros.region[0].macro({document: grease, tokens: [target]});
const greaseEnd = () => greaseMacros.combat[0].macro({document: grease, token: target, combat, round: 20, turn: 0});
turn(20); await enter(); await enter(); assert.equal(saves, 2, "Exiting and re-entering in the same turn requires another save");
abort = true; await greaseEnd(); assert.equal(saves, 2);
abort = false; await greaseEnd(); await greaseEnd(); assert.equal(saves, 3); assert.equal(actor.prone, true);

// Native Regions must be reused, with exactly one owner for repeated saves.
const castActivity = {id: "cast", flags: {cat: {placed: {region: {activities: [{id: "legacy"}]}}}}};
const nativeRegion = document({documentName: "Region", name: "Native Grease", parent: scene, behaviors: [],
  shapes: [{type: "rectangle", x: 10, y: 20, width: 200, height: 200, rotation: 30}],
  flags: {cat: {activities: [{uuid: `${spell.uuid}.Activity.legacy`}, {uuid: "Item.other.Activity.custom"}]}}});
let regionCreates = 0, behaviorCreates = 0;
cat.utils.documentUtils.createEmbeddedDocuments = async (parent, type, entries) => {
  if (type === "RegionBehavior") { behaviorCreates++; parent.behaviors.push(...entries); return entries; }
  regionCreates++; return entries.map(data => document({...data, documentName: "Region", parent}));
};
const initialShapes = structuredClone(nativeRegion.shapes);
const reused = await createSpellArea({token: source, template: nativeRegion, activity: castActivity, castData: {saveDC: 19}},
  spell, {rule: "grease", controller: {}, radius: 5});
assert.equal(reused, nativeRegion); assert.equal(regionCreates, 0); assert.equal(behaviorCreates, 1);
assert.deepEqual(nativeRegion.shapes, initialShapes);
assert.deepEqual(nativeRegion.flags.cat.activities, [{uuid: "Item.other.Activity.custom"}]);
assert.equal(nativeRegion.flags[MODULE].spellArea.saveDC, 19);
for (const direction of [0, 30, 45, 90, 180]) {
  const area = await createSpellArea({token: source, template: {x: 0, y: 0, direction, distance: 10 * Math.SQRT2}},
    spell, {rule: "grease", controller: {}, radius: 5});
  assert.ok(Math.abs(area.shapes[0].width - 200) < 1e-6);
  assert.ok(Math.abs(area.shapes[0].height - 200) < 1e-6, "Rotating a square must preserve its dimensions");
}

// Heroism starts its temporary HP on the target's turn, not at casting time.
cat.utils.effectUtils.createEffects = async (owner, data) => data.map(entry => {
  const created = document({...entry, documentName: "ActiveEffect", parent: owner, active: true});
  owner.effects.push(created); return created;
});
const heroism = document({documentName: "Item", name: "Heroism", actor: caster, system: {
  identifier: "heroism", duration: {value: 1, units: "minute"}, activities: new Map()
}});
await finishExpandedSpell({item: heroism, workflow: {actor: caster, activity: {abilityMod: 4}, targets: new Set([target])}});
assert.equal(actor.system.attributes.hp.temp, 0);
const heroismEffect = actor.effects.find(entry => entry.flags?.[MODULE]?.expandedSpell?.identifier === "heroism");
await registrations.get("khuzoe-expanded-spell-effect").combat.find(entry => entry.pass === "actorTurnStart").macro({document: heroismEffect, actor});
assert.equal(actor.system.attributes.hp.temp, 4);
console.log("Logical event regressions: installed CAT, continuation, deduplication, fallback, GM guards, Flame/Grease phases, native Regions and Heroism timing OK");

// Cancelling movement damage retains the effect; concurrent notifications cannot spend it twice.
globalThis.ui = {notifications: {warn() {}, error() {}}};
cat.utils.queryUtils.firstOwner = () => 'gm';
cat.utils.dialogUtils = {confirm: async () => true};
cat.utils.documentUtils.deleteDocument = async entry => { entry.deleted = true; };
const movementActivity = {id: SPELL_2014_ACTIVITY_IDS.boomingMoved,
  toObject: () => ({damage: {parts: [{}]}})};
const guardianActivity = {id: SPELL_2014_ACTIVITY_IDS.guardianDamage,
  toObject: () => ({save: {dc: {}}, damage: {parts: []}})};
spell.system.activities.set(movementActivity.id, movementActivity);
spell.system.activities.set(guardianActivity.id, guardianActivity);
const booming = document({documentName: 'ActiveEffect', name: 'Booming Blade', parent: actor, origin: spell.uuid});
let rolled = 0;
abort = true;
cat.utils.workflowUtils.syntheticActivityDataRoll = async () => { rolled++; return {aborted: abort}; };
await triggerBoomingBladeMovement({document: booming, token: target});
assert.equal(booming.deleted, undefined);
abort = false;
await Promise.all([1, 2, 3].map(() => triggerBoomingBladeMovement({document: booming, token: target})));
assert.equal(rolled, 2); assert.equal(booming.deleted, true);

// Guardian: cancellation does not count damage, immunity counts zero, overkill counts actual damage.
let dismissed = 0;
cat.lib.constants = {summons: {getSummonData: () => ({}), deleteSummon: async () => { dismissed++; }}};
const guardian = document({flags: {[MODULE]: {guardianFaith: {spellUuid: spell.uuid, saveDC: 17, damage: 0}}}});
let guardianDamage = 20, guardianAbort = true;
cat.utils.workflowUtils.syntheticActivityDataRoll = async () => ({aborted: guardianAbort, damageList: [{
  tokenUuid: target.uuid, hpDamage: 1, tempDamage: 0, damageDetail: [{type: 'radiant', value: guardianDamage}]
}]});
turn(31); await triggerGuardianOfFaith({document: guardian, token: target});
assert.equal(guardian.flags[MODULE].guardianFaith.damage, 0);
guardianAbort = false;
await Promise.all([1, 2].map(() => triggerGuardianOfFaith({document: guardian, token: target})));
assert.equal(guardian.flags[MODULE].guardianFaith.damage, 20);
turn(32); guardianDamage = 0;
await triggerGuardianOfFaith({document: guardian, token: target}); assert.equal(guardian.flags[MODULE].guardianFaith.damage, 20);
for (const round of [33, 34]) { turn(round); guardianDamage = 20; await triggerGuardianOfFaith({document: guardian, token: target}); }
assert.equal(dismissed, 1); assert.equal(guardian.flags[MODULE].guardianFaith.damage, 60);
turn(35); await triggerGuardianOfFaith({document: guardian, token: target}); assert.equal(dismissed, 1);

// Competing grants are compared after the previous write completes.
actor.system.attributes.hp.temp = 0;
const originalUpdate = actor.update;
actor.update = async function(changes) { await new Promise(resolve => setImmediate(resolve)); return originalUpdate.call(this, changes); };
await Promise.all([grantTemporaryHP(actor, 20, source), grantTemporaryHP(actor, 10, target)]);
assert.equal(actor.system.attributes.hp.temp, 20); assert.equal(actor.flags[MODULE].temporaryHPSource, source.uuid);
await Promise.all([grantTemporaryHP(actor, 25, target), removeOwnedTemporaryHP(actor, source)]);
assert.equal(actor.system.attributes.hp.temp, 25); assert.equal(actor.flags[MODULE].temporaryHPSource, target.uuid);
await removeOwnedTemporaryHP(actor, target); assert.equal(actor.system.attributes.hp.temp, 0);

// CAT movement/nearby use scene units; all callers express rules in feet.
let observed;
cat.utils.tokenUtils.findNearby = (_token, range) => { observed = range; return []; };
cat.utils.tokenUtils.slideToken = (_token, options) => { observed = options.distance; };
cat.utils.tokenUtils.teleportToken = (_token, options) => { observed = options.range; };
for (const [units, factor] of [['ft', 1], ['m', 0.3048]]) {
  scene.grid.units = units;
  nearbyTokens(source, 5); assert.ok(Math.abs(observed - 5 * factor) < 1e-9);
  slideTokenFeet(target, {distance: 9, sourceToken: source}); assert.ok(Math.abs(observed - 9 * factor) < 1e-9);
  teleportTokenFeet(source, {range: 30}); assert.ok(Math.abs(observed - 30 * factor) < 1e-9);
}
console.log('Logical edge cases: cancelled/repeated Booming Blade, Guardian damage budget, concurrent temporary HP, metric movement OK');
