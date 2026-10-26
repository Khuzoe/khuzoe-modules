import {RELEASE_VERSION} from "../scripts/release.mjs";
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

const {canManageAutomations} = await import("../scripts/main.mjs");
onceHooks.get("catReady")();

assert.equal(automations.length, 169);
assert.equal(macros.length, 180);
assert.ok(!automations.some(data => data.identifier === "shield" && data.type === "feat"));
assert.ok(automations.some(data => data.identifier === "shield" && data.type === "spell"));
assert.ok(!macros.some(data => data.identifier === "khuzoe-guardian-shield"));
assert.equal(typeof onHooks.get("renderApplicationV2"), "function");
assert.equal(typeof onHooks.get("preUpdateItem"), "function");
assert.ok(automations.some(data => data.identifier === "bless" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "armor-of-agathys" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "armor-of-agathys" && data.rules === "2024"));
assert.ok(automations.some(data => data.identifier === "create-bonfire" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "create-bonfire" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "wall-of-fire" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "wall-of-fire" && data.rules === "2014"));
for (const identifier of ["grapple", "grappleEscape", "shove"]) {
  assert.ok(automations.some(data => data.identifier === identifier && data.rules === "2014"));
  assert.ok(macros.some(data => data.identifier === identifier && data.roll?.[0]?.pass === "itemRollFinished"));
}
assert.ok(macros.some(data => data.identifier === "khuzoe-wall-of-fire-wall-region" && data.region?.length === 2));
assert.ok(macros.some(data => data.identifier === "khuzoe-wall-of-fire-hot-region"
  && data.combat?.some(entry => entry.pass === "regionTurnEnd")));
assert.ok(automations.some(data => data.identifier === "keeper-of-giants-strength" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "keeper-of-giants-strength" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "bardic-inspiration" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "blade-flourish" && data.rules === "2014" && data.version === RELEASE_VERSION));
assert.ok(automations.some(data => data.identifier === "masters-flourish" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "giants-might" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "cloud-rune" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "master-of-runes" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "runic-juggernaut" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "stones-endurance" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "stones-endurance"
  && data.roll?.some(entry => entry.pass === "targetDamageFlatReductions")));
assert.ok(automations.some(data => data.identifier === "wild-shape" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "combat-wild-shape-healing" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "rage" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "khuzoe-rage-active" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "lay-on-hands" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "divine-smite" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "aura-of-protection" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "aura-of-courage" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "holy-nimbus" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "holy-nimbus" && data.roll?.[0]?.pass === "itemRollFinished"));
assert.ok(macros.some(data => data.identifier === "khuzoe-holy-nimbus-active" && data.save?.[0]?.pass === "actorContext"));
assert.equal(macros.some(data => data.identifier === "aura-of-protection" && data.aura?.length), false);
assert.equal(macros.some(data => data.identifier === "aura-of-courage" && data.aura?.length), false);
assert.ok(automations.some(data => data.identifier === "arcane-recovery" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "bladesong" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "song-of-defense" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "song-of-victory" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "song-of-defense" && data.roll?.[0]?.pass === "targetDamageFlatReductions"));
assert.ok(automations.some(data => data.identifier === "sneak-attack" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "cunning-action" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "uncanny-dodge" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "evasion" && data.rules === "2014"));
assert.ok(automations.some(data => data.identifier === "reliable-talent" && data.rules === "2014"));
assert.ok(macros.some(data => data.identifier === "sneak-attack" && data.roll?.[0]?.pass === "actorDamageRollBonuses"));
assert.ok(macros.some(data => data.identifier === "uncanny-dodge" && data.roll?.[0]?.pass === "targetDamageFlatReductions"));
for (const identifier of ["damage-bond", "damage-bond-once-per-turn"]) {
  assert.ok(automations.some(data => data.identifier === identifier && data.rules === "2014"));
  const macro = macros.find(data => data.identifier === identifier && data.rules === "2014");
  assert.ok(macro?.roll?.some(entry => entry.pass === "itemPreItemRoll"));
  assert.ok(macro?.roll?.some(entry => entry.pass === "targetDamageFlatReductions"));
}
for (const identifier of [
  "booming-blade",
  "protection-from-evil-and-good",
  "sanctuary",
  "shield-of-faith",
  "shield",
  "aid",
  "aura-of-vitality",
  "guardian-of-faith",
  "aura-of-life",
  "death-ward",
  "circle-of-power"
]) {
  assert.ok(automations.some(data => data.identifier === identifier && data.rules === "2014"));
}
for (const identifier of [
  "blade-ward",
  "chromatic-orb",
  "eldritch-blast",
  "hex",
  "hunters-mark",
  "scorching-ray",
  "spirit-shroud",
  "warding-bond"
]) {
  assert.ok(automations.some(data => data.identifier === identifier && data.rules === "2014"));
}
for (const identifier of [
  "naniss-p-unaura-di-energia-be",
  "naniss-p-come-azione-bonus-na",
  "naniss-p-quando-una-creatura-a",
  "naniss-p-naniss-effettua-tre",
  "colpo-purificante",
  "spirito-elementale-fatato-p-ogni-creatura-entro-1",
  "spirito-elementale-fatato-p-quando-lo-spirito-muo",
  "spirito-elementale-fatato-p-quando-una-creatura-n",
  "spirito-elementale-fatato-p-lo-spirito-effettua-d",
  "colpo-energico",
  "psychic-strike-melee",
  "psychic-strike-ranged",
  "brain-storm",
  "impenetrable-ego",
  "appeal-to-the-fervent"
]) {
  assert.ok(automations.some(data => data.identifier === identifier && data.rules === "2014"));
}
assert.ok(!automations.some(data => data.identifier === "bend-the-spoon"));
assert.ok(!automations.some(data => data.identifier === "multiattack"));

game.user = {id: "owner", isGM: false, role: 1};
assert.equal(canManageAutomations({isOwner: true}), true, "Qualsiasi owner deve poter applicare le automazioni Khuzoe");
assert.equal(canManageAutomations({isOwner: false}), false);
game.user = {id: "gm", isGM: true, role: 4};

const existingBardicUses = {
  max: "max(@abilities.cha.mod, 1)",
  spent: 2,
  recovery: [{period: "sr", type: "recoverAll"}]
};
const bardicUpdate = {
  system: {
    identifier: "bardic-inspiration",
    uses: {max: "1", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]}
  },
  flags: {
    cat: {
      automation: {source: "khuzoe-automations"}
    }
  }
};
onHooks.get("preUpdateItem")({
  system: {identifier: "bardic-inspiration"},
  toObject: () => ({system: {uses: existingBardicUses}})
}, bardicUpdate);
assert.deepEqual(bardicUpdate.system.uses, existingBardicUses);
assert.notEqual(bardicUpdate.system.uses, existingBardicUses);

const castMacro = macros.find(data => data.identifier === "armor-of-agathys" && data.rules === "2014").roll.find(entry => entry.pass === "itemRollFinished").macro;
const reflectMacro = macros.find(data => data.identifier === "armor-of-agathys-armor" && data.rules === "2014").roll[0].macro;
let createdEffect;
let reflectedRoll;
let reflectedRollCount = 0;
let deletedEffect = false;

globalThis.cat.utils = {
  documentUtils: {
    async deleteEmbeddedDocuments() {},
    async deleteDocument() {
      deletedEffect = true;
    }
  },
  effectUtils: {
    async createEffects(actor, effects, options) {
      createdEffect = {actor, effect: effects[0], options};
    }
  },
  workflowUtils: {
    async syntheticActivityRoll(activity, targets, options) {
      reflectedRollCount += 1;
      reflectedRoll = {activity, targets, options};
    }
  }
};

const actor = {
  isOwner: true,
  effects: [],
  system: {
    attributes: {
      hp: {temp: 10},
      spelldc: 14
    }
  }
};
const item = {
  name: "Armor of Agathys",
  img: "armor.webp",
  uuid: "Actor.test.Item.armor",
  system: {
    level: 1,
    source: {rules: "2014"}
  }
};

await castMacro({
  workflow: {
    actor,
    item,
    castData: {castLevel: 2, saveDC: 14}
  },
  activity: {id: "KhzAgathysCast01"},
  actor,
  item
});

assert.deepEqual(createdEffect.effect.duration, {
  value: 3600,
  units: "seconds",
  expiry: "turnStart",
  expired: false
});
assert.equal(createdEffect.effect.flags.cat.castData.castLevel, 2);
assert.equal(createdEffect.effect.flags.cat.macros.roll[0].rules, "2014");
assert.equal(createdEffect.options.rules, "2014");

const reflectActivity = {id: "KhzAgathysRefl01"};
globalThis.fromUuid = async () => ({
  system: {
    activities: new Map([["KhzAgathysRefl01", reflectActivity]])
  }
});

actor.system.attributes.hp.temp = 5;
const attackerDocument = {id: "attacker", uuid: "Scene.test.Token.attacker"};
const attackerActor = {
  system: {
    attributes: {
      hp: {temp: 0}
    }
  }
};
const armorEffect = {
  documentName: "ActiveEffect",
  parent: actor,
  origin: item.uuid,
  flags: {cat: {castData: {castLevel: 2}}}
};
await reflectMacro({
  workflow: {
    hitTargets: new Set([{id: "protected"}]),
    activity: {actionType: "mwak"},
    token: {id: "attacker", document: attackerDocument}
  },
  sourceToken: {id: "protected"},
  document: armorEffect,
  actor: attackerActor
});

assert.equal(reflectedRoll.activity, reflectActivity);
assert.equal(reflectedRoll.targets[0], attackerDocument);
assert.equal(reflectedRoll.targets[0].uuid, "Scene.test.Token.attacker");
assert.equal(reflectedRoll.options.atLevel, 2);
assert.equal(reflectedRoll.options.consumeUsage, false);
assert.equal(reflectedRoll.options.spellSlot, false);
assert.equal(reflectedRollCount, 1);
assert.equal(deletedEffect, false);

actor.system.attributes.hp.temp = 0;
await reflectMacro({
  workflow: {
    hitTargets: new Set([{id: "protected"}]),
    activity: {actionType: "mwak"},
    token: {id: "attacker", document: attackerDocument}
  },
  sourceToken: {id: "protected"},
  document: armorEffect,
  actor: attackerActor
});

assert.equal(deletedEffect, true);
assert.equal(reflectedRollCount, 1, "Un effetto rimasto senza PF temporanei non infligge altri danni");

// Ogni callback registrato deve ignorare in sicurezza un evento CAT privo del
// documento/workflow atteso. Questo impedisce che un hook condiviso o un
// evento di un'altra automazione interrompa il workflow globale di Midi-QOL.
for (const definition of macros) {
  for (const entries of Object.values(definition)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.macro !== "function") continue;
      await entry.macro({});
    }
  }
}

console.log("Khuzoe Automations registration and Armor of Agathys workflow: OK");
