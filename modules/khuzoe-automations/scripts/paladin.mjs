import {RELEASE_VERSION} from "./release.mjs";
import {circularAuraTokenDistance, sceneUnitsPerFoot} from "./geometry.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {runSyntheticActivityData} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {isAuraCreature} from "./aura-targeting.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";

export const PALADIN_IDS = Object.freeze({
  layOnHands: "lay-on-hands",
  divineSmite: "divine-smite",
  auraProtection: "aura-of-protection",
  auraCourage: "aura-of-courage",
  holyNimbus: "holy-nimbus"
});

export const PALADIN_ACTIVITY_IDS = Object.freeze({
  layHeal: "KhzLayHealUse001",
  layPoison: "KhzLayCurePois01",
  layDisease: "KhzLayCureDise01",
  layTechnicalHeal: "KhzLayTechHeal01",
  holyNimbus: "KhzHolyNimbus001",
  holyNimbusDamage: "KhzHolyDamage001"
});

export const PALADIN_EFFECT_IDS = Object.freeze({
  holyNimbus: "khuzoe-holy-nimbus-active"
});

export const PALADIN_AURA_DISTANCE_FLAG = "khuzoePaladinAuraDistance";

const PALADIN_AURA_ICON_VISIBILITY = new Map([
  [PALADIN_IDS.auraProtection, 2],
  [PALADIN_IDS.auraCourage, 0],
  ["aura-of-devotion", 0]
]);
const PALADIN_AURA_VISUAL = Object.freeze({
  color: "#f2d66d",
  opacity: 0.035,
  lineOpacity: 0.26,
  lineWidth: 1.25
});
const HOLY_NIMBUS_VISUAL = Object.freeze({
  color: "#ffe36d",
  opacity: 0.075,
  lineOpacity: 0.42,
  lineWidth: 1.5
});
// Holy Nimbus damage follows the displayed aura, independently of token light
// and walls. Keep the mechanical range and the displayed circle in sync.
const HOLY_NIMBUS_RADIUS_FEET = 30;

const MANAGED_PALADIN_AURAS = new Set([
  PALADIN_IDS.auraProtection,
  PALADIN_IDS.auraCourage
]);
const PALADIN_AURA_RECONCILE_DELAY = 75;
const PALADIN_AURA_DOCUMENT_OPTIONS = Object.freeze({
  khuzoePaladinAuraReconcile: true,
  animate: false
});

function paladinAuraDocumentOptions() {
  // Foundry/Midi-QOL enrich the options object (for example with `parent`)
  // while creating embedded documents. Keep the shared template immutable,
  // but always hand document APIs a fresh, extensible object.
  return {...PALADIN_AURA_DOCUMENT_OPTIONS};
}

let paladinAuraQueue = Promise.resolve();
let paladinAuraTimer;
let pendingAuraScene;
const pendingAuraActors = new Set();
const pendingAuraMovementGenerations = new WeakMap();
let holyNimbusQueue = Promise.resolve();
let holyNimbusTurnStamp = "";
const holyNimbusTurnSources = new Set();

const PALADIN_DOCUMENTS = Object.freeze([
  [PALADIN_IDS.layOnHands, "KhzPalLayHands01", "Gestisce la riserva pari a cinque volte il livello da Paladino, la cura scelta dal giocatore e il costo di 5 punti per neutralizzare un veleno o curare una malattia."],
  [PALADIN_IDS.divineSmite, "KhzPalDivSmite01", "Dopo un colpo con arma da mischia propone Divine Smite, consuma lo slot scelto e applica i dadi corretti, incluso il bonus contro immondi e non morti."],
  [PALADIN_IDS.auraProtection, "KhzPalAuraProt01", "Applica agli alleati il bonus di Carisma ai tiri salvezza entro 10 ft, o 30 ft dal livello 18, soltanto mentre il Paladino è cosciente."],
  [PALADIN_IDS.auraCourage, "KhzPalAuraCour01", "Conferisce immunità alla paura agli alleati entro 10 ft, o 30 ft dal livello 18, soltanto mentre il Paladino è cosciente."],
  [PALADIN_IDS.holyNimbus, "KhzPalHolyNimb01", "Attiva per 1 minuto l'aura sacra del Paladino: 10 danni radianti ai nemici che iniziano il turno nel cerchio da 30 ft, indipendentemente da muri e illuminazione. Emette anche luce intensa entro 30 ft e fioca per altri 30 ft e concede vantaggio ai TS contro magie lanciate da immondi o non morti."]
]);

export const PALADIN_IDENTIFIERS = new Set(PALADIN_DOCUMENTS.map(([identifier]) => identifier));

export const PALADIN_AUTOMATIONS = PALADIN_DOCUMENTS.map(([identifier, id, notes]) => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier,
  version: VERSION,
  uuid: `${PACK}.${id}`,
  type: "feat",
  notes
}));

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

function identifier(document) {
  return slug(document?.system?.identifier || document?.flags?.cat?.identifier || document?.name);
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function targetDocuments(workflow, key = "targets") {
  return values(workflow?.[key]).map(tokenDocument).filter(target => target?.actor);
}

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function macroReference(identifier) {
  return {source: MODULE_ID, rules: RULES, identifier};
}

function ownerUserId(document) {
  return globalThis.cat.utils.queryUtils.firstOwner(document, true) ?? game.user.id;
}

function escapeHtml(value) {
  if (!globalThis.document?.createElement) return String(value ?? "");
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function notify(message) {
  ui.notifications.warn(message);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPaladinClass(item) {
  if (item?.type !== "class") return false;
  return ["paladin", "paladino"].includes(identifier(item));
}

export function getPaladinLevel(actor) {
  const direct = Number(actor?.classes?.paladin?.system?.levels);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  const classItem = values(actor?.items).find(isPaladinClass);
  const level = Number(classItem?.system?.levels ?? 0);
  return Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

export function paladinAuraDistance(actor) {
  return getPaladinLevel(actor) >= 18 ? 30 : 10;
}

function layOnHandsMaximum(item) {
  const levelMaximum = getPaladinLevel(item?.actor) * 5;
  if (levelMaximum > 0) return levelMaximum;
  const stored = Number(item?.system?.uses?.max ?? 0);
  return Number.isFinite(stored) ? Math.max(0, stored) : 0;
}

function layOnHandsRemaining(item) {
  return Math.max(0, layOnHandsMaximum(item) - Number(item?.system?.uses?.spent ?? 0));
}

function effectsWithStatus(actor, status) {
  return values(actor?.effects).filter(effect => {
    if (effect?.active === false || effect?.disabled) return false;
    const statuses = effect?.statuses;
    return statuses?.has?.(status) || values(statuses).includes(status);
  });
}

function layOnHandsMode(activityId) {
  if (activityId === PALADIN_ACTIVITY_IDS.layHeal) return "heal";
  if (activityId === PALADIN_ACTIVITY_IDS.layPoison) return "poison";
  if (activityId === PALADIN_ACTIVITY_IDS.layDisease) return "disease";
}

function invalidLayOnHandsCreature(actor) {
  const type = globalThis.cat.utils.actorUtils.typeOrRace(actor);
  return ["construct", "undead"].includes(type);
}

async function chooseConditionEffect(item, target, mode) {
  const status = mode === "poison" ? "poisoned" : "diseased";
  const effects = effectsWithStatus(target.actor, status);
  if (!effects.length) {
    notify(`${target.name}: non è stato trovato alcun effetto ${mode === "poison" ? "di veleno" : "di malattia"} compatibile.`);
    return null;
  }
  if (effects.length === 1) return effects[0];
  return globalThis.cat.utils.dialogUtils.selectDocumentDialog(
    item.name,
    `<p>Scegli ${mode === "poison" ? "il veleno da neutralizzare" : "la malattia da curare"} su <strong>${escapeHtml(target.name)}</strong>.</p>`,
    effects,
    {userId: ownerUserId(item.actor)}
  );
}

async function prepareLayOnHands({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  const activityId = workflow?.activity?.id;
  const mode = layOnHandsMode(activityId);
  if (!feature || !mode || activityId === PALADIN_ACTIVITY_IDS.layTechnicalHeal) return;

  const targets = targetDocuments(workflow);
  if (targets.length !== 1) {
    notify(`${feature.name}: seleziona esattamente una creatura.`);
    return true;
  }
  const target = targets[0];
  if (invalidLayOnHandsCreature(target.actor)) {
    notify(`${feature.name} non ha effetto su costrutti o non morti.`);
    return true;
  }

  const remaining = layOnHandsRemaining(feature);
  if (mode === "heal") {
    const hp = target.actor.system?.attributes?.hp ?? {};
    const missing = Math.max(0, Number(hp.max ?? 0) - Number(hp.value ?? 0));
    const maximum = Math.min(remaining, missing);
    if (remaining <= 0) {
      notify(`${feature.name}: la riserva è esaurita.`);
      return true;
    }
    if (maximum <= 0) {
      notify(`${target.name} è già al massimo dei punti ferita.`);
      return true;
    }
    const selected = await globalThis.cat.utils.dialogUtils.numberDialog(
      feature.name,
      `<p>Scegli quanti punti della riserva usare per curare <strong>${escapeHtml(target.name)}</strong>. Disponibili: <strong>${remaining}</strong>.</p>`,
      {
        label: "Punti ferita",
        name: "amount",
        options: {min: 1, max: maximum, step: 1, value: maximum}
      },
      {userId: ownerUserId(feature.actor)}
    );
    if (selected === undefined || selected === null || selected === false || selected === "") return true;
    const amount = clamp(Math.floor(Number(selected) || 0), 1, maximum);
    workflow.khuzoeLayOnHands = {mode, amount, target};
    return;
  }

  if (remaining < 5) {
    notify(`${feature.name}: servono 5 punti della riserva, ma ne rimangono ${remaining}.`);
    return true;
  }
  const effect = await chooseConditionEffect(feature, target, mode);
  if (!effect) return true;
  workflow.khuzoeLayOnHands = {mode, amount: 5, target, effect};
}

async function finishLayOnHands({workflow, document, item}) {
  const pending = workflow?.khuzoeLayOnHands;
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!pending || !feature) return;
  if (layOnHandsRemaining(feature) < pending.amount) {
    notify(`${feature.name}: la riserva non contiene più punti sufficienti.`);
    return;
  }

  if (pending.mode === "heal") {
    const hp = pending.target.actor.system?.attributes?.hp ?? {};
    const missing = Math.max(0, Number(hp.max ?? 0) - Number(hp.value ?? 0));
    const amount = Math.min(pending.amount, missing, layOnHandsRemaining(feature));
    if (amount <= 0) return;
    const activity = itemActivity(feature, PALADIN_ACTIVITY_IDS.layTechnicalHeal);
    if (!activity?.toObject) throw new Error("Attività tecnica di guarigione Lay on Hands non disponibile.");
    const activityData = activity.toObject();
    activityData.healing ??= {};
    activityData.healing.custom = {enabled: true, formula: String(amount)};
    const receipt = await reserveResources(feature.actor, {item: feature, amount});
    if (!receipt) return;
    try {
    const result = await runSyntheticActivityData(
      activityData,
      feature,
      [pending.target],
      {
        consumeUsage: false,
        consumeResources: false,
        spellSlot: false,
        userId: ownerUserId(feature.actor)
      }
    );
    if (!result || result.aborted) await refundResources(receipt);
    } catch (error) { await refundResources(receipt); throw error; }
    return;
  }

  const currentEffect = pending.target.actor.effects?.get?.(pending.effect.id)
    ?? effectsWithStatus(pending.target.actor, pending.mode === "poison" ? "poisoned" : "diseased")
      .find(effect => effect.id === pending.effect.id);
  if (!currentEffect) {
    notify(`${feature.name}: l'effetto scelto non è più presente.`);
    return;
  }
  const receipt = await reserveResources(feature.actor, {item: feature, amount: 5});
  if (!receipt) return;
  try { await globalThis.cat.utils.documentUtils.deleteDocument(currentEffect); }
  catch (error) { await refundResources(receipt); throw error; }
}

const UNARMED_IDENTIFIERS = new Set(["unarmed-strike", "unarmed-strike-2014", "colpo-senz-armi"]);

function isMeleeWeaponAttack(workflow) {
  const actionType = workflow?.activity?.getActionType?.(workflow.attackMode) ?? workflow?.activity?.actionType ?? workflow?.item?.system?.actionType;
  if (actionType !== "mwak") return false;
  return !UNARMED_IDENTIFIERS.has(identifier(workflow?.item));
}

async function useDivineSmite({workflow, document}) {
  if (!workflow || !document?.actor || !isMeleeWeaponAttack(workflow)) return;
  const targets = targetDocuments(workflow, "hitTargets");
  if (targets.length !== 1) return;
  const actor = document.actor;
  if (!globalThis.cat.utils.actorUtils.hasSpellSlots(actor, 1)) return;

  const selection = await globalThis.cat.utils.dialogUtils.selectSpellSlot(
    actor,
    document.name,
    `<p>Usare <strong>${escapeHtml(document.name)}</strong> contro <strong>${escapeHtml(targets[0].name)}</strong>?</p>`,
    {minLevel: 1, no: true, userId: ownerUserId(actor)}
  );
  if (!selection) return;

  const slotLevel = selection === "pact"
    ? Number(actor.system?.spells?.pact?.level ?? 0)
    : Number(selection);
  if (!Number.isFinite(slotLevel) || slotLevel < 1) return;

  let dice = Math.min(slotLevel + 1, 5);
  const targetType = globalThis.cat.utils.actorUtils.typeOrRace(targets[0].actor);
  if (["fiend", "undead"].includes(targetType)) dice += 1;

  const receipt = await reserveResources(actor, {slot: selection});
  if (!receipt) return;
  try {
    await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, `${dice}d8`, {damageType: "radiant"});
  } catch (error) { await refundResources(receipt); throw error; }
}

function holyNimbusEffects(actor) {
  return values(actor?.effects).filter(effect => (
    !effect?.disabled
    && effect?.active !== false
    && identifier(effect) === PALADIN_EFFECT_IDS.holyNimbus
  ));
}

async function replaceHolyNimbusEffect(item) {
  const actor = item?.actor;
  if (!actor) return null;
  for (const effect of holyNimbusEffects(actor)) {
    await globalThis.cat.utils.documentUtils.deleteDocument(effect);
  }

  const reference = macroReference(PALADIN_EFFECT_IDS.holyNimbus);
  const effectData = {
    name: item.name || "Holy Nimbus",
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {
      changes: [
        {key: "token.light.dim", value: String(2 * HOLY_NIMBUS_RADIUS_FEET * sceneUnitsPerFoot(globalThis.canvas?.scene)), priority: 20, type: "override"},
        {key: "token.light.bright", value: String(HOLY_NIMBUS_RADIUS_FEET * sceneUnitsPerFoot(globalThis.canvas?.scene)), priority: 20, type: "override"}
      ]
    },
    disabled: false,
    duration: {value: 60, units: "seconds", expiry: "turnStart", expired: false},
    statuses: [],
    description: "<p>I nemici che iniziano il turno nel cerchio dell'aura da 30 ft subiscono 10 danni radianti, indipendentemente da muri e illuminazione. Emana anche luce solare intensa entro 30 ft e luce fioca per altri 30 ft. Il Paladino ha vantaggio ai TS contro magie lanciate da immondi o non morti.</p>",
    showIcon: globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
    flags: {
      cat: {
        identifier: PALADIN_EFFECT_IDS.holyNimbus,
        noAnimation: true,
        macros: {save: [reference]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
      "midi-qol": {forceCEOff: true},
      [MODULE_ID]: {holyNimbus: true}
    }
  };
  return globalThis.cat.utils.documentUtils.createEmbeddedDocuments(
    actor,
    "ActiveEffect",
    [effectData]
  );
}

export async function activateHolyNimbus({workflow, document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || workflow?.activity?.id !== PALADIN_ACTIVITY_IDS.holyNimbus) return;
  return replaceHolyNimbusEffect(feature);
}

function holyNimbusSaveSource(config) {
  const activityUuid = config?.cat?.activityUuid;
  const activity = activityUuid && typeof globalThis.fromUuidSync === "function"
    ? globalThis.fromUuidSync(activityUuid, {strict: false})
    : null;
  if (activity?.item) return activity.item;
  if (activity?.parent?.documentName === "Item") return activity.parent;

  const itemUuid = config?.midiOptions?.saveItemUuid;
  if (!itemUuid || typeof globalThis.fromUuidSync !== "function") return null;
  const resolved = globalThis.fromUuidSync(itemUuid, {strict: false});
  return resolved?.item ?? (resolved?.documentName === "Item" ? resolved : resolved?.parent);
}

export function holyNimbusSaveAdvantage({config} = {}) {
  const spell = holyNimbusSaveSource(config);
  if (spell?.type !== "spell") return;
  const casterType = String(globalThis.cat.utils.actorUtils.typeOrRace(spell.actor) ?? "").toLowerCase();
  if (!["fiend", "undead"].includes(casterType)) return;
  return {label: "Holy Nimbus: magia di immondo o non morto", type: "advantage"};
}

function currentCombatToken(combat, current) {
  const combatantId = current?.combatantId ?? combat?.current?.combatantId;
  const combatant = combatantId
    ? combat?.combatants?.get?.(combatantId)
    : combat?.combatant;
  return tokenDocument(
    combatant?.token
    ?? combat?.scene?.tokens?.get?.(current?.tokenId ?? combatant?.tokenId)
    ?? globalThis.canvas?.scene?.tokens?.get?.(current?.tokenId ?? combatant?.tokenId)
  );
}

async function holyNimbusOriginItem(effect, actor) {
  if (effect?.origin && typeof globalThis.fromUuid === "function") {
    const origin = await globalThis.fromUuid(effect.origin);
    if (origin?.documentName === "Item") return origin;
  }
  return values(actor?.items).find(item => identifier(item) === PALADIN_IDS.holyNimbus) ?? null;
}

async function applyHolyNimbusDamage(effect, target) {
  const feature = await holyNimbusOriginItem(effect, effect?.parent);
  const activity = itemActivity(feature, PALADIN_ACTIVITY_IDS.holyNimbusDamage);
  if (!feature || !activity?.toObject || !target?.actor) return false;
  const result = await runSyntheticActivityData(
    activity.toObject(),
    feature,
    [target],
    {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(feature.actor)
    }
  );
  return Boolean(result && !result.aborted);
}

async function performHolyNimbusTurnStart(combat, current) {
  const scene = combat?.scene ?? globalThis.canvas?.scene;
  const target = currentCombatToken(combat, current);
  if (!scene || !isAuraCreature(target) || target.parent?.id !== scene.id) return false;

  const stamp = [
    combat?.id ?? "combat",
    current?.round ?? combat?.round ?? 0,
    current?.turn ?? combat?.turn ?? 0,
    target.id ?? target.uuid
  ].join(":");
  if (holyNimbusTurnStamp !== stamp) {
    holyNimbusTurnStamp = stamp;
    holyNimbusTurnSources.clear();
  }

  let applied = false;
  const seenActors = new Set();
  for (const source of values(scene.tokens).filter(isAuraCreature)) {
    const sourceKey = source.actor.uuid ?? source.actor.id;
    if (!sourceKey || seenActors.has(sourceKey)) continue;
    if (source.id === target.id) continue;
    const effect = holyNimbusEffects(source.actor)[0];
    if (!effect) continue;
    const isEnemy = globalThis.cat?.utils?.tokenUtils?.isEnemy;
    const hostile = typeof isEnemy === "function"
      ? isEnemy(source, target)
      : Number(source.disposition ?? 0) !== Number(target.disposition ?? 0);
    if (!hostile || paladinAuraTokenDistance(source, target) > HOLY_NIMBUS_RADIUS_FEET + 1e-6) continue;
    // Linked tokens share the effect, but each token has its own position.
    seenActors.add(sourceKey);
    const ledgerKey = stamp;
    if (holyNimbusTurnSources.has(ledgerKey)) continue;
    const damaged = await applyHolyNimbusDamage(effect, target);
    if (damaged) {
      holyNimbusTurnSources.add(ledgerKey);
      applied = true;
      break;
    }
  }
  return applied;
}

export function triggerHolyNimbusTurnStart(combat, current = combat?.current) {
  if (!combat || !auraExecutor()) return Promise.resolve(false);
  const task = () => performHolyNimbusTurnStart(combat, current);
  const result = holyNimbusQueue.then(task, task);
  holyNimbusQueue = result.catch(error => {
    console.error("Khuzoe Automations | Holy Nimbus non è riuscita ad applicare il danno di inizio turno.", error);
    return false;
  });
  return holyNimbusQueue;
}

function auraSourceOperational(actor) {
  if (!actor || Number(actor.system?.attributes?.hp?.value ?? 0) <= 0) return false;
  return !["dead", "unconscious"].some(status => actor.statuses?.has?.(status));
}

function auraEffectData(item, changes, description, {showIcon = 0} = {}) {
  const auraIdentifier = identifier(item);
  return {
    name: item.name,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {changes},
    disabled: false,
    duration: {value: null, units: "seconds", expired: false},
    statuses: [],
    description,
    showIcon,
    flags: {
      cat: {
        identifier: `khuzoe-paladin-${auraIdentifier}`,
        noAnimation: true
      },
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
      [MODULE_ID]: {
        paladinAura: {
          identifier: auraIdentifier,
          sourceActorUuid: item.actor?.uuid ?? "",
          sourceItemUuid: item.uuid ?? ""
        }
      }
    }
  };
}

function auraOriginIdentifier(effect) {
  return identifier(auraOriginDocument(effect)) || slug(effect?.name);
}

function auraOriginDocument(effect) {
  let origin;
  if (effect?.origin && typeof globalThis.fromUuidSync === "function") {
    try {
      origin = globalThis.fromUuidSync(effect.origin, {strict: false});
    } catch (_error) {
      origin = undefined;
    }
  }
  return origin;
}

export function paladinAuraIconVisibility(effect) {
  return PALADIN_AURA_ICON_VISIBILITY.get(auraOriginIdentifier(effect));
}

export function preparePaladinAuraEffectIcon(effect) {
  const showIcon = paladinAuraIconVisibility(effect);
  if (showIcon === undefined || typeof effect?.updateSource !== "function") return false;
  const updates = {showIcon};
  if (Object.hasOwn(effect.flags?.dae ?? {}, "showIcon")) {
    updates["flags.dae.-=showIcon"] = null;
  }
  effect.updateSource(updates);
  return true;
}

function paladinAuraActors() {
  const actors = new Map();
  const add = actor => {
    if (!actor || typeof actor.updateEmbeddedDocuments !== "function") return;
    actors.set(actor.uuid ?? actor.id, actor);
  };

  for (const actor of game.actors ?? []) add(actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene?.tokens ?? []) add(token?.actor);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) add(token?.actor);
  return actors.values();
}

function auraChangeSignature(changes) {
  return values(changes)
    .map(change => [
      String(change?.key ?? ""),
      String(change?.value ?? ""),
      Number(change?.priority ?? 0),
      String(change?.type ?? change?.mode ?? "")
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function sameAuraChanges(current, expected) {
  return JSON.stringify(auraChangeSignature(current)) === JSON.stringify(auraChangeSignature(expected));
}

function auraExecutor() {
  const activeGM = game.users?.activeGM;
  return activeGM ? activeGM.id === game.user?.id : Boolean(game.user?.isGM);
}

function managedAuraFlag(effect) {
  const flag = effect?.flags?.[MODULE_ID]?.paladinAura;
  return flag && typeof flag === "object" ? flag : null;
}

function managedAuraIdentifier(effect) {
  const flagged = slug(managedAuraFlag(effect)?.identifier);
  if (MANAGED_PALADIN_AURAS.has(flagged)) return flagged;

  const origin = auraOriginDocument(effect);
  const legacyAura = Boolean(
    effect?.flags?.cat?.auraEffect
    || effect?.flags?.["chris-premades"]?.aura
  );
  const legacyManaged = Boolean(effect?.flags?.[MODULE_ID]?.paladinAura) || Boolean(
    legacyAura && (!origin || auraItemIsManaged(origin))
  );
  if (!legacyManaged) return null;

  const originIdentifier = identifier(origin) || slug(effect?.name);
  if (MANAGED_PALADIN_AURAS.has(originIdentifier)) return originIdentifier;
  const nameIdentifier = slug(effect?.name);
  return MANAGED_PALADIN_AURAS.has(nameIdentifier) ? nameIdentifier : null;
}

function managedAuraEffects(actor, auraIdentifier = null) {
  return values(actor?.effects).filter(effect => {
    const current = managedAuraIdentifier(effect);
    return current && (!auraIdentifier || current === auraIdentifier);
  });
}

function auraItemIsManaged(item) {
  return MANAGED_PALADIN_AURAS.has(identifier(item))
    && item?.flags?.cat?.automation?.source === MODULE_ID;
}

function auraRange(item) {
  const configured = Number(item?.flags?.cat?.config?.[PALADIN_AURA_DISTANCE_FLAG]);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : paladinAuraDistance(item?.actor);
}

export function paladinAuraVisuals(token) {
  const visuals = [];
  if (!isAuraCreature(token)) return visuals;
  const item = values(token?.actor?.items)
    .filter(candidate => identifier(candidate) === PALADIN_IDS.auraProtection && auraItemIsManaged(candidate))
    .sort((left, right) => String(left.uuid ?? left.id).localeCompare(String(right.uuid ?? right.id)))[0];
  if (item) {
    visuals.push({
      id: "khuzoe-paladin-aura-of-protection-visual",
      name: item.name || "Aura of Protection",
      enabled: true,
      area: {distance: auraRange(item) * sceneUnitsPerFoot(token.parent), elevation: true},
      source: {requiresConscious: true},
      visual: {visible: true, ...PALADIN_AURA_VISUAL}
    });
  }

  const nimbus = holyNimbusEffects(token?.actor)[0];
  if (nimbus) {
    visuals.push({
      id: "khuzoe-paladin-holy-nimbus-visual",
      name: nimbus.name || "Holy Nimbus",
      enabled: true,
      area: {distance: HOLY_NIMBUS_RADIUS_FEET * sceneUnitsPerFoot(token.parent), elevation: true, walls: false},
      source: {requiresConscious: false},
      visual: {visible: true, ...HOLY_NIMBUS_VISUAL}
    });
  }
  return visuals;
}

function auraTokensAreAllies(source, target) {
  if (source?.id && source.id === target?.id) return true;
  const isEnemy = globalThis.cat?.utils?.tokenUtils?.isEnemy;
  if (typeof isEnemy === "function") return !isEnemy(source, target);
  return Number(source?.disposition ?? 0) === Number(target?.disposition ?? 0);
}

export function paladinAuraTokenDistance(source, target) {
  return circularAuraTokenDistance(source, target);
}

function actorKey(actor) {
  return actor?.uuid ?? actor?.id;
}

function candidateIsBetter(candidate, current) {
  if (!current) return true;
  if (candidate.identifier === PALADIN_IDS.auraProtection && candidate.bonus !== current.bonus) {
    return candidate.bonus > current.bonus;
  }
  return String(candidate.item.uuid ?? candidate.item.id)
    .localeCompare(String(current.item.uuid ?? current.item.id)) < 0;
}

function expectedPaladinAuras(scene) {
  const expected = new Map();
  const tokens = values(scene?.tokens).filter(isAuraCreature);

  for (const sourceToken of tokens) {
    const sourceActor = sourceToken.actor;
    if (!auraSourceOperational(sourceActor)) continue;

    for (const item of values(sourceActor.items).filter(auraItemIsManaged)) {
      const auraIdentifier = identifier(item);
      const range = auraRange(item);
      const bonus = auraIdentifier === PALADIN_IDS.auraProtection
        ? Math.max(1, Number(sourceActor.system?.abilities?.cha?.mod ?? 0))
        : 0;

      for (const targetToken of tokens) {
        if (!auraTokensAreAllies(sourceToken, targetToken)) continue;
        const distance = paladinAuraTokenDistance(sourceToken, targetToken);
        if (distance < 0 || distance > range + 1e-6) continue;

        const key = actorKey(targetToken.actor);
        if (!key) continue;
        if (!expected.has(key)) expected.set(key, new Map());
        const candidate = {
          identifier: auraIdentifier,
          item,
          sourceActor,
          targetActor: targetToken.actor,
          sceneId: scene.id,
          bonus
        };
        const current = expected.get(key).get(auraIdentifier);
        if (candidateIsBetter(candidate, current)) {
          expected.get(key).set(auraIdentifier, candidate);
        }
      }
    }
  }

  return expected;
}

function expectedAuraEffect(candidate) {
  const {identifier: auraIdentifier, item, sourceActor, bonus} = candidate;
  if (auraIdentifier === PALADIN_IDS.auraProtection) {
    return auraEffectData(
      item,
      [{key: "system.bonuses.abilities.save", value: String(bonus), priority: 20, type: "add"}],
      `<p>Bonus di <strong>+${bonus}</strong> ai tiri salvezza grazie all'Aura of Protection di ${escapeHtml(sourceActor.name)}.</p>`,
      {showIcon: globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2}
    );
  }
  return auraEffectData(
    item,
    [{key: "system.traits.ci.value", value: "frightened", priority: 20, type: "add"}],
    `<p>Immunità alla condizione frightened grazie all'Aura of Courage di ${escapeHtml(sourceActor.name)}.</p>`
  );
}

function effectPreference(effect) {
  if (managedAuraFlag(effect)) return 3;
  if (effect?.flags?.[MODULE_ID]?.paladinAura) return 2;
  if (effect?.flags?.cat?.auraEffect) return 1;
  return 0;
}

function selectCanonicalEffect(effects) {
  return [...effects].sort((left, right) => (
    effectPreference(right) - effectPreference(left)
    || String(left.id ?? left._id).localeCompare(String(right.id ?? right._id))
  ))[0];
}

function auraEffectUpdates(existing, expected) {
  const updates = {};
  for (const field of ["name", "img", "origin", "description"]) {
    if (existing?.[field] !== expected[field]) updates[field] = expected[field];
  }
  if (existing.disabled !== false) updates.disabled = false;
  if (Number(existing.showIcon) !== Number(expected.showIcon)) updates.showIcon = expected.showIcon;
  if (!sameAuraChanges(existing.system?.changes, expected.system?.changes)) {
    updates["system.changes"] = expected.system.changes;
  }
  if (Object.hasOwn(existing.flags?.dae ?? {}, "showIcon")) {
    updates["flags.dae.-=showIcon"] = null;
  }
  if (existing.flags?.cat?.auraEffect) updates["flags.cat.-=auraEffect"] = null;
  if (existing.flags?.cat?.identifier !== expected.flags.cat.identifier) {
    updates["flags.cat.identifier"] = expected.flags.cat.identifier;
  }
  if (existing.flags?.cat?.noAnimation !== true) updates["flags.cat.noAnimation"] = true;
  if (existing.flags?.dae?.stackable !== "noneNameOnly") {
    updates["flags.dae.stackable"] = "noneNameOnly";
  }
  if (existing.flags?.dae?.expiryMode !== "delete") updates["flags.dae.expiryMode"] = "delete";
  if (JSON.stringify(managedAuraFlag(existing)) !== JSON.stringify(expected.flags[MODULE_ID].paladinAura)) {
    updates[`flags.${MODULE_ID}.paladinAura`] = expected.flags[MODULE_ID].paladinAura;
  }
  if (existing.flags?.["chris-premades"]?.aura) {
    // Le copie esportate dalle vecchie aure CPR non devono più essere gestite
    // contemporaneamente anche da Chris's Premades.
    updates["flags.-=chris-premades"] = null;
  }
  return updates;
}

function actorHasEffect(actor, id) {
  if (!id) return false;
  if (typeof actor?.effects?.get === "function") return Boolean(actor.effects.get(id));
  return values(actor?.effects).some(effect => (effect.id ?? effect._id) === id);
}

async function deleteAuraEffects(actor, effects) {
  const ids = effects
    .map(effect => effect?.id ?? effect?._id)
    .filter(id => actorHasEffect(actor, id));
  if (!ids.length) return;

  try {
    await globalThis.cat.utils.documentUtils.deleteEmbeddedDocuments(
      actor,
      "ActiveEffect",
      ids,
      {options: paladinAuraDocumentOptions()}
    );
  } catch (error) {
    // Un altro gestore può completare la pulizia delle vecchie copie CAT/CPR
    // durante la prima migrazione. Se non rimane più nulla, il risultato è già
    // quello desiderato e non va trasformato in un errore permanente.
    if (ids.some(id => actorHasEffect(actor, id))) throw error;
  }
}

async function createAuraEffect(actor, effectData) {
  return globalThis.cat.utils.documentUtils.createEmbeddedDocuments(
    actor,
    "ActiveEffect",
    [effectData],
    paladinAuraDocumentOptions()
  );
}

async function reconcileAuraOnActor(actor, auraIdentifier, candidate) {
  const existing = managedAuraEffects(actor, auraIdentifier);
  if (!candidate) {
    await deleteAuraEffects(actor, existing);
    return;
  }

  const expected = expectedAuraEffect(candidate);
  expected.flags[MODULE_ID].paladinAura.sceneId = candidate.sceneId;
  const canonical = selectCanonicalEffect(existing);
  if (!canonical) {
    await createAuraEffect(actor, expected);
    return;
  }

  await deleteAuraEffects(actor, existing.filter(effect => effect !== canonical));
  const canonicalId = canonical.id ?? canonical._id;
  if (!actorHasEffect(actor, canonicalId)) {
    await createAuraEffect(actor, expected);
    return;
  }

  const updates = auraEffectUpdates(canonical, expected);
  if (!Object.keys(updates).length) return;
  try {
    await updateDocumentSafely(
      canonical,
      updates,
      paladinAuraDocumentOptions()
    );
  } catch (error) {
    if (actorHasEffect(actor, canonicalId)) throw error;
    await createAuraEffect(actor, expected);
  }
}

async function performPaladinAuraReconciliation(scene, extraActors = []) {
  if (!scene || !auraExecutor()) return;
  const expected = expectedPaladinAuras(scene);
  const actors = new Map();
  const addActor = actor => {
    const key = actorKey(actor);
    if (key && typeof actor?.createEmbeddedDocuments === "function") actors.set(key, actor);
  };

  // Include object proxies here so previously misapplied managed buffs are
  // removed; only the expected-source/target pass excludes them.
  for (const token of values(scene.tokens)) addActor(token?.actor);
  const sceneActors = new Set(values(scene.tokens).map(token => actorKey(token.actor)));
  for (const actor of extraActors) {
    if (sceneActors.has(actorKey(actor)) || values(actor?.effects).some(effect => managedAuraFlag(effect)?.sceneId === scene.id)) addActor(actor);
  }


  for (const [key, actor] of actors) {
    const actorExpected = expected.get(key) ?? new Map();
    for (const auraIdentifier of MANAGED_PALADIN_AURAS) {
      await reconcileAuraOnActor(actor, auraIdentifier, actorExpected.get(auraIdentifier));
    }
  }
}

export function reconcilePaladinAuras(scene = globalThis.canvas?.scene, {extraActors = []} = {}) {
  const task = () => performPaladinAuraReconciliation(scene, extraActors);
  const result = paladinAuraQueue.then(task, task);
  paladinAuraQueue = result.catch(error => {
    console.error("Khuzoe Automations | Ricalcolo delle aure del Paladino non riuscito.", error);
  });
  return result;
}

export function schedulePaladinAuraReconciliation(scene = globalThis.canvas?.scene, actor = null) {
  if (!auraExecutor()) return;
  if (scene) pendingAuraScene = scene;
  if (actor) pendingAuraActors.add(actor);
  globalThis.clearTimeout?.(paladinAuraTimer);
  paladinAuraTimer = globalThis.setTimeout?.(() => {
    const scheduledScene = pendingAuraScene ?? globalThis.canvas?.scene;
    const extraActors = [...pendingAuraActors];
    pendingAuraScene = undefined;
    pendingAuraActors.clear();
    void reconcilePaladinAuras(scheduledScene, {extraActors});
  }, PALADIN_AURA_RECONCILE_DELAY);
}

export function schedulePaladinAuraAfterTokenMovement(token) {
  if (!token || !auraExecutor()) return;
  const generation = (pendingAuraMovementGenerations.get(token) ?? 0) + 1;
  pendingAuraMovementGenerations.set(token, generation);

  // L'hook updateToken può precedere di pochi istanti la registrazione della
  // promessa di animazione. Il passaggio al task successivo ci permette di
  // aspettare la catena corretta di Foundry v14.
  globalThis.setTimeout(async () => {
    const movement = token?.object?.movementAnimationPromise
      ?? token?._movement?.animation?.ended;
    if (movement && typeof movement.then === "function") {
      try {
        await movement;
      } catch (_error) {
        // Un'animazione interrotta da un nuovo trascinamento non è un errore:
        // il documento contiene comunque l'ultima posizione autoritativa.
      }
    }
    if (pendingAuraMovementGenerations.get(token) !== generation) return;
    pendingAuraMovementGenerations.delete(token);
    schedulePaladinAuraReconciliation(token.parent ?? globalThis.canvas?.scene, token.actor);
  }, 0);
}

async function reconcilePaladinActor(actor) {
  if (!actor || !game.user?.isGM) return;
  const level = getPaladinLevel(actor);
  const auraDistance = level >= 18 ? 30 : 10;
  const updates = [];

  for (const item of values(actor.items)) {
    if (item.flags?.cat?.automation?.source !== MODULE_ID) continue;
    const itemIdentifier = identifier(item);
    if (itemIdentifier === PALADIN_IDS.layOnHands) {
      const maximum = level > 0 ? level * 5 : Number(item.system?.uses?.max ?? 0);
      const spent = Math.min(Math.max(0, Number(item.system?.uses?.spent ?? 0)), Math.max(0, maximum));
      if (String(item.system?.uses?.max ?? "") !== String(maximum) || Number(item.system?.uses?.spent ?? 0) !== spent) {
        updates.push({_id: item.id, "system.uses.max": String(maximum), "system.uses.spent": spent});
      }
    }
    if ([PALADIN_IDS.auraProtection, PALADIN_IDS.auraCourage].includes(itemIdentifier)) {
      const current = Number(item.flags?.cat?.config?.[PALADIN_AURA_DISTANCE_FLAG]);
      if (current !== auraDistance) {
        updates.push({_id: item.id, [`flags.cat.config.${PALADIN_AURA_DISTANCE_FLAG}`]: auraDistance});
      }
    }
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates, {khuzoePaladinReconcile: true});
  }
}

export function isPaladinReconciliationItem(item, updatedIdentifier = identifier(item)) {
  return PALADIN_IDENTIFIERS.has(slug(updatedIdentifier)) || isPaladinClass(item);
}

export function schedulePaladinReconciliation(actor) {
  if (!actor || !game.user?.isGM) return;
  globalThis.setTimeout(() => {
    void reconcilePaladinActor(actor).then(() => {
      schedulePaladinAuraReconciliation(globalThis.canvas?.scene, actor);
    });
  }, 0);
}

export async function reconcileAllPaladins() {
  if (!game.user?.isGM) return;
  for (const actor of game.actors ?? []) await reconcilePaladinActor(actor);
}

export function preparePaladinItemUpdate(item, changes) {
  const updatedIdentifier = slug(changes?.system?.identifier ?? item?.system?.identifier);
  if (!PALADIN_IDENTIFIERS.has(updatedIdentifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;

  if (updatedIdentifier === PALADIN_IDS.layOnHands && changes.system?.uses) {
    const maximum = getPaladinLevel(item.actor) * 5 || Number(item.system?.uses?.max ?? changes.system.uses.max ?? 0);
    changes.system.uses.max = String(Math.max(0, maximum));
    changes.system.uses.spent = Math.min(
      Number(item.system?.uses?.spent ?? 0),
      Math.max(0, maximum)
    );
  }

  if (updatedIdentifier === PALADIN_IDS.holyNimbus && changes.system?.uses) {
    changes.system.uses.spent = Math.min(
      Number(item.system?.uses?.spent ?? 0),
      Math.max(0, Number(changes.system.uses.max ?? item.system?.uses?.max ?? 1))
    );
  }

  if ([PALADIN_IDS.auraProtection, PALADIN_IDS.auraCourage].includes(updatedIdentifier)) {
    foundry.utils.setProperty(
      changes,
      `flags.cat.config.${PALADIN_AURA_DISTANCE_FLAG}`,
      paladinAuraDistance(item.actor)
    );
  }
}

export function registerPaladin(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: PALADIN_IDS.layOnHands,
      roll: [
        {pass: "itemPreItemRoll", macro: prepareLayOnHands, priority: 10},
        {pass: "itemRollFinished", macro: finishLayOnHands, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: PALADIN_IDS.divineSmite,
      roll: [{pass: "actorDamageRollBonuses", macro: useDivineSmite, priority: 60}]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: PALADIN_IDS.holyNimbus,
      roll: [{pass: "itemRollFinished", macro: activateHolyNimbus, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: PALADIN_EFFECT_IDS.holyNimbus,
      save: [{pass: "actorContext", macro: holyNimbusSaveAdvantage, priority: 50}]
    })
  ];
  return {macros, automations: PALADIN_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
