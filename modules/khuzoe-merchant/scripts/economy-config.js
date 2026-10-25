import { MODULE_ID, TEMPLATES } from "./constants.js";
import { applyEconomyRegistrySnapshot, getEconomyRegistry, saveEconomyRegistry, validateEconomyRegistry } from "./economy.js";
import { bindElements, HandlebarsApplicationV2 } from "./foundry-compat.js";

const SITE_SYNC_MODULE_ID = "cripta-wiki-sync";
const SITE_ECONOMY_ENDPOINT = "https://sigillo-api.khuzoe.workers.dev/api/economy";

function duplicate(value) {
  return foundry.utils.deepClone(value);
}

function randomId(prefix) {
  return `${prefix}-${foundry.utils.randomID(8).toLowerCase()}`;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class EconomyConfig extends HandlebarsApplicationV2 {
  constructor(options = {}) {
    super(options);
    this._original = getEconomyRegistry();
    this._draft = duplicate(this._original);
    this._siteRefreshRequested = false;
    this._siteRefreshError = "";
    this._siteSyncPayload = null;
    this._validationError = "";
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-economy-config",
    tag: "form",
    classes: ["khuzoe-merchant", "khuzoe-economy-config", "km-application-v14"],
    position: { width: 960, height: 760 },
    window: { icon: "fa-solid fa-coins", resizable: true },
    form: { closeOnSubmit: true, handler: EconomyConfig._onSubmitForm },
    actions: {
      addGroup: EconomyConfig._onAddGroupAction,
      addCurrency: EconomyConfig._onAddCurrencyAction,
      toggleCurrency: EconomyConfig._onToggleCurrencyAction,
      syncNow: EconomyConfig._onSyncNowAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.economy }
  };

  static _onSubmitForm(event, form, formData) { return this._saveRegistry(); }
  static _onAddGroupAction(event, target) { return this._addGroup(event, target); }
  static _onAddCurrencyAction(event, target) { return this._addCurrency(event, target); }
  static _onToggleCurrencyAction(event, target) { return this._toggleCurrency(event, target); }
  static _onSyncNowAction(event, target) { return this._syncNow(event, target); }

  get title() {
    return game.i18n.localize("KM.Economy.Title");
  }

  async _refreshFromSite({ force = false } = {}) {
    if ((!force && this._siteRefreshRequested) || !game.user?.isGM) return;
    if (!force && !game.settings.get(MODULE_ID, "economyAutoSync")) return;
    this._siteRefreshRequested = true;
    this._siteRefreshError = "";
    const syncModule = game.modules.get(SITE_SYNC_MODULE_ID);
    const pull = syncModule?.active ? syncModule.api?.pullEconomyRegistry : null;

    let bridgeError = null;
    try {
      if (typeof pull !== "function") throw new Error("API di sincronizzazione non disponibile.");
      await pull({ reason: "open-economy-config" });
      this._original = getEconomyRegistry();
      this._draft = duplicate(this._original);
      return;
    } catch (error) {
      bridgeError = error;
      console.warn(`${MODULE_ID} | Ponte Cripta Wiki Sync non disponibile; provo il recupero diretto.`, error);
    }

    try {
      await this._pullDirectlyFromSite();
      this._original = getEconomyRegistry();
      this._draft = duplicate(this._original);
    } catch (error) {
      console.warn(`${MODULE_ID} | Aggiornamento valute dal sito non riuscito.`, { bridgeError, directError: error });
      const directMessage = String(error?.message || "Sincronizzazione col sito non riuscita.");
      const bridgeMessage = String(bridgeError?.message || "").trim();
      this._siteRefreshError = bridgeMessage && bridgeMessage !== directMessage
        ? `${directMessage} Ponte interno: ${bridgeMessage}`
        : directMessage;
    }
  }

  _campaignId() {
    if (!game.modules.get(SITE_SYNC_MODULE_ID)?.active) {
      throw new Error("Cripta Wiki Sync non \u00e8 attivo: non posso determinare la campagna del sito.");
    }
    let value = "";
    try {
      value = game.settings.get(SITE_SYNC_MODULE_ID, "campaignId");
    } catch (_error) {
      value = "";
    }
    const campaignId = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!campaignId) throw new Error("Campagna del sito non configurata in Cripta Wiki Sync.");
    return campaignId;
  }

  async _pullDirectlyFromSite() {
    const url = new URL(SITE_ECONOMY_ENDPOINT);
    url.searchParams.set("campaign", this._campaignId());
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    }
    if (!payload?.registry) throw new Error("Il sito non ha restituito un registro valute valido.");
    await applyEconomyRegistrySnapshot(payload.registry, { source: "site" });
    this._siteSyncPayload = payload;
  }

  _syncState() {
    if (this._siteRefreshError) return { ok: false, label: "Sync sito non riuscita", title: this._siteRefreshError };
    const directVersion = Math.max(0, Number(this._siteSyncPayload?.version || 0));
    if (directVersion > 0) {
      return {
        ok: true,
        label: `Sito sincronizzato \u00b7 v${directVersion}`,
        title: String(this._siteSyncPayload?.updatedAt || "")
      };
    }
    try {
      const state = game.settings.get(SITE_SYNC_MODULE_ID, "economySyncState");
      const version = Math.max(0, Number(state?.version || 0));
      if (version > 0) return { ok: true, label: `Sito sincronizzato \u00b7 v${version}`, title: String(state?.updatedAt || "") };
    } catch (_error) {
      // Cripta Wiki Sync may not be installed in standalone worlds.
    }
    return { ok: false, label: "Registro locale", title: this._siteRefreshError };
  }

  async _prepareContext(options = {}) {
    await this._refreshFromSite();
    const context = await super._prepareContext(options);
    return {
      ...context,
      revision: this._draft.revision,
      sync: this._syncState(),
      validation: {
        ok: !this._validationError,
        message: this._validationError || game.i18n.localize("KM.Economy.ValidationOk")
      },
      groups: this._draft.groups.map((group) => ({
        ...group,
        automatic: group.conversionMode === "automatic",
        conversionPreview: this._conversionPreview(group),
        currencies: group.currencies.map((currency) => ({
          ...currency,
          isBase: currency.id === group.baseCurrencyId,
          archived: !currency.active
        }))
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    bindElements(this.element, "[data-economy-field]", ["change", "input"], () => {
      this._syncDraft();
      this._updateValidationState();
    });
    this._updateValidationState();
  }

  _conversionPreview(group) {
    if (group.conversionMode !== "automatic" || group.currencies.length < 2) return [];
    const base = group.currencies.find((currency) => currency.id === group.baseCurrencyId) || group.currencies[0];
    return group.currencies
      .filter((currency) => currency.id !== base.id && currency.active !== false)
      .slice(0, 4)
      .map((currency) => ({
        label: `1 ${currency.symbol || currency.id} = ${new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: 4 }).format(currency.factor / base.factor)} ${base.symbol || base.id}`
      }));
  }

  _updateValidationState() {
    try {
      validateEconomyRegistry(this._draft);
      this._validationError = "";
    } catch (error) {
      this._validationError = String(error?.message || game.i18n.localize("KM.Economy.ValidationError"));
    }
    const panel = this.element?.querySelector(".km-economy-validation");
    if (panel) {
      panel.classList.toggle("is-valid", !this._validationError);
      panel.classList.toggle("is-invalid", Boolean(this._validationError));
      const message = panel.querySelector("span");
      if (message) message.textContent = this._validationError || game.i18n.localize("KM.Economy.ValidationOk");
    }
    const submit = this.element?.querySelector("button[type='submit']");
    if (submit) submit.disabled = Boolean(this._validationError);
  }

  _syncDraft() {
    if (!this.form) return;
    for (const group of this._draft.groups) {
      const groupSelector = `[data-group-id="${CSS.escape(group.id)}"]`;
      const groupName = this.form.querySelector(`${groupSelector}[data-economy-field="group-name"]`);
      const mode = this.form.querySelector(`${groupSelector}[data-economy-field="conversion-mode"]`);
      const base = this.form.querySelector(`${groupSelector}[data-economy-field="base-currency"]`);
      if (groupName) group.name = String(groupName.value ?? "").trim().slice(0, 60);
      if (mode) group.conversionMode = mode.value === "automatic" ? "automatic" : "none";
      if (base) group.baseCurrencyId = String(base.value ?? "");

      for (const currency of group.currencies) {
        const selector = `${groupSelector}[data-currency-id="${CSS.escape(currency.id)}"]`;
        const field = (name) => this.form.querySelector(`${selector}[data-economy-field="${name}"]`);
        currency.name = String(field("currency-name")?.value ?? currency.name).trim().slice(0, 60);
        currency.symbol = String(field("currency-symbol")?.value ?? currency.symbol).trim().slice(0, 16);
        currency.factor = Math.max(0.0001, number(field("currency-factor")?.value, currency.factor));
        currency.precision = Math.max(0, Math.min(4, Math.floor(number(field("currency-precision")?.value, currency.precision))));
        currency.storage.path = String(field("currency-path")?.value ?? currency.storage.path).trim().slice(0, 120);
      }
    }
  }

  _addGroup(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraft();
    const id = randomId("group");
    this._draft.groups.push({
      id,
      name: "Nuovo gruppo",
      conversionMode: "none",
      baseCurrencyId: "",
      order: 0,
      currencies: []
    });
    this.render();
  }

  _addCurrency(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraft();
    const group = this._draft.groups.find((candidate) => candidate.id === target.dataset.groupId);
    if (!group) return;
    const id = randomId("currency");
    group.currencies.push({
      id,
      name: "Nuova valuta",
      symbol: "NV",
      factor: 1,
      precision: 0,
      order: 0,
      color: "#d8a94d",
      icon: "",
      active: true,
      storage: { kind: "flag", path: `flags.${MODULE_ID}.wallet.${id}` }
    });
    if (!group.baseCurrencyId) group.baseCurrencyId = id;
    this.render();
  }

  _toggleCurrency(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraft();
    const group = this._draft.groups.find((candidate) => candidate.id === target.dataset.groupId);
    const currency = group?.currencies.find((candidate) => candidate.id === target.dataset.currencyId);
    if (!currency) return;
    currency.active = !currency.active;
    this.render();
  }

  async _syncNow(event, target = event.currentTarget) {
    event.preventDefault();
    target.disabled = true;
    this._syncDraft();
    await this._refreshFromSite({ force: true });
    this.render();
  }

  async _saveRegistry() {
    this._syncDraft();
    validateEconomyRegistry(this._draft);
    const saved = await saveEconomyRegistry(this._draft, { expectedRevision: this._original.revision });
    this._original = saved;
    this._draft = duplicate(saved);
    ui.notifications.info(game.i18n.localize("KM.Economy.Saved"));
  }
}
