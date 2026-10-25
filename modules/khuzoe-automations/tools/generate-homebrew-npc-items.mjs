import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-npc-features-2014`;
const version = RELEASE_VERSION;

const defaults = [
  "C:/Users/delia/Downloads/fvtt-Actor-el'athel-0bAWzrEcIgyQMR5M.json",
  "C:/Users/delia/Downloads/fvtt-Actor-spirito-elementale-fatato-wVihT5hX0ZgG8Nah.json",
  "C:/Users/delia/Downloads/fvtt-Actor-na'niss-OaXe5zswrwJpxGvI.json"
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : defaults;
const definitions = new Map([
  ["naniss-p-unaura-di-energia-be", ["KhzNpcNanAura001", ["roll"]]],
  ["naniss-p-come-azione-bonus-na", ["KhzNpcNanSumm001", ["roll"]]],
  ["naniss-p-quando-una-creatura-a", ["KhzNpcNanDance01", ["roll", "save", "check", "skill"]]],
  ["naniss-p-naniss-effettua-tre", ["KhzNpcNanMulti01", ["roll"]]],
  ["colpo-purificante", ["KhzNpcNanStrike1", ["roll"]]],
  ["spirito-elementale-fatato-p-ogni-creatura-entro-1", ["KhzNpcFeyAura001", ["roll"]]],
  ["spirito-elementale-fatato-p-quando-lo-spirito-muo", ["KhzNpcFeyExpl001", ["roll"]]],
  ["spirito-elementale-fatato-p-quando-una-creatura-n", ["KhzNpcFeyProt001", ["roll"]]],
  ["spirito-elementale-fatato-p-lo-spirito-effettua-d", ["KhzNpcFeyMulti01", ["roll"]]],
  ["colpo-energico", ["KhzNpcFeyStrike1", ["roll"]]],
  ["psychic-strike-melee", ["KhzNpcElaMelee01", ["roll"]]],
  ["psychic-strike-ranged", ["KhzNpcElaRange01", ["roll"]]],
  ["brain-storm", ["KhzNpcElaBrain01", ["roll"]]],
  ["impenetrable-ego", ["KhzNpcElaEgo0001", ["save"]]],
  ["appeal-to-the-fervent", ["KhzNpcElaAppeal1", ["roll"]]]
]);

function activitiesOf(item) {
  const activities = item?.system?.activities;
  if (!activities) return [];
  if (Array.isArray(activities)) return activities;
  return Object.values(activities);
}

function normalizeActivityData(identifier, item) {
  const activities = activitiesOf(item);
  if (identifier === "naniss-p-quando-una-creatura-a") {
    for (const activity of activities) {
      activity.activation = {
        ...(activity.activation ?? {}),
        type: "special",
        value: null,
        override: true
      };
    }
  }

  if (["psychic-strike-melee", "psychic-strike-ranged"].includes(identifier)) {
    const ranged = identifier === "psychic-strike-ranged";
    item.system.range = {...(item.system.range ?? {}), value: ranged ? 60 : 5, units: "ft"};
    for (const activity of activities) {
      activity.attack ??= {};
      activity.attack.type = {value: ranged ? "ranged" : "melee", classification: "spell"};
      activity.range = {...(activity.range ?? {}), value: String(ranged ? 60 : 5), units: "ft", override: true};
    }
  }

  if (identifier === "brain-storm") {
    for (const activity of activities) {
      for (const part of Object.values(activity.damage?.parts ?? {})) part.bonus = "";
      // L'effetto Avvelenato persistente e i relativi TS ripetuti sono gestiti
      // dal macro runtime; il riferimento dnd5e esportato creerebbe un secondo
      // effetto non collegato all'automazione Khuzoe.
      activity.effects = [];
    }
  }
}

const actors = await Promise.all(files.map(async file => JSON.parse(await readFile(file, "utf8"))));
const found = new Map();
for (const actor of actors) {
  for (const item of actor.items ?? []) {
    const identifier = item.system?.identifier;
    if (!definitions.has(identifier)) continue;
    if (identifier === "multiattack" && actor.name !== "El'Athel") continue;
    found.set(identifier, item);
  }
}

const missing = Array.from(definitions.keys()).filter(identifier => !found.has(identifier));
if (missing.length) throw new Error(`Capacità non trovate negli export: ${missing.join(", ")}`);

await mkdir(output, {recursive: true});
for (const [identifier, [id, macroTypes]] of definitions) {
  if (!/^[A-Za-z0-9]{16}$/.test(id)) throw new Error(`ID Foundry non valido: ${id}`);
  const item = structuredClone(found.get(identifier));
  item._id = id;
  item.system.source ??= {};
  item.system.source.rules = "2014";
  normalizeActivityData(identifier, item);
  item.ownership = {default: 0};
  item.folder = null;
  item.sort = 0;
  // Il compendio è una sorgente di automazione: gli effetti correnti
  // dell'export restano sull'Actor e vengono preservati dal preUpdate.
  item.effects = [];
  item.flags = {
    cat: {
      automation: {source: "khuzoe-automations", version},
      macros: Object.fromEntries(macroTypes.map(type => [type, [{
        source: "khuzoe-automations",
        rules: "2014",
        identifier
      }]]))
    }
  };
  delete item._stats;
  item._key = `!items!${id}`;
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${output}/${safeName}_${id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${found.size} capacità NPC in ${output}. Bend the Spoon esclusa.`);
