import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";

// Real v14 update operators and the installed dnd5e transformation implementation,
// exercised on isolated in-memory Documents. No world, network or live game access.
const app = new URL("../../../../App/resources/app/", import.meta.url);
const utils = await import(new URL("common/utils/helpers.mjs", app));
const operators = await import(new URL("common/data/operators.mjs", app));
const handlers = new Map();
globalThis.Hooks = {
  on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return fn; },
  once(name, fn) { return this.on(name, fn); },
  off(name, fn) { handlers.set(name, (handlers.get(name) ?? []).filter(entry => entry !== fn)); },
  callAll(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); }
};
globalThis.foundry = {utils, data: {operators}, applications: {api: {
  ApplicationV2: class { async render() { await this.close(); } async close() {} },
  HandlebarsApplicationMixin: base => base
}}};
globalThis.CONFIG = {DND5E: {abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
  .map(key => [key, {type: ["str", "dex", "con"].includes(key) ? "physical" : "mental"}]))}};
globalThis.ui = {notifications: {warn() {}, error() {}, info() {}}};
const gm = {id: "gm", active: true, isGM: true};
const player = {id: "player", active: true, isGM: false};
globalThis.game = {user: gm, users: new Map([[gm.id, gm], [player.id, player]]), actors: new Map(), scenes: new Map(),
  time: {worldTime: 100}, modules: new Map(), settings: {get: () => true}};
// Automatic hooks disabled during imperative tests; exercised explicitly below.
game.users.activeGM = null;
const clone = utils.deepClone;
let serial = 0;
const uuidRegistry = new Map();
globalThis.fromUuid = async uuid => uuidRegistry.get(uuid) ?? null;
globalThis.fromUuidSync = uuid => uuidRegistry.get(uuid) ?? null;
globalThis.cat = {utils: {effectUtils: {getConcentrationEffect: actor => actor.effects.get("concentration")}}};
globalThis.dnd5e = {dataModels: {settings: {TransformationSetting: class {
  constructor(data) { Object.assign(this, data); }
  toObject() { return Object.fromEntries(Object.entries(this).map(([key, value]) => [key, value instanceof Set ? [...value] : value])); }
}}}};

function apply(target, updates) {
  return utils.mergeObject(target, updates, {inplace: false, applyOperators: true});
}
class Effect {
  constructor(data, parent) {
    Object.assign(this, clone(data)); this.id = data._id ?? `effect${++serial}`; this.parent = parent;
    this.uuid = `${parent.uuid}.ActiveEffect.${this.id}`;
    uuidRegistry.set(this.uuid, this);
  }
  toObject() { const {parent, uuid, id, ...data} = this; return {...clone(data), _id: id}; }
  async update(data) { Object.assign(this, data); }
  async delete() {
    assert.ok(this.parent.effects.has(this.id), `ActiveEffect "${this.id}" does not exist!`);
    this.parent.effects.delete(this.id); uuidRegistry.delete(this.uuid);
  }
}
class Item {
  constructor(data, actor) {
    Object.assign(this, clone(data)); this.id = this._id; this.actor = actor; this.uuid = `${actor.uuid}.Item.${this.id}`;
    const activities = this.system.activities ?? {};
    this.system.activities = new Map(Object.entries(activities).map(([id, data]) => [id, {...data, id}]));
    uuidRegistry.set(this.uuid, this);
  }
  toObject() { const {actor, uuid, id, ...data} = this; return {...clone(data), system: {...clone(this.system), activities: Object.fromEntries(this.system.activities)}}; }
}
class Actor {
  constructor(data) {
    this._id = this.id = data._id ?? `actor${++serial}`; this.uuid = `Actor.${this.id}`;
    this.name = data.name; this.type = data.type; this.img = data.img; this.flags = clone(data.flags ?? {});
    this.ownership = clone(data.ownership ?? {}); this.system = clone(data.system);
    this.prototypeToken = {...clone(data.prototypeToken), toObject() { const {toObject, ...rest} = this; return clone(rest); }};
    this.items = new Map((data.items ?? []).map(data => { const item = new Item(data, this); return [item.id, item]; }));
    this.effects = new Map((data.effects ?? []).map(data => { const effect = new Effect(data, this); return [effect.id, effect]; }));
    this.sheet = {close: async () => {}};
  }
  get isPolymorphed() { return Boolean(this.flags.dnd5e?.isPolymorphed); }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  testUserPermission(user, level) { return user.isGM || (this.ownership[user.id] ?? this.ownership.default ?? 0) >= (level === "OWNER" ? 3 : 1); }
  getFlag(scope, key) { return utils.getProperty(this.flags[scope], key); }
  getRollData() { return clone(this.system); }
  toObject() { return {_id: this.id, name: this.name, type: this.type, img: this.img, flags: clone(this.flags),
    system: clone(this.system), ownership: clone(this.ownership), prototypeToken: this.prototypeToken.toObject(),
    items: [...this.items.values()].map(item => item.toObject()), effects: [...this.effects.values()].map(effect => effect.toObject())}; }
  static async create(data) {
    const actor = new Actor(data); game.actors.set(actor.id, actor); uuidRegistry.set(actor.uuid, actor);
    Hooks.callAll("createActor", actor); return actor;
  }
  async update(updates) {
    const {items = [], ...data} = updates;
    const result = apply({flags: this.flags, system: this.system}, data);
    this.flags = result.flags; this.system = result.system;
    for (const update of items) {
      const item = this.items.get(update._id);
      this.items.set(item.id, new Item(apply(item.toObject(), update), this));
    }
    return this;
  }
  async createEmbeddedDocuments(type, entries) {
    assert.equal(type, "ActiveEffect");
    return entries.map(data => { const effect = new Effect(data, this); this.effects.set(effect.id, effect); return effect; });
  }
  async delete() { game.actors.delete(this.id); uuidRegistry.delete(this.uuid); for (const e of this.effects.values()) uuidRegistry.delete(e.uuid); }
}
const native = await readFile(new URL("../../../systems/dnd5e/dnd5e.mjs", import.meta.url), "utf8");
const start = native.indexOf("  async transformInto(");
const end = native.indexOf("  async revertOriginalForm(", start);
assert.ok(start > 0 && end > start, "Native dnd5e transform contract is present");
const nativeTransform = native.slice(start, end).replace(/^  async transformInto/, "async function transformInto")
  .replace(/\/\* -------------------------------------------- \*\/[\s\S]*$/, "");
Actor.prototype.transformInto = new Function("simplifyBonus", `return (${nativeTransform});`)(() => 0);

function actorData(id, overrides = {}) {
  return {_id: id, name: id, type: "npc", img: "portrait.webp", ownership: {player: 3}, flags: {untouched: {value: 1},
    "khuzoe-tokenizer": {syncEvent: {eventId: "original-save"}, variants: ["keep-image"]}, "cripta-wiki-sync": {npcId: "original-npc"}},
    system: {abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(key => [key, {value: 12, proficient: 1}])),
      attributes: {hp: {value: 20, max: 20, temp: 2}, ac: {value: 15}, prof: 3, spellcasting: "int"},
      skills: {acr: {value: 1}}, traits: {languages: {value: ["common"]}}, details: {biography: {value: "original"}},
      spells: {spell1: {value: 3, max: 4}}},
    items: [{_id: "retained", name: "Feature", type: "feat", system: {uses: {spent: 1}, activities: {use: {type: "utility", uses: {spent: 1}}}}}],
    effects: [], prototypeToken: {name: id, width: 1, height: 1, alpha: 1, lockRotation: false, ring: {enabled: false},
      texture: {src: `${id}.webp`, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, tint: "#ffffff"},
      sight: {enabled: true, range: 30}, detectionModes: [], actorLink: true}, ...overrides};
}
function token(actor, id, scene, linked = true) {
  const document = {id, uuid: `Scene.${scene.id}.Token.${id}`, documentName: "Token", parent: scene,
    actorId: actor.id, actorLink: linked, flags: {untouched: {value: 2}}, name: actor.name,
    ...actor.prototypeToken.toObject(), x: 100, y: 200, delta: {_id: actor.id, system: {attributes: {hp: {value: 17}}}},
    actor, hidden: false, updateCount: 0,
    toObject() { const {actor, parent, updateCount, ...data} = this; return clone(Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== "function"))); },
    async update(updates) {
      if (this.failSwap && updates.actorId !== actor.id) throw new Error("swap failure");
      const next = apply(this.toObject(), updates); Object.assign(this, next); this.updateCount++;
      if ("actorId" in updates || "actorLink" in updates) {
        this.actor = this.actorLink ? game.actors.get(this.actorId) : this.originalSynthetic;
        if (!this.actorLink) {
          uuidRegistry.set(this.actor.uuid, this.actor);
          for (const effect of this.actor.effects.values()) uuidRegistry.set(effect.uuid, effect);
        } else if (this.originalSynthetic) {
          uuidRegistry.delete(this.originalSynthetic.uuid);
          for (const effect of this.originalSynthetic.effects.values()) uuidRegistry.delete(effect.uuid);
        }
      }
      return this;
    },
    async unsetFlag(scope, key) { delete this.flags[scope][key]; }
  };
  document.actorLink = linked;
  if (!linked) {
    const synthetic = new Actor(actor.toObject()); synthetic.isToken = true;
    synthetic.uuid = `${document.uuid}.Actor.${actor.id}`;
    synthetic.system.attributes.hp.value = 17;
    synthetic.items = new Map([...actor.items.values()].map(item => { const copy = new Item(item.toObject(), synthetic); return [copy.id, copy]; }));
    synthetic.effects = new Map([...actor.effects.values()].map(effect => { const copy = new Effect(effect.toObject(), synthetic); return [copy.id, copy]; }));
    document.actor = document.originalSynthetic = synthetic;
    uuidRegistry.set(synthetic.uuid, synthetic);
  }
  scene.tokens.set(id, document); uuidRegistry.set(document.uuid, document);
  return document;
}
async function fixture(linked = true, self = false) {
  game.actors.clear(); game.scenes.clear(); uuidRegistry.clear();
  const scene = {id: "not-the-GM-scene", tokens: new Map()}; game.scenes.set(scene.id, scene);
  const caster = await Actor.create(actorData("caster", {effects: [{_id: "concentration", name: "Shapechange", flags: {}, disabled: false}]}));
  const victim = await Actor.create(actorData("victim"));
  const formData = actorData("dragon", {name: "Dragon", ownership: {player: 1}, items: []});
  formData.system.attributes.hp = {value: 80, max: 80, temp: 0}; formData.system.abilities.str.value = 23;
  formData.system.abilities.int.value = 7; formData.prototypeToken.width = formData.prototypeToken.height = 3;
  const form = await Actor.create(formData);
  const casterToken = token(caster, "caster", scene, self ? linked : true);
  const target = self ? casterToken : token(victim, "target", scene, linked);
  const other = token(self ? caster : victim, "other", scene, linked);
  const spell = new Item({_id: "shapechange", name: "Shapechange", type: "spell", img: "spell.webp", system: {identifier: "shapechange"}}, casterToken.actor);
  casterToken.actor.items.set(spell.id, spell);
  return {caster: casterToken.actor, target, other, form, spell, data: {itemUuid: spell.uuid, casterTokenUuid: casterToken.uuid,
    targetUuid: target.uuid, sourceUuid: form.uuid, operation: `request${++serial}`}};
}
const mod = await import("../scripts/shapechange.mjs");
let f = await fixture();
assert.equal(mod.selectShapechangeTarget({targets: new Set([f.target]), token: f.other}), f.target);
assert.equal(mod.selectShapechangeTarget({targets: new Set(), token: f.other}), f.other);
assert.throws(() => mod.selectShapechangeTarget({targets: new Set([f.target, f.other])}), /una sola/);
assert.equal(mod.canChooseShape(f.form, player), true);
f.form.ownership.player = 0;
assert.equal(mod.canChooseShape(f.form, player), false);
await assert.rejects(mod.transformShapechange(f.data, player.id), /visibile/);
f.form.ownership.player = 1;
f.caster.ownership.player = 1;
await assert.rejects(mod.transformShapechange(f.data, player.id), /permessi/);
f.caster.ownership.player = 3;
f.target.hidden = true;
await assert.rejects(mod.transformShapechange(f.data, player.id), /visibile/);
f.target.hidden = false;
assert.deepEqual(Object.keys(mod.visibleShapes(player)[0]).sort(), ["img", "name", "uuid"]);

for (const linked of [true, false]) for (const self of [true, false]) {
  f = await fixture(linked, self);
  const original = f.target.actor;
  const before = f.target.toObject(); const otherBefore = f.other.toObject(); const sourceBefore = f.form.toObject();
  const id = await mod.transformShapechange(f.data, player.id);
  const changed = await fromUuid(id);
  assert.equal(f.target.actor, changed);
  assert.equal(changed.flags["cripta-wiki-sync"].excludeFromSync, true);
  assert.equal(changed.flags["khuzoe-tokenizer"].syncEvent, undefined);
  assert.deepEqual(changed.flags["khuzoe-tokenizer"].variants, ["keep-image"]);
  assert.equal(original.flags["cripta-wiki-sync"].excludeFromSync, undefined);
  assert.equal(original.flags["khuzoe-tokenizer"].syncEvent.eventId, "original-save");
  assert.equal(changed.system.attributes.hp.max, 80);
  assert.equal(changed.system.abilities.str.value, 23);
  assert.equal(changed.system.abilities.int.value, 12);
  assert.equal(changed.items.has("retained"), true);
  assert.equal(f.target.width, 3);
  assert.deepEqual(f.other.toObject(), otherBefore, "Only the targeted token changes");
  assert.deepEqual(f.form.toObject(), sourceBefore, "Source actor stays untouched");
  assert.equal(await mod.transformShapechange(f.data, player.id), id, "Duplicate request does not create another actor");
  const state = changed.flags["khuzoe-automations"].shapechange;
  assert.ok(await fromUuid(state.concentrationUuid), "Concentration survives a synthetic self transformation");
  changed.system.spells.spell1.value = 2;
  changed.items.get("retained").system.uses.spent = 2;
  changed.items.get("retained").system.activities.get("use").uses.spent = 3;
  state.pendingOverflow = {amount: 8};
  assert.equal(mod.resourceReturnUpdates(original, changed, state)["system.attributes.hp.value"], undefined,
    "Damage predicted but not applied must not overflow on a manual revert");
  changed.system.attributes.hp.value = 0;
  f.target.x = 700; f.target.y = 800;
  f.target.flags.untouched.addedLater = true;
  await mod.revertShapechange(id, player.id);
  assert.equal(f.target.actor, original);
  assert.equal(f.target.actorLink, linked);
  assert.deepEqual(f.target.texture, before.texture);
  assert.deepEqual(f.target.delta, before.delta);
  assert.equal(f.target.x, 700); assert.equal(f.target.y, 800);
  assert.equal(f.target.flags.untouched.addedLater, true);
  assert.equal(original.system.spells.spell1.value, 2);
  assert.equal(original.items.get("retained").system.uses.spent, 2);
  assert.equal(original.items.get("retained").system.activities.get("use").uses.spent, 3);
  assert.equal(original.system.attributes.hp.value, (linked ? 20 : 17) - 6);
  assert.equal(original.system.attributes.hp.temp, 0);
  assert.equal(original.effects.has("concentration"), false);
  assert.equal(game.actors.has(changed.id), false);
  assert.equal(await mod.revertShapechange(id, player.id), null);
  assert.deepEqual(f.other.toObject(), otherBefore);
  assert.deepEqual(f.form.toObject(), sourceBefore);
}
f = await fixture(); f.target.failSwap = true;
const count = game.actors.size;
await assert.rejects(mod.transformShapechange(f.data, player.id), /swap failure/);
assert.equal(game.actors.size, count, "Failed swap cleans only its new temporary actor");
assert.equal(f.target.actor.id, "victim");

f = await fixture(false);
const originalWithEffect = f.target.actor;
await originalWithEffect.createEmbeddedDocuments("ActiveEffect", [{_id: "retainedEffect", name: "Effect", flags: {}}]);
const withEffectUuid = await mod.transformShapechange(f.data, player.id);
await (await fromUuid(withEffectUuid)).effects.get("retainedEffect").delete();
await mod.revertShapechange(withEffectUuid, player.id);
assert.equal(originalWithEffect.effects.has("retainedEffect"), false, "Ended original effect does not reappear from the snapshot");

// Foundry can replace a synthetic Actor instance while updating its ActorDelta.
// References captured before an awaited mutation then retain stale effect maps.
f = await fixture(false, true);
const staleOriginal = f.target.actor;
const staleFormUuid = await mod.transformShapechange(f.data, player.id);
await (await fromUuid(staleFormUuid)).effects.get("concentration").delete();
let concentrationDeletes = 0;
staleOriginal.effects.get("concentration").delete = async () => {
  if (++concentrationDeletes > 1) throw new Error('ActiveEffect "concentration" does not exist!');
  const fresh = new Actor({...staleOriginal.toObject(), effects: []});
  fresh.uuid = staleOriginal.uuid; fresh.isToken = true;
  f.target.actor = fresh;
  uuidRegistry.set(fresh.uuid, fresh);
  uuidRegistry.delete(`${fresh.uuid}.ActiveEffect.concentration`);
  // Deliberately leave staleOriginal.effects unchanged, as on a replaced instance.
};
staleOriginal.update = updates => Actor.prototype.update.call(f.target.actor, updates);
await mod.revertShapechange(staleFormUuid, player.id);
assert.equal(concentrationDeletes, 1, "A replaced synthetic Actor never deletes an already-removed concentration twice");
assert.equal(f.target.actor.effects.has("concentration"), false);

f = await fixture();
const recoveryOriginal = f.target.actor;
const recoveryUuid = await mod.transformShapechange(f.data, player.id);
(await fromUuid(recoveryUuid)).system.spells.spell1.value = 2;
const originalUpdate = recoveryOriginal.update.bind(recoveryOriginal);
let failResponse = true;
recoveryOriginal.update = async data => {
  const result = await originalUpdate(data);
  if (failResponse) { failResponse = false; throw new Error("lost response"); }
  return result;
};
await assert.rejects(mod.revertShapechange(recoveryUuid, player.id), /lost response/);
assert.equal(recoveryOriginal.system.spells.spell1.value, 2);
await mod.revertShapechange(recoveryUuid, player.id);
assert.equal(recoveryOriginal.system.spells.spell1.value, 2, "Retry after restoration does not spend resources twice");

f = await fixture();
const canceledWorkflow = {actor: f.caster, item: f.spell, token: f.target, targets: new Set(),
  setTargets(targets) { this.targets = targets; }};
const beforeCancel = game.actors.size;
assert.equal(await mod.prepareShapechange({workflow: canceledWorkflow}), true, "Closing the picker aborts the cast");
await mod.finishShapechange({workflow: canceledWorkflow});
assert.equal(game.actors.size, beforeCancel);
assert.equal(canceledWorkflow.targets.size, 1, "Self fallback satisfies Midi's mandatory-target check");

f = await fixture(false, true);
const concurrent = await Promise.all([mod.transformShapechange(f.data, player.id), mod.transformShapechange(f.data, player.id)]);
assert.equal(concurrent[0], concurrent[1], "Concurrent retries create exactly one form");
await mod.revertShapechange(concurrent[0], player.id);

const socketHandlers = new Map();
globalThis.socketlib = {registerModule: () => ({register: (name, callback) => socketHandlers.set(name, callback)})};
Hooks.callAll("socketlib.ready");
f = await fixture(); f.form.ownership.player = 0;
await assert.rejects(socketHandlers.get("shapechange.transform").call({socketdata: {userId: player.id}},
  {...f.data, userId: gm.id}), /visibile/, "Spoofed payload userId cannot use GM visibility");

f = await fixture();
let id = await mod.transformShapechange(f.data, player.id);
const form = await fromUuid(id);
const concentrationGuard = handlers.get("midi-qol.preItemRoll").at(-1);
assert.equal(concentrationGuard({actor: form, activity: {duration: {concentration: true}}}), false);
assert.equal(concentrationGuard({actor: form, activity: {duration: {concentration: false}}}), undefined);
assert.equal(concentrationGuard({actor: f.caster, activity: {duration: {concentration: true}}}), undefined);
const stranger = {id: "stranger", active: true}; game.users.set(stranger.id, stranger);
await assert.rejects(mod.revertShapechange(id, stranger.id), /Non puoi/);
// Runtime hooks execute only on one GM and use the persisted concentration link.
game.users.activeGM = gm;
await f.caster.effects.get("concentration").delete();
Hooks.callAll("deleteActiveEffect", {uuid: form.flags["khuzoe-automations"].shapechange.concentrationUuid});
for (let i = 0; i < 20 && game.actors.has(form.id); i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(game.actors.has(form.id), false, "Concentration deletion restores the form");
game.users.activeGM = null;
f = await fixture(); id = await mod.transformShapechange(f.data, player.id);
game.time.worldTime += 3601; game.users.activeGM = gm;
Hooks.callAll("updateWorldTime");
for (let i = 0; i < 20 && await fromUuid(id); i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(await fromUuid(id), null, "World time expiry restores the form");

const Handlebars = createRequire(new URL("package.json", app))("handlebars");
const render = Handlebars.compile(await readFile(new URL("../templates/shapechange-picker.hbs", import.meta.url), "utf8"));
const html = render({target: "<script>bad</script>", forms: [{name: '<img src=x onerror="bad">', uuid: "Actor.test", img: "safe.webp"}]});
assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;img"));
console.log("Shapechange: native dnd5e transformation, permissions, target/self, linked/unlinked isolation, return, resources, overflow, concentration, expiry, rollback and escaped picker passed.");
