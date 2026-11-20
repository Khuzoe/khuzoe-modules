const modifiers = {
  resistance: "Resistance", immunity: "Immunity", vulnerability: "Vulnerability",
  absorption: "Absorption", saved: "Save", DR: "Reduction", uncannyDodge: "Dodge", threshold: "Threshold"
};

function byType(parts) {
  const groups = new Map();
  if (!Array.isArray(parts)) return groups;
  for (const part of parts) {
    if (!part || !Number.isFinite(part.value) || part.type === "midi-none") continue;
    const type = part.type || "none";
    const group = groups.get(type) ?? { value: 0, reasons: new Set() };
    group.value += part.value;
    for (const [key, label] of Object.entries(modifiers)) {
      if ([part.active, part.active?.all, part.active?.type].some(flags => flags?.[key] === true)) {
        group.reasons.add(label);
      }
    }
    groups.set(type, group);
  }
  return groups;
}

export function damageTypes(entry) {
  const selector = entry.damageSelector;
  const raw = byType(entry.rawDamageDetail ?? entry.damageDetails?.[`raw${selector}`] ?? entry.damageDetail);
  // Midi's undoDamage.damageDetail holds the raw input needed by its Apply button.
  const calculated = byType(entry.damageDetails?.[selector]);
  return Array.from(new Set([...raw.keys(), ...calculated.keys()]), type => {
    const final = calculated.get(type);
    const magnitude = value => type === "healing" && value !== undefined ? Math.abs(value) : value;
    return { type, rolled: magnitude(raw.get(type)?.value), result: magnitude(final?.value), reasons: [...(final?.reasons ?? [])] };
  });
}

export function hpChange(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return { before, after, delta: after - before };
}
