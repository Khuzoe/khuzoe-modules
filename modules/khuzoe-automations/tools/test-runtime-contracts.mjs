import assert from "node:assert/strict";
import {reserveResources, refundResources} from "../scripts/resource-transactions.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";
import {weaponCantripAttack} from "../scripts/weapon-cantrips.mjs";
import {healActor} from "../scripts/healing.mjs";
import {removeRollModifierSources} from "../scripts/spell-state-rules.mjs";
import {registerSpellTerrainType} from "../scripts/persistent-spell-areas.mjs";
import {adjustAppliedDamage} from "../scripts/damage-adjustment.mjs";
import {triggerDeathWard} from "../scripts/spells-2014.mjs";

globalThis.game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}};
const reactions = new Set();
globalThis.MidiQOL = {setReactionUsed: async actor => reactions.add(actor.uuid), removeReactionUsed: async actor => reactions.delete(actor.uuid)};
globalThis.cat = {utils: {
  queryUtils: {gmUser: () => game.user},
  actorUtils: {hasUsedReaction: actor => reactions.has(actor.uuid), getFirstToken: actor => actor.token},
  documentUtils: {update: async () => {}},
  itemUtils: {syntheticItem: (data, actor) => ({...data, actor})},
  workflowUtils: {}, tokenUtils: {isEnemy: (source, target) => source.disposition !== target.disposition}
}};
const actor = {id: "caster", uuid: "Actor.caster", system: {spells: {spell2: {value: 1, max: 2}}, attributes: {hp: {value: 12, max: 20}}}};
const feature = {id: "feature", actor, system: {uses: {max: 1, spent: 0}}};
registerDocuments(actor, feature);
const reservations = await Promise.all([
  reserveResources(actor, {item: feature, slot: 2, reaction: true}),
  reserveResources(actor, {item: feature, slot: 2, reaction: true})
]);
assert.equal(reservations.filter(Boolean).length, 1, "Overlapping reactions cannot spend the same last slot/use");
assert.equal(actor.system.spells.spell2.value, 0);
assert.equal(feature.system.uses.spent, 1);
await refundResources(reservations.find(Boolean));
await refundResources(reservations.find(Boolean));
assert.equal(actor.system.spells.spell2.value, 1, "Duplicate refunds restore exactly one slot");
assert.equal(feature.system.uses.spent, 0);
assert.equal(reactions.size, 0);
const old = await reserveResources(actor, {reaction: true});
reactions.clear(); // next turn
const current = await reserveResources(actor, {reaction: true});
await refundResources(old);
assert.equal(reactions.size, 1, "An old receipt cannot clear a newer reaction");
await refundResources(current);

let weaponData;
const weaponSource = {name: "Sword", type: "weapon", system: {equipped: true, activities: {
  melee: {_id: "melee", type: "attack", attack: {type: {value: "melee"}}, damage: {parts: []}}
}}};
actor.items = [{...structuredClone(weaponSource), toObject: () => structuredClone(weaponSource)}];
const target = {uuid: "Scene.s.Token.target", actor};
cat.utils.workflowUtils.syntheticItemDataRoll = async data => { weaponData = data; return {hitTargets: new Set([target])}; };
await weaponCantripAttack({actor, targets: new Set([target])}, {actor, system: {identifier: "booming-blade"}}, {dice: 2, damageType: "thunder"});
assert.equal(weaponData.system.activities.melee.damage.parts[0].number, 2);
assert.equal(weaponSource.system.activities.melee.damage.parts.length, 0, "Casting the cantrip does not mutate the real weapon");

let healingItem;
actor.token = target;
cat.utils.workflowUtils.syntheticActivityDataRoll = async (_data, item) => { healingItem = item; return {}; };
const healed = await healActor(actor, "2d8", {sourceItem: {actor, flags: {cat: {macros: {roll: ["attack"]}}}}});
assert.equal(healed, 0, "A target whose healing is blocked stays at its original HP");
assert.equal(healingItem.flags.cat, undefined, "A healing workflow must not replay the NPC attack's macros");
cat.utils.workflowUtils.syntheticActivityDataRoll = async () => ({aborted: true});
await assert.rejects(() => healActor(actor, "2d8"), /annullata/);

let tracked = {advantage: {active: false}, disadvantage: {active: true, suppressed: false, override: false},
  attribution: {DIS: {"invisible foe": "Invisible", prone: "Prone"}}, legacyAttribution: ["DIS:invisible foe", "DIS:prone"], advReminderAttribution: []};
const tracker = {toJSON: () => tracked, restore: data => { tracked = data; }};
removeRollModifierSources(tracker, "DIS", ["invisible foe"]);
assert.equal(tracked.disadvantage.active, true);
assert.deepEqual(tracked.attribution.DIS, {prone: "Prone"}, "Faerie Fire preserves disadvantage from another cause");

// Foundry resolves every registered model's schema during localization, before
// any Region exists. An empty base class previously hid this startup failure.
class RegionBehaviorType {
  static defineSchema() { throw new Error(`The ${this.name} subclass of DataModel must define its Document schema`); }
  static get schema() { return this.defineSchema(); }
  get behavior() { return this.parent; }
}
globalThis.foundry = {data: {regionBehaviors: {RegionBehaviorType}}};
globalThis.CONFIG = {RegionBehavior: {dataModels: {}}};
registerSpellTerrainType();
const Terrain = CONFIG.RegionBehavior.dataModels["khuzoe-automations.terrain"];
assert.throws(() => RegionBehaviorType.schema, /must define its Document schema/);
assert.deepEqual(Terrain.schema, {}, "Foundry must be able to initialize the terrain schema before any Region is created");
const terrain = new Terrain();
const source = {uuid: "Scene.s.Token.source", disposition: 1};
terrain.parent = {parent: {flags: {"khuzoe-automations": {spellArea: {mobile: true, enemiesOnly: true, sourceTokenId: "source"}}},
  parent: {tokens: new Map([["source", source]])}}};
assert.equal(terrain._getTerrainEffects({disposition: -1}, {action: "walk"})[0].difficulty, 2);
assert.deepEqual(terrain._getTerrainEffects(source, {action: "walk"}), []);
assert.deepEqual(terrain._getTerrainEffects({disposition: 1}, {action: "walk"}), []);
assert.deepEqual(terrain._getTerrainEffects({disposition: -1}, {action: "fly"}), []);

// Midi consumes detail at application time; Death Ward consumes predicted HP earlier.
cat.utils.workflowUtils.modifyDamageAppliedFlat = (ditem, value) => ditem.damageDetail.push({type: "none", value});
const damage = {oldHP: 12, oldTempHP: 4, hpDamage: 11, tempDamage: 4, newHP: 1, newTempHP: 0, damageDetail: [{type: "slashing", value: 15}]};
adjustAppliedDamage(damage, -7);
assert.equal(damage.hpDamage, 4);
assert.equal(damage.newHP, 8);
assert.equal(damage.newTempHP, 0);
assert.equal(damage.damageDetail.reduce((sum, part) => sum + part.value, 0), 8);
const overkill = {oldHP: 5, oldTempHP: 0, hpDamage: 5, tempDamage: 0, newHP: 0,
  damageDetail: [{type: "fire", value: 30}], rawDamageDetail: []};
MidiQOL.modifyDamageBy = ({damageItem, value, type}) => damageItem.damageDetail.push({type, value});
let wardConsumed = false;
cat.utils.documentUtils.deleteDocument = async () => { wardConsumed = true; };
await triggerDeathWard({document: {uuid: "Actor.caster.ActiveEffect.ward"}, ditem: overkill});
assert.equal(overkill.newHP, 1, "Death Ward also protects a 5 HP creature from a 30 damage hit");
assert.equal(overkill.damageDetail.reduce((sum, part) => sum + part.value, 0), 4);
assert.equal(wardConsumed, true);
console.log("Khuzoe: resource races/refunds, weapon cantrips, healing cancellation, sight attribution, terrain and damage prediction contracts OK.");
