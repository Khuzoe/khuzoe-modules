import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {spellOvertimeChanges, normalizeSpellOvertime} from "../scripts/spell-overtime.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";

// Use the installed Midi parser and activity builder, not a local imitation of
// their contract. Foundry's generic helpers and arithmetic evaluator are stubs.
const midi = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
function extract(name) {
  const start = midi.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = midi.indexOf("\n}", start) + 2;
  return midi.slice(start, end);
}
const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
globalThis.foundry = {utils: {duplicate: structuredClone, getProperty: get, logCompatibilityWarning() {}}};
globalThis.Roll = {safeEval: expression => {
  if (!/^[\d.()+*/\s-]+$/.test(expression)) throw new Error("Invalid DC");
  return Function(`return (${expression})`)();
}};
const dependencies = `const MODULE_ID = 'midi-qol'; const TroubleShooter = {recordError() {}}; const rollModeToMessageMode = value => value;`;
const {parseOvertimeDetails: parse, buildRollActivityData: build} = Function(dependencies + [
  "replaceAtFields", "parseBool", "parseCountAction", "parseOvertimeDetails", "buildRollActivityData"
].map(extract).join("\n") + "\nreturn {parseOvertimeDetails, buildRollActivityData};")();
const spellDir = new URL("../packData/khuzoe-spells-2014/", import.meta.url);
const inventory = await Promise.all((await readdir(spellDir)).filter(file => file.endsWith(".json")).map(async file => {
  const item = JSON.parse(await readFile(new URL(file, spellDir), "utf8"));
  return {id: item.system.identifier, effects: item.effects};
}));
const changeFor = identifier => inventory.find(entry => entry.id === identifier).effects
  .flatMap(effect => effect.system.changes).find(change => change.key.startsWith("flags.midi-qol.OverTime"));
const oldHold = parse(changeFor("hold-person").value, {}, "Hold Person");
assert.equal(oldHold.saveDC, -1);
assert.equal(build(oldHold).type, undefined, "The installed parser cannot create a save from $activity.dc");
for (const identifier of ["hold-person", "synaptic-static", "blinding-smite", "wrathful-smite"]) {
  const original = changeFor(identifier);
  for (const value of [original.value, original.value.replace(/saveDC=[^,]*/, "saveDC=0")]) {
    const [fixed] = spellOvertimeChanges([{...original, value}], identifier, {saveDC: 19, castLevel: 5});
    const parsed = parse(fixed.value, {}, identifier);
    assert.equal(parsed.saveDC, 19);
    assert.equal(parsed.allowIncapacitated, identifier !== "wrathful-smite");
    assert.equal(build(parsed).type, identifier === "wrathful-smite" ? "check" : "save");
  }
}
for (const [identifier, expected] of [["melfs-acid-arrow", "5d4"], ["tashas-caustic-brew", "10d4"]]) {
  const [fixed] = spellOvertimeChanges([changeFor(identifier)], identifier, {castLevel: 5});
  const parsed = parse(fixed.value, {}, identifier);
  assert.equal(parsed.damageRoll, expected);
  assert.equal(parsed.allowIncapacitated, true);
  if (identifier === "melfs-acid-arrow") {
    assert.equal(parsed.turn, "end");
    assert.equal(parsed.removeCondition, "true");
  }
}

globalThis.game = {user: {id: "gm", isGM: true}};
globalThis.cat = {utils: {queryUtils: {}, documentUtils: {}, activityUtils: {getSaveDC: () => 17}}};
const caster = {uuid: "Actor.caster", system: {attributes: {spell: {dc: 14}}}};
const item = {uuid: "Actor.caster.Item.hold", actor: caster, system: {identifier: "hold-person", level: 2}};
const affected = {uuid: "Actor.target", effects: []};
const effect = {uuid: "Actor.target.ActiveEffect.hold", origin: item.uuid,
  system: {changes: [changeFor("hold-person")]}};
const unrelated = {uuid: "Actor.target.ActiveEffect.other", origin: "Actor.other.Item.hold",
  system: {changes: [changeFor("hold-person")]}};
affected.effects.push(effect, unrelated); registerDocuments(caster, item, affected, effect, unrelated);
const workflow = {item, activity: {}, targets: new Set([{actor: affected}]), castData: {saveDC: 19, castLevel: 5}};
await normalizeSpellOvertime({...workflow, aborted: true});
assert.match(effect.system.changes[0].value, /\$activity/);
await normalizeSpellOvertime(workflow);
assert.equal(parse(effect.system.changes[0].value, {}, "Hold").saveDC, 19);
assert.match(unrelated.system.changes[0].value, /\$activity/, "Effects from another caster are untouched");
item.system.identifier = "melfs-acid-arrow";
effect.system.changes = [changeFor("melfs-acid-arrow")];
effect.duration = {value: 12, units: "seconds", expiry: "sourceEnd"};
effect.flags = {dae: {specialDuration: ["turnEndSource"]}};
await normalizeSpellOvertime(workflow);
assert.equal(effect.duration.expiry, "turnStart", "Source expiry cannot pre-empt the target's damage event");
assert.deepEqual(effect.flags.dae.specialDuration, []);
assert.equal(parse(effect.system.changes[0].value, {}, "Acid").removeCondition, "true");
console.log("Spell OverTime: installed Midi parser, real caster DC, upcasting, incapacitation, cancellation and one-shot Acid Arrow OK");
