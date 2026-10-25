import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CREATE_BONFIRE_AUTOMATION,
  CREATE_BONFIRE_CAST_ACTIVITY_ID,
  CREATE_BONFIRE_DAMAGE_ACTIVITY_ID,
  CREATE_BONFIRE_DAMAGE_IDENTIFIER,
  linkCreateBonfireConcentration,
  prepareCreateBonfireItemUpdate
} from "../scripts/create-bonfire.mjs";

const itemPath = new URL(
  "../packData/khuzoe-spells-2014/Create_Bonfire_KhzBonfireAuto01.json",
  import.meta.url
);
const item = JSON.parse(await readFile(itemPath, "utf8"));
const cast = item.system.activities[CREATE_BONFIRE_CAST_ACTIVITY_ID];
const regionDamage = item.system.activities[CREATE_BONFIRE_DAMAGE_ACTIVITY_ID];

assert.equal(item._id.length, 16);
assert.equal(cast._id.length, 16);
assert.equal(regionDamage._id.length, 16);
assert.equal(item.system.identifier, "create-bonfire");
assert.equal(item.system.level, 0);
assert.ok(item.system.properties.includes("concentration"));
assert.equal(item.system.target.template.type, "cube");
assert.equal(item.system.target.template.size, "5");
assert.deepEqual(cast.save.ability, ["dex"]);
assert.equal(cast.damage.onSave, "none");
assert.equal(cast.damage.parts[0].denomination, 8);
assert.equal(cast.damage.parts[0].scaling.mode, "whole");
assert.equal(cast.damage.parts[0].scaling.number, 1);
assert.equal(cast.regionBehavior.enabled, true);
assert.equal(cast.regionBehavior.oncePerTurn, true);
assert.equal(cast.regionBehavior.dispositionFilter, 0);
assert.equal(cast.regionBehavior.excludeSource, false);
assert.equal(cast.regionBehavior.regionVisibility, 2);
assert.deepEqual(cast.regionBehavior.rules, [
  {trigger: "entry", action: "useActivity", targetId: CREATE_BONFIRE_DAMAGE_IDENTIFIER},
  {trigger: "turnEnd", action: "useActivity", targetId: "khuzoe-create-bonfire-end"}
]);
assert.equal(regionDamage.midiProperties.identifier, CREATE_BONFIRE_DAMAGE_IDENTIFIER);
assert.equal(regionDamage.midiProperties.automationOnly, true);
assert.equal(regionDamage.flags.cat.hidden, true);
assert.deepEqual(item.flags.dnd5e.riders.activity, []);
assert.equal(item.flags.cat.macros.roll[0].identifier, CREATE_BONFIRE_AUTOMATION.identifier);

let linkedEffectUuid;
const effect = {
  uuid: "Actor.caster.ActiveEffect.concentration",
  origin: "Actor.caster.Item.bonfire",
  statuses: new Set(["concentrating"]),
  flags: {dnd5e: {item: {id: "bonfire", uuid: "Actor.caster.Item.bonfire"}}}
};
const actor = {id: "caster", isOwner: true, effects: [effect]};
const spell = {
  id: "bonfire",
  uuid: "Actor.caster.Item.bonfire",
  name: "Create Bonfire"
};
const region = {
  id: "region",
  uuid: "Scene.test.Region.region",
  documentName: "Region",
  async setFlag(scope, key, value) {
    assert.equal(scope, "dnd5e");
    assert.equal(key, "dependentOn");
    linkedEffectUuid = value;
  }
};

globalThis.game = {user: {isGM: true}};
globalThis.ui = {notifications: {warn() {}}};
globalThis.MidiQOL = undefined;
globalThis.cat = {utils: {}};

const ignored = await linkCreateBonfireConcentration({
  activity: {id: CREATE_BONFIRE_DAMAGE_ACTIVITY_ID},
  workflow: {actor, item: spell, template: region}
});
assert.equal(ignored, false);
assert.equal(linkedEffectUuid, undefined);

const linked = await linkCreateBonfireConcentration({
  activity: {id: CREATE_BONFIRE_CAST_ACTIVITY_ID},
  workflow: {actor, item: spell, template: region}
});
assert.equal(linked, true);
assert.equal(linkedEffectUuid, effect.uuid);

const changes = {
  system: {identifier: "create-bonfire"},
  flags: {cat: {automation: {source: "khuzoe-automations"}}},
  img: "icons/replacement.webp"
};
prepareCreateBonfireItemUpdate({
  system: {identifier: "create-bonfire"},
  img: "custom/bonfire.webp"
}, changes);
assert.equal(changes.img, "custom/bonfire.webp");

console.log("Khuzoe Automations Create Bonfire: OK");

// Run the installed Midi rule dispatcher: its ledger is keyed by activity UUID.
const midiSource = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
const methodStart = midiSource.indexOf("async _executeRulesForTrigger(token, trigger) {");
const methodEnd = midiSource.indexOf("      /* ---------------------------------------- */", methodStart);
const method = midiSource.slice(methodStart, methodEnd).trim().replace("async _executeRulesForTrigger", "async function");
const dispatch = new Function("return (" + method + ")")();
const ledger = new Set(), uses = [];
const behavior = {oncePerTurn: true, rules: cast.regionBehavior.rules.map(rule => ({...rule,
  targetUuid: Object.values(item.system.activities).find(activity => activity.midiProperties?.identifier === rule.targetId)._id})),
  _hasTriggeredThisTurn: (_actor, uuid) => ledger.has(uuid),
  _markTriggeredThisTurn: async (_actor, uuid) => ledger.add(uuid),
  _triggerActivity: async (_token, uuid) => uses.push(uuid)};
for (const trigger of ["entry", "entry", "turnEnd", "turnEnd"]) await dispatch.call(behavior, {actor: {}}, trigger);
assert.deepEqual(uses, [CREATE_BONFIRE_DAMAGE_ACTIVITY_ID, "KhzBonfireEnd001"], "Entry and turn end both apply, but each applies once per turn");
