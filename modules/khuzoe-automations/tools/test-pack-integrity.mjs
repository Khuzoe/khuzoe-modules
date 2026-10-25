import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

const onceHooks = new Map();
const automations = [];
const macros = [];

globalThis.Hooks = {
  once(name, callback) { onceHooks.set(name, callback); },
  on() {}
};
globalThis.game = {
  modules: new Map([["khuzoe-automations", {active: true}]]),
  user: {id: "AuditUser000001", isGM: true},
  users: []
};
globalThis.ui = {notifications: {error() {}, info() {}, warn() {}}};
globalThis.cat = {
  api: {
    registerSourceName() {},
    registerAutomation(data) { automations.push(data); return data; },
    registerFnMacro(data) { macros.push(data); return data; }
  },
  utils: {}
};

await import("../scripts/main.mjs");
onceHooks.get("catReady")();

const packDirectories = new Map([
  ["khuzoe-spells-2014", "KhuzoeSpells2014"],
  ["khuzoe-spells-2024", "KhuzoeSpells2024"],
  ["khuzoe-class-features-2014", "KhuzoeClassFeatures2014"],
  ["khuzoe-npc-features-2014", "KhuzoeNpcFeatures2014"]
]);
const documentsByUuid = new Map();
const documents = [];

function walkMacroReferences(value, path, output) {
  if (!value || typeof value !== "object") return;
  const catMacros = value.flags?.cat?.macros;
  if (catMacros && typeof catMacros === "object") {
    for (const [group, references] of Object.entries(catMacros)) {
      assert.ok(Array.isArray(references), `${path}: gruppo macro CAT ${group} non è un array`);
      for (const reference of references) output.push({reference, path: `${path}.flags.cat.macros.${group}`});
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "flags") continue;
    if (Array.isArray(child)) child.forEach((entry, index) => walkMacroReferences(entry, `${path}.${key}[${index}]`, output));
    else if (child && typeof child === "object") walkMacroReferences(child, `${path}.${key}`, output);
  }
}

function validateItem(document, filename) {
  assert.match(document._id, /^[A-Za-z0-9]{16}$/, `${filename}: ID Item non valido`);
  assert.equal(document.flags?.["chris-premades"], undefined, `${filename}: flag Cauldron residuo`);
  const activities = Object.values(document.system?.activities ?? {});
  const activityIds = new Set();
  for (const activity of activities) {
    assert.match(activity._id, /^[A-Za-z0-9]{16}$/, `${filename}: ID attività non valido`);
    assert.ok(!activityIds.has(activity._id), `${filename}: ID attività duplicato ${activity._id}`);
    activityIds.add(activity._id);
  }
  const activityIdentifiers = document.flags?.["khuzoe-automations"]?.activityIdentifiers ?? {};
  for (const [key, id] of Object.entries(activityIdentifiers)) {
    assert.ok(activityIds.has(id), `${filename}: activityIdentifiers.${key} punta all'attività inesistente ${id}`);
  }
  const effects = document.effects ?? [];
  const effectIds = new Set();
  for (const effect of effects) {
    assert.match(effect._id, /^[A-Za-z0-9]{16}$/, `${filename}: ID effetto non valido`);
    assert.ok(!effectIds.has(effect._id), `${filename}: ID effetto duplicato ${effect._id}`);
    effectIds.add(effect._id);
    assert.equal(effect.changes, undefined, `${filename}/${effect.name}: changes usa ancora lo schema pre-v14`);
    assert.ok(Array.isArray(effect.system?.changes), `${filename}/${effect.name}: system.changes mancante`);
    assert.equal(effect.flags?.["chris-premades"], undefined, `${filename}/${effect.name}: flag effetto Cauldron residuo`);
    assert.equal(effect.flags?.dae?.showIcon, undefined, `${filename}/${effect.name}: showIcon DAE legacy; usare il campo v14 dell'effetto`);
    for (const change of effect.system?.changes ?? []) {
      const value = String(change.value ?? "");
      assert.notEqual(change.key, "macro.tokenMagic", `${filename}/${effect.name}: dipendenza TokenMagic residua`);
      assert.notEqual(change.key, "system.attributes.senses.darkvision", `${filename}/${effect.name}: percorso darkvision pre-v14`);
      assert.notEqual(change.key, "system.bonuses.All-Attacks", `${filename}/${effect.name}: percorso bonus attacchi non valido`);
      assert.doesNotMatch(value, /(^|,\s*)saveRemove\s*=\s*true(?=\s*,|$)/i, `${filename}/${effect.name}: saveRemove OverTime legacy`);
      assert.doesNotMatch(value, /(^|,\s*)failRemove\s*=\s*true(?=\s*,|$)/i, `${filename}/${effect.name}: failRemove OverTime legacy`);
      assert.doesNotMatch(value, /rollMode\s*=\s*publicroll/i, `${filename}/${effect.name}: rollMode OverTime legacy`);
    }
  }
  for (const activity of activities) {
    for (const reference of activity.effects ?? []) {
      assert.ok(effectIds.has(reference._id), `${filename}/${activity.name}: effetto inesistente ${reference._id}`);
    }
  }
  const riders = document.flags?.dnd5e?.riders ?? {};
  for (const id of riders.activity ?? []) assert.ok(activityIds.has(id), `${filename}: rider attività inesistente ${id}`);
  for (const id of riders.effect ?? []) assert.ok(effectIds.has(id), `${filename}: rider effetto inesistente ${id}`);
}

for (const [directory, packName] of packDirectories) {
  const root = new URL(`../packData/${directory}/`, import.meta.url);
  for (const filename of (await readdir(root)).filter(file => file.endsWith(".json"))) {
    const document = JSON.parse(await readFile(new URL(filename, root), "utf8"));
    validateItem(document, filename);
    const uuid = `Compendium.khuzoe-automations.${packName}.Item.${document._id}`;
    assert.ok(!documentsByUuid.has(uuid), `${filename}: UUID duplicato ${uuid}`);
    documentsByUuid.set(uuid, document);
    documents.push({document, filename, uuid});
  }
}

assert.equal(documents.length, 168, "Numero inatteso di documenti Item Khuzoe");
assert.equal(automations.length, documents.length, "Ogni Item deve avere una sola automazione registrata");

const automationKeys = new Set();
for (const automation of automations) {
  const document = documentsByUuid.get(automation.uuid);
  assert.ok(document, `Automazione ${automation.identifier}: UUID inesistente ${automation.uuid}`);
  assert.equal(document.system.identifier, automation.identifier, `${automation.uuid}: identifier non corrispondente`);
  assert.equal(document.system.source?.rules, automation.rules, `${automation.uuid}: rules non corrispondenti`);
  assert.equal(document.type, automation.type, `${automation.uuid}: tipo non corrispondente`);
  assert.equal(document.flags?.cat?.automation?.source, automation.source, `${automation.uuid}: source CAT non corrispondente`);
  assert.equal(document.flags?.cat?.automation?.version, automation.version, `${automation.uuid}: versione CAT non corrispondente`);
  const key = `${automation.source}|${automation.rules}|${automation.type}|${automation.identifier}`;
  assert.ok(!automationKeys.has(key), `Automazione duplicata ${key}`);
  automationKeys.add(key);
}

const macroKeys = new Set(macros.map(macro => `${macro.source}|${macro.rules}|${macro.identifier}`));
const macroReferences = [];
for (const {document, filename} of documents) walkMacroReferences(document, filename, macroReferences);
for (const {reference, path} of macroReferences) {
  assert.equal(typeof reference?.source, "string", `${path}: source macro mancante`);
  assert.equal(typeof reference?.rules, "string", `${path}: rules macro mancante`);
  assert.equal(typeof reference?.identifier, "string", `${path}: identifier macro mancante`);
  const key = `${reference.source}|${reference.rules}|${reference.identifier}`;
  assert.ok(macroKeys.has(key), `${path}: macro non registrata ${key}`);
}

console.log(`Khuzoe Automations | Integrità compendi: ${documents.length} Item, ${automations.length} automazioni e ${macroReferences.length} riferimenti macro OK.`);
