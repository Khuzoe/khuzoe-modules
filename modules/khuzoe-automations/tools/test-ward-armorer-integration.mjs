import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {ARMORER_AUTOMATIONS, applyArmorerAlias, prepareArmorerUpdate} from "../scripts/armorer.mjs";
globalThis.Hooks = {on() {}, once() {}};
const {wardDamagePreview, calculateWardDamage} = await import("../scripts/arcane-ward.mjs");
const MODULE = "khuzoe-automations";
const get = (data, path) => path.split(".").reduce((value, key) => value?.[key], data);
const set = (data, path, value) => {
  const keys = path.split("."), last = keys.pop(); keys.reduce((target, key) => target[key] ??= {}, data)[last] = value;
};
globalThis.foundry = {utils: {deepClone: structuredClone, getProperty: get, setProperty: set}};
globalThis.game = {user: {id: "gm", isGM: true}, users: []};
globalThis.CONFIG = {DND5E: {defaultArtwork: {Item: {}}}};
const map = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
const source = suffix => {
  const index = map.sources.findIndex(path => path.endsWith(suffix)); assert.ok(index >= 0, suffix); return map.sourcesContent[index];
};
function fn(text, name, dependencies = {}) {
  const match = text.match(new RegExp(`^(async )?function ${name}\\(([^\\n]*)\\) \\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(match, name);
  return new Function(...Object.keys(dependencies), `return ${match[1] ?? ""}function(${match[2]}) {${match[3]}}`)(...Object.values(dependencies));
}
const keepPaths = fn(source("/lib/constants.mjs"), "getItemKeepPaths");
const lookupBody = source("/lib/automations.mjs").match(/    getAutomationByIdentifier\(([^\n]*)\) \{([\s\S]*?)\n    \}/);
const lookup = new Function(`return function(${lookupBody[1]}) {${lookupBody[2]}}`)();
const registry = {automations: new Map(ARMORER_AUTOMATIONS.map(entry => [entry.uuid, entry])), getAutomationByIdentifier(...args) { return lookup.call(this, ...args); }};
const sources = new Map();
for (const automation of ARMORER_AUTOMATIONS) {
  const path = new URL(`../packData/khuzoe-class-features-2014/${automation.name.replace(/\W+/g, "_")}_${automation.uuid.split(".").at(-1)}.json`, import.meta.url);
  const data = JSON.parse(await readFile(path, "utf8")); sources.set(automation.uuid, {toObject: () => structuredClone(data)});
}
globalThis.fromUuid = async uuid => sources.get(uuid);
const updateItem = fn(source("/utilities/automationUtils.mjs"), "updateItem", {
  documentUtils: {getIdentifier: item => item.system.identifier, getRules: item => item.system.source.rules,
    update: async (item, changes, options) => { assert.deepEqual(options, {recursive: false, diff: false}); prepareArmorerUpdate(item, changes); return item.update(changes); }},
  itemUtils: {getSourceClass: () => null, stripDescriptionBlock: text => text},
  constants: {automations: registry, getItemKeepPaths: keepPaths}, genericUtils: {getProperty: get, setProperty: set},
  updateScales: async () => {}, itemEvents: {itemMedkit: async () => {}}
});
let tests = 0;
function itemFixture(data) {
  const item = {...structuredClone(data), id: "original-id", uuid: "Actor.owner.Item.original", isOwner: true,
    toObject() { return structuredClone({_id: this.id, name: this.name, img: this.img, type: this.type, system: this.system, flags: this.flags, effects: this.effects ?? []}); },
    async update(changes) { for (const [key, value] of Object.entries(changes)) set(this, key, structuredClone(value)); return this; }};
  return item;
}
for (const type of ["feat", "weapon"]) {
  const item = itemFixture({name: "Custom gauntlets", img: "custom.webp", type, system: {identifier: "thunder-gauntlets", source: {rules: "2014"},
    equipped: true, magicalBonus: "2", damage: {base: {number: 1, denomination: 8}}, description: {value: "Custom description"}},
    flags: {dnd5e: {enchantment: {origin: "Item.infusion"}}}, effects: [{_id: "enchantment", type: "enchantment", system: {changes: []}}]});
  await updateItem(item, {source: MODULE, skipEvent: true});
  assert.equal(item.type, type, "CAT must not replace a weapon with a feat sharing its identifier");
  assert.equal(item.name, "Custom gauntlets");
  assert.equal(item.system.description.value, "Custom description");
  if (type === "weapon") {
    assert.equal(item.system.magicalBonus, "2");
    assert.equal(item.effects[0]._id, "enchantment");
    assert.equal(item.flags.dnd5e.enchantment.origin, "Item.infusion");
  }
  assert.equal(item.id, "original-id"); tests++;
}
{
  const item = itemFixture({type: "feat", name: "Defensive Field", system: {identifier: "", source: {rules: "2024"}, uses: {spent: 2}}, flags: {}, effects: []});
  const automation = ARMORER_AUTOMATIONS.find(entry => entry.key === "field");
  await applyArmorerAlias(item, automation, () => updateItem(item, {source: MODULE, skipEvent: true}));
  assert.equal(item.system.identifier, "defensive-field");
  assert.equal(item.system.source.rules, "2014");
  assert.equal(item.system.uses.spent, 2);
  const canceled = itemFixture({type: "feat", name: "Defensive Field", system: {identifier: "", source: {rules: "2024"}}, flags: {}});
  await assert.rejects(applyArmorerAlias(canceled, automation, async () => {}), /CAT/);
  assert.equal(canceled.system.identifier, ""); assert.equal(canceled.system.source.rules, "2024"); tests += 2;
}
// Use CAT's real critical-damage helper boundary, not a separate custom roll.
{
  const seen = [];
  CONFIG.Dice = {DamageRoll: class {
    constructor(formula, data, options) { this.formula = formula; this.options = options; seen.push(formula); }
    async evaluate() { return this; }
  }};
  const bonus = fn(source("/utilities/workflowUtils.mjs"), "bonusDamage", {rollUtils: {getCriticalFormula: formula => formula.replace("1d6", "2d6")}});
  for (const critical of [false, true]) {
    const workflow = {isCritical: critical, activity: {getRollData: () => ({})}, damageRolls: [], async setDamageRolls(rolls) { this.damageRolls = rolls; }};
    await bonus(workflow, "1d6", {damageType: "lightning"});
    assert.equal(workflow.damageRolls.length, 1); assert.equal(workflow.damageRolls[0].options.type, "lightning");
  }
  assert.deepEqual(seen, ["1d6", "2d6"]); tests += 2;
}
// Midi's real damage-card serializer must preserve the ward plan through the GM socket.
{
  const text = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
  const encode = fn(text, "prepareDamageDetailToJSON"), decode = fn(text, "recoverDamageDetailFromJSON");
  const encodeList = fn(text, "prepareDamageListToJSON", {prepareDamageDetailToJSON: encode});
  const decodeList = fn(text, "recoverDamageListFromJSON", {recoverDamageDetailFromJSON: decode});
  const actor = {uuid: "Actor.ward", classes: {wizard: {system: {levels: 4}}},
    system: {abilities: {int: {mod: 4}}, attributes: {hp: {value: 30, max: 30, temp: 0}}},
    calculateDamage: damages => damages.map(d => ({...d, value: d.value / 2}))};
  const item = {type: "feat", actor, system: {identifier: "arcane-ward", uses: {spent: 0}}, flags: {cat: {automation: {source: MODULE}}, [MODULE]: {wardCreated: true}}};
  actor.items = [item];
  const ditem = {rawDamageDetail: [{value: 20, type: "fire", properties: new Set(["mgc"])}], calcDamageOptions: {ignore: {immunity: new Set(["cold"])}}, damageDetails: {}};
  wardDamagePreview({document: item, workflow: {id: "serial"}, ditem});
  const recovered = decodeList(JSON.parse(JSON.stringify(encodeList([ditem]))))[0];
  assert.equal(recovered.calcDamageOptions.khuzoeArcaneWard.absorbed, 12);
  assert.equal(calculateWardDamage(actor, recovered.calcDamageOptions.khuzoeArcaneWard.chunks).amount, 4);
  assert.deepEqual(recovered.damageDetail[0].properties, new Set(["mgc"])); tests++;
}
console.log(`Installed CAT/Midi integration: ${tests} typed lookups, complete Item replacements, alias/rollback, critical damage and GM serialization scenarios OK.`);
