import {adjustAppliedDamage, appliedDamageAmount} from "./damage-adjustment.mjs";
import {runSyntheticActivityData, runSyntheticActivity} from "./activity-compat.mjs";
import {combatTurnKey, isCombatExecutor} from "./combat-events.mjs";
import {distanceInScene, nearbyTokens, slideTokenFeet, teleportTokenFeet} from "./movement-compat.mjs";
import {
  EXPANDED_SPELL_CATALOG,
  EXPANDED_SPELL_VERSION
} from "./expanded-spell-catalog.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {FOLLOW_UP_ACTIVITIES} from "./pack-normalization.mjs";
import {weaponCantripAttack} from "./weapon-cantrips.mjs";
import {tokenSizeForCategory, circularAuraTokenDistance} from "./geometry.mjs";
import {isAuraCreature} from "./aura-targeting.mjs";
import {grantTemporaryHP, removeOwnedTemporaryHP} from "./temporary-hp.mjs";
import {createSpellArea} from "./persistent-spell-areas.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {healActor} from "./healing.mjs";
import {normalizeSpellOvertime} from "./spell-overtime.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const PACK = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item";
const EFFECT_HANDLER = "khuzoe-expanded-spell-effect";
const EFFECT_FLAG = "expandedSpell";

const AURA_SPELLS = new Set(["aura-of-purity", "crusaders-mantle", "pass-without-trace"]);
const SMITE_SPELLS = new Set([
  "blinding-smite", "branding-smite", "hail-of-thorns", "lightning-arrow", "searing-smite",
  "staggering-smite", "thunderous-smite", "wrathful-smite"
]);
const SIMPLE_NATIVE_SPELLS = new Set([
  "blade-ward", "burning-hands", "charm-person", "fly", "frost-fingers", "gaseous-form",
  "guiding-bolt", "hold-person", "mass-cure-wounds", "mind-sliver", "raulothims-psychic-lance",
  "sapping-sting", "skill-empowerment", "spray-of-cards", "synaptic-static", "tashas-caustic-brew",
  "tidal-wave", "vitriolic-sphere"
]);

export const EXPANDED_SPELL_AUTOMATIONS = Object.freeze(EXPANDED_SPELL_CATALOG.map(entry => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: entry.identifier,
  version: EXPANDED_SPELL_VERSION,
  uuid: `${PACK}.${entry.id}`,
  type: "spell",
  notes: `Automazione Khuzoe 2014 per ${entry.name}; attività, effetti, scaling e regole speciali sono predisposti per Foundry v14.`
})));

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  if (typeof collection === "object" && !collection[Symbol.iterator]) return Object.values(collection);
  return Array.from(collection);
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function targetDocuments(workflow, key = "targets") {
  return values(workflow?.[key]).map(tokenDocument).filter(token => token?.actor);
}

function actorToken(actor) {
  return globalThis.cat.utils.actorUtils.getFirstToken(actor);
}

function itemDocument({workflow, document, item} = {}) {
  if (document?.documentName === "Item") return document;
  return item ?? workflow?.item;
}

function spellIdentifier(context = {}) {
  return itemDocument(context)?.system?.identifier ?? context.workflow?.item?.system?.identifier;
}

function activityMap(item) {
  return item?.flags?.[MODULE_ID]?.activityIdentifiers ?? {};
}

function activityByKey(item, key) {
  const id = activityMap(item)[key];
  if (id) return item?.system?.activities?.get?.(id) ?? values(item?.system?.activities).find(activity => activity.id === id || activity._id === id);
  return values(item?.system?.activities).find(activity =>
    activity?.midiProperties?.identifier === key
    || activity?.identifier === key
    || activity?.name?.slugify?.() === String(key).slugify?.()
  );
}

function activityKey(workflow, item) {
  const id = workflow?.activity?.id ?? workflow?.activity?._id;
  return Object.entries(activityMap(item)).find(([, activityId]) => activityId === id)?.[0] ?? "";
}

function castLevel(workflow) {
  const value = Number(
    workflow?.castData?.castLevel
    ?? workflow?.workflowOptions?.castData?.castLevel
    ?? workflow?.activity?.flags?.cat?.castData?.castLevel
    ?? workflow?.item?.system?.level
    ?? 1
  );
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}

function actorLevel(actor, spell) {
  const native = actor?.system?.cantripLevel?.(spell);
  if (Number.isFinite(native) && native >= 0) return native;
  const direct = Number(actor?.system?.details?.level ?? actor?.system?.details?.cr ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const classes = values(actor?.classes).reduce((total, item) => total + Number(item?.system?.levels ?? 0), 0);
  return Number.isFinite(classes) ? classes : 0;
}

function effectDuration(item, seconds) {
  if (!seconds) {
    const value = Number(item?.system?.duration?.value ?? 0);
    const factor = {round: 6, turn: 6, minute: 60, hour: 3600, day: 86400}[item?.system?.duration?.units];
    seconds = Number.isFinite(value) && factor ? value * factor : 60;
  }
  return {value: seconds, units: "seconds", expiry: "turnStart", expired: false};
}

function effectReference() {
  return {source: MODULE_ID, rules: RULES, identifier: EFFECT_HANDLER};
}

function macroFlags(groups = ["roll", "combat", "effect", "save", "check"]) {
  const reference = effectReference();
  return Object.fromEntries(groups.map(group => [group, [reference]]));
}

function effectState(effect) {
  return effect?.flags?.[MODULE_ID]?.[EFFECT_FLAG] ?? {};
}

function effectByState(actor, identifier, predicate = () => true) {
  return values(actor?.effects).find(effect => {
    const state = effectState(effect);
    return state.identifier === identifier && predicate(state, effect);
  });
}

function changes(...entries) {
  return entries.flat().filter(Boolean).map(entry => ({priority: 20, type: "add", ...entry}));
}

async function removeEffect(effect) {
  if (!effect) return;
  try {
    await globalThis.cat.utils.documentUtils.deleteDocument(effect);
  } catch (error) {
    // Effetti dipendenti e movimento possono arrivare nello stesso tick. Se
    // un altro evento ha già concluso la cancellazione, lo stato è corretto.
    if (!/ActiveEffect .* does not exist/i.test(String(error?.message ?? error))) throw error;
  }
}

async function createEffect(actor, item, {
  name = item?.name,
  img = item?.img,
  identifier,
  state = {},
  effectChanges = [],
  statuses = [],
  seconds,
  concentrationItem,
  showIcon = 1,
  specialDuration = [],
  unhideActivities = [],
  activity,
  macroGroups,
  replace = true
} = {}) {
  if (!actor || !item) return [];
  const stateIdentifier = identifier ?? item.system?.identifier;
  if (replace) {
    const existing = effectByState(actor, stateIdentifier, current => current.kind === state.kind);
    if (existing) await removeEffect(existing);
  }
  const data = {
    name,
    img,
    origin: item.uuid,
    type: "base",
    system: {changes: effectChanges},
    duration: effectDuration(item, seconds),
    transfer: false,
    statuses,
    showIcon,
    flags: {
      [MODULE_ID]: {[EFFECT_FLAG]: {identifier: stateIdentifier, ...state}},
      cat: {identifier: EFFECT_HANDLER, macros: macroFlags(macroGroups),
        activityUuid: activity?.uuid ?? values(item.system?.activities).find(a => !a.midiProperties?.automationOnly && !a.flags?.cat?.hidden)?.uuid},
      dae: {transfer: false, stackable: replace ? "noneNameOnly" : "multi", expiryMode: "delete", specialDuration},
      "midi-qol": {forceCEOff: true}
    }
  };
  const created = await globalThis.cat.utils.effectUtils.createEffects(actor, [data], {
    rules: RULES,
    unhideActivities: unhideActivities.map(id => {
      const candidate = values(item.system?.activities).find(a => (a.id ?? a._id) === id);
      return candidate?.identifier ?? candidate?.midiProperties?.identifier ?? id;
    })
  });
  if (created?.length && concentrationItem) {
    const concentration = globalThis.cat.utils.effectUtils.getConcentrationEffect(actor === concentrationItem.actor ? actor : concentrationItem.actor, concentrationItem);
    if (concentration) await globalThis.cat.utils.documentUtils.makeDependent(concentration, created);
  }
  return created ?? [];
}

async function createTargetEffects(workflow, item, options) {
  const created = [];
  for (const token of targetDocuments(workflow, options.failedOnly ? "failedSaves" : "targets")) {
    created.push(...await createEffect(token.actor, item, {...options, concentrationItem: item}));
  }
  return created;
}

async function chooseButtons(title, prompt, options, dialogOptions = {}) {
  return globalThis.cat.utils.dialogUtils.buttonDialog(
    title,
    prompt,
    options.map(option => [option.label, option.value, option.options]),
    dialogOptions
  );
}

async function chooseDamageType(item, types) {
  const options = types.map(type => ({
    value: type,
    label: CONFIG.DND5E.damageTypes?.[type]?.label ?? type
  }));
  return chooseButtons(item.name, "Scegli il tipo di danno.", options);
}

async function chooseSkill(item, actor, predicate) {
  const skills = Object.entries(CONFIG.DND5E.skills ?? {})
    .filter(([key]) => predicate(Number(actor?.system?.skills?.[key]?.value ?? 0)))
    .map(([value, data]) => ({label: data.label ?? value.toUpperCase(), value}));
  if (!skills.length) return null;
  return chooseButtons(item.name, "Scegli l'abilità.", skills);
}

function firstHit(workflow) {
  return targetDocuments(workflow, "hitTargets")[0] ?? targetDocuments(workflow, "hitTargetsEC")[0];
}

function hasHit(workflow) {
  return Boolean(firstHit(workflow));
}

function isWeaponAttack(workflow, {melee, ranged} = {}) {
  const actionType = workflow?.activity?.getActionType?.(workflow.attackMode) ?? workflow?.activity?.actionType ?? workflow?.activity?.attack?.type?.value;
  if (melee) return actionType === "mwak";
  if (ranged) return actionType === "rwak";
  return ["mwak", "rwak"].includes(actionType) || globalThis.cat.utils.workflowUtils.isAttackType?.(workflow, "weaponAttack");
}

function isMeleeAttack(workflow) {
  const actionType = workflow?.activity?.getActionType?.(workflow.attackMode) ?? workflow?.activity?.actionType ?? workflow?.activity?.attack?.type?.value;
  return ["mwak", "msak"].includes(actionType)
    || globalThis.cat.utils.workflowUtils.isAttackType?.(workflow, "meleeAttack");
}

function workflowAttackAbility(workflow) {
  return [
    workflow?.attackRoll?.options?.ability,
    workflow?.rollOptions?.ability,
    workflow?.activity?.attack?.ability,
    workflow?.activity?.ability
  ].map(value => String(value ?? "").trim()).find(Boolean) ?? "";
}

function sameTokenReference(reference, token) {
  token = tokenDocument(token);
  if (!reference || !token) return false;
  if (typeof reference === "string") return reference === token.uuid || reference === token.id;
  reference = tokenDocument(reference);
  if (!reference) return false;
  if (reference.uuid && token.uuid) return reference.uuid === token.uuid;
  return Boolean(reference.id && token.id && reference.id === token.id && reference.parent?.id === token.parent?.id);
}

function totalDamage(workflow) {
  const direct = Number(workflow?.damageTotal ?? workflow?.damageRoll?.total);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  return values(workflow?.damageRolls).reduce((sum, roll) => sum + Math.max(0, Number(roll?.total ?? 0)), 0);
}

async function bonusDamage(workflow, formula, damageType) {
  return globalThis.cat.utils.workflowUtils.bonusDamage(workflow, formula, {damageType});
}

async function syntheticActivity(activity, targets, options = {}) {
  if (!activity) return null;
  return runSyntheticActivity(activity, targets, {
    ...options,
    options: {
      ...(options.options ?? {}),
      workflowOptions: {targetConfirmation: "none", ...(options.options?.workflowOptions ?? {})}
    }
  });
}

async function applyCondition(actor, condition) {
  return globalThis.cat.utils.actorUtils.applyConditions(actor, [condition]);
}

async function teleport(token, range) {
  if (token) return teleportTokenFeet(token, {range});
}

async function teleportFromSource(target, source, range) {
  target = tokenDocument(target);
  source = tokenDocument(source);
  if (!target || !source) return;
  const destination = await globalThis.cat.utils.crosshairUtils.aimCrosshair({token: source, maxRange: distanceInScene(range, source)});
  if (!destination || destination.cancelled) return;
  return teleportTokenFeet(target, {destination, range});
}

async function slide(target, source, distance, toward = false) {
  target = tokenDocument(target);
  source = tokenDocument(source);
  if (!target || !source) return;
  let ray;
  if (toward && globalThis.Ray) {
    const from = target.object?.center ?? target.center ?? {x: target.x, y: target.y};
    const to = source.object?.center ?? source.center ?? {x: source.x, y: source.y};
    ray = new Ray(from, to);
  }
  return slideTokenFeet(target, toward ? {ray, distance} : {sourceToken: source, distance});
}

async function createAuraSource(workflow, item, identifier) {
  return createEffect(item.actor ?? workflow.actor, item, {
    identifier,
    state: {kind: "aura", aura: identifier},
    concentrationItem: item,
    macroGroups: ["aura"],
    showIcon: 1
  });
}

export async function createExpandedAuraTarget({document, token}) {
  const sourceState = effectState(document);
  const target = tokenDocument(token);
  if (!document || !target?.actor || !sourceState.aura) return;
  let effectChanges = [];
  if (sourceState.aura === "aura-of-purity") {
    effectChanges = changes(
      {key: "system.traits.ci.value", value: "diseased"},
      {key: "system.traits.dr.value", value: "poison"},
      ["blinded", "charmed", "deafened", "frightened", "paralyzed", "poisoned", "stunned"]
        .map(condition => ({key: `flags.cat.CR.${condition}`, value: "1", type: "override"}))
    );
  } else if (sourceState.aura === "crusaders-mantle") {
    effectChanges = changes(
      {key: "system.bonuses.mwak.damage", value: "1d4[radiant]"},
      {key: "system.bonuses.rwak.damage", value: "1d4[radiant]"}
    );
  } else if (sourceState.aura === "pass-without-trace") {
    effectChanges = changes({key: "system.skills.ste.bonuses.check", value: "10"});
  }
  const effectData = {
    name: document.name,
    img: document.img,
    type: "base",
    system: {changes: effectChanges},
    duration: {value: Math.max(1, Number(document.duration?.remaining ?? 60)), units: "seconds", expiry: "turnStart", expired: false},
    showIcon: sourceState.aura !== "pass-without-trace" ? 1 : 0,
    flags: {
      [MODULE_ID]: {[EFFECT_FLAG]: {identifier: sourceState.aura, kind: "aura-target", source: document.uuid}},
      dae: {stackable: "noneNameOnly", expiryMode: "delete", specialDuration: []}
    }
  };
  // CAT gestisce creazione, deduplicazione e rimozione quando il bersaglio
  // entra/esce dal raggio. Restituire effectData è fondamentale: creando qui
  // l'effetto a mano non riceverebbe il marcatore auraEffect e resterebbe
  // sull'attore dopo l'uscita dall'aura.
  return {effectData};
}

export function createSpiritShroudSlow({document, token}) {
  const state = effectState(document);
  const target = tokenDocument(token);
  if (!document || !target?.actor) return;
  if (state.identifier !== "spirit-shroud" || state.kind !== "self-buff") return;
  return {
    effectData: {
      name: `${document.name}: rallentato`,
      img: document.img,
      type: "base",
      system: {changes: changes({key: "system.attributes.movement.all", value: "-10"})},
      duration: {value: 6, units: "seconds", expiry: "turnStart", expired: false},
      showIcon: 0,
      flags: {
        [MODULE_ID]: {[EFFECT_FLAG]: {identifier: "spirit-shroud-slow", kind: "aura-target", source: document.uuid}},
        dae: {stackable: "noneNameOnly", expiryMode: "delete", specialDuration: []}
      }
    }
  };
}

function replaceWorkflowActivity(workflow, mutate) {
  if (!workflow?.activity || !workflow?.item) return false;
  const activityData = workflow.activity.toObject?.() ?? structuredClone(workflow.activity);
  mutate(activityData);
  const itemData = workflow.item.toObject?.() ?? structuredClone(workflow.item);
  itemData.system.activities[workflow.activity.id] = activityData;
  const synthetic = globalThis.cat.utils.itemUtils.syntheticItem?.(itemData, workflow.actor);
  if (!synthetic) return false;
  workflow.item = synthetic;
  workflow.activity = synthetic.system.activities.get(workflow.activity.id);
  return true;
}

async function updateWorkflowTargets(workflow, targets) {
  const current = targetDocuments(workflow);
  const next = targets.map(tokenDocument).filter(token => token?.actor);
  if (current.length === next.length && current.every(token => next.some(candidate => sameTokenReference(token, candidate)))) return;
  await globalThis.cat.utils.workflowUtils.updateTargets(workflow, next);
}

function creatureType(actor) {
  return String(globalThis.cat.utils.actorUtils.typeOrRace(actor) ?? actor?.system?.details?.type?.value ?? "").toLowerCase();
}

function isHumanoidActor(actor) {
  // I personaggi giocanti non espongono sempre "humanoid" tramite typeOrRace:
  // in quel caso CAT restituisce spesso la razza. Per Hold Person restano
  // comunque umanoidi, mentre per gli NPC fa testo il tipo creatura.
  const declared = actor?.system?.details?.type?.value;
  return String(declared || creatureType(actor)).toLowerCase() === "humanoid";
}

async function removeConcentrationIfNoFailedSave(workflow, item) {
  if (targetDocuments(workflow, "failedSaves").length) return false;
  const concentration = globalThis.cat.utils.effectUtils.getConcentrationEffect(workflow.actor, item);
  if (concentration) await removeEffect(concentration);
  return true;
}

async function prepareVoluntaryConstitutionFailure(workflow, item, identifier) {
  const target = targetDocuments(workflow)[0];
  if (!target?.actor) return;
  const owner = globalThis.MidiQOL?.playerForActor?.(target.actor);
  const choice = await chooseButtons(
    item.name,
    `<strong>${target.name ?? target.actor.name}</strong>: vuoi accettare volontariamente l'incantesimo o tentare il tiro salvezza su Costituzione?`,
    [
      {label: "Accetta (nessun TS)", value: "accept"},
      {label: "Resisti (tira il TS)", value: "resist"}
    ],
    {userId: owner?.id ?? globalThis.game?.user?.id}
  );
  if (choice !== "accept") return;
  await createEffect(target.actor, item, {
    name: `${item.name} — Consenziente`,
    identifier: `${identifier}-consent`,
    state: {kind: "voluntary-fail", workflowId: workflow.id ?? workflow.uuid ?? ""},
    effectChanges: changes({
      key: "flags.midi-qol.fail.ability.save.con",
      value: "1",
      type: "override"
    }),
    seconds: 6,
    showIcon: 0,
    specialDuration: ["isSave"],
    macroGroups: []
  });
}

async function forceNextSaveFailure(target, item, identifier, ability) {
  if (!target?.actor) return;
  await createEffect(target.actor, item, {
    name: `${item.name} — Fallimento automatico`,
    identifier: `${identifier}-automatic-failure`,
    state: {kind: "automatic-failure"},
    effectChanges: changes({
      key: `flags.midi-qol.fail.ability.save.${ability}`,
      value: "1",
      type: "override"
    }),
    seconds: 6,
    showIcon: 0,
    specialDuration: ["isSave"],
    macroGroups: []
  });
}

export async function prepareExpandedSpell(context = {}) {
  const {workflow} = context;
  const item = itemDocument(context);
  const identifier = spellIdentifier(context);
  if (!workflow || !item) return;

  const followUp = activityKey(workflow, item);
  if (FOLLOW_UP_ACTIVITIES.has(followUp) && !workflow.workflowOptions?.khuzoeInternalActivity) {
    const source = effectByState(workflow.actor, identifier);
    if (!source || source.disabled || source.isSuppressed || source.duration?.expired) {
      ui.notifications.warn(`${item.name}: l'incantesimo non è attivo.`);
      workflow.aborted = true;
      return true;
    }
    if (["hexMove", "huntersMarkMove"].includes(followUp)) {
      const previous = await globalThis.fromUuid?.(effectState(source).targetUuid);
      if (previous?.actor && Number(previous.actor.system?.attributes?.hp?.value ?? 0) > 0) {
        ui.notifications.warn(`${item.name}: il bersaglio precedente non è a 0 PF.`);
        workflow.aborted = true;
        return true;
      }
    }
    if (followUp === "flameBladeScimitar") replaceWorkflowActivity(workflow, activity => {
      const dice = 3 + Math.floor(Math.max(0, Number(effectState(source).castLevel ?? 2) - 2) / 2);
      for (const part of activity.damage?.parts ?? []) {
        part.number = dice; part.denomination = 6;
        part.custom = {enabled: false, formula: ""}; part.scaling = {mode: "", number: null};
      }
    });
  }

  if (identifier === "wither-and-bloom" && !workflow.workflowOptions?.khuzoeInternalActivity) {
    const candidates = targetDocuments(workflow);
    const selected = await cat.utils.dialogUtils.selectTargetDialog(item.name,
      "Scegli nell’area la creatura a cui offrire i Dadi Vita; annulla per infliggere solo danni.", candidates,
      {type: "one", skipDeadAndUnconscious: false});
    const target = tokenDocument(selected?.result);
    workflow.khuzoeBloomTarget = target?.uuid;
    if (target) await updateWorkflowTargets(workflow, candidates.filter(candidate => candidate.uuid !== target.uuid));
  }
  if (identifier === "melfs-acid-arrow") {
    workflow.workflowOptions ??= {};
    workflow.workflowOptions.autoRollDamage = "always";
  }

  if (identifier === "enlarge-reduce") {
    await prepareVoluntaryConstitutionFailure(workflow, item, identifier);
  }

  if (identifier === "vortex-warp") {
    const sourceActor = workflow.actor ?? item.actor;
    const targets = targetDocuments(workflow).filter(token => (
      token.actor !== sourceActor
    ));
    await updateWorkflowTargets(workflow, targets.slice(0, 1));
    if (targets.length) await prepareVoluntaryConstitutionFailure(workflow, item, identifier);
  }

  if (["charm-person", "hold-person"].includes(identifier)) {
    const maximum = Math.max(1, castLevel(workflow) - Number(item.system?.level ?? 1) + 1);
    let targets = targetDocuments(workflow);
    targets = targets.filter(token => isHumanoidActor(token.actor));
    await updateWorkflowTargets(workflow, targets.slice(0, maximum));
  }

  if (identifier === "mass-cure-wounds") {
    const source = tokenDocument(workflow.token ?? actorToken(workflow.actor));
    const targets = targetDocuments(workflow).filter(token =>
      !["construct", "undead"].includes(creatureType(token.actor))
    );
    await updateWorkflowTargets(workflow, targets.slice(0, 6));
  }

  if (identifier === "synaptic-static") {
    await updateWorkflowTargets(workflow, targetDocuments(workflow).filter(token =>
      Number(token.actor.system?.abilities?.int?.value ?? 0) > 2
    ));
  }

  if (identifier === "blight") {
    for (const target of targetDocuments(workflow)) {
      if (creatureType(target.actor) === "plant") {
        await createEffect(target.actor, item, {
          identifier: "blight-plant-save", state: {kind: "single-save"},
          effectChanges: changes({key: "flags.midi-qol.disadvantage.ability.save.con", value: "1", type: "override"}),
          seconds: 6, specialDuration: ["isSave"], showIcon: 0
        });
      }
    }
  }

  if (identifier === "charm-person" && globalThis.game?.combat?.started) {
    for (const target of targetDocuments(workflow).filter(token =>
      values(game.combat.combatants).some(combatant => combatant.tokenId === token.id)
      && globalThis.cat.utils.tokenUtils.isEnemy(tokenDocument(workflow.token), token))) {
      await createEffect(target.actor, item, {
        identifier: "charm-person-save-advantage",
        state: {kind: "single-save"},
        effectChanges: changes({key: "flags.midi-qol.advantage.ability.save.all", value: "1", type: "override"}),
        seconds: 6,
        specialDuration: ["isSave"],
        showIcon: 0,
        concentrationItem: undefined
      });
    }
  }

  if (identifier === "toll-the-dead") {
    const wounded = targetDocuments(workflow).some(token =>
      Number(token.actor.system?.attributes?.hp?.value ?? 0) < Number(token.actor.system?.attributes?.hp?.max ?? 0)
    );
    if (wounded) replaceWorkflowActivity(workflow, activity => {
      const part = activity.damage?.parts?.[0];
      if (part) {
        part.custom = {enabled: false, formula: ""};
        part.denomination = 12;
      }
    });
  }

  if (identifier === "chromatic-orb") {
    const type = await chooseDamageType(item, ["acid", "cold", "fire", "lightning", "poison", "thunder"]);
    if (!type) { workflow.aborted = true; return true; }
    workflow.khuzoeChromaticType = type;
    replaceWorkflowActivity(workflow, activity => {
      for (const part of activity.damage?.parts ?? []) part.types = [type];
    });
    workflow.workflowOptions ??= {};
    workflow.workflowOptions.autoRollDamage = "always";
  }
}

export async function modifyExpandedSpellDamage(context = {}) {
  const {workflow} = context;
  const item = itemDocument(context);
  const identifier = spellIdentifier(context);
  if (!workflow || !item) return;

  if (identifier === "chromatic-orb") {
    const type = workflow.khuzoeChromaticType;
    if (!type) return;
    const rolls = values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll]);
    for (const roll of rolls) {
      roll.options ??= {};
      roll.options.type = type;
      for (const term of values(roll.terms)) {
        term.options ??= {};
        if (!term.options.flavor || term.options.flavor === "none") term.options.flavor = type;
      }
    }
    workflow.defaultDamageType = type;
    if (workflow.setDamageRolls) await workflow.setDamageRolls(rolls);
  }

  if (identifier === "blight") {
    const targets = targetDocuments(workflow);
    if (!targets.length) return;
    const types = targets.map(token => String(globalThis.cat.utils.actorUtils.typeOrRace(token.actor) ?? "").toLowerCase());
    const allImmune = types.every(type => ["undead", "construct"].includes(type));
    const allPlants = types.every(type => type === "plant");
    if (!allImmune && !allPlants) return;
    const original = values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll]);
    const rolls = [];
    for (const roll of original) {
      if (allImmune) {
        rolls.push(await new CONFIG.Dice.DamageRoll("0", workflow.item.getRollData(), {type: workflow.defaultDamageType}).evaluate());
      } else if (roll.reroll) {
        rolls.push(await roll.reroll({maximize: true}));
      }
    }
    if (rolls.length && workflow.setDamageRolls) await workflow.setDamageRolls(rolls);
  }

  if (identifier === "ray-of-enfeeblement") {
    const active = effectByState(workflow.actor, identifier);
    if (!active || workflow.item?.type !== "weapon") return;
    if (workflowAttackAbility(workflow) !== "str") return;
    const sourceRolls = values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll]);
    const rolls = [];
    for (const roll of sourceRolls) {
      rolls.push(await new CONFIG.Dice.DamageRoll(String(Math.floor(Number(roll.total) / 2)), workflow.item.getRollData(), roll.options).evaluate());
    }
    if (rolls.length && workflow.setDamageRolls) await workflow.setDamageRolls(rolls);
  }
}

export async function addExpandedSpellDamage(context = {}) {
  const {workflow} = context;
  const item = itemDocument(context);
  const identifier = spellIdentifier(context);
  if (!workflow || !item) return;
  if (identifier === "destructive-wave") {
    const damageType = await chooseDamageType(item, ["radiant", "necrotic"]) ?? "radiant";
    await bonusDamage(workflow, "5d6", damageType);
  }
}

export async function adjustExpandedSpellTargetDamage({workflow, ditem} = {}) {
  if (!workflow || !ditem || spellIdentifier({workflow}) !== "lightning-lure") return;
  const target = targetDocuments(workflow)[0];
  const source = tokenDocument(workflow.token ?? actorToken(workflow.actor));
  if (!target || !source) return;
  if (targetDocuments(workflow, "failedSaves").some(token => sameTokenReference(token, target))) {
    const distance = globalThis.cat.utils.tokenUtils.getDistance(source, target, {wallsBlock: true});
    const pull = Math.min(10, Math.max(0, distance - 5));
    if (pull > 0) await slide(target, source, pull, true);
  }
  const finalDistance = globalThis.cat.utils.tokenUtils.getDistance(source, target, {wallsBlock: true});
  if (finalDistance > 5) globalThis.cat.utils.workflowUtils.negateDamageItemDamage(ditem);
}

async function createSmiteEffect(workflow, item, identifier) {
  const seconds = Number(item.system?.duration?.value ?? 1) * 60;
  const activity = activityByKey(item, {
    "blinding-smite": "blindingSmiteBlind",
    "hail-of-thorns": "hailOfThornsBurst",
    "lightning-arrow": "lightningArrowBurst",
    "staggering-smite": "staggeringSmiteStagger",
    "thunderous-smite": "thunderousSmitePush",
    "wrathful-smite": "wrathfulSmiteFrighten"
  }[identifier]);
  return createEffect(workflow.actor, item, {
    identifier,
    state: {
      kind: "weapon-trigger",
      castLevel: castLevel(workflow),
      saveDC: Number(
        workflow?.castData?.saveDC
        ?? workflow?.workflowOptions?.castData?.saveDC
        ?? workflow?.actor?.system?.attributes?.spell?.dc
        ?? 10
      ),
      activityId: activity?.id ?? activity?._id
    },
    seconds,
    concentrationItem: item,
    showIcon: 1
  });
}

async function applySkillSelection(workflow, item, identifier) {
  for (const target of targetDocuments(workflow)) {
    const selection = await chooseSkill(item, target.actor, identifier === "borrowed-knowledge" ? value => value < 1 : value => value === 1);
    if (!selection) continue;
    await createEffect(target.actor, item, {
      identifier,
      state: {kind: "skill", skill: selection},
      effectChanges: changes({
        key: `system.skills.${selection}.value`,
        value: identifier === "borrowed-knowledge" ? "1" : "2",
        type: "upgrade"
      }),
      concentrationItem: identifier === "skill-empowerment" ? item : undefined,
      seconds: identifier === "borrowed-knowledge" ? 3600 : 3600
    });
  }
}

async function applyBeaconOfHope(workflow, item) {
  return createTargetEffects(workflow, item, {
    identifier: "beacon-of-hope",
    state: {kind: "beacon"},
    effectChanges: changes(
      {key: "flags.midi-qol.advantage.ability.save.wis", value: "1", type: "override"},
      {key: "flags.midi-qol.advantage.deathSave", value: "1", type: "override"}
    ),
    concentrationItem: item,
    seconds: 60
  });
}

async function applyChillTouch(workflow, item) {
  for (const target of targetDocuments(workflow, "hitTargets")) {
    const undead = String(globalThis.cat.utils.actorUtils.typeOrRace(target.actor) ?? "").toLowerCase() === "undead";
    await createEffect(target.actor, item, {
      identifier: "chill-touch",
      state: {kind: "chill-touch", casterUuid: workflow.actor?.uuid, undead},
      effectChanges: changes({key: "system.traits.di.value", value: "healing"}),
      seconds: 6,
      specialDuration: ["turnStartSource"]
    });
  }
}

async function applyFaerieFire(workflow, item) {
  if (await removeConcentrationIfNoFailedSave(workflow, item)) return;
  for (const target of targetDocuments(workflow, "failedSaves")) {
    await createEffect(target.actor, item, {
      identifier: "faerie-fire",
      state: {kind: "outlined"},
      effectChanges: changes(
        {key: "ATL.alpha", value: "1", type: "override"},
        {key: "ATL.light.dim", value: String(distanceInScene(10, target)), type: "upgrade"}
      ),
      concentrationItem: item,
      seconds: 60
    });
  }
}

async function applyHeroism(workflow, item) {
  const amount = Number(workflow.activity?.abilityMod ?? workflow.actor?.system?.attributes?.spell?.mod ?? 0);
  for (const target of targetDocuments(workflow)) {
    await createEffect(target.actor, item, {
      identifier: "heroism",
      state: {kind: "heroism", amount},
      effectChanges: changes({key: "system.traits.ci.value", value: "frightened"}),
      concentrationItem: item,
      seconds: 60
    });
  }
}

async function applyMark(workflow, item, identifier) {
  const isHex = identifier === "hex";
  const key = activityKey(workflow, item);
  const moveKey = isHex ? "hexMove" : "huntersMarkMove";
  let source = effectByState(workflow.actor, identifier, state => state.kind === "mark-source");
  if (source && key !== moveKey) { await removeEffect(source); source = null; }
  const target = targetDocuments(workflow)[0];
  if (!target) return;
  let ability = source?.flags?.[MODULE_ID]?.[EFFECT_FLAG]?.ability;
  if (!source && isHex) {
    ability = await chooseButtons(item.name, "Scegli la caratteristica penalizzata nelle prove.", Object.entries(CONFIG.DND5E.abilities ?? {}).map(([value, data]) => ({label: data.label, value})));
    if (!ability) return;
  }
  if (key === moveKey && !source) return;

  if (source) {
    const oldUuid = effectState(source).targetUuid;
    const oldToken = oldUuid ? await globalThis.fromUuid?.(oldUuid) : null;
    if (key === moveKey && oldToken?.actor && Number(oldToken.actor.system?.attributes?.hp?.value ?? 0) > 0) {
      ui.notifications.warn(`${item.name}: il bersaglio precedente non è a 0 PF.`);
      return;
    }
    const oldEffect = oldToken?.actor ? effectByState(oldToken.actor, identifier, state => state.kind === "mark-target" && state.sourceUuid === source.uuid) : null;
    if (oldEffect) await removeEffect(oldEffect);
    await updateDocumentSafely(source, {
      [`flags.${MODULE_ID}.${EFFECT_FLAG}.targetUuid`]: target.uuid
    });
  }

  let sourceEffect = source;
  if (!sourceEffect) {
    const moveActivity = activityByKey(item, moveKey);
    [sourceEffect] = await createEffect(workflow.actor, item, {
      identifier,
      state: {kind: "mark-source", targetUuid: target.uuid, ability, damageType: isHex ? "necrotic" : "", formula: "1d6"},
      concentrationItem: item,
      seconds: castLevel(workflow) >= 5 ? 86400 : castLevel(workflow) >= 3 ? 28800 : 3600,
      unhideActivities: moveActivity ? [moveActivity.id] : []
    });
  }
  const targetChanges = isHex
    ? changes({key: `flags.midi-qol.disadvantage.ability.check.${ability}`, value: "1", type: "override"})
    : [];
  const created = await createEffect(target.actor, item, {
    identifier,
    state: {kind: "mark-target", sourceUuid: sourceEffect?.uuid},
    effectChanges: targetChanges,
    seconds: Math.max(6, Number(sourceEffect?.duration?.remaining ?? 3600)),
    showIcon: 1,
    replace: false,
    macroGroups: []
  });
  if (sourceEffect && created?.length) await globalThis.cat.utils.documentUtils.makeDependent(sourceEffect, created);
}

async function applyEnlargeReduce(workflow, item) {
  const target = targetDocuments(workflow, "failedSaves")[0];
  if (!target) {
    await removeConcentrationIfNoFailedSave(workflow, item);
    return;
  }
  const consent = effectByState(target.actor, "enlarge-reduce-consent", state => state.kind === "voluntary-fail");
  if (consent) await removeEffect(consent);
  const choice = await chooseButtons(item.name, "Scegli l'effetto.", [
    {label: "Enlarge", value: "enlarge"},
    {label: "Reduce", value: "reduce"}
  ]);
  if (!choice) return;
  const order = ["tiny", "sm", "med", "lg", "huge", "grg"];
  const oldSize = String(target.actor.system?.traits?.size ?? "med");
  const index = Math.max(0, order.indexOf(oldSize));
  const newSize = order[Math.clamp?.(index + (choice === "enlarge" ? 1 : -1), 0, order.length - 1) ?? Math.max(0, Math.min(order.length - 1, index + (choice === "enlarge" ? 1 : -1)))];
  const tokenSnapshots = (target.actor.getActiveTokens?.(false, true) ?? [])
    .map(tokenDocument)
    .filter(token => token?.uuid)
    .map(token => ({
      uuid: token.uuid,
      width: token.width,
      height: token.height,
      scaleX: token.texture?.scaleX,
      scaleY: token.texture?.scaleY
    }));
  const bonus = choice === "enlarge" ? "1d4" : "-1d4";
  await createEffect(target.actor, item, {
    identifier: "enlarge-reduce",
    state: {kind: "size", choice, oldSize, newSize, tokenSnapshots},
    effectChanges: changes(
      {key: "system.traits.size", value: newSize, type: "override"},
      {key: "system.bonuses.mwak.damage", value: bonus},
      {key: "system.bonuses.rwak.damage", value: bonus},
      {key: `flags.midi-qol.${choice === "enlarge" ? "advantage" : "disadvantage"}.ability.check.str`, value: "1", type: "override"},
      {key: `flags.midi-qol.${choice === "enlarge" ? "advantage" : "disadvantage"}.ability.save.str`, value: "1", type: "override"}
    ),
    concentrationItem: item,
    seconds: 60
  });
  for (const snapshot of tokenSnapshots) {
    const token = await globalThis.fromUuid?.(snapshot.uuid);
    if (!token) continue;
    await updateDocumentSafely(token, tokenSizeForCategory(newSize));
  }
}

async function applySelfBuff(workflow, item, identifier, state, effectChanges, options = {}) {
  return createEffect(workflow.actor, item, {
    identifier,
    state: {kind: "self-buff", ...state},
    effectChanges,
    concentrationItem: options.concentration === false ? undefined : item,
    seconds: options.seconds,
    unhideActivities: options.unhideActivities ?? [],
    showIcon: options.showIcon ?? 1
  });
}

async function applyGuardianOfNature(workflow, item) {
  const choice = await chooseButtons(item.name, "Scegli la forma del guardiano.", [
    {label: "Primal Beast", value: "beast"},
    {label: "Great Tree", value: "tree"}
  ]);
  if (!choice) return;
  const effectChanges = choice === "beast" ? changes(
    {key: "system.attributes.movement.walk", value: "10"},
    {key: "system.attributes.senses.ranges.darkvision", value: "120", type: "upgrade"},
    {key: "flags.midi-qol.advantage.attack.str", value: "1", type: "override"},
    {key: "system.bonuses.mwak.damage", value: "1d6[force]"}
  ) : changes(
    {key: "flags.midi-qol.advantage.ability.save.con", value: "1", type: "override"},
    {key: "flags.midi-qol.advantage.attack.dex", value: "1", type: "override"},
    {key: "flags.midi-qol.advantage.attack.wis", value: "1", type: "override"}
  );
  const effects = await applySelfBuff(workflow, item, "guardian-of-nature", {choice}, effectChanges, {seconds: 60});
  if (choice === "tree") {
    const hp = Number(workflow.actor.system?.attributes?.hp?.temp ?? 0);
    if (hp < 10) await updateDocumentSafely(workflow.actor, {"system.attributes.hp.temp": 10});
    await createSpellArea(workflow, item, {rule: "guardian-of-nature", controller: effects?.[0], radius: 15, mobile: true, enemiesOnly: true});
  }
}

async function applyInvestiture(workflow, item, identifier) {
  let effectChanges = [];
  let activity;
  if (identifier === "investiture-of-flame") {
    activity = activityByKey(item, "investitureOfFlameFire");
    effectChanges = changes(
      {key: "system.traits.di.value", value: "fire"},
      {key: "system.traits.dr.value", value: "cold"}
    );
  } else if (identifier === "investiture-of-ice") {
    activity = activityByKey(item, "investitureOfIceCone");
    effectChanges = changes(
      {key: "system.traits.di.value", value: "cold"},
      {key: "system.traits.dr.value", value: "fire"}
    );
  } else {
    activity = activityByKey(item, "investitureOfStoneEarthquake");
    effectChanges = changes({key: "system.traits.dr.value", value: "physical"}, {key: "system.traits.dr.bypasses", value: "mgc"});
  }
  const effects = await applySelfBuff(workflow, item, identifier, {}, effectChanges, {
    seconds: 600,
    unhideActivities: activity ? [activity.id] : []
  });
  if (identifier === "investiture-of-ice") await createSpellArea(workflow, item, {
    rule: identifier, controller: effects?.[0], radius: 10, mobile: true
  });
  return effects;
}

async function applyOtherworldlyGuise(workflow, item) {
  const choice = await chooseButtons(item.name, "Scegli la forma.", [
    {label: "Upper Planes", value: "upper"},
    {label: "Lower Planes", value: "lower"}
  ]);
  if (!choice) return;
  const immunities = choice === "upper" ? ["radiant", "necrotic"] : ["fire", "poison"];
  const condition = choice === "upper" ? "charmed" : "poisoned";
  return applySelfBuff(workflow, item, "tashas-otherworldly-guise", {choice}, changes(
    immunities.map(type => ({key: "system.traits.di.value", value: type})),
    {key: "system.traits.ci.value", value: condition},
    {key: "system.attributes.ac.bonus", value: "2"},
    {key: "system.attributes.movement.fly", value: "40", type: "upgrade"}
  ), {seconds: 60});
}

async function applyFireShield(workflow, item) {
  const key = activityKey(workflow, item);
  if (key === "fireShieldDismiss") {
    return removeEffect(effectByState(workflow.actor, "fire-shield"));
  }
  const warm = key === "fireShieldWarm" || workflow.activity?.name?.toLowerCase().includes("warm");
  const damageType = warm ? "fire" : "cold";
  const resistance = warm ? "cold" : "fire";
  const damageActivity = activityByKey(item, "fireShieldDamage");
  const dismiss = activityByKey(item, "fireShieldDismiss");
  return applySelfBuff(workflow, item, "fire-shield", {damageType, damageActivityId: damageActivity?.id}, changes(
    {key: "system.traits.dr.value", value: resistance},
    {key: "ATL.light.dim", value: String(distanceInScene(20, tokenDocument(workflow.token))), type: "upgrade"},
    {key: "ATL.light.bright", value: String(distanceInScene(10, tokenDocument(workflow.token))), type: "upgrade"}
  ), {seconds: 600, concentration: false, unhideActivities: dismiss ? [dismiss.id] : []});
}

async function applyGeneratedBlade(workflow, item, identifier) {
  const key = activityKey(workflow, item);
  const attackKey = identifier === "flame-blade" ? "flameBladeScimitar" : "shadowBladeSword";
  if (key && key !== (identifier === "flame-blade" ? "flameBlade" : "shadowBlade")) return;
  let activity = activityByKey(item, attackKey);
  if (identifier === "shadow-blade" && !activity) {
    const formula = `${castLevel(workflow) >= 7 ? 5 : castLevel(workflow) >= 5 ? 4 : castLevel(workflow) >= 3 ? 3 : 2}d8`;
    const data = {
      name: "Shadow Blade",
      type: "weapon",
      img: item.img,
      system: {
        identifier: "khuzoe-shadow-blade-weapon",
        type: {value: "simpleM", baseItem: "shortsword"},
        equipped: true,
        proficient: 1,
        properties: ["fin", "lgt", "thr", "mgc"],
        range: {value: 20, long: 60, units: "ft"},
        damage: {base: {number: null, denomination: 0, bonus: "", types: ["psychic"], custom: {enabled: true, formula}}},
        activities: {
          KhzShadowAtk0001: {
            _id: "KhzShadowAtk0001",
            type: "attack",
            name: "Shadow Blade",
            img: item.img,
            activation: {type: "action", value: null, override: false, condition: ""},
            consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
            description: {chatFlavor: ""},
            duration: {units: "inst", concentration: false, override: false},
            effects: [],
            range: {override: false},
            target: {prompt: true, template: {contiguous: false, units: "ft", type: ""}, affects: {choice: false, count: "1", type: "creature", special: ""}, override: false},
            uses: {spent: 0, recovery: [], max: ""},
            attack: {ability: "", bonus: "", critical: {threshold: null}, flat: false, type: {value: "melee", classification: "weapon"}},
            damage: {critical: {bonus: ""}, includeBase: true, parts: []},
            sort: 0,
            midiProperties: {confirmTargets: "default", autoTargetType: "any", autoTargetAction: "default", magicEffect: true, magicDamage: true}
          }
        }
      },
      flags: {[MODULE_ID]: {temporarySpellItem: true}}
    };
    const created = await globalThis.cat.utils.documentUtils.createEmbeddedDocuments(workflow.actor, "Item", [data]);
    const weapon = created?.[0];
    if (!weapon) throw new Error(`${item.name}: arma temporanea non creata.`);
    try {
    const effects = await createEffect(workflow.actor, item, {
      identifier,
      state: {kind: "generated-item", itemUuid: weapon?.uuid},
      concentrationItem: item,
      seconds: 60
    });
    if (!effects.length) throw new Error(`${item.name}: effetto di controllo non creato.`);
    return effects;
    } catch (error) {
      await globalThis.cat.utils.documentUtils.deleteDocument(weapon);
      throw error;
    }
  }
  return applySelfBuff(workflow, item, identifier, {castLevel: castLevel(workflow)}, changes(
    identifier === "flame-blade" ? [
      {key: "ATL.light.dim", value: String(distanceInScene(20, tokenDocument(workflow.token))), type: "upgrade"},
      {key: "ATL.light.bright", value: String(distanceInScene(10, tokenDocument(workflow.token))), type: "upgrade"}
    ] : []
  ), {seconds: identifier === "flame-blade" ? 600 : 60, unhideActivities: activity ? [activity.id] : []});
}

async function applySpiritShroud(workflow, item) {
  const damageType = await chooseDamageType(item, ["cold", "necrotic", "radiant"]) ?? "necrotic";
  return applySelfBuff(workflow, item, "spirit-shroud", {
    damageType,
    formula: `${Math.max(1, Math.floor((castLevel(workflow) - 1) / 2))}d8`
  }, [], {seconds: 60});
}

async function applyShadowOfMoil(workflow, item) {
  return applySelfBuff(workflow, item, "shadow-of-moil", {damageType: "necrotic", formula: "2d8"}, changes(
    {key: "system.traits.dr.value", value: "radiant"}
  ), {seconds: 60});
}

async function applyElementalWeapon(workflow, item) {
  const damageType = await chooseDamageType(item, ["acid", "cold", "fire", "lightning", "thunder"]);
  if (!damageType) return;
  for (const token of targetDocuments(workflow)) {
    const weapons = values(token.actor.items).filter(weapon =>
      weapon.type === "weapon" && weapon.system?.equipped && !weapon.system?.properties?.has?.("mgc")
    );
    if (!weapons.length) continue;
    const weapon = weapons.length === 1 ? weapons[0] : await globalThis.cat.utils.dialogUtils.selectDocumentDialog(
      item.name,
      "Scegli l'arma non magica da potenziare.",
      weapons
    );
    if (!weapon) continue;
    const level = castLevel(workflow);
    const bonus = level >= 7 ? 3 : level >= 5 ? 2 : 1;
    const effectData = {
      name: `${item.name} — ${weapon.name}`,
      img: item.img,
      origin: item.uuid,
      duration: effectDuration(item, 3600),
      type: "enchantment",
      system: {changes: changes(
        {key: "name", value: `${weapon.name} (${CONFIG.DND5E.damageTypes?.[damageType]?.label ?? damageType})`, type: "override"},
        {key: "system.properties", value: "mgc"},
        {key: "system.magicalBonus", value: String(bonus), type: "upgrade"},
        {key: "system.damage.base.bonus", value: `${bonus}d4[${damageType}]`}
      )},
      flags: {
        [MODULE_ID]: {[EFFECT_FLAG]: {identifier: "elemental-weapon", kind: "enchantment", damageType, bonus}},
        dae: {stackable: "noneNameOnly", expiryMode: "delete", specialDuration: []}
      }
    };
    const enchanted = await globalThis.cat.utils.itemUtils.enchantItem(weapon, effectData);
    const concentration = globalThis.cat.utils.effectUtils.getConcentrationEffect(item.actor, item);
    if (concentration && enchanted?.length) await globalThis.cat.utils.documentUtils.makeDependent(concentration, enchanted);
  }
}

async function applyWardingBond(workflow, item) {
  const key = activityKey(workflow, item);
  if (key === "wardingBondDismiss") {
    for (const effect of values(workflow.actor.effects).filter(effect => effectState(effect).identifier === "warding-bond" && effectState(effect).kind === "bond-source")) await removeEffect(effect);
    return;
  }
  const targets = targetDocuments(workflow);
  if (!targets.length) return;
  const dismiss = activityByKey(item, "wardingBondDismiss");
  const sourceToken = tokenDocument(workflow.token ?? actorToken(workflow.actor));
  // A new casting on either member ends that pair, including when the new target was a caster.
  const previous = new Map();
  for (const target of targets) for (const effect of values(target.actor.effects)) {
    const state = effectState(effect);
    if (state.identifier !== "warding-bond") continue;
    const source = state.kind === "bond-target" && state.sourceEffectUuid ? await fromUuid(state.sourceEffectUuid) : effect;
    if (source) previous.set(source.uuid, source);
  }
  for (const effect of previous.values()) await removeEffect(effect);
  const [sourceEffect] = await createEffect(workflow.actor, item, {
    identifier: "warding-bond",
    state: {kind: "bond-source", targetUuids: targets.map(token => token.uuid), maxDistance: 60},
    replace: false, seconds: 3600,
    unhideActivities: dismiss ? [dismiss.id] : [],
    concentrationItem: undefined, macroGroups: ["move"]
  });
  for (const target of targets) {
    const created = await createEffect(target.actor, item, {
      identifier: "warding-bond",
      state: {kind: "bond-target", sourceTokenUuid: sourceToken?.uuid, sourceEffectUuid: sourceEffect?.uuid, maxDistance: 60},
      effectChanges: changes(
        {key: "system.traits.dr.all", value: "1", type: "custom"},
        {key: "system.attributes.ac.bonus", value: "1"},
        {key: "system.bonuses.abilities.save", value: "1"}
      ),
      seconds: 3600,
      replace: true,
      macroGroups: ["roll", "move"]
    });
    if (sourceEffect && created?.length) await globalThis.cat.utils.documentUtils.makeDependent(sourceEffect, created);
  }
}

async function applyLifeTransference(workflow, item) {
  const target = targetDocuments(workflow).find(token => token.actor !== workflow.actor);
  if (!target) return;
  const self = tokenDocument(workflow.token ?? actorToken(workflow.actor));
  if (!self) return;
  const sacrifice = {
    _id: "KhzLifeSacrifice", name: item.name, type: "damage",
    activation: {type: "special", value: null, override: true},
    consumption: {targets: [], spellSlot: false, scaling: {allowed: false}},
    duration: {units: "inst", concentration: false, override: true},
    range: {units: "any", override: true},
    target: {override: true, prompt: false, affects: {count: "1", type: "creature"}, template: {units: "ft"}},
    damage: {critical: {allow: false}, parts: [{number: 4 + Math.max(0, castLevel(workflow) - 3), denomination: 8,
      bonus: "", types: ["necrotic"], custom: {enabled: false, formula: ""}, scaling: {mode: ""}}]},
    midiProperties: {automationOnly: true, magicDamage: true, ignoreTraits: ["idi", "idr", "idv", "ida", "idm"]}
  };
  const damageWorkflow = await runSyntheticActivityData(sacrifice, item, [self], {
    options: {workflowOptions: {khuzoeUnreducible: true}}
  });
  if (!damageWorkflow || damageWorkflow.aborted) return;
  const amount = totalDamage(damageWorkflow) * 2;
  if (amount <= 0) return;
  const data = {
    _id: "KhzLifeTransHeal",
    type: "heal",
    name: `${item.name}: Healing`,
    activation: {type: "special", value: null, override: true, condition: ""},
    consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
    description: {chatFlavor: ""},
    duration: {units: "inst", concentration: false, override: true},
    range: {override: true, value: null, units: "spec"},
    target: {prompt: false, template: {contiguous: false, units: "ft", type: ""}, affects: {choice: false, count: "1", type: "creature", special: ""}, override: true},
    uses: {spent: 0, recovery: [], max: ""},
    healing: {number: null, denomination: 0, bonus: "", types: ["healing"], custom: {enabled: true, formula: String(amount)}, scaling: {number: null, mode: "", formula: ""}},
    midiProperties: {automationOnly: true, magicEffect: true, magicDamage: false, confirmTargets: "never"}
  };
  await runSyntheticActivityData(data, item, [target], {
    options: {workflowOptions: {targetConfirmation: "none"}}
  });
}

async function applyMultiProjectile(workflow, item, identifier) {
  const config = {
    "eldritch-blast": {key: "eldritchBlastBeam", count: Math.max(1, Math.floor((actorLevel(workflow.actor, item) + 1) / 6) + 1)},
    "magic-missile": {key: "magicMissileBolt", count: castLevel(workflow) + 2},
    "scorching-ray": {key: "scorchingRayBolt", count: castLevel(workflow) + 1}
  }[identifier];
  const activity = activityByKey(item, config.key);
  if (!activity) return;
  const targets = targetDocuments(workflow);
  if (!targets.length) return;
  const selected = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    item.name,
    `Distribuisci ${config.count} ${identifier === "magic-missile" ? "dardi" : identifier === "scorching-ray" ? "raggi" : "colpi"}.`,
    targets,
    {type: "selectAmount", maxAmount: config.count, skipDeadAndUnconscious: false}
  );
  const allocations = selected?.result ?? selected;
  if (!allocations?.length) return;
  let remaining = config.count;
  for (const allocation of allocations) {
    const target = tokenDocument(allocation.document ?? allocation.target ?? allocation);
    const count = Math.min(remaining, Math.max(0, Number(allocation.value ?? 1)));
    for (let index = 0; index < count; index += 1) {
      const result = await syntheticActivity(activity, [target]);
      if (!result || result.aborted) return false;
    }
    remaining -= count;
    if (remaining <= 0) break;
  }
}

async function applyChainLightning(workflow, item) {
  const primary = targetDocuments(workflow)[0];
  if (!primary) return;
  const activity = activityByKey(item, "chainLightningLeap");
  if (!activity) return;
  const nearby = nearbyTokens(primary, 30, {disposition: "all", includeToken: false});
  if (!nearby.length) return;
  const max = Math.max(3, castLevel(workflow) - 3);
  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    item.name,
    `Scegli fino a ${max} bersagli secondari entro 30 ft dal primo.`,
    nearby,
    {type: "multiple", maxAmount: max}
  );
  const targets = (selection?.result ?? selection ?? []).map(tokenDocument);
  if (!targets.length) return;
  const damage = totalDamage(workflow);
  if (damage <= 0) return;
  const data = globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(
    activity,
    String(damage),
    {types: ["lightning"]}
  );
  await runSyntheticActivityData(data, item, targets, {
    options: {workflowOptions: {targetConfirmation: "none"}}
  });
}

async function applyWitherAndBloom(workflow, item) {
  const target = workflow.khuzoeBloomTarget ? await fromUuid(workflow.khuzoeBloomTarget) : null;
  if (!target?.actor) return;
  const maximum = Math.max(1, castLevel(workflow) - 1);
  const selected = await cat.utils.dialogUtils.selectHitDie?.(target.actor, item.name,
    `Spendi fino a ${maximum} Dadi Vita.`, {max: maximum});
  if (!selected?.length) return;
  return withDocumentLock(target.actor, "hit-dice", async () => {
    const plans = selected.map(selection => ({item: selection.document, amount: Number(selection.amount)}));
    if (plans.some(plan => !plan.item || !Number.isInteger(plan.amount) || plan.amount < 0)
      || plans.reduce((sum, plan) => sum + plan.amount, 0) > maximum) return;
    if (plans.some(plan => plan.amount > Number(plan.item.system.hd.max ?? plan.item.system.levels ?? 0) - Number(plan.item.system.hd.spent ?? 0))) return;
    const charged = [];
    try {
      for (const plan of plans.filter(plan => plan.amount > 0)) {
        await updateDocumentSafely(plan.item, {"system.hd.spent": Number(plan.item.system.hd.spent ?? 0) + plan.amount});
        charged.push(plan);
      }
      if (!charged.length) return;
      const formula = charged.map(plan => `${plan.amount}${plan.item.system.hd.denomination}`).join(" + ")
        + ` + ${Number(workflow.actor.system?.attributes?.spell?.mod ?? 0)}`;
      await healActor(target.actor, formula, {sourceItem: item, token: target});
    } catch (error) {
      for (const plan of charged) await updateDocumentSafely(plan.item, {"system.hd.spent": Math.max(0, Number(plan.item.system.hd.spent) - plan.amount)});
      throw error;
    }
  });
}

async function applyAntagonize(workflow, item) {
  const compelled = targetDocuments(workflow, "failedSaves")[0];
  if (!compelled) return;
  const fallback = () => rollDamageAgainst(item, compelled, "1d4", "psychic");
  if (cat.utils.actorUtils.hasUsedReaction(compelled.actor)) return fallback();
  const attacks = values(compelled.actor.items).flatMap(weapon =>
    (weapon.type === "weapon" && weapon.system?.equipped ? values(weapon.system.activities) : [])
      .filter(activity => activity.type === "attack" && activity.attack?.type?.value === "melee"));
  const source = tokenDocument(workflow.token);
  const pairs = attacks.flatMap(activity => {
    const reach = Number(activity.range?.value ?? activity.item?.system?.range?.reach ?? 5);
    return nearbyTokens(compelled, Math.max(5, reach), {disposition: "all", includeToken: false})
      .filter(token => !globalThis.MidiQOL?.canSee || MidiQOL.canSee(source.object ?? source, token.object ?? token))
      .map(target => ({activity, target: tokenDocument(target)}));
  });
  if (!pairs.length) return fallback();
  const selected = await cat.utils.dialogUtils.buttonDialog(item.name, "Scegli l’attacco in mischia e il bersaglio della reazione obbligata.",
    pairs.map((pair, index) => [`${pair.activity.name}: ${pair.target.name}`, String(index)]), {displayAsRows: true});
  if (selected === false || selected === null || selected === undefined) return fallback();
  const pair = pairs[Number(selected)];
  if (!pair) return fallback();
  const receipt = await reserveResources(compelled.actor, {reaction: true});
  if (!receipt) return fallback();
  try {
    const result = await runSyntheticActivity(pair.activity, [pair.target]);
    if (!result || result.aborted) { await refundResources(receipt); return fallback(); }
  } catch (error) { await refundResources(receipt); throw error; }
}

async function applyFly(workflow, item) {
  for (const target of targetDocuments(workflow)) {
    await createEffect(target.actor, item, {
      identifier: "fly",
      state: {kind: "flight", speed: 60},
      effectChanges: changes({key: "system.attributes.movement.fly", value: "60", type: "upgrade"}),
      concentrationItem: item,
      seconds: 600
    });
  }
}

async function applyRayOfEnfeeblement(workflow, item) {
  for (const target of targetDocuments(workflow, "hitTargets")) {
    await createEffect(target.actor, item, {
      identifier: "ray-of-enfeeblement",
      state: {kind: "enfeebled"},
      effectChanges: changes({
        key: "flags.midi-qol.OverTime",
        value: `turn=end,allowIncapacitated=true,rollType=save,saveAbility=con,saveDC=${Number(workflow.castData?.saveDC ?? workflow.actor.system?.attributes?.spell?.dc ?? 10)},saveCount=1-,saveMagic=true,label=Ray of Enfeeblement`,
        type: "custom"
      }),
      concentrationItem: item,
      seconds: 60
    });
  }
}

async function applyRimesBindingIce(workflow, item) {
  for (const target of targetDocuments(workflow, "failedSaves")) {
    await createEffect(target.actor, item, {
      identifier: "rimes-binding-ice",
      state: {kind: "frozen"},
      effectChanges: changes({key: "system.attributes.movement.all", value: "*0", type: "custom"}),
      seconds: 60,
      concentrationItem: undefined
    });
  }
}

async function applySimpleProne(workflow) {
  for (const target of targetDocuments(workflow, "failedSaves")) await applyCondition(target.actor, "prone");
}

async function applyGreenFlameBlade(workflow, item) {
  const dice = Math.floor((actorLevel(workflow.actor, item) + 1) / 6);
  const attack = await weaponCantripAttack(workflow, item, {dice, damageType: "fire"});
  const primary = firstHit(attack);
  if (!primary) return;
  const source = tokenDocument(workflow.token ?? actorToken(workflow.actor));
  const candidates = nearbyTokens(primary, 5, {disposition: "all", includeToken: false})
    .map(tokenDocument)
    .filter(token => token?.actor && !sameTokenReference(token, primary)
      && (!globalThis.MidiQOL?.canSee || MidiQOL.canSee(source?.object ?? source, token.object ?? token)));
  if (!candidates.length) return;
  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    item.name,
    "<p>Scegli la seconda creatura entro 5 ft dal bersaglio principale, oppure annulla per non far saltare le fiamme.</p>",
    candidates,
    {type: "one", skipDeadAndUnconscious: false, coverToken: primary, displayDistance: false}
  );
  const selectedToken = selection && Object.hasOwn(selection, "result") ? selection.result : selection?.[0] ?? selection;
  const secondary = tokenDocument(selectedToken);
  if (!secondary?.actor || !candidates.some(candidate => sameTokenReference(candidate, secondary))) return;
  const modifier = Number(workflow.actor.system?.attributes?.spell?.mod ?? 0);
  const formula = [dice ? `${dice}d8` : "", String(modifier)].filter(Boolean).join(" + ");
  if (!formula || formula === "0") return;
  const activity = activityByKey(item, "greenFlameBladeLeap");
  if (!activity) return;
  const data = globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(activity, formula, {types: ["fire"]});
  await runSyntheticActivityData(data, item, [secondary], {
    options: {workflowOptions: {targetConfirmation: "none"}}
  });
}

async function applyMovementSpell(workflow, identifier) {
  const source = tokenDocument(workflow.token ?? actorToken(workflow.actor));
  if (identifier === "thunderwave") {
    for (const target of targetDocuments(workflow, "failedSaves")) await slide(target, source, 10, false);
    return;
  }
  const target = identifier === "thorn-whip"
    ? firstHit(workflow)
    : targetDocuments(workflow, "failedSaves")[0];
  if (!target) return;
  if (identifier === "thorn-whip") {
    if (["huge", "grg"].includes(target.actor.system?.traits?.size)) return;
    const distance = await chooseButtons("Thorn Whip", "Quanto vuoi avvicinare il bersaglio?", [
      {label: "Non trascinare", value: 0}, {label: "5 piedi", value: 5}, {label: "10 piedi", value: 10}
    ]);
    const available = Math.max(0, Number(cat.utils.tokenUtils.getDistance(source, target, {wallsBlock: true})) - 5);
    const pull = Math.min(Number(distance), 10, available);
    if (pull > 0) return slide(target, source, pull, true);
    return;
  }
  if (identifier === "lightning-lure") {
    const distance = globalThis.cat.utils.tokenUtils.getDistance(source, target, {wallsBlock: true});
    if (distance > 5) await slide(target, source, Math.min(10, Math.max(0, distance - 5)), true);
    return;
  }
  if (identifier === "thunderwave") return slide(target, source, 10, false);
}

export async function finishExpandedSpell(context = {}) {
  const {workflow} = context;
  const item = itemDocument(context);
  const identifier = spellIdentifier(context);
  if (!workflow || workflow.aborted || !item || !identifier) return;
  const key = activityKey(workflow, item);

  // Le attività tecniche richiamano gli stessi hook dell'incantesimo che le
  // contiene. Non devono riattivare buff, Smite o proiettili quando vengono
  // lanciate internamente da una macro Khuzoe.
  if (workflow.workflowOptions?.khuzoeInternalActivity || (workflow.activity?.midiProperties?.automationOnly && !FOLLOW_UP_ACTIVITIES.has(key))) return;
  await normalizeSpellOvertime(workflow, item);
  if (key === "investitureOfStoneEarthquake") return applySimpleProne(workflow);
  if (["investitureOfFlameFire", "investitureOfIceCone", "flameBladeEvoke", "flameBladeScimitar"].includes(key)) return;

  if (AURA_SPELLS.has(identifier)) return createAuraSource(workflow, item, identifier);
  if (SMITE_SPELLS.has(identifier)) return createSmiteEffect(workflow, item, identifier);

  switch (identifier) {
    case "antagonize": return applyAntagonize(workflow, item);
    case "arms-of-hadar":
      for (const target of targetDocuments(workflow, "failedSaves")) globalThis.MidiQOL?.setReactionUsed?.(target.actor);
      return;
    case "beacon-of-hope": return applyBeaconOfHope(workflow, item);
    case "borrowed-knowledge":
    case "skill-empowerment": return applySkillSelection(workflow, item, identifier);
    case "chain-lightning": return applyChainLightning(workflow, item);
    case "chill-touch": return applyChillTouch(workflow, item);
    case "detect-magic": return applySelfBuff(workflow, item, identifier, {}, [], {seconds: 600});
    case "earth-tremor":
      await applySimpleProne(workflow);
      if (await cat.utils.dialogUtils.confirm(item.name, "Il terreno nell’area è terra o pietra smossa?")) {
        await createSpellArea(workflow, item, {rule: identifier, radius: 10, seconds: 0});
      }
      return;
    case "ice-storm": return createSpellArea(workflow, item, {rule: identifier, radius: 20, seconds: 6});
    case "sapping-sting":
    case "tidal-wave": return applySimpleProne(workflow);
    case "destructive-wave": await applySimpleProne(workflow); return;
    case "disintegrate":
      for (const entry of values(workflow.damageList)) {
        if (Number(entry?.newHP ?? 1) > 0) continue;
        const target = targetDocuments(workflow).find(token =>
          [token.id, token.uuid, token.actor?.id, token.actor?.uuid].includes(entry?.targetUuid ?? entry?.actorUuid)
        );
        if (target?.actor?.type === "character") await applyCondition(target.actor, "dead");
      }
      return;
    case "eldritch-blast":
    case "magic-missile":
    case "scorching-ray": return applyMultiProjectile(workflow, item, identifier);
    case "elemental-weapon": return applyElementalWeapon(workflow, item);
    case "enlarge-reduce": return applyEnlargeReduce(workflow, item);
    case "faerie-fire": return applyFaerieFire(workflow, item);
    case "far-step":
      await teleport(tokenDocument(workflow.token ?? actorToken(workflow.actor)), 60);
      if (key !== "farStepTeleport") {
        const activity = activityByKey(item, "farStepTeleport");
        return applySelfBuff(workflow, item, identifier, {}, [], {seconds: 60, unhideActivities: activity ? [activity.id] : []});
      }
      return;
    case "fire-shield": return applyFireShield(workflow, item);
    case "flame-blade":
    case "shadow-blade": return applyGeneratedBlade(workflow, item, identifier);
    case "fly": return applyFly(workflow, item);
    case "green-flame-blade": return applyGreenFlameBlade(workflow, item);
    case "grease":
      await applySimpleProne(workflow);
      return createSpellArea(workflow, item, {rule: identifier, radius: 5, seconds: 60});
    case "guardian-of-nature": return applyGuardianOfNature(workflow, item);
    case "heroism": return applyHeroism(workflow, item);
    case "hex":
    case "hunters-mark": return applyMark(workflow, item, identifier);
    case "investiture-of-flame":
    case "investiture-of-ice":
    case "investiture-of-stone":
      if (workflow.activity?.type !== "utility") return;
      return applyInvestiture(workflow, item, identifier);
    case "life-transference": return applyLifeTransference(workflow, item);
    case "melfs-acid-arrow":
      if (!hasHit(workflow) && targetDocuments(workflow).length) {
        return rollDamageAgainst(item, targetDocuments(workflow)[0], String(Math.floor(totalDamage(workflow) / 2)), "acid");
      }
      return;
    case "thorn-whip":
    case "thunderwave": return applyMovementSpell(workflow, identifier);
    case "misty-step": return teleport(tokenDocument(workflow.token ?? actorToken(workflow.actor)), 30);
    case "ray-of-enfeeblement": return applyRayOfEnfeeblement(workflow, item);
    case "rimes-binding-ice": return applyRimesBindingIce(workflow, item);
    case "shadow-of-moil": return applyShadowOfMoil(workflow, item);
    case "shocking-grasp":
      for (const target of targetDocuments(workflow, "hitTargets")) globalThis.MidiQOL?.setReactionUsed?.(target.actor);
      return;
    case "hold-person":
    case "hypnotic-pattern":
    case "tashas-caustic-brew": return removeConcentrationIfNoFailedSave(workflow, item);
    case "spirit-shroud": return applySpiritShroud(workflow, item);
    case "tashas-otherworldly-guise": return applyOtherworldlyGuise(workflow, item);
    case "vortex-warp":
      for (const target of targetDocuments(workflow, "failedSaves")) {
        const consent = effectByState(target.actor, "vortex-warp-consent", state => state.kind === "voluntary-fail");
        if (consent) await removeEffect(consent);
        await teleportFromSource(target, tokenDocument(workflow.token ?? actorToken(workflow.actor)), 90 + 30 * Math.max(0, castLevel(workflow) - 2));
      }
      return;
    case "warding-bond": return applyWardingBond(workflow, item);
    case "wither-and-bloom": return applyWitherAndBloom(workflow, item);
    default:
      if (!SIMPLE_NATIVE_SPELLS.has(identifier)) return;
  }
}

async function originItem(effect) {
  const origin = effect?.origin;
  if (!origin) return null;
  const document = await globalThis.fromUuid?.(origin);
  if (document?.documentName === "Item") return document;
  return document?.parent?.documentName === "Item" ? document.parent : null;
}

async function rollDamageAgainst(item, target, formula, damageType, activity) {
  if (!item || !target) return null;
  let data;
  if (activity) {
    data = globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(activity, formula, {types: [damageType]});
  } else {
    data = {
      _id: "KhzExpandedDmg1",
      type: "damage",
      name: item.name,
      activation: {type: "special", value: null, override: true, condition: ""},
      consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
      description: {chatFlavor: ""},
      duration: {units: "inst", concentration: false, override: true},
      range: {override: true, units: "spec"},
      target: {prompt: false, template: {contiguous: false, units: "ft", type: ""}, affects: {choice: false, count: "1", type: "creature", special: ""}, override: true},
      uses: {spent: 0, recovery: [], max: ""},
      damage: {critical: {allow: false}, parts: [{custom: {enabled: true, formula}, number: null, denomination: 0, bonus: "", types: [damageType], scaling: {mode: "", number: null, formula: ""}}]},
      midiProperties: {automationOnly: true, magicEffect: true, magicDamage: true, confirmTargets: "never"}
    };
  }
  return runSyntheticActivityData(data, item, [tokenDocument(target)], {
    options: {workflowOptions: {targetConfirmation: "none", khuzoeExpandedDamage: true}}
  });
}

async function resolveWeaponTrigger(effect, state, workflow) {
  if (!isWeaponAttack(workflow)) return;
  const identifier = state.identifier;
  if (!hasHit(workflow) && identifier !== "lightning-arrow") return;
  if (identifier === "hail-of-thorns" && !isWeaponAttack(workflow, {ranged: true})) return;
  if (identifier === "lightning-arrow" && !isWeaponAttack(workflow, {ranged: true})) return;
  if (["blinding-smite", "searing-smite", "staggering-smite", "thunderous-smite", "wrathful-smite"].includes(identifier)
    && !isWeaponAttack(workflow, {melee: true})) return;

  const damage = {
    "blinding-smite": ["3d8", "radiant"],
    "branding-smite": [`${Math.max(2, Number(state.castLevel ?? 2))}d6`, "radiant"],
    "searing-smite": [`${Math.max(1, Number(state.castLevel ?? 1))}d6`, "fire"],
    "staggering-smite": ["4d6", "psychic"],
    "thunderous-smite": ["2d6", "thunder"],
    "wrathful-smite": ["1d6", "psychic"]
  }[identifier];
  if (damage) await bonusDamage(workflow, damage[0], damage[1]);

  const item = await originItem(effect);
  const primary = firstHit(workflow) ?? targetDocuments(workflow)[0];
  const activity = state.activityId
    ? item?.system?.activities?.get?.(state.activityId) ?? values(item?.system?.activities).find(entry => entry.id === state.activityId)
    : null;

  if (identifier === "hail-of-thorns" && activity) {
    const nearby = nearbyTokens(primary, 5, {disposition: "all", includeToken: false});
    await syntheticActivity(activity, [primary, ...nearby], {atLevel: state.castLevel, configureDialog: false});
  } else if (identifier === "lightning-arrow" && activity) {
    if (!hasHit(workflow)) {
      const half = Math.floor(totalDamage(workflow) / 2);
      if (half > 0) await rollDamageAgainst(item, primary, String(half), "lightning");
    }
    const nearby = nearbyTokens(primary, 10, {disposition: "all", includeToken: false});
    if (nearby.length) await syntheticActivity(activity, nearby, {atLevel: state.castLevel, configureDialog: false});
  } else if (activity) {
    const result = await syntheticActivity(activity, [primary], {configureDialog: false});
    if (["blinding-smite", "wrathful-smite"].includes(identifier)) {
      if (result && !result.aborted) await normalizeSpellOvertime({...result, targets: [primary]}, item, {saveDC: state.saveDC, castLevel: state.castLevel});
    }
    if (identifier === "thunderous-smite" && targetDocuments(result, "failedSaves").length) {
      await applyCondition(primary.actor, "prone");
      await slide(primary, tokenDocument(workflow.token), 10, false);
    }
    if (identifier === "staggering-smite" && targetDocuments(result, "failedSaves").length) {
      await globalThis.MidiQOL?.setReactionUsed?.(primary.actor);
    }
  }

  if (identifier === "branding-smite") {
    await createEffect(primary.actor, item, {
      identifier,
      state: {kind: "branded"},
      effectChanges: changes(
        {key: "ATL.alpha", value: "1", type: "override"},
        {key: "ATL.light.dim", value: String(distanceInScene(5, primary)), type: "upgrade"}
      ),
      seconds: Math.max(6, Number(effect.duration?.remaining ?? 60)),
      replace: true,
      concentrationItem: item
    });
  }
  if (identifier === "searing-smite") {
    const dc = Number(state.saveDC ?? item?.actor?.system?.attributes?.spell?.dc ?? 10);
    await createEffect(primary.actor, item, {
      identifier,
      state: {kind: "burning"},
      effectChanges: changes({
        key: "flags.midi-qol.OverTime",
        value: `turn=start,allowIncapacitated=true,damageRoll=1d6,damageType=fire,rollType=save,saveAbility=con,saveDC=${dc},saveCount=1-,saveMagic=true,label=Searing Smite`,
        type: "custom"
      }),
      seconds: 60,
      replace: true,
      concentrationItem: item
    });
  }
  await removeEffect(effect);
}

export async function expandedEffectDamageBonuses({document, workflow} = {}) {
  const state = effectState(document);
  if (!document || !workflow || !state.identifier) return;
  if (state.kind === "weapon-trigger") return resolveWeaponTrigger(document, state, workflow);
  if (state.kind === "mark-source") {
    if (!hasHit(workflow) || !globalThis.cat.utils.workflowUtils.isAttackType(workflow, "attack")) return;
    if (state.identifier === "hunters-mark" && !isWeaponAttack(workflow)) return;
    const hit = firstHit(workflow);
    if (!sameTokenReference(state.targetUuid, hit)) return;
    return bonusDamage(workflow, state.formula ?? "1d6", state.identifier === "hunters-mark" ? workflow.defaultDamageType : (state.damageType || "necrotic"));
  }
  if (state.identifier === "spirit-shroud" && state.kind === "self-buff") {
    if (!globalThis.cat.utils.workflowUtils.isAttackType(workflow, "attack")) return;
    const hit = firstHit(workflow);
    if (!hit) return;
    const source = tokenDocument(workflow.token ?? actorToken(workflow.actor));
    if (!isAuraCreature(source) || !isAuraCreature(hit) || circularAuraTokenDistance(source, hit) > 10 + 1e-6) return;
    await bonusDamage(workflow, state.formula ?? "1d8", state.damageType ?? "necrotic");
    const item = await originItem(document);
    await createEffect(hit.actor, item, {
      identifier: "spirit-shroud-no-healing",
      state: {kind: "no-healing", sourceActorUuid: workflow.actor?.uuid},
      effectChanges: changes({key: "system.traits.di.value", value: "healing"}),
      seconds: 6,
      specialDuration: ["turnStartSource"],
      replace: true
    });
  }
}

export async function expandedEffectOnHit({document, workflow} = {}) {
  const state = effectState(document);
  if (!document || !workflow || !state.identifier || workflow.workflowOptions?.khuzoeExpandedDamage) return;
  if (!["fire-shield", "shadow-of-moil"].includes(state.identifier)) return;
  if (state.identifier === "fire-shield" && !isMeleeAttack(workflow)) return;
  if (state.identifier === "shadow-of-moil"
    && !globalThis.cat.utils.workflowUtils.isAttackType?.(workflow, "attack")) return;
  const attacker = tokenDocument(workflow.token);
  const owner = actorToken(document.parent);
  if (!attacker || !owner) return;
  const maxDistance = state.identifier === "fire-shield" ? 5 : 10;
  if (globalThis.cat.utils.tokenUtils.getDistance(owner, attacker, {wallsBlock: true}) > maxDistance) return;
  const item = await originItem(document);
  const activity = state.damageActivityId ? item?.system?.activities?.get?.(state.damageActivityId) : null;
  return rollDamageAgainst(item, attacker, state.formula ?? "2d8", state.damageType ?? "fire", activity);
}

export async function expandedEffectDamageItem({document, workflow, ditem} = {}) {
  const state = effectState(document);
  if (!document || !workflow || !ditem || !state.identifier) return;
  if (state.identifier === "beacon-of-hope" && state.kind === "beacon") {
    const healing = workflow.defaultDamageType === "healing"
      || values(workflow.damageRolls).some(roll => roll.options?.type === "healing");
    if (!healing) return;
    let maximum = 0;
    for (const roll of values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll])) {
      if (roll?.options?.type && roll.options.type !== "healing") continue;
      const maximized = await roll.reroll({maximize: true});
      maximum += Number(maximized.total ?? 0);
    }
    const rolled = Math.abs(Number(ditem.hpDamage ?? 0));
    if (maximum > rolled) adjustAppliedDamage(ditem, -(maximum - rolled), {type: "healing"});
  }
}

export function expandedEffectFlatReduction({document, workflow, ditem} = {}) {
  const state = effectState(document);
  if (!document || !workflow || !ditem || state.identifier !== "blade-ward") return;
  if (!isWeaponAttack(workflow)) return;

  const protectedTypes = new Set(["bludgeoning", "piercing", "slashing"]);
  const details = Array.isArray(ditem.damageDetail) ? ditem.damageDetail : [];
  const reduction = details.reduce((total, detail) => {
    const type = String(detail?.type ?? detail?.damageType ?? "").toLowerCase();
    const amount = Math.max(0, Number(detail?.value ?? detail?.damage ?? 0));
    const resisted = detail.active?.resistance || detail.active?.type?.resistance || detail.active?.all?.resistance;
    return protectedTypes.has(type) && !resisted ? total + Math.ceil(amount / 2) : total;
  }, 0);
  if (reduction > 0) adjustAppliedDamage(ditem, -reduction);
}

export async function expandedEffectDamageComplete({document, workflow, ditem} = {}) {
  const state = effectState(document);
  if (!document || !workflow || !ditem || state.identifier !== "warding-bond" || state.kind !== "bond-target") return;
  const visited = workflow.workflowOptions?.khuzoeWardingVisited ?? [];
  const amount = appliedDamageAmount(ditem);
  if (!amount) return;
  const sourceToken = await globalThis.fromUuid?.(state.sourceTokenUuid);
  const item = await originItem(document);
  const activity = activityByKey(item, "wardingBondDamage");
  if (!sourceToken || !item || visited.includes(sourceToken.actor?.uuid)) return;
  const data = activity
    ? globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(activity, String(amount), {types: [workflow.defaultDamageType ?? "force"]})
    : null;
  if (!data) return;
  const typed = values(ditem.damageDetail).filter(part => Number(part.value) > 0 && !["none", "healing", "temphp", "maximum", "vitality", "midi-none"].includes(part.type));
  const total = typed.reduce((sum, part) => sum + Number(part.value), 0);
  if (total > 0 && data.damage) {
    let assigned = 0;
    data.damage.parts = typed.map((part, index) => {
      const value = index === typed.length - 1 ? amount - assigned : Math.floor(amount * Number(part.value) / total);
      assigned += value;
      return {number: null, denomination: 0, bonus: "", types: [part.type], custom: {enabled: true, formula: String(value)}, scaling: {mode: "", number: null}};
    });
  }
  (workflow.khuzoeWardingTransfers ??= []).push({data, item, sourceToken, visited: [...visited, document.parent?.uuid, sourceToken.actor?.uuid].filter(Boolean)});
}

export async function resolveWardingBondTransfers(workflow) {
  const queue = workflow?.khuzoeWardingTransfers;
  if (!queue?.length) return;
  workflow.khuzoeWardingTransfers = [];
  for (const entry of queue) await runSyntheticActivityData(entry.data, entry.item, [entry.sourceToken], {
    options: {workflowOptions: {targetConfirmation: "none", khuzoeWardingBond: true, khuzoeWardingVisited: entry.visited}}
  });
}

export async function expandedEffectDamageRoll({document, workflow} = {}) {
  const state = effectState(document);
  if (!document || !workflow) return;
  if (state.identifier === "tashas-otherworldly-guise" && state.kind === "self-buff" && isWeaponAttack(workflow)) {
    const rolls = values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll]);
    for (const roll of rolls) {
      roll.options ??= {};
      const properties = roll.options.properties;
      if (properties instanceof Set) properties.add("mgc");
      else roll.options.properties = [...new Set([...(Array.isArray(properties) ? properties : []), "mgc"])];
    }
    if (rolls.length && workflow.setDamageRolls) await workflow.setDamageRolls(rolls);
    return;
  }
  if (state.identifier === "lightning-arrow" && state.kind === "weapon-trigger" && isWeaponAttack(workflow, {ranged: true})) {
    const formula = `${Math.max(2, 1 + Number(state.castLevel ?? 3)) * (workflow.isCritical ? 2 : 1)}d8`;
    const roll = await new CONFIG.Dice.DamageRoll(formula, workflow.item.getRollData(), {type: "lightning"}).evaluate();
    if (workflow.setDamageRolls) await workflow.setDamageRolls([roll]);
    return;
  }
  if (state.identifier !== "ray-of-enfeeblement" || state.kind !== "enfeebled" || workflow.item?.type !== "weapon") return;
  if (workflowAttackAbility(workflow) !== "str") return;
  const sourceRolls = values(workflow.damageRolls?.length ? workflow.damageRolls : [workflow.damageRoll]);
  const rolls = [];
  for (const roll of sourceRolls) {
    rolls.push(await new CONFIG.Dice.DamageRoll(String(Math.floor(Number(roll.total) / 2)), workflow.item.getRollData(), roll.options).evaluate());
  }
  if (rolls.length && workflow.setDamageRolls) await workflow.setDamageRolls(rolls);
}

export function expandedEffectAttackContext({document, workflow} = {}) {
  const state = effectState(document);
  if (!document || !workflow) return;
  if (state.identifier === "lightning-arrow" && state.kind === "weapon-trigger" && isWeaponAttack(workflow, {ranged: true})) {
    workflow.workflowOptions ??= {};
    workflow.workflowOptions.autoRollDamage = "always";
  }
  if (state.identifier === "tashas-otherworldly-guise" && state.kind === "self-buff" && isWeaponAttack(workflow)) {
    const ability = String(workflow.actor?.system?.attributes?.spellcasting ?? "");
    const currentAbility = workflow.activity?.ability ?? workflowAttackAbility(workflow);
    const abilities = workflow.actor?.system?.abilities ?? {};
    if (ability && Number(abilities[ability]?.mod ?? -Infinity) > Number(abilities[currentAbility]?.mod ?? -Infinity)) replaceWorkflowActivity(workflow, activity => {
      if (activity.attack) activity.attack.ability = ability;
    });
  }
  if (state.identifier !== "chill-touch" || state.kind !== "chill-touch" || !state.undead) return;
  const targetsCaster = targetDocuments(workflow).some(target => sameTokenReference(state.casterUuid, target.actor?.uuid) || state.casterUuid === target.actor?.uuid);
  if (targetsCaster) workflow.disadvantage = true;
}

export async function expandedEffectTurnStart({document, actor} = {}) {
  const state = effectState(document);
  actor ??= document?.parent;
  if (!document || !actor || state.identifier !== "heroism" || state.kind !== "heroism") return;
  const amount = Math.max(0, Number(state.amount ?? 0));
  const current = Number(actor.system?.attributes?.hp?.temp ?? 0);
  if (amount > current) await grantTemporaryHP(actor, amount, document);
}

export async function expandedSceneTurnStart({document, token} = {}) {
  const state = effectState(document);
  const target = tokenDocument(token);
  if (state.identifier !== "spirit-shroud" || state.kind !== "self-buff" || !isAuraCreature(target)) return;
  const item = await originItem(document), source = tokenDocument(actorToken(document.parent));
  if (!item || !isAuraCreature(source) || source.uuid === target.uuid || !sameScene(source, target)
    || circularAuraTokenDistance(source, target) > 10 + 1e-6) return;
  if (globalThis.MidiQOL?.canSee && !MidiQOL.canSee(source.object ?? source, target.object ?? target)) return;
  const selected = await cat.utils.dialogUtils.confirm(item.name, `${target.name} inizia il turno entro 10 piedi: ridurre la sua velocità di 10 piedi?`,
    {userId: cat.utils.queryUtils.firstOwner(item.actor, true)});
  if (!selected) return;
  const effects = await createEffect(target.actor, item, {identifier: "spirit-shroud-slow", state: {kind: "slow"},
    seconds: 12, specialDuration: ["turnStartSource"],
    effectChanges: changes({key: "system.attributes.movement.all", value: "-10"}), macroGroups: []});
  if (effects?.length) await cat.utils.documentUtils.makeDependent(document, effects);
}

async function flameHeat(effect, target, phase = "move", context = {}) {
  const state = effectState(effect);
  if (state.identifier !== "investiture-of-flame" || state.kind !== "self-buff" || effect.disabled || effect.isSuppressed) return;
  const source = tokenDocument(actorToken(effect.parent));
  target = tokenDocument(target);
  if (!source || !target?.actor || source.uuid === target.uuid || !sameScene(source, target)
    || cat.utils.tokenUtils.getDistance(source, target) > 5) return;
  return withDocumentLock(effect, `heat:${target.uuid}`, async () => {
    const stamp = `${combatTurnKey(context) ?? game.time.worldTime}:${phase}`;
    const stamps = effectState(effect).heatStamps ?? {};
    const key = `${target.uuid}:${phase}`;
    if (stamps[key] === stamp) return;
    const item = await originItem(effect);
    if (!item) return;
    const result = await rollDamageAgainst(item, target, "1d10", "fire");
    if (!result || result.aborted) return false;
    // Movement and end of turn are distinct triggers. Commit only after damage
    // succeeds, and keep the other phase's receipt for this same turn.
    const current = effectState(effect).heatStamps ?? {};
    await updateDocumentSafely(effect, {[`flags.${MODULE_ID}.${EFFECT_FLAG}.heatStamps`]: {
      ...Object.fromEntries(Object.entries(current).filter(([, value]) => value.slice(0, value.lastIndexOf(":")) === stamp.slice(0, stamp.lastIndexOf(":")))), [key]: stamp
    }});
    return true;
  });
}

export async function expandedFlameMotion(token) {
  if (!isCombatExecutor() || !token?.parent) return;
  const seen = new Set();
  for (const candidate of values(token.parent.tokens)) {
    if (!candidate.actor || seen.has(candidate.actor.uuid)) continue;
    seen.add(candidate.actor.uuid);
    for (const effect of values(candidate.actor.effects)) await flameHeat(effect, token);
  }
}

function sameScene(first, second) {
  first = tokenDocument(first);
  second = tokenDocument(second);
  return Boolean(first?.parent?.id && first.parent.id === second?.parent?.id);
}

async function removeWardingTargetFromSource(sourceEffect, targetUuid) {
  if (!sourceEffect) return false;
  const remaining = (effectState(sourceEffect).targetUuids ?? []).filter(uuid => uuid !== targetUuid);
  if (!remaining.length) {
    await removeEffect(sourceEffect);
    return true;
  }
  await updateDocumentSafely(sourceEffect, {
    [`flags.${MODULE_ID}.${EFFECT_FLAG}.targetUuids`]: remaining
  });
  return false;
}

export async function expandedEffectMoved({document, token} = {}) {
  const state = effectState(document);
  if (!document || state.identifier !== "warding-bond") return;
  const movedToken = tokenDocument(token) ?? actorToken(document.parent);
  if (!movedToken) return;
  const maximum = Math.max(0, Number(state.maxDistance ?? 60));

  if (state.kind === "bond-target") {
    const sourceToken = await globalThis.fromUuid?.(state.sourceTokenUuid);
    if (sourceToken && sameScene(sourceToken, movedToken)
      && globalThis.cat.utils.tokenUtils.getDistance(sourceToken, movedToken, {wallsBlock: false}) <= maximum) return;
    const sourceEffect = state.sourceEffectUuid ? await globalThis.fromUuid?.(state.sourceEffectUuid) : null;
    const removedWithSource = await removeWardingTargetFromSource(sourceEffect, movedToken.uuid);
    if (removedWithSource) return;
    if (document.parent) await removeEffect(document);
    return;
  }

  if (state.kind !== "bond-source") return;
  const remaining = [];
  const removedTargets = [];
  for (const uuid of state.targetUuids ?? []) {
    const target = await globalThis.fromUuid?.(uuid);
    const inRange = target && sameScene(movedToken, target)
      && globalThis.cat.utils.tokenUtils.getDistance(movedToken, target, {wallsBlock: false}) <= maximum;
    if (inRange) {
      remaining.push(uuid);
      continue;
    }
    const targetEffect = target?.actor
      ? effectByState(target.actor, "warding-bond", current => current.kind === "bond-target" && current.sourceEffectUuid === document.uuid)
      : null;
    if (targetEffect) removedTargets.push(targetEffect);
  }
  if (!remaining.length) return removeEffect(document);
  for (const targetEffect of removedTargets) await removeEffect(targetEffect);
  if (remaining.length !== (state.targetUuids ?? []).length) {
    await updateDocumentSafely(document, {
      [`flags.${MODULE_ID}.${EFFECT_FLAG}.targetUuids`]: remaining
    });
  }
}

export async function expandedEffectDeleted({document, actor} = {}) {
  const state = effectState(document);
  actor ??= document?.parent;
  if (!document || !actor) return;
  if (state.identifier === "heroism" && state.kind === "heroism") {
    await removeOwnedTemporaryHP(actor, document);
  }
  if (state.kind === "generated-item" && state.itemUuid) {
    const generated = await globalThis.fromUuid?.(state.itemUuid);
    if (generated) await globalThis.cat.utils.documentUtils.deleteDocument(generated);
  }
  if (state.kind === "size") {
    for (const snapshot of state.tokenSnapshots ?? []) {
      const token = await globalThis.fromUuid?.(snapshot.uuid);
      if (!token) continue;
      const category = actor.system?.traits?.size;
      if (category && category !== state.oldSize) {
        await updateDocumentSafely(token, tokenSizeForCategory(category));
        continue;
      }
      await updateDocumentSafely(token, {
        width: snapshot.width,
        height: snapshot.height,
        "texture.scaleX": snapshot.scaleX,
        "texture.scaleY": snapshot.scaleY
      });
    }
  }
  if (state.kind === "voluntary-fail" && state.identifier?.endsWith?.("-consent")) return;
}

export function registerExpandedSpells2014(api) {
  const macros = [];
  for (const spell of EXPANDED_SPELL_CATALOG) {
    macros.push(api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: spell.identifier,
      roll: [
        {pass: "itemPreambleComplete", macro: prepareExpandedSpell, priority: 20},
        {pass: "itemDamage", macro: adjustExpandedSpellTargetDamage, priority: 20},
        {pass: "itemDamageRoll", macro: modifyExpandedSpellDamage, priority: 40},
        {pass: "itemDamageRollBonuses", macro: addExpandedSpellDamage, priority: 50},
        {pass: "itemRollFinished", macro: finishExpandedSpell, priority: 80}
      ]
    }));
  }
  macros.push(api.registerFnMacro({
    source: MODULE_ID,
    rules: RULES,
    identifier: EFFECT_HANDLER,
    roll: [
      {pass: "actorDamageRoll", macro: expandedEffectDamageRoll, priority: 40},
      {pass: "actorAttackRollConfig", macro: expandedEffectAttackContext, priority: 40},
      {pass: "actorDamageRollBonuses", macro: expandedEffectDamageBonuses, priority: 50},
      {pass: "targetOnHit", macro: expandedEffectOnHit, priority: 200},
      {pass: "targetDamageFlatReductions", macro: expandedEffectFlatReduction, priority: 210},
      {pass: "targetDamageBonuses", macro: expandedEffectDamageItem, priority: 220},
      {pass: "targetDamageComplete", macro: expandedEffectDamageComplete, priority: 240}
    ],
    combat: [
      {pass: "actorTurnStart", macro: expandedEffectTurnStart, priority: 50},
      {pass: "sceneTurnStart", macro: expandedSceneTurnStart, priority: 50, canOverlap: true},
      {pass: "sceneTurnEnd", macro: context => flameHeat(context.document, context.token, "end", context), priority: 50, canOverlap: true}
    ],
    effect: [
      {pass: "deleted", macro: expandedEffectDeleted, priority: 80}
    ],
    move: [
      {pass: "actorMoved", macro: expandedEffectMoved, priority: 50}
    ],
    aura: [
      {pass: "update", macro: createExpandedAuraTarget, priority: 50, distance: 30, dispositions: ["ally"]}
    ]
  }));
  return {
    macros,
    automations: EXPANDED_SPELL_AUTOMATIONS.map(data => api.registerAutomation(data))
  };
}
