import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const source = "khuzoe-automations";
const rules = "2014";
const version = RELEASE_VERSION;

function activity({id, name, range = 5, target = true}) {
  return {
    _id: id,
    type: "utility",
    activation: {type: "action", value: 1, condition: "", override: true},
    consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {
      value: target ? range : null,
      units: target ? "ft" : "self",
      special: "",
      override: true
    },
    target: {
      prompt: target,
      template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
      affects: {count: target ? "1" : "", type: target ? "creature" : "self", choice: false, special: ""},
      override: true
    },
    roll: {formula: "", name: "", prompt: false, visible: false},
    uses: {spent: 0, recovery: [], max: ""},
    sort: 0,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    midiProperties: {
      confirmTargets: target ? "always" : "never",
      autoTargetType: "any",
      autoTargetAction: "default",
      automationOnly: false,
      magicEffect: false,
      magicDamage: false
    },
    flags: {}
  };
}

function item({id, activityId, name, identifier, img, description, target = true}) {
  const activities = {[activityId]: activity({id: activityId, name, target})};
  return {
    _id: id,
    name,
    type: "feat",
    img,
    system: {
      description: {value: description, chat: ""},
      source: {custom: "Player's Handbook 2014", book: "", page: "", license: "", rules},
      uses: {max: "", spent: 0, recovery: []},
      type: {value: "feat", subtype: ""},
      properties: [],
      requirements: "Combat action 2014",
      prerequisites: {level: null},
      activities,
      identifier,
      enchant: {}
    },
    effects: [],
    flags: {
      "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
      midiProperties: {confirmTargets: target ? "always" : "never", magicdam: false, magiceffect: false},
      dnd5e: {riders: {activity: [], effect: []}},
      cat: {
        automation: {source, version},
        macros: {roll: [{source, rules, identifier}]}
      }
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const items = [
  item({
    id: "KhzGrapple140001",
    activityId: "KhzGrappleAct001",
    name: "Grapple",
    identifier: "grapple",
    img: "icons/magic/control/buff-strength-muscle-damage-red.webp",
    description: "<p>Quando effettui l'azione Attack puoi sostituire uno dei tuoi attacchi con un tentativo di afferrare una creatura entro portata che non sia più di una taglia più grande di te.</p><p>Effettua una prova di Atletica (FOR) contrapposta ad Atletica (FOR) o Acrobazia (DES), a scelta del bersaglio. Il difensore vince i pareggi. Se riesci, il bersaglio è <strong>Grappled</strong> e riceve automaticamente l'azione <strong>Escape Grapple</strong>.</p>"
  }),
  item({
    id: "KhzGrapEsc140001",
    activityId: "KhzGrapEscAct001",
    name: "Escape Grapple",
    identifier: "grappleEscape",
    img: "icons/environment/traps/net.webp",
    target: false,
    description: "<p>Usa la tua azione per tentare di sfuggire a un grapple. Scegli Atletica (FOR) o Acrobazia (DES) e confronta il risultato con Atletica (FOR) del grappler.</p><p>Questa azione tecnica viene aggiunta e rimossa automaticamente dall'automazione Grapple.</p>"
  }),
  item({
    id: "KhzShoveAction01",
    activityId: "KhzShoveAct00001",
    name: "Shove",
    identifier: "shove",
    img: "icons/skills/melee/unarmed-punch-fist-white.webp",
    description: "<p>Quando effettui l'azione Attack puoi sostituire uno dei tuoi attacchi con un tentativo di spingere una creatura entro portata che non sia più di una taglia più grande di te.</p><p>Effettua una prova di Atletica (FOR) contrapposta ad Atletica (FOR) o Acrobazia (DES), a scelta del bersaglio. Il difensore vince i pareggi. Se riesci, scegli se rendere il bersaglio <strong>Prone</strong> oppure spingerlo di 5 ft lontano da te.</p>"
  })
];

await mkdir(output, {recursive: true});
for (const document of items) {
  const safeName = document.name.replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${output}/${safeName}_${document._id}.json`, `${JSON.stringify(normalizeAutomationData(document), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} azioni di combattimento 2014 in ${output}.`);
