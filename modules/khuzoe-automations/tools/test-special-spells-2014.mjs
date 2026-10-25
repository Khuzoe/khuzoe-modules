import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {SPECIAL_SPELL_CATALOG, SPECIAL_EFFECT} from "../scripts/special-spell-catalog.mjs";
import {
  registerSpecialSpells2014, prepareSpecialUse, prepareSpecialSpell, finishSpecialSpell,
  redirectMirrorAttack, castDragonBreath, pulseHeatMetal, holyWeaponDamage,
  restoreSpecialLight, detonateHolyWeapon, damageDealt, healVampiricTouch,
  chaosDice, changeChaosDamage, bounceChaosBolt
} from "../scripts/special-spells-2014.mjs";

const MODULE = "khuzoe-automations";
const root = new URL("../packData/khuzoe-spells-2014/", import.meta.url);
const source = new Map();
for (const file of (await readdir(root)).filter(file => file.endsWith(".json"))) {
  const item = JSON.parse(await readFile(new URL(file, root), "utf8"));
  source.set(item.system.identifier, item);
}
const registered = [];
const registeredAutomations = [];
registerSpecialSpells2014({registerFnMacro(data) { registered.push(data); }, registerAutomation(data) { registeredAutomations.push(data); }});
assert.equal(registered.length, 7);
assert.equal(registeredAutomations.length, 6);
for (const {identifier} of SPECIAL_SPELL_CATALOG) {
  const item = source.get(identifier);
  assert.ok(item);
  assert.ok(registered.find(macro => macro.identifier === identifier).roll.every(entry => entry.pass.startsWith("item")));
  for (const activity of Object.values(item.system.activities)) {
    assert.match(activity._id, /^[a-z0-9]{16}$/i);
    assert.equal(activity.midiProperties.identifier.length > 0, true);
    if (activity.flags.cat.hidden) {
      assert.equal(activity.consumption.spellSlot, false);
      assert.equal(activity.duration.concentration, false);
    }
    if (["heatMetalPulse", "holyWeaponDismiss", "vampiricTouchAttack"].includes(activity.midiProperties.identifier)) {
      assert.equal(activity.midiProperties.automationOnly, false, "Unhidden follow-ups must be usable by an owner");
      assert.equal(item.flags.dnd5e.riders.activity.includes(activity._id), false, "Core riders remain unusable even when CAT unhides them");
    }
  }
}
assert.equal(registered.find(macro => macro.identifier === SPECIAL_EFFECT).aura, undefined);

let serial = 0;
const db = new Map();
const dependencies = new Map();
const rollTotals = [];
const selections = [];
const tokenSelections = [];
const calls = {rolls: [], damages: [], bonuses: [], dialogs: [], warnings: [], queries: [], visibility: []};
let syntheticHandler = async () => null;
let visible = true;
let specialSenses = false;
function assignPath(object, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  for (const part of parts) object = object[part] ??= {};
  object[last] = structuredClone(value);
}
function document(data, parent, type) {
  const result = structuredClone(data);
  result.id = result._id ?? `test${++serial}`;
  result.uuid = `${parent ? `${parent.uuid}.` : ""}${type}.${result.id}`;
  result.documentName = type;
  result.parent = parent;
  result.isOwner = parent?.isOwner ?? true;
  result.update = async updates => { for (const [key, value] of Object.entries(updates)) assignPath(result, key, value); return result; };
  result.delete = async () => {
    if (!db.has(result.uuid)) throw new Error(`${type} does not exist`);
    for (const uuid of dependencies.get(result.uuid) ?? []) if (db.has(uuid)) await db.get(uuid).delete();
    dependencies.delete(result.uuid);
    if (type === "ActiveEffect") await restoreSpecialLight({document: result});
    db.delete(result.uuid);
    parent?.effects?.delete(result.id);
    parent?.items?.delete(result.id);
  };
  if (type === "Item") {
    result.actor = parent;
    result.system.activities = new Map(Object.entries(result.system.activities ?? {}).map(([id, data]) => {
      const activity = structuredClone(data);
      Object.assign(activity, {id, uuid: `${result.uuid}.Activity.${id}`, item: result, actor: parent,
        identifier: data.midiProperties.identifier, toObject: () => structuredClone(data)});
      db.set(activity.uuid, activity);
      return [id, activity];
    }));
    result.toObject = () => ({...structuredClone(data), _id: result.id});
  }
  result.createEmbeddedDocuments = async (embeddedType, datas) => datas.map(data => {
    const child = document(data, result, embeddedType);
    (embeddedType === "Item" ? result.items : result.effects).set(child.id, child);
    return child;
  });
  if (type === "Actor") { result.items = new Map(); result.effects = new Map(); result.isOwner = data.isOwner ?? true; }
  if (type === "Item") result.effects = new Map();
  db.set(result.uuid, result);
  return result;
}
function makeActor(name, isOwner = true) {
  return document({name, isOwner, system: {abilities: {dex: {mod: 2}}, attributes: {senses: {ranges: {}}, hp: {value: 20, max: 30}}}}, null, "Actor");
}
const scene = {id: "scene-test", uuid: "Scene.scene-test", tokens: new Map()};
function makeToken(actor, x = 0) {
  const token = document({name: actor.name, x, y: 0, light: {bright: 0, dim: 0}}, scene, "Token");
  token.actor = actor;
  token.object = {document: token, actor};
  scene.tokens.set(token.id, token);
  return token;
}
const caster = makeActor("Caster");
const enemy = makeActor("Enemy", false);
const ally = makeActor("Ally", false);
const casterT = makeToken(caster);
const enemyT = makeToken(enemy, 10);
const allyT = makeToken(ally, 20);
const distantT = makeToken(makeActor("Distant"), 100);
globalThis.canvas = {scene};
globalThis.game = {user: {id: "player", isGM: false, targets: new Set()}, users: [], modules: new Map(), time: {worldTime: 100}};
globalThis.fromUuid = async uuid => db.get(uuid) ?? null;
globalThis.ui = {notifications: {warn(message) {calls.warnings.push(message);}, info() {}}};
globalThis.CONFIG = {DND5E: {damageTypes: Object.fromEntries(["acid", "cold", "fire", "force", "lightning", "poison", "psychic", "thunder"].map(t => [t, {label: t}]))}};
globalThis.ChatMessage = {implementation: {getSpeaker: () => ({})}};
globalThis.Roll = class {
  async evaluate() { this.total = rollTotals.shift(); assert.ok(Number.isFinite(this.total)); return this; }
  async toMessage() {}
};
globalThis.MidiQOL = {
  canSee: () => visible, canSense: () => specialSenses,
  async applyTokenDamage(...args) { calls.damages.push(args); }
};
globalThis.cat = {utils: {
  queryUtils: {
    hasPermission(doc) { return doc.isOwner; },
    firstOwner(actor) { return actor === caster ? "player" : "other-owner"; },
    gmUser() { return {id: "gm", query() {}}; },
    async query(type, user, payload) { calls.queries.push({type, user, payload}); await db.get(payload.uuid).update(payload.updates); return payload.uuid; }
  },
  actorUtils: {getFirstToken(actor) { return [...scene.tokens.values()].find(t => t.actor === actor); }, getEquivalentSpellSlotName: (actor, level) => `spell${level}`},
  itemUtils: {
    getSaveDC: () => 17,
    syntheticItem(data, actor) {
      assert.deepEqual(data.flags.dnd5e.riders.activity, [], "Runtime activities must not be core riders");
      assert.equal(data.flags.dnd5e.scaling, 0);
      const item = {actor, flags: data.flags, system: {...data.system}, uuid: `${actor.uuid}.Item.${data._id}`};
      item.system.activities = new Map(Object.entries(data.system.activities).map(([id, data]) => [id, {...data, id, item, toObject: () => structuredClone(data)}]));
      return item;
    },
    async enchantItem(item, data) { return item.createEmbeddedDocuments("ActiveEffect", [data]); }
  },
  effectUtils: {
    getConcentrationEffect(actor, item) { return [...actor.effects.values()].find(effect => effect.concentrationItem === item.uuid); },
    async createEffects(actor, datas, options) {
      calls.visibility.push(options?.unhideActivities);
      return actor.createEmbeddedDocuments("ActiveEffect", datas);
    }
  },
  documentUtils: {
    async makeDependent(parent, children) { const list = dependencies.get(parent.uuid) ?? []; dependencies.set(parent.uuid, [...list, ...children.map(c => c.uuid)]); },
    async deleteDocument(doc) { await doc.delete(); },
    async createEmbeddedDocuments(parent, type, datas) { return parent.createEmbeddedDocuments(type, datas); }
  },
  tokenUtils: {getDistance: (a, b) => Math.abs(a.x - b.x)},
  dialogUtils: {
    async buttonDialog(title, prompt, options, config) { calls.dialogs.push({title, prompt, options, config}); assert.ok(selections.length, `Unexpected dialog ${prompt}`); return selections.shift(); },
    async selectTargetDialog(title, prompt, targets, config) { calls.dialogs.push({title, prompt, targets, config}); assert.ok(tokenSelections.length, `Unexpected target dialog ${title}`); const result = tokenSelections.shift(); return result === null ? null : {result}; },
    async selectDocumentDialog(title, prompt, weapons) { return weapons[0]; }
  },
  workflowUtils: {
    async syntheticActivityRoll(activity, targets, options) {
      const data = activity.toObject();
      const item = activity.item;
      calls.rolls.push({data, item, targets, options});
      assert.equal(data.flags.cat.hidden, false);
      assert.equal(data.midiProperties.automationOnly, false);
      assert.equal(data.consumption.spellSlot, false);
      assert.equal(data.duration.concentration, false);
      assert.equal(options.config.consume.action, false);
      return syntheticHandler(data, item, targets, options);
    },
    async bonusDamage(workflow, formula, options) { calls.bonuses.push({workflow, formula, options}); }
  }
}};
async function makeSpell(identifier) {
  return (await caster.createEmbeddedDocuments("Item", [source.get(identifier)]))[0];
}
async function concentrate(item) {
  const effect = (await caster.createEmbeddedDocuments("ActiveEffect", [{name: "Concentration", system: {changes: []}}]))[0];
  effect.concentrationItem = item.uuid;
  return effect;
}
function activity(item, key) { return [...item.system.activities.values()].find(a => a.identifier === key); }
function workflow(item, key, targets = [enemyT], castLevel = item.system.level) {
  return {
    item, actor: item.actor, activity: activity(item, key), token: casterT.object,
    targets: new Set(targets.map(t => t.object)), hitTargets: new Set(targets.map(t => t.object)), hitTargetsEC: new Set(),
    failedSaves: new Set(), castData: {castLevel}, workflowOptions: {}, damageList: [],
    async setDamageRolls(rolls) { this.damageRolls = rolls; }
  };
}
function effectFor(actor, kind) { return [...actor.effects.values()].find(effect => effect.flags?.[MODULE]?.specialSpell?.kind === kind); }
function damageResult(target, value, type, hp = value) { return {damageList: [{targetUuid: target.uuid, damageDetail: [{value, type}], hpDamage: hp, tempDamage: 0}]}; }

// Mirror Image: attack-only; diversion can hit a lower-AC duplicate even if the caster was missed.
const mirror = await makeSpell("mirror-image");
await finishSpecialSpell({workflow: workflow(mirror, "mirrorImage", [casterT])});
let mirrorEffect = effectFor(caster, "mirror-image");
assert.equal(mirrorEffect.flags[MODULE].specialSpell.duplicates, 3);
const attackItem = await makeSpell("chaos-bolt");
function attackMirror() { return {...workflow(attackItem, "chaosBolt", [casterT, allyT]), actor: enemy, token: enemyT.object, attackRoll: {total: 15}, attackTotal: 15}; }
const attack = attackMirror();
rollTotals.push(6);
await redirectMirrorAttack({document: mirrorEffect, workflow: attack});
assert.equal(attack.hitTargets.has(casterT.object), false);
assert.equal(attack.hitTargets.has(allyT.object), true, "Never change another target's hit state");
assert.equal(mirrorEffect.flags[MODULE].specialSpell.duplicates, 2);
await redirectMirrorAttack({document: mirrorEffect, workflow: attack});
assert.equal(mirrorEffect.flags[MODULE].specialSpell.duplicates, 2, "Duplicate hook must not spend a second image");
specialSenses = true;
await redirectMirrorAttack({document: mirrorEffect, workflow: attackMirror()});
specialSenses = false;
visible = false;
await redirectMirrorAttack({document: mirrorEffect, workflow: attackMirror()});
visible = true;
const saveOnly = attackMirror(); saveOnly.activity = {type: "save"};
await redirectMirrorAttack({document: mirrorEffect, workflow: saveOnly});
assert.equal(mirrorEffect.flags[MODULE].specialSpell.duplicates, 2);
rollTotals.push(8, 11);
await Promise.all([redirectMirrorAttack({document: mirrorEffect, workflow: attackMirror()}), redirectMirrorAttack({document: mirrorEffect, workflow: attackMirror()})]);
assert.equal(db.has(mirrorEffect.uuid), false, "Simultaneous attacks spend the last two images without missing-document errors");

// Dragon's Breath: current source icon, fixed caster DC, recipient-owned action, dependent cleanup.
const breath = await makeSpell("dragons-breath");
breath.img = "custom-breath.webp";
const breathConcentration = await concentrate(breath);
const breathCast = workflow(breath, "dragonsBreath", [allyT], 4);
selections.push("cold");
assert.equal(await prepareSpecialSpell({workflow: breathCast}), undefined);
await castDragonBreath(breathCast);
const breathEffect = effectFor(ally, "dragons-breath");
const breathItem = [...ally.items.values()].find(i => i.system.identifier === "dragons-breath-exhale");
const breathAction = activity(breathItem, "dragonBreath");
assert.equal(breathItem.img, "custom-breath.webp");
assert.equal(breathAction.damage.parts[0].number, 5);
assert.equal(breathAction.damage.parts[0].types[0], "cold");
assert.equal(breathAction.save.dc.formula, "17");
assert.equal(breathAction.activation.type, "action");
assert.equal(breathAction.target.template.size, "15");
assert.equal(await prepareSpecialUse({item: breathItem, activity: breathAction}), undefined);
await breathConcentration.delete();
assert.equal(db.has(breathEffect.uuid), false);
assert.equal(db.has(breathItem.uuid), false);
assert.equal(await prepareSpecialUse({item: breathItem, activity: breathAction}), true);

// Heat Metal: cast level survives, armor retains disadvantage on a successful save, dropped targets stop pulsing.
const heat = await makeSpell("heat-metal");
await concentrate(heat);
const heatCast = workflow(heat, "heatMetal", [enemyT], 4);
syntheticHandler = async (data, item, targets) => data.type === "damage"
  ? damageResult(targets[0], 12, "fire") : {failedSaves: new Set()};
selections.push("unable");
await finishSpecialSpell({workflow: heatCast});
const heatRoot = effectFor(caster, "heat-metal");
const held = effectFor(enemy, "heat-metal-held");
assert.ok(held);
assert.deepEqual(held.flags.dae.specialDuration, ["turnStartSource"]);
assert.ok(held.system.changes.some(change => change.key === "flags.midi-qol.disadvantage.ability.check.all"));
assert.equal(calls.rolls.find(call => call.data.midiProperties.identifier === "heatMetalDamage").data.damage.parts[0].number, 4);
assert.equal(activity(heat, "heatMetalDamage").damage.parts[0].number, 2, "Never edit the saved activity while scaling a pulse");
assert.equal(calls.dialogs.find(call => call.prompt?.includes("Enemy: l'oggetto")).config.userId, "other-owner");
selections.push("drop");
await pulseHeatMetal(workflow(heat, "heatMetalPulse"), heatRoot);
assert.equal(effectFor(enemy, "heat-metal-held"), undefined);
assert.equal(heatRoot.flags[MODULE].specialSpell.contacts[0].contact, false);
const rollCount = calls.rolls.length;
await pulseHeatMetal(workflow(heat, "heatMetalPulse"), heatRoot);
assert.equal(calls.rolls.length, rollCount, "Dropping the metal must prevent future damage to its former holder");
assert.equal(damageDealt(damageResult(enemyT, 0, "fire"), enemyT, "fire"), 0);

// Holy Weapon: one actual weapon, radiant rider once, user-selected burst recipients, cancellation, independent blindness.
const weapon = (await ally.createEmbeddedDocuments("Item", [{name: "Sword", type: "weapon", system: {activities: {}, properties: []}}]))[0];
const holy = await makeSpell("holy-weapon");
const holyConcentration = await concentrate(holy);
const holyCast = workflow(holy, "holyWeapon", [allyT]);
await prepareSpecialSpell({workflow: holyCast});
await finishSpecialSpell({workflow: holyCast});
const holyBuff = effectFor(ally, "holy-weapon-target");
assert.ok(holyBuff);
assert.ok([...weapon.effects.values()].some(e => e.system.changes.some(c => c.key === "system.properties" && c.value === "mgc")));
assert.equal(allyT.light.bright, 30);
assert.equal(allyT.light.dim, 60);
const weaponAttack = {item: weapon, activity: {type: "attack", attack: {type: {classification: "weapon"}}}};
await holyWeaponDamage({document: holyBuff, workflow: weaponAttack});
await holyWeaponDamage({document: holyBuff, workflow: weaponAttack});
await holyWeaponDamage({document: holyBuff, workflow: {item: holy, activity: {type: "attack"}}});
assert.equal(calls.bonuses.length, 1);
assert.equal(calls.bonuses[0].formula, "2d8");
const dismiss = workflow(holy, "holyWeaponDismiss");
tokenSelections.push(null);
await detonateHolyWeapon(dismiss);
assert.ok(db.has(holyConcentration.uuid), "Cancel must not end concentration");
tokenSelections.push([enemyT]);
syntheticHandler = async () => ({failedSaves: new Set([enemyT.object])});
await detonateHolyWeapon(dismiss);
assert.equal(db.has(holyConcentration.uuid), false);
assert.equal(allyT.light.bright, 0);
assert.equal(allyT.light.dim, 0);
assert.equal(weapon.effects.size, 0);
const blind = effectFor(enemy, "holy-weapon-blind");
assert.ok(blind && db.has(blind.uuid));
assert.deepEqual(blind.statuses, ["blinded"]);
assert.match(blind.system.changes[0].value, /saveDC=17/);
assert.match(blind.system.changes[0].value, /turn=end/);
const burstDialog = calls.dialogs.find(call => call.prompt?.startsWith("Scegli le creature da colpire"));
assert.ok(burstDialog.targets.includes(allyT), "Choice is not hardcoded to enemies");
assert.ok(!burstDialog.targets.includes(distantT));

// Vampiric Touch: effective necrotic only, immunity, generic reductions, overkill, one heal per attack.
const vamp = await makeSpell("vampiric-touch");
const vampConcentration = await concentrate(vamp);
const vampCast = workflow(vamp, "vampiricTouch", [enemyT], 5);
vampCast.damageList = damageResult(enemyT, 14, "necrotic").damageList;
await finishSpecialSpell({workflow: vampCast});
assert.equal(calls.damages.at(-1)[1], 7);
assert.equal(calls.damages.at(-1)[0][0].type, "healing");
await healVampiricTouch(vampCast);
assert.equal(calls.damages.length, 1);
const repeatConfig = {consume: {action: true}};
await prepareSpecialUse({item: vamp, activity: activity(vamp, "vampiricTouchAttack"), config: repeatConfig, dialog: {}});
assert.equal(repeatConfig.consume.spellSlot, false);
assert.equal(repeatConfig.consume.action, true, "Follow-up still consumes the actor's action");
assert.equal(repeatConfig.scaling, 2);
assert.equal(repeatConfig.spell.slot, "spell5");
const reduced = damageResult(enemyT, 14, "necrotic");
reduced.damageList[0].damageDetail.push({type: "none", value: -6}, {type: "radiant", value: 8});
assert.equal(damageDealt(reduced, enemyT, "necrotic"), 8);
assert.equal(damageDealt(damageResult(enemyT, 14, "necrotic", 1), enemyT, "necrotic"), 14, "HP at zero is not a cap on damage dealt");
assert.equal(damageDealt(damageResult(enemyT, 0, "necrotic"), enemyT, "necrotic"), 0);
await vampConcentration.delete();
assert.equal(await prepareSpecialUse({item: vamp, activity: activity(vamp, "vampiricTouchAttack"), config: {}, dialog: {}}), true);

// Chaos Bolt: exact two base d8s, type assigned before damage, jump only after original workflow finishes.
const chaos = await makeSpell("chaos-bolt");
const chaosCast = workflow(chaos, "chaosBolt", [enemyT], 3);
chaosCast.damageRolls = [{terms: [{faces: 8, results: [{result: 4, active: true}, {result: 4, active: true}, {result: 8, active: true}, {result: 8, active: true}]}], options: {type: "none"}}, {options: {type: "none"}}];
assert.deepEqual(chaosDice(chaosCast), [4, 4], "Critical extra dice cannot change type or bounce eligibility");
const beforeType = calls.rolls.length;
await changeChaosDamage({workflow: chaosCast});
assert.equal(calls.rolls.length, beforeType, "Do not launch nested damage while original damage is being resolved");
assert.ok(chaosCast.damageRolls.every(roll => roll.options.type === "force"));
tokenSelections.push([allyT]);
syntheticHandler = async (data, item, targets, options) => {
  assert.equal(options.workflowOptions, undefined);
  assert.equal(options.options.workflowOptions.khuzoeSpecial.castLevel, 3);
  assert.deepEqual(options.options.workflowOptions.khuzoeSpecial.chain.visited, [enemyT.uuid]);
  assert.equal(data.damage.parts[0].number, 2);
  assert.equal(data.damage.parts[1].number, 3);
  assert.deepEqual(targets, [allyT]);
  return {};
};
await finishSpecialSpell({workflow: chaosCast});
assert.equal(calls.rolls.length, beforeType + 1);
const bounce = workflow(chaos, "chaosBoltBounce", [allyT]);
bounce.workflowOptions.khuzoeSpecial = {castLevel: 3, chain: {visited: [enemyT.uuid, casterT.uuid]}};
bounce.damageRolls = [{terms: [{faces: 8, results: [{result: 2}, {result: 2}]}], options: {}}];
await changeChaosDamage({workflow: bounce});
await bounceChaosBolt(bounce);
assert.equal(calls.rolls.length, beforeType + 1, "No target in range can be hit twice in the same chain");
const miss = workflow(chaos, "chaosBolt", [enemyT]);
miss.hitTargets.clear();
miss.damageRolls = [{terms: [{faces: 8, results: [{result: 2}, {result: 2}]}], options: {}}];
await changeChaosDamage({workflow: miss});
await bounceChaosBolt(miss);
assert.equal(calls.rolls.length, beforeType + 1, "A miss cannot bounce");
assert.equal(selections.length, 0);
assert.equal(tokenSelections.length, 0);
assert.ok(calls.queries.length > 0, "Non-owner updates must use the GM permission path");
console.log("Khuzoe Automations | Sei spell speciali 2014: registrazione, effetti, owner, concentrazione, scaling e rimbalzi OK.");
