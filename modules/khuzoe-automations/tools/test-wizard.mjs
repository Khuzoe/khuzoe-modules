import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

globalThis.Hooks = {on() {}};
globalThis.game = {user: {id: "player", isGM: false}};
globalThis.ui = {notifications: {warn() {}, info() {}, error() {}}};

const {
  BLADESONG_EFFECT_ID,
  WIZARD_ACTIVITY_IDS,
  WIZARD_IDS,
  arcaneRecoveryBudget,
  endBladesongIfIncapacitated,
  getWizardLevel,
  prepareWizardItemUpdate,
  registerWizard
} = await import("../scripts/wizard.mjs");

const automations = [];
const macros = [];
const api = {
  registerAutomation(data) { automations.push(data); return true; },
  registerFnMacro(data) { macros.push(data); return data; }
};
const registration = registerWizard(api);
assert.equal(registration.automations.length, 4);
assert.equal(registration.macros.length, 5);
for (const identifier of Object.values(WIZARD_IDS)) {
  assert.ok(automations.some(entry => entry.identifier === identifier && entry.rules === "2014"));
  assert.ok(macros.some(entry => entry.identifier === identifier && entry.rules === "2014"));
}

const byIdentifier = identifier => macros.find(entry => entry.identifier === identifier);
assert.equal(byIdentifier(WIZARD_IDS.songDefense).roll[0].pass, "targetDamageFlatReductions");
assert.equal(byIdentifier(WIZARD_IDS.songVictory).roll[0].pass, "actorDamageRollBonuses");

const packDirectory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
const sourceFiles = (await readdir(packDirectory)).filter(file => file.endsWith(".json"));
const wizardDocuments = [];
for (const file of sourceFiles) {
  const data = JSON.parse(await readFile(new URL(file, packDirectory), "utf8"));
  if (!Object.values(WIZARD_IDS).includes(data.system?.identifier)) continue;
  wizardDocuments.push(data);
  assert.equal(data._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(data.system.source.rules, "2014");
  assert.equal(data.flags.cat.automation.source, "khuzoe-automations");
  for (const activity of Object.values(data.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
}
assert.equal(wizardDocuments.length, 4);
const arcaneSource = wizardDocuments.find(item => item.system.identifier === WIZARD_IDS.arcaneRecovery);
const bladesongSource = wizardDocuments.find(item => item.system.identifier === WIZARD_IDS.bladesong);
const defenseSource = wizardDocuments.find(item => item.system.identifier === WIZARD_IDS.songDefense);
assert.ok(arcaneSource.system.activities[WIZARD_ACTIVITY_IDS.arcaneRecovery]);
assert.ok(bladesongSource.system.activities[WIZARD_ACTIVITY_IDS.bladesongStart]);
assert.ok(bladesongSource.system.activities[WIZARD_ACTIVITY_IDS.bladesongEnd]);
assert.equal(defenseSource.system.activities[WIZARD_ACTIVITY_IDS.songDefense].flags.cat.hidden, true);

let createdEffect;
let itemUseUpdate;
let deletedEffect;
let slotSpent;
let flatReduction;
let reactionActor;
let syntheticDefense;
let bonusDamage;
let slotSelectionFields;
let actorSlotUpdate;

globalThis.MidiQOL = {
  async setReactionUsed(actor) { reactionActor = actor; }
};
globalThis.cat = {
  utils: {
    actorUtils: {
      hasUsedReaction() { return false; },
      hasSpellSlots() { return true; },
      async spendSpellSlots(_actor, slot) { slotSpent = slot; }
    },
    dialogUtils: {
      async selectSpellSlot() { return 2; },
      async selectAmounts(_title, _content, fields) {
        slotSelectionFields = fields;
        return {spell1: 1, spell3: 1};
      }
    },
    documentUtils: {
      async update(document, changes) {
        if (document?.system?.identifier) itemUseUpdate = changes;
        else actorSlotUpdate = changes;
      },
      async deleteDocument(effect) { deletedEffect = effect; }
    },
    effectUtils: {
      async createEffects(_actor, effects) { createdEffect = effects[0]; return effects; }
    },
    queryUtils: {firstOwner() { return "player"; }},
    workflowUtils: {
      modifyDamageAppliedFlat(_ditem, amount) { flatReduction = amount; },
      async syntheticActivityRoll(activity, targets, options) {
        syntheticDefense = {activity, targets, options}; return {};
      },
      async bonusDamage(_workflow, formula, options) { bonusDamage = {formula, options}; }
    }
  }
};

const activeEffect = {
  id: "bladesong-effect",
  active: true,
  disabled: false,
  flags: {cat: {identifier: BLADESONG_EFFECT_ID}}
};
const wizardActor = {
  name: "Lama Cantante",
  classes: {wizard: {system: {levels: 14}}},
  effects: [],
  statuses: new Set(),
  system: {
    abilities: {int: {mod: 4}},
    attributes: {hp: {value: 40}, prof: 5},
    spells: {}
  }
};
const bladesongItem = {
  id: "bladesong",
  uuid: "Actor.Wizard.Item.Bladesong",
  documentName: "Item",
  name: "Bladesong",
  img: "custom-bladesong.webp",
  actor: wizardActor,
  system: {
    identifier: WIZARD_IDS.bladesong,
    uses: {max: "@prof", spent: 1},
    activities: new Map()
  }
};
const bladeWorkflow = {activity: {id: WIZARD_ACTIVITY_IDS.bladesongStart}, item: bladesongItem};
registerDocuments(wizardActor, bladesongItem);
const bladeMacros = byIdentifier(WIZARD_IDS.bladesong).roll;
await bladeMacros.find(entry => entry.pass === "itemPreItemRoll").macro({workflow: bladeWorkflow, document: bladesongItem});
assert.deepEqual(bladeWorkflow.khuzoeBladesong, {mode: "start"});
await bladeMacros.find(entry => entry.pass === "itemRollFinished").macro({workflow: bladeWorkflow, document: bladesongItem});
assert.equal(createdEffect.flags.cat.identifier, BLADESONG_EFFECT_ID);
assert.equal(createdEffect.flags.cat.macros.roll[0].identifier, BLADESONG_EFFECT_ID);
assert.equal(createdEffect.duration.value, 60);
assert.equal(createdEffect.flags.dae.specialDuration[0], "zeroHP");
assert.ok(createdEffect.system.changes.some(change => change.key === "system.attributes.ac.bonus" && change.value === "4"));
assert.ok(createdEffect.system.changes.some(change => change.key === "system.attributes.movement.walk" && change.value === "10"));
assert.ok(createdEffect.system.changes.some(change => change.key === "flags.midi-qol.advantage.skill.acr"));
assert.ok(createdEffect.system.changes.some(change => change.key === "system.attributes.concentration.bonuses.save" && change.value === "4"));
assert.equal(itemUseUpdate["system.uses.spent"], 2);

wizardActor.system.abilities.int.mod = -1;
await bladeMacros.find(entry => entry.pass === "itemRollFinished").macro({workflow: {...bladeWorkflow}, document: bladesongItem});
assert.ok(createdEffect.system.changes.some(change => change.key === "system.attributes.ac.bonus" && change.value === "1"));
assert.ok(createdEffect.system.changes.some(change => change.key === "system.attributes.concentration.bonuses.save" && change.value === "1"));
wizardActor.system.abilities.int.mod = 4;

wizardActor.effects = [activeEffect];
const victoryMacro = byIdentifier(WIZARD_IDS.songVictory).roll[0].macro;
await victoryMacro({
  workflow: {actor: wizardActor, activity: {actionType: "mwak"}, defaultDamageType: "slashing"},
  actor: wizardActor,
  document: {actor: wizardActor}
});
assert.deepEqual(bonusDamage, {formula: "4", options: {damageType: "slashing"}});
wizardActor.system.abilities.int.mod = -1;
await victoryMacro({workflow: {actor: wizardActor, activity: {actionType: "mwak"}, defaultDamageType: "slashing"}, actor: wizardActor, document: {actor: wizardActor}});
assert.equal(bonusDamage.formula, "1", "Song of Victory grants at least +1");
wizardActor.system.abilities.int.mod = 4;

const defenseActivity = {id: WIZARD_ACTIVITY_IDS.songDefense};
const defenseItem = {
  name: "Song of Defense",
  actor: wizardActor,
  system: {
    identifier: WIZARD_IDS.songDefense,
    activities: new Map([[WIZARD_ACTIVITY_IDS.songDefense, defenseActivity]])
  }
};
wizardActor.system.spells = {spell2: {value: 1, max: 2}};
registerDocuments(wizardActor, defenseItem);
const ditem = {hpDamage: 18, tempDamage: 0};
await byIdentifier(WIZARD_IDS.songDefense).roll[0].macro({
  targetToken: {actor: wizardActor},
  ditem,
  document: defenseItem
});
assert.equal(wizardActor.system.spells.spell2.value, 0);
assert.equal(flatReduction, -10);
assert.equal(reactionActor, wizardActor);
assert.equal(syntheticDefense.activity, defenseActivity);
assert.equal(syntheticDefense.options.consumeUsage, false);
assert.equal(syntheticDefense.options.spellSlot, false);

const recoveryActor = {
  flags: {"khuzoe-automations": {arcaneRecoveryRest: true}},
  classes: {wizard: {system: {levels: 7}}},
  system: {
    spells: {
      spell1: {level: 1, value: 2, max: 4},
      spell3: {level: 3, value: 0, max: 1},
      spell5: {level: 5, value: 0, max: 1},
      pact: {level: 2, value: 0, max: 2}
    }
  }
};
const recoveryItem = {
  id: "arcane-recovery",
  documentName: "Item",
  name: "Arcane Recovery",
  actor: recoveryActor,
  system: {
    identifier: WIZARD_IDS.arcaneRecovery,
    uses: {max: "1", spent: 0},
    activities: new Map()
  }
};
registerDocuments(recoveryItem);
const recoveryWorkflow = {activity: {id: WIZARD_ACTIVITY_IDS.arcaneRecovery}, item: recoveryItem};
const recoveryMacros = byIdentifier(WIZARD_IDS.arcaneRecovery).roll;
await recoveryMacros.find(entry => entry.pass === "itemPreItemRoll").macro({workflow: recoveryWorkflow, document: recoveryItem});
assert.equal(slotSelectionFields.length, 2);
assert.equal(slotSelectionFields.find(field => field.name === "spell3").options.weight, 3);
assert.equal(recoveryWorkflow.khuzoeArcaneRecovery.length, 2);
await recoveryMacros.find(entry => entry.pass === "itemRollFinished").macro({workflow: recoveryWorkflow, document: recoveryItem});
assert.deepEqual(actorSlotUpdate, {
  "system.spells.spell1.value": 3,
  "system.spells.spell3.value": 1,
  "flags.khuzoe-automations.arcaneRecoveryRest": false
});
assert.equal(itemUseUpdate["system.uses.spent"], 1);

assert.equal(getWizardLevel(recoveryActor), 7);
assert.equal(arcaneRecoveryBudget(recoveryActor), 4);

const automationUpdate = {
  img: "source.webp",
  system: {identifier: WIZARD_IDS.bladesong, uses: {max: "@prof", spent: 0, recovery: []}},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
const existingUses = {max: "2", spent: 1, recovery: [{period: "sr", type: "recoverAll"}]};
prepareWizardItemUpdate({
  img: "custom.webp",
  system: {identifier: WIZARD_IDS.bladesong, uses: existingUses},
  toObject() { return {system: {uses: existingUses}}; }
}, automationUpdate);
assert.equal(automationUpdate.img, "custom.webp");
assert.equal(automationUpdate.system.uses.max, "2");
assert.equal(automationUpdate.system.uses.spent, 1);
assert.deepEqual(automationUpdate.system.uses.recovery, existingUses.recovery);
assert.notEqual(automationUpdate.system.uses.recovery, existingUses.recovery);

wizardActor.system.attributes.hp.value = 0;
deletedEffect = undefined;
assert.equal(await endBladesongIfIncapacitated(wizardActor), true);
assert.equal(deletedEffect, activeEffect);

wizardActor.system.attributes.hp.value = 40;
deletedEffect = undefined;
activeEffect.parent = wizardActor;
await byIdentifier(BLADESONG_EFFECT_ID).roll[0].macro({
  document: activeEffect,
  workflow: {
    actor: wizardActor,
    activity: {type: "attack", actionType: "mwak"},
    item: {type: "weapon", system: {properties: new Set(["two"])}}
  }
});
assert.equal(deletedEffect, activeEffect, "Un attacco a due mani deve terminare Bladesong");

console.log("Khuzoe Automations Wizard/Bladesinger 2014: Arcane Recovery e Bladesong OK");
