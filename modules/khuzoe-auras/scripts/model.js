import {
  DEFAULT_COLOR,
  FREQUENCIES,
  ROLL_MODES,
  SAVE_RESULTS,
  STACKING_MODES,
  TARGET_RELATIONS,
  TRIGGER_PRESETS
} from "./constants.js";

const FALLBACK_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function createId(prefix = "id") {
  const foundryId = globalThis.foundry?.utils?.randomID?.();
  if (foundryId) return `${prefix}-${foundryId}`;

  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;

  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix += FALLBACK_ID_ALPHABET[Math.floor(Math.random() * FALLBACK_ID_ALPHABET.length)];
  }
  return `${prefix}-${suffix}`;
}

export function createDefaultAction(overrides = {}) {
  const action = {
    id: createId("action"),
    type: "healing",
    formula: "1d6",
    damageType: "radiant",
    rollMode: "perTarget",
    save: {
      enabled: false,
      ability: "dex",
      dc: "10",
      onSuccess: "half",
      immunityOnSuccess: false,
      failureEffects: [],
      effectDurationRounds: 1,
      showFailureEffectIcon: true
    }
  };

  return normalizeAction({ ...action, ...overrides });
}

export function createDefaultAura(overrides = {}) {
  const aura = {
    id: createId("aura"),
    name: "Aura curativa",
    enabled: true,
    visualOnly: false,
    area: {
      distance: 15,
      walls: false,
      elevation: false
    },
    targets: {
      relation: "ally",
      includeSource: false
    },
    source: {
      requiresConscious: true
    },
    triggers: [
      {
        event: "turnStart",
        subject: "source",
        frequency: "oncePerPhase"
      }
    ],
    actions: [createDefaultAction()],
    stacking: {
      group: "",
      mode: "stack",
      priority: 0
    },
    visual: {
      visible: true,
      color: DEFAULT_COLOR,
      opacity: 0.12,
      lineOpacity: 0.85,
      lineWidth: 2
    }
  };

  return normalizeAura(mergePlain(aura, overrides));
}

export function normalizeAura(raw = {}) {
  const area = isPlainObject(raw.area) ? raw.area : {};
  const targets = isPlainObject(raw.targets) ? raw.targets : {};
  const source = isPlainObject(raw.source) ? raw.source : {};
  const stacking = isPlainObject(raw.stacking) ? raw.stacking : {};
  const visual = isPlainObject(raw.visual) ? raw.visual : {};

  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map(normalizeTrigger).filter(Boolean)
    : [];

  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(normalizeAction).filter(Boolean)
    : [];

  return {
    id: cleanString(raw.id) || createId("aura"),
    name: cleanString(raw.name) || "Aura",
    enabled: toBoolean(raw.enabled, true),
    visualOnly: toBoolean(raw.visualOnly, false),
    area: {
      distance: clampNumber(area.distance, 0, 1000, 15),
      walls: toBoolean(area.walls, false),
      elevation: toBoolean(area.elevation, false)
    },
    targets: {
      relation: enumValue(targets.relation, TARGET_RELATIONS, "ally"),
      includeSource: toBoolean(targets.includeSource, false)
    },
    source: {
      requiresConscious: toBoolean(source.requiresConscious, true)
    },
    triggers: triggers.length
      ? deduplicateTriggers(triggers)
      : [normalizeTrigger({ event: "turnStart", subject: "source" })],
    actions: actions.length ? actions : [createDefaultAction()],
    stacking: {
      group: cleanString(stacking.group),
      mode: enumValue(stacking.mode, STACKING_MODES, "stack"),
      priority: clampNumber(stacking.priority, -999, 999, 0)
    },
    visual: {
      visible: toBoolean(visual.visible, true),
      color: normalizeColor(visual.color),
      opacity: clampNumber(visual.opacity, 0, 0.5, 0.12),
      lineOpacity: clampNumber(visual.lineOpacity, 0, 1, 0.85),
      lineWidth: clampNumber(visual.lineWidth, 0, 10, 2)
    }
  };
}

export function normalizeAction(raw = {}) {
  if (!isPlainObject(raw)) return null;

  const save = isPlainObject(raw.save) ? raw.save : {};
  return {
    id: cleanString(raw.id) || createId("action"),
    type: normalizeActionType(raw.type),
    formula: cleanString(raw.formula) || "1d6",
    damageType: cleanString(raw.damageType) || "radiant",
    rollMode: enumValue(raw.rollMode, ROLL_MODES, "perTarget"),
    save: {
      enabled: toBoolean(save.enabled, false),
      ability: cleanString(save.ability) || "dex",
      dc: cleanString(save.dc) || "10",
      onSuccess: enumValue(save.onSuccess, SAVE_RESULTS, "half"),
      immunityOnSuccess: toBoolean(save.immunityOnSuccess, false),
      failureEffects: normalizeStringList(save.failureEffects),
      effectDurationRounds: Math.trunc(clampNumber(save.effectDurationRounds, 0, 999, 1)),
      showFailureEffectIcon: toBoolean(save.showFailureEffectIcon, true)
    }
  };
}

export function normalizeTrigger(raw = {}) {
  if (typeof raw === "string") {
    const preset = TRIGGER_PRESETS[raw];
    if (!preset) return null;
    return { ...preset, frequency: "oncePerPhase" };
  }

  if (!isPlainObject(raw)) return null;
  const event = cleanString(raw.event);
  const subject = cleanString(raw.subject);
  const validPreset = Object.values(TRIGGER_PRESETS).some(
    preset => preset.event === event && preset.subject === subject
  );
  if (!validPreset) return null;

  return {
    event,
    subject,
    frequency: enumValue(raw.frequency, FREQUENCIES, "oncePerPhase")
  };
}

export function triggerToPresetKey(trigger) {
  return Object.entries(TRIGGER_PRESETS).find(([, preset]) => (
    preset.event === trigger.event && preset.subject === trigger.subject
  ))?.[0] ?? null;
}

export function auraMapFromArray(auras = []) {
  return Object.fromEntries(auras.map(normalizeAura).map(aura => [aura.id, aura]));
}

export function mergePlain(base, overrides) {
  const output = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) output[key] = mergePlain(base[key], value);
    else output[key] = value;
  }
  return output;
}

function deduplicateTriggers(triggers) {
  const seen = new Set();
  return triggers.filter(trigger => {
    const key = `${trigger.event}:${trigger.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeColor(value) {
  const color = cleanString(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_COLOR;
}

function normalizeActionType(value) {
  const type = cleanString(value);
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(type) ? type : "healing";
}

function enumValue(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return ["true", "1", "on", "yes"].includes(value.toLowerCase());
  return Boolean(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
