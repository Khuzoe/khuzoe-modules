import assert from "node:assert/strict";

const onHooks = new Map();
globalThis.Hooks = {
  on(name, callback) { onHooks.set(name, callback); }
};

globalThis.game = {
  user: {id: "gm", isGM: true},
  users: [{id: "gm", active: true, isGM: true}]
};
globalThis.CONFIG = {DND5E: {damageTypes: {
  acid: {}, bludgeoning: {}, cold: {}, fire: {}, force: {}, genie: {}, lightning: {}, necrotic: {},
  piercing: {}, poison: {}, psychic: {}, radiant: {}, slashing: {}, thunder: {}
}}};

globalThis.ui = {notifications: {info() {}, warn() {}}};
globalThis.foundry = {
  utils: {
    deepClone: structuredClone
  }
};

const {
  hasBearTotem,
  hasPersistentRage,
  qualifiesForRageDamage,
  rageContinuesAtTurnEnd,
  rageDamageBonus,
  rageResistanceTypes,
  registerRage,
  RAGE_ACTIVE_IDENTIFIER,
  RAGE_END_ACTIVITY_ID,
  RAGE_START_ACTIVITY_ID,
  RAGE_UUID
} = await import("../scripts/rage.mjs");

function feature(identifier, name = identifier) {
  return {type: "feat", name, system: {identifier}};
}

function barbarian(level, extra = []) {
  const cls = {type: "class", name: "Barbarian", system: {identifier: "barbarian", levels: level}};
  return {items: [cls, ...extra], classes: {barbarian: cls}, system: {scale: {barbarian: {}}}};
}

assert.equal(RAGE_START_ACTIVITY_ID.length, 16);
assert.equal(RAGE_END_ACTIVITY_ID.length, 16);
assert.match(RAGE_UUID, /KhzRage14Auto001$/);
assert.equal(rageDamageBonus(barbarian(1)), 2);
assert.equal(rageDamageBonus(barbarian(9)), 3);
assert.equal(rageDamageBonus(barbarian(16)), 4);

const scaled = barbarian(1);
scaled.system.scale.barbarian["rage-damage"] = {value: 5};
assert.equal(rageDamageBonus(scaled), 5);

const baseActor = barbarian(5);
const bearActor = barbarian(5, [feature("totem-spirit-bear", "Totem Spirit: Bear")]);
const italianBear = barbarian(5, [feature("custom", "Spirito Totemico: Orso")]);
assert.equal(hasBearTotem(baseActor), false);
assert.equal(hasBearTotem(bearActor), true);
assert.equal(hasBearTotem(italianBear), true);
assert.deepEqual(rageResistanceTypes(baseActor), ["bludgeoning", "piercing", "slashing"]);
assert.equal(rageResistanceTypes(bearActor).includes("psychic"), false);
assert.equal(rageResistanceTypes(bearActor).includes("genie"), true);
assert.equal(rageResistanceTypes(bearActor).length, 13);
assert.equal(hasPersistentRage(barbarian(15, [feature("persistent-rage")])), true);

const meleeStrength = {
  activity: {actionType: "mwak", ability: "str"},
  attackRoll: {options: {}},
  attackMode: "oneHanded"
};
assert.equal(qualifiesForRageDamage(meleeStrength), true);
assert.equal(qualifiesForRageDamage({activity: {actionType: "mwak", attack: {ability: "str"}}}), true);
assert.equal(qualifiesForRageDamage({...meleeStrength, activity: {actionType: "mwak", ability: "dex"}}), false);
assert.equal(qualifiesForRageDamage({...meleeStrength, activity: {actionType: "rwak", ability: "str"}}), false);
assert.equal(rageContinuesAtTurnEnd({maintained: true}), true);
assert.equal(rageContinuesAtTurnEnd({maintained: false}), false);
assert.equal(rageContinuesAtTurnEnd({maintained: false, persistent: true}), true);

const automations = [];
const macros = [];
const api = {
  registerAutomation(data) { automations.push(data); return data; },
  registerFnMacro(data) { macros.push(data); return data; }
};
registerRage(api);
assert.equal(automations.length, 1);
assert.equal(macros.length, 2);
assert.equal(automations[0].identifier, "rage");

const rageMacro = macros.find(data => data.identifier === "rage");
const activeMacro = macros.find(data => data.identifier === RAGE_ACTIVE_IDENTIFIER);
assert.ok(rageMacro.roll.some(entry => entry.pass === "itemPreItemRoll"));
assert.ok(rageMacro.roll.some(entry => entry.pass === "itemRollFinished"));
assert.ok(activeMacro.roll.some(entry => entry.pass === "actorAttackRollComplete"));
assert.ok(activeMacro.roll.some(entry => entry.pass === "actorDamageRollBonuses"));
assert.ok(activeMacro.combat.some(entry => entry.pass === "sceneTurnEnd"));

let createdEffectData;
let deleted = false;
let bonusDamage;
function setPath(object, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  const target = parts.reduce((current, part) => current[part] ??= {}, object);
  target[last] = value;
}

globalThis.cat = {
  utils: {
    documentUtils: {
      async deleteDocument() { deleted = true; },
      async update(document, changes) {
        for (const [path, value] of Object.entries(changes)) setPath(document, path, value);
      }
    },
    effectUtils: {
      async createEffects(_actor, effects) { createdEffectData = effects[0]; return effects; }
    },
    workflowUtils: {
      async bonusDamage(_workflow, formula, options) { bonusDamage = {formula, options}; }
    }
  }
};

const rageItem = {
  id: "rage-item",
  documentName: "Item",
  name: "Rage",
  img: "rage.webp",
  uuid: "Actor.barbarian.Item.rage",
  actor: bearActor,
  system: {identifier: "rage", uses: {max: 3, spent: 0, value: 3}}
};
bearActor.name = "Barbarian";
bearActor.uuid = "Actor.barbarian";
bearActor.effects = [];
bearActor.isOwner = true;

const finish = rageMacro.roll.find(entry => entry.pass === "itemRollFinished").macro;
await finish({workflow: {activity: {id: RAGE_START_ACTIVITY_ID}}, document: rageItem});
assert.equal(createdEffectData.flags.cat.identifier, RAGE_ACTIVE_IDENTIFIER);
assert.equal(createdEffectData.flags["khuzoe-automations"].rage.maintained, false);
assert.equal(createdEffectData.flags["khuzoe-automations"].rage.bearTotem, true);
assert.equal(createdEffectData.flags.dae.specialDuration.includes("zeroHP"), true);
assert.equal(createdEffectData.system.changes.some(change => change.value === "psychic"), false);
assert.equal(createdEffectData.system.changes.length, 13);

const effect = {
  ...createdEffectData,
  documentName: "ActiveEffect",
  parent: bearActor
};
bearActor.effects = [effect];

const damageBonusMacro = activeMacro.roll.find(entry => entry.pass === "actorDamageRollBonuses").macro;
await damageBonusMacro({workflow: {...meleeStrength, actor: bearActor, defaultDamageType: "slashing"}, document: effect});
assert.equal(bonusDamage.formula, "2");
assert.equal(bonusDamage.options.damageType, "slashing");

const advantageMacro = activeMacro.check[0].macro;
const strOptions = {};
advantageMacro({checkId: "str", options: strOptions});
assert.equal(strOptions.advantage, true);
const dexOptions = {};
advantageMacro({checkId: "dex", options: dexOptions});
assert.equal(dexOptions.advantage, undefined);

const turnEnd = activeMacro.combat[0].macro;
const token = {actor: bearActor};
await turnEnd({token, document: effect});
assert.equal(effect.flags["khuzoe-automations"].rage.maintained, false);
assert.equal(deleted, true, "Rage senza attacchi o danni termina anche nel primo turno");
deleted = false;

const markAttack = activeMacro.roll.find(entry => entry.pass === "actorAttackRollComplete").macro;
await markAttack({workflow: {actor: bearActor, activity: {type: "attack"}, attackRoll: {}}, document: effect});
assert.equal(effect.flags["khuzoe-automations"].rage.maintained, true);
await turnEnd({token, document: effect});
assert.equal(effect.flags["khuzoe-automations"].rage.maintained, false);

await turnEnd({token, document: effect});
assert.equal(deleted, true);

deleted = false;
effect.flags["khuzoe-automations"].rage.maintained = false;
bearActor.items.push(feature("persistent-rage"));
await turnEnd({token, document: effect});
assert.equal(deleted, false);

bearActor.items = bearActor.items.filter(item => item.system?.identifier !== "persistent-rage");
effect.flags["khuzoe-automations"].rage.maintained = false;
await onHooks.get("midi-qol.preTargetDamageApplication")({actor: bearActor}, {
  damageItem: {hpDamage: 0, tempDamage: 3}
});
assert.equal(effect.flags["khuzoe-automations"].rage.maintained, true);

deleted = false;
await finish({workflow: {activity: {id: RAGE_END_ACTIVITY_ID}}, document: rageItem});
assert.equal(deleted, true);

console.log("Khuzoe Automations Rage: regole, Bear Totem e mantenimento OK");
