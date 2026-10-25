import {RELEASE_VERSION} from "./release.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {adjustAppliedDamage, appliedDamageAmount} from "./damage-adjustment.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const IDENTIFIER = "stones-endurance";
const UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzStoneEndur001";

const useQueues = new Map();
const handledDamageItems = new WeakMap();
const INCAPACITATING_STATUSES = new Set([
  "dead",
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious"
]);

export const GOLIATH_IDS = Object.freeze({stonesEndurance: IDENTIFIER});

export const GOLIATH_AUTOMATIONS = Object.freeze([{
  source: MODULE_ID,
  rules: RULES,
  identifier: IDENTIFIER,
  version: VERSION,
  uuid: UUID,
  type: "feat",
  notes: "Quando il Goliath subisce danni propone al suo owner Stone's Endurance, consuma reazione e uso e riduce il danno di 1d12 + Costituzione."
}]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function ownerUserId(document) {
  return globalThis.cat.utils.queryUtils.firstOwner(document, true) ?? game.user.id;
}

function incomingDamage(ditem) {
  return appliedDamageAmount(ditem);
}

export function stonesEnduranceReduction(rollTotal, damage) {
  const rolled = Math.max(0, Math.floor(Number(rollTotal) || 0));
  return Math.min(Math.max(0, Number(damage) || 0), rolled);
}

function usesRemaining(item) {
  const prepared = Number(item?.system?.uses?.value);
  const maximum = Number(item?.system?.uses?.max);
  const spent = Math.max(0, Number(item?.system?.uses?.spent ?? 0));
  if (Number.isFinite(maximum) && maximum > 0) return Math.max(0, maximum - spent);
  if (Number.isFinite(prepared)) return Math.max(0, prepared);
  return 0;
}

function actorCanReact(actor) {
  if (!actor || typeof globalThis.MidiQOL?.setReactionUsed !== "function") return false;
  if (globalThis.cat.utils.actorUtils.hasUsedReaction(actor)) return false;
  if (Number(actor?.system?.attributes?.hp?.value ?? 1) <= 0) return false;
  return !values(actor?.statuses).some(status => INCAPACITATING_STATUSES.has(String(status)));
}

function damageItemWasHandled(ditem, document) {
  if (!ditem || typeof ditem !== "object") return false;
  let documents = handledDamageItems.get(ditem);
  if (!documents) handledDamageItems.set(ditem, documents = new Set());
  const key = document?.uuid ?? document?.id ?? IDENTIFIER;
  if (documents.has(key)) return true;
  documents.add(key);
  return false;
}

async function withUseQueue(document, operation) {
  const key = document?.uuid ?? `${document?.documentName ?? "Item"}.${document?.id ?? IDENTIFIER}`;
  const previous = useQueues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  useQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (useQueues.get(key) === queued) useQueues.delete(key);
  }
}

async function refreshedItem(item) {
  if (!item?.uuid || typeof globalThis.fromUuid !== "function") return item;
  try {
    return await globalThis.fromUuid(item.uuid) ?? item;
  } catch (_error) {
    return item;
  }
}

async function reserveUseAndReaction(item, actor) {
  if (!actorCanReact(actor)) return null;
  return reserveResources(actor, {item, reaction: true});
}

async function refundReservation(reservation) {
  return refundResources(reservation);
}

async function rollEndurance(actor) {
  const RollClass = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
  if (typeof RollClass !== "function") throw new Error("Classe Roll di Foundry non disponibile.");
  const modifier = Number(actor?.system?.abilities?.con?.mod ?? 0);
  const formula = modifier >= 0 ? `1d12 + ${modifier}` : `1d12 - ${Math.abs(modifier)}`;
  const roll = await new RollClass(formula, actor?.getRollData?.() ?? actor?.system ?? {}).evaluate();
  return roll;
}

async function postReductionRoll(roll, actor, token, damage, reduction) {
  if (typeof roll?.toMessage !== "function") return;
  const speaker = globalThis.ChatMessage?.getSpeaker?.({actor, token: token?.document ?? token});
  await roll.toMessage({
    speaker,
    flavor: `<strong>Stone's Endurance</strong>: riduce ${damage} danni in arrivo di <strong>${reduction}</strong>.`
  });
}

export async function useStonesEndurance({workflow, targetToken, ditem, document} = {}) {
  if (workflow?.workflowOptions?.khuzoeUnreducible) return false;
  const actor = document?.actor ?? targetToken?.actor ?? targetToken?.document?.actor;
  const damage = incomingDamage(ditem);
  if (!actorCanReact(actor) || !document || damage <= 0 || usesRemaining(document) <= 0) return false;
  if (damageItemWasHandled(ditem, document)) return false;

  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name ?? "Stone's Endurance",
    `<p>Hai subito <strong>${damage}</strong> danni. Usare la reazione per ridurli di <strong>1d12 + Costituzione</strong>?</p>`,
    {userId: ownerUserId(actor)}
  );
  if (!confirmed) return false;

  let reservation;
  try {
    reservation = await reserveUseAndReaction(document, actor);
    if (!reservation) return false;

    const roll = await rollEndurance(actor);
    const reduction = stonesEnduranceReduction(roll.total, damage);
    if (reduction > 0) {
      adjustAppliedDamage(ditem, -reduction);
    }
    try {
      await postReductionRoll(roll, actor, targetToken, damage, reduction);
    } catch (error) {
      console.warn("Khuzoe Automations | Impossibile pubblicare il tiro di Stone's Endurance.", error);
    }
    return true;
  } catch (error) {
    if (reservation) await refundReservation(reservation, actor);
    console.error("Khuzoe Automations | Stone's Endurance non riuscita; uso e reazione sono stati ripristinati.", error);
    ui.notifications?.error?.("Stone's Endurance non riuscita: uso e reazione sono stati ripristinati.");
    return false;
  }
}

export function prepareGoliathItemUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (identifier !== IDENTIFIER || changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
  if (!changes.system?.uses) return;

  const currentUses = item?.toObject?.().system?.uses ?? item?.system?.uses;
  if (currentUses) changes.system.uses = structuredClone(currentUses);
}

export function registerGoliath(api) {
  const macros = [api.registerFnMacro({
    source: MODULE_ID,
    rules: RULES,
    identifier: IDENTIFIER,
    roll: [{pass: "targetDamageFlatReductions", macro: useStonesEndurance, priority: 45}]
  })];
  return {macros, automations: GOLIATH_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
