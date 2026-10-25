import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DocumentOwnershipField} from '../../../../App/resources/app/common/data/fields.mjs';

// Execute Foundry's actual ownership cleaning and installed verification in
// memory. No world, Actor, token, settings, Worker or KV data is accessed.
const source = fs.readFileSync(new URL('../scripts/services/managed-actor-sync.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const ctx = vm.createContext({console, Map, Set, MODULE_ID: 'cripta-wiki-sync',
    foundry: {utils: {deepClone: clone}}});
vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.verify = verifyManagedActorLinkNativeDocument; globalThis.comparable = managedActorLinkNativeDocumentComparable;', ctx);
const item = (id = 'one') => ({_id: id, name: 'Capacità ' + id, type: 'feat', system: {uses: {spent: 0}, activities: {attack: {_id: 'attack', damage: {formula: '2d6'}}}}, flags: {custom: {keep: true}}, effects: []});
const actor = items => ({_id: 'npc', name: 'NPC', type: 'npc', items, effects: [], system: {attributes: {hp: {value: 40}}}});
const verify = (expected, actual) => ctx.verify({toJSON: () => clone(actual)}, expected);

test('Foundry really inserts default NONE for an absent or empty ownership field', () => {
    const field = new DocumentOwnershipField();
    assert.deepEqual(field.clean(undefined, {partial: false}), {default: 0});
    assert.deepEqual(field.clean({}, {partial: false}), {default: 0});
});
test('all 19 reported ability defaults pass the complete native verification', () => {
    const expected = actor(Array.from({length: 19}, (_, index) => item(String(index))));
    const actual = clone(expected), field = new DocumentOwnershipField();
    actual.items.forEach(entry => {entry.ownership = field.clean(undefined, {partial: false});});
    const before = clone(expected), persisted = clone(actual);
    assert.equal(verify(expected, actual).ok, true);
    assert.deepEqual(expected, before); assert.deepEqual(actual, persisted);
    assert.equal(verify(actual, expected).ok, true);
});
test('empty ownership and the actual Foundry default are equivalent', () => {
    const expected = actor([{...item(), ownership: {}}]);
    const actual = actor([{...item(), ownership: {default: 0}}]);
    assert.equal(verify(expected, actual).ok, true);
});
test('nonzero default permissions are still checked', () => {
    for (const level of [-1, 1, 2, 3]) {
        const result = verify(actor([item()]), actor([{...item(), ownership: {default: level}}]));
        assert.equal(result.ok, false); assert.ok(result.summary.some(label => label.includes('ownership')));
    }
});
test('permission mappings are not mistaken for empty objects', () => {
    const ownership = new Map([['default', 0], ['user000000000001', 3]]);
    const comparable = ctx.comparable(actor([{...item(), ownership}]));
    assert.deepEqual(clone(comparable.items[0].ownership), {default: 0, user000000000001: 3});
});
test('explicit per-user permissions are never swallowed by default normalization', () => {
    const expected = actor([{...item(), ownership: {default: 0, user000000000001: 3}}]);
    assert.equal(verify(expected, expected).ok, true);
    for (const ownership of [{default: 0}, {default: 0, user000000000001: 0}]) {
        assert.equal(verify(expected, actor([{...item(), ownership}])).ok, false);
    }
});
test('malformed ownership values do not become valid defaults', () => {
    for (const ownership of [null, false, [], {default: '0'}, {custom: 0}]) {
        const actual = actor([{...item(), ownership}]);
        assert.deepEqual(clone(ctx.comparable(actual).items[0].ownership), ownership);
        assert.equal(verify(actor([{...item(), ownership: {default: 3}}]), actual).ok, false);
    }
});
test('system or module data named ownership still compares exactly', () => {
    const expected = actor([item()]), actual = clone(expected);
    actual.items[0].system.ownership = {default: 0};
    assert.equal(verify(expected, actual).ok, false);
    delete actual.items[0].system.ownership; actual.items[0].flags.custom.ownership = {default: 0};
    assert.equal(verify(expected, actual).ok, false);
});
test('missing items, changed damage, spent uses, effects and flags still fail', () => {
    const expected = actor([item()]);
    for (const change of [
        actual => {actual.items = [];},
        actual => {actual.items[0].system.activities.attack.damage.formula = '1d6';},
        actual => {actual.items[0].system.uses.spent = 1;},
        actual => {actual.items[0].effects.push({_id: 'effect', changes: [{key: 'system.attributes.ac.bonus', value: '3'}]});},
        actual => {delete actual.items[0].flags.custom.keep;},
        actual => {actual.system.attributes.hp.value = 30;}
    ]) {const actual = clone(expected); actual.items[0].ownership = {default: 0}; change(actual); assert.equal(verify(expected, actual).ok, false);}
});
