const LEGACY_MODE_TYPES = Object.freeze({
    0: "custom",
    1: "multiply",
    2: "add",
    3: "downgrade",
    4: "upgrade",
    5: "override"
});

const DEFAULT_PRIORITIES = Object.freeze({
    custom: 0,
    multiply: 10,
    add: 20,
    subtract: 20,
    downgrade: 30,
    upgrade: 40,
    override: 50
});

function deepClone(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function getActiveEffectChanges(effect = {}) {
    const source = effect?._source || effect;
    if (Array.isArray(source?.system?.changes)) return source.system.changes;
    if (Array.isArray(effect?.system?.changes)) return effect.system.changes;
    if (Array.isArray(source?.changes)) return source.changes;
    if (Array.isArray(effect?.changes)) return effect.changes;
    return [];
}

export function normalizeActiveEffectChangeV14(change = {}) {
    const legacyMode = Number(change?.mode);
    const type = String(change?.type || (Number.isFinite(legacyMode) ? LEGACY_MODE_TYPES[legacyMode] : "add"));
    const priority = Number(change?.priority);
    return {
        key: String(change?.key || ""),
        type,
        value: change?.value ?? "",
        phase: String(change?.phase || "initial"),
        priority: Number.isFinite(priority) ? priority : (DEFAULT_PRIORITIES[type] ?? 0)
    };
}

export function normalizeActiveEffectChangesV14(changes = []) {
    return (Array.isArray(changes) ? changes : [])
        .filter((change) => change && typeof change === "object")
        .map(normalizeActiveEffectChangeV14);
}

function normalizeDuration(source = {}) {
    const duration = source?.duration && typeof source.duration === "object" ? deepClone(source.duration) : {};
    if (Object.hasOwn(duration, "value") || duration.units) return duration;
    for (const units of ["rounds", "turns", "seconds"]) {
        const value = Number(duration[units]);
        if (!Number.isFinite(value)) continue;
        return { value, units, expiry: units === "seconds" ? null : "turnStart", expired: false };
    }
    return { value: null, units: "seconds", expiry: null, expired: false };
}

export function normalizeActiveEffectSourceV14(effect = {}) {
    const source = deepClone(effect?._source || effect || {});
    const changes = normalizeActiveEffectChangesV14(getActiveEffectChanges(source));
    source.system = { ...(source.system || {}), changes };
    delete source.changes;
    source.duration = normalizeDuration(source);
    if (!source.img && source.icon) source.img = source.icon;
    delete source.icon;
    if (source.showIcon === undefined) {
        const legacyShowIcon = source.flags?.dae?.showIcon;
        source.showIcon = legacyShowIcon === true ? 2 : (legacyShowIcon === false ? 0 : 1);
    }
    return source;
}
