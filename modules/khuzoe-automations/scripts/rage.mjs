import {RELEASE_VERSION} from "./release.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;

export const RAGE_IDENTIFIER = "rage";
export const RAGE_ACTIVE_IDENTIFIER = "khuzoe-rage-active";
export const RAGE_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzRage14Auto001";
export const RAGE_START_ACTIVITY_ID = "KhzRageUse000001";
export const RAGE_END_ACTIVITY_ID = "KhzRageEnd000001";

const BASE_RESISTANCES = Object.freeze(["bludgeoning", "piercing", "slashing"]);
const BEAR_RESISTANCES = Object.freeze([
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "radiant",
  "slashing",
  "thunder"
]);

const BEAR_IDENTIFIERS = new Set([
  "totem-spirit-bear",
  "totem-spirit-bear-2014",
  "spirito-totemico-orso",
  "spirito-del-totem-orso",
  "totem-dell-orso"
]);

const PERSISTENT_RAGE_IDENTIFIERS = new Set(["persistent-rage", "ira-persistente"]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
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
  return slug(document?.system?.identifier || document?.name);
}

function actorItem(actor, identifiers) {
  const wanted = identifiers instanceof Set ? identifiers : new Set(identifiers);
  return values(actor?.items).find(item => wanted.has(identifier(item)));
}

export function hasBearTotem(actor) {
  return Boolean(values(actor?.items).find(item => {
    const id = identifier(item);
    if (BEAR_IDENTIFIERS.has(id)) return true;
    const name = slug(item?.name);
    return (name.includes("totem-spirit") && name.includes("bear"))
      || (name.includes("spirito-totemico") && name.includes("orso"));
  }));
}

export function hasPersistentRage(actor) {
  return Boolean(actorItem(actor, PERSISTENT_RAGE_IDENTIFIERS));
}

function barbarianLevel(actor) {
  const direct = Number(actor?.classes?.barbarian?.system?.levels);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const item = values(actor?.items).find(candidate =>
    candidate?.type === "class" && ["barbarian", "barbaro"].includes(identifier(candidate))
  );
  const level = Number(item?.system?.levels ?? 0);
  return Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

export function rageDamageBonus(actor) {
  const scale = actor?.system?.scale?.barbarian?.["rage-damage"];
  const scaled = Number(scale?.value ?? scale?.number ?? scale);
  if (Number.isFinite(scaled) && scaled > 0) return Math.floor(scaled);
  const level = barbarianLevel(actor);
  if (level >= 16) return 4;
  if (level >= 9) return 3;
  return 2;
}

export function rageResistanceTypes(actor) {
  if (!hasBearTotem(actor)) return Array.from(BASE_RESISTANCES);
  // Il Bear Totem resiste a ogni tipo di danno tranne psychic. Partire anche
  // dalla CONFIG del mondo include tipi registrati da altri moduli (per
  // esempio il danno Geniale/Genie) senza dover aggiornare questa lista.
  const configured = Object.keys(globalThis.CONFIG?.DND5E?.damageTypes ?? {});
  return [...new Set([...BEAR_RESISTANCES, ...configured])].filter(type => type !== "psychic");
}

function effectByIdentifier(actor, effectIdentifier = RAGE_ACTIVE_IDENTIFIER) {
  return values(actor?.effects).find(effect => effect.flags?.cat?.identifier === effectIdentifier);
}

function remainingUses(item) {
  const computed = Number(item?.system?.uses?.value);
  if (Number.isFinite(computed)) return Math.max(0, computed);
  const maximum = Number(item?.system?.uses?.max ?? 0);
  const spent = Number(item?.system?.uses?.spent ?? 0);
  if (!Number.isFinite(maximum)) return Infinity;
  return Math.max(0, maximum - (Number.isFinite(spent) ? spent : 0));
}

function rageChanges(actor) {
  if (wearsHeavyArmor(actor) && !hasBearTotem(actor)) return [];
  return rageResistanceTypes(actor).map(type => ({
    key: "system.traits.dr.value",
    value: type,
    priority: 20,
    type: "add"
  }));
}

function rageEffectData(item) {
  const bearTotem = hasBearTotem(item.actor);
  return {
    name: bearTotem ? `${item.name} — Bear Totem` : item.name,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {changes: rageChanges(item.actor)},
    duration: {
      value: 60,
      units: "seconds",
      expiry: "turnStart",
      expired: false
    },
    statuses: [],
    description: bearTotem
      ? "<p>Rage attiva: vantaggio alle prove e ai TS di Forza, bonus ai danni in mischia con Forza e resistenza a tutti i danni tranne psichico.</p>"
      : "<p>Rage attiva: vantaggio alle prove e ai TS di Forza, bonus ai danni in mischia con Forza e resistenza ai danni contundenti, perforanti e taglienti.</p>",
    showIcon: 1,
    flags: {
      cat: {
        identifier: RAGE_ACTIVE_IDENTIFIER,
        macros: {
          roll: [{source: MODULE_ID, rules: RULES, identifier: RAGE_ACTIVE_IDENTIFIER}],
          check: [{source: MODULE_ID, rules: RULES, identifier: RAGE_ACTIVE_IDENTIFIER}],
          save: [{source: MODULE_ID, rules: RULES, identifier: RAGE_ACTIVE_IDENTIFIER}],
          combat: [{source: MODULE_ID, rules: RULES, identifier: RAGE_ACTIVE_IDENTIFIER}]
        }
      },
      dae: {
        transfer: false,
        stackable: "noneNameOnly",
        specialDuration: ["zeroHP"],
        expiryMode: "delete"
      },
      [MODULE_ID]: {
        rage: {
          maintained: Boolean(item.actor.flags?.[MODULE_ID]?.rageEventSinceTurnEnd),
          lastEvent: "activation",
          bearTotem
        }
      }
    }
  };
}

async function validateRageUse({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || workflow?.activity?.id !== RAGE_START_ACTIVITY_ID) return;
  if (effectByIdentifier(feature.actor)) {
    ui.notifications.info(`${feature.name} è già attiva. Usa “Termina Rage” prima di attivarla nuovamente.`);
    return true;
  }
  if (remainingUses(feature) > 0) return;
  ui.notifications.warn(`${feature.name}: nessun utilizzo disponibile.`);
  return true;
}

async function activateRage(item) {
  const existing = effectByIdentifier(item.actor);
  if (existing) await globalThis.cat.utils.documentUtils.deleteDocument(existing);
  for (const effect of values(item.actor.effects)) {
    if (effect.statuses?.has?.("concentrating") || values(effect.statuses).includes("concentrating")) {
      await globalThis.cat.utils.documentUtils.deleteDocument(effect);
    }
  }
  await globalThis.cat.utils.effectUtils.createEffects(item.actor, [rageEffectData(item)], {rules: RULES});
}

async function finishRageUse({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature) return;
  if (workflow?.activity?.id === RAGE_START_ACTIVITY_ID) return activateRage(feature);
  if (workflow?.activity?.id !== RAGE_END_ACTIVITY_ID) return;
  const effect = effectByIdentifier(feature.actor);
  if (effect) await globalThis.cat.utils.documentUtils.deleteDocument(effect);
}

function strengthAdvantage({checkId, saveId, options, actor, document}) {
  if (wearsHeavyArmor(actor ?? document?.parent)) return;
  if ((checkId ?? saveId) === "str") options.advantage = true;
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

export function qualifiesForRageDamage(workflow) {
  return !wearsHeavyArmor(workflow?.actor) && workflowActionType(workflow) === "mwak" && workflowAttackAbility(workflow) === "str";
}

function wearsHeavyArmor(actor) {
  return values(actor?.items).some(item => item.type === "equipment" && item.system?.equipped
    && (item.system?.type?.value ?? item.system?.armor?.type) === "heavy");
}

export async function reconcileRageStatus(actor) {
  const effect = effectByIdentifier(actor);
  if (!effect) return;
  if (actor.statuses?.has?.("unconscious") || actor.statuses?.has?.("dead") || Number(actor.system?.attributes?.hp?.value ?? 1) <= 0) {
    await cat.utils.documentUtils.deleteDocument(effect);
    return;
  }
  const expected = rageChanges(actor);
  if (JSON.stringify(effect.toObject?.().system?.changes ?? effect.system?.changes) !== JSON.stringify(expected)) {
    await updateDocumentSafely(effect, {"system.changes": expected});
  }
}

export function restrictRageSpellcasting(activity) {
  const rage = effectByIdentifier(activity?.item?.actor);
  if (activity?.item?.type !== "spell" || !rage || rage.disabled || rage.isSuppressed || rage.active === false) return;
  ui.notifications.warn("Non puoi lanciare incantesimi mentre Rage è attiva.");
  return false;
}

async function addRageDamage({workflow, document}) {
  if (!workflow || !qualifiesForRageDamage(workflow)) return;
  const actor = document?.parent ?? workflow.actor;
  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, String(rageDamageBonus(actor)), {
    damageType: workflow.defaultDamageType
  });
}

async function markMaintained(effect, reason) {
  if (!effect || effect.flags?.[MODULE_ID]?.rage?.maintained) return;
  await updateDocumentSafely(effect, {
    [`flags.${MODULE_ID}.rage.maintained`]: true,
    [`flags.${MODULE_ID}.rage.lastEvent`]: reason
  });
}

async function markRageAttack({workflow, document}) {
  if (!workflow?.attackRoll && workflow?.activity?.type !== "attack") return;
  const source = tokenDocument(workflow.token);
  const targets = values(workflow.hitTargets?.size ? workflow.hitTargets : workflow.targets)
    .map(tokenDocument)
    .filter(target => target?.actor);
  if (source && targets.length && globalThis.cat.utils.tokenUtils?.isEnemy
    && !targets.some(target => globalThis.cat.utils.tokenUtils.isEnemy(source, target))) return;
  const effect = document?.documentName === "ActiveEffect"
    ? document
    : effectByIdentifier(workflow?.actor);
  if (actorItem(workflow.actor, [RAGE_IDENTIFIER])) await updateDocumentSafely(workflow.actor, {[`flags.${MODULE_ID}.rageEventSinceTurnEnd`]: true});
  await markMaintained(effect, "attack");
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function activeGmId() {
  return values(game?.users).find(user => user.active && user.isGM)?.id ?? null;
}

function shouldHandleDamage(actor) {
  const gmId = activeGmId();
  return gmId ? game.user?.id === gmId : Boolean(actor?.isOwner);
}

async function markRageDamage(token, data = {}) {
  const actor = tokenDocument(token)?.actor ?? token?.actor;
  if (!actor || !shouldHandleDamage(actor)) return;
  const damage = data.damageItem ?? data.ditem ?? {};
  if (Number(damage.hpDamage ?? 0) <= 0 && Number(damage.tempDamage ?? 0) <= 0) return;
  if (actorItem(actor, [RAGE_IDENTIFIER])) await updateDocumentSafely(actor, {[`flags.${MODULE_ID}.rageEventSinceTurnEnd`]: true});
  await markMaintained(effectByIdentifier(actor), "damage");
}

export function rageContinuesAtTurnEnd({maintained = false, persistent = false} = {}) {
  return Boolean(persistent || maintained);
}

async function checkRageAtTurnEnd({token, document}) {
  const effect = document?.documentName === "ActiveEffect" ? document : null;
  const actor = effect?.parent;
  const endedActor = tokenDocument(token)?.actor;
  if (!effect || !actor || !endedActor || actor.uuid !== endedActor.uuid) return;

  const persistent = hasPersistentRage(actor);
  const maintained = Boolean(effect.flags?.[MODULE_ID]?.rage?.maintained);
  if (!rageContinuesAtTurnEnd({maintained, persistent})) {
    await globalThis.cat.utils.documentUtils.deleteDocument(effect);
    if (game.user?.isGM || actor.isOwner) {
      ui.notifications.info(`${actor.name}: Rage terminata perché non ha attaccato né subito danni.`);
    }
    return;
  }
  if (persistent) return;
  await updateDocumentSafely(effect, {
    [`flags.${MODULE_ID}.rage.maintained`]: false,
    [`flags.${MODULE_ID}.rage.lastEvent`]: "turn-end"
  });
}

export function prepareRageItemUpdate(item, changes) {
  const updatedIdentifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (updatedIdentifier !== RAGE_IDENTIFIER) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (changes.system?.uses && item.system?.uses) {
    const current = item.toObject?.().system?.uses ?? item.system.uses;
    changes.system.uses = foundry.utils.deepClone(current);
  }
  if (item?.img) changes.img = item.img;
}

export const RAGE_AUTOMATION = Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: RAGE_IDENTIFIER,
  version: VERSION,
  uuid: RAGE_UUID,
  type: "feat",
  notes: "Attiva Rage 2014, applica vantaggio a Forza, bonus ai danni in mischia basati su Forza e resistenze. Rileva Bear Totem e termina automaticamente Rage se tra due fini-turno non vengono effettuati attacchi né subiti danni."
});

export function registerRage(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: RAGE_IDENTIFIER,
      roll: [
        {pass: "itemPreItemRoll", macro: validateRageUse, priority: 10},
        {pass: "itemRollFinished", macro: finishRageUse, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: RAGE_ACTIVE_IDENTIFIER,
      roll: [
        {pass: "actorAttackRollComplete", macro: markRageAttack, priority: 50},
        {pass: "actorDamageRollBonuses", macro: addRageDamage, priority: 50}
      ],
      combat: [{pass: "sceneTurnEnd", macro: checkRageAtTurnEnd, priority: 50, canOverlap: true}],
      check: [{pass: "actorSituational", macro: strengthAdvantage, priority: 50}],
      save: [{pass: "actorSituational", macro: strengthAdvantage, priority: 50}]
    })
  ];
  return {macros, automations: [api.registerAutomation(RAGE_AUTOMATION)]};
}

Hooks.on("midi-qol.preTargetDamageApplication", markRageDamage);

Hooks.on("midi-qol.RollComplete", workflow => {
  if (!workflow?.aborted && workflow.activity?.type === "attack") void markRageAttack({workflow});
});
Hooks.on("combatTurnChange", (combat, prior) => {
  if (!game.user.isGM) return;
  const actor = combat.combatants?.get?.(prior?.combatantId)?.actor;
  if (actor?.flags?.[MODULE_ID]?.rageEventSinceTurnEnd) void updateDocumentSafely(actor, {[`flags.${MODULE_ID}.rageEventSinceTurnEnd`]: false});
});
