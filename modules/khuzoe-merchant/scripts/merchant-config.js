import { MODULE_ID, TEMPLATES } from "./constants.js";
import { denominationOptions, extractItemPrice, normalizeCost, normalizePrice } from "./currency-v2.js";
import { duplicate, getMerchant, itemDescription, localize, notifyError, refreshMerchantEntries } from "./utils.js";
import { enqueueTransaction } from "./transaction-coordinator.js";
import { prepareItemBundle } from "./item-transfer.js";
import { getAuthoritativeMerchant, saveAuthoritativeMerchant } from "./container-store.js";
import {
  normalizeProduction,
  prepareProductionSchedule,
  productionRows,
  productionRuleFromEntry,
  validateProduction
} from "./production-data.js";
import { productionLogRows, productionNextLabel, runMerchantProduction } from "./production.js";
import { activateInterfaceTabs } from "./ui-tabs.js";
import { bindElements, HandlebarsApplicationV2, rerenderApplication } from "./foundry-compat.js";

const openConfigurations = new Set();

function normalizeStock(value) {
  if (value === "" || value === null || value === undefined) return null;
  const stock = Number.parseInt(value, 10);
  return Number.isFinite(stock) ? Math.max(0, stock) : null;
}

export class MerchantConfig extends HandlebarsApplicationV2 {
  constructor(actor, options = {}) {
    const { initialMerchant, activeTab, ...applicationOptions } = options;
    super(applicationOptions);
    this.actor = actor;
    this._draft = initialMerchant ? duplicate(initialMerchant) : getMerchant(actor);
    this._baseRevision = this._draft.revision;
    this._activeTab = activeTab || "general";
    this._dirty = false;
    this._selectedItems = new Set();
    openConfigurations.add(this);
    if (!actor.getFlag(MODULE_ID, "merchant")) {
      this._draft.distance = Math.max(0, Number(game.settings.get(MODULE_ID, "defaultDistance")) || 0);
    }
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-merchant-config",
    tag: "form",
    classes: ["khuzoe-merchant", "khuzoe-merchant-config", "km-application-v14"],
    position: { width: 960, height: 780 },
    window: { icon: "fa-solid fa-store", resizable: true },
    form: { closeOnSubmit: true, handler: MerchantConfig._onSubmitForm },
    actions: {
      removeItem: MerchantConfig._onRemoveItemAction,
      openSourceItem: MerchantConfig._onOpenSourceItemAction,
      runProduction: MerchantConfig._onRunProductionAction,
      applyBulkPrice: MerchantConfig._onApplyBulkPriceAction,
      applyBulkStock: MerchantConfig._onApplyBulkStockAction,
      selectAllItems: MerchantConfig._onSelectAllItemsAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.config }
  };

  static _onSubmitForm(event, form, formData) { return this._saveDraft({ notify: true }); }
  static _onRemoveItemAction(event, target) { return this._removeItem(event, target); }
  static _onOpenSourceItemAction(event, target) { return this._openSourceItem(event, target); }
  static _onRunProductionAction(event, target) { return this._runProduction(event, target); }
  static _onApplyBulkPriceAction(event, target) { return this._applyBulkPrice(event, target); }
  static _onApplyBulkStockAction(event, target) { return this._applyBulkStock(event, target); }
  static _onSelectAllItemsAction(event, target) { return this._selectAllItems(event, target); }

  get title() {
    return localize("KM.Config.Title", { name: this.actor.name });
  }

  static async openForActor(actor, options = {}) {
    const initialMerchant = await getAuthoritativeMerchant(actor);
    const application = new this(actor, { ...options, initialMerchant });
    application.render({ force: true });
    return application;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const denominations = denominationOptions();
    this._draft.inventory = await refreshMerchantEntries(this._draft.inventory);
    const inventory = this._draft.inventory.map((entry) => {
      const price = normalizePrice(entry);
      return {
        ...entry,
        img: entry.img || "icons/svg/item-bag.svg",
        description: itemDescription(entry),
        priceValue: price.value,
        denomination: price.denomination,
        denominationOptions: denominations.map((option) => ({ ...option, selected: option.value === price.denomination })),
        stockValue: entry.stock ?? "",
        unlimited: entry.stock === null || entry.stock === undefined,
        selected: this._selectedItems.has(entry.id)
      };
    });
    const production = normalizeProduction(this._draft.production);
    const rules = productionRows(this._draft.inventory, production, { merchant: true });
    const finiteEntries = this._draft.inventory.filter((entry) => entry.stock !== null && entry.stock !== undefined);

    return {
      ...context,
      actor: this.actor,
      merchant: this._draft,
      inventory,
      production,
      productionRules: rules,
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
      tabCatalog: this._activeTab === "catalog",
      tabProduction: this._activeTab === "production",
      inventoryCount: this._draft.inventory.length,
      finiteStockCount: finiteEntries.length,
      soldOutCount: finiteEntries.filter((entry) => Number(entry.stock) < 1).length,
      productionRuleCount: production.rules.length,
      dirty: this._dirty,
      selectedItemCount: this._selectedItems.size,
      denominations: denominations.map((option) => option.label).join(", "),
      unit: canvas?.scene?.grid?.units || localize("KM.Common.SceneUnits")
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
    bindElements(root, "[name='enabled'], [name='subtitle'], [name='distance']", ["change", "input"], syncDirty);
    bindElements(root, "[data-item-id][data-field]", ["change", "input"], syncDirty);
    bindElements(root, "[data-bulk-select]", "change", (event) => {
      const id = String(event.currentTarget.dataset.bulkSelect || "");
      if (event.currentTarget.checked) this._selectedItems.add(id);
      else this._selectedItems.delete(id);
      const count = root.querySelector(".km-bulk-selected-count");
      if (count) count.textContent = String(this._selectedItems.size);
    });
    bindElements(root, "[name^='production.'], [data-production-field]", ["change", "input"], syncDirty);
    bindElements(root, "[name='production.enabled'], [data-production-field='enabled']", "change", () => this.render());

    bindElements(root, ".km-drop-zone", "dragover", (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("is-dragover");
    });
    bindElements(root, ".km-drop-zone", "dragleave", (event) => {
      event.currentTarget.classList.remove("is-dragover");
    });
    bindElements(root, ".km-drop-zone", "drop", (event) => this._onItemDrop(event));
  }

  _updateDirtyState() {
    const status = this.element?.querySelector(".km-save-state");
    if (!status) return;
    status.classList.toggle("is-dirty", this._dirty);
    status.querySelector("span").textContent = localize(this._dirty ? "KM.Config.Unsaved" : "KM.Config.UpToDate");
    const icon = status.querySelector("i");
    if (icon) icon.className = `fas ${this._dirty ? "fa-circle" : "fa-circle-check"}`;
  }

  _selectAllItems(event, target = event.currentTarget) {
    event.preventDefault();
    const shouldSelect = this._selectedItems.size !== this._draft.inventory.length;
    this._selectedItems = shouldSelect
      ? new Set(this._draft.inventory.map((entry) => entry.id))
      : new Set();
    this.render();
  }

  _applyBulkPrice(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    const multiplier = Math.max(0, Number(this.form?.querySelector("[name='bulkPriceMultiplier']")?.value) || 1);
    if (!this._selectedItems.size) return notifyError("KM.Config.BulkNoSelection");
    for (const entry of this._draft.inventory) {
      if (!this._selectedItems.has(entry.id)) continue;
      const price = normalizePrice(entry);
      entry.price = { ...price, value: Math.round(price.value * multiplier * 10000) / 10000 };
      entry.cost = { components: [{ currencyId: entry.price.denomination, amount: entry.price.value }] };
    }
    this._dirty = true;
    this.render();
  }

  _applyBulkStock(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    if (!this._selectedItems.size) return notifyError("KM.Config.BulkNoSelection");
    const value = this.form?.querySelector("[name='bulkStock']")?.value ?? "";
    for (const entry of this._draft.inventory) {
      if (this._selectedItems.has(entry.id)) entry.stock = normalizeStock(value);
    }
    this._dirty = true;
    this.render();
  }

  _syncDraftFromForm() {
    const form = this.form;
    if (!form) return;
    this._draft.enabled = Boolean(form.querySelector("[name='enabled']")?.checked);
    this._draft.subtitle = String(form.querySelector("[name='subtitle']")?.value ?? "").slice(0, 160);
    this._draft.distance = Math.max(0, Number(form.querySelector("[name='distance']")?.value) || 0);

    for (const entry of this._draft.inventory) {
      const selector = `[data-item-id="${CSS.escape(entry.id)}"]`;
      const price = form.querySelector(`${selector}[data-field="price"]`);
      const denomination = form.querySelector(`${selector}[data-field="denomination"]`);
      const stock = form.querySelector(`${selector}[data-field="stock"]`);
      if (price) {
        entry.price = {
          value: Math.max(0, Number(price.value) || 0),
          denomination: String(denomination?.value ?? "").trim().slice(0, 40)
        };
        entry.cost = { components: [{ currencyId: entry.price.denomination, amount: entry.price.value }] };
      }
      if (stock) entry.stock = normalizeStock(stock.value);
    }

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

  async _onItemDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove("is-dragover");
    this._syncDraftFromForm();

    try {
      const dragData = TextEditor.getDragEventData(event.originalEvent ?? event);
      if (dragData.type !== "Item") return notifyError("KM.Errors.DropItemOnly");
      const itemClass = CONFIG.Item.documentClass;
      const item = await itemClass.fromDropData(dragData);
      if (!item || item.documentName !== "Item") return notifyError("KM.Errors.DropItemOnly");

      const duplicateItem = this._draft.inventory.some((entry) => entry.sourceUuid === item.uuid);
      if (duplicateItem) return notifyError("KM.Errors.DuplicateItem");
      const preparedBundle = await prepareItemBundle(item, { quantity: 1 });

      this._draft.inventory.push({
        id: foundry.utils.randomID(12),
        sourceUuid: item.uuid,
        name: String(item.name).slice(0, 120),
        img: item.img || "icons/svg/item-bag.svg",
        type: String(item.type ?? "item").slice(0, 60),
        description: itemDescription(item),
        price: extractItemPrice(item),
        stock: null,
        data: item.toObject(),
        dataBundle: preparedBundle.length > 1 ? preparedBundle : undefined
      });
      this._activeTab = "catalog";
      this._dirty = true;
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile aggiungere l'Oggetto trascinato`, error);
      notifyError("KM.Errors.DropFailed");
    }
  }

  _removeItem(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    const id = target.dataset.itemId;
    this._draft.inventory = this._draft.inventory.filter((entry) => entry.id !== id);
    this._selectedItems.delete(id);
    this._draft.production = normalizeProduction({
      ...this._draft.production,
      rules: this._draft.production.rules.filter((rule) => rule.targetEntryId !== id)
    });
    this._activeTab = "catalog";
    this._dirty = true;
    this.render();
  }

  async _openSourceItem(event, target = event.currentTarget) {
    event.preventDefault();
    this._syncDraftFromForm();
    const uuid = target.dataset.sourceUuid;
    if (!uuid || typeof globalThis.fromUuid !== "function") return notifyError("KM.Errors.SourceUnavailable");

    try {
      const item = await globalThis.fromUuid(uuid);
      if (item?.documentName !== "Item" || !item.sheet) return notifyError("KM.Errors.SourceUnavailable");
      rerenderApplication(item.sheet, { force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile aprire l'Oggetto originale`, error);
      notifyError("KM.Errors.SourceUnavailable");
    }
  }

  async _saveDraft({ notify = true } = {}) {
    if (!game.user.isGM) throw new Error("Solo un GM puo configurare i mercanti.");
    this._syncDraftFromForm();
    const draft = duplicate(this._draft);
    return enqueueTransaction(async () => {
      const current = await getAuthoritativeMerchant(this.actor);
      if (current.revision !== this._baseRevision) {
        notifyError("KM.Errors.MerchantChangedWhileEditing");
        throw new Error("La configurazione del mercante è cambiata durante la modifica.");
      }
      draft.inventory = await refreshMerchantEntries(draft.inventory);
      draft.production = prepareProductionSchedule(draft.production, current.production);
      const validation = validateProduction(draft.production, { merchant: true, inventory: draft.inventory });
      if (!validation.ok) {
        notifyError(validation.errorKey, validation.errorData);
        throw new Error(`Invalid merchant production: ${validation.errorKey}`);
      }
      const clean = {
        schemaVersion: 2,
        revision: current.revision + 1,
        vaultRef: current.vaultRef || "",
        enabled: Boolean(draft.enabled),
        subtitle: String(draft.subtitle ?? "").trim().slice(0, 160),
        distance: Math.max(0, Number(draft.distance) || 0),
        production: validation.production,
        inventory: draft.inventory.map((entry) => ({
          id: String(entry.id),
          sourceUuid: String(entry.sourceUuid ?? ""),
          name: String(entry.name ?? "Item").slice(0, 120),
          img: String(entry.img ?? "icons/svg/item-bag.svg"),
          type: String(entry.type ?? "item").slice(0, 60),
          description: itemDescription(entry),
          price: normalizePrice(entry),
          cost: normalizeCost(entry),
          stock: normalizeStock(entry.stock),
          data: duplicate(entry.data ?? {}),
          dataBundle: Array.isArray(entry.dataBundle) ? duplicate(entry.dataBundle) : undefined
        }))
      };
      await saveAuthoritativeMerchant(this.actor, clean);
      this._draft = clean;
      this._baseRevision = clean.revision;
      this._dirty = false;
      if (notify) ui.notifications.info(localize("KM.Config.Saved", { name: this.actor.name }));
      return clean;
    }, "merchant configuration save");
  }

  async _runProduction(event, target = event.currentTarget) {
    event.preventDefault();
    try {
      await this._saveDraft({ notify: false });
      const result = await runMerchantProduction(this.actor);
      const current = await getAuthoritativeMerchant(this.actor);
      this._draft = current;
      this._baseRevision = current.revision;
      const summary = result.produced.map((entry) => `${entry.quantity}× ${entry.name}`).join(", ");
      ui.notifications.info(summary
        ? localize("KM.Production.RunResult", { result: summary })
        : localize("KM.Production.RunEmpty"));
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile eseguire la produzione del mercante`, error);
      notifyError("KM.Production.Errors.RunFailed");
    }
  }

  async close(options = {}) {
    openConfigurations.delete(this);
    return super.close(options);
  }

  static refreshForItem(item) {
    for (const config of openConfigurations) {
      if (!config._draft.inventory.some((entry) => entry.sourceUuid === item.uuid)) continue;
      config._syncDraftFromForm();
      config.render();
    }
  }
}
