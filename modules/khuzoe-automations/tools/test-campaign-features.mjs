import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import * as campaign from "../scripts/campaign-features.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";
import {khuzoeRegistrationApi} from "../scripts/activity-compat.mjs";
import {RELEASE_VERSION} from "../scripts/release.mjs";

const MODULE = "khuzoe-automations", STATE = "khuzoeCampaignRoll";
const hooks = new Map(), wrappers = new Map(), notices = [];
globalThis.Hooks = {once() {}, on(name, callback) { hooks.set(name, callback); }};
globalThis.libWrapper = {register(_module, path, callback) { wrappers.set(path, callback); }};
globalThis.game = {user: {id: "gm", isGM: true}, users: [], actors: [], combats: []};
globalThis.ui = {notifications: {warn: message => notices.push(message), error: message => notices.push(message)}};
globalThis.CONFIG = {Dice: {D20Roll: {ADV_MODE: {DISADVANTAGE: -1}}}};
let selection = false, confirmations = 0, visible = true;
globalThis.MidiQOL = {
  canSee: () => visible,
  setReactionUsed: async actor => { actor.reaction = true; },
  removeReactionUsed: async actor => { actor.reaction = false; }
};
const setChanges = (target, changes) => {
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split("."), key = keys.pop();
    keys.reduce((root, part) => root[part] ??= {}, target)[key] = structuredClone(value);
  }
};
globalThis.cat = {utils: {
  queryUtils: {isTheGM: () => true, firstOwner: () => "gm"},
  actorUtils: {hasUsedReaction: actor => Boolean(actor.reaction), getFirstToken: () => null},
  dialogUtils: {buttonDialog: async () => { confirmations++; return selection; }, confirmUseItem: async () => { confirmations++; return selection; }},
  effectUtils: {createEffects: async (actor, data) => data.map(source => {
    const effect = {...structuredClone(source), uuid: `${actor.uuid}.ActiveEffect.${actor.effects.length}`, parent: actor,
      update: async changes => setChanges(effect, changes)};
    actor.effects.push(effect); return effect;
  })},
  workflowUtils: {bonusAttack: async (workflow, formula) => { assert.equal(formula, "1d6[Ragionamento Preciso]"); workflow.attackRoll.total += 4; }}
}};
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; this.total = Number(formula); }
  async evaluate() { return this; }
};
function actor(name) {
  const actor = {name, uuid: `Actor.${name}`, documentName: "Actor", isOwner: true, items: [], effects: [], flags: {}, statuses: new Set(),
    system: {abilities: {int: {mod: 4}, wis: {mod: 2}}, attributes: {hp: {value: 50, max: 80}}},
    applyDamage: async ([damage]) => { actor.system.attributes.hp.value = Math.min(80, actor.system.attributes.hp.value + damage.value); }};
  registerDocuments(actor); return actor;
}
function item(actor, key, options = {}) {
  const definition = campaign.CAMPAIGN_AUTOMATIONS.find(entry => entry.key === key);
  const uses = {max: "4", spent: 0, recovery: []};
  Object.defineProperty(uses, "value", {get: () => Math.max(1, actor.system.abilities.int.mod) - uses.spent});
  const item = {name: definition.name, type: "feat", actor, system: {identifier: definition.identifier, source: {rules: definition.rules}, uses},
    flags: {cat: {automation: {source: MODULE, version: RELEASE_VERSION}}}, ...options};
  actor.items.push(item); registerDocuments(item); return item;
}
const garun = actor("Garun"), theldarion = actor("Theldarion"), guardian = actor("Velkarya"), wearer = actor("Wearer"), enemy = actor("Enemy");
const defense = item(garun, "defense"), premonition = item(garun, "premonition"), reasoning = item(theldarion, "reasoning"), lucky = item(theldarion, "lucky");
const shield = {name: "Shield", type: "feat", system: {identifier: "shield", source: {rules: "2014"}},
  flags: {cat: {automation: {source: MODULE, version: "0.25.0"}, macros: {roll: [{source: MODULE, rules: "2014", identifier: "khuzoe-guardian-shield"}]}}}};
const regeneration = item(guardian, "regeneration");
const scene = {id: "test", grid: {size: 100, distance: 5, units: "ft", measurePath: ([a, b]) => ({distance: Math.hypot(a.x - b.x, a.y - b.y) / 20})}};
function token(actor, x = 0, disposition = 1) {
  const document = {uuid: `Scene.test.Token.${actor.name}`, parent: scene, actor, x, y: 0, width: 1, height: 1, disposition};
  const object = {document, actor, name: actor.name}; document.object = object; return object;
}
const gt = token(garun), et = token(enemy, 100, -1), wt = token(wearer, 100), st = token(guardian);
guardian.getActiveTokens = () => [st];
function combatFor(actor, turn = 0) {
  const combatants = [actor, enemy].map((actor, index) => ({actor, id: `c${index}`, initiative: 20 - index}));
  const combat = {id: "combat", started: true, isActive: true, round: 1, turn, current: {round: 1, turn},
    get combatant() { return combatants[this.turn]; }, getCombatantsByActor: actor => combatants.filter(entry => entry.actor === actor)};
  game.combat = combat; game.combats = [combat]; return combat;
}
function attack(actor, target, options = {}) {
  return {id: crypto.randomUUID(), actor, token: actor === garun ? gt : et, targets: new Set([target]), hitTargets: new Set([target]), attackRollCount: 1,
    activity: {attack: {}, actionType: "mwak", ability: "str"}, targetACModifiers: new Map(), ...options};
}
function d20(result = 12, options = {}) { return {total: result + 5, dice: [{faces: 20, results: [{result, active: true}]}], options}; }

// Recognition and explicit alias application do not claim unrelated Items or the Shield spell.
assert.equal(campaign.getCampaignAutomation({...defense, system: {...defense.system, identifier: "reckless-attack"}})?.key, "defense");
assert.equal(campaign.getCampaignAutomation({...defense, name: "Reckless Attack", system: {...defense.system, identifier: "reckless-attack"}}), null);
assert.equal(campaign.getCampaignAutomation({...reasoning, system: {...reasoning.system, identifier: "new-item"}})?.key, "reasoning");
assert.equal(campaign.getCampaignAutomation({...reasoning, name: "Altro", system: {...reasoning.system, identifier: "new-item"}}), null);
assert.equal(campaign.getCampaignAutomation({...shield, type: "spell"}), null);
assert.equal(campaign.getCampaignAutomation({...regeneration, flags: {}, system: {...regeneration.system, description: {value: "Regains 20 hit points unless it takes fire damage"}}}), null);
const {getSupportedAutomation} = await import("../scripts/main.mjs");
const wikiItem = {...defense, flags: {"cripta-wiki-sync": {skillTree: {treeKey: "garun", nodeId: "2", sources: [{treeKey: "garun"}]}, transferId: "stable-link"}}};
const wikiUpdate = {flags: {cat: {automation: {source: MODULE}}}};
hooks.get("preUpdateItem")(wikiItem, wikiUpdate);
assert.deepEqual(wikiUpdate.flags["cripta-wiki-sync"], wikiItem.flags["cripta-wiki-sync"], "CAT application preserves Wiki Sync provenance");
assert.notEqual(wikiUpdate.flags["cripta-wiki-sync"], wikiItem.flags["cripta-wiki-sync"], "Preserved metadata is cloned");
assert.match(getSupportedAutomation({...shield, type: "spell"}).uuid, /KhuzoeSpells/);
assert.equal(getSupportedAutomation(shield), null, "Retired guardian Shield is not offered for application, even on an old copy");
const alias = item(theldarion, "reasoning", {flags: {}}); alias.system.identifier = "new-item";
await assert.rejects(campaign.applyCampaignAlias(alias, campaign.getCampaignAutomation(alias), async () => { throw new Error("CAT failed"); }));
assert.equal(alias.system.identifier, "new-item", "Failure restores the original identifier");
theldarion.items.splice(theldarion.items.indexOf(alias), 1);
const changes = {system: {identifier: "ragionamento-preciso", source: {rules: "2024"}}, flags: {cat: {automation: {source: MODULE}}}};
reasoning.system.uses.spent = 3;
campaign.prepareCampaignItemUpdate(reasoning, changes);
assert.equal(changes.system.uses.spent, 3);
assert.equal(changes.system.uses.max, "max(1, @abilities.int.mod)");
assert.deepEqual(changes.system.uses.recovery, [{period: "lr", type: "recoverAll"}]);

// Guard: first attack only, forced disadvantage despite a dialog override, visibility and per-target AC.
combatFor(garun); selection = true;
const ga = attack(garun, et);
await campaign.guardAttackConfig({workflow: ga, document: defense});
assert.equal(garun.effects.length, 1); assert.equal(ga.disadvantage, true);
assert.equal(garun.effects[0].duration.expiry, "turnStart");
const configured = {options: {advantage: true, advantageMode: 1}, configureModifiers() { this.reconfigured = true; }};
campaign.enforceGuardRoll([configured], {workflow: ga});
assert.equal(configured.options.advantageMode, -1); assert.equal(configured.options.advantage, false); assert.ok(configured.reconfigured);
const incoming = attack(enemy, gt, {disadvantage: true});
campaign.guardedTarget({workflow: incoming, document: defense, sourceToken: gt.document});
campaign.guardedTarget({workflow: incoming, document: defense, sourceToken: gt.document});
campaign.campaignACModifiers(incoming);
assert.equal(incoming.targetACModifiers.get(garun.uuid), 2, "Independent disadvantage gives exactly +2 for this target");
const normal = attack(enemy, gt); campaign.guardedTarget({workflow: normal, document: defense, sourceToken: gt.document});
campaign.campaignACModifiers(normal); assert.equal(normal.targetACModifiers.size, 0); assert.equal(normal.disadvantage, true);
visible = false; const unseen = attack(enemy, gt); campaign.guardedTarget({workflow: unseen, document: defense, sourceToken: gt.document});
assert.equal(unseen.disadvantage, undefined); visible = true;
ga.attackRoll = d20(); await campaign.recordFirstAttack({workflow: ga, document: defense});
garun.effects = []; await campaign.activateGuard({document: defense}); assert.equal(garun.effects.length, 0);
game.combat.turn = 1; await campaign.activateGuard({document: defense}); assert.equal(garun.effects.length, 0);

// Premonition applies after a hit, caps at Wisdom, cannot duplicate a callback, and ignores misses/allies.
const hit = attack(enemy, gt, {attackRoll: d20()});
await Promise.all([campaign.repeatedPremonition({workflow: hit, document: premonition}), campaign.repeatedPremonition({workflow: hit, document: premonition})]);
assert.equal(garun.effects.length, 1); assert.equal(garun.effects[0].flags[MODULE].stacks, 1);
assert.equal(garun.effects[0].start.combatant, "c0", "Off-turn effect expires at defender's next start");
for (let i = 0; i < 3; i++) await campaign.repeatedPremonition({workflow: attack(enemy, gt, {attackRoll: d20()}), document: premonition});
assert.equal(garun.effects[0].system.changes[0].value, "2");
garun.effects = [];
await campaign.repeatedPremonition({workflow: attack(enemy, gt, {attackRoll: d20(), hitTargets: new Set()}), document: premonition});
et.document.disposition = 1; await campaign.repeatedPremonition({workflow: attack(enemy, gt, {attackRoll: d20()}), document: premonition});
assert.equal(garun.effects.length, 0); et.document.disposition = -1;

// Pre-roll decision, d6 in the native formula, optional advantage and cancellation refunds.
campaign.registerCampaignHooks();
assert.equal(wrappers.size, 7); assert.ok(hooks.has("dnd5e.preRollSavingThrow"));
const save = {ability: "dex"}, options = {}; selection = "advantage";
await campaign.reasoningSituational({document: reasoning, config: save, options, saveId: "dex"});
assert.equal(options.advantage, true); assert.equal(reasoning.system.uses.spent, 4);
const native = structuredClone(save); native.rolls = [{parts: ["1d20", "@mod"], options: {}}];
campaign.prepareReasoningRoll(native); campaign.prepareReasoningRoll(native);
assert.deepEqual(native.rolls[0].parts, ["1d20", "@mod", "1d6[Ragionamento Preciso]"]);
const rolled = d20(12, native.rolls[0].options);
await campaign.reasoningPost({document: reasoning, config: save, roll: rolled, saveId: "dex"});
await campaign.cancelReasoning(save); assert.equal(reasoning.system.uses.spent, 4, "Completed rolls keep the spent use");
reasoning.system.uses.spent = 2; selection = "bonus";
const canceled = {ability: "dex"};
await campaign.reasoningRollWrapper(async config => { await campaign.reasoningSituational({document: reasoning, config, options: {}, saveId: "dex"}); return null; }, canceled);
assert.equal(reasoning.system.uses.spent, 2);
await campaign.cancelReasoning(canceled); assert.equal(reasoning.system.uses.spent, 2, "Refund is idempotent");
await assert.rejects(campaign.reasoningRollWrapper(async config => { await campaign.reasoningSituational({document: reasoning, config, options: {}, saveId: "dex"}); throw new Error("Canceled"); }, {}));
assert.equal(reasoning.system.uses.spent, 2);
selection = false; const unused = {};
await campaign.reasoningSituational({document: reasoning, config: unused, options: {}, saveId: "int"});
await campaign.reasoningPost({document: reasoning, config: unused, roll: d20(20), saveId: "int"});
await campaign.reasoningPost({document: reasoning, config: unused, roll: d20(20), saveId: "int"});
assert.equal(reasoning.system.uses.spent, 1, "Natural 20 recovers once even without spending on that save");
assert.equal(campaign.naturalTwenty(d20(19)), false);
assert.equal(campaign.naturalTwenty({dice: [{faces: 20, results: [{result: 20, active: false, discarded: true}, {result: 5, active: true}]}]}), false);
const check = {}; await campaign.reasoningSituational({document: reasoning, config: check, options: {}});
await campaign.reasoningPost({document: reasoning, config: check, roll: d20(20)});
assert.equal(reasoning.system.uses.spent, 1, "Checks do not restore uses");
selection = "bonus"; const ra = attack(theldarion, et, {attackRoll: d20(20)});
await campaign.reasoningAttackConfig({document: reasoning, workflow: ra});
await campaign.reasoningAttackBonus({workflow: ra}); await campaign.reasoningAttackBonus({workflow: ra});
assert.equal(ra.attackRoll.total, 29, "Attack bonus cannot be added twice");
await campaign.reasoningAttackPost({document: reasoning, workflow: ra}); await campaign.reasoningAttackPost({document: reasoning, workflow: ra});
assert.equal(reasoning.system.uses.spent, 1);

// Salvaculo extends only an owned Evasion and only an INT save for half damage.
const intSave = {saveActivity: {damage: {onSave: "half"}}};
assert.equal(campaign.intelligenceEvasion(intSave, {actor: theldarion}, new Set(["int"])), false);
const evasion = {type: "feat", name: "Eludere", system: {identifier: "evasion"}}; theldarion.items.push(evasion);
assert.equal(campaign.intelligenceEvasion(intSave, {actor: theldarion}, new Set(["int"])), true);
assert.equal(campaign.intelligenceEvasion({saveActivity: {damage: {onSave: "none"}}}, {actor: theldarion}, new Set(["int"])), false);
assert.equal(campaign.intelligenceEvasion(intSave, {actor: theldarion}, new Set(["wis"])), false);
evasion.disabled = true; assert.equal(campaign.intelligenceEvasion(intSave, {actor: theldarion}, new Set(["int"])), false);

// Retiring guardian Shield must leave cancellation and guard-state cleanup intact.
const canceledAttack = attack(garun, et);
canceledAttack[STATE] = {guardAsked: true, ac: {[garun.uuid]: {guard: 2}}};
await campaign.cancelCampaignAttack(canceledAttack);
assert.deepEqual(canceledAttack[STATE].ac, {});
assert.equal(canceledAttack[STATE].guardAsked, false);
assert.equal(campaign.guardianShield, undefined);
assert.equal(campaign.configureGuardian, undefined);

// Regeneration uses the common healing path and the existing authoritative combat deduplication.
const macros = []; campaign.registerCampaignFeatures(khuzoeRegistrationApi({registerFnMacro: entry => { macros.push(entry); return entry; }, registerAutomation: entry => entry}));
const regen = macros.find(entry => entry.identifier === "regeneration").combat[0].macro;
const combat = combatFor(guardian); const context = {document: regeneration, combat, combatant: combat.combatant, token: st.document};
await Promise.all([regen(context), regen(context)]); assert.equal(guardian.system.attributes.hp.value, 60);
await regen(context); assert.equal(guardian.system.attributes.hp.value, 60);
guardian.system.attributes.hp.value = 0; combat.round++; combat.current.round++;
await regen(context); assert.equal(guardian.system.attributes.hp.value, 0);
guardian.system.attributes.hp.value = 76; combat.round++; combat.current.round++;
await regen(context); assert.equal(guardian.system.attributes.hp.value, 80);
const reasoningMacro = macros.find(entry => entry.identifier === "ragionamento-preciso");
assert.ok(reasoningMacro.save.every(entry => entry.pass !== "actorBonus" && entry.pass !== "actorOptionalBonus"), "Do not terminate CAT's other bonus handlers or prompt after the result");

// Installed D&D5e and Midi contracts: targeted modifiers, native build hook and forced disadvantage method.
const midi = await readFile(new URL("../../midi-qol/midi-qol.js", import.meta.url), "utf8");
assert.match(midi, /let targetACMod = this.targetACModifiers.get\(targetActor.uuid\) \?\? 0/);
assert.match(midi, /async checkSuperSaver\(token, abilities\)/);
const dnd = await readFile(new URL("../../../systems/dnd5e/dnd5e.mjs", import.meta.url), "utf8");
assert.match(dnd, /dnd5e.preRoll\$\{hookName.capitalize\(\)\}/);
assert.match(dnd, /this.d20.applyAdvantage\(this.options.advantageMode\)/);
console.log("Campaign features: recognition, aliases, guard, hit stacks, resources, canceled rolls, natural 20, INT Evasion, guardian Shield retirement and regeneration OK.");
