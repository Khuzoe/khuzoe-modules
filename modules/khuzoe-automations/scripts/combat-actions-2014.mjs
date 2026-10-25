import {RELEASE_VERSION} from "./release.mjs";
import {slideTokenFeet} from "./movement-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {tokenDistanceFeet} from "./geometry.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const GRAPPLE_STATE = "grapple";
const SOURCE_EFFECT_IDENTIFIER = "khuzoe-grappling";
const TARGET_EFFECT_IDENTIFIER = "khuzoe-grappled";

export const GRAPPLE_IDENTIFIER = "grapple";
export const GRAPPLE_ESCAPE_IDENTIFIER = "grappleEscape";
export const SHOVE_IDENTIFIER = "shove";

export const GRAPPLE_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzGrapple140001";
export const GRAPPLE_ESCAPE_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzGrapEsc140001";
export const SHOVE_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzShoveAction01";

const SIZE_ORDER = Object.freeze(["tiny", "sm", "med", "lg", "huge", "grg"]);
const INCAPACITATED_STATUSES = new Set(["dead", "incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map || collection instanceof Set) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function tokenObject(token) {
  return token?.object ?? token;
}

function actorOf(token) {
  return tokenDocument(token)?.actor;
}

function itemIdentifier(item) {
  return item?.system?.identifier ?? item?.identifier;
}

function effectIdentifier(effect) {
  return effect?.flags?.cat?.identifier;
}

function grappleState(effect) {
  return effect?.flags?.[MODULE_ID]?.[GRAPPLE_STATE];
}

function isGrappleEffect(effect, role) {
  const state = grappleState(effect);
  return Boolean(state && (!role || state.role === role));
}

function actorEffects(actor, role) {
  return values(actor?.effects).filter(effect => isGrappleEffect(effect, role));
}

function actorItems(actor) {
  return values(actor?.items);
}

function hasConditionImmunity(actor, condition) {
  const checkTrait = globalThis.cat?.utils?.actorUtils?.checkTrait;
  if (typeof checkTrait === "function") return Boolean(checkTrait(actor, "ci", condition));
  return values(actor?.system?.traits?.ci?.value).includes(condition);
}

function isIncapacitated(actor) {
  const statuses = actor?.statuses;
  return values(statuses).some(status => INCAPACITATED_STATUSES.has(status));
}

export function canAffectBySize(sourceActor, targetActor) {
  const source = SIZE_ORDER.indexOf(sourceActor?.system?.traits?.size);
  const target = SIZE_ORDER.indexOf(targetActor?.system?.traits?.size);
  if (source < 0 || target < 0) return true;
  return target <= source + 1;
}

function sameScene(source, target) {
  source = tokenDocument(source);
  target = tokenDocument(target);
  return Boolean(source?.parent?.id && source.parent.id === target?.parent?.id);
}

function center(token) {
  token = tokenDocument(token);
  if (token?.object?.center) return token.object.center;
  const gridSize = Number(token?.parent?.grid?.size ?? globalThis.canvas?.grid?.size ?? 1);
  return {
    x: Number(token?.x ?? 0) + Number(token?.width ?? 1) * gridSize / 2,
    y: Number(token?.y ?? 0) + Number(token?.height ?? 1) * gridSize / 2
  };
}

function fallbackDistance(source, target) {
  source = tokenDocument(source);
  target = tokenDocument(target);
  const scene = source?.parent;
  const pixels = Math.hypot(center(source).x - center(target).x, center(source).y - center(target).y);
  const gridSize = Number(scene?.grid?.size ?? 1);
  const gridDistance = Number(scene?.grid?.distance ?? 5);
  const sourceRadius = Math.min(Number(source?.width ?? 1), Number(source?.height ?? 1)) * gridSize / 2;
  const targetRadius = Math.min(Number(target?.width ?? 1), Number(target?.height ?? 1)) * gridSize / 2;
  return Math.max(0, pixels - sourceRadius - targetRadius) * gridDistance / gridSize;
}

async function distanceBetween(source, target) {
  const getDistance = globalThis.cat?.utils?.tokenUtils?.getDistance;
  if (typeof getDistance === "function") {
    const distance = await getDistance(tokenDocument(source), tokenDocument(target), {wallsBlock: true});
    if (Number.isFinite(Number(distance))) return Number(distance);
  }
  return fallbackDistance(source, target);
}

function notify(message, type = "warn") {
  globalThis.ui?.notifications?.[type]?.(message);
}

function abort(workflow, message) {
  notify(message);
  if (workflow) workflow.aborted = true;
  return false;
}

async function validateTarget(workflow, item, {condition} = {}) {
  const source = tokenObject(workflow?.token);
  const targets = values(workflow?.targets);
  if (!source || targets.length !== 1) return abort(workflow, `${item?.name ?? "Azione"}: seleziona un solo bersaglio.`);

  const target = tokenObject(targets[0]);
  const sourceActor = actorOf(source);
  const targetActor = actorOf(target);
  if (!sourceActor || !targetActor) return abort(workflow, `${item?.name ?? "Azione"}: attore o bersaglio non disponibile.`);
  if (tokenDocument(source)?.uuid === tokenDocument(target)?.uuid) {
    return abort(workflow, `${item?.name ?? "Azione"}: non puoi scegliere te stesso.`);
  }
  if (!sameScene(source, target)) return abort(workflow, `${item?.name ?? "Azione"}: il bersaglio deve trovarsi nella stessa scena.`);
  if (isIncapacitated(sourceActor)) return abort(workflow, `${item?.name ?? "Azione"}: una creatura incapacitata non può usare questa azione.`);
  if (!canAffectBySize(sourceActor, targetActor)) {
    return abort(workflow, `${item?.name ?? "Azione"}: il bersaglio è più di una taglia più grande.`);
  }
  if (condition && hasConditionImmunity(targetActor, condition)) {
    return abort(workflow, `${target.name ?? targetActor.name} è immune alla condizione ${condition}.`);
  }
  const reach = grappleReach(sourceActor, item);
  if (await distanceBetween(source, target) > reach + 0.001) {
    return abort(workflow, `${item?.name ?? "Azione"}: il bersaglio deve essere entro ${reach} ft e raggiungibile.`);
  }
  return {source, target, sourceActor, targetActor};
}

function grappleReach(actor, item) {
  return Math.max(5, Number(item?.flags?.[MODULE_ID]?.grappleReach
    ?? actor?.flags?.[MODULE_ID]?.grappleReach ?? (5 + Number(actor?.flags?.["midi-qol"]?.range?.mwak ?? 0))));
}

function ownerUserId(document) {
  const firstOwner = globalThis.cat?.utils?.queryUtils?.firstOwner;
  return firstOwner?.(document, true) ?? globalThis.game?.user?.id;
}

async function chooseSkill(actor, title, prompt) {
  const buttons = [
    ["Atletica (FOR)", "ath", {image: "icons/skills/melee/unarmed-punch-fist-yellow-red.webp"}],
    ["Acrobazia (DES)", "acr", {image: "icons/skills/movement/figure-running-gray.webp"}]
  ];
  return globalThis.cat?.utils?.dialogUtils?.buttonDialog?.(
    title,
    prompt,
    buttons,
    {displayAsRows: true, userId: ownerUserId(actor)}
  );
}

async function contestedAthletics(source, target, targetSkill, item, {sourceSkill = "ath"} = {}) {
  const contestedRoll = globalThis.MidiQOL?.contestedRoll;
  if (typeof contestedRoll !== "function") throw new Error("Midi-QOL.contestedRoll non disponibile.");
  const result = await contestedRoll({
    source: {token: tokenObject(source), rollType: "skill", ability: sourceSkill, rollOptions: {}},
    target: {token: tokenObject(target), rollType: "skill", ability: targetSkill, rollOptions: {}},
    displayResults: true,
    itemCardUuid: item?.uuid,
    flavor: item?.name,
    rollOptions: {fastForward: false, chatMessage: true}
  });
  return result?.result;
}

function effectData({name, img, origin, identifier, role, source, target, reach, linkedEffectUuid, statuses = []}) {
  return {
    name,
    img,
    type: "base",
    system: {changes: []},
    disabled: false,
    duration: {value: null, units: "seconds", expired: false},
    origin,
    tint: "#ffffff",
    transfer: false,
    statuses,
    description: "",
    showIcon: 1,
    flags: {
      cat: {identifier},
      dae: {
        transfer: false,
        stackable: "noneNameOnly",
        specialDuration: [],
        expiryMode: "delete",
        disableIncapacitated: false
      },
      [MODULE_ID]: {
        [GRAPPLE_STATE]: {
          role,
          reach: reach ?? grappleReach(actorOf(source)),
          sourceTokenUuid: tokenDocument(source)?.uuid,
          targetTokenUuid: tokenDocument(target)?.uuid,
          linkedEffectUuid: linkedEffectUuid ?? null
        }
      }
    }
  };
}

async function createEffects(actor, datas) {
  return globalThis.cat?.utils?.effectUtils?.createEffects?.(actor, datas, {rules: RULES}) ?? [];
}

async function deleteDocumentSafely(document) {
  if (!document) return false;
  try {
    const current = document.uuid && globalThis.fromUuid ? await globalThis.fromUuid(document.uuid) : document;
    if (!current) return false;
    const remove = globalThis.cat?.utils?.documentUtils?.deleteDocument;
    if (typeof remove === "function") await remove(current);
    else await current.delete?.();
    return true;
  } catch (error) {
    if (!/does not exist/i.test(String(error?.message ?? error))) throw error;
    return false;
  }
}

async function ensureEscapeItem(actor) {
  if (actorItems(actor).some(item => itemIdentifier(item) === GRAPPLE_ESCAPE_IDENTIFIER
    && (
      item.flags?.[MODULE_ID]?.generatedGrappleEscape
      || item.flags?.cat?.automation?.source === MODULE_ID
    ))) return true;
  const source = await globalThis.fromUuid?.(GRAPPLE_ESCAPE_UUID);
  if (!source) throw new Error(`Sorgente ${GRAPPLE_ESCAPE_UUID} non disponibile.`);
  const data = source.toObject();
  delete data._id;
  delete data._key;
  data.flags ??= {};
  data.flags[MODULE_ID] = {...(data.flags[MODULE_ID] ?? {}), generatedGrappleEscape: true};
  await globalThis.cat.utils.documentUtils.createEmbeddedDocuments(actor, "Item", [data]);
  return true;
}

async function removeGeneratedEscapeItem(actor) {
  if (!actor || actorEffects(actor, "target").length) return false;
  const item = actorItems(actor).find(entry => entry.flags?.[MODULE_ID]?.generatedGrappleEscape);
  return deleteDocumentSafely(item);
}

async function resolveUuid(uuid) {
  if (!uuid || typeof globalThis.fromUuid !== "function") return null;
  try {
    return await globalThis.fromUuid(uuid);
  } catch (_error) {
    return null;
  }
}

async function releaseGrappleEffect(effect) {
  const state = grappleState(effect);
  if (!state) return false;
  const linked = await resolveUuid(state.linkedEffectUuid);
  // Eliminando per primo l'effetto sorgente lasciamo che la dipendenza Midi
  // rimuova il bersaglio. La seconda cancellazione e' solo un fallback e
  // verifica nuovamente l'UUID, quindi non genera richieste su documenti morti.
  if (state.role === "target" && linked) {
    const deleted = await deleteDocumentSafely(linked);
    await deleteDocumentSafely(effect);
    return deleted;
  }
  const deleted = await deleteDocumentSafely(effect);
  await deleteDocumentSafely(linked);
  return deleted;
}

async function releaseAllGrapplesForActor(actor) {
  for (const effect of actorEffects(actor)) await releaseGrappleEffect(effect);
}

async function applyGrapple(item, source, target) {
  const sourceActor = actorOf(source);
  const targetActor = actorOf(target);
  const existing = actorEffects(targetActor, "target").find(effect => {
    const state = grappleState(effect);
    return state?.sourceTokenUuid === tokenDocument(source)?.uuid;
  });
  if (existing) {
    notify(`${target.name ?? targetActor.name} è già afferrato da ${source.name ?? sourceActor.name}.`, "info");
    return true;
  }

  const [sourceEffect] = await createEffects(sourceActor, [effectData({
    name: `Afferrando ${target.name ?? targetActor.name}`,
    img: item.img,
    origin: item.uuid,
    identifier: SOURCE_EFFECT_IDENTIFIER,
    reach: grappleReach(sourceActor, item),
    role: "source",
    source,
    target
  })]);
  if (!sourceEffect) throw new Error("Creazione dell'effetto del grappler non riuscita.");

  try {
    const [targetEffect] = await createEffects(targetActor, [effectData({
      name: `Afferrato da ${source.name ?? sourceActor.name}`,
      img: item.img,
      origin: item.uuid,
      identifier: TARGET_EFFECT_IDENTIFIER,
      reach: grappleReach(sourceActor, item),
      role: "target",
      source,
      target,
      linkedEffectUuid: sourceEffect.uuid,
      statuses: ["grappled"]
    })]);
    if (!targetEffect) throw new Error("Creazione della condizione Grappled non riuscita.");

    await updateDocumentSafely(sourceEffect, {
      [`flags.${MODULE_ID}.${GRAPPLE_STATE}.linkedEffectUuid`]: targetEffect.uuid
    });
    await globalThis.cat?.utils?.documentUtils?.makeDependent?.(sourceEffect, [targetEffect]);
    await ensureEscapeItem(targetActor);
    return true;
  } catch (error) {
    await deleteDocumentSafely(sourceEffect);
    throw error;
  }
}

export async function useGrapple({workflow, item} = {}) {
  item ??= workflow?.item;
  if (!workflow || itemIdentifier(item) !== GRAPPLE_IDENTIFIER) return false;
  const context = await validateTarget(workflow, item, {condition: "grappled"});
  if (!context) return false;
  // Equipped does not identify the occupied hands in dnd5e. Ask the owner
  // instead of inferring a free hand from an unreliable equipment count.
  if (actorItems(context.sourceActor).some(entry => entry.system?.equipped
    && ["weapon", "equipment"].includes(entry.type))) {
    const freeHand = await globalThis.cat.utils.dialogUtils.confirm(item.name,
      "Hai almeno una mano libera con cui afferrare il bersaglio?", {userId: ownerUserId(context.sourceActor)});
    if (!freeHand) return abort(workflow, `${item.name}: serve una mano libera.`);
  }

  const targetSkill = await chooseSkill(
    context.targetActor,
    item.name,
    `<p><strong>${context.target.name ?? context.targetActor.name}</strong>: scegli come opporti al tentativo di afferrare.</p>`
  );
  if (!targetSkill) return abort(workflow, `${item.name}: prova annullata.`);

  const result = await contestedAthletics(context.source, context.target, targetSkill, item);
  if (!Number.isFinite(result)) return abort(workflow, `${item.name}: prova contrapposta annullata.`);
  if (result <= 0) {
    notify(`${item.name}: il difensore resiste al tentativo.`, "info");
    return false;
  }

  await applyGrapple(item, context.source, context.target);
  return true;
}

async function chooseGrappler(item, target, effects) {
  const choices = [];
  for (const effect of effects) {
    const source = await resolveUuid(grappleState(effect)?.sourceTokenUuid);
    if (!source) continue;
    choices.push({effect, source});
  }
  if (!choices.length) return null;
  if (choices.length === 1) return choices[0];

  const selected = await globalThis.cat?.utils?.dialogUtils?.buttonDialog?.(
    item.name,
    "Scegli da quale creatura tentare di liberarti.",
    choices.map(choice => [
      choice.source.name ?? choice.source.actor?.name ?? "Creatura",
      choice.effect.uuid,
      {image: choice.source.texture?.src ?? choice.source.actor?.img}
    ]),
    {displayAsRows: true, userId: ownerUserId(actorOf(target))}
  );
  return choices.find(choice => choice.effect.uuid === selected) ?? null;
}

export async function useGrappleEscape({workflow, item} = {}) {
  item ??= workflow?.item;
  if (!workflow || itemIdentifier(item) !== GRAPPLE_ESCAPE_IDENTIFIER) return false;
  const target = tokenObject(workflow.token);
  const targetActor = actorOf(target) ?? item?.actor;
  const effects = actorEffects(targetActor, "target");
  if (!target || !effects.length) {
    await removeGeneratedEscapeItem(targetActor);
    return abort(workflow, `${item.name}: la creatura non è afferrata.`);
  }

  const choice = await chooseGrappler(item, target, effects);
  if (!choice) return abort(workflow, `${item.name}: nessun grappler disponibile.`);
  const source = tokenObject(choice.source);
  const skill = await chooseSkill(targetActor, item.name, "Scegli Atletica o Acrobazia per tentare la fuga.");
  if (!skill) return abort(workflow, `${item.name}: prova annullata.`);

  const result = await contestedAthletics(target, source, "ath", item, {sourceSkill: skill});
  if (!Number.isFinite(result)) return abort(workflow, `${item.name}: prova contrapposta annullata.`);
  if (result <= 0) {
    notify(`${item.name}: il tentativo di fuga non riesce.`, "info");
    return false;
  }

  await releaseGrappleEffect(choice.effect);
  await removeGeneratedEscapeItem(targetActor);
  return true;
}

export async function useShove({workflow, item} = {}) {
  item ??= workflow?.item;
  if (!workflow || itemIdentifier(item) !== SHOVE_IDENTIFIER) return false;
  const context = await validateTarget(workflow, item);
  if (!context) return false;

  const targetSkill = await chooseSkill(
    context.targetActor,
    item.name,
    `<p><strong>${context.target.name ?? context.targetActor.name}</strong>: scegli come opporti alla spinta.</p>`
  );
  if (!targetSkill) return abort(workflow, `${item.name}: prova annullata.`);

  const result = await contestedAthletics(context.source, context.target, targetSkill, item);
  if (!Number.isFinite(result)) return abort(workflow, `${item.name}: prova contrapposta annullata.`);
  if (result <= 0) {
    notify(`${item.name}: il difensore resiste al tentativo.`, "info");
    return false;
  }

  const proneAllowed = !hasConditionImmunity(context.targetActor, "prone")
    && !values(context.targetActor.statuses).includes("prone");
  const buttons = [["Spingi di 5 ft", "push", {image: "icons/skills/movement/arrow-right-white.webp"}]];
  if (proneAllowed) buttons.push(["Butta a terra", "prone", {image: "icons/svg/falling.svg"}]);
  const choice = proneAllowed
    ? await globalThis.cat?.utils?.dialogUtils?.buttonDialog?.(
      item.name,
      "Scegli l'esito della spinta riuscita.",
      buttons,
      {displayAsRows: true, userId: ownerUserId(context.sourceActor)}
    )
    : "push";
  if (!choice) return abort(workflow, `${item.name}: scelta annullata.`);

  if (choice === "prone") {
    await globalThis.cat?.utils?.actorUtils?.applyConditions?.(context.targetActor, ["prone"]);
    return true;
  }

  await slideTokenFeet(tokenDocument(context.target), {
    sourceToken: tokenDocument(context.source),
    distance: 5,
    action: "catForce"
  });
  await cleanupSeparatedGrapples(tokenDocument(context.target));
  return true;
}

export async function cleanupSeparatedGrapples(token, {deleted = false} = {}) {
  const actor = token?.actor;
  if (!actor) return;
  for (const effect of actorEffects(actor)) {
    const state = grappleState(effect);
    if (![state.sourceTokenUuid, state.targetTokenUuid].includes(token.uuid)) continue;
    const source = await resolveUuid(state.sourceTokenUuid);
    const target = await resolveUuid(state.targetTokenUuid);
    if (deleted || !source || !target || !sameScene(source, target)
      || tokenDistanceFeet(source, target) > Number(state.reach ?? grappleReach(source.actor)) + 0.001) {
      await releaseGrappleEffect(effect);
    }
  }
}

export function prepareCombatActionItemUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? itemIdentifier(item);
  if (![GRAPPLE_IDENTIFIER, GRAPPLE_ESCAPE_IDENTIFIER, SHOVE_IDENTIFIER].includes(identifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
}

/**
 * Mantiene simmetrici i due effetti senza inviare delete su UUID già rimossi.
 * Il ritardo lascia completare prima la cancellazione (ed eventuali dipendenze)
 * avviata da Foundry/Midi.
 */
export function cleanupDeletedGrappleEffect(effect) {
  const state = grappleState(effect);
  if (!state) return false;
  globalThis.setTimeout?.(async () => {
    const linked = await resolveUuid(state.linkedEffectUuid);
    await deleteDocumentSafely(linked);
    if (state.role === "target") await removeGeneratedEscapeItem(effect?.parent?.actor ?? effect?.parent);
  }, 50);
  return true;
}

/** Il grapple 2014 termina immediatamente se il grappler è incapacitato. */
export function cleanupGrapplesIfIncapacitated(actor) {
  if (!actor) return false;
  globalThis.setTimeout?.(async () => {
    if (!isIncapacitated(actor)) return;
    for (const effect of actorEffects(actor, "source")) await releaseGrappleEffect(effect);
  }, 50);
  return true;
}

export const COMBAT_ACTION_AUTOMATIONS = Object.freeze([
  {
    source: MODULE_ID,
    rules: RULES,
    identifier: GRAPPLE_IDENTIFIER,
    version: VERSION,
    uuid: GRAPPLE_UUID,
    type: "feat",
    notes: "Azione Grapple 2014: distanza e taglia, prova Atletica contro Atletica/Acrobazia scelta dal difensore, effetti collegati e azione di fuga automatica."
  },
  {
    source: MODULE_ID,
    rules: RULES,
    identifier: GRAPPLE_ESCAPE_IDENTIFIER,
    version: VERSION,
    uuid: GRAPPLE_ESCAPE_UUID,
    type: "feat",
    notes: "Azione tecnica aggiunta automaticamente alle creature afferrate; gestisce anche più grappler e viene rimossa quando non serve più."
  },
  {
    source: MODULE_ID,
    rules: RULES,
    identifier: SHOVE_IDENTIFIER,
    version: VERSION,
    uuid: SHOVE_UUID,
    type: "feat",
    notes: "Azione Shove 2014: prova contrapposta, scelta tra prone e spinta di 5 ft, collisioni e muri gestiti da CAT."
  }
]);

export function registerCombatActions2014(api) {
  const callbacks = new Map([
    [GRAPPLE_IDENTIFIER, useGrapple],
    [GRAPPLE_ESCAPE_IDENTIFIER, useGrappleEscape],
    [SHOVE_IDENTIFIER, useShove]
  ]);
  const macros = COMBAT_ACTION_AUTOMATIONS.map(automation => api.registerFnMacro({
    source: MODULE_ID,
    rules: RULES,
    identifier: automation.identifier,
    roll: [{pass: "itemRollFinished", macro: callbacks.get(automation.identifier), priority: 50}]
  }));
  const automations = COMBAT_ACTION_AUTOMATIONS.map(automation => api.registerAutomation(automation));
  return {macros, automations};
}
