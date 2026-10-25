import assert from "node:assert/strict";
import {registerHomebrewNpcs, NPC_IDS, NPC_AURA_IDS} from "../scripts/homebrew-npcs.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";

const macros = [];
registerHomebrewNpcs({registerAutomation() {}, registerFnMacro: data => macros.push(data)});
const reactions = new Set();
globalThis.game = {user: {id: "gm", isGM: true}, combat: {id: "combat", started: true, round: 1}};
globalThis.ui = {notifications: {warn() {}, error() {}}};
globalThis.foundry = {utils: {deepClone: structuredClone}};
globalThis.ChatMessage = {getSpeaker: () => ({}), create: async () => ({})};
let dice = 0;
class TestRoll {
  constructor(formula) { this.formula = formula; }
  async evaluate({maximize} = {}) { dice++; this.total = maximize ? 24 : 14; return this; }
}
globalThis.Roll = TestRoll;
globalThis.MidiQOL = {setReactionUsed: async actor => reactions.add(actor.uuid),
  removeReactionUsed: async actor => reactions.delete(actor.uuid)};
globalThis.cat = {utils: {actorUtils: {hasUsedReaction: actor => reactions.has(actor.uuid), getFirstToken: actor => actor.token},
  queryUtils: {}, documentUtils: {}, effectUtils: {createEffects: async () => []},
  itemUtils: {syntheticItem: (data, actor) => ({...data, actor})}, workflowUtils: {}}};
const source = {uuid: "Actor.naniss", items: [], effects: [], statuses: new Set(),
  system: {attributes: {hp: {value: 20, max: 40}}}};
const ally = {uuid: "Actor.ally", system: {attributes: {hp: {value: 1, max: 100}}}};
const second = {uuid: "Actor.second", system: {attributes: {hp: {value: 1, max: 100}}}};
const scene = {id: "scene", tokens: []};
function token(actor, id) { const result = {documentName: "Token", uuid: `Scene.scene.Token.${id}`, id, parent: scene, actor}; actor.token = result; scene.tokens.push(result); return result; }
const sourceToken = token(source, "source"), allyToken = token(ally, "ally"), secondToken = token(second, "second");
globalThis.canvas = {scene};
game.khuzoeAuras = {
  getAuraSources: (_scene, id) => id === NPC_AURA_IDS.naniss ? [{token: sourceToken, aura: {id}}] : [],
  getEligibleTargets: () => [sourceToken, allyToken, secondToken]
};
const dance = {documentName: "Item", id: "dance", actor: source, name: "Danza", system: {identifier: NPC_IDS.nanissDance}};
source.items.push(dance); registerDocuments(source, ally, second, dance);
class Bonus {
  constructor(_item, options) { this.options = options; this.roll = new TestRoll(options.formula); this.rollClass = TestRoll; }
  withValidation(callback) { this.validation = callback; return this; }
  withDefaultRequest() { return this; }
  withOnUse(callback) { this.use = callback; return this; }
  initialize() { return this; }
}
const provide = macros.find(m => m.identifier === NPC_IDS.nanissDance).roll[0].macro;
const first = provide({document: dance, actor: ally, token: allyToken, D20Bonus: Bonus});
const other = provide({document: dance, actor: second, token: secondToken, D20Bonus: Bonus});
assert.equal(first.options.actor, source, "The owner who grants the bonus controls its consumption");
assert.equal(first.options.targetActor, ally);
const used = await Promise.all([first.use(), other.use()]);
assert.equal(used.filter(Boolean).length, 1);
assert.deepEqual([first.roll.formula, other.roll.formula].sort(), ["0", "1d10 + 5"], "CAT's unconditional addition cannot grant a second bonus");

const explosion = {documentName: "Item", id: "explosion", name: "Esplosione", actor: source, system: {identifier: NPC_IDS.spiritExplosion}};
registerDocuments(explosion); source.system.attributes.hp.value = 0;
const trigger = macros.find(m => m.identifier === NPC_IDS.spiritExplosion).roll[0].macro;
let failSecond = true;
const heals = [];
cat.utils.workflowUtils.syntheticActivityDataRoll = async (activity, _item, targets) => {
  if (targets[0] === secondToken && failSecond) return {aborted: true};
  const amount = Number(activity.healing.custom.formula);
  targets[0].actor.system.attributes.hp.value += amount;
  heals.push(targets[0].actor.uuid);
  return {};
};
await assert.rejects(() => trigger({document: explosion}), /annullata/);
assert.equal(ally.system.attributes.hp.value, 15);
assert.equal(second.system.attributes.hp.value, 1);
assert.equal(source.system.attributes.hp.value, 0, "The dead spirit cannot heal itself");
failSecond = false;
await Promise.all([trigger({document: explosion}), trigger({document: explosion})]);
assert.equal(ally.system.attributes.hp.value, 15, "Retry skips the ally already healed");
assert.equal(second.system.attributes.hp.value, 15);
assert.equal(dice, 1, "Retry uses the same shared roll");
assert.equal(heals.length, 2);
assert.equal(explosion.flags["khuzoe-automations"].radiantExplosion.triggered, true);
console.log("NPC concurrency: one Dance reaction, correct owner, partial Explosion retry without duplicate heals OK");
