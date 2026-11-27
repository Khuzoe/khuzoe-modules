import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {registerExpandedSpells2014, expandedEffectDeleted} from "../scripts/expanded-spells-2014.mjs";

const MODULE = "khuzoe-automations";
const state = effect => effect.flags?.[MODULE]?.expandedSpell ?? {};
const sizes = ["tiny", "sm", "med", "lg", "huge", "grg"];
const dimensions = {tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4};
const macros = [];
registerExpandedSpells2014({registerAutomation() {}, registerFnMacro(entry) { macros.push(entry); }});
const finish = macros.find(entry => entry.identifier === "enlarge-reduce").roll
  .find(entry => entry.pass === "itemRollFinished").macro;
const systemSource = await readFile(new URL("../../../systems/dnd5e/dnd5e.mjs", import.meta.url), "utf8");
const ringBody = systemSource.match(/  prepareData\(\) \{\s+super\.prepareData\(\);\s+(if \( !this\.hasDynamicRing \)[\s\S]*?)\n  \}/)?.[1];
assert.ok(ringBody, "Installed D&D5e dynamic-ring preparation must be available");
const prepareRing = new Function("CONFIG", `return function() {${ringBody}}`)(
  {DND5E: {actorSizes: Object.fromEntries(sizes.map(size => [size, {dynamicTokenScale: size === "sm" ? 0.8 : 1}]))}}
);

let serial = 0;
let cases = 0;
function fixture({size = "med", width = dimensions[size], height = width, linked = true, ring = false} = {}) {
  const id = ++serial, documents = new Map(), updates = [], pendingDeletes = [], answers = [];
  const actor = {uuid: `Actor.size${id}`, name: "Target", documentName: "Actor", effects: [], system: {traits: {}},
    getActiveTokens(onlyLinked) { return [token, ...(this.extraTokens ?? [])].filter(t => !onlyLinked || t.actorLink); }};
  Object.defineProperty(actor.system.traits, "size", {get() {
    const changes = actor.effects.filter(effect => !effect.disabled && !effect.isSuppressed)
      .flatMap(effect => effect.system?.changes ?? []).filter(change => change.key === "system.traits.size")
      .sort((a, b) => (a.priority ?? 20) - (b.priority ?? 20));
    return changes.at(-1)?.value ?? size;
  }});
  const token = {uuid: `Scene.test.Token.size${id}`, actor, actorLink: linked, baseActor: actor,
    hasDynamicRing: ring, _source: {width, height, texture: {scaleX: -1.25, scaleY: 1.4}},
    texture: {}, width, height};
  const prepareToken = () => { token.texture = {...token._source.texture}; prepareRing.call(token); };
  prepareToken();
  documents.set(token.uuid, token);
  const caster = {uuid: `Actor.caster${id}`, effects: []};
  const item = {uuid: `${caster.uuid}.Item.enlarge`, actor: caster, name: "Enlarge/Reduce",
    system: {identifier: "enlarge-reduce", level: 2, duration: {value: 1, units: "minute"}}};
  const concentration = {uuid: `${caster.uuid}.ActiveEffect.concentration`, parent: caster, dependents: []};
  let failCreation = false, delayedDeletion = false;
  globalThis.game = {user: {id: "gm", isGM: true}};
  globalThis.ui = {notifications: {warn() {}}};
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  globalThis.cat = {utils: {
    actorUtils: {getFirstToken: () => null},
    dialogUtils: {buttonDialog: async () => answers.shift()},
    effectUtils: {
      getConcentrationEffect: () => concentration,
      createEffects: async (owner, entries) => {
        if (failCreation) return [];
        return entries.map(data => {
          const effect = {...structuredClone(data), uuid: `${owner.uuid}.ActiveEffect.${++serial}`, parent: owner};
          owner.effects.push(effect); documents.set(effect.uuid, effect); prepareToken();
          return effect;
        });
      }
    },
    documentUtils: {
      async deleteDocument(effect) {
        effect.parent?.effects?.splice(effect.parent.effects.indexOf(effect), 1);
        documents.delete(effect.uuid); prepareToken();
        if (state(effect).kind === "size") {
          if (delayedDeletion) pendingDeletes.push(effect);
          else await expandedEffectDeleted({document: effect, actor});
        }
      },
      async makeDependent(parent, children) { parent.dependents.push(...children); },
      async update(document, data) {
        updates.push({document, data: structuredClone(data)});
        for (const [path, value] of Object.entries(data)) {
          if (path === "width" || path === "height") document._source[path] = document[path] = value;
          else if (path.startsWith("texture.")) document._source.texture[path.slice(8)] = value;
        }
        prepareToken();
        return document;
      }
    }
  }};
  const cast = async (choice = "enlarge", extra = {}) => {
    answers.push(choice);
    await finish({workflow: {id: `workflow-${++serial}`, actor: caster, item,
      targets: new Set([token]), failedSaves: new Set([token]), ...extra}, item});
    return actor.effects.find(effect => state(effect).kind === "size");
  };
  const end = effect => cat.utils.documentUtils.deleteDocument(effect);
  const assertNoScaleWrites = () => assert.ok(updates.every(({data}) =>
    !Object.keys(data).some(key => key.startsWith("texture") || /scale/i.test(key))),
  "Enlarge/Reduce must never persist graphical scale, including on expiry");
  return {actor, token, caster, item, concentration, documents, updates, cast, end, answers, assertNoScaleWrites,
    failCreation() { failCreation = true; }, delayDeletion() { delayedDeletion = true; },
    async flushDeletes() { for (const effect of pendingDeletes.splice(0)) await expandedEffectDeleted({document: effect, actor}); }};
}

// A Small dynamic-ring token has a prepared scale different from its saved scale.
// Saving the prepared value on expiry used to compound D&D5e's 0.8 multiplier.
{
  const f = fixture({size: "sm", ring: true});
  const original = structuredClone(f.token._source.texture);
  const effect = await f.cast();
  assert.equal(f.actor.system.traits.size, "med");
  await f.end(effect);
  assert.deepEqual(f.token._source.texture, original, "Expiry must preserve saved scale for dynamic-ring tokens");
  f.assertNoScaleWrites();
  cases++;
}

for (const choice of ["enlarge", "reduce"]) for (let i = 0; i < sizes.length; i++) {
  const f = fixture({size: sizes[i]});
  const effect = await f.cast(choice);
  const expected = sizes[Math.max(0, Math.min(sizes.length - 1, i + (choice === "enlarge" ? 1 : -1)))];
  assert.equal(f.actor.system.traits.size, expected);
  assert.equal(f.token.width, dimensions[expected]);
  assert.equal(f.token.height, dimensions[expected]);
  const bonus = choice === "enlarge" ? "1d4" : "-1d4";
  for (const type of ["mwak", "rwak"]) assert.ok(effect.system.changes.some(change =>
    change.key === `system.bonuses.${type}.damage` && change.value === bonus));
  const modifier = choice === "enlarge" ? "advantage" : "disadvantage";
  for (const type of ["check", "save"]) assert.ok(effect.system.changes.some(change =>
    change.key === `flags.midi-qol.${modifier}.ability.${type}.str`));
  assert.equal(effect.duration.value, 60);
  assert.ok(f.concentration.dependents.includes(effect));
  await f.end(effect);
  assert.equal(f.actor.system.traits.size, sizes[i]);
  assert.equal(f.token.width, dimensions[sizes[i]]);
  f.assertNoScaleWrites();
  cases++;
}

// Refresh and opposite choices replace the old spell; they do not build on its size.
for (const next of ["enlarge", "reduce"]) {
  const f = fixture({width: 1.25, height: 1.5});
  await f.cast();
  const effect = await f.cast(next);
  assert.equal(f.actor.effects.filter(effect => state(effect).kind === "size").length, 1);
  assert.equal(f.actor.system.traits.size, next === "enlarge" ? "lg" : "sm", "Recasts must use the original size");
  await f.end(effect);
  assert.equal(f.actor.system.traits.size, "med");
  assert.deepEqual([f.token.width, f.token.height], [1.25, 1.5], "Expiry restores the original custom footprint");
  f.assertNoScaleWrites();
  cases++;
}

{
  const f = fixture();
  const effect = await f.cast();
  state(effect).tokenSnapshots[0].scaleX = 0.1;
  state(effect).tokenSnapshots[0].scaleY = 0.2;
  f.token._source.texture.scaleX = -1.8;
  f.token._source.texture.scaleY = 1.7;
  await f.end(effect);
  assert.deepEqual(f.token._source.texture, {scaleX: -1.8, scaleY: 1.7}, "Legacy snapshots and manual scale edits are not overwritten");
  f.assertNoScaleWrites();
  cases++;
}
{
  const f = fixture();
  f.failCreation();
  await f.cast();
  assert.equal(f.actor.system.traits.size, "med");
  assert.equal(f.updates.length, 0, "Failed effect creation must not leave a large token with Medium size");
  cases++;
}
{
  const f = fixture({linked: false});
  f.actor.getActiveTokens = () => [];
  const effect = await f.cast();
  assert.equal(f.token.width, 2, "The explicitly targeted synthetic token is resized without a canvas lookup");
  await f.end(effect);
  assert.equal(f.token.width, 1);
  cases++;
}
{
  const f = fixture();
  const unrelated = {...f.token, uuid: "Scene.test.Token.unrelated", actorLink: false, _source: structuredClone(f.token._source)};
  f.actor.extraTokens = [unrelated]; f.documents.set(unrelated.uuid, unrelated);
  await f.cast();
  assert.equal(unrelated.width, 1, "Unlinked tokens sharing the base NPC must not be resized");
  assert.ok(f.updates.every(update => update.document !== unrelated));
  cases++;
}
{
  const f = fixture();
  await f.cast();
  f.delayDeletion();
  const effect = await f.cast();
  await f.flushDeletes();
  assert.equal(f.actor.system.traits.size, "lg");
  assert.equal(f.token.width, 2, "Delayed expiry of the replaced effect must not undo the replacement");
  await f.end(effect); await f.flushDeletes();
  assert.equal(f.token.width, 1);
  f.assertNoScaleWrites();
  cases++;
}
{
  const f = fixture();
  const effect = await f.cast();
  f.actor.effects.push({system: {changes: [{key: "system.traits.size", value: "huge", priority: 50}]}});
  await f.end(effect);
  assert.equal(f.actor.system.traits.size, "huge");
  assert.equal(f.token.width, 3, "Expiry respects another surviving size effect");
  f.assertNoScaleWrites();
  cases++;
}
{
  const f = fixture({width: 2});
  f.actor.effects.push({system: {changes: [{key: "system.traits.size", value: "lg", priority: 30}]}});
  const effect = await f.cast();
  assert.equal(f.actor.system.traits.size, "huge", "Enlarge must increase the real size while Giant's Might is active");
  assert.equal(f.token.width, 3);
  await f.end(effect);
  assert.equal(f.actor.system.traits.size, "lg");
  assert.equal(f.token.width, 2);
  cases++;
}
{
  const f = fixture();
  await Promise.all([f.cast(), f.cast()]);
  assert.equal(f.actor.effects.filter(effect => state(effect).kind === "size").length, 1,
    "Concurrent refreshes on one client must serialize their size changes");
  assert.equal(f.actor.system.traits.size, "lg");
  cases++;
}
for (const [size, choice] of [["grg", "enlarge"], ["tiny", "reduce"]]) {
  const f = fixture({size, width: dimensions[size] + 0.25});
  await f.cast(choice);
  f.delayDeletion();
  const effect = await f.cast(choice);
  await f.flushDeletes();
  assert.equal(f.token.width, dimensions[size], "A delayed replaced effect cannot restore a custom footprint over a live spell at a size boundary");
  await f.end(effect); await f.flushDeletes();
  assert.equal(f.token.width, dimensions[size] + 0.25);
  f.assertNoScaleWrites();
  cases++;
}
{
  const f = fixture();
  await f.cast(false);
  assert.equal(f.actor.effects.length, 0);
  assert.equal(f.updates.length, 0);
  await f.cast("enlarge", {failedSaves: new Set()});
  assert.equal(f.actor.effects.length, 0);
  assert.equal(f.updates.length, 0, "Successful saves do not change size or scale");
  cases++;
}
console.log(`Enlarge/Reduce: ${cases} size, footprint, scale, native dynamic-ring, refresh, expiry and failure scenarios OK.`);
