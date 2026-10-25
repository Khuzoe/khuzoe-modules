import {RELEASE_VERSION} from "../scripts/release.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import * as auraGeometry from "../../khuzoe-auras/scripts/distance.js";

globalThis.game = {user: {id: "player", isGM: false}, actors: []};
globalThis.ui = {notifications: {warn() {}, info() {}, error() {}}};
globalThis.document = {
  createElement() {
    return {innerHTML: "", set textContent(value) { this.innerHTML = String(value); }};
  }
};
globalThis.foundry = {
  utils: {
    setProperty(object, path, value) {
      const keys = path.split(".");
      const last = keys.pop();
      const parent = keys.reduce((current, key) => current[key] ??= {}, object);
      parent[last] = value;
      return true;
    }
  }
};

const {
  PALADIN_ACTIVITY_IDS,
  PALADIN_AURA_DISTANCE_FLAG,
  PALADIN_EFFECT_IDS,
  PALADIN_IDS,
  activateHolyNimbus,
  getPaladinLevel,
  holyNimbusSaveAdvantage,
  paladinAuraIconVisibility,
  paladinAuraTokenDistance,
  paladinAuraVisuals,
  paladinAuraDistance,
  preparePaladinAuraEffectIcon,
  preparePaladinItemUpdate,
  reconcilePaladinAuras,
  registerPaladin,
  triggerHolyNimbusTurnStart
} = await import("../scripts/paladin.mjs");

const automations = [];
const macros = [];
const api = {
  registerAutomation(data) { automations.push(data); return true; },
  registerFnMacro(data) { macros.push(data); return data; }
};
const registered = registerPaladin(api);
assert.equal(registered.automations.length, 5);
assert.equal(registered.macros.length, 4);
for (const identifier of Object.values(PALADIN_IDS)) {
  assert.ok(automations.some(entry => entry.identifier === identifier && entry.rules === "2014"));
}
for (const identifier of [PALADIN_IDS.layOnHands, PALADIN_IDS.divineSmite, PALADIN_IDS.holyNimbus]) {
  assert.ok(macros.some(entry => entry.identifier === identifier && entry.rules === "2014"));
}
assert.ok(macros.some(entry => entry.identifier === PALADIN_EFFECT_IDS.holyNimbus && entry.save?.[0]?.pass === "actorContext"));
assert.equal(macros.some(entry => entry.aura), false, "Le aure persistenti non devono usare il ciclo concorrente di CAT");

const byIdentifier = identifier => macros.find(entry => entry.identifier === identifier);
assert.equal(byIdentifier(PALADIN_IDS.divineSmite).roll[0].pass, "actorDamageRollBonuses");

const packDirectory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
const sourceFiles = (await readdir(packDirectory)).filter(file => file.endsWith(".json"));
const paladinDocuments = [];
for (const file of sourceFiles) {
  const data = JSON.parse(await readFile(new URL(file, packDirectory), "utf8"));
  if (!Object.values(PALADIN_IDS).includes(data.system?.identifier)) continue;
  paladinDocuments.push(data);
  assert.equal(data._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(data.system.source.rules, "2014");
  assert.equal(data.flags.cat.automation.source, "khuzoe-automations");
  for (const activity of Object.values(data.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
}
assert.equal(paladinDocuments.length, 5);

const laySource = paladinDocuments.find(item => item.system.identifier === PALADIN_IDS.layOnHands);
assert.deepEqual(
  new Set(Object.keys(laySource.system.activities)),
  new Set([
    PALADIN_ACTIVITY_IDS.layHeal,
    PALADIN_ACTIVITY_IDS.layPoison,
    PALADIN_ACTIVITY_IDS.layDisease,
    PALADIN_ACTIVITY_IDS.layTechnicalHeal
  ])
);
assert.equal(laySource.system.activities[PALADIN_ACTIVITY_IDS.layTechnicalHeal].flags.cat.hidden, true);
assert.equal(laySource.system.uses.recovery[0].period, "lr");
for (const identifier of [PALADIN_IDS.auraProtection, PALADIN_IDS.auraCourage]) {
  const aura = paladinDocuments.find(item => item.system.identifier === identifier);
  assert.equal(aura.flags.cat.config[PALADIN_AURA_DISTANCE_FLAG], 10);
  assert.equal(aura.flags.cat.macros?.aura, undefined);
  assert.equal(aura.flags.cat.automation.version, RELEASE_VERSION);
}
const holyNimbusSource = paladinDocuments.find(item => item.system.identifier === PALADIN_IDS.holyNimbus);
assert.equal(holyNimbusSource.flags.cat.automation.version, RELEASE_VERSION);
assert.equal(holyNimbusSource.system.uses.max, "1");
assert.equal(holyNimbusSource.system.uses.recovery[0].period, "lr");
assert.equal(holyNimbusSource.system.activities[PALADIN_ACTIVITY_IDS.holyNimbus].duration.units, "minute");
assert.equal(holyNimbusSource.system.activities[PALADIN_ACTIVITY_IDS.holyNimbusDamage].damage.parts[0].custom.formula, "10");
assert.deepEqual(holyNimbusSource.system.activities[PALADIN_ACTIVITY_IDS.holyNimbusDamage].damage.parts[0].types, ["radiant"]);

let spentSlot;
let bonusDamage;
globalThis.cat = {
  utils: {
    actorUtils: {
      hasSpellSlots() { return true; },
      typeOrRace(actor) { return actor.creatureType; },
      async spendSpellSlots(_actor, slot) { spentSlot = slot; }
    },
    dialogUtils: {
      async selectSpellSlot() { return 2; }
    },
    queryUtils: {firstOwner() { return "player"; }},
    workflowUtils: {
      async bonusDamage(_workflow, formula, options) { bonusDamage = {formula, options}; }
    }
  }
};

const paladinActor = {
  name: "Paladino",
  system: {spells: {spell2: {level: 2, value: 1, max: 2}}}
};
const undeadTarget = {name: "Non morto", actor: {creatureType: "undead"}};
const smiteWorkflow = {
  activity: {actionType: "mwak"},
  item: {name: "Longsword", system: {identifier: "longsword"}},
  hitTargets: new Set([undeadTarget])
};
const smiteItem = {name: "Divine Smite", actor: paladinActor};
registerDocuments(paladinActor, smiteItem);
await byIdentifier(PALADIN_IDS.divineSmite).roll[0].macro({workflow: smiteWorkflow, document: smiteItem});
assert.equal(paladinActor.system.spells.spell2.value, 0);
assert.deepEqual(bonusDamage, {formula: "4d8", options: {damageType: "radiant"}});

let createdNimbusEffect;
globalThis.cat.utils.documentUtils = {
  async deleteDocument() {},
  async createEmbeddedDocuments(actor, type, documents) {
    createdNimbusEffect = {actor, type, data: documents[0]};
    return documents;
  }
};
const nimbusActor = {effects: []};
const nimbusItem = {
  documentName: "Item",
  name: "Holy Nimbus",
  img: "nimbus.webp",
  uuid: "Actor.Paladin.Item.HolyNimbus",
  actor: nimbusActor
};
await activateHolyNimbus({
  workflow: {activity: {id: PALADIN_ACTIVITY_IDS.holyNimbus}},
  document: nimbusItem
});
assert.equal(createdNimbusEffect.actor, nimbusActor);
assert.equal(createdNimbusEffect.type, "ActiveEffect");
assert.equal(createdNimbusEffect.data.flags.cat.identifier, PALADIN_EFFECT_IDS.holyNimbus);
assert.equal(createdNimbusEffect.data.flags.cat.macros.save[0].identifier, PALADIN_EFFECT_IDS.holyNimbus);
assert.ok(createdNimbusEffect.data.system.changes.some(change => change.key === "token.light.bright" && change.value === "30"), "Holy Nimbus uses native v14 token light without requiring ATL");
assert.ok(createdNimbusEffect.data.system.changes.some(change => change.key === "token.light.dim" && change.value === "60"));

const fiendSpell = {documentName: "Item", type: "spell", actor: {creatureType: "fiend"}};
const humanoidSpell = {documentName: "Item", type: "spell", actor: {creatureType: "humanoid"}};
globalThis.fromUuidSync = uuid => ({
  "Activity.FiendSpell": {item: fiendSpell},
  "Activity.HumanoidSpell": {item: humanoidSpell}
})[uuid];
assert.equal(holyNimbusSaveAdvantage({config: {cat: {activityUuid: "Activity.FiendSpell"}}}).type, "advantage");
assert.equal(holyNimbusSaveAdvantage({config: {cat: {activityUuid: "Activity.HumanoidSpell"}}}), undefined);

let numberDialogOptions;
let healingRoll;
let layUpdate;
const layActor = {
  classes: {paladin: {system: {levels: 4}}}
};
const healedActor = {
  creatureType: "humanoid",
  system: {attributes: {hp: {value: 12, max: 30}}},
  effects: []
};
const healedTarget = {name: "Alleato", actor: healedActor};
const technicalActivity = {
  id: PALADIN_ACTIVITY_IDS.layTechnicalHeal,
  toObject() {
    return {type: "heal", healing: {custom: {enabled: true, formula: "1"}}};
  }
};
const layItem = {
  id: "lay",
  documentName: "Item",
  name: "Lay on Hands",
  actor: layActor,
  system: {
    identifier: PALADIN_IDS.layOnHands,
    uses: {max: "20", spent: 5},
    activities: new Map([[PALADIN_ACTIVITY_IDS.layTechnicalHeal, technicalActivity]])
  }
};
globalThis.cat.utils.actorUtils.typeOrRace = actor => actor.creatureType;
globalThis.cat.utils.dialogUtils.numberDialog = async (_title, _content, _input, options) => {
  numberDialogOptions = options;
  return 7;
};
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async (activity, item, targets, options) => {
  healingRoll = {activity, item, targets, options};
  return {ok: true};
};
globalThis.cat.utils.documentUtils = {
  async update(_document, changes) { layUpdate = changes; },
  async deleteDocument() {}
};

registerDocuments(layActor, layItem);
const layWorkflow = {
  activity: {id: PALADIN_ACTIVITY_IDS.layHeal},
  item: layItem,
  targets: new Set([healedTarget])
};
const layMacros = byIdentifier(PALADIN_IDS.layOnHands).roll;
await layMacros.find(entry => entry.pass === "itemPreItemRoll").macro({workflow: layWorkflow, document: layItem});
assert.equal(layWorkflow.khuzoeLayOnHands.amount, 7);
assert.equal(numberDialogOptions.userId, "player");
await layMacros.find(entry => entry.pass === "itemRollFinished").macro({workflow: layWorkflow, document: layItem});
assert.equal(healingRoll.activity.healing.custom.formula, "7");
assert.deepEqual(healingRoll.targets, [healedTarget]);
assert.equal(healingRoll.options.consumeUsage, false);
assert.equal(layUpdate["system.uses.spent"], 12);

const auraSources = new Map([
  ["Actor.Paladin.Item.Protection", {system: {identifier: PALADIN_IDS.auraProtection}}],
  ["Actor.Paladin.Item.Courage", {system: {identifier: PALADIN_IDS.auraCourage}}],
  ["Actor.Paladin.Item.Devotion", {system: {identifier: "aura-of-devotion"}}]
]);
globalThis.fromUuidSync = uuid => auraSources.get(uuid);

let nextAuraEffectId = 1;
let auraCreates = 0;
const auraDeleteBatches = [];
const auraUpdates = [];

function applyFlatUpdate(document, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split(".");
    const deletion = keys.at(-1).startsWith("-=");
    const final = deletion ? keys.pop().slice(2) : keys.pop();
    let parent = document;
    for (const key of keys) parent = parent[key] ??= {};
    if (deletion) delete parent[final];
    else parent[final] = structuredClone(value);
  }
}

function makeAuraActor(id, name, {cha = 0} = {}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name,
    statuses: new Set(),
    items: [],
    effects: [],
    system: {attributes: {hp: {value: 20}}, abilities: {cha: {mod: cha}}},
    async createEmbeddedDocuments() {},
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) {
        const effect = this.effects.find(entry => entry.id === update._id);
        if (effect) applyFlatUpdate(effect, Object.fromEntries(Object.entries(update).filter(([key]) => key !== "_id")));
      }
    }
  };
  return actor;
}

const auraActor = makeAuraActor("Aurelio", "Aurelio", {cha: 4});
const protectionDocument = {
  id: "Protection",
  uuid: "Actor.Paladin.Item.Protection",
  name: "Aura of Protection",
  img: "aura.webp",
  actor: auraActor,
  system: {identifier: PALADIN_IDS.auraProtection},
  flags: {cat: {automation: {source: "khuzoe-automations"}, config: {[PALADIN_AURA_DISTANCE_FLAG]: 10}}}
};
const courageDocument = {
  id: "Courage",
  uuid: "Actor.Paladin.Item.Courage",
  name: "Aura of Courage",
  img: "courage.webp",
  actor: auraActor,
  system: {identifier: PALADIN_IDS.auraCourage},
  flags: {cat: {automation: {source: "khuzoe-automations"}, config: {[PALADIN_AURA_DISTANCE_FLAG]: 10}}}
};
const duplicateProtectionDocument = {
  ...protectionDocument,
  id: "ProtectionDuplicate",
  uuid: "Actor.Paladin.Item.ProtectionDuplicate"
};
auraActor.items = [protectionDocument, duplicateProtectionDocument, courageDocument];
auraSources.set(protectionDocument.uuid, protectionDocument);
auraSources.set(duplicateProtectionDocument.uuid, duplicateProtectionDocument);
auraSources.set(courageDocument.uuid, courageDocument);

const protectionVisuals = paladinAuraVisuals({actor: auraActor});
assert.equal(protectionVisuals.length, 1, "Le copie dell'abilità devono produrre una sola visuale");
assert.equal(protectionVisuals[0].area.distance, 10);
assert.equal(protectionVisuals[0].visual.color, "#f2d66d");
assert.ok(protectionVisuals[0].visual.opacity < 0.05);

const nimbusVisualActor = makeAuraActor("NimbusVisual", "Nimbus Visual");
nimbusVisualActor.effects.push({
  active: true,
  disabled: false,
  name: "Holy Nimbus",
  flags: {cat: {identifier: PALADIN_EFFECT_IDS.holyNimbus}}
});
const nimbusVisuals = paladinAuraVisuals({actor: nimbusVisualActor});
assert.equal(nimbusVisuals.length, 1);
assert.equal(nimbusVisuals[0].area.distance, 30);
assert.equal(nimbusVisuals[0].source.requiresConscious, false);

const firstAlly = makeAuraActor("FirstAlly", "Primo alleato");
const secondAlly = makeAuraActor("SecondAlly", "Secondo alleato");
const enemy = makeAuraActor("Enemy", "Nemico");
const sourceToken = {id: "source", actor: auraActor, disposition: 1, x: 0};
const firstToken = {id: "first", actor: firstAlly, disposition: 1, x: 5};
const secondToken = {id: "second", actor: secondAlly, disposition: 1, x: 8};
const enemyToken = {id: "enemy", actor: enemy, disposition: -1, x: 5};
const auraScene = {
  id: "AuraScene",
  grid: {size: 5, distance: 5, units: "ft"},
  tokens: [sourceToken, firstToken, secondToken, enemyToken]
};
for (const token of auraScene.tokens) token.parent = auraScene;

const legacyProtection = {
  id: "legacy-protection",
  origin: protectionDocument.uuid,
  name: "Aura of Protection",
  img: "old.webp",
  disabled: false,
  showIcon: 1,
  system: {changes: [{key: "system.bonuses.abilities.save", value: "4", priority: 20, type: "add"}]},
  flags: {"chris-premades": {aura: true}}
};
const duplicateCatProtection = {
  id: "duplicate-cat-protection",
  origin: protectionDocument.uuid,
  name: "Aura of Protection",
  system: {changes: []},
  flags: {cat: {auraEffect: true, identifier: "aura-of-protectionAura"}}
};
const duplicateManagedProtection = {
  id: "managed-protection",
  origin: protectionDocument.uuid,
  name: "Aura of Protection",
  system: {changes: []},
  flags: {"khuzoe-automations": {paladinAura: true}}
};
firstAlly.effects.push(legacyProtection, duplicateCatProtection, duplicateManagedProtection);

globalThis.game.user = {id: "gm", isGM: true};
globalThis.game.users = {activeGM: {id: "gm"}};
globalThis.game.actors = [auraActor, firstAlly, secondAlly, enemy];
globalThis.game.scenes = [auraScene];
globalThis.canvas = {scene: auraScene, tokens: {placeables: []}};
globalThis.CONST = {ACTIVE_EFFECT_SHOW_ICON: {ALWAYS: 2}};
globalThis.cat.utils.tokenUtils = {
  isEnemy: (left, right) => left.disposition !== right.disposition,
  getDistance: (left, right) => Math.abs(left.x - right.x)
};
globalThis.cat.utils.documentUtils = {
  ...globalThis.cat.utils.documentUtils,
  async createEmbeddedDocuments(actor, _type, documents, options) {
    assert.equal(Object.isExtensible(options), true, "Le opzioni passate a Foundry/Midi devono essere estensibili");
    options.parent = actor;
    auraCreates += documents.length;
    await new Promise(resolve => setTimeout(resolve, 2));
    const created = documents.map(data => ({
      ...structuredClone(data),
      id: `aura-effect-${nextAuraEffectId++}`,
      parent: actor
    }));
    actor.effects.push(...created);
    return created;
  },
  async deleteEmbeddedDocuments(actor, _type, ids) {
    const missing = ids.filter(id => !actor.effects.some(effect => effect.id === id));
    assert.deepEqual(missing, [], "Una riconciliazione serializzata non deve eliminare due volte lo stesso effetto");
    auraDeleteBatches.push([...ids]);
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
  },
  async update(effect, changes) {
    auraUpdates.push({effect, changes});
    applyFlatUpdate(effect, changes);
  }
};

const holyDamageActivity = {
  id: PALADIN_ACTIVITY_IDS.holyNimbusDamage,
  toObject: () => ({type: "damage", damage: {parts: [{custom: {enabled: true, formula: "10"}, types: ["radiant"]}]}})
};
const holyFeature = {
  documentName: "Item",
  name: "Holy Nimbus",
  uuid: "Actor.Aurelio.Item.HolyNimbus",
  actor: auraActor,
  system: {
    identifier: PALADIN_IDS.holyNimbus,
    activities: new Map([[PALADIN_ACTIVITY_IDS.holyNimbusDamage, holyDamageActivity]])
  }
};
const holyEffect = {
  parent: auraActor,
  active: true,
  disabled: false,
  origin: holyFeature.uuid,
  flags: {cat: {identifier: PALADIN_EFFECT_IDS.holyNimbus}}
};
auraActor.items.push(holyFeature);
auraActor.effects.push(holyEffect);
globalThis.fromUuid = async uuid => uuid === holyFeature.uuid ? holyFeature : null;
const previousSyntheticActivityDataRoll = globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll;
const nimbusDamageRolls = [];
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async (activity, item, targets, options) => {
  nimbusDamageRolls.push({activity, item, targets, options});
  return {ok: true};
};
const holyCombat = {
  id: "HolyCombat",
  scene: auraScene,
  round: 1,
  turn: 0,
  combatants: new Map([["enemy-combatant", {token: enemyToken, tokenId: enemyToken.id}]])
};
const holyCurrent = {combatantId: "enemy-combatant", tokenId: enemyToken.id, round: 1, turn: 0};
await Promise.all([
  triggerHolyNimbusTurnStart(holyCombat, holyCurrent),
  triggerHolyNimbusTurnStart(holyCombat, holyCurrent)
]);
assert.equal(nimbusDamageRolls.length, 1, "Il doppio hook di inizio turno non deve duplicare Holy Nimbus");
assert.deepEqual(nimbusDamageRolls[0].targets, [enemyToken]);
assert.equal(nimbusDamageRolls[0].options.consumeUsage, false);

for (const marker of ["container", "groundLoot"]) {
  enemyToken.flags = {"khuzoe-merchant": {[marker]: {name: "Oggetto"}}};
  assert.equal(await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 101}), false,
    `Holy Nimbus must not damage a Merchant ${marker}`);
  delete enemyToken.flags;
  sourceToken.flags = {"khuzoe-merchant": {[marker]: {name: "Oggetto"}}};
  assert.equal(await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 102}), false,
    `A Merchant ${marker} cannot project Holy Nimbus`);
  delete sourceToken.flags;
}
assert.equal(nimbusDamageRolls.length, 1);
enemyToken.x = 30;
enemyToken.y = 30;
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 2});
assert.equal(nimbusDamageRolls.length, 1, "Holy Nimbus non colpisce un nemico esterno al cerchio in diagonale");
enemyToken.x = 25;
enemyToken.y = 15;
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 3});
assert.equal(nimbusDamageRolls.length, 2, "Holy Nimbus colpisce il nemico rientrato nel cerchio");

const additionalNimbus = {...holyFeature, uuid: "Actor.Other.Item.HolyNimbus"};
const additionalEffect = {...holyEffect, origin: additionalNimbus.uuid};
// Two eligible sources still represent the same named feature.
auraActor.items.push(additionalNimbus); auraActor.effects.push(additionalEffect);
globalThis.fromUuid = async uuid => [holyFeature, additionalNimbus].find(item => item.uuid === uuid);
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 4});
assert.equal(nimbusDamageRolls.length, 3, "Overlapping Holy Nimbus sources deal damage only once");
const successNimbusRoll = globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll;
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async () => ({aborted: true});
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 5});
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = successNimbusRoll;
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 5});
assert.equal(nimbusDamageRolls.length, 4, "Cancelled damage does not consume the target's turn stamp");
const distantLinkedPaladin = {...sourceToken, id: "distant-linked-paladin", x: 200, y: 0};
auraScene.tokens.unshift(distantLinkedPaladin);
await triggerHolyNimbusTurnStart(holyCombat, {...holyCurrent, round: 6});
assert.equal(nimbusDamageRolls.length, 5, "A distant linked token cannot hide the same paladin's nearby Holy Nimbus");
auraScene.tokens.shift();
auraActor.items = auraActor.items.filter(item => item !== additionalNimbus);
auraActor.effects = auraActor.effects.filter(effect => effect !== additionalEffect);

// Use the installed Auras geometry to compare actual damage with the displayed
// circle. Light and wall APIs must not decide who takes Holy Nimbus damage.
const savedNimbusCanvas = globalThis.canvas;
const savedNimbusAuras = game.khuzoeAuras;
const savedNimbusConfig = globalThis.CONFIG;
globalThis.CONFIG = {Canvas: {polygonBackends: {
  light: {testCollision() { assert.fail("Holy Nimbus must not test light-blocking walls"); }},
  sight: {testCollision() { assert.fail("Holy Nimbus must not test sight-blocking walls"); }}
}}};
let nimbusAuraCase = 0;
for (const metric of [false, true]) for (const rendererAvailable of [false, true]) {
  game.khuzoeAuras = rendererAvailable ? {geometry: auraGeometry} : undefined;
  const unit = metric ? 0.3048 : 1;
  const scene = {id: "NimbusAuraScene", grid: {size: 100, distance: 5 * unit, units: metric ? "m" : "ft"}};
  const source = {...sourceToken, parent: scene, x: 0, y: 0, width: 2, height: 2, elevation: 0};
  const target = {...enemyToken, parent: scene, width: 1, height: 1};
  scene.tokens = [source, target];
  globalThis.canvas = {scene, ready: true,
    get effects() { assert.fail("Holy Nimbus must work independently of rendered light sources"); }};
  const aura = paladinAuraVisuals(source).find(visual => visual.id === "khuzoe-paladin-holy-nimbus-visual");
  assert.equal(aura.area.distance, 30 * unit);
  assert.equal(aura.area.walls, false);
  const combat = {...holyCombat, id: "NimbusAuraCombat", scene,
    combatants: new Map([["enemy-combatant", {token: target, tokenId: target.id}]])};
  for (const [label, dx, dy, elevation, inside] of [
    ["inside circle", 600, 300, 0, true],
    ["exact edge", 700, 0, 0, true],
    ["just outside", 700.01, 0, 0, false],
    ["diagonally outside", 600, 400, 0, false],
    ["elevation inside", 500, 0, 20, true],
    ["elevation outside", 0, 0, 40, false]
  ]) for (const bright of [0, 120]) {
    source.light = {bright: bright * unit, dim: 2 * bright * unit};
    Object.assign(target, {x: 50 + dx, y: 50 + dy, elevation: elevation * unit});
    assert.equal(auraGeometry.isWithinAura(scene, source, target, aura), inside, label);
    const before = nimbusDamageRolls.length;
    const applied = await triggerHolyNimbusTurnStart(combat, {...holyCurrent, round: ++nimbusAuraCase});
    assert.equal(applied, inside, `${label}: damage follows the aura with light ${bright}, metric ${metric}, renderer ${rendererAvailable}`);
    assert.equal(nimbusDamageRolls.length - before, inside ? 1 : 0);
  }
}
globalThis.canvas = savedNimbusCanvas;
game.khuzoeAuras = savedNimbusAuras;
globalThis.CONFIG = savedNimbusConfig;
enemyToken.x = 5;
enemyToken.y = 0;
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = previousSyntheticActivityDataRoll;
auraActor.items = auraActor.items.filter(item => item !== holyFeature);
auraActor.effects = auraActor.effects.filter(effect => effect !== holyEffect);

// Tre ricalcoli simultanei simulano più Token trascinati insieme. Devono
// convergere a una sola coppia di effetti per attore e ripulire i residui JSON.
await Promise.all([
  reconcilePaladinAuras(auraScene),
  reconcilePaladinAuras(auraScene),
  reconcilePaladinAuras(auraScene)
]);
for (const actor of [auraActor, firstAlly, secondAlly]) {
  assert.equal(actor.effects.filter(effect => effect.flags?.["khuzoe-automations"]?.paladinAura?.identifier === PALADIN_IDS.auraProtection).length, 1);
  assert.equal(actor.effects.filter(effect => effect.flags?.["khuzoe-automations"]?.paladinAura?.identifier === PALADIN_IDS.auraCourage).length, 1);
}
assert.equal(enemy.effects.length, 0, "I nemici non devono ricevere le aure");
assert.equal(firstAlly.effects.length, 2, "Le tre copie importate devono convergere a un solo effetto per aura");
assert.equal(firstAlly.effects.some(effect => effect.flags?.cat?.auraEffect), false);
assert.equal(firstAlly.effects.some(effect => effect.flags?.["chris-premades"]?.aura), false);
assert.ok(auraDeleteBatches.some(ids => ids.length === 2), "I duplicati preesistenti devono essere rimossi in un'unica operazione");

// Keep excluded actors in the cleanup pass: an old buff must disappear too.
for (const marker of ["container", "groundLoot", "groundLootProxy"]) {
  const objectActor = makeAuraActor(`object-${marker}`, "Oggetto Merchant");
  const objectToken = {...firstToken, id: `object-${marker}`, actor: objectActor};
  const unrelated = {id: "unrelated", name: "Unrelated effect", flags: {}};
  objectActor.effects.push({...structuredClone(duplicateCatProtection), parent: objectActor}, unrelated);
  if (marker === "groundLootProxy") objectActor.flags = {"khuzoe-merchant": {[marker]: true}};
  else objectToken.flags = {"khuzoe-merchant": {[marker]: {name: "Oggetto"}}};
  auraScene.tokens.push(objectToken);
  await reconcilePaladinAuras(auraScene);
  assert.deepEqual(objectActor.effects, [unrelated], `${marker}: remove only the stale aura and grant no new buff`);
  auraScene.tokens.pop();
}
// A merchant who is a creature remains eligible, even if another token using
// the same Actor is marked as a container.
firstAlly.flags = {"khuzoe-merchant": {enabled: true}};
const linkedObject = {...firstToken, id: "linked-container", flags: {"khuzoe-merchant": {container: {}}}};
auraScene.tokens.push(linkedObject);
await reconcilePaladinAuras(auraScene);
assert.equal(firstAlly.effects.length, 2, "A real merchant still receives both paladin auras");
delete firstAlly.flags;
auraScene.tokens.pop();

// Foundry v14 può mantenere l'oggetto grafico sulla posizione precedente
// mentre il TokenDocument contiene già quella definitiva. La distanza non
// deve quindi dipendere dall'oggetto animato.
const canvasWithoutGrid = globalThis.canvas;
const documentScene = {id: "DocumentScene", grid: {size: 100, distance: 5, units: "ft"}, dimensions: {size: 100, distance: 5}};
globalThis.canvas = {
  ...canvasWithoutGrid,
  dimensions: documentScene.dimensions,
  grid: {
    getCenterPoint: point => point,
    measurePath: ([from, to]) => ({
      distance: Math.hypot(
        from.x - to.x,
        from.y - to.y,
        ((from.elevation ?? 0) - (to.elevation ?? 0)) / 5 * 100
      ) / 100 * 5
    })
  }
};
const authoritativeSource = {
  id: "authoritative-source",
  parent: documentScene,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  elevation: 0,
  object: {document: {x: 900, y: 900}}
};
const authoritativeTarget = {
  id: "authoritative-target",
  parent: documentScene,
  x: 200,
  y: 0,
  width: 1,
  height: 1,
  elevation: 0,
  object: {document: {x: 900, y: 900}}
};
assert.equal(paladinAuraTokenDistance(authoritativeSource, authoritativeTarget), 7.5);
authoritativeTarget.x = 700;
assert.equal(paladinAuraTokenDistance(authoritativeSource, authoritativeTarget), 32.5);
authoritativeTarget.x = 200;
authoritativeTarget.width = 2;
assert.equal(
  paladinAuraTokenDistance(authoritativeSource, authoritativeTarget),
  10,
  "Anche per i token grandi conta il centro rispetto al bordo circolare della sorgente"
);
globalThis.canvas = canvasWithoutGrid;

const firstProtection = firstAlly.effects.find(effect => effect.flags?.["khuzoe-automations"]?.paladinAura?.identifier === PALADIN_IDS.auraProtection);
assert.equal(firstProtection.showIcon, 2);
assert.ok(firstProtection.system.changes.some(change => (
  change.key === "system.bonuses.abilities.save" && change.value === "4"
)));
const firstCourage = firstAlly.effects.find(effect => effect.flags?.["khuzoe-automations"]?.paladinAura?.identifier === PALADIN_IDS.auraCourage);
assert.equal(firstCourage.showIcon, 0);
const stableMutationCounts = {
  creates: auraCreates,
  deletes: auraDeleteBatches.length,
  updates: auraUpdates.length
};
await reconcilePaladinAuras(auraScene);
assert.deepEqual(
  {creates: auraCreates, deletes: auraDeleteBatches.length, updates: auraUpdates.length},
  stableMutationCounts,
  "Un ricalcolo senza cambiamenti non deve togliere, ricreare o aggiornare gli effetti"
);

// Regressione: la distanza CAT/griglia è 10, ma il centro è fuori dal cerchio.
firstToken.x = 10;
firstToken.y = 10;
assert.equal(globalThis.cat.utils.tokenUtils.getDistance(sourceToken, firstToken), 10);
await reconcilePaladinAuras(auraScene);
assert.equal(firstAlly.effects.length, 0, "Uscire dal cerchio in diagonale rimuove entrambi i buff");
assert.equal(secondAlly.effects.length, 2, "L'alleato rimasto nel cerchio conserva i buff");
firstToken.x = 8;
firstToken.y = 6;
await reconcilePaladinAuras(auraScene);
assert.equal(firstAlly.effects.length, 2, "Rientrare nel cerchio riapplica entrambi i buff una sola volta");
firstToken.y = 0;

// Uscite simultanee dal raggio non devono produrre rimozioni duplicate.
firstToken.x = 40;
secondToken.x = 45;
await Promise.all([
  reconcilePaladinAuras(auraScene),
  reconcilePaladinAuras(auraScene),
  reconcilePaladinAuras(auraScene)
]);
assert.equal(firstAlly.effects.length, 0);
assert.equal(secondAlly.effects.length, 0);

// Se la fonte perde coscienza (qui tramite 0 PF), l'aura viene rimossa anche
// dal Paladino; al ripristino usa immediatamente il nuovo Carisma.
auraActor.system.attributes.hp.value = 0;
await reconcilePaladinAuras(auraScene);
assert.equal(auraActor.effects.length, 0);
auraActor.system.attributes.hp.value = 20;
auraActor.system.abilities.cha.mod = 5;
firstToken.x = 5;
await reconcilePaladinAuras(auraScene);
const restoredProtection = firstAlly.effects.find(effect => effect.flags?.["khuzoe-automations"]?.paladinAura?.identifier === PALADIN_IDS.auraProtection);
assert.ok(restoredProtection.system.changes.some(change => change.value === "5"));

for (const [origin, expected] of [
  ["Actor.Paladin.Item.Protection", 2],
  ["Actor.Paladin.Item.Courage", 0],
  ["Actor.Paladin.Item.Devotion", 0]
]) {
  let iconUpdate;
  const effect = {
    origin,
    name: "Aura",
    flags: {dae: {showIcon: true}},
    updateSource(changes) { iconUpdate = changes; }
  };
  assert.equal(paladinAuraIconVisibility(effect), expected);
  assert.equal(preparePaladinAuraEffectIcon(effect), true);
  assert.equal(iconUpdate.showIcon, expected);
  assert.equal(iconUpdate["flags.dae.-=showIcon"], null);
  assert.equal(iconUpdate["flags.dae.showIcon"], undefined);
}

globalThis.game.user.isGM = false;

assert.equal(getPaladinLevel({classes: {paladin: {system: {levels: 18}}}}), 18);
assert.equal(paladinAuraDistance({classes: {paladin: {system: {levels: 17}}}}), 10);
assert.equal(paladinAuraDistance({classes: {paladin: {system: {levels: 18}}}}), 30);

const layAutomationUpdate = {
  img: "source.webp",
  system: {identifier: PALADIN_IDS.layOnHands, uses: {max: "5", spent: 0, recovery: []}},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
preparePaladinItemUpdate({
  img: "custom.webp",
  actor: {classes: {paladin: {system: {levels: 5}}}},
  system: {identifier: PALADIN_IDS.layOnHands, uses: {max: "20", spent: 6}}
}, layAutomationUpdate);
assert.equal(layAutomationUpdate.img, "custom.webp");
assert.equal(layAutomationUpdate.system.uses.max, "25");
assert.equal(layAutomationUpdate.system.uses.spent, 6);

const auraAutomationUpdate = {
  system: {identifier: PALADIN_IDS.auraProtection},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
preparePaladinItemUpdate({
  actor: {classes: {paladin: {system: {levels: 18}}}},
  system: {identifier: PALADIN_IDS.auraProtection}
}, auraAutomationUpdate);
assert.equal(auraAutomationUpdate.flags.cat.config[PALADIN_AURA_DISTANCE_FLAG], 30);

console.log("Khuzoe Automations Paladino 2014: Lay on Hands, Divine Smite e aure OK");
