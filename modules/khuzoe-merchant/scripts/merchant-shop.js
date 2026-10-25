import { MAX_PURCHASE_QUANTITY, MODULE_ID, TEMPLATES } from "./constants.js";
import { formatPrice, getBalanceLabel, planDeduction } from "./currency-v2.js";
import { isWithinDistance, selectBuyerToken, tokenDistance } from "./distance.js";
import { requestPurchase } from "./socket.js";
import { bindElements, HandlebarsApplicationV2, openImagePopout } from "./foundry-compat.js";
import { canonicalActor, clampInteger, getMerchant, itemDescription, localize, notifyError, primaryGM, refreshMerchantEntries } from "./utils.js";

const openShops = new Set();

function formatDistance(value) {
  return new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: 1 }).format(value);
}

function maximumAffordableQuantity(actor, entry, maximum) {
  let low = 0;
  let high = Math.max(0, Math.floor(Number(maximum) || 0));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (planDeduction(actor, entry, middle).sufficient) low = middle;
    else high = middle - 1;
  }
  return low;
}

export class MerchantShop extends HandlebarsApplicationV2 {
  constructor(merchantToken, buyerToken, options = {}) {
    const sceneId = merchantToken?.document?.parent?.id ?? "scene";
    const dynamicId = `khuzoe-merchant-shop-${sceneId}-${merchantToken?.id}-${buyerToken?.id}`;
    super({ ...options, id: dynamicId });
    this.merchantToken = merchantToken;
    this.buyerToken = buyerToken;
    this._query = "";
    this._viewMode = game.settings.get(MODULE_ID, "shopViewMode") === "full" ? "full" : "list";
    this._sortMode = "name";
    this._availabilityFilter = "all";
    openShops.add(this);
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-merchant-shop",
    classes: ["khuzoe-merchant", "khuzoe-merchant-shop", "km-application-v14"],
    position: { width: 900, height: 740 },
    window: { icon: "fa-solid fa-store", resizable: true },
    actions: {
      viewMode: MerchantShop._onViewModeAction,
      toggleDetails: MerchantShop._onToggleDetailsAction,
      openImage: MerchantShop._onOpenImageAction,
      purchase: MerchantShop._onPurchaseAction,
      quantityStep: MerchantShop._onQuantityStepAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.shop }
  };

  static _onViewModeAction(event, target) { return this._changeViewMode(event, target); }
  static _onToggleDetailsAction(event, target) { return this._toggleItemDetails(event, target); }
  static _onOpenImageAction(event, target) { return this._openItemImage(event, target); }
  static _onPurchaseAction(event, target) { return this._purchase(event, target); }
  static _onQuantityStepAction(event, target) { return this._stepQuantity(event, target); }

  get title() {
    return localize("KM.Shop.Title", { name: this.merchantToken.actor?.name ?? "" });
  }

  static async openForToken(merchantToken) {
    const merchant = getMerchant(merchantToken?.actor);
    if (!merchant.enabled) return false;
    if (!primaryGM()) return notifyError("KM.Errors.NoGM");

    const buyerToken = selectBuyerToken(merchantToken);
    if (!buyerToken) return notifyError("KM.Errors.NoBuyerToken");
    if (!isWithinDistance(buyerToken, merchantToken, merchant.distance)) {
      const unit = merchantToken.document.parent.grid.units || "";
      return notifyError("KM.Errors.OutOfRange", { distance: merchant.distance, unit });
    }

    const existing = [...openShops].find((app) => {
      return app.merchantToken?.id === merchantToken.id
        && app.merchantToken?.document?.parent?.id === merchantToken.document.parent.id
        && app.buyerToken?.id === buyerToken.id;
    });
    if (existing) {
      existing.render();
      existing.bringToFront();
      return existing;
    }

    const shop = new MerchantShop(merchantToken, buyerToken);
    shop.render({ force: true });
    return shop;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const merchantActor = canonicalActor(this.merchantToken.actor);
    const buyerActor = this.buyerToken.actor;
    const merchant = getMerchant(merchantActor);
    const scene = this.merchantToken.document.parent;
    const distance = tokenDistance(this.buyerToken, this.merchantToken, scene);
    const inRange = distance <= merchant.distance + 1e-6;

    const synchronizedInventory = await refreshMerchantEntries(merchant.inventory);
    const inventory = synchronizedInventory.map((entry) => {
      const stock = entry.stock === null || entry.stock === undefined ? null : Math.max(0, Number(entry.stock) || 0);
      const soldOut = stock !== null && stock < 1;
      const stockMaximum = stock === null
        ? MAX_PURCHASE_QUANTITY
        : Math.min(MAX_PURCHASE_QUANTITY, stock);
      const affordableMaximum = maximumAffordableQuantity(buyerActor, entry, stockMaximum);
      const canAfford = affordableMaximum > 0;
      const buttonLabel = soldOut
        ? localize("KM.Shop.SoldOut")
        : !canAfford
          ? localize("KM.Shop.InsufficientFundsShort")
          : !inRange
            ? localize("KM.Shop.OutOfRangeShort")
            : localize("KM.Shop.Buy");
      const buttonIcon = soldOut
        ? "fa-ban"
        : !canAfford
          ? "fa-wallet"
          : !inRange
            ? "fa-person-walking-arrow-right"
            : "fa-bag-shopping";
      return {
        id: entry.id,
        name: entry.name,
        img: entry.img || "icons/svg/item-bag.svg",
        type: entry.type,
        description: itemDescription(entry),
        priceLabel: formatPrice(entry),
        priceSort: Math.max(0, Number(entry.price?.value ?? entry.cost?.components?.[0]?.amount) || 0),
        stock,
        stockSort: stock === null ? 999999999 : stock,
        unlimited: stock === null,
        soldOut,
        canAfford,
        disabled: soldOut || !inRange || !canAfford,
        maxQuantity: Math.max(1, affordableMaximum),
        buttonLabel,
        buttonIcon
      };
    });

    return {
      ...context,
      merchant: {
        name: merchantActor.name,
        img: merchantActor.img || this.merchantToken.document.texture.src,
        subtitle: merchant.subtitle || localize("KM.Shop.DefaultSubtitle")
      },
      buyer: {
        name: buyerActor.name,
        img: buyerActor.img,
        balance: getBalanceLabel(buyerActor)
      },
      inventory,
      inventoryCount: inventory.length,
      empty: inventory.length === 0,
      inRange,
      distance: formatDistance(distance),
      maxDistance: formatDistance(merchant.distance),
      unit: scene.grid.units || "",
      query: this._query,
      sortMode: this._sortMode,
      sortName: this._sortMode === "name",
      sortPrice: this._sortMode === "price",
      sortStock: this._sortMode === "stock",
      availabilityFilter: this._availabilityFilter,
      filterAll: this._availabilityFilter === "all",
      filterAffordable: this._availabilityFilter === "affordable",
      filterAvailable: this._availabilityFilter === "available",
      viewMode: this._viewMode,
      listMode: this._viewMode === "list",
      fullMode: this._viewMode === "full"
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    bindElements(root, ".km-shop-search", "input", (event) => {
      this._query = String(event.currentTarget.value ?? "").trim().toLowerCase();
      this._applyFilters();
    });
    bindElements(root, ".km-shop-sort", "change", (event) => {
      this._sortMode = String(event.currentTarget.value || "name");
      this._applyFilters();
    });
    bindElements(root, ".km-shop-filter", "change", (event) => {
      this._availabilityFilter = String(event.currentTarget.value || "all");
      this._applyFilters();
    });
    bindElements(root, ".km-quantity", ["change", "input"], (event) => this._updateCardTotal(event));
    this._applyFilters();
  }

  _applyFilters() {
    const inventory = this.element?.querySelector(".km-shop-inventory");
    if (!inventory) return;
    const cards = [...inventory.querySelectorAll(".km-shop-card")];
    const compare = {
      name: (left, right) => String(left.dataset.name || "").localeCompare(String(right.dataset.name || ""), game.i18n.lang),
      price: (left, right) => Number(left.dataset.price || 0) - Number(right.dataset.price || 0),
      stock: (left, right) => Number(right.dataset.stock || 0) - Number(left.dataset.stock || 0)
    }[this._sortMode] || (() => 0);
    cards.sort(compare).forEach((card) => inventory.append(card));
    let visible = 0;
    for (const card of cards) {
      const matchesQuery = !this._query || String(card.dataset.search || "").toLowerCase().includes(this._query);
      const matchesAvailability = this._availabilityFilter === "all"
        || (this._availabilityFilter === "affordable" && card.dataset.affordable === "true")
        || (this._availabilityFilter === "available" && card.dataset.soldOut !== "true");
      card.hidden = !(matchesQuery && matchesAvailability);
      if (!card.hidden) visible += 1;
    }
    const empty = this.element.querySelector(".km-shop-search-empty");
    if (empty) empty.hidden = visible > 0 || cards.length === 0;
  }

  async _changeViewMode(event, target = event.currentTarget) {
    event.preventDefault();
    const viewMode = target.dataset.viewMode;
    if (!["list", "full"].includes(viewMode) || viewMode === this._viewMode) return;
    this._viewMode = viewMode;
    await game.settings.set(MODULE_ID, "shopViewMode", viewMode);
    this.render();
  }

  _toggleItemDetails(event, target = event.currentTarget) {
    event.preventDefault();
    if (this._viewMode !== "list") return;
    const button = target;
    const card = button.closest(".km-shop-card");
    if (!card) return;

    const expanded = !card.classList.contains("is-details-open");
    const inventory = card.closest(".km-shop-inventory");
    for (const openCard of inventory?.querySelectorAll(".km-shop-card.is-details-open") ?? []) {
      if (openCard === card) continue;
      openCard.classList.remove("is-details-open");
      const openButton = openCard.querySelector(".km-item-details-button");
      if (openButton) this._updateDetailsButton(openButton, false);
    }

    card.classList.toggle("is-details-open", expanded);
    this._updateDetailsButton(button, expanded);
  }

  _updateDetailsButton(button, expanded) {
    button.setAttribute("aria-expanded", String(expanded));
    button.title = expanded ? button.dataset.closeHint : button.dataset.openHint;
    const label = button.querySelector(".km-details-label");
    if (label) label.textContent = expanded ? button.dataset.closeLabel : button.dataset.openLabel;
    const icon = button.querySelector(".km-details-icon");
    if (icon) icon.className = `fas ${expanded ? "fa-compress" : "fa-book-open"} km-details-icon`;
  }

  _openItemImage(event, target = event.currentTarget) {
    event.preventDefault();
    const src = target.dataset.imageSrc;
    if (!src) return;
    openImagePopout(src, {
      title: target.dataset.imageTitle || localize("KM.Shop.ItemImage")
    });
  }

  _stepQuantity(event, target = event.currentTarget) {
    event.preventDefault();
    const input = target.closest(".km-quantity-stepper")?.querySelector(".km-quantity");
    if (!input) return;
    const direction = Number(target.dataset.step || 0);
    const minimum = Number(input.min) || 1;
    const maximum = Number(input.max) || MAX_PURCHASE_QUANTITY;
    input.value = clampInteger(Number(input.value || minimum) + direction, minimum, maximum);
    this._updateCardTotal({ currentTarget: input });
  }

  _updateCardTotal(event) {
    const card = event.currentTarget.closest(".km-shop-card");
    const id = card?.dataset.itemId;
    const entry = getMerchant(this.merchantToken.actor).inventory.find((item) => item.id === id);
    if (!entry) return;
    const maximum = Number(event.currentTarget.max) || MAX_PURCHASE_QUANTITY;
    const quantity = clampInteger(event.currentTarget.value, 1, maximum);
    event.currentTarget.value = quantity;
    const total = card.querySelector(".km-card-total");
    if (total) total.textContent = formatPrice(entry, quantity);

    const deduction = planDeduction(this.buyerToken.actor, entry, quantity);
    const inRange = isWithinDistance(this.buyerToken, this.merchantToken, getMerchant(this.merchantToken.actor).distance);
    const soldOut = entry.stock !== null && entry.stock !== undefined && Number(entry.stock) < quantity;
    const button = card.querySelector(".km-buy-button");
    if (!button) return;
    button.disabled = soldOut || !inRange || !deduction.sufficient;
    card.classList.toggle("is-unaffordable", !deduction.sufficient);
    const label = button.querySelector(".km-buy-label");
    const icon = button.querySelector(".km-buy-icon");
    if (!deduction.sufficient) {
      if (label) label.textContent = button.dataset.fundsLabel;
      if (icon) icon.className = "fas fa-wallet km-buy-icon";
    } else if (!inRange) {
      if (label) label.textContent = button.dataset.rangeLabel;
      if (icon) icon.className = "fas fa-person-walking-arrow-right km-buy-icon";
    } else {
      if (label) label.textContent = button.dataset.buyLabel;
      if (icon) icon.className = "fas fa-bag-shopping km-buy-icon";
    }
  }

  async _purchase(event, target = event.currentTarget) {
    event.preventDefault();
    const button = target;
    const card = button.closest(".km-shop-card");
    const itemId = card?.dataset.itemId;
    const quantityInput = card?.querySelector(".km-quantity");
    const maximum = Number(quantityInput?.max) || MAX_PURCHASE_QUANTITY;
    const quantity = clampInteger(quantityInput?.value, 1, maximum);
    if (!itemId || button.disabled) return;

    card.classList.add("is-purchasing");
    button.disabled = true;
    const result = await requestPurchase({
      merchantToken: this.merchantToken,
      buyerToken: this.buyerToken,
      itemId,
      quantity
    });

    if (result.ok) {
      ui.notifications.info(localize("KM.Shop.PurchaseSuccess", {
        quantity: result.quantity,
        item: result.itemName,
        price: result.totalLabel
      }));
      this.render();
      return;
    }

    card.classList.remove("is-purchasing");
    notifyError(result.errorKey || "KM.Errors.Transaction", result.errorData ?? {});
    this.render();
  }

  async close(options = {}) {
    openShops.delete(this);
    return super.close(options);
  }

  static refreshForDocument(document) {
    for (const shop of openShops) {
      if (document.documentName === "Item") {
        const hasSource = getMerchant(shop.merchantToken.actor).inventory
          .some((entry) => entry.sourceUuid === document.uuid);
        if (hasSource) shop.render();
        continue;
      }
      const actorIds = [canonicalActor(shop.merchantToken.actor)?.id, shop.buyerToken.actor?.id];
      if (document.documentName === "Actor" && actorIds.includes(document.id)) {
        shop.render();
        continue;
      }
      if (document.documentName === "Token") {
        const sameScene = document.parent?.id === shop.merchantToken.document?.parent?.id;
        const tokenIds = [shop.merchantToken.document?.id, shop.buyerToken.document?.id];
        if (sameScene && tokenIds.includes(document.id)) shop.render();
      }
    }
  }

  static closeForToken(document) {
    for (const shop of [...openShops]) {
      const sameScene = document.parent?.id === shop.merchantToken.document?.parent?.id;
      if (sameScene && [shop.merchantToken.document?.id, shop.buyerToken.document?.id].includes(document.id)) shop.close();
    }
  }
}
