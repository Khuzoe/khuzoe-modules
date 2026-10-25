import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const automationVersion = RELEASE_VERSION;
const configureActivityId = "KhzDmgBondCfg001";
const transferActivityId = "KhzDmgBondDmg001";

function consumption() {
  return {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false};
}

function target(type, count = "") {
  return {
    prompt: false,
    template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
    affects: {count, type, choice: false, special: ""},
    override: true
  };
}

function baseActivity({id, type, name, sort, targetType, targetCount = ""}) {
  return {
    _id: id,
    type,
    activation: {type: "special", value: null, condition: "", override: true},
    consumption: consumption(),
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {value: null, units: type === "utility" ? "self" : "any", special: "", override: true},
    target: target(targetType, targetCount),
    uses: {spent: 0, recovery: [], max: ""},
    sort,
    name,
    img: "",
    visibility: {level: {min: null, max: null}}
  };
}

function configureActivity() {
  return {
    ...baseActivity({
      id: configureActivityId,
      type: "utility",
      name: "Configura legami",
      sort: 0,
      targetType: "self"
    }),
    roll: {formula: "", name: "", prompt: false, visible: false},
    midiProperties: {
      confirmTargets: "never",
      autoTargetType: "any",
      autoTargetAction: "default",
      automationOnly: false,
      magicEffect: false,
      magicDamage: false
    },
    flags: {}
  };
}

function transferActivity() {
  return {
    ...baseActivity({
      id: transferActivityId,
      type: "damage",
      name: "Danno trasferito",
      sort: 100000,
      targetType: "creature",
      targetCount: "1"
    }),
    damage: {
      critical: {allow: false},
      parts: [{
        custom: {enabled: true, formula: "1"},
        number: null,
        denomination: 0,
        bonus: "",
        types: ["force"],
        scaling: {mode: "", number: null, formula: ""}
      }]
    },
    midiProperties: {
      identifier: "khuzoe-damage-bond-transfer",
      confirmTargets: "never",
      forceDamageDialog: "never",
      autoTargetType: "any",
      autoTargetAction: "default",
      automationOnly: true,
      magicEffect: false,
      magicDamage: false,
      ignoreTraits: ["idi", "idr", "idv", "ida", "idm"]
    },
    flags: {cat: {hidden: true}}
  };
}

function feature({id, name, identifier, description}) {
  const activities = {
    [configureActivityId]: configureActivity(),
    [transferActivityId]: transferActivity()
  };
  return {
    _id: id,
    name,
    type: "feat",
    img: identifier.endsWith("once-per-turn")
      ? "icons/magic/control/energy-stream-link-spiral-blue.webp"
      : "icons/magic/control/energy-stream-link-spiral-white.webp",
    system: {
      description: {value: description, chat: ""},
      source: {custom: "Khuzoe Homebrew", book: "", page: "", license: "", rules: "2014"},
      uses: {max: "", spent: 0, recovery: []},
      type: {value: "class", subtype: ""},
      properties: [],
      requirements: "",
      prerequisites: {level: null},
      activities,
      identifier,
      enchant: {}
    },
    effects: [],
    flags: {
      "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
      midiProperties: {confirmTargets: "never", magicdam: false, magiceffect: false},
      dnd5e: {riders: {activity: [transferActivityId], effect: []}},
      cat: {
        automation: {source: "khuzoe-automations", version: automationVersion},
        macros: {
          roll: [{source: "khuzoe-automations", rules: "2014", identifier}]
        }
      }
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const items = [
  feature({
    id: "KhzDmgBondAlways",
    name: "Legame del Danno",
    identifier: "damage-bond",
    description: "<p>Crei un legame con uno o più alleati. Ogni volta che stai per subire danni puoi scegliere un singolo alleato collegato: tu subisci la metà arrotondata per eccesso e l'alleato la metà arrotondata per difetto.</p><p>Usa <strong>Configura legami</strong> o il pulsante nel Medkit per scegliere gli alleati. Il danno trasferito è calcolato dopo le tue normali resistenze e riduzioni.</p>"
  }),
  feature({
    id: "KhzDmgBondTurn01",
    name: "Legame del Danno (una volta per turno)",
    identifier: "damage-bond-once-per-turn",
    description: "<p>Crei un legame con uno o più alleati. Quando stai per subire danni puoi scegliere un singolo alleato collegato e dividere con lui il danno finale.</p><p>Dopo un trasferimento riuscito non puoi usare nuovamente questa capacità fino al turno successivo. Il limite è condiviso fra tutti i legami.</p><p>Usa <strong>Configura legami</strong> o il pulsante nel Medkit per scegliere gli alleati.</p>"
  })
];

for (const value of [configureActivityId, transferActivityId, ...items.map(item => item._id)]) {
  if (!/^[A-Za-z0-9]{16}$/.test(value)) throw new Error(`ID Foundry non valido: ${value}`);
}

await mkdir(output, {recursive: true});
for (const item of items) {
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${output}/${safeName}_${item._id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} capacità Legame del Danno in ${output}.`);
