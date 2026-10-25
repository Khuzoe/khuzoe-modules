import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {readFile, readdir, writeFile} from "node:fs/promises";
import {SPECIAL_SPELL_CATALOG, SPECIAL_SPELL_VERSION, specialActivity, specialDamage} from "../scripts/special-spell-catalog.mjs";

// Read the existing read-only extraction, never the live Cauldron LevelDB.
const input = new URL("../.analysis-cpr-spells/", import.meta.url);
const output = new URL("../packData/khuzoe-spells-2014/", import.meta.url);
const sources = new Map();
for (const file of (await readdir(input)).filter(name => name.endsWith(".json"))) {
  const item = JSON.parse(await readFile(new URL(file, input), "utf8"));
  sources.set(item.flags?.["chris-premades"]?.info?.identifier, item);
}

const concentration = {concentration: true, duration: "minute", durationValue: "1"};
const descriptions = {
  "mirror-image": "Crea tre duplicati per un minuto. La deviazione degli attacchi e il numero di duplicati sono gestiti automaticamente; nessuna concentrazione. I sensi che ignorano le illusioni vengono controllati quando disponibili in Midi-QOL.",
  "heat-metal": "Bersaglia le creature in contatto con lo stesso oggetto metallico scelto dal tavolo. Applica il danno iniziale e rende disponibile Riscalda di nuovo. Chi tiene o indossa l'oggetto sceglie se lasciarlo, tentare il TS o dichiararlo non rimovibile. Chi lo lascia non subisce altri impulsi finché non confermi un nuovo contatto.",
  "dragons-breath": "Scegli una creatura consenziente e il tipo di danno. Per la durata della concentrazione riceve una capacità temporanea di soffio: cono di 15 ft, TS DES contro la CD dell'incantatore, metà danni sul successo. La capacità viene rimossa con l'effetto.",
  "holy-weapon": "Scegli il portatore e l'arma da potenziare. L'arma diventa magica e aggiunge 2d8 radianti ai propri attacchi. Il portatore emette luce intensa per 30 ft e fioca fino a 60 ft. Detona arma sacra termina l'incantesimo e permette di scegliere le creature visibili entro 30 ft dall'arma: TS COS, 4d8 radianti, metà sul successo; accecamento sul fallimento con nuovo TS a fine turno.",
  "vampiric-touch": "Mantiene l'attacco in mischia con incantesimo per un minuto di concentrazione. Gli attacchi successivi non consumano altri slot. Cura metà del danno necrotico effettivamente inflitto, arrotondata per difetto, non il danno teorico prima delle resistenze.",
  "chaos-bolt": "Il tipo di danno viene scelto fra i risultati dei due d8. Se sono uguali, dopo il danno puoi scegliere un'altra creatura entro 30 ft dal bersaglio per un nuovo attacco. Ogni creatura può essere bersagliata una sola volta nella stessa catena; i rimbalzi non consumano altri slot."
};

function activities(identifier) {
  switch (identifier) {
    case "mirror-image": return [specialActivity("mirrorImage", {name: "Mirror Image", activation: "action", spellSlot: true, targetType: "self", range: "self", duration: "minute", durationValue: "1"})];
    case "heat-metal": return [
      specialActivity("heatMetal", {name: "Heat Metal", activation: "action", spellSlot: true, range: "ft", distance: "60", count: "", ...concentration}),
      specialActivity("heatMetalPulse", {name: "Riscalda di nuovo", activation: "bonus", hidden: true, targetType: "", count: ""}),
      specialActivity("heatMetalDamage", {name: "Heat Metal — Danno", type: "damage", hidden: true, count: "", parts: [specialDamage(2, 8, "fire", true)]}),
      specialActivity("heatMetalHeld", {name: "Heat Metal — Trattenere l'oggetto", type: "save", hidden: true, save: "con"})
    ];
    case "dragons-breath": return [specialActivity("dragonsBreath", {name: "Dragon's Breath", activation: "bonus", spellSlot: true, range: "touch", ...concentration})];
    case "holy-weapon": return [
      specialActivity("holyWeapon", {name: "Holy Weapon", activation: "bonus", spellSlot: true, range: "touch", ...concentration, duration: "hour"}),
      specialActivity("holyWeaponDismiss", {name: "Detona arma sacra", activation: "bonus", hidden: true, targetType: "", count: ""}),
      specialActivity("holyWeaponBurst", {name: "Holy Weapon — Detonazione", type: "save", hidden: true, count: "", parts: [specialDamage(4, 8, "radiant")], save: "con"})
    ];
    case "vampiric-touch": return [
      specialActivity("vampiricTouch", {name: "Vampiric Touch", activation: "action", spellSlot: true, type: "attack", range: "ft", distance: "5", parts: [specialDamage(3, 6, "necrotic", true)], ...concentration}),
      specialActivity("vampiricTouchAttack", {name: "Tocco vampirico — Attacco", activation: "action", hidden: true, type: "attack", range: "ft", distance: "5", parts: [specialDamage(3, 6, "necrotic", true)]})
    ].map(activity => ({...activity, attack: {...activity.attack, type: {value: "melee", classification: "spell"}}}));
    case "chaos-bolt": return [
      specialActivity("chaosBolt", {name: "Chaos Bolt", activation: "action", spellSlot: true, type: "attack", range: "ft", distance: "120", parts: [specialDamage(2, 8), specialDamage(1, 6, "", true)]}),
      specialActivity("chaosBoltBounce", {name: "Chaos Bolt — Rimbalzo", hidden: true, type: "attack", parts: [specialDamage(2, 8), specialDamage(1, 6, "", true)]})
    ];
    default: throw new Error(`Unknown spell ${identifier}`);
  }
}

for (const spell of SPECIAL_SPELL_CATALOG) {
  const source = sources.get(spell.source);
  if (!source) throw new Error(`Missing source: ${spell.source}`);
  const item = structuredClone(source);
  item._id = spell.id;
  item.name = spell.name;
  item.effects = [];
  item.flags = {
    cat: {automation: {source: "khuzoe-automations", version: SPECIAL_SPELL_VERSION}, macros: {roll: [{source: "khuzoe-automations", rules: "2014", identifier: spell.identifier}]}},
    "khuzoe-automations": {sourceIdentifier: spell.source, activityIdentifiers: {}},
    dnd5e: {riders: {activity: [], effect: []}}
  };
  item.system.identifier = spell.identifier;
  item.system.source = {...item.system.source, custom: "Khuzoe Automations", rules: "2014"};
  item.system.description = {value: `<p>${descriptions[spell.identifier]}</p>`, chat: ""};
  item.system.activities = {};
  for (const activity of activities(spell.identifier)) {
    activity.img = item.img;
    item.system.activities[activity._id] = activity;
    item.flags["khuzoe-automations"].activityIdentifiers[activity.midiProperties.identifier] = activity._id;
    // Core riders cannot be used even after CAT unhides them. Only internal
    // activities are riders; follow-up buttons are hidden by CAT alone.
    if (activity.midiProperties.automationOnly) item.flags.dnd5e.riders.activity.push(activity._id);
  }
  item.folder = null;
  item.sort = 0;
  item.ownership = {default: 0};
  delete item._stats;
  item._key = `!items!${item._id}`;
  await writeFile(new URL(`${spell.name.replace(/[^a-z0-9]+/gi, "_")}_${spell.id}.json`, output), `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`);
}
console.log(`Khuzoe Automations | Generati ${SPECIAL_SPELL_CATALOG.length} incantesimi speciali 2014.`);
