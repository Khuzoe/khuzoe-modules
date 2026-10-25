import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {
  HOME_BREW_NPC_AUTOMATIONS,
  NPC_AURA_IDS,
  NPC_IDS,
  ensureHomebrewNpcAuras,
  prepareHomebrewNpcItemUpdate,
  registerHomebrewNpcs,
  resetEncouragingDanceReaction,
  resolveQueuedNpcDamageTransfers,
  useSpiritualProtector
} from "../scripts/homebrew-npcs.mjs";

assert.equal(HOME_BREW_NPC_AUTOMATIONS.length, 15);
assert.ok(!HOME_BREW_NPC_AUTOMATIONS.some(entry => entry.identifier === "bend-the-spoon"));
assert.ok(HOME_BREW_NPC_AUTOMATIONS.every(entry => /^[A-Za-z0-9]{16}$/.test(entry.uuid.split(".").at(-1))));

const registrations = {automations: [], macros: []};
const api = {
  registerAutomation(data) {
    registrations.automations.push(data);
    return true;
  },
  registerFnMacro(data) {
    registrations.macros.push(data);
    return true;
  }
};
const result = registerHomebrewNpcs(api);
assert.equal(result.automations.length, 15);
assert.equal(result.macros.length, 18);
assert.ok(registrations.macros.find(data => data.identifier === NPC_IDS.nanissDance)?.roll?.some(entry => entry.pass === "sceneOptionalBonusAttack"));
assert.deepEqual(registrations.macros.find(data => data.identifier === NPC_IDS.spiritProtector)?.roll, []);
assert.ok(!registrations.macros.some(data => data.roll?.some(entry => entry.pass === "sceneDamageFlatReductions")));
assert.ok(registrations.macros.find(data => data.identifier === NPC_IDS.impenetrableEgo)?.save?.some(entry => entry.pass === "actorBonus"));

const originalSystem = {
  identifier: NPC_IDS.psychicRanged,
  source: {rules: "2014"},
  range: {value: 5, units: "ft"},
  activities: {
    attack: {
      _id: "1234567890ABCDEF",
      attack: {type: {value: "melee", classification: "spell"}},
      range: {units: "self", override: false}
    }
  }
};
const originalFlags = {"cripta-wiki-sync": {transferId: "keep-me"}, cat: {automation: {source: "old"}}};
const item = {
  system: originalSystem,
  toObject: () => ({
    name: "Psychic Strike (Ranged)",
    img: "strike.webp",
    system: structuredClone(originalSystem),
    effects: [{_id: "ExistingEffect01"}],
    flags: structuredClone(originalFlags)
  })
};
const changes = {
  system: {identifier: NPC_IDS.psychicRanged},
  flags: {cat: {automation: {source: "khuzoe-automations", version: "0.1.0"}, macros: {roll: [{}]}}}
};
prepareHomebrewNpcItemUpdate(item, changes);
assert.equal(changes.name, "Psychic Strike (Ranged)");
assert.equal(changes.img, "strike.webp");
assert.equal(changes.flags["cripta-wiki-sync"].transferId, "keep-me");
assert.equal(changes.flags.cat.automation.source, "khuzoe-automations");
assert.equal(changes.system.range.value, 60);
assert.equal(changes.system.activities.attack.attack.type.value, "ranged");
assert.equal(changes.system.activities.attack.range.value, "60");
assert.equal(changes.effects[0]._id, "ExistingEffect01");

const danceSystem = {
  identifier: NPC_IDS.nanissDance,
  activities: {
    dance: {
      _id: "DanceActivity001",
      activation: {type: "reaction", value: 1, condition: "", override: false}
    }
  }
};
const danceItem = {
  system: danceSystem,
  toObject: () => ({
    name: "Danza Incoraggiante",
    img: "dance.webp",
    system: structuredClone(danceSystem),
    effects: [],
    flags: {}
  })
};
const danceChanges = {
  system: {identifier: NPC_IDS.nanissDance},
  flags: {cat: {automation: {source: "khuzoe-automations", version: "0.1.1"}}}
};
prepareHomebrewNpcItemUpdate(danceItem, danceChanges);
assert.equal(danceChanges.system.activities.dance.activation.type, "special");
assert.equal(danceChanges.system.activities.dance.activation.value, null);
assert.equal(danceChanges.system.activities.dance.activation.override, true);

let installedAuras = null;
let spiritAuraEligible = false;
let lastEligibilityCheck = null;
const auraApi = {
  getAuraSources() { return []; },
  getEligibleTargets() { return []; },
  isTargetEligible(source, target, auraId) {
    lastEligibilityCheck = {source, target, auraId};
    return spiritAuraEligible;
  },
  getAura() { return null; },
  getAuras() { return []; },
  async setAuras(_token, auras) { installedAuras = auras; }
};
globalThis.game = {
  khuzoeAuras: auraApi,
  user: {isGM: true, id: "tester"}
};
globalThis.canvas = {scene: {id: "scene", tokens: []}};
globalThis.ui = {notifications: {warn() {}}};
const token = {
  documentName: "Token",
  id: "token",
  actor: {items: [{system: {identifier: NPC_IDS.nanissAura}}]}
};
await ensureHomebrewNpcAuras(token);
assert.equal(installedAuras.length, 1);
assert.equal(installedAuras[0].id, NPC_AURA_IDS.naniss);
assert.deepEqual(installedAuras[0].triggers.map(trigger => trigger.event), ["turnStart", "turnEnd"]);
assert.equal(installedAuras[0].actions[0].formula, "1d6");
assert.equal(installedAuras[0].visual.color, "#58c987");
assert.equal(installedAuras[0].visual.opacity, 0.075);
assert.equal(installedAuras[0].visual.lineOpacity, 0.48);
assert.equal(installedAuras[0].visual.lineWidth, 1.5);

const existingAura = {
  ...structuredClone(installedAuras[0]),
  area: {...installedAuras[0].area, distance: 20, elevation: true},
  triggers: [{event: "manual", subject: "source", frequency: "oncePerPhase"}],
  actions: [{...installedAuras[0].actions[0], formula: "2d6"}],
  visual: {...installedAuras[0].visual, color: "#f0bf4a", opacity: 0.1}
};
auraApi.getAura = () => existingAura;
auraApi.getAuras = () => [existingAura];
installedAuras = null;
await ensureHomebrewNpcAuras(token);
assert.equal(installedAuras[0].area.distance, 20, "La riconciliazione conserva il raggio configurato");
assert.equal(installedAuras[0].area.elevation, true);
assert.equal(installedAuras[0].visual.color, "#58c987");
assert.equal(installedAuras[0].visual.opacity, 0.075);
assert.equal(installedAuras[0].visual.lineOpacity, 0.48);
assert.equal(installedAuras[0].visual.lineWidth, 1.5);
assert.deepEqual(installedAuras[0].triggers.map(trigger => `${trigger.event}:${trigger.subject}`), [
  "turnStart:affected",
  "turnEnd:affected"
]);
assert.equal(installedAuras[0].actions[0].type, "healing");
assert.equal(installedAuras[0].actions[0].formula, "1d6");

const scene = globalThis.canvas.scene;
const spiritHp = {value: 20, temp: 5};
const spiritActor = {
  id: "spirit-actor",
  uuid: "Actor.spirit-actor",
  name: "Spirito Elementale Fatato",
  statuses: new Set(),
  system: {attributes: {hp: spiritHp}},
  getActiveTokens: () => [spiritToken],
  async applyDamage(amount) {
    const tempDamage = Math.min(this.system.attributes.hp.temp, amount);
    this.system.attributes.hp.temp -= tempDamage;
    this.system.attributes.hp.value -= Math.min(this.system.attributes.hp.value, amount - tempDamage);
  }
};
const protectedActor = {
  id: "protected-actor",
  uuid: "Actor.protected-actor",
  name: "Alleato",
  system: {attributes: {hp: {value: 30, temp: 0}}},
  async applyDamage(amount) {
    const hp = this.system.attributes.hp;
    const tempDamage = Math.min(hp.temp, amount);
    hp.temp -= tempDamage;
    hp.value -= Math.min(hp.value, amount - tempDamage);
  }
};
const spiritToken = {
  documentName: "Token",
  id: "spirit-token",
  uuid: "Scene.scene.Token.spirit-token",
  parent: scene,
  disposition: 1,
  actor: spiritActor
};
const protectedToken = {
  documentName: "Token",
  id: "protected-token",
  uuid: "Scene.scene.Token.protected-token",
  name: "Alleato",
  parent: scene,
  disposition: 1,
  actor: protectedActor
};
scene.tokens = [spiritToken, protectedToken];

let confirmResult = false;
let confirmCalls = 0;
let reactionsUsed = 0;
globalThis.cat = {
  utils: {
    actorUtils: {hasUsedReaction: () => false},
    tokenUtils: {isAlly: (source, target) => source.disposition === target.disposition},
    queryUtils: {firstOwner: () => "tester"},
    dialogUtils: {
      async confirm() {
        confirmCalls += 1;
        return confirmResult;
      }
    },
    workflowUtils: {
      negateDamageItemDamage(ditem) {
        ditem.totalDamage = 0;
        ditem.hpDamage = 0;
        ditem.tempDamage = 0;
      }
    },
    documentUtils: {async update() {}}
  }
};
globalThis.MidiQOL = {async setReactionUsed() { reactionsUsed += 1; }};
const protectorItem = {
  documentName: "Item",
  name: "Protettore Spirituale",
  uuid: "Actor.spirit-actor.Item.protector",
  actor: spiritActor
};

registerDocuments(protectorItem, protectedActor);
let failNextTransfer = false;
globalThis.cat.utils.itemUtils = {syntheticItem: (data, actor) => ({...data, actor})};
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async (activity, item, targets) => {
  if (failNextTransfer && targets[0].actor === spiritActor) { failNextTransfer = false; return {aborted: true}; }
  if (activity.type === "heal") {
    await cat.utils.queryUtils.query("update", cat.utils.queryUtils.gmUser(), {updates: {"system.attributes.hp.value": targets[0].actor.system.attributes.hp.value + Number(activity.healing.custom.formula)}});
  } else await targets[0].actor.applyDamage(Number(activity.damage.parts[0].custom.formula));
  return {id: "resolved"};
};
globalThis.MidiQOL.removeReactionUsed = async () => {};
// Fuori dall'aura personale dello Spirito non deve neppure apparire il dialogo.
spiritAuraEligible = false;
let damageItem = {totalDamage: 7, hpDamage: 7, tempDamage: 0};
assert.equal(await useSpiritualProtector({workflow: {}, document: protectorItem, ditem: damageItem, targetToken: protectedToken}), false);
assert.equal(confirmCalls, 0);
assert.equal(damageItem.hpDamage, 7);
assert.equal(lastEligibilityCheck.source, spiritToken);
assert.equal(lastEligibilityCheck.target, protectedToken);
assert.equal(lastEligibilityCheck.auraId, NPC_AURA_IDS.spirit);

// Premendo No il damage item originale deve rimanere completamente intatto.
spiritAuraEligible = true;
confirmResult = false;
damageItem = {totalDamage: 7, hpDamage: 7, tempDamage: 0};
assert.equal(await useSpiritualProtector({workflow: {}, document: protectorItem, ditem: damageItem, targetToken: protectedToken}), false);
assert.deepEqual(damageItem, {totalDamage: 7, hpDamage: 7, tempDamage: 0});
assert.deepEqual(spiritHp, {value: 20, temp: 5});
assert.equal(reactionsUsed, 0);

// Premendo Sì azzera il danno sul bersaglio e consuma la reazione; l'update PF
// dello Spirito viene differito fino a RollComplete, quando Midi-QOL non può
// più sovrascriverlo.
confirmResult = true;
damageItem = {totalDamage: 7, hpDamage: 7, tempDamage: 0};
const acceptedWorkflow = {};
assert.equal(await useSpiritualProtector({workflow: acceptedWorkflow, document: protectorItem, ditem: damageItem, targetToken: protectedToken}), true);
assert.deepEqual(spiritHp, {value: 20, temp: 5});
assert.deepEqual(damageItem, {totalDamage: 0, hpDamage: 0, tempDamage: 0});
assert.equal(reactionsUsed, 1);
await resolveQueuedNpcDamageTransfers({workflow: acceptedWorkflow});
assert.deepEqual(spiritHp, {value: 18, temp: 0});
assert.deepEqual(damageItem, {totalDamage: 0, hpDamage: 0, tempDamage: 0});
assert.equal(reactionsUsed, 1);

// Se Foundry non applica realmente i PF allo Spirito, non deve mai perdere il
// danno originale né consumare una seconda reazione.
const workingApplyDamage = spiritActor.applyDamage;
failNextTransfer = true;
damageItem = {totalDamage: 4, hpDamage: 4, tempDamage: 0};
const failedWorkflow = {};
assert.equal(await useSpiritualProtector({workflow: failedWorkflow, document: protectorItem, ditem: damageItem, targetToken: protectedToken}), true);
assert.deepEqual(damageItem, {totalDamage: 0, hpDamage: 0, tempDamage: 0});
assert.equal(reactionsUsed, 2);
await resolveQueuedNpcDamageTransfers({workflow: failedWorkflow});
assert.deepEqual(protectedActor.system.attributes.hp, {value: 26, temp: 0});
spiritActor.applyDamage = workingApplyDamage;

// Due Colpi Purificanti usati singolarmente nello stesso turno e sullo stesso
// bersaglio devono attivare una sola volta il TS su Costituzione CD 16.
let purifyingSaveCalls = 0;
let purifyingSaveArguments = null;
const purifyingMessages = [];
const purifyingTargetActor = {
  id: "purifying-target-actor",
  uuid: "Actor.purifying-target-actor",
  async rollSavingThrow(...args) {
    purifyingSaveCalls += 1;
    purifyingSaveArguments = args;
    return [{total: 18}];
  }
};
const purifyingTarget = {
  id: "purifying-target",
  uuid: "Scene.scene.Token.purifying-target",
  name: "Bersaglio",
  actor: purifyingTargetActor
};
const healedActor = {
  id: "healed-actor",
  uuid: "Actor.healed-actor",
  system: {attributes: {hp: {value: 10, max: 30}}}
};
const healedToken = {
  id: "healed-token",
  uuid: "Scene.scene.Token.healed-token",
  name: "Alleato curato",
  actor: healedActor
};
const purifyingSourceActor = {id: "naniss-actor", uuid: "Actor.naniss-actor"};
const purifyingSourceToken = {id: "naniss-token", actor: purifyingSourceActor};
const purifyingStrike = {
  documentName: "Item",
  name: "Colpo Purificante",
  uuid: "Actor.naniss-actor.Item.purifying",
  system: {identifier: NPC_IDS.purifyingStrike},
  actor: purifyingSourceActor
};
auraApi.getAuraSources = (_scene, auraId) => auraId === NPC_AURA_IDS.naniss
  ? [{token: purifyingSourceToken, aura: {id: auraId}}]
  : [];
auraApi.getEligibleTargets = () => [healedToken];
globalThis.game.combat = {started: true, id: "purifying-combat", round: 1, turn: 2};
globalThis.ChatMessage = {
  getSpeaker: ({actor}) => ({actor: actor?.id}),
  async create(data) { purifyingMessages.push(data); }
};
let purifyingRemoteUpdates = 0;
const purifyingGm = {id: "gm", query() {}};
globalThis.cat.utils.queryUtils = {
  firstOwner: () => "tester",
  hasPermission: () => false,
  gmUser: () => purifyingGm,
  async query(name, user, data) {
    assert.equal(name, "update");
    assert.equal(user, purifyingGm, "Il percorso remoto deve ricevere l'oggetto User, non il solo ID");
    if (Object.hasOwn(data.updates, "system.attributes.hp.value")) {
      healedActor.system.attributes.hp.value = data.updates["system.attributes.hp.value"];
    }
    purifyingRemoteUpdates += 1;
    return healedActor.uuid;
  }
};
globalThis.fromUuid = async uuid => uuid === healedActor.uuid ? healedActor : null;
globalThis.cat.utils.documentUtils.update = async () => {
  throw new Error("Il fallback CAT 0.0.7 non deve essere usato quando il target non è posseduto.");
};
const purifyingMacro = registrations.macros
  .find(data => data.identifier === NPC_IDS.purifyingStrike)
  .roll.find(entry => entry.pass === "itemRollFinished").macro;
const purifyingWorkflow = damage => ({
  hitTargets: new Set([purifyingTarget]),
  damageList: [{tokenId: purifyingTarget.id, hpDamage: damage, tempDamage: 0}]
});
await purifyingMacro({workflow: purifyingWorkflow(4), document: purifyingStrike});
assert.equal(purifyingSaveCalls, 0);
await purifyingMacro({workflow: purifyingWorkflow(5), document: purifyingStrike});
assert.equal(purifyingSaveCalls, 1);
assert.equal(purifyingSaveArguments[0].ability, "con");
assert.equal(purifyingSaveArguments[1].target, 16);
assert.equal(purifyingSaveArguments[2].create, true);
assert.ok(purifyingMessages.some(message => message.content.includes("TS Costituzione CD 16")));
assert.equal(purifyingRemoteUpdates, 4, "Due cure e due aggiornamenti dei contatori persistenti");

// All'inizio del turno di Na'Niss devono essere azzerati sia il marker Khuzoe
// sia lo stato reazione di Midi-QOL, altrimenti il bonus compare una sola volta.
let danceResetUpdate = null;
let midiReactionReset = null;
let deletedDanceEffect = null;
let deletedDanceEffectCalls = 0;
const danceSpentEffect = {
  id: "dance-spent",
  flags: {cat: {identifier: "khuzoe-naniss-dance-spent"}}
};
const nanissActor = {
  items: [{system: {identifier: NPC_IDS.nanissDance}}],
  effects: [danceSpentEffect],
  flags: {"khuzoe-automations": {nanissDanceReaction: {combatId: "combat", round: 2}}}
};
const nanissToken = {actor: nanissActor};
globalThis.game.user.isActiveGM = true;
globalThis.cat.utils.documentUtils.update = async (document, update) => {
  danceResetUpdate = {document, update};
};
globalThis.cat.utils.documentUtils.deleteDocument = async effect => {
  deletedDanceEffectCalls += 1;
  deletedDanceEffect = effect;
};
globalThis.MidiQOL.setReactionUsed = async (actor, active) => {
  midiReactionReset = {actor, active};
};
const danceCombat = {scene: {tokens: new Map([["naniss", nanissToken]])}};
assert.deepEqual(await Promise.all([
  resetEncouragingDanceReaction(danceCombat, {tokenId: "naniss"}),
  resetEncouragingDanceReaction(danceCombat, {tokenId: "naniss"})
]), [true, true]);
assert.equal(danceResetUpdate.document, nanissActor);
assert.ok(Object.hasOwn(danceResetUpdate.update, "flags.khuzoe-automations.-=nanissDanceReaction"));
assert.equal(danceResetUpdate.update["flags.midi-qol.actions.reactionsUsed"], 0);
assert.equal(danceResetUpdate.update["flags.midi-qol.actions.reaction"], false);
assert.ok(Object.hasOwn(danceResetUpdate.update, "flags.midi-qol.actions.-=reactionCombatRound"));
assert.deepEqual(midiReactionReset, {actor: nanissActor, active: false});
assert.equal(deletedDanceEffect, danceSpentEffect);
assert.equal(deletedDanceEffectCalls, 1);

console.log("Khuzoe Automations homebrew NPC workflows: OK");
