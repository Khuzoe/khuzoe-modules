import assert from "node:assert/strict";
import {readFile, access} from "node:fs/promises";
import * as armorer from "../scripts/armorer.mjs";
import {registerDocuments} from "./fixtures-documents.mjs";
const MODULE = "khuzoe-automations";
globalThis.Hooks = {on() {}, once() {}};
globalThis.game = {user: {id: "gm", isGM: true}, users: [], time: {worldTime: 100}, combats: []};
globalThis.ui = {notifications: {warn() {}}};
let decisions = [], asked = 0, effectSerial = 0;
globalThis.cat = {utils: {queryUtils: {},
  dialogUtils: {buttonDialog: async () => { asked++; return decisions.shift() ?? false; }},
  documentUtils: {deleteDocument: async effect => { effect.parent.effects.splice(effect.parent.effects.indexOf(effect), 1); }},
  effectUtils: {createEffects: async (actor, entries) => entries.map(data => {
    const effect = {...structuredClone(data), uuid: `${actor.uuid}.ActiveEffect.${++effectSerial}`, parent: actor};
    registerDocuments(effect); actor.effects.push(effect); return effect;
  })}, workflowUtils: {setActivity: (workflow, activity) => { workflow.activity = activity; }, bonusDamage: async workflow => { workflow.bonus = "1d6"; }}}};
let serial = 0, cases = 0;
function actorFixture() {
  const actor = {uuid: `Actor.armorer${++serial}`, name: "Armorer", documentName: "Actor", isOwner: true,
    classes: {artificer: {system: {levels: 4}}}, flags: {}, effects: [], items: [], statuses: new Set(),
    system: {attributes: {hp: {value: 30, max: 30, temp: 0}, prof: 3}, abilities: {int: {mod: 4}}}};
  for (const [key, identifier] of Object.entries(armorer.ARMORER_IDS)) actor.items.push({uuid: `${actor.uuid}.Item.${key}`, name: key,
    type: "feat", img: "icons/svg/shield.svg", actor, system: {identifier, source: {rules: "2014"}, uses: {max: "@prof", spent: 0}},
    flags: {cat: {automation: {source: MODULE}}}, effects: []});
  const armor = {uuid: `${actor.uuid}.Item.suit`, type: "equipment", actor, name: "Custom armor", system: {equipped: true, type: {value: "heavy"}, strength: 15}};
  actor.items.push(armor); registerDocuments(actor);
  const items = Object.fromEntries(Object.keys(armorer.ARMORER_IDS).map(key => [key, actor.items.find(i => i.system.identifier === armorer.ARMORER_IDS[key])]));
  const cmd = data => armorer.executeArmorerCommand({actorUuid: actor.uuid, ...data});
  const bind = model => cmd({action: "bind", armorUuid: armor.uuid, model, ability: "int"});
  return {actor, armor, items, cmd, bind};
}
function combat(actor, own = true) {
  const source = {id: "source", actor, initiative: 18, turnNumber: 0};
  const other = {id: "other", actor: {uuid: "Actor.enemy"}, initiative: 10, turnNumber: 1};
  game.combat = {id: "combat", started: true, round: 2, turn: own ? 0 : 1, combatants: [source, other], combatant: own ? source : other};
  return game.combat;
}
function workflow(actor, item, extra = {}) {
  return {id: crypto.randomUUID(), actor, item, targets: new Set([{actor: {uuid: "Actor.target"}}]),
    activity: {type: "attack", attack: {ability: "str"}}, attackRoll: {total: 20},
    hitTargets: new Set([{actor: {uuid: "Actor.target"}}]), ...extra};
}
{
  const {actor, armor, items, cmd, bind} = actorFixture();
  assert.equal(armorer.activeArmorModel(actor), null);
  assert.equal(await bind("infiltrator"), true);
  assert.equal(armorer.activeArmorModel(actor), "infiltrator");
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].system.changes[0].value, "5");
  assert.equal(await cmd({action: "model", model: "guardian", ability: "int"}), false, "Cannot change outside a rest");
  await cmd({action: "rest"});
  assert.equal(await cmd({action: "model", model: "guardian", ability: "int"}), true);
  assert.deepEqual(actor.effects[0].system.changes, [], "Guardian removes Infiltrator movement bonus");
  assert.equal(await bind("infiltrator"), false, "Rebinding armor cannot bypass the rest requirement");
  armor.system.equipped = false;
  await armorer.reconcileArmorer(actor);
  assert.equal(armorer.activeArmorModel(actor), "guardian", "The selected model does not require equipped armor");
  assert.equal(actor.effects.length, 1);
  armor.system.equipped = true;
  await armorer.reconcileArmorer(actor);
  assert.equal(armorer.activeArmorModel(actor), "guardian");
  assert.equal(actor.effects.length, 1);
  actor.statuses.add("dead");
  await armorer.reconcileArmorer(actor);
  assert.equal(actor.flags[MODULE].armorer.armorUuid, null, "Arcane Armor ends on death");
  assert.equal(actor.effects.length, 0);
  cases += 7;
}
{
  const {actor, armor, items, bind, cmd} = actorFixture();
  await bind("guardian");
  const duplicate = {...items.field, uuid: `${actor.uuid}.Item.fieldDuplicate`, system: structuredClone(items.field.system)};
  actor.items.push(duplicate); registerDocuments(duplicate);
  actor.system.attributes.hp.temp = 15;
  const use = workflow(actor, items.field, {activity: {type: "utility"}});
  decisions = [false];
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), true, "Cancel replacement of higher temporary HP before consuming an action/use");
  assert.equal(items.field.system.uses.spent, 0);
  assert.equal(actor.system.attributes.hp.temp, 15);
  decisions = [true];
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), undefined);
  await armorer.finishArmorerUse({workflow: use});
  await armorer.finishArmorerUse({workflow: use});
  assert.equal(items.field.system.uses.spent, 1);
  assert.equal(duplicate.system.uses.spent, 1, "Duplicates share one resource pool");
  assert.equal(actor.system.attributes.hp.temp, 4, "Artificer levels, not total character levels; replaces even higher temporary HP");
  const results = await Promise.all([1, 2, 3].map(id => cmd({action: "field", id: `concurrent-${id}`})));
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(items.field.system.uses.spent, 3);
  assert.equal(duplicate.system.uses.spent, 3);
  armor.system.equipped = false;
  await armorer.reconcileArmorer(actor);
  assert.equal(actor.system.attributes.hp.temp, 4, "Doffing no longer removes Defensive Field temporary HP");
  const otherArmor = {...armor, uuid: `${actor.uuid}.Item.otherSuit`, system: {...armor.system, equipped: false}};
  actor.items.push(otherArmor); registerDocuments(otherArmor);
  assert.equal(await cmd({action: "bind", armorUuid: otherArmor.uuid, model: "guardian", ability: "int"}), true);
  assert.equal(actor.system.attributes.hp.temp, 4, "Changing the optional armor association preserves temporary HP");
  actor.items.splice(actor.items.indexOf(otherArmor), 1);
  await armorer.reconcileArmorer(actor);
  assert.equal(armorer.activeArmorModel(actor), "guardian", "Deleting the associated armor does not disable the selected model");
  actor.system.attributes.hp.temp = 20;
  actor.flags[MODULE].temporaryHPSource = "Item.agathys";
  await armorer.reconcileArmorer(actor);
  assert.equal(actor.system.attributes.hp.temp, 20, "Other sources of temporary HP are preserved");
  cases += 8;
}
{
  const {actor, items, bind} = actorFixture();
  await bind("infiltrator");
  combat(actor);
  const a = workflow(actor, items.launcher), b = workflow(actor, items.launcher);
  decisions = [true, true];
  await Promise.all([armorer.launcherBonus({workflow: a}), armorer.launcherBonus({workflow: b})]);
  assert.equal([a.bonus, b.bonus].filter(Boolean).length, 1, "Concurrent attacks/duplicate Items grant only one bonus");
  await armorer.launcherBonus({workflow: a});
  game.combat.round++;
  const miss = workflow(actor, items.launcher, {hitTargets: new Set()});
  const before = asked;
  await armorer.launcherBonus({workflow: miss});
  assert.equal(asked, before, "No extra damage or prompt on a miss");
  combat(actor, false);
  await armorer.launcherBonus({workflow: workflow(actor, items.launcher)});
  assert.equal(asked, before, "No once-per-own-turn damage on another creature's turn");
  combat(actor); game.combat.round = 8;
  decisions = [false];
  await armorer.launcherBonus({workflow: workflow(actor, items.launcher)});
  assert.notEqual(actor.flags[MODULE].armorer.launcher.turn, armorer.launcherTurn(actor), "Declining does not consume the turn");
  const goodBonus = cat.utils.workflowUtils.bonusDamage;
  cat.utils.workflowUtils.bonusDamage = async () => { throw new Error("roll failed"); };
  decisions = [true];
  await assert.rejects(armorer.launcherBonus({workflow: workflow(actor, items.launcher)}), /roll failed/);
  assert.equal(actor.flags[MODULE].armorer.launcher, null, "Failed damage roll restores the turn allowance");
  cat.utils.workflowUtils.bonusDamage = goodBonus;
  cases += 5;
}
{
  const {actor, items, bind} = actorFixture();
  await bind("guardian");
  const attack = workflow(actor, items.gauntlets);
  await armorer.prepareArmorerUse({workflow: attack});
  assert.equal(attack.activity.attack.ability, "int");
  actor.flags[MODULE].armorer.ability = "ordinary";
  await armorer.prepareArmorerUse({workflow: attack});
  assert.equal(attack.activity.attack.ability, "str");
  assert.equal(await armorer.prepareArmorerUse({workflow: workflow(actor, items.launcher)}), undefined,
    "An explicit Launcher attack is allowed even with Guardian selected");
  const target = {uuid: "Actor.marked", documentName: "Actor", items: [], effects: []};
  registerDocuments(target); combat(actor);
  attack.hitTargets = new Set([{actor: target}, {actor: target}]);
  await armorer.gauntletsHit({workflow: attack});
  assert.equal(target.effects.length, 1);
  const effect = target.effects[0];
  assert.equal(effect.start.combatant, "source");
  const same = workflow(target, {}, {targets: new Set([{actor}])});
  armorer.gauntletDisadvantage({workflow: same, document: effect});
  assert.equal(same.disadvantage, undefined, "Attacks against the actual Armorer are unaffected");
  const other = workflow(target, {});
  armorer.gauntletDisadvantage({workflow: other, document: effect});
  assert.equal(other.disadvantage, true);
  const mixed = workflow(target, {}, {targets: new Set([{actor}, {actor: {uuid: "Actor.third"}}])});
  assert.equal(armorer.checkGauntletTargets({workflow: mixed, document: effect}), true, "Do not wrongly disadvantage the source in a shared multi-target roll");
  effect.duration.expired = true;
  const expired = workflow(target, {});
  armorer.gauntletDisadvantage({workflow: expired, document: effect});
  assert.equal(expired.disadvantage, undefined);
  cases += 6;
}
{
  const {actor, items, bind, cmd} = actorFixture();
  await bind("infiltrator");
  const options = {disadvantage: true};
  armorer.dampeningStealth({document: items.model, options, skillId: "ste"});
  assert.deepEqual(options, {advantage: true, disadvantage: true}, "Armor disadvantage cancels normally; do not delete other disadvantages");
  const athletics = {};
  armorer.dampeningStealth({document: items.model, options: athletics, skillId: "ath"});
  assert.deepEqual(athletics, {});
  await cmd({action: "rest"}); await cmd({action: "model", model: "guardian", ability: "int"});
  const guardian = {};
  armorer.dampeningStealth({document: items.model, options: guardian, skillId: "ste"});
  assert.deepEqual(guardian, {});
  cases += 3;
}
{
  const {actor, items, bind} = actorFixture();
  const originalSteps = {uuid: `${actor.uuid}.Item.oldSteps`, type: "feat", system: {identifier: "powered-steps"}, effects: [{transfer: true,
    system: {changes: [{key: "system.attributes.movement.walk", value: "5", type: "add"}]}}]};
  actor.items.push(originalSteps);
  await bind("infiltrator");
  assert.deepEqual(actor.effects[0].system.changes, [], "Do not stack a pre-existing Powered Steps effect");
  originalSteps.effects = [];
  await armorer.reconcileArmorer(actor);
  assert.equal(actor.effects[0].system.changes[0].value, "5");
  cases++;
}
// Explicit abilities work without armor, Arcane Armor, Armor Model or a selected model.
{
  const {actor, items} = actorFixture();
  actor.items = [items.field, items.gauntlets, items.launcher];
  assert.equal(armorer.activeArmorModel(actor), null);
  const field = workflow(actor, items.field, {activity: {type: "utility"}});
  assert.equal(await armorer.prepareArmorerUse({workflow: field}), undefined);
  await armorer.finishArmorerUse({workflow: field});
  assert.equal(actor.system.attributes.hp.temp, 4);
  assert.equal(items.field.system.uses.spent, 1, "The GM path allows standalone Field and still spends a use");
  const target = {uuid: `${actor.uuid}.Target`, name: "Target", documentName: "Actor", items: [], effects: []};
  registerDocuments(target); combat(actor);
  const gauntlets = workflow(actor, items.gauntlets, {hitTargets: new Set([{actor: target}])});
  assert.equal(await armorer.prepareArmorerUse({workflow: gauntlets}), undefined);
  await armorer.gauntletsHit({workflow: gauntlets});
  assert.equal(target.effects.length, 1, "Standalone Gauntlets apply their mark");
  const launcher = workflow(actor, items.launcher);
  assert.equal(await armorer.prepareArmorerUse({workflow: launcher}), undefined);
  decisions = [true];
  await armorer.launcherBonus({workflow: launcher});
  assert.equal(launcher.bonus, "1d6", "Standalone Launcher includes its bonus damage on the GM path");
  const second = workflow(actor, items.launcher);
  await armorer.launcherBonus({workflow: second});
  assert.equal(second.bonus, undefined, "The once-per-own-turn limit remains enforced");
  cases += 4;
}
// Model setup is available by itself, and its passive benefits survive equipment changes.
{
  const {actor, armor, items} = actorFixture();
  actor.items = [items.model, items.steps, items.dampening];
  const use = workflow(actor, items.model, {activity: {type: "utility"}});
  decisions = ["infiltrator", "int"];
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), undefined);
  await armorer.finishArmorerUse({workflow: use});
  assert.equal(actor.flags[MODULE].armorer.armorUuid, null);
  assert.equal(armorer.activeArmorModel(actor), "infiltrator");
  assert.equal(actor.effects[0].system.changes[0].value, "5");
  const options = {};
  armorer.dampeningStealth({document: items.model, options, skillId: "ste"});
  assert.equal(options.advantage, true, "Infiltrator's passive stealth works without armor");
  actor.items.push(armor); armor.system.equipped = false;
  await armorer.reconcileArmorer(actor);
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].system.changes[0].value, "5");
  cases += 3;
}
// Arcane Armor's association is optional, including when there is no armor in the inventory.
{
  const {actor, items, cmd} = actorFixture();
  actor.items = [items.armor];
  const use = workflow(actor, items.armor, {activity: {type: "utility"}});
  decisions = ["guardian", "int"];
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), undefined);
  await armorer.finishArmorerUse({workflow: use});
  assert.equal(armorer.activeArmorModel(actor), "guardian");
  assert.equal(actor.effects[0].origin, items.armor.uuid, "Arcane Armor setup does not require a second feature");
  assert.equal(await cmd({action: "bind", armorUuid: "Item.missing", model: "guardian", ability: "int"}), false,
    "An optional association must still reference a real armor item");
  cases += 2;
}
{
  const {actor, armor, items} = actorFixture();
  armor.system.equipped = false;
  decisions = ["none", "infiltrator", "int"];
  const use = workflow(actor, items.armor, {activity: {type: "utility"}});
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), undefined);
  await armorer.finishArmorerUse({workflow: use});
  assert.equal(actor.flags[MODULE].armorer.armorUuid, null, "Existing inventory armor can be left unassociated");
  assert.equal(armorer.activeArmorModel(actor), "infiltrator");
  cases++;
}
{
  const {actor, armor, items} = actorFixture();
  armor.system.equipped = false;
  decisions = [armor.uuid, "infiltrator", "ordinary"];
  const use = workflow(actor, items.armor, {activity: {type: "utility"}});
  assert.equal(await armorer.prepareArmorerUse({workflow: use}), undefined);
  await armorer.finishArmorerUse({workflow: use});
  assert.equal(actor.flags[MODULE].armorer.armorUuid, armor.uuid, "Unequipped inventory armor can be associated");
  assert.equal(armorer.activeArmorModel(actor), "infiltrator");
  const launcher = workflow(actor, items.launcher);
  await armorer.prepareArmorerUse({workflow: launcher});
  assert.equal(launcher.activity.attack.ability, "dex", "The configured ordinary attack ability is retained");
  cases++;
}
{
  const {actor, items} = actorFixture();
  decisions = [false];
  assert.equal(await armorer.prepareArmorerUse({workflow: workflow(actor, items.armor)}), true);
  assert.equal(actor.flags[MODULE], undefined, "Cancelling optional armor selection changes no state");
  decisions = ["none", false];
  assert.equal(await armorer.prepareArmorerUse({workflow: workflow(actor, items.armor)}), true);
  assert.equal(actor.flags[MODULE], undefined, "Cancelling model selection changes no state");
  cases += 2;
}
// The native v14 expiry uses the source combatant, even when the marked enemy owns the effect.
{
  const core = await readFile(new URL("../../../../App/resources/app/client/documents/active-effect.mjs", import.meta.url), "utf8");
  const constants = await readFile(new URL("../../../../App/resources/app/common/constants.mjs", import.meta.url), "utf8");
  const events = JSON.parse(constants.match(/ACTIVE_EFFECT_EXPIRY_EVENTS = Object\.freeze\((\[[\s\S]*?\])\)/)[1]);
  const method = (name, args) => new Function("CORE_EXPIRY_EVENTS", "_loc", `return function(${args}) {${core.match(new RegExp(`^  ${name}\\([^\\n]*\\) \\{([\\s\\S]*?)^  \\}`, "m"))[1]}}`)(events, () => "duration");
  const prepare = method("_prepareCombatBasedDuration", "duration, context"), expiry = method("isExpiryEvent", "event, context");
  globalThis.CONFIG = {time: {turnTime: 0, roundTime: 6}};
  game.i18n = {pluralRules: new Intl.PluralRules("en")};
  const {actor} = actorFixture();
  for (let sourceTurn = 0; sourceTurn < 3; sourceTurn++) for (let hitTurn = 0; hitTurn < 3; hitTurn++) {
    const turns = Array.from({length: 3}, (_, i) => ({id: `c${i}`, turnNumber: i, initiative: 20 - i, actor: i === sourceTurn ? actor : {uuid: `Actor.enemy${i}`}}));
    const c = {id: "nativeCombat", started: true, round: 5, turn: hitTurn, turns, combatants: new Map(turns.map(t => [t.id, t])),
      getCombatantsByActor: a => turns.filter(t => t.actor.uuid === a.uuid), get combatant() { return turns[this.turn]; }};
    game.combat = c;
    game.combats = new Map([[c.id, c]]);
    const data = armorer.gauntletExpiry(actor);
    const effect = {actor: {uuid: "Actor.enemy", inCombat: true}, start: {...data.start, combat: c}, duration: data.duration};
    assert.equal(prepare.call(effect, {...data.duration}, {}).remaining, 1);
    for (let elapsed = 1; elapsed <= 3; elapsed++) {
      c.turn = (hitTurn + elapsed) % 3; c.round = 5 + Math.floor((hitTurn + elapsed) / 3);
      const ended = expiry.call(effect, "turnStart", {combat: c}) && prepare.call(effect, {...data.duration}, {}).remaining <= 0;
      assert.equal(ended, c.turn === sourceTurn);
      if (ended) break;
    }
    cases++;
  }
}
{
  const knownImport = {type: "feat", name: "Defensive Field", system: {identifier: "", source: {rules: "2024"}, description: {
    value: "You gain temporary hit points equal to your level in this class. Uses equal to your proficiency bonus, regained at a long rest."}}};
  const automation = armorer.getArmorerAutomation(knownImport);
  assert.equal(automation.identifier, "defensive-field");
  assert.equal(armorer.getArmorerAutomation({...knownImport, system: {...knownImport.system, description: {value: "A different ability"}}}), null);
  assert.equal(armorer.getArmorerAutomation({...knownImport, name: "Unknown ability"}), null);
  const weapon = {type: "weapon", img: "custom.webp", system: {identifier: "thunder-gauntlets", source: {rules: "2014"},
    damage: {base: {number: 1, denomination: 8}}, magicalBonus: "2", properties: ["mgc"], uses: {spent: 0}},
    flags: {[MODULE]: {existing: true}, dnd5e: {enchantment: {origin: "Item.infusion"}}}, effects: [{_id: "infusion", type: "enchantment", system: {changes: []}}]};
  assert.equal(armorer.getArmorerAutomation(weapon).type, "weapon");
  const changes = {system: {identifier: "thunder-gauntlets", magicalBonus: ""}, flags: {cat: {automation: {source: MODULE}}}};
  armorer.prepareArmorerUpdate(weapon, changes);
  assert.equal(changes.system.magicalBonus, "2");
  assert.deepEqual(changes.system.properties, ["mgc"]);
  assert.deepEqual(changes.system.damage, weapon.system.damage);
  assert.equal(changes.img, "custom.webp");
  assert.equal(changes.flags[MODULE].existing, true);
  assert.deepEqual(changes.effects, weapon.effects, "Embedded enchantments/infusions survive CAT's full replacement");
  assert.deepEqual(changes.flags.dnd5e.enchantment, weapon.flags.dnd5e.enchantment);
  for (const definition of armorer.ARMORER_AUTOMATIONS) {
    const path = new URL(`../packData/khuzoe-class-features-2014/${definition.name.replace(/\W+/g, "_")}_${definition.uuid.split(".").at(-1)}.json`, import.meta.url);
    const item = JSON.parse(await readFile(path, "utf8"));
    await access(new URL(`../../../../App/resources/app/public/${item.img}`, import.meta.url)).catch(() => { throw new Error(`Missing icon: ${item.img}`); });
    if (definition.key === "field") assert.deepEqual(item.system.uses.recovery, [{period: "lr", type: "recoverAll"}]);
    if (definition.key === "launcher") {
      const attack = Object.values(item.system.activities)[0];
      if (definition.type === "weapon") {
        assert.equal(attack.range.override, false);
        assert.equal(item.system.range.long, 300);
      } else {
        const activity = {...attack, item};
        armorer.prepareArmorerActivity(activity);
        assert.equal(activity.range.long, 300);
      }
      assert.equal(attack.damage.parts.length, definition.type === "weapon" ? 0 : 1, "The extra d6 is optional, not baked into the base attack");
    }
  }
  cases += 4;
}
console.log(`Armorer: ${cases} mode, resource, temporary HP, attack, stealth, duplicate, native-expiry and preservation scenarios OK.`);
