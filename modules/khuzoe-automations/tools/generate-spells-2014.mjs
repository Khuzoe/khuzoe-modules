import {RELEASE_VERSION} from "../scripts/release.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const itemOutput = `${moduleRoot}/packData/khuzoe-spells-2014`;
const actorOutput = `${moduleRoot}/packData/khuzoe-summons-2014`;
const moduleId = "khuzoe-automations";
const rules = "2014";
// Deve restare allineata a scripts/spells-2014.mjs: CAT usa questa versione
// per decidere se sostituire una vecchia automazione sull'Item dell'attore.
const automationVersion = RELEASE_VERSION;

const ids = {
  boomingBlade: "booming-blade",
  protectionEvilGood: "protection-from-evil-and-good",
  sanctuary: "sanctuary",
  shieldOfFaith: "shield-of-faith",
  shield: "shield",
  aid: "aid",
  auraVitality: "aura-of-vitality",
  guardianFaith: "guardian-of-faith",
  auraLife: "aura-of-life",
  deathWard: "death-ward",
  circlePower: "circle-of-power"
};

const activityIds = {
  boomingCast: "KhzBoomCast00001",
  boomingHit: "KhzBoomHit000001",
  boomingMoved: "KhzBoomMove00001",
  sanctuaryCast: "KhzSancCast00001",
  sanctuarySave: "KhzSancSave00001",
  aidCast: "KhzAidCast000001",
  auraVitalityCast: "KhzVitalCast0001",
  auraVitalityHeal: "KhzVitalHeal0001",
  guardianCast: "KhzGuardCast0001",
  guardianDamage: "KhzGuardDmg00001",
  auraLifeCast: "KhzLifeCast00001",
  deathWardCast: "KhzDeathCast0001",
  circlePowerCast: "KhzCircleCast001"
};

const effectIds = {
  protection: "khuzoe-protection-evil-good",
  shield: "khuzoe-shield-active",
  sanctuarySafe: "khuzoe-sanctuary-safe",
  aid: "khuzoe-aid"
};

function consumption(spellSlot = true) {
  return {targets: [], scaling: {allowed: false, max: ""}, spellSlot};
}

function targetData({type = "creature", count = "1", prompt = true, rangeUnits = "ft", templateType = "", override = false} = {}) {
  return {
    prompt,
    template: {
      contiguous: false,
      stationary: false,
      units: rangeUnits,
      type: templateType,
      size: "",
      width: "",
      height: "",
      count: ""
    },
    affects: {choice: false, count, type, special: ""},
    override
  };
}

function baseActivity({id, type, name, identifier, activation = "action", spellSlot = true, target, range, hidden = false, sort = 0, useConditionText = "", durationOverride = false}) {
  return {
    _id: id,
    type,
    activation: {type: activation, value: null, override: hidden, condition: ""},
    consumption: consumption(spellSlot),
    description: {chatFlavor: ""},
    duration: {units: "inst", concentration: false, override: durationOverride},
    effects: [],
    range: range ?? {override: false},
    target: target ?? targetData(),
    uses: {spent: 0, recovery: [], max: ""},
    sort,
    name,
    img: "",
    useConditionText,
    visibility: {level: {min: null, max: null}},
    midiProperties: {
      confirmTargets: "default",
      autoTargetType: "any",
      autoTargetAction: "default",
      automationOnly: hidden,
      magicEffect: true,
      magicDamage: false,
      ...(identifier ? {identifier} : {})
    },
    flags: hidden ? {cat: {hidden: true}} : {}
  };
}

function utilityActivity(options) {
  return {
    ...baseActivity({...options, type: "utility"}),
    roll: {formula: "", name: "", prompt: false, visible: false}
  };
}

function appliesEffects(activity, ...effectIds) {
  activity.effects = effectIds.map(_id => ({_id, level: {min: null, max: null}}));
  return activity;
}

function saveActivity({ability, damage, onSave = "none", ...options}) {
  const activity = baseActivity({...options, type: "save"});
  activity.damage = {
    onSave,
    parts: damage ? [damage] : [],
    critical: {allow: false}
  };
  activity.save = {ability: [ability], dc: {calculation: "spellcasting", formula: ""}};
  if (damage) activity.midiProperties.magicDamage = true;
  return activity;
}

function damageActivity({formula = "1d8", damageType = "thunder", ...options}) {
  const activity = baseActivity({...options, type: "damage"});
  activity.damage = {
    critical: {allow: false},
    parts: [{
      custom: {enabled: true, formula},
      number: null,
      denomination: 0,
      bonus: "",
      types: [damageType],
      scaling: {mode: "", number: null, formula: ""}
    }]
  };
  activity.midiProperties.magicDamage = true;
  return activity;
}

function healActivity(options) {
  const activity = baseActivity({...options, type: "heal"});
  activity.healing = {
    number: 2,
    denomination: 6,
    types: ["healing"],
    custom: {enabled: false, formula: ""},
    scaling: {number: null, mode: "", formula: ""},
    bonus: ""
  };
  activity.midiProperties.magicEffect = true;
  return activity;
}

function activeEffect({id, itemId, name, img, seconds, changes, catIdentifier, catMacros, showIcon = 1, specialDuration = []}) {
  return {
    _id: id,
    name,
    img,
    type: "base",
    system: {changes},
    disabled: false,
    duration: {value: seconds, units: "seconds", expiry: "turnStart", expired: false},
    origin: null,
    tint: "#ffffff",
    transfer: false,
    statuses: [],
    description: "",
    showIcon,
    flags: {
      core: {overlay: false},
      dae: {transfer: false, stackable: "noneNameOnly", expiryMode: "delete", specialDuration},
      dnd5e: {riders: {statuses: []}},
      "midi-qol": {forceCEOff: true},
      ...(catIdentifier ? {cat: {identifier: catIdentifier, ...(catMacros ? {macros: catMacros} : {})}} : {})
    },
    start: null,
    folder: null,
    sort: 0,
    _key: `!items.effects!${itemId}.${id}`
  };
}

function catReference(identifier) {
  return {source: moduleId, rules, identifier};
}

function spell({
  id, name, identifier, img, level, school, description, activation = "action", durationValue = "inst",
  durationUnits = "inst", rangeValue = null, rangeUnits = "self", targetType = "creature", targetCount = "1",
  properties = [], activities, effects = [], macro = true, midi = {}
}) {
  const sourceActivities = Object.fromEntries(activities.map(activity => [activity._id, activity]));
  const hidden = activities.filter(activity => activity.flags?.cat?.hidden).map(activity => activity._id);
  const effectIdsForRiders = effects.map(effect => effect._id);
  return {
    _id: id,
    name,
    type: "spell",
    img,
    system: {
      description: {value: description, chat: ""},
      source: {custom: "Khuzoe Automations", book: "", page: "", license: "", rules},
      activation: {type: activation, condition: "", value: 1},
      duration: {value: durationValue, units: durationUnits},
      target: {
        affects: {type: targetType, count: targetCount, choice: false, special: ""},
        template: {units: "", contiguous: false, type: "", size: "", width: "", height: "", count: ""}
      },
      range: {value: rangeValue, units: rangeUnits, special: ""},
      uses: {max: "", recovery: [], spent: 0},
      level,
      school,
      materials: {value: "", consumed: false, cost: 0, supply: 0},
      preparation: {mode: "prepared", prepared: level === 0},
      properties,
      activities: sourceActivities,
      identifier
    },
    effects,
    flags: {
      "midi-qol": {
        removeAttackDamageButtons: "default",
        forceCEOff: true,
        reactionCondition: "",
        ...midi
      },
      midiProperties: {confirmTargets: "default", magicdam: false, magiceffect: true},
      dnd5e: {riders: {activity: hidden, effect: effectIdsForRiders}},
      cat: {
        automation: {source: moduleId, version: automationVersion},
        ...(macro ? {macros: {roll: [catReference(identifier)]}} : {})
      }
    },
    folder: null,
    sort: 0,
    ownership: {default: 0},
    _key: `!items!${id}`
  };
}

const protId = "KhzProtEvil14001";
const protEffectId = "KhzProtEffect001";
const faithId = "KhzShieldFaith01";
const faithEffectId = "KhzFaithEffect01";
const shieldId = "KhzShieldSpell01";
const shieldEffectId = "KhzShieldEff0001";

const items = [
  spell({
    id: "KhzBoomBlade1401",
    name: "Booming Blade",
    identifier: ids.boomingBlade,
    img: "icons/magic/lightning/bolt-strike-blue.webp",
    level: 0,
    school: "evo",
    description: "<p>Come parte dell'azione di lancio effettui un attacco in mischia con un'arma. Ai livelli 5, 11 e 17 il colpo infligge rispettivamente 1d8, 2d8 e 3d8 danni da tuono aggiuntivi. Se il bersaglio si muove volontariamente prima dell'inizio del tuo turno successivo subisce 1d8 danni da tuono, aumentati di un dado agli stessi livelli.</p>",
    rangeValue: "5",
    rangeUnits: "ft",
    durationValue: "1",
    durationUnits: "round",
    properties: ["somatic", "material"],
    activities: [
      utilityActivity({id: activityIds.boomingCast, name: "Booming Blade", target: targetData({count: "1"})}),
      damageActivity({
        id: activityIds.boomingHit,
        name: "Booming Blade: colpo",
        hidden: true,
        activation: "special",
        spellSlot: false,
        range: {override: true, value: "5", units: "ft", special: "Bersaglio colpito"},
        target: targetData({count: "1", prompt: false, override: true})
      }),
      damageActivity({
        id: activityIds.boomingMoved,
        name: "Booming Blade: movimento",
        hidden: true,
        activation: "special",
        spellSlot: false,
        range: {override: true, value: null, units: "any", special: "Bersaglio marchiato"},
        target: targetData({count: "1", prompt: false, override: true})
      })
    ]
  }),
  spell({
    id: protId,
    name: "Protection from Evil and Good",
    identifier: ids.protectionEvilGood,
    img: "icons/magic/defensive/shield-barrier-flaming-diamond-blue-yellow.webp",
    level: 1,
    school: "abj",
    description: "<p>Una creatura è protetta da aberrazioni, celestiali, elementali, folletti, immondi e non morti. Queste creature hanno svantaggio agli attacchi contro il bersaglio, che non può essere affascinato, spaventato o posseduto da esse e dispone di vantaggio ai relativi tiri salvezza.</p>",
    durationValue: "10",
    durationUnits: "minute",
    rangeUnits: "touch",
    properties: ["vocal", "somatic", "material", "concentration"],
    macro: false,
    activities: [appliesEffects(
      utilityActivity({id: "KhzProtCast00001", name: "Cast", target: targetData({count: "1"})}),
      protEffectId
    )],
    effects: [activeEffect({
      id: protEffectId,
      itemId: protId,
      name: "Protection from Evil and Good",
      img: "icons/magic/defensive/shield-barrier-flaming-diamond-blue-yellow.webp",
      seconds: 600,
      showIcon: 1,
      changes: [{
        key: "flags.midi-qol.grants.disadvantage.attack.all",
        value: "['aberration', 'celestial', 'elemental', 'fey', 'fiend', 'undead'].includes(raceOrType)",
        priority: 20,
        type: "override"
      }],
      catIdentifier: effectIds.protection,
      catMacros: {save: [catReference(effectIds.protection)]}
    })]
  }),
  spell({
    id: "KhzSanctuary1401",
    name: "Sanctuary",
    identifier: ids.sanctuary,
    img: "icons/magic/holy/barrier-shield-winged-blue.webp",
    level: 1,
    school: "abj",
    description: "<p>Una creatura che tenta di attaccare il bersaglio o di colpirlo con un incantesimo dannoso deve superare un tiro salvezza su Saggezza. L'effetto termina se il protetto attacca o lancia un incantesimo che influenza un nemico.</p>",
    activation: "bonus",
    durationValue: "1",
    durationUnits: "minute",
    rangeValue: "30",
    rangeUnits: "ft",
    properties: ["vocal", "somatic", "material"],
    activities: [
      utilityActivity({id: activityIds.sanctuaryCast, name: "Sanctuary", target: targetData({count: "1"})}),
      saveActivity({
        id: activityIds.sanctuarySave,
        name: "Sanctuary: tiro salvezza",
        hidden: true,
        activation: "special",
        spellSlot: false,
        ability: "wis",
        target: targetData({count: "1", prompt: false}),
        range: {override: true, value: null, units: "any", special: "Attaccante"}
      })
    ]
  }),
  spell({
    id: faithId,
    name: "Shield of Faith",
    identifier: ids.shieldOfFaith,
    img: "icons/magic/defensive/shield-barrier-flaming-diamond-blue-yellow.webp",
    level: 1,
    school: "abj",
    description: "<p>Il bersaglio ottiene un bonus di +2 alla CA per un massimo di 10 minuti, finché mantieni la concentrazione.</p>",
    activation: "bonus",
    durationValue: "10",
    durationUnits: "minute",
    rangeValue: "60",
    rangeUnits: "ft",
    properties: ["vocal", "somatic", "material", "concentration"],
    macro: false,
    activities: [appliesEffects(
      utilityActivity({id: "KhzFaithCast0001", name: "Cast", target: targetData({count: "1"})}),
      faithEffectId
    )],
    effects: [activeEffect({
      id: faithEffectId,
      itemId: faithId,
      name: "Shield of Faith",
      img: "icons/magic/defensive/shield-barrier-flaming-diamond-blue-yellow.webp",
      seconds: 600,
      changes: [{key: "system.attributes.ac.bonus", value: "2", priority: 20, type: "add"}]
    })]
  }),
  spell({
    id: shieldId,
    name: "Shield",
    identifier: ids.shield,
    img: "icons/magic/defensive/shield-barrier-glowing-triangle-magenta.webp",
    level: 1,
    school: "abj",
    description: "<p>Come reazione quando vieni colpito da un attacco o bersagliato da Magic Missile, ottieni +5 alla CA fino all'inizio del tuo turno successivo e non subisci danni da Magic Missile.</p>",
    activation: "reaction",
    durationValue: "1",
    durationUnits: "round",
    targetType: "self",
    targetCount: "",
    properties: ["vocal", "somatic"],
    macro: false,
    midi: {reactionCondition: "reaction === 'isHit'"},
    activities: [appliesEffects(
      utilityActivity({
        id: "KhzShieldCast001",
        name: "Shield",
        activation: "reaction",
        target: targetData({type: "self", count: "", prompt: false}),
        useConditionText: "reaction === 'isHit' || (reaction === 'isDamaged' && workflow.item.system.identifier === 'magic-missile')"
      }),
      shieldEffectId
    )],
    effects: [activeEffect({
      id: shieldEffectId,
      itemId: shieldId,
      name: "Shield",
      img: "icons/magic/defensive/shield-barrier-glowing-triangle-magenta.webp",
      seconds: 6,
      changes: [{key: "system.attributes.ac.bonus", value: "5", priority: 20, type: "add"}],
      catIdentifier: effectIds.shield,
      catMacros: {roll: [catReference(effectIds.shield)]},
      specialDuration: ["turnStartSource"]
    })]
  }),
  spell({
    id: "KhzAidSpell14001",
    name: "Aid",
    identifier: ids.aid,
    img: "icons/magic/life/heart-cross-strong-flame-green.webp",
    level: 2,
    school: "abj",
    description: "<p>Fino a tre creature aumentano i propri punti ferita attuali e massimi di 5. L'incremento aumenta di 5 per ogni livello dello slot superiore al 2°.</p>",
    durationValue: "8",
    durationUnits: "hour",
    rangeValue: "30",
    rangeUnits: "ft",
    targetCount: "3",
    properties: ["vocal", "somatic", "material"],
    activities: [utilityActivity({id: activityIds.aidCast, name: "Aid", target: targetData({count: "3"})})]
  }),
  spell({
    id: "KhzAuraVitality1",
    name: "Aura of Vitality",
    identifier: ids.auraVitality,
    img: "icons/magic/life/cross-area-circle-green-white.webp",
    level: 3,
    school: "evo",
    description: "<p>Per 1 minuto puoi usare un'azione bonus per far recuperare 2d6 punti ferita a una creatura entro 30 ft. Richiede concentrazione.</p>",
    durationValue: "1",
    durationUnits: "minute",
    targetType: "self",
    targetCount: "",
    properties: ["vocal", "concentration"],
    activities: [
      utilityActivity({id: activityIds.auraVitalityCast, name: "Aura of Vitality", target: targetData({type: "self", count: "", prompt: false})}),
      healActivity({
        id: activityIds.auraVitalityHeal,
        name: "Aura of Vitality: cura",
        identifier: "aura-of-vitality-healing",
        activation: "bonus",
        spellSlot: false,
        hidden: true,
        durationOverride: true,
        target: targetData({count: "1", override: true}),
        range: {override: true, value: "30", units: "ft", special: ""}
      })
    ]
  }),
  spell({
    id: "KhzGuardianFth01",
    name: "Guardian of Faith",
    identifier: ids.guardianFaith,
    img: "icons/magic/holy/angel-winged-humanoid-blue.webp",
    level: 4,
    school: "con",
    description: "<p>Evoca un guardiano entro 30 ft per 8 ore. Una creatura ostile che si muove entro 10 ft per la prima volta in un turno deve superare un tiro salvezza su Destrezza: subisce 20 danni radianti, o 10 con un successo. Il guardiano scompare dopo aver inflitto 60 danni.</p>",
    durationValue: "8",
    durationUnits: "hour",
    rangeValue: "30",
    rangeUnits: "ft",
    targetType: "self",
    targetCount: "",
    properties: ["vocal"],
    activities: [
      utilityActivity({id: activityIds.guardianCast, name: "Guardian of Faith", target: targetData({type: "self", count: "", prompt: false})}),
      saveActivity({
        id: activityIds.guardianDamage,
        name: "Guardian of Faith: danno",
        hidden: true,
        activation: "special",
        spellSlot: false,
        ability: "dex",
        onSave: "half",
        damage: {
          custom: {enabled: true, formula: "20"},
          number: null,
          denomination: 0,
          bonus: "",
          types: ["radiant"],
          scaling: {mode: "", number: null, formula: ""}
        },
        target: targetData({count: "1", prompt: false}),
        range: {override: true, value: "10", units: "ft", special: "Dal guardiano"}
      })
    ]
  }),
  spell({
    id: "KhzAuraLife14001",
    name: "Aura of Life",
    identifier: ids.auraLife,
    img: "icons/magic/holy/prayer-hands-glowing-yellow.webp",
    level: 4,
    school: "abj",
    description: "<p>Le creature non ostili entro 30 ft hanno resistenza ai danni necrotici, i loro punti ferita massimi non possono essere ridotti e recuperano 1 punto ferita a inizio turno se si trovano a 0.</p>",
    durationValue: "10",
    durationUnits: "minute",
    targetType: "self",
    targetCount: "",
    properties: ["vocal", "concentration"],
    activities: [utilityActivity({id: activityIds.auraLifeCast, name: "Aura of Life", target: targetData({type: "self", count: "", prompt: false})})]
  }),
  spell({
    id: "KhzDeathWard1401",
    name: "Death Ward",
    identifier: ids.deathWard,
    img: "icons/magic/death/skull-humanoid-worn-teal.webp",
    level: 4,
    school: "abj",
    description: "<p>La prima volta che il bersaglio dovrebbe scendere a 0 punti ferita a causa del danno, rimane invece a 1 punto ferita e l'incantesimo termina.</p>",
    durationValue: "8",
    durationUnits: "hour",
    rangeUnits: "touch",
    properties: ["vocal", "somatic"],
    activities: [utilityActivity({id: activityIds.deathWardCast, name: "Death Ward", target: targetData({count: "1"})})]
  }),
  spell({
    id: "KhzCirclePower01",
    name: "Circle of Power",
    identifier: ids.circlePower,
    img: "icons/magic/holy/barrier-shield-winged-cross.webp",
    level: 5,
    school: "abj",
    description: "<p>Tu e le creature amiche entro 30 ft avete vantaggio ai tiri salvezza contro incantesimi ed effetti magici. Quando una creatura nell'aura supera un tiro salvezza che normalmente dimezzerebbe il danno, non subisce danni.</p>",
    durationValue: "10",
    durationUnits: "minute",
    targetType: "self",
    targetCount: "",
    properties: ["vocal", "concentration"],
    activities: [utilityActivity({id: activityIds.circlePowerCast, name: "Circle of Power", target: targetData({type: "self", count: "", prompt: false})})]
  })
];

const guardianActor = {
  _id: "KhzGuardianAct01",
  name: "Guardian of Faith",
  type: "npc",
  img: "icons/magic/holy/angel-winged-humanoid-blue.webp",
  system: {
    abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(key => [key, {value: 10, proficient: 0, max: null, bonuses: {check: "", save: ""}}])),
    attributes: {
      ac: {flat: 10, calc: "flat", formula: ""},
      hp: {value: 60, max: 60, temp: 0, tempmax: 0, formula: "60"},
      movement: {burrow: 0, climb: 0, fly: 0, swim: 0, walk: 0, units: "ft", hover: true},
      senses: {ranges: {darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0}, units: "ft", special: ""},
      spellcasting: "wis"
    },
    details: {biography: {value: "<p>Manifestazione immobile creata da Guardian of Faith.</p>", public: ""}, alignment: "", type: {value: "celestial", subtype: "", swarm: "", custom: ""}, cr: 0},
    traits: {size: "lg", di: {value: [], bypasses: [], custom: ""}, dr: {value: [], bypasses: [], custom: ""}, dv: {value: [], bypasses: [], custom: ""}, ci: {value: [], custom: ""}},
    source: {custom: "Khuzoe Automations", rules}
  },
  prototypeToken: {
    name: "Guardian of Faith",
    displayName: 30,
    actorLink: true,
    texture: {src: "icons/magic/holy/angel-winged-humanoid-blue.webp", scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, rotation: 0, tint: "#ffffff", anchorX: 0.5, anchorY: 0.5, fit: "contain", alphaThreshold: 0.75},
    width: 2,
    height: 2,
    lockRotation: true,
    rotation: 0,
    alpha: 0.9,
    disposition: 1,
    displayBars: 0,
    bar1: {attribute: null},
    bar2: {attribute: null},
    light: {alpha: 0.35, angle: 360, bright: 5, color: "#ffe9a6", coloration: 1, dim: 10, attenuation: 0.5, luminosity: 0.5, saturation: 0, contrast: 0, shadows: 0, animation: {type: null, speed: 5, intensity: 5, reverse: false}, darkness: {min: 0, max: 1}, negative: false, priority: 0},
    sight: {enabled: false, range: 0, angle: 360, visionMode: "basic", color: null, attenuation: 0.1, brightness: 0, saturation: 0, contrast: 0},
    detectionModes: [],
    flags: {},
    randomImg: false,
    appendNumber: false,
    prependAdjective: false,
    hexagonalShape: 0,
    occludable: {radius: 0},
    ring: {enabled: false, colors: {ring: null, background: null}, effects: 1, subject: {scale: 1, texture: null}}
  },
  items: [],
  effects: [],
  flags: {"midi-qol": {neverTarget: true}, dnd5e: {showTokenPortrait: false}},
  folder: null,
  sort: 0,
  ownership: {default: 0},
  _key: "!actors!KhzGuardianAct01"
};

await mkdir(itemOutput, {recursive: true});
await mkdir(actorOutput, {recursive: true});
for (const item of items) {
  for (const activity of Object.values(item.system.activities)) {
    if (String(activity._id).length !== 16) throw new Error(`${item.name}: ID attività non valido ${activity._id}`);
  }
  if (item._id.length !== 16) throw new Error(`${item.name}: ID oggetto non valido ${item._id}`);
  const safeName = item.name.replaceAll("'", "").replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  await writeFile(`${itemOutput}/${safeName}_${item._id}.json`, `${JSON.stringify(normalizeAutomationData(item), null, 2)}\n`, "utf8");
}
await writeFile(`${actorOutput}/Guardian_of_Faith_${guardianActor._id}.json`, `${JSON.stringify(guardianActor, null, 2)}\n`, "utf8");

console.log(`Generate ${items.length} incantesimi 2014 e il summon Guardian of Faith.`);
