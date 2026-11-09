import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spendEmbraceCharges, collectEmbraceCharges} from '../scripts/ginevra.mjs';
import {registerGinevraChargesSocket} from '../scripts/ginevra-charges.mjs';

// Use the installed Midi DamageOnlyWorkflow, processDamageRoll and HP/temp-HP
// calculation. Only Foundry documents, user transport and the final database
// update are in-memory adapters. Never open or mutate an actual world.
const midi = await readFile(new URL('../../midi-qol/midi-qol.js', import.meta.url), 'utf8');
function functionCode(name) {
  let start = midi.indexOf(`async function ${name}(`);
  if (start < 0) start = midi.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Installed Midi function ${name}`);
  return midi.slice(start, midi.indexOf('\n}', start) + 2);
}
function compile(code, dependencies) {
  return new Function(...Object.keys(dependencies), `return (${code})`)(...Object.values(dependencies));
}
function put(target, path, value) {
  const parts = path.split('.'), leaf = parts.pop();
  parts.reduce((object, key) => object[key] ??= {}, target)[leaf] = value;
}
const get = (object, path) => path?.split('.').reduce((object, key) => object?.[key], object);
function mergeObject(target, source, {inplace = true} = {}) {
  if (!inplace) target = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && Object.getPrototypeOf(value) === Object.prototype) mergeObject(target[key] ??= {}, value);
    else target[key] = structuredClone(value);
  }
  return target;
}
const warnings = [], reactions = [], applied = [], cards = [], executions = [], saveUsers = [], errors = [];
const db = new Map(), socketHandlers = new Map();
let serial = 0, saveTotal = 10, failApplication = false, abort = false, omitDamage = false;
const gm = {id: 'gm', isGM: true, active: true}, player = {id: 'owner', active: true};
const users = new Map([[gm.id, gm], [player.id, player]]);
users.activeGM = gm;
globalThis.game = {user: gm, users, messages: new Map()};
globalThis.ui = {notifications: {warn: text => warnings.push(text)}};
globalThis.canvas = {scene: {id: 'test'}};
globalThis.fromUuid = async uuid => db.get(uuid);
globalThis.fromUuidSync = uuid => db.get(uuid);
globalThis.foundry = {utils: {deepClone: structuredClone, mergeObject, setProperty: put, getProperty: get,
  randomID: () => String(++serial).padStart(16, '0'), logCompatibilityWarning: assert.fail}};
Math.clamp ??= (number, min, max) => Math.min(max, Math.max(min, number));
const settings = {singleConcentrationRoll: true, autoApplyDamage: 'yesCard', autoCheckHit: 'all', waitForDamageApplication: true};
const garun = {documentName: 'Actor', uuid: 'Actor.garun', id: 'garun', name: 'Garun',
  items: [], effects: [], system: {attributes: {spell: {dc: 17}}},
  testUserPermission: user => user.id === player.id, getRollData: () => ({})};
const victim = {uuid: 'Actor.victim', id: 'victim', name: 'Bersaglio', effects: [], flags: {},
  system: {attributes: {hp: {value: 200, max: 200, temp: 0, get damage() { return Math.max(0, this.max - this.value); }}}},
  resistance: 1, healingMultiplier: 1,
  calculateDamage(damage, options) {
    assert.equal(options.ignore.resistance.size, 0, 'The ordinary target traits are preserved');
    return damage.map(part => ({...part, value: part.type === 'healing'
      ? Math.floor(part.value * this.healingMultiplier) * (options.invertHealing ? -1 : 1)
      : Math.floor(part.value * this.resistance)}));
  }, async rollSavingThrow() {
    saveUsers.push(game.user.id);
    assert.equal(effect.flags['khuzoe-automations'].charges, 0, 'Damage must use the amount reserved before the save');
    return Number.isFinite(saveTotal) ? [{total: saveTotal}] : null;
  }};
const source = {uuid: 'Scene.test.Token.garun', id: 'garun', actor: garun};
source.object = {document: source, actor: garun};
const target = {uuid: 'Scene.test.Token.victim', id: 'victim', actor: victim};
target.object = {document: target, actor: victim};
const item = {name: 'Abbraccio di Ginevra', uuid: 'Actor.garun.Item.ginevra', img: 'icon.webp', actor: garun,
  system: {identifier: 'abbraccio-di-ginevra'}};
garun.items.push(item);
const effect = {id: 'embrace', parent: garun, origin: item.uuid, name: 'Abbraccio di Ginevra (25/100)',
  flags: {cat: {identifier: 'khuzoe-ginevra-embrace'}, 'khuzoe-automations': {charges: 25}},
  async update(changes) { for (const [path, value] of Object.entries(changes)) put(this, path, value); }};
garun.effects.push(effect);
for (const document of [garun, victim, source, target]) db.set(document.uuid, document);
globalThis.cat = {utils: {queryUtils: {gmUser: () => gm}, actorUtils: {getFirstToken: () => source.object},
  tokenUtils: {getDistance: () => 20},
  workflowUtils: {syntheticActivityDataRoll: assert.fail}, itemUtils: {syntheticItem: assert.fail}}};
globalThis.socketlib = {registerModule: () => ({
  register: (name, callback) => socketHandlers.set(name, callback),
  async executeAsUser(name, userId, data) {
    const sender = game.user;
    game.user = users.get(userId);
    try { return await socketHandlers.get(name).call({socketdata: {userId: sender.id}}, data); }
    finally { game.user = sender; }
  }
})};
registerGinevraChargesSocket();
const mergeDamageDetail = damage => damage;
const setupDamageDetails = compile(functionCode('setupDamageDetails'), {mergeDamageDetail, configSettings: settings});
const processDamageRoll = compile(functionCode('processDamageRoll'), {
  debugEnabled: 0, warn: assert.fail, debug() {}, expireMyEffects: async () => {}, checkRule: () => false,
  getSaveMultiplierForActivity: () => 0.5, doReactions: async (token, sourceUuid, roll, type) => reactions.push({target: token.actor.uuid, type}),
  MODULE_ID: 'midi-qol', GameSystemConfig: {damageTypes: {radiant: {label: 'Radiant'}}},
  TroubleShooter: {recordError: error => errors.push(error)}, error2: assert.fail,
  mergeDamageDetail, setupDamageDetails, configSettings: settings, prepareDamageListToJSON: data => data,
  unTimedExecuteAsGM: assert.fail,
  timedAwaitExecuteAsGM: async (name, data) => {
    assert.equal(name, 'createReverseDamageCard');
    if (failApplication) throw Error('Simulated GM damage application failure');
    await Promise.resolve();
    for (const entry of data.damageList) {
      const actor = db.get(entry.actorUuid);
      if (entry.wasHit && data.autoApplyDamage.includes('yes')) {
        // Foundry database boundary: values were computed by native Midi.
        Object.assign(actor.system.attributes.hp, {value: entry.newHP, temp: entry.newTempHP});
        applied.push(entry);
      }
    }
    return ['ChatMessage.damage'];
  }
});
class NumericDamageRoll {
  constructor(formula, data, options) { Object.assign(this, {formula, total: Number(formula), options}); }
  async evaluate() { return this; }
}
class Item {
  constructor(data, {parent}) {
    this.actor = parent; this.name = data.name; this.type = data.type; this.flags = data.flags ?? {};
    this.system = {...data.system, activities: {contents: []}};
    for (const source of Object.values(data.system.activities)) {
      const activity = {...source, item: this, midiProperties: {...source.midiProperties, ignoreTraits: new Set()},
        async _createUsageMessage(config) { cards.push(config); return {uuid: `ChatMessage.${++serial}`}; }};
      this.system.activities.contents.push(activity);
    }
  }
  prepareData() {}
  prepareFinalAttributes() {}
}
globalThis.CONFIG = {Item: {documentClass: Item}, Dice: {DamageRoll: NumericDamageRoll}};
class WorkflowAdapter {
  constructor(actor, activity, speaker, targets, options) {
    this.actor = actor; this.item = activity.item; this.activity = activity; this.targets = targets;
    this.token = source.object; this.tokenUuid = source.uuid;
    this.workflowOptions = options.workflowOptions; this.semiSuperSavers = new Set(); this.superSavers = new Set();
    this.saves = new Set(); this.criticalSaves = new Set(); this.fumbleSaves = new Set();
    this.rollOptions = {}; this.aborted = abort;
    executions.push({userId: game.user.id, workflow: this});
  }
  async setDamageRolls(rolls) {
    this.damageRolls = rolls; this.damageRoll = rolls[0];
    this.rawDamageDetail = rolls.map(roll => ({value: roll.total, type: roll.options.type, properties: new Set()}));
    this.damageDetail = this.rawDamageDetail;
  }
  async processDamageRollBonusFlags(rolls) { return rolls; }
  async performState(state) { return state.call(this); }
  recordTargetACModifiers() {}
  async checkHits() {}
  async displayHits() {}
  async displayDamageRolls() {}
  async callDamageHooksAndMacros() {}
  async WorkflowState_AllRollsComplete() {
    if (this.aborted || omitDamage) return;
    await processDamageRoll(this, 'radiant');
    await collectEmbraceCharges({document: item, workflow: this});
  }
}
const classStart = midi.indexOf('DamageOnlyWorkflow = class');
const classEnd = midi.indexOf('\n    TrapWorkflow =', classStart);
assert.ok(classStart > 0 && classEnd > classStart);
const classCode = midi.slice(classStart + 'DamageOnlyWorkflow = '.length, classEnd).trim().replace(/;$/, '');
const DamageOnlyWorkflow = compile(classCode, {Workflow: WorkflowAdapter, __name: value => value,
  getToken: token => token.object ?? token, ChatMessage: {getSpeaker: () => ({})},
  GameSystemConfig: {damageTypes: {radiant: {label: 'Radiant'}}}, midiFlag2: key => `flags.midi-qol.${key}`,
  shiftOnlyEvent: {}, configSettings: settings, safeGetGameSetting: () => 'public'});
globalThis.MidiQOL = {DamageOnlyWorkflow, configSettings: () => settings, socket: () => ({
  async executeAsUser(name, userId) {
    assert.equal(name, 'rollAbilityV2', 'Only the defender save may be delegated, not another activity use');
    const sender = game.user;
    game.user = users.get(userId);
    try { return await victim.rollSavingThrow(); }
    finally { game.user = sender; }
  }
})};
const spend = (activityId = 'KhzGinDeath00001', recipient = target) => spendEmbraceCharges({document: item, workflow: {
  activity: {id: activityId}, token: source, targets: new Set([recipient])
}});
const charge = amount => { effect.flags['khuzoe-automations'].charges = amount; };
await spend();
assert.equal(victim.system.attributes.hp.value, 175, 'DM invocation reaches native Midi damage processing and HP updates');
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
assert.equal(executions.at(-1).userId, gm.id, 'The DM executes the damage even with the caster owner online');
assert.equal(saveUsers.length, 1, 'Exactly one save is rolled');
assert.equal(cards.at(-1).data.rolls[0].total, 25, 'The new card contains the evaluated damage roll');
assert.ok(executions.at(-1).workflow.workflowOptions.khuzoeGinevraSpending);
assert.equal(reactions.at(-1).target, victim.uuid, 'Midi target damage reactions still run');
charge(25); saveTotal = 18;
await spend();
assert.equal(victim.system.attributes.hp.value, 163, 'Successful save halves 25 to 12');
charge(25); saveTotal = 10; victim.resistance = 0.5;
await spend();
assert.equal(victim.system.attributes.hp.value, 151, 'Target resistance still applies after the save');
charge(25); victim.resistance = 0;
await spend();
assert.equal(victim.system.attributes.hp.value, 151);
assert.equal(effect.flags['khuzoe-automations'].charges, 0, 'Immunity consumes charges without being mistaken for a failed execution');
charge(25); victim.resistance = 1; victim.system.attributes.hp.temp = 10;
await spend();
assert.equal(victim.system.attributes.hp.temp, 0);
assert.equal(victim.system.attributes.hp.value, 136, 'Midi applies damage to temporary HP before ordinary HP');
charge(25); game.user = player;
await spend();
assert.equal(victim.system.attributes.hp.value, 111, 'Owner invocation also applies damage');
assert.equal(executions.at(-1).userId, player.id);
assert.equal(effect.flags['khuzoe-automations'].charges, 0, 'Spending never earns its own charges');
game.user = gm; charge(25); failApplication = true;
await assert.rejects(spend(), /Simulated GM damage application failure/);
assert.equal(victim.system.attributes.hp.value, 111);
assert.equal(effect.flags['khuzoe-automations'].charges, 25);
failApplication = false; abort = true;
await spend();
assert.equal(effect.flags['khuzoe-automations'].charges, 25, 'An aborted damage workflow refunds charges');
abort = false; omitDamage = true;
await spend();
assert.equal(effect.flags['khuzoe-automations'].charges, 25, 'A completed roll without a processed target refunds charges');
omitDamage = false; saveTotal = NaN;
const count = executions.length;
await spend();
assert.equal(executions.length, count, 'Canceling the save starts no damage workflow');
assert.equal(effect.flags['khuzoe-automations'].charges, 25);
charge(1); saveTotal = 18;
await spend();
assert.equal(executions.length, count, 'Zero damage after halving needs no damage workflow');
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
// Life must enter the same native processing chain with healing, without a
// second activity use or a save, and without reducing temporary HP.
const life = () => spend('KhzGinLife000001');
const savesBeforeLife = saveUsers.length;
victim.system.attributes.hp.value = 40;
victim.system.attributes.hp.temp = 10;
charge(25); game.user = gm;
await life();
assert.equal(victim.system.attributes.hp.value, 65, '25 charges restore 25 HP through native Midi');
assert.equal(victim.system.attributes.hp.temp, 10, 'Healing does not consume temporary HP');
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
assert.equal(cards.at(-1).data.rolls[0].options.type, 'healing');
assert.equal(cards.at(-1).data.rolls[0].total, 25);
assert.equal(executions.at(-1).userId, gm.id, 'The GM also executes healing with the owner online');
assert.equal(executions.at(-1).workflow.item.system.identifier, 'khuzoe-ginevra-life');
assert.equal(reactions.at(-1).type, 'reactionheal');
assert.equal(applied.at(-1).hpDamage, -25, 'Midi treats the amount as healing, not damage');
victim.system.attributes.hp.value = 190;
charge(25); game.user = player;
await life();
assert.equal(victim.system.attributes.hp.value, 200, 'Healing caps at maximum HP when invoked by the owner');
assert.equal(applied.at(-1).hpDamage, -10);
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
assert.equal(executions.at(-1).userId, player.id);
charge(25);
await life();
assert.equal(victim.system.attributes.hp.value, 200);
assert.equal(effect.flags['khuzoe-automations'].charges, 0, 'A full-HP target still constitutes a completed healing use');
victim.system.attributes.hp.value = 0;
charge(25);
await life();
assert.equal(victim.system.attributes.hp.value, 25, 'A target at zero HP also receives the reserved healing');
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
game.user = gm; victim.system.attributes.hp.value = 40; victim.healingMultiplier = 0;
charge(25);
await life();
assert.equal(victim.system.attributes.hp.value, 40, 'Target healing immunity remains effective');
assert.equal(effect.flags['khuzoe-automations'].charges, 0, 'Healing blocked by immunity does not refund a completed use');
victim.healingMultiplier = 1;
charge(25); failApplication = true;
await assert.rejects(life(), /Simulated GM damage application failure/);
assert.equal(victim.system.attributes.hp.value, 40);
assert.equal(effect.flags['khuzoe-automations'].charges, 25, 'A failed heal restores charges');
failApplication = false; abort = true;
await life();
assert.equal(victim.system.attributes.hp.value, 40);
assert.equal(effect.flags['khuzoe-automations'].charges, 25, 'An aborted heal restores charges');
abort = false; omitDamage = true;
await life();
assert.equal(effect.flags['khuzoe-automations'].charges, 25, 'A roll without a processed healing target is not a completed heal');
omitDamage = false;
assert.equal(saveUsers.length, savesBeforeLife, 'Life never asks for a save');
garun.system.attributes.hp = {value: 20, max: 80, temp: 0, get damage() { return Math.max(0, this.max - this.value); }};
garun.calculateDamage = victim.calculateDamage;
garun.healingMultiplier = 1;
charge(25);
await spend('KhzGinLife000001', source);
assert.equal(garun.system.attributes.hp.value, 45, 'The caster can also choose itself as the healing target');
assert.equal(effect.flags['khuzoe-automations'].charges, 0);
assert.equal(errors.length, 0);
console.log('Ginevra: danno e cura con DamageOnlyWorkflow e processDamageRoll Midi installati; DM/owner, bersaglio e cura su sé stessi, limiti PF, immunità, PF temporanei, reazioni, TS e rimborsi verificati.');
