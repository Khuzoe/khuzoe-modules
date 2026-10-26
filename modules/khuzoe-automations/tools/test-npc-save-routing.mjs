import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {rollTargetSavingThrow} from "../scripts/target-saves.mjs";
import {NPC_IDS, registerHomebrewNpcs} from "../scripts/homebrew-npcs.mjs";

// Run the installed Midi handler, including its real argument-to-native-roll
// mapping. All actors, users, effects and transport calls below are in memory.
const midiSource = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
const start = midiSource.indexOf("async function rollAbility(data)");
const end = midiSource.indexOf("\nfunction monksTokenBarSaves", start);
assert.ok(start >= 0 && end > start, "Installed Midi roll handler is available");
const actors = new Map();
const midiRoll = new Function("fromActorUuid", "configSettings", "error", "warn",
  `return (${midiSource.slice(start, end).trim()});`
)(uuid => actors.get(uuid), {playerSaveTimeout: 0}, assert.fail, assert.fail);

const gm = {id: "gm", isGM: true, active: true};
const initiator = {id: "attacker-player", active: true};
const otherOwner = {id: "other-owner", active: true};
const owner = {id: "defender-player", active: true, character: {id: "defender", uuid: "Actor.defender"}};
const offline = {id: "offline-owner", active: false};
const users = new Map([gm, initiator, otherOwner, owner, offline].map(user => [user.id, user]));
users.activeGM = gm;
const warnings = [], calls = [], rolls = [], effects = [];
let result = [{total: 12}];
globalThis.game = {user: gm, users, combat: {id: "combat", started: true, round: 1, turn: 0}};
globalThis.ui = {notifications: {warn: text => warnings.push(text)}};
globalThis.foundry = {utils: {logCompatibilityWarning: assert.fail}};
function update(data) {
  for (const [path, value] of Object.entries(data)) {
    const keys = path.split("."), last = keys.pop();
    keys.reduce((object, key) => object[key] ??= {}, this)[last] = structuredClone(value);
  }
  return this;
}
const defender = {
  id: "defender", uuid: "Actor.defender", name: "Bersaglio", effects: [],
  ownership: {[offline.id]: 3, [otherOwner.id]: 3, [owner.id]: 3},
  async rollSavingThrow(config, dialog, message) {
    rolls.push({actor: this.uuid, user: game.user.id, config, dialog, message});
    return result;
  }
};
actors.set(defender.uuid, defender);
const scene = {id: "scene", tokens: []};
const target = {id: "target", uuid: "Scene.scene.Token.target", documentName: "Token", name: "Bersaglio", actor: defender, parent: scene};
scene.tokens.push(target);
globalThis.canvas = {scene};
globalThis.cat = {utils: {
  queryUtils: {gmUser: () => gm},
  documentUtils: {deleteDocument: async effect => { effect.removed = true; }},
  effectUtils: {createEffects: async (actor, data) => { effects.push({actor, data}); return data; }}
}};
const socket = {async executeAsUser(handler, userId, payload) {
  assert.equal(handler, "rollAbilityV2");
  calls.push({userId, payload});
  const sender = game.user;
  game.user = users.get(userId);
  try {
    const value = await midiRoll(structuredClone(payload));
    return value == null ? value : JSON.parse(JSON.stringify(value));
  } finally { game.user = sender; }
}};
globalThis.MidiQOL = {socket: () => socket};

let save = await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.at(-1).userId, owner.id, "Assigned player wins over the other active owner and the GM");
assert.equal(calls.at(-1).payload.saveDetails.actorUuid, defender.uuid);
assert.equal(rolls.at(-1).actor, defender.uuid);
assert.equal(rolls.at(-1).user, owner.id);
assert.equal(rolls.at(-1).config.ability, "int");
assert.equal(rolls.at(-1).config.midiOptions.target, 16);
assert.equal(rolls.at(-1).dialog.configure, true, "The defender must be offered a roll dialog");
assert.equal(rolls.at(-1).message.create, true);
assert.equal(save.success, false); assert.equal(save.margin, 4);

game.user = initiator;
await rollTargetSavingThrow({document: target}, "con", 16);
assert.equal(rolls.at(-1).user, owner.id, "An attacking player must not roll the defender's save");
game.user = owner;
const remoteCount = calls.length;
result = [{total: 16}];
save = await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.length, remoteCount, "A target's own client rolls locally once");
assert.equal(rolls.at(-1).dialog.configure, true);
assert.equal(rolls.at(-1).dialog.target, 16);
assert.equal(save.success, true);

game.user = gm; owner.active = false;
await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.at(-1).userId, otherOwner.id, "Use another connected owner before the GM");
otherOwner.active = false;
const offlineCount = calls.length;
await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.length, offlineCount);
assert.equal(rolls.at(-1).user, gm.id, "No connected player owner: the GM controls this defender");
owner.active = true; otherOwner.active = true;

const ownership = defender.ownership;
defender.ownership = {default: 3, [initiator.id]: 0};
await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.at(-1).userId, owner.id, "Default ownership is honored without choosing explicitly excluded players");
defender.ownership = {};
defender.testUserPermission = (user, level) => { assert.equal(level, "OWNER"); return user.id === owner.id; };
defender.uuid = "Scene.scene.Token.target.Actor.defender";
actors.set(defender.uuid, defender);
await rollTargetSavingThrow(target, "int", 16);
assert.equal(calls.at(-1).payload.saveDetails.actorUuid, defender.uuid, "Use the synthetic actor, not its world base actor");
defender.uuid = "Actor.defender"; defender.ownership = ownership; delete defender.testUserPermission;

for (const cancelled of [null, [], {}, false, [{total: null}], [{total: "invalid"}]]) {
  result = cancelled;
  assert.equal(await rollTargetSavingThrow(target, "int", 16), null, "No roll means no automatic failure or fallback roll");
}
result = [{_total: 19}];
assert.equal((await rollTargetSavingThrow(target, "int", 16)).success, true, "Serialized totals are accepted");
const normalSocket = MidiQOL.socket;
const errorLog = console.error;
console.error = () => {};
try {
  for (const broken of [undefined, {executeAsUser: async () => {throw new Error("connection lost");}}]) {
    MidiQOL.socket = () => broken;
    const before = rolls.length;
    assert.equal(await rollTargetSavingThrow(target, "int", 16), null);
    assert.equal(rolls.length, before, "Remote failure never retries on the initiating client");
  }
} finally { MidiQOL.socket = normalSocket; console.error = errorLog; }
assert.equal(warnings.length, 2);

// Exercise the actual registered El'Athel macros, including effect outcomes.
const registrations = [];
registerHomebrewNpcs({registerAutomation() {}, registerFnMacro(data) { registrations.push(data); }});
const attacker = {id: "elathel", uuid: "Actor.elathel", flags: {}, update,
  rollSavingThrow() { assert.fail("El'Athel must never roll the target's save"); }};
const strike = {documentName: "Item", name: "Psychic Strike", uuid: "Actor.elathel.Item.strike", actor: attacker};
const strikeMacro = id => registrations.find(entry => entry.identifier === id).roll[0].macro;
const melee = strikeMacro(NPC_IDS.psychicMelee), ranged = strikeMacro(NPC_IDS.psychicRanged);
result = [{total: 12}];
const before = rolls.length;
await melee({document: strike, workflow: {id: "hit1", hitTargets: new Set([target])}});
assert.equal(rolls.length, before);
await ranged({document: strike, workflow: {id: "hit2", hitTargets: new Set([target])}});
assert.equal(rolls.length, before + 1);
assert.equal(rolls.at(-1).user, owner.id);
assert.equal(effects.length, 1); assert.equal(effects[0].actor, defender);
assert.deepEqual(effects[0].data[0].statuses, ["stunned"]);
await ranged({document: strike, workflow: {id: "hit2", hitTargets: new Set([target])}});
assert.equal(rolls.length, before + 1, "A repeated workflow cannot ask for a second save");
for (const outcome of [[{total: 16}], null]) {
  game.combat.turn++;
  result = outcome;
  await melee({document: strike, workflow: {id: `first${game.combat.turn}`, hitTargets: new Set([target])}});
  await melee({document: strike, workflow: {id: `second${game.combat.turn}`, hitTargets: new Set([target])}});
  assert.equal(effects.length, 1, "A passed or canceled target save grants no stun");
}

const brain = registrations.find(entry => entry.identifier === "khuzoe-elathel-brain-storm-poison").combat[0].macro;
const poison = {documentName: "ActiveEffect", flags: {"khuzoe-automations": {brainStorm: {remainingSaves: 10}}}, update};
result = null;
assert.equal(await brain({document: poison, actor: defender}), false);
assert.equal(poison.flags["khuzoe-automations"].brainStorm.remainingSaves, 10);
result = [{total: 12}];
await brain({document: poison, actor: defender});
assert.equal(rolls.at(-1).user, owner.id);
assert.equal(poison.flags["khuzoe-automations"].brainStorm.remainingSaves, 9);
result = [{total: 16}];
await brain({document: poison, actor: defender});
assert.equal(poison.removed, true);
console.log("NPC target saves: installed Midi handler, defender ownership, local/remote/synthetic actors, cancellation, no duplicate roll, Psychic Strike and repeated Brain Storm saves OK.");
