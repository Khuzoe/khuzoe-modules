import {mkdir, writeFile} from "node:fs/promises";
import {ARMORER_AUTOMATIONS} from "../scripts/armorer.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
globalThis.Hooks ??= {on() {}, once() {}};
const {ARCANE_WARD_AUTOMATION} = await import("../scripts/arcane-ward.mjs");
const MODULE = "khuzoe-automations";
const directory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
await mkdir(directory, {recursive: true});
const images = {ward: "icons/magic/defensive/shield-barrier-glowing-triangle-blue.webp", armor: "icons/equipment/chest/breastplate-layered-steel.webp",
  model: "icons/equipment/chest/breastplate-layered-steel.webp", gauntlets: "icons/equipment/hand/gauntlet-armored-blue.webp",
  field: "icons/magic/defensive/shield-barrier-glowing-triangle-blue.webp", launcher: "icons/magic/lightning/bolt-blue.webp",
  steps: "icons/equipment/feet/boots-armored-steel.webp", dampening: "icons/magic/perception/silhouette-stealth-shadow.webp"};
function activity(id, name, activation) {
  return {_id: id, name, type: "utility", activation: {type: activation, value: activation === "special" ? null : 1, override: true},
    consumption: {targets: [], scaling: {allowed: false}, spellSlot: false},
    duration: {units: "inst", concentration: false, override: true}, effects: [],
    range: {units: "self", override: true}, target: {override: true, prompt: false, affects: {type: "self"}, template: {units: "ft"}},
    roll: {formula: "", prompt: false, visible: false}, midiProperties: {confirmTargets: "never"}, uses: {max: "", spent: 0, recovery: []}};
}
const part = (die, type, bonus = "") => ({number: 1, denomination: die, bonus, types: [type], custom: {enabled: false, formula: ""}, scaling: {mode: "", number: 1}});
for (const definition of [{...ARCANE_WARD_AUTOMATION, key: "ward"}, ...ARMORER_AUTOMATIONS]) {
  const {key, type, name, identifier} = definition;
  const id = definition.uuid.split(".").at(-1);
  const activities = {};
  if (["armor", "model", "field"].includes(key)) {
    const a = activity("KhzArmorerUse001", name, key === "armor" ? "action" : key === "field" ? "bonus" : "special");
    activities[a._id] = a;
  } else if (["gauntlets", "launcher"].includes(key)) {
    const a = activity("KhzArmorerAtk001", name, "action"), launcher = key === "launcher";
    a.type = "attack";
    delete a.roll;
    a.attack = {ability: "int", bonus: "", flat: false, critical: {threshold: null}, type: {value: launcher ? "ranged" : "melee", classification: "weapon"}};
    a.damage = {critical: {bonus: ""}, includeBase: type === "weapon", parts: type === "weapon" ? [] : [part(launcher ? 6 : 8, launcher ? "lightning" : "thunder", "@mod")]};
    // Weapon range (including its long range) is inherited from the Item.
    // The feat copy receives the same derived long range at prepareFinalData.
    a.range = {override: type !== "weapon", units: "ft", value: launcher ? "90" : "5"};
    a.target = {override: true, prompt: true, affects: {type: "creature", count: "1"}, template: {units: "ft"}};
    activities[a._id] = a;
  }
  const groups = key === "model" ? ["roll", "skill"] : ["steps", "dampening"].includes(key) ? [] : ["roll"];
  const item = {_id: id, _key: `!items!${id}`, name, type, img: images[key],
    system: {identifier, source: {rules: "2014", custom: "Khuzoe Automations — regole 2014"},
      description: {value: `<p>${definition.notes}</p>` + (key === "ward" ? "<p>Massimo PF: due volte il livello da mago più il modificatore di Intelligenza. Quando lanci un incantesimo di abiurazione di livello 1 o superiore puoi creare la protezione fino al prossimo riposo lungo. Gli incantesimi successivi le restituiscono due PF per livello di lancio, senza superare il massimo. La protezione resta presente anche a zero PF e non concede PF temporanei.</p>" : ""), chat: ""},
      type: {value: type === "weapon" ? key === "launcher" ? "simpleR" : "simpleM" : "class"}, activities,
      uses: key === "ward" ? {max: "max(0, 2 * @classes.wizard.levels + @abilities.int.mod)", spent: 0, recovery: []}
        : key === "field" ? {max: "@prof", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]} : {max: "", spent: 0, recovery: []},
      properties: [], requirements: key === "ward" ? "School of Abjuration 2" : "Armorer 3"},
    effects: [], folder: null, sort: 0, ownership: {default: 0},
    flags: {cat: {automation: {source: MODULE, version: definition.version}, macros: Object.fromEntries(groups.map(group => [group, [{source: MODULE, rules: "2014", identifier}]]))},
      [MODULE]: {armorerFeature: key}, "midi-qol": {forceCEOff: true}}
  };
  if (type === "weapon") Object.assign(item.system, {damage: {base: part(key === "launcher" ? 6 : 8, key === "launcher" ? "lightning" : "thunder")},
    range: {value: key === "launcher" ? 90 : 5, long: key === "launcher" ? 300 : null, units: "ft"}, proficient: 1,
    equipped: true, quantity: 1, magicalBonus: "", weight: {value: 0, units: "lb"}});
  await writeFile(new URL(`${name.replace(/\W+/g, "_")}_${id}.json`, directory), JSON.stringify(normalizeAutomationData(item), null, 2) + "\n");
}
console.log("Generati Arcane Ward e Armorer (10 documenti), senza accesso ai mondi.");
