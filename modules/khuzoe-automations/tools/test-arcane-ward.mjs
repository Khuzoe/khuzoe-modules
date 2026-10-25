import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {registerDocuments} from "./fixtures-documents.mjs";
globalThis.Hooks = {on() {}, once() {}};
const ward = await import("../scripts/arcane-ward.mjs");
const MODULE = "khuzoe-automations", PLAN = "khuzoeArcaneWard";
const documents = new Map();
const set = (object, path, value) => {
  const keys = path.split("."), last = keys.pop();
  keys.reduce((target, key) => target[key] ??= {}, object)[last] = value;
};
globalThis.game = {user: {id: "gm", isGM: true}, users: [], time: {worldTime: 50}};
globalThis.foundry = {utils: {deepClone: structuredClone, setProperty: set}};
globalThis.ui = {notifications: {warn() {}, info() {}}};
globalThis.MidiQOL = {configSettings: () => ({singleConcentrationRoll: true, defaultSaveMultiplier: 0.5})};
let accept = true, decisions = 0, effectSerial = 0;
globalThis.cat = {utils: {queryUtils: {}, dialogUtils: {buttonDialog: async () => { decisions++; return accept; }},
  documentUtils: {deleteDocument: async effect => { effect.parent.effects.splice(effect.parent.effects.indexOf(effect), 1); }},
  effectUtils: {createEffects: async (actor, entries) => {
    return entries.map(data => { const effect = {...structuredClone(data), uuid: `${actor.uuid}.ActiveEffect.${++effectSerial}`, parent: actor};
      registerDocuments(effect); actor.effects.push(effect); return effect; });
  }}}};

// Exercise Foundry's installed D&D5e calculation, including native trait ordering.
const map = JSON.parse(await readFile(new URL("../../../systems/dnd5e/dnd5e-compiled.mjs.map", import.meta.url), "utf8"));
const actorSource = map.sourcesContent[map.sources.indexOf("module/documents/actor/actor.mjs")];
const body = actorSource.match(/^  calculateDamage\(damages, options=\{\}\) \{([\s\S]*?)^  \}/m)?.[1];
assert.ok(body, "Installed Actor.calculateDamage is available");
const midiSource = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
const saveBody = midiSource.match(/^function applySaves\(\{ damages, options \}\) \{([\s\S]*?)^\}/m)?.[1];
assert.ok(saveBody);
const applySaves = new Function("isDRType", "shouldIgnore", "setDamageActiveFlag", "configSettings", "foundry",
  `return function({damages, options}) {${saveBody}}`)(() => false,
  (options, key, type) => options.ignore?.[key] === true || options.ignore?.[key]?.has?.(type),
  (damage, key) => { (damage.active ??= {})[key] = true; }, {defaultSaveMultiplier: 0.5}, foundry);
globalThis.CONFIG = {DND5E: {damageTypes: Object.fromEntries(["fire", "cold", "force", "thunder", "lightning", "slashing", "bludgeoning"].map(type => [type, {}])),
  healingTypes: {healing: {}, temphp: {}}}};
Math.clamp ??= (n, min, max) => Math.min(max, Math.max(min, n));
let saveOrder = "SaveDrDR";
const calculationHooks = {call: (name, actor, damages, options) => {
  if (!options.midi?.noCalc && ((name === "dnd5e.preCalculateDamage" && saveOrder !== "DRSaveDr")
    || (name === "dnd5e.calculateDamage" && saveOrder === "DRSaveDr"))) applySaves({damages, options});
  return true;
}};
const nativeCalculate = new Function("Hooks", "CONFIG", "foundry", "simplifyBonus",
  `return function(damages, options={}) {${body.replaceAll("#changeIsIgnored", "_changeIsIgnored").replaceAll("#changeHasEffect", "_changeHasEffect")}}`)(
  calculationHooks, CONFIG, foundry, value => Number(value));
let actorSerial = 0, assertions = 0;
function actorFixture({created = true, spent = 0, temp = 8, resistance = [], immunity = [], vulnerability = [], modification = {}} = {}) {
  const actor = {uuid: `Actor.ward${++actorSerial}`, name: "Abjurer", documentName: "Actor", isOwner: true,
    classes: {wizard: {system: {levels: 4}}}, flags: {[MODULE]: {temporaryHPSource: "Item.agathys"}}, effects: [], items: [],
    system: {abilities: {int: {mod: 4}}, attributes: {hp: {value: 30, max: 30, temp, tempmax: 0, damage: 0}}, traits: {dm: {amount: modification}}},
    getRollData: () => ({}),
    _changeIsIgnored: (key, type, {options}) => options.ignore === true || options.ignore?.[key] === true || options.ignore?.[key]?.has?.(type),
    _changeHasEffect: (key, damage, {options}) => options.ignore !== true && options.ignore?.[key] !== true && !options.ignore?.[key]?.has?.(damage.type)
      && ({resistance, immunity, vulnerability}[key] ?? []).includes(damage.type), calculateDamage: nativeCalculate};
  const item = {uuid: `${actor.uuid}.Item.ward`, name: "Arcane Ward", type: "feat", img: "icons/svg/shield.svg", actor,
    system: {identifier: "arcane-ward", source: {rules: "2014"}, uses: {max: "12", spent}},
    flags: {cat: {automation: {source: MODULE}}, [MODULE]: {wardCreated: created}}};
  actor.items.push(item); registerDocuments(actor, item); documents.set(actor.uuid, actor);
  const update = actor.update.bind(actor);
  actor.update = (changes, options = {}) => ward.wardActorUpdate.call(actor, update, changes, options);
  return {actor, item};
}
function detail(value, type = "fire") { return {value, type, properties: new Set(["mgc"])}; }
function preview(actor, damage, options = {}, id = crypto.randomUUID()) {
  const ditem = {rawDamageDetail: damage, damageDetail: actor.calculateDamage(damage, structuredClone(options)), calcDamageOptions: structuredClone(options),
    oldHP: actor.system.attributes.hp.value, oldTempHP: actor.system.attributes.hp.temp, damageSelector: "combinedDamage"};
  ward.wardDamagePreview({workflow: {id}, targetToken: {actor}, ditem, document: actor.items[0]});
  return ditem;
}
async function apply(actor, ditem, {fail = false, cancel = false} = {}) {
  const options = structuredClone(ditem.calcDamageOptions);
  const amount = ditem.damageDetail.reduce((sum, d) => sum + (!['temphp', 'maximum'].includes(d.type) ? d.value : 0), 0);
  const updates = {"system.attributes.hp.value": ditem.newHP, "system.attributes.hp.temp": ditem.newTempHP};
  ward.captureWardApplication(actor, amount, updates, options);
  if (fail || cancel) return ward.wardActorUpdate.call(actor, async () => { if (fail) throw new Error("database failure"); }, updates, options);
  return actor.update(updates, options);
}

// Saves, resistance, immunity, vulnerability and owner reductions must not make
// the ward stronger. Run both installed Midi save/trait orders.
for (saveOrder of ["SaveDrDR", "DRSaveDr"]) {
  for (const [settings, damage, options, expectedHP, expectedSpent] of [
    [{}, [detail(10)], {}, 30, 10],
    [{resistance: ["fire"], temp: 0}, [detail(20)], {}, 26, 12],
    [{immunity: ["fire"], temp: 0}, [detail(20)], {}, 30, 12],
    [{vulnerability: ["fire"], temp: 0}, [detail(20)], {}, 14, 12],
    [{modification: {fire: -3}, temp: 0}, [detail(20)], {}, 25, 12],
    [{resistance: ["fire"], temp: 0}, [detail(40)], {midi: {saved: true, saveMultiplier: 0.5}}, 26, 12],
    [{resistance: ["fire"]}, [detail(8, "cold"), detail(12)], {}, 30, 12],
    [{}, [detail(10)], {midi: {saved: true, saveMultiplier: 0}}, 30, 0],
    [{spent: 8, temp: 3}, [detail(12)], {}, 25, 12]
  ]) {
    const {actor, item} = actorFixture(settings);
    const d = preview(actor, damage, options);
    assert.equal(item.system.uses.spent, settings.spent ?? 0, "Preview must not spend ward HP");
    if (d.calcDamageOptions[PLAN]) await apply(actor, d);
    assert.equal(actor.system.attributes.hp.value, expectedHP);
    assert.equal(item.system.uses.spent, expectedSpent);
    if (expectedSpent === 10) {
      assert.equal(actor.system.attributes.hp.temp, 8, "Armor of Agathys HP remain intact after full absorption");
      assert.equal(actor.flags[MODULE].temporaryHPSource, "Item.agathys");
    }
    assertions++;
  }
}
{
  const {actor, item} = actorFixture({temp: 0});
  const a = preview(actor, [detail(10)]), b = preview(actor, [detail(10)]);
  // Two concurrent GM applications, both previewed with a full ward.
  await Promise.all([apply(actor, a), apply(actor, b)]);
  assert.equal(item.system.uses.spent, 12);
  assert.equal(actor.system.attributes.hp.value, 22);
  await apply(actor, a);
  assert.equal(actor.system.attributes.hp.value, 22, "Repeated damage application ID is idempotent");
  assert.equal(actor.effects.length, 1);
  assertions += 2;
}
for (const canceled of [true, false]) {
  const {actor, item} = actorFixture();
  const d = preview(actor, [detail(10)]);
  if (canceled) await apply(actor, d, {cancel: true});
  else await assert.rejects(apply(actor, d, {fail: true}), /database failure/);
  assert.equal(item.system.uses.spent, 0, "Canceled or failed HP update refunds ward HP");
  assert.equal(actor.system.attributes.hp.value, 30);
  assertions++;
}
{
  const {actor, item} = actorFixture();
  const ditem = {damageSelector: "combinedDamage", rawDamageDetail: [detail(10), detail(6, "cold")], damageDetail: [], calcDamageOptions: {},
    damageDetails: {rawdefaultDamage: [detail(10)], rawbonusDamage: [detail(6, "cold")], rawotherDamage: [detail(8)],
      calcDamageOptions: {defaultDamage: {}, bonusDamage: {}, otherDamage: {midi: {saved: true, saveMultiplier: 0.5}}}}};
  ward.wardDamagePreview({workflow: {id: "combined"}, document: item, ditem});
  assert.equal(ditem.calcDamageOptions[PLAN].absorbed, 12, "One shared ward budget for default, bonus and other damage");
  assert.equal(ditem.damageDetail.reduce((sum, d) => sum + d.value, 0), 8);
  const transported = JSON.parse(JSON.stringify(ditem.calcDamageOptions[PLAN]));
  assert.equal(ward.calculateWardDamage(actor, transported.chunks).amount, 8, "Save and Set data survive socket serialization");
  assertions++;
}
{
  const {actor, item} = actorFixture({created: false, spent: 12});
  const cast = (level = 1, extra = {}) => ({actor, id: crypto.randomUUID(), item: {type: "spell", system: {school: "abj", level: 1}}, castData: {castLevel: level}, ...extra});
  accept = false;
  await ward.wardAfterSpell({workflow: cast()});
  assert.equal(ward.wardPoints(actor), 0);
  accept = true;
  const first = cast();
  await ward.wardAfterSpell({workflow: first});
  await ward.wardAfterSpell({workflow: first});
  assert.equal(ward.wardPoints(actor), 12);
  item.system.uses.spent = 11;
  const beforePrompts = decisions;
  await ward.wardAfterSpell({workflow: cast(3)});
  assert.equal(ward.wardPoints(actor), 7, "Upcast level, not base spell level, refills the ward");
  assert.equal(decisions, beforePrompts, "An existing ward refills without a creation prompt");
  for (const extra of [{aborted: true}, {counterspelled: true}, {workflowOptions: {khuzoeInternalActivity: true}},
    {activity: {midiProperties: {automationOnly: true}}}, {item: {type: "spell", system: {school: "evo", level: 1}}}]) {
    await ward.wardAfterSpell({workflow: cast(3, extra)});
    assert.equal(ward.wardPoints(actor), 7);
  }
  await ward.wardAfterSpell({workflow: cast(0)});
  assert.equal(ward.wardPoints(actor), 7);
  await ward.resetWard({actorUuid: actor.uuid});
  assert.equal(item.flags[MODULE].wardCreated, false);
  assert.equal(ward.wardPoints(actor), 0);
  assert.equal(actor.effects.length, 0);
  assertions += 10;
}
{
  const {actor, item} = actorFixture({resistance: ["fire"], temp: 0});
  let updatesSeen;
  const nativeApply = async (damages, options) => {
    const calculated = actor.calculateDamage(damages, options), amount = calculated.amount;
    updatesSeen = {"system.attributes.hp.value": actor.system.attributes.hp.value - amount, "system.attributes.hp.temp": 0};
    ward.captureWardApplication(actor, amount, updatesSeen, options);
    await actor.update(updatesSeen, options);
    return actor;
  };
  await ward.wardApplyDamage.call(actor, nativeApply, [detail(20)]);
  assert.equal(actor.system.attributes.hp.value, 26, "Native damage uses resistance exactly once");
  assert.equal(item.system.uses.spent, 12);
  assert.equal(updatesSeen["system.attributes.hp.value"], 26);
  assertions++;
}
{
  const {actor, item} = actorFixture({spent: 9});
  const changes = {system: {identifier: "arcane-ward", uses: {spent: 0}}, flags: {cat: {automation: {source: MODULE}}}};
  ward.prepareArcaneWardUpdate(item, changes);
  assert.equal(changes.system.uses.spent, 9);
  assert.equal(changes.flags[MODULE].wardCreated, true);
  assert.deepEqual(changes.system.uses.recovery, [], "A long rest must not activate or refill a new ward for free");
  const d = {rawDamageDetail: [detail(10)], calcDamageOptions: {}};
  ward.wardDamagePreview({workflow: {workflowOptions: {khuzoeUnreducible: true}}, document: item, ditem: d});
  assert.equal(d.calcDamageOptions[PLAN], undefined);
  assertions += 2;
}
// Match Midi's manual buttons, including the single-target options clone made
// before preApplyDamage and its negative damage argument on both Apply/Reverse.
for (const damage of [10, 20]) for (const autoApplied of [false, true]) {
  const {actor, item} = actorFixture({temp: 0});
  const d = preview(actor, [detail(damage)]);
  const card = {flags: {"midi-qol": {undoDamage: [{actorUuid: actor.uuid, calcDamageOptions: structuredClone(d.calcDamageOptions)}]}}};
  async function press(intent) {
    const originalOptions = card.flags["midi-qol"].undoDamage[0].calcDamageOptions;
    const updateOptions = structuredClone(originalOptions);
    const changes = {"system.attributes.hp.value": intent === "reverse" ? 30 : d.newHP, "system.attributes.hp.temp": 0};
    ward.markWardCardAction(card, `${intent}-${actor.uuid.replaceAll(".", "")}`);
    ward.captureWardApplication(actor, d.newHP - 30, changes, originalOptions);
    await actor.update(changes, updateOptions);
  }
  if (autoApplied) await apply(actor, d); else await press("apply");
  assert.equal(item.system.uses.spent, Math.min(12, damage));
  assert.equal(actor.system.attributes.hp.value, 30 - Math.max(0, damage - 12));
  await press("reverse");
  assert.equal(item.system.uses.spent, 0, "Reverse restores the ward even when all damage was absorbed");
  assert.equal(actor.system.attributes.hp.value, 30);
  await press("reverse");
  assert.equal(item.system.uses.spent, 0, "A duplicate Undo does not overfill the ward");
  await press("apply");
  assert.equal(item.system.uses.spent, Math.min(12, damage));
  assert.equal(actor.system.attributes.hp.value, 30 - Math.max(0, damage - 12));
  await press("apply");
  assert.equal(item.system.uses.spent, Math.min(12, damage));
  assertions++;
}
console.log(`Arcane Ward: ${assertions} damage-order, save-order, spell, lifecycle, concurrency, damage-card and cancellation scenarios OK (installed D&D5e calculator and Midi save logic).`);
