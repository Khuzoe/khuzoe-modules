import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {useBoomingBlade, triggerBoomingBladeMovement, SPELL_2014_ACTIVITY_IDS as IDS} from "../scripts/spells-2014.mjs";
import {runSyntheticActivityData, markSnapshotActivityAborted} from "../scripts/activity-compat.mjs";

const MODULE = "khuzoe-automations";
const source = JSON.parse(await readFile(new URL("../packData/khuzoe-spells-2014/Booming_Blade_KhzBoomBlade1401.json", import.meta.url), "utf8"));
const catMap = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
const systemMap = JSON.parse(await readFile(new URL("../../../systems/dnd5e/dnd5e-compiled.mjs.map", import.meta.url), "utf8"));
const midiSource = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
function catSource(file) { return catMap.sourcesContent[catMap.sources.findIndex(path => path.endsWith(`/scripts/${file}.mjs`))]; }
function functionCode(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Installed function ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
function nativeCantripLevel(type) {
  const source = systemMap.sourcesContent[systemMap.sources.findIndex(path => path.endsWith(`/actor/${type}.mjs`))];
  const start = source.indexOf("cantripLevel(spell) {");
  const method = source.slice(start, source.indexOf("\n  }", start) + 4);
  return new Function(`return ({${method}}).cantripLevel;`)();
}
function nativeWorkflowMethod(name) {
  const start = midiSource.indexOf(`      ${name}(item, options = {}) {`);
  assert.ok(start >= 0, `Installed workflow method ${name}`);
  const method = midiSource.slice(start, midiSource.indexOf("\n      }", start) + 8);
  return new Function(`return ({${method}}).${name};`)();
}
const getMacroData = nativeWorkflowMethod("getMacroData");
const getSafeMacroData = nativeWorkflowMethod("getSafeMacroData");
class Collection extends Map {
  find(callback) { return [...this.values()].find(callback); }
  filter(callback) { return [...this.values()].filter(callback); }
}
Set.prototype.map ??= function(callback) { return new Set([...this].map(callback)); };
Set.prototype.filter ??= function(callback) { return new Set([...this].filter(callback)); };
const db = new Map();
const rolls = [], calls = [], prompts = [], weaponDice = [];
const handlers = new Map();
let serial = 0, willing = true, aborted = false, socketFailure = false, abortAfterRoll = false;
const gm = {id: "gm", active: true, isGM: true, targets: new Set()};
const player = {id: "caster-owner", active: true, targets: new Set()};
const victim = {id: "target-owner", active: true, targets: new Set()};
globalThis.game = {user: gm, get userId() { return this.user.id; }, users: new Collection([gm, player, victim].map(user => [user.id, user])), time: {worldTime: 0}};
globalThis.Hooks = {
  on(name, fn) { const id = ++serial; handlers.set(id, {name, fn}); return id; },
  off(_name, id) { handlers.delete(id); }
};
Hooks.on("midi-qol.preAbort", markSnapshotActivityAborted);
function emit(name, workflow) { for (const handler of [...handlers.values()]) if (handler.name === name) handler.fn(workflow); }
function put(object, path, value) {
  const keys = path.split("."), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
}
function mergeObject(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && Object.getPrototypeOf(value) === Object.prototype) mergeObject(target[key] ??= {}, value);
    else target[key] = value;
  }
  return target;
}
class Activity {
  constructor(data, item) {
    Object.assign(this, structuredClone(data)); this.item = item; this.actor = item.actor; this.id = data._id;
    this.identifier = data.midiProperties?.identifier ?? data._id;
  }
  get uuid() { return `${this.item.uuid}.Activity.${this.id}`; }
  toObject() { return structuredClone(this.item.data.system.activities[this.id]); }
  async use(usage) {
    assert.equal(usage.consume.spellSlot, false);
    assert.equal(usage.consume.resources, false);
    assert.equal(usage.consume.action, false);
    assert.equal(usage.midiOptions.workflowOptions.khuzoeInternalActivity, true);
    const roll = {formula: this.damage.parts[0].custom.formula, actorUuid: this.actor.uuid,
      targetUuids: usage.midiOptions.targetUuids, userId: game.user.id, aborted};
    rolls.push(roll);
    const workflow = {...roll, item: this.item, actor: this.actor, sequenceId: usage.sequenceId,
      getMacroData, getSafeMacroData, rollOptions: {}, workflowOptions: usage.midiOptions.workflowOptions,
      damageRoll: !aborted || abortAfterRoll ? {formula: roll.formula} : undefined,
      targets: new Set([token.object]), saves: new Set(), hitTargets: new Set(), hitTargetsEC: new Set(),
      failedSaves: new Set(), criticalSaves: new Set(), fumbleSaves: new Set(), superSavers: new Set(), semiSuperSavers: new Set()};
    if (aborted) {
      // Installed Midi calls general hooks before the activity-specific hook.
      emit("midi-qol.preAbort", workflow);
      emit(`midi-qol.preAbort.${this.uuid}`, workflow);
    } else emit(`midi-qol.postCleanup.${this.uuid}`, workflow);
    return workflow;
  }
}
class Item {
  constructor(data, {parent}) {
    this.data = structuredClone(data); this.actor = parent; this.parent = parent;
    this.name = data.name; this.type = data.type; this.flags = structuredClone(data.flags ?? {}); this.id = data._id;
    this.img = data.img; this.documentName = "Item";
    this.uuid = `${parent.uuid}.Item.${this.id}`;
    this.system = {...structuredClone(data.system), activities: new Collection()};
    for (const activity of Object.values(data.system.activities)) this.system.activities.set(activity._id, new Activity(activity, this));
  }
  toObject() { return structuredClone(this.data); }
  getRollData() { return {}; }
  prepareData() {}
  prepareFinalAttributes() {}
  applyActiveEffects() {}
}
globalThis.CONFIG = {Item: {documentClass: Item}};
globalThis.foundry = {utils: {
  deepClone(value) { return value instanceof Item || value instanceof Activity ? value : structuredClone(value); },
  mergeObject, setProperty: put, randomID: () => `id${++serial}`
}};
globalThis.fromUuid = async uuid => db.get(uuid);
globalThis.fromUuidSync = uuid => db.get(uuid);
globalThis.ui = {notifications: {warn() {}}};
const caster = {uuid: "Actor.caster", owner: player.id, effects: new Map(), items: [],
  system: {details: {level: 11}, cantripLevel: nativeCantripLevel("character")}, toObject() { return {name: "Caster"}; }};
const targetActor = {uuid: "Actor.target", owner: victim.id, name: "Target", effects: new Map(), system: {details: {level: 1}}};
const token = {id: "target", uuid: "Scene.test.Token.target", actor: targetActor, name: "Target"};
token.object = {document: token, id: token.id, actor: targetActor};
const spell = new Item(source, {parent: caster});
for (const doc of [caster, targetActor, token, spell, ...spell.system.activities.values()]) db.set(doc.uuid, doc);
const weaponData = {_id: "weapon", type: "weapon", system: {equipped: true, activities: {attack: {
  _id: "attack", type: "attack", attack: {type: {value: "melee"}}, damage: {parts: []}
}}}};
caster.items.push({type: "weapon", system: weaponData.system, toObject: () => structuredClone(weaponData)});

// Execute the installed Midi sender and receivers, including their UUID-only
// remote activity path and the completeItemUse path that carries itemData.
let nativeMidi;
const socket = {async executeAsUser(action, userId, data) {
  if (socketFailure) throw new Error("Simulated disconnected owner");
  calls.push({action, userId, data: structuredClone(data)});
  const previous = game.user; game.user = game.users.get(userId);
  try { return await nativeMidi[`_${action}`](structuredClone(data)); }
  finally { game.user = previous; }
}};
const dependencies = {
  socketlibSocket: socket, getToken: uuid => db.get(uuid)?.object ?? uuid,
  isValidTarget: token => Boolean(token?.actor), updateUserTargets() {}, preferredActiveGM: () => gm,
  debugEnabled: 0, __name: fn => fn, warn() {}, error2: message => { throw new Error(message); },
  TroubleShooter: {recordError: error => { throw error; }}, MidiActivityChoiceDialog: {},
  timedAwaitExecuteAsGM: () => { throw new Error("Unexpected implicit GM call"); }
};
const midiFunctions = ["completeActivityUse2", "completeItemUse", "_completeActivityUse", "_completeItemUse"];
nativeMidi = new Function(...Object.keys(dependencies), midiFunctions.map(name => functionCode(midiSource, name)).join("\n")
  + "\nreturn {completeActivityUse2,completeItemUse,_completeActivityUse,_completeItemUse};")(...Object.values(dependencies));
globalThis.MidiQOL = {completeActivityUse: nativeMidi.completeActivityUse2, completeItemUse: nativeMidi.completeItemUse,
  socket: () => socket, configSettings: () => ({autoRollDamage: "always"})};
const itemUtils = {syntheticItem: (data, actor) => new Item(data, {parent: actor})};
const activityUtils = {syntheticActivity: new Function("itemUtils", functionCode(catSource("utilities/activityUtils"), "syntheticActivity")
  + "\nreturn syntheticActivity;")(itemUtils)};
const queryUtils = {firstOwner: actor => actor.owner, hasPermission: (actor, id) => actor.owner === id || id === gm.id};
const catFunctions = ["syntheticActivityDataRoll", "syntheticActivityRoll", "completeActivityUse"];
const workflowUtils = new Function("activityUtils", "genericUtils", "queryUtils", "actorUtils",
  catFunctions.map(name => functionCode(catSource("utilities/workflowUtils"), name)).join("\n")
    + "\nreturn {syntheticActivityDataRoll,syntheticActivityRoll,completeActivityUse};")(
      activityUtils, {mergeObject}, queryUtils, {});
workflowUtils.syntheticItemDataRoll = async data => {
  weaponDice.push(data.system.activities.attack.damage.parts[0]?.number ?? 0);
  return {hitTargets: new Set([token]), targets: new Set([token])};
};
globalThis.cat = {utils: {workflowUtils, itemUtils, queryUtils, actorUtils: {getLevelOrCR: actor => actor.system.details.level},
  dialogUtils: {confirm: async (_name, _prompt, options) => { prompts.push(options.userId); return willing; }},
  effectUtils: {async createEffects(actor, datas) {
    return datas.map(data => {
      const effect = {...structuredClone(data), id: `effect${++serial}`, parent: actor};
      effect.uuid = `${actor.uuid}.ActiveEffect.${effect.id}`;
      actor.effects.set(effect.id, effect); db.set(effect.uuid, effect); return effect;
    });
  }},
  documentUtils: {async deleteDocument(effect) { effect.parent.effects.delete(effect.id); db.delete(effect.uuid); effect.deleted = true; }}
}};
const current = () => [...targetActor.effects.values()][0];
async function cast(level) {
  caster.system.details.level = level;
  await useBoomingBlade({item: spell, workflow: {item: spell, actor: caster,
    activity: spell.system.activities.get(IDS.boomingCast), targets: new Set([token])}});
  return current();
}

// Reproduce the reported bug with the unmodified installed CAT/Midi transport.
const modified = spell.system.activities.get(IDS.boomingMoved).toObject();
modified.damage.parts[0].custom.formula = "3d8";
await runSyntheticActivityData(modified, spell, [token], {userId: player.id});
assert.equal(rolls.at(-1).formula, "1d8", "UUID-only delegation reloads the persisted unscaled activity");
assert.equal(calls.at(-1).action, "completeActivityUse");

for (const [level, dice] of [[1,1],[4,1],[5,2],[10,2],[11,3],[16,3],[17,4],[20,4]]) {
  for (const user of [gm, player, victim]) {
    game.user = user;
    const effect = await cast(level);
    assert.equal(weaponDice.at(-1), dice - 1, "Initial weapon damage uses the same caster thresholds");
    assert.equal(effect.flags[MODULE].boomingBlade.casterLevel, level);
    assert.equal(effect.flags[MODULE].boomingBlade.dice, dice);
    // Neither a later caster-level change nor the target's level may affect the saved roll.
    caster.system.details.level = level < 11 ? 20 : 1;
    targetActor.system.details.level = level < 11 ? 20 : 1;
    await triggerBoomingBladeMovement({document: effect, token});
    assert.equal(rolls.at(-1).formula, `${dice}d8`);
    assert.equal(rolls.at(-1).actorUuid, caster.uuid);
    assert.deepEqual(rolls.at(-1).targetUuids, [token.uuid]);
    assert.equal(rolls.at(-1).userId, player.id, "Damage still rolls on the caster's owner");
    assert.equal(prompts.at(-1), victim.id, "The moving target confirms voluntary movement");
    assert.equal(effect.deleted, true);
    assert.equal(source.system.activities[IDS.boomingMoved].damage.parts[0].custom.formula, "1d8");
    assert.deepEqual(spell.toObject(), source, "Source spell and activities remain unchanged");
  }
}

game.user = gm;
let effect = await cast(11);
willing = false;
let count = rolls.length;
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(rolls.length, count); assert.equal(effect.deleted, undefined);
willing = true;
await triggerBoomingBladeMovement({document: effect, token, teleport: true});
assert.equal(rolls.length, count);
aborted = true;
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(effect.deleted, undefined, "Canceled remote damage retains the effect");
abortAfterRoll = true;
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(effect.deleted, undefined, "A cancellation after the damage roll survives native serialization too");
abortAfterRoll = false;
aborted = false;
count = rolls.length;
await Promise.all([1,2,3].map(() => triggerBoomingBladeMovement({document: effect, token})));
assert.equal(rolls.length, count + 1);

effect = await cast(11);
socketFailure = true;
count = rolls.length;
await assert.rejects(triggerBoomingBladeMovement({document: effect, token}), /disconnected owner/);
assert.equal(effect.deleted, undefined);
assert.equal(rolls.length, count, "A failed remote request must not trigger a second local roll");
socketFailure = false;
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(rolls.at(-1).formula, "3d8");

// Effects already in a world retain the old saved dice. Missing/invalid data
// falls back to the original caster, never the moved target or the base 1d8.
effect = await cast(5);
effect.flags[MODULE].boomingBlade = {dice: 2};
caster.system.details.level = 20;
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(rolls.at(-1).formula, "2d8");
for (const saved of [undefined, {dice: "bad"}, {dice: 0}, {dice: -1}, {dice: 99}]) {
  effect = await cast(17);
  effect.flags[MODULE].boomingBlade = saved;
  await triggerBoomingBladeMovement({document: effect, token});
  assert.equal(rolls.at(-1).formula, "4d8");
}

// Native NPC cantrip levels (spellcasting level or innate CR) are snapshotted too.
caster.system.cantripLevel = nativeCantripLevel("npc");
caster.system.attributes = {spell: {level: 17}};
spell.system.method = "spell";
effect = await cast(0);
assert.equal(effect.flags[MODULE].boomingBlade.casterLevel, 17);
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(rolls.at(-1).formula, "4d8");
spell.system.method = "innate"; caster.system.details.cr = 11;
effect = await cast(0);
await triggerBoomingBladeMovement({document: effect, token});
assert.equal(rolls.at(-1).formula, "3d8");

// An unlinked NPC keeps its synthetic actor UUID when another player moves.
const syntheticCaster = {...caster, uuid: "Scene.test.Token.caster.Actor.npc", owner: gm.id,
  system: {details: {level: 17}, cantripLevel: nativeCantripLevel("character")}};
const syntheticSpell = new Item(source, {parent: syntheticCaster});
for (const doc of [syntheticCaster, syntheticSpell, ...syntheticSpell.system.activities.values()]) db.set(doc.uuid, doc);
game.user = victim;
await useBoomingBlade({item: syntheticSpell, workflow: {item: syntheticSpell, actor: syntheticCaster,
  activity: syntheticSpell.system.activities.get(IDS.boomingCast), targets: new Set([token])}});
await triggerBoomingBladeMovement({document: current(), token});
assert.equal(rolls.at(-1).formula, "4d8");
assert.equal(rolls.at(-1).actorUuid, syntheticCaster.uuid);
assert.equal(rolls.at(-1).userId, gm.id);
assert.equal(calls.at(-1).data.actorUuid, syntheticCaster.uuid);
assert.ok(calls.some(call => call.action === "completeItemUse" && call.data.itemData));
assert.equal(handlers.size, 1, "Native Midi completion hooks are cleaned up; only our persistent abort marker remains");
const unrelated = {workflowOptions: {}};
markSnapshotActivityAborted(unrelated);
assert.deepEqual(unrelated.workflowOptions, {}, "Unrelated workflows are untouched");
console.log("Booming Blade scaling: reproduced installed Midi UUID-only bug; native CAT/Midi local/remote rolls preserve caster levels 1–20, saved dice, NPC levels, cancellation and single consumption.");
