import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {reasoningSituational, prepareReasoningRoll, reasoningPost, reasoningRollWrapper, CAMPAIGN_AUTOMATIONS, applyCampaignAlias} from "../scripts/campaign-features.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";

// Execute the installed CAT wrappers. Foundry documents, dice and UI are simulated.
const map = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
const source = suffix => {
  const index = map.sources.findIndex(path => path.endsWith(suffix)); assert.ok(index >= 0, suffix);
  return map.sourcesContent[index].replace(/^import .*;\r?$/gm, "");
};
const catActor = source("/patches/actor.mjs");
const signatures = ["check", "save", "skill", "tool"];
globalThis.Hooks = {once() {}, on() {}};
globalThis.game = {user: {id: "gm", isGM: true}, users: [], settings: {get: () => "publicroll"}, messages: {contents: []}};
globalThis.foundry = {utils: {setProperty: (object, key, value) => { object[key] = value; }}};
const actor = {uuid: "Actor.reasoning", documentName: "Actor", isOwner: true, effects: [], items: [], system: {abilities: {int: {mod: 4}}}};
const item = {actor, uuid: "Actor.reasoning.Item.reasoning", type: "feat", name: "Ragionamento Preciso", system: {identifier: "ragionamento-preciso", source: {rules: "2024"}, uses: {max: "4", spent: 0}}, flags: {cat: {automation: {source: "khuzoe-automations"}}}};
actor.items.push(item); registerDocuments(actor, item);
let decision = "bonus", nativeReached = false, prompts = 0, otherBonuses = 0, kind;
globalThis.cat = {utils: {queryUtils: {}, dialogUtils: {buttonDialog: async () => { assert.equal(nativeReached, false, "Decision precedes the native d20"); prompts++; return decision; }}}};
globalThis.Roll = class {
  constructor(total, options = {}) { this.total = total; this.options = options; this.dice = [{faces: 20, results: [{result: 12, active: true}]}]; }
};
const events = Object.fromEntries(signatures.map(type => [`${type}Events`, {
  situational: async (_actor, data) => reasoningSituational({...data, document: item}),
  context: async () => {}, targetSituational: async () => {},
  // CAT returns the first truthy bonus result. The native d6 must already be present.
  bonus: async (_actor, {roll}) => { assert.equal(roll.total, 21); otherBonuses++; return new Roll(roll.total + 3, roll.options); },
  post: async (_actor, data) => reasoningPost({...data, document: item})
}]));
globalThis.campaignCatDependencies = {...events,
  skillEvents: events.skillEvents, toolEvents: events.toolEvents, hitDieEvents: {}, Logging: {},
  genericUtils: {mergeObject: Object.assign}, conditionResistanceAndVulnerability: async () => {},
  optionalBonus: Object.fromEntries(signatures.map(type => [type, async () => null]))
};
const factorySource = `const {${Object.keys(campaignCatDependencies).join(",")}}=globalThis.campaignCatDependencies;\n${catActor}\nexport {check,save,skill,tool};`;
const wrappers = await import(`data:text/javascript;base64,${Buffer.from(factorySource).toString("base64")}`);
let cases = 0;
for (kind of signatures) for (const order of ["inside-cat", "outside-cat"]) for (const canceled of [false, true]) {
  item.system.uses.spent = 0; nativeReached = false; prompts = 0;
  const config = kind === "save" || kind === "check" ? {ability: "int"} : kind === "skill" ? {skill: "arc"} : {tool: "thief"};
  const native = async config => {
    nativeReached = true;
    // D&D5e creates its own configuration: state changes here must not be needed for refunds.
    const built = structuredClone(config); built.rolls = [{parts: ["1d20", "@mod"], options: {}}];
    prepareReasoningRoll(built);
    assert.deepEqual(built.rolls[0].parts, ["1d20", "@mod", "1d6[Ragionamento Preciso]"]);
    return canceled ? null : [new Roll(21, built.rolls[0].options)];
  };
  let result;
  if (order === "inside-cat") result = await wrappers[kind].call(actor, (...args) => reasoningRollWrapper.call(actor, native, ...args), config, {}, {create: false});
  else result = await reasoningRollWrapper.call(actor, (...args) => wrappers[kind].call(actor, native, ...args), config, {}, {create: false});
  assert.equal(prompts, 1);
  assert.equal(result?.[0]?.total, canceled ? undefined : 24, "Native d6 and another CAT bonus both survive");
  assert.equal(item.system.uses.spent, canceled ? 0 : 1);
  cases++;
}
assert.equal(otherBonuses, 8);

// Execute CAT's actual lookup predicate: the retired feat must not fall back to the Shield spell.
const automationsSource = source("/lib/automations.mjs");
const lookupBody = automationsSource.match(/    getAutomationByIdentifier\(([^\n]*)\) \{([\s\S]*?)\n    \}/);
assert.ok(lookupBody);
const lookup = new Function(`return function(${lookupBody[1]}) {${lookupBody[2]}}`)();
const spell = {source: "khuzoe-automations", identifier: "shield", type: "spell", rules: "2014", uuid: "Spell.shield"};
const registry = {automations: new Map([[spell.uuid, spell], ...CAMPAIGN_AUTOMATIONS.map(entry => [entry.uuid, entry])])};
assert.equal(lookup.call(registry, "shield", {rules: "2014", type: "feat", source: spell.source}), undefined);
assert.equal(lookup.call(registry, "shield", {rules: "2014", type: "spell", source: spell.source}).uuid, spell.uuid);

// Previously applied Items can retain the old reference; CAT ignores an unregistered macro silently.
const macroSource = source("/lib/macros.mjs");
const macroBody = macroSource.match(/    getFnMacros\(([^\n]*)\) \{([\s\S]*?)\n    \}/);
assert.ok(macroBody);
const getFnMacros = new Function(`return function(${macroBody[1]}) {${macroBody[2].replaceAll("#getMacroKey", "getMacroKey")}}`)();
const macroRegistry = {fnMacros: new Map(), overwriteMacros: new Map(), getMacroKey: (source, identifier, rules) => `${source}|${identifier}|${rules}`};
for (const pass of ["sceneAttackRollConfig", "itemRollFinished"]) {
  assert.equal(getFnMacros.call(macroRegistry, spell.source, "2014", "khuzoe-guardian-shield", "roll", pass), undefined);
}

// Successful alias conversion reaches CAT with the canonical identifier and preserves ownership.
const alias = {...item, system: {...item.system, identifier: "new-item"}, flags: {}, update: async changes => {
  if (changes["system.identifier"]) alias.system.identifier = changes["system.identifier"];
}};
const definition = CAMPAIGN_AUTOMATIONS.find(entry => entry.key === "reasoning");
await applyCampaignAlias(alias, definition, async () => {
  assert.equal(alias.system.identifier, "ragionamento-preciso");
  alias.flags.cat = {automation: {source: "khuzoe-automations", version: definition.version}};
});
assert.equal(alias.actor, actor);
console.log(`Installed CAT integration: ${cases} native roll/order/cancellation combinations, additive bonuses, retired Shield lookup, inert old references and explicit alias application OK.`);
