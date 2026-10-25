import { MODULE_ID } from "./constants.js";

export const ECONOMY_SCHEMA_VERSION = 1;
export const ECONOMY_SETTING_KEY = "economyRegistry";

const MAX_GROUPS = 24;
const MAX_CURRENCIES = 80;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SYSTEM_PATH_PATTERN = /^system(?:\.[A-Za-z0-9_-]+)+$/;
const FLAG_PATH_PATTERN = /^flags\.khuzoe-merchant\.wallet\.[a-z0-9][a-z0-9_-]{0,39}$/;

const DND5E_CURRENCIES = Object.freeze([
  { id: "pp", name: "Platino", symbol: "pp", factor: 1000, order: 50, path: "system.currency.pp" },
  { id: "gp", name: "Oro", symbol: "gp", factor: 100, order: 40, path: "system.currency.gp" },
  { id: "ep", name: "Electrum", symbol: "ep", factor: 50, order: 30, path: "system.currency.ep" },
  { id: "sp", name: "Argento", symbol: "sp", factor: 10, order: 20, path: "system.currency.sp" },
  { id: "cp", name: "Rame", symbol: "cp", factor: 1, order: 10, path: "system.currency.cp" }
]);

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback, maximum = 80) {
  const normalized = String(value ?? "").trim().slice(0, maximum);
  return normalized || fallback;
}

function cleanId(value, fallback = "") {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ID_PATTERN.test(normalized) ? normalized : fallback;
}

function defaultCustomPath(id) {
  return `flags.${MODULE_ID}.wallet.${id}`;
}

function normalizeStorage(storage, id, fallbackPath = "") {
  const requested = text(storage?.path ?? fallbackPath, defaultCustomPath(id), 120);
  if (SYSTEM_PATH_PATTERN.test(requested)) return { kind: "system", path: requested };
  if (FLAG_PATH_PATTERN.test(requested)) return { kind: "flag", path: requested };
  return { kind: "flag", path: defaultCustomPath(id) };
}

function normalizeCurrency(source, fallbackId, seenIds) {
  const id = cleanId(source?.id, fallbackId);
  if (!id || seenIds.has(id)) return null;
  seenIds.add(id);
  const storage = normalizeStorage(source?.storage, id, source?.path);
  return {
    id,
    name: text(source?.name, id.toUpperCase(), 60),
    symbol: text(source?.symbol, id, 16),
    factor: Math.max(0.0001, Math.min(1_000_000_000, numeric(source?.factor, 1))),
    precision: Math.max(0, Math.min(4, Math.floor(numeric(source?.precision, 0)))),
    order: Math.max(-10000, Math.min(10000, numeric(source?.order, 0))),
    color: /^#[0-9a-f]{6}$/i.test(String(source?.color ?? "")) ? String(source.color) : "#d8a94d",
    icon: text(source?.icon, "", 240),
    active: source?.active !== false,
    storage
  };
}

function normalizeGroup(source, index, seenIds, currencyBudget) {
  const id = cleanId(source?.id, `group-${index + 1}`);
  const conversionMode = source?.conversionMode === "automatic" ? "automatic" : "none";
  const currencies = [];
  for (const [currencyIndex, rawCurrency] of (Array.isArray(source?.currencies) ? source.currencies : []).entries()) {
    if (seenIds.size >= currencyBudget) break;
    const currency = normalizeCurrency(rawCurrency, `${id}-${currencyIndex + 1}`, seenIds);
    if (currency) currencies.push(currency);
  }
  if (!currencies.length) return null;
  const requestedBase = cleanId(source?.baseCurrencyId);
  const baseCurrencyId = currencies.some((currency) => currency.id === requestedBase)
    ? requestedBase
    : [...currencies].sort((left, right) => left.factor - right.factor)[0].id;
  return {
    id,
    name: text(source?.name, `Gruppo ${index + 1}`, 60),
    conversionMode,
    baseCurrencyId,
    order: Math.max(-10000, Math.min(10000, numeric(source?.order, 0))),
    currencies
  };
}

export function createDefaultEconomyRegistry({ systemId, currencyMode, simpleCurrencyPath, currencyLabel } = {}) {
  const useDnd5e = currencyMode === "dnd5e" || (currencyMode !== "simple" && systemId === "dnd5e");
  const groups = useDnd5e
    ? [{
      id: "common-coins",
      name: "Conio comune",
      conversionMode: "automatic",
      baseCurrencyId: "cp",
      order: 100,
      currencies: DND5E_CURRENCIES.map((currency) => ({
        ...currency,
        precision: 0,
        color: "#d8a94d",
        icon: "",
        active: true,
        storage: { kind: "system", path: currency.path }
      }))
    }]
    : [{
      id: "default",
      name: "Valuta principale",
      conversionMode: "none",
      baseCurrencyId: cleanId(currencyLabel, "gp"),
      order: 100,
      currencies: [{
        id: cleanId(currencyLabel, "gp"),
        name: text(currencyLabel, "gp", 60),
        symbol: text(currencyLabel, "gp", 16),
        factor: 1,
        precision: 4,
        order: 10,
        color: "#d8a94d",
        icon: "",
        active: true,
        storage: normalizeStorage(null, cleanId(currencyLabel, "gp"), simpleCurrencyPath || "system.currency.gp")
      }]
    }];
  return {
    schemaVersion: ECONOMY_SCHEMA_VERSION,
    revision: 1,
    updatedAt: "",
    groups
  };
}

export function normalizeEconomyRegistry(source, fallback = {}) {
  const input = source && typeof source === "object" ? source : {};
  const defaultRegistry = createDefaultEconomyRegistry(fallback);
  const seenIds = new Set();
  const groups = [];
  const rawGroups = Array.isArray(input.groups) && input.groups.length ? input.groups : defaultRegistry.groups;
  for (const [index, rawGroup] of rawGroups.slice(0, MAX_GROUPS).entries()) {
    const group = normalizeGroup(rawGroup, index, seenIds, MAX_CURRENCIES);
    if (group) groups.push(group);
  }
  return {
    schemaVersion: ECONOMY_SCHEMA_VERSION,
    revision: Math.max(1, Math.floor(numeric(input.revision, defaultRegistry.revision))),
    updatedAt: text(input.updatedAt, "", 40),
    groups: groups.length ? groups : defaultRegistry.groups
  };
}

export function validateEconomyRegistry(source) {
  const groups = Array.isArray(source?.groups) ? source.groups : [];
  const groupIds = new Set();
  const currencyIds = new Set();
  const storagePaths = new Set();
  for (const group of groups) {
    const groupId = cleanId(group?.id);
    if (!groupId || groupIds.has(groupId)) {
      const error = new Error("Ogni gruppo deve avere un identificatore univoco.");
      error.code = "ECONOMY_DUPLICATE_GROUP";
      throw error;
    }
    groupIds.add(groupId);
    for (const currency of Array.isArray(group?.currencies) ? group.currencies : []) {
      const currencyId = cleanId(currency?.id);
      if (!currencyId || currencyIds.has(currencyId)) {
        const error = new Error("Ogni valuta deve avere un identificatore univoco.");
        error.code = "ECONOMY_DUPLICATE_CURRENCY";
        throw error;
      }
      currencyIds.add(currencyId);
      const storage = normalizeStorage(currency?.storage, currencyId, currency?.path);
      if (storagePaths.has(storage.path)) {
        const error = new Error(`Il percorso ${storage.path} è già usato da un'altra valuta.`);
        error.code = "ECONOMY_DUPLICATE_PATH";
        throw error;
      }
      storagePaths.add(storage.path);
    }
  }
  if (!currencyIds.size) {
    const error = new Error("Il registro deve contenere almeno una valuta.");
    error.code = "ECONOMY_EMPTY";
    throw error;
  }
  return true;
}

function legacyFallbackOptions() {
  let configuredMode = "auto";
  let simpleCurrencyPath = "system.currency.gp";
  let currencyLabel = "gp";
  try {
    configuredMode = game.settings.get(MODULE_ID, "currencyMode") ?? "auto";
    simpleCurrencyPath = game.settings.get(MODULE_ID, "simpleCurrencyPath") ?? simpleCurrencyPath;
    currencyLabel = game.settings.get(MODULE_ID, "currencyLabel") ?? currencyLabel;
  } catch (_error) {
    // The registry also works in tests and in worlds upgrading from old settings.
  }
  return {
    systemId: game?.system?.id ?? "",
    currencyMode: configuredMode,
    simpleCurrencyPath,
    currencyLabel
  };
}

export function getEconomyRegistry() {
  let stored = null;
  try {
    stored = game.settings.get(MODULE_ID, ECONOMY_SETTING_KEY);
  } catch (_error) {
    stored = null;
  }
  return normalizeEconomyRegistry(stored, legacyFallbackOptions());
}

export async function saveEconomyRegistry(registry, { expectedRevision = null, source = "foundry" } = {}) {
  if (!game.user?.isGM) throw new Error("Solo un GM può modificare le valute del mondo.");
  const current = getEconomyRegistry();
  if (expectedRevision !== null && Number(expectedRevision) !== current.revision) {
    const error = new Error("Il registro valute è stato modificato da un altro client.");
    error.code = "ECONOMY_REVISION_CONFLICT";
    error.current = current;
    throw error;
  }
  validateEconomyRegistry(registry);
  const normalized = normalizeEconomyRegistry(registry, legacyFallbackOptions());
  normalized.revision = Math.max(current.revision + 1, normalized.revision);
  normalized.updatedAt = new Date().toISOString();
  normalized.source = source === "site" ? "site" : "foundry";
  await game.settings.set(MODULE_ID, ECONOMY_SETTING_KEY, normalized);
  Hooks.callAll(`${MODULE_ID}.economyUpdated`, normalized, current);
  return normalized;
}

export async function applyEconomyRegistrySnapshot(registry, { source = "site" } = {}) {
  if (!game.user?.isGM) throw new Error("Solo un GM pu\u00f2 applicare le valute del mondo.");
  const current = getEconomyRegistry();
  validateEconomyRegistry(registry);
  const normalized = normalizeEconomyRegistry(registry, legacyFallbackOptions());
  normalized.source = source === "site" ? "site" : "foundry";
  const comparable = (value) => JSON.stringify({ ...value, updatedAt: "", source: "" });
  if (comparable(current) === comparable(normalized)) return current;
  if (normalized.revision < current.revision) {
    const error = new Error("Il registro remoto è meno recente di quello locale e non è stato applicato.");
    error.code = "ECONOMY_STALE_SNAPSHOT";
    throw error;
  }
  normalized.revision = Math.max(current.revision + 1, normalized.revision);
  await game.settings.set(MODULE_ID, ECONOMY_SETTING_KEY, normalized);
  Hooks.callAll(`${MODULE_ID}.economyUpdated`, normalized, current);
  return normalized;
}

export function economyGroups({ includeInactive = true } = {}) {
  return getEconomyRegistry().groups
    .map((group) => ({
      ...group,
      currencies: group.currencies.filter((currency) => includeInactive || currency.active)
    }))
    .filter((group) => group.currencies.length)
    .sort((left, right) => right.order - left.order || left.name.localeCompare(right.name));
}

export function economyCurrencies(options = {}) {
  return economyGroups(options)
    .flatMap((group) => group.currencies.map((currency) => ({ ...currency, groupId: group.id, group })));
}

export function currencyById(id, options = {}) {
  const normalizedId = cleanId(id);
  return economyCurrencies(options).find((currency) => currency.id === normalizedId) ?? null;
}

export function economyApi() {
  return {
    schemaVersion: ECONOMY_SCHEMA_VERSION,
    getRegistry: getEconomyRegistry,
    saveRegistry: saveEconomyRegistry,
    applyRegistrySnapshot: applyEconomyRegistrySnapshot,
    validateRegistry: validateEconomyRegistry,
    normalizeRegistry: normalizeEconomyRegistry,
    createDefaultRegistry: createDefaultEconomyRegistry,
    getGroups: economyGroups,
    getCurrencies: economyCurrencies,
    getCurrency: currencyById
  };
}
