import assert from "node:assert/strict";
import {
  COMBAT_ACTION_AUTOMATIONS,
  canAffectBySize,
  registerCombatActions2014,
  useGrapple,
  useGrappleEscape,
  useShove
} from "../scripts/combat-actions-2014.mjs";

function actor(name, size) {
  return {
    name,
    uuid: `Actor.${name}`,
    isOwner: true,
    system: {traits: {size, ci: {value: new Set()}}},
    effects: [],
    items: [],
    statuses: new Set()
  };
}

function token(name, actor, x) {
  const parent = scene;
  const document = {
    id: `${name}Token`,
    uuid: `Scene.Test.Token.${name}Token`,
    name,
    actor,
    parent,
    x,
    y: 0,
    width: 1,
    height: 1,
    texture: {src: `${name}.webp`}
  };
  const object = {document, actor, name, center: {x: x + 50, y: 50}};
  document.object = object;
  return object;
}

const scene = {id: "Test", grid: {size: 100, distance: 5}};
const sourceActor = actor("Source", "med");
const targetActor = actor("Target", "lg");
const source = token("Source", sourceActor, 0);
const target = token("Target", targetActor, 100);

assert.equal(canAffectBySize(sourceActor, targetActor), true);
assert.equal(canAffectBySize(sourceActor, actor("Huge", "huge")), false);
assert.equal(canAffectBySize(actor("Large", "lg"), actor("Huge", "huge")), true);

const automations = [];
const macros = [];
const registered = registerCombatActions2014({
  registerAutomation(data) { automations.push(data); return data; },
  registerFnMacro(data) { macros.push(data); return data; }
});
assert.equal(COMBAT_ACTION_AUTOMATIONS.length, 3);
assert.equal(registered.automations.length, 3);
assert.equal(registered.macros.length, 3);
assert.deepEqual(automations.map(entry => entry.identifier), ["grapple", "grappleEscape", "shove"]);
assert.ok(macros.every(entry => entry.roll?.[0]?.pass === "itemRollFinished"));

let dialogResults = ["acr"];
let contestedResult = 4;
let createdEscape = 0;
let linked = false;
let slid = false;
let effectCounter = 0;
const uuidDocuments = new Map();
uuidDocuments.set(source.document.uuid, source.document);
uuidDocuments.set(target.document.uuid, target.document);
const escapeSource = {
  toObject() {
    return {
      _id: "KhzGrapEsc140001",
      name: "Escape Grapple",
      system: {identifier: "grappleEscape"},
      flags: {cat: {automation: {source: "khuzoe-automations", version: "0.1.0"}}}
    };
  }
};

globalThis.game = {user: {id: "User", isGM: true}};
globalThis.ui = {notifications: {warn() {}, info() {}, error() {}}};
globalThis.MidiQOL = {
  async contestedRoll() { return {result: contestedResult, rolls: []}; }
};
globalThis.fromUuid = async uuid => uuid === COMBAT_ACTION_AUTOMATIONS[1].uuid
  ? escapeSource
  : uuidDocuments.get(uuid) ?? null;
globalThis.cat = {
  utils: {
    actorUtils: {
      checkTrait(current, _trait, condition) { return current.system.traits.ci.value.has(condition); },
      async applyConditions(current, conditions) { conditions.forEach(condition => current.statuses.add(condition)); }
    },
    tokenUtils: {
      async getDistance() { return 5; },
      async slideToken() { slid = true; }
    },
    queryUtils: {
      firstOwner() { return "User"; },
      hasPermission() { return true; }
    },
    dialogUtils: {
      async buttonDialog() { return dialogResults.shift(); }
    },
    effectUtils: {
      async createEffects(current, datas) {
        return datas.map(data => {
          const id = `Effect${++effectCounter}`;
          const effect = {
            ...data,
            id,
            uuid: `${current.uuid}.ActiveEffect.${id}`,
            parent: current,
            isOwner: true,
            async update(changes) {
              const value = changes["flags.khuzoe-automations.grapple.linkedEffectUuid"];
              if (value) this.flags["khuzoe-automations"].grapple.linkedEffectUuid = value;
              return this;
            }
          };
          current.effects.push(effect);
          uuidDocuments.set(effect.uuid, effect);
          return effect;
        });
      }
    },
    documentUtils: {
      async makeDependent() { linked = true; },
      async createEmbeddedDocuments(current, type, datas) {
        assert.equal(type, "Item");
        createdEscape += datas.length;
        const documents = datas.map((data, index) => ({
          ...data,
          id: `Escape${index}`,
          uuid: `${current.uuid}.Item.Escape${index}`,
          actor: current,
          parent: current,
          isOwner: true
        }));
        current.items.push(...documents);
        documents.forEach(document => uuidDocuments.set(document.uuid, document));
        return documents;
      },
      async deleteDocument(document) {
        const collection = document?.parent?.effects?.includes(document)
          ? document.parent.effects
          : document?.parent?.items?.includes(document)
            ? document.parent.items
            : null;
        if (collection) collection.splice(collection.indexOf(document), 1);
        uuidDocuments.delete(document?.uuid);
        return document;
      }
    }
  }
};

const grappleItem = {
  uuid: COMBAT_ACTION_AUTOMATIONS[0].uuid,
  name: "Grapple",
  img: "grapple.webp",
  system: {identifier: "grapple"}
};
const grappleWorkflow = {token: source, targets: new Set([target]), item: grappleItem, aborted: false};
assert.equal(await useGrapple({workflow: grappleWorkflow, item: grappleItem}), true);
assert.equal(sourceActor.effects.length, 1);
assert.equal(targetActor.effects.length, 1);
assert.deepEqual(targetActor.effects[0].statuses, ["grappled"]);
assert.equal(createdEscape, 1);
assert.equal(linked, true);

const escapeItem = targetActor.items[0];
dialogResults = ["acr"];
contestedResult = 3;
assert.equal(await useGrappleEscape({
  workflow: {token: target, item: escapeItem},
  item: escapeItem
}), true);
assert.equal(sourceActor.effects.length, 0);
assert.equal(targetActor.effects.length, 0);
assert.equal(targetActor.items.length, 0);

const shoveItem = {
  uuid: COMBAT_ACTION_AUTOMATIONS[2].uuid,
  name: "Shove",
  img: "shove.webp",
  system: {identifier: "shove"}
};
const clearTargetActor = actor("ClearTarget", "med");
const clearTarget = token("ClearTarget", clearTargetActor, 100);
dialogResults = ["ath", "push"];
contestedResult = 2;
assert.equal(await useShove({
  workflow: {token: source, targets: new Set([clearTarget]), item: shoveItem},
  item: shoveItem
}), true);
assert.equal(slid, true);

dialogResults = ["acr"];
contestedResult = 0;
assert.equal(await useShove({
  workflow: {token: source, targets: new Set([clearTarget]), item: shoveItem},
  item: shoveItem
}), false, "Il difensore deve vincere i pareggi");

console.log("Khuzoe Automations | Grapple e Shove 2014: registrazione, taglia, contest, grapple e spinta OK.");
