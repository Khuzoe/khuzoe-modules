export const PRODUCTION_SECONDS_PER_DAY = 86400;
export const PRODUCTION_LOG_LIMIT = 30;
export const PRODUCTION_QUANTITY_LIMIT = 10000;

export const DEFAULT_PRODUCTION = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  mode: "weighted",
  timeBasis: "world",
  intervalDays: 1,
  maxCatchUp: 30,
  lastProcessedAt: null,
  lastRunAt: null,
  rules: [],
  log: []
});

function clone(value) {
  if (value === undefined) return undefined;
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function finiteTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum));
}

export function normalizeQuantityFormula(value) {
  const formula = String(value ?? "1").trim().slice(0, 40);
  return formula || "1";
}

export function productionFormulaIsSafe(value) {
  const formula = normalizeQuantityFormula(value);
  if (!/^[0-9dD+\-*/().\s]+$/.test(formula)) return false;
  for (const match of formula.matchAll(/(\d*)[dD](\d+)/g)) {
    const dice = Number(match[1] || 1);
    const faces = Number(match[2]);
    if (!Number.isSafeInteger(dice) || dice < 1 || dice > 100) return false;
    if (!Number.isSafeInteger(faces) || faces < 1 || faces > 10000) return false;
  }
  return true;
}

function cleanMaximum(value) {
  if (value === null || value === undefined || value === "") return null;
  const maximum = Number.parseInt(value, 10);
  return Number.isFinite(maximum) ? Math.max(0, maximum) : null;
}

function cleanRule(rule, index = 0) {
  const source = rule && typeof rule === "object" ? rule : {};
  return {
    id: String(source.id || `production-rule-${index}`).slice(0, 80),
    targetEntryId: String(source.targetEntryId || "").slice(0, 80),
    sourceUuid: String(source.sourceUuid || "").slice(0, 500),
    name: String(source.name || "Oggetto").slice(0, 120),
    img: String(source.img || "icons/svg/item-bag.svg").slice(0, 500),
    type: String(source.type || "item").slice(0, 60),
    description: String(source.description || ""),
    quantityFormula: normalizeQuantityFormula(source.quantityFormula),
    chance: boundedNumber(source.chance, 100, 0, 100),
    maximum: cleanMaximum(source.maximum),
    price: clone(source.price || {}),
    cost: clone(source.cost || {}),
    data: clone(source.data || {}),
    dataBundleMode: source.dataBundleMode === "single" ? "single" : "copies",
    dataBundle: Array.isArray(source.dataBundle) && source.dataBundle.length
      ? clone(source.dataBundle)
      : undefined
  };
}

function cleanLogEntry(entry, index = 0) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    id: String(source.id || `production-log-${index}`).slice(0, 80),
    timestamp: finiteTimestamp(source.timestamp) ?? 0,
    timeBasis: source.timeBasis === "real" ? "real" : "world",
    manual: Boolean(source.manual),
    skippedCycles: boundedInteger(source.skippedCycles, 0, 0, 1000000),
    results: (Array.isArray(source.results) ? source.results : []).slice(0, 100).map((result) => ({
      ruleId: String(result?.ruleId || "").slice(0, 80),
      name: String(result?.name || "Oggetto").slice(0, 120),
      rolled: boundedInteger(result?.rolled, 0, 0, PRODUCTION_QUANTITY_LIMIT),
      added: boundedInteger(result?.added, 0, 0, PRODUCTION_QUANTITY_LIMIT),
      capped: Boolean(result?.capped),
      skipped: String(result?.skipped || "").slice(0, 40)
    }))
  };
}

export function normalizeProduction(source = {}) {
  const raw = source && typeof source === "object" ? source : {};
  return {
    schemaVersion: 1,
    enabled: Boolean(raw.enabled),
    mode: raw.mode === "independent" ? "independent" : "weighted",
    timeBasis: raw.timeBasis === "real" ? "real" : "world",
    intervalDays: boundedNumber(raw.intervalDays, 1, 0.01, 3650),
    maxCatchUp: boundedInteger(raw.maxCatchUp, 30, 1, 100),
    lastProcessedAt: finiteTimestamp(raw.lastProcessedAt),
    lastRunAt: finiteTimestamp(raw.lastRunAt),
    rules: (Array.isArray(raw.rules) ? raw.rules : []).slice(0, 200).map(cleanRule),
    log: (Array.isArray(raw.log) ? raw.log : []).slice(-PRODUCTION_LOG_LIMIT).map(cleanLogEntry)
  };
}

export function selectProductionRules(source = {}, random = Math.random) {
  const production = normalizeProduction(source);
  const nextPercentile = () => {
    const value = Number(random());
    const unit = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : Math.random();
    return unit * 100;
  };
  if (production.mode === "independent") {
    return production.rules.filter((rule) => nextPercentile() < rule.chance);
  }
  const percentile = nextPercentile();
  let threshold = 0;
  for (const rule of production.rules) {
    threshold += rule.chance;
    if (percentile < threshold) return [rule];
  }
  return [];
}

export function publicProduction(source = {}) {
  const production = normalizeProduction(source);
  return normalizeProduction({
    enabled: production.enabled,
    mode: production.mode,
    timeBasis: production.timeBasis,
    intervalDays: production.intervalDays,
    maxCatchUp: production.maxCatchUp,
    lastProcessedAt: production.lastProcessedAt,
    lastRunAt: production.lastRunAt,
    rules: [],
    log: []
  });
}

export function productionClock(timeBasis = "world") {
  if (timeBasis === "real") return Date.now() / 1000;
  const worldTime = Number(globalThis.game?.time?.worldTime);
  return Number.isFinite(worldTime) ? worldTime : 0;
}

export function productionTimeUnits(timeBasis = "world") {
  const days = timeBasis === "world" ? globalThis.game?.time?.calendar?.days : null;
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const minute = positive(days?.secondsPerMinute, 60);
  const hour = minute * positive(days?.minutesPerHour, 60);
  return { minute, hour, day: hour * positive(days?.hoursPerDay, 24) };
}

export function productionIntervalSeconds(source = {}) {
  const production = normalizeProduction(source);
  return production.intervalDays * productionTimeUnits(production.timeBasis).day;
}

export function productionSchedule(source = {}, now = undefined) {
  const production = normalizeProduction(source);
  const current = Number.isFinite(Number(now)) ? Number(now) : productionClock(production.timeBasis);
  const interval = productionIntervalSeconds(production);
  const anchor = production.lastProcessedAt;
  if (!production.enabled || anchor === null) {
    return {
      due: 0,
      totalDue: 0,
      skipped: 0,
      nextAt: current + interval,
      advancedAt: current,
      reanchor: production.enabled && anchor === null
    };
  }
  if (current < anchor) {
    return { due: 0, totalDue: 0, skipped: 0, nextAt: current + interval, advancedAt: current, reanchor: true };
  }
  const totalDue = Math.max(0, Math.floor(((current - anchor) + 0.000001) / interval));
  const due = Math.min(totalDue, production.maxCatchUp);
  return {
    due,
    totalDue,
    skipped: Math.max(0, totalDue - due),
    nextAt: anchor + ((totalDue + 1) * interval),
    advancedAt: anchor + (totalDue * interval),
    reanchor: false
  };
}

export function prepareProductionSchedule(nextSource = {}, previousSource = {}) {
  const next = normalizeProduction(nextSource);
  const previous = normalizeProduction(previousSource);
  if (!next.enabled) {
    next.lastProcessedAt = null;
    return next;
  }
  const scheduleChanged = !previous.enabled
    || previous.timeBasis !== next.timeBasis
    || previous.intervalDays !== next.intervalDays
    || next.lastProcessedAt === null;
  if (scheduleChanged) next.lastProcessedAt = productionClock(next.timeBasis);
  return next;
}

export function productionRuleFromEntry(entry = {}, previous = {}, fields = {}) {
  const source = previous && typeof previous === "object" ? previous : {};
  return cleanRule({
    ...source,
    ...fields,
    id: fields.id || source.id || globalThis.foundry?.utils?.randomID?.(12) || `production-${Date.now()}`,
    targetEntryId: entry.id || source.targetEntryId || "",
    sourceUuid: entry.sourceUuid || source.sourceUuid || "",
    name: entry.name || source.name || "Oggetto",
    img: entry.img || source.img || "icons/svg/item-bag.svg",
    type: entry.type || source.type || "item",
    description: entry.description || source.description || "",
    price: entry.price || source.price || {},
    cost: entry.cost || source.cost || {},
    data: entry.data && Object.keys(entry.data).length ? entry.data : source.data || {},
    dataBundleMode: entry.dataBundleMode || source.dataBundleMode || "copies",
    dataBundle: entry.dataBundle || source.dataBundle
  });
}

export function productionRows(inventory = [], source = {}, { merchant = false } = {}) {
  const production = normalizeProduction(source);
  const matched = new Set();
  const rows = (Array.isArray(inventory) ? inventory : []).map((entry) => {
    const rule = production.rules.find((candidate) => candidate.targetEntryId === String(entry?.id || ""));
    if (rule) matched.add(rule.id);
    const finiteStock = !merchant || (entry.stock !== null && entry.stock !== undefined);
    return {
      id: rule?.id || globalThis.foundry?.utils?.randomID?.(12) || `production-${entry.id}`,
      targetEntryId: String(entry?.id || ""),
      name: String(entry?.name || rule?.name || "Oggetto"),
      img: entry?.img || rule?.img || "icons/svg/item-bag.svg",
      selected: Boolean(rule),
      quantityFormula: rule?.quantityFormula || "1",
      chance: rule?.chance ?? 100,
      maximumValue: rule?.maximum ?? "",
      missing: false,
      finiteStock,
      currentValue: merchant
        ? (finiteStock ? Math.max(0, Math.floor(Number(entry?.stock) || 0)) : "∞")
        : Math.max(0, Math.floor(Number(entry?.quantity) || 0))
    };
  });
  for (const rule of production.rules) {
    if (matched.has(rule.id)) continue;
    rows.push({
      ...rule,
      selected: true,
      quantityFormula: rule.quantityFormula,
      maximumValue: rule.maximum ?? "",
      missing: true,
      finiteStock: true,
      currentValue: 0
    });
  }
  return rows;
}

export function validateProduction(source = {}, { merchant = false, inventory = [] } = {}) {
  const production = normalizeProduction(source);
  if (!production.enabled) return { ok: true, production };
  if (!production.rules.length) return { ok: false, errorKey: "KM.Production.Errors.NoRules" };
  if (production.mode === "weighted") {
    const total = production.rules.reduce((sum, rule) => sum + rule.chance, 0);
    if (total > 100.000001) return { ok: false, errorKey: "KM.Production.Errors.ProbabilityTotal" };
  }
  for (const rule of production.rules) {
    if (rule.dataBundleMode === "single" && rule.dataBundle?.length > 1) {
      return { ok: false, errorKey: "KM.Production.Errors.NestedContainer", errorData: { item: rule.name } };
    }
    try {
      if (!productionFormulaIsSafe(rule.quantityFormula)) throw new Error("Unsafe formula");
      if (typeof globalThis.Roll?.validate === "function" && !Roll.validate(rule.quantityFormula)) throw new Error("Invalid formula");
      if (typeof globalThis.Roll === "function" && typeof Roll.validate !== "function") new Roll(rule.quantityFormula);
    } catch (_error) {
      return { ok: false, errorKey: "KM.Production.Errors.InvalidFormula", errorData: { item: rule.name } };
    }
    if (merchant) {
      const entry = inventory.find((candidate) => String(candidate?.id || "") === rule.targetEntryId);
      if (entry && (entry.stock === null || entry.stock === undefined)) {
        return { ok: false, errorKey: "KM.Production.Errors.UnlimitedStock", errorData: { item: rule.name } };
      }
    }
  }
  return { ok: true, production };
}
