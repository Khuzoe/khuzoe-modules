import assert from 'node:assert/strict';
import {changeGinevraCharges, getGinevraCharges, setGinevraCharges, registerGinevraChargesApi, registerGinevraChargesSocket} from '../scripts/ginevra-charges.mjs';
import {readEnergy, writeEnergy} from '../../energia-radiosa/radiance.mjs';

const MODULE = 'khuzoe-automations';
const gm = {id: 'gm', isGM: true, active: true};
const owner = {id: 'owner', isGM: false, active: true};
const observer = {id: 'observer', isGM: false, active: true};
const users = new Map([gm, owner, observer].map(user => [user.id, user]));
users.activeGM = gm;
const module = {active: true, api: {existing: true}};
globalThis.game = {user: gm, users, modules: new Map([[MODULE, module]])};
let handler, pendingRequest, effectNumber = 0, actorWrites = 0;
globalThis.socketlib = {registerModule: () => ({
  register: (_name, callback) => { handler = callback; },
  executeAsUser: (name, target, payload) => new Promise(resolve => { pendingRequest = {name, target, payload, resolve}; })
})};
function applyChanges(document, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split('.'), key = parts.pop();
    parts.reduce((root, part) => root[part] ??= {}, document)[key] = structuredClone(value);
  }
}
const actor = {id: 'garun', documentName: 'Actor', uuid: 'Actor.garun', isOwner: true,
  items: [], effects: [], flags: {'energia-radiosa': {value: 7, minimum: 0, maximum: 10}},
  getFlag(scope, key) { return this.flags[scope]?.[key]; },
  async setFlag(scope, key, value) { actorWrites++; this.flags[scope][key] = value; },
  testUserPermission(user, level) { return level === 'OWNER' && user.id === owner.id; }
};
const item = {uuid: 'Actor.garun.Item.ginevra', name: 'Abbraccio di Ginevra', img: 'icon.webp',
  system: {identifier: 'abbraccio-di-ginevra'}};
actor.items.push(item);
globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
globalThis.cat = {utils: {
  effectUtils: {createEffects: async (actor, entries) => {
    for (const entry of entries) {
      const effect = {...structuredClone(entry), parent: actor, id: `effect${++effectNumber}`};
      effect.update = async changes => { await Promise.resolve(); applyChanges(effect, changes); };
      actor.effects.push(effect);
    }
  }},
  documentUtils: {deleteDocument: async effect => { actor.effects = actor.effects.filter(candidate => candidate !== effect); }}
}};
registerGinevraChargesApi();
registerGinevraChargesSocket();
assert.equal(module.api.existing, true, 'Existing module APIs survive registration');
assert.equal(module.api.ginevra.get, getGinevraCharges);
assert.equal(readEnergy(actor).source, 'ginevra', 'An existing association selects Ginevra automatically');
assert.equal(readEnergy(actor).value, 0, 'The old widget counter does not leak into the buff');
assert.equal(readEnergy(actor).editable, false);
assert.equal(readEnergy(actor).status, 'Abbraccio non attivo');
await assert.rejects(writeEnergy(actor, 20), /non attivo/);
const activate = () => changeGinevraCharges(actor, 'activate', {itemUuid: item.uuid});
await activate();
await writeEnergy(actor, 35);
assert.equal(getGinevraCharges(actor).value, 35);
assert.equal(actor.effects[0].name, 'Abbraccio di Ginevra (35/100)');
assert.equal(actorWrites, 0, 'Linked changes never copy charges into Actor flags');
// Existing buffs can repair the deprecated DAE field without restarting the
// effect, losing charges or changing unrelated bonuses, duration or ownership.
const legacyBuff = actor.effects[0];
const originalDuration = structuredClone(legacyBuff.duration);
const unrelatedChange = {key: 'system.attributes.ac.bonus', type: 'add', value: '1', priority: 30};
legacyBuff.system.changes = [
  {key: 'system.traits.dr.all', type: 'custom', value: '1', priority: 20}, unrelatedChange
];
legacyBuff.flags[MODULE].processed = ['prior-hit'];
await writeEnergy(actor, 35);
assert.equal(actor.effects[0], legacyBuff);
assert.equal(readEnergy(actor).value, 35, 'Saving the same count repairs the effect without spending or granting charges');
assert.deepEqual(legacyBuff.system.changes, [
  {key: 'system.traits.dr.value', type: 'add', value: 'ALL', priority: 20}, unrelatedChange
]);
assert.deepEqual(legacyBuff.duration, originalDuration);
assert.deepEqual(legacyBuff.flags[MODULE].processed, ['prior-hit']);
assert.equal(legacyBuff.origin, item.uuid);
const stale = readEnergy(actor);
const collect = (amount, workflowId) => changeGinevraCharges(actor, 'collect', {
  itemUuid: item.uuid, effectId: actor.effects[0].id, amount, workflowId
});
const results = await Promise.allSettled([collect(10, 'hit1'), collect(10, 'hit1'), writeEnergy(actor, 20, stale)]);
assert.equal(results[2].status, 'rejected');
assert.match(results[2].reason.message, /cariche sono cambiate/);
assert.equal(getGinevraCharges(actor).value, 45, 'A stale manual edit cannot erase concurrent damage; duplicate workflows count once');
await writeEnergy(actor, 61);
const spending = await Promise.all([collect(12, 'hit2'), changeGinevraCharges(actor, 'reserve', {
  itemUuid: item.uuid, effectId: actor.effects[0].id
})]);
assert.equal(spending[1].charges, 73, 'The spending action sees the manually edited charge pool and prior damage');
assert.equal(readEnergy(actor).value, 0);
await Promise.all([collect(5, 'hit3'), changeGinevraCharges(actor, 'refund', {
  itemUuid: item.uuid, effectId: spending[1].effectId, amount: spending[1].charges
})]);
assert.equal(readEnergy(actor).value, 78, 'A canceled action refunds into the same pool without losing new damage');
await writeEnergy(actor, 200);
assert.equal(readEnergy(actor).value, 100);
await writeEnergy(actor, -10);
assert.equal(readEnergy(actor).value, 0);
await assert.rejects(setGinevraCharges(actor, 1.5), /numero intero/);
actor.effects[0].disabled = true;
assert.equal(readEnergy(actor).editable, false);
await assert.rejects(writeEnergy(actor, 10), /non attivo/);
actor.effects[0].disabled = false;
actor.effects[0].duration.expired = true;
assert.equal(readEnergy(actor).value, 0);
assert.equal(readEnergy(actor).editable, false);
actor.effects[0].duration.expired = false;
const oldEffect = readEnergy(actor);
await activate();
await assert.rejects(writeEnergy(actor, 20, oldEffect), /riattivato/);
assert.equal(actor.effects.length, 1);
assert.equal(readEnergy(actor).value, 0);

game.user = owner;
const remote = setGinevraCharges(actor, 25);
assert.equal(pendingRequest.target, gm.id, 'The owner delegates writes to the same authority as damage collection');
game.user = gm;
const reply = await handler.call({socketdata: {userId: owner.id}}, pendingRequest.payload);
pendingRequest.resolve(reply);
await remote;
assert.equal(readEnergy(actor).value, 25);
game.user = owner;
const concurrentRemote = setGinevraCharges(actor, 30);
game.user = gm;
const [_, conflict] = await Promise.all([collect(5, 'gm-hit'), handler.call({socketdata: {userId: owner.id}}, pendingRequest.payload)]);
pendingRequest.resolve(conflict);
await assert.rejects(concurrentRemote, /cariche sono cambiate/);
assert.equal(readEnergy(actor).value, 30, 'The GM and player share one lock across socket requests');
const denied = await handler.call({socketdata: {userId: observer.id}}, {...pendingRequest.payload,
  data: {...pendingRequest.payload.data, userId: gm.id, expectedValue: 30, value: 90}});
assert.equal(denied.ok, false, 'The socket validates the sender instead of a user supplied in the payload');
assert.equal(readEnergy(actor).value, 30);
game.user = observer;
await assert.rejects(setGinevraCharges(actor, 20), /permesso/);
game.user = gm;
actor.effects = [];
assert.equal(readEnergy(actor).status, 'Abbraccio non attivo');
assert.equal(readEnergy(actor).value, 0);
module.active = false;
assert.equal(readEnergy(actor).editable, false, 'A missing automation API cannot fall back to an unrelated manual counter');
module.active = true;
globalThis.foundry = {applications: {api: {ApplicationV2: class {}, HandlebarsApplicationMixin: base => base}}};
const {EnergyConfig} = await import('../../energia-radiosa/config.mjs');
game.actors = new Map([[actor.id, actor]]);
game.settings = {set: async (_scope, _key, id) => { assert.equal(id, actor.id); }};
actor.update = async changes => applyChanges(actor, changes);
const button = {}, form = {querySelector: () => button};
let closed = false;
await EnergyConfig.save.call({close: async () => { closed = true; }}, null, form,
  {object: {actor: actor.id, source: 'ginevra'}});
assert.equal(closed, true, 'Linked configuration saves even though disabled min/max fields are absent');
assert.equal(actor.flags['energia-radiosa'].value, 7, 'Linking the widget does not overwrite the old independent counter');
assert.equal(actor.flags['energia-radiosa'].maximum, 10);
actor.flags['energia-radiosa'].source = 'manual';
assert.equal(readEnergy(actor).value, 7);
await writeEnergy(actor, 8);
assert.equal(actorWrites, 1, 'The independent manual mode still works');
actor.items = [];
delete actor.flags['energia-radiosa'].source;
assert.equal(readEnergy(actor).source, 'manual', 'Other characters keep their manual counter');
users.activeGM = null;
gm.active = false;
await assert.rejects(changeGinevraCharges(actor, 'set', {}), /Gamemaster connesso/);
console.log('Widget Ginevra: stessa riserva, modifiche manuali, spesa, scadenza, permessi e concorrenza GM/giocatore verificati.');
