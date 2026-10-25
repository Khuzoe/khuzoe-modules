import assert from "node:assert/strict";

globalThis.game = {user: {id: "gm", isGM: true}};
globalThis.ui = {notifications: {info() {}, warn() {}}};

const {
  DAMAGE_BOND_ACTIVITY_IDS,
  DAMAGE_BOND_AUTOMATIONS,
  DAMAGE_BOND_IDS,
  calculateDamageBondShare,
  prepareDamageBondItemUpdate,
  registerDamageBond,
  resolveQueuedDamageBonds,
  useDamageBond
} = await import("../scripts/damage-bond.mjs");

assert.deepEqual(calculateDamageBondShare({hpDamage: 11, tempDamage: 4}), {
  incoming: 15,
  transferred: 7,
  retained: 8
});
assert.deepEqual(calculateDamageBondShare({hpDamage: 1, tempDamage: 0}), {
  incoming: 1,
  transferred: 0,
  retained: 1
});

const registeredMacros = [];
const registeredAutomations = [];
registerDamageBond({
  registerFnMacro(data) { registeredMacros.push(data); return data; },
  registerAutomation(data) { registeredAutomations.push(data); return data; }
});
assert.equal(registeredMacros.length, 2);
assert.equal(registeredAutomations.length, 2);
for (const identifier of Object.values(DAMAGE_BOND_IDS)) {
  const macro = registeredMacros.find(entry => entry.identifier === identifier);
  assert.ok(macro);
  assert.ok(macro.roll.some(entry => entry.pass === "itemPreItemRoll"));
  assert.ok(macro.roll.some(entry => entry.pass === "targetDamageFlatReductions"));
  assert.ok(DAMAGE_BOND_AUTOMATIONS.some(entry => entry.identifier === identifier));
}

const preservedState = {
  links: [{actorUuid: "Actor.B", tokenUuid: "Scene.test.Token.B", name: "B"}],
  stamps: [{combat: "combat", round: 1, turn: 2}]
};
const preservedItem = {
  name: "Legame del Danno",
  system: {identifier: DAMAGE_BOND_IDS.always},
  flags: {"khuzoe-automations": {damageBond: preservedState}}
};
const preservedChanges = {
  flags: {cat: {automation: {source: "khuzoe-automations", version: "0.1.0"}}}
};
prepareDamageBondItemUpdate(preservedItem, preservedChanges);
assert.deepEqual(preservedChanges.flags["khuzoe-automations"].damageBond, preservedState);
assert.notEqual(preservedChanges.flags["khuzoe-automations"].damageBond, preservedState);

function actor(id, name) {
  return {
    id,
    uuid: `Actor.${id}`,
    name,
    img: `${id}.webp`,
    statuses: new Set(),
    system: {attributes: {hp: {value: 30, temp: 0}}},
    async applyDamage(amount) {
      const hp = this.system.attributes.hp;
      const tempDamage = Math.min(hp.temp, amount);
      hp.temp -= tempDamage;
      hp.value = Math.max(0, hp.value - (amount - tempDamage));
      protectedDamageRolls.push({actor: this, amount});
      return this;
    },
    getActiveTokens() { return []; }
  };
}

function token(id, linkedActor) {
  const document = {
    id,
    uuid: `Scene.test.Token.${id}`,
    name: linkedActor.name,
    actor: linkedActor,
    parent: {id: "test"},
    texture: {src: linkedActor.img}
  };
  document.object = {id, actor: linkedActor, document};
  return document;
}

const actorA = actor("A", "A");
const actorB = actor("B", "B");
const actorC = actor("C", "C");
const tokenA = token("A", actorA);
const tokenB = token("B", actorB);
const tokenC = token("C", actorC);
actorA.getActiveTokens = () => [tokenA];
actorB.getActiveTokens = () => [tokenB];
actorC.getActiveTokens = () => [tokenC];

globalThis.canvas = {
  scene: {id: "test", tokens: [tokenA, tokenB, tokenC]},
  tokens: {placeables: [tokenA, tokenB, tokenC]}
};

const documents = new Map([
  [actorA.uuid, actorA], [actorB.uuid, actorB], [actorC.uuid, actorC],
  [tokenA.uuid, tokenA], [tokenB.uuid, tokenB], [tokenC.uuid, tokenC]
]);
globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;

const transferActivity = {id: DAMAGE_BOND_ACTIVITY_IDS.transfer, name: "Danno trasferito"};
function bondItem(mode, links, stamps = []) {
  return {
    id: mode === "oncePerTurn" ? "once" : "always",
    uuid: `Actor.A.Item.${mode}`,
    documentName: "Item",
    name: mode === "oncePerTurn" ? "Legame del Danno (una volta per turno)" : "Legame del Danno",
    actor: actorA,
    system: {
      identifier: mode === "oncePerTurn" ? DAMAGE_BOND_IDS.oncePerTurn : DAMAGE_BOND_IDS.always,
      activities: new Map([[DAMAGE_BOND_ACTIVITY_IDS.transfer, transferActivity]])
    },
    flags: {"khuzoe-automations": {damageBond: {links, stamps}}}
  };
}

const links = [
  {actorUuid: actorB.uuid, tokenUuid: tokenB.uuid, name: actorB.name},
  {actorUuid: actorC.uuid, tokenUuid: tokenC.uuid, name: actorC.name}
];

let selectedActorUuid = actorB.uuid;
let syntheticRolls = [];
let protectedDamageRolls = [];
let negatedDamageItems = [];
let itemUpdates = [];
let stampedThisTurn = false;
globalThis.cat = {
  utils: {
    queryUtils: {firstOwner() { return "player"; }},
    dialogUtils: {
      async confirm() { return true; },
      async buttonDialog() { return selectedActorUuid; }
    },
    tokenUtils: {
      getCombatData() { return {inCombat: false}; },
      isAlly() { return true; }
    },
    combatUtils: {
      isStampedThisTurn() { return stampedThisTurn; },
      addTurnStamp(stamps) { return [...stamps, {combat: "combat", round: 1, turn: 2}]; }
    },
    activityUtils: {
      getDamageModifiedActivityData(_activity, formula, options) {
        return {
          _id: DAMAGE_BOND_ACTIVITY_IDS.transfer,
          description: {},
          midiProperties: {},
          flags: {},
          damage: {parts: [{custom: {enabled: true, formula}, types: options.types}]}
        };
      }
    },
    workflowUtils: {
      modifyDamageAppliedFlat(ditem, amount) {
        ditem.damageDetail ??= [{type: "slashing", value: ditem.hpDamage + ditem.tempDamage}];
        ditem.damageDetail.push({type: "none", value: amount});
        if (ditem.oldHP === undefined) ditem.hpDamage += amount;
      },
      async syntheticActivityDataRoll(activity, item, targets, options) {
        syntheticRolls.push({activity, item, targets, options});
        return {id: "transfer-workflow"};
      },
      negateDamageItemDamage(ditem) {
        negatedDamageItems.push(ditem);
        ditem.totalDamage = 0;
        ditem.tempDamage = 0;
        ditem.hpDamage = 0;
        ditem.newTempHP = Number(ditem.oldTempHP ?? 0);
        ditem.newHP = Number(ditem.oldHP ?? 0);
      }
    },
    documentUtils: {
      async update(item, changes) {
        itemUpdates.push({item, changes});
      }
    }
  }
};
globalThis.ChatMessage = {
  getSpeaker({actor}) { return {actor: actor.id}; },
  async create(data) { return data; }
};

const alwaysItem = bondItem("always", links);
actorA.system.attributes.hp.temp = 4;
const originalDamage = {hpDamage: 11, tempDamage: 4, oldHP: 30, oldTempHP: 4};
const firstWorkflow = {id: "workflow-1", activity: {id: "enemy-damage"}};
assert.equal(await useDamageBond({
  workflow: firstWorkflow,
  targetToken: tokenA,
  ditem: originalDamage,
  document: alwaysItem
}), undefined);
assert.equal(syntheticRolls.length, 0, "Il trasferimento deve attendere la conclusione del danno principale");
await resolveQueuedDamageBonds({workflow: firstWorkflow, document: alwaysItem});
assert.equal(protectedDamageRolls.length, 0, "La quota trattenuta resta nel workflow originario");
assert.equal(originalDamage.hpDamage, 4);
assert.equal(originalDamage.tempDamage, 4);
// Simulate Midi applying the original workflow after all target reductions.
await actorA.applyDamage(originalDamage.hpDamage + originalDamage.tempDamage);
assert.equal(actorA.system.attributes.hp.temp, 0);
assert.equal(actorA.system.attributes.hp.value, 26);
assert.equal(syntheticRolls.length, 1, "La sola quota trasferita deve usare l'attività sintetica");
assert.equal(syntheticRolls[0].targets[0], tokenB, "Fra B e C deve essere usato soltanto l'alleato scelto");
assert.equal(syntheticRolls[0].activity._id, DAMAGE_BOND_ACTIVITY_IDS.runtimeTransfer,
  "Il trasferimento sintetico non deve conservare l'ID rider, che dnd5e v14 considera inutilizzabile");
assert.equal(syntheticRolls[0].activity.damage.parts[0].custom.formula, "7");
assert.deepEqual(syntheticRolls[0].activity.midiProperties.ignoreTraits, ["idi", "idr", "idv", "ida", "idm"]);
assert.equal(syntheticRolls[0].options.options.workflowOptions.khuzoeDamageTransfer, true);
assert.deepEqual(negatedDamageItems, []);
assert.equal(originalDamage.newTempHP, 0);
assert.equal(originalDamage.newHP, 26);
assert.equal(itemUpdates.length, 0, "La variante sempre disponibile non deve creare marcature di turno");

assert.equal(await useDamageBond({
  workflow: {id: "workflow-transfer", activity: {id: DAMAGE_BOND_ACTIVITY_IDS.runtimeTransfer}},
  targetToken: tokenA,
  ditem: {hpDamage: 10, tempDamage: 0},
  document: alwaysItem
}), false, "Il danno trasferito non deve generare una nuova catena di legami");
assert.equal(syntheticRolls.length, 1);

const onceItem = bondItem("oncePerTurn", [links[0]], []);
globalThis.cat.utils.tokenUtils.getCombatData = () => ({inCombat: true, combatId: "combat", currentRound: 1, currentTurn: 2});
stampedThisTurn = false;
const onceWorkflow = {id: "workflow-2", activity: {id: "enemy-damage"}};
assert.equal(await useDamageBond({
  workflow: onceWorkflow,
  targetToken: tokenA,
  ditem: {hpDamage: 8, tempDamage: 0},
  document: onceItem
}), undefined);
assert.equal(itemUpdates.length, 1, "L’uso per turno va riservato prima di aprire un altro workflow");
await resolveQueuedDamageBonds({workflow: onceWorkflow, document: onceItem});
assert.equal(itemUpdates.length, 1);
assert.ok(itemUpdates[0].changes["flags.khuzoe-automations.damageBond.stamps"]);

stampedThisTurn = true;
assert.equal(await useDamageBond({
  workflow: {id: "workflow-3", activity: {id: "enemy-damage"}},
  targetToken: tokenA,
  ditem: {hpDamage: 8, tempDamage: 0},
  document: onceItem
}), false);
assert.equal(syntheticRolls.length, 2, "Il secondo danno nello stesso turno non deve essere trasferito");

stampedThisTurn = false;
let failureRoll = 0;
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async (activity, item, targets, options) => {
  syntheticRolls.push({activity, item, targets, options});
  failureRoll += 1;
  if (failureRoll === 1) return false;
  await targets[0].actor.applyDamage(Number(activity.damage.parts[0].custom.formula));
  return {id: "restored"};
};
const negationsBeforeFailure = negatedDamageItems.length;
const updatesBeforeFailure = itemUpdates.length;
const failureWorkflow = {id: "workflow-4", activity: {id: "enemy-damage"}};
assert.equal(await useDamageBond({
  workflow: failureWorkflow,
  targetToken: tokenA,
  ditem: {hpDamage: 12, tempDamage: 0},
  document: onceItem
}), undefined);
assert.equal(negatedDamageItems.length, negationsBeforeFailure,
  "La quota trattenuta non deve essere azzerata");
await resolveQueuedDamageBonds({workflow: failureWorkflow, document: onceItem});
assert.equal(protectedDamageRolls.at(-1).amount, 6,
  "Un trasferimento fallito deve riapplicare la quota mancante al bersaglio originale");
assert.equal(itemUpdates.length, updatesBeforeFailure + 2, "Il trasferimento fallito riserva e poi ripristina l’uso del turno");

console.log("Khuzoe Automations Damage Bond: legami multipli, scelta singola, trasferimento e limite per turno OK");
