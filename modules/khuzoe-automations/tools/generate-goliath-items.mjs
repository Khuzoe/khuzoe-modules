import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const id = "KhzStoneEndur001";
const activityId = "KhzStoneEndAct01";
const identifier = "stones-endurance";
const img = "icons/magic/defensive/armor-stone-skin.webp";

const item = {
  _id: id,
  name: "Stone's Endurance",
  type: "feat",
  img,
  system: {
    description: {
      value: "<p>Quando subisci danni, puoi usare la tua reazione per tirare 1d12 e aggiungere il tuo modificatore di Costituzione. Riduci i danni di quel totale.</p><p>Dopo aver usato questa capacità, devi completare un riposo breve o lungo prima di poterla usare di nuovo.</p>",
      chat: ""
    },
    source: {custom: "Volo's Guide to Monsters", book: "", page: "", license: "", rules: "2014"},
    uses: {max: "1", spent: 0, recovery: [{period: "sr", type: "recoverAll"}]},
    type: {value: "race", subtype: ""},
    properties: [],
    requirements: "Goliath",
    prerequisites: {level: null},
    activities: {
      [activityId]: {
        _id: activityId,
        type: "utility",
        activation: {type: "reaction", value: 1, condition: "Quando subisci danni", override: true},
        consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
        description: {chatFlavor: "Stone's Endurance"},
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
        name: "Stone's Endurance",
        img: "",
        visibility: {level: {min: null, max: null}},
        flags: {cat: {hidden: true}}
      }
    },
    identifier,
    enchant: {}
  },
  effects: [],
  flags: {
    "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
    midiProperties: {confirmTargets: "default", magicdam: false, magiceffect: false},
    dnd5e: {riders: {activity: [activityId], effect: []}},
    cat: {
      automation: {source: "khuzoe-automations", version: RELEASE_VERSION},
      macros: {roll: [{source: "khuzoe-automations", rules: "2014", identifier}]}
    }
  },
  folder: null,
  sort: 0,
  ownership: {default: 0},
  _key: `!items!${id}`
};

await mkdir(output, {recursive: true});
await writeFile(`${output}/Stones_Endurance_${id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
console.log(`Generata Stone's Endurance in ${output}.`);
