import {changeGinevraCharges, ginevraEffect as embrace} from "./ginevra-charges.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {rollTargetSavingThrow} from "./target-saves.mjs";

const MODULE = "khuzoe-automations";
const IDENTIFIER = "abbraccio-di-ginevra";
const ACTIVATE = "KhzGinActivate01";
const LIFE = "KhzGinLife000001";
const DEATH = "KhzGinDeath00001";
const VERSION = "0.28.8";

export const GINEVRA_AUTOMATION = Object.freeze({
  source: MODULE, type: "feat", identifier: IDENTIFIER, rules: "2024", version: VERSION,
  uuid: "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzGinevraEmbr01",
  notes: "Scurovisione e resistenza radiante permanenti. Manifestazione di 1 minuto con resistenza a tutti i danni, 2d4 radianti sugli attacchi in mischia, cariche dai danni effettivi e azioni Vita/Morte. Non modifica classi o slot."
});

const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? (Array.isArray(collection) ? collection : Object.values(collection ?? {})));
const tokenDocument = token => token?.document ?? token;
const slug = name => String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function getGinevraAutomation(item) {
  if (item?.type !== "feat" || item.system?.source?.rules !== "2024") return null;
  const identifier = item.system?.identifier;
  if (identifier === IDENTIFIER) return GINEVRA_AUTOMATION;
  return slug(item.name) === IDENTIFIER && ["", "new-item", null, undefined].includes(identifier)
    ? GINEVRA_AUTOMATION : null;
}

export function prepareGinevraItemUpdate(item, changes) {
  if (changes.flags?.cat?.automation?.source !== MODULE || !getGinevraAutomation(item)) return;
  changes.system ??= {};
  changes.system.uses = {
    max: "max(0, @abilities.wis.mod)",
    spent: Number(item.system?.uses?.spent ?? 0),
    recovery: [{period: "lr", type: "recoverAll"}]
  };
}

export async function applyGinevraAlias(item, automation, apply) {
  const oldIdentifier = item.system?.identifier;
  if (automation?.identifier !== IDENTIFIER || oldIdentifier === IDENTIFIER) return apply();
  await updateDocumentSafely(item, {"system.identifier": IDENTIFIER});
  try {
    const result = await apply();
    if (item.flags?.cat?.automation?.source !== MODULE || item.flags.cat.automation.version !== VERSION) {
      throw new Error("CAT non ha applicato Abbraccio di Ginevra.");
    }
    return result;
  } catch (error) {
    await updateDocumentSafely(item, {"system.identifier": oldIdentifier});
    throw error;
  }
}

async function activateEmbrace({document: item, workflow} = {}) {
  if (workflow?.activity?.id !== ACTIVATE || !item?.actor) return;
  await changeGinevraCharges(item.actor, "activate", {itemUuid: item.uuid});
}

function attackActionType(workflow) {
  return workflow?.activity?.getActionType?.(workflow.attackMode)
    ?? workflow?.activity?.actionType ?? workflow?.item?.system?.actionType;
}

export async function embraceMeleeDamage({document: item, workflow} = {}) {
  if (!item?.actor || !embrace(item.actor, item) || !workflow?.activity?.attack
    || !["mwak", "msak"].includes(attackActionType(workflow)) || !values(workflow.hitTargets).length) return;
  await cat.utils.workflowUtils.bonusDamage(workflow, "2d4", {damageType: "radiant"});
}

function entryTarget(workflow, entry) {
  const candidates = values(workflow.targets).map(tokenDocument);
  return candidates.find(token => (entry.tokenUuid && token?.uuid === entry.tokenUuid)
    || (entry.targetUuid && token?.uuid === entry.targetUuid)
    || (entry.tokenId && token?.id === entry.tokenId)
    || (entry.actorUuid && token?.actor?.uuid === entry.actorUuid)
    || (entry.actorId && token?.actor?.id === entry.actorId));
}

export function inflictedDamage(workflow, actor) {
  if (!workflow || workflow.aborted || workflow.actor?.uuid !== actor?.uuid
    || workflow.workflowOptions?.khuzoeGinevraSpending
    || workflow.item?.system?.identifier === "khuzoe-ginevra-death") return 0;
  const source = tokenDocument(workflow.token);
  if (!source) return 0;
  return values(workflow.damageList).reduce((total, entry) => {
    const target = entryTarget(workflow, entry);
    if (!target?.actor || target.actor.uuid === actor.uuid || entry.isHit === false) return total;
    if (cat.utils.tokenUtils?.isEnemy
      ? !cat.utils.tokenUtils.isEnemy(source, target)
      : Number(source.disposition) === Number(target.disposition)) return total;
    return total + Math.max(0, Number(entry.hpDamage ?? 0) + Number(entry.tempDamage ?? 0));
  }, 0);
}

export async function collectEmbraceCharges({document: item, workflow} = {}) {
  const actor = item?.actor;
  if (!actor || !embrace(actor, item)) return;
  const amount = Math.floor(inflictedDamage(workflow, actor));
  if (!amount) return;
  const id = workflow?.uuid ?? workflow?.id;
  if (!id) return;
  await changeGinevraCharges(actor, "collect", {itemUuid: item.uuid, effectId: embrace(actor, item)?.id, amount, workflowId: id});
}

function chosenTarget(workflow, actor) {
  const targets = values(workflow?.targets).map(tokenDocument).filter(token => token?.actor);
  if (targets.length !== 1) return null;
  const source = tokenDocument(workflow?.token) ?? tokenDocument(cat.utils.actorUtils.getFirstToken(actor));
  if (!source) return null;
  const distance = source.uuid === targets[0].uuid ? 0 : cat.utils.tokenUtils?.getDistance?.(source, targets[0]);
  return Number.isFinite(distance) && distance <= 60 ? targets[0] : null;
}

export function validateEmbraceAction({document: item, workflow} = {}) {
  if (!item?.actor || ![LIFE, DEATH].includes(workflow?.activity?.id)) return;
  const charges = Number(embrace(item.actor, item)?.flags?.[MODULE]?.charges ?? 0);
  if (charges > 0 && chosenTarget(workflow, item.actor)) return;
  ui.notifications.warn(charges > 0
    ? `${item.name}: scegli una creatura entro 60 piedi.`
    : `${item.name}: non ci sono cariche da spendere.`);
  return true;
}

async function resolveEmbraceAmount(item, target, amount, {healing = false} = {}) {
  if (amount <= 0) return true;
  const DamageRoll = globalThis.CONFIG?.Dice?.DamageRoll;
  const DamageOnlyWorkflow = globalThis.MidiQOL?.DamageOnlyWorkflow;
  const source = cat.utils.actorUtils.getFirstToken(item.actor);
  const sourceToken = source?.object ?? source;
  const targetToken = target.object ?? target;
  if (!DamageRoll || !DamageOnlyWorkflow || !sourceToken || !targetToken?.actor) {
    throw new Error(`${healing ? "Angelo della Vita" : "Angelo della Morte"}: serve un token nella scena e il flusso di Midi-QOL disponibile.`);
  }
  const name = healing ? "Angelo della Vita: guarigione" : "Angelo della Morte: danni radianti";
  const type = healing ? "healing" : "radiant";
  const roll = await new DamageRoll(String(amount), item.actor.getRollData?.() ?? {}, {type}).evaluate();
  // Both actions have a fixed amount. Midi's resolved-roll path also supports
  // positive healing values: its target calculation inverts healing and caps it
  // at missing HP. It avoids another temporary activity use or owner dispatch.
  const result = new DamageOnlyWorkflow(item.actor, sourceToken, amount, type, [targetToken], roll, {
    flavor: name, itemCardUuid: "new", isCritical: false,
    itemData: {name, type: "feat", img: item.img, effects: [],
      system: {identifier: healing ? "khuzoe-ginevra-life" : "khuzoe-ginevra-death", source: {rules: "2024"}},
      flags: {"midi-qol": {syntheticItem: true}, dnd5e: {riders: {activity: []}}}}
  });
  result.workflowOptions.khuzoeGinevraSpending = true;
  result.activity.midiProperties.magicEffect = true;
  result.activity.midiProperties.magicDamage = !healing;
  await result.ready;
  return Boolean(result && !result.aborted && (result.damageRoll || values(result.damageRolls).length)
    && values(result.damageList).some(entry => entry.targetUuid === target.uuid
      || entry.tokenUuid === target.uuid || entry.actorUuid === target.actor?.uuid));
}

export async function spendEmbraceCharges({document: item, workflow} = {}) {
  const mode = workflow?.activity?.id;
  if (!item?.actor || ![LIFE, DEATH].includes(mode)) return;
  const actor = item.actor;
  const target = chosenTarget(workflow, actor);
  if (!target) return ui.notifications.warn(`${item.name}: scegli una creatura entro 60 piedi.`);
  const reservation = await changeGinevraCharges(actor, "reserve", {itemUuid: item.uuid, effectId: embrace(actor, item)?.id});
  if (!reservation) return ui.notifications.warn(`${item.name}: non ci sono cariche da spendere.`);
  const {charges, effectId} = reservation;
  let completed = false;
  try {
    if (mode === LIFE) {
      completed = await resolveEmbraceAmount(item, target, charges, {healing: true});
    } else {
      const dc = Number(actor.system?.attributes?.spell?.dc)
        || Number(actor.system?.abilities?.wis?.dc)
        || 8 + Number(actor.system?.abilities?.wis?.mod ?? 0) + Number(actor.system?.attributes?.prof ?? 0);
      const save = await rollTargetSavingThrow(target, "dex", dc);
      if (save) completed = await resolveEmbraceAmount(item, target, save.success ? Math.floor(charges / 2) : charges);
    }
  } finally {
    if (!completed) {
      const restored = await changeGinevraCharges(actor, "refund", {itemUuid: item.uuid, effectId, amount: charges});
      if (restored) ui.notifications.warn(`${mode === LIFE ? "Angelo della Vita" : "Angelo della Morte"}: operazione non completata, cariche ripristinate.`);
    }
  }
}

export function registerGinevra(api) {
  const pass = (pass, macro, priority = 100) => ({pass, macro, priority});
  return {
    automations: [api.registerAutomation(GINEVRA_AUTOMATION)],
    macros: [api.registerFnMacro({source: MODULE, rules: "2024", identifier: IDENTIFIER,
      roll: [pass("itemPreItemRoll", validateEmbraceAction, 10),
        pass("itemRollFinished", activateEmbrace), pass("itemRollFinished", spendEmbraceCharges, 110),
        pass("actorDamageRollBonuses", embraceMeleeDamage, 70), pass("actorRollFinished", collectEmbraceCharges, 160)]})]
  };
}
