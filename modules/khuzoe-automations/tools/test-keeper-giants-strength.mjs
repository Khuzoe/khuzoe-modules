import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  KEEPER_GIANTS_STRENGTH_AUTOMATION,
  applyKeeperAttackPenalty,
  applyKeeperDamageBonuses,
  configureKeeperPowerAttack,
  isGrappledBy,
  keeperSizeDifference,
  qualifiesKeeperAttack,
  qualifiesKeeperPowerAttack
} from "../scripts/keeper-giants-strength.mjs";

const itemPath = new URL(
  "../packData/khuzoe-class-features-2014/Keeper_of_Giants_Strength_KhzKeeperGiant01.json",
  import.meta.url
);
const itemData = JSON.parse(await readFile(itemPath, "utf8"));
assert.equal(itemData._id.length, 16);
assert.equal(itemData.system.identifier, KEEPER_GIANTS_STRENGTH_AUTOMATION.identifier);
assert.equal(itemData.flags.cat.automation.source, "khuzoe-automations");
assert.equal(itemData.flags.cat.macros.roll[0].identifier, KEEPER_GIANTS_STRENGTH_AUTOMATION.identifier);

const sizes = {tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5};
const damageBonuses = [];
const attackBonuses = [];
let confirmation = true;
let stamped = false;

globalThis.game = {user: {id: "owner", isGM: false}};
globalThis.cat = {
  utils: {
    actorUtils: {
      getSize(actor) {
        return sizes[actor.system.traits.size];
      }
    },
    queryUtils: {
      firstOwner() {
        return "owner";
      }
    },
    dialogUtils: {
      async confirm() {
        return confirmation;
      }
    },
    workflowUtils: {
      async bonusAttack(_workflow, formula) {
        attackBonuses.push(formula);
      },
      async bonusDamage(_workflow, formula, options) {
        damageBonuses.push({formula, options});
      }
    },
    tokenUtils: {
      getCombatData(token) {
        return token.combatant
          ? {inCombat: true, combatId: "combat", currentRound: 1, currentTurn: 2}
          : {inCombat: false};
      }
    },
    combatUtils: {
      isStampedThisTurn() {
        return stamped;
      },
      addTurnStamp() {
        return ["stamp"];
      }
    },
    documentUtils: {
      async update(_document, changes) {
        if (changes["flags.khuzoe-automations.keeperGiantsStrength.criticalStamps"]) stamped = true;
      }
    }
  }
};

function actor(size, strength = 5, uuid = `Actor.${size}`) {
  return {
    id: uuid.split(".").at(-1),
    uuid,
    effects: [],
    system: {
      traits: {size},
      abilities: {str: {mod: strength}}
    }
  };
}

const sourceActor = actor("lg", 5, "Actor.source");
const targetActor = actor("med", 0, "Actor.target");
const source = {id: "source", uuid: "Scene.test.Token.source", actor: sourceActor};
const target = {id: "target", uuid: "Scene.test.Token.target", name: "Bersaglio", actor: targetActor};
const feature = {
  name: "Keeper of Giant's Strength",
  parent: sourceActor,
  flags: {}
};

function workflow({ability = "str", actionType = "mwak", critical = false, targets = [target], hits = targets} = {}) {
  return {
    token: source,
    actor: sourceActor,
    activity: {
      ability,
      getActionType() {
        return actionType;
      }
    },
    targets: new Set(targets),
    hitTargets: new Set(hits),
    isCritical: critical,
    defaultDamageType: "slashing"
  };
}

assert.equal(keeperSizeDifference(sourceActor, targetActor), 1);
assert.equal(keeperSizeDifference(targetActor, sourceActor), 0);
assert.equal(qualifiesKeeperAttack(workflow()), true);
assert.equal(qualifiesKeeperAttack({activity: {actionType: "mwak", attack: {ability: "str"}}}), true);
assert.equal(qualifiesKeeperAttack(workflow({ability: "dex"})), false);
assert.equal(qualifiesKeeperAttack(workflow({actionType: "rwak"})), false);
assert.equal(qualifiesKeeperPowerAttack(workflow()), true);

const powerWorkflow = workflow();
assert.equal(await configureKeeperPowerAttack({workflow: powerWorkflow, document: feature}), true);
assert.equal(await applyKeeperAttackPenalty({workflow: powerWorkflow}), true);
assert.equal(await applyKeeperAttackPenalty({workflow: powerWorkflow}), false);
assert.deepEqual(attackBonuses, ["-5[Keeper of Giant's Strength]"]);

let result = await applyKeeperDamageBonuses({workflow: powerWorkflow, document: feature, token: source});
assert.deepEqual(result, {powerAttack: true, critical: false});
assert.deepEqual(damageBonuses, [{
  formula: "10",
  options: {damageType: "slashing", ignoreCrit: true}
}]);

damageBonuses.length = 0;
const criticalWorkflow = workflow({critical: true});
result = await applyKeeperDamageBonuses({workflow: criticalWorkflow, document: feature, token: source});
assert.deepEqual(result, {powerAttack: false, critical: true});
assert.deepEqual(damageBonuses, [{
  formula: "5",
  options: {damageType: "slashing", ignoreCrit: true}
}]);

damageBonuses.length = 0;
stamped = false;
const combat = {combatant: {tokenId: "other", actorId: "other"}};
source.combatant = {combat};
result = await applyKeeperDamageBonuses({workflow: criticalWorkflow, document: feature, token: source});
assert.deepEqual(result, {powerAttack: false, critical: false});
assert.equal(damageBonuses.length, 0);

combat.combatant = {tokenId: source.id, actorId: sourceActor.id};
result = await applyKeeperDamageBonuses({workflow: criticalWorkflow, document: feature, token: source});
assert.deepEqual(result, {powerAttack: false, critical: true});
result = await applyKeeperDamageBonuses({workflow: criticalWorkflow, document: feature, token: source});
assert.deepEqual(result, {powerAttack: false, critical: false});
assert.equal(damageBonuses.length, 1);
delete source.combatant;
stamped = false;

const sameSizeTarget = {
  id: "same",
  uuid: "Scene.test.Token.same",
  name: "Afferrato",
  actor: actor("lg", 0, "Actor.same")
};
sameSizeTarget.actor.effects.push({
  origin: sourceActor.uuid,
  statuses: new Set(["grappled"]),
  flags: {"chris-premades": {grapple: {tokenId: source.id}}}
});
assert.equal(isGrappledBy(sameSizeTarget, source), true);
assert.equal(qualifiesKeeperPowerAttack(workflow({targets: [sameSizeTarget]})), true);

const khuzoeGrappledTarget = {
  id: "khuzoe-same",
  uuid: "Scene.test.Token.khuzoe-same",
  name: "Afferrato Khuzoe",
  actor: actor("lg", 0, "Actor.khuzoe-same")
};
khuzoeGrappledTarget.actor.effects.push({
  origin: "Item.Grapple",
  statuses: new Set(["grappled"]),
  flags: {
    cat: {identifier: "khuzoe-grappled"},
    "khuzoe-automations": {
      grapple: {role: "target", sourceTokenUuid: source.uuid, targetTokenUuid: khuzoeGrappledTarget.uuid}
    }
  }
});
assert.equal(isGrappledBy(khuzoeGrappledTarget, source), true);
assert.equal(qualifiesKeeperPowerAttack(workflow({targets: [khuzoeGrappledTarget]})), true);

confirmation = false;
const refusedWorkflow = workflow();
assert.equal(await configureKeeperPowerAttack({workflow: refusedWorkflow, document: feature}), false);
assert.equal(await applyKeeperAttackPenalty({workflow: refusedWorkflow}), false);

console.log("Khuzoe Automations Keeper of Giant's Strength: OK");
