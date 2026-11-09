import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import * as ginevra from "../scripts/ginevra.mjs";

const MODULE = "khuzoe-automations";
const source = JSON.parse(await readFile(new URL("../packData/khuzoe-class-features-2014/Abbraccio_di_Ginevra_KhzGinevraEmbr01.json", import.meta.url), "utf8"));
assert.equal(source.flags.cat.automation.version, ginevra.GINEVRA_AUTOMATION.version);
assert.equal(source.system.uses.max, "max(0, @abilities.wis.mod)");
assert.equal(source.system.activities.KhzGinActivate01.activation.type, "bonus");
assert.equal(source.system.activities.KhzGinActivate01.consumption.targets[0].type, "itemUses");
assert.equal(source.system.activities.KhzGinLife000001.activation.type, "action");
assert.equal(source.system.activities.KhzGinDeath00001.activation.type, "action");
assert.ok(source.effects[0].system.changes.some(change => change.key === "system.traits.dr.value" && change.value === "radiant"));

const notifications = [], synthetic = [], bonuses = [], macros = [], damageOnly = [];
globalThis.game = {user: {id: "gm", isGM: true}, users: [{id: "gm", isGM: true, active: true}]};
globalThis.ui = {notifications: {warn: message => notifications.push(message)}};
globalThis.cat = {utils: {
  queryUtils: {isTheGM: () => true, firstOwner: () => game.user.id},
  actorUtils: {getFirstToken: actor => actor.token},
  tokenUtils: {isEnemy: (a, b) => Number(a.disposition) !== Number(b.disposition), getDistance: (a, b) => Math.abs(a.x - b.x)},
  documentUtils: {deleteDocument: async effect => { effect.parent.effects = effect.parent.effects.filter(entry => entry !== effect); }},
  effectUtils: {createEffects: async (actor, data) => data.map(entry => {
    const effect = {...structuredClone(entry), id: `effect${actor.effects.length}`, parent: actor};
    effect.update = async changes => applyChanges(effect, changes);
    actor.effects.push(effect); return effect;
  })},
  itemUtils: {syntheticItem: (data, actor) => ({...data, actor})},
  workflowUtils: {
    bonusDamage: async (workflow, formula, options) => bonuses.push({workflow, formula, options}),
    syntheticActivityDataRoll: async (activity, item, targets, options) => {
      synthetic.push({activity, item, targets, options});
      if (activity.type === "heal") {
        const hp = targets[0].actor.system.attributes.hp;
        hp.value = Math.min(hp.max, hp.value + Number(activity.healing.custom.formula));
      }
      return {aborted: false};
    }
  }
}};
globalThis.CONFIG = {Dice: {DamageRoll: class {
  constructor(formula, data, options) { Object.assign(this, {formula, total: Number(formula), options}); }
  async evaluate() { return this; }
}}};
globalThis.MidiQOL = {DamageOnlyWorkflow: class {
  constructor(actor, token, amount, type, targets, roll, options) {
    this.workflowOptions = {};
    this.activity = {midiProperties: {}};
    this.damageRoll = roll;
    this.ready = Promise.resolve().then(() => {
      const hp = targets[0].actor.system.attributes.hp, before = hp.value;
      hp.value = type === "healing" ? Math.min(hp.max, before + amount) : Math.max(0, before - amount);
      this.damageList = [{targetUuid: targets[0].uuid, actorUuid: targets[0].actor.uuid, hpDamage: before - hp.value}];
      damageOnly.push({actor, token, amount, type, targets, roll, options, workflow: this});
    });
  }
}};
function applyChanges(target, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split("."), key = keys.pop();
    keys.reduce((root, part) => root[part] ??= {}, target)[key] = structuredClone(value);
  }
}
function actor(name, x, disposition) {
  const result = {uuid: `Actor.${name}`, name, isOwner: true, items: [], effects: [],
    system: {abilities: {wis: {mod: 3, dc: 15}}, attributes: {prof: 4, hp: {value: 20, max: 100}}}};
  result.token = {uuid: `Scene.test.Token.${name}`, id: name, x, disposition, actor: result};
  result.token.object = {document: result.token, actor: result};
  result.rollSavingThrow = async config => { result.lastSaveDc = config.midiOptions.target; return [{total: result.saveTotal}]; };
  return result;
}
const garun = actor("Garun", 0, 1), enemy = actor("Enemy", 20, -1), ally = actor("Ally", 10, 1);
const item = {type: "feat", name: "Abbraccio di Ginevra", uuid: "Actor.Garun.Item.ginevra", actor: garun, img: "icon.webp",
  system: {identifier: "abbraccio-di-ginevra", source: {rules: "2024"}, uses: {spent: 1}},
  flags: {cat: {automation: {source: MODULE, version: "0.28.8"}}}};
garun.items.push(item);
assert.equal(ginevra.getGinevraAutomation(item), ginevra.GINEVRA_AUTOMATION);
assert.equal(ginevra.getGinevraAutomation({...item, system: {...item.system, identifier: "new-item"}}), ginevra.GINEVRA_AUTOMATION);
const update = {flags: {cat: {automation: {source: MODULE}}}};
ginevra.prepareGinevraItemUpdate(item, update);
assert.equal(update.system.uses.spent, 1);
assert.deepEqual(update.system.uses.recovery, [{period: "lr", type: "recoverAll"}]);

ginevra.registerGinevra({registerAutomation: () => true, registerFnMacro: data => { macros.push(data); return true; }});
const passes = macros[0].roll;
const call = async (pass, context) => {
  for (const entry of passes.filter(entry => entry.pass === pass)) await entry.macro(context);
};
assert.equal(ginevra.validateEmbraceAction({document: item, workflow: {activity: {id: "KhzGinLife000001"}, token: garun.token, targets: [ally.token]}}), true);
await call("itemRollFinished", {document: item, workflow: {activity: {id: "KhzGinActivate01"}}});
assert.equal(garun.effects.length, 1);
assert.equal(garun.effects[0].name, "Abbraccio di Ginevra (0/100)");
assert.deepEqual(garun.effects[0].system.changes[0],
  {key: "system.traits.dr.value", type: "add", value: "ALL", priority: 20});
assert.equal(garun.effects[0].duration.value, 60);
const attack = {activity: {attack: {}, actionType: "msak"}, hitTargets: [enemy.token]};
await call("actorDamageRollBonuses", {document: item, workflow: attack});
assert.deepEqual(bonuses[0].options, {damageType: "radiant"});
assert.equal(bonuses[0].formula, "2d4");
await call("actorDamageRollBonuses", {document: item, workflow: {activity: {attack: {}, actionType: "rwak"}, hitTargets: [enemy.token]}});
assert.equal(bonuses.length, 1);

const damage = {id: "hit1", actor: garun, token: garun.token,
  targets: [enemy.token, ally.token], damageList: [
    {tokenUuid: enemy.token.uuid, hpDamage: 60, tempDamage: 5},
    {tokenUuid: ally.token.uuid, hpDamage: 20, tempDamage: 0}
  ]};
assert.equal(ginevra.inflictedDamage(damage, garun), 65);
assert.equal(ginevra.inflictedDamage({...damage, damageList: [
  {tokenUuid: enemy.token.uuid, oldHP: 4, newHP: 0, hpDamage: 4, tempDamage: 0, totalDamage: 100}
]}, garun), 4, "Il danno eccedente i PF non genera cariche");
await call("actorRollFinished", {document: item, workflow: damage});
assert.equal(garun.effects[0].flags[MODULE].charges, 65);
await call("actorRollFinished", {document: item, workflow: damage});
assert.equal(garun.effects[0].flags[MODULE].charges, 65, "La stessa workflow non conta due volte");
await call("actorRollFinished", {document: item, workflow: {...damage, id: "hit2"}});
assert.equal(garun.effects[0].flags[MODULE].charges, 100);
assert.equal(ginevra.validateEmbraceAction({document: item, workflow: {activity: {id: "KhzGinLife000001"}, token: garun.token, targets: [ally.token]}}), undefined);
await call("itemRollFinished", {document: item, workflow: {activity: {id: "KhzGinLife000001"}, token: garun.token, targets: [ally.token]}});
assert.equal(ally.system.attributes.hp.value, 100);
assert.equal(damageOnly.at(-1).type, "healing", "Vita usa lo stesso flusso risolto con tipo guarigione");
assert.equal(damageOnly.at(-1).amount, 100, "La cura usa tutte le cariche riservate");
assert.equal(garun.system.attributes.hp.value, 20, "Viene curato il bersaglio selezionato, non il lanciatore");
assert.equal(garun.effects[0].flags[MODULE].charges, 0);

applyChanges(garun.effects[0], {[`flags.${MODULE}.charges`]: 25});
garun.system.attributes.spell = {dc: 17};
enemy.saveTotal = NaN;
await call("itemRollFinished", {document: item, workflow: {activity: {id: "KhzGinDeath00001"}, token: garun.token, targets: [enemy.token]}});
assert.equal(garun.effects[0].flags[MODULE].charges, 25, "Un TS annullato conserva le cariche");
assert.equal(enemy.lastSaveDc, 17, "La Morte usa la CD degli incantesimi effettiva");
enemy.saveTotal = 18;
await call("itemRollFinished", {document: item, workflow: {activity: {id: "KhzGinDeath00001"}, token: garun.token, targets: [enemy.token]}});
assert.equal(damageOnly.at(-1).amount, 12, "TS riuscito dimezza per difetto");
assert.equal(enemy.system.attributes.hp.value, 8, "Il danno viene applicato al bersaglio");
assert.equal(garun.effects[0].flags[MODULE].charges, 0);
assert.ok(damageOnly.at(-1).workflow.workflowOptions.khuzoeGinevraSpending);
assert.ok(notifications.length >= 1);
console.log("Abbraccio di Ginevra: resistenze, danni, cariche e spesa verificati.");
