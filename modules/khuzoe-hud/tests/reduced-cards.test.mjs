import test from "node:test";
import assert from "node:assert/strict";
import { registerReducedCards } from "../scripts/reduced-cards.mjs";
import { registerRollPresentation } from "../scripts/roll-presentation.mjs";

test("GM-only actions publish one allowlisted result and record only committed HP", async () => {
  const hooks = new Map();
  globalThis.Hooks = { once() {}, on(name, fn) {
    const previous = hooks.get(name);
    hooks.set(name, previous ? (...args) => Promise.all([previous(...args), fn(...args)]) : fn);
  } };
  const gm = { id: "gm", isGM: true, active: true }, player = { id: "pc", isGM: false };
  const docs = new Map();
  globalThis.game = {
    user: gm, users: { activeGM: gm, get: id => ({ gm, pc: player })[id] }, messages: docs,
    scenes: new Map(), i18n: { localize: key => key }
  };
  globalThis.document = { baseURI: "https://foundry.test/" };
  globalThis.CONST = { CHAT_MESSAGE_STYLES: { OTHER: 0 } };
  let counter = 0;
  globalThis.foundry = { utils: { randomID: () => "copy" + ++counter } };
  const actor = { uuid: "Actor.a", documentName: "Actor", name: "Briska", prototypeToken: { texture: { src: "actor.webp" } }, system: { attributes: { hp: { value: 38, temp: 4 } } } };
  const token = { documentName: "Token", uuid: "Scene.s.Token.t", name: "Briska", actor, texture: { src: "token.webp" } };
  const a = { ...token, uuid: "Scene.s.Token.a", name: "Mena" }, b = { ...token, uuid: "Scene.s.Token.b", name: "Dona" };
  globalThis.fromUuidSync = uuid => [actor, token, a, b].find(doc => doc.uuid === uuid);
  const mod = "khuzoe-hud";
  const apply = (obj, changes) => {
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split("."), field = parts.pop();
      let dest = obj;
      for (const part of parts) dest = dest[part] ??= {};
      dest[field] = value && typeof value === "object" && !Array.isArray(value) ? { ...dest[field], ...value } : value;
    }
  };
  const doc = (id, values) => {
    const msg = { id, flags: {}, rolls: [], isContentVisible: true, author: gm, speaker: {}, ...values,
      async update(changes) { apply(this, changes); hooks.get("updateChatMessage")(this); },
      async setFlag(scope, key, value) { await this.update({ [`flags.${scope}.${key}`]: value }); },
      async delete() { docs.delete(id); hooks.get("deleteChatMessage")(this); }
    };
    docs.set(id, msg);
    return msg;
  };
  const writes = [];
  globalThis.ChatMessage = { async create(payload, options) {
    writes.push(structuredClone(payload));
    assert.equal(options.messageMode, "public");
    return doc(payload._id, payload);
  } };
  let coverLookups = 0;
  registerRollPresentation();
  registerReducedCards(async actor => {
    coverLookups++;
    return `wiki-card-${actor.id}-12ab.webp`;
  });
  const emit = (event, ...args) => hooks.get(event)(...args);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const make = (id, recipients, type) => doc(id, { whisper: recipients, content: "SECRET GM NOTES",
    getAssociatedActor: () => actor, getAssociatedActivity: () => ({ type, _source: { img: "ability.webp" }, name: "SECRET MOVE" }),
    flags: { "midi-qol": { attackingTokenUuid: token.uuid, targets: [{ uuid: a.uuid }, { uuid: b.uuid }] } }
  });
  const source = make("attack", ["gm"], "attack");
  const m = source.flags["midi-qol"];
  m.attackRoll = { total: 24, isCritical: true, formula: "1d20 + SECRET", terms: ["SECRET DIE"] };
  m.isFumble = false;
  await Promise.all([emit("createChatMessage", source), emit("updateChatMessage", source)]);
  await tick();
  const copy = docs.get(source.flags[mod].reducedId);
  const view = () => copy.flags[mod].reduced;
  assert.equal(writes.length, 1);
  assert.deepEqual(view().attack, { total: 24, critical: true });
  game.dice3d = {};
  game.settings = { get: () => false };
  source._dice3danimating = true;
  m.attackRoll.total = 19;
  await emit("updateChatMessage", source);
  m.attackRoll.total = 27;
  await emit("updateChatMessage", source);
  assert.equal(view().attack.total, 24);
  delete source._dice3danimating;
  emit("diceSoNiceRollComplete", source.id);
  await tick();
  assert.deepEqual(view().attack, { total: 27, critical: true });
  assert.equal(view().speaker.img, "token.webp");
  assert.equal(view().icon, "ability.webp");
  assert.equal(view().targets.length, 2);
  assert.equal(JSON.stringify(writes).includes("SECRET"), false);
  assert.deepEqual(writes[0].rolls, []);
  assert.equal(view().rolledDamage, null);
  const child = doc("child-damage", { whisper: ["gm"], flags: { dnd5e: { originatingMessage: source.id, roll: { type: "damage" } } },
    rolls: [{ total: 5, formula: "SECRET" }] });
  await emit("createChatMessage", child); await tick();
  assert.equal(view().rolledDamage, 5);
  child.rolls[0].total = 7;
  await emit("updateChatMessage", child); await tick();
  assert.equal(view().rolledDamage, 7);
  m.damageTotal = 20;
  m.damageRolls = [{ total: 20, formula: "SECRET" }];
  source.rolls = [{ total: 20, options: { "midi-qol": { rollType: "defaultDamage" } } },
    { total: 3, options: { "midi-qol": { rollType: "bonusDamage" } } }];
  await emit("updateChatMessage", source);
  assert.equal(view().rolledDamage, 23);
  assert.equal(view().targets[0].hp, null);
  assert.equal(JSON.stringify(view()).includes("SECRET"), false);
  const other = doc("other-damage", { whisper: ["gm"], flags: { dnd5e: { originatingMessage: source.id } },
    rolls: [{ total: 2, options: { "midi-qol": { rollType: "otherDamage" } } }] });
  await emit("createChatMessage", other); await tick();
  assert.equal(view().rolledDamage, 25);
  await other.delete(); await tick();
  assert.equal(view().rolledDamage, 23);
  const item = { calcDamageOptions: {}, updateOptions: {} };
  emit("midi-qol.preTargetDamageApplication", { document: a }, { workflow: { chatCard: source }, damageItem: item });
  const opts = item.updateOptions;
  emit("dnd5e.preApplyDamage", actor, 9, {}, opts);
  assert.equal(view().targets[0].hp, null);
  actor.system.attributes.hp = { value: 33, temp: 0 };
  await emit("dnd5e.applyDamage", actor, 9, opts); await tick();
  assert.deepEqual(view().targets[0].hp, [38, 33]);
  assert.deepEqual(view().targets[0].temp, [4, 0]);
  assert.equal(view().targets[1].hp, null);
  emit("dnd5e.preApplyDamage", actor, -9, {}, item.calcDamageOptions);
  actor.system.attributes.hp = { value: 38, temp: 4 };
  await emit("dnd5e.applyDamage", actor, -9, item.calcDamageOptions); await tick();
  assert.deepEqual(view().targets[0].hp, [38, 38]);

  const save = make("save", ["gm"], "save");
  await emit("midi-qol.postCheckSaves", { chatCard: save, saveDisplayData: [
    { target: { document: a }, playerName: "Mena", rollTotal: "19", saveClass: "success", rollHTML: "SECRET" },
    { target: { document: b }, playerName: "Dona", rollTotal: "0", saveClass: "failure", rollDetail: "SECRET" }
  ] }); await tick();
  const saved = docs.get(save.flags[mod].reducedId).flags[mod].reduced;
  assert.deepEqual(saved.targets.map(t => [t.name, t.save, t.passed]), [["Mena", 19, true], ["Dona", 0, false]]);
  const receipt = { flags: { [mod]: { sourceMessageId: save.id }, "midi-qol": { playerDamageCard: true, undoDamage: ["SECRET"] } } };
  assert.equal(emit("preCreateChatMessage", receipt), false);
  for (const recipients of [[], ["gm", "pc"], ["pc"]]) {
    const other = make("other", recipients, "attack");
    await emit("createChatMessage", other);
    receipt.flags[mod].sourceMessageId = other.id;
    assert.notEqual(emit("preCreateChatMessage", receipt), false);
  }
  await emit("createChatMessage", doc("whisper", { whisper: ["gm"], content: "SECRET" }));
  game.user = player;
  await emit("createChatMessage", make("untrusted", ["gm"], "save"));
  game.user = gm;
  assert.equal(writes.length, 2);

  // Old copies have neither a title nor a world actor reference. On GM login,
  // repair the presentation while keeping the public outcome recorded at roll time.
  actor.id = "a";
  actor.type = "npc";
  game.actors = new Map([[actor.id, actor]]);
  delete view().title;
  delete view().rolledDamage;
  m.attackRoll.total = 99;
  const before = structuredClone(view().targets);
  await emit("ready"); await tick();
  assert.equal(view().title, null); // This fixture's activity has only a private name.
  assert.equal(view().speaker.wikiActorId, actor.id);
  assert.equal(view().speaker.wikiActorType, "npc");
  assert.equal(view().rolledDamage, 23);
  assert.deepEqual(copy.flags[mod].cover, { actorId: "a", image: "wiki-card-a-12ab.webp" });
  assert.deepEqual(view().attack, { total: 27, critical: true });
  assert.deepEqual(view().targets, before);
  assert.equal(JSON.stringify(copy.flags).includes("SECRET"), false);
  const previousLookups = coverLookups;
  await emit("ready"); await tick();
  assert.equal(coverLookups, previousLookups);
  assert.equal(writes.length, 2);

  // Updates arriving during a network write still publish the latest damage.
  let releaseWrite, startedWrite;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const writing = new Promise(resolve => { startedWrite = resolve; });
  const originalUpdate = copy.update.bind(copy);
  const seen = [];
  copy.update = async changes => {
    const summary = changes[`flags.${mod}.reduced`];
    if (summary) {
      seen.push(summary.rolledDamage);
      startedWrite();
      await gate;
    }
    return originalUpdate(changes);
  };
  source.rolls[0].total = 30;
  const firstWrite = emit("updateChatMessage", source);
  await writing;
  const pending = [];
  for (let n = 31; n <= 42; n++) {
    source.rolls[0].total = n;
    pending.push(emit("updateChatMessage", source));
  }
  assert.equal(new Set(pending).size, 1);
  releaseWrite();
  await Promise.all([firstWrite, ...pending]);
  assert.deepEqual(seen, [33, 45]);
  assert.equal(view().rolledDamage, 45);
  await source.delete(); await tick();
  assert.equal(docs.has(copy.id), false);
});
