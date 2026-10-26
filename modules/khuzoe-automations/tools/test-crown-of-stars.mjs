import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";

const hooks = new Map();
globalThis.Hooks = {on: (name, fn) => hooks.set(name, fn), once: (name, fn) => hooks.set(name, fn)};
const {
  CROWN_OF_STARS_AUTOMATION, registerCrownOfStars, castCrownOfStars, prepareCrownOfStars, finishCrownMote,
  crownMotes, crownLight, crownItemUpdated, crownEffectDeleted, crownEffectUpdated, reconcileCrowns
} = await import("../scripts/crown-of-stars.mjs");
const source = JSON.parse(await readFile(new URL("../packData/khuzoe-spells-2014/Crown_of_Stars_KhzCrownStars001.json", import.meta.url), "utf8"));
const MODULE = "khuzoe-automations";
const castId = source.flags[MODULE].activityIdentifiers.crownOfStars;
const attackId = source.flags[MODULE].activityIdentifiers.crownOfStarsMote;
const attack = source.system.activities[attackId];
const cast = source.system.activities[castId];
const spentPath = `system.activities.${attackId}.uses.spent`;
assert.equal(source.system.uses.max, "", "Stars have their own activity resource");
assert.equal(CROWN_OF_STARS_AUTOMATION.uuid.split(".").at(-1), source._id);
assert.equal(source.flags.cat.automation.version, CROWN_OF_STARS_AUTOMATION.version);
assert.equal(source.system.level, 7);
assert.equal(source.system.preparation, undefined, "Use the dnd5e 5.3 spell method, not deprecated preparation");
assert.equal(source.system.method, "spell");
assert.ok(!source.system.properties.includes("concentration"));
assert.equal(cast.activation.type, "action");
assert.equal(cast.consumption.spellSlot, true);
assert.deepEqual(cast.consumption.targets, []);
assert.equal(attack.activation.type, "bonus");
assert.equal(attack.consumption.spellSlot, false);
assert.equal(attack.consumption.targets[0].type, "activityUses");
assert.equal(attack.consumption.targets[0].value, "1");
assert.equal(attack.target.affects.type, "creatureOrObject");
assert.equal(attack.target.affects.count, "1");
assert.equal(attack.range.value, "120");
assert.deepEqual(attack.attack.type, {value: "ranged", classification: "spell"});
assert.equal(attack.damage.parts[0].number, 4);
assert.equal(attack.damage.parts[0].denomination, 12);
assert.deepEqual(attack.damage.parts[0].types, ["radiant"]);
assert.equal(attack.damage.parts[0].scaling.mode, "");
assert.equal(attack.flags.cat.hidden, true);
assert.equal(attack.midiProperties.automationOnly, false);
assert.deepEqual(source.flags.dnd5e.riders.activity, []);
assert.deepEqual(source.system.uses.recovery, []);
const normalized = normalizeAutomationData(structuredClone(source));
assert.equal(normalized.flags.cat.automation.version, CROWN_OF_STARS_AUTOMATION.version);
assert.deepEqual(normalized.system.activities[attackId].consumption.targets, attack.consumption.targets);
assert.equal(normalized.system.activities[attackId].midiProperties.automationOnly, false);
assert.deepEqual(normalized.flags.dnd5e.riders.activity, []);

const db = new Map();
const warnings = [];
const writes = [];
const hidden = new Map();
let serial = 0;
const gm = {id: "gm", isGM: true};
globalThis.game = {user: gm, users: {activeGM: gm}, actors: new Map(), time: {worldTime: 100}, i18n: {format: key => key}};
globalThis.ui = {notifications: {warn: message => warnings.push(message), error: message => { throw new Error(message); }}};
globalThis.fromUuid = async uuid => db.get(uuid) ?? null;
function get(object, path) { return object?.[path] ?? path.split(".").reduce((v, k) => v?.[k], object); }
function set(object, path, value) {
  const keys = path.split("."); const last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = structuredClone(value);
}
globalThis.foundry = {utils: {hasProperty: (o, p) => get(o, p) !== undefined,
  mergeObject: (o, patch) => { for (const [k, v] of Object.entries(patch)) set(o, k, v); return o; }}};
globalThis.cat = {utils: {itemUtils: {
  async unhideActivities(item, keys) { assert.deepEqual(keys, ["crownOfStarsMote"]); hidden.set(item.uuid, false); },
  async rehideActivities(item, keys) { assert.deepEqual(keys, ["crownOfStarsMote"]); hidden.set(item.uuid, true); }
}}};
function makeActor(uuid = "Actor.caster") {
  const actor = {uuid, effects: new Map(), items: new Map(), async createEmbeddedDocuments(type, datas, options) {
    assert.equal(type, "ActiveEffect");
    assert.equal(options.khuzoeCrownOfStars, true);
    return datas.map(data => {
      const effect = {...structuredClone(data), id: String(++serial), parent: actor};
      effect.uuid = `${actor.uuid}.ActiveEffect.${effect.id}`;
      effect.update = async (patch, options) => {
        writes.push({uuid: effect.uuid, patch});
        for (const [k, v] of Object.entries(patch)) set(effect, k, v);
        await crownEffectUpdated(effect, patch, options, game.user.id);
        return effect;
      };
      effect.delete = async options => {
        actor.effects.delete(effect.id); db.delete(effect.uuid);
        await crownEffectDeleted(effect, options, game.user.id);
      };
      actor.effects.set(effect.id, effect); db.set(effect.uuid, effect);
      return effect;
    });
  }};
  game.actors.set(uuid, actor); db.set(uuid, actor); return actor;
}
function makeItem(actor, id = source._id) {
  const item = {...structuredClone(source), id, uuid: `${actor.uuid}.Item.${id}`, actor};
  Object.defineProperty(item.system.activities[attackId].uses, "value", {configurable: true, get() { return crownMotes(item); }});
  item.update = async (patch, options) => {
    writes.push({uuid: item.uuid, patch});
    for (const [k, v] of Object.entries(patch)) set(item, k, v);
    await crownItemUpdated(item, patch, options, game.user.id);
    return item;
  };
  for (const activity of Object.values(item.system.activities)) {
    activity.item = item; activity.id = activity._id; activity.uuid = `${item.uuid}.Activity.${activity.id}`;
  }
  actor.items.set(id, item); db.set(item.uuid, item); return item;
}
const scene = {grid: {units: "ft"}, tokens: new Map()};
globalThis.canvas = {scene};
const actor = makeActor();
const item = makeItem(actor);
const effect = () => [...actor.effects.values()][0];
const workflow = (activityId = castId, extra = {}, sourceItem = item) => ({item: sourceItem, actor: sourceItem.actor,
  activity: sourceItem.system.activities[activityId], token: {document: {parent: scene}}, targets: new Set([{}]), ...extra});
const use = (activityId, extra, sourceItem) => ({workflow: workflow(activityId, extra, sourceItem)});
const crown = (level = 7, sourceItem = item) => castCrownOfStars(use(castId, {castData: {castLevel: level}}, sourceItem));

// Exercise the real dnd5e 5.3.3 item-use consumer, not a duplicate implementation.
const systemMap = JSON.parse(await readFile(new URL("../../../systems/dnd5e/dnd5e-compiled.mjs.map", import.meta.url), "utf8"));
const native = systemMap.sourcesContent[systemMap.sources.findIndex(path => path.endsWith("consumption-targets-field.mjs"))];
function nativeMethod(signature, name) {
  const start = native.indexOf(signature);
  assert.ok(start >= 0);
  const end = native.indexOf("\n  /* --------", start);
  const method = native.slice(start, end).replace(/^static /, "");
  return new Function("ConsumptionError", "formatNumber", `return ({${method}}).${name};`)(Error, String);
}
const consumeActivityUses = nativeMethod("static async consumeActivityUses", "consumeActivityUses");
const usesConsumption = nativeMethod("async _usesConsumption", "_usesConsumption");
async function nativeConsume(sourceItem = item) {
  const target = {...sourceItem.system.activities[attackId].consumption.targets[0], item: sourceItem,
    actor: sourceItem.actor, activity: sourceItem.system.activities[attackId], _usesConsumption: usesConsumption,
    async resolveCost() { return {total: Number(this.value)}; }};
  const updates = {activity: {}, rolls: []};
  await consumeActivityUses.call(target, {}, updates);
  await sourceItem.update({[spentPath]: updates.activity.uses.spent}, {});
}

assert.equal(await prepareCrownOfStars(use(attackId)), true, "Cannot fire before casting");
await castCrownOfStars(use(castId, {aborted: true}));
assert.equal(actor.effects.size, 0);
item.system.uses = {max: "1", spent: 1, recovery: [{period: "lr", type: "recoverAll"}]};
const originalUses = structuredClone(item.system.uses);
await crown();
assert.deepEqual(item.system.uses, originalUses, "Casting must not replace the parent item resource");
assert.equal(crownMotes(item), 7);
assert.equal(effect().duration.value, 3600);
assert.equal(effect().start.time, 100);
assert.equal(effect().duration.expired, false);
assert.equal(hidden.get(item.uuid), false);
assert.deepEqual(effect().system.changes, crownLight(7));
assert.equal(await prepareCrownOfStars(use(attackId)), undefined);
assert.equal(await prepareCrownOfStars(use(attackId, {targets: new Set()})), true);
assert.equal(await prepareCrownOfStars(use(attackId, {targets: new Set([{}, {}])})), true);
// Canceling the native use dialog never enters consumption or creates an attack.
await finishCrownMote(use(attackId, {aborted: true}));
assert.equal(crownMotes(item), 7);
const sameCast = use(castId, {castData: {castLevel: 8}});
await castCrownOfStars(sameCast);
assert.equal(crownMotes(item), 9);
await nativeConsume();
await castCrownOfStars(sameCast);
assert.equal(crownMotes(item), 8, "A repeated finish hook must not replenish the crown");
await crown(9); assert.equal(crownMotes(item), 11);
await crown(7); assert.equal(crownMotes(item), 7);
assert.equal(actor.effects.size, 1);
const priorId = effect().id;
game.time.worldTime = 200;
await crown(8);
assert.equal(effect().id, priorId);
assert.equal(effect().start.time, 200);
assert.equal(effect().flags[MODULE].crownOfStars.expiresAt, 3800);
await crown(7);
for (let i = 0; i < 3; i++) {
  await nativeConsume();
  const miss = use(attackId, {attackRoll: {total: 1}, hitTargets: new Set()});
  await finishCrownMote(miss); await finishCrownMote(miss);
}
assert.equal(crownMotes(item), 4, "Misses spend one star; macro reruns do not spend another");
assert.equal(effect().system.changes[0].value, 30);
assert.equal(effect().system.changes[1].value, 60);
await nativeConsume();
await finishCrownMote(use(attackId, {attackRoll: {total: 20}, hitTargets: new Set([{}])}));
assert.equal(crownMotes(item), 3);
assert.equal(effect().system.changes[0].value, 0);
assert.equal(effect().system.changes[1].value, 30);
assert.match(effect().name, /3 stelle/);
await nativeConsume(); await nativeConsume();
assert.equal(crownMotes(item), 1);
await nativeConsume();
assert.equal(crownMotes(item), 0);
assert.equal(actor.effects.size, 1, "Keep the source until a roll: rejected use can still be refunded");
// Midi's post-chat checks can refund native consumption before an attack exists.
await item.update({[spentPath]: 6}, {});
assert.equal(crownMotes(item), 1);
assert.equal(hidden.get(item.uuid), false);
assert.equal(effect().system.changes[1].value, 30);
await nativeConsume();
const last = use(attackId, {attackRoll: {total: 1}, hitTargets: new Set()});
await finishCrownMote(last);
assert.equal(actor.effects.size, 0, "Last star ends the spell even on a miss");
assert.equal(hidden.get(item.uuid), true);
assert.equal(await prepareCrownOfStars(use(attackId)), true);
await assert.rejects(nativeConsume(), /None/);

await crown();
await effect().update({disabled: true}, {});
assert.equal(await prepareCrownOfStars(use(attackId)), true);
assert.equal(hidden.get(item.uuid), true);
await effect().update({disabled: false}, {});
assert.equal(hidden.get(item.uuid), false);
await effect().delete({});
assert.equal(crownMotes(item), 0);
assert.equal(hidden.get(item.uuid), true);
await crown();
game.time.worldTime += 3600;
assert.equal(await prepareCrownOfStars(use(attackId)), true, "Time expiry blocks the attack even before the GM sweep");
await reconcileCrowns(scene);
assert.equal(actor.effects.size, 0);
assert.equal(crownMotes(item), 0);
await crown();
await effect().update({"duration.expired": true}, {});
assert.equal(actor.effects.size, 0);

// Duplicate spell items replace the old crown and exhaust its counter.
await crown();
const other = makeItem(actor, "anotherCrownItem");
await crown(9, other);
assert.equal(actor.effects.size, 1);
assert.equal(crownMotes(other), 11);
assert.equal(crownMotes(item), 0);
assert.equal(hidden.get(item.uuid), true);
await crown(7);
assert.equal(crownMotes(other), 0);

// Workflow items may be scaled snapshots; always use the persisted source.
const stale = {...item, system: {...item.system, activities: {...item.system.activities, [attackId]: {...item.system.activities[attackId], uses: {max: 7, spent: 0}}}}};
await item.update({[spentPath]: 7}, {});
await finishCrownMote({workflow: {...workflow(attackId), item: stale, attackRoll: {total: 1}}});
assert.equal(actor.effects.size, 0);

// Metric light, no token-light mutations, idle reconciliations perform no writes.
scene.grid.units = "m";
await crown();
assert.equal(effect().system.changes[0].value, 30 * 0.3048);
assert.equal(effect().system.changes[1].value, 60 * 0.3048);
assert.ok(effect().system.changes.every(change => change.type === "upgrade"));
const before = writes.length;
await reconcileCrowns(scene); await reconcileCrowns(scene);
assert.equal(writes.length, before, "Unchanged crowns must not cause repeated document updates");
const synthetic = makeActor("Scene.test.Token.unlinked.Actor.npc");
game.actors.delete(synthetic.uuid);
const npcItem = makeItem(synthetic);
scene.tokens.set("unlinked", {actor: synthetic});
await crown(8, npcItem);
game.time.worldTime += 3600;
await reconcileCrowns(scene);
assert.equal(synthetic.effects.size, 0);
assert.equal(crownMotes(npcItem), 0);

const registered = [];
registerCrownOfStars({registerFnMacro: data => registered.push(data), registerAutomation: data => data});
assert.ok(registered[0].roll.some(entry => entry.pass === "itemAttackRollComplete"));
for (const name of ["updateItem", "deleteItem", "updateActiveEffect", "deleteActiveEffect", "updateWorldTime", "canvasReady", "ready"]) {
  assert.equal(typeof hooks.get(name), "function", `${name} lifecycle hook is installed`);
}
console.log("Crown of Stars: native consumption, hit/miss, 7/9/11 motes, final star/refund, recast, expiry, metric light and idle writes OK.");
