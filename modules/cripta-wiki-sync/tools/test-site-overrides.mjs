import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createOverrideSummary, formatOverrideSummary, planSiteOverrideState, recordOverrideOutcome } from "../scripts/services/site-override-state.js";

const MODULE = "cripta-wiki-sync";
const WORKER = "https://sigillo-api.khuzoe.workers.dev";
const source = fs.readFileSync(new URL("../scripts/main.js", import.meta.url), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
function definition(name) {
    const result = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
    assert.ok(result, `Installed function ${name}`);
    return result[0];
}
const loaded = [
    "stableAssetStringify", "hashAssetValue", "extractWorkerMediaPath", "normalizeManagedRemotePath", "normalizeFoundryLocalMediaPath",
    "normalizeOverrideCompareValue", "normalizeOverrideImageValue", "hashOverrideFieldValue", "hashOverrideImageValue", "hashOverrideDescriptionValue",
    "resolveAbilityOverrideImageUrl", "renderAbilityOverrideDescription", "getSiteOverrideState", "getManagedMediaState",
    "canAutoApplyItemImageOverride", "canAutoApplyItemDescriptionOverride", "updateSiteOverrideState",
    "applyAbilityOverridesFromWiki", "applyItemOverridesFromWiki"
].map(definition).join("\n");

function harness(kind, count = 1) {
    const calls = [], logs = [], optionsSeen = new WeakSet();
    const items = Array.from({length: count}, (_, index) => ({
        id: String(index), name: `Item ${index}`, img: `${WORKER}/media/current-${index}.webp`,
        system: {description: {value: "<p>Current text.</p>"}, uses: {spent: 3}},
        effects: [{name: "Custom automation"}], flags: {cat: {automation: {source: "khuzoe-automations"}}, [MODULE]: {skillTree: {nodeId: "active-node"}}},
        getFlag(module, key) { return this.flags[module]?.[key]; },
        async update(changes, options) {
            assert.equal(options.criptaWikiSyncCommand, true);
            assert.ok(!optionsSeen.has(options), "Every Foundry update receives fresh options");
            optionsSeen.add(options); options.parentUuid = "Actor.test";
            if (this.fail) throw new Error("Database unavailable");
            if (this.cancel) return null;
            calls.push({id: this.id, changes: copy(changes)});
            for (const [path, value] of Object.entries(changes)) {
                const parts = path.split("."), key = parts.pop();
                parts.reduce((target, part) => target[part] ??= {}, this)[key] = copy(value);
            }
            return this;
        }
    }));
    const overrides = items.map(item => ({id: item.id, image: item.img, description: item.system.description.value}));
    const control = {selection: "all", resolveFailed: false, registerMedia: false, mediaCalls: 0};
    let clock = Date.parse("2026-09-12T12:00:00Z");
    class ControlledDate extends Date { constructor() { super(clock); clock += 1000; } }
    const ctx = vm.createContext({
        MODULE_ID: MODULE, DISCORD_WORKER_URL: WORKER, SITE_OVERRIDE_STATE_FLAG: "siteOverrideState", MANAGED_MEDIA_FLAG: "managedMedia",
        Date: ControlledDate, URL, createOverrideSummary, formatOverrideSummary, planSiteOverrideState, recordOverrideOutcome,
        console: {info: (...args) => logs.push(copy(args)), warn: (...args) => logs.push(copy(args))},
        game: {user: {isGM: true}}, ui: {notifications: {info() {}, warn() {}}},
        foundry: {utils: {deepClone: copy}}, escapeHtml: text => text,
        requestNotesApi: async path => { assert.equal(path, `api/data/${kind === "ability" ? "ability" : "item"}-overrides`); return {data: overrides}; },
        findActorForAbilityOverride: override => items.some(item => item.id === override.id) ? {id: "actor", name: "Test Actor"} : null,
        findActorAbilityItem: (_actor, override) => items.find(item => item.id === override.id),
        findActorInventoryItem: (_actor, override) => items.find(item => item.id === override.id),
        getAbilityOverrideIdentityForItem: () => ({key: "test-ability"}), getItemOverrideIdentityForItem: () => ({key: "test-item"}),
        withCharacterSyncSuppressed: async task => task(),
        selectWikiOverridesToApply: async ({entries}) => control.selection === "all" ? entries
            : control.selection === "first" ? entries.slice(0, 1) : null,
        resolveAndRegisterManagedMedia: async (item, slot, options) => {
            control.mediaCalls++;
            if (control.resolveFailed) return "";
            if (control.registerMedia) await item.update({[`flags.${MODULE}.managedMedia.${slot}`]: {remote: ctx.normalizeManagedRemotePath(options.remote)}}, {criptaWikiSyncCommand: true});
            return ctx.resolveAbilityOverrideImageUrl(options.remote);
        }
    });
    vm.runInContext(loaded, ctx);
    function baseline(item) {
        item.flags[MODULE].siteOverrideState = {
            image: {siteHash: ctx.hashOverrideImageValue(item.img), appliedHash: ctx.hashOverrideImageValue(item.img), appliedAt: "2026-09-01T00:00:00Z"},
            description: {siteHash: ctx.hashOverrideDescriptionValue(item.system.description.value), appliedHash: ctx.hashOverrideDescriptionValue(item.system.description.value), appliedAt: "2026-09-01T00:00:00Z"}
        };
        item.flags[MODULE].managedMedia = {image: {remote: ctx.normalizeManagedRemotePath(item.img)}};
    }
    items.forEach(baseline);
    return {ctx, items, overrides, calls, logs, control, baseline,
        run: options => ctx[kind === "ability" ? "applyAbilityOverridesFromWiki" : "applyItemOverridesFromWiki"]({autoSafe: true, ...options}),
        summary: () => logs.filter(entry => entry[0].includes("Override") && entry[1]?.updated !== undefined).at(-1)?.[1]
    };
}

test("unchanged fingerprints preserve timestamps and do not even read the clock", () => {
    const previous = {image: {siteHash: "same", appliedHash: "same", appliedAt: "original", extra: "preserved"}, other: {keep: true}};
    const options = {hashImage: value => value, hashDescription: value => value, now: () => { throw new Error("No timestamp needed"); }};
    const result = planSiteOverrideState(previous, {image: {siteValue: "same", appliedValue: "same"}}, options);
    assert.equal(result.changed, false); assert.equal(result.state, previous);
});

test("changed or missing fields get one timestamp, unchanged fields and extra metadata survive", () => {
    const previous = {image: {siteHash: "old", appliedHash: "old", appliedAt: "old-time", extra: "keep"}, other: {preserved: true}};
    const before = copy(previous); let dates = 0;
    const options = {hashImage: value => value, hashDescription: value => value, now: () => { dates++; return "new-time"; }};
    const result = planSiteOverrideState(previous, {image: {siteValue: "new", appliedValue: "new"}, description: {siteValue: "text", appliedValue: "text"}}, options);
    assert.equal(result.changed, true); assert.equal(dates, 1); assert.deepEqual(previous, before);
    assert.equal(result.state.image.extra, "keep"); assert.equal(result.state.description.appliedAt, "new-time");
    const second = planSiteOverrideState(result.state, {description: {siteValue: "changed", appliedValue: "changed"}}, {...options, now: () => "later"});
    assert.deepEqual(second.state.image, result.state.image);
    assert.equal(second.state.description.appliedAt, "later");
});

for (const kind of ["ability", "item"]) {
    test(`${kind}: 120 already aligned records, repeated syncs produce zero writes`, async () => {
        const h = harness(kind, 120); const before = copy(h.items.map(item => item.flags));
        assert.equal(await h.run(), false); assert.equal(await h.run(), false);
        assert.equal(h.calls.length, 0); assert.equal(h.control.mediaCalls, 0);
        assert.deepEqual(h.items.map(item => item.flags), before);
        assert.deepEqual(h.summary(), {updated: 0, metadataUpdated: 0, unchanged: 120, skipped: 0});
    });

    test(`${kind}: first baseline writes once, the next sync writes nothing`, async () => {
        const h = harness(kind); delete h.items[0].flags[MODULE].siteOverrideState;
        assert.equal(await h.run(), true); assert.equal(h.calls.length, 1);
        assert.deepEqual(h.summary(), {updated: 0, metadataUpdated: 1, unchanged: 0, skipped: 0});
        const state = copy(h.items[0].flags[MODULE].siteOverrideState);
        h.calls.length = 0; assert.equal(await h.run(), false);
        assert.equal(h.calls.length, 0); assert.deepEqual(h.items[0].flags[MODULE].siteOverrideState, state);
    });

    test(`${kind}: a real description change applies, preserves automation, and settles on the next sync`, async () => {
        const h = harness(kind); const item = h.items[0];
        const oldImageState = copy(item.flags[MODULE].siteOverrideState.image);
        h.overrides[0].description = "<p>Changed at the site.</p>";
        assert.equal(await h.run(), true); assert.equal(item.system.description.value, h.overrides[0].description);
        assert.equal(h.calls.length, 2); assert.equal(h.control.mediaCalls, 0);
        assert.deepEqual(h.summary(), {updated: 1, metadataUpdated: 0, unchanged: 0, skipped: 0});
        assert.deepEqual(item.flags[MODULE].siteOverrideState.image, oldImageState);
        assert.equal(item.flags.cat.automation.source, "khuzoe-automations");
        assert.equal(item.flags[MODULE].skillTree.nodeId, "active-node");
        assert.equal(item.system.uses.spent, 3); assert.equal(item.effects.length, 1);
        h.calls.length = 0; await h.run(); assert.equal(h.calls.length, 0);
    });

    test(`${kind}: equivalent URLs and whitespace do not rewrite content or baseline`, async () => {
        const h = harness(kind); h.overrides[0].image = "media/current-0.webp";
        h.items[0].system.description.value = "<p>Current\r\ntext.</p>";
        await h.run(); assert.equal(h.calls.length, 0);
        assert.equal(h.summary().unchanged, 1);
    });

    test(`${kind}: local image and description changes remain protected`, async () => {
        const h = harness(kind); h.items[0].img = "worlds/test/custom.webp";
        h.items[0].system.description.value = "<p>Local custom text.</p>";
        h.overrides[0].image = "media/remote-changed.webp";
        h.overrides[0].description = "<p>Remote change.</p>";
        await h.run(); assert.equal(h.calls.length, 0); assert.equal(h.control.mediaCalls, 0);
        assert.equal(h.items[0].img, "worlds/test/custom.webp");
        assert.deepEqual(h.summary(), {updated: 0, metadataUpdated: 0, unchanged: 0, skipped: 1});
    });

    test(`${kind}: a protected image is not registered while applying an allowed description change`, async () => {
        const h = harness(kind); h.items[0].img = "worlds/test/custom.webp";
        h.overrides[0].image = "media/remote-changed.webp";
        h.overrides[0].description = "<p>Allowed description.</p>";
        await h.run(); assert.equal(h.items[0].img, "worlds/test/custom.webp");
        assert.equal(h.items[0].system.description.value, h.overrides[0].description);
        assert.equal(h.control.mediaCalls, 0); assert.equal(h.summary().updated, 1);
    });

    test(`${kind}: real image edits and media registration count as one content update`, async () => {
        const h = harness(kind); h.overrides[0].image = "media/new-image.webp"; h.control.registerMedia = true;
        await h.run(); assert.equal(h.items[0].img, `${WORKER}/media/new-image.webp`);
        assert.deepEqual(h.summary(), {updated: 1, metadataUpdated: 0, unchanged: 0, skipped: 0});
        h.calls.length = 0; await h.run(); assert.equal(h.calls.length, 0);
    });

    test(`${kind}: unresolved image is skipped, not reported as updated`, async () => {
        const h = harness(kind); h.overrides[0].image = "media/unavailable.webp"; h.control.resolveFailed = true;
        await h.run(); assert.equal(h.calls.length, 0);
        assert.deepEqual(h.summary(), {updated: 0, metadataUpdated: 0, unchanged: 0, skipped: 1});
    });

    test(`${kind}: canceling manual selection writes nothing`, async () => {
        const h = harness(kind); h.control.selection = null; h.overrides[0].description = "<p>Changed.</p>";
        assert.equal(await h.run({autoSafe: false}), false); assert.equal(h.calls.length, 0);
    });

    test(`${kind}: manual selection counts unselected entries separately`, async () => {
        const h = harness(kind, 3); h.control.selection = "first";
        h.overrides.forEach(entry => entry.description = "<p>Changed.</p>");
        await h.run({autoSafe: false, notify: true});
        assert.deepEqual(h.summary(), {updated: 1, metadataUpdated: 0, unchanged: 0, skipped: 2});
        assert.equal(h.calls.filter(call => call.changes["system.description.value"]).length, 1);
    });

    test(`${kind}: canceled document update never records remote content as applied`, async () => {
        const h = harness(kind); h.items[0].cancel = true; const old = copy(h.items[0].flags[MODULE].siteOverrideState);
        h.overrides[0].description = "<p>Changed.</p>";
        await h.run(); assert.equal(h.calls.length, 0); assert.deepEqual(h.items[0].flags[MODULE].siteOverrideState, old);
        assert.equal(h.summary().skipped, 1); assert.equal(h.summary().updated, 0);
    });

    test(`${kind}: missing actor/item is counted as skipped`, async () => {
        const h = harness(kind); h.overrides[0].id = "missing";
        await h.run(); assert.equal(h.calls.length, 0); assert.equal(h.summary().skipped, 1);
    });

    test(`${kind}: database failures propagate without a success report or changed baseline`, async () => {
        const h = harness(kind); h.items[0].fail = true; h.overrides[0].description = "<p>Changed.</p>";
        const previous = copy(h.items[0].flags[MODULE]);
        await assert.rejects(h.run(), /Database unavailable/); assert.deepEqual(h.items[0].flags[MODULE], previous);
        assert.equal(h.summary(), undefined);
    });
}

test("inventory: registering an existing managed image is metadata-only, then becomes a no-op", async () => {
    const h = harness("item"); delete h.items[0].flags[MODULE].managedMedia; h.control.registerMedia = true;
    await h.run(); assert.equal(h.calls.length, 1);
    assert.deepEqual(h.summary(), {updated: 0, metadataUpdated: 1, unchanged: 0, skipped: 0});
    h.calls.length = 0; await h.run(); assert.equal(h.calls.length, 0);
});
