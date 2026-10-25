import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {installCircularAuras, circularSpellAuraVisuals, refreshCircularAuras} from "../scripts/circular-auras.mjs";
import {registerSpells2014} from "../scripts/spells-2014.mjs";
import {registerExpandedSpells2014, expandedEffectDamageBonuses, expandedSceneTurnStart} from "../scripts/expanded-spells-2014.mjs";
import {registerHomebrewNpcs, NPC_IDS, NPC_AURA_IDS} from "../scripts/homebrew-npcs.mjs";
import * as geometry from "../../khuzoe-auras/scripts/distance.js";
import {isTargetEligible, isSourceOperational, isAuraCreature as aurasCreature} from "../../khuzoe-auras/scripts/targeting.js";
import {isAuraCreature} from "../scripts/aura-targeting.mjs";

// Both optional modules must agree for documents and rendered placeables.
for (const predicate of [isAuraCreature, aurasCreature]) {
  for (const token of [
    {actor: {}, flags: {"khuzoe-merchant": {container: {}}}},
    {actor: {}, flags: {"khuzoe-merchant": {groundLoot: {}}}},
    {actor: {flags: {"khuzoe-merchant": {groundLootProxy: true}}}}
  ]) {
    token.getFlag = () => assert.fail("Persisted flags must work even with Merchant inactive");
    assert.equal(predicate(token), false);
    assert.equal(predicate({document: token}), false);
  }
  const npc = {actor: {type: "npc", flags: {"khuzoe-merchant": {enabled: true}}, system: {details: {type: {value: "construct"}}}}};
  assert.equal(predicate(npc), true);
  assert.equal(predicate({document: npc}), true);
  assert.equal(predicate({}), false);
  assert.equal(predicate(null), false);
}

// Exercise CAT's actual installed trigger selection and event classes from its
// source map, rather than imitating the range/stacking contracts in the test.
const sourceMap = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8"));
function original(file, deps) {
  const index = sourceMap.sources.findIndex(path => path.endsWith(`/scripts/lib/${file}.mjs`));
  assert.ok(index >= 0);
  const code = sourceMap.sourcesContent[index].replace(/^import .*;\r?\n/gm, "").replace("export default", "return");
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}
String.prototype.slugify ??= function() { return String(this).toLowerCase().replace(/\W+/g, "-"); };
String.prototype.capitalize ??= function() { return this[0].toUpperCase() + this.slice(1); };
const registrations = new Map();
const api = {
  registerAutomation: () => true,
  registerFnMacro(data) { registrations.set(`${data.source}|${data.rules}|${data.identifier}`, data); return data; }
};
registerSpells2014(api);
registerExpandedSpells2014(api);
registerHomebrewNpcs(api);
const constants = {macros: {getFnMacros(source, rules, identifier, type, pass) {
  const entry = registrations.get(`${source}|${rules}|${identifier}`);
  const macros = entry?.[type]?.filter(macro => macro.pass === pass);
  return macros?.length ? {source, rules, identifier, macros} : undefined;
}}};
let docs = new Map(), created = 0, deleted = 0, updated = 0;
const put = (object, path, value) => {
  const keys = path.split("."), last = keys.pop();
  keys.reduce((entry, key) => entry[key] ??= {}, object)[last] = structuredClone(value);
};
const documentUtils = {
  getIdentifier: document => document.flags?.cat?.identifier ?? document.system?.identifier ?? document.name.slugify(),
  getSavedCastData: () => ({castLevel: 1, saveDC: 10}),
  async deleteEmbeddedDocuments(actor, _type, ids) {
    assert.ok(ids.every(id => actor.effects.some(effect => effect.id === id)), "No repeated deletion of the same effect");
    for (const effect of actor.effects.filter(effect => ids.includes(effect.id))) docs.delete(effect.uuid);
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    deleted += ids.length;
  }
};
const actorUtils = {getEffects: actor => actor.effects, getGroups: () => [], getEncounters: () => [], getVehicles: () => []};
const tokenUtils = {
  isEnemy: (a, b) => a.disposition !== b.disposition,
  getDistance: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5
};
const automationUtils = {getConfigValue: (document, key) => document.flags.cat.config?.[key]};
const genericUtils = {setProperty: put};
const effectUtils = {createEffects: (actor, data) => actor.createEmbeddedDocuments("ActiveEffect", data)};
const Logging = {addEntry() {}, addMacroError(_trigger, error) { throw error; }};
const Triggers = original("trigger", {automationUtils, documentUtils, tokenUtils, constants,
  EmbeddedMacros: class { getMacros() { return []; } }});
const Events = original("event", {actorUtils, documentUtils, effectUtils, genericUtils, tokenUtils,
  utils: {}, Triggers, Logging, constants, DamageBonus: class {}, D20Bonus: class {}});
globalThis.cat = {lib: {Triggers, Events, constants, Logging}, utils: {actorUtils, documentUtils, tokenUtils, automationUtils, effectUtils}};
globalThis.game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, settings: {get: () => false}};
globalThis.fromUuid = async uuid => docs.get(uuid);
globalThis.fromUuidSync = uuid => docs.get(uuid);
globalThis.foundry = {utils: {setProperty: put}};
assert.equal(installCircularAuras(), true);
const installedRun = Events.AuraEvent.prototype.run;
assert.equal(installCircularAuras(), true);
assert.equal(Events.AuraEvent.prototype.run, installedRun, "Installing twice must not wrap twice");

function actor(id) {
  return {id, uuid: `Actor.${id}`, items: [], effects: [], statuses: new Set(), system: {attributes: {hp: {value: 20}}},
    async createEmbeddedDocuments(_type, data) {
      await new Promise(resolve => setTimeout(resolve, 1));
      return data.map(entry => {
        const effect = {...structuredClone(entry), id: `created${++created}`, active: true, parent: this,
          async update(changes) { updated++; for (const [key, value] of Object.entries(changes)) put(this, key, value); }};
        effect.uuid = `${this.uuid}.ActiveEffect.${effect.id}`;
        this.effects.push(effect); docs.set(effect.uuid, effect); return effect;
      });
    }};
}
const ref = identifier => ({source: "khuzoe-automations", rules: "2014", identifier});
function sourceDocument(owner, kind) {
  const expanded = ["aura-of-purity", "crusaders-mantle", "pass-without-trace"].includes(kind);
  const identifier = expanded ? "khuzoe-expanded-spell-effect" : kind;
  const item = kind === NPC_IDS.spiritProtector;
  const result = {id: kind, uuid: `${owner.uuid}.${item ? "Item" : "ActiveEffect"}.${kind}`,
    name: kind, img: "aura.webp", documentName: item ? "Item" : "ActiveEffect", actor: owner, parent: owner,
    active: true, effects: [], system: {identifier: kind}, duration: {remaining: 600},
    flags: {cat: {identifier, macros: {aura: [ref(identifier)]}},
      ...(expanded ? {"khuzoe-automations": {expandedSpell: {kind: "aura", aura: kind, identifier: kind}}} : {})}};
  (item ? owner.items : owner.effects).push(result); docs.set(result.uuid, result); return result;
}
function setup(kind, metric = false) {
  docs = new Map();
  const scene = {id: "scene", grid: {size: 100, distance: metric ? 1.524 : 5, units: metric ? "m" : "ft"}, levels: new Map()};
  const sourceActor = actor("source"), receiver = actor("target");
  const makeToken = (id, actor, x, y) => ({id, uuid: `Scene.scene.Token.${id}`, actor, parent: scene, x, y, width: 1, height: 1, disposition: 1, elevation: 0, regions: []});
  const source = makeToken("source", sourceActor, 0, 0), target = makeToken("target", receiver, 600, 400);
  scene.tokens = [source, target];
  game.scenes = [scene]; game.user = {id: "gm", isGM: true};
  const aura = {area: {distance: 15 * (metric ? 0.3048 : 1), elevation: true}, targets: {relation: "ally", includeSource: true}, source: {requiresConscious: true}, enabled: true};
  game.khuzoeAuras = {geometry, isTargetEligible: (s, t, id) => id === NPC_AURA_IDS.spirit
    && isSourceOperational(s, aura) && isTargetEligible(scene, s, t, aura)};
  const document = sourceDocument(sourceActor, kind);
  const run = () => new Events.AuraEvent(target, "update").run();
  return {scene, source, target, receiver, document, aura, run};
}

const families = ["khuzoe-aura-life-source", "khuzoe-circle-power-source", "aura-of-purity", "crusaders-mantle", "pass-without-trace", NPC_IDS.spiritProtector];
for (const kind of families) for (const metric of [false, true]) {
  const {source, target, receiver, document, run, scene, aura} = setup(kind, metric);
  const spirit = kind === NPC_IDS.spiritProtector;
  if (spirit) { target.x = 300; target.y = 200; }
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: diagonally outside the circle`);
  target.x = spirit ? 200 : 500; target.y = 300;
  if (spirit) target.y = 200;
  await run();
  assert.equal(receiver.effects.length, 1, `${kind}: enters the circle`);
  const effectId = receiver.effects[0].id, count = created;
  await Promise.all([run(), run(), run()]);
  assert.equal(receiver.effects.length, 1);
  assert.equal(receiver.effects[0].id, effectId);
  assert.equal(created, count, `${kind}: stationary updates do not recreate effects`);
  target.x = spirit ? 300 : 600; target.y = spirit ? 200 : 400;
  await Promise.all([run(), run()]);
  assert.equal(receiver.effects.length, 0, `${kind}: leaves the circle`);
  target.x = 100; target.y = 0;
  await run();
  assert.equal(receiver.effects.length, 1, `${kind}: re-enters`);
  source.x = -1000;
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: source moves away`);
  source.x = 0;
  await run();
  target.disposition = -1;
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: hostile target excluded`);
  target.disposition = 1;
  await run();
  if (!spirit) {
    document.active = false;
    await run();
    assert.equal(receiver.effects.length, 0, `${kind}: source effect ended`);
    document.active = true;
  } else {
    aura.enabled = false;
    await run();
    assert.equal(receiver.effects.length, 0, "Disabled spirit aura removes the protector");
    aura.enabled = true;
  }
  await run();
  game.user = {id: "player", isGM: false};
  target.x = 2000;
  await run();
  assert.equal(receiver.effects.length, 1, "Player movement cannot race the GM's aura writes");
  game.user = {id: "gm", isGM: true};
  await refreshCircularAuras(scene);
  assert.equal(receiver.effects.length, 0, "GM reconciliation removes the out-of-area effect");
  target.x = 100;
  await run();
  const visuals = circularSpellAuraVisuals(source);
  assert.equal(visuals.length, spirit ? 0 : 1);
  if (!spirit) assert.equal(visuals[0].area.distance, 30 * (metric ? 0.3048 : 1));
  source.actor.items = []; source.actor.effects = []; docs.delete(document.uuid);
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: deleted source leaves no orphan buff`);
}

// Merchant map objects may carry an NPC Actor, but must neither receive nor
// project creature auras. Exercise actual CAT selection and stale-buff cleanup.
for (const kind of families) for (const marker of ["container", "groundLoot", "groundLootProxy"]) {
  const {source, target, receiver, run} = setup(kind);
  target.x = 100; target.y = 0;
  await run();
  assert.equal(receiver.effects.length, 1);
  const flagged = marker === "groundLootProxy" ? receiver : target;
  flagged.flags = {"khuzoe-merchant": {[marker]: marker === "groundLootProxy" ? true : {name: "Oggetto"}}};
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: ${marker} loses a pre-existing aura`);
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: ${marker} receives no new aura`);
  delete flagged.flags;
  receiver.flags = {"khuzoe-merchant": {enabled: true}};
  await run();
  assert.equal(receiver.effects.length, 1, `${kind}: a real NPC merchant remains eligible`);
  source.flags = {"khuzoe-merchant": {container: {}}};
  await run();
  assert.equal(receiver.effects.length, 0, `${kind}: an object cannot project an aura`);
  assert.equal(circularSpellAuraVisuals(source).length, 0);
}

// Different expanded auras share a handler ID. All must survive repeated updates.
{
  const {source, target, receiver, run} = setup("aura-of-purity");
  target.x = 100; target.y = 0;
  sourceDocument(source.actor, "crusaders-mantle");
  sourceDocument(source.actor, "pass-without-trace");
  await run();
  assert.equal(receiver.effects.length, 3);
  const ids = receiver.effects.map(effect => effect.id), counts = [created, deleted, updated];
  await Promise.all([run(), run(), run()]);
  assert.deepEqual(receiver.effects.map(effect => effect.id), ids);
  assert.deepEqual([created, deleted, updated], counts, "Overlapping different auras remain stable");
}

// The protector follows the stored aura's custom range rather than its 15 ft CAT default.
{
  const {source, target, receiver, run, aura} = setup(NPC_IDS.spiritProtector);
  aura.area.distance = 40;
  target.x = 700; target.y = 0;
  await run();
  assert.equal(receiver.effects.length, 1);
  aura.area.distance = 10;
  await run();
  assert.equal(receiver.effects.length, 0);
  source.actor.system.attributes.hp.value = 0;
  target.x = 100;
  await run();
  assert.equal(receiver.effects.length, 0);
}

// Another module keeps its grid range, even on a scene also containing Khuzoe auras.
{
  const {source, target, receiver, run} = setup("aura-of-purity");
  registrations.set("foreign|2014|foreign", {aura: [{pass: "update", distance: 30,
    macro: () => ({effectData: {name: "Foreign", flags: {}, system: {changes: []}}})}]});
  const foreign = sourceDocument(source.actor, "foreign");
  foreign.flags.cat.macros.aura = [{source: "foreign", rules: "2014", identifier: "foreign"}];
  await run();
  assert.deepEqual(receiver.effects.map(effect => effect.name), ["Foreign"]);
}

// Spirit Shroud uses the same 10 ft circle for both the attack rider and turn trigger.
{
  const {source, target, document} = setup("spirit-shroud");
  document.flags["khuzoe-automations"] = {expandedSpell: {identifier: "spirit-shroud", kind: "self-buff"}};
  document.flags.cat.macros = {};
  const item = {uuid: `${source.actor.uuid}.Item.shroud`, documentName: "Item", name: "Spirit Shroud", actor: source.actor, system: {}};
  document.origin = item.uuid; docs.set(item.uuid, item);
  let bonuses = 0, prompts = 0;
  cat.utils.actorUtils.getFirstToken = actor => game.scenes[0].tokens.find(token => token.actor === actor);
  cat.utils.workflowUtils = {isAttackType: () => true, bonusDamage: async () => { bonuses++; }};
  cat.utils.dialogUtils = {confirm: async () => { prompts++; return true; }};
  cat.utils.queryUtils = {firstOwner: () => "gm"};
  cat.utils.documentUtils.makeDependent = async () => {};
  const workflow = {token: source, actor: source.actor, hitTargets: new Set([target])};
  target.x = 200; target.y = 200;
  await expandedEffectDamageBonuses({document, workflow});
  await expandedSceneTurnStart({document, token: target});
  assert.equal(bonuses, 0);
  assert.equal(prompts, 0);
  target.x = 150; target.y = 150;
  await expandedEffectDamageBonuses({document, workflow});
  await expandedSceneTurnStart({document, token: target});
  assert.equal(bonuses, 1);
  assert.equal(prompts, 1);
  assert.ok(target.actor.effects.some(effect => effect.flags?.["khuzoe-automations"]?.expandedSpell?.identifier === "spirit-shroud-slow"));
  assert.equal(circularSpellAuraVisuals(source)[0].area.distance, 10);
  target.flags = {"khuzoe-merchant": {container: {}}};
  await expandedEffectDamageBonuses({document, workflow});
  await expandedSceneTurnStart({document, token: target});
  assert.equal(bonuses, 1, "Spirit Shroud grants no damage rider against a container");
  assert.equal(prompts, 1, "Spirit Shroud must not offer to slow a container");
}

console.log("Aure circolari: 6 famiglie in piedi/metri, CAT installato, entrata/uscita, concorrenza, sovrapposizioni, GM, visuali, Protettore configurabile e Spirit Shroud OK");
