import {registerDocuments} from "./fixtures-documents.mjs";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

globalThis.game = {user: {id: "player", isGM: false}};
globalThis.ui = {notifications: {error() {}}};

let confirmations = 0;
let flatReduction = 0;
let reactionUsed = 0;
let reactionRemoved = 0;
let reactionAlreadyUsed = false;
let rollTotal = 10;
let message;

class TestRoll {
  constructor(formula) { this.formula = formula; }
  async evaluate() { this.total = rollTotal; return this; }
  async toMessage(data) { message = data; }
}

globalThis.foundry = {dice: {Roll: TestRoll}};
globalThis.ChatMessage = {getSpeaker: ({actor}) => ({actor: actor.id})};
globalThis.MidiQOL = {
  async setReactionUsed() { reactionUsed += 1; },
  async removeReactionUsed() { reactionRemoved += 1; }
};
globalThis.cat = {
  utils: {
    actorUtils: {hasUsedReaction() { return reactionAlreadyUsed; }},
    dialogUtils: {async confirm() { confirmations += 1; return true; }},
    queryUtils: {firstOwner() { return "player"; }},
    workflowUtils: {modifyDamageAppliedFlat(_ditem, amount) { flatReduction = amount; }}
  }
};

const {
  GOLIATH_AUTOMATIONS,
  GOLIATH_IDS,
  prepareGoliathItemUpdate,
  registerGoliath,
  stonesEnduranceReduction,
  useStonesEndurance
} = await import("../scripts/goliath.mjs");

assert.equal(stonesEnduranceReduction(13, 8), 8);
assert.equal(stonesEnduranceReduction(-2, 8), 0);
assert.equal(stonesEnduranceReduction(6.9, 20), 6);

const automations = [];
const macros = [];
const api = {
  registerAutomation(data) { automations.push(data); return data; },
  registerFnMacro(data) { macros.push(data); return data; }
};
const registration = registerGoliath(api);
assert.equal(registration.automations.length, 1);
assert.equal(registration.macros.length, 1);
assert.equal(automations[0].identifier, GOLIATH_IDS.stonesEndurance);
assert.equal(macros[0].roll[0].pass, "targetDamageFlatReductions");

const actor = {
  id: "goliath",
  statuses: new Set(),
  system: {abilities: {con: {mod: 3}}, attributes: {hp: {value: 30}}},
  getRollData() { return this.system; }
};
let spent = 0;
const item = {
  id: "stone-item",
  name: "Stone's Endurance",
  actor,
  isOwner: true,
  img: "custom.webp",
  system: {identifier: GOLIATH_IDS.stonesEndurance, uses: {max: "1", spent: 0, recovery: []}},
  async update(changes) { spent = changes["system.uses.spent"]; }
};

registerDocuments(item);
assert.equal(await useStonesEndurance({
  targetToken: {actor},
  ditem: {hpDamage: 7, tempDamage: 5},
  document: item
}), true);
assert.equal(confirmations, 1);
assert.equal(spent, 1);
assert.equal(reactionUsed, 1);
assert.equal(flatReduction, -10);
assert.match(message.flavor, /riduce 12 danni.*10/);

item.system.uses.spent = 0;
rollTotal = 20;
flatReduction = 0;
assert.equal(await useStonesEndurance({
  targetToken: {actor},
  ditem: {hpDamage: 4, tempDamage: 1},
  document: item
}), true);
assert.equal(flatReduction, -5, "la riduzione non deve superare il danno effettivo");

reactionAlreadyUsed = true;
assert.equal(await useStonesEndurance({
  targetToken: {actor},
  ditem: {hpDamage: 10, tempDamage: 0},
  document: item
}), false);
assert.equal(confirmations, 2, "non deve aprire il dialogo se la reazione è già usata");
reactionAlreadyUsed = false;

item.system.uses.spent = 1;
assert.equal(await useStonesEndurance({
  targetToken: {actor},
  ditem: {hpDamage: 10, tempDamage: 0},
  document: item
}), false);
assert.equal(confirmations, 2, "non deve aprire il dialogo senza utilizzi");

const update = {
  img: "source.webp",
  system: {identifier: GOLIATH_IDS.stonesEndurance, uses: {max: "1", spent: 0, recovery: []}},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
prepareGoliathItemUpdate({
  img: "custom.webp",
  system: {identifier: GOLIATH_IDS.stonesEndurance, uses: {max: "@prof", spent: 2, recovery: [{period: "lr", type: "recoverAll"}]}}
}, update);
assert.equal(update.img, "custom.webp");
assert.equal(update.system.uses.max, "@prof");
assert.equal(update.system.uses.spent, 2);
assert.equal(update.system.uses.recovery[0].period, "lr");

const source = JSON.parse(await readFile(
  new URL("../packData/khuzoe-class-features-2014/Stones_Endurance_KhzStoneEndur001.json", import.meta.url),
  "utf8"
));
assert.equal(source._id.length, 16);
assert.equal(source.system.identifier, GOLIATH_IDS.stonesEndurance);
assert.equal(source.system.uses.max, "1");
assert.equal(source.system.uses.recovery[0].period, "sr");
assert.equal(source.flags.cat.automation.version, GOLIATH_AUTOMATIONS[0].version);
assert.equal(Object.values(source.system.activities)[0]._id.length, 16);

assert.equal(reactionRemoved, 0);
console.log("Khuzoe Automations Goliath 2014: Stone's Endurance OK");
