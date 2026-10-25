export function registerBuiltInActions(registry) {
  registry.register("healing", executeHealing);
  registry.register("damage", executeDamage);
  registry.register("temphp", executeTemporaryHitPoints);
  registry.register("effect", executeEffect);
}

async function executeHealing(action, context) {
  const hp = context.target.actor?.system?.attributes?.hp;
  if (!hp) return skippedResult(action, context, "KHZ_AURAS.Chat.NoHitPoints");
  if (Number(hp.value ?? 0) >= Number(hp.effectiveMax ?? hp.max ?? 0)) {
    return skippedResult(action, context, "KHZ_AURAS.Chat.FullHitPoints");
  }

  const roll = await evaluateActionRoll(action, context);
  const before = Number(hp.value ?? 0);

  await context.target.actor.applyDamage(
    [{ value: roll.total, type: "healing", properties: new Set() }],
    { only: "healing" }
  );

  const after = Number(context.target.actor.system.attributes.hp.value ?? before);
  return appliedResult(action, context, roll, Math.max(0, after - before), {
    hpBefore: before, hpAfter: after
  });
}

async function executeDamage(action, context) {
  const hp = context.target.actor?.system?.attributes?.hp;
  if (!hp) return skippedResult(action, context, "KHZ_AURAS.Chat.NoHitPoints");

  const [roll, save] = await Promise.all([
    evaluateActionRoll(action, context),
    evaluateSave(action, context)
  ]);

  let multiplier = 1;
  if (save?.success) multiplier = action.save.onSuccess === "half" ? 0.5 : 0;

  const before = healthPoolTotal(hp);
  await context.target.actor.applyDamage(
    [{
      value: roll.total,
      type: action.damageType,
      properties: new Set()
    }],
    { multiplier, only: "damage" }
  );
  const after = healthPoolTotal(context.target.actor.system.attributes.hp);

  const effects = save && !save.success
    ? await applyFailureEffects(action, context)
    : [];

  return appliedResult(action, context, roll, Math.max(0, before - after), {
    save,
    effects,
    grantAuraImmunity: Boolean(save?.success && action.save?.immunityOnSuccess)
  });
}

async function executeEffect(action, context) {
  const save = await evaluateSave(action, context);
  if (!save) return skippedResult(action, context, "KHZ_AURAS.Chat.SaveRequired");

  const effects = save.success ? [] : await applyFailureEffects(action, context);
  if (!save.success && !effects.some(effect => effect.applied)) {
    return {
      ...skippedResult(action, context, effects.length ? "KHZ_AURAS.Chat.NoEffectsApplied" : "KHZ_AURAS.Chat.NoFailureEffects"),
      status: effects.some(effect => effect.error || effect.missing) ? "error" : "skipped",
      error: effects.some(effect => effect.error || effect.missing) ? game.i18n.localize("KHZ_AURAS.Chat.EffectsFailed") : undefined,
      save,
      effects
    };
  }

  return appliedResult(action, context, null, effects.filter(effect => effect.applied).length, {
    save,
    effects,
    grantAuraImmunity: Boolean(save.success && action.save?.immunityOnSuccess)
  });
}

async function executeTemporaryHitPoints(action, context) {
  const hp = context.target.actor?.system?.attributes?.hp;
  if (!hp) return skippedResult(action, context, "KHZ_AURAS.Chat.NoHitPoints");

  const roll = await evaluateActionRoll(action, context);
  const before = Number(hp.temp ?? 0);

  if (typeof context.target.actor.applyTempHP === "function") {
    await context.target.actor.applyTempHP(roll.total);
  } else {
    await context.target.actor.update({
      "system.attributes.hp.temp": Math.max(before, Number(roll.total ?? 0))
    });
  }

  const after = Number(context.target.actor.system.attributes.hp.temp ?? before);
  return appliedResult(action, context, roll, Math.max(0, after - before), {
    tempBefore: before, tempAfter: after
  });
}

async function evaluateActionRoll(action, context) {
  const sharedKey = [
    context.source.id,
    context.aura.id,
    action.id,
    action.formula,
    context.eventContext.eventId
  ].join(":");

  const rollData = context.source.actor?.getRollData?.() ?? {};
  let roll = action.rollMode === "shared" ? context.rollCache.get(sharedKey) : null;
  if (!roll) {
    roll = await createRoll(action.formula, rollData).evaluate({ allowInteractive: false });
    if (action.rollMode === "shared") context.rollCache.set(sharedKey, roll);
  }
  // Cache the common dice, then apply each recipient's own healing modifiers.
  if (action.type === "healing" && hasMaximizedHealing(context.target.actor) && typeof roll.reroll === "function") {
    roll = await roll.reroll({ maximize: true });
  }
  return roll;
}

function hasMaximizedHealing(actor) {
  const value = globalThis.foundry?.utils?.getProperty?.(actor, "flags.midi-qol.grants.max.damage.heal")
    ?? actor?.flags?.["midi-qol"]?.grants?.max?.damage?.heal
    ?? actor?.flags?.["midi-qol"]?.max?.damage?.heal;
  return value === true || value === 1 || value === "1" || value === "true";
}

async function evaluateSave(action, context) {
  if (!["damage", "effect"].includes(action.type) || !action.save?.enabled) return null;
  if (typeof context.target.actor?.rollSavingThrow !== "function") {
    throw new Error(`Actor "${context.target.name}" cannot roll a saving throw.`);
  }

  const dcRoll = await createRoll(
    action.save.dc,
    context.source.actor?.getRollData?.() ?? {}
  ).evaluate({ allowInteractive: false });
  const dc = Number(dcRoll.total ?? 0);

  const rolls = await context.target.actor.rollSavingThrow(
    { ability: action.save.ability },
    { configure: false },
    { create: false }
  );
  const roll = rolls?.[0];
  if (!roll) throw new Error(`Saving throw for "${context.target.name}" was cancelled.`);

  return {
    ability: action.save.ability,
    dc,
    total: Number(roll.total ?? 0),
    success: Number(roll.total ?? 0) >= dc,
    roll
  };
}

function appliedResult(action, context, roll, applied, extra = {}) {
  return {
    status: "applied",
    actionType: action.type,
    damageType: action.type === "damage" ? action.damageType : null,
    sourceId: context.source.id,
    sourceName: context.source.name,
    targetId: context.target.id,
    targetName: context.target.name,
    auraId: context.aura.id,
    auraName: context.aura.name,
    formula: action.formula,
    total: Number(roll?.total ?? 0),
    applied: Number(applied ?? 0),
    roll,
    ...extra
  };
}

export async function applyFailureEffects(action, context) {
  const actor = context.target.actor;
  const references = Array.isArray(action.save?.failureEffects)
    ? action.save.failureEffects
    : [];
  if (!actor?.createEmbeddedDocuments || !references.length) return [];

  const results = [];
  for (const reference of references) {
    try {
      const result = await applyFailureEffect(reference, action, context);
      if (result) results.push(result);
    } catch (error) {
      console.warn("Khuzoe Auras | Failure effect could not be applied.", {
        reference,
        aura: context.aura.name,
        target: context.target.name,
        error
      });
      results.push({ reference, name: reference, applied: false, error: error.message });
    }
  }
  return results;
}

async function applyFailureEffect(reference, action, context) {
  const actor = context.target.actor;
  const statusId = reference.startsWith("status:") ? reference.slice(7) : null;

  if (statusId && traitHasValue(actor.system?.traits?.ci, statusId)) {
    return {
      reference,
      name: conditionLabel(statusId),
      applied: false,
      immune: true
    };
  }

  const existing = findExistingEffect(actor, reference, statusId, action, context);
  const timing = effectTiming(action.save?.effectDurationRounds);
  const showIcon = effectIconVisibility(action.save?.showFailureEffectIcon);
  if (existing) {
    const owned = isOwnedEffect(existing, action, context);
    if (owned && typeof existing.update === "function") {
      await existing.update({ disabled: false, ...timing, showIcon });
      return { reference, name: existing.name ?? conditionLabel(statusId), applied: true, refreshed: true };
    }
    return { reference, name: existing.name ?? conditionLabel(statusId), applied: false, existing: true };
  }

  const data = await resolveEffectData(reference, statusId);
  if (!data) return { reference, name: reference, applied: false, missing: true };

  delete data._id;
  data.disabled = false;
  data.transfer = false;
  data.origin = context.source.actor?.uuid ?? context.source.uuid;
  data.duration = timing.duration;
  data.start = timing.start;
  data.showIcon = showIcon;
  data.flags ??= {};
  data.flags["khuzoe-auras"] = {
    ...(data.flags["khuzoe-auras"] ?? {}),
    auraId: context.aura.id,
    actionId: action.id,
    sourceTokenId: context.source.id,
    sourceTokenUuid: context.source.uuid,
    effectReference: reference
  };

  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  return {
    reference,
    name: created?.name ?? data.name ?? conditionLabel(statusId),
    applied: Boolean(created)
  };
}

async function resolveEffectData(reference, statusId) {
  if (statusId) {
    const EffectClass = globalThis.CONFIG?.ActiveEffect?.documentClass;
    if (typeof EffectClass?.fromStatusEffect !== "function") {
      throw new Error("ActiveEffect.fromStatusEffect non disponibile.");
    }
    const effect = await EffectClass.fromStatusEffect(statusId);
    return effect?.toObject?.() ?? cloneData(effect);
  }

  const uuid = reference.startsWith("uuid:") ? reference.slice(5) : reference;
  const resolveUuid = globalThis.foundry?.utils?.fromUuid ?? globalThis.fromUuid;
  if (typeof resolveUuid !== "function") throw new Error("fromUuid non disponibile.");
  const effect = await resolveUuid(uuid);
  if (!effect) return null;
  return effect.toObject?.() ?? cloneData(effect);
}

function findExistingEffect(actor, reference, statusId, action, context) {
  const matches = Array.from(actor.effects ?? []).filter(effect => (
    (statusId && effect.statuses?.has?.(statusId)) || getEffectFlag(effect, "effectReference") === reference
  ));
  // Prefer our own effect so a disabled/expired instance can be restarted.
  // Inactive effects belonging to another source must not block a new one.
  return matches.find(effect => isOwnedEffect(effect, action, context))
    ?? matches.find(effect => !effect.disabled && !effect.isSuppressed && !effect.duration?.expired);
}

function isOwnedEffect(effect, action, context) {
  const sourceUuid = getEffectFlag(effect, "sourceTokenUuid");
  return getEffectFlag(effect, "auraId") === context.aura.id
    && getEffectFlag(effect, "actionId") === action.id
    && (sourceUuid ? sourceUuid === context.source.uuid : getEffectFlag(effect, "sourceTokenId") === context.source.id);
}

function getEffectFlag(effect, key) {
  return effect.getFlag?.("khuzoe-auras", key)
    ?? effect.flags?.["khuzoe-auras"]?.[key];
}

function effectTiming(roundsValue) {
  const rounds = Math.trunc(Math.max(0, Number(roundsValue ?? 1)));
  const EffectClass = globalThis.CONFIG?.ActiveEffect?.documentClass;
  const start = typeof EffectClass?.getEffectStart === "function"
    ? EffectClass.getEffectStart()
    : {
        time: Number(game.time?.worldTime ?? 0),
        combat: null,
        combatant: null,
        initiative: null,
        round: null,
        turn: null
      };

  return {
    start,
    duration: rounds
      ? {value: rounds, units: "rounds", expiry: "turnStart", expired: false}
      : {value: null, units: "seconds", expiry: null, expired: false}
  };
}

function effectIconVisibility(visible) {
  const modes = globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON;
  return visible === false ? (modes?.NEVER ?? 0) : (modes?.ALWAYS ?? 2);
}

function traitHasValue(trait, value) {
  return trait?.value?.has?.(value)
    || (Array.isArray(trait?.value) && trait.value.includes(value));
}

function conditionLabel(statusId) {
  if (!statusId) return "";
  const config = CONFIG.DND5E?.conditionTypes?.[statusId]
    ?? CONFIG.statusEffects?.find?.(status => status.id === statusId);
  const key = config?.name ?? config?.label;
  return key ? game.i18n.localize(key) : statusId;
}

function cloneData(value) {
  const clone = globalThis.foundry?.utils?.deepClone;
  if (typeof clone === "function") return clone(value);
  return structuredClone(value);
}

function skippedResult(action, context, reason) {
  return {
    status: "skipped",
    actionType: action.type,
    damageType: action.type === "damage" ? action.damageType : null,
    sourceId: context.source.id,
    sourceName: context.source.name,
    targetId: context.target.id,
    targetName: context.target.name,
    auraId: context.aura.id,
    auraName: context.aura.name,
    reason
  };
}

function healthPoolTotal(hp) {
  return Number(hp?.value ?? 0) + Number(hp?.temp ?? 0);
}

function createRoll(formula, data = {}) {
  const RollClass = globalThis.foundry?.dice?.Roll;
  if (typeof RollClass?.create === "function") return RollClass.create(formula, data);
  return new globalThis.Roll(formula, data);
}
