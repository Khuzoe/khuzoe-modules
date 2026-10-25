import {registerMidiRollConfig} from "./midi-roll-config.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {exposeNpcRulesApi, healFromNpcRule} from "./npc-rules.mjs";
import {createAutomationToolbar} from "./automation-toolbar.mjs";
import {RELEASE_VERSION} from "./release.mjs";
import {getCampaignAutomation, prepareCampaignItemUpdate, applyCampaignAlias, registerCampaignFeatures, registerCampaignHooks} from "./campaign-features.mjs";
import {ARCANE_WARD_AUTOMATION, prepareArcaneWardUpdate, registerArcaneWard, registerArcaneWardHooks} from "./arcane-ward.mjs";
import {getArmorerAutomation, applyArmorerAlias, prepareArmorerUpdate, registerArmorer, registerArmorerHooks} from "./armorer.mjs";
import {registerCombatFallbackHooks} from "./combat-events.mjs";
import {nearbyTokens, slideTokenFeet} from "./movement-compat.mjs";
import {installCircularAuras, registerCircularAuraHooks, circularSpellAuraVisuals, scheduleCircularAuras} from "./circular-auras.mjs";
import {prepareShieldEffectExpiry, preventProtectedConditions} from "./spells-2014.mjs";
import {applySpellSightRules, restrictGaseousActions, breakCharmOnHarm, enhanceSpellActions, finishShadowBladeThrow} from "./spell-state-rules.mjs";
import {expandedFlameMotion, resolveWardingBondTransfers} from "./expanded-spells-2014.mjs";
import {registerSpellTerrainType, registerPersistentSpellAreas, moveSpellAreas} from "./persistent-spell-areas.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {runSyntheticActivityData, runSyntheticActivity, khuzoeRegistrationApi} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {prepareTemporaryHPUpdate, preserveTemporaryDamageSource, rememberTemporaryDamage} from "./temporary-hp.mjs";
import {
  RUNE_KNIGHT_AUTOMATIONS,
  RUNE_KNIGHT_IDENTIFIERS,
  enhanceGiantsMightMedkit,
  prepareRuneKnightItemUpdate,
  reconcileAllRuneUses,
  registerRuneKnight,
  restoreGiantsMightTokenSize,
  scheduleRuneUseReconciliation
} from "./rune-knight.mjs";
import {
  WILD_SHAPE_AUTOMATION,
  enhanceWildShapeMedkit,
  exposeWildShapeApi,
  prepareWildShapeItemUpdate,
  registerWildShape
} from "./wild-shape.mjs";
import {
  RAGE_AUTOMATION,
  prepareRageItemUpdate,
  reconcileRageStatus,
  restrictRageSpellcasting,
  registerRage
} from "./rage.mjs";
import {
  CREATE_BONFIRE_AUTOMATION,
  prepareCreateBonfireItemUpdate,
  registerCreateBonfire
} from "./create-bonfire.mjs";
import {
  WALL_OF_FIRE_AUTOMATION,
  prepareWallOfFireItemUpdate,
  registerWallOfFire
} from "./wall-of-fire.mjs";
import {
  COMBAT_ACTION_AUTOMATIONS,
  cleanupDeletedGrappleEffect, cleanupSeparatedGrapples,
  cleanupGrapplesIfIncapacitated,
  prepareCombatActionItemUpdate,
  registerCombatActions2014
} from "./combat-actions-2014.mjs";
import {
  KEEPER_GIANTS_STRENGTH_AUTOMATION,
  prepareKeeperGiantsStrengthItemUpdate,
  registerKeeperGiantsStrength
} from "./keeper-giants-strength.mjs";
import {
  PALADIN_AUTOMATIONS,
  isPaladinReconciliationItem,
  preparePaladinAuraEffectIcon,
  preparePaladinItemUpdate,
  paladinAuraVisuals,
  reconcileAllPaladins,
  registerPaladin,
  schedulePaladinAuraAfterTokenMovement,
  schedulePaladinAuraReconciliation,
  schedulePaladinReconciliation,
  triggerHolyNimbusTurnStart
} from "./paladin.mjs";
import {
  WIZARD_AUTOMATIONS,
  prepareWizardItemUpdate,
  registerWizard,
  scheduleBladesongStatusCheck
} from "./wizard.mjs";
import {
  ROGUE_AUTOMATIONS,
  prepareRogueItemUpdate,
  registerRogue
} from "./rogue.mjs";
import {
  GOLIATH_AUTOMATIONS,
  prepareGoliathItemUpdate,
  registerGoliath
} from "./goliath.mjs";
import {
  SPELLS_2014_AUTOMATIONS,
  registerSpells2014Settings,
  registerSpells2014
} from "./spells-2014.mjs";
import {
  EXPANDED_SPELL_AUTOMATIONS,
  registerExpandedSpells2014
} from "./expanded-spells-2014.mjs";
import {SPECIAL_SPELL_AUTOMATIONS, registerSpecialSpells2014} from "./special-spells-2014.mjs";
import {SHAPECHANGE_AUTOMATION, registerShapechange} from "./shapechange.mjs";
import {
  DAMAGE_BOND_AUTOMATIONS,
  enhanceDamageBondMedkit,
  prepareDamageBondItemUpdate,
  registerDamageBond,
  resolveQueuedDamageBonds
} from "./damage-bond.mjs";
import {
  HOME_BREW_NPC_AUTOMATIONS,
  HOME_BREW_NPC_IDENTIFIERS,
  ensureHomebrewNpcAuras,
  ensureHomebrewNpcHelpers,
  handleHomebrewNpcActorUpdate,
  reconcileImpenetrableEgo,
  prepareHomebrewNpcItemUpdate,
  registerHomebrewNpcs,
  resolveQueuedNpcDamageTransfers,
  resetEncouragingDanceReaction
} from "./homebrew-npcs.mjs";
import {scheduleCatDamageWorkflowGuards} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const MODULE_TITLE = "Khuzoe Automations";
const BLESS_VERSION = RELEASE_VERSION;
const ARMOR_OF_AGATHYS_VERSION = RELEASE_VERSION;
const BARDIC_INSPIRATION_VERSION = RELEASE_VERSION;
const BLADE_FLOURISH_VERSION = RELEASE_VERSION;
const MASTERS_FLOURISH_VERSION = RELEASE_VERSION;
const BLESS_UUID = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item.KhzBless14Auto01";
const ARMOR_OF_AGATHYS_UUID_2014 = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item.KhzAgathysAuto01";
const ARMOR_OF_AGATHYS_UUID_2024 = "Compendium.khuzoe-automations.KhuzoeSpells2024.Item.KhzAgathys24Au01";
const BARDIC_INSPIRATION_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzBardicInsp001";
const BLADE_FLOURISH_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzBladeFlour001";
const MASTERS_FLOURISH_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzMasterFlour01";
const ARMOR_EFFECT_IDENTIFIER = "armor-of-agathys-armor";
const ARMOR_CAST_ACTIVITY_ID = "KhzAgathysCast01";
const ARMOR_REFLECT_ACTIVITY_ID = "KhzAgathysRefl01";
const BARDIC_EFFECT_IDENTIFIER = "bardic-inspiration-inspired";
const BLADE_MOVEMENT_ACTIVITY_ID = "KhzBladeMove0001";
const BLADE_MOVEMENT_EFFECT_ID = "KhzBladeMoveEf01";
const DEFENSIVE_FLOURISH_ACTIVITY_ID = "KhzBladeDefn0001";
const MOBILE_FLOURISH_ACTIVITY_ID = "KhzBladeMobl0001";
const SLASHING_FLOURISH_ACTIVITY_ID = "KhzBladeSlsh0001";
const DEFENSIVE_FLOURISH_EFFECT_ID = "KhzBladeDefnEf01";
const BLADE_FLAG_SCOPE = "bladeFlourish";
const BLADE_EXCLUDED_ATTACKS = new Set([
  "booming-blade",
  "boomingBlade",
  "green-flame-blade",
  "greenFlameBlade"
]);
const SUPPORTED_AUTOMATIONS = new Map([
  ["2014:bless", {version: BLESS_VERSION, uuid: BLESS_UUID}],
  ["2014:armor-of-agathys", {version: ARMOR_OF_AGATHYS_VERSION, uuid: ARMOR_OF_AGATHYS_UUID_2014}],
  ["2024:armor-of-agathys", {version: ARMOR_OF_AGATHYS_VERSION, uuid: ARMOR_OF_AGATHYS_UUID_2024}],
  ["2014:bardic-inspiration", {version: BARDIC_INSPIRATION_VERSION, uuid: BARDIC_INSPIRATION_UUID}],
  ["2014:blade-flourish", {version: BLADE_FLOURISH_VERSION, uuid: BLADE_FLOURISH_UUID}],
  ["2014:masters-flourish", {version: MASTERS_FLOURISH_VERSION, uuid: MASTERS_FLOURISH_UUID}],
  [`${WILD_SHAPE_AUTOMATION.rules}:${WILD_SHAPE_AUTOMATION.identifier}`, {
    version: WILD_SHAPE_AUTOMATION.version,
    uuid: WILD_SHAPE_AUTOMATION.uuid
  }],
  [`${RAGE_AUTOMATION.rules}:${RAGE_AUTOMATION.identifier}`, {
    version: RAGE_AUTOMATION.version,
    uuid: RAGE_AUTOMATION.uuid
  }],
  [`${CREATE_BONFIRE_AUTOMATION.rules}:${CREATE_BONFIRE_AUTOMATION.identifier}`, {
    version: CREATE_BONFIRE_AUTOMATION.version,
    uuid: CREATE_BONFIRE_AUTOMATION.uuid
  }],
  [`${WALL_OF_FIRE_AUTOMATION.rules}:${WALL_OF_FIRE_AUTOMATION.identifier}`, {
    version: WALL_OF_FIRE_AUTOMATION.version,
    uuid: WALL_OF_FIRE_AUTOMATION.uuid
  }],
  ...COMBAT_ACTION_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  [`${KEEPER_GIANTS_STRENGTH_AUTOMATION.rules}:${KEEPER_GIANTS_STRENGTH_AUTOMATION.identifier}`, {
    version: KEEPER_GIANTS_STRENGTH_AUTOMATION.version,
    uuid: KEEPER_GIANTS_STRENGTH_AUTOMATION.uuid
  }],
  ...RUNE_KNIGHT_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...PALADIN_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...WIZARD_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...ROGUE_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...GOLIATH_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...SPELLS_2014_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...EXPANDED_SPELL_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...SPECIAL_SPELL_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ["2014:shapechange", {version: SHAPECHANGE_AUTOMATION.version, uuid: SHAPECHANGE_AUTOMATION.uuid}],
  ...DAMAGE_BOND_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ]),
  ...HOME_BREW_NPC_AUTOMATIONS.map(automation => [
    `${automation.rules}:${automation.identifier}`,
    {version: automation.version, uuid: automation.uuid}
  ])
]);

let registrationComplete = false;

Hooks.once("init", () => {
  registerSpellTerrainType();
  registerSpells2014Settings();
});

function timedEffectDuration(seconds, expiry = "turnStart") {
  return {
    value: seconds,
    units: "seconds",
    expiry,
    expired: false
  };
}

function getCastLevel(workflow) {
  const level = Number(
    workflow?.castData?.castLevel
    ?? workflow?.workflowOptions?.castData?.castLevel
    ?? workflow?.item?.system?.level
    ?? 1
  );
  return Number.isFinite(level) ? Math.max(1, level) : 1;
}

async function prepareArmorOfAgathys({workflow, activity, actor, item}) {
  if ((activity ?? workflow?.activity)?.id !== ARMOR_CAST_ACTIVITY_ID) return;
  actor ??= workflow.actor; item ??= workflow.item;
  if (item?.system?.source?.rules === "2024") return;
  const previous = Number(actor.system.attributes.hp.temp ?? 0), expected = getCastLevel(workflow) * 5;
  if (previous >= expected) workflow.khuzoeAgathysReplace = await cat.utils.dialogUtils.confirm(item.name,
    `Sostituire i ${previous} PF temporanei attuali con i ${expected} di Armor of Agathys?`, {userId: cat.utils.queryUtils.firstOwner(actor, true)});
}

async function applyArmorOfAgathys({workflow, activity, actor, item}) {
  if (!workflow || activity?.id !== ARMOR_CAST_ACTIVITY_ID) return;

  actor ??= workflow.actor;
  item ??= workflow.item;
  if (!actor || !item) return;

  const castLevel = getCastLevel(workflow);
  const expectedTempHp = castLevel * 5;
  const currentTempHp = Number(actor.system.attributes.hp.temp ?? 0);
  const rules = item.system.source.rules === "2024" ? "2024" : "2014";

  // Se il personaggio ha mantenuto una fonte di PF temporanei più alta,
  // Armor of Agathys non diventa attiva.
  if (rules === "2014" && (workflow.khuzoeAgathysReplace === false || (workflow.khuzoeAgathysReplace === undefined && currentTempHp > expectedTempHp))) {
    if (game.user?.isGM || actor.isOwner) {
      ui.notifications.info(`${item.name}: mantenuti i PF temporanei già presenti; l'armatura non è stata attivata.`);
    }
    return;
  }

  const {documentUtils, effectUtils} = globalThis.cat.utils;
  const existing = actor.effects.filter(effect => effect.flags.cat?.identifier === ARMOR_EFFECT_IDENTIFIER);
  if (existing.length) {
    await documentUtils.deleteEmbeddedDocuments(actor, "ActiveEffect", existing.map(effect => effect.id));
  }

  const effectData = {
    name: item.name,
    img: item.img,
    origin: item.uuid,
    type: "base",
    duration: timedEffectDuration(3600),
    flags: {
      cat: {
        identifier: ARMOR_EFFECT_IDENTIFIER,
        castData: {
          castLevel,
          baseLevel: Number(item.system.level ?? 1),
          saveDC: Number(
            workflow.castData?.saveDC
            ?? actor.system.attributes?.spell?.dc
            ?? actor.system.attributes?.spelldc
            ?? -1
          )
        },
        macros: {
          roll: [
            {
              source: MODULE_ID,
              rules,
              identifier: ARMOR_EFFECT_IDENTIFIER
            }
          ]
        }
      },
      "khuzoe-automations": {
        armorOfAgathys: {
          castLevel,
          tempHp: expectedTempHp,
          trackTempSource: rules === "2014"
        }
      }
    }
  };

  const created = await effectUtils.createEffects(actor, [effectData], {rules});
  if (rules === "2014" && created?.[0]?.uuid) await updateDocumentSafely(actor, {
    "system.attributes.hp.temp": expectedTempHp, [`flags.${MODULE_ID}.temporaryHPSource`]: created[0].uuid
  });
}

function tokenId(token) {
  return token?.document?.id ?? token?.id;
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function collectionValues(collection) {
  return Array.from(collection ?? []);
}

function findActorItem(actor, identifiers) {
  const wanted = new Set(identifiers);
  return collectionValues(actor?.items).find(item => wanted.has(item.system?.identifier));
}

function getBardicInspirationFormula(actor) {
  const scale = actor?.system?.scale?.bard?.inspiration;
  if (typeof scale?.formula === "string" && scale.formula.trim()) return scale.formula;
  if (typeof scale?.die === "string" && scale.die.trim()) {
    return /^\d+d\d+$/i.test(scale.die) ? scale.die : `1${scale.die}`;
  }

  const bardClass = actor?.classes?.bard
    ?? collectionValues(actor?.items).find(item => item.type === "class" && item.system?.identifier === "bard");
  const level = Number(bardClass?.system?.levels ?? 1);
  if (level >= 15) return "1d12";
  if (level >= 10) return "1d10";
  if (level >= 5) return "1d8";
  return "1d6";
}

function getWorkflowTargetDocuments(workflow, key = "targets") {
  return collectionValues(workflow?.[key]).map(tokenDocument).filter(Boolean);
}

function isValidBardicTarget(actor, target) {
  return Boolean(target?.actor && target.actor.id !== actor?.id);
}

function validateBardicInspirationTarget({workflow, actor}) {
  actor ??= workflow?.actor;
  const targets = getWorkflowTargetDocuments(workflow);
  if (targets.length === 1 && isValidBardicTarget(actor, targets[0])) return;

  if (game.user?.isGM || actor?.isOwner) {
    ui.notifications.warn("Bardic Inspiration richiede come bersaglio una singola creatura diversa dal bardo.");
  }
  return true;
}

async function applyBardicInspiration({workflow, actor, item}) {
  actor ??= workflow?.actor;
  item ??= workflow?.item;
  if (!actor || !item) return;

  const targets = getWorkflowTargetDocuments(workflow);
  if (targets.length !== 1 || !isValidBardicTarget(actor, targets[0])) return;

  const targetActor = targets[0].actor;
  const formula = getBardicInspirationFormula(actor);
  const {documentUtils, effectUtils} = globalThis.cat.utils;
  const existing = collectionValues(targetActor.effects)
    .filter(effect => effect.flags.cat?.identifier === BARDIC_EFFECT_IDENTIFIER);
  if (existing.length) {
    await documentUtils.deleteEmbeddedDocuments(targetActor, "ActiveEffect", existing.map(effect => effect.id));
  }

  const macroReference = {
    source: MODULE_ID,
    rules: "2014",
    identifier: BARDIC_EFFECT_IDENTIFIER
  };
  const effectData = {
    name: `Bardic Inspiration (${formula})`,
    img: item.img,
    origin: item.uuid,
    type: "base",
    duration: timedEffectDuration(600),
    description: `<p>Puoi aggiungere <strong>${formula}</strong> a un tiro per colpire, una prova di caratteristica, una prova di abilità o un tiro salvezza. Il dado viene consumato quando lo selezioni nel pannello dei bonus di CAT.</p>`,
    showIcon: 1,
    flags: {
      cat: {
        identifier: BARDIC_EFFECT_IDENTIFIER,
        macros: {
          roll: [macroReference],
          save: [macroReference],
          skill: [macroReference],
          check: [macroReference]
        }
      },
      [MODULE_ID]: {
        bardicInspiration: {
          formula,
          sourceActorUuid: actor.uuid
        }
      },
      dae: {
        stackable: "noneNameOnly",
        specialDuration: []
      }
    }
  };

  await effectUtils.createEffects(targetActor, [effectData], {rules: "2014"});
}

function provideBardicInspirationBonus({document, actor, D20Bonus}) {
  if (document?.documentName !== "ActiveEffect" || typeof D20Bonus !== "function") return;
  const formula = document.flags[MODULE_ID]?.bardicInspiration?.formula ?? "1d6";
  const bonus = new D20Bonus(document, {formula, actor});
  return bonus
    .withOnUse(async () => globalThis.cat.utils.documentUtils.deleteDocument(document))
    .initialize();
}

function isEligibleBladeAttack(workflow) {
  if (!workflow || workflow.workflowOptions?.khuzoeWeaponCantrip || workflow.item?.flags?.[MODULE_ID]?.weaponCantrip || BLADE_EXCLUDED_ATTACKS.has(workflow.item?.system?.identifier)) return false;
  if (workflow.aborted || /^(bonus|reaction)/.test(workflow.activity?.activation?.type ?? "") || /offhand/i.test(workflow.attackMode ?? "")) return false;
  return Boolean(globalThis.cat.utils.workflowUtils.isAttackType(workflow, "weaponAttack"));
}

function getCombatContext(token) {
  token = tokenDocument(token);
  if (!token) return {token: null, tokenId: null, combatData: {inCombat: false}};
  const combatData = globalThis.cat.utils.tokenUtils.getCombatData(token);
  return {token, tokenId: token.id, combatData};
}

function canUseBladeFlourishNow(token, combatData) {
  return !combatData.inCombat || globalThis.cat.utils.combatUtils.isOwnTurn(token);
}

function bladeTurnStamps(item, key) {
  const stamps = item.flags[MODULE_ID]?.[BLADE_FLAG_SCOPE]?.[key];
  return Array.isArray(stamps) ? stamps : [];
}

function bladeUsedThisTurn(item, key, tokenId, combatData) {
  if (!combatData.inCombat || !tokenId) return false;
  return globalThis.cat.utils.combatUtils.isStampedThisTurn(
    bladeTurnStamps(item, key),
    tokenId,
    combatData
  );
}

async function stampBladeUse(item, key, tokenId, combatData) {
  if (!combatData.inCombat || !tokenId) return;
  const stamps = globalThis.cat.utils.combatUtils.addTurnStamp(
    bladeTurnStamps(item, key),
    tokenId,
    combatData
  );
  await updateDocumentSafely(item, {
    [`flags.${MODULE_ID}.${BLADE_FLAG_SCOPE}.${key}`]: stamps
  });
}

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id);
}

async function applyBladeFlourishMovement({workflow, document, token}) {
  return withDocumentLock(document, "applyBladeFlourishMovement", async () => {
  if (!isEligibleBladeAttack(workflow)) return;
  const context = getCombatContext(token ?? workflow.token);
  if (!canUseBladeFlourishNow(context.token, context.combatData)) return;
  if (bladeUsedThisTurn(document, "movementStamps", context.tokenId, context.combatData)) return;

  const activity = itemActivity(document, BLADE_MOVEMENT_ACTIVITY_ID);
  if (!activity) return;
  const result = await runSyntheticActivity(
    activity,
    context.token ? [context.token] : [],
    {consumeUsage: false, consumeResources: false, spellSlot: false}
  );
  if (!result || result.aborted) return false;
  await stampBladeUse(document, "movementStamps", context.tokenId, context.combatData);
  });
}

function itemUsesRemaining(item) {
  const preparedValue = Number(item?.system?.uses?.value);
  if (Number.isFinite(preparedValue)) return Math.max(0, preparedValue);
  const max = Number(item?.system?.uses?.max);
  const spent = Number(item?.system?.uses?.spent ?? 0);
  return Number.isFinite(max) ? Math.max(0, max - spent) : 0;
}

async function consumeItemUse(item) {
  const spent = Number(item?.system?.uses?.spent ?? 0);
  await updateDocumentSafely(item, {"system.uses.spent": spent + 1});
}

async function chooseBladeFlourish() {
  return globalThis.cat.utils.dialogUtils.buttonDialog(
    "Blade Flourish",
    "<p>Scegli il tipo di flourish da applicare a questo attacco.</p>",
    [
      ["Defensive Flourish", "defensive", {image: "icons/skills/melee/swords-parry-block-blue.webp"}],
      ["Mobile Flourish", "mobile", {image: "icons/skills/movement/feet-winged-boots-brown.webp"}],
      ["Slashing Flourish", "slashing", {image: "icons/skills/melee/strike-sword-slashing-red.webp"}],
      ["Nessun flourish", false, {image: "icons/svg/cancel.svg"}]
    ],
    {displayAsRows: true}
  );
}

async function chooseMastersFlourish(item, usesRemaining) {
  if (usesRemaining <= 0) return true;
  return globalThis.cat.utils.dialogUtils.confirm(
    "Master's Flourish",
    `<p>Usare <strong>Master's Flourish</strong> con 1d6 senza consumare Bardic Inspiration?</p><p>Scegli <strong>No</strong> per usare il dado completo di Bardic Inspiration (${getBardicInspirationFormula(item.actor)}).</p>`
  );
}

function flourishDamageResult(workflow) {
  const value = Number(workflow?.damageRolls?.at?.(-1)?.total);
  return Number.isFinite(value) ? value : 0;
}

function flourishDamageType(workflow) {
  return workflow?.defaultDamageType ?? workflow?.damageRolls?.[0]?.options?.type ?? "slashing";
}

async function applyDefensiveFlourish(item, token, result) {
  const effect = item.effects?.get?.(DEFENSIVE_FLOURISH_EFFECT_ID);
  const activity = itemActivity(item, DEFENSIVE_FLOURISH_ACTIVITY_ID);
  if (!effect || !activity) return;

  await updateDocumentSafely(effect, {
    "system.changes": [
      {
        key: "system.attributes.ac.bonus",
        value: String(result),
        priority: 20,
        type: "add"
      }
    ]
  });
  await runSyntheticActivity(
    activity,
    token ? [token] : [],
    {consumeUsage: false, consumeResources: false, spellSlot: false}
  );
}

async function applyMobileFlourish(item, sourceToken, targetToken, result) {
  const activity = itemActivity(item, MOBILE_FLOURISH_ACTIVITY_ID);
  if (!activity || !targetToken) return;

  await runSyntheticActivity(
    activity,
    [targetToken],
    {consumeUsage: false, consumeResources: false, spellSlot: false}
  );

  const distance = 5 + result;
  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    "Mobile Flourish",
    `<p>Spingere <strong>${escapeHtml(targetToken.name)}</strong> fino a <strong>${distance} ft</strong> lontano dal bardo?</p>`
  );
  if (!confirmed) return;
  await slideTokenFeet(targetToken, {
    sourceToken,
    distance,
    action: "catForce"
  });
}

async function selectSlashingFlourishTarget(sourceToken, primaryTarget) {
  const {dialogUtils} = globalThis.cat.utils;
  const nearby = nearbyTokens(sourceToken, 5, {disposition: "all"})
    .filter(target => target.id !== primaryTarget?.id && target.id !== sourceToken?.id)
    .filter(target => globalThis.MidiQOL?.canSee?.(sourceToken.object ?? sourceToken, target.object ?? target) ?? true);
  if (!nearby.length) {
    ui.notifications.info("Slashing Flourish: nessun'altra creatura entro 5 ft.");
    return null;
  }
  if (nearby.length === 1) return nearby[0];

  const selection = await dialogUtils.selectTargetDialog(
    "Slashing Flourish",
    "<p>Scegli un'altra creatura entro 5 ft che subirà lo stesso danno del dado di ispirazione.</p>",
    nearby,
    {
      type: "one",
      skipDeadAndUnconscious: false,
      coverToken: sourceToken,
      displayDistance: true
    }
  );
  return selection?.result ?? null;
}

async function applySlashingFlourish(item, sourceToken, primaryTarget, result, damageType) {
  const activity = itemActivity(item, SLASHING_FLOURISH_ACTIVITY_ID);
  if (!activity || !sourceToken || result <= 0) return;
  const secondaryTarget = await selectSlashingFlourishTarget(sourceToken, primaryTarget);
  if (!secondaryTarget) return;

  const activityData = globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(
    activity,
    String(result),
    {types: [damageType]}
  );
  await runSyntheticActivityData(
    activityData,
    item,
    [secondaryTarget],
    {consumeUsage: false, consumeResources: false, spellSlot: false}
  );
}

async function applyBladeFlourish({workflow, document, actor, token}) {
  return withDocumentLock(document, "applyBladeFlourish", async () => {
  if (!isEligibleBladeAttack(workflow)) return;
  const hitTargets = getWorkflowTargetDocuments(workflow, "hitTargets");
  if (hitTargets.length !== 1) return;

  actor ??= workflow.actor;
  const context = getCombatContext(token ?? workflow.token);
  if (!canUseBladeFlourishNow(context.token, context.combatData)) return;
  if (bladeUsedThisTurn(document, "flourishStamps", context.tokenId, context.combatData)) return;

  const bardicInspiration = findActorItem(actor, ["bardic-inspiration"]);
  const mastersFlourish = findActorItem(actor, ["masters-flourish"]);
  const usesRemaining = itemUsesRemaining(bardicInspiration);
  if (!bardicInspiration && !mastersFlourish) return;
  if (usesRemaining <= 0 && !mastersFlourish) return;

  const flourish = await chooseBladeFlourish();
  if (!flourish) return;

  const useMastersFlourish = Boolean(mastersFlourish)
    && await chooseMastersFlourish(document, usesRemaining);
  const formula = useMastersFlourish ? "1d6" : getBardicInspirationFormula(actor);
  const damageType = flourishDamageType(workflow);

  const receipt = useMastersFlourish ? null : await reserveResources(actor, {item: bardicInspiration});
  if (!useMastersFlourish && !receipt) return;
  try { await globalThis.cat.utils.workflowUtils.bonusDamage(workflow, formula, {damageType}); }
  catch (error) { await refundResources(receipt); throw error; }
  const result = flourishDamageResult(workflow);
  await stampBladeUse(document, "flourishStamps", context.tokenId, context.combatData);

  if (flourish === "defensive") {
    await applyDefensiveFlourish(document, context.token, result);
  } else if (flourish === "mobile") {
    await applyMobileFlourish(document, context.token, hitTargets[0], result);
  } else if (flourish === "slashing") {
    await applySlashingFlourish(document, context.token, hitTargets[0], result, damageType);
  }
  });
}

async function reflectArmorOfAgathys({workflow, sourceToken, document, actor}) {
  if (!workflow || document?.documentName !== "ActiveEffect") return;

  const protectedTokenId = tokenId(sourceToken);
  const wasHit = Array.from(workflow.hitTargets ?? []).some(target => tokenId(target) === protectedTokenId);
  if (!wasHit) return;

  // Nei passaggi targetOnHit CAT espone `actor` come attore del workflow,
  // cioè l'attaccante. I PF temporanei da controllare appartengono invece
  // sempre all'attore che possiede l'effetto Armor of Agathys.
  const protectedActor = document.parent ?? actor;
  const remainingTempHp = Number(protectedActor?.system?.attributes?.hp?.temp ?? 0);
  if (remainingTempHp <= 0 || (document.flags?.[MODULE_ID]?.armorOfAgathys?.trackTempSource
    && protectedActor.flags?.[MODULE_ID]?.temporaryHPSource !== document.uuid)) {
    await cat.utils.documentUtils.deleteDocument(document); return;
  }
  const actionType = workflow.activity?.getActionType?.(workflow.attackMode) ?? workflow.activity?.actionType ?? workflow.item?.system?.actionType;
  const isMeleeAttack = actionType === "mwak" || actionType === "msak";

  if (isMeleeAttack && workflow.token) {
    // Midi espone normalmente l'attaccante come placeable Canvas, mentre CAT
    // richiede un TokenDocument per ricavarne l'UUID del bersaglio sintetico.
    const attacker = tokenDocument(workflow.token);
    if (!attacker?.uuid) {
      console.warn(`${MODULE_TITLE} | Impossibile determinare l'UUID dell'attaccante per Armor of Agathys.`, workflow.token);
    } else {
      const originItem = await fromUuid(document.origin);
      const reflectActivity = originItem?.system?.activities?.get(ARMOR_REFLECT_ACTIVITY_ID);
      if (reflectActivity) {
        const castLevel = Number(document.flags.cat?.castData?.castLevel ?? 1);
        await runSyntheticActivity(
          reflectActivity,
          [attacker],
          {
            atLevel: castLevel,
            consumeUsage: false,
            consumeResources: false,
            spellSlot: false
          }
        );
      }
    }
  }

  // Il colpo è avvenuto mentre l'armatura era attiva: il danno riflesso viene
  // risolto prima di terminare l'effetto che ha appena esaurito i PF temporanei.
  if (remainingTempHp <= 0) {
    await globalThis.cat.utils.documentUtils.deleteDocument(document);
  }

}

export function getSupportedAutomation(item) {
  if (item?.type === "feat" && item.system?.identifier === "arcane-ward" && item.system?.source?.rules === "2014") return ARCANE_WARD_AUTOMATION;
  const armorer = getArmorerAutomation(item);
  if (armorer) return armorer;
  const campaign = getCampaignAutomation(item);
  if (campaign) return campaign;
  const identifier = item?.system?.identifier;
  const rules = item?.system?.source?.rules;
  const automation = SUPPORTED_AUTOMATIONS.get(`${rules}:${identifier}`);
  if (automation?.uuid?.includes(".KhuzoeSpells") && item.type !== "spell") return null;
  return automation ? {identifier, rules, ...automation} : null;
}

function getCompendiumCollection(uuid) {
  const parts = String(uuid ?? "").split(".");
  if (parts[0] !== "Compendium" || parts.length < 4) return null;
  return `${parts[1]}.${parts[2]}`;
}

function preserveBardicInspirationUses(item, changes) {
  if (item?.system?.identifier !== "bardic-inspiration") return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (!changes.system?.uses) return;

  const currentUses = item.toObject?.().system?.uses ?? item.system?.uses;
  if (!currentUses) return;
  changes.system.uses = structuredClone(currentUses);
}

function normalizeBladeFlourishEffect(effect, expiry) {
  if (!effect) return;

  effect.duration = {
    ...(effect.duration ?? {}),
    value: null,
    units: "seconds",
    expiry,
    expired: false
  };
  effect.flags ??= {};
  effect.flags.dae ??= {};
  effect.flags.dae.specialDuration = [];
  effect.flags.dae.expiryMode = "delete";
}

function normalizeBladeFlourishUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (identifier !== "blade-flourish" || !Array.isArray(changes?.effects)) return;

  for (const effect of changes.effects) {
    if (effect?._id === BLADE_MOVEMENT_EFFECT_ID) {
      normalizeBladeFlourishEffect(effect, "sourceEnd");
    } else if (effect?._id === DEFENSIVE_FLOURISH_EFFECT_ID) {
      normalizeBladeFlourishEffect(effect, "sourceStart");
    }
  }
}

function prepareKhuzoeAutomationItemUpdate(item, changes) {
  // CAT replaces flags wholesale; keep Wiki Sync's tree identity and archive links.
  if (changes.flags?.cat?.automation?.source === MODULE_ID && item.flags?.["cripta-wiki-sync"]) {
    changes.flags["cripta-wiki-sync"] = structuredClone(item.flags["cripta-wiki-sync"]);
  }
  preserveBardicInspirationUses(item, changes);
  normalizeBladeFlourishUpdate(item, changes);
  prepareWildShapeItemUpdate(item, changes);
  prepareRageItemUpdate(item, changes);
  prepareCreateBonfireItemUpdate(item, changes);
  prepareWallOfFireItemUpdate(item, changes);
  prepareCombatActionItemUpdate(item, changes);
  prepareKeeperGiantsStrengthItemUpdate(item, changes);
  prepareRuneKnightItemUpdate(item, changes);
  preparePaladinItemUpdate(item, changes);
  prepareWizardItemUpdate(item, changes);
  prepareRogueItemUpdate(item, changes);
  prepareGoliathItemUpdate(item, changes);
  prepareDamageBondItemUpdate(item, changes);
  prepareHomebrewNpcItemUpdate(item, changes);
  prepareCampaignItemUpdate(item, changes);
  prepareArcaneWardUpdate(item, changes);
  prepareArmorerUpdate(item, changes);
}

function isKhuzoeAutomationCurrent(item, automation) {
  if (item?.flags?.cat?.automation?.source !== MODULE_ID) return false;
  const currentVersion = item.flags.cat.automation.version;
  if (!currentVersion) return false;

  try {
    return !foundry.utils.isNewerVersion(automation.version, currentVersion);
  } catch (_error) {
    return currentVersion === automation.version;
  }
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

export function canManageAutomations(actor) {
  if (game.user?.isGM) return true;
  if (!actor) return false;
  if (actor.isOwner) return true;
  try {
    return Boolean(actor.testUserPermission?.(
      game.user,
      globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? "OWNER"
    ));
  } catch (_error) {
    return false;
  }
}

const automationApplications = new Map();
const automationToolbar = createAutomationToolbar({
  getSupportedAutomation, isCurrent: isKhuzoeAutomationCurrent,
  canManage: canManageAutomations, applyAll: applyAllKhuzoeAutomations
});

export async function applyAllKhuzoeAutomations(actor, app, button) {
  if (!canManageAutomations(actor)) {
    ui.notifications.warn(`${MODULE_TITLE}: serve il proprietario del personaggio o il GM.`);
    return;
  }
  const key = actor.uuid ?? actor;
  if (automationApplications.has(key)) return automationApplications.get(key);
  const task = performApplyAllKhuzoeAutomations(actor, app, button);
  automationApplications.set(key, task);
  try { return await task; }
  finally {
    automationApplications.delete(key);
    automationToolbar.refresh(actor);
  }
}

async function performApplyAllKhuzoeAutomations(actor, app, button) {
  const supported = Array.from(actor?.items ?? [])
    .map(item => ({item, automation: getSupportedAutomation(item)}))
    .filter(entry => entry.automation);

  if (!supported.length) {
    ui.notifications.info(`${MODULE_TITLE}: nessuna automazione Khuzoe supportata rilevata su ${actor.name}.`);
    return;
  }

  const pending = supported.filter(({item, automation}) => !isKhuzoeAutomationCurrent(item, automation));
  if (!pending.length) {
    ui.notifications.info(`${MODULE_TITLE}: tutte le ${supported.length} automazioni rilevate sono già aggiornate.`);
    return;
  }

  const missingCollections = Array.from(new Set(
    pending
      .map(({automation}) => getCompendiumCollection(automation.uuid))
      .filter(collection => collection && !game.packs.get(collection))
  ));
  if (missingCollections.length) {
    console.error(
      `${MODULE_TITLE} | Compendi sorgente non caricati: ${missingCollections.join(", ")}. `
      + "È necessario riavviare completamente l'applicazione Foundry dopo l'installazione o l'aggiornamento del modulo."
    );
    ui.notifications.error(
      `${MODULE_TITLE}: il nuovo compendio delle automazioni non è ancora caricato. `
      + "Chiudi completamente Foundry e riaprilo, poi riprova."
    );
    return;
  }

  const itemList = pending.map(({item}) => `<li>${escapeHtml(item.name)}</li>`).join("");
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {title: `${MODULE_TITLE} — applicazione multipla`},
    content: `
      <p>Saranno applicate o aggiornate <strong>${pending.length}</strong> automazioni Khuzoe su <strong>${escapeHtml(actor.name)}</strong>.</p>
      <ul>${itemList}</ul>
      <p>Verranno aggiornate solo le capacità elencate, usando Khuzoe come sorgente.</p>
    `
  });
  if (!confirmed || !canManageAutomations(actor)) return;

  button.disabled = true;
  const originalHtml = button.innerHTML;
  const isToolbar = button.dataset?.khuzoeAction === "sheet-automations";
  if (!isToolbar) button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Applicazione in corso…';

  let applied = 0;
  const failures = [];
  try {
    for (const {item} of pending) {
      try {
        const automation = getSupportedAutomation(item);
        const sourceDocument = automation?.uuid ? await fromUuid(automation.uuid) : null;
        if (!sourceDocument) {
          throw new Error(`Documento sorgente non disponibile: ${automation?.uuid ?? item.name}`);
        }

        await applyArmorerAlias(item, automation, () => applyCampaignAlias(item, automation, () => globalThis.cat.utils.automationUtils.updateItem(item, {
          source: MODULE_ID,
          skipEvent: true
        })));

        const updated = actor.items.get?.(item.id) ?? item;
        if (isKhuzoeAutomationCurrent(updated, automation)) applied += 1;
        else failures.push(item.name);
      } catch (error) {
        failures.push(item.name);
        console.error(`${MODULE_TITLE} | Applicazione non riuscita per ${item.name}.`, error);
      }
    }
  } finally {
    button.disabled = false;
    if (!isToolbar) button.innerHTML = originalHtml;
  }

  if (failures.length) {
    ui.notifications.warn(`${MODULE_TITLE}: applicate ${applied} automazioni; ${failures.length} non riuscite. Controlla la console.`);
  } else {
    const alreadyCurrent = supported.length - pending.length;
    const suffix = alreadyCurrent ? `; ${alreadyCurrent} erano già aggiornate` : "";
    ui.notifications.info(`${MODULE_TITLE}: ${applied} automazioni applicate${suffix}.`);
  }

  app.render();
}

function enhanceActorMedkit(app, html) {
  const root = app?.element ?? html?.[0] ?? html;
  const section = root?.querySelector?.('fieldset[data-section="actor-automations"]');
  const actor = app?.document ?? app?.actor ?? app?.object;
  if (!section || actor?.documentName !== "Actor") return;
  if (section.querySelector('[data-khuzoe-action="apply-all"]')) {
    enhanceWildShapeMedkit(app, section);
    enhanceGiantsMightMedkit(app, section);
    enhanceDamageBondMedkit(app, section);
  enhanceSpellActions(app, section);
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.khuzoeAction = "apply-all";
  button.dataset.tooltip = "Rileva e applica in blocco soltanto le automazioni fornite da Khuzoe Automations";
  button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Applica tutte le automazioni Khuzoe';
  button.disabled = !canManageAutomations(actor);
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void applyAllKhuzoeAutomations(actor, app, button);
  });
  section.append(button);
  enhanceWildShapeMedkit(app, section);
  enhanceGiantsMightMedkit(app, section);
  enhanceDamageBondMedkit(app, section);
  enhanceSpellActions(app, section);
}

function registerAutomations() {
  if (registrationComplete) return true;

  const module = game.modules.get(MODULE_ID);
  const api = khuzoeRegistrationApi(globalThis.cat?.api);

  if (!module?.active || !api) return false;

  try {
    api.registerSourceName(MODULE_ID, MODULE_TITLE);

    const macroResults = ["2014", "2024"].flatMap(rules => [
      api.registerFnMacro({
        source: MODULE_ID,
        rules,
        identifier: "armor-of-agathys",
        roll: [
          {pass: "itemPreambleComplete", macro: prepareArmorOfAgathys, priority: 20},
          {
            pass: "itemRollFinished",
            macro: applyArmorOfAgathys,
            priority: 50
          }
        ]
      }),
      api.registerFnMacro({
        source: MODULE_ID,
        rules,
        identifier: ARMOR_EFFECT_IDENTIFIER,
        roll: [
          {
            pass: "targetOnHit",
            macro: reflectArmorOfAgathys,
            priority: 250
          }
        ]
      })
    ]);

    macroResults.push(
      api.registerFnMacro({
        source: MODULE_ID,
        rules: "2014",
        identifier: "bardic-inspiration",
        roll: [
          {
            pass: "itemPreItemRoll",
            macro: validateBardicInspirationTarget,
            priority: 50
          },
          {
            pass: "itemRollFinished",
            macro: applyBardicInspiration,
            priority: 50
          }
        ]
      }),
      api.registerFnMacro({
        source: MODULE_ID,
        rules: "2014",
        identifier: BARDIC_EFFECT_IDENTIFIER,
        roll: [
          {
            pass: "actorOptionalBonusAttack",
            macro: provideBardicInspirationBonus,
            priority: 50
          }
        ],
        save: [
          {
            pass: "actorOptionalBonus",
            macro: provideBardicInspirationBonus,
            priority: 50
          }
        ],
        skill: [
          {
            pass: "actorOptionalBonus",
            macro: provideBardicInspirationBonus,
            priority: 50
          }
        ],
        check: [
          {
            pass: "actorOptionalBonus",
            macro: provideBardicInspirationBonus,
            priority: 50
          }
        ]
      }),
      api.registerFnMacro({
        source: MODULE_ID,
        rules: "2014",
        identifier: "blade-flourish",
        roll: [
          {
            pass: "actorAttackRollComplete",
            macro: applyBladeFlourishMovement,
            priority: 50
          },
          {
            pass: "actorDamageRollBonuses",
            macro: applyBladeFlourish,
            priority: 50
          }
        ]
      })
    );

    const automationResults = [
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2014",
        identifier: "bless",
        version: BLESS_VERSION,
        uuid: BLESS_UUID,
        type: "spell",
        notes: "Applica automaticamente +1d4 ai tiri per colpire e ai tiri salvezza dei bersagli, con durata e concentrazione gestite da Foundry, Midi-QOL e DAE."
      }),
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2014",
        identifier: "armor-of-agathys",
        version: ARMOR_OF_AGATHYS_VERSION,
        uuid: ARMOR_OF_AGATHYS_UUID_2014,
        type: "spell",
        notes: "Conferisce 5 PF temporanei per livello di lancio e infligge automaticamente lo stesso ammontare di danni da freddo a chi colpisce l'incantatore con un attacco in mischia."
      }),
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2024",
        identifier: "armor-of-agathys",
        version: ARMOR_OF_AGATHYS_VERSION,
        uuid: ARMOR_OF_AGATHYS_UUID_2024,
        type: "spell",
        notes: "Versione 2024: lancio come azione bonus, 5 PF temporanei per livello e danno da freddo automatico contro chi colpisce in mischia."
      }),
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2014",
        identifier: "bardic-inspiration",
        version: BARDIC_INSPIRATION_VERSION,
        uuid: BARDIC_INSPIRATION_UUID,
        type: "feat",
        notes: "Conferisce a un'altra creatura il dado di Bardic Inspiration del bardo. CAT lo propone nei bonus facoltativi di attacchi, prove di caratteristica, prove di abilità e tiri salvezza, consumandolo solo quando viene scelto."
      }),
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2014",
        identifier: "blade-flourish",
        version: BLADE_FLOURISH_VERSION,
        uuid: BLADE_FLOURISH_UUID,
        type: "feat",
        notes: "Automatizza il bonus di movimento e le tre scelte Defensive, Mobile e Slashing Flourish una volta per turno, usando il dado di Bardic Inspiration del bardo."
      }),
      api.registerAutomation({
        source: MODULE_ID,
        rules: "2014",
        identifier: "masters-flourish",
        version: MASTERS_FLOURISH_VERSION,
        uuid: MASTERS_FLOURISH_UUID,
        type: "feat",
        notes: "Abilita in Blade Flourish l'opzione di usare 1d6 senza consumare Bardic Inspiration. Quando rimangono usi, consente di scegliere tra il d6 gratuito e il dado completo."
      })
    ];

    const runeKnight = registerRuneKnight(api);
    macroResults.push(...runeKnight.macros);
    automationResults.push(...runeKnight.automations);

    const wildShape = registerWildShape(api);
    macroResults.push(...wildShape.macros);
    automationResults.push(...wildShape.automations);

    const rage = registerRage(api);
    macroResults.push(...rage.macros);
    automationResults.push(...rage.automations);

    const createBonfire = registerCreateBonfire(api);
    macroResults.push(...createBonfire.macros);
    automationResults.push(...createBonfire.automations);

    const wallOfFire = registerWallOfFire(api);
    macroResults.push(...wallOfFire.macros);
    automationResults.push(...wallOfFire.automations);

    const combatActions2014 = registerCombatActions2014(api);
    macroResults.push(...combatActions2014.macros);
    automationResults.push(...combatActions2014.automations);

    const keeperGiantsStrength = registerKeeperGiantsStrength(api);
    macroResults.push(...keeperGiantsStrength.macros);
    automationResults.push(...keeperGiantsStrength.automations);

    const paladin = registerPaladin(api);
    macroResults.push(...paladin.macros);
    automationResults.push(...paladin.automations);

    const wizard = registerWizard(api);
    macroResults.push(...wizard.macros);
    automationResults.push(...wizard.automations);
    const ward = registerArcaneWard(api);
    macroResults.push(...ward.macros);
    automationResults.push(...ward.automations);
    const armorer = registerArmorer(api);
    macroResults.push(...armorer.macros);
    automationResults.push(...armorer.automations);

    const rogue = registerRogue(api);
    macroResults.push(...rogue.macros);
    automationResults.push(...rogue.automations);

    const goliath = registerGoliath(api);
    macroResults.push(...goliath.macros);
    automationResults.push(...goliath.automations);

    const spells2014 = registerSpells2014(api);
    macroResults.push(...spells2014.macros);
    automationResults.push(...spells2014.automations);

    macroResults.push(registerPersistentSpellAreas(api));
    const expandedSpells2014 = registerExpandedSpells2014(api);
    macroResults.push(...expandedSpells2014.macros);
    automationResults.push(...expandedSpells2014.automations);

    const specialSpells2014 = registerSpecialSpells2014(api);
    macroResults.push(...specialSpells2014.macros);
    automationResults.push(...specialSpells2014.automations);

    const shapechange = registerShapechange(api);
    macroResults.push(...shapechange.macros);
    automationResults.push(...shapechange.automations);

    const damageBond = registerDamageBond(api);
    macroResults.push(...damageBond.macros);
    automationResults.push(...damageBond.automations);

    const homebrewNpcs = registerHomebrewNpcs(api);
    macroResults.push(...homebrewNpcs.macros);
    automationResults.push(...homebrewNpcs.automations);
    const campaign = registerCampaignFeatures(api);
    macroResults.push(...campaign.macros);
    automationResults.push(...campaign.automations);

    if (macroResults.includes(false) || automationResults.includes(false)) {
      throw new Error("CAT ha rifiutato una o più registrazioni Khuzoe.");
    }

    registrationComplete = true;
    console.info(`${MODULE_TITLE} | Automazioni di classi, incantesimi e capacità NPC 2014/2024 registrate in CAT.`);
    return true;
  } catch (error) {
    console.error(`${MODULE_TITLE} | Impossibile registrare le automazioni in CAT.`, error);
    if (game.user?.isGM) {
      ui.notifications.error(`${MODULE_TITLE}: registrazione CAT non riuscita. Controlla la console.`);
    }
    return false;
  }
}

Hooks.once("catReady", () => {
  registerAutomations();
  installCircularAuras();
  registerCircularAuraHooks();
  scheduleCircularAuras();
  scheduleCatDamageWorkflowGuards();
});

function registerPaladinAuraVisuals() {
  game.khuzoeAuras?.registerVisualProvider?.(`${MODULE_ID}.spell-auras`, circularSpellAuraVisuals);
  return game.khuzoeAuras?.registerVisualProvider?.(
    `${MODULE_ID}.paladin-aura`,
    token => paladinAuraVisuals(token)
  ) ?? false;
}

Hooks.once("khuzoeAuras.ready", registerPaladinAuraVisuals);

// Fallback per ordini di caricamento non standard: non duplica la registrazione.
Hooks.once("ready", () => {
  exposeNpcRulesApi();
  registerMidiRollConfig();
  registerAutomations();
  registerCampaignHooks();
  registerArcaneWardHooks();
  registerArmorerHooks();
  installCircularAuras();
  registerCircularAuraHooks();
  scheduleCircularAuras();
  scheduleCatDamageWorkflowGuards();
  registerPaladinAuraVisuals();
  void reconcileAllRuneUses();
  void reconcileAllPaladins().then(() => schedulePaladinAuraReconciliation());
  exposeWildShapeApi();
  void ensureHomebrewNpcAuras();
  void ensureHomebrewNpcHelpers();
});

// Gli attori dei token non collegati vengono costruiti quando la scena entra
// nel canvas e non fanno parte di game.actors: migriamo anche quelle aure.
Hooks.on("canvasReady", canvasInstance => {
  schedulePaladinAuraReconciliation(canvasInstance?.scene);
  void ensureHomebrewNpcAuras();
  void ensureHomebrewNpcHelpers();
});

Hooks.on("createToken", token => {
  if (token?.parent?.id === globalThis.canvas?.scene?.id) {
    schedulePaladinAuraReconciliation(token.parent, token.actor);
  }
  void ensureHomebrewNpcAuras(token);
  void ensureHomebrewNpcHelpers(token);
});

Hooks.on("updateToken", (token, changes, options) => {
  if (options?.khuzoePaladinAuraReconcile) return;
  if (token?.parent?.id !== globalThis.canvas?.scene?.id) return;
  const relevant = ["x", "y", "elevation", "width", "height", "disposition", "actorId", "actorLink"]
    .some(field => Object.hasOwn(changes ?? {}, field));
  if (relevant) {
    void moveSpellAreas(token);
    if (Object.hasOwn(changes, "x") || Object.hasOwn(changes, "y")) void expandedFlameMotion(token);
    schedulePaladinAuraAfterTokenMovement(token);
    if (game.user.isGM) void cleanupSeparatedGrapples(token);
  }
});

Hooks.on("deleteToken", token => {
  if (game.user.isGM) void cleanupSeparatedGrapples(token, {deleted: true});
  if (token?.parent?.id === globalThis.canvas?.scene?.id) {
    schedulePaladinAuraReconciliation(token.parent, token.actor);
  }
});

// Il trasferimento non deve aprire un secondo workflow Midi mentre quello del
// danno principale sta ancora applicando i PF. RollComplete viene emesso da
// Midi dopo WorkflowState_RollFinished: la prima quota è quindi già conclusa e
// non dipende dal fatto che il Legame si trovi sul bersaglio anziché
// sull'attaccante.
Hooks.on("midi-qol.RollComplete", async workflow => {
  try { await healFromNpcRule(workflow); }
  catch (error) {
    console.error("Khuzoe Automations | Cura del preset NPC fallita", error);
    ui.notifications.error("Cura dai danni non applicata. Controlla la console di Foundry.");
  }
  await finishShadowBladeThrow(workflow);
  await resolveQueuedDamageBonds({workflow});
  await resolveQueuedNpcDamageTransfers({workflow});
  await resolveWardingBondTransfers(workflow);
});

registerCombatFallbackHooks();

Hooks.on("combatTurnChange", (combat, _prior, current) => {
  void resetEncouragingDanceReaction(combat, current);
  void triggerHolyNimbusTurnStart(combat, current);
});

// In v14 combatTurnChange viene emesso solo dopo i workflow di fine/inizio
// turno del core. Un errore in un effetto di un altro modulo può interrompere
// quella catena prima dell'hook. updateCombat è il percorso di sicurezza più
// precoce; il reset è idempotente e può quindi essere richiamato da entrambi.
Hooks.on("updateCombat", (combat, changes, options) => {
  if (options?.turnEvents === false) return;
  if (!["round", "turn", "combatants"].some(field => Object.hasOwn(changes ?? {}, field))) return;
  void resetEncouragingDanceReaction(combat, combat.current);
  void triggerHolyNimbusTurnStart(combat, combat.current);
});

Hooks.on("renderApplicationV2", (app, html) => {
  enhanceActorMedkit(app, html);
  automationToolbar.render(app, html);
});
Hooks.on("renderActorSheet", (app, html) => automationToolbar.render(app, html));
Hooks.on("closeApplicationV2", app => automationToolbar.close(app));
Hooks.on("closeActorSheet", app => automationToolbar.close(app));

// CAT sostituisce l'intero oggetto quando si applica una sorgente. Per Bardic
// Inspiration conserviamo usi spesi, formula del massimo e recupero già
// configurato dall'attore (incluso Font of Inspiration).
Hooks.on("preUpdateItem", prepareKhuzoeAutomationItemUpdate);
Hooks.on("preUpdateActor", prepareTemporaryHPUpdate);
Hooks.on("dnd5e.preApplyDamage", preserveTemporaryDamageSource);
Hooks.on("dnd5e.preUseActivity", restrictRageSpellcasting);
Hooks.on("midi-qol.preTargetDamageApplication", rememberTemporaryDamage);

Hooks.on("preCreateActiveEffect", effect => {
  if (preventProtectedConditions(effect) === false) return false;
  prepareShieldEffectExpiry(effect);
  preparePaladinAuraEffectIcon(effect);
});

Hooks.on("createItem", item => {
  automationToolbar.refresh(item.actor);
  if (item?.type === "equipment") void reconcileImpenetrableEgo(item.actor);
  scheduleBladesongStatusCheck(item?.actor);
  if (RUNE_KNIGHT_IDENTIFIERS.has(item?.system?.identifier)) scheduleRuneUseReconciliation(item.actor);
  if (isPaladinReconciliationItem(item)) schedulePaladinReconciliation(item.actor);
  if (HOME_BREW_NPC_IDENTIFIERS.has(item?.system?.identifier)) {
    void ensureHomebrewNpcAuras();
    void ensureHomebrewNpcHelpers(item.actor);
  }
});

Hooks.on("updateItem", (item, changes, options) => {
  automationToolbar.refresh(item.actor);
  if (item?.type === "equipment") void reconcileImpenetrableEgo(item.actor);
  if (item.actor && item.type === "equipment") void reconcileRageStatus(item.actor);
  scheduleBladesongStatusCheck(item?.actor);
  if (options?.khuzoeRuneReconcile || options?.khuzoePaladinReconcile) return;
  const updatedIdentifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (RUNE_KNIGHT_IDENTIFIERS.has(updatedIdentifier)) scheduleRuneUseReconciliation(item.actor);
  if (isPaladinReconciliationItem(item, updatedIdentifier)) schedulePaladinReconciliation(item.actor);
  if (HOME_BREW_NPC_IDENTIFIERS.has(updatedIdentifier)) {
    void ensureHomebrewNpcAuras();
    void ensureHomebrewNpcHelpers(item.actor);
  }
});

Hooks.on("deleteItem", item => {
  automationToolbar.refresh(item.actor);
  if (item?.type === "equipment" || item?.system?.identifier === "impenetrable-ego") void reconcileImpenetrableEgo(item.actor);
  if (HOME_BREW_NPC_IDENTIFIERS.has(item?.system?.identifier)) void ensureHomebrewNpcAuras();
  scheduleBladesongStatusCheck(item?.actor);
  if (RUNE_KNIGHT_IDENTIFIERS.has(item?.system?.identifier)) scheduleRuneUseReconciliation(item.actor);
  if (isPaladinReconciliationItem(item)) schedulePaladinReconciliation(item.actor);
});

Hooks.on("deleteActiveEffect", (effect, options, userId) => {
  void reconcileImpenetrableEgo(effect?.parent?.actor ?? effect?.parent);
  if (userId === game.user.id) cleanupDeletedGrappleEffect(effect);
  if (userId === game.user.id && !options?.khuzoeGiantsMightRefresh) void restoreGiantsMightTokenSize(effect);
  if (!options?.khuzoePaladinAuraReconcile) {
    schedulePaladinAuraReconciliation(globalThis.canvas?.scene, effect?.parent?.actor ?? effect?.parent);
  }
});

Hooks.on("createActiveEffect", (effect, options, userId) => {
  void reconcileImpenetrableEgo(effect?.parent?.actor ?? effect?.parent);
  if (userId === game.user.id) {
    const actor = effect?.parent?.actor ?? effect?.parent;
    void reconcileRageStatus(actor);
    scheduleBladesongStatusCheck(actor);
    cleanupGrapplesIfIncapacitated(actor);
  }
  if (!options?.khuzoePaladinAuraReconcile) {
    schedulePaladinAuraReconciliation(globalThis.canvas?.scene, effect?.parent?.actor ?? effect?.parent);
  }
});

Hooks.on("updateActiveEffect", (effect, _changes, options, userId) => {
  void reconcileImpenetrableEgo(effect?.parent?.actor ?? effect?.parent);
  if (userId === game.user.id) {
    const actor = effect?.parent?.actor ?? effect?.parent;
    void reconcileRageStatus(actor);
    scheduleBladesongStatusCheck(actor);
    cleanupGrapplesIfIncapacitated(actor);
  }
  if (!options?.khuzoePaladinAuraReconcile) {
    schedulePaladinAuraReconciliation(globalThis.canvas?.scene, effect?.parent?.actor ?? effect?.parent);
  }
});

Hooks.on("updateActor", (actor, changes, options, userId) => {
  if (changes?.ownership || Object.keys(changes ?? {}).some(key => key.startsWith("ownership."))) automationToolbar.refresh(actor);
  void reconcileImpenetrableEgo(actor);
  if (userId === game.user.id) {
    const hp = actor.system?.attributes?.hp;
    if (Number(hp?.temp ?? 0) <= 0) {
      for (const effect of collectionValues(actor.effects)) {
        if (effect.flags?.cat?.identifier === ARMOR_EFFECT_IDENTIFIER) void cat.utils.documentUtils.deleteDocument(effect);
      }
    }
    if (Number(hp?.value ?? 0) <= 0) {
      for (const effect of collectionValues(actor.effects)) {
        const state = effect.flags?.[MODULE_ID]?.expandedSpell;
        if (state?.identifier === "warding-bond" && state.kind === "bond-source") void cat.utils.documentUtils.deleteDocument(effect);
      }
    }
    scheduleBladesongStatusCheck(actor);
    void handleHomebrewNpcActorUpdate(actor, changes);
    void reconcileRageStatus(actor);
  }
  if (
    !options?.khuzoePaladinAuraReconcile
    && (
      foundry.utils.hasProperty(changes, "system.abilities.cha")
      || foundry.utils.hasProperty(changes, "system.attributes.hp")
    )
  ) {
    schedulePaladinAuraReconciliation(globalThis.canvas?.scene, actor);
  }
});

Hooks.on("midi-qol.preAttackRollConfig", applySpellSightRules);
Hooks.on("midi-qol.preTargetDamageApplication", breakCharmOnHarm);
Hooks.on("dnd5e.preUseActivity", restrictGaseousActions);
