import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const output = `${moduleRoot}/packData/khuzoe-class-features-2014`;
const source = "Tasha's Cauldron of Everything";
const automationVersion = RELEASE_VERSION;

function selfTarget() {
  return {
    prompt: false,
    template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
    affects: {count: "", type: "self", choice: false, special: ""},
    override: true
  };
}

function creatureTarget() {
  return {
    prompt: false,
    template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
    affects: {count: "1", type: "creature", choice: false, special: ""},
    override: true
  };
}

function consumption({consume = false} = {}) {
  return {
    targets: consume ? [{type: "itemUses", target: "", value: "1", scaling: {mode: "", formula: ""}}] : [],
    scaling: {allowed: false, max: ""},
    spellSlot: false
  };
}

function utilityActivity({id, name, activation = "bonus", duration = {}, range = "self", target = selfTarget(), hidden = false, consume = false}) {
  return {
    _id: id,
    type: "utility",
    activation: {type: activation, value: 1, condition: "", override: true},
    consumption: consumption({consume}),
    description: {chatFlavor: name},
    duration: {value: duration.value ?? "", units: duration.units ?? "inst", concentration: false, override: true},
    effects: [],
    range: range === "self"
      ? {value: null, units: "self", special: "", override: true}
      : {value: String(range), units: "ft", special: "", override: true},
    target,
    roll: {formula: "", name: "", prompt: false, visible: false},
    uses: {spent: 0, recovery: [], max: ""},
    sort: 0,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function saveActivity({id, name, ability, range, hidden = false, activation = "reaction"}) {
  return {
    _id: id,
    type: "save",
    activation: {type: activation, value: activation === "special" ? null : 1, condition: "", override: true},
    consumption: consumption(),
    description: {chatFlavor: name},
    duration: {value: "", units: "inst", concentration: false, override: true},
    effects: [],
    range: range === "any"
      ? {value: null, units: "any", special: "", override: true}
      : {value: String(range), units: "ft", special: "", override: true},
    target: creatureTarget(),
    damage: {onSave: "none", parts: [], critical: {allow: false}},
    save: {ability: [ability], dc: {calculation: "con", formula: ""}},
    uses: {spent: 0, recovery: [], max: ""},
    sort: 0,
    name,
    img: "",
    visibility: {level: {min: null, max: null}},
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function catFlags(identifier, macroTypes = []) {
  const entry = {source: "khuzoe-automations", rules: "2014", identifier};
  return {
    automation: {source: "khuzoe-automations", version: automationVersion},
    ...(macroTypes.length ? {macros: Object.fromEntries(macroTypes.map(type => [type, [entry]]))} : {})
  };
}

function baseEffect({id, name, img, changes, disableIncapacitated = false}) {
  return {
    _id: id,
    name,
    img,
    type: "base",
    system: {changes},
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
      dae: {transfer: true, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete", disableIncapacitated}
    },
    folder: null,
    sort: 0,
    _key: `!items.effects!${id}`
  };
}

function feature({id, name, identifier, img, level, description, uses, activities = {}, effects = [], macroTypes = []}) {
  effects = effects.map(effect => ({...effect, _key: `!items.effects!${id}.${effect._id}`}));
  const riderActivities = Object.values(activities)
    .filter(activity => activity.flags?.cat?.hidden)
    .map(activity => activity._id);
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
      requirements: `Rune Knight ${level}`,
      prerequisites: {level},
      activities,
      identifier,
      enchant: {}
    },
    effects,
    flags: {
      "midi-qol": {removeAttackDamageButtons: "default", forceCEOff: true},
      midiProperties: {confirmTargets: "default", magicdam: false, magiceffect: false},
      dnd5e: {riders: {activity: riderActivities, effect: []}},
      cat: catFlags(identifier, macroTypes)
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const runeUses = () => ({max: "1", spent: 0, recovery: [{period: "sr", type: "recoverAll"}]});
const longRestProfUses = () => ({max: "@prof", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]});

const items = [
  feature({
    id: "KhzRKGiantMight1",
    name: "Giant's Might",
    identifier: "giants-might",
    img: "icons/magic/control/buff-strength-muscle-damage-orange.webp",
    level: 3,
    uses: longRestProfUses(),
    description: "<p>Come azione bonus assumi la potenza dei giganti per 1 minuto. Se sei più piccolo di Large diventi Large, ottieni vantaggio alle prove e ai tiri salvezza di Forza e, una volta per turno, un attacco con arma o colpo senz'armi infligge 1d6 danni extra.</p><p>Great Stature porta il dado a d8. Runic Juggernaut permette di diventare Huge, porta il dado a d10 e aumenta di 5 ft la portata in mischia.</p>",
    activities: {
      KhzRKGiantUse001: utilityActivity({id: "KhzRKGiantUse001", name: "Giant's Might", activation: "bonus", duration: {value: "1", units: "minute"}, consume: true})
    },
    macroTypes: ["roll"]
  }),
  feature({
    id: "KhzRKCloudRune01",
    name: "Cloud Rune",
    identifier: "cloud-rune",
    img: "icons/commodities/treasure/token-runed-fehu-gold.webp",
    level: 3,
    uses: runeUses(),
    description: "<p>Hai vantaggio alle prove di Deception e Sleight of Hand.</p><p>Quando tu o una creatura che puoi vedere entro 30 ft viene colpita da un attacco, puoi usare la reazione per trasferire l'attacco a una creatura diversa entro 30 ft da te, usando lo stesso tiro.</p>",
    activities: {
      KhzRKCloudUse001: utilityActivity({id: "KhzRKCloudUse001", name: "Cloud Rune: trasferimento", activation: "reaction", range: 30, target: creatureTarget(), hidden: true})
    },
    macroTypes: ["roll", "skill"]
  }),
  feature({
    id: "KhzRKFireRune001",
    name: "Fire Rune",
    identifier: "fire-rune",
    img: "icons/commodities/treasure/token-runed-circles-red.webp",
    level: 3,
    uses: runeUses(),
    description: "<p>Il bonus di competenza è raddoppiato per le prove con strumenti in cui sei competente.</p><p>Quando colpisci con un attacco con arma, puoi invocare la runa: infliggi 2d6 danni da fuoco extra. Il bersaglio effettua un TS Forza contro la tua CD runica; con un fallimento è restrained per 1 minuto, subisce 2d6 fuoco all'inizio di ogni turno e ripete il TS alla fine del turno.</p>",
    activities: {
      KhzRKFireSave001: saveActivity({id: "KhzRKFireSave001", name: "Fire Rune: ceppi infuocati", ability: "str", range: "any", hidden: true, activation: "special"})
    },
    macroTypes: ["roll", "tool"]
  }),
  feature({
    id: "KhzRKFrostRune01",
    name: "Frost Rune",
    identifier: "frost-rune",
    img: "icons/commodities/treasure/token-engraved-spiral-grey.webp",
    level: 3,
    uses: runeUses(),
    description: "<p>Hai vantaggio alle prove di Animal Handling e Intimidation.</p><p>Come azione bonus puoi ottenere +2 alle prove di caratteristica e ai tiri salvezza di Forza e Costituzione per 10 minuti.</p>",
    activities: {
      KhzRKFrostUse001: utilityActivity({id: "KhzRKFrostUse001", name: "Frost Rune", activation: "bonus", duration: {value: "10", units: "minute"}})
    },
    macroTypes: ["roll", "skill"]
  }),
  feature({
    id: "KhzRKHillRune001",
    name: "Hill Rune",
    identifier: "hill-rune",
    img: "icons/commodities/treasure/token-runed-os-grey.webp",
    level: 7,
    uses: runeUses(),
    description: "<p>Hai resistenza ai danni da veleno e vantaggio ai tiri salvezza contro l'avvelenamento.</p><p>Come azione bonus puoi ottenere per 1 minuto resistenza ai danni contundenti, perforanti e taglienti.</p>",
    activities: {
      KhzRKHillUse0001: utilityActivity({id: "KhzRKHillUse0001", name: "Hill Rune", activation: "bonus", duration: {value: "1", units: "minute"}})
    },
    effects: [baseEffect({
      id: "KhzRKHillPass001",
      name: "Hill Rune: resistenza al veleno",
      img: "icons/commodities/treasure/token-runed-os-grey.webp",
      changes: [{key: "system.traits.dr.value", value: "poison", priority: 20, type: "add"}]
    })],
    macroTypes: ["roll", "save"]
  }),
  feature({
    id: "KhzRKStoneRune01",
    name: "Stone Rune",
    identifier: "stone-rune",
    img: "icons/commodities/treasure/token-runed-spiral-grey.webp",
    level: 3,
    uses: runeUses(),
    description: "<p>Hai vantaggio alle prove di Insight e scurovisione fino a 120 ft.</p><p>Quando una creatura che puoi vedere termina il turno entro 30 ft, puoi usare la reazione. Fallendo un TS Saggezza contro la tua CD runica, è charmed, incapacitated e con velocità 0 per 1 minuto; ripete il TS alla fine di ogni turno.</p>",
    activities: {
      KhzRKStoneUse001: saveActivity({id: "KhzRKStoneUse001", name: "Stone Rune: sguardo onirico", ability: "wis", range: 30, hidden: true})
    },
    effects: [baseEffect({
      id: "KhzRKStonePass01",
      name: "Stone Rune: scurovisione",
      img: "icons/commodities/treasure/token-runed-spiral-grey.webp",
      changes: [{key: "system.attributes.senses.ranges.darkvision", value: "120", priority: 20, type: "upgrade"}]
    })],
    macroTypes: ["roll", "combat", "skill"]
  }),
  feature({
    id: "KhzRKStormRune01",
    name: "Storm Rune",
    identifier: "storm-rune",
    img: "icons/commodities/treasure/stone-cracked-lightning-blue.webp",
    level: 7,
    uses: runeUses(),
    description: "<p>Hai vantaggio alle prove di Arcana e non puoi essere sorpreso finché non sei incapacitated.</p><p>Come azione bonus entri in uno stato profetico per 1 minuto. Una volta per turno, come reazione, puoi imporre vantaggio o svantaggio a un tiro per colpire, tiro salvezza o prova di caratteristica effettuato entro 60 ft.</p>",
    activities: {
      KhzRKStormUse001: utilityActivity({id: "KhzRKStormUse001", name: "Storm Rune", activation: "bonus", duration: {value: "1", units: "minute"}})
    },
    effects: [baseEffect({
      id: "KhzRKStormPass01",
      name: "Storm Rune: allerta",
      img: "icons/commodities/treasure/stone-cracked-lightning-blue.webp",
      disableIncapacitated: true,
      changes: [{key: "system.traits.ci.value", value: "surprised", priority: 20, type: "add"}]
    })],
    macroTypes: ["roll", "skill"]
  }),
  feature({
    id: "KhzRKRunicShld01",
    name: "Runic Shield",
    identifier: "runic-shield",
    img: "icons/magic/defensive/shield-barrier-glowing-triangle-blue.webp",
    level: 7,
    uses: longRestProfUses(),
    description: "<p>Quando una creatura diversa da te che puoi vedere entro 60 ft viene colpita da un attacco, puoi usare la reazione per costringere l'attaccante a ripetere il d20 e a usare il nuovo risultato.</p>",
    activities: {
      KhzRKShieldUse01: utilityActivity({id: "KhzRKShieldUse01", name: "Runic Shield", activation: "reaction", range: 60, target: creatureTarget(), hidden: true})
    },
    macroTypes: ["roll"]
  }),
  feature({
    id: "KhzRKGreatStat01",
    name: "Great Stature",
    identifier: "great-stature",
    img: "icons/magic/control/buff-strength-muscle-damage-red.webp",
    level: 10,
    description: "<p>Quando usi Giant's Might, il danno extra diventa 1d8.</p><p>La crescita permanente della statura prevista dalla capacità è narrativa e non modifica la taglia meccanica dell'attore.</p>"
  }),
  feature({
    id: "KhzRKMasterRune1",
    name: "Master of Runes",
    identifier: "master-of-runes",
    img: "icons/commodities/treasure/token-runed-os-gold.webp",
    level: 15,
    description: "<p>Puoi invocare ciascuna runa conosciuta due volte, recuperando tutti gli usi con un riposo breve o lungo.</p>"
  }),
  feature({
    id: "KhzRKRunicJuggr1",
    name: "Runic Juggernaut",
    identifier: "runic-juggernaut",
    img: "icons/creatures/abilities/giant-boulder-hurl-orange.webp",
    level: 18,
    description: "<p>Giant's Might può renderti Huge, il danno extra diventa 1d10 e la portata degli attacchi in mischia aumenta di 5 ft.</p>"
  })
];

await mkdir(output, {recursive: true});
for (const item of items) {
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  const path = `${output}/${safeName}_${item._id}.json`;
  await writeFile(path, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}

console.log(`Generate ${items.length} capacità Rune Knight in ${output}.`);
