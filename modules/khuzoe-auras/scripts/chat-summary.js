import { triggerToPresetKey } from "./model.js";

/** Prepare escaped, grouped chat data without changing the executed results. */
export function buildChatSummary(results) {
  const groups = new Map();
  const rows = results.map(result => {
    const triggerKey = triggerToPresetKey({ event: result.event, subject: result.triggerSubject });
    const eventLabel = game.i18n.localize(triggerKey
      ? `KHZ_AURAS.Triggers.${triggerKey}`
      : `KHZ_AURAS.Events.${result.event}`);
    const effects = (result.effects ?? []).map(effect => {
      const state = effect.refreshed ? "EffectRefreshed" : effect.applied ? "EffectApplied"
        : effect.immune ? "EffectImmune" : effect.existing ? "EffectExisting"
        : effect.missing ? "EffectMissing" : "EffectFailed";
      return {
        name: game.i18n.localize(effect.name || effect.reference || ""),
        label: game.i18n.localize(`KHZ_AURAS.Chat.${state}`),
        failed: Boolean(effect.error || effect.missing),
        error: effect.error
      };
    });
    const row = {
      ...result,
      effects,
      eventLabel,
      outcome: outcome(result),
      isError: result.status === "error",
      icon: {
        healing: "fa-heart-pulse", damage: "fa-burst", temphp: "fa-shield-heart",
        effect: "fa-wand-magic-sparkles"
      }[result.actionType] ?? "fa-sun",
      rollLabel: result.roll ? game.i18n.format("KHZ_AURAS.Chat.Rolled", { total: result.total }) : "",
      saveLabel: result.save ? game.i18n.format("KHZ_AURAS.Chat.SavingThrow", {
        ability: configurationLabel(globalThis.CONFIG?.DND5E?.abilities?.[result.save.ability], result.save.ability),
        total: result.save.total,
        dc: result.save.dc
      }) : "",
      saveOutcome: result.save ? game.i18n.localize(`KHZ_AURAS.Chat.${result.save.success ? "SaveSuccess" : "SaveFailure"}`) : "",
      immunityLabel: result.auraImmunityGranted ? game.i18n.localize("KHZ_AURAS.Chat.AuraImmunityGranted") : ""
    };
    const key = JSON.stringify([
      result.sourceId ?? result.sourceName, result.auraId ?? result.auraName,
      result.event, result.triggerSubject
    ]);
    if (!groups.has(key)) groups.set(key, {
      auraName: result.auraName, sourceName: result.sourceName, eventLabel, rows: []
    });
    groups.get(key).rows.push(row);
    return row;
  });
  return {
    title: game.i18n.localize("KHZ_AURAS.Chat.Title"),
    sourceLabel: game.i18n.localize("KHZ_AURAS.Chat.Source"),
    rows,
    groups: [...groups.values()]
  };
}

function outcome(result) {
  if (result.status === "error") return game.i18n.localize("KHZ_AURAS.Chat.Error");
  if (result.status === "skipped") return game.i18n.localize(result.reason);
  const amount = Number(result.applied ?? 0);
  const type = configurationLabel(globalThis.CONFIG?.DND5E?.damageTypes?.[result.damageType], result.damageType ?? "");
  const key = result.actionType === "healing" ? (amount > 0 ? "Healed" : "NoHealing")
    : result.actionType === "damage" ? (amount > 0 ? (type ? "DamagedTyped" : "Damaged") : "NoDamage")
    : result.actionType === "temphp" ? (amount > 0 ? "TemporarySet" : "TemporaryKept")
    : result.actionType === "effect" ? (amount > 0 ? "EffectsApplied" : "NoEffectsApplied") : null;
  return key ? game.i18n.format(`KHZ_AURAS.Chat.${key}`, {
    amount, type, value: result.tempAfter ?? result.total
  }) : game.i18n.localize(`KHZ_AURAS.Actions.${result.actionType}`);
}

function configurationLabel(data, fallback) {
  const label = typeof data === "string" ? data : data?.label;
  return label ? game.i18n.localize(label) : fallback;
}
