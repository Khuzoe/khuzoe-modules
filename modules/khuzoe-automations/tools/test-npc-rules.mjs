import assert from "node:assert/strict";
import {prepareNpcRules, healFromNpcRule, validateNpcRules} from "../scripts/npc-rules.mjs";

let checks = 0;
const equal = (actual, expected, label) => {assert.deepEqual(actual, expected, label); checks++;};
let nextId = 0;
globalThis.foundry = {utils: {randomID: () => String(++nextId).padStart(16, "0")}};
globalThis.game = {user: {id: "owner"}, i18n: {localize: name => name}};
const activities = {attack: {type: "attack", name: "Morso", effects: [{_id: "existing00000000"}], damage: {includeBase: true}}, save: {type: "save", name: "Aura", effects: []}};
const originalEffect = {_id: "existing00000000", name: "Existing", flags: {other: {keep: true}}};
const effects = [originalEffect];
const statusEffects = [{id: "prone", name: "Prono", img: "icons/svg/falling.svg"}, {id: "poisoned", name: "Avvelenato", system: {changes: [{key: "test", value: 1, type: "add"}]}}];
const rules = {version: 1, activities: {attack: {healing: 0.5, conditions: ["prone", "poisoned"], rounds: 2, expiry: "turnEnd"}}};
const prepared = prepareNpcRules({rules, activities, effects, itemName: "Morso", statusEffects});
equal(prepared.effects.length, 3, "one effect per condition keeps immunities independent");
equal(prepared.effects[0], originalEffect, "unrelated effect is preserved exactly");
equal(prepared.activities.attack.effects.length, 3, "native activity links retain previous effects");
equal(prepared.activities.attack.damage, {includeBase: true}, "damage data is preserved");
equal(prepared.effects[1].duration, {value: 2, units: "rounds", expiry: "turnEnd"}, "native v14 duration");
equal(prepared.effects[2].system.changes, statusEffects[1].system.changes, "condition mechanics come from the installed system");
equal(prepared.activities.attack.effects[1].onSave, false, "save conditions are not applied on successful saves");
equal(effects.length, 1, "compiler does not mutate input effects");
equal(activities.attack.effects.length, 1, "compiler does not mutate input activities");
const replayed = prepareNpcRules({...prepared, rules, itemName: "Morso", statusEffects});
equal(replayed, prepared, "repeated compilation preserves IDs and creates no duplicates");
const removed = prepareNpcRules({...prepared, rules: {version: 1, activities: {}}, itemName: "Morso", statusEffects});
equal(removed.effects, effects, "removing presets removes only generated effects");
equal(removed.activities, activities, "removing presets preserves unrelated activity links");
for (const invalid of [
  {version: 2, activities: {}}, {version: 1, activities: {missing: {healing: 1}}},
  {version: 1, activities: {attack: {healing: 2}}},
  {version: 1, activities: {attack: {conditions: ["invented"]}}},
  {version: 1, activities: {attack: {rounds: -1}}},
  {version: 1, activities: {attack: {rounds: 1.5}}},
  {version: 1, activities: {attack: {macro: "run()"}}}
]) {assert.throws(() => validateNpcRules(invalid, activities)); checks++;}
assert.throws(() => prepareNpcRules({rules, activities, effects, itemName: "Test", statusEffects: []})); checks++;

let applied = [], warnings = [];
let mode = "yesCard";
globalThis.MidiQOL = {configSettings: () => ({autoApplyDamage: mode}), applyTokenDamage: async (...args) => {applied.push(args);}};
globalThis.ui = {notifications: {warn: text => warnings.push(text)}};
const workflow = (fraction = 0.5, entries = [{tokenUuid: "Scene.x.Token.target", damageDetail: [{type: "necrotic", value: 13}, {type: "none", value: -2}], hpDamage: 4}]) => ({
  userId: "owner", item: {name: "Morso", flags: {"khuzoe-automations": {npcRules: {version: 1, activities: {attack: {healing: fraction}}}}}},
  activity: {id: "attack"}, token: {actor: {id: "source"}}, damageList: entries
});
const first = workflow();
await Promise.all([healFromNpcRule(first), healFromNpcRule(first)]);
equal(applied.length, 1, "concurrent hooks heal once per workflow");
equal(applied[0][1], 5, "half final damage is rounded down after reductions, not capped at remaining HP");
equal(applied[0][0][0].type, "healing", "healing uses Midi's normal immunity/effect-aware pipeline");
equal(applied[0][5].forceApply, true, "healing is applied, not merely previewed");
await healFromNpcRule({...workflow(1), aborted: true});
await healFromNpcRule({...workflow(1), userId: "other"});
await healFromNpcRule(workflow(1, [{tokenUuid: "miss", isHit: false, hpDamage: 90}]));
await healFromNpcRule(workflow(1, [{tokenUuid: "immune", damageDetail: [{type: "fire", value: 0}]}]));
await healFromNpcRule(workflow(1, [{tokenUuid: "healed", damageDetail: [{type: "healing", value: 9}, {type: "temphp", value: 4}]}]));
equal(applied.length, 1, "aborted, foreign, missed, immune and healing-only workflows never heal");
await healFromNpcRule(workflow(1, [{tokenUuid: "a", hpDamage: 4, tempDamage: 3}, {tokenUuid: "b", hpDamage: 5}, {tokenUuid: "a", hpDamage: 4, tempDamage: 3}]));
equal(applied.at(-1)[1], 12, "multiple targets include temporary HP damage without duplicate targets");
mode = "noCard";
await healFromNpcRule(workflow());
equal(applied.length, 2, "manual damage preview does not heal");
equal(warnings.length, 1, "manual Midi configuration is explained");
mode = "yesCardNPC";
await healFromNpcRule(workflow(1, [{tokenUuid: "pc", actor: {type: "character"}, hpDamage: 9}, {tokenUuid: "npc", actor: {type: "npc"}, hpDamage: 7}]));
equal(applied.at(-1)[1], 7, "NPC-only damage setting excludes damage not applied to PCs");
mode = "yesCard";
await healFromNpcRule({...workflow(0.5, [{tokenUuid: "split", damageDetail: [{type: "fire", value: 4}], damageDetails: {combinedDamage: [{type: "slashing", value: 10}], otherDamage: [{type: "fire", value: 4}]}}]), otherDamageRolls: [{}]});
equal(applied.at(-1)[1], 7, "separate secondary damage batches retain primary damage");
console.log(`NPC rules: ${checks} checks passed.`);
