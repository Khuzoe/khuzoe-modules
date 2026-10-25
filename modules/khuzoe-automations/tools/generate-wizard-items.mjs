import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const automationVersion = RELEASE_VERSION;

function consumption() {
  return {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false};
}

function utilityActivity({id, name, activation = "special", hidden = false}) {
  return {
    _id: id,
    type: "utility",
    activation: {type: activation, value: activation === "bonus" || activation === "reaction" ? 1 : null, condition: "", override: true},
    consumption: consumption(),
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {value: null, units: "self", special: "", override: true},
    target: {
      prompt: false,
      template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
      affects: {count: "", type: "self", choice: false, special: ""},
      override: true
    },
    roll: {formula: "", name: "", prompt: false, visible: false},
    uses: {spent: 0, recovery: [], max: ""},
    sort: 0,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function catFlags(identifier) {
  const entry = {source: "khuzoe-automations", rules: "2014", identifier};
  return {
    automation: {source: "khuzoe-automations", version: automationVersion},
    macros: {roll: [entry]}
  };
}

function feature({id, name, identifier, img, source, level, description, uses, activities = {}}) {
  return {
    _id: id,
    name,
    type: "feat",
    img,
    system: {
      description: {value: description, chat: ""},
      source: {custom: source, book: "", page: "", license: "", rules: "2014"},
      uses: uses ?? {max: "", spent: 0, recovery: []},
      type: {value: "class", subtype: ""},
      properties: [],
      requirements: `Wizard ${level}`,
      prerequisites: {level},
      activities,
      identifier,
      enchant: {}
    },
    effects: [],
    flags: {
      "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
      midiProperties: {confirmTargets: "default", magicdam: false, magiceffect: false},
      dnd5e: {riders: {activity: Object.keys(activities), effect: []}},
      cat: catFlags(identifier)
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const items = [
  feature({
    id: "KhzWizArcRecv001",
    name: "Arcane Recovery",
    identifier: "arcane-recovery",
    img: "icons/magic/time/hourglass-brown-orange.webp",
    source: "Player's Handbook 2014",
    level: 1,
    uses: {max: "1", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]},
    description: "<p>Una volta al giorno, al termine di un riposo breve, puoi recuperare slot incantesimo spesi. La somma dei livelli degli slot recuperati non può superare metà del tuo livello da mago, arrotondato per eccesso, e nessuno slot può essere di 6° livello o superiore.</p>",
    activities: {
      KhzArcRecover001: utilityActivity({id: "KhzArcRecover001", name: "Recupera slot"})
    }
  }),
  feature({
    id: "KhzWizBladeSong1",
    name: "Bladesong",
    identifier: "bladesong",
    img: "icons/skills/melee/sword-winged-holy-orange.webp",
    source: "Tasha's Cauldron of Everything 2014",
    level: 2,
    uses: {max: "@prof", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]},
    description: "<p>Come azione bonus puoi attivare Bladesong per 1 minuto. Ottieni un bonus alla CA e ai tiri salvezza di Costituzione per mantenere concentrazione pari al modificatore di Intelligenza, +10 ft alla velocità e vantaggio alle prove di Acrobatics.</p>",
    activities: {
      KhzBladeStart001: utilityActivity({id: "KhzBladeStart001", name: "Attiva Bladesong", activation: "bonus"}),
      KhzBladeEnd00001: utilityActivity({id: "KhzBladeEnd00001", name: "Termina Bladesong"})
    }
  }),
  feature({
    id: "KhzWizSongDef001",
    name: "Song of Defense",
    identifier: "song-of-defense",
    img: "icons/magic/defensive/shield-barrier-flaming-diamond-blue.webp",
    source: "Tasha's Cauldron of Everything 2014",
    level: 10,
    description: "<p>Durante Bladesong, quando subisci danni, puoi usare la reazione e spendere uno slot incantesimo per ridurre il danno di cinque volte il livello dello slot.</p>",
    activities: {
      KhzSongDefense01: utilityActivity({id: "KhzSongDefense01", name: "Song of Defense", activation: "reaction", hidden: true})
    }
  }),
  feature({
    id: "KhzWizSongVic001",
    name: "Song of Victory",
    identifier: "song-of-victory",
    img: "icons/skills/melee/sword-stuck-glowing-pink.webp",
    source: "Tasha's Cauldron of Everything 2014",
    level: 14,
    description: "<p>Durante Bladesong aggiungi il tuo modificatore di Intelligenza ai danni degli attacchi con arma da mischia.</p>"
  })
];

await mkdir(output, {recursive: true});
for (const item of items) {
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${output}/${safeName}_${item._id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} capacità Wizard/Bladesinger in ${output}.`);
