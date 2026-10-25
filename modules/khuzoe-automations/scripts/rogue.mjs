import {RELEASE_VERSION} from "./release.mjs";
import {nearbyTokens} from "./movement-compat.mjs";
import {adjustAppliedDamage, appliedDamageAmount} from "./damage-adjustment.mjs";
import {runSyntheticActivity, continueModifiers} from "./activity-compat.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {withDocumentLock} from "./operation-locks.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";

export const ROGUE_IDS = Object.freeze({
  sneakAttack: "sneak-attack",
  cunningAction: "cunning-action",
  uncannyDodge: "uncanny-dodge",
  evasion: "evasion",
  reliableTalent: "reliable-talent"
});

export const ROGUE_ACTIVITY_IDS = Object.freeze({
  cunningDash: "KhzRogDashAct001",
  cunningDisengage: "KhzRogDisengage1",
  cunningHide: "KhzRogHideAct001",
  uncannyDodge: "KhzRogUncanAct01"
});

const ROGUE_DOCUMENTS = Object.freeze([
  [ROGUE_IDS.sneakAttack, "KhzRogSneakAtk01", "Propone Sneak Attack sugli attacchi idonei, calcola i dadi dalla scala del Ladro e ne consente un solo uso per turno, incluse le reazioni fuori dal proprio turno."],
  [ROGUE_IDS.cunningAction, "KhzRogCunning001", "Aggiunge attività separate come azione bonus per Dash, Disengage e Hide, integrandole con il tracciamento dell'economia delle azioni di Midi-QOL."],
  [ROGUE_IDS.uncannyDodge, "KhzRogUncanny001", "Quando un attaccante visibile colpisce, propone la reazione e dimezza i danni dell'attacco dopo le altre modifiche applicabili."],
  [ROGUE_IDS.evasion, "KhzRogEvasion001", "Usa il supporto Super Saver di Midi-QOL per infliggere zero danni su un tiro salvezza di Destrezza riuscito e metà danni su un fallimento."],
  [ROGUE_IDS.reliableTalent, "KhzRogReliable01", "Attiva il supporto nativo D&D5e per trattare come 10 i risultati naturali inferiori a 10 nelle prove in cui il Ladro possiede competenza."]
]);

export const ROGUE_IDENTIFIERS = new Set(ROGUE_DOCUMENTS.map(([identifier]) => identifier));

export const ROGUE_AUTOMATIONS = ROGUE_DOCUMENTS.map(([identifier, id, notes]) => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier,
  version: VERSION,
  uuid: `${PACK}.${id}`,
  type: "feat",
  notes
}));

const INCAPACITATING_STATUSES = new Set([
  "dead",
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious"
]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  if (typeof collection === "object" && !collection[Symbol.iterator]) return Object.values(collection);
  return Array.from(collection);
}

function slug(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenDocument(token) {
  return token?.document ?? token ?? null;
}

function targetDocuments(workflow, key = "hitTargets") {
  return values(workflow?.[key]).map(tokenDocument).filter(Boolean);
}

function sameToken(left, right) {
  left = tokenDocument(left);
  right = tokenDocument(right);
  if (!left || !right) return false;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return Boolean(left.id && right.id && left.id === right.id && left.parent?.id === right.parent?.id);
}

function ownerUserId(document) {
  return globalThis.cat.utils.queryUtils.firstOwner(document, true) ?? game.user.id;
}

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function itemHasProperty(item, property) {
  const properties = item?.system?.properties;
  if (typeof properties?.has === "function") return properties.has(property);
  if (Array.isArray(properties)) return properties.includes(property);
  return Boolean(properties?.[property]);
}

function isRogueClass(item) {
  if (item?.type !== "class") return false;
  return ["rogue", "ladro"].includes(slug(item?.system?.identifier || item?.name));
}

export function getRogueLevel(actor) {
  const direct = Number(actor?.classes?.rogue?.system?.levels);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  const classItem = values(actor?.items).find(isRogueClass);
  const level = Number(classItem?.system?.levels ?? 0);
  return Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

function diceFormula(value) {
  if (typeof value === "string" && /\d+d\d+/i.test(value)) return value;
  if (Number.isFinite(Number(value)) && Number(value) > 0) return `${Math.floor(Number(value))}d6`;
  if (!value || typeof value !== "object") return null;

  if (typeof value.formula === "string" && value.formula.trim()) return value.formula;
  const nested = diceFormula(value.value);
  if (nested) return nested;
  const number = Number(value.number ?? value.count);
  const faces = Number(value.faces ?? value.denomination ?? 6);
  if (Number.isFinite(number) && number > 0 && Number.isFinite(faces) && faces > 0) {
    const bonus = String(value.bonus ?? "").trim();
    return `${Math.floor(number)}d${Math.floor(faces)}${bonus ? ` + ${bonus}` : ""}`;
  }
  return null;
}

export function sneakAttackFormula(actor) {
  const scale = actor?.system?.scale?.rogue?.["sneak-attack"]
    ?? actor?.system?.scale?.rogue?.sneakAttack;
  const prepared = diceFormula(scale);
  if (prepared) return prepared;

  if (actor?.type === "npc") {
    const challenge = Number(actor?.system?.details?.cr ?? 0);
    return `${Math.max(1, Math.ceil(challenge / 2))}d6`;
  }
  return `${Math.max(1, Math.ceil(getRogueLevel(actor) / 2))}d6`;
}

function qualifiesSneakAttackWeapon(workflow) {
  const {workflowUtils} = globalThis.cat.utils;
  if (workflowUtils.isAttackType(workflow, "rangedWeaponAttack")) return true;
  return workflowUtils.isAttackType(workflow, "meleeWeaponAttack")
    && itemHasProperty(workflow?.item, "fin");
}

function sneakCombatContext(token) {
  const document = tokenDocument(token);
  return {
    token: document,
    tokenId: document?.id ?? "actor",
    data: document
      ? globalThis.cat.utils.tokenUtils.getCombatData(document)
      : {inCombat: false}
  };
}

function sneakAttackStamps(item) {
  const stamps = item?.flags?.[MODULE_ID]?.sneakAttackStamps;
  return Array.isArray(stamps) ? stamps : [];
}

function hasAdjacentEnemyOfTarget(target, source) {
  if (!target || !source) return false;
  const {tokenUtils} = globalThis.cat.utils;
  return nearbyTokens(target, 5, {
    disposition: "all",
    includeIncapacitated: false,
    includeToken: false
  }).some(candidate => !sameToken(candidate, source) && tokenUtils.isEnemy(target, candidate));
}

function hasSneakAttackCondition(workflow, target, source) {
  if (workflow?.disadvantage) return false;
  if (workflow?.advantage) return true;
  return hasAdjacentEnemyOfTarget(target, source);
}

export async function applySneakAttack({workflow, document, token} = {}) {
  if (!workflow || !document || !qualifiesSneakAttackWeapon(workflow)) return false;
  return withDocumentLock(document, "sneak-attack", async () => {
  if (workflow.aborted || workflow.khuzoeSneakAttackApplied) return false;
  const hits = targetDocuments(workflow, "hitTargets");
  if (hits.length !== 1) return false;

  const context = sneakCombatContext(token ?? workflow.token);
  const stamps = sneakAttackStamps(document);
  if (globalThis.cat.utils.combatUtils.isStampedThisTurn(stamps, context.tokenId, context.data)) return false;
  if (!hasSneakAttackCondition(workflow, hits[0], context.token)) return false;

  const use = await globalThis.cat.utils.dialogUtils.confirmUseItem(document, {
    userId: ownerUserId(document.actor ?? workflow.actor)
  });
  if (!use) return false;

  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, sneakAttackFormula(document.actor ?? workflow.actor), {
    damageType: workflow.defaultDamageType
  });
  workflow.khuzoeSneakAttackApplied = true;
  if (context.data.inCombat) {
    const updated = globalThis.cat.utils.combatUtils.addTurnStamp(stamps, context.tokenId, context.data);
    await updateDocumentSafely(document, {
      [`flags.${MODULE_ID}.sneakAttackStamps`]: updated
    });
  }
  return true;
  });
}

function actorCanReact(actor) {
  if (!actor || globalThis.cat.utils.actorUtils.hasUsedReaction(actor)) return false;
  if (Number(actor?.system?.attributes?.hp?.value ?? 1) <= 0) return false;
  return !values(actor?.statuses).some(status => INCAPACITATING_STATUSES.has(String(status)));
}

function canSeeAttacker(defender, attacker) {
  try {
    return globalThis.MidiQOL?.canSee?.(defender?.object, attacker?.object) ?? true;
  } catch (_error) {
    return true;
  }
}

function incomingDamage(ditem) {
  return appliedDamageAmount(ditem);
}

export async function useUncannyDodge({workflow, targetToken, sourceToken, ditem, document} = {}) {
  const actor = document?.actor ?? tokenDocument(targetToken)?.actor;
  const defender = tokenDocument(targetToken);
  const attacker = tokenDocument(workflow?.token);
  if (!actorCanReact(actor) || !workflow || !ditem) return false;
  if (!globalThis.cat.utils.workflowUtils.isAttackType(workflow, "attack")) return false;
  if (!canSeeAttacker(defender, attacker)) return false;

  const hits = targetDocuments(workflow, "hitTargets");
  if (hits.length && defender && !hits.some(hit => sameToken(hit, defender))) return false;
  const damage = incomingDamage(ditem);
  if (damage <= 0) return false;

  const use = await globalThis.cat.utils.dialogUtils.confirmUseItem(document, {
    userId: ownerUserId(actor)
  });
  if (!use) return false;

  const receipt = await reserveResources(actor, {reaction: true});
  if (!receipt) return false;
  try {
  const activity = itemActivity(document, ROGUE_ACTIVITY_IDS.uncannyDodge);
  if (activity) {
    const result = await runSyntheticActivity(activity, [], {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(actor)
    });
    if (!result || result.aborted) { await refundResources(receipt); return false; }
  }

  // Per 21 danni il risultato dimezzato è 10, non 11: in D&D ogni
  // frazione viene arrotondata per difetto, quindi la riduzione è ceil(21/2).
  adjustAppliedDamage(ditem, -Math.ceil(damage / 2));
  } catch (error) { await refundResources(receipt); throw error; }
  return true;
}

export function prepareRogueItemUpdate(item, changes) {
  const updatedIdentifier = slug(changes?.system?.identifier ?? item?.system?.identifier);
  if (!ROGUE_IDENTIFIERS.has(updatedIdentifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
}

export function registerRogue(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: ROGUE_IDS.sneakAttack,
      roll: [{pass: "actorDamageRollBonuses", macro: continueModifiers(applySneakAttack), priority: 45}]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: ROGUE_IDS.uncannyDodge,
      roll: [{pass: "targetDamageFlatReductions", macro: continueModifiers(useUncannyDodge), priority: 40}]
    })
  ];
  return {macros, automations: ROGUE_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
