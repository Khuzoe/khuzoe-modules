import {RELEASE_VERSION} from "../scripts/release.mjs";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

import {
  EXPANDED_SPELL_CATALOG,
  EXPANDED_SPELL_IDENTIFIERS,
  expandedSpellId
} from "../scripts/expanded-spell-catalog.mjs";
import {
  EXPANDED_SPELL_AUTOMATIONS,
  registerExpandedSpells2014
} from "../scripts/expanded-spells-2014.mjs";

assert.equal(EXPANDED_SPELL_CATALOG.length, 78);
assert.equal(new Set(EXPANDED_SPELL_IDENTIFIERS).size, 78);
assert.equal(new Set(EXPANDED_SPELL_CATALOG.map(entry => entry.id)).size, 78);
assert.equal(EXPANDED_SPELL_CATALOG.filter(entry => entry.difficulty === "easy").length, 15);
assert.equal(EXPANDED_SPELL_CATALOG.filter(entry => entry.difficulty === "medium").length, 63);
for (const entry of EXPANDED_SPELL_CATALOG) {
  assert.equal(entry.id, expandedSpellId(entry.identifier));
  assert.match(entry.id, /^[A-Za-z0-9]{16}$/);
}

assert.equal(EXPANDED_SPELL_AUTOMATIONS.length, 78);
for (const automation of EXPANDED_SPELL_AUTOMATIONS) {
  assert.equal(automation.source, "khuzoe-automations");
  assert.equal(automation.rules, "2014");
  assert.equal(automation.type, "spell");
  assert.match(automation.uuid, /^Compendium\.khuzoe-automations\.KhuzoeSpells2014\.Item\.[A-Za-z0-9]{16}$/);
}

const registeredMacros = [];
const registeredAutomations = [];
const result = registerExpandedSpells2014({
  registerFnMacro(data) { registeredMacros.push(data); return true; },
  registerAutomation(data) { registeredAutomations.push(data); return true; }
});
assert.equal(result.macros.length, 79);
assert.equal(result.automations.length, 78);
assert.equal(registeredMacros.length, 79);
assert.equal(registeredAutomations.length, 78);
for (const identifier of EXPANDED_SPELL_IDENTIFIERS) {
  const macro = registeredMacros.find(entry => entry.identifier === identifier);
  assert.ok(macro, `${identifier}: macro principale mancante`);
  assert.deepEqual(macro.roll.map(entry => entry.pass), [
    "itemPreambleComplete",
    "itemDamage",
    "itemDamageRoll",
    "itemDamageRollBonuses",
    "itemRollFinished"
  ]);
}
const effectMacro = registeredMacros.find(entry => entry.identifier === "khuzoe-expanded-spell-effect");
assert.ok(effectMacro);
assert.ok(effectMacro.roll.some(entry => entry.pass === "actorDamageRollBonuses"));
assert.ok(effectMacro.roll.some(entry => entry.pass === "targetDamageFlatReductions"));
assert.ok(effectMacro.roll.some(entry => entry.pass === "targetDamageComplete"));
assert.equal(effectMacro.aura[0].distance, 30);
assert.equal(effectMacro.aura.length, 1);
assert.ok(effectMacro.combat.some(trigger => trigger.pass === "sceneTurnStart"));

const directory = new URL("../packData/khuzoe-spells-2014/", import.meta.url);
const files = (await readdir(directory)).filter(file => file.endsWith(".json"));
const expected = new Set(EXPANDED_SPELL_IDENTIFIERS);
const documents = [];
for (const file of files) {
  const document = JSON.parse(await readFile(new URL(file, directory), "utf8"));
  if (!expected.has(document.system?.identifier)) continue;
  documents.push(document);
  assert.equal(document._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(document.system.source.rules, "2014");
  assert.equal(document.flags.cat.automation.source, "khuzoe-automations");
  assert.equal(document.flags.cat.automation.version, RELEASE_VERSION);
  assert.deepEqual(document.flags.cat.macros?.roll, [{
    source: "khuzoe-automations",
    rules: "2014",
    identifier: document.system.identifier
  }], `${document.system.identifier}: riferimento alla macro runtime mancante`);
  assert.equal(document.flags["chris-premades"], undefined, `${file}: flag runtime Cauldron residuo`);
  for (const activity of Object.values(document.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
  for (const effect of document.effects ?? []) {
    assert.equal(effect._id.length, 16, `${file}: ID effetto non valido`);
    assert.ok(Array.isArray(effect.system?.changes), `${file}: changes non migrati allo schema v14`);
    assert.equal(effect.flags?.["chris-premades"], undefined, `${file}: flag effetto Cauldron residuo`);
  }
}
assert.equal(documents.length, 78);
assert.deepEqual(new Set(documents.map(document => document.system.identifier)), expected);

const grease = documents.find(document => document.system.identifier === "grease");
const greaseActivity = grease.system.activities[grease.flags["khuzoe-automations"].activityIdentifiers.grease];
assert.deepEqual(greaseActivity.flags.cat.placed.region.activities[0].triggers, ["enter", "turnEnd"]);

const expectedStatuses = new Map([
  ["blinding-smite", "blinded"],
  ["charm-person", "charmed"],
  ["hold-person", "paralyzed"],
  ["hypnotic-pattern", "incapacitated"],
  ["raulothims-psychic-lance", "incapacitated"],
  ["spray-of-cards", "blinded"],
  ["wrathful-smite", "frightened"]
]);
for (const [identifier, status] of expectedStatuses) {
  const document = documents.find(entry => entry.system.identifier === identifier);
  assert.ok(document.effects.some(effect => effect.statuses?.includes(status)), `${identifier}: stato ${status} mancante`);
}

const bladeWard = documents.find(document => document.system.identifier === "blade-ward");
const bladeWardEffect = bladeWard.effects[0];
assert.equal(
  bladeWardEffect.system.changes.some(change => change.key === "system.traits.dr.value"),
  false,
  "Blade Ward: non deve concedere una resistenza fisica globale"
);
assert.equal(
  bladeWardEffect.flags?.["khuzoe-automations"]?.expandedSpell?.identifier,
  "blade-ward",
  "Blade Ward: gestore condizionale mancante"
);

let bladeWardReduction = 0;
globalThis.cat = {
  utils: {
    workflowUtils: {
      isAttackType() { return false; },
      modifyDamageAppliedFlat(_ditem, amount) { bladeWardReduction += amount; }
    }
  }
};
const bladeWardMacro = effectMacro.roll.find(entry => entry.pass === "targetDamageFlatReductions").macro;
bladeWardMacro({
  document: {...bladeWardEffect, parent: {}},
  workflow: {activity: {actionType: "mwak"}},
  ditem: {damageDetail: [
    {type: "slashing", value: 5},
    {type: "piercing", value: 3},
    {type: "fire", value: 7}
  ]}
});
assert.equal(bladeWardReduction, -5, "Blade Ward: deve dimezzare separatamente solo B/P/S");
bladeWardReduction = 0;
bladeWardMacro({
  document: {...bladeWardEffect, parent: {}},
  workflow: {activity: {actionType: "save"}},
  ditem: {damageDetail: [{type: "bludgeoning", value: 9}]}
});
assert.equal(bladeWardReduction, 0, "Blade Ward: non deve ridurre danni estranei a un attacco con arma");

const synapticStatic = documents.find(document => document.system.identifier === "synaptic-static");
assert.equal(
  synapticStatic.effects.some(effect => effect.system.changes.some(change =>
    change.key === "system.attributes.concentration.bonuses.save"
  )),
  false,
  "Synaptic Static: non deve penalizzare i TS di concentrazione"
);

const enlargeMacro = registeredMacros
  .find(entry => entry.identifier === "enlarge-reduce")
  ?.roll.find(entry => entry.pass === "itemRollFinished")?.macro;
const enlargePrepareMacro = registeredMacros
  .find(entry => entry.identifier === "enlarge-reduce")
  ?.roll.find(entry => entry.pass === "itemPreambleComplete")?.macro;
assert.equal(typeof enlargeMacro, "function", "Enlarge/Reduce: macro finale mancante");
assert.equal(typeof enlargePrepareMacro, "function", "Enlarge/Reduce: macro consenso mancante");

const createdEffects = [];
const tokenUpdates = [];
const deletedEffects = [];
const dialogCalls = [];
const dialogAnswers = ["accept", "enlarge"];
const targetActor = {
  uuid: "Actor.EnlargeTarget01",
  name: "Bersaglio consenziente",
  system: {traits: {size: "med"}},
  effects: [],
  // Foundry v14 può restituire direttamente TokenDocument quando viene
  // richiesto il documento invece del placeable canvas.
  getActiveTokens() { return [targetToken]; }
};
const targetToken = {
  uuid: "Scene.EnlargeScene01.Token.EnlargeToken01",
  name: "Bersaglio consenziente",
  actor: targetActor,
  width: 1,
  height: 1,
  texture: {scaleX: 1, scaleY: 1}
};
const sourceActor = {uuid: "Actor.EnlargeSource01", effects: []};
const enlargeItem = {
  uuid: "Actor.EnlargeSource01.Item.EnlargeReduce01",
  actor: sourceActor,
  name: "Enlarge/Reduce",
  img: "icons/magic/control/silhouette-grow-shrink-tan.webp",
  system: {identifier: "enlarge-reduce", level: 2, duration: {value: 1, units: "minute"}}
};
globalThis.game = {user: {id: "User.Test01"}};
globalThis.MidiQOL = {playerForActor() { return {id: "User.TargetOwner01"}; }};
globalThis.fromUuid = async uuid => uuid === targetToken.uuid ? targetToken : null;
globalThis.cat = {
  utils: {
    dialogUtils: {
      async buttonDialog(...args) {
        dialogCalls.push(args);
        return dialogAnswers.shift();
      }
    },
    actorUtils: {getFirstToken() { return null; }},
    effectUtils: {
      async createEffects(actor, data) {
        createdEffects.push({actor, data});
        const effect = {uuid: `${actor.uuid}.ActiveEffect.EnlargeEffect0${createdEffects.length}`, ...data[0]};
        actor.effects.push(effect);
        return [effect];
      },
      getConcentrationEffect() { return null; }
    },
    documentUtils: {
      async deleteDocument(effect) { deletedEffects.push(effect); },
      async makeDependent() {},
      async update(document, data) { tokenUpdates.push({document, data}); }
    }
  }
};

const enlargeWorkflow = {
  id: "Workflow.Enlarge01",
  actor: sourceActor,
  item: enlargeItem,
  targets: new Set([targetToken]),
  failedSaves: new Set([targetToken])
};
await enlargePrepareMacro({workflow: enlargeWorkflow, item: enlargeItem});
const consentEffect = createdEffects.find(entry =>
  entry.data[0].flags?.["khuzoe-automations"]?.expandedSpell?.kind === "voluntary-fail"
);
assert.ok(consentEffect, "Enlarge/Reduce: fallimento volontario non predisposto");
assert.ok(consentEffect.data[0].system.changes.some(change =>
  change.key === "flags.midi-qol.fail.ability.save.con" && change.value === "1"
));
assert.equal(consentEffect.data[0].showIcon, 0);
assert.deepEqual(consentEffect.data[0].flags.dae.specialDuration, ["isSave"]);
assert.equal(dialogCalls[0]?.[3]?.userId, "User.TargetOwner01");

await enlargeMacro({
  workflow: enlargeWorkflow,
  item: enlargeItem
});
const sizeEffect = createdEffects.find(entry =>
  entry.data[0].flags?.["khuzoe-automations"]?.expandedSpell?.kind === "size"
);
assert.ok(sizeEffect, "Enlarge/Reduce: effetto non creato");
const enlargeChanges = sizeEffect.data[0].system.changes;
assert.ok(enlargeChanges.some(change => change.key === "system.traits.size" && change.value === "lg"));
assert.ok(enlargeChanges.some(change => change.key === "system.bonuses.mwak.damage" && change.value === "1d4"));
assert.deepEqual(tokenUpdates[0]?.data, {width: 2, height: 2});
assert.ok(deletedEffects.some(effect => effect.flags?.["khuzoe-automations"]?.expandedSpell?.kind === "voluntary-fail"));

const effectsAfterAcceptedCast = createdEffects.length;
dialogAnswers.push("resist");
const resistedWorkflow = {...enlargeWorkflow, id: "Workflow.Enlarge02", failedSaves: new Set()};
await enlargePrepareMacro({workflow: resistedWorkflow, item: enlargeItem});
await enlargeMacro({workflow: resistedWorkflow, item: enlargeItem});
assert.equal(createdEffects.length, effectsAfterAcceptedCast, "Enlarge/Reduce: effetto applicato dopo un TS riuscito");

// Vortex Warp usa lo stesso consenso esplicito di Enlarge/Reduce, ma esclude
// il lanciatore e le creature Huge/Gargantuan prima del TS.
const vortexPrepareMacro = registeredMacros
  .find(entry => entry.identifier === "vortex-warp")
  ?.roll.find(entry => entry.pass === "itemPreambleComplete")?.macro;
const vortexItem = {
  ...enlargeItem,
  name: "Vortex Warp",
  system: {...enlargeItem.system, identifier: "vortex-warp"}
};
dialogAnswers.push("accept");
const vortexWorkflow = {...enlargeWorkflow, id: "Workflow.Vortex01", item: vortexItem};
await vortexPrepareMacro({workflow: vortexWorkflow, item: vortexItem});
assert.ok(createdEffects.some(entry =>
  entry.data[0].flags?.["khuzoe-automations"]?.expandedSpell?.identifier === "vortex-warp-consent"
), "Vortex Warp: consenso volontario non predisposto");

const targetUpdates = [];
globalThis.cat.utils.workflowUtils = {
  async updateTargets(_workflow, targets) { targetUpdates.push(targets); }
};
const hugeActor = {...targetActor, uuid: "Actor.HugeTarget001", system: {traits: {size: "huge"}}};
const hugeToken = {...targetToken, uuid: "Scene.EnlargeScene01.Token.HugeTarget001", actor: hugeActor};
await vortexPrepareMacro({
  workflow: {...vortexWorkflow, id: "Workflow.Vortex02", targets: new Set([hugeToken])},
  item: vortexItem
});
assert.equal(targetUpdates.length, 0, "Vortex Warp non impone un limite di taglia e conserva Huge come bersaglio");

// Fly concede sempre 60 ft, indipendentemente dalla velocità base del bersaglio.
const flyFinishMacro = registeredMacros
  .find(entry => entry.identifier === "fly")
  ?.roll.find(entry => entry.pass === "itemRollFinished")?.macro;
const flyItem = {...enlargeItem, name: "Fly", system: {...enlargeItem.system, identifier: "fly", duration: {value: 10, units: "minute"}}};
targetActor.system.attributes = {movement: {walk: 25}};
await flyFinishMacro({workflow: {...enlargeWorkflow, item: flyItem}, item: flyItem});
const flyEffect = createdEffects.at(-1).data[0];
assert.ok(flyEffect.system.changes.some(change => change.key === "system.attributes.movement.fly" && change.value === "60"));

// Tasha's Otherworldly Guise non usa un percorso Actor inesistente per
// "mgc": rende invece magici i DamageRoll dell'arma e ne imposta l'abilità.
const tashaFinishMacro = registeredMacros
  .find(entry => entry.identifier === "tashas-otherworldly-guise")
  ?.roll.find(entry => entry.pass === "itemRollFinished")?.macro;
const tashaItem = {...enlargeItem, name: "Tasha's Otherworldly Guise", system: {...enlargeItem.system, identifier: "tashas-otherworldly-guise"}};
dialogAnswers.push("upper");
await tashaFinishMacro({workflow: {...enlargeWorkflow, actor: sourceActor, item: tashaItem, targets: new Set()}, item: tashaItem});
const tashaEffect = createdEffects.at(-1).data[0];
assert.equal(tashaEffect.system.changes.some(change => change.key === "system.properties"), false);
const tashaEffectDocument = {...tashaEffect, parent: sourceActor};
const attackActivityData = {id: "WeaponAttack0001", actionType: "mwak", attack: {ability: ""}};
const syntheticActivity = {...attackActivityData};
globalThis.cat.utils.itemUtils = {
  syntheticItem(itemData) {
    return {system: {activities: new Map([["WeaponAttack0001", itemData.system.activities.WeaponAttack0001]])}};
  }
};
const weaponItem = {
  type: "weapon",
  toObject() { return {system: {activities: {WeaponAttack0001: structuredClone(attackActivityData)}}}; }
};
const weaponWorkflow = {
  actor: {system: {attributes: {spellcasting: "int"}, abilities: {int: {mod: 4}, str: {mod: 2}, dex: {mod: 1}}}},
  item: weaponItem,
  activity: syntheticActivity
};
const attackContextMacro = effectMacro.roll.find(entry => entry.pass === "actorAttackRollConfig").macro;
attackContextMacro({document: tashaEffectDocument, workflow: weaponWorkflow});
assert.equal(weaponWorkflow.activity.attack.ability, "int");
weaponWorkflow.actor.system.abilities.str.mod = 5;
weaponWorkflow.activity = {...attackActivityData, ability: "str"};
attackContextMacro({document: tashaEffectDocument, workflow: weaponWorkflow});
assert.equal(weaponWorkflow.activity.ability, "str", "Guise must not replace a stronger weapon ability");
const damageRoll = {options: {properties: new Set()}};
let tashaDamageRolls = [];
const damageRollMacro = effectMacro.roll.find(entry => entry.pass === "actorDamageRoll").macro;
await damageRollMacro({
  document: tashaEffectDocument,
  workflow: {...weaponWorkflow, damageRoll, async setDamageRolls(rolls) { tashaDamageRolls = rolls; }}
});
assert.equal(tashaDamageRolls[0].options.properties.has("mgc"), true);

// CAT 0.0.7 restituisce le scelte dei bersagli dentro `{result: ...}`.
// Questi test proteggono i rami che in precedenza leggevano ancora il vecchio
// formato array e quindi non eseguivano le attività tecniche selezionate.
const dialogTargetA = {id: "DialogTarget0001", uuid: "Scene.Dialog.Token.DialogTarget0001", actor: {uuid: "Actor.DialogTarget1"}, disposition: 1};
const dialogTargetB = {id: "DialogTarget0002", uuid: "Scene.Dialog.Token.DialogTarget0002", actor: {uuid: "Actor.DialogTarget2"}, disposition: 1};
const technicalActivity = {id: "TechnicalAct0001"};
const technicalCalls = [];
globalThis.cat = {
  utils: {
    actorUtils: {getFirstToken() { return null; }},
    dialogUtils: {
      async selectTargetDialog() {
        return {result: [
          {document: dialogTargetA, value: 2},
          {document: dialogTargetB, value: 1}
        ]};
      }
    },
    workflowUtils: {
      async syntheticActivityRoll(activity, targets) { technicalCalls.push({activity, targets}); return {}; },
      async syntheticActivityDataRoll(data, item, targets) { technicalCalls.push({data, item, targets}); }
    }
  }
};
const projectileItem = {
  name: "Magic Missile",
  system: {identifier: "magic-missile", activities: new Map([[technicalActivity.id, technicalActivity]])},
  flags: {"khuzoe-automations": {activityIdentifiers: {magicMissileBolt: technicalActivity.id}}}
};
const projectileMacro = registeredMacros.find(entry => entry.identifier === "magic-missile")
  .roll.find(entry => entry.pass === "itemRollFinished").macro;
await projectileMacro({
  workflow: {item: projectileItem, actor: {}, castData: {castLevel: 1}, targets: new Set([dialogTargetA, dialogTargetB])},
  item: projectileItem
});
assert.equal(technicalCalls.length, 3, "Magic Missile: allocazioni CAT non eseguite");
assert.deepEqual(technicalCalls.map(call => call.targets[0]), [dialogTargetA, dialogTargetA, dialogTargetB]);

const completedProjectileRoll = cat.utils.workflowUtils.syntheticActivityRoll;
technicalCalls.length = 0;
cat.utils.workflowUtils.syntheticActivityRoll = async (...args) => { await completedProjectileRoll(...args); return {aborted: true}; };
await projectileMacro({workflow: {item: projectileItem, actor: {}, castData: {castLevel: 1}, targets: new Set([dialogTargetA, dialogTargetB])}, item: projectileItem});
assert.equal(technicalCalls.length, 1, "Cancelling one projectile stops the remaining sequence");
cat.utils.workflowUtils.syntheticActivityRoll = completedProjectileRoll;

technicalCalls.length = 0;
globalThis.cat.utils.dialogUtils.selectTargetDialog = async () => ({result: [dialogTargetB]});
globalThis.cat.utils.tokenUtils = {findNearby() { return [dialogTargetB]; }};
globalThis.cat.utils.activityUtils = {
  getDamageModifiedActivityData(activity, formula, options) { return {activity, formula, options}; }
};
const chainItem = {
  name: "Chain Lightning",
  system: {identifier: "chain-lightning", activities: new Map([[technicalActivity.id, technicalActivity]])},
  flags: {"khuzoe-automations": {activityIdentifiers: {chainLightningLeap: technicalActivity.id}}}
};
const chainMacro = registeredMacros.find(entry => entry.identifier === "chain-lightning")
  .roll.find(entry => entry.pass === "itemRollFinished").macro;
await chainMacro({
  workflow: {item: chainItem, actor: {}, token: {id: "CasterToken00001"}, castData: {castLevel: 6}, damageTotal: 37, targets: new Set([dialogTargetA])},
  item: chainItem
});
assert.equal(technicalCalls.length, 1, "Chain Lightning: bersagli secondari CAT non eseguiti");
assert.deepEqual(technicalCalls[0].targets, [dialogTargetB]);
assert.equal(technicalCalls[0].data.formula, "37", "Chain Lightning: i salti devono riutilizzare il tiro principale");
assert.deepEqual(technicalCalls[0].data.options.types, ["lightning"]);

technicalCalls.length = 0;
const hitDieClass = {
  id: "ClassHitDie00001",
  isOwner: true,
  system: {levels: 3, hd: {denomination: "d8", spent: 0}},
  async update(updates) { this.system.hd.spent = updates["system.hd.spent"]; }
};
globalThis.cat.utils.dialogUtils.selectTargetDialog = async () => ({result: dialogTargetB});
globalThis.cat.utils.dialogUtils.selectHitDie = async () => [{document: hitDieClass, amount: 1}];
globalThis.cat.utils.activityUtils = {
  getDamageModifiedActivityData(activity, formula) { return {activity, formula}; }
};
const witherItem = {
  name: "Wither and Bloom",
  system: {identifier: "wither-and-bloom", activities: new Map([[technicalActivity.id, technicalActivity]])},
  flags: {"khuzoe-automations": {activityIdentifiers: {witherAndBloomHeal: technicalActivity.id}}}
};
globalThis.fromUuid = async uuid => uuid === dialogTargetB.uuid ? dialogTargetB : null;
dialogTargetB.actor.system = {attributes: {hp: {value: 5, max: 30}}};
globalThis.cat.utils.itemUtils = {syntheticItem: (data, actor) => ({...data, actor})};
globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll = async (data, item, targets) => { technicalCalls.push({data, item, targets}); return {}; };
const witherMacro = registeredMacros.find(entry => entry.identifier === "wither-and-bloom")
  .roll.find(entry => entry.pass === "itemRollFinished").macro;
await witherMacro({
  workflow: {
    item: witherItem,
    khuzoeBloomTarget: dialogTargetB.uuid,
    actor: {system: {attributes: {spell: {mod: 3}}}},
    token: {disposition: 1},
    castData: {castLevel: 2},
    targets: new Set([dialogTargetA, dialogTargetB])
  },
  item: witherItem
});
assert.equal(hitDieClass.system.hd.spent, 1, "Wither and Bloom: Dado Vita non consumato");
assert.equal(technicalCalls[0].data.healing.custom.formula, "1d8 + 3");
assert.deepEqual(technicalCalls[0].targets, [dialogTargetB]);

// Blight: una pianta fallisce automaticamente il TS di Costituzione prima
// che Midi lo risolva; la massimizzazione del danno avviene nel pass seguente.
const blightPrepareMacro = registeredMacros.find(entry => entry.identifier === "blight")
  .roll.find(entry => entry.pass === "itemPreambleComplete").macro;
const blightEffects = [];
const plantActor = {uuid: "Actor.BlightPlant01", effects: [], system: {}};
const plantToken = {uuid: "Scene.Test.Token.BlightPlant01", actor: plantActor};
const blightItem = {
  uuid: "Actor.Caster.Item.Blight01",
  actor: sourceActor,
  name: "Blight",
  img: "blight.webp",
  system: {identifier: "blight", duration: {value: 0, units: "inst"}}
};
globalThis.cat = {utils: {
  actorUtils: {typeOrRace(actor) { return actor === plantActor ? "plant" : "humanoid"; }},
  effectUtils: {async createEffects(actor, data) { blightEffects.push({actor, data}); return data; }},
  documentUtils: {async deleteDocument() {}, async makeDependent() {}},
  workflowUtils: {}
}};
await blightPrepareMacro({workflow: {actor: sourceActor, item: blightItem, targets: new Set([plantToken])}, item: blightItem});
assert.ok(blightEffects[0].data[0].system.changes.some(change =>
  change.key === "flags.midi-qol.disadvantage.ability.save.con" && change.value === "1"
), "Blight: svantaggio al TS delle piante mancante");

// Un'attività tecnica non deve riattivare lo Smite che l'ha invocata.
const smiteFinishMacro = registeredMacros.find(entry => entry.identifier === "branding-smite")
  .roll.find(entry => entry.pass === "itemRollFinished").macro;
let smiteEffectsCreated = 0;
globalThis.cat.utils.effectUtils = {
  async createEffects(_actor, data) { smiteEffectsCreated += data.length; return data; },
  getConcentrationEffect() { return null; }
};
const smiteItem = {
  uuid: "Actor.Caster.Item.BrandingSmite01",
  actor: sourceActor,
  name: "Branding Smite",
  img: "smite.webp",
  system: {identifier: "branding-smite", duration: {value: 1, units: "minute"}}
};
await smiteFinishMacro({
  workflow: {actor: sourceActor, item: smiteItem, activity: {type: "damage", midiProperties: {automationOnly: true}}},
  item: smiteItem
});
assert.equal(smiteEffectsCreated, 0, "Smite: l'attività tecnica ha riattivato il buff");
await smiteFinishMacro({workflow: {actor: sourceActor, item: smiteItem, activity: {type: "utility"}}, item: smiteItem});
assert.equal(smiteEffectsCreated, 1, "Smite: l'attività di lancio non ha creato il buff");

// Fire Shield reagisce esclusivamente a un attacco in mischia. Essere entro
// 5 ft non trasforma un attacco a distanza in un attacco in mischia.
const onHitMacro = effectMacro.roll.find(entry => entry.pass === "targetOnHit").macro;
let retaliationCount = 0;
const shieldOwner = {id: "ShieldOwnerToken", actor: {}};
const shieldAttacker = {id: "ShieldAttackerToken", actor: {}};
const fireShieldItem = {documentName: "Item", uuid: "Actor.Caster.Item.FireShield01", name: "Fire Shield", system: {activities: new Map()}};
const fireShieldEffect = {
  origin: fireShieldItem.uuid,
  parent: shieldOwner.actor,
  flags: {"khuzoe-automations": {expandedSpell: {identifier: "fire-shield", kind: "self-buff", formula: "2d8", damageType: "fire"}}}
};
globalThis.fromUuid = async uuid => uuid === fireShieldItem.uuid ? fireShieldItem : null;
globalThis.cat.utils.actorUtils = {getFirstToken() { return shieldOwner; }};
globalThis.cat.utils.tokenUtils = {getDistance() { return 5; }};
globalThis.cat.utils.workflowUtils = {
  isAttackType(workflow, type) { return type === "attack" && ["mwak", "rwak", "msak", "rsak"].includes(workflow.activity?.actionType); },
  async syntheticActivityDataRoll() { retaliationCount += 1; }
};
await onHitMacro({document: fireShieldEffect, workflow: {token: shieldAttacker, activity: {actionType: "rwak"}}});
assert.equal(retaliationCount, 0, "Fire Shield: non deve reagire a un attacco a distanza");
await onHitMacro({document: fireShieldEffect, workflow: {token: shieldAttacker, activity: {actionType: "mwak"}}});
assert.equal(retaliationCount, 1, "Fire Shield: deve reagire a un attacco in mischia entro 5 ft");

// Lightning Arrow sostituisce il danno dell'arma con soli d8: il modificatore
// dell'arma non viene sommato una seconda volta.
const lightningDamageMacro = effectMacro.roll.find(entry => entry.pass === "actorDamageRoll").macro;
let lightningFormula = "";
globalThis.CONFIG = {
  ...globalThis.CONFIG,
  Dice: {DamageRoll: class {
    constructor(formula) { lightningFormula = formula; this.formula = formula; }
    async evaluate() { return this; }
  }}
};
globalThis.cat.utils.workflowUtils.isAttackType = () => true;
await lightningDamageMacro({
  document: {flags: {"khuzoe-automations": {expandedSpell: {identifier: "lightning-arrow", kind: "weapon-trigger", castLevel: 3}}}},
  workflow: {
    activity: {actionType: "rwak"},
    item: {type: "weapon", getRollData() { return {}; }},
    async setDamageRolls() {}
  }
});
assert.equal(lightningFormula, "4d8", "Lightning Arrow: il danno sostitutivo non deve contenere @mod");

// Use D&D5e's installed NPC rule: innate cantrips use CR; other cantrips
// use character/spellcaster level. Exercise the real spell entry points.
const dndSource = await readFile(new URL("../../../systems/dnd5e/dnd5e.mjs", import.meta.url), "utf8");
const nativeStart = dndSource.lastIndexOf("  cantripLevel(spell) {");
const nativeEnd = dndSource.indexOf("\n  }", nativeStart) + 4;
assert.ok(nativeStart > 0);
const nativeCantrip = Function(`return {${dndSource.slice(nativeStart, nativeEnd)}}`)().cantripLevel;
const npc = {type: "npc", system: {details: {cr: 2, level: 0}, attributes: {spell: {level: 11, mod: 4}}, cantripLevel: nativeCantrip}};
const spellScene = {id: "cantripScene", grid: {distance: 5, units: "ft"}};
const npcToken = {documentName: "Token", id: "npc", uuid: "Scene.cantripScene.Token.npc", actor: npc, parent: spellScene};
const victim = {documentName: "Token", id: "victim", uuid: "Scene.cantripScene.Token.victim", actor: {}, parent: spellScene};
const hiddenTarget = {documentName: "Token", id: "hidden", actor: {}, parent: spellScene};
const beamItem = {name: "Eldritch Blast", actor: npc, system: {identifier: "eldritch-blast", method: "spell", activities: new Map([[technicalActivity.id, technicalActivity]])},
  flags: {"khuzoe-automations": {activityIdentifiers: {eldritchBlastBeam: technicalActivity.id}}}};
let beamCount = 0;
cat.utils.dialogUtils ??= {};
cat.utils.dialogUtils.selectTargetDialog = async () => ({result: [{document: victim, value: 9}]});
cat.utils.workflowUtils.syntheticActivityRoll = async () => { beamCount++; return {}; };
const beamMacro = registeredMacros.find(entry => entry.identifier === "eldritch-blast").roll.find(entry => entry.pass === "itemRollFinished").macro;
await beamMacro({workflow: {actor: npc, item: beamItem, targets: new Set([victim])}, item: beamItem});
assert.equal(beamCount, 3, "A CR 2 NPC with spellcaster level 11 has three non-innate beams");
beamItem.system.method = "innate"; beamCount = 0;
await beamMacro({workflow: {actor: npc, item: beamItem, targets: new Set([victim])}, item: beamItem});
assert.equal(beamCount, 1, "The same innate cantrip follows the system's CR rule");

const weaponData = {name: "Sword", type: "weapon", system: {equipped: true, activities: {
  attack: {_id: "attack", type: "attack", attack: {type: {value: "melee"}}, damage: {parts: []}}
}}};
npc.items = [{...structuredClone(weaponData), toObject: () => structuredClone(weaponData)}];
const greenItem = {...beamItem, name: "Green-Flame Blade", system: {...beamItem.system, identifier: "green-flame-blade", method: "spell"},
  flags: {"khuzoe-automations": {activityIdentifiers: {greenFlameBladeLeap: technicalActivity.id}}}};
let weaponDice, secondaryDamage, chooseSecondary = false, offered;
cat.utils.workflowUtils.syntheticItemDataRoll = async data => { weaponDice = data.system.activities.attack.damage.parts[0].number; return {hitTargets: new Set([victim])}; };
cat.utils.workflowUtils.syntheticActivityDataRoll = async data => { secondaryDamage = data.formula; return {}; };
cat.utils.activityUtils = {getDamageModifiedActivityData: (_activity, formula) => ({formula})};
cat.utils.tokenUtils = {findNearby: () => [victim, npcToken, hiddenTarget]};
globalThis.MidiQOL = {canSee: (_source, target) => target !== hiddenTarget};
cat.utils.dialogUtils.selectTargetDialog = async (_name, _message, candidates) => { offered = candidates; return {result: chooseSecondary ? npcToken : null}; };
const greenMacro = registeredMacros.find(entry => entry.identifier === "green-flame-blade").roll.find(entry => entry.pass === "itemRollFinished").macro;
const greenWorkflow = {actor: npc, token: npcToken, item: greenItem, targets: new Set([victim])};
await greenMacro({workflow: greenWorkflow, item: greenItem});
assert.equal(weaponDice, 2, "Green-Flame Blade uses the native NPC spellcaster level");
assert.deepEqual(offered, [npcToken], "The caster is a legal optional secondary target; hidden creatures are not");
assert.equal(secondaryDamage, undefined, "The only available secondary target is never damaged automatically");
chooseSecondary = true;
await greenMacro({workflow: greenWorkflow, item: greenItem});
assert.equal(secondaryDamage, "2d8 + 4");

console.log("Khuzoe Automations | Test spell 2014 facili/medie superati.");
