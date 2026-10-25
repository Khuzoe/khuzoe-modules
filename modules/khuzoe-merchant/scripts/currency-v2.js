import { MODULE_ID } from "./constants.js";
import { currencyById, economyCurrencies, economyGroups, getEconomyRegistry } from "./economy.js";

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value, precision = 4) {
  const factor = 10 ** Math.max(0, Math.min(8, precision));
  return Math.round((numeric(value) + Number.EPSILON) * factor) / factor;
}

function formatNumber(value, precision = 4) {
  return new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: precision }).format(roundMoney(value, precision));
}

function getProperty(object, path) {
  return foundry?.utils?.getProperty
    ? foundry.utils.getProperty(object, path)
    : String(path).split(".").reduce((value, key) => value?.[key], object);
}

export function currencyMode() {
  const configured = game.settings.get(MODULE_ID, "currencyMode");
  if (configured === "auto") return game.system.id === "dnd5e" ? "dnd5e" : "simple";
  return configured;
}

function validSystemPath(path, fallback) {
  const value = String(path ?? "").trim();
  return /^system(?:\.[A-Za-z0-9_-]+)+$/.test(value) ? value : fallback;
}

function configuredPricePath() {
  return validSystemPath(game.settings.get(MODULE_ID, "itemPricePath"), "system.price.value");
}

function fallbackCurrency() {
  return economyCurrencies({ includeInactive: false })[0]
    ?? economyCurrencies({ includeInactive: true })[0]
    ?? { id: "gp", name: "gp", symbol: "gp", precision: 4, factor: 1 };
}

function normalizedCurrencyId(value, fallback = fallbackCurrency().id) {
  const id = String(value ?? "").trim().toLowerCase();
  return currencyById(id, { includeInactive: true })?.id ?? fallback;
}

function priceFromObject(value, fallbackDenomination) {
  if (!value || typeof value !== "object") return null;
  if (Number.isFinite(Number(value.value))) {
    return {
      value: Math.max(0, numeric(value.value)),
      denomination: normalizedCurrencyId(value.denomination, fallbackDenomination)
    };
  }

  const known = economyCurrencies({ includeInactive: true })
    .filter((currency) => Number.isFinite(Number(value[currency.id])));
  if (known.length) {
    return {
      components: known.map((currency) => ({ currencyId: currency.id, amount: Math.max(0, numeric(value[currency.id])) }))
    };
  }
  return null;
}

/** Read a system item price once, when the GM drops the item into the merchant. */
export function extractItemPrice(item) {
  const flaggedCost = getProperty(item, `flags.${MODULE_ID}.cost`);
  const flaggedComponent = normalizeCost({ cost: flaggedCost }).components[0];
  if (flaggedComponent) return { value: flaggedComponent.amount, denomination: flaggedComponent.currencyId };
  const path = configuredPricePath();
  const raw = getProperty(item, path);
  const parentPath = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path;
  const adjacentDenomination = getProperty(item, `${parentPath}.denomination`);
  const fallbackDenomination = fallbackCurrency().id;
  const objectPrice = priceFromObject(raw, adjacentDenomination ?? fallbackDenomination);
  if (objectPrice?.components) {
    return {
      value: objectPrice.components[0]?.amount ?? 0,
      denomination: objectPrice.components[0]?.currencyId ?? fallbackDenomination
    };
  }
  if (objectPrice) return objectPrice;

  return {
    value: Math.max(0, numeric(raw)),
    denomination: normalizedCurrencyId(adjacentDenomination, fallbackDenomination)
  };
}

function componentSource(entry) {
  if (Array.isArray(entry?.cost?.components)) return entry.cost.components;
  if (Array.isArray(entry?.price?.components)) return entry.price.components;
  if (entry?.price && typeof entry.price === "object") {
    return [{ currencyId: entry.price.denomination ?? entry.denomination, amount: entry.price.value }];
  }
  return [{ currencyId: entry?.denomination, amount: entry?.price ?? 0 }];
}

function normalizeAmount(amount, currency) {
  const raw = Math.max(0, numeric(amount));
  const group = economyGroups({ includeInactive: true }).find((candidate) => candidate.id === currency.groupId);
  if (group?.conversionMode === "automatic") {
    const base = group.currencies.find((candidate) => candidate.id === group.baseCurrencyId)
      ?? [...group.currencies].sort((left, right) => left.factor - right.factor)[0];
    const baseUnits = raw * currency.factor / base.factor;
    const roundedBase = raw > 0 ? Math.max(1, Math.round(baseUnits)) : 0;
    return roundMoney(roundedBase * base.factor / currency.factor, 4);
  }
  return roundMoney(raw, currency.precision);
}

export function normalizeCost(entry) {
  const fallback = fallbackCurrency();
  const totals = new Map();
  for (const raw of componentSource(entry)) {
    const id = normalizedCurrencyId(raw?.currencyId ?? raw?.denomination, fallback.id);
    const currency = currencyById(id, { includeInactive: true }) ?? fallback;
    const amount = normalizeAmount(raw?.amount ?? raw?.value, currency);
    if (amount <= 0) continue;
    totals.set(currency.id, roundMoney((totals.get(currency.id) ?? 0) + amount, 4));
  }
  return {
    components: [...totals.entries()].map(([currencyId, amount]) => ({ currencyId, amount }))
  };
}

/** Legacy single-price facade retained for existing merchant flags and integrations. */
export function normalizePrice(entry) {
  const component = normalizeCost(entry).components[0];
  const currency = currencyById(component?.currencyId, { includeInactive: true }) ?? fallbackCurrency();
  return {
    value: component?.amount ?? 0,
    denomination: currency.id
  };
}

function currencyLabel(currency) {
  return currency?.symbol || currency?.name || currency?.id || "";
}

export function formatCost(cost, quantity = 1) {
  const count = Math.max(1, Math.floor(numeric(quantity, 1)));
  const components = normalizeCost(cost).components;
  if (!components.length) return `0 ${currencyLabel(fallbackCurrency())}`;
  return components.map((component) => {
    const currency = currencyById(component.currencyId, { includeInactive: true }) ?? fallbackCurrency();
    return `${formatNumber(component.amount * count, currency.precision)} ${currencyLabel(currency)}`;
  }).join(" + ");
}

export function formatPrice(entry, quantity = 1) {
  return formatCost(entry, quantity);
}

export function readWallet(actor, { includeInactive = true } = {}) {
  return Object.fromEntries(economyCurrencies({ includeInactive }).map((currency) => [
    currency.id,
    Math.max(0, roundMoney(getProperty(actor, currency.storage.path), currency.precision))
  ]));
}

function walletLabel(wallet, { includeZero = false } = {}) {
  const parts = economyCurrencies({ includeInactive: false })
    .filter((currency) => includeZero || numeric(wallet[currency.id]) > 0)
    .map((currency) => `${formatNumber(wallet[currency.id], currency.precision)} ${currencyLabel(currency)}`);
  if (parts.length) return parts.join(" · ");
  const first = fallbackCurrency();
  return `0 ${currencyLabel(first)}`;
}

export function getBalanceLabel(actor) {
  return walletLabel(readWallet(actor));
}

function groupBase(group) {
  return group.currencies.find((currency) => currency.id === group.baseCurrencyId)
    ?? [...group.currencies].sort((left, right) => left.factor - right.factor)[0];
}

function recomposeAutomaticGroup(group, totalBaseUnits) {
  const base = groupBase(group);
  let remaining = Math.max(0, roundMoney(totalBaseUnits, 8));
  const wallet = {};
  const ordered = [...group.currencies].sort((left, right) => right.factor - left.factor || right.order - left.order);
  for (const [index, currency] of ordered.entries()) {
    const ratio = currency.factor / base.factor;
    if (index === ordered.length - 1) {
      wallet[currency.id] = roundMoney(remaining / ratio, currency.precision);
      remaining = 0;
      continue;
    }
    const amount = Math.floor((remaining + Number.EPSILON) / ratio);
    wallet[currency.id] = roundMoney(amount, currency.precision);
    remaining = roundMoney(remaining - amount * ratio, 8);
  }
  return wallet;
}

/**
 * Produce one authoritative, atomic Actor update without modifying the Actor.
 * Convertible groups are recomposed canonically, while independent currencies
 * are deducted only from their own wallet field.
 */
export function planDeduction(actor, entry, quantity) {
  const count = Math.max(1, Math.floor(numeric(quantity, 1)));
  const cost = normalizeCost(entry);
  const oldWallet = readWallet(actor, { includeInactive: true });
  const newWallet = { ...oldWallet };
  const touchedCurrencies = new Set();
  const update = {};
  const rollback = {};
  let sufficient = true;

  for (const group of economyGroups({ includeInactive: true })) {
    const groupCosts = cost.components.filter((component) => group.currencies.some((currency) => currency.id === component.currencyId));
    if (!groupCosts.length) continue;

    if (group.conversionMode === "automatic") {
      const base = groupBase(group);
      const balance = group.currencies.reduce((total, currency) => {
        return total + numeric(oldWallet[currency.id]) * currency.factor / base.factor;
      }, 0);
      const amount = groupCosts.reduce((total, component) => {
        const currency = group.currencies.find((candidate) => candidate.id === component.currencyId);
        return total + component.amount * count * currency.factor / base.factor;
      }, 0);
      if (balance + 0.0000001 < amount) sufficient = false;
      const recomposed = recomposeAutomaticGroup(group, Math.max(0, balance - amount));
      for (const currency of group.currencies) newWallet[currency.id] = recomposed[currency.id] ?? 0;
      for (const currency of group.currencies) touchedCurrencies.add(currency.id);
      continue;
    }

    for (const component of groupCosts) {
      const currency = group.currencies.find((candidate) => candidate.id === component.currencyId);
      const balance = numeric(oldWallet[currency.id]);
      const amount = roundMoney(component.amount * count, currency.precision);
      if (balance + 0.0000001 < amount) sufficient = false;
      newWallet[currency.id] = Math.max(0, roundMoney(balance - amount, currency.precision));
      touchedCurrencies.add(currency.id);
    }
  }

  for (const currency of economyCurrencies({ includeInactive: true })) {
    if (!touchedCurrencies.has(currency.id) && newWallet[currency.id] === oldWallet[currency.id]) continue;
    update[currency.storage.path] = newWallet[currency.id];
    rollback[currency.storage.path] = oldWallet[currency.id];
  }

  return {
    sufficient,
    update,
    rollback,
    cost,
    totalLabel: formatCost({ cost }, count),
    balanceLabel: walletLabel(oldWallet),
    newBalanceLabel: walletLabel(newWallet)
  };
}

export function planCurrencyTransfer(actor, currencyId, amount, { direction = "deposit" } = {}) {
  const currency = currencyById(currencyId, { includeInactive: true });
  const requested = Number(amount);
  if (!actor || !currency || !Number.isFinite(requested) || requested <= 0) {
    return { valid: false, sufficient: false, currency, amount: 0, update: {}, rollback: {} };
  }
  const normalizedAmount = roundMoney(requested, currency.precision);
  const tolerance = 1 / (10 ** Math.min(8, currency.precision + 4));
  if (normalizedAmount <= 0 || Math.abs(normalizedAmount - requested) > tolerance) {
    return { valid: false, sufficient: false, currency, amount: normalizedAmount, update: {}, rollback: {} };
  }
  const previous = Math.max(0, roundMoney(getProperty(actor, currency.storage.path), currency.precision));
  const withdrawing = direction === "withdraw";
  const sufficient = !withdrawing || previous + tolerance >= normalizedAmount;
  const next = roundMoney(withdrawing ? previous - normalizedAmount : previous + normalizedAmount, currency.precision);
  return {
    valid: true,
    sufficient,
    currency,
    amount: normalizedAmount,
    previous,
    next: Math.max(0, next),
    update: { [currency.storage.path]: Math.max(0, next) },
    rollback: { [currency.storage.path]: previous }
  };
}

export function currencyUnit(currencyId) {
  const currency = currencyById(currencyId, { includeInactive: true });
  if (!currency) return 1;
  return currency.precision > 0 ? 1 / (10 ** currency.precision) : 1;
}

export function supportedDenominations() {
  return economyCurrencies({ includeInactive: false }).map((currency) => currency.id);
}

export function denominationOptions() {
  return economyCurrencies({ includeInactive: false }).map((currency) => ({
    value: currency.id,
    label: `${currency.name} (${currencyLabel(currency)})`
  }));
}

export function economySnapshot() {
  return getEconomyRegistry();
}
