import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

globalThis.game = {user: {id: "player", isGM: false}};
globalThis.ui = {notifications: {warn() {}, info() {}, error() {}}};

const {
  ROGUE_ACTIVITY_IDS,
  ROGUE_IDS,
  getRogueLevel,
  prepareRogueItemUpdate,
  registerRogue,
  sneakAttackFormula
} = await import("../scripts/rogue.mjs");

const automations = [];
const macros = [];
const api = {
  registerAutomation(data) { automations.push(data); return true; },
  registerFnMacro(data) { macros.push(data); return data; }
};
const registration = registerRogue(api);
assert.equal(registration.automations.length, 5);
assert.equal(registration.macros.length, 2);
for (const identifier of Object.values(ROGUE_IDS)) {
  assert.ok(automations.some(entry => entry.identifier === identifier && entry.rules === "2014"));
}

const byIdentifier = identifier => macros.find(entry => entry.identifier === identifier);
assert.equal(byIdentifier(ROGUE_IDS.sneakAttack).roll[0].pass, "actorDamageRollBonuses");
assert.equal(byIdentifier(ROGUE_IDS.uncannyDodge).roll[0].pass, "targetDamageFlatReductions");

const packDirectory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
const sourceFiles = (await readdir(packDirectory)).filter(file => file.endsWith(".json"));
const rogueDocuments = [];
for (const file of sourceFiles) {
  const data = JSON.parse(await readFile(new URL(file, packDirectory), "utf8"));
  if (!Object.values(ROGUE_IDS).includes(data.system?.identifier)) continue;
  rogueDocuments.push(data);
  assert.equal(data._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(data.system.source.rules, "2014");
  assert.equal(data.flags.cat.automation.source, "khuzoe-automations");
  for (const activity of Object.values(data.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
  for (const effect of data.effects ?? []) {
    assert.equal(effect._id.length, 16, `${file}: ID effetto non valido`);
    assert.equal(effect._key, `!items.effects!${data._id}.${effect._id}`, `${file}: chiave effetto non valida`);
  }
}
assert.equal(rogueDocuments.length, 5);

const cunning = rogueDocuments.find(item => item.system.identifier === ROGUE_IDS.cunningAction);
assert.equal(Object.keys(cunning.system.activities).length, 3);
assert.equal(cunning.system.activities[ROGUE_ACTIVITY_IDS.cunningDash].activation.type, "bonus");
assert.equal(cunning.system.activities[ROGUE_ACTIVITY_IDS.cunningDisengage].activation.type, "bonus");
assert.equal(cunning.system.activities[ROGUE_ACTIVITY_IDS.cunningHide].activation.type, "bonus");

const evasion = rogueDocuments.find(item => item.system.identifier === ROGUE_IDS.evasion);
assert.equal(evasion.effects[0].transfer, true);
assert.equal(evasion.effects[0].system.changes[0].key, "flags.midi-qol.superSaver.dex");
assert.equal(evasion.effects[0].system.changes[0].value, "activity.damage.onSave === 'half'");
const reliable = rogueDocuments.find(item => item.system.identifier === ROGUE_IDS.reliableTalent);
assert.equal(reliable.effects[0].transfer, true);
assert.equal(reliable.effects[0].system.changes[0].key, "flags.dnd5e.reliableTalent");

const rogueActor = {
  id: "rogue-actor",
  type: "character",
  classes: {rogue: {system: {levels: 8}}},
  statuses: new Set(),
  system: {
    attributes: {hp: {value: 40}},
    scale: {rogue: {"sneak-attack": {value: {number: 4, denomination: 6}}}}
  }
};
assert.equal(getRogueLevel(rogueActor), 8);
assert.equal(sneakAttackFormula(rogueActor), "4d6");
assert.equal(sneakAttackFormula({type: "character", classes: {rogue: {system: {levels: 11}}}, system: {}}), "6d6");
assert.equal(sneakAttackFormula({type: "npc", system: {details: {cr: 7}}}), "4d6");

let bonusDamage;
let itemUpdate;
let confirmed = 0;
let reactionUsed;
let flatReduction;
let syntheticActivity;
let nearby = [];
let reactionAlreadyUsed = false;
let visible = true;

globalThis.MidiQOL = {
  canSee() { return visible; },
  async setReactionUsed(actor) { reactionUsed = actor; }
};
globalThis.cat = {
  utils: {
    actorUtils: {
      hasUsedReaction() { return reactionAlreadyUsed; }
    },
    combatUtils: {
      isStampedThisTurn(stamps, tokenId, data) {
        return data.inCombat && stamps.some(stamp => stamp.id === tokenId && stamp.combatId === data.combatId && stamp.round === data.currentRound && stamp.turn === data.currentTurn);
      },
      addTurnStamp(stamps, tokenId, data) {
        return [...stamps.filter(stamp => stamp.id !== tokenId), {id: tokenId, combatId: data.combatId, round: data.currentRound, turn: data.currentTurn}];
      }
    },
    dialogUtils: {
      async confirmUseItem() { confirmed += 1; return true; }
    },
    documentUtils: {
      async update(_document, changes) { itemUpdate = changes; }
    },
    queryUtils: {
      firstOwner() { return "player"; }
    },
    tokenUtils: {
      getCombatData() { return {inCombat: true, combatId: "combat", currentRound: 2, currentTurn: 1}; },
      findNearby() { return nearby; },
      isEnemy(left, right) { return (left.disposition >= 0 && right.disposition < 0) || (left.disposition < 0 && right.disposition >= 0); }
    },
    workflowUtils: {
      isAttackType(workflow, type) {
        const action = workflow.activity?.actionType;
        if (type === "attack") return ["mwak", "rwak", "msak", "rsak"].includes(action);
        if (type === "meleeWeaponAttack") return action === "mwak";
        if (type === "rangedWeaponAttack") return action === "rwak";
        return false;
      },
      async bonusDamage(_workflow, formula, options) { bonusDamage = {formula, options}; },
      modifyDamageAppliedFlat(_ditem, amount) { flatReduction = amount; },
      async syntheticActivityRoll(activity, targets, options) { syntheticActivity = {activity, targets, options}; return {}; }
    }
  }
};

const rogueToken = {id: "rogue-token", uuid: "Scene.test.Token.rogue", disposition: 1, actor: rogueActor, object: {}};
const enemyToken = {id: "enemy-token", uuid: "Scene.test.Token.enemy", disposition: -1, actor: {}, object: {}};
const allyToken = {id: "ally-token", uuid: "Scene.test.Token.ally", disposition: 1, actor: {}, object: {}};
nearby = [rogueToken, allyToken];
const sneakItem = {
  name: "Sneak Attack",
  actor: rogueActor,
  flags: {},
  system: {identifier: ROGUE_IDS.sneakAttack}
};
const sneakWorkflow = {
  actor: rogueActor,
  token: rogueToken,
  item: {system: {properties: new Set(["fin"])}},
  activity: {actionType: "mwak"},
  hitTargets: new Set([enemyToken]),
  defaultDamageType: "piercing",
  advantage: false,
  disadvantage: false
};

registerDocuments(rogueActor, sneakItem);
const sneakMacro = byIdentifier(ROGUE_IDS.sneakAttack).roll[0].macro;
assert.equal(await sneakMacro({workflow: sneakWorkflow, document: sneakItem}), undefined);
assert.deepEqual(bonusDamage, {formula: "4d6", options: {damageType: "piercing"}});
assert.equal(confirmed, 1);
assert.equal(itemUpdate["flags.khuzoe-automations.sneakAttackStamps"][0].turn, 1);

sneakItem.flags["khuzoe-automations"] = {sneakAttackStamps: itemUpdate["flags.khuzoe-automations.sneakAttackStamps"]};
assert.equal(await sneakMacro({workflow: sneakWorkflow, document: sneakItem}), undefined);
assert.equal(confirmed, 1);

sneakWorkflow.disadvantage = true;
sneakItem.flags = {};
assert.equal(await sneakMacro({workflow: sneakWorkflow, document: sneakItem}), undefined);
sneakWorkflow.disadvantage = false;
sneakWorkflow.item.system.properties = new Set();
assert.equal(await sneakMacro({workflow: sneakWorkflow, document: sneakItem}), undefined);

const uncannyActivity = {_id: ROGUE_ACTIVITY_IDS.uncannyDodge};
const uncannyItem = {
  name: "Uncanny Dodge",
  actor: rogueActor,
  system: {activities: new Map([[ROGUE_ACTIVITY_IDS.uncannyDodge, uncannyActivity]])}
};
const uncannyWorkflow = {
  token: enemyToken,
  activity: {actionType: "mwak"},
  hitTargets: new Set([rogueToken])
};
registerDocuments(uncannyItem);
const uncannyMacro = byIdentifier(ROGUE_IDS.uncannyDodge).roll[0].macro;
assert.equal(await uncannyMacro({
  workflow: uncannyWorkflow,
  targetToken: rogueToken,
  sourceToken: enemyToken,
  ditem: {hpDamage: 21, tempDamage: 0},
  document: uncannyItem
}), undefined);
assert.equal(flatReduction, -11);
assert.equal(reactionUsed, rogueActor);
assert.equal(syntheticActivity.activity, uncannyActivity);
assert.equal(syntheticActivity.options.consumeUsage, false);

reactionAlreadyUsed = true;
assert.equal(await uncannyMacro({
  workflow: uncannyWorkflow,
  targetToken: rogueToken,
  sourceToken: enemyToken,
  ditem: {hpDamage: 20, tempDamage: 0},
  document: uncannyItem
}), undefined);
reactionAlreadyUsed = false;
visible = false;
assert.equal(await uncannyMacro({
  workflow: uncannyWorkflow,
  targetToken: rogueToken,
  sourceToken: enemyToken,
  ditem: {hpDamage: 20, tempDamage: 0},
  document: uncannyItem
}), undefined);

const automationUpdate = {
  img: "source.webp",
  system: {identifier: ROGUE_IDS.sneakAttack},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
prepareRogueItemUpdate({img: "custom.webp", system: {identifier: ROGUE_IDS.sneakAttack}}, automationUpdate);
assert.equal(automationUpdate.img, "custom.webp");

console.log("Khuzoe Automations Rogue 2014: Sneak Attack, Cunning Action, Uncanny Dodge, Evasion e Reliable Talent OK");
