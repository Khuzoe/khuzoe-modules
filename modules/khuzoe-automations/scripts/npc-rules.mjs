import {damageDealt} from "./damage-adjustment.mjs";

const MODULE = "khuzoe-automations";
export const NPC_RULES_VERSION = 1;
export const NPC_CONDITIONS = Object.freeze([
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"
]);
const copy = value => structuredClone(value);
const values = value => Array.from(value?.values?.() ?? (Array.isArray(value) ? value : Object.values(value ?? {})));

/** This data contract deliberately contains no executable macros. */
export function validateNpcRules(rules, activities = {}) {
  if (!rules || rules.version !== 1 || !rules.activities || typeof rules.activities !== "object" || Array.isArray(rules.activities)
    || Object.keys(rules).some(key => !["version", "activities"].includes(key))
    || Object.keys(rules.activities).length > 32) throw new Error("Preset NPC non valido o di versione non supportata.");
  for (const [id, rule] of Object.entries(rules.activities)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !Object.hasOwn(activities, id)) throw new Error(`Attività del preset non trovata: ${id}`);
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).some(key => !["healing", "conditions", "rounds", "expiry"].includes(key))
      || ![0, 0.5, 1].includes(rule.healing ?? 0)
      || !Array.isArray(rule.conditions ?? []) || (rule.conditions ?? []).length > 14 || (rule.conditions ?? []).some(id => !NPC_CONDITIONS.includes(id))
      || !Number.isInteger(rule.rounds ?? 1) || (rule.rounds ?? 1) < 0 || (rule.rounds ?? 1) > 100
      || !["turnStart", "turnEnd"].includes(rule.expiry ?? "turnEnd")) throw new Error(`Configurazione non valida per ${id}`);
    if ((rule.healing ?? 0) > 0 && !["attack", "save", "damage"].includes(activities[id].type)) {
      throw new Error("La cura dai danni richiede un'attività di attacco, danno o tiro salvezza.");
    }
    if ((rule.conditions?.length ?? 0) && !["attack", "save", "damage", "utility"].includes(activities[id].type)) {
      throw new Error("Le condizioni rapide non sono supportate per questo tipo di attività.");
    }
  }
  return rules;
}

/** Compile presets into ordinary item effects/activity links consumed by D&D5e and Midi. */
export function prepareNpcRules({rules, activities, effects, itemName, statusEffects = []}) {
  validateNpcRules(rules, activities);
  const nextActivities = copy(activities);
  const oldGenerated = effects.filter(effect => effect.flags?.[MODULE]?.npcRule);
  const generatedIds = new Set(oldGenerated.map(effect => effect._id));
  const nextEffects = copy(effects.filter(effect => !generatedIds.has(effect._id)));
  for (const activity of Object.values(nextActivities)) {
    activity.effects = (activity.effects ?? []).filter(link => !generatedIds.has(link._id));
  }
  for (const [activityId, rule] of Object.entries(rules.activities)) {
    const statuses = [...new Set(rule.conditions ?? [])];
    if (!statuses.length) continue;
    const activity = nextActivities[activityId];
    const definitions = statuses.map(id => {
      const definition = statusEffects.find(effect => effect.id === id);
      if (!definition) throw new Error(`Condizione non disponibile in questo mondo: ${id}`);
      return definition;
    });
    const rounds = rule.rounds ?? 1;
    for (const definition of definitions) {
      const previous = oldGenerated.find(effect => effect.flags[MODULE].npcRule.activityId === activityId
        && effect.flags[MODULE].npcRule.condition === definition.id);
      const id = previous?._id ?? globalThis.foundry.utils.randomID();
      nextEffects.push({
      _id: id, name: `${itemName} — ${activity.name || "Condizioni"} — ${globalThis.game?.i18n?.localize?.(definition.name) ?? definition.id}`,
      img: definition.img ?? definition.icon ?? "icons/svg/aura.svg",
      type: "base", disabled: false, transfer: false, statuses: [definition.id],
      system: {changes: copy(definition.system?.changes ?? definition.changes ?? [])},
      duration: rounds ? {value: rounds, units: "rounds", expiry: rule.expiry ?? "turnEnd"} : {value: null, units: "seconds", expiry: null},
      flags: {
        [MODULE]: {npcRule: {activityId, condition: definition.id}},
        dae: {transfer: false, stackable: "noneName", expiryMode: "delete"},
        "midi-qol": {forceCEOff: true}
      }
    });
    // Midi applies attack effects to hits and save effects to failed saves.
    activity.effects.push({_id: id, onSave: false});
    }
  }
  return {activities: nextActivities, effects: nextEffects};
}

const healedWorkflows = new WeakSet();

/** Run on the client which owns the completed workflow, once, through Midi's healing pipeline. */
export async function healFromNpcRule(workflow) {
  if (!workflow || workflow.aborted || healedWorkflows.has(workflow)) return;
  if (workflow.userId && workflow.userId !== globalThis.game?.user?.id) return;
  const rules = workflow.item?.flags?.[MODULE]?.npcRules;
  const id = workflow.activity?.id ?? workflow.activity?._id;
  const fraction = rules?.version === 1 ? rules.activities?.[id]?.healing : 0;
  if (![0.5, 1].includes(fraction)) return;
  const damageEntries = values(workflow.damageList).filter(entry => entry.isHit !== false);
  if (!damageEntries.length) return;
  // Do not heal from a mere damage preview while automatic damage is disabled.
  const settings = globalThis.MidiQOL?.configSettings?.();
  if (!String(settings?.autoApplyDamage ?? "").toLowerCase().includes("yes")) {
    globalThis.ui?.notifications?.warn?.(`${workflow.item.name}: cura dai danni non eseguita; Midi deve applicare automaticamente i danni.`);
    return;
  }
  const seen = new Set();
  let damage = 0;
  for (const entry of damageEntries) {
    const key = entry.tokenUuid ?? entry.targetUuid ?? entry.tokenId ?? entry.actorUuid ?? entry.actorId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const targetActor = entry.actor ?? (entry.actorUuid ? globalThis.fromUuidSync?.(entry.actorUuid) : null);
    if (settings.autoApplyDamage === "yesCardNPC" && targetActor?.type !== "npc") continue;
    // With separate concentration checks Midi leaves damageList pointing to
    // the last damage batch; retain the primary batch as well as other damage.
    const split = !settings.singleConcentrationRoll && workflow.otherDamageRolls?.length
      && entry.damageDetails?.combinedDamage && entry.damageDetails?.otherDamage;
    const measured = split ? {...entry, damageDetail: [...values(entry.damageDetails.combinedDamage), ...values(entry.damageDetails.otherDamage)]} : entry;
    damage += damageDealt({damageList: [measured]}, {
      uuid: entry.tokenUuid ?? entry.targetUuid, id: entry.tokenId,
      actor: {uuid: entry.actorUuid, id: entry.actorId}
    });
  }
  const amount = Math.floor(damage * fraction);
  const token = workflow.token?.object ?? workflow.token;
  if (!amount) return;
  if (!token?.actor || typeof globalThis.MidiQOL?.applyTokenDamage !== "function") {
    globalThis.ui?.notifications?.warn?.(`${workflow.item.name}: serve un token dell'utilizzatore e Midi-QOL attivo per applicare la cura.`);
    return;
  }
  healedWorkflows.add(workflow);
  await globalThis.MidiQOL.applyTokenDamage([{value: amount, type: "healing", properties: new Set()}], amount,
    new Set([token]), workflow.item, new Set(), {forceApply: true, noConcentrationCheck: true});
}

export function exposeNpcRulesApi() {
  const module = globalThis.game?.modules?.get(MODULE);
  if (!module) return;
  module.api ??= {};
  module.api.npcRules = {version: NPC_RULES_VERSION, prepare: prepareNpcRules};
}
