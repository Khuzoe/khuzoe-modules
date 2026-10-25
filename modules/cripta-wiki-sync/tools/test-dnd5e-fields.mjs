import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as fields from "../scripts/services/dnd5e-fields.js";
import { isTemporaryWikiActor } from "../scripts/services/actor-sync-eligibility.mjs";

const MODULE_ID = "cripta-wiki-sync";
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const getProperty = (object, path) => path.split(".").reduce((entry, key) => entry?.[key], object);
function setProperty(object, path, value) {
    const keys = path.split(".");
    let cursor = object;
    while (keys.length > 1) cursor = cursor[keys.shift()] ??= {};
    cursor[keys[0]] = value;
    return true;
}
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
function liveSpell(prepared = 0, method = "spell", extra = {}) {
    const system = { level: 1, method, prepared, ...extra };
    Object.defineProperty(system, "preparation", {
        enumerable: true,
        get() { throw new Error("Deprecated SpellData#preparation was read"); }
    });
    return system;
}
function item(prepared = 0, method = "spell", extra = {}) {
    const raw = { _id: "spell", name: "Test Spell", type: "spell", img: "spell.webp",
        system: { level: 1, method, prepared, ...extra }, effects: [],
        flags: { [MODULE_ID]: { campaignItemId: "test-spell" } } };
    return { id: raw._id, uuid: "Item.spell", name: raw.name, type: raw.type, img: raw.img,
        system: liveSpell(prepared, method, extra), _source: raw, flags: raw.flags,
        toObject: () => copy(raw), getFlag: (scope, key) => raw.flags?.[scope]?.[key] };
}
function actor(items = [], senses) {
    return { id: "actor", type: "npc", items: new Collection(items.map(entry => [entry.id, entry])), effects: [],
        system: { attributes: senses ? { senses } : {} } };
}
function context(service = "managed-actor-sync") {
    const ctx = vm.createContext({ ...fields, isTemporaryWikiActor, MODULE_ID, Map, Set, console,
        foundry: { utils: { deepClone: copy, getProperty, setProperty } },
        game: { actors: new Collection(), settings: { get: () => ({}) } },
        normalizeActiveEffectSourceV14: value => copy(value) });
    const code = fs.readFileSync(new URL(`../scripts/services/${service}.js`, import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    vm.runInContext(code, ctx, { filename: `${service}.js` });
    return ctx;
}

for (const prepared of [0, 1, 2]) test(`native spell state ${prepared} never reads compatibility accessor`, () => {
    const system = liveSpell(prepared);
    assert.deepEqual(fields.readSpellPreparation(system), { method: "spell", prepared });
    assert.deepEqual(fields.spellPreparationForWiki(system), {
        mode: prepared === 2 ? "always" : "prepared", prepared: prepared > 0
    });
});
test("plain archived spell data is supported; native fields take precedence", () => {
    for (const [mode, prepared, method, expected] of [
        ["always", false, "spell", 2], ["prepared", false, "spell", 0],
        ["prepared", true, "spell", 1], ["innate", true, "innate", 1]
    ]) assert.deepEqual(fields.readSpellPreparation({ preparation: { mode, prepared } }), { method, prepared: expected });
    assert.deepEqual(fields.readSpellPreparation({ method: "innate", prepared: 0, preparation: { mode: "always", prepared: true } }),
        { method: "innate", prepared: 0 });
});

test("character spell selection retains cantrips, normal spells, and fixed casting methods", () => {
    const source = fs.readFileSync(new URL("../scripts/main.js", import.meta.url), "utf8");
    const extract = name => {
        const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
        assert.ok(match, name);
        return match[0];
    };
    const ctx = vm.createContext({ ...fields, CHARACTER_SYNC_SPELL_METHODS: new Set(["spell", "atwill", "innate", "pact"]),
        compactObject: value => value, cleanFoundryDescription: value => value,
        getItemLoadoutRole: () => undefined, getItemLoadoutSubtype: () => undefined,
        getItemDocumentId: value => value.id, getItemTransferId: () => "transfer", getItemStableSourceId: () => "source",
        getTransferableItemKey: () => "key", getItemQuantity: () => 1, getItemContainer: () => null,
        getItemCurrency: () => undefined, getItemCapacity: () => undefined,
        getActivityActivationData: () => undefined, getActivityRangeData: () => undefined, getActivityDurationData: () => undefined });
    vm.runInContext(["isUsefulSpell", "toNumberOrNull", "mapItemForCharacterSync", "getPlainItemSystem"].map(extract).join("\n"), ctx);
    for (const method of ["spell", "atwill", "innate", "pact"]) assert.equal(ctx.isUsefulSpell(item(0, method)), true);
    assert.equal(ctx.isUsefulSpell(item(0, "", { level: 0 })), true);
    assert.equal(ctx.isUsefulSpell(item(1, "custom")), true);
    assert.equal(ctx.isUsefulSpell(item(0, "")), false);
    for (const prepared of [0, 1, 2]) assert.equal(ctx.mapItemForCharacterSync(item(prepared)).prepared, prepared > 0);
});

for (const prepared of [0, 1, 2]) test(`Link Actor preserves numeric state ${prepared} and writes only the native field`, () => {
    const ctx = context(), source = actor([item(prepared)]), target = actor([item((prepared + 1) % 3)]);
    const before = JSON.stringify(source.items.get("spell")._source);
    assert.equal(ctx.managedActorLinkItemState(source)[0].prepared, prepared);
    assert.deepEqual(copy(ctx.managedActorLinkItemUpdates(target, source)), [{ _id: "spell", "system.prepared": prepared }]);
    assert.deepEqual(copy(ctx.managedActorLinkItemUpdates(source, source)), []);
    assert.equal(JSON.stringify(source.items.get("spell")._source), before);
});
test("prepared state is runtime, while casting method remains a structural difference", () => {
    const ctx = context();
    assert.equal(ctx.managedActorLinkItemDefinitionSignature(item(0)), ctx.managedActorLinkItemDefinitionSignature(item(2)));
    assert.notEqual(ctx.managedActorLinkItemDefinitionSignature(item(0)), ctx.managedActorLinkItemDefinitionSignature(item(0, "innate")));
    assert.equal(ctx.managedActorLinkItemStateValueEqual("prepared", true, 1), true);
    assert.equal(ctx.managedActorLinkItemStateValueEqual("prepared", false, 0), true);
    assert.equal(ctx.managedActorLinkItemStateValueEqual("prepared", 2, 1), false);
    assert.deepEqual(copy(ctx.managedActorLinkCanonicalItemRuntimeState({ prepared: true })),
        copy(ctx.managedActorLinkCanonicalItemRuntimeState({ prepared: 1 })));
    assert.equal(ctx.managedActorLinkCanonicalItemRuntimeState({ prepared: 2 }).prepared, 2);
});
test("managed website export preserves its existing boolean and mode contract", () => {
    const ctx = context();
    for (const prepared of [0, 1, 2]) {
        const result = ctx.buildManagedActorEntry(item(prepared));
        assert.equal(result.state.prepared, prepared > 0);
        assert.equal(result.definition.preparation.mode, prepared === 2 ? "always" : "prepared");
        assert.equal(result.definition.method, "spell");
    }
});

async function command(prepared, method, patches) {
    const ctx = context(), doc = item(prepared, method), owner = actor([doc]), writes = [];
    owner.updateEmbeddedDocuments = async (type, updates) => {
        assert.equal(type, "Item"); writes.push(copy(updates));
    };
    ctx.game.actors.set(owner.id, owner);
    const result = await ctx.applyManagedActorCommand({ kind: "item.update", foundryActorId: owner.id,
        target: { itemId: doc.id }, patches });
    return { result, writes };
}
const patch = (suffix, baseValue, value) => ({ path: `system.preparation.${suffix}`, baseValue, value });
for (const [before, after] of [[0, 1], [1, 0], [2, 0]]) test(`website prepared toggle ${before} -> ${after} writes native data`, async () => {
    const { result, writes } = await command(before, "spell", [patch("prepared", before > 0, after > 0)]);
    assert.equal(result.status, "applied");
    assert.deepEqual(writes, [[{ _id: "spell", system: { prepared: after } }]]);
});
test("repeated website prepared=true keeps always-prepared state and avoids a write", async () => {
    const { result, writes } = await command(2, "spell", [patch("prepared", true, true)]);
    assert.equal(result.status, "applied"); assert.equal(writes.length, 0);
});
for (const [before, oldMode, mode, method, prepared] of [
    [1, "prepared", "always", "spell", 2], [2, "always", "prepared", "spell", 1],
    [2, "always", "innate", "innate", 1]
]) test(`website casting mode ${oldMode} -> ${mode} retains preparation semantics`, async () => {
    const { result, writes } = await command(before, "spell", [patch("mode", oldMode, mode)]);
    assert.equal(result.status, "applied");
    assert.deepEqual(writes, [[{ _id: "spell", system: { method, prepared } }]]);
});
test("website conflicting edits are rejected before any write", async () => {
    const { result, writes } = await command(0, "innate", [patch("mode", "prepared", "pact")]);
    assert.equal(result.status, "conflict"); assert.equal(writes.length, 0);
});
test("native website edits pass through; legacy conversion does not replace explicit native fields", async () => {
    const { result, writes } = await command(0, "spell", [{ path: "system.prepared", baseValue: 0, value: 2 }]);
    assert.equal(result.status, "applied");
    assert.deepEqual(writes, [[{ _id: "spell", system: { prepared: 2 } }]]);
    const update = { system: { method: "innate", prepared: 0, preparation: { mode: "always", prepared: true } } };
    fields.modernizeSpellPreparationUpdate(update, liveSpell(1));
    assert.deepEqual(update, { system: { method: "innate", prepared: 0 } });
});
test("combined website edits and whole preparation objects preserve the requested state", async () => {
    const combined = await command(2, "spell", [patch("mode", "always", "prepared"), patch("prepared", true, false)]);
    assert.equal(combined.result.status, "applied");
    assert.deepEqual(combined.writes, [[{ _id: "spell", system: { method: "spell", prepared: 0 } }]]);
    const whole = await command(0, "spell", [{ path: "system.preparation",
        baseValue: { mode: "prepared", prepared: false }, value: { mode: "always", prepared: true } }]);
    assert.equal(whole.result.status, "applied");
    assert.deepEqual(whole.writes, [[{ _id: "spell", system: { method: "spell", prepared: 2 } }]]);
});
for (const prepared of [false, true, 2]) test(`old Link Actor backup restores prepared=${prepared} through native updates`, async () => {
    const ctx = context(), doc = item(prepared === false ? 1 : 0), owner = actor([doc]), writes = [];
    ctx.game.scenes = [];
    owner.update = async () => {};
    owner.updateEmbeddedDocuments = async (type, updates) => { assert.equal(type, "Item"); writes.push(copy(updates)); };
    const snapshot = { actorItemState: [{ id: doc.id, name: doc.name, type: doc.type, prepared }], tokens: [] };
    const before = copy(snapshot);
    await ctx.restoreManagedActorLinkSnapshot(owner, snapshot);
    assert.deepEqual(writes, [[{ _id: "spell", "system.prepared": Number(prepared) }]]);
    assert.deepEqual(snapshot, before);
});

function liveSenses(ranges = { darkvision: 60, blindsight: 0, tremorsense: null, truesight: null }) {
    const senses = { ranges, units: "ft", special: "special sense" };
    for (const key of ["darkvision", "blindsight", "tremorsense", "truesight"]) {
        Object.defineProperty(senses, key, { enumerable: true,
            get() { throw new Error(`Deprecated senses.${key} was read`); } });
    }
    return senses;
}
test("senses normalization ignores enumerable aliases and retains zero, null, custom senses and metadata", () => {
    const senses = liveSenses(), before = copy(senses.ranges);
    senses.ranges.customSense = 30;
    const result = fields.readDnd5eSenses(senses);
    assert.deepEqual(result, { ranges: { ...before, customSense: 30 }, units: "ft", special: "special sense" });
    result.ranges.darkvision = 120;
    assert.equal(senses.ranges.darkvision, 60);
    assert.deepEqual(fields.readDnd5eSenses({ ranges: new Map([["darkvision", 90]]), units: "m" }),
        { ranges: { darkvision: 90 }, units: "m" });
});
test("legacy senses and modern ranges compare equally, without warnings or false differences", () => {
    const ctx = context(), modern = liveSenses();
    const legacy = { ...modern.ranges, units: modern.units, special: modern.special };
    assert.deepEqual(copy(ctx.managedActorLinkDefinitionState(actor([], modern))), copy(ctx.managedActorLinkDefinitionState(actor([], legacy))));
    assert.deepEqual(copy(ctx.managedActorLinkDefinitionDifferences(actor([], modern), actor([], legacy))), []);
});
test("Link Actor displays actual resolved darkvision, including effect changes and zero", () => {
    const ctx = context();
    for (const range of [90, 0]) {
        const base = actor([], liveSenses()), changed = actor([], liveSenses({ ...base.system.attributes.senses.ranges, darkvision: range }));
        changed._source = { system: { attributes: { senses: { ranges: { darkvision: 60 } } } } };
        const result = ctx.managedActorLinkDefinitionDifferences(base, changed);
        assert.deepEqual(copy(result), [{ label: "Scurovisione", before: "60", after: String(range), group: "trait" }]);
        assert.equal(changed._source.system.attributes.senses.ranges.darkvision, 60);
    }
});
for (const prepared of [0, 1, 2]) test(`catalog propagation retains instance prepared=${prepared} without compatibility getters`, async () => {
    const ctx = context("campaign-item-sync"), world = item(0), embedded = item(prepared), owner = actor([embedded]), writes = [];
    world._source.name = "Updated library spell";
    ctx.game.actors.set(owner.id, owner);
    owner.updateEmbeddedDocuments = async (_type, updates) => { writes.push(copy(updates)); };
    assert.equal(await ctx.propagateWorldItemToLinkedInstances(world), 1);
    assert.equal(writes[0][0].system.prepared, prepared);
    assert.equal(Object.hasOwn(writes[0][0].system, "preparation"), false);
    assert.equal(embedded._source.system.prepared, prepared);
});
