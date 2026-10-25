import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runSyntheticActivity, runSyntheticActivityData, continueModifiers} from "../scripts/activity-compat.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";
import {tokenDistanceFeet, sceneUnitsPerFoot, tokenSizeForCategory} from "../scripts/geometry.mjs";
import {expandedEffectDamageItem, expandedEffectFlatReduction, expandedEffectDamageBonuses,
  expandedEffectDamageRoll, finishExpandedSpell} from "../scripts/expanded-spells-2014.mjs";

globalThis.foundry = {utils: {deepClone: structuredClone}};
globalThis.game = {user: {id: "gm", isGM: true}, combat: null};
const corrections = [], bonuses = [], movements = [];
globalThis.MidiQOL = {modifyDamageBy: data => corrections.push(data)};

function syntheticItem(data, actor) {
  const item = {actor, flags: data.flags, toObject: () => structuredClone(data)};
  item.system = {activities: new Map(Object.entries(data.system.activities).map(([id, value]) => [id, {
    ...value, id, item, toObject: () => structuredClone(value)
  }]))};
  return item;
}
globalThis.cat = {utils: {
  itemUtils: {syntheticItem},
  actorUtils: {getFirstToken: actor => actor?.token},
  tokenUtils: {getDistance: () => 5, slideToken: async (target, options) => movements.push([target.uuid, options.distance])},
  workflowUtils: {
    syntheticActivityRoll: async (activity, targets, options) => {
      assert.ok(!activity.item.flags.dnd5e.riders.activity.includes(activity.id), "D&D5e must allow the runtime activity");
      assert.equal(options.spellSlot, false);
      return {activity, targets};
    },
    syntheticActivityDataRoll: async (data, item, targets, options) => {
      assert.ok(!item.flags.dnd5e.riders.activity.includes(data._id));
      assert.equal(options.consumeUsage, false);
      return {item, targets};
    },
    isAttackType: (workflow, type) => type === "attack" ? workflow.activity?.type === "attack" : workflow.item?.type === "weapon",
    bonusDamage: async (workflow, formula, options) => bonuses.push([formula, options.damageType]),
    modifyDamageAppliedFlat: (...args) => corrections.push(args)
  }
}};

const originalData = {flags: {dnd5e: {riders: {activity: ["rider"], effect: ["effect"]}}},
  system: {activities: {rider: {_id: "rider", type: "damage", midiProperties: {automationOnly: true}}}}};
const source = syntheticItem(originalData, {});
await runSyntheticActivity(source.system.activities.get("rider"), []);
await runSyntheticActivityData(originalData.system.activities.rider, source, []);
assert.deepEqual(originalData.flags.dnd5e.riders.activity, ["rider"], "Never modify the original Item");

const native = {system: {identifier: "disintegrate", activities: {
  cast: {_id: "cast", damage: {onSave: "half"}},
  rider: {_id: "rider", flags: {cat: {hidden: true}}, midiProperties: {automationOnly: true}}
}}, flags: {dnd5e: {riders: {activity: ["cast", "rider"]}}}};
normalizeAutomationData(native);
assert.equal(native.system.activities.cast.damage.onSave, "none");
assert.deepEqual(native.flags.dnd5e.riders.activity, ["rider"]);
const publicFollowup = {system: {activities: {move: {_id: "move", flags: {cat: {hidden: true}}, midiProperties: {automationOnly: true}}}},
  flags: {"khuzoe-automations": {activityIdentifiers: {hexMove: "move"}}}};
normalizeAutomationData(publicFollowup);
assert.equal(publicFollowup.system.activities.move.midiProperties.automationOnly, false);
assert.deepEqual(publicFollowup.flags.dnd5e.riders.activity, []);

let total = 0;
const wrapped = continueModifiers(async () => { total += 7; return true; });
// CAT's ordinary event contract stops at the first truthy callback result.
for (const callback of [wrapped, async () => { total += 5; }]) if (await callback()) break;
assert.equal(total, 12, "Sneak Attack must leave the following bonus reachable");

// Exercise the installed CAT implementation, including its negative-damage clamp.
const map = JSON.parse(await readFile(new URL("../../cat/dist/main.js.map", import.meta.url), "utf8").catch(async () =>
  readFile(new URL("../../../cat/dist/main.js.map", import.meta.url), "utf8")));
const sourceIndex = map.sources.findIndex(path => path.endsWith("utilities/workflowUtils.mjs"));
const sourceText = map.sourcesContent[sourceIndex];
const start = sourceText.indexOf("function modifyDamageAppliedFlat(");
const body = sourceText.slice(start, sourceText.indexOf("\n}", start) + 2);
cat.utils.workflowUtils.modifyDamageAppliedFlat = new Function(`return (${body});`)();
const effect = (identifier, kind = "self-buff") => ({flags: {"khuzoe-automations": {expandedSpell: {identifier, kind}}}});
await expandedEffectDamageItem({document: effect("beacon-of-hope", "beacon"),
  workflow: {defaultDamageType: "healing", damageRolls: [{options: {type: "healing"}, reroll: async () => ({total: 8})}]},
  ditem: {hpDamage: -3, tempDamage: 0, rawDamageDetail: []}});
assert.equal(corrections.at(-1).value, -5);
assert.equal(corrections.at(-1).type, "healing");
corrections.length = 0;
expandedEffectFlatReduction({document: effect("blade-ward"), workflow: {item: {type: "weapon"}},
  ditem: {hpDamage: 8, tempDamage: 0, rawDamageDetail: [], damageDetail: [{type: "slashing", value: 8, active: {resistance: true}}]}});
assert.equal(corrections.length, 0, "Blade Ward must not halve damage already resisted");

const target = {uuid: "Scene.s.Token.t", actor: {}};
const mark = effect("hunters-mark", "mark-source");
Object.assign(mark.flags["khuzoe-automations"].expandedSpell, {targetUuid: target.uuid, damageType: ""});
const weaponWorkflow = {activity: {type: "attack"}, item: {type: "weapon"}, hitTargets: new Set([target]), defaultDamageType: "slashing"};
await expandedEffectDamageBonuses({document: mark, workflow: weaponWorkflow});
assert.deepEqual(bonuses.at(-1), ["1d6", "slashing"]);
const hex = effect("hex", "mark-source");
Object.assign(hex.flags["khuzoe-automations"].expandedSpell, {targetUuid: target.uuid});
const previous = bonuses.length;
await expandedEffectDamageBonuses({document: hex, workflow: {...weaponWorkflow, activity: {type: "save"}}});
assert.equal(bonuses.length, previous, "Hex requires an attack, not just hitTargets");

const a = {uuid: "Scene.s.Token.a", actor: {}}, b = {uuid: "Scene.s.Token.b", actor: {}};
await finishExpandedSpell({item: {system: {identifier: "thunderwave"}},
  workflow: {failedSaves: new Set([a, b]), token: target, activity: {}}});
assert.deepEqual(movements.map(entry => entry[0]), [a.uuid, b.uuid]);

let changedRolls;
globalThis.CONFIG = {Dice: {DamageRoll: class {constructor(formula) {this.formula = formula;} async evaluate() {return this;}}}};
await expandedEffectDamageRoll({document: effect("ray-of-enfeeblement", "enfeebled"), workflow: {
  item: {type: "weapon", getRollData: () => ({})}, attackRoll: {options: {ability: "str"}},
  damageRolls: [{formula: "2d6+4", total: 13, options: {type: "slashing"}}],
  setDamageRolls: async rolls => {changedRolls = rolls;}
}});
assert.equal(changedRolls[0].formula, "6", "Halve the existing result without rerolling dice");

const scene = {id: "s", grid: {size: 100, units: "ft", distance: 5}};
globalThis.canvas = {grid: {measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y))/100*scene.grid.distance})}};
const large = {parent: scene, x: 0, y: 0, width: 2, height: 2};
const medium = {parent: scene, x: 300, y: 0, width: 1, height: 1};
assert.equal(tokenDistanceFeet(large, medium), 10);
scene.grid.units = "m"; scene.grid.distance = 1.524;
assert.ok(Math.abs(tokenDistanceFeet(large, medium) - 10) < 0.00001);
assert.equal(sceneUnitsPerFoot(scene), 0.3048);
assert.deepEqual(tokenSizeForCategory("huge"), {width: 3, height: 3});
console.log("Khuzoe: attività native/CAT, catene di bonus, cure, resistenze, marchi, bersagli multipli, tiri e geometria OK.");
