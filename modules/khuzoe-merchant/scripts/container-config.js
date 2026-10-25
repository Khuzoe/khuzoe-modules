import { MODULE_ID, TEMPLATES } from "./constants.js";
import { containerCurrencyIcon, containerItemFingerprint, getContainer, normalizeContainer } from "./container-data.js";
import { currencyById, economyCurrencies } from "./economy.js";
import { promptQuantity } from "./quantity-dialog.js";
import { requestContainerDeposit } from "./container-socket.js";
import { enqueueTransaction } from "./transaction-coordinator.js";
import { getAuthoritativeContainer, saveAuthoritativeContainer } from "./container-store.js";
import { itemDescription, localize, notifyError, refreshMerchantEntries } from "./utils.js";
import {
  normalizeProduction,
  prepareProductionSchedule,
  productionRows,
  productionRuleFromEntry,
  validateProduction
} from "./production-data.js";
import { productionLogRows, productionNextLabel, runContainerProduction } from "./production.js";
import { activateInterfaceTabs } from "./ui-tabs.js";
import { bindElements, HandlebarsApplicationV2, openFilePicker, rerenderApplication } from "./foundry-compat.js";

const openContainerConfigurations = new Set();
const DND5E_CONTAINER_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);

function itemQuantity(item) {
  const raw = foundry.utils.getProperty(item, "system.quantity");
  const quantity = Number(typeof raw === "object" ? raw?.value : raw);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

function normalizedAmount(value, precision = 0) {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const factor = 10 ** Math.max(0, Math.min(4, Math.floor(Number(precision) || 0)));
  return Math.round(parsed * factor) / factor;
}

function isAllowedItem(item) {
  return game.system?.id !== "dnd5e" || DND5E_CONTAINER_ITEM_TYPES.has(String(item?.type || "").toLowerCase());
}

export class ContainerConfig extends HandlebarsApplicationV2 {
  constructor(tokenDocument, options = {}) {
    const { initialContainer, activeTab, ...applicationOptions } = options;
    super(applicationOptions);
    this.tokenDocument = tokenDocument?.document || tokenDocument;
    this._draft = initialContainer
      ? normalizeContainer(initialContainer)
      : getContainer(this.tokenDocument);
    this._baseRevision = this._draft?.revision ?? 0;
    this._activeTab = activeTab || "general";
    this._dirty = false;
    openContainerConfigurations.add(this);
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-container-config",
    tag: "form",
    classes: ["khuzoe-merchant", "khuzoe-container", "khuzoe-container-config", "km-application-v14"],
    position: { width: 960, height: 780 },
    window: { icon: "fa-solid fa-box", resizable: true },
    form: { closeOnSubmit: true, handler: ContainerConfig._onSubmitForm },
    actions: {
      removeKey: ContainerConfig._onRemoveKeyAction,
      removeItem: ContainerConfig._onRemoveItemAction,
      openSourceItem: ContainerConfig._onOpenSourceItemAction,
      pickImage: ContainerConfig._onPickImageAction,
      openLoot: ContainerConfig._onOpenLootAction,
      runProduction: ContainerConfig._onRunProductionAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.containerConfig }
  };

  static _onSubmitForm(event, form, formData) { return this._saveDraft({ notify: true }); }
  static _onRemoveKeyAction(event, target) { return this._removeKey(event, target); }
  static _onRemoveItemAction(event, target) { return this._removeItem(event, target); }
  static _onOpenSourceItemAction(event, target) { return this._openSourceItem(event, target); }
  static _onPickImageAction(event, target) { return this._pickImage(event, target); }
  static _onOpenLootAction(event, target) { return this._openLootSheet(event, target); }
  static _onRunProductionAction(event, target) { return this._runProduction(event, target); }

  get title() {
    return localize("KM.Container.ConfigTitle", { name: this._draft?.name || this.tokenDocument?.name || "" });
  }

  static async openForToken(tokenDocument, options = {}) {
    const token = tokenDocument?.document || tokenDocument;
    const initialContainer = await getAuthoritativeContainer(token);
    if (!initialContainer) return null;
    const application = new this(token, { ...options, initialContainer });
    application.render({ force: true });
    return application;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    if (!this._draft) this._draft = normalizeContainer();
    this._draft.inventory = await refreshMerchantEntries(this._draft.inventory);
    const currency = economyCurrencies({ includeInactive: true }).map((denomination) => {
      const icon = containerCurrencyIcon(denomination);
      return {
        ...denomination,
        icon,
        hasIcon: Boolean(icon),
        amount: Number(this._draft.currency[denomination.id] || 0),
        archived: denomination.active === false,
        step: denomination.precision > 0 ? 1 / (10 ** denomination.precision) : 1
      };
    });
    const production = normalizeProduction(this._draft.production);
    const storedQuantity = this._draft.inventory.reduce((sum, entry) => sum + Math.max(0, Number(entry.quantity) || 0), 0);

    return {
      ...context,
      container: this._draft,
      inventory: this._draft.inventory.map((entry) => ({
        ...entry,
        img: entry.img || "icons/svg/item-bag.svg",
        description: itemDescription(entry)
      })),
      production,
      productionRules: productionRows(this._draft.inventory, production),
      productionWeighted: production.mode === "weighted",
      productionIndependent: production.mode === "independent",
      productionWorldTime: production.timeBasis === "world",
      productionRealTime: production.timeBasis === "real",
      productionChanceTotal: production.rules.reduce((sum, rule) => sum + rule.chance, 0),
      productionNext: productionNextLabel(production),
      productionLog: productionLogRows(production),
      hasProductionLog: production.log.length > 0,
      hasProductionRules: production.rules.length > 0,
      tabGeneral: this._activeTab === "general",
      tabContent: this._activeTab === "content",
      tabLock: this._activeTab === "lock",
      tabProduction: this._activeTab === "production",
      inventoryCount: this._draft.inventory.length,
      storedQuantity,
      currencyCount: currency.filter((entry) => Number(entry.amount) > 0).length,
      productionRuleCount: production.rules.length,
      dirty: this._dirty,
      currency,
      keepEmpty: this._draft.emptyBehavior !== "delete",
      deleteEmpty: this._draft.emptyBehavior === "delete",
      key: this._draft.key,
      hasKey: Boolean(this._draft.key),
      keyInserted: Boolean(this._draft.key?.inserted)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    activateInterfaceTabs(root, this._activeTab, (tab) => {
      this._syncDraftFromForm();
      this._activeTab = tab;
    });
    const syncDirty = () => {
      this._syncDraftFromForm();
      this._dirty = true;
      this._updateDirtyState();
    };
    bindElements(root, "[name='name'], [name='img'], [name='description'], [name='emptyBehavior']", ["change", "input"], syncDirty);
    bindElements(root, "[data-item-id][data-field], [data-currency-id]", ["change", "input"], syncDirty);
    bindElements(root, "[name^='production.'], [data-production-field]", ["change", "input"], syncDirty);
    bindElements(root, "[name='production.enabled'], [data-production-field='enabled']", "change", () => this.render());

    bindElements(root, ".km-container-drop-zone", "dragover", (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("is-dragover");
    });
    bindElements(root, ".km-container-drop-zone", "dragleave", (event) => event.currentTarget.classList.remove("is-dragover"));
    bindElements(root, ".km-container-drop-zone", "drop", (event) => this._onItemDrop(event));
    bindElements(root, ".km-container-key-drop-zone", "dragover", (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("is-dragover");
    });
    bindElements(root, ".km-container-key-drop-zone", "dragleave", (event) => event.currentTarget.classList.remove("is-dragover"));
    bindElements(root, ".km-container-key-drop-zone", "drop", (event) => this._onKeyDrop(event));
    bindElements(root, "[name='img']", "input", (event) => {
      const preview = root.querySelector(".km-container-config-portrait");
      if (preview && event.currentTarget.value) preview.src = event.currentTarget.value;
    });
  }

  _updateDirtyState() {
    const status = this.element?.querySelector(".km-save-state");
    if (!status) return;
    status.classList.toggle("is-dirty", this._dirty);
    status.querySelector("span").textContent = localize(this._dirty ? "KM.Config.Unsaved" : "KM.Config.UpToDate");
    const icon = status.querySelector("i");
    if (icon) icon.className = `fas ${this._dirty ? "fa-circle" : "fa-circle-check"}`;
  }

  _syncDraftFromForm() {
    const form = this.form;
    if (!form || !this._draft) return;
    this._draft.name = String(form.querySelector("[name='name']")?.value || "Forziere").slice(0, 120);
    this._draft.img = String(form.querySelector("[name='img']")?.value || "").slice(0, 500);
    this._draft.description = String(form.querySelector("[name='description']")?.value || "").slice(0, 1000);
    this._draft.emptyBehavior = form.querySelector("[name='emptyBehavior']")?.value === "delete" ? "delete" : "keep";

    for (const entry of this._draft.inventory) {
      const input = form.querySelector(`[data-item-id="${CSS.escape(entry.id)}"][data-field="quantity"]`);
      if (input) entry.quantity = Math.max(1, Math.floor(Number(input.value) || 1));
    }

    const activeCurrencyIds = new Set(
      economyCurrencies({ includeInactive: true }).map((denomination) => denomination.id)
    );
    const currency = Object.fromEntries(
      Object.entries(this._draft.currency).filter(([currencyId, amount]) => (
        !activeCurrencyIds.has(currencyId) && Number(amount) > 0
      ))
    );
    for (const input of form.querySelectorAll("[data-currency-id]")) {
      const amount = normalizedAmount(input.value, input.dataset.precision);
      if (amount > 0) currency[String(input.dataset.currencyId)] = amount;
    }
    this._draft.currency = currency;

    const previous = normalizeProduction(this._draft.production);
    const productionControlsPresent = Boolean(form.querySelector("[name='production.mode']"));
    const rules = productionControlsPresent ? [] : previous.rules;
    for (const row of productionControlsPresent ? form.querySelectorAll(".km-production-rule") : []) {
      const enabled = row.querySelector("[data-production-field='enabled']")?.checked;
      if (!enabled) continue;
      const targetEntryId = String(row.dataset.entryId || "");
      const previousRule = previous.rules.find((rule) => rule.id === row.dataset.ruleId)
        || previous.rules.find((rule) => rule.targetEntryId === targetEntryId)
        || {};
      const entry = this._draft.inventory.find((candidate) => candidate.id === targetEntryId) || previousRule;
      rules.push(productionRuleFromEntry(entry, previousRule, {
        id: row.dataset.ruleId,
        quantityFormula: row.querySelector("[data-production-field='formula']")?.value,
        chance: row.querySelector("[data-production-field='chance']")?.value,
        maximum: row.querySelector("[data-production-field='maximum']")?.value
      }));
    }
    this._draft.production = normalizeProduction({
      ...previous,
      enabled: Boolean(form.querySelector("[name='production.enabled']")?.checked),
      mode: form.querySelector("[name='production.mode']")?.value ?? previous.mode,
      timeBasis: form.querySelector("[name='production.timeBasis']")?.value ?? previous.timeBasis,
      intervalDays: form.querySelector("[name='production.intervalDays']")?.value ?? previous.intervalDays,
      maxCatchUp: form.querySelector("[name='production.maxCatchUp']")?.value ?? previous.maxCatchUp,
      rules
    });
  }

  async _onKeyDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove("is-dragover");
    this._syncDraftFromForm();
    if (this._draft.key?.inserted) return notifyError("KM.Container.Errors.KeyStillInserted");
    try {
      const dragData = TextEditor.getDragEventData(event.originalEvent ?? event);
      if (dragData.type !== "Item") return notifyError("KM.Container.Errors.KeyItemOnly");
      const item = await CONFIG.Item.documentClass.fromDropData(dragData);
      if (!item || item.documentName !== "Item") return notifyError("KM.Container.Errors.KeyItemOnly");
      const data = item.toObject();
      if (foundry.utils.getProperty(data, "system.quantity") !== undefined) {
        foundry.utils.setProperty(data, "system.quantity", 1);
      }
      this._draft.key = {
        fingerprint: containerItemFingerprint(item),
        identityId: foundry.utils.randomID(24),
        identityBound: false,
        sourceUuid: item.uuid || "",
        name: String(item.name || "Chiave").slice(0, 120),
        img: item.img || "icons/svg/key.svg",
        type: String(item.type || "loot").slice(0, 60),
        data,
        inserted: false,
        insertedData: null
      };
      this._activeTab = "lock";
      this._dirty = true;
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile associare la chiave al contenitore`, error);
      notifyError("KM.Container.Errors.KeyConfigureFailed");
    }
  }

  _removeKey(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    if (this._draft.key?.inserted) return notifyError("KM.Container.Errors.KeyStillInserted");
    this._draft.key = null;
    this._activeTab = "lock";
    this._dirty = true;
    this.render();
  }

  async _onItemDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove("is-dragover");
    this._syncDraftFromForm();
    try {
      const dragData = TextEditor.getDragEventData(event.originalEvent ?? event);
      if (dragData.type === "KhuzoeCurrency") {
        const currency = currencyById(dragData.currencyId, { includeInactive: false });
        const maximum = normalizedAmount(dragData.amount, currency?.precision);
        if (!currency || !(maximum > 0)) return notifyError("KM.GroundLoot.Errors.InvalidCurrency");
        const amount = await promptQuantity({
          itemName: currency.name || currency.symbol || currency.id,
          maximum,
          precision: currency.precision,
          mode: "deposit"
        });
        if (amount === null) return;
        await this._deposit({
          kind: "currency",
          currencyId: currency.id,
          amount,
          sourceActorId: dragData.sourceActorId,
          sourceSceneId: dragData.sourceSceneId,
          sourceTokenId: dragData.sourceTokenId
        });
        return;
      }
      if (dragData.type !== "Item") return notifyError("KM.Errors.DropItemOnly");
      const item = await CONFIG.Item.documentClass.fromDropData(dragData);
      if (!item || item.documentName !== "Item") return notifyError("KM.Errors.DropItemOnly");
      if (!isAllowedItem(item)) return notifyError("KM.Container.Errors.NotStorable");

      const maximum = itemQuantity(item);
      const quantity = await promptQuantity({
        itemName: item.name || "Oggetto",
        maximum,
        precision: 0,
        mode: "deposit"
      });
      if (quantity === null) return;
      await this._deposit({ kind: "item", item, quantity });
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile depositare nel contenitore`, error);
      notifyError("KM.Container.Errors.DepositFailed");
    }
  }

  async _deposit(request) {
    await this._saveDraft({ notify: false });
    const result = await requestContainerDeposit({ containerToken: this.tokenDocument, ...request });
    const saved = await getAuthoritativeContainer(this.tokenDocument);
    if (saved) {
      this._draft = saved;
      this._baseRevision = saved.revision;
    }
    if (!result.ok) {
      notifyError(result.errorKey || "KM.Container.Errors.DepositFailed", result.errorData || {});
      this.render();
      return false;
    }
    ui.notifications.info(localize(
      result.copied ? "KM.Container.DepositCopied" : "KM.Container.Deposited",
      {
        quantity: result.quantity,
        item: result.itemName,
        actor: result.actorName,
        container: saved?.name || this.tokenDocument?.name || ""
      }
    ));
    this.render();
    return true;
  }
  _removeItem(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    const id = String(target.dataset.itemId || "");
    this._draft.inventory = this._draft.inventory.filter((entry) => entry.id !== id);
    this._draft.production = normalizeProduction({
      ...this._draft.production,
      rules: this._draft.production.rules.filter((rule) => rule.targetEntryId !== id)
    });
    this._activeTab = "content";
    this._dirty = true;
    this.render();
  }

  async _openSourceItem(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    const uuid = String(target.dataset.sourceUuid || "");
    if (!uuid || typeof globalThis.fromUuid !== "function") return notifyError("KM.Errors.SourceUnavailable");
    try {
      const item = await globalThis.fromUuid(uuid);
      if (item?.documentName !== "Item" || !item.sheet) return notifyError("KM.Errors.SourceUnavailable");
      rerenderApplication(item.sheet, { force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile aprire l'Oggetto del contenitore`, error);
      notifyError("KM.Errors.SourceUnavailable");
    }
  }

  _pickImage(event, target = event.currentTarget) {
    event.preventDefault();
    const input = this.form?.querySelector("[name='img']");
    if (!input) return;
    openFilePicker({
      type: "image",
      current: input.value,
      callback: (path) => {
        input.value = path;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  async _openLootSheet(event, target = event.currentTarget) {
    event.preventDefault();
    try {
      await this._saveDraft({ notify: false });
      const { ContainerSheet } = await import("./container-sheet.js");
      const sheet = await ContainerSheet.openForToken(this.tokenDocument);
      if (sheet) await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile aprire il contenitore per il prelievo`, error);
      notifyError("KM.Container.Errors.OpenLootFailed");
    }
  }

  async _runProduction(event, target = event.currentTarget) {
    event.preventDefault();
    try {
      await this._saveDraft({ notify: false });
      const result = await runContainerProduction(this.tokenDocument);
      const current = await getAuthoritativeContainer(this.tokenDocument);
      if (current) {
        this._draft = current;
        this._baseRevision = current.revision;
      }
      const summary = result.produced.map((entry) => `${entry.quantity}× ${entry.name}`).join(", ");
      ui.notifications.info(summary
        ? localize("KM.Production.RunResult", { result: summary })
        : localize("KM.Production.RunEmpty"));
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile eseguire la produzione del contenitore`, error);
      notifyError("KM.Production.Errors.RunFailed");
    }
  }

  async _saveDraft({ notify = true } = {}) {
    if (!game.user?.isGM) throw new Error("Solo un GM può configurare i contenitori.");
    this._syncDraftFromForm();
    this._draft.inventory = await refreshMerchantEntries(this._draft.inventory);
    const draft = foundry.utils.deepClone(this._draft);
    const clean = await enqueueTransaction(async () => {
      const current = await getAuthoritativeContainer(this.tokenDocument);
      if (!current) throw new Error("Il contenitore non è più disponibile.");
      if (current.revision !== this._baseRevision) {
        notifyError("KM.Container.Errors.ChangedWhileEditing");
        throw new Error("Il contenuto è cambiato durante la configurazione.");
      }
      draft.production = prepareProductionSchedule(draft.production, current.production);
      const validation = validateProduction(draft.production, { inventory: draft.inventory });
      if (!validation.ok) {
        notifyError(validation.errorKey, validation.errorData);
        throw new Error(`Invalid container production: ${validation.errorKey}`);
      }
      const saved = normalizeContainer({
        ...draft,
        schemaVersion: 2,
        revision: current.revision + 1,
        production: validation.production
      });
      await saveAuthoritativeContainer(this.tokenDocument, saved, {
        name: saved.name,
        "texture.src": saved.img
      }, { khuzoeMerchantContainerConfig: true });
      return saved;
    }, "container configuration");
    this._draft = clean;
    this._baseRevision = clean.revision;
    this._dirty = false;
    if (notify) ui.notifications.info(localize("KM.Container.ConfigSaved", { name: clean.name }));
    return clean;
  }

  async close(options = {}) {
    openContainerConfigurations.delete(this);
    return super.close(options);
  }

  static refreshForItem(item) {
    for (const config of openContainerConfigurations) {
      if (!config._draft?.inventory?.some((entry) => entry.sourceUuid === item.uuid)) continue;
      config._syncDraftFromForm();
      config.render();
    }
  }
}
