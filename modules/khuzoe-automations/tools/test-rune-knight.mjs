import {RELEASE_VERSION} from "../scripts/release.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

const onceHooks = new Map();
const onHooks = new Map();
const automations = [];
const macros = [];
const runtimeSource = await readFile(new URL("../scripts/rune-knight.mjs", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../scripts/main.mjs", import.meta.url), "utf8");

assert.doesNotMatch(runtimeSource, /duration\s*:\s*\{\s*seconds\s*:/, "Rimasta una durata ActiveEffect legacy");
assert.doesNotMatch(runtimeSource, /saveRemove=|rollMode=publicroll/, "Rimasta una sintassi OverTime legacy");
assert.doesNotMatch(runtimeSource, /workflowUtils\.syntheticActivityRoll\(/,
  "Le attività tecniche rider non devono essere eseguite direttamente in Foundry v14");
for (const runtimeId of ["KhzRKCloudRt0001", "KhzRKFireRt00001", "KhzRKStoneRt0001", "KhzRKShldRt00001"])
  assert.equal(runtimeId.length, 16, `ID runtime non valido: ${runtimeId}`);
assert.match(runtimeSource, /saveCount=1-/, "La rimozione al primo TS riuscito non è configurata");
for (const functionName of ["triggerStoneRune", "redirectCloudRune", "useRunicShield"]) {
  const body = runtimeSource.match(new RegExp(`async function ${functionName}\\([\\s\\S]*?\\n}`))?.[0] ?? "";
  assert.match(body, /await useReaction\(ownerActor\)/, `${functionName}: la reazione non viene consumata`);
}
assert.equal(runtimeSource.match(/timedDuration\(60\)/g)?.length, 5, "Numero errato di effetti da 1 minuto");
assert.equal(runtimeSource.match(/timedDuration\(600\)/g)?.length, 1, "Durata Frost Rune errata");
assert.match(mainSource, /!options\?\.khuzoeGiantsMightRefresh/,
  "Il rinnovo di Giant's Might deve sopprimere il ripristino intermedio del token");

globalThis.Hooks = {
  once(name, callback) { onceHooks.set(name, callback); },
  on(name, callback) { onHooks.set(name, callback); }
};

globalThis.game = {
  modules: new Map([["khuzoe-automations", {active: true}]]),
  user: {id: "gm", isGM: true},
  users: [],
  actors: []
};

globalThis.ui = {notifications: {error() {}, info() {}, warn() {}}};
globalThis.document = {
  createElement() {
    return {innerHTML: "", set textContent(value) { this.innerHTML = String(value); }};
  }
};
globalThis.CONFIG = {
  DND5E: {
    actorSizes: {lg: {token: 2}, huge: {token: 3}, grg: {token: 4}},
    skills: {},
    tools: {}
  }
};
globalThis.foundry = {
  utils: {
    getProperty(object, path) {
      return path.split(".").reduce((value, key) => value?.[key], object);
    },
    setProperty(object, path, value) {
      const keys = path.split(".");
      const last = keys.pop();
      const parent = keys.reduce((current, key) => current[key] ??= {}, object);
      parent[last] = value;
      return true;
    },
    deepClone(value) { return structuredClone(value); },
    isNewerVersion(a, b) { return a > b; }
  },
  applications: {api: {DialogV2: {}}}
};

globalThis.cat = {
  api: {
    registerSourceName() {},
    registerAutomation(data) { automations.push(data); return true; },
    registerFnMacro(data) { macros.push(data); return data; }
  },
  utils: {}
};

await import("../scripts/main.mjs");
onceHooks.get("catReady")();
const {isFriendlyToken, reconcileAllRuneUses, resolveGiantsMightConfig} = await import("../scripts/rune-knight.mjs");

globalThis.CONST = {TOKEN_DISPOSITIONS: {HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1}};
assert.equal(isFriendlyToken({disposition: 1}), true);
assert.equal(isFriendlyToken({disposition: 0}), false);
assert.equal(isFriendlyToken({disposition: -1}), false);
assert.equal(isFriendlyToken({document: {disposition: 1}}), true);

assert.deepEqual(resolveGiantsMightConfig(), {baseSize: "lg", juggernautSize: "huge"});
assert.deepEqual(
  resolveGiantsMightConfig({baseSize: "huge", juggernautSize: "grg"}),
  {baseSize: "huge", juggernautSize: "grg"}
);
assert.deepEqual(
  resolveGiantsMightConfig({baseSize: "invalid", juggernautSize: "invalid"}),
  {baseSize: "lg", juggernautSize: "huge"}
);

const expected = new Set([
  "giants-might", "cloud-rune", "fire-rune", "frost-rune", "hill-rune", "stone-rune",
  "storm-rune", "runic-shield", "great-stature", "master-of-runes", "runic-juggernaut"
]);
const registered = new Set(automations.filter(entry => entry.source === "khuzoe-automations").map(entry => entry.identifier));
for (const identifier of expected) assert.ok(registered.has(identifier), `Automazione mancante: ${identifier}`);

const byIdentifier = identifier => macros.find(entry => entry.identifier === identifier);
assert.ok(byIdentifier("cloud-rune").roll.some(entry => entry.pass === "sceneAttackRollComplete"));
assert.ok(byIdentifier("stone-rune").combat.some(entry => entry.pass === "sceneTurnEnd"));
assert.ok(byIdentifier("storm-rune-active").roll.some(entry => entry.pass === "sceneAttackRollConfig"));
for (const type of ["save", "check", "skill", "tool"]) {
  assert.ok(byIdentifier("storm-rune-active")[type].some(entry => entry.pass === "sceneSituational"),
    `Storm Rune: pass ${type} non applicato direttamente al tiro`);
  assert.ok(!byIdentifier("storm-rune-active")[type].some(entry => entry.pass === "sceneContext"),
    `Storm Rune: ${type} richiederebbe una seconda conferma al tiratore`);
}
assert.ok(byIdentifier("runic-shield").roll.some(entry => entry.pass === "sceneAttackRollComplete"));
assert.ok(byIdentifier("giants-might-active").roll.some(entry => entry.pass === "actorDamageRollBonuses"));
assert.ok(byIdentifier("cloud-rune").roll.find(entry => entry.pass === "sceneAttackRollComplete").canOverlap);
assert.ok(byIdentifier("runic-shield").roll.find(entry => entry.pass === "sceneAttackRollComplete").canOverlap);

const packDirectory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
const sourceFiles = (await readdir(packDirectory)).filter(file => file.endsWith(".json"));
const runeDocuments = [];
for (const file of sourceFiles) {
  const data = JSON.parse(await readFile(new URL(file, packDirectory), "utf8"));
  if (!expected.has(data.system?.identifier)) continue;
  runeDocuments.push(data);
  assert.equal(data._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(data.system.source.rules, "2014");
  assert.equal(data.flags.cat.automation.source, "khuzoe-automations");
  assert.equal(data.flags.cat.automation.version, RELEASE_VERSION);
  for (const activity of Object.values(data.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
  for (const effect of data.effects ?? []) {
    assert.equal(effect._id.length, 16, `${file}: ID effetto non valido`);
    assert.equal(effect._key, `!items.effects!${data._id}.${effect._id}`);
  }
}
assert.equal(runeDocuments.length, 11);

const runeDocument = identifier => runeDocuments.find(item => item.system.identifier === identifier);
const activity = (item, activityId) => item.system.activities[activityId];
const assertActivityDuration = (identifier, activityId, value, units) => {
  const duration = activity(runeDocument(identifier), activityId).duration;
  assert.equal(duration.value, value, `${identifier}: valore durata attività errato`);
  assert.equal(duration.units, units, `${identifier}: unità durata attività errata`);
};
const assertRecovery = (identifier, period) => {
  assert.deepEqual(runeDocument(identifier).system.uses.recovery, [{period, type: "recoverAll"}],
    `${identifier}: recupero utilizzi errato`);
};

assertActivityDuration("giants-might", "KhzRKGiantUse001", "1", "minute");
assertActivityDuration("frost-rune", "KhzRKFrostUse001", "10", "minute");
assertActivityDuration("hill-rune", "KhzRKHillUse0001", "1", "minute");
assertActivityDuration("storm-rune", "KhzRKStormUse001", "1", "minute");
for (const [identifier, activityId] of [
  ["cloud-rune", "KhzRKCloudUse001"],
  ["fire-rune", "KhzRKFireSave001"],
  ["stone-rune", "KhzRKStoneUse001"],
  ["runic-shield", "KhzRKShieldUse01"]
]) assertActivityDuration(identifier, activityId, "", "inst");

for (const identifier of ["cloud-rune", "fire-rune", "frost-rune", "hill-rune", "stone-rune", "storm-rune"])
  assertRecovery(identifier, "sr");
for (const identifier of ["giants-might", "runic-shield"]) assertRecovery(identifier, "lr");

for (const [identifier, activityId] of [
  ["giants-might", "KhzRKGiantUse001"],
  ["frost-rune", "KhzRKFrostUse001"],
  ["hill-rune", "KhzRKHillUse0001"],
  ["storm-rune", "KhzRKStormUse001"]
]) {
  assert.ok(!runeDocument(identifier).flags.dnd5e.riders.activity.includes(activityId),
    `${identifier}: l'attività pubblica non deve essere un rider`);
}
for (const [identifier, activityId] of [
  ["cloud-rune", "KhzRKCloudUse001"],
  ["fire-rune", "KhzRKFireSave001"],
  ["stone-rune", "KhzRKStoneUse001"],
  ["runic-shield", "KhzRKShieldUse01"]
]) {
  assert.ok(runeDocument(identifier).flags.dnd5e.riders.activity.includes(activityId),
    `${identifier}: l'attività tecnica deve restare un rider`);
  assert.equal(activity(runeDocument(identifier), activityId).flags.cat.hidden, true,
    `${identifier}: l'attività tecnica deve restare nascosta`);
}

for (const item of runeDocuments) {
  for (const effect of item.effects ?? []) {
    assert.equal(effect.duration.value, null, `${item.system.identifier}: effetto passivo con durata finita inattesa`);
    assert.equal(effect.duration.units, "seconds", `${item.system.identifier}: unità effetto passivo non v14`);
    assert.ok(effect.duration.expiry == null, `${item.system.identifier}: scadenza inattesa sull'effetto passivo`);
  }
}

const hillSource = runeDocument("hill-rune");
assert.ok(hillSource.effects[0].system.changes.some(change => change.key === "system.traits.dr.value" && change.value === "poison"));
const stoneSource = runeDocument("stone-rune");
assert.ok(stoneSource.effects[0].system.changes.some(change => change.key === "system.attributes.senses.ranges.darkvision"));
assert.ok(!JSON.stringify(stoneSource).includes("system.attributes.senses.darkvision\""));
const juggernaut = runeDocument("runic-juggernaut");
assert.match(juggernaut.system.description.value, /1d10/);
const fireSource = runeDocument("fire-rune");
assert.equal(Object.values(fireSource.system.activities)[0].activation.type, "special");
const stormSource = runeDocument("storm-rune");
assert.equal(stormSource.effects[0].flags.dae.disableIncapacitated, true);

let updatedUse;
let createdEffect;
let createdEffectsCount = 0;
let confirmationUserId;
let deletedEffectOptions;
let giantStampId;
const technicalRolls = [];
const reactionUsed = new Set();
const bonusDamageCalls = [];
let technicalRollResult = {failedSaves: new Set()};
globalThis.MidiQOL = {
  async setReactionUsed(actor, active = true) {
    if (active) reactionUsed.add(actor);
    else reactionUsed.delete(actor);
  },
  async removeReactionUsed(actor) { reactionUsed.delete(actor); },
  canSee() { return true; }
};
globalThis.cat.utils = {
  documentUtils: {
    async update(document, changes) {
      updatedUse = changes;
      if ("system.uses.spent" in changes && document?.system?.uses) {
        document.system.uses.spent = changes["system.uses.spent"];
      }
    },
    async deleteDocument(_effect, options) { deletedEffectOptions = options; }
  },
  effectUtils: {
    async createEffects(_actor, effects) {
      createdEffectsCount += 1;
      createdEffect = effects[0];
      return [{id: "effect"}];
    }
  },
  actorUtils: {
    getEffectByIdentifier() {},
    getSize() { return 2; },
    hasUsedReaction(actor) { return reactionUsed.has(actor); },
    checkTrait(actor, trait, value) { return actor?.system?.traits?.[trait]?.value?.has?.(value) ?? false; }
  },
  workflowUtils: {
    isAttackType() { return true; },
    async bonusDamage(workflow, formula, options) { bonusDamageCalls.push({workflow, formula, options}); },
    async syntheticActivityDataRoll(data, _item, targets) {
      technicalRolls.push({data, targets});
      return technicalRollResult;
    },
    async updateTargets(workflow, targets) { workflow.targets = new Set(targets); }
  },
  combatUtils: {
    isStampedThisTurn(_stamps, stampId) { giantStampId = stampId; return false; },
    addTurnStamp(stamps, stampId) { giantStampId = stampId; return stamps; },
    isOwnTurn() { return true; }
  },
  tokenUtils: {
    getCombatData() { return {inCombat: false}; },
    getDistance() { return 10; },
    isEnemy(source, target) { return Number(source.disposition) !== Number(target.disposition); }
  },
  rollUtils: {
    async addToRoll(roll, formula) { return {...roll, formula}; }
  },
  queryUtils: {firstOwner() { return "player-owner"; }}
};

for (const [feature, skills] of [
  ["cloud-rune", ["dec", "slt"]],
  ["frost-rune", ["ani", "itm"]],
  ["stone-rune", ["ins"]],
  ["storm-rune", ["arc"]]
]) {
  const macro = byIdentifier(feature).skill.find(entry => entry.pass === "actorSituational").macro;
  for (const skillId of skills) {
    const options = {};
    macro({skillId, options});
    assert.equal(options.advantage, true, `${feature}: vantaggio passivo mancante per ${skillId}`);
  }
}

const fireToolMacro = byIdentifier("fire-rune").tool.find(entry => entry.pass === "actorBonus").macro;
const toolActor = {
  system: {tools: {smith: {value: 1}}},
  getRollData() { return {prof: 3}; }
};
assert.equal((await fireToolMacro({actor: toolActor, toolId: "smith", roll: {total: 12}})).formula, "@prof");
assert.equal(await fireToolMacro({actor: toolActor, toolId: "unknown", roll: {total: 12}}), undefined);

const giantStrengthMacro = byIdentifier("giants-might-active").check.find(entry => entry.pass === "actorSituational").macro;
const strengthOptions = {};
giantStrengthMacro({checkId: "str", options: strengthOptions});
assert.equal(strengthOptions.advantage, true);
const dexterityOptions = {};
giantStrengthMacro({checkId: "dex", options: dexterityOptions});
assert.equal(dexterityOptions.advantage, undefined);

const cloudMacro = byIdentifier("cloud-rune").roll
  .find(entry => entry.pass === "sceneAttackRollComplete").macro;
const cloudActor = {
  id: "cloud-actor",
  statuses: new Set(),
  items: [],
  system: {attributes: {prof: 3}}
};
const cloudScene = {id: "cloud-scene", tokens: []};
const cloudOwner = {id: "cloud-owner", actor: cloudActor, parent: cloudScene, disposition: 1};
const cloudAttacker = {id: "cloud-attacker", actor: {id: "attacker"}, parent: cloudScene, disposition: -1};
const cloudTarget = {id: "cloud-target", name: "Ally", actor: {id: "ally"}, parent: cloudScene, disposition: 1};
cloudScene.tokens = [cloudOwner, cloudAttacker, cloudTarget];
const cloudItem = {
  id: "cloud-item",
  uuid: "Actor.cloud.Item.rune",
  documentName: "Item",
  name: "Cloud Rune",
  actor: cloudActor,
  system: {
    identifier: "cloud-rune",
    uses: {max: "1", spent: 0},
    activities: new Map([["KhzRKCloudUse001", {
      id: "KhzRKCloudUse001",
      toObject() {
        return {_id: "KhzRKCloudUse001", activation: {type: "reaction", value: 1}, flags: {cat: {hidden: true}}};
      }
    }]])
  }
};
let cloudPrompts = 0;
globalThis.cat.utils.actorUtils.getFirstToken = () => cloudOwner;
globalThis.cat.utils.tokenUtils.getDistance = () => 10;
globalThis.cat.utils.dialogUtils = {
  async selectTargetDialog() { cloudPrompts += 1; return null; },
  async confirm(_title, _content, options) {
    confirmationUserId = options?.userId;
    return true;
  }
};

cloudTarget.disposition = -1;
registerDocuments(cloudActor, cloudItem);
await cloudMacro({
  workflow: {attackRoll: {}, token: cloudAttacker, hitTargets: new Set([cloudTarget])},
  document: cloudItem
});
assert.equal(cloudPrompts, 0, "Cloud Rune non deve essere proposta per un bersaglio Hostile");

cloudTarget.disposition = 1;
const duplicateCloudWorkflow = {
  workflow: {attackRoll: {}, token: cloudAttacker, hitTargets: new Set([cloudTarget])},
  document: cloudItem
};
await cloudMacro(duplicateCloudWorkflow);
await cloudMacro(duplicateCloudWorkflow);
assert.equal(cloudPrompts, 1, "Cloud Rune deve essere proposta per un bersaglio Friendly");
assert.equal(cloudPrompts, 1, "Cloud Rune non deve duplicare il dialogo se l'attore ha più token nella scena");

let cloudHitChecks = 0;
globalThis.cat.utils.dialogUtils.selectTargetDialog = async () => ({result: cloudOwner});
const redirectWorkflow = {
  attackRoll: {},
  token: cloudAttacker,
  hitTargets: new Set([cloudTarget]),
  workflowOptions: {},
  async checkHits() { cloudHitChecks += 1; }
};
await cloudMacro({workflow: redirectWorkflow, document: cloudItem});
assert.equal(cloudItem.system.uses.spent, 1, "Cloud Rune deve consumare un uso");
assert.equal(reactionUsed.has(cloudActor), true, "Cloud Rune deve consumare la reazione");
assert.equal(redirectWorkflow.targets.has(cloudOwner), true, "Cloud Rune deve trasferire il bersaglio");
assert.equal(cloudHitChecks, 1, "Cloud Rune deve ricalcolare il risultato contro il nuovo bersaglio");
assert.equal(technicalRolls.at(-1).data._id, "KhzRKCloudRt0001");
assert.equal(technicalRolls.at(-1).data.activation.type, "special",
  "La copia tecnica non deve tentare di consumare nuovamente la reazione");
reactionUsed.clear();

const fireMacro = byIdentifier("fire-rune").roll.find(entry => entry.pass === "actorDamageRollBonuses").macro;
const fireActor = {
  id: "fire-owner",
  items: [],
  effects: [],
  statuses: new Set(),
  system: {attributes: {prof: 3}, abilities: {con: {mod: 4}}}
};
const fireTargetActor = {id: "fire-target-actor", effects: [], statuses: new Set(), system: {traits: {ci: {value: new Set()}}}};
const fireTarget = {id: "fire-target", name: "Target", actor: fireTargetActor, parent: cloudScene, disposition: -1};
const fireActivity = {
  id: "KhzRKFireSave001",
  save: {dc: {value: 17}},
  toObject() {
    return {_id: "KhzRKFireSave001", activation: {type: "special", value: null}, effects: [], flags: {cat: {hidden: true}}};
  }
};
const fireItem = {
  id: "fire-item",
  uuid: "Actor.fire.Item.rune",
  documentName: "Item",
  name: "Fire Rune",
  img: "fire.webp",
  actor: fireActor,
  system: {identifier: "fire-rune", uses: {max: "1", spent: 0}, activities: new Map([[fireActivity.id, fireActivity]])}
};
technicalRollResult = {failedSaves: new Set([fireTarget])};
const fireWorkflow = {
  item: {system: {identifier: "longsword"}},
  hitTargets: new Set([fireTarget]),
  token: cloudOwner
};
registerDocuments(fireActor, fireItem);
await fireMacro({workflow: fireWorkflow, document: fireItem});
assert.equal(fireItem.system.uses.spent, 1, "Fire Rune deve consumare un uso");
assert.equal(bonusDamageCalls.at(-1).formula, "2d6");
assert.equal(bonusDamageCalls.at(-1).options.damageType, "fire");
assert.equal(technicalRolls.at(-1).data._id, "KhzRKFireRt00001",
  "Fire Rune deve usare una copia non-rider per il TS");
assert.ok(createdEffect.statuses.includes("restrained"), "Fire Rune deve applicare restrained dopo il TS fallito");
assert.equal(createdEffect.flags.cat.identifier, "fire-rune-shackles-Actor.fire-owner");
assert.equal(createdEffect.flags.dae.stackable, "multi",
  "I ceppi di due Rune Knight diversi non devono sovrascriversi");
assert.ok(createdEffect.system.changes.some(change => String(change.value).includes("saveDC=17")),
  "I TS ripetuti di Fire Rune devono usare la CD preparata dell'attività");

fireItem.system.uses.spent = 0;
const fireCallsBeforeUnarmed = bonusDamageCalls.length;
await fireMacro({
  workflow: {...fireWorkflow, item: {system: {identifier: "unarmed-strike"}}},
  document: fireItem
});
assert.equal(bonusDamageCalls.length, fireCallsBeforeUnarmed,
  "Fire Rune 2014 richiede un'arma e non deve attivarsi sul colpo senz'armi");

fireTargetActor.system.traits.ci.value.add("restrained");
const effectsBeforeImmunity = createdEffectsCount;
await fireMacro({workflow: fireWorkflow, document: fireItem});
assert.equal(createdEffectsCount, effectsBeforeImmunity,
  "L'immunità a restrained deve impedire i ceppi e il loro danno ricorrente");
fireTargetActor.system.traits.ci.value.clear();

const poisonEffect = {statuses: new Set(["poisoned"])};
const saveActivities = new Map([
  ["Activity.Poisoned", {name: "Drow Poison", effects: [{_id: "poisoned"}], item: {effects: new Map([["poisoned", poisonEffect]])}}],
  ["Activity.PoisonDamage", {name: "Poison Spray", effects: [], item: {effects: new Map()}}]
]);
globalThis.fromUuidSync = uuid => saveActivities.get(uuid) ?? null;
const hillSaveMacro = byIdentifier("hill-rune").save.find(entry => entry.pass === "actorSituational").macro;
const poisonedOptions = {};
hillSaveMacro({config: {cat: {activityUuid: "Activity.Poisoned"}}, options: poisonedOptions});
assert.equal(poisonedOptions.advantage, true, "Hill Rune deve dare vantaggio contro la condizione poisoned");
const poisonDamageOptions = {};
hillSaveMacro({config: {cat: {activityUuid: "Activity.PoisonDamage"}}, options: poisonDamageOptions});
assert.equal(poisonDamageOptions.advantage, undefined,
  "Hill Rune non deve dare vantaggio a qualsiasi TS che contiene la parola poison");

const stoneMacro = byIdentifier("stone-rune").combat.find(entry => entry.pass === "sceneTurnEnd").macro;
const stoneActor = {
  id: "stone-owner",
  uuid: "Actor.stone-owner",
  items: [],
  effects: [],
  statuses: new Set(),
  system: {attributes: {prof: 3}, abilities: {con: {mod: 3}}}
};
const stoneOwner = {id: "stone-owner-token", actor: stoneActor, parent: cloudScene, disposition: 1};
cloudScene.tokens.push(stoneOwner, fireTarget);
const stoneActivity = {
  id: "KhzRKStoneUse001",
  save: {dc: {value: 18}},
  toObject() {
    return {_id: "KhzRKStoneUse001", activation: {type: "reaction", value: 1}, effects: [], flags: {cat: {hidden: true}}};
  }
};
const stoneItem = {
  id: "stone-item",
  uuid: "Actor.stone.Item.rune",
  documentName: "Item",
  name: "Stone Rune",
  img: "stone.webp",
  actor: stoneActor,
  system: {identifier: "stone-rune", uses: {max: "1", spent: 0}, activities: new Map([[stoneActivity.id, stoneActivity]])}
};
let stoneConfirms = 0;
globalThis.cat.utils.dialogUtils.confirm = async (_title, _content, options) => {
  stoneConfirms += 1;
  confirmationUserId = options?.userId;
  return true;
};
technicalRollResult = {failedSaves: new Set([fireTarget])};
const stoneEvent = {token: fireTarget, document: stoneItem, combat: {id: "Combat.Test"}, round: 2, turn: 3};
registerDocuments(stoneActor, stoneItem);
await stoneMacro(stoneEvent);
assert.equal(stoneItem.system.uses.spent, 1, "Stone Rune deve consumare un uso");
assert.equal(reactionUsed.has(stoneActor), true, "Stone Rune deve consumare la reazione");
assert.equal(technicalRolls.at(-1).data._id, "KhzRKStoneRt0001");
assert.ok(createdEffect.statuses.includes("charmed") && createdEffect.statuses.includes("incapacitated"));
assert.equal(createdEffect.flags.cat.identifier, "stone-rune-active-Actor.stone-owner");
assert.ok(createdEffect.system.changes.some(change => String(change.value).includes("saveDC=18")),
  "I TS ripetuti di Stone Rune devono usare la stessa CD del tiro iniziale");
reactionUsed.clear();
stoneItem.system.uses.spent = 0;
await stoneMacro(stoneEvent);
assert.equal(stoneConfirms, 1,
  "Stone Rune non deve duplicare il dialogo quando CAT incontra lo stesso attore più volte nella scena");

technicalRollResult = null;
const originalConsoleError = console.error;
console.error = () => {};
registerDocuments(stoneActor, stoneItem);
await stoneMacro({...stoneEvent, turn: 4});
console.error = originalConsoleError;
assert.equal(stoneItem.system.uses.spent, 0,
  "Stone Rune deve ripristinare l'uso se il TS tecnico non parte");
assert.equal(reactionUsed.has(stoneActor), false,
  "Stone Rune deve ripristinare la reazione se il TS tecnico non parte");
technicalRollResult = {failedSaves: new Set()};
await stoneMacro({...stoneEvent, turn: 4});
assert.equal(stoneItem.system.uses.spent, 1, "Stone Rune can retry the same event after the technical save was cancelled");

const frostMacro = byIdentifier("frost-rune").roll.find(entry => entry.pass === "itemRollFinished").macro;
const frostActor = {items: [], effects: []};
const frostItem = {
  name: "Frost Rune", img: "frost.webp", uuid: "Actor.a.Item.frost", actor: frostActor,
  system: {identifier: "frost-rune", uses: {max: "1", spent: 0}}
};
registerDocuments(frostItem);
await frostMacro({workflow: {activity: {id: "KhzRKFrostUse001"}}, document: frostItem});
assert.equal(updatedUse["system.uses.spent"], 1);
assert.deepEqual(createdEffect.duration, {
  value: 600,
  units: "seconds",
  expiry: "turnStart",
  expired: false
});
assert.equal(createdEffect.system.changes.length, 4);
assert.ok(createdEffect.system.changes.every(change => change.value === "2"));

const hillActivationMacro = byIdentifier("hill-rune").roll.find(entry => entry.pass === "itemRollFinished").macro;
const hillActor = {id: "hill-owner", items: [], effects: []};
const hillItem = {
  id: "hill-item", uuid: "Actor.hill.Item.rune", name: "Hill Rune", img: "hill.webp", actor: hillActor,
  system: {identifier: "hill-rune", uses: {max: "1", spent: 0}}
};
registerDocuments(hillItem);
await hillActivationMacro({workflow: {activity: {id: "KhzRKHillUse0001"}}, document: hillItem});
assert.equal(hillItem.system.uses.spent, 1);
assert.deepEqual(createdEffect.system.changes.map(change => change.value), ["bludgeoning", "piercing", "slashing"]);
assert.equal(createdEffect.duration.value, 60);

const stormActivationMacro = byIdentifier("storm-rune").roll.find(entry => entry.pass === "itemRollFinished").macro;
const stormActivationActor = {id: "storm-activation-owner", items: [], effects: []};
const stormItem = {
  id: "storm-item", uuid: "Actor.storm.Item.rune", name: "Storm Rune", img: "storm.webp", actor: stormActivationActor,
  system: {identifier: "storm-rune", uses: {max: "1", spent: 0}}
};
registerDocuments(stormItem);
await stormActivationMacro({workflow: {activity: {id: "KhzRKStormUse001"}}, document: stormItem});
assert.equal(stormItem.system.uses.spent, 1);
assert.equal(createdEffect.duration.value, 60);
for (const type of ["roll", "save", "check", "skill", "tool"])
  assert.equal(createdEffect.flags.cat.macros[type][0].identifier, "storm-rune-active");

const stormOwnerActor = {
  id: "storm-owner",
  uuid: "Actor.storm-owner",
  items: [],
  effects: [],
  statuses: new Set()
};
const stormOwnerToken = {id: "storm-owner-token", actor: stormOwnerActor, parent: cloudScene, disposition: 1};
cloudScene.tokens.push(stormOwnerToken);
const stormEffect = {
  id: "storm-effect",
  uuid: "Actor.storm-owner.ActiveEffect.storm",
  documentName: "ActiveEffect",
  parent: stormOwnerActor
};
let stormPrompts = 0;
globalThis.cat.utils.dialogUtils.buttonDialog = async () => {
  stormPrompts += 1;
  return "advantage";
};
reactionUsed.clear();
const stormSaveMacro = byIdentifier("storm-rune-active").save.find(entry => entry.pass === "sceneSituational").macro;
const stormSaveData = {
  document: stormEffect,
  token: fireTarget,
  saveId: "dex",
  config: {},
  options: {}
};
registerDocuments(stormOwnerActor);
await stormSaveMacro(stormSaveData);
assert.equal(stormSaveData.options.advantage, true,
  "Storm Rune deve applicare direttamente il vantaggio scelto dal proprietario");
assert.equal(reactionUsed.has(stormOwnerActor), true);
reactionUsed.clear();
await stormSaveMacro(stormSaveData);
assert.equal(stormPrompts, 1, "Storm Rune non deve chiedere due volte per lo stesso effetto e tiro");

const giantMacro = byIdentifier("giants-might").roll.find(entry => entry.pass === "itemRollFinished").macro;
const giantToken = {id: "giant-token", width: 1, height: 1};
const giantActor = {
  id: "giant-actor",
  uuid: "Actor.giant-actor",
  items: [],
  effects: [],
  getActiveTokens() { return [{document: giantToken}]; }
};
const giantItem = {
  id: "giant-item",
  name: "Giant's Might",
  img: "giant.webp",
  uuid: "Actor.giant.Item.might",
  documentName: "Item",
  actor: giantActor,
  system: {identifier: "giants-might"},
  flags: {"khuzoe-automations": {giantsMightConfig: {baseSize: "huge", juggernautSize: "grg"}}}
};
const juggernautItem = {documentName: "Item", system: {identifier: "runic-juggernaut"}};

giantActor.items = [giantItem];
await giantMacro({workflow: {activity: {id: "KhzRKGiantUse001"}}, document: giantItem});
assert.ok(createdEffect.system.changes.some(change => change.key === "system.traits.size" && change.value === "huge"));
assert.deepEqual(updatedUse, {width: 3, height: 3});

giantActor.effects = [{
  id: "old-giant-effect",
  flags: {cat: {identifier: "giants-might-active"}, "khuzoe-automations": {tokenSizes: []}},
  parent: giantActor
}];
giantActor.items = [giantItem, juggernautItem];
await giantMacro({workflow: {activity: {id: "KhzRKGiantUse001"}}, document: giantItem});
assert.equal(deletedEffectOptions.options.khuzoeGiantsMightRefresh, true,
  "Il rinnovo di Giant's Might non deve ripristinare temporaneamente la taglia");
assert.ok(createdEffect.system.changes.some(change => change.key === "system.traits.size" && change.value === "grg"));
assert.ok(createdEffect.system.changes.some(change => change.key === "flags.midi-qol.range.mwak"));
assert.deepEqual(updatedUse, {width: 4, height: 4});

giantItem.flags["khuzoe-automations"].giantsMightConfig.juggernautSize = "lg";
await giantMacro({workflow: {activity: {id: "KhzRKGiantUse001"}}, document: giantItem});
assert.ok(!createdEffect.system.changes.some(change => change.key === "flags.midi-qol.range.mwak"),
  "Runic Juggernaut non deve aumentare la portata se la configurazione non rende almeno Huge");
giantItem.flags["khuzoe-automations"].giantsMightConfig.juggernautSize = "grg";

const giantDamageMacro = byIdentifier("giants-might-active").roll
  .find(entry => entry.pass === "actorDamageRollBonuses").macro;
let giantBonusCount = 0;
globalThis.cat.utils.workflowUtils.bonusDamage = async () => { giantBonusCount += 1; };
globalThis.cat.utils.tokenUtils.getCombatData = () => ({inCombat: true});
globalThis.cat.utils.combatUtils.isOwnTurn = () => false;
await giantDamageMacro({
  workflow: {token: giantToken, hitTargets: new Set([{id: "enemy", actor: {id: "enemy-actor"}}])},
  document: {parent: giantActor, flags: {}},
  token: giantToken
});
assert.equal(giantBonusCount, 0, "Giant's Might non deve aggiungere danno durante una reazione fuori dal proprio turno");
globalThis.cat.utils.combatUtils.isOwnTurn = () => true;
await giantDamageMacro({
  workflow: {token: giantToken, hitTargets: new Set([{id: "enemy", actor: {id: "enemy-actor"}}])},
  document: {parent: giantActor, flags: {}},
  token: giantToken
});
assert.equal(giantBonusCount, 1, "Giant's Might deve funzionare nel proprio turno");
assert.equal(confirmationUserId, "player-owner", "Giant's Might deve chiedere al proprietario attivo dell'attore");
assert.equal(giantStampId, "Actor.giant-actor",
  "Il limite una volta per turno deve essere condiviso tra tutti i token dello stesso attore");

const shieldMacro = byIdentifier("runic-shield").roll.find(entry => entry.pass === "sceneAttackRollComplete").macro;
const shieldActor = {
  id: "shield-owner",
  uuid: "Actor.shield-owner",
  items: [],
  effects: [],
  statuses: new Set(),
  system: {attributes: {prof: 3}}
};
const shieldOwner = {id: "shield-owner-token", actor: shieldActor, parent: cloudScene, disposition: 1};
cloudScene.tokens.push(shieldOwner);
const shieldActivity = {
  id: "KhzRKShieldUse01",
  toObject() {
    return {_id: "KhzRKShieldUse01", activation: {type: "reaction", value: 1}, flags: {cat: {hidden: true}}};
  }
};
const shieldItem = {
  id: "shield-item",
  uuid: "Actor.shield.Item.rune",
  documentName: "Item",
  name: "Runic Shield",
  actor: shieldActor,
  system: {identifier: "runic-shield", uses: {max: "@prof", spent: 0}, activities: new Map([[shieldActivity.id, shieldActivity]])}
};
let shieldSetRoll = 0;
let shieldHitChecks = 0;
globalThis.cat.utils.dialogUtils.confirm = async () => true;
reactionUsed.clear();
const shieldWorkflow = {
  attackRoll: {async reroll() { return {total: 7}; }},
  hitTargets: new Set([cloudTarget]),
  token: cloudAttacker,
  workflowOptions: {},
  async setAttackRoll() { shieldSetRoll += 1; },
  async checkHits() { shieldHitChecks += 1; }
};
registerDocuments(shieldActor, shieldItem);
await shieldMacro({workflow: shieldWorkflow, document: shieldItem});
assert.equal(shieldItem.system.uses.spent, 1);
assert.equal(reactionUsed.has(shieldActor), true);
assert.equal(technicalRolls.at(-1).data._id, "KhzRKShldRt00001");
assert.equal(shieldSetRoll, 1);
assert.equal(shieldHitChecks, 1);

const preUpdate = onHooks.get("preUpdateItem");
const runeUpdate = {
  img: "source.webp",
  system: {identifier: "storm-rune", uses: {max: "1", spent: 0, recovery: []}},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
preUpdate({img: "custom.webp", system: {identifier: "storm-rune", uses: {spent: 1}}}, runeUpdate);
assert.equal(runeUpdate.img, "custom.webp");
assert.equal(runeUpdate.system.uses.spent, 1);

const configuredGiantUpdate = {
  img: "source.webp",
  system: {identifier: "giants-might", uses: {max: "@prof", spent: 0, recovery: []}},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
const configuredGiantItem = {
  img: "custom-giant.webp",
  system: {identifier: "giants-might", uses: {spent: 2}},
  flags: {"khuzoe-automations": {giantsMightConfig: {baseSize: "huge", juggernautSize: "grg"}}}
};
preUpdate(configuredGiantItem, configuredGiantUpdate);
assert.equal(configuredGiantUpdate.img, "custom-giant.webp");
assert.equal(configuredGiantUpdate.system.uses.spent, 2);
assert.deepEqual(
  configuredGiantUpdate.flags["khuzoe-automations"].giantsMightConfig,
  {baseSize: "huge", juggernautSize: "grg"}
);

let reconciliationUpdates;
const masterRuneItem = {system: {identifier: "master-of-runes"}};
const reconciledRune = {id: "rune", flags: {cat: {automation: {source: "khuzoe-automations"}}}, system: {identifier: "cloud-rune", uses: {max: "1", spent: 1}}};
const reconciliationActor = {
  items: [masterRuneItem, reconciledRune],
  async updateEmbeddedDocuments(_type, updates) { reconciliationUpdates = updates; }
};
game.actors = [reconciliationActor];
await reconcileAllRuneUses();
assert.equal(reconciliationUpdates[0]["system.uses.max"], "2",
  "Master of Runes deve portare ogni runa a due usi");

reconciliationActor.items = [reconciledRune];
reconciledRune.system.uses = {max: "2", spent: 2};
await reconcileAllRuneUses();
assert.equal(reconciliationUpdates[0]["system.uses.max"], "1");
assert.equal(reconciliationUpdates[0]["system.uses.spent"], 1,
  "Rimuovendo Master of Runes gli usi spesi devono essere ricondotti al nuovo massimo");
game.actors = [];

console.log("Khuzoe Automations Rune Knight: registrazione, sorgenti e workflow base OK");
