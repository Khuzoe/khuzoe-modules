import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {registerHomebrewNpcs, NPC_IDS, NPC_AURA_IDS} from "../scripts/homebrew-npcs.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";

// Exercise the installed CAT implementation, including its third-party request
// and roll application. Only Foundry documents, dice and the dialog are simulated.
const map = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
function catSource(suffix) {
  const index = map.sources.findIndex(path => path.endsWith(suffix));
  assert.ok(index >= 0, `Installed CAT source missing: ${suffix}`);
  return map.sourcesContent[index].replace(/^import .*;\r?$/gm, "");
}
async function loadCat(suffix, dependencies) {
  const source = `const {${dependencies.join(",")}} = globalThis.catDanceDependencies;\n${catSource(suffix)}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

class Actor {}
class BasicRoll {
  constructor(formula, data = {}, options = {}) { Object.assign(this, {formula, data, options, total: Number(formula)}); }
}
globalThis.game = {user: {id: "roller", isGM: true}, combat: {id: "combat", started: true, round: 1}};
globalThis.CONFIG = {Actor: {documentClass: Actor}, Dice: {BasicRoll}, DND5E: {activityConsumptionTypes: {}}};
globalThis.dnd5e = {utils: {formatNumber: String, getHumanReadableAttributeLabel: String}};
globalThis.foundry = {utils: {deepClone: structuredClone}};
globalThis._loc = value => value;
Number.isNumeric = value => Number.isFinite(Number(value));
const source = Object.assign(new Actor(), {id: "naniss", uuid: "Actor.naniss", name: "Na'Niss", items: [], effects: [], statuses: new Set(), system: {attributes: {hp: {value: 20}}}});
const ally = Object.assign(new Actor(), {id: "ally", uuid: "Actor.ally", name: "Ally"});
const scene = {id: "scene", tokens: []};
function token(actor) {
  actor.token = {id: actor.id, uuid: `Scene.scene.Token.${actor.id}`, documentName: "Token", parent: scene, actor};
  scene.tokens.push(actor.token);
  return actor.token;
}
const sourceToken = token(source), allyToken = token(ally);
globalThis.canvas = {scene};
game.khuzoeAuras = {
  getAuraSources: (_scene, id) => id === NPC_AURA_IDS.naniss ? [{token: sourceToken, aura: {id}}] : [],
  getEligibleTargets: () => [sourceToken, allyToken]
};
const dance = {id: "dance", documentName: "Item", name: "Danza Incoraggiante", actor: source,
  flags: {}, system: {identifier: NPC_IDS.nanissDance, activities: []}};
source.items.push(dance);
registerDocuments(source, ally, dance);
const reactions = new Set();
globalThis.MidiQOL = {setReactionUsed: async actor => reactions.add(actor.uuid), removeReactionUsed: async actor => reactions.delete(actor.uuid)};
globalThis.cat = {utils: {actorUtils: {hasUsedReaction: actor => reactions.has(actor.uuid)},
  queryUtils: {}, documentUtils: {}, effectUtils: {createEffects: async () => []}}};
let approval = true, requests = [], selected = true, category = "roll";
const dependencies = globalThis.catDanceDependencies = {
  activityUtils: {}, dataUtils: {toArray: value => Array.isArray(value) ? value : [value]}, effectUtils: {}, genericUtils: {}, workflowUtils: {},
  queryUtils: {firstOwner: actor => { assert.equal(actor, source); return {id: "naniss-owner", name: "Owner"}; }},
  dialogUtils: {confirmUseForRollTotal: async (_document, name, total, options) => {
    requests.push({name, total, options}); return approval;
  }}
};
const {D20Bonus, DamageBonus} = await loadCat("/lib/optionalBonus.mjs", Object.keys(dependencies));
const macros = [];
registerHomebrewNpcs({registerAutomation() {}, registerFnMacro: macro => macros.push(macro)});
const entry = macros.find(macro => macro.identifier === NPC_IDS.nanissDance);
const makeBonus = (actor = ally) => entry[category][0].macro({document: dance, actor, token: actor.token, D20Bonus});
dependencies.dialogUtils.selectScaledDocument = async bonuses => {
  if (!selected) return false;
  for (const bonus of bonuses) {
    // CAT uses a request input, rather than a checkbox, for third-party bonuses.
    const result = bonus.isThirdParty ? await bonus.request(undefined, bonuses, 12) : true;
    bonus.active = result === true || result?.result === true;
  }
  return D20Bonus.ValidateAll(bonuses, {});
};
dependencies.rollUtils = {addToRoll: async (roll, formula) => {
  assert.equal(formula, "1d10 + 5");
  return {...roll, formula: `${roll.formula} + ${formula}`, total: roll.total + 11};
}};
dependencies.D20Bonus = D20Bonus;
dependencies.DamageBonus = DamageBonus;
dependencies.constants = {workflowPasses: {}, rollPasses: {}};
class Event { async run() { const bonus = makeBonus(); return bonus ? [bonus] : []; } }
dependencies.Events = {WorkflowEvent: Event, CheckEvent: Event, SaveEvent: Event, SkillEvent: Event};
const {default: optionalBonus} = await loadCat("/mechanics/optionalBonus.mjs", ["D20Bonus", "DamageBonus", "constants", "Events", "dialogUtils", "rollUtils", "workflowUtils"]);

function reset() { source.flags = {}; reactions.clear(); requests = []; }
for (const kind of ["roll", "save", "check", "skill"]) {
  reset(); category = kind;
  const roll = new BasicRoll("12");
  let result;
  if (kind === "roll") {
    const workflow = {attackRoll: roll, actor: ally, targets: [], setAttackRoll: async value => { result = value; }};
    await optionalBonus.attack(workflow);
  } else result = await optionalBonus[kind](ally, {roll});
  assert.equal(requests.length, 1, `${kind}: CAT must request the source owner's approval`);
  assert.equal(requests[0].options.userId, "naniss-owner");
  assert.equal(result?.total, 23, `${kind}: accepting Dance adds the bonus to the original roll`);
  assert.equal(source.flags["khuzoe-automations"].nanissDanceReaction.combatId, "combat");
  assert.equal(reactions.has(source.uuid), true);
  assert.equal(reactions.has(ally.uuid), false);
}
reset(); category = "check"; approval = false;
assert.equal(await optionalBonus.check(ally, {roll: new BasicRoll("12")}), undefined);
assert.equal(reactions.size, 0, "Declining approval must not spend a reaction");
reset(); selected = false; approval = true;
assert.equal(await optionalBonus.check(ally, {roll: new BasicRoll("12")}), undefined);
assert.equal(requests.length, 0, "Cancelling selection must not request approval");
assert.equal(reactions.size, 0);
reset(); selected = true;
assert.equal(makeBonus(source).isThirdParty, false, "Na'Niss's own roll remains a normal optional bonus");
reactions.add(source.uuid);
assert.equal(makeBonus(), undefined, "A spent reaction cannot offer Dance");
console.log("Dance / installed CAT: owner approval, original attack/save/check/skill totals, decline/cancel and reaction ownership OK");
