/** Keep both Midi's damage detail and the prediction read by later CAT reactions consistent. */
export function appliedDamageAmount(ditem) {
  if (!Array.isArray(ditem?.damageDetail)) return Math.max(0, Number(ditem?.hpDamage ?? 0) + Number(ditem?.tempDamage ?? 0));
  return Math.max(0, Math.floor(ditem.damageDetail.reduce((sum, part) =>
    ["healing", "temphp", "midi-none", "vitality", "maximum"].includes(part.type) ? sum : sum + Number(part.value ?? 0), 0)));
}

export function adjustAppliedDamage(ditem, amount, options = {}) {
  // CAT 0.0.7 caps a reduction at hpDamage, which is already capped at the
  // victim's remaining HP. That loses overkill damage (and breaks Death Ward).
  if (Array.isArray(ditem.damageDetail) && globalThis.MidiQOL?.modifyDamageBy && options.multiplier !== "auto") {
    const type = options.type ?? "none";
    const value = amount < 0 && type !== "healing" ? Math.max(amount, -appliedDamageAmount(ditem)) : amount;
    MidiQOL.modifyDamageBy({damageItem: ditem, value, type, multiplier: options.multiplier ?? 1});
    (ditem.rawDamageDetail ??= []).push({value, type});
  } else globalThis.cat.utils.workflowUtils.modifyDamageAppliedFlat(ditem, amount, options);
  if (!Number.isFinite(ditem.oldHP) || !Number.isFinite(ditem.oldTempHP) || !Array.isArray(ditem.damageDetail)) return;
  const excluded = new Set(["temphp", "midi-none", "vitality", "maximum"]);
  const components = ditem.damageDetail.filter(part => !excluded.has(part.type));
  const damageTotal = Math.max(0, components.filter(part => part.type !== "healing").reduce((sum, part) => sum + Number(part.value ?? 0), 0));
  const healing = components.filter(part => part.type === "healing").reduce((sum, part) => sum + Number(part.value ?? 0), 0);
  const damage = Math.floor(damageTotal) + Math.ceil(healing);
  ditem.totalDamage = damageTotal;
  ditem.healingAdjustedTotalDamage = damage;
  const tempDamage = damage > 0 ? Math.min(ditem.oldTempHP, damage) : 0;
  const actor = ditem.actor ?? (ditem.actorUuid ? globalThis.fromUuidSync?.(ditem.actorUuid, {strict: false}) : null);
  const hp = actor?.system?.attributes?.hp;
  const maximum = Number(ditem.maxHP ?? (Number.isFinite(hp?.damage) ? ditem.oldHP + hp.damage : hp?.max) ?? Infinity);
  const hpDamage = Math.max(ditem.oldHP - maximum, Math.min(ditem.oldHP, damage - tempDamage));
  const grantedTemp = Math.max(0, ...ditem.damageDetail.filter(part => part.type === "temphp").map(part => Math.abs(Number(part.value ?? 0))));
  ditem.hpDamage = hpDamage;
  ditem.newTempHP = Math.max(grantedTemp, ditem.oldTempHP - tempDamage);
  ditem.tempDamage = ditem.oldTempHP - ditem.newTempHP;
  ditem.newHP = ditem.oldHP - hpDamage;
}

const damageEntries = value => Array.isArray(value) ? value : value ? Array.from(value.values?.() ?? Object.values(value)) : [];
/** Damage after resistance, immunity and target reductions. Never estimates from raw rolls. */
export function damageDealt(workflow, target, type) {
  if (workflow?.aborted) return 0;
  target = target?.document ?? target;
  if (!target) return 0;
  const entry = damageEntries(workflow?.damageList).find(data =>
    data.tokenUuid === target.uuid || data.targetUuid === target.uuid
    || data.tokenId === target.id || (!data.tokenUuid && !data.targetUuid && !data.tokenId && (data.actorUuid === target.actor?.uuid || data.actorId === target.actor?.id)));
  if (!entry || entry.isHit === false) return 0;
  const details = entry.damageDetail ?? entry.damageDetails?.combinedDamage;
  if (!details) return Math.max(0, Number(entry.hpDamage ?? 0) + Number(entry.tempDamage ?? 0));
  const nonDamage = new Set(["healing", "temphp", "vitality", "maximum", "none", "midi-none"]);
  const typed = damageEntries(details).reduce((sum, part) => sum + ((type ? part.type === type : !nonDamage.has(part.type)) ? Math.max(0, Number(part.value ?? part.damage) || 0) : 0), 0);
  const genericReduction = damageEntries(details).reduce((sum, part) =>
    sum + (["none", "midi-none"].includes(part.type) ? Math.min(0, Number(part.value ?? part.damage) || 0) : 0), 0);
  // Losing the target's last HP does not cap the damage dealt by the spell.
  // Use the effective damage breakdown, not HP subtraction (capped at zero).
  return Math.max(0, Math.floor(typed + genericReduction));
}
