import {withDocumentLock} from "./operation-locks.mjs";
import {circularAuraTokenDistance} from "./geometry.mjs";
import {isAuraCreature} from "./aura-targeting.mjs";
import {RELEASE_VERSION} from "./release.mjs";
import {adjustAppliedDamage, appliedDamageAmount, damageDealt} from "./damage-adjustment.mjs";
import {distanceInScene} from "./movement-compat.mjs";
import {weaponCantripAttack} from "./weapon-cantrips.mjs";
import {healActor} from "./healing.mjs";
import {runSyntheticActivityData, runSyntheticActivity, runSnapshotActivityData} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item";
const GUARDIAN_ACTOR_UUID = "Compendium.khuzoe-automations.KhuzoeSummons2014.Actor.KhzGuardianAct01";
const GUARDIAN_TOKEN_IMAGE_SETTING = "guardianOfFaithTokenImage";
const GUARDIAN_DEFAULT_TOKEN_IMAGE = "icons/magic/holy/angel-winged-humanoid-blue.webp";
const AURA_VITALITY_HEAL_IDENTIFIER = "aura-of-vitality-healing";
const PROTECTION_CREATURE_TYPES = new Set(["aberration", "celestial", "elemental", "fey", "fiend", "undead"]);

export const SPELL_2014_IDS = Object.freeze({
  boomingBlade: "booming-blade",
  protectionEvilGood: "protection-from-evil-and-good",
  sanctuary: "sanctuary",
  shieldOfFaith: "shield-of-faith",
  shield: "shield",
  aid: "aid",
  auraVitality: "aura-of-vitality",
  guardianFaith: "guardian-of-faith",
  auraLife: "aura-of-life",
  deathWard: "death-ward",
  circlePower: "circle-of-power"
});

export const SPELL_2014_ACTIVITY_IDS = Object.freeze({
  boomingCast: "KhzBoomCast00001",
  boomingHit: "KhzBoomHit000001",
  boomingMoved: "KhzBoomMove00001",
  sanctuaryCast: "KhzSancCast00001",
  sanctuarySave: "KhzSancSave00001",
  aidCast: "KhzAidCast000001",
  auraVitalityCast: "KhzVitalCast0001",
  auraVitalityHeal: "KhzVitalHeal0001",
  guardianCast: "KhzGuardCast0001",
  guardianDamage: "KhzGuardDmg00001",
  auraLifeCast: "KhzLifeCast00001",
  deathWardCast: "KhzDeathCast0001",
  circlePowerCast: "KhzCircleCast001"
});

export const SPELL_2014_EFFECT_IDS = Object.freeze({
  boomingMoved: "khuzoe-booming-blade-moved",
  protection: "khuzoe-protection-evil-good",
  shield: "khuzoe-shield-active",
  sanctuarySafe: "khuzoe-sanctuary-safe",
  aid: "khuzoe-aid",
  auraVitality: "khuzoe-aura-vitality",
  guardianActive: "khuzoe-guardian-faith-active",
  auraLifeSource: "khuzoe-aura-life-source",
  auraLifeTarget: "khuzoe-aura-life-target",
  deathWard: "khuzoe-death-ward",
  circlePowerSource: "khuzoe-circle-power-source",
  circlePowerTarget: "khuzoe-circle-power-target"
});

const DOCUMENTS = Object.freeze([
  [SPELL_2014_IDS.boomingBlade, "KhzBoomBlade1401", "Sceglie un'arma da mischia equipaggiata, risolve l'attacco e gestisce sia il danno iniziale sia quello causato dal movimento volontario."],
  [SPELL_2014_IDS.protectionEvilGood, "KhzProtEvil14001", "Applica lo svantaggio agli attacchi dei tipi di creatura previsti e propone il vantaggio ai tiri salvezza pertinenti."],
  [SPELL_2014_IDS.sanctuary, "KhzSanctuary1401", "Richiede il tiro salvezza dell'attaccante e rimuove Sanctuary quando il protetto attacca o influenza un nemico con un incantesimo."],
  [SPELL_2014_IDS.shieldOfFaith, "KhzShieldFaith01", "Applica +2 alla CA e collega l'effetto alla concentrazione."],
    [SPELL_2014_IDS.shield, "KhzShieldSpell01", "Gestisce la reazione, applica +5 alla CA fino all'inizio del turno successivo e annulla Magic Missile."],
  [SPELL_2014_IDS.aid, "KhzAidSpell14001", "Aumenta punti ferita attuali e massimi di tre creature, con incremento corretto per lo slot usato e ripristino alla scadenza."],
  [SPELL_2014_IDS.auraVitality, "KhzAuraVitality1", "Rende disponibile l'attività bonus da 2d6 cure soltanto mentre l'aura e la concentrazione sono attive."],
  [SPELL_2014_IDS.guardianFaith, "KhzGuardianFth01", "Evoca il guardiano, risolve il tiro salvezza entro 10 ft una volta per turno e lo rimuove dopo 60 danni inflitti."],
  [SPELL_2014_IDS.auraLife, "KhzAuraLife14001", "Gestisce resistenza necrotica, protezione dalle riduzioni dei PF massimi e recupero a 1 PF a inizio turno entro 30 ft."],
  [SPELL_2014_IDS.deathWard, "KhzDeathWard1401", "Intercetta il danno letale, lascia il bersaglio a 1 PF e consuma l'effetto."],
  [SPELL_2014_IDS.circlePower, "KhzCirclePower01", "Gestisce vantaggio ai tiri salvezza e annulla il danno dimezzato dopo un tiro riuscito contro magie entro 30 ft."]
]);

export const SPELLS_2014_AUTOMATIONS = DOCUMENTS.map(([identifier, id, notes]) => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier,
  version: VERSION,
  uuid: `${PACK}.${id}`,
  type: "spell",
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

function tokenDocument(token) {
  return token?.document ?? token;
}

function targetDocuments(workflow, key = "targets") {
  return values(workflow?.[key]).map(tokenDocument).filter(token => token?.actor);
}

function sameToken(left, right) {
  left = tokenDocument(left);
  right = tokenDocument(right);
  if (!left || !right) return false;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return Boolean(left.id && right.id && left.id === right.id && left.parent?.id === right.parent?.id);
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

function effectDuration(seconds, expiry = "turnStart") {
  return {value: seconds, units: "seconds", expiry, expired: false};
}

export function prepareShieldEffectExpiry(effect) {
  const actor = effect?.parent;
  if (actor?.documentName !== "Actor" || effect.flags?.cat?.identifier !== SPELL_2014_EFFECT_IDS.shield) return;
  const combat = [globalThis.game?.combat, ...values(globalThis.game?.combats)]
    .find(candidate => candidate?.started && candidate.getCombatantsByActor?.(actor)?.length);
  const combatant = combat?.getCombatantsByActor(actor)?.[0];
  const special = effect.flags?.dae?.specialDuration;
  const changes = {
    "duration.expiry": "turnStart",
    "duration.expired": false,
    "duration.units": combatant ? "turns" : "seconds",
    "duration.value": combatant ? 1 : 6,
    "flags.dae.specialDuration": (Array.isArray(special) ? special : [])
      .filter(value => !["turnStartSource", "turnStart"].includes(value))
  };
  if (combatant) Object.assign(changes, {
    // Count from the casting turn, but expire only at the Shield owner's start.
    // Six elapsed seconds would miss a next turn later in this same round.
    "start.combat": combat.id,
    "start.combatant": combatant.id,
    "start.round": combat.round,
    "start.turn": combat.turn,
    "start.initiative": combatant.initiative
  });
  effect.updateSource(changes);
}

function castLevel(workflow) {
  const level = Number(
    workflow?.castData?.castLevel
    ?? workflow?.workflowOptions?.castData?.castLevel
    ?? workflow?.item?.system?.level
    ?? 1
  );
  return Number.isFinite(level) ? Math.max(1, level) : 1;
}

function actorLevel(actor, spell) {
  const native = actor?.system?.cantripLevel?.(spell);
  if (Number.isFinite(native) && native >= 0) return native;
  const direct = Number(actor?.system?.details?.level ?? actor?.system?.details?.cr ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const classLevels = values(actor?.classes).reduce((total, cls) => total + Number(cls?.system?.levels ?? 0), 0);
  if (Number.isFinite(classLevels) && classLevels > 0) return classLevels;
  const fromCat = Number(globalThis.cat.utils.actorUtils.getLevelOrCR?.(actor));
  return Number.isFinite(fromCat) && fromCat >= 0 ? fromCat : 0;
}

const boomingMovementDice = level => 1 + [5, 11, 17].filter(threshold => level >= threshold).length;

function savedBoomingMovementDice(effect, spell) {
  const saved = effect.flags?.[MODULE_ID]?.boomingBlade;
  if (Number.isFinite(saved?.casterLevel) && saved.casterLevel >= 0) return boomingMovementDice(saved.casterLevel);
  // Earlier Khuzoe effects already saved the dice; retain their cast-time value.
  const dice = Number(saved?.dice);
  if (Number.isInteger(dice) && dice >= 1 && dice <= 4) return dice;
  return boomingMovementDice(actorLevel(spell.actor, spell));
}

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function effectByIdentifier(actor, identifier) {
  return values(actor?.effects).find(effect => effect?.flags?.cat?.identifier === identifier);
}

async function removeEffect(effect) {
  if (!effect) return;
  try {
    await globalThis.cat.utils.documentUtils.deleteDocument(effect);
  } catch (error) {
    if (!/ActiveEffect .* does not exist/i.test(String(error?.message ?? error))) throw error;
  }
}

async function createEffects(actor, effectDatas, {concentrationItem, activity, unhideActivities} = {}) {
  if (activity?.uuid) {
    for (const effectData of effectDatas) {
      effectData.flags ??= {};
      effectData.flags.cat ??= {};
      effectData.flags.cat.activityUuid = activity.uuid;
    }
  }
  const created = await globalThis.cat.utils.effectUtils.createEffects(actor, effectDatas, {
    rules: RULES,
    unhideActivities
  });
  if (!created?.length || !concentrationItem) return created ?? [];
  const concentration = globalThis.cat.utils.effectUtils.getConcentrationEffect(actor, concentrationItem);
  if (concentration) await globalThis.cat.utils.documentUtils.makeDependent(concentration, created);
  return created;
}

function hasMeleeAttack(item) {
  return values(item?.system?.activities).some(activity =>
    activity?.type === "attack" && (activity?.actionType ?? activity?.attack?.type?.value) === "mwak"
  );
}

function equippedMeleeWeapons(actor) {
  return values(actor?.items).filter(item => item?.type === "weapon" && item.system?.equipped && hasMeleeAttack(item));
}

function sameTokenReference(left, right) {
  right = tokenDocument(right);
  if (!left || !right) return false;
  if (typeof left === "string") return left === right.uuid || left === right.id;
  left = tokenDocument(left);
  if (!left) return false;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return Boolean(left.id && right.id && left.id === right.id && left.parent?.id === right.parent?.id);
}

function workflowHitTarget(workflow, target) {
  if (!workflow || workflow.aborted) return false;
  const hitFields = ["hitTargets", "hitTargetsEC", "hitTargetUuids", "hitTargetsUuids", "hitTargetUuidsEC", "hitECTargetUuids"];
  const candidates = [
    ...values(workflow?.hitTargets),
    ...values(workflow?.hitTargetsEC),
    ...values(workflow?.hitTargetUuids),
    ...values(workflow?.hitTargetsUuids),
    ...values(workflow?.hitTargetUuidsEC),
    ...values(workflow?.hitECTargetUuids)
  ];
  if (candidates.some(candidate => sameTokenReference(candidate, target))) return true;
  // CAT/Midi may return plain hit records rather than Token references. Booming
  // Blade is constrained to a single target, so any recorded hit is that target.
  if (candidates.length > 0 && targetDocuments(workflow).length <= 1) return true;
  // An explicitly empty collection is Midi's resolved miss, including reactions.
  if (hitFields.some(key => workflow[key] != null)) return false;

  // When CAT executes the synthetic item for another owning user, some Midi
  // versions serialize the roll totals but omit the hit collections. Preserve
  // Midi's critical/fumble result and use the resolved attack total as the
  // deterministic fallback for the spell's single target.
  const attackTotal = Number(workflow?.attackTotal ?? workflow?.attackRoll?.total);
  const targetAC = Number(tokenDocument(target)?.actor?.system?.attributes?.ac?.value);
  return Number.isFinite(attackTotal)
    && Number.isFinite(targetAC)
    && !workflow?.isFumble
    && (Boolean(workflow?.isCritical) || attackTotal >= targetAC);
}

function setDamageFormula(activityData, formula) {
  const part = activityData?.damage?.parts?.[0];
  if (!part) return false;
  part.custom = {enabled: true, formula};
  part.number = null;
  part.denomination = 0;
  return true;
}

export async function useBoomingBlade({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  const actor = spell?.actor ?? workflow?.actor;
  const targets = targetDocuments(workflow);
  if (!spell || !actor || workflow?.activity?.id !== SPELL_2014_ACTIVITY_IDS.boomingCast || targets.length !== 1) return;

  const level = actorLevel(actor, spell);
  const initialDice = boomingMovementDice(level) - 1;
  const attack = await weaponCantripAttack(workflow, spell, {dice: initialDice, damageType: "thunder"});
  if (!attack) {
    ui.notifications.warn(`${spell.name}: CAT non ha restituito il workflow dell'attacco.`);
    return;
  }
  if (!workflowHitTarget(attack, targets[0])) return;

  const existing = effectByIdentifier(targets[0].actor, SPELL_2014_EFFECT_IDS.boomingMoved);
  if (existing) await removeEffect(existing);
  const movementDice = initialDice + 1;
  await createEffects(targets[0].actor, [{
    name: spell.name,
    img: spell.img,
    origin: spell.uuid,
    type: "base",
    duration: effectDuration(12),
    description: `<p>Se ${escapeHtml(targets[0].name)} si muove volontariamente prima dell'inizio del prossimo turno dell'incantatore, subisce <strong>${movementDice}d8</strong> danni da tuono.</p>`,
    showIcon: 1,
    flags: {
      cat: {
        identifier: SPELL_2014_EFFECT_IDS.boomingMoved,
        macros: {move: [macroReference(SPELL_2014_EFFECT_IDS.boomingMoved)]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: ["turnStartSource"], expiryMode: "delete"},
      [MODULE_ID]: {boomingBlade: {dice: movementDice, casterLevel: level}}
    }
  }]);


}

export async function triggerBoomingBladeMovement({document, token, options, teleport} = {}) {
  if (teleport || options?.teleport || !document?.parent) return;
  return withDocumentLock(document, "booming-movement", async () => {
  if (document.deleted || document.disabled || document.isSuppressed || document.duration?.expired
      || (document.parent.effects?.get && !document.parent.effects.get(document.id))) return false;
  const actor = document.parent;
  const movedToken = tokenDocument(token) ?? globalThis.cat.utils.actorUtils.getFirstToken(actor);
  if (!movedToken) return;
  const willing = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    `<p>Il movimento di <strong>${escapeHtml(actor.name)}</strong> è volontario, di almeno 5 piedi, e deve attivare Booming Blade?</p>`,
    {userId: ownerUserId(actor)}
  );
  if (!willing) return;
  const spell = await fromUuid(document.origin);
  const activity = itemActivity(spell, SPELL_2014_ACTIVITY_IDS.boomingMoved);
  if (!spell || !activity) return;
  const activityData = activity.toObject();
  const dice = savedBoomingMovementDice(document, spell);
  if (!setDamageFormula(activityData, `${dice}d8`)) return;
  const result = await runSnapshotActivityData(activityData, spell, [movedToken], {
    userId: ownerUserId(spell.actor)
  });
  if (!result || result.aborted) return false;
  await removeEffect(document);
  return true;
  });
}

function sourceCreatureType(actor) {
  return String(
    globalThis.cat.utils.actorUtils.typeOrRace?.(actor)
    ?? actor?.system?.details?.type?.value
    ?? ""
  ).trim().toLowerCase();
}

function workflowConditionContext(workflow) {
  const statuses = values(workflow?.activity?.effects).flatMap(reference => {
    const effect = reference?.statuses
      ? reference
      : workflow?.item?.effects?.get?.(reference?._id ?? reference?.id ?? reference);
    return values(effect?.statuses);
  });
  return [
    workflow?.activity?.name,
    workflow?.item?.name,
    workflow?.activity?.description?.chatFlavor,
    workflow?.item?.system?.description?.value,
    ...statuses
  ].filter(Boolean).join(" ").toLowerCase();
}

export function protectionSaveAdvantage({workflow} = {}) {
  if (!workflow || !PROTECTION_CREATURE_TYPES.has(sourceCreatureType(workflow.actor))) return;
  if (!/(charm|charmed|fright|frightened|possess|paura|affascinat)/i.test(workflowConditionContext(workflow))) return;
  return {label: "Protection from Evil and Good", type: "advantage"};
}

export function blockMagicMissile({workflow, ditem} = {}) {
  const identifier = String(workflow?.item?.system?.identifier ?? "").toLowerCase();
  const name = String(workflow?.item?.name ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
  if (!ditem || (identifier !== "magic-missile" && name !== "magic-missile")) return;
  const damage = Math.max(0, Number(ditem.hpDamage ?? 0) + Number(ditem.tempDamage ?? 0));
  if (damage > 0) adjustAppliedDamage(ditem, -damage);
}

export async function applySanctuary({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell) return;
  for (const target of targetDocuments(workflow)) {
    const existing = effectByIdentifier(target.actor, SPELL_2014_EFFECT_IDS.sanctuarySafe);
    if (existing) await removeEffect(existing);
    await createEffects(target.actor, [{
      name: spell.name,
      img: spell.img,
      origin: spell.uuid,
      type: "base",
      duration: effectDuration(60),
      showIcon: 1,
      flags: {
        cat: {
          identifier: SPELL_2014_EFFECT_IDS.sanctuarySafe,
          macros: {roll: [macroReference(SPELL_2014_EFFECT_IDS.sanctuarySafe)]}
        },
        dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
      }
    }]);
  }
}

function isAreaActivity(activity) {
  return Boolean(activity?.target?.template?.type || activity?.target?.template?.size);
}

function hostile(sourceToken, targetToken) {
  sourceToken = tokenDocument(sourceToken);
  targetToken = tokenDocument(targetToken);
  if (!sourceToken || !targetToken) return true;
  return globalThis.cat.utils.tokenUtils.isEnemy(sourceToken, targetToken);
}

export async function sanctuaryTargeted({document, workflow} = {}) {
  if (!document || !workflow || workflow.activity?.id === SPELL_2014_ACTIVITY_IDS.sanctuarySave) return;
  if (isAreaActivity(workflow.activity)) return;
  const allTargets = targetDocuments(workflow);
  const protectedToken = allTargets.find(target => target?.actor?.id === document.parent?.id);
  const attacker = tokenDocument(workflow.token);
  if (!attacker || !protectedToken) return;
  const harmful = workflow.activity?.type === "attack" || ["mwak", "rwak", "msak", "rsak"].includes(workflow.activity?.actionType)
    || workflow.item?.type === "spell" && (workflow.activity?.type === "save" || workflow.activity?.type === "damage");
  if (!harmful) return;

  const spell = await fromUuid(document.origin);
  const save = itemActivity(spell, SPELL_2014_ACTIVITY_IDS.sanctuarySave);
  if (!spell || !save) return;
  const result = await runSyntheticActivity(save, [attacker], {
    consumeUsage: false,
    consumeResources: false,
    spellSlot: false,
    userId: ownerUserId(spell.actor)
  });
  if (!result || result.aborted) { workflow.aborted = true; return; }
  if (!targetDocuments(result, "failedSaves").some(target => sameToken(target, attacker))) return;
  const remaining = allTargets.filter(target => !sameToken(target, protectedToken));
  const candidates = values(attacker.parent?.tokens).filter(target => target.actor && !sameToken(target, protectedToken)
    && !sameToken(target, attacker) && !remaining.some(current => sameToken(current, target)));
  if (candidates.length) {
    const choice = await globalThis.cat.utils.dialogUtils.selectTargetDialog(spell.name,
      "Sanctuary: scegli un nuovo bersaglio oppure annulla l’attacco contro il protetto.", candidates,
      {type: "one", userId: ownerUserId(workflow.actor)});
    const replacement = tokenDocument(choice?.result);
    if (replacement) remaining.push(replacement);
  }
  if (remaining.length) await globalThis.cat.utils.workflowUtils.updateTargets(workflow, remaining);
  else workflow.aborted = true;
  ui.notifications.info(`${workflow.item?.name ?? "L'azione"} viene fermata da Sanctuary.`);
}

export async function removeSanctuaryAfterAction({document, workflow} = {}) {
  if (!document || !workflow || workflow.actor?.id !== document.parent?.id) return;
  if (workflow.activity?.id === SPELL_2014_ACTIVITY_IDS.sanctuarySave) return;
  const actionType = workflow.activity?.actionType;
  const attack = workflow.activity?.type === "attack" || ["mwak", "rwak", "msak", "rsak"].includes(actionType);
  const hostileSpell = workflow.item?.type === "spell"
    && targetDocuments(workflow).some(target => hostile(tokenDocument(workflow.token), target));
  const dealtDamage = values(workflow.damageList).some(entry => Number(entry.hpDamage ?? 0) + Number(entry.tempDamage ?? 0) > 0);
  if (attack || hostileSpell || dealtDamage) await removeEffect(document);
}

export function preventProtectedConditions(effect) {
  const actor = effect?.parent?.actor ?? effect?.parent;
  const protection = effectByIdentifier(actor, SPELL_2014_EFFECT_IDS.protection);
  if (!protection || protection.disabled || protection.isSuppressed || protection.active === false || protection.duration?.expired) return;
  if (!values(effect.statuses).some(status => ["charmed", "frightened", "possessed"].includes(status))) return;
  const source = effect.origin ? globalThis.fromUuidSync?.(effect.origin, {strict: false}) : null;
  const attacker = source?.actor ?? (source?.documentName === "Actor" ? source : null);
  if (attacker && PROTECTION_CREATURE_TYPES.has(sourceCreatureType(attacker))) return false;
}

async function applyOrUpgradeAid(targetActor, spell, amount) {
  const existing = effectByIdentifier(targetActor, SPELL_2014_EFFECT_IDS.aid);
  const currentAmount = Number(existing?.flags?.[MODULE_ID]?.aid?.amount ?? 0);
  if (existing && currentAmount > amount) return existing;
  const increase = amount - currentAmount;
  const data = {
    name: spell.name,
    img: spell.img,
    origin: spell.uuid,
    type: "base",
    system: {changes: [{key: "system.attributes.hp.tempmax", value: String(amount), priority: 20, type: "add"}]},
    duration: effectDuration(28800),
    showIcon: 1,
    flags: {
      cat: {
        identifier: SPELL_2014_EFFECT_IDS.aid,
        macros: {effect: [macroReference(SPELL_2014_EFFECT_IDS.aid)]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
      [MODULE_ID]: {aid: {amount}}
    }
  };
  if (existing) {
    await updateDocumentSafely(existing, {
      origin: spell.uuid,
      "system.changes": data.system.changes,
      duration: data.duration,
      [`flags.${MODULE_ID}.aid.amount`]: amount
    });
  } else {
    await createEffects(targetActor, [data]);
  }
  const hp = targetActor.system?.attributes?.hp ?? {};
  await updateDocumentSafely(targetActor, {
    "system.attributes.hp.value": Math.max(0, Number(hp.value ?? 0) + increase)
  });
  return existing;
}

export async function applyAid({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell) return;
  const amount = 5 * Math.max(1, castLevel(workflow) - 1);
  const actors = [...new Set(targetDocuments(workflow).slice(0, 3).map(target => target.actor))];
  await Promise.all(actors.map(actor => withDocumentLock(actor, "aid", () => applyOrUpgradeAid(actor, spell, amount))));
}

export async function removeAidHitPoints({document, actor} = {}) {
  actor ??= document?.parent;
  if (!actor || document?.flags?.cat?.identifier !== SPELL_2014_EFFECT_IDS.aid) return;
  const amount = Number(document.flags?.[MODULE_ID]?.aid?.amount ?? 0);
  if (amount <= 0) return;
  const current = Number(actor.system?.attributes?.hp?.value ?? 0);
  await updateDocumentSafely(actor, {
    "system.attributes.hp.value": Math.max(0, current - amount)
  });
}

async function createConcentrationSourceEffect({workflow, spell, identifier, seconds, auraIdentifier, unhideActivities = []}) {
  const actor = spell.actor ?? workflow.actor;
  const existing = effectByIdentifier(actor, identifier);
  if (existing) await removeEffect(existing);
  const flags = {
    cat: {
      identifier,
      activityUuid: workflow.activity?.uuid,
      ...(auraIdentifier ? {macros: {aura: [macroReference(auraIdentifier)]}} : {})
    },
    dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
  };
  const created = await createEffects(actor, [{
    name: spell.name,
    img: spell.img,
    origin: spell.uuid,
    type: "base",
    duration: effectDuration(seconds),
    showIcon: 1,
    flags
  }], {
    concentrationItem: spell,
    activity: workflow.activity,
    unhideActivities
  });
  return created?.[0];
}

export async function activateAuraVitality({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell || workflow?.activity?.id !== SPELL_2014_ACTIVITY_IDS.auraVitalityCast) return;
  return createConcentrationSourceEffect({
    workflow,
    spell,
    identifier: SPELL_2014_EFFECT_IDS.auraVitality,
    seconds: 60,
    unhideActivities: [AURA_VITALITY_HEAL_IDENTIFIER]
  });
}

export async function prepareAuraVitalityHealing({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  const activity = workflow?.activity;
  const identifier = activity?.midiProperties?.identifier
    ?? activity?.system?.midiProperties?.identifier
    ?? activity?.identifier;
  if (!spell || (activity?.id !== SPELL_2014_ACTIVITY_IDS.auraVitalityHeal && identifier !== AURA_VITALITY_HEAL_IDENTIFIER)) return;

  const selected = values(globalThis.game?.user?.targets).map(tokenDocument).filter(token => token?.actor);
  const targets = selected.length ? selected : targetDocuments(workflow);
  if (targets.length !== 1 || !isAuraCreature(targets[0])) {
    globalThis.ui?.notifications?.warn?.(`${spell.name}: seleziona esattamente una creatura da curare.`);
    return true;
  }

  const source = tokenDocument(workflow?.token ?? globalThis.cat?.utils?.actorUtils?.getFirstToken?.(spell.actor));
  const active = values(spell.actor?.effects).some(effect => effect.flags?.cat?.identifier === SPELL_2014_EFFECT_IDS.auraVitality
    && effect.active !== false && !effect.disabled);
  if (!active || !isAuraCreature(source) || circularAuraTokenDistance(source, targets[0]) > 30 + 1e-6) {
    globalThis.ui?.notifications?.warn?.(`${spell.name}: la cura richiede un'aura attiva e un bersaglio nel suo cerchio.`);
    return true;
  }
  await globalThis.cat.utils.workflowUtils.updateTargets(workflow, [targets[0]]);
}

const guardianLocks = new Map();

export function registerSpells2014Settings() {
  game.settings.register(MODULE_ID, GUARDIAN_TOKEN_IMAGE_SETTING, {
    name: "Guardian of Faith: immagine del token",
    hint: "Immagine usata dalle nuove evocazioni del guardiano. I guardiani già presenti sulla scena non vengono modificati.",
    scope: "world",
    config: true,
    type: String,
    default: GUARDIAN_DEFAULT_TOKEN_IMAGE,
    filePicker: "image",
    requiresReload: false
  });
}

function guardianTokenImage() {
  try {
    return String(game.settings.get(MODULE_ID, GUARDIAN_TOKEN_IMAGE_SETTING) || GUARDIAN_DEFAULT_TOKEN_IMAGE);
  } catch {
    return GUARDIAN_DEFAULT_TOKEN_IMAGE;
  }
}

function guardianStamp(target) {
  const combat = game.combat;
  if (combat?.started) return `${combat.id}:${combat.round}:${combat.turn}:${target.id}`;
  return `world:${Math.floor(Number(game.time?.worldTime ?? 0) / 6)}:${target.id}`;
}

export async function summonGuardianOfFaith({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  // L'attività tecnica di danno appartiene allo stesso incantesimo e genera a
  // sua volta itemRollFinished. Senza questo controllo CAT ricreerebbe il
  // summon, richiederebbe un nuovo piazzamento e azzererebbe i 60 danni.
  if (workflow?.activity?.id !== SPELL_2014_ACTIVITY_IDS.guardianCast) return;
  const actor = spell?.actor ?? workflow?.actor;
  const sourceActor = await fromUuid(GUARDIAN_ACTOR_UUID);
  const manager = globalThis.cat?.lib?.constants?.summons;
  if (!spell || !actor || !sourceActor || !manager) return;

  const saveDC = Number(workflow?.castData?.saveDC ?? actor.system?.attributes?.spell?.dc ?? actor.system?.attributes?.spelldc ?? 10);
  const reference = macroReference(SPELL_2014_EFFECT_IDS.guardianActive);
  const summon = await manager.createSummon(actor, sourceActor, Number(game.time?.worldTime ?? 0), {
    duration: 28800,
    sourceDocument: spell,
    name: `Guardian of Faith — ${actor.name}`,
    tokenImg: guardianTokenImage(),
    disposition: tokenDocument(workflow.token)?.disposition,
    dismissAtZero: false,
    updates: {
      flags: {
        cat: {macros: {move: [reference]}},
        [MODULE_ID]: {guardianFaith: {spellUuid: spell.uuid, saveDC, damage: 0, stamp: ""}}
      }
    }
  });
  const placed = await summon.place(distanceInScene(30, workflow.token), {token: tokenDocument(workflow.token)});
  if (!placed) await manager.deleteSummon(summon);
  return placed;
}

async function runGuardianTrigger(document, target) {
  const data = document?.flags?.[MODULE_ID]?.guardianFaith;
  if (!data || !target?.actor || Number(data.damage ?? 0) >= 60 || document.deleted) return;
  const stamp = guardianStamp(target);
  if (data.stamp === stamp || (data.stamps ?? []).includes(stamp)) return;
  const spell = await fromUuid(data.spellUuid);
  const activity = itemActivity(spell, SPELL_2014_ACTIVITY_IDS.guardianDamage);
  if (!spell || !activity) return;

  const activityData = activity.toObject();
  activityData.save.dc = {calculation: "", formula: String(data.saveDC), value: true};
  const result = await runSyntheticActivityData(activityData, spell, [target], {
    consumeUsage: false,
    consumeResources: false,
    spellSlot: false,
    userId: ownerUserId(spell.actor)
  });
  if (!result || result.aborted) return false;
  const damage = damageDealt(result, target, "radiant");
  const total = Math.min(60, Number(data.damage ?? 0) + damage);
  await updateDocumentSafely(document, {
    [`flags.${MODULE_ID}.guardianFaith.damage`]: total,
    [`flags.${MODULE_ID}.guardianFaith.stamp`]: stamp,
    [`flags.${MODULE_ID}.guardianFaith.stamps`]: [...(data.stamps ?? []).filter(value => value.startsWith(stamp.slice(0, stamp.lastIndexOf(":") + 1))), stamp]
  });
  if (total < 60) return;
  const manager = globalThis.cat?.lib?.constants?.summons;
  const summon = manager?.getSummonData(document);
  if (summon) await manager.deleteSummon(summon);
}

export async function triggerGuardianOfFaith({document, token} = {}) {
  const target = tokenDocument(token);
  if (!document || !target?.actor) return;
  const key = document.uuid ?? document.id;
  const previous = guardianLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runGuardianTrigger(document, target));
  guardianLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (guardianLocks.get(key) === next) guardianLocks.delete(key);
  }
}

function auraChangesSignature(changes) {
  return values(changes).map(change => [
    String(change?.key ?? ""),
    String(change?.value ?? ""),
    Number(change?.priority ?? 0),
    String(change?.type ?? change?.mode ?? "")
  ]).sort((left, right) => left[0].localeCompare(right[0]));
}

async function ensureAuraTargetEffect(source, actor, effectData) {
  const existing = values(actor?.effects).find(effect =>
    effect?.flags?.cat?.auraEffect && effect?.origin === source?.uuid
  );
  if (!existing) return {effectData};
  const updates = {};
  if (existing.name !== effectData.name) updates.name = effectData.name;
  if (existing.img !== effectData.img) updates.img = effectData.img;
  if (Number(existing.showIcon) !== Number(effectData.showIcon)) updates.showIcon = effectData.showIcon;
  if (JSON.stringify(auraChangesSignature(existing.system?.changes)) !== JSON.stringify(auraChangesSignature(effectData.system?.changes))) {
    updates["system.changes"] = effectData.system?.changes ?? [];
  }
  if (Object.keys(updates).length) await updateDocumentSafely(existing, updates);
  return {existingEffect: existing};
}

export async function activateAuraLife({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell) return;
  return createConcentrationSourceEffect({
    workflow,
    spell,
    identifier: SPELL_2014_EFFECT_IDS.auraLifeSource,
    seconds: 600,
    auraIdentifier: SPELL_2014_EFFECT_IDS.auraLifeSource
  });
}

export async function createAuraLifeTarget({document, token}) {
  if (!document || !token?.actor) return;
  const reference = macroReference(SPELL_2014_EFFECT_IDS.auraLifeTarget);
  return ensureAuraTargetEffect(document, token.actor, {
    name: "Aura of Life",
    img: document.img,
    type: "base",
    system: {changes: [{key: "system.traits.dr.value", value: "necrotic", priority: 20, type: "add"}]},
    duration: effectDuration(Math.max(1, Number(document.duration?.remaining ?? 600))),
    showIcon: 1,
    flags: {
      cat: {
        identifier: SPELL_2014_EFFECT_IDS.auraLifeTarget,
        macros: {combat: [reference], effect: [reference]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
      [MODULE_ID]: {auraLifeTarget: true}
    }
  });
}

export async function auraLifeTurnStart({document, actor}) {
  actor ??= document?.parent;
  if (!actor || Number(actor.system?.attributes?.hp?.value ?? 0) !== 0 || values(actor.statuses).includes("dead")) return;
  await healActor(actor, 1, {name: "Aura of Life"});
}

function negativeHpMaxChanges(changes) {
  const originals = [];
  const next = values(changes).map((change, index) => {
    if (change?.key !== "system.attributes.hp.tempmax" || Number(change.value) >= 0) return change;
    originals.push({index, value: change.value});
    return {...change, value: "0"};
  });
  return {next, originals};
}

export function suppressAuraLifeHpMaxReduction({effect, updates} = {}) {
  if (!effect) return;
  const incoming = updates?.system?.changes ?? updates?.changes ?? effect.system?.changes;
  if (!incoming) return;
  const {next, originals} = negativeHpMaxChanges(incoming);
  if (!originals.length) return;
  if (updates) {
    updates.system ??= {};
    updates.system.changes = next;
    updates.flags ??= {};
    updates.flags[MODULE_ID] ??= {};
    updates.flags[MODULE_ID].auraLifeOriginalChanges = originals;
  } else if (typeof effect.updateSource === "function") {
    effect.updateSource({
      "system.changes": next,
      [`flags.${MODULE_ID}.auraLifeOriginalChanges`]: originals
    });
  }
}

export async function restoreAuraLifeHpMaxReductions({document, actor} = {}) {
  actor ??= document?.parent;
  if (!actor) return;
  const anotherAura = values(actor.effects).some(effect =>
    effect.id !== document?.id && effect.flags?.[MODULE_ID]?.auraLifeTarget && effect.active !== false
  );
  if (anotherAura) return;
  for (const effect of values(actor.effects)) {
    const originals = effect.flags?.[MODULE_ID]?.auraLifeOriginalChanges;
    if (!Array.isArray(originals) || !originals.length) continue;
    const changes = values(effect.system?.changes).map(change => ({...change}));
    for (const original of originals) {
      if (changes[original.index]) changes[original.index].value = original.value;
    }
    await updateDocumentSafely(effect, {
      "system.changes": changes,
      [`flags.${MODULE_ID}.-=auraLifeOriginalChanges`]: null
    });
  }
}

export async function applyDeathWard({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell) return;
  for (const target of targetDocuments(workflow)) {
    const existing = effectByIdentifier(target.actor, SPELL_2014_EFFECT_IDS.deathWard);
    if (existing) await removeEffect(existing);
    await createEffects(target.actor, [{
      name: spell.name,
      img: spell.img,
      origin: spell.uuid,
      type: "base",
      duration: effectDuration(28800),
      showIcon: 1,
      flags: {
        cat: {
          identifier: SPELL_2014_EFFECT_IDS.deathWard,
          macros: {roll: [macroReference(SPELL_2014_EFFECT_IDS.deathWard)]}
        },
        dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
      }
    }]);
  }
}

export async function triggerDeathWard({document, ditem} = {}) {
  if (!document || !ditem || Number(ditem.newHP ?? 1) > 0) return;
  const oldHP = Number(ditem.oldHP ?? 0);
  if (oldHP <= 0) return;
  const currentHpDamage = Math.max(0, appliedDamageAmount(ditem) - Number(ditem.oldTempHP ?? 0));
  const allowedHpDamage = Math.max(0, oldHP - 1);
  const reduction = Math.max(0, currentHpDamage - allowedHpDamage);
  if (reduction > 0) adjustAppliedDamage(ditem, -reduction);
  await removeEffect(document);
}

export async function activateCircleOfPower({workflow, document, item}) {
  const spell = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!spell) return;
  return createConcentrationSourceEffect({
    workflow,
    spell,
    identifier: SPELL_2014_EFFECT_IDS.circlePowerSource,
    seconds: 600,
    auraIdentifier: SPELL_2014_EFFECT_IDS.circlePowerSource
  });
}

export async function createCirclePowerTarget({document, token}) {
  if (!document || !token?.actor) return;
  const reference = macroReference(SPELL_2014_EFFECT_IDS.circlePowerTarget);
  return ensureAuraTargetEffect(document, token.actor, {
    name: "Circle of Power",
    img: document.img,
    type: "base",
    system: {changes: []},
    duration: effectDuration(Math.max(1, Number(document.duration?.remaining ?? 600))),
    showIcon: 1,
    flags: {
      cat: {
        identifier: SPELL_2014_EFFECT_IDS.circlePowerTarget,
        macros: {save: [reference], roll: [reference]}
      },
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
    }
  });
}

export function circlePowerSaveAdvantage({workflow} = {}) {
  if (!magicalWorkflow(workflow)) return;
  return {label: "Circle of Power: magia o effetto magico", type: "advantage"};
}

function magicalWorkflow(workflow) {
  return workflow?.item?.type === "spell"
    || workflow?.activity?.midiProperties?.magicEffect
    || workflow?.item?.flags?.midiProperties?.magiceffect;
}

export function circlePowerNegateHalfDamage({workflow, targetToken, ditem} = {}) {
  const target = tokenDocument(targetToken);
  if (!workflow || !target || !ditem || !magicalWorkflow(workflow)) return;
  if (workflow.activity?.damage?.onSave !== "half") return;
  const saved = targetDocuments(workflow, "saves").some(token => sameToken(token, target));
  if (!saved) return;
  const damage = Math.max(0, Number(ditem.hpDamage ?? 0) + Number(ditem.tempDamage ?? 0));
  if (damage > 0) adjustAppliedDamage(ditem, -damage);
}

export function registerSpells2014(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.boomingBlade,
      roll: [{pass: "itemRollFinished", macro: useBoomingBlade, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.boomingMoved,
      move: [{pass: "actorMoved", macro: triggerBoomingBladeMovement, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.protection,
      save: [{pass: "actorContext", macro: protectionSaveAdvantage, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.shield,
      roll: [{pass: "targetDamageComplete", macro: blockMagicMissile, priority: 200}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.sanctuary,
      roll: [{pass: "itemRollFinished", macro: applySanctuary, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.sanctuarySafe,
      roll: [
        {pass: "targetPreItemRoll", macro: sanctuaryTargeted, priority: 20},
        {pass: "actorRollFinished", macro: removeSanctuaryAfterAction, priority: 80}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.aid,
      roll: [{pass: "itemRollFinished", macro: applyAid, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.aid,
      effect: [{pass: "deleted", macro: removeAidHitPoints, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.auraVitality,
      roll: [
        {pass: "itemPreItemRoll", macro: prepareAuraVitalityHealing, priority: 10},
        {pass: "itemRollFinished", macro: activateAuraVitality, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.guardianFaith,
      roll: [{pass: "itemRollFinished", macro: summonGuardianOfFaith, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.guardianActive,
      move: [{pass: "nearbyMoved", macro: triggerGuardianOfFaith, priority: 50, distance: 10, dispositions: ["enemy"], canOverlap: true}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.auraLife,
      roll: [{pass: "itemRollFinished", macro: activateAuraLife, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.auraLifeSource,
      aura: [{pass: "update", macro: createAuraLifeTarget, priority: 50, distance: 30, dispositions: ["ally"]}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.auraLifeTarget,
      combat: [{pass: "actorTurnStart", macro: auraLifeTurnStart, priority: 50}],
      effect: [
        {pass: "actorPreCreated", macro: suppressAuraLifeHpMaxReduction, priority: 20},
        {pass: "actorPreUpdated", macro: suppressAuraLifeHpMaxReduction, priority: 20},
        {pass: "deleted", macro: restoreAuraLifeHpMaxReductions, priority: 80}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.deathWard,
      roll: [{pass: "itemRollFinished", macro: applyDeathWard, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.deathWard,
      roll: [{pass: "targetDamageComplete", macro: triggerDeathWard, priority: 250}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_IDS.circlePower,
      roll: [{pass: "itemRollFinished", macro: activateCircleOfPower, priority: 50}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.circlePowerSource,
      aura: [{pass: "update", macro: createCirclePowerTarget, priority: 50, distance: 30, dispositions: ["ally"]}]
    }),
    api.registerFnMacro({
      source: MODULE_ID, rules: RULES, identifier: SPELL_2014_EFFECT_IDS.circlePowerTarget,
      save: [{pass: "actorContext", macro: circlePowerSaveAdvantage, priority: 50}],
      roll: [{pass: "targetDamageComplete", macro: circlePowerNegateHalfDamage, priority: 200}]
    })
  ];
  return {macros, automations: SPELLS_2014_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
