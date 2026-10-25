import { MODULE_ID } from "./constants.js";
import { economyCurrencies, getEconomyRegistry } from "./economy.js";
import { readWallet } from "./currency-v2.js";
import { applicationRoot, openApplications, rerenderApplication } from "./foundry-compat.js";
import { isInventoryActor } from "./map-object.js";

const WALLET_CLASS = "khuzoe-actor-wallet";
const SITE_MEDIA_ORIGIN = "https://sigillo-api.khuzoe.workers.dev";

function walletDocumentFromApplication(app, { includeActor = true } = {}) {
  const candidates = [app?.document, app?.object, app?.item, app?.options?.document, includeActor ? app?.actor : null];
  for (const document of candidates) {
    if (document?.documentName === "Actor" && isInventoryActor(document) && ["character", "npc"].includes(String(document.type || ""))) return document;
    if (document?.documentName === "Item" && ["container", "backpack"].includes(String(document.type || ""))) return document;
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function currencyIconUrl(currency) {
  const raw = String(currency?.icon || "").trim();
  if (!raw) return "";
  let url = raw;
  if (/^media\//i.test(raw)) url = `${SITE_MEDIA_ORIGIN}/${raw.replace(/^\/+/, "")}`;
  const revision = Number(getEconomyRegistry()?.revision || 0);
  if (revision > 0 && /^https?:/i.test(url)) {
    url += `${url.includes("?") ? "&" : "?"}v=${revision}`;
  }
  return url;
}

function currencyIconMarkup(currency, className) {
  const icon = currencyIconUrl(currency);
  if (icon) {
    return `<img class="${className}" src="${escapeHtml(icon)}" alt="" loading="eager">`;
  }
  const symbol = String(currency?.symbol || currency?.id || "?").slice(0, 3);
  return `<span class="${className} is-symbol">${escapeHtml(symbol)}</span>`;
}

function walletInputMarkup(currency, amount, step, editable, extraClass = "") {
  return `<input type="text" class="${escapeHtml(extraClass)}" min="0" step="${step}" value="${amount}"
    data-km-wallet-path="${escapeHtml(currency.storage.path)}" data-km-wallet-precision="${currency.precision}"
    inputmode="decimal" pattern="[0-9+=\\-.,]*" aria-label="${escapeHtml(currency.name)}" ${editable ? "" : "disabled"}>`;
}

function customCurrencies() {
  return economyCurrencies({ includeInactive: false }).filter((currency) => {
    const path = String(currency?.storage?.path || "");
    return currency?.storage?.kind === "flag" || path.startsWith(`flags.${MODULE_ID}.wallet.`);
  });
}

function nativeCurrencyHost(root) {
  const selector = ".currency, .currency-list, [data-section='currency'], [data-group='currency']";
  const candidates = [root, ...root.querySelectorAll(selector)]
    .filter((element, index, values) => values.indexOf(element) === index && element.matches?.(selector));
  return candidates
    .map((element) => ({
      element,
      inputs: element.querySelectorAll("[name^='system.currency.']").length
        + (element.matches("[name^='system.currency.']") ? 1 : 0)
    }))
    .filter((entry) => entry.inputs > 0)
    .sort((left, right) => right.inputs - left.inputs)[0]?.element ?? null;
}

function hideArchivedNativeCurrencies(root) {
  const archived = economyCurrencies({ includeInactive: true }).filter((currency) => (
    currency.active === false && currency.storage?.kind === "system"
  ));
  for (const currency of archived) {
    const path = String(currency.storage?.path || "");
    if (!path) continue;
    for (const input of root.querySelectorAll(`[name="${CSS.escape(path)}"]`)) {
      input.classList.add("khuzoe-currency-archived");
      input.setAttribute("aria-hidden", "true");
      const wrapper = input.closest("label, .currency-entry, .denomination") || input;
      wrapper.classList.add("khuzoe-currency-archived");
      const previous = input.previousElementSibling;
      if (previous?.matches?.("label.denomination")) previous.classList.add("khuzoe-currency-archived");
    }
  }
}

function amountForInput(value, precision) {
  const number = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number)) return 0;
  const safePrecision = Math.max(0, Math.min(4, Math.floor(Number(precision) || 0)));
  const factor = 10 ** safePrecision;
  return Math.max(0, Math.round(number * factor) / factor);
}

function walletMarkup(document, currencies, nativeMode) {
  const wallet = readWallet(document, { includeInactive: true });
  const editable = Boolean(document.isOwner && !document.pack);
  const entries = currencies.map((currency) => {
    const amount = Number(wallet[currency.id] || 0);
    const step = currency.precision > 0 ? 1 / (10 ** currency.precision) : 1;
    const accent = /^#[0-9a-f]{6}$/i.test(String(currency.color || "")) ? currency.color : "#d8a94d";
    return { currency, amount, step, accent };
  });

  if (nativeMode === "modern") {
    return entries.map(({ currency, amount, step, accent }) => `
      <label class="khuzoe-wallet-native" style="--km-wallet-accent:${escapeHtml(accent)}"
        aria-label="${escapeHtml(currency.name)}" data-tooltip="${escapeHtml(currency.name)}">
        ${currencyIconMarkup(currency, "khuzoe-wallet-native-icon")}
        ${walletInputMarkup(currency, amount, step, editable, "uninput")}
      </label>`).join("");
  }

  if (nativeMode === "legacy") {
    return entries.map(({ currency, amount, step, accent }) => `
      <label class="denomination khuzoe-wallet-legacy-label" style="--km-wallet-accent:${escapeHtml(accent)}"
        title="${escapeHtml(currency.name)}">
        ${currencyIconMarkup(currency, "khuzoe-wallet-legacy-icon")}
        <span>${escapeHtml(currency.symbol || currency.id)}</span>
      </label>
      ${walletInputMarkup(currency, amount, step, editable, "khuzoe-wallet-legacy-input")}`).join("");
  }

  const coins = entries.map(({ currency, amount, step, accent }) => `
    <div class="khuzoe-wallet-coin denomination" style="--km-wallet-accent:${escapeHtml(accent)}" title="${escapeHtml(currency.name)}">
      <label>
        ${currencyIconMarkup(currency, "khuzoe-wallet-fallback-icon")}
        <span class="khuzoe-wallet-symbol">${escapeHtml(currency.symbol || currency.id)}</span>
        <span class="khuzoe-wallet-name">${escapeHtml(currency.name)}</span>
      </label>
      ${walletInputMarkup(currency, amount, step, editable)}
    </div>`).join("");

  return `<header class="khuzoe-wallet-heading"><i class="fas fa-coins"></i><span>Valute personalizzate</span></header>
    <div class="khuzoe-wallet-grid">${coins}</div>`;
}

function walletCurrencyForInput(input) {
  const path = String(input?.dataset?.kmWalletPath || input?.name || "");
  return economyCurrencies({ includeInactive: false }).find((currency) => currency.storage.path === path) || null;
}

function walletCurrencyDragHandle(input) {
  const previous = input.previousElementSibling;
  if (previous?.matches?.("label.denomination")) return previous;
  const host = input.closest?.("label, .khuzoe-wallet-coin");
  return host?.querySelector?.("img, .khuzoe-wallet-native-icon, .khuzoe-wallet-legacy-icon, .khuzoe-wallet-fallback-icon") || host;
}

function bindCurrencyDragHandles(actor, root) {
  const inputs = root.querySelectorAll("[name^='system.currency.'], [data-km-wallet-path]");
  for (const input of inputs) {
    const currency = walletCurrencyForInput(input);
    const handle = currency ? walletCurrencyDragHandle(input) : null;
    if (!currency || !handle || handle.dataset.kmCurrencyDragBound === "true") continue;
    handle.dataset.kmCurrencyDragBound = "true";
    handle.classList.add("khuzoe-currency-drag-handle");
    handle.draggable = true;
    handle.title = "Trascina a terra o in un contenitore; sceglierai la quantità. Alt: una sola unità.";
    handle.addEventListener("dragstart", (event) => {
      const currentWallet = readWallet(actor, { includeInactive: true });
      const balance = Math.max(0, Number(currentWallet[currency.id]) || 0);
      const unit = currency.precision > 0 ? 1 / (10 ** currency.precision) : 1;
      const amount = event.altKey ? Math.min(balance, unit) : balance;
      if (!(amount > 0) || !event.dataTransfer) {
        event.preventDefault();
        ui.notifications?.warn?.("Non ci sono monete di questa valuta da depositare.");
        return;
      }
      const sourceToken = actor.token || null;
      const payload = {
        type: "KhuzoeCurrency",
        currencyId: currency.id,
        amount,
        sourceActorId: actor.id || "",
        sourceSceneId: sourceToken?.parent?.id || "",
        sourceTokenId: sourceToken?.id || ""
      };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify(payload));
      event.stopPropagation();
    });
  }
}

async function updateBalance(event, walletDocument) {
  event.preventDefault();
  event.stopPropagation();
  const input = event.currentTarget;
  if (!walletDocument.isOwner || walletDocument.pack) return;
  const path = String(input.dataset.kmWalletPath || "");
  if (!/^flags\.khuzoe-merchant\.wallet\.[a-z0-9][a-z0-9_-]{0,39}$/.test(path)) return;
  const amount = amountForInput(input.value, input.dataset.kmWalletPrecision);
  input.disabled = true;
  try {
    await walletDocument.update({ [path]: amount });
    input.value = String(amount);
  } catch (error) {
    console.error(`${MODULE_ID} | Impossibile aggiornare la valuta del documento.`, error);
    ui.notifications?.error?.("Non \u00e8 stato possibile aggiornare questa valuta.");
  } finally {
    input.disabled = false;
  }
}

export function renderActorWallet(app, html) {
  const walletDocument = walletDocumentFromApplication(app);
  const root = applicationRoot(html, app);
  if (!walletDocument || !root) return;

  root.querySelectorAll(`.${WALLET_CLASS}`).forEach((element) => element.remove());
  hideArchivedNativeCurrencies(root);
  const nativeHost = nativeCurrencyHost(root);
  const currencies = customCurrencies();
  if (!nativeHost || !currencies.length) {
    if (walletDocument.documentName === "Actor") bindCurrencyDragHandles(walletDocument, root);
    return;
  }

  const nativeMode = nativeHost.matches("section.currency") ? "modern" : "legacy";
  const panel = document.createElement("div");
  panel.className = `${WALLET_CLASS} is-native-wallet is-${nativeMode}`;
  panel.innerHTML = walletMarkup(walletDocument, currencies, nativeMode);
  panel.querySelectorAll("[data-km-wallet-path]").forEach((input) => {
    input.addEventListener("change", (event) => updateBalance(event, walletDocument));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      }
    });
  });

  nativeHost.appendChild(panel);
  if (walletDocument.documentName === "Actor") bindCurrencyDragHandles(walletDocument, root);
}

function renderApplicationWallet(app, html) {
  if (!walletDocumentFromApplication(app, { includeActor: false })) return;
  renderActorWallet(app, html);
}

function refreshOpenWalletSheets() {
  for (const app of openApplications()) {
    if (walletDocumentFromApplication(app)) rerenderApplication(app);
  }
}

export function registerActorWallet() {
  Hooks.on("renderActorSheet", renderActorWallet);
  Hooks.on("renderItemSheet", renderActorWallet);
  Hooks.on("renderApplicationV2", renderApplicationWallet);
  Hooks.on(`${MODULE_ID}.economyUpdated`, refreshOpenWalletSheets);
}
