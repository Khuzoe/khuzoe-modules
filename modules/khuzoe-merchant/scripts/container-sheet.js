import { MODULE_ID, TEMPLATES } from "./constants.js";
import { containerCurrencyIcon, containerDistance, containerIsLocked, getContainer } from "./container-data.js";
import { currencyById, economyCurrencies } from "./economy.js";
import { requestContainerDeposit, requestContainerKey, requestContainerTake } from "./container-socket.js";
import { selectBuyerToken } from "./distance.js";
import { promptQuantity } from "./quantity-dialog.js";
import { isActorOwner, itemDescription, localize, notifyError, primaryGM, refreshMerchantEntries } from "./utils.js";
import { getAuthoritativeContainer } from "./container-store.js";
import { bindElements, HandlebarsApplicationV2, openImagePopout, rerenderApplication } from "./foundry-compat.js";
import { isInventoryToken } from "./map-object.js";

const openContainers = new Set();
let preferredContainerBuyerTokenId = "";

function formatNumber(value, precision = 0) {
  return new Intl.NumberFormat(game.i18n.lang, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, Math.min(4, Number(precision) || 0))
  }).format(Number(value) || 0);
}

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

function refreshActorInventory(actor) {
  if (!actor) return;
  rerenderApplication(actor.sheet);
  globalThis.setTimeout?.(() => rerenderApplication(actor.sheet), 150);
}

function selectedPreferredToken(containerToken) {
  const selected = selectBuyerToken(containerToken);
  if (selected) return selected;
  if (!preferredContainerBuyerTokenId) return null;
  const preferred = canvas?.tokens?.get?.(preferredContainerBuyerTokenId);
  if (!isInventoryToken(preferred) || !isActorOwner(preferred.actor)) return null;
  return preferred;
}

export function rememberContainerBuyerToken() {
  const selected = (canvas?.tokens?.controlled || []).filter((token) => isInventoryToken(token) && isActorOwner(token.actor));
  if (selected.length === 1) preferredContainerBuyerTokenId = selected[0].id;
}

export class ContainerSheet extends HandlebarsApplicationV2 {
  constructor(containerToken, buyerToken, options = {}) {
    const document = containerToken?.document || containerToken;
    const dynamicId = `khuzoe-container-sheet-${document?.parent?.id || "scene"}-${document?.id}-${buyerToken?.id}`;
    super({ ...options, id: dynamicId });
    this.containerToken = containerToken;
    this.buyerToken = buyerToken;
    this._query = "";
    this._viewMode = game.settings.get(MODULE_ID, "containerViewMode") === "full" ? "full" : "list";
    openContainers.add(this);
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-container-sheet",
    classes: ["khuzoe-merchant", "khuzoe-container", "khuzoe-container-sheet", "km-application-v14"],
    position: { width: 860, height: 700 },
    window: { icon: "fa-solid fa-box-open", resizable: true },
    actions: {
      viewMode: ContainerSheet._onViewModeAction,
      toggleDetails: ContainerSheet._onToggleDetailsAction,
      openImage: ContainerSheet._onOpenImageAction,
      takeKey: ContainerSheet._onTakeKeyAction,
      takeItem: ContainerSheet._onTakeItemAction,
      takeCurrency: ContainerSheet._onTakeCurrencyAction,
      takeAll: ContainerSheet._onTakeAllAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.containerSheet }
  };

  static _onViewModeAction(event, target) { return this._changeViewMode(event, target); }
  static _onToggleDetailsAction(event, target) { return this._toggleItemDetails(event, target); }
  static _onOpenImageAction(event, target) { return this._openImage(event, target); }
  static _onTakeKeyAction(event, target) { return this._takeKey(event, target); }
  static _onTakeItemAction(event, target) { return this._takeItem(event, target); }
  static _onTakeCurrencyAction(event, target) { return this._takeCurrency(event, target); }
  static _onTakeAllAction(event, target) { return this._takeAll(event, target); }

  get title() {
    const container = getContainer(this.containerToken);
    return localize("KM.Container.Title", { name: container?.name || this.containerToken?.name || "" });
  }

  static async openForToken(containerToken, { buyerToken: explicitBuyerToken = null } = {}) {
    const container = await getAuthoritativeContainer(containerToken);
    if (!container) return false;
    if (!primaryGM()) return notifyError("KM.Errors.NoGM");
    if (containerIsLocked(container) && !game.user?.isGM) return notifyError("KM.Container.Errors.Locked");
    const buyerToken = explicitBuyerToken || selectedPreferredToken(containerToken);
    if (!buyerToken) return notifyError("KM.Container.Errors.NoBuyerToken");
    const document = containerToken?.document || containerToken;
    const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "containerDistance")) || 0);
    if (!game.user?.isGM && containerDistance(buyerToken, document) > maximum + 1e-6) {
      return notifyError("KM.Container.Errors.OutOfRange", {
        distance: maximum, unit: document?.parent?.grid?.units || ""
      });
    }

    const existing = [...openContainers].find((app) => {
      const left = app.containerToken?.document || app.containerToken;
      const right = containerToken?.document || containerToken;
      return left?.id === right?.id && left?.parent?.id === right?.parent?.id && app.buyerToken?.id === buyerToken.id;
    });
    if (existing) {
      existing.render();
      existing.bringToFront();
      return existing;
    }

    const sheet = new ContainerSheet(containerToken, buyerToken);
    sheet.render({ force: true });
    buyerToken.control?.({ releaseOthers: true });
    return sheet;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const container = await getAuthoritativeContainer(this.containerToken);
    if (!container) return { ...context, unavailable: true, inventory: [], currencies: [], empty: true };
    const document = this.containerToken?.document || this.containerToken;
    const maximum = Math.max(0, Number(game.settings.get(MODULE_ID, "containerDistance")) || 0);
    const distance = containerDistance(this.buyerToken, document);
    const inRange = Boolean(game.user?.isGM) || distance <= maximum + 1e-6;
    const inventory = (await refreshMerchantEntries(container.inventory))
      .filter((entry) => entry.quantity > 0)
      .map((entry) => ({
        ...entry,
        description: itemDescription(entry),
        maxQuantity: Math.max(1, entry.quantity)
      }));

    const allCurrencies = economyCurrencies({ includeInactive: Boolean(game.user?.isGM) });
    const activeCurrencyById = new Map(allCurrencies.map((currency) => [currency.id, currency]));
    const currencies = Object.entries(container.currency).flatMap(([currencyId, amount]) => {
      const currency = activeCurrencyById.get(currencyId);
      if (!currency || !(Number(amount) > 0)) return [];
      const icon = containerCurrencyIcon(currency);
      return [{
        ...currency,
        amount,
        amountLabel: `${formatNumber(amount, currency.precision)} ${currency.symbol || currency.id}`,
        icon,
        hasIcon: Boolean(icon)
      }];
    }).sort((left, right) => {
      const leftIndex = allCurrencies.findIndex((currency) => currency.id === left.id);
      const rightIndex = allCurrencies.findIndex((currency) => currency.id === right.id);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
    });

    return {
      ...context,
      container,
      buyer: { name: this.buyerToken.actor?.name || "", img: this.buyerToken.actor?.img || "" },
      inventory,
      currencies,
      hasItems: inventory.length > 0,
      hasCurrency: currencies.length > 0,
      inventoryCount: inventory.length,
      totalQuantity: inventory.reduce((sum, entry) => sum + Math.max(0, Number(entry.quantity) || 0), 0),
      currencyCount: currencies.length,
      empty: inventory.length === 0 && currencies.length === 0,
      inRange,
      maxDistance: formatNumber(maximum, 1),
      unit: document?.parent?.grid?.units || "",
      query: this._query,
      viewMode: this._viewMode,
      listMode: this._viewMode === "list",
      fullMode: this._viewMode === "full",
      key: container.key,
      hasKey: Boolean(container.key),
      keyInserted: Boolean(container.key?.inserted)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    bindElements(root, ".km-container-search", "input", (event) => this._filterItems(event));
    bindElements(root, ".km-container-player-drop-zone", "dragover", (event) => {
      event.preventDefault();
      event.currentTarget.classList.add("is-dragover");
    });
    bindElements(root, ".km-container-player-drop-zone", "dragleave", (event) => event.currentTarget.classList.remove("is-dragover"));
    bindElements(root, ".km-container-player-drop-zone", "drop", (event) => this._onDepositDrop(event));
    if (this._query) this._filterItems({ currentTarget: root.querySelector(".km-container-search") });
  }

  _filterItems(event) {
    if (!event.currentTarget) return;
    this._query = String(event.currentTarget.value || "").trim().toLowerCase();
    const cards = [...this.element.querySelectorAll(".km-shop-card")];
    let visible = 0;
    for (const card of cards) {
      card.hidden = Boolean(this._query) && !String(card.dataset.search || "").toLowerCase().includes(this._query);
      if (!card.hidden) visible += 1;
    }
    const empty = this.element.querySelector(".km-container-search-empty");
    if (empty) empty.hidden = !this._query || visible > 0 || cards.length === 0;
  }

  async _changeViewMode(event, target = event.currentTarget) {
    event.preventDefault();
    const viewMode = target.dataset.viewMode;
    if (!["list", "full"].includes(viewMode) || viewMode === this._viewMode) return;
    this._viewMode = viewMode;
    await game.settings.set(MODULE_ID, "containerViewMode", viewMode);
    this.render();
  }

  _toggleItemDetails(event, target = event.currentTarget) {
    event.preventDefault();
    if (this._viewMode !== "list") return;
    const button = target;
    const card = button.closest(".km-shop-card");
    if (!card) return;
    const expanded = !card.classList.contains("is-details-open");
    for (const openCard of card.closest(".km-shop-inventory")?.querySelectorAll(".km-shop-card.is-details-open") || []) {
      if (openCard !== card) this._setDetailsState(openCard, false);
    }
    this._setDetailsState(card, expanded);
  }

  _setDetailsState(card, expanded) {
    card.classList.toggle("is-details-open", expanded);
    const button = card.querySelector(".km-container-details-button");
    if (!button) return;
    button.setAttribute("aria-expanded", String(expanded));
    const label = button.querySelector("span");
    if (label) label.textContent = localize(expanded ? "KM.Shop.CloseDetails" : "KM.Shop.Details");
    const icon = button.querySelector("i");
    if (icon) icon.className = `fas ${expanded ? "fa-compress" : "fa-book-open"}`;
  }

  _openImage(event, target = event.currentTarget) {
    event.preventDefault();
    const src = target.dataset.imageSrc;
    if (!src) return;
    openImagePopout(src, {
      title: target.dataset.imageTitle || localize("KM.Shop.ItemImage")
    });
  }

  async _onDepositDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove("is-dragover");
    try {
      const dragData = TextEditor.getDragEventData(event.originalEvent ?? event);
      let request = null;
      let sourceToken = this.buyerToken;
      if (dragData.type === "KhuzoeCurrency") {
        const currency = currencyById(dragData.currencyId, { includeInactive: false });
        const maximum = normalizedAmount(dragData.amount, currency?.precision);
        const draggedActorId = String(dragData.sourceActorId || "");
        if (!currency || !(maximum > 0)) return notifyError("KM.GroundLoot.Errors.InvalidCurrency");
        if (draggedActorId && draggedActorId !== String(this.buyerToken.actor?.id || "")) {
          if (!game.user?.isGM) return notifyError("KM.Container.Errors.InvalidRecipient");
          sourceToken = null;
        }
        const amount = await promptQuantity({
          itemName: currency.name || currency.symbol || currency.id,
          maximum,
          precision: currency.precision,
          mode: "deposit"
        });
        if (amount === null) return;
        request = {
          kind: "currency",
          currencyId: currency.id,
          amount,
          sourceActorId: dragData.sourceActorId,
          sourceSceneId: dragData.sourceSceneId,
          sourceTokenId: dragData.sourceTokenId
        };
      } else if (dragData.type === "Item") {
        const item = await CONFIG.Item.documentClass.fromDropData(dragData);
        if (!item || item.documentName !== "Item") return notifyError("KM.Errors.DropItemOnly");
        const itemSourceActor = item.parent?.documentName === "Actor" ? item.parent : null;
        if (itemSourceActor?.uuid && itemSourceActor.uuid !== this.buyerToken.actor?.uuid) {
          if (!game.user?.isGM) return notifyError("KM.Container.Errors.InvalidRecipient");
          sourceToken = null;
        }
        const quantity = await promptQuantity({
          itemName: item.name || "Oggetto",
          maximum: itemQuantity(item),
          precision: 0,
          mode: "deposit"
        });
        if (quantity === null) return;
        request = { kind: "item", item, quantity };
      } else {
        return notifyError("KM.Errors.DropItemOnly");
      }

      const result = await requestContainerDeposit({
        containerToken: this.containerToken,
        sourceToken,
        ...request
      });
      if (!result.ok) return notifyError(result.errorKey || "KM.Container.Errors.DepositFailed", result.errorData || {});
      ui.notifications.info(localize("KM.Container.Deposited", {
        quantity: result.quantity,
        item: result.itemName,
        actor: result.actorName,
        container: getContainer(this.containerToken)?.name || ""
      }));
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Impossibile depositare dal pannello del contenitore`, error);
      notifyError("KM.Container.Errors.DepositFailed");
    }
  }

  async _takeKey(event, target = event.currentTarget) {
    event.preventDefault();
    if (target.disabled) return;
    const result = await requestContainerKey({
      containerToken: this.containerToken,
      buyerToken: this.buyerToken,
      mode: "remove"
    });
    if (!result.ok) return notifyError(result.errorKey || "KM.Container.Errors.KeyTransferFailed", result.errorData || {});
    refreshActorInventory(this.buyerToken.actor);
    ui.notifications.info(localize("KM.Container.KeyRemoved", {
      key: result.keyName,
      actor: result.actorName
    }));
    await this.close();
  }

  async _takeItem(event, target = event.currentTarget) {
    event.preventDefault();
    const button = target;
    const card = button.closest(".km-shop-card");
    if (!card || button.disabled) return;
    const quantity = await promptQuantity({
      itemName: card.dataset.itemName || "Oggetto",
      maximum: Number(card.dataset.quantity) || 1,
      precision: 0,
      mode: "take"
    });
    if (quantity === null) return;
    await this._performTake(button, {
      kind: "item",
      entryId: card.dataset.itemId,
      quantity
    });
  }

  async _takeCurrency(event, target = event.currentTarget) {
    event.preventDefault();
    const button = target;
    if (button.disabled) return;
    const amount = await promptQuantity({
      itemName: button.dataset.currencyName || button.dataset.currencyId,
      maximum: Number(button.dataset.amount),
      precision: Number(button.dataset.precision) || 0,
      mode: "take"
    });
    if (amount === null) return;
    await this._performTake(button, {
      kind: "currency",
      currencyId: button.dataset.currencyId,
      amount
    });
  }

  async _takeAll(event, target = event.currentTarget) {
    event.preventDefault();
    if (target.disabled) return;
    await this._performTake(target, { mode: "all" });
  }

  async _performTake(button, request) {
    const shell = button.closest(".km-container-shell");
    shell?.classList.add("is-transferring");
    const result = await requestContainerTake({
      containerToken: this.containerToken,
      buyerToken: this.buyerToken,
      ...request
    });
    shell?.classList.remove("is-transferring");
    if (!result.ok) {
      notifyError(result.errorKey || "KM.Container.Errors.TransferFailed", result.errorData || {});
      this.render();
      return;
    }

    const itemCount = (result.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0);
    const currencyCount = (result.currency || []).length;
    ui.notifications.info(localize("KM.Container.Taken", {
      actor: result.actorName || this.buyerToken.actor?.name || "",
      items: itemCount,
      currencies: currencyCount
    }));
    if (result.deleted) await this.close();
    else this.render();
  }

  async close(options = {}) {
    openContainers.delete(this);
    return super.close(options);
  }

  static refreshForDocument(document) {
    for (const app of openContainers) {
      const containerDocument = app.containerToken?.document || app.containerToken;
      if (document.documentName === "Token") {
        const sameScene = document.parent?.id === containerDocument?.parent?.id;
        if (sameScene && [containerDocument?.id, app.buyerToken?.id].includes(document.id)) {
          const current = getContainer(containerDocument);
          if (containerIsLocked(current) && !game.user?.isGM) app.close();
          else app.render();
        }
      } else if (document.documentName === "Actor" && document.id === app.buyerToken?.actor?.id) {
        app.render();
      } else if (document.documentName === "Item") {
        const hasSource = getContainer(containerDocument)?.inventory?.some((entry) => entry.sourceUuid === document.uuid);
        if (hasSource) app.render();
      }
    }
  }

  static closeForToken(document) {
    for (const app of [...openContainers]) {
      const containerDocument = app.containerToken?.document || app.containerToken;
      const sameScene = document.parent?.id === containerDocument?.parent?.id;
      if (sameScene && [containerDocument?.id, app.buyerToken?.id].includes(document.id)) app.close();
    }
  }
}
