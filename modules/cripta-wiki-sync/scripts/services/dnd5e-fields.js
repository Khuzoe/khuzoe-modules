/** Native preparation is numeric: 0 unprepared, 1 prepared, 2 always prepared. */
export function normalizePreparedState(value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "boolean") return Number(value);
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function readSpellPreparation(system = {}) {
    // Only plain legacy snapshots may provide preparation. Never invoke the
    // deprecated accessor on a live SpellData model, even as a fallback.
    const legacy = system && Object.getOwnPropertyDescriptor(system, "preparation")?.value;
    const mode = legacy?.mode;
    const method = system?.method ?? (["always", "prepared"].includes(mode) ? "spell" : mode);
    const prepared = normalizePreparedState(system?.prepared)
        ?? (mode === "always" ? 2 : normalizePreparedState(legacy?.prepared));
    return { method, prepared };
}

/** The published wiki still consumes this plain JSON shape, not a Foundry accessor. */
export function spellPreparationForWiki(system) {
    const { method, prepared } = readSpellPreparation(system);
    return {
        mode: prepared === 2 ? "always" : (method === "spell" ? "prepared" : method),
        prepared: prepared === undefined ? undefined : prepared > 0
    };
}

/** Translate old website controls on a detached update, preserving native fields. */
export function modernizeSpellPreparationUpdate(update, currentSystem) {
    const system = update?.system;
    const legacy = system && Object.getOwnPropertyDescriptor(system, "preparation")?.value;
    if (!legacy || typeof legacy !== "object") return update;
    const current = readSpellPreparation(currentSystem);
    if (legacy.mode !== undefined && system.method === undefined) {
        system.method = ["always", "prepared"].includes(legacy.mode) ? "spell" : legacy.mode;
    }
    if (system.prepared === undefined) {
        if (legacy.mode === "always") system.prepared = 2;
        else if (legacy.prepared !== undefined) system.prepared = normalizePreparedState(legacy.prepared);
        else if (legacy.mode !== undefined && current.prepared === 2) system.prepared = 1;
    }
    delete system.preparation;
    return update;
}

/** Canonical senses, with resolved ranges and no deprecated enumerable aliases. */
export function readDnd5eSenses(senses = {}) {
    if (!senses || typeof senses !== "object") return {};
    const legacyKeys = ["darkvision", "blindsight", "tremorsense", "truesight"];
    const descriptors = Object.getOwnPropertyDescriptors(senses);
    const fields = Object.fromEntries(Object.entries(descriptors)
        .filter(([key, descriptor]) => key !== "ranges" && !legacyKeys.includes(key) && Object.hasOwn(descriptor, "value"))
        .map(([key, descriptor]) => [key, descriptor.value]));
    const sourceRanges = senses.ranges;
    const ranges = sourceRanges instanceof Map ? Object.fromEntries(sourceRanges)
        : (sourceRanges && typeof sourceRanges === "object" ? { ...sourceRanges } : {});
    for (const key of legacyKeys) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(ranges, key) && descriptor && Object.hasOwn(descriptor, "value")) ranges[key] = descriptor.value;
    }
    return { ...fields, ranges };
}
