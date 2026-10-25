import {updateDocumentSafely} from "./cat-compat.mjs";

const SPELLS = new Set([
  "hold-person", "synaptic-static", "melfs-acid-arrow", "vitriolic-sphere",
  "tashas-caustic-brew", "blinding-smite", "wrathful-smite"
]);

function values(collection) {
  if (!collection) return [];
  return Array.isArray(collection) ? collection : collection.contents ?? Array.from(collection.values?.() ?? Object.values(collection));
}

// DAE can evaluate formula references before itemRollFinished. Replace the
// resulting value, including an already unresolved zero, with the caster's DC.
export function spellOvertimeChanges(changes, identifier, {saveDC, castLevel} = {}) {
  if (!SPELLS.has(identifier)) return changes;
  return changes.map(change => {
    if (!String(change.key).startsWith("flags.midi-qol.OverTime")) return change;
    const fields = new Map(String(change.value).split(",").filter(part => part.includes("=")).map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }));
    if (fields.has("saveDC") && Number.isFinite(saveDC)) fields.set("saveDC", String(saveDC));
    if (identifier === "melfs-acid-arrow") {
      fields.set("damageRoll", `${Math.max(2, Number(castLevel) || 2)}d4`);
      // Let Midi remove the effect after resolving this single damage event,
      // avoiding a competing source-turn expiry before the target takes damage.
      fields.set("removeCondition", "true");
    }
    if (identifier === "tashas-caustic-brew") fields.set("damageRoll", `${2 * Math.max(1, Number(castLevel) || 1)}d4`);
    fields.set("allowIncapacitated", identifier === "wrathful-smite" ? "false" : "true");
    fields.set("saveMagic", "true");
    return {...change, value: [...fields].map(([key, value]) => `${key}=${value}`).join(",")};
  });
}

export async function normalizeSpellOvertime(workflow, item = workflow?.item, options = {}) {
  if (!workflow || workflow.aborted || !item) return;
  const identifier = item.flags?.cat?.identifier ?? item.system?.identifier;
  if (!SPELLS.has(identifier)) return;
  const dc = options.saveDC ?? workflow.castData?.saveDC
    ?? (workflow.activity ? globalThis.cat?.utils?.activityUtils?.getSaveDC?.(workflow.activity) : undefined)
    ?? item.actor?.system?.attributes?.spell?.dc;
  const state = {saveDC: dc == null ? undefined : Number(dc),
    castLevel: options.castLevel ?? workflow.castData?.castLevel ?? item.system?.level};
  const actors = new Set(values(workflow.targets).map(target => target.actor ?? target.document?.actor).filter(Boolean));
  for (const actor of actors) {
    for (const effect of values(actor.effects)) {
      if (effect.origin !== item.uuid && !String(effect.origin ?? "").startsWith(`${item.uuid}.Activity.`)) continue;
      const current = values(effect.system?.changes);
      if (!current.some(change => String(change.key).startsWith("flags.midi-qol.OverTime"))) continue;
      const next = spellOvertimeChanges(current, identifier, state);
      const update = {};
      if (JSON.stringify(current) !== JSON.stringify(next)) update["system.changes"] = next;
      if (identifier === "melfs-acid-arrow") {
        if (effect.flags?.dae?.specialDuration?.length) update["flags.dae.specialDuration"] = [];
        if (effect.duration?.expiry !== "turnStart") update["duration.expiry"] = "turnStart";
      }
      if (Object.keys(update).length) await updateDocumentSafely(effect, update);
    }
  }
}
