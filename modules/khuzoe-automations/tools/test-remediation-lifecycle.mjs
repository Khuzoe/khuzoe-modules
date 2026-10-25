import assert from "node:assert/strict";
import {registerDocuments} from "./fixtures-documents.mjs";
import {NPC_IDS, registerHomebrewNpcs, reconcileImpenetrableEgo} from "../scripts/homebrew-npcs.mjs";
import {finishShadowBladeThrow, restrictGaseousActions} from "../scripts/spell-state-rules.mjs";
import {createSpellArea} from "../scripts/persistent-spell-areas.mjs";

globalThis.game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, actors: [], time: {worldTime: 0}};
globalThis.ui = {notifications: {warn() {}, info() {}, error() {}}};
globalThis.cat = {utils: {
  queryUtils: {gmUser: () => game.user, firstOwner: () => "gm"},
  actorUtils: {hasUsedReaction: () => false}, documentUtils: {update: async () => {}},
  effectUtils: {}, workflowUtils: {}, dialogUtils: {}
}, lib: {constants: {}}};
let serial = 0;
cat.utils.effectUtils.createEffects = async (actor, entries) => entries.map(data => {
  const effect = {...structuredClone(data), id: `effect${++serial}`, parent: actor};
  effect.uuid = `${actor.uuid}.ActiveEffect.${effect.id}`;
  effect.update = async changes => { if (changes["system.changes"]) effect.system.changes = changes["system.changes"]; };
  actor.effects.push(effect);
  return effect;
});
cat.utils.documentUtils.deleteDocument = async effect => { effect.parent.effects.splice(effect.parent.effects.indexOf(effect), 1); };
const ego = {name: "Impenetrable Ego", system: {identifier: NPC_IDS.impenetrableEgo}};
const actor = {uuid: "Actor.ego", effects: [], items: [ego], statuses: new Set(),
  system: {abilities: {cha: {mod: 4}}, attributes: {hp: {value: 60}, ac: {calc: "custom", formula: "@attributes.ac.armor + @attributes.ac.dex +4"}}}};
registerDocuments(actor);
await reconcileImpenetrableEgo(actor);
assert.equal(actor.effects.length, 0, "The CHA already in the NPC AC must not be added twice");
actor.statuses.add("unconscious");
await Promise.all([reconcileImpenetrableEgo(actor), reconcileImpenetrableEgo(actor)]);
assert.equal(actor.effects.length, 1, "Concurrent local hooks create one correction");
assert.deepEqual(actor.effects[0].system.changes[0], {key: "system.attributes.ac.bonus", value: "-4", type: "add", priority: 20});
actor.statuses = new Set(["stunned"]);
await reconcileImpenetrableEgo(actor);
assert.equal(actor.effects.length, 0, "Stunned alone does not mean unconscious");
actor.items.push({type: "equipment", system: {equipped: true, type: {value: "shield"}}});
await reconcileImpenetrableEgo(actor);
assert.equal(actor.effects[0].system.changes[0].value, "-4");
actor.items.pop(); actor.system.abilities.cha.mod = 5;
await reconcileImpenetrableEgo(actor);
assert.equal(actor.effects[0].system.changes[0].value, "1", "A changed CHA corrects only the difference");
const originalFormula = actor.system.attributes.ac.formula;
game.user.isGM = false; actor.statuses.add("unconscious");
await reconcileImpenetrableEgo(actor);
assert.equal(actor.effects[0].system.changes[0].value, "1", "Other clients must not run maintenance writes");
game.user.isGM = true;
assert.equal(actor.system.attributes.ac.formula, originalFormula, "The original NPC formula remains intact");

const registrations = [];
registerHomebrewNpcs({registerAutomation: data => data, registerFnMacro: data => { registrations.push(data); return data; }});
const callbacks = registrations.find(data => data.identifier === NPC_IDS.nanissSummon).roll;
const prepare = callbacks.find(entry => entry.pass === "itemPreItemRoll").macro;
const summon = callbacks.find(entry => entry.pass === "itemRollFinished").macro;
const caster = {uuid: "Actor.naniss", system: {attributes: {hp: {value: 30}}}, items: []};
const feature = {documentName: "Item", name: "Evoca Spirito", actor: caster,
  system: {identifier: NPC_IDS.nanissSummon, uses: {max: 1, spent: 0}}, flags: {"khuzoe-automations": {summonSourceUuid: "Actor.spiritSource"}}};
const sourceActor = {documentName: "Actor", uuid: "Actor.spiritSource"};
registerDocuments(caster, feature, sourceActor);
let refundedBonus = 0, placement = null, failOldCleanup = false;
const previous = {id: "old"}, created = {id: "new", place: async () => placement};
const deleted = [];
cat.lib.constants.summons = {getSummonData: () => null, getSummonsBySource: () => [previous],
  createSummon: async () => created, deleteSummon: async value => {
    if (value === previous && failOldCleanup) throw new Error("Expected cleanup failure");
    deleted.push(value);
  }};
globalThis.MidiQOL = {hasUsedBonusAction: () => false, removeBonusActionUsed: async () => { refundedBonus++; }};
const workflow = {token: {disposition: 1}, actor: caster};
await prepare({document: feature, workflow});
await summon({document: feature, workflow});
assert.deepEqual(deleted, [created]);
assert.equal(feature.system.uses.spent, 0);
assert.equal(refundedBonus, 1);
assert.ok(!deleted.includes(previous), "Canceling placement preserves the previous summon");
deleted.length = 0; placement = {actor: sourceActor}; failOldCleanup = true;
const logError = console.error; console.error = () => {};
try { await summon({document: feature, workflow}); } finally { console.error = logError; }
assert.equal(feature.system.uses.spent, 1, "A placed summon remains committed even if old-summon cleanup fails");
assert.ok(!deleted.includes(created));

const blade = {actor: caster, system: {identifier: "khuzoe-shadow-blade-weapon", equipped: true, quantity: 1}};
registerDocuments(blade);
await finishShadowBladeThrow({item: blade, attackMode: "thrown"});
assert.equal(blade.system.equipped, false);
assert.equal(blade.system.quantity, 0);
assert.equal(restrictGaseousActions({item: blade, type: "attack"}), false, "A thrown blade must be recalled before another attack");

const scene = {grid: {size: 100, distance: 1.524, units: "m"}};
const token = {id: "token", x: 0, y: 0, width: 1, height: 1, parent: scene};
let regionData;
cat.utils.documentUtils.createEmbeddedDocuments = async (_scene, type, entries) => { assert.equal(type, "Region"); [regionData] = entries; return [{id: "region"}]; };
cat.utils.documentUtils.makeDependent = async () => {};
await createSpellArea({token, template: {x: 0, y: 0, direction: 45, distance: 3.048 * Math.SQRT2}},
  {name: "Grease", uuid: "Item.grease", actor: caster}, {rule: "grease", controller: {}});
assert.ok(Math.abs(regionData.shapes[0].width - 200) < 0.001, "A metric Grease template remains a 10 ft square");
console.log("Khuzoe lifecycle: conditional NPC AC, summon rollback/commit, Shadow Blade and metric terrain OK.");
