import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {extractPack} from "@foundryvtt/foundryvtt-cli";

import {
  EXPANDED_SPELL_CATALOG,
  EXPANDED_SPELL_VERSION,
  expandedSpellId
} from "../scripts/expanded-spell-catalog.mjs";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePack = fileURLToPath(new URL("../../chris-premades/packs/cpr-spells", import.meta.url));
const extractedSource = `${moduleRoot}/.analysis-cpr-spells`;
const outputDirectory = `${moduleRoot}/packData/khuzoe-spells-2014`;
const MODULE_ID = "khuzoe-automations";
const EFFECT_HANDLER = "khuzoe-expanded-spell-effect";

// Gli effetti creati a runtime ricevono già il macro tecnico da createEffect.
// Gli effetti incorporati nel compendio usano invece solo dati D&D/DAE: non
// agganciarli al gestore globale evita eventi CAT inutili a ogni tiro.
const effectHookSpells = new Set(["blade-ward"]);

const effectStatuses = new Map([
  ["blinding-smite", ["blinded"]],
  ["charm-person", ["charmed"]],
  ["hold-person", ["paralyzed"]],
  ["hypnotic-pattern", ["charmed", "incapacitated"]],
  ["raulothims-psychic-lance", ["incapacitated"]],
  ["spray-of-cards", ["blinded"]],
  ["wrathful-smite", ["frightened"]]
]);

const modeTypes = new Map([
  [0, "custom"],
  [1, "multiply"],
  [2, "add"],
  [3, "downgrade"],
  [4, "upgrade"],
  [5, "override"]
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeName(value) {
  return String(value).replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function durationSeconds(system) {
  const value = Number(system?.duration?.value ?? 0);
  const units = system?.duration?.units;
  if (!Number.isFinite(value) || value <= 0) return null;
  return ({round: 6, turn: 6, minute: 60, hour: 3600, day: 86400})[units] * value || null;
}

function normalizeOverTime(value, identifier) {
  let result = String(value ?? "")
    .replaceAll(/(^|,\s*)saveRemove\s*=\s*true(?=\s*,|$)/gi, "$1saveCount=1-")
    .replaceAll(/(^|,\s*)failRemove\s*=\s*true(?=\s*,|$)/gi, "$1saveCount=0")
    .replaceAll(/rollMode\s*=\s*publicroll/gi, "rollMode=public");
  if (identifier === "synaptic-static" && !/(^|,)\s*saveCount\s*=/.test(result)) result += ",saveCount=1-";
  return result;
}

function normalizeChange(change, item) {
  const result = clone(change);
  result.type = result.type ?? modeTypes.get(Number(result.mode)) ?? "custom";
  delete result.mode;
  if (result.key === "system.attributes.senses.darkvision") result.key = "system.attributes.senses.ranges.darkvision";
  if (result.key === "macro.tokenMagic") return [];
  if (result.key === "flags.midi-qol.OverTime") result.value = normalizeOverTime(result.value, item.system.identifier);
  if (result.key === "system.bonuses.All-Attacks") {
    return ["mwak", "rwak", "msak", "rsak"].map(type => ({
      ...result,
      key: `system.bonuses.${type}.attack`
    }));
  }
  return [result];
}

function normalizeActivity(activity, item, hidden) {
  const result = clone(activity);
  result.name ||= item.name;
  result.img ||= item.img;
  result.visibility ??= {level: {min: null, max: null}};
  result.midiProperties ??= {};
  result.midiProperties.confirmTargets ??= item.flags?.midiProperties?.confirmTargets ?? "default";
  result.midiProperties.autoTargetType ??= "any";
  result.midiProperties.autoTargetAction ??= "default";
  result.midiProperties.magicDamage ??= Boolean(item.flags?.midiProperties?.magicdam);
  result.midiProperties.magicEffect ??= Boolean(item.flags?.midiProperties?.magiceffect);
  if (result.midiAutomationOnly !== undefined) {
    result.midiProperties.automationOnly = Boolean(result.midiAutomationOnly);
    delete result.midiAutomationOnly;
  }
  result.flags ??= {};
  if (hidden) {
    result.flags.cat = {...result.flags.cat, hidden: true};
    result.midiProperties.automationOnly = true;
  }
  const references = result.effects?.length ? result.effects : result.appliedEffects?.map(_id => ({_id}));
  result.effects = (references ?? []).map(reference => ({
    _id: typeof reference === "string" ? reference : reference._id,
    level: reference?.level ?? {min: null, max: null}
  }));
  delete result.appliedEffects;
  return result;
}

function normalizeEffect(effect, item, index) {
  const oldId = effect._id;
  const id = expandedSpellId(`${item.system.identifier}:effect:${index}`);
  const result = clone(effect);
  result._id = id;
  result.type ??= "base";
  result.system ??= {};
  result.system.changes = (result.system.changes ?? result.changes ?? [])
    .flatMap(change => normalizeChange(change, item));
  // Blade Ward 2014 protegge soltanto dai danni B/P/S inflitti da un attacco
  // con arma. Le tre resistenze statiche del documento CPR si applicherebbero
  // invece anche a cadute, trappole e altri danni non derivati da un attacco.
  // Il gestore runtime applica la riduzione solo nel contesto corretto.
  if (item.system.identifier === "blade-ward") {
    result.system.changes = result.system.changes.filter(change => !(
      change.key === "system.traits.dr.value"
      && ["bludgeoning", "piercing", "slashing"].includes(String(change.value))
    ));
  }
  // Synaptic Static penalizza attacchi e prove di caratteristica, non i tiri
  // salvezza di Costituzione effettuati per mantenere la concentrazione.
  if (item.system.identifier === "synaptic-static") {
    result.system.changes = result.system.changes.filter(change =>
      change.key !== "system.attributes.concentration.bonuses.save"
    );
  }
  if (item.system.identifier === "hypnotic-pattern") {
    result.system.changes.push({
      key: "system.attributes.movement.all",
      value: "*0",
      priority: 20,
      type: "custom"
    });
  }
  delete result.changes;
  result.statuses = [...new Set([...(result.statuses ?? []), ...(effectStatuses.get(item.system.identifier) ?? [])])];
  if (result.statuses.length) result.showIcon = 1;
  result.origin = null;
  delete result._stats;
  result.duration = {
    value: Number(result.duration?.seconds) || durationSeconds(item.system),
    units: "seconds",
    expiry: "turnStart",
    expired: false
  };
  result.showIcon = Number(result.showIcon ?? result.flags?.dae?.showIcon ?? 1);
  result.flags ??= {};
  delete result.flags["chris-premades"];
  result.flags.dae = {
    transfer: false,
    stackable: result.flags.dae?.stackable ?? "noneNameOnly",
    expiryMode: result.flags.dae?.expiryMode ?? "delete",
    specialDuration: result.flags.dae?.specialDuration ?? []
  };
  if (effectHookSpells.has(item.system.identifier)) {
    result.flags[MODULE_ID] = {
      ...(result.flags[MODULE_ID] ?? {}),
      expandedSpell: {identifier: item.system.identifier}
    };
    result.flags.cat = {
      identifier: EFFECT_HANDLER,
      macros: {
        roll: [{source: MODULE_ID, rules: "2014", identifier: EFFECT_HANDLER}],
        combat: [{source: MODULE_ID, rules: "2014", identifier: EFFECT_HANDLER}],
        effect: [{source: MODULE_ID, rules: "2014", identifier: EFFECT_HANDLER}],
        save: [{source: MODULE_ID, rules: "2014", identifier: EFFECT_HANDLER}],
        check: [{source: MODULE_ID, rules: "2014", identifier: EFFECT_HANDLER}]
      }
    };
  }
  result._key = `!items.effects!${item._id}.${id}`;
  return {oldId, id, effect: result};
}

function transform(source, catalog) {
  const item = clone(source);
  item._id = catalog.id;
  item.system.identifier = catalog.identifier;
  item.system.source = {
    custom: "Khuzoe Automations",
    book: item.system.source?.book ?? "",
    page: item.system.source?.page ?? "",
    license: item.system.source?.license ?? "",
    rules: "2014"
  };

  const cpr = item.flags?.["chris-premades"] ?? {};
  const activityIdentifiers = clone(cpr.activityIdentifiers ?? {});
  const hiddenNames = new Set(cpr.hiddenActivities ?? []);
  const hiddenIds = new Set([...hiddenNames].map(name => activityIdentifiers[name]).filter(Boolean));

  item.flags ??= {};
  delete item.flags["chris-premades"];
  item.flags.cat = {
    automation: {source: MODULE_ID, version: EXPANDED_SPELL_VERSION},
    macros: {
      roll: [{source: MODULE_ID, rules: "2014", identifier: catalog.identifier}]
    }
  };
  item.flags[MODULE_ID] = {
    importedFrom: "Cauldron 1.2.39 (document schema only; runtime-independent)",
    sourceIdentifier: catalog.source,
    activityIdentifiers
  };

  const oldActivities = Object.values(item.system.activities ?? {});
  item.system.activities = Object.fromEntries(oldActivities.map(activity => {
    const normalized = normalizeActivity(activity, item, hiddenIds.has(activity._id));
    return [normalized._id, normalized];
  }));

  // Foundry v14 rappresenta le aree persistenti come Region. CAT può quindi
  // eseguire nativamente l'attività tecnica di Grease all'ingresso e alla fine
  // del turno, senza hook globali né una dipendenza runtime da Cauldron.
  if (catalog.identifier === "grease") {
    const sourceActivity = item.system.activities[activityIdentifiers.grease];
    const fallActivityId = activityIdentifiers.greaseFall;
    if (sourceActivity && fallActivityId) {
      sourceActivity.flags ??= {};
      sourceActivity.flags.cat ??= {};
      sourceActivity.flags.cat.placed = {
        ...(sourceActivity.flags.cat.placed ?? {}),
        region: {
          ...(sourceActivity.flags.cat.placed?.region ?? {}),
          activities: [{
            id: fallActivityId,
            triggers: ["enter", "turnEnd"],
            disposition: "all",
            oncePerTurn: false
          }]
        }
      };
    }
  }

  const normalizedEffects = (item.effects ?? []).map((effect, index) => normalizeEffect(effect, item, index));
  const effectIds = new Map(normalizedEffects.map(({oldId, id}) => [oldId, id]));
  item.effects = normalizedEffects.map(({effect}) => effect);
  for (const activity of Object.values(item.system.activities)) {
    activity.effects = (activity.effects ?? [])
      .map(reference => ({...reference, _id: effectIds.get(reference._id) ?? reference._id}))
      .filter(reference => item.effects.some(effect => effect._id === reference._id));
  }
  item.flags.dnd5e ??= {};
  item.flags.dnd5e.riders ??= {};
  item.flags.dnd5e.riders.activity = Object.values(item.system.activities)
    .filter(activity => activity.flags?.cat?.hidden)
    .map(activity => activity._id);
  item.flags.dnd5e.riders.effect = item.effects.map(effect => effect._id);
  delete item._stats;
  item.folder = null;
  item.sort = 0;
  item.ownership = {default: 0};
  item._key = `!items!${item._id}`;
  return item;
}

if (!existsSync(sourcePack)) {
  throw new Error("Cauldron 1.2.39 non trovato nella portable v14: impossibile importare i documenti sorgente.");
}
if (!existsSync(extractedSource)) {
  await extractPack(sourcePack, extractedSource, {clean: true, log: false});
}

const sourceFiles = (await readdir(extractedSource)).filter(file => file.endsWith(".json"));
const documents = [];
for (const file of sourceFiles) {
  documents.push(JSON.parse(await readFile(`${extractedSource}/${file}`, "utf8")));
}
const bySourceIdentifier = new Map(documents.map(document => [document.flags?.["chris-premades"]?.info?.identifier, document]));

await mkdir(outputDirectory, {recursive: true});
for (const catalog of EXPANDED_SPELL_CATALOG) {
  const source = bySourceIdentifier.get(catalog.source);
  if (!source) throw new Error(`Documento Cauldron mancante: ${catalog.source}`);
  const item = transform(source, catalog);
  const filename = `${safeName(item.name)}_${item._id}.json`;
  await writeFile(`${outputDirectory}/${filename}`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Khuzoe Automations | Importate ${EXPANDED_SPELL_CATALOG.length} spell 2014 facili/medie.`);
