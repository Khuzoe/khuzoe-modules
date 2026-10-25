import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";

const onceHooks = new Map();
const onHooks = new Map();
const automations = [];
const macros = [];

globalThis.Hooks = {
  once(name, callback) {
    onceHooks.set(name, callback);
  },
  on(name, callback) {
    onHooks.set(name, callback);
  }
};

globalThis.game = {
  modules: new Map([["khuzoe-automations", {active: true}]]),
  user: {isGM: true},
  users: []
};

globalThis.ui = {
  notifications: {
    error() {},
    info() {},
    warn() {}
  }
};

globalThis.document = {
  createElement() {
    return {
      innerHTML: "",
      set textContent(value) {
        this.innerHTML = String(value);
      }
    };
  }
};

globalThis.cat = {
  api: {
    registerSourceName() {},
    registerAutomation(data) {
      automations.push(data);
      return true;
    },
    registerFnMacro(data) {
      macros.push(data);
      return data;
    }
  },
  utils: {}
};

await import("../scripts/main.mjs");
onceHooks.get("catReady")();

const bardicMacro = macros.find(data => data.identifier === "bardic-inspiration");
const inspiredMacro = macros.find(data => data.identifier === "bardic-inspiration-inspired");
const bladeMacro = macros.find(data => data.identifier === "blade-flourish");
assert.ok(bardicMacro);
assert.ok(inspiredMacro);
assert.ok(bladeMacro);

const bladeSourceUpdate = {
  system: {identifier: "blade-flourish"},
  effects: [
    {
      _id: "KhzBladeMoveEf01",
      duration: {value: 6, units: "seconds", expiry: "turnEnd"},
      flags: {dae: {specialDuration: ["turnEndSource"]}}
    },
    {
      _id: "KhzBladeDefnEf01",
      duration: {value: 6, units: "seconds", expiry: "turnStart"},
      flags: {dae: {specialDuration: ["turnStartSource"]}}
    }
  ]
};
onHooks.get("preUpdateItem")({system: {identifier: "blade-flourish"}}, bladeSourceUpdate);
const movementSourceEffect = bladeSourceUpdate.effects[0];
const defensiveSourceEffect = bladeSourceUpdate.effects[1];
assert.equal(movementSourceEffect.duration.value, null);
assert.equal(movementSourceEffect.duration.expiry, "sourceEnd");
assert.equal(movementSourceEffect.flags.dae.expiryMode, "delete");
assert.deepEqual(movementSourceEffect.flags.dae.specialDuration, []);
assert.equal(defensiveSourceEffect.duration.value, null);
assert.equal(defensiveSourceEffect.duration.expiry, "sourceStart");
assert.equal(defensiveSourceEffect.flags.dae.expiryMode, "delete");
assert.deepEqual(defensiveSourceEffect.flags.dae.specialDuration, []);

const validateBardic = bardicMacro.roll.find(entry => entry.pass === "itemPreItemRoll").macro;
const applyBardic = bardicMacro.roll.find(entry => entry.pass === "itemRollFinished").macro;
const provideBardicBonus = inspiredMacro.check[0].macro;
const applyMovement = bladeMacro.roll.find(entry => entry.pass === "actorAttackRollComplete").macro;
const applyFlourish = bladeMacro.roll.find(entry => entry.pass === "actorDamageRollBonuses").macro;

let createdBardicEffect;
let deletedBardicEffect = false;
const sourceActor = {
  id: "bard",
  uuid: "Actor.bard",
  isOwner: true,
  items: [],
  system: {
    scale: {
      bard: {
        inspiration: {formula: "1d10"}
      }
    }
  }
};
const targetActor = {
  id: "ally",
  uuid: "Actor.ally",
  effects: []
};
const targetToken = {
  id: "ally-token",
  uuid: "Scene.test.Token.ally-token",
  name: "Alleato",
  actor: targetActor
};
const bardicItem = {
  name: "Bardic Inspiration",
  img: "bardic.webp",
  uuid: "Actor.bard.Item.bardic"
};
const bardicWorkflow = {
  actor: sourceActor,
  item: bardicItem,
  targets: new Set([targetToken])
};

globalThis.cat.utils = {
  documentUtils: {
    async deleteEmbeddedDocuments() {},
    async deleteDocument() {
      deletedBardicEffect = true;
    }
  },
  effectUtils: {
    async createEffects(actor, effects, options) {
      createdBardicEffect = {actor, effect: effects[0], options};
    }
  }
};

assert.equal(validateBardic({workflow: bardicWorkflow, actor: sourceActor}), undefined);
await applyBardic({workflow: bardicWorkflow, actor: sourceActor, item: bardicItem});
assert.equal(createdBardicEffect.actor, targetActor);
assert.equal(createdBardicEffect.effect.flags["khuzoe-automations"].bardicInspiration.formula, "1d10");
assert.deepEqual(createdBardicEffect.effect.duration, {
  value: 600,
  units: "seconds",
  expiry: "turnStart",
  expired: false
});
assert.equal(createdBardicEffect.effect.flags.cat.macros.roll[0].identifier, "bardic-inspiration-inspired");
assert.equal(createdBardicEffect.effect.flags.cat.macros.save[0].identifier, "bardic-inspiration-inspired");
assert.equal(createdBardicEffect.effect.flags.cat.macros.skill[0].identifier, "bardic-inspiration-inspired");
assert.equal(createdBardicEffect.effect.flags.cat.macros.check[0].identifier, "bardic-inspiration-inspired");

class FakeD20Bonus {
  constructor(document, options) {
    this.document = document;
    this.options = options;
  }

  withOnUse(callback) {
    this.onUse = callback;
    return this;
  }

  initialize() {
    this.initialized = true;
    return this;
  }

  async use() {
    await this.onUse();
  }
}

const inspiredEffect = {
  ...createdBardicEffect.effect,
  documentName: "ActiveEffect"
};
const optionalBonus = provideBardicBonus({
  document: inspiredEffect,
  actor: targetActor,
  D20Bonus: FakeD20Bonus
});
assert.equal(optionalBonus.options.formula, "1d10");
assert.equal(optionalBonus.initialized, true);
await optionalBonus.use();
assert.equal(deletedBardicEffect, true);

const movementActivity = {id: "KhzBladeMove0001"};
const defensiveActivity = {id: "KhzBladeDefn0001"};
const mobileActivity = {id: "KhzBladeMobl0001"};
const slashingActivity = {id: "KhzBladeSlsh0001"};
const defensiveEffect = {id: "KhzBladeDefnEf01", system: {}};
const bardicResource = {
  id: "bardic-resource",
  type: "feat",
  system: {
    identifier: "bardic-inspiration",
    uses: {value: 2, max: 4, spent: 2}
  }
};
const mastersItem = {
  id: "masters",
  type: "feat",
  system: {identifier: "masters-flourish"}
};
const bladeItem = {
  id: "blade",
  actor: sourceActor,
  flags: {
    "khuzoe-automations": {
      bladeFlourish: {}
    }
  },
  system: {
    identifier: "blade-flourish",
    activities: new Map([
      [movementActivity.id, movementActivity],
      [defensiveActivity.id, defensiveActivity],
      [mobileActivity.id, mobileActivity],
      [slashingActivity.id, slashingActivity]
    ])
  },
  effects: new Map([[defensiveEffect.id, defensiveEffect]])
};
sourceActor.items = [bardicResource, mastersItem, bladeItem];

const combat = {
  id: "combat",
  round: 3,
  turn: 0,
  current: {tokenId: "bard-token"}
};
const sourceToken = {
  id: "bard-token",
  uuid: "Scene.test.Token.bard-token",
  name: "Bardo",
  actor: sourceActor,
  combatant: {combat}
};
const enemyActor = {id: "enemy"};
const enemyToken = {
  id: "enemy-token",
  uuid: "Scene.test.Token.enemy-token",
  name: "Nemico",
  actor: enemyActor
};

const syntheticRolls = [];
const damageFormulas = [];
const dialogButtons = [];
const confirmResults = [];

function setNestedFlag(item, path, value) {
  const key = path.split(".").at(-1);
  item.flags["khuzoe-automations"].bladeFlourish[key] = value;
}

globalThis.cat.utils = {
  activityUtils: {
    getDamageModifiedActivityData(activity, formula, options) {
      return {activity, formula, options};
    }
  },
  combatUtils: {
    isOwnTurn(token) {
      return token.id === token.combatant.combat.current.tokenId;
    },
    isStampedThisTurn(stamps, tokenId, combatData) {
      return stamps.some(stamp => stamp.id === tokenId
        && stamp.combatId === combatData.combatId
        && stamp.round === combatData.currentRound
        && stamp.turn === combatData.currentTurn);
    },
    addTurnStamp(stamps, tokenId, combatData) {
      return [
        ...stamps.filter(stamp => stamp.id !== tokenId),
        {
          id: tokenId,
          combatId: combatData.combatId,
          round: combatData.currentRound,
          turn: combatData.currentTurn
        }
      ];
    }
  },
  dialogUtils: {
    async buttonDialog() {
      return dialogButtons.shift();
    },
    async confirm() {
      return confirmResults.shift();
    },
    async selectTargetDialog() {
      return null;
    }
  },
  documentUtils: {
    async update(document, updates) {
      for (const [path, value] of Object.entries(updates)) {
        if (path.startsWith("flags.khuzoe-automations")) setNestedFlag(document, path, value);
        else if (path === "system.uses.spent") {
          document.system.uses.spent = value;
          document.system.uses.value -= 1;
        } else if (path === "system.changes") document.system.changes = value;
      }
    }
  },
  tokenUtils: {
    getCombatData(token) {
      const current = token.combatant?.combat;
      return {
        inCombat: Boolean(current),
        combatId: current?.id ?? null,
        currentRound: current?.round ?? null,
        currentTurn: current?.turn ?? null
      };
    },
    findNearby() {
      return [];
    },
    isEnemy() {
      return true;
    },
    async slideToken() {
      throw new Error("Il test non deve spingere il token quando il dialogo viene rifiutato.");
    }
  },
  workflowUtils: {
    isAttackType() {
      return true;
    },
    async bonusDamage(workflow, formula, options) {
      damageFormulas.push({formula, options});
      workflow.damageRolls.push({total: formula === "1d6" ? 4 : 7, options: {type: options.damageType}});
    },
    async syntheticActivityRoll(activity, targets, options) {
      syntheticRolls.push({activity, targets, options}); return {};
    },
    async syntheticActivityDataRoll(activityData, item, targets, options) {
      syntheticRolls.push({activityData, item, targets, options});
    }
  }
};

const attackWorkflow = {
  actor: sourceActor,
  item: {system: {identifier: "longsword"}},
  token: sourceToken,
  hitTargets: new Set([enemyToken]),
  damageRolls: [{total: 9, options: {type: "slashing"}}],
  defaultDamageType: "slashing"
};

dialogButtons.push("defensive");
confirmResults.push(false);
registerDocuments(sourceActor, bardicResource, bladeItem);
await applyFlourish({
  workflow: attackWorkflow,
  document: bladeItem,
  actor: sourceActor,
  token: sourceToken
});
assert.equal(damageFormulas[0].formula, "1d10");
assert.equal(bardicResource.system.uses.spent, 3);
assert.equal(bardicResource.system.uses.value, 1);
assert.equal(defensiveEffect.system.changes[0].value, "7");
assert.ok(syntheticRolls.some(entry => entry.activity === defensiveActivity));
assert.equal(bladeItem.flags["khuzoe-automations"].bladeFlourish.flourishStamps.length, 1);

await applyMovement({workflow: attackWorkflow, document: bladeItem, token: sourceToken});
await applyMovement({workflow: attackWorkflow, document: bladeItem, token: sourceToken});
assert.equal(syntheticRolls.filter(entry => entry.activity === movementActivity).length, 1);

combat.turn = 1;
dialogButtons.push("mobile");
confirmResults.push(true, false);
const masterWorkflow = {
  ...attackWorkflow,
  damageRolls: [{total: 8, options: {type: "slashing"}}]
};
await applyFlourish({
  workflow: masterWorkflow,
  document: bladeItem,
  actor: sourceActor,
  token: sourceToken
});
assert.equal(damageFormulas[1].formula, "1d6");
assert.equal(bardicResource.system.uses.spent, 3);
assert.ok(syntheticRolls.some(entry => entry.activity === mobileActivity));

console.log("Khuzoe Automations Sword Bard workflows: OK");
