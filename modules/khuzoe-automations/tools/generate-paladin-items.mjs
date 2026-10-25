import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const source = "Player's Handbook 2014";
const automationVersion = RELEASE_VERSION;
const auraDistanceFlag = "khuzoePaladinAuraDistance";

function creatureTarget() {
  return {
    prompt: false,
    template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
    affects: {count: "1", type: "creature", choice: false, special: ""},
    override: true
  };
}

function consumption() {
  return {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false};
}

function utilityActivity({id, name, hidden = false}) {
  return {
    _id: id,
    type: "utility",
    activation: {type: "action", value: 1, condition: "", override: true},
    consumption: consumption(),
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {value: null, units: "touch", special: "", override: true},
    target: creatureTarget(),
    roll: {formula: "", name: "", prompt: false, visible: false},
    uses: {spent: 0, recovery: [], max: ""},
    sort: 0,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function healingActivity({id, name}) {
  return {
    _id: id,
    type: "heal",
    activation: {type: "special", value: null, condition: "Gestita da Lay on Hands.", override: true},
    consumption: consumption(),
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {value: null, units: "touch", special: "", override: true},
    target: creatureTarget(),
    healing: {
      number: null,
      denomination: 0,
      types: ["healing"],
      custom: {enabled: true, formula: "1"},
      scaling: {number: null, mode: "", formula: ""},
      bonus: ""
    },
    uses: {spent: 0, recovery: [], max: ""},
    sort: 100000,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: {cat: {hidden: true}}
  };
}

function holyNimbusActivity() {
  const activity = utilityActivity({id: "KhzHolyNimbus001", name: "Holy Nimbus"});
  activity.consumption.targets = [{type: "itemUses", value: "1", target: "", scaling: {}}];
  activity.duration = {value: "1", units: "minute", concentration: false, override: true};
  activity.range = {value: null, units: "self", special: "", override: true};
  activity.target = {
    prompt: false,
    template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
    affects: {count: "", type: "self", choice: false, special: ""},
    override: true
  };
  return activity;
}

function holyNimbusDamageActivity() {
  return {
    _id: "KhzHolyDamage001",
    type: "damage",
    activation: {type: "special", value: null, condition: "Nemico che inizia il turno nella luce intensa.", override: true},
    consumption: consumption(),
    description: {chatFlavor: "Holy Nimbus: danno"},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: {value: null, units: "any", special: "", override: true},
    target: creatureTarget(),
    damage: {
      critical: {allow: false},
      parts: [{
        custom: {enabled: true, formula: "10"},
        number: null,
        denomination: 0,
        bonus: "",
        types: ["radiant"],
        scaling: {mode: "", number: null, formula: ""}
      }]
    },
    uses: {spent: 0, recovery: [], max: ""},
    sort: 100000,
    name: "Holy Nimbus: danno",
    img: "",
    visibility: {level: {min: null, max: null}},
    midiProperties: {
      confirmTargets: "never",
      autoTargetType: "any",
      autoTargetAction: "default",
      automationOnly: true,
      magicEffect: true,
      magicDamage: true
    },
    flags: {cat: {hidden: true}}
  };
}

function catFlags(identifier, macroTypes = [], {aura = false} = {}) {
  const entry = {source: "khuzoe-automations", rules: "2014", identifier};
  return {
    automation: {source: "khuzoe-automations", version: automationVersion},
    ...(macroTypes.length ? {macros: Object.fromEntries(macroTypes.map(type => [type, [entry]]))} : {}),
    ...(aura ? {config: {[auraDistanceFlag]: 10}} : {})
  };
}

function feature({id, name, identifier, img, level, description, uses, activities = {}, macroTypes = [], aura = false}) {
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
      requirements: `Paladin ${level}`,
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
      cat: catFlags(identifier, macroTypes, {aura})
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const items = [
  feature({
    id: "KhzPalLayHands01",
    name: "Lay on Hands",
    identifier: "lay-on-hands",
    img: "icons/magic/light/explosion-star-glow-silhouette.webp",
    level: 1,
    uses: {max: "5", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]},
    description: "<p>Possiedi una riserva di potere curativo pari a cinque volte il tuo livello da Paladino, recuperata dopo un riposo lungo.</p><p>Come azione puoi toccare una creatura e spendere punti della riserva per ripristinare altrettanti punti ferita. In alternativa puoi spendere 5 punti per curare una malattia o neutralizzare un veleno. La capacità non ha effetto su costrutti e non morti.</p>",
    activities: {
      KhzLayHealUse001: utilityActivity({id: "KhzLayHealUse001", name: "Lay on Hands: cura"}),
      KhzLayCurePois01: utilityActivity({id: "KhzLayCurePois01", name: "Lay on Hands: neutralizza veleno"}),
      KhzLayCureDise01: utilityActivity({id: "KhzLayCureDise01", name: "Lay on Hands: cura malattia"}),
      KhzLayTechHeal01: healingActivity({id: "KhzLayTechHeal01", name: "Lay on Hands: guarigione"})
    },
    macroTypes: ["roll"]
  }),
  feature({
    id: "KhzPalDivSmite01",
    name: "Divine Smite",
    identifier: "divine-smite",
    img: "icons/magic/holy/projectiles-blades-salvo-yellow.webp",
    level: 2,
    description: "<p>Quando colpisci una creatura con un attacco con arma da mischia, puoi spendere uno slot incantesimo per infliggere danni radianti aggiuntivi. Il danno è 2d8 per uno slot di 1° livello, più 1d8 per ogni livello superiore, fino a 5d8. Contro immondi e non morti infliggi 1d8 aggiuntivo.</p>",
    macroTypes: ["roll"]
  }),
  feature({
    id: "KhzPalAuraProt01",
    name: "Aura of Protection",
    identifier: "aura-of-protection",
    img: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
    level: 6,
    description: "<p>Finché sei cosciente, tu e le creature amiche entro 10 ft ottenete ai tiri salvezza un bonus pari al tuo modificatore di Carisma, con un minimo di +1. Al 18° livello da Paladino il raggio aumenta a 30 ft.</p>",
    aura: true
  }),
  feature({
    id: "KhzPalAuraCour01",
    name: "Aura of Courage",
    identifier: "aura-of-courage",
    img: "icons/magic/holy/barrier-shield-winged-blue.webp",
    level: 10,
    description: "<p>Finché sei cosciente, tu e le creature amiche entro 10 ft non potete essere frightened. Al 18° livello da Paladino il raggio aumenta a 30 ft.</p>",
    aura: true
  }),
  feature({
    id: "KhzPalHolyNimb01",
    name: "Holy Nimbus",
    identifier: "holy-nimbus",
    img: "icons/magic/light/explosion-star-large-blue-yellow.webp",
    level: 20,
    uses: {max: "1", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]},
    description: "<p>Come azione emani un'aura di luce solare per 1 minuto. Da te si propaga luce intensa entro 30 ft e luce fioca per altri 30 ft.</p><p>Ogni creatura nemica che inizia il proprio turno nella luce intensa subisce 10 danni radianti. Per la durata hai vantaggio ai tiri salvezza contro gli incantesimi lanciati da immondi o non morti.</p><p>Dopo l'uso devi completare un riposo lungo prima di poter usare nuovamente questa capacità.</p>",
    activities: {
      KhzHolyNimbus001: holyNimbusActivity(),
      KhzHolyDamage001: holyNimbusDamageActivity()
    },
    macroTypes: ["roll"]
  })
];

await mkdir(output, {recursive: true});
for (const item of items) {
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  const path = `${output}/${safeName}_${item._id}.json`;
  await writeFile(path, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} capacità Paladino in ${output}.`);
