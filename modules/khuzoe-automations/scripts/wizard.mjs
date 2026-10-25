import {RELEASE_VERSION} from "./release.mjs";
import {adjustAppliedDamage, appliedDamageAmount} from "./damage-adjustment.mjs";
import {runSyntheticActivity} from "./activity-compat.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {withDocumentLock} from "./operation-locks.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";

export const WIZARD_IDS = Object.freeze({
  arcaneRecovery: "arcane-recovery",
  bladesong: "bladesong",
  songDefense: "song-of-defense",
  songVictory: "song-of-victory"
});

export const WIZARD_ACTIVITY_IDS = Object.freeze({
  arcaneRecovery: "KhzArcRecover001",
  bladesongStart: "KhzBladeStart001",
  bladesongEnd: "KhzBladeEnd00001",
  songDefense: "KhzSongDefense01"
});

export const BLADESONG_EFFECT_ID = "bladesong-active";

const WIZARD_DOCUMENTS = Object.freeze([
  [WIZARD_IDS.arcaneRecovery, "KhzWizArcRecv001", "Permette di recuperare slot da mago dopo un riposo breve rispettando il budget pari a metà livello, arrotondato per eccesso, e il limite del 5° livello."],
  [WIZARD_IDS.bladesong, "KhzWizBladeSong1", "Attiva Bladesong con bonus alla CA, movimento, Acrobatics e concentrazione; conserva gli utilizzi configurati sulla capacità."],
  [WIZARD_IDS.songDefense, "KhzWizSongDef001", "Durante Bladesong propone la reazione, consuma lo slot scelto e riduce il danno di cinque punti per livello dello slot."],
  [WIZARD_IDS.songVictory, "KhzWizSongVic001", "Durante Bladesong aggiunge il modificatore di Intelligenza ai danni degli attacchi con arma da mischia."]
]);

export const WIZARD_IDENTIFIERS = new Set(WIZARD_DOCUMENTS.map(([identifier]) => identifier));

export const WIZARD_AUTOMATIONS = WIZARD_DOCUMENTS.map(([identifier, id, notes]) => Object.freeze({
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

function identifier(document) {
  return slug(document?.system?.identifier || document?.flags?.cat?.identifier || document?.name);
}

function ownerUserId(document) {
  return globalThis.cat.utils.queryUtils.firstOwner(document, true) ?? game.user.id;
}

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function effectByIdentifier(actor, effectIdentifier) {
  return values(actor?.effects).find(effect =>
    effect?.active !== false
    && !effect?.disabled
    && identifier(effect) === effectIdentifier
  );
}

function itemUsesRemaining(item) {
  const prepared = Number(item?.system?.uses?.value);
  if (Number.isFinite(prepared)) return Math.max(0, prepared);

  const maximum = item?.system?.uses?.max === "@prof"
    ? Number(item?.actor?.system?.attributes?.prof ?? 0)
    : Number(item?.system?.uses?.max ?? 0);
  const spent = Number(item?.system?.uses?.spent ?? 0);
  return Number.isFinite(maximum) ? Math.max(0, maximum - spent) : 0;
}

async function consumeItemUse(item) {
  const spent = Number(item?.system?.uses?.spent ?? 0);
  await updateDocumentSafely(item, {"system.uses.spent": spent + 1});
}

function isWizardClass(item) {
  if (item?.type !== "class") return false;
  return ["wizard", "mago"].includes(identifier(item));
}

export function getWizardLevel(actor) {
  const direct = Number(actor?.classes?.wizard?.system?.levels);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  const classItem = values(actor?.items).find(isWizardClass);
  const level = Number(classItem?.system?.levels ?? 0);
  return Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

export function arcaneRecoveryBudget(actor) {
  return Math.ceil(getWizardLevel(actor) / 2);
}

function recoverableWizardSlots(actor) {
  return Object.entries(actor?.system?.spells ?? {}).flatMap(([key, slot]) => {
    if (key === "pact") return [];
    const level = Number(slot?.level ?? key.match(/\d+/)?.[0] ?? 0);
    const value = Number(slot?.value ?? 0);
    const maximum = Number(slot?.max ?? 0);
    const missing = Math.max(0, maximum - value);
    if (level < 1 || level > 5 || missing <= 0) return [];
    return [{
      id: key,
      name: `Slot di ${level}° livello`,
      img: `systems/dnd5e/icons/spell-tiers/spell${level}.webp`,
      level,
      missing,
      value,
      maximum
    }];
  }).sort((left, right) => left.level - right.level);
}

async function prepareArcaneRecovery({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || workflow?.activity?.id !== WIZARD_ACTIVITY_IDS.arcaneRecovery) return;
  if (itemUsesRemaining(feature) <= 0) {
    ui.notifications.warn(`${feature.name}: Arcane Recovery è già stata utilizzata.`);
    return true;
  }

  if (!feature.actor.flags?.[MODULE_ID]?.arcaneRecoveryRest) {
    ui.notifications.warn("Arcane Recovery richiede un riposo breve appena completato.");
    return true;
  }
  const budget = arcaneRecoveryBudget(feature.actor);
  const slots = recoverableWizardSlots(feature.actor).filter(slot => slot.level <= budget);
  if (!slots.length) {
    ui.notifications.info(`${feature.name}: non ci sono slot recuperabili dal 1° al 5° livello.`);
    return true;
  }

  const fields = slots.map(slot => ({
    label: `Slot di ${slot.level}° livello (${slot.value}/${slot.maximum} disponibili)`,
    name: slot.id,
    options: {
      image: slot.img,
      minAmount: 0,
      maxAmount: slot.missing,
      weight: slot.level
    }
  }));
  const selection = await globalThis.cat.utils.dialogUtils.selectAmounts(
    feature.name,
    `<p>Scegli gli slot da recuperare. La somma dei loro livelli non può superare <strong>${budget}</strong>.</p>`,
    fields,
    {totalMax: budget, userId: ownerUserId(feature.actor)}
  );
  if (!selection) return true;

  const recovered = slots
    .map(slot => ({slot, amount: Math.max(0, Math.floor(Number(selection[slot.id]) || 0))}))
    .filter(({amount}) => amount > 0);
  const total = recovered.reduce((sum, {slot, amount}) => sum + slot.level * amount, 0);
  if (!recovered.length || total <= 0 || total > budget || recovered.some(({slot, amount}) => amount > slot.missing)) {
    ui.notifications.warn(`${feature.name}: selezione degli slot non valida.`);
    return true;
  }
  workflow.khuzoeArcaneRecovery = recovered;
}

async function finishArcaneRecovery({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  const recovered = workflow?.khuzoeArcaneRecovery;
  if (!feature || !recovered?.length || itemUsesRemaining(feature) <= 0) return;

  const current = new Map(recoverableWizardSlots(feature.actor).map(slot => [slot.id, slot]));
  const budget = arcaneRecoveryBudget(feature.actor);
  const total = recovered.reduce((sum, {slot, amount}) => sum + slot.level * amount, 0);
  if (total > budget || recovered.some(({slot, amount}) => !current.has(slot.id) || amount > current.get(slot.id).missing)) {
    ui.notifications.warn(`${feature.name}: gli slot disponibili sono cambiati; riprova.`);
    return;
  }

  const updates = Object.fromEntries(recovered.map(({slot, amount}) => [
    `system.spells.${slot.id}.value`,
    current.get(slot.id).value + amount
  ]));
  const receipt = await reserveResources(feature.actor, {item: feature});
  if (!receipt) return;
  try { await updateDocumentSafely(feature.actor, {...updates, [`flags.${MODULE_ID}.arcaneRecoveryRest`]: false}); }
  catch (error) { await refundResources(receipt); throw error; }
  const summary = recovered.map(({slot, amount}) => `${amount}× livello ${slot.level}`).join(", ");
  ui.notifications.info(`${feature.name}: recuperati ${summary}.`);
}

function bladesongEffectData(item) {
  const intelligence = Math.max(1, Number(item.actor?.system?.abilities?.int?.mod ?? 0));
  return {
    name: item.name,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {
      changes: [
        {key: "system.attributes.ac.bonus", type: "add", value: String(intelligence), priority: 20},
        {key: "system.attributes.movement.walk", type: "add", value: "10", priority: 20},
        {key: "flags.midi-qol.advantage.skill.acr", type: "override", value: "1", priority: 20},
        {key: "system.attributes.concentration.bonuses.save", type: "add", value: String(intelligence), priority: 20}
      ]
    },
    duration: {value: 60, units: "seconds", expiry: "turnStart", expired: false},
    statuses: [],
    description: `<p>Bladesong: +${intelligence} CA e concentrazione, +10 ft movimento e vantaggio ad Acrobatics.</p>`,
    showIcon: 1,
    flags: {
      cat: {
        identifier: BLADESONG_EFFECT_ID,
        macros: {roll: [{source: MODULE_ID, rules: RULES, identifier: BLADESONG_EFFECT_ID}]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: ["zeroHP"], expiryMode: "delete"},
      [MODULE_ID]: {bladesong: true}
    }
  };
}

async function prepareBladesong({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature) return;
  const activityId = workflow?.activity?.id;
  if (![WIZARD_ACTIVITY_IDS.bladesongStart, WIZARD_ACTIVITY_IDS.bladesongEnd].includes(activityId)) return;

  const active = effectByIdentifier(feature.actor, BLADESONG_EFFECT_ID);
  if (activityId === WIZARD_ACTIVITY_IDS.bladesongEnd) {
    if (!active) {
      ui.notifications.info(`${feature.name} non è attiva.`);
      return true;
    }
    workflow.khuzoeBladesong = {mode: "end", effect: active};
    return;
  }
  if (active) {
    ui.notifications.info(`${feature.name} è già attiva.`);
    return true;
  }
  if (isBladesongIncapacitated(feature.actor)) {
    ui.notifications.warn(`${feature.name} non può essere attivata mentre il personaggio è incapacitato.`);
    return true;
  }
  if (hasInvalidBladesongEquipment(feature.actor)) {
    ui.notifications.warn(`${feature.name} non può essere attivata con armatura media o pesante oppure con uno scudo equipaggiato.`);
    return true;
  }
  if (itemUsesRemaining(feature) <= 0) {
    ui.notifications.warn(`${feature.name}: nessun utilizzo disponibile.`);
    return true;
  }
  workflow.khuzoeBladesong = {mode: "start"};
}

async function finishBladesong({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  const pending = workflow?.khuzoeBladesong;
  if (!feature || !pending || workflow.aborted) return;
  return withDocumentLock(feature, "bladesong", async () => {
  if (pending.mode === "end") {
    const active = effectByIdentifier(feature.actor, BLADESONG_EFFECT_ID);
    if (active) await globalThis.cat.utils.documentUtils.deleteDocument(active);
    return;
  }
  if (itemUsesRemaining(feature) <= 0 || effectByIdentifier(feature.actor, BLADESONG_EFFECT_ID)) return;
  if (isBladesongIncapacitated(feature.actor) || hasInvalidBladesongEquipment(feature.actor)) return;
  const receipt = await reserveResources(feature.actor, {item: feature});
  if (!receipt) return;
  try {
    const created = await globalThis.cat.utils.effectUtils.createEffects(feature.actor, [bladesongEffectData(feature)], {rules: RULES});
    if (!created?.length) await refundResources(receipt);
  } catch (error) { await refundResources(receipt); throw error; }
  });
}

function isBladesongIncapacitated(actor) {
  if (Number(actor?.system?.attributes?.hp?.value ?? 0) <= 0) return true;
  return values(actor?.statuses).some(status => INCAPACITATING_STATUSES.has(String(status)));
}

function equipmentCategory(item) {
  return slug(item?.system?.type?.value ?? item?.system?.armor?.type ?? item?.system?.type ?? "");
}

function hasInvalidBladesongEquipment(actor) {
  return values(actor?.items).some(item => item?.type === "equipment" && item.system?.equipped
    && ["medium", "heavy", "shield"].includes(equipmentCategory(item)));
}

export async function endBladesongIfIncapacitated(actor) {
  if (!actor || (!isBladesongIncapacitated(actor) && !hasInvalidBladesongEquipment(actor))) return false;
  const active = effectByIdentifier(actor, BLADESONG_EFFECT_ID);
  if (!active) return false;
  await globalThis.cat.utils.documentUtils.deleteDocument(active);
  return true;
}

function twoHandedWeaponAttack(workflow) {
  if (workflow?.item?.type !== "weapon" || workflow?.activity?.type !== "attack") return false;
  const properties = workflow?.item?.system?.properties;
  const inherentlyTwoHanded = typeof properties?.has === "function"
    ? properties.has("two")
    : Array.isArray(properties) ? properties.includes("two") : Boolean(properties?.two);
  return inherentlyTwoHanded || workflow?.attackMode === "twoHanded" || workflow?.rollOptions?.attackMode === "twoHanded";
}

async function endBladesongAfterTwoHandedAttack({workflow, document} = {}) {
  if (!document?.parent || !twoHandedWeaponAttack(workflow)) return;
  await globalThis.cat.utils.documentUtils.deleteDocument(document);
  ui.notifications.info("Bladesong termina dopo l'attacco effettuato usando due mani.");
}

export function scheduleBladesongStatusCheck(actor) {
  if (!actor) return;
  globalThis.setTimeout(() => void endBladesongIfIncapacitated(actor), 0);
}

function spellSlotLevel(actor, selection) {
  if (selection === "pact") return Number(actor?.system?.spells?.pact?.level ?? 0);
  return Number(selection);
}

function incomingDamage(ditem) {
  return appliedDamageAmount(ditem);
}

async function useSongOfDefense({workflow, targetToken, sourceToken, ditem, document}) {
  if (workflow?.workflowOptions?.khuzoeUnreducible) return;
  const actor = document?.actor ?? targetToken?.actor ?? sourceToken?.actor;
  if (!actor || !ditem || !effectByIdentifier(actor, BLADESONG_EFFECT_ID)) return;
  const damage = incomingDamage(ditem);
  if (damage <= 0) return;
  if (globalThis.cat.utils.actorUtils.hasUsedReaction(actor)) return;
  if (!globalThis.cat.utils.actorUtils.hasSpellSlots(actor, 1)) return;

  const selection = await globalThis.cat.utils.dialogUtils.selectSpellSlot(
    actor,
    document?.name ?? "Song of Defense",
    `<p>Spendere uno slot per ridurre i <strong>${damage}</strong> danni in arrivo?</p>`,
    {minLevel: 1, no: true, userId: ownerUserId(actor)}
  );
  if (!selection) return;
  const level = spellSlotLevel(actor, selection);
  if (!Number.isFinite(level) || level < 1) return;

  const reduction = Math.min(damage, level * 5);
  const receipt = await reserveResources(actor, {slot: selection, reaction: true});
  if (!receipt) return;

  try {
  const activity = itemActivity(document, WIZARD_ACTIVITY_IDS.songDefense);
  if (activity) {
    const result = await runSyntheticActivity(activity, [], {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(actor)
    });
    if (!result || result.aborted) { await refundResources(receipt); return false; }
  }
  adjustAppliedDamage(ditem, -reduction);
  } catch (error) { await refundResources(receipt); throw error; }
}

function meleeWeaponAttack(workflow) {
  return (workflow?.activity?.getActionType?.(workflow.attackMode) ?? workflow?.activity?.actionType ?? workflow?.item?.system?.actionType) === "mwak";
}

async function applySongOfVictory({workflow, actor, document}) {
  actor ??= workflow?.actor ?? document?.actor;
  if (!actor || !workflow || !meleeWeaponAttack(workflow)) return;
  if (!effectByIdentifier(actor, BLADESONG_EFFECT_ID)) return;
  const intelligence = Math.max(1, Number(actor.system?.abilities?.int?.mod ?? 0));
  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, String(intelligence), {
    damageType: workflow.defaultDamageType
  });
}

export function prepareWizardItemUpdate(item, changes) {
  const updatedIdentifier = slug(changes?.system?.identifier ?? item?.system?.identifier);
  if (!WIZARD_IDENTIFIERS.has(updatedIdentifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;

  if (![WIZARD_IDS.arcaneRecovery, WIZARD_IDS.bladesong].includes(updatedIdentifier) || !changes.system?.uses) return;
  const current = item?.toObject?.().system?.uses ?? item?.system?.uses;
  if (!current) return;
  const currentMaximum = String(current.max ?? "");
  if (currentMaximum) changes.system.uses.max = current.max;
  if (Array.isArray(current.recovery) && current.recovery.length) {
    changes.system.uses.recovery = structuredClone(current.recovery);
  }
  changes.system.uses.spent = Math.max(0, Number(current.spent ?? 0));
}

export function registerWizard(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WIZARD_IDS.arcaneRecovery,
      roll: [
        {pass: "itemPreItemRoll", macro: prepareArcaneRecovery, priority: 10},
        {pass: "itemRollFinished", macro: finishArcaneRecovery, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WIZARD_IDS.bladesong,
      roll: [
        {pass: "itemPreItemRoll", macro: prepareBladesong, priority: 10},
        {pass: "itemRollFinished", macro: finishBladesong, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WIZARD_IDS.songDefense,
      roll: [{pass: "targetDamageFlatReductions", macro: useSongOfDefense, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WIZARD_IDS.songVictory,
      roll: [{pass: "actorDamageRollBonuses", macro: applySongOfVictory, priority: 60}]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: BLADESONG_EFFECT_ID,
      roll: [{pass: "actorAttackRollComplete", macro: endBladesongAfterTwoHandedAttack, priority: 80}]
    })
  ];
  return {macros, automations: WIZARD_AUTOMATIONS.map(data => api.registerAutomation(data))};
}

Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
  if (!actor.isOwner || !values(actor.items).some(item => item.system?.identifier === WIZARD_IDS.arcaneRecovery)) return;
  void updateDocumentSafely(actor, {[`flags.${MODULE_ID}.arcaneRecoveryRest`]: (config?.type ?? result?.type) === "short"});
});
Hooks.on("midi-qol.RollComplete", workflow => {
  if (workflow?.actor?.flags?.[MODULE_ID]?.arcaneRecoveryRest && !workflow.aborted && workflow.item?.system?.identifier !== WIZARD_IDS.arcaneRecovery) {
    void updateDocumentSafely(workflow.actor, {[`flags.${MODULE_ID}.arcaneRecoveryRest`]: false});
  }
});
