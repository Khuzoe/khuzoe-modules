import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
    applySkillTreeActorPlan, collectSkillTreeEffects, createSkillTreeSyncQueue, isArchivedSkillTree,
    isSharedSkillTree, isSkillTreeSyncLeader, planSkillTreeActor, selectSkillTreeState,
    skillNodeAtLevel, summarizeSkillTreePlans, unlockedSkillTreeNodes, validateSkillTreeSnapshot
} from '../scripts/services/skill-tree-sync.js';
import { normalizeWikiItemKey, slugify } from '../scripts/services/wiki-utils.js';

const M = 'cripta-wiki-sync';
const C = 'cripta-di-sangue';
const copy = value => JSON.parse(JSON.stringify(value));
function patch(target, changes) {
    for (const [path, value] of Object.entries(changes)) {
        const keys = path.split('.');
        let owner = target;
        for (const key of keys.slice(0, -1)) owner = owner[key] ||= {};
        owner[keys.at(-1)] = copy(value);
    }
}
let sequence = 0;
const id = () => String(++sequence).padStart(16, '0');
const documentsByUuid = new Map();
function databaseOperation(type, parent, operation = {}) {
    // Foundry 14 Document methods set parent/pack on the caller's object. The backend
    // resolves a leftover parentUuid when parent is null, then serializes into the same object.
    // See common/abstract/document.mjs, abstract/backend.mjs and client/data/client-backend.mjs.
    operation.parent = parent;
    operation.pack = parent?.pack ?? null;
    operation.parent ||= documentsByUuid.get(operation.parentUuid) ?? null;
    if (type === 'Actor' && operation.parent) {
        throw new Error('Actor is not a valid embedded Document within the Actor Document');
    }
    if (operation.parent) {
        operation.parentUuid = operation.parent.uuid;
        delete operation.parent;
    }
}
class Effect {
    constructor(data, parent) { Object.assign(this, copy(data)); this._id ||= id(); this.id = this._id; this.parent = parent; this.uuid = `${parent.uuid}.ActiveEffect.${this.id}`; }
    toObject() { return { _id: this.id, name: this.name, origin: this.origin, disabled: Boolean(this.disabled), flags: copy(this.flags || {}), system: copy(this.system || {}) }; }
    async update(changes, options) {
        databaseOperation('ActiveEffect', this.parent, options);
        if (this.cancelUpdate) return this;
        patch(this, changes); return this;
    }
}
class Item {
    constructor(data, actor) {
        Object.assign(this, copy(data)); this._id ||= id(); this.id = this._id; this.actor = this.parent = actor;
        this.uuid = `${actor.uuid}.Item.${this.id}`; this.effects = (data.effects || []).map(e => new Effect(e, this));
        documentsByUuid.set(this.uuid, this);
    }
    toObject() {
        return { _id: this.id, name: this.name, type: this.type, img: this.img, system: copy(this.system || {}), flags: copy(this.flags || {}), effects: this.effects.map(e => e.toObject()) };
    }
}
class Actor {
    constructor(name = 'Valdor', data = []) {
        this.id = id(); this.uuid = `Actor.${this.id}`; this.name = name; this.type = 'character';
        this.characterId = name.toLowerCase(); this.flags = {}; this.effects = []; this.calls = [];
        documentsByUuid.set(this.uuid, this);
        this.items = data.map(d => new Item(d, this));
    }
    async update(changes, options) {
        databaseOperation('Actor', null, options);
        if (this.failArchive && Object.keys(changes).some(k => k.includes('skillTreeArchive'))) throw new Error('archive failed');
        if (this.cancelArchive && Object.keys(changes).some(k => k.includes('skillTreeArchive'))) return this;
        this.calls.push(['actor.update', copy(changes), options]); patch(this, changes); return this;
    }
    async createEmbeddedDocuments(type, documents, options) {
        databaseOperation(type, this, options);
        this.calls.push(['create', documents.map(d => d.name), options]);
        if (this.cancelCreate) return [];
        const created = documents.map(d => new Item(d, this)); this.items.push(...created); return created;
    }
    async updateEmbeddedDocuments(type, updates, options) {
        databaseOperation(type, this, options);
        this.calls.push(['update', copy(updates), options]);
        return updates.map(u => { const item = this.items.find(i => i.id === u._id); patch(item, u); return item; });
    }
    async deleteEmbeddedDocuments(type, ids, options) {
        databaseOperation(type, this, options);
        this.calls.push(['delete', ids, options]);
        if (this.cancelDelete) return [];
        const removed = this.items.filter(i => ids.includes(i.id)); this.items = this.items.filter(i => !ids.includes(i.id)); return removed;
    }
}
const node = (nodeId = '1', title = 'Ability') => ({ id: nodeId, title, desc: `<p>${title}</p>`, state: 'unlocked' });
const tree = (key = 'valdor', nodes = [node()], extra = {}) => ({ id: key, nodes, ...extra });
const payload = (collection, data, version = 1) => ({ ok: true, campaignId: C, collection, source: 'kv', version, data });
const snapshot = (trees = [tree()], states = [], version = 1) => validateSkillTreeSnapshot(payload('skill-trees', trees, version), payload('skill-tree-states', states, version), C);
const state = (treeKey = 'valdor', unlocked = ['1'], updatedAt = '2026-09-01T00:00:00Z', characterId = 'valdor') => ({
    id: `${C}-${treeKey}-${characterId}`, key: `${C}-${treeKey}-${characterId}`, treeKey, characterId, unlocked, updatedAt, levels: {}
});
function buildItem(n, t, key, level) {
    return { name: n.title, img: n.icon || 'icons/svg/aura.svg', type: 'feat', effects: [],
        system: { description: { value: `${n.desc || ''}<hr>${t.id}/${level}` }, activities: { base: { type: 'utility' } }, uses: { spent: 0, max: '' } },
        flags: { [M]: { skillTree: { treeKey: key, nodeId: String(n.id), level } } } };
}
function owned(title = 'Ability', treeKey = 'valdor', nodeId = '1') {
    const d = buildItem(node(nodeId, title), tree(treeKey), treeKey, 1);
    d.system.uses = { spent: 3, max: '5', recovery: [{ period: 'lr' }] };
    d.system.activities = { configured: { type: 'attack', consumption: { targets: ['resource'] } } };
    d.flags['khuzoe-automations'] = { version: '0.24.0', macro: 'keep' };
    d.flags['midi-qol'] = { onUseMacroName: 'macro' };
    d.effects = [{ _id: id(), name: 'Configured', disabled: false, system: { changes: [{ key: 'system.attributes.ac.bonus', value: 2 }] } }];
    return d;
}
function plan(actor, snap = snapshot(), entries = Object.entries(snap.trees).map(([key, tree]) => ({ key, tree }))) {
    return planSkillTreeActor({ actor, snapshot: snap, entries, characterId: actor.characterId, candidates: [actor.characterId], buildItem });
}
const apply = (p, actors = [p.actor], canWrite = () => true) => applySkillTreeActorPlan(p, { canWrite, effectActors: () => actors });

test('individual state selects latest duplicate; explicit empty overrides defaults', () => {
    const old = state(), newest = state('valdor', [], '2026-09-10T00:00:00Z');
    const selected = selectSkillTreeState({ states: [old, newest], campaignId: C, treeKey: 'valdor', tree: tree(), characterId: 'valdor' });
    assert.equal(selected, newest);
    assert.equal(unlockedSkillTreeNodes(tree(), selected).size, 0);
    assert.deepEqual([...unlockedSkillTreeNodes(tree(), null)], ['1']);
});

test('exact state identifier precedes an alias record; unrelated characters do not match', () => {
    const exact = state();
    const alias = { ...state('valdor', [], '2026-09-11T00:00:00Z'), id: 'alias', key: 'alias', characterId: 'Sommo' };
    assert.equal(selectSkillTreeState({ states: [alias, state('valdor', [], undefined, 'other'), exact], campaignId: C,
        treeKey: 'valdor', tree: tree(), characterId: 'valdor', candidates: ['Sommo'] }), exact);
});

test('shared trees merge grants as the website does', () => {
    const s = [{ ...state('shared-tree', ['1']), shared: true }, { ...state('shared-tree', ['2']), shared: true }];
    const selected = selectSkillTreeState({ states: s, campaignId: C, treeKey: 'shared-tree', tree: { shared: true }, characterId: 'valdor' });
    assert.deepEqual(selected.unlocked, ['1', '2']);
});

test('archived trees and presentation-only group nodes are not imported', () => {
    const a = new Actor();
    const p = plan(a, snapshot([tree('valdor', [node(), { ...node('group'), type: 'group' }]), tree('old', [node('2')], { archived: true })]));
    assert.equal(p.create.length, 1);
    assert.equal(isArchivedSkillTree({ archived: false, disabled: true }), false);
    assert.equal(isArchivedSkillTree({ status: 'archiviato' }), true);
});

test('level-specific title/description/icon are clamped without changing shared flavor', () => {
    const n = { ...node(), flavor: 'Shared', levels: [{ desc: 'ignored first level' }, { title: 'Advanced', description: '<p>Second</p>', icon: 'second.webp', flavor: 'ignored' }] };
    assert.equal(skillNodeAtLevel(n, 99).title, 'Advanced');
    assert.equal(skillNodeAtLevel(n, 99).level, 2);
    assert.equal(skillNodeAtLevel(n, 99).flavor, 'Shared');
    assert.equal(skillNodeAtLevel(n, -1).desc, n.desc);
});

test('invalid or fallback payloads never become an authoritative empty selection', () => {
    const t = payload('skill-trees', [tree()]), s = payload('skill-tree-states', []);
    for (const invalid of [null, [], { ...t, ok: false }, { ...t, source: 'static' }, { ...t, campaignId: 'other' }, { ...t, data: [{}] },
        { ...t, data: [tree(), tree()] }, { ...t, data: [tree('valdor', [node(), node()])] }]) {
        assert.throws(() => validateSkillTreeSnapshot(invalid, s, C));
    }
    for (const invalid of [{}, { ...s, source: 'static' }, { ...s, source: 'unknown' }, { ...s, source: 'd1', campaignId: 'other' },
        { ...s, source: 'd1', data: null }, { ...s, data: {} }, { ...s, data: [{ treeKey: 'valdor' }] }, { ...s, data: [{ ...state(), unlocked: null }] }]) {
        assert.throws(() => validateSkillTreeSnapshot(t, invalid, C));
    }
    assert.deepEqual(snapshot([], []).trees, {});
});

test('KV and D1 authoritative snapshots preserve grants, levels and revisions in every combination', () => {
    const states = [{ ...state(), levels: { '1': 2 } }];
    for (const treeSource of ['kv', 'd1']) for (const stateSource of ['kv', 'd1']) {
        const treesPayload = { ...payload('skill-trees', [tree()], 31), source: treeSource };
        const statesPayload = { ...payload('skill-tree-states', states, 166), source: stateSource, stateRevisions: { [states[0].id]: 3 } };
        const result = validateSkillTreeSnapshot(treesPayload, statesPayload, C);
        assert.deepEqual(result.states, states);
        assert.equal(result.treeVersion, 31); assert.equal(result.stateVersion, 166);
        assert.deepEqual(result.trees.valdor.nodes, treesPayload.data[0].nodes);
    }
});

test('updates preserve activities, counters, automation flags, effects and custom image; repeat is a no-op', async () => {
    const a = new Actor('Valdor', [owned()]);
    a.items[0].img = 'custom.webp';
    const before = a.items[0].toObject();
    const snap = snapshot([tree('valdor', [node('1', 'Updated')])]);
    const p = plan(a, snap); await apply(p);
    const after = a.items[0].toObject();
    assert.equal(after.name, 'Updated');
    assert.equal(after.img, 'custom.webp');
    assert.deepEqual(after.system.activities, before.system.activities);
    assert.deepEqual(after.system.uses, before.system.uses);
    assert.deepEqual(after.flags['khuzoe-automations'], before.flags['khuzoe-automations']);
    assert.deepEqual(after.flags['midi-qol'], before.flags['midi-qol']);
    assert.deepEqual(after.effects, before.effects);
    assert.equal(after.flags[M].skillTree.sources[0].campaignId, C);
    const repeat = plan(a, snap), calls = a.calls.length;
    assert.equal(repeat.update.length + repeat.create.length + repeat.retire.length, 0);
    await apply(repeat); assert.equal(a.calls.length, calls);
});

test('manual same-name capacity is neither adopted nor duplicated', async () => {
    const data = owned(); delete data.flags[M];
    const a = new Actor('Valdor', [data]); const original = a.items[0].toObject();
    const p = plan(a); assert.equal(p.create.length + p.update.length + p.retire.length, 0);
    assert.equal(p.warnings[0].code, 'unlinked-name'); await apply(p);
    assert.deepEqual(a.items[0].toObject(), original);
});

test('Foundry operation reuse reproduces the reported error; retry preserves the already updated item', async () => {
    const a = new Actor('Valdor', [owned()]);
    const p = plan(a), originalId = a.items[0].id;
    const reused = { criptaWikiSyncCommand: true, criptaSkillTreeSync: true };
    await a.updateEmbeddedDocuments('Item', p.update, reused);
    assert.equal(reused.parentUuid, a.uuid);
    await assert.rejects(a.update({ [`flags.${M}.skillTreeSync`]: p.syncState }, reused), {
        message: 'Actor is not a valid embedded Document within the Actor Document'
    });
    const saved = a.items[0].toObject(), retry = plan(a);
    assert.equal(retry.create.length + retry.update.length + retry.retire.length, 0);
    await apply(retry);
    assert.equal(a.items.length, 1); assert.equal(a.items[0].id, originalId);
    assert.deepEqual(a.items[0].toObject(), saved);
    assert.deepEqual(a.flags[M].skillTreeSync, p.syncState);
    assert.equal(a.calls.length, 2); // Item update, then only the missing Actor metadata.
});

test('known legacy import is retired on archiving even when every tree is archived', async () => {
    const a = new Actor('Valdor', [owned()]);
    const p = plan(a, snapshot([tree('valdor', [node()], { archived: true })]));
    assert.equal(p.retire.length, 1); await apply(p);
    assert.equal(a.items.length, 0);
    assert.equal(Object.values(a.flags[M].skillTreeArchive)[0].status, 'retired');
});

test('retirement archives configuration, cleans linked effects only and restores same item with spent uses', async () => {
    const a = new Actor('Valdor', [owned()]), other = new Actor('Other');
    const original = a.items[0].toObject(), originalId = a.items[0].id;
    await apply(plan(a));
    const linked = new Effect({ name: 'Linked buff', origin: `${a.items[0].uuid}.Activity.configured`, disabled: false }, other);
    const unrelated = new Effect({ name: 'Unrelated', origin: 'Actor.Other.Item.Unrelated', disabled: false }, other);
    const child = new Effect({ name: 'Child', flags: { dnd5e: { dependentOn: linked.uuid } }, disabled: false }, other);
    other.effects = [linked, unrelated, child];
    assert.equal(collectSkillTreeEffects(a.items[0], [a, other]).length, 2);
    await apply(plan(a, snapshot([tree()], [state('valdor', [])], 2)), [a, other]);
    assert.equal(a.items.length, 0); assert.equal(linked.disabled, true); assert.equal(child.disabled, true); assert.equal(unrelated.disabled, false);
    const backup = a.flags[M].skillTreeArchive[originalId];
    assert.equal(backup.effects.length, 2); assert.equal(backup.item.system.uses.spent, 3);
    await apply(plan(a, snapshot([tree()], [state()], 3)), [a, other]);
    assert.equal(a.items[0].id, originalId); assert.equal(a.items[0].system.uses.spent, 3);
    assert.deepEqual(a.items[0].system.activities, original.system.activities);
    assert.equal(linked.disabled, true); // Old temporary buffs are not reactivated on re-unlock.
    assert.equal(a.flags[M].skillTreeArchive[originalId].status, 'restored');
});

test('failed backup does not delete the item or disable effects', async () => {
    const a = new Actor('Valdor', [owned()]); a.failArchive = true;
    const e = new Effect({ name: 'Buff', origin: a.items[0].uuid, disabled: false }, a); a.effects = [e];
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])]))), /archive failed/);
    assert.equal(a.items.length, 1); assert.equal(e.disabled, false); assert.equal(a.calls.length, 0);
});

test('silent backup veto also prevents deletion', async () => {
    const a = new Actor('Valdor', [owned()]); a.cancelArchive = true;
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])]))), /non salvata/);
    assert.equal(a.items.length, 1); assert.equal(a.calls.length, 0);
});

test('retry after a veto archives the latest configuration and spent counter', async () => {
    const a = new Actor('Valdor', [owned()]); a.cancelDelete = true;
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])]))));
    a.items[0].system.uses.spent = 4;
    a.items[0].flags['midi-qol'].onUseMacroName = 'newer macro'; a.cancelDelete = false;
    await apply(plan(a, snapshot([tree()], [state('valdor', [])])));
    await apply(plan(a, snapshot([tree()], [state()], 2)));
    assert.equal(a.items[0].system.uses.spent, 4);
    assert.equal(a.items[0].flags['midi-qol'].onUseMacroName, 'newer macro');
});

test('effect veto prevents deletion, and deletion veto leaves a recoverable pending copy', async () => {
    const a = new Actor('Valdor', [owned()]);
    const e = new Effect({ name: 'Buff', origin: a.items[0].uuid, disabled: false }, a); e.cancelUpdate = true; a.effects = [e];
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])]))), /disattivare/);
    assert.equal(a.items.length, 1); assert.ok(Object.values(a.flags[M].skillTreeArchive).length);
    e.cancelUpdate = false; a.cancelDelete = true;
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])]))), /Rimozione annullata/);
    assert.equal(a.items.length, 1); assert.equal(Object.values(a.flags[M].skillTreeArchive)[0].status, 'pending');
});

test('failure after item deletion can restore from a pending archive', async () => {
    const a = new Actor('Valdor', [owned()]); await apply(plan(a));
    await apply(plan(a, snapshot([tree()], [state('valdor', [])], 2)));
    Object.values(a.flags[M].skillTreeArchive)[0].status = 'pending';
    await apply(plan(a, snapshot([tree()], [state()], 3)));
    assert.equal(a.items.length, 1); assert.equal(a.items[0].system.uses.spent, 3);
});

test('foreign campaign sources and untraceable legacy items are never revoked', async () => {
    const current = owned(), foreign = owned('Other', 'other'), unknown = owned('Lost', 'lost');
    foreign.flags[M].skillTree.campaignId = 'another-campaign';
    const a = new Actor('Valdor', [current, foreign, unknown]);
    const p = plan(a, snapshot([tree()], [state('valdor', [])]));
    assert.deepEqual(p.retire.map(i => i.name), ['Ability']);
    assert.ok(p.warnings.some(w => w.code === 'unresolved-origin' && w.name === 'Lost'));
    await apply(p); assert.deepEqual(a.items.map(i => i.name), ['Other', 'Lost']);
});

test('migrated imports are revoked when their tree disappears entirely', async () => {
    const a = new Actor('Valdor', [owned()]); await apply(plan(a));
    const p = plan(a, snapshot([], [], 2), []); assert.equal(p.retire.length, 1); await apply(p); assert.equal(a.items.length, 0);
});

test('one ability granted by multiple trees remains until its last grant is removed', async () => {
    const a = new Actor();
    const n = { ...node(), abilityId: 'shared-ability' };
    let snap = snapshot([tree('valdor', [n]), tree('second', [n])]);
    await apply(plan(a, snap)); assert.equal(a.items.length, 1);
    assert.equal(a.items[0].flags[M].skillTree.sources.length, 2);
    snap = snapshot([tree('valdor', [n], { archived: true }), tree('second', [n])], [], 2);
    await apply(plan(a, snap)); assert.equal(a.items.length, 1); assert.equal(a.items[0].flags[M].skillTree.sources.length, 1);
    snap = snapshot([tree('valdor', [n], { archived: true }), tree('second', [n], { archived: true })], [], 3);
    await apply(plan(a, snap)); assert.equal(a.items.length, 0);
});

test('duplicate managed copies are reported without dropping custom configurations', () => {
    const a = new Actor('Valdor', [owned(), owned()]); const p = plan(a);
    assert.equal(p.retire.length, 0); assert.ok(p.warnings.some(w => w.code === 'duplicate-managed'));
});

test('stale revisions and dangling unlocked node IDs fail before actor mutations', () => {
    const a = new Actor('Valdor', [owned()]); a.flags[M] = { skillTreeSync: { campaignId: C, treeVersion: 5, stateVersion: 5 } };
    assert.throws(() => plan(a), /precedenti/);
    a.flags = {};
    assert.throws(() => plan(a, snapshot([tree()], [state('valdor', ['missing'])])), /senza nodo/);
    assert.equal(a.calls.length, 0);
});

test('only the elected GM may write; loss of authority interrupts before the next mutation', async () => {
    const first = { id: 'a', active: true, isGM: true }, second = { id: 'b', active: true, isGM: true };
    assert.equal(isSkillTreeSyncLeader({ user: first, users: [second, first] }), true);
    assert.equal(isSkillTreeSyncLeader({ user: second, users: [second, first] }), false);
    const users = [first, second]; users.activeGM = second;
    assert.equal(isSkillTreeSyncLeader({ user: first, users }), false);
    assert.equal(isSkillTreeSyncLeader({ user: { id: 'p', isGM: false }, users }), false);
    const a = new Actor('Valdor', [owned()]);
    await assert.rejects(apply(plan(a, snapshot([tree()], [state('valdor', [])])), [a], () => a.calls.length === 0), /autorità/);
    assert.equal(a.items.length, 1); assert.equal(a.calls.length, 1); // Backup only.
});

test('concurrent requests serialize and re-fetch once after an in-flight change; failure is retryable', async () => {
    let release, runs = 0, concurrent = 0, maximum = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const queue = createSkillTreeSyncQueue(async () => {
        runs++; concurrent++; maximum = Math.max(maximum, concurrent);
        if (runs === 1) await gate;
        concurrent--; return runs;
    });
    const a = queue(), b = queue(), c = queue(); release();
    assert.deepEqual(await Promise.all([a, b, c]), [2, 2, 2]); assert.equal(maximum, 1); assert.equal(runs, 2);
    let failed = true; const retry = createSkillTreeSyncQueue(async () => { if (failed) throw new Error('offline'); return 'ok'; });
    await assert.rejects(retry(), /offline/); failed = false; assert.equal(await retry(), 'ok');
});

// Exercise the actual entry points in main.js without booting Foundry or connecting to a world.
const main = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf8');
function definition(start, end) { const a = main.indexOf(start); assert.ok(a >= 0); const b = main.indexOf(end, a); assert.ok(b > a); return main.slice(a, b); }
function integration({ actors = [], canPull = true, failFetch = false, trees = [tree()], states = [], badStates = false, treeSource = 'kv', stateSource = 'kv' } = {}) {
    const gm = { id: 'gm', isGM: true, active: true }, users = [gm]; users.activeGM = gm;
    const context = vm.createContext({ MODULE_ID: M, DISCORD_WORKER_URL: 'https://example.invalid', game: { user: gm, users, actors, scenes: [] },
        getCampaignId: () => C, canPullFromWorker: () => canPull, getActorSkillTreeCandidateIds: a => [a.characterId],
        getPreferredSkillTreeCharacterId: a => a.characterId, getCachedWikiSkillTrees: () => null,
        normalizeWikiItemKey, slugify, isArchivedSkillTree, isSharedSkillTree, isSkillTreeSyncLeader,
        planSkillTreeActor, validateSkillTreeSnapshot, applySkillTreeActorPlan, summarizeSkillTreePlans,
        buildFoundryItemFromSkillTreeNode: buildItem, skillTreesCache: {}, URL, AbortSignal,
        lastSkillTreeSyncReport: null, lastSkillTreeWarningSignature: '', ui: { notifications: { warn() {} } }, console: { info() {} },
        fetchPublicJson: async url => {
            if (failFetch) throw new Error('offline');
            const collection = new URL(url).pathname.split('/').at(-1);
            if (badStates && collection === 'skill-tree-states') return { data: [] };
            return { ...payload(collection, collection === 'skill-trees' ? trees : states), source: collection === 'skill-trees' ? treeSource : stateSource };
        }
    });
    vm.runInContext([
        definition('function getSkillTreeOwnerIds(', 'function resolveSkillTreeNodeImage('),
        definition('async function loadAuthoritativeSkillTreeSnapshot(', 'async function showSkillTreeSyncPreview('),
        definition('async function reconcileSkillTreeAbilities(', 'const runSkillTreeSync =')
    ].join('\n'), context);
    return context;
}

test('actual main preview is read-only; actual reconcile uses only non-archived trees', async () => {
    const a = new Actor('Valdor', [owned()]);
    const ctx = integration({ actors: [a], trees: [tree('valdor', [node()], { archived: true })] });
    assert.equal((await ctx.previewSkillTreeSync()).retired, 1); assert.equal(a.calls.length, 0);
    const result = await ctx.reconcileSkillTreeAbilities(); assert.equal(result.retired, 1); assert.equal(a.items.length, 0);
});

test('actual main respects disabled pull mode and never writes on network/schema failure', async () => {
    for (const settings of [{ canPull: false }, { failFetch: true }, { badStates: true }, { stateSource: 'static' }, { treeSource: 'unknown' }]) {
        const a = new Actor('Valdor', [owned()]); const ctx = integration({ actors: [a], ...settings });
        if (settings.canPull === false) assert.equal(await ctx.reconcileSkillTreeAbilities(), false);
        else await assert.rejects(ctx.reconcileSkillTreeAbilities());
        assert.equal(a.calls.length, 0); assert.equal(a.items.length, 1);
    }
});

test('actual main reads migrated D1 states and future D1 trees through the same endpoints', async () => {
    for (const treeSource of ['kv', 'd1']) {
        const a = new Actor('Valdor', [owned()]);
        const ctx = integration({ actors: [a], trees: [tree('valdor', [node('1', 'D1 update')])], states: [state()], treeSource, stateSource: 'd1' });
        assert.equal((await ctx.previewSkillTreeSync()).updated, 1); assert.equal(a.calls.length, 0);
        assert.equal((await ctx.reconcileSkillTreeAbilities()).updated, 1);
        assert.equal(a.items[0].name, 'D1 update');
        assert.equal((await ctx.reconcileSkillTreeAbilities()).updated, 0);
    }
});

test('actual main can update, retire and create abilities across actors without leaking document context', async () => {
    const a = new Actor('Valdor', [owned()]);
    const b = new Actor('Retired', [owned('Old', 'retired')]);
    const c = new Actor('New');
    const other = new Actor('Effect owner');
    const buff = new Effect({ name: 'Old buff', origin: b.items[0].uuid, disabled: false }, other);
    other.effects.push(buff);
    const ctx = integration({ actors: [a, b, c, other], trees: [tree(), tree('retired', [node('1', 'Old')], { archived: true }), tree('new')] });
    const result = await ctx.reconcileSkillTreeAbilities();
    assert.equal(result.updated, 1); assert.equal(result.retired, 1); assert.equal(result.created, 1);
    assert.equal(a.items.length, 1); assert.equal(b.items.length, 0); assert.equal(c.items.length, 1);
    assert.equal(buff.disabled, true);
    assert.equal(Object.values(b.flags[M].skillTreeArchive)[0].status, 'retired');
    const calls = [a, b, c, other].map(actor => actor.calls.length);
    const repeat = await ctx.reconcileSkillTreeAbilities();
    assert.equal(repeat.created + repeat.updated + repeat.retired, 0);
    assert.deepEqual([a, b, c, other].map(actor => actor.calls.length), calls);
});

test('actual main plans all actors before mutation and excludes summoned/polymorphed copies', async () => {
    const a = new Actor(), b = new Actor('Other');
    const ctx = integration({ actors: [a, b], trees: [tree(), tree('other')], states: [state('other', ['bad'], undefined, 'other')] });
    await assert.rejects(ctx.reconcileSkillTreeAbilities()); assert.equal(a.calls.length, 0);
    const summoned = new Actor(), transformed = new Actor(); summoned.flags.dnd5e = { summonedCopy: true }; transformed.isPolymorphed = true;
    const excluded = integration({ actors: [summoned, transformed] });
    assert.equal((await excluded.previewSkillTreeSync()).created, 0);
});

test('actual main handles an emptied tree and latest duplicate state as in the campaign', async () => {
    const a = new Actor('Valdor', [owned()]);
    const empty = integration({ actors: [a], trees: [tree('valdor', [])], states: [state('valdor', [])] });
    assert.equal((await empty.previewSkillTreeSync()).retired, 1);
    const g = new Actor('Garun');
    const active = ['Impulso Premonitore', 'Premonizione Ripetuta', "Forma d’Incubo", 'Lama Necrotica'].map((name, i) => node(String(i + 1), name));
    const ctx = integration({ actors: [g], trees: [tree('garun', active)], states: [state('garun', ['1','2'], '2026-06-06', 'garun'), state('garun', ['1','2','3','4'], '2026-08-01', 'garun')] });
    assert.equal((await ctx.reconcileSkillTreeAbilities()).created, 4);
});
