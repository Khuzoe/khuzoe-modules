import test from "node:test";
import assert from "node:assert/strict";
import { missedAttack, registerAttackRetries } from "../scripts/attack-retry.mjs";

test("a chat retry after a miss starts an independent attack with the original audience", async () => {
  const hooks = new Map();
  globalThis.Hooks = { once: (name, fn) => hooks.set(name, fn), on: (name, fn) => hooks.set(name, fn) };
  const token = { id: "target" };
  const source = { id: "first", uuid: "ChatMessage.first", isContentVisible: true, system: { scaling: 2 },
    whisper: ["gm"], blind: true, content: '<li class="target failure midi-qol-hit-class"></li>',
    flags: { "midi-qol": { isHit: false, attackRoll: { total: 14 }, hitTargetUuids: [], targets: [{ uuid: "Scene.s.Token.t" }] } } };
  globalThis.game = { modules: new Map([["midi-qol", { active: true }]]), user: { targets: new Set() }, messages: new Map([[source.id, source]]) };
  globalThis.fromUuidSync = uuid => uuid === "Scene.s.Token.t" && { object: token };
  let nonce = 0;
  globalThis.foundry = { utils: { randomID: () => String(++nonce) } };
  let ordinary = 0;
  const actions = Object.fromEntries(["rollAttack", "rollAttackAdvantage", "rollAttackDisadvantage", "rollDamage"].map(k => [k, () => ++ordinary]));
  const type = { documentClass: { metadata: { usage: { actions } } } };
  globalThis.CONFIG = { DND5E: { activityTypes: { attack: type, midiAttack: type } } };
  registerAttackRetries();
  hooks.get("ready")();
  const created = [];
  const activity = { item: { isOwner: true }, async use(usage, dialog, message) {
    const row = { id: "second", flags: message.data.flags, updateSource(changes) { Object.assign(this, changes); } };
    // D&D5e can apply the activity's own visibility setting during construction.
    message.data.whisper.length = 0;
    assert.notEqual(hooks.get("preCreateChatMessage")(row), false);
    assert.deepEqual(row.whisper, ["gm"]);
    assert.equal(row.blind, true);
    assert.equal(usage.workflow, undefined);
    assert.deepEqual([...usage.midiOptions.targetsToUse], [token]);
    assert.equal(usage.consume, false);
    assert.equal(usage.scaling, 2);
    assert.equal(usage.midiOptions.workflowOptions.advantage, true);
    row.total = 27;
    created.push(row);
    await Promise.resolve();
    return row;
  } };
  const results = await Promise.all([1, 2].map(() => actions.rollAttackAdvantage.call(activity, {}, {}, source)));
  assert.equal(created.length, 1);
  assert.equal(results[0].total, 27);
  assert.equal(source.flags["midi-qol"].attackRoll.total, 14);
  assert.equal(ordinary, 0);
  const cancel = { ...activity, use: async () => undefined };
  assert.equal(await actions.rollAttack.call(cancel, {}, {}, source), undefined);
  assert.equal(missedAttack(source), true);
  actions.rollDamage.call(activity, {}, {}, source);
  source.flags["midi-qol"].isHit = true;
  await actions.rollAttack.call(activity, {}, {}, source);
  assert.equal(ordinary, 2);
  assert.equal(created.length, 1);
});
