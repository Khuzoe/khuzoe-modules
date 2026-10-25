import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { isTemporaryWikiActor } from "../scripts/services/actor-sync-eligibility.mjs";
import { DataFieldOperator, ForcedDeletion, ForcedReplacement } from "../../../../App/resources/app/common/data/operators.mjs";

// Integration tests execute the installed Bar Brawl hook implementation and
// Foundry's actual deletion operator. No Foundry world or browser is accessed.
const MODULE_ID = "cripta-wiki-sync";
const deletion = new ForcedDeletion();
const plain = value => Object.prototype.toString.call(value) === "[object Object]" && !(value instanceof DataFieldOperator);
const clone = value => {
    if (value instanceof DataFieldOperator) return value;
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return value;
};
const json = value => JSON.parse(JSON.stringify(value));
const getProperty = (object, path) => path.split(".").reduce((entry, key) => entry?.[key], object);
function setProperty(object, path, value) {
    const keys = path.split("."); let cursor = object;
    while (keys.length > 1) cursor = cursor[keys.shift()] ??= {};
    cursor[keys[0]] = value;
    return true;
}
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
function harness(active = true) {
    const warnings = [], hooks = new Map();
    const ctx = vm.createContext({ isTemporaryWikiActor, MODULE_ID, Map, Set, _del: deletion, _replace: ForcedReplacement.create,
        DataFieldOperator, ForcedDeletion, isPlainObject: plain, isDeletionKey: () => false,
        CONST: { TOKEN_DISPLAY_MODES: { NONE: 0, CONTROL: 10, OWNER_HOVER: 20, HOVER: 30, OWNER: 40, ALWAYS: 50 } },
        foundry: { utils: { deepClone: clone, getProperty, setProperty, hasProperty: (object, path) => getProperty(object, path) !== undefined } },
        game: { modules: new Map([["barbrawl", { active }]]), scenes: new Collection() },
        console: { warn: (...args) => warnings.push(args), debug() {} },
        adjustPrototypeOverrides() {}, extendBarRenderer() {}, extendTokenHud() {}, extendTokenConfig() {}, api: {},
        Hooks: { once() {}, on: (name, fn) => { hooks.set(name, fn); } }
    });
    const load = url => vm.runInContext(fs.readFileSync(new URL(url, import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), ctx);
    load("../../barbrawl/module/api.js");
    load("../../barbrawl/module/synchronization.js");
    load("../../barbrawl/barbrawl.js");
    load("../scripts/services/managed-actor-sync.js");
    const helpers = fs.readFileSync(new URL("../../../../App/resources/app/common/utils/helpers.mjs", import.meta.url), "utf8");
    const applyOperators = helpers.match(/^export function applyDataOperators\([^\n]*\) \{[\s\S]*?^\}/m);
    assert.ok(applyOperators);
    vm.runInContext(applyOperators[0].replace(/^export /, ""), ctx);
    return { ctx, hooks, warnings, persist: value => ctx.applyDataOperators(value) };
}
function configuration() {
    return { name: "NPC", width: 1, height: 1, displayBars: 50,
        bar1: { attribute: "attributes.hp" }, bar2: { attribute: null },
        texture: { src: "npc.webp", scaleX: 1 },
        flags: { unrelated: { keep: true }, barbrawl: { resourceBars: {
            bar1: { id: "bar1", attribute: "attributes.hp", position: "bottom-inner", mincolor: "#123456", ownerVisibility: 50 }
        } } }
    };
}
function token(source = configuration(), id = "token") {
    const data = { ...clone(source), _id: id, actorId: "actor", actorLink: false, delta: { system: { test: 1 } },
        x: 120, y: 240, elevation: 5, hidden: true, locked: false, sort: 7, _regions: [] };
    return { ...clone(data), id, _source: data, toObject: () => clone(data) };
}

for (const hook of ["preUpdateActor", "preUpdateToken"]) test(`reproduces the reported ${hook} exception with the original full update`, () => {
    const h = harness(), doc = token(), changes = clone(configuration());
    assert.throws(() => hook === "preUpdateActor"
        ? h.hooks.get(hook)({ prototypeToken: doc }, { prototypeToken: changes })
        : h.hooks.get(hook)(doc, changes), /reading 'attribute'/);
});
for (const hook of ["preUpdateActor", "preUpdateToken"]) test(`${hook} accepts the corrected full update and stores no placeholder bar`, () => {
    const h = harness(), doc = token(), changes = h.ctx.prepareManagedActorLinkBarUpdate(clone(configuration()));
    const before = json(doc._source);
    assert.equal(changes.flags.barbrawl.resourceBars.bar2, deletion);
    assert.doesNotThrow(() => hook === "preUpdateActor"
        ? h.hooks.get(hook)({ prototypeToken: doc }, { prototypeToken: changes })
        : h.hooks.get(hook)(doc, changes));
    const persisted = h.persist(changes);
    assert.equal(Object.hasOwn(persisted.flags.barbrawl.resourceBars, "bar2"), false);
    assert.deepEqual(json(persisted.flags), configuration().flags);
    assert.deepEqual(json(persisted.bar2), { attribute: null });
    assert.deepEqual(json(doc._source), before);
    assert.equal(h.warnings.length, 0);
});
test("both empty bars are removed explicitly, including old destination bars", () => {
    const h = harness(), doc = token(), source = configuration();
    source.bar1.attribute = null;
    delete source.flags.barbrawl;
    const update = h.ctx.prepareManagedActorLinkBarUpdate(clone(source));
    h.hooks.get("preUpdateToken")(doc, update);
    const persisted = h.persist(update);
    assert.deepEqual(json(persisted.flags.barbrawl.resourceBars), {});
    assert.deepEqual(json(persisted.bar1), { attribute: null });
    assert.deepEqual(json(persisted.bar2), { attribute: null });
    assert.equal(h.warnings.length, 0);
});
test("custom bars sharing a native null attribute retain values, colors and visibility", () => {
    const h = harness(), source = configuration();
    source.flags.barbrawl.resourceBars.bar2 = { id: "bar2", attribute: "custom", value: 5, max: 12,
        ignoreMin: false, ignoreMax: false, ownerVisibility: 50, otherVisibility: 0, mincolor: "#abcdef" };
    source.flags.barbrawl.resourceBars.extra = { id: "extra", attribute: "resources.secondary", gmVisibility: 50 };
    const update = h.ctx.prepareManagedActorLinkBarUpdate(clone(source));
    assert.deepEqual(json(update), source);
    h.hooks.get("preUpdateToken")(token(source), update);
    assert.deepEqual(json(h.persist(update).flags), source.flags);
    assert.equal(h.warnings.length, 0);
});
test("inactive or absent Bar Brawl leaves the full configuration untouched", () => {
    const h = harness(false), source = configuration();
    assert.deepEqual(json(h.ctx.prepareManagedActorLinkBarUpdate(clone(source))), source);
    h.ctx.game.modules.clear();
    assert.deepEqual(json(h.ctx.prepareManagedActorLinkBarUpdate(clone(source))), source);
});
test("partial updates and nonempty native bars are not changed by the compatibility adapter", () => {
    const h = harness();
    for (const source of [{ actorLink: true }, { bar2: {} }, { bar2: { attribute: "resources.secondary" } }]) {
        assert.deepEqual(json(h.ctx.prepareManagedActorLinkBarUpdate(clone(source))), source);
    }
});
test("adapter can be repeated without changing an existing deletion or other flags", () => {
    const h = harness(), update = h.ctx.prepareManagedActorLinkBarUpdate(clone(configuration()));
    const before = json(update);
    h.ctx.prepareManagedActorLinkBarUpdate(update);
    assert.deepEqual(json(update), before);
    assert.equal(update.flags.barbrawl.resourceBars.bar2, deletion);
});
test("actual Link Actor prototype writer uses the adapter and preserves prototype-only settings", async () => {
    const h = harness(), source = configuration(), prototype = token(), writes = [];
    prototype.randomImg = true;
    const owner = { prototypeToken: prototype, async update(update, options) {
        writes.push(update);
        assert.equal(options.noHook, undefined);
        h.hooks.get("preUpdateActor")(this, update);
        if ("prototypeToken.actorLink" in update) prototype.actorLink = update["prototypeToken.actorLink"];
    } };
    await h.ctx.applyManagedActorLinkPrototypeConfiguration(owner, source, true);
    assert.equal(writes[0].prototypeToken.actorLink, true);
    assert.equal(writes[0].prototypeToken.randomImg, true);
    assert.deepEqual(json(source), configuration());
    assert.equal(h.warnings.length, 0);
});
test("actual Link Actor scene writer preserves position and unrelated tokens", async () => {
    const h = harness(), doc = token(), unrelated = token(configuration(), "other"), writes = [];
    unrelated.actorId = "unrelated";
    h.ctx.game.scenes.set("scene", { id: "scene", tokens: new Collection([[doc.id, doc], [unrelated.id, unrelated]]),
        async updateEmbeddedDocuments(type, updates, options) {
            assert.equal(type, "Token"); assert.equal(options.noHook, undefined);
            for (const update of updates) h.hooks.get("preUpdateToken")(doc, update);
            writes.push(updates);
        } });
    await h.ctx.applyManagedActorLinkPlacedTokens({ id: "actor" }, configuration());
    assert.equal(writes[0].length, 1);
    const update = writes[0][0];
    assert.equal(update._id, doc.id);
    assert.equal(update.actorLink, true);
    assert.deepEqual(json(update.delta), {});
    for (const key of ["x", "y", "elevation", "hidden", "locked", "sort"]) assert.equal(update[key], doc[key]);
    assert.equal(h.warnings.length, 0);
});
test("rollback scene writer applies the same compatibility handling without editing the stored backup", async () => {
    const h = harness(), doc = token(), writes = [], source = clone(doc._source);
    const snapshot = { tokens: [{ sceneId: "scene", tokenId: doc.id, actorLink: false, source }] };
    const before = json(snapshot);
    h.ctx.game.scenes.set("scene", { id: "scene", tokens: new Collection([[doc.id, doc]]),
        async updateEmbeddedDocuments(_type, updates) {
            for (const update of updates) {
                h.hooks.get("preUpdateToken")(doc, update);
                const next = h.persist(update);
                // Native schema fields absent from the update retain their values.
                Object.assign(doc._source, next); Object.assign(doc, next);
            }
            writes.push(updates);
        } });
    await h.ctx.restoreManagedActorLinkSnapshot({ id: "actor", items: [], async update() {} }, snapshot);
    assert.equal(writes.length, 1);
    assert.equal(doc.actorLink, false);
    assert.deepEqual(json(doc.delta), source.delta);
    assert.deepEqual(json(snapshot), before);
    assert.equal(h.warnings.length, 0);
});
