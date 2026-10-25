import {RELEASE_VERSION} from "./release.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {reserveResources, refundResources, recoverResourceUse} from "./resource-transactions.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {healActor} from "./healing.mjs";

const MODULE = "khuzoe-automations";
const STATE = "khuzoeCampaignRoll";
const GUARD = "khuzoe-guarded-stance";
const PREMONITION = "khuzoe-repeated-premonition";
const CLASS_PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";
const NPC_PACK = "Compendium.khuzoe-automations.KhuzoeNpcFeatures2014.Item";
export const CAMPAIGN_IDS = Object.freeze({
  defense: "difesa-impenetrabile", premonition: "premonizione-ripetuta",
  reasoning: "ragionamento-preciso", lucky: "salvaculo-ragionato",
  regeneration: "regeneration"
});
const definitions = [
  ["defense", "KhzCampDefense01", "Difesa Impenetrabile", "2024", "Posizione Guardinga prima del primo attacco: svantaggio agli attacchi visibili, +2 CA contro attacchi già svantaggiati e svantaggio obbligatorio ai propri attacchi da mischia con Forza."],
  ["premonition", "KhzCampPremon001", "Premonizione Ripetuta", "2024", "+1 CA dopo ogni attacco ostile che colpisce, fino al modificatore di Saggezza; termina all'inizio del turno successivo."],
  ["reasoning", "KhzCampReason01x", "Ragionamento Preciso", "2024", "Propone 1d6 prima dei tiri per colpire, prove e TS; usi pari a Intelligenza (minimo 1), recupero al riposo lungo e di un uso con 20 naturale su attacchi o TS."],
  ["lucky", "KhzCampLucky001x", "Salvaculo Ragionato", "2024", "Con Ragionamento Preciso offre anche vantaggio ai TS. Estende Evasion ai TS di Intelligenza per dimezzare i danni solo se Evasion è posseduta."],
  ["regeneration", "KhzGuardRegen001", "Regeneration", "2014", "Rigenera 10 PF all'inizio del turno se il guardiano ha almeno 1 PF, rispettando il massimo e i modificatori alle cure."]
];
export const CAMPAIGN_AUTOMATIONS = definitions.map(([key, id, name, rules, notes]) => Object.freeze({
  source: MODULE, type: "feat", identifier: CAMPAIGN_IDS[key], key, name, rules,
  version: RELEASE_VERSION, uuid: `${key === "regeneration" ? NPC_PACK : CLASS_PACK}.${id}`, notes
}));
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? (Array.isArray(collection) ? collection : Object.values(collection ?? {})));
const doc = token => token?.document ?? token;
const owner = item => item?.actor ?? (item?.parent?.documentName === "Actor" ? item.parent : null);
const active = item => item && !item.disabled && !item.isSuppressed && item.system?.equipped !== false;
const slug = name => String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hasAutomation = item => active(item) && item.flags?.cat?.automation?.source === MODULE;
const feature = (actor, id) => values(actor?.items).find(item => item.type === "feat" && item.system?.identifier === id && hasAutomation(item));
const effect = (actor, id) => values(actor?.effects).find(entry => active(entry) && !entry.duration?.expired && entry.flags?.cat?.identifier === id);
const rollState = object => object[STATE] ??= {};
const userId = actor => cat.utils.queryUtils?.firstOwner?.(actor, true) ?? game.user.id;

/** Aliases are deliberately name-specific: never claim a generic new-item or Reckless Attack. */
export function getCampaignAutomation(item) {
  if (item?.type !== "feat") return null;
  let identifier = item.system?.identifier;
  const name = slug(item.name);
  if (name === CAMPAIGN_IDS.defense && ["reckless-attack", CAMPAIGN_IDS.defense, ""].includes(identifier ?? "")) identifier = CAMPAIGN_IDS.defense;
  if (name === CAMPAIGN_IDS.reasoning && ["new-item", CAMPAIGN_IDS.reasoning, ""].includes(identifier ?? "")) identifier = CAMPAIGN_IDS.reasoning;
  const result = CAMPAIGN_AUTOMATIONS.find(data => data.identifier === identifier && data.rules === item.system?.source?.rules);
  // Other monsters' Regeneration may have different amounts or suppression rules.
  if (result?.key === "regeneration") {
    const text = String(item.system?.description?.value ?? "").replace(/<[^>]*>/g, " ");
    const isGuardian = /regains\s+10\s+hit points.*start of (?:its|each of its) turn.*(?:at least 1|at least one) hit point/is.test(text)
      && !/acid|fire|radiant|except|unless/i.test(text);
    if (!isGuardian && !hasAutomation(item)) return null;
  }
  return result ?? null;
}

export function prepareCampaignItemUpdate(item, changes) {
  if (changes.flags?.cat?.automation?.source !== MODULE) return;
  const automation = getCampaignAutomation({...item, type: item.type, name: item.name, system: changes.system ?? item.system});
  if (!automation) return;
  changes.flags[MODULE] = {...(item.flags?.[MODULE] ?? {}), ...(changes.flags[MODULE] ?? {}), campaignFeature: automation.key};
  if (automation.key === "reasoning") {
    changes.system.uses = {max: "max(1, @abilities.int.mod)", spent: Number(item.system?.uses?.spent ?? 0), recovery: [{period: "lr", type: "recoverAll"}]};
  }
}

/** Normalize an audited alias only during the user's explicit Apply action. */
export async function applyCampaignAlias(item, automation, apply) {
  const oldIdentifier = item.system?.identifier;
  if (!automation?.key || oldIdentifier === automation.identifier) return apply();
  await updateDocumentSafely(item, {"system.identifier": automation.identifier});
  try {
    const result = await apply();
    if (item.flags?.cat?.automation?.source !== MODULE || item.flags.cat.automation.version !== automation.version) throw new Error("CAT non ha applicato la sorgente Khuzoe aggiornata.");
    return result;
  } catch (error) {
    await updateDocumentSafely(item, {"system.identifier": oldIdentifier});
    throw error;
  }
}

function combatFor(actor) {
  return [game.combat, ...values(game.combats)].find(combat => combat?.started && combat.getCombatantsByActor?.(actor)?.length);
}
function turnKey(actor) {
  const combat = combatFor(actor);
  return combat ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}
function ownTurn(actor) {
  const combat = combatFor(actor);
  return Boolean(combat && combat.combatant?.actor?.uuid === actor.uuid);
}
function durationToNextTurn(actor) {
  const combat = combatFor(actor), combatant = combat?.getCombatantsByActor(actor)?.[0];
  return {
    duration: {value: combatant ? 1 : 6, units: combatant ? "turns" : "seconds", expiry: "turnStart", expired: false},
    ...(combatant ? {start: {combat: combat.id, combatant: combatant.id, round: combat.round, turn: combat.turn, initiative: combatant.initiative}} : {})
  };
}
function effectData(item, identifier, changes = []) {
  return {name: item.name, img: item.img, type: "base", origin: item.uuid, transfer: false,
    system: {changes}, ...durationToNextTurn(owner(item)), showIcon: 1,
    flags: {cat: {identifier}, dae: {specialDuration: [], expiryMode: "delete"}, [MODULE]: {campaignFeature: identifier}}};
}

export async function activateGuard({document: item, workflow}) {
  item ??= workflow?.item;
  const actor = owner(item);
  if (!actor || effect(actor, GUARD)) return;
  if (!ownTurn(actor) || actor.flags?.[MODULE]?.firstAttackTurn === turnKey(actor)) {
    ui.notifications.warn("Difesa Impenetrabile: attivala nel tuo turno, prima del primo attacco.");
    return;
  }
  await withDocumentLock(actor, GUARD, async () => {
    if (!effect(actor, GUARD)) await cat.utils.effectUtils.createEffects(actor, [effectData(item, GUARD)], {rules: item.system.source.rules});
  });
}

export async function guardAttackConfig({workflow, document: item}) {
  const actor = owner(item);
  if (!workflow?.activity?.attack || !actor) return;
  const state = rollState(workflow);
  if (!state.guardAsked && ownTurn(actor) && actor.flags?.[MODULE]?.firstAttackTurn !== turnKey(actor) && !effect(actor, GUARD)) {
    state.guardAsked = true;
    if (await cat.utils.dialogUtils.confirmUseItem(item, {userId: userId(actor)})) await activateGuard({document: item});
  }
  if (effect(actor, GUARD) && isStrengthMelee(workflow)) {
    state.forcedDisadvantage = true;
    workflow.advantage = false;
    workflow.disadvantage = true;
  }
}

function isStrengthMelee(workflow) {
  return workflow.activity?.actionType === "mwak" && (workflow.activity?.ability ?? workflow.activity?.attack?.ability ?? workflow.item?.system?.ability) === "str";
}
function canSee(defender, attacker) {
  try { return Boolean(MidiQOL.canSee?.(doc(defender)?.object ?? defender, doc(attacker)?.object ?? attacker)); }
  catch { return false; }
}
function addAC(workflow, actor, source, amount) {
  const state = rollState(workflow);
  state.ac ??= {};
  (state.ac[actor.uuid] ??= {})[source] = amount;
}

export function guardedTarget({workflow, document: item, sourceToken}) {
  const actor = owner(item);
  if (!actor || !effect(actor, GUARD) || !workflow?.activity?.attack) return;
  const defender = sourceToken ?? values(workflow.targets).find(token => token.actor?.uuid === actor.uuid);
  if (!defender || !canSee(defender, workflow.token)) return;
  const state = rollState(workflow);
  state.guarded ??= new Set();
  if (state.guarded.has(actor.uuid)) return;
  state.guarded.add(actor.uuid);
  if (workflow.disadvantage && !workflow.advantage) addAC(workflow, actor, GUARD, 2);
  workflow.disadvantage = true;
}

export async function recordFirstAttack({workflow, document: item}) {
  const actor = owner(item);
  if (!workflow?.attackRoll || !actor || !ownTurn(actor)) return;
  const stamp = turnKey(actor);
  if (actor.flags?.[MODULE]?.firstAttackTurn !== stamp) await updateDocumentSafely(actor, {[`flags.${MODULE}.firstAttackTurn`]: stamp});
}

export function enforceGuardRoll(rolls, config) {
  const workflow = config?.workflow;
  if (!workflow?.[STATE]?.forcedDisadvantage || !isStrengthMelee(workflow) || !effect(workflow.actor, GUARD)) return;
  for (const roll of rolls ?? []) {
    if (roll._evaluated) continue;
    roll.options.advantage = false;
    roll.options.disadvantage = true;
    roll.options.advantageMode = CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE;
    roll.configureModifiers();
  }
}

export async function repeatedPremonition({workflow, document: item, sourceToken}) {
  const actor = owner(item);
  const target = sourceToken ?? values(workflow?.hitTargets).find(token => token.actor?.uuid === actor?.uuid);
  if (!actor || !workflow?.attackRoll || !target || !values(workflow.hitTargets).some(token => doc(token)?.uuid === doc(target)?.uuid)) return;
  if (!(Number(doc(workflow.token)?.disposition) * Number(doc(target)?.disposition) < 0)) return;
  const cap = Math.max(0, Number(actor.system?.abilities?.wis?.mod ?? 0));
  if (!cap) return;
  const key = `${workflow.id ?? workflow.uuid}:${workflow.attackRollCount ?? 1}`;
  await withDocumentLock(actor, PREMONITION, async () => {
    const previous = effect(actor, PREMONITION);
    const hits = previous?.flags?.[MODULE]?.hits ?? [];
    if (hits.includes(key)) return;
    const count = Math.min(cap, Number(previous?.flags?.[MODULE]?.stacks ?? 0) + 1);
    const changes = [{key: "system.attributes.ac.bonus", type: "add", value: String(count), priority: 20}];
    if (previous) await updateDocumentSafely(previous, {"system.changes": changes, [`flags.${MODULE}.stacks`]: count, [`flags.${MODULE}.hits`]: [...hits, key].slice(-100)});
    else {
      const data = effectData(item, PREMONITION, changes);
      data.flags[MODULE].stacks = count; data.flags[MODULE].hits = [key];
      await cat.utils.effectUtils.createEffects(actor, [data], {rules: item.system.source.rules});
    }
  });
}

export function naturalTwenty(roll) {
  const d20 = roll?.dice?.find(die => die.faces === 20);
  return Boolean(d20?.results?.some(result => result.result === 20 && result.active !== false && !result.discarded));
}

async function chooseReasoning(item, state, {save = false} = {}) {
  if (state.reasoning && !state.reasoning.refunded) return state.reasoning;
  const actor = owner(item);
  const maximum = Math.max(1, Number(actor?.system?.abilities?.int?.mod ?? 1));
  const choiceState = state.reasoning = {itemUuid: item.uuid, actorUuid: actor.uuid, save, id: globalThis.crypto.randomUUID()};
  if (Number(item.system?.uses?.spent ?? 0) >= maximum) return choiceState;
  const choices = [["Aggiungi 1d6", "bonus"]];
  if (save && feature(actor, CAMPAIGN_IDS.lucky)) choices.push(["1d6 e vantaggio", "advantage"]);
  choices.push(["Non usare", false]);
  const choice = await cat.utils.dialogUtils.buttonDialog(item.name, "<p>Usare Ragionamento Preciso per questo tiro? La scelta avviene prima di tirare il d20.</p>", choices, {displayAsRows: true, userId: userId(actor)});
  if (!choice) return choiceState;
  choiceState.receipt = await reserveResources(actor, {item});
  choiceState.advantage = Boolean(choiceState.receipt && choice === "advantage");
  return choiceState;
}

export async function reasoningSituational({document: item, config, options, saveId}) {
  if (!config || !options || !owner(item)) return;
  if (config[STATE]?.reasoning?.closed) delete config[STATE];
  const choice = await chooseReasoning(item, rollState(config), {save: Boolean(saveId)});
  if (choice.advantage) options.advantage = true;
}
export function prepareReasoningRoll(config) {
  const choice = config?.[STATE]?.reasoning, roll = config?.rolls?.[0];
  if (!choice?.receipt || choice.refunded || !roll) return;
  roll.options ??= {};
  if (roll.options.khuzoeReasoningId === choice.id) return;
  (roll.parts ??= []).push("1d6[Ragionamento Preciso]");
  roll.options.khuzoeReasoningId = choice.id;
}
function markReasoningApplied(config, roll) {
  const choice = config?.[STATE]?.reasoning;
  if (choice?.id && roll?.options?.khuzoeReasoningId === choice.id) choice.applied = true;
}
async function recoverTwenty(item, roll, state) {
  if (!naturalTwenty(roll) || state.recovered) return;
  state.recovered = true;
  await recoverResourceUse(owner(item), item, state.id ??= globalThis.crypto.randomUUID());
}
export async function reasoningPost({document: item, config, roll, saveId}) {
  const state = config?.[STATE]?.reasoning;
  if (!state) return;
  markReasoningApplied(config, roll);
  if (state.receipt && !state.applied) await cancelReasoning(config);
  if (saveId) await recoverTwenty(item, roll, state);
  state.closed = true;
}
export async function reasoningAttackConfig({document: item, workflow}) {
  if (workflow?.activity?.attack) await chooseReasoning(item, rollState(workflow));
}
export async function reasoningAttackBonus({workflow}) {
  const choice = workflow?.[STATE]?.reasoning;
  if (!choice?.receipt || choice.applied || choice.refunded || !workflow.attackRoll) return;
  await cat.utils.workflowUtils.bonusAttack(workflow, "1d6[Ragionamento Preciso]");
  choice.applied = true;
}
export async function reasoningAttackPost({document: item, workflow}) {
  if (!workflow?.attackRoll) return;
  const state = rollState(workflow).reasoning ??= {id: globalThis.crypto.randomUUID()};
  await recoverTwenty(item, workflow.attackRoll, state);
}
export async function cancelReasoning(container) {
  const state = container?.[STATE]?.reasoning;
  if (state?.receipt && !state.applied && !state.refunded) {
    await refundResources(state.receipt); state.refunded = true;
  }
}
export async function reasoningRollWrapper(wrapped, config = {}, ...args) {
  let result;
  try { result = await wrapped(config, ...args); return result; }
  finally {
    markReasoningApplied(config, result?.[0]);
    if (!result?.length) await cancelReasoning(config);
  }
}

export function intelligenceEvasion(workflow, token, abilities) {
  const actor = token?.actor;
  return values(abilities).includes("int") && Boolean(feature(actor, CAMPAIGN_IDS.lucky))
    && values(actor?.items).some(item => active(item) && item.type === "feat" && (item.system?.identifier === "evasion" || ["evasion", "elusione", "eludere"].includes(slug(item.name))))
    && (workflow.saveActivity?.damage?.onSave ?? workflow.activity?.damage?.onSave) === "half";
}

export async function guardianRegeneration({document: item, combatant, token}) {
  const actor = owner(item);
  if (!actor || (combatant?.actor?.uuid && combatant.actor.uuid !== actor.uuid)) return;
  await withDocumentLock(actor, "guardian-regeneration", async () => {
    const hp = actor.system?.attributes?.hp;
    if (!(Number(hp?.value) > 0) || Number(hp.value) >= Number(hp.max) + Number(hp.tempmax ?? 0)) return;
    await healActor(actor, 10, {sourceItem: item, token: combatant?.token ?? token});
  });
}

export function campaignACModifiers(workflow) {
  for (const [actorUuid, sources] of Object.entries(workflow[STATE]?.ac ?? {})) {
    const amount = Object.values(sources).reduce((sum, value) => sum + value, 0);
    workflow.targetACModifiers.set(actorUuid, (workflow.targetACModifiers.get(actorUuid) ?? 0) + amount);
  }
}
export async function cancelCampaignAttack(workflow) {
  await cancelReasoning(workflow);
  const state = workflow?.[STATE];
  if (state && !workflow.attackRoll) {
    state.ac = {}; state.guardAsked = false;
  }
}
let hooksInstalled = false;
export function registerCampaignHooks() {
  if (hooksInstalled || !globalThis.libWrapper) return;
  hooksInstalled = true;
  for (const method of ["rollAbilityCheck", "rollSkill", "rollSavingThrow", "rollToolCheck"]) {
    libWrapper.register(MODULE, `CONFIG.Actor.documentClass.prototype.${method}`, reasoningRollWrapper, "WRAPPER");
  }
  libWrapper.register(MODULE, "CONFIG.DND5E.activityTypes.attack.documentClass.prototype.rollAttack", async function(wrapped, config = {}, ...args) {
    let result;
    try { result = await wrapped(config, ...args); return result; }
    finally { if (!result?.length) await cancelCampaignAttack(config.workflow); }
  }, "WRAPPER");
  libWrapper.register(MODULE, "MidiQOL.Workflow.prototype.recordTargetACModifiers", function(wrapped, ...args) {
    const result = wrapped(...args); campaignACModifiers(this); return result;
  }, "WRAPPER");
  libWrapper.register(MODULE, "MidiQOL.Workflow.prototype.checkSuperSaver", async function(wrapped, token, abilities) {
    return await wrapped(token, abilities) || intelligenceEvasion(this, token, abilities);
  }, "WRAPPER");
  Hooks.on("dnd5e.postAttackRollConfiguration", enforceGuardRoll);
  for (const type of ["AbilityCheck", "Skill", "SavingThrow", "ToolCheck"]) Hooks.on(`dnd5e.preRoll${type}`, prepareReasoningRoll);
  Hooks.on("midi-qol.preAbort", cancelCampaignAttack);
}

export function registerCampaignFeatures(api) {
  const macro = (identifier, events, rules = "2024") => api.registerFnMacro({source: MODULE, rules, identifier, ...events});
  const pass = (pass, macro, priority = 100) => ({pass, macro, priority});
  const reasoningD20 = [pass("actorSituational", reasoningSituational), pass("actorPost", reasoningPost)];
  const macros = [
    macro(CAMPAIGN_IDS.defense, {roll: [pass("itemRollFinished", activateGuard), pass("actorAttackRollConfig", guardAttackConfig, 200), pass("targetAttackRollConfig", guardedTarget, 240), pass("actorAttackRollBonuses", recordFirstAttack, 1)]}),
    macro(CAMPAIGN_IDS.premonition, {roll: [pass("targetAttackRollComplete", repeatedPremonition, 500)]}),
    macro(CAMPAIGN_IDS.reasoning, {roll: [pass("actorAttackRollConfig", reasoningAttackConfig), pass("actorAttackRollBonuses", reasoningAttackBonus), pass("actorAttackRollComplete", reasoningAttackPost)], save: reasoningD20, check: reasoningD20, skill: reasoningD20, tool: reasoningD20}),
    macro(CAMPAIGN_IDS.regeneration, {combat: [pass("actorTurnStart", guardianRegeneration)]}, "2014")
  ];
  return {macros, automations: CAMPAIGN_AUTOMATIONS.map(({key, name, ...data}) => api.registerAutomation(data))};
}
