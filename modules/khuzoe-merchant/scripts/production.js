import { MODULE_ID } from "./constants.js";
import { normalizeContainer } from "./container-data.js";
import {
  PRODUCTION_LOG_LIMIT,
  PRODUCTION_QUANTITY_LIMIT,
  normalizeProduction,
  productionFormulaIsSafe,
  productionClock,
  productionIntervalSeconds,
  productionTimeUnits,
  productionSchedule,
  selectProductionRules
} from "./production-data.js";
import {
  getAuthoritativeContainer,
  getAuthoritativeMerchant,
  saveAuthoritativeContainer,
  saveAuthoritativeMerchant
} from "./container-store.js";
import { enqueueTransaction } from "./transaction-coordinator.js";
import { duplicate, getMerchant, localize, log, logError, normalizeMerchant, primaryGM } from "./utils.js";

let productionTimer = null;
let scanRequested = false;

function randomUnit() {
  const configured = globalThis.CONFIG?.Dice?.randomUniform;
  const value = typeof configured === "function" ? Number(configured.call(CONFIG.Dice)) : Math.random();
  return Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : Math.random();
}

async function rollQuantity(rule) {
  try {
    if (!productionFormulaIsSafe(rule.quantityFormula)) throw new Error("Unsafe production formula.");
    if (typeof globalThis.Roll !== "function") throw new Error("Foundry Roll is unavailable.");
    const roll = await new Roll(rule.quantityFormula).evaluate();
    const total = Math.floor(Number(roll.total));
    if (!Number.isFinite(total)) throw new Error("The production formula has no numeric total.");
    return Math.min(PRODUCTION_QUANTITY_LIMIT, Math.max(0, total));
  } catch (error) {
    logError("Production quantity roll failed", { rule: rule.name, formula: rule.quantityFormula, error });
    return null;
  }
}

function merchantEntryFromRule(rule, inventory) {
  let entry = inventory.find((candidate) => candidate.id === rule.targetEntryId);
  entry ||= rule.sourceUuid
    ? inventory.find((candidate) => candidate.sourceUuid === rule.sourceUuid)
    : null;
  if (entry) return entry;
  entry = {
    id: rule.targetEntryId || foundry.utils.randomID(12),
    sourceUuid: rule.sourceUuid,
    name: rule.name,
    img: rule.img,
    type: rule.type,
    description: rule.description,
    price: duplicate(rule.price || {}),
    cost: duplicate(rule.cost || {}),
    stock: 0,
    data: duplicate(rule.data || {}),
    dataBundle: Array.isArray(rule.dataBundle) ? duplicate(rule.dataBundle) : undefined
  };
  inventory.push(entry);
  return entry;
}

function containerEntryFromRule(rule, inventory) {
  let entry = inventory.find((candidate) => candidate.id === rule.targetEntryId);
  entry ||= rule.sourceUuid
    ? inventory.find((candidate) => candidate.sourceUuid === rule.sourceUuid)
    : null;
  if (entry) return entry;
  entry = {
    id: rule.targetEntryId || foundry.utils.randomID(12),
    sourceUuid: rule.sourceUuid,
    name: rule.name,
    img: rule.img,
    type: rule.type,
    description: rule.description,
    quantity: 0,
    sort: inventory.length,
    data: duplicate(rule.data || {}),
    dataBundleMode: rule.dataBundleMode === "single" ? "single" : "copies",
    dataBundle: Array.isArray(rule.dataBundle) ? duplicate(rule.dataBundle) : undefined
  };
  inventory.push(entry);
  return entry;
}

function addRuleQuantity(rule, rolled, inventory, kind) {
  const entry = kind === "merchant"
    ? merchantEntryFromRule(rule, inventory)
    : containerEntryFromRule(rule, inventory);
  const field = kind === "merchant" ? "stock" : "quantity";
  if (kind === "merchant" && (entry.stock === null || entry.stock === undefined)) {
    return { ruleId: rule.id, name: rule.name, rolled, added: 0, capped: false, skipped: "unlimited" };
  }
  const current = Math.max(0, Math.floor(Number(entry[field]) || 0));
  const available = rule.maximum === null ? rolled : Math.max(0, rule.maximum - current);
  const added = Math.min(rolled, available);
  entry[field] = current + added;
  return {
    ruleId: rule.id,
    name: rule.name,
    rolled,
    added,
    capped: added < rolled,
    skipped: ""
  };
}

async function executeCycle(production, inventory, kind, timestamp, { manual = false, skippedCycles = 0 } = {}) {
  const results = [];
  for (const rule of selectProductionRules(production, randomUnit)) {
    const rolled = await rollQuantity(rule);
    if (rolled === null) {
      results.push({ ruleId: rule.id, name: rule.name, rolled: 0, added: 0, capped: false, skipped: "formula" });
      continue;
    }
    results.push(addRuleQuantity(rule, rolled, inventory, kind));
  }
  return {
    id: foundry.utils.randomID(16),
    timestamp,
    timeBasis: production.timeBasis,
    manual,
    skippedCycles,
    results
  };
}

function summarize(logEntries = [], skippedCycles = 0) {
  const totals = new Map();
  for (const logEntry of logEntries) {
    for (const result of logEntry.results || []) {
      if (!(result.added > 0)) continue;
      totals.set(result.name, (totals.get(result.name) || 0) + result.added);
    }
  }
  return {
    cycles: logEntries.length,
    skippedCycles,
    produced: [...totals.entries()].map(([name, quantity]) => ({ name, quantity })),
    totalQuantity: [...totals.values()].reduce((sum, quantity) => sum + quantity, 0)
  };
}

async function processRecord({ kind, document, force = false }) {
  const current = kind === "merchant"
    ? await getAuthoritativeMerchant(document)
    : await getAuthoritativeContainer(document);
  if (!current) return { ok: false, reason: "unavailable", cycles: 0, produced: [], totalQuantity: 0 };
  const production = normalizeProduction(current.production);
  if (!production.rules.length || (!force && !production.enabled)) {
    return { ok: false, reason: "inactive", cycles: 0, produced: [], totalQuantity: 0 };
  }

  const now = productionClock(production.timeBasis);
  const schedule = productionSchedule(production, now);
  if (!force && schedule.due < 1 && !schedule.reanchor) {
    return { ok: true, reason: "not-due", cycles: 0, produced: [], totalQuantity: 0 };
  }

  const inventory = duplicate(current.inventory || []);
  const logEntries = [];
  if (force) {
    logEntries.push(await executeCycle(production, inventory, kind, now, { manual: true }));
    production.lastRunAt = now;
  } else if (schedule.reanchor) {
    production.lastProcessedAt = schedule.advancedAt;
  } else {
    const interval = productionIntervalSeconds(production);
    const firstTimestamp = schedule.advancedAt - ((schedule.due - 1) * interval);
    for (let index = 0; index < schedule.due; index += 1) {
      logEntries.push(await executeCycle(production, inventory, kind, firstTimestamp + (index * interval), {
        skippedCycles: index === 0 ? schedule.skipped : 0
      }));
    }
    production.lastProcessedAt = schedule.advancedAt;
    production.lastRunAt = now;
  }
  production.log = [...production.log, ...logEntries].slice(-PRODUCTION_LOG_LIMIT);

  const next = kind === "merchant"
    ? normalizeMerchant({ ...current, revision: current.revision + 1, inventory, production })
    : normalizeContainer({ ...current, revision: current.revision + 1, inventory, production });
  if (kind === "merchant") {
    await saveAuthoritativeMerchant(document, next);
  } else {
    await saveAuthoritativeContainer(document, next, {}, { khuzoeMerchantProduction: true });
  }
  return { ok: true, ...summarize(logEntries, schedule.skipped) };
}

async function processDueProductions({ timeBasis = null } = {}) {
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return { merchants: 0, containers: 0 };
  let merchants = 0;
  let containers = 0;
  for (const actor of game.actors || []) {
    const visible = getMerchant(actor);
    if (!visible.production.enabled || (timeBasis && visible.production.timeBasis !== timeBasis)) continue;
    try {
      const result = await processRecord({ kind: "merchant", document: actor });
      if (result.cycles > 0) merchants += 1;
    } catch (error) {
      logError("Merchant production failed", { actor: actor.uuid, error });
    }
  }
  for (const scene of game.scenes || []) {
    for (const token of scene.tokens || []) {
      const visible = token.getFlag?.(MODULE_ID, "container");
      const production = normalizeProduction(visible?.production);
      if (!visible || !production.enabled || (timeBasis && production.timeBasis !== timeBasis)) continue;
      try {
        const result = await processRecord({ kind: "container", document: token });
        if (result.cycles > 0) containers += 1;
      } catch (error) {
        logError("Container production failed", { token: token.uuid, error });
      }
    }
  }
  if (merchants || containers) log("Produzione periodica completata", { merchants, containers });
  return { merchants, containers };
}

function requestProductionScan(timeBasis = null) {
  if (scanRequested) return;
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return;
  scanRequested = true;
  enqueueTransaction(
    () => processDueProductions({ timeBasis }),
    "periodic production"
  ).catch((error) => logError("Production scan failed", error)).finally(() => {
    scanRequested = false;
  });
}

export function productionNextLabel(source = {}) {
  const production = normalizeProduction(source);
  if (!production.enabled) return localize("KM.Production.Disabled");
  if (production.lastProcessedAt === null) return localize("KM.Production.StartsOnSave");
  const schedule = productionSchedule(production);
  const remaining = Math.max(0, schedule.nextAt - productionClock(production.timeBasis));
  const units = productionTimeUnits(production.timeBasis);
  const days = Math.floor(remaining / units.day);
  const hours = Math.floor((remaining % units.day) / units.hour);
  const minutes = Math.max(1, Math.ceil((remaining % units.hour) / units.minute));
  if (days > 0) return localize("KM.Production.NextDays", { days, hours });
  if (hours > 0) return localize("KM.Production.NextHours", { hours, minutes });
  return localize("KM.Production.NextMinutes", { minutes });
}

export function productionLogRows(source = {}) {
  const production = normalizeProduction(source);
  return [...production.log].reverse().slice(0, 8).map((entry) => {
    const produced = entry.results
      .filter((result) => result.added > 0)
      .map((result) => `${result.added}× ${result.name}`)
      .join(", ");
    return {
      ...entry,
      produced: produced || localize("KM.Production.NothingProduced"),
      when: entry.timeBasis === "real"
        ? new Date(entry.timestamp * 1000).toLocaleString(game.i18n.lang)
        : localize("KM.Production.WorldTime", { value: Math.round(entry.timestamp) })
    };
  });
}

export function runMerchantProduction(actor) {
  if (!game.user?.isGM) return Promise.resolve({ ok: false, reason: "gm-only", cycles: 0, produced: [], totalQuantity: 0 });
  return enqueueTransaction(
    () => processRecord({ kind: "merchant", document: actor, force: true }),
    "manual merchant production"
  );
}

export function runContainerProduction(token) {
  if (!game.user?.isGM) return Promise.resolve({ ok: false, reason: "gm-only", cycles: 0, produced: [], totalQuantity: 0 });
  return enqueueTransaction(
    () => processRecord({ kind: "container", document: token?.document || token, force: true }),
    "manual container production"
  );
}

export function initializeProduction() {
  if (productionTimer !== null) return;
  Hooks.on("updateWorldTime", () => requestProductionScan("world"));
  productionTimer = globalThis.setInterval?.(() => requestProductionScan("real"), 60000) ?? true;
  requestProductionScan(null);
}

export function productionApi() {
  return {
    runMerchant: runMerchantProduction,
    runContainer: runContainerProduction,
    scan: () => enqueueTransaction(() => processDueProductions(), "manual production scan")
  };
}
