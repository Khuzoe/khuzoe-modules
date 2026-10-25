import assert from "node:assert/strict";
import {isTemporaryWikiActor} from "../scripts/services/actor-sync-eligibility.mjs";
import {SETTINGS, MODULE_ID} from "../scripts/constants.js";
import {registerManagedActorSync, resumeManagedActorSyncQueue, syncManagedActorNow,
    queueManagedActorContentSync, isManagedActorShared} from "../scripts/services/managed-actor-sync.js";

const forbid = () => { throw new Error("Temporary actors must not write documents or contact the site"); };
const listeners = new Map(), stored = new Map(), timers = [], writes = [];
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
const gm = {id: "gm", isGM: true};
globalThis.Hooks = {on(name, fn) { const handlers = listeners.get(name) || []; handlers.push(fn); listeners.set(name, handlers); }};
globalThis.fetch = forbid;
globalThis.window = {setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}};
globalThis.foundry = {utils: {deepClone: structuredClone}};
globalThis.game = {user: gm, users: {activeGM: gm, get: () => gm}, actors: new Collection(), scenes: new Collection(),
    world: {id: "test-world"}, modules: new Map(), settings: {
        register(_module, key, definition) { if (!stored.has(key)) stored.set(key, definition.default); },
        get(_module, key) { return stored.get(key); },
        async set(_module, key, value) { stored.set(key, value); writes.push(key); }
    }};
stored.set(SETTINGS.SYNC_MODE, "bidirectional");
stored.set(SETTINGS.CAMPAIGN_ID, "test-campaign");
const original = {id: "original", name: "Original", type: "npc", documentName: "Actor", flags: {},
    getFlag(scope, key) { return this.flags[scope]?.[key]; }, update: forbid, setFlag: forbid};
const variants = [
    {dnd5e: {isPolymorphed: true}},
    {[MODULE_ID]: {excludeFromSync: true}},
    {"khuzoe-automations": {shapechange: {operation: "older-shapechange"}}}
].map((flags, index) => ({...original, id: `temporary${index}`, flags: {
    ...flags, "khuzoe-tokenizer": {syncEvent: {eventId: "inherited-save", changedTargets: ["avatar"]}},
    "khuzoe-merchant": {merchant: {enabled: true}}
}}));
variants.push({...original, id: "native-getter", isPolymorphed: true});
assert.equal(isTemporaryWikiActor(original), false);
assert.equal(isTemporaryWikiActor({...original, flags: {"khuzoe-automations": {shapechangeRestored: "previous-cast"}}}), false);
registerManagedActorSync({ensureTransferIds: forbid});
for (const actor of variants) {
    game.actors.set(actor.id, actor);
    assert.equal(isTemporaryWikiActor(actor), true);
    assert.equal(await syncManagedActorNow(actor, {forceCreate: true, allowMissingBaseMedia: true}), false);
    assert.equal(await syncManagedActorNow(actor, {pullCommandReconciliation: true}), false);
    assert.equal(await queueManagedActorContentSync(actor), false);
    assert.equal(await isManagedActorShared(actor, {force: true}), false);
    for (const fn of listeners.get("khuzoe-tokenizer.saved")) await fn(actor, {eventId: "saved"});
    for (const fn of listeners.get("updateActor")) await fn(actor, {"flags.khuzoe-tokenizer.syncEvent": {eventId: "save"}}, {}, gm.id);
    for (const hook of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "deleteActiveEffect"]) {
        for (const fn of listeners.get(hook)) await fn({parent: actor, actor}, {}, {});
    }
}
assert.equal(writes.length, 0, "No queue or settings writes for temporary documents");
assert.equal(timers.length, 0, "No temporary jobs are scheduled");

// Jobs saved by an older module and inherited Tokenizer receipts at startup.
const pending = Object.fromEntries(variants.map(actor => [actor.id, {reason: "old-save", forceCreate: true}]));
stored.set("managedActorPendingQueue", pending);
stored.set("managedActorSyncState", {[variants[1].id]: {revision: 1, schemaVersion: 1}});
await resumeManagedActorSyncQueue();
assert.equal(timers.length, 0);
assert.deepEqual(stored.get("managedActorPendingQueue"), pending, "No unrelated persisted data is deleted");

// Ordinary NPC exports still enter the normal queue, including at startup.
game.actors.set(original.id, original);
stored.set("managedActorSyncState", {[original.id]: {revision: 1}});
assert.equal(await queueManagedActorContentSync(original), true);
assert.ok(stored.get("managedActorPendingQueue")[original.id]);
assert.equal(timers.length, 1);
console.log("Temporary actor sync: manual/automatic exports, inherited events, older copies, startup queue and ordinary NPC controls passed; no network calls.");
