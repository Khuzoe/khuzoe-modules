import { MODULE_ID } from "./constants.js";

const DND5E_FACTORS = Object.freeze({ cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 });
const DND5E_ORDER = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((numeric(value) + Number.EPSILON) * 10000) / 10000;
}

function formatNumber(value) {
  return new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: 4 }).format(roundMoney(value));
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

function configuredCurrencyPath() {
  return validSystemPath(game.settings.get(MODULE_ID, "simpleCurrencyPath"), "system.currency.gp");
}

function configuredPricePath() {
  return validSystemPath(game.settings.get(MODULE_ID, "itemPricePath"), "system.price.value");
}

function configuredLabel() {
  return String(game.settings.get(MODULE_ID, "currencyLabel") || "gp").trim().slice(0, 12) || "gp";
}

function dnd5eDenomination(value) {
  const denomination = String(value ?? "gp").toLowerCase();
  return DND5E_FACTORS[denomination] ? denomination : "gp";
}

function priceFromObject(value, fallbackDenomination) {
  if (!value || typeof value !== "object") return null;
  if (Number.isFinite(Number(value.value))) {
    return {
      value: Math.max(0, numeric(value.value)),
      denomination: String(value.denomination ?? fallbackDenomination)
    };
  }

  const denominations = Object.entries(DND5E_FACTORS).filter(([key]) => Number.isFinite(Number(value[key])));
  if (denominations.length) {
    const copper = denominations.reduce((total, [key, factor]) => total + numeric(value[key]) * factor, 0);
    return { value: Math.max(0, copper), denomination: "cp" };
  }
  return null;
}

/** Read a system item price once, when the GM drops the item into the merchant. */
export function extractItemPrice(item) {
  const path = configuredPricePath();
  const raw = foundry.utils.getProperty(item, path);
  const parentPath = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path;
  const adjacentDenomination = foundry.utils.getProperty(item, `${parentPath}.denomination`);
  const fallbackDenomination = currencyMode() === "dnd5e" ? "gp" : configuredLabel();
  const objectPrice = priceFromObject(raw, adjacentDenomination ?? fallbackDenomination);
  if (objectPrice) return objectPrice;

  return {
    value: Math.max(0, numeric(raw)),
    denomination: String(adjacentDenomination ?? fallbackDenomination)
  };
}

export function normalizePrice(entry) {
  const mode = currencyMode();
  const rawValue = Math.max(0, roundMoney(entry?.price?.value ?? entry?.price ?? 0));
  if (mode === "dnd5e") {
    const denomination = dnd5eDenomination(entry?.price?.denomination ?? entry?.denomination);
    const factor = DND5E_FACTORS[denomination];
    const copperValue = rawValue > 0 ? Math.max(1, Math.round(rawValue * factor)) : 0;
    return {
      value: roundMoney(copperValue / factor),
      denomination
    };
  }

  return {
    value: rawValue,
    denomination: configuredLabel()
  };
}

export function formatPrice(entry, quantity = 1) {
  const price = normalizePrice(entry);
  const count = Math.max(1, Number(quantity) || 1);
  return `${formatNumber(price.value * count)} ${price.denomination}`;
}

function dnd5eWallet(actor) {
  const wallet = foundry.utils.getProperty(actor, "system.currency") ?? {};
  return Object.fromEntries(Object.keys(DND5E_FACTORS).map((key) => [key, Math.max(0, Math.floor(numeric(wallet[key])))]));
}

function dnd5eTotalCopper(wallet) {
  return Object.entries(DND5E_FACTORS).reduce((total, [key, factor]) => total + wallet[key] * factor, 0);
}

function copperToWallet(copper) {
  let remaining = Math.max(0, Math.floor(copper));
  const wallet = {};
  for (const denomination of DND5E_ORDER) {
    const factor = DND5E_FACTORS[denomination];
    wallet[denomination] = Math.floor(remaining / factor);
    remaining %= factor;
  }
  return wallet;
}

function dnd5eWalletLabel(wallet) {
  const parts = DND5E_ORDER
    .filter((denomination) => wallet[denomination] > 0)
    .map((denomination) => `${formatNumber(wallet[denomination])} ${denomination}`);
  return parts.join(" · ") || "0 gp";
}

export function getBalanceLabel(actor) {
  if (currencyMode() === "dnd5e") return dnd5eWalletLabel(dnd5eWallet(actor));
  const path = configuredCurrencyPath();
  const balance = Math.max(0, numeric(foundry.utils.getProperty(actor, path)));
  return `${formatNumber(balance)} ${configuredLabel()}`;
}

/**
 * Produce an authoritative currency update without modifying the Actor.
 * D&D5e wallets are converted to their equivalent, canonical coin mix so change is supported.
 */
export function planDeduction(actor, entry, quantity) {
  const price = normalizePrice(entry);
  const count = Math.max(1, Math.floor(numeric(quantity, 1)));

  if (currencyMode() === "dnd5e") {
    const oldWallet = dnd5eWallet(actor);
    const factor = DND5E_FACTORS[dnd5eDenomination(price.denomination)];
    const unitCost = Math.max(0, Math.round(price.value * factor));
    const cost = unitCost * count;
    const balance = dnd5eTotalCopper(oldWallet);
    const newWallet = copperToWallet(balance - cost);
    const update = {};
    const rollback = {};
    for (const denomination of Object.keys(DND5E_FACTORS)) {
      update[`system.currency.${denomination}`] = newWallet[denomination];
      rollback[`system.currency.${denomination}`] = oldWallet[denomination];
    }
    return {
      sufficient: balance >= cost,
      update,
      rollback,
      totalLabel: formatPrice(entry, count),
      balanceLabel: dnd5eWalletLabel(oldWallet),
      newBalanceLabel: dnd5eWalletLabel(newWallet)
    };
  }

  const path = configuredCurrencyPath();
  const balance = Math.max(0, numeric(foundry.utils.getProperty(actor, path)));
  const cost = roundMoney(price.value * count);
  const remaining = roundMoney(balance - cost);
  return {
    sufficient: remaining >= -0.00001,
    update: { [path]: Math.max(0, remaining) },
    rollback: { [path]: balance },
    totalLabel: `${formatNumber(cost)} ${configuredLabel()}`,
    balanceLabel: `${formatNumber(balance)} ${configuredLabel()}`,
    newBalanceLabel: `${formatNumber(Math.max(0, remaining))} ${configuredLabel()}`
  };
}

export function supportedDenominations() {
  return currencyMode() === "dnd5e" ? [...DND5E_ORDER] : [configuredLabel()];
}
