import test from "node:test";
import assert from "node:assert/strict";
import { reducedAttackGroup, rollGroupKey, rollGroups } from "../scripts/roll-groups.mjs";

const element = { matches: () => false, querySelectorAll: () => [] };
const actor = { scene: "scene", actor: "actor", token: "source" };
const message = (type, targets = []) => ({
  author: { id: "player" }, isContentVisible: true, speaker: actor, whisper: [],
  flags: { dnd5e: { roll: { type } }, "midi-qol": { targets: targets.map(token => ({ uuid: `Scene.scene.Token.${token}` })) } }
});

test("checks match by actor and audience, including different skills and linked tokens", () => {
  globalThis.game = { user: { isGM: true }, scenes: new Map() };
  const skill = message("skill"), tool = message("tool");
  tool.speaker = { ...actor, token: "second" };
  tool.author = { id: "second-player" };
  const key = rollGroupKey(skill, element);
  assert.ok(key);
  assert.equal(rollGroupKey(tool, element), key);
  assert.notEqual(rollGroupKey({ ...skill, whisper: ["gm"] }, element), key);
  assert.notEqual(rollGroupKey({ ...skill, blind: true }, element), key);
  assert.equal(rollGroupKey(message("save"), element), undefined);
  assert.equal(rollGroupKey({ ...tool, isContentVisible: false }, element), undefined);
  game.scenes.set("scene", { tokens: new Map([["second", { actorLink: false }]]) });
  assert.notEqual(rollGroupKey(tool, element), key);
});

test("attacks require the complete unordered target set and keep public summaries separate", () => {
  globalThis.game = { user: { isGM: true } };
  const a = message("attack", ["one", "two"]), b = message("attack", ["two", "one"]);
  assert.equal(rollGroupKey(a, element), rollGroupKey(b, element));
  assert.notEqual(rollGroupKey(a, element), rollGroupKey(message("attack", ["two"]), element));
  assert.equal(rollGroupKey(message("attack"), element), undefined);
  const signature = reducedAttackGroup(a);
  assert.equal(signature, reducedAttackGroup(b));
  assert.ok(signature && !signature.includes("scene"));
  assert.notEqual(signature, reducedAttackGroup({ ...a, speaker: { ...actor, token: "other" } }));
  const publicCopy = { ...a, author: { isGM: true }, flags: { "khuzoe-hud": { reduced: { attack: { total: 17 }, attackGroup: signature } } } };
  assert.notEqual(rollGroupKey(publicCopy, element), rollGroupKey(a, element));
  game.user.isGM = false;
  assert.equal(rollGroupKey(a, element), undefined);
  const row = id => ({ dataset: { id }, closest: () => null });
  const visible = rows => ({ ...element, querySelectorAll: () => rows });
  assert.ok(rollGroupKey(a, visible([row("one"), row("two")])));
  assert.equal(rollGroupKey(a, visible([row("one")])), undefined);
  assert.equal(rollGroupKey(a, visible([row("one"), { ...row("two"), closest: () => ({}) }])), undefined);
});

test("a repeated activity keeps the latest available controls and targets across attached receipts", () => {
  const messages = new Map();
  globalThis.game = { user: { isGM: true }, messages };
  const log = {};
  const target = { dataset: { id: "target" }, closest: () => null };
  const texture = { dataset: { khhudFoot: "#210d19" }, hasAttribute: () => true };
  function attack(id, activity) {
    const doc = message("attack", ["target"]);
    doc.flags.dnd5e.activity = { uuid: activity };
    messages.set(id, doc);
    const props = new Map();
    const attrs = new Set();
    return {
      ...element, nodeType: 1, parentElement: log, dataset: { messageId: id },
      hasDamage: true, targets: [target],
      style: { getPropertyValue: k => props.get(k) ?? "", setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
      querySelector(selector) {
        if (selector.includes("khhud-banner-texture")) return texture;
        if (selector.includes("rollAttack") || (selector.includes("rollDamage") && this.hasDamage)) return target;
        return null;
      },
      querySelectorAll() { return this.targets; },
      hasAttribute: name => attrs.has(name),
      toggleAttribute(name, enabled) { if (enabled) attrs.add(name); else attrs.delete(name); },
      removeAttribute(name) {
        attrs.delete(name);
        if (name === "data-khhud-superseded") delete this.dataset.khhudSuperseded;
        if (name === "data-khhud-roll-follow") delete this.dataset.khhudRollFollow;
      }
    };
  }
  const first = attack("one", "Fist"), second = attack("two", "Fist"), third = attack("three", "Claw");
  const receipt = { ...element, dataset: { messageId: "hp" } };
  const rows = [first, receipt, second, third];
  rows.forEach((row, i) => { row.previousElementSibling = rows[i - 1]; row.nextElementSibling = rows[i + 1]; });
  const update = rollGroups(log, new Map([[receipt, first]]), () => []);
  second.matches = selector => selector.includes(".dsn-hide");
  update([first, second, third]);
  assert.equal(first.dataset.khhudSuperseded, undefined);
  assert.equal(second.dataset.khhudRollFollow, undefined);
  second.matches = () => false;
  update([first, second, third]);
  assert.ok(first.hasAttribute("data-khhud-attack-series") && third.hasAttribute("data-khhud-attack-series"));
  assert.equal(first.dataset.khhudSuperseded, "attack damage targets");
  assert.equal(second.dataset.khhudSuperseded, undefined);
  assert.equal(third.style.getPropertyValue("--khhud-series-fill"), "#210d19");
  second.hasDamage = false;
  second.targets = [];
  update([second]);
  assert.equal(first.dataset.khhudSuperseded, "attack");
  messages.get("two").flags["midi-qol"].targets = [{ uuid: "Scene.scene.Token.other" }];
  update([second]);
  assert.equal(first.dataset.khhudSuperseded, undefined);
  assert.equal(first.style.getPropertyValue("--khhud-series-fill"), "");
  assert.equal(first.hasAttribute("data-khhud-attack-series"), false);
});
