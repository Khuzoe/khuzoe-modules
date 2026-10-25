import {withDocumentLock} from "./operation-locks.mjs";
import {RELEASE_VERSION} from "./release.mjs";
import {continueModifiers} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const WORKFLOW_STATE = Symbol("khuzoeKeeperGiantsStrength");
const CRITICAL_STAMPS_FLAG = `flags.${MODULE_ID}.keeperGiantsStrength.criticalStamps`;

export const KEEPER_GIANTS_STRENGTH_IDENTIFIER = "keeper-of-giants-strength";
export const KEEPER_GIANTS_STRENGTH_UUID =
  "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzKeeperGiant01";

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function targetDocuments(workflow, key = "targets") {
  return values(workflow?.[key]).map(tokenDocument).filter(target => target?.actor);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ownerUserId(document) {
  return globalThis.cat?.utils?.queryUtils?.firstOwner?.(document, true)
    ?? globalThis.game?.user?.id;
}

function workflowActionType(workflow) {
  const activity = workflow?.activity;
  return activity?.getActionType?.(workflow?.attackMode) ?? activity?.actionType ?? "";
}

function workflowAttackAbility(workflow) {
  return [
    workflow?.attackRoll?.options?.ability,
    workflow?.rollOptions?.ability,
    workflow?.activity?.attack?.ability,
    workflow?.activity?.ability
  ].find(ability => String(ability ?? "").trim()) ?? "";
}

export function qualifiesKeeperAttack(workflow) {
  return workflowActionType(workflow) === "mwak" && workflowAttackAbility(workflow) === "str";
}

function sizeIndex(actor) {
  const fromCat = globalThis.cat?.utils?.actorUtils?.getSize?.(actor);
  if (Number.isFinite(fromCat)) return Number(fromCat);
  return {tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5}[actor?.system?.traits?.size];
}

export function keeperSizeDifference(sourceActor, targetActor) {
  const source = sizeIndex(sourceActor);
  const target = sizeIndex(targetActor);
  if (!Number.isFinite(source) || !Number.isFinite(target)) return 0;
  return Math.max(0, source - target);
}

function effectIdentifier(effect) {
  return effect?.flags?.cat?.identifier
    ?? effect?.flags?.["chris-premades"]?.info?.identifier
    ?? "";
}

function hasStatus(effect, status) {
  return effect?.statuses?.has?.(status) || values(effect?.statuses).includes(status);
}

function grappleMetadata(effect) {
  return effect?.flags?.["chris-premades"]?.grapple
    ?? effect?.flags?.cat?.grapple;
}

/**
 * Riconosce i legami creati da CPR/CAT e gli effetti con origine esplicita.
 * Un semplice stato "grappled" senza sorgente non basta: potrebbe provenire
 * da un'altra creatura e produrrebbe un falso positivo per il -5/+10.
 */
export function isGrappledBy(targetToken, sourceToken) {
  const target = tokenDocument(targetToken);
  const source = tokenDocument(sourceToken);
  if (!target?.actor || !source?.actor) return false;

  const targetEffects = values(target.actor.effects);
  if (targetEffects.some(effect => {
    if (effect.disabled || effect.isSuppressed || effect.active === false) return false;
    const khuzoeGrapple = effect?.flags?.[MODULE_ID]?.grapple;
    if (khuzoeGrapple?.role === "target" && khuzoeGrapple.sourceTokenUuid === source.uuid) return true;
    const metadata = grappleMetadata(effect);
    if (metadata?.tokenId === source.id) return true;

    const conditions = values(effect?.flags?.["chris-premades"]?.conditions);
    const grappled = hasStatus(effect, "grappled")
      || conditions.includes("grappled")
      || effectIdentifier(effect) === "grappled";
    return grappled && effect.origin === source.actor.uuid;
  })) return true;

  return values(source.actor.effects).some(effect => {
    if (effect.disabled || effect.isSuppressed || effect.active === false) return false;
    const metadata = grappleMetadata(effect);
    return metadata?.tokenId === target.id
      && ["", "grappling"].includes(effectIdentifier(effect));
  });
}

function sameToken(first, second) {
  if (!first || !second) return false;
  if (first.uuid && second.uuid) return first.uuid === second.uuid;
  return Boolean(first.id && second.id && first.id === second.id && first.parent?.id === second.parent?.id);
}

export function qualifiesKeeperPowerAttack(workflow) {
  if (!qualifiesKeeperAttack(workflow)) return false;
  const [target] = targetDocuments(workflow);
  if (!target || targetDocuments(workflow).length !== 1) return false;
  const source = tokenDocument(workflow?.token);
  if (!source?.actor) return false;
  return keeperSizeDifference(source.actor, target.actor) > 0 || isGrappledBy(target, source);
}

export async function configureKeeperPowerAttack({workflow, document} = {}) {
  if (!workflow || !document || !qualifiesKeeperPowerAttack(workflow)) return false;
  if (workflow[WORKFLOW_STATE]?.powerAttack) return true;

  const [target] = targetDocuments(workflow);
  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    `<p>Usare l'attacco poderoso contro <strong>${escapeHtml(target.name)}</strong>?</p>`
      + "<p>Il tiro per colpire riceve <strong>−5</strong>; se colpisce, l'attacco infligge <strong>+10 danni</strong>.</p>",
    {userId: ownerUserId(document)}
  );
  if (!confirmed) return false;

  workflow[WORKFLOW_STATE] = {
    powerAttack: true,
    targetId: target.id,
    targetUuid: target.uuid,
    attackPenaltyApplied: false
  };
  return true;
}

export async function applyKeeperAttackPenalty({workflow} = {}) {
  const state = workflow?.[WORKFLOW_STATE];
  if (!state?.powerAttack || state.attackPenaltyApplied) return false;
  await globalThis.cat.utils.workflowUtils.bonusAttack(
    workflow,
    "-5[Keeper of Giant's Strength]"
  );
  state.attackPenaltyApplied = true;
  return true;
}

function isCritical(workflow) {
  return Boolean(
    workflow?.isCritical
    || workflow?.attackRoll?.isCritical
    || workflow?.attackRoll?.options?.isCritical
  );
}

function combatContext(token) {
  const document = tokenDocument(token);
  const combat = document?.combatant?.combat
    ?? globalThis.game?.combats?.get?.(document?.combatant?.combatId)
    ?? globalThis.game?.combat;
  return {
    token: document,
    tokenId: document?.id ?? "actor",
    combat,
    data: document
      ? globalThis.cat.utils.tokenUtils.getCombatData(document)
      : {inCombat: false}
  };
}

function isSourceTurn(context, actor) {
  if (!context.data.inCombat) return true;
  const current = context.combat?.combatant;
  if (!current) return false;
  return current.tokenId === context.tokenId || current.actorId === actor?.id;
}

async function addPowerAttackDamage(workflow) {
  const state = workflow?.[WORKFLOW_STATE];
  if (!state?.powerAttack) return false;
  const hits = targetDocuments(workflow, "hitTargets");
  const chosenTarget = targetDocuments(workflow).find(target =>
    target.id === state.targetId || target.uuid === state.targetUuid
  );
  if (!chosenTarget || !hits.some(target => sameToken(target, chosenTarget))) return false;

  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, "10", {
    damageType: workflow.defaultDamageType,
    ignoreCrit: true
  });
  return true;
}

async function addCriticalSizeDamage(workflow, document, token) {
  return withDocumentLock(document, "addCriticalSizeDamage", async () => {
  if (!isCritical(workflow)) return false;
  const hits = targetDocuments(workflow, "hitTargets");
  if (hits.length !== 1) return false;

  const actor = document?.parent ?? workflow.actor;
  const difference = keeperSizeDifference(actor, hits[0].actor);
  const strengthModifier = Number(actor?.system?.abilities?.str?.mod ?? 0);
  const amount = difference * strengthModifier;
  if (difference <= 0 || amount <= 0) return false;

  const context = combatContext(token ?? workflow.token);
  if (!isSourceTurn(context, actor)) return false;
  const stamps = document.flags?.[MODULE_ID]?.keeperGiantsStrength?.criticalStamps ?? [];
  if (globalThis.cat.utils.combatUtils.isStampedThisTurn(stamps, context.tokenId, context.data)) return false;

  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, String(amount), {
    damageType: workflow.defaultDamageType,
    ignoreCrit: true
  });

  if (context.data.inCombat) {
    const updated = globalThis.cat.utils.combatUtils.addTurnStamp(stamps, context.tokenId, context.data);
    await updateDocumentSafely(document, {[CRITICAL_STAMPS_FLAG]: updated});
  }
  return true;
  });
}

export async function applyKeeperDamageBonuses({workflow, document, token} = {}) {
  if (!workflow || !document || !qualifiesKeeperAttack(workflow)) return {powerAttack: false, critical: false};
  const powerAttack = await addPowerAttackDamage(workflow);
  const critical = await addCriticalSizeDamage(workflow, document, token);
  return {powerAttack, critical};
}

export function prepareKeeperGiantsStrengthItemUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (identifier !== KEEPER_GIANTS_STRENGTH_IDENTIFIER) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
}

export const KEEPER_GIANTS_STRENGTH_AUTOMATION = Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: KEEPER_GIANTS_STRENGTH_IDENTIFIER,
  version: VERSION,
  uuid: KEEPER_GIANTS_STRENGTH_UUID,
  type: "feat",
  notes: "Automazione homebrew: una volta per turno aggiunge il modificatore di Forza per ogni categoria di taglia di differenza su un critico in mischia; propone inoltre il -5 al tiro per colpire / +10 ai danni contro bersagli più piccoli o afferrati dall'attaccante."
});

export function registerKeeperGiantsStrength(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: KEEPER_GIANTS_STRENGTH_IDENTIFIER,
      roll: [
        {pass: "actorAttackRollConfig", macro: continueModifiers(configureKeeperPowerAttack), priority: 50},
        {pass: "actorAttackRollBonuses", macro: continueModifiers(applyKeeperAttackPenalty), priority: 50},
        {pass: "actorDamageRollBonuses", macro: continueModifiers(applyKeeperDamageBonuses), priority: 70}
      ]
    })
  ];
  return {macros, automations: [api.registerAutomation(KEEPER_GIANTS_STRENGTH_AUTOMATION)]};
}
