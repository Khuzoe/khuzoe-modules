import test from "node:test";
import assert from "node:assert/strict";
import { registerRollPresentation } from "../scripts/roll-presentation.mjs";

function setup() {
  const hooks = new Map();
  const on = (event, fn) => hooks.set(event, [...(hooks.get(event) ?? []), fn]);
  const emit = (event, ...args) => hooks.get(event)?.forEach(fn => fn(...args));
  globalThis.Hooks = { once: on, on };
  const actions = { rollDamage: (_event, button) => button.result };
  class Activity {
    static metadata = { usage: { actions } };
    rollAttack(config) { return config.result; }
  }
  globalThis.CONFIG = { DND5E: { activityTypes: { attack: { documentClass: Activity } } } };
  globalThis.game = { messages: new Map(), dice3d: {}, settings: { get: () => false },
    modules: new Map([["midi-qol", { active: true }]]) };
  const renders = [];
  globalThis.ui = { chat: { async updateMessage(message, options) {
    renders.push([message.id, message.isContentVisible ? message.content : "private", !!options?.notify]);
  } } };
  registerRollPresentation();
  emit("ready");
  function message(id) {
    const doc = { id, isRoll: true, isContentVisible: true, content: "original" };
    game.messages.set(id, doc);
    return doc;
  }
  function change(doc, data, notify = false) {
    Object.assign(doc, data);
    const updated = ui.chat.updateMessage(doc, { notify });
    emit("updateChatMessage", doc, { _id: doc.id, _stats: { modifiedTime: 50 }, ...data });
    return updated;
  }
  return { actions, Activity, message, emit, change, renders };
}

test("overlapping roll animations commit the latest row once and leave other messages live", async () => {
  const { message, change, emit, renders } = setup();
  const a = message("attack"), b = message("other");
  const first = change(a, { content: "partial" }, true);
  // Foundry requested the redraw before DSN processed the same update.
  a._dice3danimating = true;
  const second = change(a, { content: "finished" });
  await change(b, { content: "unrelated" });
  emit("diceSoNiceRollComplete", a.id); // One of two rolls finished.
  await Promise.resolve();
  assert.deepEqual(renders, [["other", "unrelated", false]]);
  delete a._dice3danimating;
  emit("diceSoNiceRollComplete", a.id);
  await Promise.all([first, second]);
  assert.deepEqual(renders, [["other", "unrelated", false], ["attack", "finished", true]]);
});

test("a Midi card holds its current DOM through cancellation and the last concurrent chat action", async () => {
  const { actions, message, change, renders } = setup();
  const a = message("midi");
  a.isRoll = false;
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const one = actions.rollDamage(null, { result: first.promise }, a);
  const two = actions.rollDamage(null, { result: second.promise }, a);
  const redraw = change(a, { content: "ready" });
  first.reject(new Error("cancelled"));
  await assert.rejects(one, /cancelled/);
  assert.equal(renders.length, 0);
  second.resolve(18);
  assert.equal(await two, 18);
  await redraw;
  assert.deepEqual(renders, [["midi", "ready", false]]);
});

test("privacy, deletion and immediate-display settings take effect while dice are moving", async () => {
  const { message, change, emit, renders } = setup();
  const a = message("hidden");
  a._dice3danimating = true;
  const first = change(a, { content: "roll" });
  await Promise.resolve();
  a.isContentVisible = false;
  await change(a, { blind: true });
  assert.deepEqual(renders, [["hidden", "private", false]]);
  const b = message("deleted");
  b._dice3danimating = true;
  const deleted = change(b, { content: "removed" });
  await Promise.resolve();
  game.messages.delete(b.id);
  emit("deleteChatMessage", b);
  delete a._dice3danimating;
  emit("diceSoNiceRollComplete", a.id);
  await Promise.all([first, deleted]);
  const c = message("immediate");
  c._dice3danimating = true;
  game.settings.get = () => true;
  await change(c, { content: "20" });
  assert.deepEqual(renders, [["hidden", "private", false], ["immediate", "20", false]]);
});

test("automatic Midi rolls started from the sheet wait for the result on the originating card", async () => {
  const { Activity, message, change, renders } = setup();
  const a = message("sheet");
  a.isRoll = false;
  const dice = Promise.withResolvers();
  const rolled = new Activity().rollAttack({ workflow: { chatCard: a }, result: dice.promise });
  const first = change(a, { flags: { "midi-qol": { currentAction: "waitForAttackRoll" } } });
  await Promise.resolve();
  assert.equal(renders.length, 0);
  const second = change(a, { content: "hit" });
  dice.resolve(19);
  assert.equal(await rolled, 19);
  await Promise.all([first, second]);
  assert.deepEqual(renders, [["sheet", "hit", false]]);
});
