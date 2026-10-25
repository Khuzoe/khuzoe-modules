import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";

import {
  SPELLS_2014_AUTOMATIONS,
  SPELL_2014_ACTIVITY_IDS,
  SPELL_2014_EFFECT_IDS,
  SPELL_2014_IDS,
  activateAuraVitality,
  applyAid,
  blockMagicMissile,
  circlePowerNegateHalfDamage,
  circlePowerSaveAdvantage,
  createAuraLifeTarget,
  prepareAuraVitalityHealing,
  protectionSaveAdvantage,
  registerSpells2014Settings,
  registerSpells2014,
  sanctuaryTargeted,
  summonGuardianOfFaith,
  triggerDeathWard,
  useBoomingBlade
} from "../scripts/spells-2014.mjs";

const expectedIdentifiers = Object.values(SPELL_2014_IDS);
assert.equal(SPELLS_2014_AUTOMATIONS.length, 11);
assert.deepEqual(new Set(SPELLS_2014_AUTOMATIONS.map(entry => entry.identifier)), new Set(expectedIdentifiers));
for (const automation of SPELLS_2014_AUTOMATIONS) {
  assert.equal(automation.source, "khuzoe-automations");
  assert.equal(automation.rules, "2014");
  assert.match(automation.uuid, /^Compendium\.khuzoe-automations\.KhuzoeSpells2014\.Item\.[A-Za-z0-9]{16}$/);
}

const macros = [];
const automations = [];
const registered = registerSpells2014({
  registerFnMacro(data) { macros.push(data); return true; },
  registerAutomation(data) { automations.push(data); return true; }
});
assert.equal(registered.macros.length, 19);
assert.equal(registered.automations.length, 11);
assert.equal(macros.length, 19);
assert.equal(automations.length, 11);
const guardianTrigger = macros.find(entry => entry.identifier === SPELL_2014_EFFECT_IDS.guardianActive);
assert.equal(guardianTrigger.move[0].pass, "nearbyMoved");
assert.equal(guardianTrigger.move[0].distance, 10);
assert.equal(guardianTrigger.combat, undefined);
for (const auraIdentifier of [SPELL_2014_EFFECT_IDS.auraLifeSource, SPELL_2014_EFFECT_IDS.circlePowerSource]) {
  const aura = macros.find(entry => entry.identifier === auraIdentifier).aura[0];
  assert.equal(aura.pass, "update");
  assert.equal(aura.distance, 30);
  assert.deepEqual(aura.dispositions, ["ally"]);
}

const packDirectory = new URL("../packData/khuzoe-spells-2014/", import.meta.url);
const files = (await readdir(packDirectory)).filter(file => file.endsWith(".json"));
const sources = [];
for (const file of files) {
  const source = JSON.parse(await readFile(new URL(file, packDirectory), "utf8"));
  if (!expectedIdentifiers.includes(source.system?.identifier)) continue;
  sources.push(source);
  assert.equal(source._id.length, 16, `${file}: ID oggetto non valido`);
  assert.equal(source.system.source.rules, "2014");
  assert.equal(source.flags.cat.automation.source, "khuzoe-automations");
  for (const activity of Object.values(source.system.activities ?? {})) {
    assert.equal(activity._id.length, 16, `${file}: ID attività non valido`);
  }
}
assert.equal(sources.length, 11);

for (const identifier of [SPELL_2014_IDS.protectionEvilGood, SPELL_2014_IDS.shieldOfFaith, SPELL_2014_IDS.shield]) {
  const source = sources.find(item => item.system.identifier === identifier);
  const activity = Object.values(source.system.activities)[0];
  assert.equal(activity.effects.length, 1, `${identifier}: l'attività deve applicare il proprio effetto`);
  assert.ok(source.effects.some(effect => effect._id === activity.effects[0]._id));
}
const shieldSource = sources.find(item => item.system.identifier === SPELL_2014_IDS.shield);
const shieldActivity = Object.values(shieldSource.system.activities)[0];
assert.match(shieldActivity.useConditionText, /isDamaged/);
assert.match(shieldActivity.useConditionText, /magic-missile/);
assert.equal(shieldSource.effects[0].flags.cat.identifier, SPELL_2014_EFFECT_IDS.shield);
const vitality = sources.find(item => item.system.identifier === SPELL_2014_IDS.auraVitality);
const vitalityHeal = vitality.system.activities[SPELL_2014_ACTIVITY_IDS.auraVitalityHeal];
assert.equal(
  vitalityHeal.midiProperties.identifier,
  "aura-of-vitality-healing"
);
assert.equal(vitalityHeal.flags.cat.hidden, true);
assert.equal(vitalityHeal.activation.type, "bonus");
assert.equal(vitalityHeal.activation.override, true);
assert.equal(vitalityHeal.duration.concentration, false);
assert.equal(vitalityHeal.duration.override, true);
assert.equal(vitalityHeal.target.affects.type, "creature");
assert.equal(vitalityHeal.target.override, true);

const booming = sources.find(item => item.system.identifier === SPELL_2014_IDS.boomingBlade);
const boomingHit = booming.system.activities[SPELL_2014_ACTIVITY_IDS.boomingHit];
assert.equal(boomingHit.type, "damage");
assert.deepEqual(boomingHit.damage.parts[0].types, ["thunder"]);
assert.equal(boomingHit.flags.cat.hidden, true);
assert.equal(boomingHit.target.override, true);

const guardian = JSON.parse(await readFile(
  new URL("../packData/khuzoe-summons-2014/Guardian_of_Faith_KhzGuardianAct01.json", import.meta.url),
  "utf8"
));
assert.equal(guardian._id, "KhzGuardianAct01");
assert.equal(guardian.type, "npc");
assert.equal(guardian.system.attributes.movement.walk, 0);

let guardianSetting;
let guardianCreated = 0;
let guardianPlaced = 0;
let guardianDeleted = 0;
let guardianCreateOptions;
globalThis.game = {
  time: {worldTime: 1234},
  settings: {
    register(moduleId, key, data) { guardianSetting = {moduleId, key, data}; },
    get() { return "worlds/test/assets/custom-guardian.webp"; }
  }
};
registerSpells2014Settings();
assert.equal(guardianSetting.moduleId, "khuzoe-automations");
assert.equal(guardianSetting.key, "guardianOfFaithTokenImage");
assert.equal(guardianSetting.data.filePicker, "image");

const guardianSpellActor = {name: "Sir Elric"};
const guardianSpell = {
  documentName: "Item",
  name: "Guardian of Faith",
  uuid: "Actor.caster.Item.guardian",
  actor: guardianSpellActor
};
globalThis.fromUuid = async () => guardian;
globalThis.cat = {lib: {
  constants: {
    summons: {
      getSummonsBySource() { return []; },
      async deleteSummon() { guardianDeleted += 1; },
      async createSummon(_actor, _sourceActor, _created, options) {
        guardianCreated += 1;
        guardianCreateOptions = options;
        return {
          async place() {
            guardianPlaced += 1;
            return {id: "guardian-token"};
          }
        };
      }
    }
  }
}};

await summonGuardianOfFaith({
  item: guardianSpell,
  workflow: {item: guardianSpell, actor: guardianSpellActor, activity: {id: SPELL_2014_ACTIVITY_IDS.guardianDamage}}
});
assert.equal(guardianCreated, 0, "L'attività di danno non deve ricreare o riposizionare il guardiano");

await summonGuardianOfFaith({
  item: guardianSpell,
  workflow: {
    item: guardianSpell,
    actor: guardianSpellActor,
    activity: {id: SPELL_2014_ACTIVITY_IDS.guardianCast},
    token: {disposition: 1},
    castData: {saveDC: 16}
  }
});
assert.equal(guardianCreated, 1);
assert.equal(guardianPlaced, 1);
assert.equal(guardianDeleted, 0);
assert.equal(guardianCreateOptions.tokenImg, "worlds/test/assets/custom-guardian.webp");
assert.equal(guardianCreateOptions.updates.flags["khuzoe-automations"].guardianFaith.damage, 0);

globalThis.cat = {utils: {actorUtils: {typeOrRace(actor) { return actor.system.details.type.value; }}}};
assert.deepEqual(protectionSaveAdvantage({
  workflow: {
    actor: {system: {details: {type: {value: "fiend"}}}},
    item: {name: "Frightful Presence", effects: new Map()},
    activity: {name: "Frighten", effects: [{statuses: new Set(["frightened"])}]}
  }
}), {label: "Protection from Evil and Good", type: "advantage"});

// Sanctuary deve rimuovere soltanto il bersaglio protetto da un'azione con
// più bersagli; gli altri bersagli validi non devono perdere l'intera azione.
const sanctuaryActor = {id: "SanctuaryActor1"};
const sanctuaryToken = {id: "SanctuaryToken1", actor: sanctuaryActor, disposition: 1};
const otherToken = {id: "OtherTarget0001", actor: {id: "OtherActor00001"}, disposition: 1};
const attackerToken = {id: "AttackerToken001", actor: {id: "AttackerActor01"}, disposition: -1};
const sanctuarySave = {id: SPELL_2014_ACTIVITY_IDS.sanctuarySave};
const sanctuarySpell = {actor: sanctuaryActor, system: {activities: new Map([[sanctuarySave.id, sanctuarySave]])}};
let sanctuaryTargets;
globalThis.fromUuid = async () => sanctuarySpell;
globalThis.ui = {notifications: {info() {}}};
globalThis.game.user = {id: "User.Test01"};
globalThis.cat = {utils: {
  actorUtils: {typeOrRace() { return ""; }},
  queryUtils: {firstOwner() { return "User.Test01"; }},
  tokenUtils: {isEnemy() { return true; }},
  workflowUtils: {
    async syntheticActivityRoll() { return {failedSaves: new Set([attackerToken])}; },
    async updateTargets(_workflow, targets) { sanctuaryTargets = targets; }
  }
}};
const sanctuaryWorkflow = {
  item: {name: "Magic Missile", type: "spell"},
  activity: {id: "HostileActivity1", type: "damage", target: {template: {type: "", size: null}}},
  token: attackerToken,
  targets: new Set([sanctuaryToken, otherToken])
};
await sanctuaryTargeted({
  document: {parent: sanctuaryActor, origin: "Actor.Caster.Item.Sanctuary"},
  workflow: sanctuaryWorkflow
});
assert.deepEqual(sanctuaryTargets, [otherToken]);
assert.notEqual(sanctuaryWorkflow.aborted, true);
assert.equal(protectionSaveAdvantage({
  workflow: {
    actor: {system: {details: {type: {value: "humanoid"}}}},
    item: {name: "Frightful Presence", effects: new Map()},
    activity: {effects: [{statuses: new Set(["frightened"])}]}
  }
}), undefined);
assert.equal(protectionSaveAdvantage({
  workflow: {
    actor: {system: {details: {type: {value: "fiend"}}}},
    item: {name: "Fireball", effects: new Map()},
    activity: {name: "Fireball", effects: []}
  }
}), undefined);
assert.deepEqual(circlePowerSaveAdvantage({workflow: {item: {type: "spell"}}}), {label: "Circle of Power: magia o effetto magico", type: "advantage"});
assert.equal(circlePowerSaveAdvantage({workflow: {item: {type: "weapon"}}}), undefined);

let shieldReduction = null;
globalThis.cat = {utils: {workflowUtils: {modifyDamageAppliedFlat(_ditem, amount) { shieldReduction = amount; }}}};
blockMagicMissile({
  workflow: {item: {name: "Magic Missile", system: {identifier: "magic-missile"}}},
  ditem: {hpDamage: 9, tempDamage: 0}
});
assert.equal(shieldReduction, -9);

let removedDeathWard = false;
let deathWardReduction = null;
globalThis.cat = {
  utils: {
    documentUtils: {
      async deleteDocument() { removedDeathWard = true; }
    },
    workflowUtils: {
      modifyDamageAppliedFlat(ditem, amount) {
        deathWardReduction = amount;
        ditem.hpDamage += amount;
        ditem.newHP = ditem.oldHP - ditem.hpDamage;
        ditem.damageDetail[0].value += amount;
      }
    }
  }
};
const damageItem = {oldHP: 8, oldTempHP: 0, newHP: 0, hpDamage: 12, damageDetail: [{value: 12}]};
await triggerDeathWard({document: {id: "ward"}, ditem: damageItem});
assert.equal(deathWardReduction, -5);
assert.equal(damageItem.newHP, 1);
assert.equal(damageItem.hpDamage, 7);
assert.equal(damageItem.damageDetail[0].value, 7);
assert.equal(removedDeathWard, true);

removedDeathWard = false;
await triggerDeathWard({document: {id: "ward"}, ditem: {oldHP: 0, newHP: 0, hpDamage: 5}});
assert.equal(removedDeathWard, false, "Death Ward non deve consumarsi su una creatura già a 0 PF");

let modifiedBy = null;
globalThis.cat.utils.workflowUtils = {
  modifyDamageAppliedFlat(_ditem, amount) { modifiedBy = amount; }
};
const circleTarget = {id: "target", actor: {id: "actor"}};
circlePowerNegateHalfDamage({
  workflow: {
    item: {type: "spell"},
    activity: {damage: {onSave: "half"}},
    saves: new Set([circleTarget])
  },
  targetToken: circleTarget,
  ditem: {hpDamage: 11, tempDamage: 2}
});
assert.equal(modifiedBy, -13);

let createdAid;
let updatedAidActor;
globalThis.game = {user: {id: "player"}};
globalThis.cat.utils.effectUtils = {
  async createEffects(_actor, effectDatas) { createdAid = effectDatas[0]; return []; }
};
globalThis.cat.utils.documentUtils.update = async (document, updates) => {
  updatedAidActor = {document, updates};
};
const aidActor = {effects: [], system: {attributes: {hp: {value: 9}}}};
const aidSpell = {name: "Aid", img: "aid.webp", uuid: "Actor.caster.Item.aid"};
await applyAid({
  item: aidSpell,
  workflow: {item: aidSpell, castData: {castLevel: 3}, targets: new Set([{id: "target", actor: aidActor}])}
});
assert.equal(createdAid.flags["khuzoe-automations"].aid.amount, 10);
assert.equal(createdAid.system.changes[0].value, "10");
assert.equal(updatedAidActor.updates["system.attributes.hp.value"], 19);

let vitalityCreation;
globalThis.cat.utils.effectUtils = {
  async createEffects(_actor, effectDatas, options) {
    vitalityCreation = {effect: effectDatas[0], options};
    return [{id: "vitality-effect"}];
  },
  getConcentrationEffect() { return undefined; }
};
const vitalityActor = {effects: []};
const vitalitySpell = {name: "Aura of Vitality", img: "vitality.webp", uuid: "Actor.caster.Item.vitality", actor: vitalityActor};
await activateAuraVitality({
  item: vitalitySpell,
  workflow: {
    actor: vitalityActor,
    item: vitalitySpell,
    activity: {id: SPELL_2014_ACTIVITY_IDS.auraVitalityCast, uuid: "Actor.caster.Item.vitality.Activity.cast"}
  }
});
assert.equal(vitalityCreation.effect.flags.cat.activityUuid, "Actor.caster.Item.vitality.Activity.cast");
assert.deepEqual(vitalityCreation.options.unhideActivities, ["aura-of-vitality-healing"]);

let vitalityTargetUpdate;
const vitalityTarget = {id: "ally", actor: {id: "ally-actor"}};
const vitalityScene = {id: "Vitality", grid: {size: 100, distance: 5, units: "ft"}};
Object.assign(vitalityTarget, {parent: vitalityScene, x: 500, y: 300, width: 1, height: 1});
const vitalitySource = {id: "caster", actor: vitalityActor, parent: vitalityScene, x: 0, y: 0, width: 1, height: 1};
vitalityActor.effects.push({...vitalityCreation.effect, active: true});
globalThis.game.user.targets = new Set([vitalityTarget]);
globalThis.cat.utils.workflowUtils = {
  async updateTargets(workflow, targets) { vitalityTargetUpdate = {workflow, targets}; }
};
const vitalityHealWorkflow = {
  token: vitalitySource,
  item: vitalitySpell,
  activity: {
    id: SPELL_2014_ACTIVITY_IDS.auraVitalityHeal,
    midiProperties: {identifier: "aura-of-vitality-healing"}
  },
  targets: new Set([{id: "caster", actor: vitalityActor}])
};
await prepareAuraVitalityHealing({item: vitalitySpell, workflow: vitalityHealWorkflow});
assert.equal(vitalityTargetUpdate.workflow, vitalityHealWorkflow);
assert.deepEqual(vitalityTargetUpdate.targets, [vitalityTarget]);
vitalityTarget.flags = {"khuzoe-merchant": {container: {}}};
vitalityTargetUpdate = undefined;
assert.equal(await prepareAuraVitalityHealing({item: vitalitySpell, workflow: vitalityHealWorkflow}), true,
  "Aura of Vitality must reject a Merchant container instead of healing its NPC proxy");
assert.equal(vitalityTargetUpdate, undefined);
delete vitalityTarget.flags;
vitalityTarget.x = 600;
vitalityTarget.y = 400;
assert.equal(await prepareAuraVitalityHealing({item: vitalitySpell, workflow: vitalityHealWorkflow}), true, "Aura of Vitality rifiuta una cura oltre il cerchio in diagonale");
vitalityTarget.x = 500;
vitalityTarget.y = 300;
vitalityActor.effects[0].disabled = true;
assert.equal(await prepareAuraVitalityHealing({item: vitalitySpell, workflow: vitalityHealWorkflow}), true, "Un'aura disattivata non permette la cura");

let boomingWeaponData;
let boomingDamageRoll;
let boomingEffect;
let boomingRollOptions;
const boomingTargetActor = {effects: [], system: {attributes: {ac: {value: 15}}}};
const boomingTarget = {id: "enemy", uuid: "Scene.test.Token.enemy", parent: {id: "test"}, actor: boomingTargetActor, name: "Yeti"};
const boomingWeapon = {
  type: "weapon",
  system: {equipped: true, activities: {attack: {_id: "attack", type: "attack", actionType: "mwak", attack: {type: {value: "melee", classification: "weapon"}}}}},
  toObject() {
    return {_id: "weapon", type: "weapon", system: {activities: {attack: {_id: "attack", type: "attack", actionType: "mwak", attack: {type: {value: "melee", classification: "weapon"}}, damage: {parts: []}}}}};
  }
};
const boomingHitActivity = {
  id: SPELL_2014_ACTIVITY_IDS.boomingHit,
  toObject() {
    return {type: "damage", damage: {parts: [{custom: {enabled: false, formula: ""}, number: 1, denomination: 8, types: ["thunder"]}]}};
  }
};
const boomingActor = {items: [boomingWeapon], effects: [], system: {details: {level: 11}}};
const boomingSpell = {
  name: "Booming Blade",
  img: "booming.webp",
  uuid: "Actor.caster.Item.booming",
  actor: boomingActor,
  system: {activities: new Map([[SPELL_2014_ACTIVITY_IDS.boomingHit, boomingHitActivity]])}
};
globalThis.ui = {notifications: {error() {}, warn() {}}};
globalThis.cat.utils.actorUtils = {getLevelOrCR() { return 0; }};
globalThis.cat.utils.queryUtils = {firstOwner() { return "player"; }};
globalThis.cat.utils.workflowUtils = {
  async syntheticItemDataRoll(data, _actor, _targets, options) {
    boomingWeaponData = data;
    boomingRollOptions = options;
    return {attackTotal: 20, isCritical: false, isFumble: false, targets: new Set([boomingTarget])};
  },
  async syntheticActivityDataRoll(data, spell, targets) {
    boomingDamageRoll = {data, spell, targets};
    return {};
  }
};
globalThis.cat.utils.effectUtils = {
  async createEffects(_actor, effectDatas) {
    boomingEffect = effectDatas[0];
    return [{id: "booming-effect"}];
  }
};
globalThis.cat.utils.documentUtils = {async deleteDocument() {}};
await useBoomingBlade({
  item: boomingSpell,
  workflow: {
    item: boomingSpell,
    actor: boomingActor,
    activity: {id: SPELL_2014_ACTIVITY_IDS.boomingCast},
    targets: new Set([boomingTarget])
  }
});
assert.equal(boomingWeaponData._id, undefined);
assert.equal(boomingWeaponData.system.activities.attack.damage.parts.length, 1, "Il danno iniziale appartiene al tiro dell’arma e raddoppia sul critico");
assert.deepEqual(boomingRollOptions.options.workflowOptions, {
  targetConfirmation: "none",
  autoRollAttack: true,
  autoRollDamage: "always",
  khuzoeWeaponCantrip: true
});
assert.equal(boomingWeaponData.system.activities.attack.damage.parts[0].number, 2);
assert.equal(boomingDamageRoll, undefined);
assert.equal(boomingEffect.flags["khuzoe-automations"].boomingBlade.dice, 3);
boomingEffect = null;
globalThis.cat.utils.workflowUtils.syntheticItemDataRoll = async () => ({
  attackTotal: 30, hitTargets: new Set(), targets: new Set([boomingTarget])
});
await useBoomingBlade({item: boomingSpell, workflow: {
  item: boomingSpell, actor: boomingActor, activity: {id: SPELL_2014_ACTIVITY_IDS.boomingCast}, targets: new Set([boomingTarget])
}});
assert.equal(boomingEffect, null, "An authoritative miss after a reaction must not create the movement effect");

let auraUpdateCount = 0;
globalThis.cat.utils.documentUtils.update = async () => { auraUpdateCount += 1; };
const auraSource = {uuid: "Actor.caster.ActiveEffect.aura", img: "aura.webp", duration: {remaining: 300}};
const matchingAuraEffect = {
  id: "target-effect",
  origin: auraSource.uuid,
  name: "Aura of Life",
  img: "aura.webp",
  showIcon: 1,
  system: {changes: [{key: "system.traits.dr.value", value: "necrotic", priority: 20, type: "add"}]},
  flags: {cat: {auraEffect: true}}
};
const auraResult = await createAuraLifeTarget({
  document: auraSource,
  token: {actor: {effects: [matchingAuraEffect]}}
});
assert.equal(auraResult.existingEffect, matchingAuraEffect);
assert.equal(auraUpdateCount, 0, "Un'aura invariata non deve togliere e ricreare l'effetto");

console.log("Khuzoe Automations spells 2014: OK");
