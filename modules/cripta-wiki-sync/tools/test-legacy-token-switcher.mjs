import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeWikiItemKey, slugify } from "../scripts/services/wiki-utils.js";

const MODULE = "cripta-wiki-sync", LEGACY = "khuzoe-token-switcher", TOKENIZER = "khuzoe-tokenizer";
const source = fs.readFileSync(new URL("../scripts/main.js", import.meta.url), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
function definition(name) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
    assert.ok(match, `Installed function ${name}`);
    return match[0];
}
const functions = ["getFilename", "getTransformationTokenSize", "getLegacyTokenSwitcherEntries",
    "migrateLegacyTokenSwitcherVariants", "getKhuzoeTokenizerApi", "syncTransformationsToTokenizer"].map(definition).join("\n");

function harness({ activeLegacy = false, installedLegacy = false } = {}) {
    const writes = [], syncs = [], actors = [], overrides = [], stored = new Map();
    const control = { failLegacy: false, sceneUpdates: 0 };
    const api = {
        getVariants: () => [],
        async syncVariants(actor, payload) {
            if (payload.source === LEGACY && control.failLegacy) throw new Error("Simulated Tokenizer failure");
            syncs.push({ actorId: actor.id, payload: copy(payload) });
            const key = `${actor.id}:${payload.source}`, next = JSON.stringify(payload);
            const changed = stored.get(key) !== next;
            stored.set(key, next);
            return changed;
        }
    };
    const modules = new Map([[TOKENIZER, { active: true, api }]]);
    if (installedLegacy) modules.set(LEGACY, { active: activeLegacy });
    const ctx = vm.createContext({
        MODULE_ID: MODULE, LEGACY_TOKEN_SWITCHER_MODULE_ID: LEGACY, LEGACY_TOKEN_SWITCHER_IMAGES_FLAG: "images",
        LEGACY_TOKEN_SWITCHER_MIGRATED_FLAG: "legacyTokenSwitcherMigrated", TOKENIZER_MODULE_ID: TOKENIZER,
        TOKENIZER_SYNC_SOURCE: MODULE, normalizeWikiItemKey, slugify,
        game: { modules, actors }, console: { info() {}, warn() {} }, ui: { notifications: { info() {}, warn() {} } },
        loadWikiTransformationOverrides: async () => overrides,
        getConfiguredTransformationSubjects: () => actors.map(actor => ({ actor })),
        findConfiguredTransformationSubjectActor: entry => actors.find(actor => actor.id === entry.actorId),
        findActorForTransformation: () => null,
        mapTransformationToTokenizerVariant: async (_actor, entry) => ({ id: entry.id, src: entry.tokenImage, source: MODULE }),
        applyTransformationOverridesToScene: () => { control.sceneUpdates++; }
    });
    vm.runInContext(functions, ctx);
    function actor(images) {
        const doc = {
            id: `actor-${actors.length}`, name: "Test Actor", prototypeToken: { texture: { src: "tokens/base.webp?v=2" } },
            flags: { [MODULE]: {}, [LEGACY]: { images, otherLegacyData: "preserve" } },
            getFlag(scope, key) {
                // Reproduce Foundry 14: validation precedes the check for stored data.
                if (scope !== MODULE && !(scope === LEGACY && activeLegacy)) {
                    throw new Error(`Flag scope "${scope}" is not valid or not currently active`);
                }
                return this.flags?.[scope]?.[key];
            },
            async setFlag(scope, key, value) {
                assert.equal(scope, MODULE, "Only the existing Wiki Sync migration marker may be written");
                assert.equal(key, "legacyTokenSwitcherMigrated");
                writes.push({ actorId: this.id, scope, key, value });
                (this.flags[scope] ??= {})[key] = value;
            }
        };
        actors.push(doc);
        return doc;
    }
    return { ctx, actor, actors, api, writes, syncs, overrides, control };
}

test("reproduces Foundry's original scope error; archived-data reading succeeds", () => {
    const h = harness(), doc = h.actor(["tokens/wolf.webp"]);
    assert.throws(() => doc.getFlag(LEGACY, "images"), /Flag scope/);
    const before = JSON.stringify(doc.flags);
    assert.deepEqual(copy(h.ctx.getLegacyTokenSwitcherEntries(doc)), [{ path: "tokens/wolf.webp", name: "", width: 1, height: 1 }]);
    assert.equal(JSON.stringify(doc.flags), before);
    assert.equal(h.writes.length, 0);
});

for (const status of ["active", "disabled", "removed"]) test(`legacy variants migrate with old module ${status}`, async () => {
    const h = harness({ activeLegacy: status === "active", installedLegacy: status !== "removed" });
    const doc = h.actor([{ src: "tokens/wolf.webp", name: "Lupo", width: 2, height: 3 }]);
    const before = copy(doc.flags[LEGACY]);
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), true);
    assert.deepEqual(h.syncs[0].payload.variants, [{ id: "legacy-lupo", name: "Lupo", src: "tokens/wolf.webp", width: 2, height: 3, revision: 1, source: LEGACY }]);
    assert.deepEqual(doc.flags[LEGACY], before);
    assert.equal(h.writes.length, 1);
});

test("actors without archived flags and malformed legacy collections return an empty list", () => {
    const h = harness();
    for (const doc of [null, {}, { flags: {} }, h.actor(undefined), h.actor(null), h.actor("not-an-array"), h.actor({ images: [] })]) {
        assert.deepEqual(copy(h.ctx.getLegacyTokenSwitcherEntries(doc)), []);
    }
    assert.equal(h.writes.length, 0);
});

test("mixed archived formats retain names and sizes while empty entries are ignored", () => {
    const h = harness();
    const doc = h.actor([null, {}, " ", 7, " tokens/wolf.webp ", { path: "tokens/bear.webp", name: " Orso ", size: 3, height: 2 }]);
    assert.deepEqual(copy(h.ctx.getLegacyTokenSwitcherEntries(doc)), [
        { path: "tokens/wolf.webp", name: "", width: 1, height: 1 },
        { path: "tokens/bear.webp", name: "Orso", width: 3, height: 2 }
    ]);
});

test("migration excludes the base image and transformations already owned by Wiki Sync", async () => {
    const h = harness();
    const doc = h.actor(["tokens/base.webp?v=1", { path: "tokens/another-base.webp", name: "Base" },
        "tokens/wiki-form.webp?rev=1", "tokens/manual.webp"]);
    await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api, new Set(["tokens/wiki-form.webp"]));
    assert.deepEqual(h.syncs[0].payload.variants.map(entry => entry.src), ["tokens/manual.webp"]);
});

test("completed migration is a no-op on subsequent runs", async () => {
    const h = harness(), doc = h.actor(["tokens/wolf.webp"]);
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), true);
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), false);
    assert.equal(h.syncs.length, 1); assert.equal(h.writes.length, 1);
});

test("empty migration preserves its existing one-time marker behavior", async () => {
    const h = harness(), doc = h.actor([]);
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), false);
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), false);
    assert.equal(h.syncs.length, 0); assert.equal(h.writes.length, 1);
});

test("a Tokenizer failure is not marked as migrated and remains retryable", async () => {
    const h = harness(), doc = h.actor(["tokens/wolf.webp"]);
    h.control.failLegacy = true;
    await assert.rejects(h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), /Simulated Tokenizer failure/);
    assert.equal(h.writes.length, 0);
    h.control.failLegacy = false;
    assert.equal(await h.ctx.migrateLegacyTokenSwitcherVariants(doc, h.api), true);
    assert.equal(h.writes.length, 1);
});

test("actual transformation sync finishes multiple Actors without the retired module", async () => {
    const h = harness();
    const first = h.actor(undefined), second = h.actor(["tokens/manual.webp"]);
    h.overrides.push({ id: "form", actorId: second.id, switcher: true, tokenImage: "tokens/wiki.webp" });
    assert.equal(await h.ctx.syncTransformationsToTokenizer({ force: true }), true);
    assert.deepEqual(h.syncs.map(call => [call.actorId, call.payload.source]), [[first.id, MODULE], [second.id, MODULE], [second.id, LEGACY]]);
    assert.equal(h.control.sceneUpdates, 1);
    assert.equal(h.writes.length, 2);
    assert.equal(await h.ctx.syncTransformationsToTokenizer({ force: true }), false);
    assert.equal(h.syncs.filter(call => call.payload.source === LEGACY).length, 1);
    assert.equal(h.writes.length, 2);
});
