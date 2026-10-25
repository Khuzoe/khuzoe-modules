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

function utilityActivity({id, name, activation = "special", hidden = false, sort = 0}) {
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
    sort,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function catFlags(identifier, hasMacro) {
  const flags = {
    automation: {source: "khuzoe-automations", version: automationVersion}
  };
  if (hasMacro) {
    flags.macros = {
      roll: [{source: "khuzoe-automations", rules: "2014", identifier}]
    };
  }
  return flags;
}

function passiveEffect({id, name, img, key, value = "1"}) {
  return {
    _id: id,
    name,
    img,
    type: "base",
    system: {
      changes: [{key, value, priority: 20, type: "override"}]
    },
    disabled: false,
    duration: {value: null, units: "seconds", expired: false},
    origin: null,
    tint: "#ffffff",
    transfer: true,
    statuses: [],
    description: "",
    showIcon: 0,
    flags: {
      core: {overlay: false},
      dae: {
        transfer: true,
        stackable: "noneNameOnly",
        specialDuration: [],
        expiryMode: "delete",
        disableIncapacitated: false
      }
    },
    folder: null
  };
}

function feature({id, name, identifier, img, level, description, activities = {}, effects = [], hasMacro = false}) {
  effects = effects.map(effect => ({
    ...effect,
    _key: `!items.effects!${id}.${effect._id}`
  }));
  return {
    _id: id,
    name,
    type: "feat",
    img,
    system: {
      description: {value: description, chat: ""},
      source: {custom: "Player's Handbook 2014", book: "", page: "", license: "", rules: "2014"},
      uses: {max: "", spent: 0, recovery: []},
      type: {value: "class", subtype: ""},
      properties: [],
      requirements: `Rogue ${level}`,
      prerequisites: {level},
      activities,
      identifier,
      enchant: {}
    },
    effects,
    flags: {
      "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
      midiProperties: {confirmTargets: "default", magicdam: false, magiceffect: false},
      dnd5e: {riders: {activity: Object.keys(activities), effect: effects.map(effect => effect._id)}},
      cat: catFlags(identifier, hasMacro)
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const items = [
  feature({
    id: "KhzRogSneakAtk01",
    name: "Sneak Attack",
    identifier: "sneak-attack",
    img: "icons/skills/melee/strike-dagger-blood-red.webp",
    level: 1,
    hasMacro: true,
    description: "<p>Una volta per turno puoi infliggere danni extra quando colpisci con un attacco con arma a distanza o con un'arma finesse. Devi avere vantaggio, oppure un altro nemico del bersaglio deve trovarsi entro 5 ft da esso e non devi avere svantaggio.</p><p>L'automazione propone l'uso solo quando le condizioni sono soddisfatte e ricava i dadi dalla scala di Sneak Attack del Ladro.</p>"
  }),
  feature({
    id: "KhzRogCunning001",
    name: "Cunning Action",
    identifier: "cunning-action",
    img: "icons/skills/movement/feet-winged-boots-brown.webp",
    level: 2,
    description: "<p>Puoi effettuare Dash, Disengage o Hide come azione bonus in ciascun tuo turno. Le tre attività sono separate per poterle usare direttamente dalla scheda o dalla barra rapida.</p>",
    activities: {
      KhzRogDashAct001: utilityActivity({id: "KhzRogDashAct001", name: "Cunning Action: Dash", activation: "bonus"}),
      KhzRogDisengage1: utilityActivity({id: "KhzRogDisengage1", name: "Cunning Action: Disengage", activation: "bonus", sort: 100000}),
      KhzRogHideAct001: utilityActivity({id: "KhzRogHideAct001", name: "Cunning Action: Hide", activation: "bonus", sort: 200000})
    }
  }),
  feature({
    id: "KhzRogUncanny001",
    name: "Uncanny Dodge",
    identifier: "uncanny-dodge",
    img: "icons/skills/movement/figure-running-gray.webp",
    level: 5,
    hasMacro: true,
    description: "<p>Quando un attaccante che puoi vedere ti colpisce con un attacco, puoi usare la reazione per dimezzare i danni dell'attacco contro di te.</p>",
    activities: {
      KhzRogUncanAct01: utilityActivity({id: "KhzRogUncanAct01", name: "Uncanny Dodge", activation: "reaction", hidden: true})
    }
  }),
  feature({
    id: "KhzRogEvasion001",
    name: "Evasion",
    identifier: "evasion",
    img: "icons/magic/defensive/illusion-evasion-echo-purple.webp",
    level: 7,
    description: "<p>Quando un effetto ti consente un tiro salvezza di Destrezza per dimezzare i danni, non subisci danni se riesci e subisci soltanto metà danni se fallisci.</p>",
    effects: [passiveEffect({
      id: "KhzRogEvasionEf1",
      name: "Evasion",
      img: "icons/magic/defensive/illusion-evasion-echo-purple.webp",
      key: "flags.midi-qol.superSaver.dex",
      value: "activity.damage.onSave === 'half'"
    })]
  }),
  feature({
    id: "KhzRogReliable01",
    name: "Reliable Talent",
    identifier: "reliable-talent",
    img: "icons/skills/trades/academics-investigation-puzzles.webp",
    level: 11,
    description: "<p>Quando effettui una prova di caratteristica che include il tuo bonus di competenza, tratti un risultato naturale del d20 inferiore a 10 come se fosse 10.</p><p>L'effetto usa direttamente la gestione di Reliable Talent del sistema D&D5e.</p>",
    effects: [passiveEffect({
      id: "KhzRogReliabEf01",
      name: "Reliable Talent",
      img: "icons/skills/trades/academics-investigation-puzzles.webp",
      key: "flags.dnd5e.reliableTalent"
    })]
  })
];

await mkdir(output, {recursive: true});
for (const item of items) {
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${output}/${safeName}_${item._id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} capacità Rogue in ${output}.`);
