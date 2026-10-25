import {withDocumentLock} from "./operation-locks.mjs";
import {RELEASE_VERSION} from "./release.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {tokenSizeForCategory} from "./geometry.mjs";
import {runSyntheticActivityData} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";
const GIANTS_MIGHT_CONFIG_FLAG = "giantsMightConfig";

const GIANTS_MIGHT_DEFAULTS = Object.freeze({
  baseSize: "lg",
  juggernautSize: "huge"
});

const SIZE_INDEX = Object.freeze({tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5});
const SIZE_CHOICES = Object.freeze([
  ["none", "Non modificare la taglia"],
  ["tiny", "Tiny"],
  ["sm", "Small"],
  ["med", "Medium"],
  ["lg", "Large"],
  ["huge", "Huge"],
  ["grg", "Gargantuan"]
]);

const applicationApi = globalThis.foundry?.applications?.api;
const ApplicationV2 = applicationApi?.ApplicationV2 ?? class {};
const HandlebarsApplicationV2 = applicationApi?.HandlebarsApplicationMixin?.(ApplicationV2) ?? ApplicationV2;

const IDS = Object.freeze({
  giant: "giants-might",
  giantActive: "giants-might-active",
  cloud: "cloud-rune",
  fire: "fire-rune",
  frost: "frost-rune",
  frostActive: "frost-rune-active",
  hill: "hill-rune",
  hillActive: "hill-rune-active",
  stone: "stone-rune",
  stoneActive: "stone-rune-active",
  storm: "storm-rune",
  stormActive: "storm-rune-active",
  shield: "runic-shield",
  stature: "great-stature",
  master: "master-of-runes",
  juggernaut: "runic-juggernaut"
});

const ACTIVITY = Object.freeze({
  giant: "KhzRKGiantUse001",
  cloud: "KhzRKCloudUse001",
  fireSave: "KhzRKFireSave001",
  frost: "KhzRKFrostUse001",
  hill: "KhzRKHillUse0001",
  stone: "KhzRKStoneUse001",
  storm: "KhzRKStormUse001",
  shield: "KhzRKShieldUse01"
});

// Le attività tecniche rimangono rider nell'Item reale, ma Foundry v14 non
// consente di eseguire un'attività rider neppure tramite Midi-QOL. Le copie
// runtime usano quindi ID diversi, validi e stabili, che non compaiono nella
// lista rider dell'Item.
const RUNTIME_ACTIVITY = Object.freeze({
  cloud: "KhzRKCloudRt0001",
  fireSave: "KhzRKFireRt00001",
  stone: "KhzRKStoneRt0001",
  shield: "KhzRKShldRt00001"
});

const itemUseQueues = new Map();
const reactionQueues = new Map();
const workflowFeatureMarks = new WeakMap();
const eventFeatureMarks = new WeakMap();
const stoneTurnMarks = new Map();

const AUTOMATION_DOCUMENTS = Object.freeze([
  [IDS.giant, "KhzRKGiantMight1", "Giant's Might: taglia, vantaggio a Forza e danno extra una volta per turno; integra Great Stature e Runic Juggernaut."],
  [IDS.cloud, "KhzRKCloudRune01", "Vantaggio passivo e reazione per trasferire un attacco già a segno a una nuova creatura entro 30 ft."],
  [IDS.fire, "KhzRKFireRune001", "Competenza raddoppiata con gli strumenti; su un colpo con arma aggiunge 2d6 fuoco e applica i ceppi con TS e danno ricorrente."],
  [IDS.frost, "KhzRKFrostRune01", "Vantaggi passivi e attivazione per +2 alle prove e ai TS di Forza e Costituzione per 10 minuti."],
  [IDS.hill, "KhzRKHillRune001", "Resistenza passiva al veleno, vantaggio ai TS contro il veleno e resistenza ai danni fisici per 1 minuto."],
  [IDS.stone, "KhzRKStoneRune01", "Insight e scurovisione passivi; reazione automatica a fine turno con charme, incapacità, velocità zero e TS ripetuto."],
  [IDS.storm, "KhzRKStormRune01", "Arcana e immunità alla sorpresa passivi; per 1 minuto usa la reazione per imporre vantaggio o svantaggio entro 60 ft."],
  [IDS.shield, "KhzRKRunicShld01", "Dopo che un alleato entro 60 ft viene colpito, forza l'attaccante a ripetere il d20 e usare il nuovo risultato."],
  [IDS.stature, "KhzRKGreatStat01", "Potenziamento passivo di Giant's Might: il dado di danno diventa d8."],
  [IDS.master, "KhzRKMasterRune1", "Ogni runa può essere invocata due volte per riposo anziché una."],
  [IDS.juggernaut, "KhzRKRunicJuggr1", "Giant's Might può rendere Enorme, il dado diventa d10 e la portata degli attacchi in mischia aumenta di 5 ft."]
]);

export const RUNE_KNIGHT_IDENTIFIERS = new Set(AUTOMATION_DOCUMENTS.map(([identifier]) => identifier));

export const RUNE_KNIGHT_AUTOMATIONS = AUTOMATION_DOCUMENTS.map(([identifier, id, notes]) => ({
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

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function technicalActivityData(item, activityId, runtimeId) {
  const activity = itemActivity(item, activityId);
  if (!activity) return null;
  const data = typeof activity.toObject === "function"
    ? activity.toObject()
    : foundry.utils.deepClone(activity);
  data._id = runtimeId;
  delete data.id;
  data.activation = {
    ...(data.activation ?? {}),
    type: "special",
    value: null,
    override: true
  };
  data.flags ??= {};
  data.flags.cat = {...(data.flags.cat ?? {}), hidden: true};
  data.midiProperties = {
    ...(data.midiProperties ?? {}),
    automationOnly: true,
    confirmTargets: "never"
  };
  return data;
}

async function rollTechnicalActivity(item, activityId, runtimeId, targets, options = {}) {
  const data = technicalActivityData(item, activityId, runtimeId);
  if (!data) return null;
  return runSyntheticActivityData(
    data,
    item,
    targets,
    {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(item.actor ?? item),
      options: {workflowOptions: {khuzoeRuneInvocation: true}},
      ...options
    }
  );
}

function identifier(document) {
  return document?.system?.identifier ?? document?.flags?.cat?.identifier;
}

function isGiantsMightItem(item) {
  return item?.documentName === "Item" && identifier(item) === IDS.giant;
}

function normalizeConfiguredSize(value, fallback) {
  return SIZE_CHOICES.some(([key]) => key === value) ? value : fallback;
}

export function resolveGiantsMightConfig(raw = {}) {
  return {
    baseSize: normalizeConfiguredSize(raw?.baseSize, GIANTS_MIGHT_DEFAULTS.baseSize),
    juggernautSize: normalizeConfiguredSize(raw?.juggernautSize, GIANTS_MIGHT_DEFAULTS.juggernautSize)
  };
}

function giantsMightConfig(item) {
  const stored = item?.getFlag?.(MODULE_ID, GIANTS_MIGHT_CONFIG_FLAG)
    ?? item?.flags?.[MODULE_ID]?.[GIANTS_MIGHT_CONFIG_FLAG];
  return resolveGiantsMightConfig(stored);
}

function actorItem(actor, id) {
  return values(actor?.items).find(item => identifier(item) === id);
}

function effectByIdentifier(actor, id) {
  return values(actor?.effects).find(effect => effect.flags?.cat?.identifier === id);
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function ownerUserId(document) {
  return globalThis.cat.utils.queryUtils.firstOwner(document, true) ?? game.user.id;
}

function canReact(actor) {
  if (!actor || globalThis.cat.utils.actorUtils.hasUsedReaction(actor)) return false;
  return !["dead", "incapacitated", "paralyzed", "stunned", "unconscious"].some(status => actor.statuses?.has(status));
}

function canSee(source, target) {
  try {
    return globalThis.MidiQOL?.canSee?.(source?.object, target?.object) ?? true;
  } catch (_error) {
    return true;
  }
}

function within(source, target, distance) {
  if (!source || !target || source.parent?.id !== target.parent?.id) return false;
  return globalThis.cat.utils.tokenUtils.getDistance(source, target, {wallsBlock: true}) <= distance;
}

function actorTokensInScene(actor, scene) {
  if (!actor || !scene) return [];
  return values(scene.tokens).map(tokenDocument).filter(token => {
    const tokenActor = token?.actor;
    return tokenActor && (
      tokenActor === actor
      || (tokenActor.uuid && actor.uuid && tokenActor.uuid === actor.uuid)
      || (tokenActor.id && actor.id && tokenActor.id === actor.id)
    );
  });
}

function ownerTokenForTarget(actor, target, distance, {requiresSight = true} = {}) {
  target = tokenDocument(target);
  const candidates = actorTokensInScene(actor, target?.parent)
    .filter(token => within(token, target, distance))
    .filter(token => !requiresSight || canSee(token, target));
  candidates.sort((left, right) => (
    globalThis.cat.utils.tokenUtils.getDistance(left, target, {wallsBlock: true})
    - globalThis.cat.utils.tokenUtils.getDistance(right, target, {wallsBlock: true})
  ));
  return candidates[0] ?? null;
}

function markObjectFeature(object, document, suffix) {
  if (!object || typeof object !== "object") return true;
  let marks = workflowFeatureMarks.get(object);
  if (!marks) workflowFeatureMarks.set(object, marks = new Set());
  const key = `${document?.uuid ?? document?.id ?? identifier(document)}:${suffix}`;
  if (marks.has(key)) return false;
  marks.add(key);
  return true;
}

function markEventFeature(object, document, suffix) {
  if (!object || typeof object !== "object") return true;
  let marks = eventFeatureMarks.get(object);
  if (!marks) eventFeatureMarks.set(object, marks = new Set());
  const key = `${document?.uuid ?? document?.id ?? identifier(document)}:${suffix}`;
  if (marks.has(key)) return false;
  marks.add(key);
  return true;
}

function markStoneTurn({combat, round, turn, token, document}, release = false) {
  const target = tokenDocument(token);
  const turnKey = `${combat?.id ?? target?.parent?.id ?? "scene"}:${round ?? "-"}:${turn ?? "-"}:${target?.id ?? "token"}`;
  let documents = stoneTurnMarks.get(turnKey);
  if (!documents) {
    stoneTurnMarks.set(turnKey, documents = new Set());
    while (stoneTurnMarks.size > 16) stoneTurnMarks.delete(stoneTurnMarks.keys().next().value);
  }
  const documentKey = document?.uuid ?? document?.id ?? identifier(document);
  if (release) return documents.delete(documentKey);
  if (documents.has(documentKey)) return false;
  documents.add(documentKey);
  return true;
}

export function isFriendlyToken(token) {
  token = tokenDocument(token);
  const friendly = globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  return Number(token?.disposition) === Number(friendly);
}

function usesRemaining(item, maxOverride) {
  const prepared = Number(item?.system?.uses?.value);
  const spent = Number(item?.system?.uses?.spent ?? 0);
  const rawMaximum = maxOverride ?? item?.system?.uses?.max;
  const maximum = rawMaximum === "@prof"
    ? Number(item?.actor?.system?.attributes?.prof ?? 0)
    : Number(rawMaximum);
  if (Number.isFinite(maximum)) return Math.max(0, maximum - spent);
  if (Number.isFinite(prepared)) return Math.max(0, prepared);
  return 0;
}

function runeMaximum(actor) {
  return actorItem(actor, IDS.master) ? 2 : 1;
}

function runeUsesRemaining(item) {
  return usesRemaining(item, runeMaximum(item?.actor));
}

async function withDocumentQueue(queues, document, operation) {
  const key = document?.uuid ?? `${document?.documentName ?? "Document"}.${document?.id ?? identifier(document)}`;
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  queues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

async function refreshDocument(document) {
  if (typeof globalThis.fromUuid !== "function" || !document?.uuid) return document;
  try {
    return await globalThis.fromUuid(document.uuid) ?? document;
  } catch (_error) {
    return document;
  }
}

async function consumeUse(item) {
  return reserveResources(item.actor, {item});
}

function consumeRuneUse(item) {
  return consumeUse(item, runeMaximum(item?.actor));
}

async function refundUse(item, receipt) {
  if (receipt) return refundResources(receipt);
  return withDocumentQueue(itemUseQueues, item, async () => {
    const current = await refreshDocument(item);
    const spent = Number(current?.system?.uses?.spent ?? 0);
    if (spent <= 0) return false;
    await updateDocumentSafely(current, {"system.uses.spent": spent - 1}, {khuzoeRuneRefund: true});
    return true;
  });
}

async function useReaction(actor) {
  if (!canReact(actor)) return null;
  return reserveResources(actor, {reaction: true});
}

async function removeEffect(actor, effectIdentifier, options = {}) {
  const effect = effectByIdentifier(actor, effectIdentifier);
  if (effect) await globalThis.cat.utils.documentUtils.deleteDocument(effect, {options});
}

function effectData(item, effectIdentifier, {name = item.name, duration = {}, changes = [], statuses = [], description = "", macros = {}, moduleFlags = {}, stackable = "noneNameOnly"} = {}) {
  return {
    name,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {changes},
    duration,
    statuses,
    description,
    showIcon: 1,
    flags: {
      cat: {
        identifier: effectIdentifier,
        macros
      },
      dae: {
        transfer: false,
        stackable,
        specialDuration: [],
        expiryMode: "delete"
      },
      [MODULE_ID]: moduleFlags
    }
  };
}

function timedDuration(seconds, expiry = "turnStart") {
  return {
    value: seconds,
    units: "seconds",
    expiry,
    expired: false
  };
}

async function createUniqueEffect(item, effectIdentifier, data, {replacementOptions = {}} = {}) {
  const existing = effectByIdentifier(item.actor, effectIdentifier);
  if (existing) await removeEffect(item.actor, effectIdentifier, replacementOptions);
  try {
    const created = await globalThis.cat.utils.effectUtils.createEffects(
      item.actor,
      [effectData(item, effectIdentifier, data)],
      {rules: RULES}
    );
    return created?.[0];
  } catch (error) {
    if (existing && replacementOptions.khuzoeGiantsMightRefresh) {
      await restoreGiantsMightTokenSize(existing);
    }
    throw error;
  }
}

function notifyNoUses(item) {
  if (game.user.isGM || item?.actor?.isOwner) ui.notifications.warn(`${item.name}: nessun uso disponibile.`);
}

function validateRuneUse({workflow, document, item}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || !RUNE_KNIGHT_IDENTIFIERS.has(identifier(feature))) return;
  if (![ACTIVITY.frost, ACTIVITY.hill, ACTIVITY.storm].includes(workflow?.activity?.id)) return;
  const remaining = runeUsesRemaining(feature);
  if (remaining > 0) return;
  notifyNoUses(feature);
  return true;
}

function skillAdvantage(validSkills) {
  return ({skillId, options}) => {
    if (options && validSkills.includes(skillId)) options.advantage = true;
  };
}

function strengthAdvantage({checkId, saveId, options}) {
  if (options && (checkId ?? saveId) === "str") options.advantage = true;
}

function frostActiveBonusChanges() {
  return ["str", "con"].flatMap(ability => [
    {key: `system.abilities.${ability}.bonuses.check`, value: "2", priority: 20, type: "add"},
    {key: `system.abilities.${ability}.bonuses.save`, value: "2", priority: 20, type: "add"}
  ]);
}

async function activateFrostRune({workflow, document}) {
  if (workflow?.activity?.id !== ACTIVITY.frost) return;
  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) return notifyNoUses(document);
  try {
    await createUniqueEffect(document, IDS.frostActive, {
      duration: timedDuration(600),
      changes: frostActiveBonusChanges(),
      description: "<p>+2 alle prove di caratteristica e ai tiri salvezza di Forza e Costituzione.</p>"
    });
  } catch (error) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    throw error;
  }
}

async function activateHillRune({workflow, document}) {
  if (workflow?.activity?.id !== ACTIVITY.hill) return;
  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) return notifyNoUses(document);
  try {
    await createUniqueEffect(document, IDS.hillActive, {
      duration: timedDuration(60),
      changes: ["bludgeoning", "piercing", "slashing"].map(type => ({
        key: "system.traits.dr.value",
        value: type,
        priority: 20,
        type: "add"
      })),
      description: "<p>Resistenza ai danni contundenti, perforanti e taglienti per 1 minuto.</p>"
    });
  } catch (error) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    throw error;
  }
}

async function activateStormRune({workflow, document}) {
  if (workflow?.activity?.id !== ACTIVITY.storm) return;
  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) return notifyNoUses(document);
  try {
    await createUniqueEffect(document, IDS.stormActive, {
      duration: timedDuration(60),
      description: "<p>Una volta per turno, come reazione, puoi imporre vantaggio o svantaggio a un tiro entro 60 ft.</p>",
      macros: {
        roll: [{source: MODULE_ID, rules: RULES, identifier: IDS.stormActive}],
        save: [{source: MODULE_ID, rules: RULES, identifier: IDS.stormActive}],
        check: [{source: MODULE_ID, rules: RULES, identifier: IDS.stormActive}],
        skill: [{source: MODULE_ID, rules: RULES, identifier: IDS.stormActive}],
        tool: [{source: MODULE_ID, rules: RULES, identifier: IDS.stormActive}]
      }
    });
  } catch (error) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    throw error;
  }
}

function poisonSaveActivity(config) {
  if (!config) return false;
  const uuid = foundry.utils.getProperty(config ?? {}, "cat.activityUuid");
  const activity = uuid ? fromUuidSync(uuid, {strict: false}) : null;
  if (!activity) return false;
  return values(activity.effects).some(link => {
    const effect = link?.effect
      ?? activity.item?.effects?.get?.(link?._id ?? link?.id ?? link)
      ?? link;
    return effect?.statuses?.has?.("poisoned") || values(effect?.statuses).includes("poisoned");
  });
}

function hillPoisonAdvantage({config, options}) {
  if (options && poisonSaveActivity(config)) options.advantage = true;
}

async function fireToolExpertise({actor, toolId, roll}) {
  const proficiency = Number(actor?.system?.tools?.[toolId]?.value ?? actor?.system?.tools?.[toolId]?.proficient ?? 0);
  if (proficiency !== 1 || !roll) return;
  return globalThis.cat.utils.rollUtils.addToRoll(roll, "@prof", {rollData: actor.getRollData()});
}

function runeSaveDC(item, activityId) {
  const prepared = Number(itemActivity(item, activityId)?.save?.dc?.value);
  if (Number.isFinite(prepared) && prepared > 0) return prepared;
  const actor = item?.actor;
  return 8 + Number(actor?.system?.attributes?.prof ?? 0) + Number(actor?.system?.abilities?.con?.mod ?? 0);
}

function overTimeChange(value) {
  return {key: "flags.midi-qol.OverTime", value, priority: 20, type: "custom"};
}

function scopedTargetEffectIdentifier(base, item) {
  return `${base}-${item?.actor?.uuid ?? item?.actor?.id ?? item?.id ?? "source"}`;
}

async function applyFireShackles(item, target) {
  const dc = runeSaveDC(item, ACTIVITY.fireSave);
  const saveWorkflow = await rollTechnicalActivity(
    item,
    ACTIVITY.fireSave,
    RUNTIME_ACTIVITY.fireSave,
    [target]
  );
  if (!saveWorkflow || saveWorkflow.aborted) return;
  const failed = targetDocuments(saveWorkflow, "failedSaves").some(token => token.id === target.id);
  if (!failed) return;
  if (globalThis.cat.utils.actorUtils.checkTrait(target.actor, "ci", "restrained")) return;

  const effectIdentifier = scopedTargetEffectIdentifier("fire-rune-shackles", item);
  // Pulisce anche l'identificatore non-scoped delle versioni precedenti.
  await removeEffect(target.actor, "fire-rune-shackles");
  await removeEffect(target.actor, effectIdentifier);
  await globalThis.cat.utils.effectUtils.createEffects(target.actor, [effectData(item, effectIdentifier, {
    name: `${item.name}: Ceppi infuocati (${item.actor?.name ?? item.actor?.id ?? "Rune Knight"})`,
    duration: timedDuration(60),
    statuses: ["restrained"],
    changes: [
      overTimeChange("turn=start,allowIncapacitated=true,rollType=damage,damageRoll=2d6,damageType=fire,rollMode=public,label=Fire Rune"),
      overTimeChange(`turn=end,allowIncapacitated=true,rollType=save,saveAbility=str,saveDC=${dc},saveDamage=nodamage,saveCount=1-,rollMode=public,label=Fire Rune`)
    ],
    stackable: "multi",
    description: `<p>Restrained. Subisce 2d6 danni da fuoco all'inizio del turno e ripete un TS Forza CD ${dc} alla fine del turno, terminando l'effetto con un successo.</p>`
  })], {rules: RULES});
}

function isUnarmedAttack(workflow) {
  const labels = [identifier(workflow?.item), workflow?.item?.name].filter(Boolean).join(" ");
  return /(^|[\s-])unarmed([\s-]|$)|colpo[\s-]+senz/i.test(labels);
}

async function chooseHitTarget(title, item, workflow) {
  const targets = targetDocuments(workflow, "hitTargets");
  if (!targets.length) return null;
  if (targets.length === 1) return targets[0];
  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    title,
    `<p>Scegli il bersaglio di <strong>${escapeHtml(item.name)}</strong>.</p>`,
    targets,
    {type: "one", coverToken: tokenDocument(workflow.token), userId: ownerUserId(item)}
  );
  return selection?.result ?? null;
}

async function invokeFireRune({workflow, document}) {
  if (!workflow || !document) return;
  if (!globalThis.cat.utils.workflowUtils.isAttackType(workflow, "weaponAttack")) return;
  if (isUnarmedAttack(workflow)) return;
  if (!targetDocuments(workflow, "hitTargets").length || runeUsesRemaining(document) <= 0) return;

  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    "<p>Invocare la runa per aggiungere <strong>2d6 danni da fuoco</strong> e tentare di immobilizzare il bersaglio?</p>",
    {userId: ownerUserId(document)}
  );
  if (!confirmed) return;
  const target = await chooseHitTarget(document.name, document, workflow);
  if (!target) return;

  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) return notifyNoUses(document);
  try { await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, "2d6", {damageType: "fire"}); }
  catch (error) { await refundResources(useReceipt); throw error; }
  await applyFireShackles(document, target);
}

async function applyStoneRuneEffect(item, workflow) {
  const target = targetDocuments(workflow, "failedSaves")[0];
  if (!target) return;
  if (globalThis.cat.utils.actorUtils.checkTrait(target.actor, "ci", "charmed")) return;
  const dc = runeSaveDC(item, ACTIVITY.stone);
  const effectIdentifier = scopedTargetEffectIdentifier(IDS.stoneActive, item);
  // Pulisce anche l'identificatore non-scoped delle versioni precedenti.
  await removeEffect(target.actor, IDS.stoneActive);
  await removeEffect(target.actor, effectIdentifier);
  await globalThis.cat.utils.effectUtils.createEffects(target.actor, [effectData(item, effectIdentifier, {
    name: `${item.name}: Sguardo onirico (${item.actor?.name ?? item.actor?.id ?? "Rune Knight"})`,
    duration: timedDuration(60),
    statuses: ["charmed", "incapacitated"],
    changes: [
      {key: "system.attributes.movement.all", value: "0", priority: 20, type: "custom"},
      overTimeChange(`turn=end,allowIncapacitated=true,rollType=save,saveAbility=wis,saveDC=${dc},saveDamage=nodamage,saveCount=1-,rollMode=public,label=Stone Rune`)
    ],
    stackable: "multi",
    description: `<p>Charmed e incapacitated; velocità 0. Ripete un TS Saggezza CD ${dc} alla fine del turno.</p>`
  })], {rules: RULES});
}

async function triggerStoneRune({token, document, combat, round, turn}) {
  const target = tokenDocument(token);
  if (!target?.actor || !document?.actor) return;
  if (!["character", "npc"].includes(target.actor.type ?? "npc")) return;
  if (target.actor.statuses?.has("dead")) return;
  const ownerActor = document?.actor;
  const ownerToken = ownerTokenForTarget(ownerActor, target, 30);
  if (!ownerToken || target.actor.id === ownerActor.id) return;
  if (!globalThis.cat.utils.tokenUtils.isEnemy(ownerToken, target)) return;
  if (!canReact(ownerActor) || runeUsesRemaining(document) <= 0) return;
  if (globalThis.cat.utils.actorUtils.checkTrait(target.actor, "ci", "charmed")) return;
  if (!markStoneTurn({combat, round, turn, token: target, document})) return;

  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    `<p><strong>${escapeHtml(target.name)}</strong> ha terminato il turno entro 30 ft. Invocare Stone Rune?</p>`,
    {userId: ownerUserId(ownerActor)}
  );
  if (!confirmed) return;
  const reactionReceipt = await useReaction(ownerActor);
  if (!reactionReceipt) return;
  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) {
    await refundResources(reactionReceipt);
    return notifyNoUses(document);
  }

  try {
    const saveWorkflow = await rollTechnicalActivity(
      document,
      ACTIVITY.stone,
      RUNTIME_ACTIVITY.stone,
      [target]
    );
    if (!saveWorkflow || saveWorkflow.aborted) throw new Error("Il tiro salvezza di Stone Rune non è stato completato.");
    await applyStoneRuneEffect(document, saveWorkflow);
  } catch (error) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    await refundResources(reactionReceipt);
    console.error("Khuzoe Automations | Stone Rune non riuscita; uso e reazione ripristinati.", error);
    if (game.user.isGM || ownerActor.isOwner) ui.notifications.error("Stone Rune non riuscita: uso e reazione sono stati ripristinati.");
    markStoneTurn({combat, round, turn, token: target, document}, true);
    return false;
  }
}

function giantDamageDie(actor) {
  if (actorItem(actor, IDS.juggernaut)) return "1d10";
  if (actorItem(actor, IDS.stature)) return "1d8";
  return "1d6";
}

function combatContext(token) {
  const document = tokenDocument(token);
  return {
    token: document,
    tokenId: document?.id ?? "actor",
    data: document ? globalThis.cat.utils.tokenUtils.getCombatData(document) : {inCombat: false}
  };
}

async function giantBonusDamage({workflow, document, token}) {
  return withDocumentLock(document, "giantBonusDamage", async () => {
  if (!workflow || !document) return;
  if (!globalThis.cat.utils.workflowUtils.isAttackType(workflow, "weaponAttack")) return;
  if (!targetDocuments(workflow, "hitTargets").length) return;
  const context = combatContext(token ?? workflow.token);
  if (context.data.inCombat && !globalThis.cat.utils.combatUtils.isOwnTurn(context.token)) return;
  const ownerActor = document.parent ?? document.actor ?? workflow.actor;
  const stampId = ownerActor?.uuid ?? ownerActor?.id ?? context.tokenId;
  const stamps = document.flags?.[MODULE_ID]?.damageStamps ?? [];
  if (globalThis.cat.utils.combatUtils.isStampedThisTurn(stamps, stampId, context.data)) return;

  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name ?? "Giant's Might",
    `<p>Applicare <strong>${giantDamageDie(ownerActor)}</strong> danni extra di Giant's Might a questo attacco?</p>`,
    {userId: ownerUserId(ownerActor)}
  );
  if (!confirmed) return;

  await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, giantDamageDie(ownerActor), {
    damageType: workflow.defaultDamageType
  });
  if (context.data.inCombat) {
    const updated = globalThis.cat.utils.combatUtils.addTurnStamp(stamps, stampId, context.data);
    await updateDocumentSafely(document, {[`flags.${MODULE_ID}.damageStamps`]: updated});
  }
  });
}

function tokenDimensionsForSize(size) {
  return tokenSizeForCategory(size);
}

async function resizeActorTokens(actor, size) {
  const updates = values(actor?.getActiveTokens?.(false, true)).map(token => {
    const document = tokenDocument(token);
    return document ? updateDocumentSafely(document, tokenDimensionsForSize(size)) : null;
  }).filter(Boolean);
  await Promise.allSettled(updates);
}

async function activateGiantsMight({workflow, document}) {
  if (workflow?.activity?.id !== ACTIVITY.giant) return;
  const actor = document.actor;
  const currentSize = globalThis.cat.utils.actorUtils.getSize(actor);
  const config = giantsMightConfig(document);
  const targetSize = actorItem(actor, IDS.juggernaut) ? config.juggernautSize : config.baseSize;
  const targetIndex = SIZE_INDEX[targetSize];
  const changes = [];
  const canGrow = currentSize < targetIndex && await globalThis.cat.utils.dialogUtils.confirm(document.name,
    "C’è spazio sufficiente per raggiungere la taglia scelta senza attraversare muri o ostacoli?", {userId: ownerUserId(actor)});
  if (Number.isFinite(currentSize) && canGrow) {
    changes.push({key: "system.traits.size", value: targetSize, priority: 30, type: "override"});
  }
  const hasJuggernaut = Boolean(actorItem(actor, IDS.juggernaut));
  const effectiveSize = canGrow && Number.isFinite(targetIndex) ? Math.max(currentSize, targetIndex) : currentSize;
  if (hasJuggernaut && effectiveSize >= SIZE_INDEX.huge) {
    changes.push(
      {key: "flags.midi-qol.range.mwak", value: "5", priority: 20, type: "add"},
      {key: "flags.midi-qol.range.msak", value: "5", priority: 20, type: "add"}
    );
  }
  const existing = effectByIdentifier(actor, IDS.giantActive);
  const tokenSizes = existing?.flags?.[MODULE_ID]?.tokenSizes ?? values(actor?.getActiveTokens?.(false, true))
    .map(tokenDocument)
    .filter(tokenDoc => tokenDoc?.id)
    .map(tokenDoc => ({id: tokenDoc.id, uuid: tokenDoc.uuid, width: tokenDoc.width, height: tokenDoc.height}));
  try {
    const effect = await createUniqueEffect(document, IDS.giantActive, {
      duration: timedDuration(60),
      changes,
      description: `<p>Vantaggio alle prove e ai TS di Forza; un attacco con arma o colpo senz'armi per turno infligge ${giantDamageDie(actor)} danni extra.</p>`,
      moduleFlags: {tokenSizes, originalSize: actor.system?.traits?.size},
      macros: {
        roll: [{source: MODULE_ID, rules: RULES, identifier: IDS.giantActive}],
        check: [{source: MODULE_ID, rules: RULES, identifier: IDS.giantActive}],
        save: [{source: MODULE_ID, rules: RULES, identifier: IDS.giantActive}]
      }
    }, {replacementOptions: {khuzoeGiantsMightRefresh: true}});
    if (effect && changes.some(change => change.key === "system.traits.size")) await resizeActorTokens(actor, targetSize);
  } catch (error) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    throw error;
  }
}

function sizeChoiceContext(selected) {
  return SIZE_CHOICES.map(([value, label]) => ({value, label, selected: value === selected}));
}

export class GiantsMightConfig extends HandlebarsApplicationV2 {
  #item;

  constructor(item, options = {}) {
    super(options);
    this.#item = item;
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-giants-might-config",
    tag: "form",
    classes: ["khuzoe-automations", "khz-giants-might-config"],
    position: {width: 520, height: "auto"},
    window: {icon: "fa-solid fa-up-right-and-down-left-from-center", resizable: false},
    form: {closeOnSubmit: true, handler: GiantsMightConfig._onSubmit},
    actions: {resetDefaults: GiantsMightConfig._onResetDefaults}
  };

  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/giants-might-config.hbs`}
  };

  static _onSubmit(_event, form) { return this.#save(form); }

  static _onResetDefaults(event) {
    event?.preventDefault?.();
    const form = this.form ?? this.element?.querySelector?.("form") ?? this.element;
    const base = form?.querySelector?.('[name="baseSize"]');
    const juggernaut = form?.querySelector?.('[name="juggernautSize"]');
    if (base) base.value = GIANTS_MIGHT_DEFAULTS.baseSize;
    if (juggernaut) juggernaut.value = GIANTS_MIGHT_DEFAULTS.juggernautSize;
  }

  get title() { return `Giant's Might — ${this.#item?.actor?.name ?? "configurazione"}`; }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const config = giantsMightConfig(this.#item);
    return {
      ...context,
      itemName: this.#item?.name ?? "Giant's Might",
      actorName: this.#item?.actor?.name ?? "",
      baseSizes: sizeChoiceContext(config.baseSize),
      juggernautSizes: sizeChoiceContext(config.juggernautSize)
    };
  }

  async #save(form) {
    if (!this.#item?.isOwner && !game.user?.isGM) {
      throw new Error("Non hai il permesso di configurare questa capacità.");
    }
    const data = new FormData(form);
    const config = resolveGiantsMightConfig({
      baseSize: String(data.get("baseSize") ?? ""),
      juggernautSize: String(data.get("juggernautSize") ?? "")
    });
    await this.#item.setFlag(MODULE_ID, GIANTS_MIGHT_CONFIG_FLAG, config);
    ui.notifications.info(`Progressione di taglia salvata per ${this.#item.name}; sarà usata dalla prossima attivazione.`);
  }
}

function addGiantsMightHeaderControl(app, controls) {
  if (!Array.isArray(controls)) return;
  const item = app?.document?.documentName === "Item" ? app.document : null;
  if (!item?.actor || !item.isOwner || !isGiantsMightItem(item)) return;
  if (controls.some(control => control.action === "khuzoeConfigureGiantsMight")) return;
  controls.unshift({
    action: "khuzoeConfigureGiantsMight",
    label: "Configura Giant's Might",
    icon: "fa-solid fa-up-right-and-down-left-from-center",
    classes: "khuzoe-giants-might-configure",
    visible: true,
    onClick: () => new GiantsMightConfig(item).render({force: true})
  });
}

export function enhanceGiantsMightMedkit(app, section) {
  const actor = app?.document ?? app?.actor ?? app?.object;
  if (!section || actor?.documentName !== "Actor" || !actor.isOwner) return;
  if (section.querySelector('[data-khuzoe-action="giants-might-config"]')) return;
  const items = values(actor.items).filter(isGiantsMightItem);
  if (!items.length) return;

  const row = document.createElement("div");
  row.className = "khz-rune-knight-medkit-row";

  let select = null;
  if (items.length > 1) {
    select = document.createElement("select");
    select.dataset.tooltip = "Scegli quale capacità Giant's Might configurare";
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    row.append(select);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.khuzoeAction = "giants-might-config";
  button.dataset.tooltip = "Configura le taglie raggiunte da Giant's Might";
  button.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i> Configura Giant\'s Might';
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const item = select ? actor.items.get(select.value) : items[0];
    if (!item) return ui.notifications.warn("Capacità Giant's Might non disponibile.");
    new GiantsMightConfig(item).render({force: true});
  });
  row.append(button);
  section.append(row);
}

export function prepareRuneKnightItemUpdate(item, changes) {
  const updatedIdentifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID || !RUNE_KNIGHT_IDENTIFIERS.has(updatedIdentifier)) return;

  if (changes.system?.uses && item.system?.uses) {
    changes.system.uses.spent = Number(item.system.uses.spent ?? 0);
  }
  changes.img = item.img;

  if (updatedIdentifier !== IDS.giant) return;
  const stored = item?.getFlag?.(MODULE_ID, GIANTS_MIGHT_CONFIG_FLAG)
    ?? item?.flags?.[MODULE_ID]?.[GIANTS_MIGHT_CONFIG_FLAG];
  if (stored && typeof stored === "object") {
    foundry.utils.setProperty(
      changes,
      `flags.${MODULE_ID}.${GIANTS_MIGHT_CONFIG_FLAG}`,
      foundry.utils.deepClone(stored)
    );
  }
}

async function redirectCloudRune({workflow, document}) {
  if (!workflow?.attackRoll || targetDocuments(workflow, "hitTargets").length !== 1) return;
  const ownerActor = document.actor;
  const original = targetDocuments(workflow, "hitTargets")[0];
  const attacker = tokenDocument(workflow.token);
  const ownerToken = ownerTokenForTarget(ownerActor, original, 30);
  if (!ownerToken || !original || !attacker || !canReact(ownerActor) || runeUsesRemaining(document) <= 0) return;
  // Regola di campagna: Cloud Rune viene proposta soltanto quando la creatura
  // colpita ha disposizione Foundry Friendly. Il bersaglio della deviazione
  // resta invece libero, come nella capacità originale.
  if (!isFriendlyToken(original)) return;

  const candidates = values(ownerToken.parent?.tokens).filter(candidate => {
    if (!candidate.actor || candidate.hidden) return false;
    if ([attacker.id, original.id].includes(candidate.id)) return false;
    if (!within(ownerToken, candidate, 30)) return false;
    return !candidate.actor.statuses?.has("dead");
  });
  if (!candidates.length) return;
  if (!markObjectFeature(workflow, document, "cloud-rune")) return;

  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    document.name,
    `<p><strong>${escapeHtml(original.name)}</strong> è stato colpito. Scegli una creatura diversa a cui trasferire l'attacco, oppure annulla.</p>`,
    candidates,
    {type: "one", coverToken: ownerToken, userId: ownerUserId(ownerActor)}
  );
  const redirected = selection?.result;
  if (!redirected) return;

  const reactionReceipt = await useReaction(ownerActor);
  if (!reactionReceipt) return;
  const useReceipt = await consumeRuneUse(document);
  if (!useReceipt) {
    await refundResources(reactionReceipt);
    return notifyNoUses(document);
  }

  try {
    await rollTechnicalActivity(document, ACTIVITY.cloud, RUNTIME_ACTIVITY.cloud, [redirected]);
  } catch (error) {
    // La scheda tecnica è solo informativa: la deviazione dell'attacco deve
    // proseguire anche se la creazione del messaggio chat fallisce.
    console.warn("Khuzoe Automations | Scheda tecnica di Cloud Rune non creata.", error);
  }

  const oldNoReaction = workflow.workflowOptions?.noProvokeReaction;
  workflow.workflowOptions ??= {};
  workflow.workflowOptions.noProvokeReaction = true;
  try {
    await globalThis.cat.utils.workflowUtils.updateTargets(workflow, [redirected]);
    workflow.recordTargetACModifiers?.();
    await workflow.checkHits?.({noProvokeReaction: true});
  } finally {
    workflow.workflowOptions.noProvokeReaction = oldNoReaction;
  }
}

async function rerollAttack(workflow) {
  const original = workflow.attackRoll;
  let rerolled;
  if (original?.toJSON && original.constructor?.fromData) {
    const data = original.toJSON();
    const die = data.terms?.find(term => term.faces === 20);
    if (!die) return false;
    const oldResult = (die.results ?? []).filter(result => result.active !== false && !result.discarded)
      .reduce((sum, result) => sum + Number(result.result), 0);
    const fresh = await new Roll("1d20").evaluate();
    die.number = 1; die.modifiers = []; die.results = [{result: Number(fresh.total), active: true}];
    data.total = Number(original.total) - oldResult + Number(fresh.total);
    rerolled = original.constructor.fromData(data);
  } else rerolled = await original?.reroll?.();
  if (!rerolled) return false;
  const oldNoReaction = workflow.workflowOptions?.noProvokeReaction;
  workflow.workflowOptions ??= {};
  workflow.workflowOptions.noProvokeReaction = true;
  try {
    await workflow.setAttackRoll(rerolled);
    workflow.recordTargetACModifiers?.();
    await workflow.checkHits?.({noProvokeReaction: true});
  } finally {
    workflow.workflowOptions.noProvokeReaction = oldNoReaction;
  }
  return true;
}

async function useRunicShield({workflow, document}) {
  if (!workflow?.attackRoll || targetDocuments(workflow, "hitTargets").length !== 1) return;
  const ownerActor = document.actor;
  const protectedTarget = targetDocuments(workflow, "hitTargets")[0];
  const ownerToken = ownerTokenForTarget(ownerActor, protectedTarget, 60);
  if (!ownerToken || protectedTarget.actor.id === ownerActor.id) return;
  if (!canReact(ownerActor) || usesRemaining(document) <= 0) return;
  if (globalThis.cat.utils.tokenUtils.isEnemy(ownerToken, protectedTarget)) return;
  if (!markObjectFeature(workflow, document, "runic-shield")) return;

  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    `<p><strong>${escapeHtml(protectedTarget.name)}</strong> è stato colpito. Costringere l'attaccante a ripetere il d20?</p>`,
    {userId: ownerUserId(ownerActor)}
  );
  if (!confirmed) return;
  const reactionReceipt = await useReaction(ownerActor);
  if (!reactionReceipt) return;
  const useReceipt = await consumeUse(document);
  if (!useReceipt) {
    await refundResources(reactionReceipt);
    return notifyNoUses(document);
  }
  try {
    await rollTechnicalActivity(document, ACTIVITY.shield, RUNTIME_ACTIVITY.shield, [protectedTarget]);
  } catch (error) {
    console.warn("Khuzoe Automations | Scheda tecnica di Runic Shield non creata.", error);
  }
  if (!await rerollAttack(workflow)) {
    await refundUse(document, typeof useReceipt === "undefined" ? undefined : useReceipt);
    await refundResources(reactionReceipt);
    if (game.user.isGM || ownerActor.isOwner) ui.notifications.error("Runic Shield non ha potuto ripetere il tiro: uso e reazione sono stati ripristinati.");
  }
}

function stormOwnerContext(document, rollingToken) {
  const effect = document?.documentName === "ActiveEffect" ? document : null;
  const ownerActor = effect?.parent;
  const rolledToken = tokenDocument(rollingToken);
  if (!ownerActor || !rolledToken) return null;
  const ownerToken = ownerTokenForTarget(ownerActor, rolledToken, 60);
  if (!ownerToken || !rolledToken || !canReact(ownerActor)) return null;
  return {effect, ownerActor, ownerToken, rolledToken};
}

async function chooseStormInfluence(document, rollingToken, label, eventObject) {
  const context = stormOwnerContext(document, rollingToken);
  if (!context) return false;
  if (!markEventFeature(eventObject, document, "storm-rune")) return false;
  const result = await globalThis.cat.utils.dialogUtils.buttonDialog(
    "Storm Rune",
    `<p>Usare la reazione per influenzare ${escapeHtml(label)} di <strong>${escapeHtml(context.rolledToken.name)}</strong>?</p>`,
    [
      ["Vantaggio", "advantage", {image: "icons/svg/upgrade.svg"}],
      ["Svantaggio", "disadvantage", {image: "icons/svg/downgrade.svg"}],
      ["Non usare", false, {image: "icons/svg/cancel.svg"}]
    ],
    {displayAsRows: true, userId: ownerUserId(context.ownerActor)}
  );
  if (!result) return false;
  if (!await useReaction(context.ownerActor)) return false;
  return result;
}

async function stormAttack({workflow, document, token}) {
  if (!workflow?.activity?.attack) return;
  const choice = await chooseStormInfluence(document, token ?? workflow.token, "il tiro per colpire", workflow);
  if (choice === "advantage") workflow.advantage = true;
  if (choice === "disadvantage") workflow.disadvantage = true;
}

function stormD20(labelBuilder) {
  return async data => {
    if (!data?.document || !data?.token || !data?.options) return;
    const eventObject = data.config ?? data.options;
    const choice = await chooseStormInfluence(data.document, data.token, labelBuilder(data), eventObject);
    if (choice === "advantage") data.options.advantage = true;
    if (choice === "disadvantage") data.options.disadvantage = true;
  };
}

async function reconcileActorRuneUses(actor) {
  if (!actor || !game.user?.isGM) return;
  const maximum = String(runeMaximum(actor));
  const updates = values(actor.items).filter(item => item.flags?.cat?.automation?.source === MODULE_ID && [IDS.cloud, IDS.fire, IDS.frost, IDS.hill, IDS.stone, IDS.storm].includes(identifier(item))).map(item => {
    const spent = Math.min(Number(item.system.uses?.spent ?? 0), Number(maximum));
    if (String(item.system.uses?.max) === maximum && Number(item.system.uses?.spent ?? 0) === spent) return null;
    return {_id: item.id, "system.uses.max": maximum, "system.uses.spent": spent};
  }).filter(Boolean);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, {khuzoeRuneReconcile: true});
}

export function scheduleRuneUseReconciliation(actor) {
  if (!actor || !game.user?.isGM) return;
  globalThis.setTimeout(() => void reconcileActorRuneUses(actor), 0);
}

export async function reconcileAllRuneUses() {
  if (!game.user?.isGM) return;
  for (const actor of game.actors ?? []) await reconcileActorRuneUses(actor);
}

export async function restoreGiantsMightTokenSize(effect) {
  if (effect?.flags?.cat?.identifier !== IDS.giantActive || !effect.parent) return;
  const saved = effect.flags?.[MODULE_ID]?.tokenSizes ?? [];
  const tokens = values(effect.parent.getActiveTokens?.(false, true)).map(tokenDocument).filter(token => token?.id);
  const updates = tokens.map(token => {
    const original = saved.find(entry => (
      (entry.uuid && token.uuid && entry.uuid === token.uuid)
      || (!entry.uuid && entry.id === token.id)
    ));
    return updateDocumentSafely(token, original && (!effect.flags?.[MODULE_ID]?.originalSize || effect.parent.system.traits.size === effect.flags[MODULE_ID].originalSize)
      ? {width: original.width, height: original.height}
      : tokenDimensionsForSize(effect.parent.system.traits.size));
  }).filter(Boolean);
  await Promise.allSettled(updates);
}

export function registerRuneKnight(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.giant,
      roll: [{pass: "itemRollFinished", macro: activateGiantsMight, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.giantActive,
      roll: [{pass: "actorDamageRollBonuses", macro: giantBonusDamage, priority: 50}],
      check: [{pass: "actorSituational", macro: strengthAdvantage, priority: 50}],
      save: [{pass: "actorSituational", macro: strengthAdvantage, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.cloud,
      roll: [{pass: "sceneAttackRollComplete", macro: redirectCloudRune, priority: 150, canOverlap: true}],
      skill: [{pass: "actorSituational", macro: skillAdvantage(["dec", "slt"]), priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.fire,
      roll: [{pass: "actorDamageRollBonuses", macro: invokeFireRune, priority: 60}],
      tool: [{pass: "actorBonus", macro: fireToolExpertise, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.frost,
      roll: [
        {pass: "itemPreItemRoll", macro: validateRuneUse, priority: 10},
        {pass: "itemRollFinished", macro: activateFrostRune, priority: 50}
      ],
      skill: [{pass: "actorSituational", macro: skillAdvantage(["ani", "itm"]), priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.hill,
      roll: [
        {pass: "itemPreItemRoll", macro: validateRuneUse, priority: 10},
        {pass: "itemRollFinished", macro: activateHillRune, priority: 50}
      ],
      save: [{pass: "actorSituational", macro: hillPoisonAdvantage, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.stone,
      combat: [{pass: "sceneTurnEnd", macro: triggerStoneRune, priority: 50, canOverlap: true}],
      skill: [{pass: "actorSituational", macro: skillAdvantage(["ins"]), priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.storm,
      roll: [
        {pass: "itemPreItemRoll", macro: validateRuneUse, priority: 10},
        {pass: "itemRollFinished", macro: activateStormRune, priority: 50}
      ],
      skill: [{pass: "actorSituational", macro: skillAdvantage(["arc"]), priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.stormActive,
      roll: [{pass: "sceneAttackRollConfig", macro: stormAttack, priority: 50, canOverlap: true}],
      save: [{pass: "sceneSituational", macro: stormD20(data => `il TS di ${String(data.saveId ?? "").toUpperCase()}`), priority: 50, canOverlap: true}],
      check: [{pass: "sceneSituational", macro: stormD20(data => `la prova di ${String(data.checkId ?? "").toUpperCase()}`), priority: 50, canOverlap: true}],
      skill: [{pass: "sceneSituational", macro: stormD20(data => `la prova di ${CONFIG.DND5E.skills?.[data.skillId]?.label ?? data.skillId}`), priority: 50, canOverlap: true}],
      tool: [{pass: "sceneSituational", macro: stormD20(data => `la prova con ${CONFIG.DND5E.tools?.[data.toolId]?.label ?? data.toolId}`), priority: 50, canOverlap: true}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: IDS.shield,
      roll: [{pass: "sceneAttackRollComplete", macro: useRunicShield, priority: 160, canOverlap: true}]
    })
  ];

  const automations = RUNE_KNIGHT_AUTOMATIONS.map(data => api.registerAutomation(data));
  return {macros, automations};
}

Hooks.on("getHeaderControlsApplicationV2", addGiantsMightHeaderControl);
