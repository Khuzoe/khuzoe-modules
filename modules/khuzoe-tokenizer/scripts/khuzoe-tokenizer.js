import { parseDecimal, parseVariantScale, variantTexture } from "./variant-scale.js";
import {
  HandlebarsApplicationV2,
  applicationRoot,
  bringApplicationToFront,
  filePickerClass,
  findOpenApplication,
  openApplications,
  openFilePicker,
  openImagePopout,
  renderApplication
} from "./foundry-compat.js";

(() => {
  "use strict";

  const MODULE_ID = "khuzoe-tokenizer";
  const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/tokenizer.hbs`;
  const TOKEN_VARIANT_SELECTOR_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/token-variant-selector.hbs`;
  const TOKEN_VARIANT_MANAGER_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/token-variant-manager.hbs`;
  const DATA_SOURCE = "data";
  const SOCKET_NAME = `module.${MODULE_ID}`;
  const DIRECTORY_REQUEST_TIMEOUT_MS = 60000;
  const SUPPORTED_DND5E_TYPES = new Set(["character", "npc", "vehicle"]);
  const TARGETS = ["avatar", "token"];
  const LEGACY_TOKEN_SWITCHER_SOURCE = "khuzoe-token-switcher";
  const MERCHANT_MODULE_ID = "khuzoe-merchant";
  const pendingDirectoryRequests = new Map();
  const pendingActorDirectoryEnsures = new Map();
  let pendingFrameDirectoryEnsure = null;
  let lastCanvasPointerPosition = null;
  let activeAvatarPreview = null;

  async function emitTokenizerSaved(actor, options = {}) {
    if (!actor) return;
    const changedTargets = Array.from(new Set(
      (Array.isArray(options.changedTargets) ? options.changedTargets : [])
        .map((target) => String(target || "").trim())
        .filter((target) => TARGETS.includes(target))
    ));
    const reason = String(options.reason || "save");
    const variantsChanged = Boolean(options.variantsChanged) || reason.startsWith("variant-");
    const removedVariantIds = Array.from(new Set(
      (Array.isArray(options.removedVariantIds) ? options.removedVariantIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    ));
    const savedAt = new Date().toISOString();
    const variants = getActorTokenVariants(actor).map(cleanTokenVariant);
    const payload = {
      schemaVersion: 1,
      reason,
      changedTargets,
      variantsChanged,
      removedVariantIds,
      base: {
        avatar: { src: stripCacheBust(actor.img || "") },
        token: { src: getActorTokenPath(actor) || "" }
      },
      variants,
      savedAt
    };
    await actor.setFlag(MODULE_ID, "syncEvent", {
      schemaVersion: 1,
      eventId: foundry.utils.randomID(24),
      reason,
      changedTargets,
      variantsChanged,
      removedVariantIds,
      savedAt
    });
    Hooks.callAll(`${MODULE_ID}.saved`, actor, payload);
    if (variantsChanged) Hooks.callAll(`${MODULE_ID}.variantsChanged`, actor, payload);
  }
  const TOKEN_VARIANT_MIN_SIZE = 0.5;
  const TOKEN_VARIANT_MAX_SIZE = 12;
  const DEFAULT_FRAME = {
    enabled: false,
    name: "",
    src: "",
    clipMode: "outer",
    image: null,
    geometry: null,
    loading: false
  };


  class KhuzoeTokenVariantSelectorApp extends HandlebarsApplicationV2 {
    constructor(tokenDocument, options = {}) {
      super({ ...options, id: getTokenVariantSelectorId(tokenDocument) });
      this.tokenDocument = tokenDocument;
      this.actor = tokenDocument?.actor;
    }

    static DEFAULT_OPTIONS = {
      classes: [MODULE_ID, "ktz-token-variant-selector-window", "ktz-application-v14"],
      position: { width: 460, height: "auto" },
      window: { icon: "fa-solid fa-images", resizable: true }
    };

    static PARTS = {
      main: { template: TOKEN_VARIANT_SELECTOR_TEMPLATE_PATH }
    };

    get title() {
      return game.i18n.format(`${MODULE_ID}.app.variantSelectorTitle`, { name: this.actor?.name || "" });
    }

    async _prepareContext(options = {}) {
      const context = await super._prepareContext(options);
      const activeVariant = this.tokenDocument?.getFlag(MODULE_ID, "activeTokenVariant") || "base";
      const baseVisual = this.tokenDocument
        ? (this.tokenDocument.getFlag(MODULE_ID, "tokenVariantBase") || captureTokenVisualState(this.tokenDocument))
        : null;
      const baseTexture = baseVisual?.texture || {};
      const choices = [{
        id: "base",
        name: game.i18n.localize(`${MODULE_ID}.labels.baseToken`),
        src: baseTexture.src || getActorTokenPath(this.actor),
        width: baseVisual?.width || getActorTokenWidth(this.actor),
        height: baseVisual?.height || getActorTokenHeight(this.actor),
        active: activeVariant === "base",
        base: true
      }];

      for (const variant of getActorTokenVariants(this.actor)) {
        choices.push(Object.assign({}, variant, {
          active: activeVariant === variant.id,
          base: false
        }));
      }

      return {
        ...context,
        actor: this.actor,
        choices
      };
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      const root = this.element;
      if (!root) return;

      root.querySelectorAll("[data-variant-id]").forEach((button) => {
        button.addEventListener("click", (event) => this._onChooseVariant(event));
      });
    }

    async _onChooseVariant(event) {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const variantId = button.dataset.variantId;
      if (!variantId || !this.tokenDocument) return;

      this.element?.querySelectorAll("button").forEach((candidate) => {
        candidate.disabled = true;
      });

      if (variantId === "base") {
        await restoreTokenVariantBase(this.tokenDocument);
      } else {
        const variant = getActorTokenVariants(this.actor).find((candidate) => candidate.id === variantId);
        if (variant) await applyTokenVariant(this.tokenDocument, variant);
      }

      this.close();
    }
  }

  class KhuzoeTokenVariantManagerApp extends HandlebarsApplicationV2 {
    constructor(actor, options = {}) {
      super({ ...options, id: `${MODULE_ID}-variant-manager-${actor?.id || "actor"}` });
      this.actor = actor;
      this._busy = false;
    }

    static DEFAULT_OPTIONS = {
      classes: [MODULE_ID, "ktz-token-variant-manager-window", "ktz-application-v14"],
      position: { width: 660, height: "auto" },
      window: { icon: "fa-solid fa-images", resizable: true }
    };

    static PARTS = {
      main: { template: TOKEN_VARIANT_MANAGER_TEMPLATE_PATH }
    };

    get title() {
      return game.i18n.format(`${MODULE_ID}.app.variantManagerTitle`, { name: this.actor?.name || "" });
    }

    async _prepareContext(options = {}) {
      const context = await super._prepareContext(options);
      const variants = getActorTokenVariants(this.actor).map((variant) => ({
        ...variant,
        size: variant.width,
        managed: !isEditableTokenVariant(variant)
      }));
      return {
        ...context,
        actor: this.actor,
        baseToken: {
          name: game.i18n.localize(`${MODULE_ID}.labels.baseToken`),
          src: getActorTokenPath(this.actor),
          width: getActorTokenWidth(this.actor),
          height: getActorTokenHeight(this.actor)
        },
        variants
      };
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      const root = this.element;
      if (!root) return;

      root.querySelector('[data-action="variant-manager-choose"]')?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._chooseImage();
      });

      root.querySelectorAll('[data-action="variant-manager-delete"]').forEach((button) => {
        button.addEventListener("click", (event) => this._deleteVariant(event));
      });

      root.querySelectorAll('[data-action="variant-avatar-choose"], [data-action="variant-avatar-remove"]').forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (this._busy) return;
          if (button.dataset.action === "variant-avatar-remove") this._saveAvatar(button.dataset.variantId, "");
          else chooseVariantAvatar(this.actor, button.dataset.variantId, (path) => this._saveAvatar(button.dataset.variantId, path));
        });
      });

      root.querySelectorAll("[data-variant-manager-field]").forEach((input) => {
        input.addEventListener("change", (event) => this._updateVariant(event));
      });

      const dropzone = root.querySelector("[data-variant-manager-dropzone]");
      if (!dropzone) return;
      for (const eventName of ["dragenter", "dragover"]) {
        dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          event.stopPropagation();
          dropzone.classList.add("is-dragging");
        });
      }
      dropzone.addEventListener("dragleave", (event) => {
        if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove("is-dragging");
      });
      dropzone.addEventListener("drop", (event) => this._onDrop(event));
    }

    async _saveAvatar(variantId, path) {
      if (this._busy) return;
      this._setBusy(true);
      try {
        await saveActorVariantAvatar(this.actor, variantId, path);
        this.render();
      } catch (error) {
        console.error(`${MODULE_ID} | Variant avatar save failed`, error);
        ui.notifications.error(getUserFacingErrorMessage(error, `${MODULE_ID}.notifications.variantSaveFailed`));
      } finally {
        this._setBusy(false);
      }
    }

    _chooseImage() {
      if (this._busy) return;
      openFilePicker({
        type: "image",
        current: stripCacheBust(getActorTokenPath(this.actor)) || "",
        callback: (path) => this._addSource(path, fileNameFromPath(path))
      });
    }

    async _onDrop(event) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove("is-dragging");
      if (this._busy) return;

      const files = getImageFiles(event.dataTransfer);
      if (files.length) {
        for (const file of files) {
          const dataUrl = await readFileAsDataUrl(file);
          await this._addSource(dataUrl, file.name);
        }
        return;
      }

      const path = getDroppedPath(event.dataTransfer);
      if (path && isImagePath(path)) {
        await this._addSource(path, fileNameFromPath(path));
        return;
      }

      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noImageDrop`));
    }

    async _addSource(src, sourceName) {
      if (!src || this._busy) return;
      this._setBusy(true);
      try {
        const variantId = generateVariantId();
        const storedPath = await uploadTokenVariantSource(this.actor, src, sourceName, variantId);
        const outputPath = stripCacheBust(storedPath);
        const name = fileNameWithoutExtension(sourceName || outputPath) || this.actor.name || "Token";
        const now = new Date().toISOString();
        const variant = createTokenVariant({
          id: variantId,
          name,
          src: outputPath,
          width: 1,
          height: 1,
          createdAt: now,
          updatedAt: now
        });
        const variants = getActorTokenVariants(this.actor);
        variants.push(variant);
        await this.actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
        await emitTokenizerSaved(this.actor, {
          reason: "variant-added",
          variantsChanged: true
        });
        refreshOpenTokenVariantViews(this.actor, this);
        ui.notifications.info(game.i18n.format(`${MODULE_ID}.notifications.variantSaved`, { name: variant.name }));
        this.render();
      } catch (error) {
        console.error(`${MODULE_ID} | Token variant quick add failed`, error);
        ui.notifications.error(getUserFacingErrorMessage(error, `${MODULE_ID}.notifications.variantSaveFailed`));
      } finally {
        this._setBusy(false);
      }
    }

    async _deleteVariant(event) {
      event.preventDefault();
      event.stopPropagation();
      const variantId = event.currentTarget.dataset.variantId;
      if (!variantId || this._busy) return;

      const currentVariant = getActorTokenVariants(this.actor).find((variant) => variant.id === variantId);
      if (!isEditableTokenVariant(currentVariant)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.managedVariant`));
        return;
      }
      const variants = getActorTokenVariants(this.actor).filter((variant) => variant.id !== variantId);
      await this.actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
      await restorePlacedTokensUsingVariant(this.actor, variantId);
      await emitTokenizerSaved(this.actor, {
        reason: "variant-removed",
        variantsChanged: true,
        removedVariantIds: [variantId]
      });
      refreshOpenTokenVariantViews(this.actor, this);
      this.render();
    }

    async _updateVariant(event) {
      const input = event.currentTarget;
      const variantId = input.dataset.variantId;
      const field = input.dataset.variantManagerField;
      if (!variantId || !field || this._busy) return;

      const variants = getActorTokenVariants(this.actor);
      const index = variants.findIndex((variant) => variant.id === variantId);
      if (index < 0) return;
      if (!isEditableTokenVariant(variants[index])) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.managedVariant`));
        this.render();
        return;
      }

      if (field === "name") {
        variants[index].name = String(input.value || variants[index].name || "Token").trim() || "Token";
        input.value = variants[index].name;
      }
      if (field === "size") {
        const entered = parseDecimal(input.value);
        if (!Number.isFinite(entered) || entered < TOKEN_VARIANT_MIN_SIZE || entered > TOKEN_VARIANT_MAX_SIZE) {
          ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.invalidVariantSize`));
          input.value = String(variants[index].width);
          return;
        }
        const size = normalizeTokenVariantSize(input.value);
        variants[index].width = size;
        variants[index].height = size;
        input.value = String(size);
      }
      if (field === "scale") {
        const scale = parseVariantScale(input.value);
        if (Number.isNaN(scale)) {
          ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.invalidVariantScale`));
          input.value = variants[index].scale == null ? "" : String(variants[index].scale);
          return;
        }
        variants[index].scale = scale;
      }
      variants[index].source = "manual";
      variants[index].updatedAt = new Date().toISOString();
      this._setBusy(true);
      try {
        await this.actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
        if (field === "size" || field === "scale") await updatePlacedTokensUsingVariant(this.actor, variants[index]);
        await emitTokenizerSaved(this.actor, {
          reason: "variant-metadata-updated",
          variantsChanged: true
        });
        refreshOpenTokenVariantViews(this.actor, this);
      } catch (error) {
        console.error(`${MODULE_ID} | Variant metadata save failed`, error);
        ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.variantSaveFailed`));
      } finally {
        this._setBusy(false);
        this.render();
      }
    }

    _setBusy(busy) {
      this._busy = Boolean(busy);
      const root = getRoot(this.element);
      root?.classList.toggle("is-saving", this._busy);
      root?.querySelectorAll("button, input").forEach((element) => {
        element.disabled = this._busy;
      });
    }
  }
  class KhuzoeTokenizerApp extends HandlebarsApplicationV2 {
    constructor(actor, options = {}) {
      super({ ...options, id: `${MODULE_ID}-${actor?.id || "actor"}` });
      this.actor = actor;
      this.editorState = {
        avatar: this._createTargetState("avatar"),
        token: this._createTargetState("token")
      };
      this._canvases = {};
      this._dropzones = {};
      this._selectedTarget = "avatar";
      this._editingTokenVariantId = "base";
      this._baseTokenStateSnapshot = null;
      this._saving = false;
      this._loadedInitialImages = false;
      this._boundPaste = this._onPaste.bind(this);
      this._eventDocument = null;
    }

    static DEFAULT_OPTIONS = {
      classes: [MODULE_ID, "khuzoe-tokenizer-window", "ktz-application-v14"],
      position: { width: 960, height: "auto" },
      window: { icon: "fa-solid fa-crop-simple", resizable: true }
    };

    static PARTS = {
      main: { template: TEMPLATE_PATH }
    };

    get title() {
      return `${game.i18n.localize(`${MODULE_ID}.app.title`)}: ${this.actor.name}`;
    }

    async _prepareContext(options = {}) {
      const context = await super._prepareContext(options);
      const tokenPath = getActorTokenPath(this.actor);
      const frame = this.editorState.token.frame;
      const frameChoices = await getFrameChoices(frame?.src || "");
      return {
        ...context,
        actor: this.actor,
        actorType: this.actor.type,
        actorImage: this.actor.img || "",
        tokenImage: tokenPath || "",
        updatePlacedTokens: game.settings.get(MODULE_ID, "updatePlacedTokens"),
        canUpdatePlacedTokens: game.user.isGM,
        frameChoices,
        frameDirectory: getFrameDirectory(),
        frameEnabled: Boolean(frame?.enabled)
      };
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      const root = this.element;
      if (!root) return;
      const content = root.querySelector(".khuzoe-tokenizer-app");
      if (!content) return;

      this._canvases = {};
      this._dropzones = {};

      for (const target of TARGETS) {
        this._canvases[target] = content.querySelector(`canvas[data-target="${target}"]`);
        this._dropzones[target] = content.querySelector(`.ktz-dropzone[data-target="${target}"]`);
      }

      content.querySelectorAll("[data-action]").forEach((element) => {
        element.addEventListener("click", (event) => this._onAction(event));
      });

      content.querySelectorAll("[data-control]").forEach((element) => {
        element.addEventListener("input", (event) => this._onControlInput(event));
      });

      content.querySelectorAll("[data-frame-control]").forEach((element) => {
        element.addEventListener("input", (event) => this._onFrameControlInput(event));
        element.addEventListener("change", (event) => this._onFrameControlInput(event));
      });

      content.querySelectorAll("[data-background-control]").forEach((element) => {
        element.addEventListener("input", (event) => this._onBackgroundControlInput(event));
        element.addEventListener("change", (event) => this._onBackgroundControlInput(event));
      });

      for (const target of TARGETS) {
        const dropzone = this._dropzones[target];
        if (!dropzone) continue;

        dropzone.addEventListener("dragenter", (event) => this._onDragEnter(event, target));
        dropzone.addEventListener("dragover", (event) => this._onDragOver(event, target));
        dropzone.addEventListener("dragleave", (event) => this._onDragLeave(event, target));
        dropzone.addEventListener("drop", (event) => this._onDrop(event, target));
        dropzone.addEventListener("wheel", (event) => this._onWheel(event, target), { passive: false });
        dropzone.addEventListener("pointerdown", (event) => this._onPointerDown(event, target));
        dropzone.addEventListener("click", () => {
          this._selectedTarget = target;
        });
      }

      this._eventDocument?.removeEventListener("paste", this._boundPaste);
      this._eventDocument = root.ownerDocument || document;
      this._eventDocument.addEventListener("paste", this._boundPaste);

      this._resizeObserver?.disconnect();
      const ResizeObserverClass = this._eventDocument.defaultView?.ResizeObserver || globalThis.ResizeObserver;
      if (ResizeObserverClass) {
        this._resizeObserver = new ResizeObserverClass(() => this._drawAll());
        for (const dropzone of Object.values(this._dropzones)) {
          if (dropzone) this._resizeObserver.observe(dropzone);
        }
      }

      this._syncAllControls();
      void this._loadInitialState();
    }

    async close(options) {
      this._eventDocument?.removeEventListener("paste", this._boundPaste);
      this._eventDocument = null;
      this._resizeObserver?.disconnect();
      return super.close(options);
    }

    _createTargetState(target) {
      const lastEdit = this.actor.getFlag(MODULE_ID, "lastEdit") || {};
      const candidate = lastEdit[target] || {};
      const storedIsCurrent = target === "token"
        ? isStoredTokenEditCurrent(this.actor, candidate)
        : isStoredAvatarEditCurrent(this.actor, candidate);
      const stored = storedIsCurrent ? candidate : {};
      return {
        target,
        image: null,
        sourceName: "",
        sourcePath: stripCacheBust(stored.sourcePath || ""),
        outputPath: stripCacheBust(stored.path || ""),
        mode: stored.mode || "fit",
        zoom: Number(stored.zoom) || 1,
        offsetX: Number(stored.offsetX) || 0,
        offsetY: Number(stored.offsetY) || 0,
        aspect: target === "token" ? 1 : Number(stored.aspect) || 0.75,
        visible: stored.visible !== false,
        dirty: false,
        loading: false,
        frame: target === "token" ? createFrameState(stored.frame) : null,
        layers: (stored.layers || []).map((layer) => createLayerState(layer, target)),
        activeLayerId: String(stored.activeLayerId || "base"),
        layerOrder: normalizeLayerOrder(stored.layerOrder, stored.layers || [], stored.visible !== false || Boolean(stored.sourcePath || stored.sourceName)),
        background: createBackgroundState(stored.background)
      };
    }

    async _loadInitialState() {
      await Promise.allSettled([
        this._loadInitialFrameImage(),
        this._loadInitialImages()
      ]);
      await this._ensureBaseTokenPreview();
    }

    async _loadInitialImages() {
      if (this._loadedInitialImages) return;
      this._loadedInitialImages = true;

      const lastEdit = this.actor.getFlag(MODULE_ID, "lastEdit") || {};
      const storedAvatarCandidate = lastEdit.avatar || {};
      const storedAvatar = isStoredAvatarEditCurrent(this.actor, storedAvatarCandidate)
        ? storedAvatarCandidate
        : {};
      const storedTokenCandidate = lastEdit.token || {};
      const storedToken = isStoredTokenEditCurrent(this.actor, storedTokenCandidate)
        ? storedTokenCandidate
        : {};
      const hasStoredAvatarLayers = Array.isArray(storedAvatar.layers) && storedAvatar.layers.length > 0;
      const hasStoredTokenLayers = Array.isArray(storedToken.layers) && storedToken.layers.length > 0;
      const avatarPath = stripCacheBust(storedAvatar.sourcePath || (!hasStoredAvatarLayers ? this.actor.img : "") || "");
      const tokenPath = storedToken.sourcePath || (!hasStoredTokenLayers ? getActorTokenPath(this.actor) : "") || "";

      await Promise.allSettled([
        avatarPath ? this._loadImagePath("avatar", avatarPath, { dirty: false, restoreTransform: true }) : null,
        tokenPath ? this._loadImagePath("token", tokenPath, { dirty: false, restoreTransform: true }) : null
      ]);

      if (hasStoredAvatarLayers) await this._loadInitialLayers("avatar", storedAvatar.layers, storedAvatar.activeLayerId || "base", storedAvatar.layerOrder || []);
      if (hasStoredTokenLayers) await this._loadInitialLayers("token", storedToken.layers, storedToken.activeLayerId || "base", storedToken.layerOrder || []);

      this._drawAll();
    }

    async _ensureBaseTokenPreview() {
      const tokenPath = getActorTokenPath(this.actor);
      if (!tokenPath || this._editingTokenVariantId !== "base") return;

      try {
        const baseImage = await loadImage(tokenPath);
        if (tokenStateMatchesBaseImage(this.editorState.token, baseImage)) return;

        this.editorState.token = this._createBlankTokenVariantState();
        await this._setImage("token", tokenPath, {
          sourceName: fileNameFromPath(tokenPath),
          sourcePath: tokenPath,
          dirty: false,
          restoreTransform: false
        });
        this.editorState.token.outputPath = tokenPath;
        this.editorState.token.dirty = false;
        this._syncAllControls();
        this._drawAll();
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to verify base token preview`, error);
      }
    }

    async _onAction(event) {
      event.preventDefault();
      event.stopPropagation();

      const button = event.currentTarget;
      const action = button.dataset.action;
      const target = button.dataset.target;

      if (action === "save") return this._save();
      if (action === "cancel") return this.close();
      if (action === "choose") return this._chooseImage(target);
      if (action === "copy") return this._copyTarget(button.dataset.from, target);
      if (action === "preset") return this._applyPreset(target, button.dataset.preset);
      if (action === "layer-add") return this._chooseLayerImages(target);
      if (action === "layer-select") return this._selectLayer(target, button.dataset.layerId);
      if (action === "layer-toggle") return this._toggleLayer(target, button.dataset.layerId);
      if (action === "layer-up") return this._moveLayer(target, button.dataset.layerId, -1);
      if (action === "layer-down") return this._moveLayer(target, button.dataset.layerId, 1);
      if (action === "layer-delete") return this._deleteLayer(target, button.dataset.layerId);
      if (action === "frame-select") return this._setFrameSource(button.dataset.src, {
        dirty: true,
        enabled: true,
        name: button.dataset.name || fileNameWithoutExtension(button.dataset.src || "")
      });
      if (action === "frame-upload") return this._uploadFrameImage();
      if (action === "variant-save") return this._saveTokenVariant();
      if (action === "variant-edit-base") return this._editTokenBase();
      if (action === "variant-edit") return this._editTokenVariant(button.dataset.variantId);
      if (action === "variant-avatar-manage") return openTokenVariantManager(this.actor);
      if (action === "variant-delete") return this._deleteTokenVariant(button.dataset.variantId);
    }

    _onControlInput(event) {
      const input = event.currentTarget;
      const target = input.dataset.target;
      const control = input.dataset.control;
      const state = this.editorState[target];
      const editable = this._getEditableState(target);
      if (!editable?.image) return;

      const value = Number(input.value);
      if (!Number.isFinite(value)) return;

      if (control === "zoom") editable.zoom = clamp(value, 0.1, 5);
      if (control === "offsetX") editable.offsetX = clamp(value, -1.5, 1.5);
      if (control === "offsetY") editable.offsetY = clamp(value, -1.5, 1.5);

      state.dirty = true;
      this._drawTarget(target);
      this._syncTargetControls(target);
      this._syncLayerControls();
    }

    _onFrameControlInput(event) {
      const input = event.currentTarget;
      const control = input.dataset.frameControl;
      const tokenState = this.editorState.token;
      const frame = tokenState.frame;
      if (!frame) return;

      if (control === "enabled") frame.enabled = input.checked;
      if (control === "clipMode") frame.clipMode = normalizeFrameClipMode(input.value);

      tokenState.dirty = hasRenderableStateImage(tokenState);
      this._drawTarget("token");
      this._syncFrameControls();
    }

    _onBackgroundControlInput(event) {
      const input = event.currentTarget;
      const target = input.dataset.target;
      const control = input.dataset.backgroundControl;
      const state = this.editorState[target];
      const background = state?.background;
      if (!state || !background) return;

      if (control === "enabled") background.enabled = input.checked;
      if (control === "color") background.color = normalizeColor(input.value, background.color);

      state.dirty = hasRenderableStateImage(state);
      this._drawTarget(target);
      this._syncBackgroundControls(target);
      this._syncEmptyState(target);
    }

    _uploadFrameImage() {
      const input = (this.element?.ownerDocument || document).createElement("input");
      input.type = "file";
      input.accept = "image/webp,image/png,image/jpeg,image/*";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (file) await this._uploadFrameFile(file);
      }, { once: true });
      input.click();
    }

    async _uploadFrameFile(file) {
      if (!isImageFile(file)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.unsupportedFile`));
        return;
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const image = await loadImage(dataUrl);
        const canvas = imageToCanvas(image);
        const blob = await canvasToWebpBlob(canvas, getWebpQuality());
        const directory = await ensureFrameDirectory();
        const hash = await hashBlob(blob);
        const fileName = `${sanitizeSegment(fileNameWithoutExtension(file.name))}-${hash}.webp`;
        const storedPath = await uploadBlob(directory, fileName, blob);
        const path = stripCacheBust(storedPath);
        await this._setFrameSource(path, {
          dirty: true,
          enabled: true,
          name: fileNameWithoutExtension(file.name)
        });
      } catch (error) {
        console.error(`${MODULE_ID} | Frame upload failed`, error);
        ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.frameUploadFailed`));
      }
    }

    async _setFrameSource(path, options = {}) {
      const tokenState = this.editorState.token;
      const frame = tokenState.frame;
      if (!frame || !path) return;

      frame.loading = true;
      this._syncFrameControls();

      try {
        const image = await loadImage(path);
        const geometry = safeAnalyzeFrameGeometry(image);
        frame.src = path;
        frame.image = image;
        frame.geometry = geometry;
        frame.enabled = options.enabled ?? frame.enabled;
        frame.name = options.name || fileNameWithoutExtension(path);
        tokenState.dirty = Boolean(options.dirty && hasRenderableStateImage(tokenState));
        this._drawTarget("token");
      } catch (error) {
        console.error(`${MODULE_ID} | Frame image load failed`, error);
        ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.frameLoadFailed`));
      } finally {
        frame.loading = false;
        this._syncFrameControls();
      }
    }

    async _loadInitialFrameImage() {
      const frame = this.editorState.token.frame;
      if (!frame?.src) return;
      await this._setFrameSource(frame.src, {
        dirty: false,
        enabled: frame.enabled,
        name: frame.name
      });
    }

    _onDragEnter(event, target) {
      event.preventDefault();
      this._selectedTarget = target;
      this._dropzones[target]?.classList.add("is-dragging");
    }

    _onDragOver(event, target) {
      event.preventDefault();
      this._selectedTarget = target;
      this._dropzones[target]?.classList.add("is-dragging");
    }

    _onDragLeave(event, target) {
      if (!this._dropzones[target]?.contains(event.relatedTarget)) {
        this._dropzones[target]?.classList.remove("is-dragging");
      }
    }

    async _onDrop(event, target) {
      event.preventDefault();
      event.stopPropagation();
      this._dropzones[target]?.classList.remove("is-dragging");
      this._selectedTarget = target;

      const files = getImageFiles(event.dataTransfer);
      if (files.length > 1) return this._addLayerFiles(target, files);

      const file = files[0];
      if (file) return this._loadImageFile(target, file);

      const path = getDroppedPath(event.dataTransfer);
      if (path) return this._loadImagePath(target, path, { dirty: true, restoreTransform: false });

      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noImageDrop`));
    }

    async _onPaste(event) {
      if (!this.rendered) return;

      const activeTarget = this._selectedTarget || "avatar";
      const file = getImageFile(event.clipboardData);
      if (!file) return;

      event.preventDefault();
      await this._loadImageFile(activeTarget, file);
    }

    _onWheel(event, target) {
      const state = this.editorState[target];
      const editable = this._getEditableState(target);
      if (!editable?.image) return;

      event.preventDefault();
      this._selectedTarget = target;

      const canvas = this._canvases[target];
      const rect = canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };

      const oldZoom = editable.zoom;
      const factor = Math.exp(-event.deltaY * 0.001);
      const newZoom = clamp(oldZoom * factor, 0.1, 5);
      if (oldZoom === newZoom) return;

      this._zoomAt(target, editable, pointer, oldZoom, newZoom, rect.width, rect.height);
      state.dirty = true;
      this._drawTarget(target);
      this._syncTargetControls(target);
      this._syncLayerControls();
    }

    _onPointerDown(event, target) {
      const state = this.editorState[target];
      const editable = this._getEditableState(target);
      if (!editable?.image || event.button !== 0) return;

      event.preventDefault();
      this._selectedTarget = target;

      const canvas = this._canvases[target];
      const rect = canvas.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        offsetX: editable.offsetX,
        offsetY: editable.offsetY
      };
      const eventWindow = event.currentTarget?.ownerDocument?.defaultView || window;

      const onMove = (moveEvent) => {
        editable.offsetX = clamp(start.offsetX + ((moveEvent.clientX - start.x) / rect.width), -1.5, 1.5);
        editable.offsetY = clamp(start.offsetY + ((moveEvent.clientY - start.y) / rect.height), -1.5, 1.5);
        state.dirty = true;
        this._drawTarget(target);
        this._syncTargetControls(target);
        this._syncLayerControls();
      };

      const onUp = () => {
        eventWindow.removeEventListener("pointermove", onMove);
        eventWindow.removeEventListener("pointerup", onUp);
        eventWindow.removeEventListener("pointercancel", onUp);
      };

      eventWindow.addEventListener("pointermove", onMove);
      eventWindow.addEventListener("pointerup", onUp, { once: true });
      eventWindow.addEventListener("pointercancel", onUp, { once: true });
    }

    _zoomAt(target, editable, pointer, oldZoom, newZoom, frameWidth, frameHeight) {
      const state = this.editorState[target];
      const oldRect = getImageRect(editable, frameWidth, frameHeight, oldZoom, state);
      const relativeX = (pointer.x - oldRect.x) / oldRect.width;
      const relativeY = (pointer.y - oldRect.y) / oldRect.height;

      editable.zoom = newZoom;
      const newRect = getImageRect(editable, frameWidth, frameHeight, newZoom, state);
      const desiredX = pointer.x - (relativeX * newRect.width);
      const desiredY = pointer.y - (relativeY * newRect.height);
      editable.offsetX = clamp((desiredX - ((frameWidth - newRect.width) / 2)) / frameWidth, -1.5, 1.5);
      editable.offsetY = clamp((desiredY - ((frameHeight - newRect.height) / 2)) / frameHeight, -1.5, 1.5);
    }

    _chooseImage(target) {
      const state = this.editorState[target];
      openFilePicker({
        type: "image",
        current: state?.sourcePath || "",
        callback: (path) => this._loadImagePath(target, path, { dirty: true, restoreTransform: false })
      });
    }

    async _copyTarget(from, target) {
      const source = this.editorState[from];
      const destination = this.editorState[target];
      if (!source || !destination || !hasRenderableStateImage(source)) return;

      if (!source.image) {
        const canvas = this._renderOutputCanvas(from);
        await this._setImage(target, canvas.toDataURL("image/png"), {
          sourceName: `${from}.png`,
          sourcePath: "",
          dirty: true,
          restoreTransform: false
        });
        return;
      }

      destination.image = source.image;
      destination.sourceName = source.sourceName;
      destination.sourcePath = source.sourcePath;
      destination.visible = true;
      destination.aspect = target === "token" ? 1 : getImageAspect(source.image);
      destination.mode = "fit";
      destination.zoom = 1;
      destination.offsetX = 0;
      destination.offsetY = 0;
      destination.layerOrder = addLayerToOrder(destination.layerOrder, "base");
      destination.activeLayerId = "base";
      destination.dirty = true;

      this._syncAspect(target);
      this._drawTarget(target);
      this._syncTargetControls(target);
      this._syncLayerControls();
      this._syncEmptyState(target);
    }

    _getEditableState(target) {
      const state = this.editorState[target];
      if (!state) return null;
      return getActiveLayer(state);
    }

    _chooseLayerImages(target) {
      const input = (this.element?.ownerDocument || document).createElement("input");
      input.type = "file";
      input.accept = "image/webp,image/png,image/jpeg,image/*";
      input.multiple = true;
      input.addEventListener("change", async () => {
        await this._addLayerFiles(target, Array.from(input.files || []));
      }, { once: true });
      input.click();
    }

    async _addLayerFiles(target, files) {
      const imageFiles = files.filter((file) => isImageFile(file));
      if (!imageFiles.length) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.unsupportedFile`));
        return;
      }

      for (const file of imageFiles) {
        if (file.type === "image/gif") ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.gifWarning`));
        const dataUrl = await readFileAsDataUrl(file);
        await this._addLayer(target, dataUrl, {
          name: file.name,
          sourceName: file.name,
          sourcePath: "",
          dirty: true
        });
      }
    }

    async _addLayer(target, src, options = {}) {
      const state = this.editorState[target];
      if (!state) return;

      const layer = createLayerState({
        id: options.id,
        name: options.name || options.sourceName || fileNameFromPath(options.sourcePath || src),
        sourceName: options.sourceName || options.name || "",
        sourcePath: options.sourcePath || "",
        mode: options.mode || "fit",
        zoom: options.zoom,
        offsetX: options.offsetX,
        offsetY: options.offsetY,
        visible: options.visible
      }, target);

      layer.loading = true;
      state.layers.push(layer);
      state.layerOrder = addLayerToOrder(state.layerOrder, layer.id);
      state.activeLayerId = layer.id;
      this._syncLayerControls(target);

      try {
        layer.image = await loadImage(src);
        layer.loading = false;
        if (target === "avatar" && !state.image) state.aspect = getImageAspect(layer.image);
        state.dirty = Boolean(options.dirty);
        this._syncAspect(target);
        this._drawTarget(target);
      } catch (error) {
        state.layers = state.layers.filter((candidate) => candidate.id !== layer.id);
        state.layerOrder = removeLayerFromOrder(state.layerOrder, layer.id);
        state.activeLayerId = getFirstLayerId(state) || "base";
        console.error(`${MODULE_ID} | Failed to load layer image`, error);
        ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.layerLoadFailed`));
      } finally {
        layer.loading = false;
        this._syncTargetControls(target);
        this._syncLayerControls(target);
        this._syncEmptyState(target);
      }
    }

    async _loadInitialLayers(target, layers, activeLayerId, layerOrder = []) {
      const state = this.editorState[target];
      if (!state) return;
      state.layers = [];
      state.layerOrder = normalizeLayerOrder(layerOrder, layers || [], hasBaseLayer(state));

      for (const storedLayer of layers || []) {
        const path = storedLayer.sourcePath || storedLayer.path || "";
        if (!path) continue;
        await this._addLayer(target, path, {
          id: storedLayer.id,
          name: storedLayer.name,
          sourceName: storedLayer.sourceName || storedLayer.name,
          sourcePath: path,
          mode: storedLayer.mode,
          zoom: storedLayer.zoom,
          offsetX: storedLayer.offsetX,
          offsetY: storedLayer.offsetY,
          visible: storedLayer.visible,
          dirty: false
        });
      }

      state.layerOrder = normalizeLayerOrder(layerOrder, state.layers, hasBaseLayer(state));
      state.activeLayerId = getLayerById(state, activeLayerId) ? activeLayerId : (getFirstLayerId(state) || "base");
      state.dirty = false;
      this._syncAspect(target);
      this._syncTargetControls(target);
      this._syncLayerControls(target);
      this._syncEmptyState(target);
    }

    _selectLayer(target, layerId) {
      const state = this.editorState[target];
      if (!getLayerById(state, layerId)) return;
      state.activeLayerId = layerId || "base";
      this._syncTargetControls(target);
      this._syncLayerControls(target);
    }

    _toggleLayer(target, layerId) {
      const state = this.editorState[target];
      const layer = getLayerById(state, layerId);
      if (!layer) return;
      layer.visible = layer.visible === false;
      state.dirty = hasRenderableStateImage(state);
      this._drawTarget(target);
      this._syncLayerControls(target);
      this._syncEmptyState(target);
    }

    _moveLayer(target, layerId, direction) {
      const state = this.editorState[target];
      if (!state) return;
      state.layerOrder = normalizeLayerOrder(state.layerOrder, state.layers, hasBaseLayer(state));
      const index = state.layerOrder.indexOf(layerId || "base");
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= state.layerOrder.length) return;
      const [id] = state.layerOrder.splice(index, 1);
      state.layerOrder.splice(nextIndex, 0, id);
      state.dirty = hasRenderableStateImage(state);
      this._drawTarget(target);
      this._syncLayerControls(target);
    }

    _deleteLayer(target, layerId) {
      const state = this.editorState[target];
      if (!state) return;
      const id = layerId || "base";

      if (id === "base") {
        state.image = null;
        state.sourceName = "";
        state.sourcePath = "";
        state.visible = false;
        state.layerOrder = removeLayerFromOrder(state.layerOrder, "base");
      } else {
        state.layers = state.layers.filter((layer) => layer.id !== id);
        state.layerOrder = removeLayerFromOrder(state.layerOrder, id);
      }

      if (state.activeLayerId === id) state.activeLayerId = getFirstLayerId(state) || "base";
      state.dirty = hasRenderableStateImage(state);
      this._syncAspect(target);
      this._drawTarget(target);
      this._syncTargetControls(target);
      this._syncLayerControls(target);
      this._syncEmptyState(target);
    }

    _applyPreset(target, preset) {
      const state = this.editorState[target];
      const editable = this._getEditableState(target);
      if (!editable?.image) return;

      if (preset === "fit") {
        editable.mode = "fit";
        editable.zoom = 1;
        editable.offsetX = 0;
        editable.offsetY = 0;
      }

      if (preset === "fill") {
        editable.mode = "fill";
        editable.zoom = 1;
        editable.offsetX = 0;
        editable.offsetY = 0;
      }

      if (preset === "center") {
        editable.offsetX = 0;
        editable.offsetY = 0;
      }

      if (preset === "portrait") {
        editable.mode = "fill";
        editable.zoom = target === "token" ? 1.22 : 1.05;
        editable.offsetX = 0;
        editable.offsetY = target === "token" ? 0.1 : 0.04;
      }

      if (preset === "reset") {
        editable.mode = "fit";
        editable.zoom = 1;
        editable.offsetX = 0;
        editable.offsetY = 0;
      }

      state.dirty = true;
      this._drawTarget(target);
      this._syncTargetControls(target);
      this._syncLayerControls();
    }

    async _loadImageFile(target, file) {
      if (!isImageFile(file)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.unsupportedFile`));
        return;
      }

      if (file.type === "image/gif") {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.gifWarning`));
      }

      const dataUrl = await readFileAsDataUrl(file);
      await this._setImage(target, dataUrl, {
        sourceName: file.name,
        sourcePath: "",
        dirty: true,
        restoreTransform: false
      });
    }

    async _loadImagePath(target, path, options = {}) {
      if (!path) return;
      await this._setImage(target, path, {
        sourceName: fileNameFromPath(path),
        sourcePath: path,
        dirty: options.dirty ?? true,
        restoreTransform: options.restoreTransform ?? false
      });
    }

    async _setImage(target, src, options = {}) {
      const state = this.editorState[target];
      if (!state) return;

      state.loading = true;
      this._syncEmptyState(target);

      try {
        const image = await loadImage(src);
        state.image = image;
        state.sourceName = options.sourceName || "";
        state.sourcePath = options.sourcePath || "";
        state.visible = true;
        state.aspect = target === "token" ? 1 : getImageAspect(image);

        if (!options.restoreTransform) {
          state.mode = "fit";
          state.zoom = 1;
          state.offsetX = 0;
          state.offsetY = 0;
          state.layerOrder = addLayerToOrder(state.layerOrder, "base");
          state.activeLayerId = "base";
        }

        state.dirty = Boolean(options.dirty);
        this._syncAspect(target);
        this._drawTarget(target);
        this._syncTargetControls(target);
        this._syncLayerControls();
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to load image`, error);
        ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.loadFailed`));
      } finally {
        state.loading = false;
        this._syncEmptyState(target);
      }
    }

    _syncAllControls() {
      for (const target of TARGETS) {
        this._syncAspect(target);
        this._syncTargetControls(target);
        this._syncEmptyState(target);
      }
      this._syncFrameControls();
      this._syncBackgroundControls();
      this._syncLayerControls();
      this._syncVariantControls();
    }

    _syncTargetControls(target) {
      const root = getRoot(this.element);
      const state = this.editorState[target];
      const editable = this._getEditableState(target) || state;
      if (!root || !state) return;

      const setValue = (selector, value) => {
        root.querySelectorAll(selector).forEach((input) => {
          input.value = String(value);
        });
      };

      setValue(`[data-control="zoom"][data-target="${target}"]`, roundForInput(editable.zoom || 1));
      setValue(`[data-control="offsetX"][data-target="${target}"]`, roundForInput(editable.offsetX || 0));
      setValue(`[data-control="offsetY"][data-target="${target}"]`, roundForInput(editable.offsetY || 0));

      root.querySelectorAll(`[data-readout="zoom"][data-target="${target}"]`).forEach((element) => {
        element.textContent = `${Math.round((editable.zoom || 1) * 100)}%`;
      });
      root.querySelectorAll(`[data-readout="offsetX"][data-target="${target}"]`).forEach((element) => {
        element.textContent = `${Math.round((editable.offsetX || 0) * 100)}%`;
      });
      root.querySelectorAll(`[data-readout="offsetY"][data-target="${target}"]`).forEach((element) => {
        element.textContent = `${Math.round((editable.offsetY || 0) * 100)}%`;
      });
      root.querySelectorAll(`[data-readout="source"][data-target="${target}"]`).forEach((element) => {
        element.textContent = getLayerDisplayName(editable) || game.i18n.localize(`${MODULE_ID}.labels.noImage`);
      });

      root.querySelectorAll(`[data-preset][data-target="${target}"]`).forEach((button) => {
        button.classList.toggle("is-active", button.dataset.preset === editable.mode);
      });
    }

    _syncFrameControls() {
      const root = getRoot(this.element);
      const frame = this.editorState.token.frame;
      if (!root || !frame) return;

      const setValue = (selector, value) => {
        root.querySelectorAll(selector).forEach((input) => {
          input.value = String(value);
        });
      };

      root.querySelectorAll('[data-frame-control="enabled"][data-target="token"]').forEach((input) => {
        input.checked = Boolean(frame.enabled);
      });
      setValue('[data-frame-control="clipMode"][data-target="token"]', normalizeFrameClipMode(frame.clipMode));

      root.querySelectorAll('[data-frame-readout="src"][data-target="token"]').forEach((element) => {
        element.textContent = frame.loading
          ? game.i18n.localize(`${MODULE_ID}.labels.frameLoading`)
          : frame.src || game.i18n.localize(`${MODULE_ID}.labels.frameNoImage`);
      });

      root.querySelectorAll("[data-frame-choice]").forEach((button) => {
        button.classList.toggle("is-selected", stripCacheBust(button.dataset.src) === stripCacheBust(frame.src));
      });

      root.querySelectorAll(".ktz-frame-controls").forEach((element) => {
        element.classList.toggle("is-disabled", !frame.enabled);
        element.classList.toggle("is-loading", Boolean(frame.loading));
      });
    }

    _syncBackgroundControls(target = null) {
      const root = getRoot(this.element);
      if (!root) return;

      const targets = target ? [target] : TARGETS;
      for (const currentTarget of targets) {
        const state = this.editorState[currentTarget];
        const background = state?.background;
        if (!background) continue;

        root.querySelectorAll(`[data-background-control="enabled"][data-target="${currentTarget}"]`).forEach((input) => {
          input.checked = Boolean(background.enabled);
        });
        root.querySelectorAll(`[data-background-control="color"][data-target="${currentTarget}"]`).forEach((input) => {
          input.value = normalizeColor(background.color, "#000000");
          input.disabled = !background.enabled;
        });
        root.querySelectorAll(`.ktz-background-controls[data-target="${currentTarget}"]`).forEach((element) => {
          element.classList.toggle("is-disabled", !background.enabled);
        });
      }
    }

    _syncLayerControls(target = null) {
      const root = getRoot(this.element);
      if (!root) return;

      const targets = target ? [target] : TARGETS;
      for (const currentTarget of targets) {
        const state = this.editorState[currentTarget];
        const list = root.querySelector(`[data-layer-list="${currentTarget}"]`);
        if (!list || !state) continue;

        const rows = getLayerRows(state);
        list.replaceChildren();

        rows.forEach((layer, index) => {
          const row = document.createElement("div");
          row.className = "ktz-layer-row";
          row.classList.toggle("is-active", layer.id === state.activeLayerId);
          row.classList.toggle("is-hidden", layer.visible === false);
          row.classList.toggle("is-loading", Boolean(layer.loading));

          const select = document.createElement("button");
          select.type = "button";
          select.className = "ktz-layer-select";
          select.dataset.action = "layer-select";
          select.dataset.target = currentTarget;
          select.dataset.layerId = layer.id;
          select.title = game.i18n.localize(`${MODULE_ID}.labels.selectLayer`);
          select.addEventListener("click", (event) => this._onAction(event));

          const name = document.createElement("span");
          name.className = "ktz-layer-name";
          name.textContent = getLayerDisplayName(layer) || game.i18n.localize(`${MODULE_ID}.labels.noImage`);
          select.appendChild(name);

          const meta = document.createElement("span");
          meta.className = "ktz-layer-meta";
          meta.textContent = layer.id === "base"
            ? game.i18n.localize(`${MODULE_ID}.labels.baseLayer`)
            : `${Math.round((layer.zoom || 1) * 100)}%`;
          select.appendChild(meta);
          row.appendChild(select);

          row.appendChild(this._createLayerButton(currentTarget, "layer-toggle", layer.id, layer.visible === false ? "fa-eye-slash" : "fa-eye", game.i18n.localize(`${MODULE_ID}.buttons.toggleLayer`), !layer.image));
          row.appendChild(this._createLayerButton(currentTarget, "layer-up", layer.id, "fa-arrow-up", game.i18n.localize(`${MODULE_ID}.buttons.layerUp`), index <= 0));
          row.appendChild(this._createLayerButton(currentTarget, "layer-down", layer.id, "fa-arrow-down", game.i18n.localize(`${MODULE_ID}.buttons.layerDown`), index >= rows.length - 1));
          row.appendChild(this._createLayerButton(currentTarget, "layer-delete", layer.id, "fa-trash", game.i18n.localize(`${MODULE_ID}.buttons.deleteLayer`), false));

          list.appendChild(row);
        });
      }
    }

    _createLayerButton(target, action, layerId, iconClass, title, disabled = false) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ktz-layer-icon";
      button.dataset.action = action;
      button.dataset.target = target;
      button.dataset.layerId = layerId;
      button.title = title;
      button.disabled = Boolean(disabled);

      const icon = document.createElement("i");
      icon.className = `fas ${iconClass}`;
      button.appendChild(icon);
      button.addEventListener("click", (event) => this._onAction(event));
      return button;
    }

    _syncAspect(target) {
      const state = this.editorState[target];
      const dropzone = this._dropzones[target];
      if (!dropzone || !state) return;

      const aspect = target === "token" ? 1 : clamp(state.aspect || 0.75, 0.35, 2.4);
      dropzone.style.setProperty("--ktz-aspect", String(aspect));
    }

    _syncEmptyState(target) {
      const state = this.editorState[target];
      const dropzone = this._dropzones[target];
      if (!dropzone || !state) return;

      dropzone.classList.toggle("has-image", hasRenderableStateImage(state));
      dropzone.classList.toggle("is-loading", Boolean(state.loading));
    }

    _drawAll() {
      for (const target of TARGETS) this._drawTarget(target);
    }

    _drawTarget(target) {
      const canvas = this._canvases[target];
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = canvas.ownerDocument?.defaultView?.devicePixelRatio || window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));

      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

      const context = canvas.getContext("2d");
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.save();
      context.scale(dpr, dpr);
      drawTarget(context, this.editorState[target], width, height, { guides: true });
      context.restore();
    }

    async _save() {
      if (this._saving) return;

      const isEditingSavedVariant = this._isEditingSavedTokenVariant();
      const dirtyVariantToken = isEditingSavedVariant && this.editorState.token.dirty;
      const dirtyTargets = TARGETS.filter((target) => {
        if (target === "token" && isEditingSavedVariant) return false;
        return this.editorState[target].dirty && hasRenderableStateImage(this.editorState[target]);
      });

      if (!dirtyTargets.length) {
        const notificationKey = dirtyVariantToken
          ? `${MODULE_ID}.notifications.variantSaveBeforeActorSave`
          : `${MODULE_ID}.notifications.noChanges`;
        const notify = dirtyVariantToken ? ui.notifications.warn : ui.notifications.info;
        notify.call(ui.notifications, game.i18n.localize(notificationKey));
        return;
      }

      if (dirtyVariantToken) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.variantSaveBeforeActorSave`));
      }

      this._saving = true;
      this._setSavingState(true);

      try {
        const actorDirectory = await ensureActorOutputDirectory(this.actor);

        const updates = {};
        const lastEdit = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "lastEdit") || {});
        const previous = {
          avatar: stripCacheBust(this.actor.img || ""),
          token: getActorTokenPath(this.actor) || ""
        };

        let tokenPath = "";
        const savedTargets = [];

        for (const target of dirtyTargets) {
          const result = await this._exportTarget(target, actorDirectory);
          const outputPath = stripCacheBust(result.outputPath);
          const state = this.editorState[target];
          const flattened = Boolean(result.sourceIsFlattened);
          const editData = {
            path: outputPath,
            sourcePath: result.sourcePath,
            sourceName: state.sourceName,
            mode: flattened ? "fit" : state.mode,
            zoom: flattened ? 1 : state.zoom,
            offsetX: flattened ? 0 : state.offsetX,
            offsetY: flattened ? 0 : state.offsetY,
            aspect: state.aspect,
            visible: flattened ? true : state.visible !== false
          };
          editData.background = flattened
            ? cleanBackgroundState({ enabled: false, color: state.background?.color })
            : cleanBackgroundState(state.background);
          editData.layers = flattened ? [] : (result.layers || []);
          editData.activeLayerId = flattened ? "base" : (state.activeLayerId || "base");
          editData.layerOrder = flattened ? ["base"] : (state.layerOrder || []);
          if (target === "token") {
            editData.frame = flattened
              ? cleanFrameState({ enabled: false, clipMode: state.frame?.clipMode })
              : cleanFrameState(state.frame);
          }

          lastEdit[target] = editData;
          savedTargets.push({ target, outputPath, sourcePath: result.sourcePath });

          if (target === "avatar") updates.img = outputPath;
          if (target === "token") {
            updates["prototypeToken.texture.src"] = outputPath;
            tokenPath = outputPath;
          }
        }

        lastEdit.version = 1;
        lastEdit.updatedAt = new Date().toISOString();
        lastEdit.previous = previous;

        await this.actor.update({
          ...updates,
          [`flags.${MODULE_ID}.lastEdit`]: lastEdit
        }, { khuzoeTokenizerSave: true });
        await emitTokenizerSaved(this.actor, {
          reason: "base-saved",
          changedTargets: dirtyTargets
        });

        for (const saved of savedTargets) {
          const state = this.editorState[saved.target];
          state.outputPath = saved.outputPath;
          state.sourcePath = saved.sourcePath;
          state.dirty = false;
        }

        const shouldUpdatePlacedTokens = Boolean(this.element?.querySelector('[name="updatePlacedTokens"]')?.checked);
        let updatedTokens = 0;
        if (shouldUpdatePlacedTokens && tokenPath && game.user.isGM) {
          try {
            updatedTokens = await updatePlacedTokens(this.actor, tokenPath);
          } catch (error) {
            console.warn(`${MODULE_ID} | Base salvata, aggiornamento token piazzati fallito`, error);
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.placedTokensFailed`));
          }
        }

        const message = updatedTokens
          ? game.i18n.format(`${MODULE_ID}.notifications.savedWithPlacedTokens`, { count: updatedTokens })
          : game.i18n.localize(`${MODULE_ID}.notifications.saved`);
        ui.notifications.info(message);
        this.close();
      } catch (error) {
        console.error(`${MODULE_ID} | Save failed`, error);
        ui.notifications.error(getUserFacingErrorMessage(error, `${MODULE_ID}.notifications.saveFailed`));
      } finally {
        this._saving = false;
        this._setSavingState(false);
      }
    }

    async _exportTarget(target, directory) {
      const state = this.editorState[target];
      const outputCanvas = this._renderOutputCanvas(target);
      const outputBlob = await canvasToWebpBlob(outputCanvas, getWebpQuality());
      const outputHash = await hashBlob(outputBlob);
      const outputFileName = `${target}-base-${outputHash}.webp`;
      const outputPath = await uploadBlob(directory, outputFileName, outputBlob);

      let sourcePath = outputPath;
      const shouldStoreSource = Boolean(state.image) && (
        game.settings.get(MODULE_ID, "storeSources")
        || (target === "token" && state.frame?.enabled)
        || state.layers?.length
      );
      if (shouldStoreSource) {
        const sourceCanvas = this._renderSourceCanvas(target);
        const sourceBlob = await canvasToWebpBlob(sourceCanvas, getWebpQuality());
        const sourceHash = await hashBlob(sourceBlob);
        const sourceFileName = `${target}-base-source-${sourceHash}.webp`;
        sourcePath = await uploadBlob(directory, sourceFileName, sourceBlob);
      }

      const layers = shouldStoreSource ? await this._exportLayers(target, directory) : [];

      return { outputPath, sourcePath, layers, sourceIsFlattened: !shouldStoreSource };
    }

    async _exportLayers(target, directory) {
      const state = this.editorState[target];
      const exported = [];

      for (const layer of state.layers) {
        if (!layer.image) continue;

        if (!layer.sourcePath) {
          const sourceCanvas = this._renderImageSourceCanvas(layer.image);
          const sourceBlob = await canvasToWebpBlob(sourceCanvas, getWebpQuality());
          const sourceHash = await hashBlob(sourceBlob);
          const sourceFileName = `${target}-layer-${sanitizeSegment(layer.id)}-${sourceHash}.webp`;
          layer.sourcePath = await uploadBlob(directory, sourceFileName, sourceBlob);
        }

        exported.push(cleanLayerState(layer));
      }

      return exported;
    }

    async _saveTokenVariant() {
      const state = this.editorState.token;
      if (!hasRenderableStateImage(state)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.variantNoToken`));
        return;
      }

      const root = getRoot(this.element);
      const nameInput = root?.querySelector('[data-variant-control="name"]');
      const sizeInput = root?.querySelector('[data-variant-control="size"]');
      const scaleInput = root?.querySelector('[data-variant-control="scale"]');
      const scale = parseVariantScale(scaleInput?.value);
      if (Number.isNaN(scale)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.invalidVariantScale`));
        return;
      }
      const enteredSize = parseDecimal(sizeInput?.value);
      if (!Number.isFinite(enteredSize) || enteredSize < TOKEN_VARIANT_MIN_SIZE || enteredSize > TOKEN_VARIANT_MAX_SIZE) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.invalidVariantSize`));
        return;
      }
      const name = String(nameInput?.value || this.actor.name || "Token").trim() || this.actor.name || "Token";
      const size = normalizeTokenVariantSize(sizeInput?.value);
      const editingVariantId = this._isEditingSavedTokenVariant() ? this._editingTokenVariantId : "";
      const editingVariant = getActorTokenVariants(this.actor).find((variant) => variant.id === editingVariantId);
      if (editingVariant && !isEditableTokenVariant(editingVariant)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.managedVariant`));
        return;
      }

      if (!editingVariantId && this._editingTokenVariantId === "base") {
        this._baseTokenStateSnapshot = cloneTargetState(this.editorState.token);
      }

      this._setSavingState(true);
      try {
        const actorDirectory = await ensureActorOutputDirectory(this.actor);

        const variants = getActorTokenVariants(this.actor);
        const existingIndex = variants.findIndex((variant) => variant.id === editingVariantId);
        const variantId = existingIndex >= 0 ? variants[existingIndex].id : generateVariantId();
        const canvas = this._renderOutputCanvas("token");
        const blob = await canvasToWebpBlob(canvas, getWebpQuality());
        const imageHash = await hashBlob(blob);
        const fileName = `token-variant-${sanitizeSegment(variantId)}-${imageHash}.webp`;
        const storedPath = await uploadBlob(actorDirectory, fileName, blob);
        const outputPath = stripCacheBust(storedPath);

        const now = new Date().toISOString();
        const variant = createTokenVariant({
          ...(existingIndex >= 0 ? variants[existingIndex] : {}),
          id: variantId,
          name,
          src: outputPath,
          width: size,
          height: size,
          scale,
          createdAt: existingIndex >= 0 ? variants[existingIndex].createdAt : now,
          updatedAt: now
        });
        variant.source = "manual";

        if (existingIndex >= 0) variants[existingIndex] = variant;
        else variants.push(variant);

        await this.actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
        if (existingIndex >= 0) {
          await updatePlacedTokensUsingVariant(this.actor, variant);
        }
        await emitTokenizerSaved(this.actor, {
          reason: existingIndex >= 0 ? "variant-updated" : "variant-added",
          variantsChanged: true
        });
        refreshOpenTokenVariantViews(this.actor, this);
        this._editingTokenVariantId = variant.id;
        state.sourceName = variant.name;
        state.sourcePath = outputPath;
        state.outputPath = outputPath;
        state.dirty = false;
        this._setVariantFormValues(variant.name, variant.width, variant.scale);
        this._syncVariantControls();

        const notificationKey = existingIndex >= 0
          ? `${MODULE_ID}.notifications.variantUpdated`
          : `${MODULE_ID}.notifications.variantSaved`;
        ui.notifications.info(game.i18n.format(notificationKey, { name: variant.name }));
      } catch (error) {
        console.error(`${MODULE_ID} | Token variant save failed`, error);
        ui.notifications.error(getUserFacingErrorMessage(error, `${MODULE_ID}.notifications.variantSaveFailed`));
      } finally {
        this._setSavingState(false);
      }
    }

    async _deleteTokenVariant(variantId) {
      if (!variantId) return;
      const wasEditing = this._editingTokenVariantId === variantId;
      const currentVariant = getActorTokenVariants(this.actor).find((variant) => variant.id === variantId);
      if (!isEditableTokenVariant(currentVariant)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.managedVariant`));
        return;
      }
      const variants = getActorTokenVariants(this.actor).filter((variant) => variant.id !== variantId);
      await this.actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
      await restorePlacedTokensUsingVariant(this.actor, variantId);
      await emitTokenizerSaved(this.actor, {
        reason: "variant-removed",
        variantsChanged: true,
        removedVariantIds: [variantId]
      });
      refreshOpenTokenVariantViews(this.actor, this);
      if (wasEditing) this._editTokenBase();
      else this._syncVariantControls();
    }

    _editTokenBase() {
      if (this._baseTokenStateSnapshot) {
        this.editorState.token = cloneTargetState(this._baseTokenStateSnapshot);
      }

      this._editingTokenVariantId = "base";
      this._setVariantFormValues(this.actor.name || "Token", 1);
      this._syncAllControls();
      this._drawAll();
    }

    async _editTokenVariant(variantId) {
      const variant = getActorTokenVariants(this.actor).find((candidate) => candidate.id === variantId);
      if (!variant) return;
      if (!isEditableTokenVariant(variant)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.managedVariant`));
        return;
      }

      if (this._editingTokenVariantId === "base") {
        this._baseTokenStateSnapshot = cloneTargetState(this.editorState.token);
      }

      this._editingTokenVariantId = variant.id;
      this.editorState.token = this._createBlankTokenVariantState();
      this._setVariantFormValues(variant.name, variant.width, variant.scale);
      await this._setImage("token", variant.src, {
        sourceName: variant.name,
        sourcePath: variant.src,
        dirty: false,
        restoreTransform: false
      });
      this.editorState.token.dirty = false;
      this._setVariantFormValues(variant.name, variant.width, variant.scale);
      this._syncAllControls();
      this._drawAll();
    }

    _createBlankTokenVariantState() {
      return {
        target: "token",
        image: null,
        sourceName: "",
        sourcePath: "",
        outputPath: "",
        mode: "fit",
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        aspect: 1,
        visible: true,
        dirty: false,
        loading: false,
        frame: createFrameState(),
        layers: [],
        activeLayerId: "base",
        layerOrder: [],
        background: createBackgroundState()
      };
    }

    _isEditingSavedTokenVariant() {
      if (!this._editingTokenVariantId || this._editingTokenVariantId === "base") return false;
      return getActorTokenVariants(this.actor).some((variant) => variant.id === this._editingTokenVariantId);
    }

    _setVariantFormValues(name, size, scale = null) {
      const root = getRoot(this.element);
      if (!root) return;

      root.querySelectorAll('[data-variant-control="name"]').forEach((input) => {
        input.value = String(name || this.actor.name || "Token");
      });
      root.querySelectorAll('[data-variant-control="size"]').forEach((input) => {
        input.value = String(normalizeTokenVariantSize(size));
      });
      root.querySelectorAll('[data-variant-control="scale"]').forEach((input) => {
        input.value = scale == null ? "" : String(scale);
      });
    }

    _syncVariantControls() {
      const root = getRoot(this.element);
      const list = root?.querySelector('[data-variant-list="token"]');
      if (!root || !list) return;

      const variants = getActorTokenVariants(this.actor);
      let editingVariant = variants.find((variant) => variant.id === this._editingTokenVariantId);
      if (this._editingTokenVariantId !== "base" && !editingVariant) {
        this._editingTokenVariantId = "base";
        editingVariant = null;
      }

      const isEditingSavedVariant = Boolean(editingVariant);
      const editingLabel = editingVariant?.name || game.i18n.localize(`${MODULE_ID}.labels.baseToken`);
      root.querySelectorAll('[data-variant-readout="editing"]').forEach((element) => {
        element.textContent = editingLabel;
      });
      root.querySelectorAll('[data-variant-save-label]').forEach((element) => {
        element.textContent = game.i18n.localize(isEditingSavedVariant
          ? `${MODULE_ID}.buttons.updateVariant`
          : `${MODULE_ID}.buttons.saveVariant`);
      });
      root.querySelectorAll('[data-variant-save-icon]').forEach((icon) => {
        icon.className = `fas ${isEditingSavedVariant ? "fa-save" : "fa-plus"}`;
      });
      root.querySelectorAll(".ktz-variant-controls").forEach((element) => {
        element.classList.toggle("is-editing-saved-variant", isEditingSavedVariant);
      });

      list.replaceChildren();

      const baseTitle = document.createElement("div");
      baseTitle.className = "ktz-variant-section-title";
      baseTitle.textContent = game.i18n.localize(`${MODULE_ID}.labels.baseToken`);
      list.appendChild(baseTitle);

      const baseVariant = {
        id: "base",
        name: game.i18n.localize(`${MODULE_ID}.labels.baseToken`),
        src: getActorTokenPath(this.actor),
        width: getActorTokenWidth(this.actor),
        height: getActorTokenHeight(this.actor)
      };
      list.appendChild(this._createVariantListRow(baseVariant, !isEditingSavedVariant, { base: true }));

      const savedTitle = document.createElement("div");
      savedTitle.className = "ktz-variant-section-title";
      savedTitle.textContent = game.i18n.localize(`${MODULE_ID}.labels.savedTokenVariants`);
      list.appendChild(savedTitle);

      if (!variants.length) {
        const empty = document.createElement("div");
        empty.className = "ktz-variant-empty";
        empty.textContent = game.i18n.localize(`${MODULE_ID}.labels.variantEmpty`);
        list.appendChild(empty);
        return;
      }

      for (const variant of variants) {
        list.appendChild(this._createVariantListRow(variant, this._editingTokenVariantId === variant.id, { base: false }));
      }
    }

    _createVariantListRow(variant, active = false, options = {}) {
      const row = document.createElement("div");
      row.className = "ktz-variant-row";
      row.classList.toggle("is-active", active);
      row.classList.toggle("is-base", Boolean(options.base));

      const thumb = document.createElement("div");
      thumb.className = "ktz-variant-thumb";
      if (variant.src) {
        const image = document.createElement("img");
        image.src = variant.src;
        image.alt = variant.name;
        thumb.appendChild(image);
      } else {
        const icon = document.createElement("i");
        icon.className = "fas fa-user";
        thumb.appendChild(icon);
      }
      row.appendChild(thumb);

      const label = document.createElement("div");
      label.className = "ktz-variant-label";
      const name = document.createElement("strong");
      name.textContent = variant.name;
      const size = document.createElement("span");
      size.textContent = `${variant.width}x${variant.height} · ${game.i18n.localize(`${MODULE_ID}.labels.variantScale`)}: ${variant.scale ?? game.i18n.localize(`${MODULE_ID}.labels.inheritScale`)}`;
      label.appendChild(name);
      label.appendChild(size);
      row.appendChild(label);

      if (options.base) {
        const placeholder = document.createElement("span");
        placeholder.className = "ktz-variant-icon-placeholder";
        row.appendChild(placeholder);
      } else {
        const avatarButton = this._createVariantButton("variant-avatar-manage", variant.id, "fa-user", game.i18n.localize(`${MODULE_ID}.buttons.variantAvatar`));
        if (variant.avatarSrc) {
          avatarButton.classList.add("has-avatar");
          avatarButton.replaceChildren();
          const image = document.createElement("img");
          image.src = variant.avatarSrc;
          image.alt = game.i18n.localize(`${MODULE_ID}.labels.variantAvatar`);
          avatarButton.appendChild(image);
        }
        row.appendChild(avatarButton);
      }

      row.appendChild(this._createVariantButton(
        options.base ? "variant-edit-base" : "variant-edit",
        variant.id,
        options.base ? "fa-home" : "fa-pencil-alt",
        game.i18n.localize(options.base ? `${MODULE_ID}.buttons.editBaseToken` : `${MODULE_ID}.buttons.editVariant`)
      ));

      if (options.base) {
        const placeholder = document.createElement("span");
        placeholder.className = "ktz-variant-icon-placeholder";
        row.appendChild(placeholder);
      } else {
        row.appendChild(this._createVariantButton("variant-delete", variant.id, "fa-trash", game.i18n.localize(`${MODULE_ID}.buttons.deleteVariant`)));
      }

      return row;
    }

    _createVariantButton(action, variantId, iconClass, title) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ktz-variant-icon";
      button.dataset.action = action;
      button.dataset.target = "token";
      if (variantId) button.dataset.variantId = variantId;
      button.title = title;

      const icon = document.createElement("i");
      icon.className = `fas ${iconClass}`;
      button.appendChild(icon);
      button.addEventListener("click", (event) => this._onAction(event));
      return button;
    }

    _renderOutputCanvas(target) {
      const state = this.editorState[target];
      const canvas = document.createElement("canvas");

      if (target === "token") {
        const size = getTokenOutputSize(state);
        canvas.width = size;
        canvas.height = size;
      } else {
        const maxDimension = clamp(Math.round(game.settings.get(MODULE_ID, "avatarMaxDimension") || 1024), 128, 4096);
        const aspect = clamp(state.aspect || getImageAspect(state.image), 0.1, 10);
        if (aspect >= 1) {
          canvas.width = maxDimension;
          canvas.height = Math.max(1, Math.round(maxDimension / aspect));
        } else {
          canvas.height = maxDimension;
          canvas.width = Math.max(1, Math.round(maxDimension * aspect));
        }
      }

      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawTarget(context, state, canvas.width, canvas.height, { guides: false });
      return canvas;
    }

    _renderSourceCanvas(target) {
      return this._renderImageSourceCanvas(this.editorState[target].image);
    }

    _renderImageSourceCanvas(image) {
      const maxDimension = clamp(Math.round(game.settings.get(MODULE_ID, "sourceMaxDimension") || 2048), 128, 4096);
      const width = image.naturalWidth || image.width || maxDimension;
      const height = image.naturalHeight || image.height || maxDimension;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    _setSavingState(isSaving) {
      const root = getRoot(this.element);
      if (!root) return;

      root.classList.toggle("is-saving", isSaving);
      root.querySelectorAll("button, input, select").forEach((element) => {
        element.disabled = isSaving;
      });
    }
  }

  Hooks.once("init", () => {
    registerSettings();
    registerAvatarPreviewKeybinding();
  });

  Hooks.once("ready", async () => {
    initializeDirectorySocket();
    initializeAvatarPreviewPointerTracking();

    const api = Object.freeze({
      open: (actor) => openTokenizer(actor),
      manageVariants: (actor) => openTokenVariantManager(actor),
      getVariants: (actor) => getActorTokenVariants(actor),
      getTokenAvatar: (tokenDocument) => getTokenAvatar(tokenDocument),
      syncVariants: (actor, payload = {}) => syncActorTokenVariants(actor, payload),
      replaceVariants: (actor, payload = {}) => replaceActorTokenVariants(actor, payload),
      applyVariant: (tokenDocument, variantOrId, options = {}) => applyTokenVariant(tokenDocument, variantOrId, options),
      restoreBase: (tokenDocument, options = {}) => restoreTokenVariantBase(tokenDocument, options)
    });
    game.khuzoeTokenizer = api;
    const module = game.modules.get(MODULE_ID);
    if (module) module.api = api;

    if (game.user.isGM && Number(game.settings.get(MODULE_ID, "migrationVersion") || 0) < 1) {
      try {
        const migration = await migrateLegacyCacheBustedPaths();
        if (migration.failures === 0) {
          await game.settings.set(MODULE_ID, "migrationVersion", 1);
        } else {
          console.warn(`${MODULE_ID} | Legacy path migration left ${migration.failures} documents to retry`);
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Failed to normalize legacy image paths`, error);
      }
    }
  });


  Hooks.on("renderTokenConfig", (app, html) => {
    injectTokenConfigVariantButton(app, html);
  });


  Hooks.on("renderActorSheet", (app, html) => {
    const actor = getSheetActor(app);
    if (!canUseTokenizer(app, actor)) return;

    injectSheetTrigger(app, html, actor);
  });

  Hooks.on("renderApplication", (app, html) => {
    injectTokenConfigVariantButton(app, html);
    const actor = getSheetActor(app);
    if (!canUseTokenizer(app, actor)) return;

    injectSheetTrigger(app, html, actor);
  });

  Hooks.on("renderApplicationV2", (app, html) => {
    injectTokenConfigVariantButton(app, html);
    const actor = getSheetActor(app);
    if (!canUseTokenizer(app, actor)) return;

    injectSheetTrigger(app, html, actor);
  });

  Hooks.on("renderTokenHUD", (app, html) => {
    injectTokenVariantHud(app, html);
  });

  function registerSettings() {
    game.settings.register(MODULE_ID, "webpQuality", {
      name: `${MODULE_ID}.settings.webpQuality.name`,
      hint: `${MODULE_ID}.settings.webpQuality.hint`,
      scope: "world",
      config: true,
      type: Number,
      default: 1,
      range: {
        min: 0.1,
        max: 1,
        step: 0.01
      }
    });

    game.settings.register(MODULE_ID, "tokenSize", {
      name: `${MODULE_ID}.settings.tokenSize.name`,
      hint: `${MODULE_ID}.settings.tokenSize.hint`,
      scope: "world",
      config: true,
      type: Number,
      default: 1024,
      range: {
        min: 1024,
        max: 4096,
        step: 128
      }
    });

    game.settings.register(MODULE_ID, "avatarMaxDimension", {
      name: `${MODULE_ID}.settings.avatarMaxDimension.name`,
      hint: `${MODULE_ID}.settings.avatarMaxDimension.hint`,
      scope: "world",
      config: true,
      type: Number,
      default: 1024,
      range: {
        min: 128,
        max: 4096,
        step: 128
      }
    });

    game.settings.register(MODULE_ID, "sourceMaxDimension", {
      name: `${MODULE_ID}.settings.sourceMaxDimension.name`,
      hint: `${MODULE_ID}.settings.sourceMaxDimension.hint`,
      scope: "world",
      config: true,
      type: Number,
      default: 2048,
      range: {
        min: 128,
        max: 4096,
        step: 128
      }
    });

    game.settings.register(MODULE_ID, "outputDirectory", {
      name: `${MODULE_ID}.settings.outputDirectory.name`,
      hint: `${MODULE_ID}.settings.outputDirectory.hint`,
      scope: "world",
      config: true,
      type: String,
      default: MODULE_ID
    });

    game.settings.register(MODULE_ID, "frameDirectory", {
      name: `${MODULE_ID}.settings.frameDirectory.name`,
      hint: `${MODULE_ID}.settings.frameDirectory.hint`,
      scope: "world",
      config: true,
      type: String,
      default: `${MODULE_ID}/frames`
    });

    game.settings.register(MODULE_ID, "storeSources", {
      name: `${MODULE_ID}.settings.storeSources.name`,
      hint: `${MODULE_ID}.settings.storeSources.hint`,
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "updatePlacedTokens", {
      name: `${MODULE_ID}.settings.updatePlacedTokens.name`,
      hint: `${MODULE_ID}.settings.updatePlacedTokens.hint`,
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "avatarPreviewForVisibleTokens", {
      name: `${MODULE_ID}.settings.avatarPreviewForVisibleTokens.name`,
      hint: `${MODULE_ID}.settings.avatarPreviewForVisibleTokens.hint`,
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "migrationVersion", {
      scope: "world",
      config: false,
      type: Number,
      default: 0
    });

  }
  function registerAvatarPreviewKeybinding() {
    game.keybindings.register(MODULE_ID, "previewHoveredAvatar", {
      name: `${MODULE_ID}.keybindings.previewHoveredAvatar.name`,
      hint: `${MODULE_ID}.keybindings.previewHoveredAvatar.hint`,
      editable: [{ key: "KeyM" }],
      onDown: () => previewHoveredTokenAvatar(),
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
    });
  }

  function initializeAvatarPreviewPointerTracking() {
    document.addEventListener("pointermove", rememberCanvasPointerPosition, true);
  }

  function rememberCanvasPointerPosition(event) {
    const view = getCanvasView();
    if (!view) {
      lastCanvasPointerPosition = null;
      return;
    }
    if (event.target !== view) {
      if (lastCanvasPointerPosition?.target === view) lastCanvasPointerPosition = null;
      return;
    }
    lastCanvasPointerPosition = {
      clientX: Number(event.clientX) || 0,
      clientY: Number(event.clientY) || 0,
      target: view
    };
  }

  function getCanvasView() {
    return canvas?.app?.view || canvas?.app?.canvas || null;
  }

  function getCanvasTokenAtClientPoint(point) {
    const view = getCanvasView();
    if (!view || !point || point.target !== view || !canvas?.stage || !canvas?.tokens?.placeables?.length) return null;

    const hovered = [...canvas.tokens.placeables].reverse().find((token) => token?.hover && isTokenVisibleForAvatarPreview(token));
    if (hovered && isTokenVisibleForAvatarPreview(hovered)) return hovered;

    const rect = view.getBoundingClientRect();
    const screenPoint = new PIXI.Point(point.clientX - rect.left, point.clientY - rect.top);
    const worldPoint = canvas.stage.worldTransform.applyInverse(screenPoint);
    const tokens = [...canvas.tokens.placeables].reverse().filter(isTokenVisibleForAvatarPreview);

    return tokens.find((token) => {
      const bounds = token.bounds;
      if (bounds?.contains?.(worldPoint.x, worldPoint.y)) return true;
      const width = Number(token.w ?? token.width) || 0;
      const height = Number(token.h ?? token.height) || 0;
      return worldPoint.x >= token.x
        && worldPoint.x <= token.x + width
        && worldPoint.y >= token.y
        && worldPoint.y <= token.y + height;
    }) || null;
  }

  function isTokenVisibleForAvatarPreview(token) {
    if (!token || token.destroyed) return false;
    if (token.visible === false || token.renderable === false) return false;
    if (typeof token.worldVisible === "boolean" && token.worldVisible === false) return false;
    if (typeof token.isVisible === "boolean" && token.isVisible === false) return false;
    if (typeof token.isVisible === "function") {
      try {
        if (!token.isVisible()) return false;
      } catch (_error) {
        // Foundry versions can expose isVisible as either a property or a method.
      }
    }
    if (token.document?.hidden && !game.user?.isGM) return false;
    return true;
  }

  function isTypingInTextInput() {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    if (active.isContentEditable) return true;
    if (active.closest?.("[contenteditable='true'], .editor, .tox, .ProseMirror, .CodeMirror")) return true;
    return ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
  }

  function hasAvatarObserverPermission(token) {
    if (game.user?.isGM || token?.document?.isOwner || token?.actor?.isOwner) return true;
    const observerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    try {
      return Boolean(token?.actor?.testUserPermission?.(game.user, observerLevel));
    } catch (_error) {
      return false;
    }
  }

  function getAvatarPreviewOverride(token) {
    const values = [
      token?.document?.getFlag?.(MODULE_ID, "avatarPreview"),
      token?.actor?.getFlag?.(MODULE_ID, "avatarPreview")
    ];
    for (const value of values) {
      if (value === true || value === "allow") return true;
      if (value === false || value === "deny") return false;
    }
    return null;
  }

  function getMerchantGroundLootPreview(token) {
    const loot = token?.document?.getFlag?.(MERCHANT_MODULE_ID, "groundLoot");
    if (!loot || typeof loot !== "object") return null;

    const source = [
      loot.img,
      loot.item?.img,
      token?.document?.texture?.src
    ].map((value) => String(value || "").trim()).find(Boolean) || "";
    const title = [
      loot.label,
      loot.name,
      loot.item?.name,
      token?.document?.name
    ].map((value) => String(value || "").trim()).find(Boolean)
      || game.i18n.localize(`${MODULE_ID}.labels.itemImage`);

    return { source, title };
  }

  function canPreviewTokenAvatar(token) {
    if (!isTokenVisibleForAvatarPreview(token)) return false;
    if (hasAvatarObserverPermission(token)) return true;
    const override = getAvatarPreviewOverride(token);
    if (override !== null) return override;
    return Boolean(game.settings.get(MODULE_ID, "avatarPreviewForVisibleTokens"));
  }

  function previewHoveredTokenAvatar() {
    if (isTypingInTextInput()) return false;
    const token = getCanvasTokenAtClientPoint(lastCanvasPointerPosition);
    if (!token) return false;

    if (!canPreviewTokenAvatar(token)) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.avatarPreviewDenied`));
      return true;
    }

    const actor = token.actor;
    const groundLootPreview = getMerchantGroundLootPreview(token);
    const source = String(groundLootPreview?.source || getTokenAvatar(token.document) || "").trim();
    if (!source) {
      ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.avatarPreviewMissing`));
      return true;
    }

    const canIdentify = hasAvatarObserverPermission(token);
    const title = groundLootPreview?.title || (canIdentify
      ? String(actor?.name || token.document?.name || game.i18n.localize(`${MODULE_ID}.labels.avatarPreview`))
      : game.i18n.localize(`${MODULE_ID}.labels.avatarPreview`));

    const previewIdentity = String(token.document?.uuid || token.document?.id || token.id || "");
    if (activeAvatarPreview?.rendered && activeAvatarPreview._ktzAvatarSource === source
      && activeAvatarPreview._ktzAvatarIdentity === previewIdentity) {
      bringApplicationToFront(activeAvatarPreview);
      return true;
    }
    if (activeAvatarPreview?.rendered) {
      Promise.resolve(activeAvatarPreview.close()).catch(() => {});
    }

    activeAvatarPreview = openImagePopout(source, {
      title,
      uuid: !groundLootPreview && canIdentify && source === actor?.img && actor?.uuid ? actor.uuid : null
    });
    if (activeAvatarPreview) {
      activeAvatarPreview._ktzAvatarSource = source;
      activeAvatarPreview._ktzAvatarIdentity = previewIdentity;
    }
    return true;
  }

  function openTokenizer(actor) {
    if (!actor) return null;
    const id = `${MODULE_ID}-${actor.id}`;
    const existing = findOpenApplication(id);
    if (existing) {
      bringApplicationToFront(existing);
      return existing;
    }
    const app = new KhuzoeTokenizerApp(actor);
    app.render({ force: true });
    return app;
  }

  function openTokenVariantManager(actor) {
    if (!actor) return null;
    const id = getTokenVariantManagerId(actor);
    const existing = findOpenApplication(id);
    if (existing) {
      bringApplicationToFront(existing);
      return existing;
    }
    const app = new KhuzoeTokenVariantManagerApp(actor);
    app.render({ force: true });
    return app;
  }

  function getTokenVariantManagerId(actor) {
    return `${MODULE_ID}-variant-manager-${actor?.id || "actor"}`;
  }

  function getTokenConfigActor(app) {
    const candidates = [
      app?.actor,
      app?.object?.actor,
      app?.document?.actor,
      app?.token?.actor,
      app?.object?.parent?.actor
    ];
    const actor = candidates.find((candidate) => candidate?.documentName === "Actor") || null;
    if (!actor?.isToken) return actor;
    const baseActorId = actor.parent?.actorId || actor.id;
    return game.actors?.get(baseActorId) || actor;
  }

  function injectTokenConfigVariantButton(app, html) {
    if (!/TokenConfig/i.test(String(app?.constructor?.name || ""))) return;
    const root = getRoot(html);
    if (!root || root.querySelector(".ktz-token-config-variants-button")) return;

    const textureInput = root.querySelector('input[name="texture.src"], file-picker[name="texture.src"]');
    const actor = getTokenConfigActor(app);
    if (!textureInput || !actor || (!actor.isOwner && !game.user.isGM)) return;

    const container = textureInput.closest(".form-fields") || textureInput.parentElement;
    if (!container) return;

    const ownerDocument = root.ownerDocument || document;
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "file-picker ktz-token-config-variants-button";
    button.title = game.i18n.localize(`${MODULE_ID}.buttons.manageVariants`);
    button.setAttribute("aria-label", button.title);
    const icon = ownerDocument.createElement("i");
    icon.className = "fas fa-images";
    button.appendChild(icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTokenVariantManager(actor);
    });
    container.appendChild(button);
  }
  function getSheetActor(app) {
    const primaryDocument = app?.document
      || app?.object?.document
      || (app?.object?.documentName ? app.object : null)
      || app?.options?.document
      || null;
    if (primaryDocument?.documentName && primaryDocument.documentName !== "Actor") return null;

    const candidates = [app?.actor, primaryDocument, app?.object, app?.options?.document];
    return candidates.find((candidate) => candidate?.documentName === "Actor") || null;
  }

  function canUseTokenizer(app, actor) {
    if (app instanceof KhuzoeTokenizerApp || app instanceof KhuzoeTokenVariantSelectorApp || app instanceof KhuzoeTokenVariantManagerApp) return false;
    if (!actor || actor.documentName !== "Actor") return false;
    if (app?.isEditable === false) return false;
    if (!actor.isOwner && !game.user.isGM) return false;
    if (game.system?.id === "dnd5e" && !SUPPORTED_DND5E_TYPES.has(actor.type)) return false;
    return true;
  }

  function injectSheetTrigger(app, html, actor) {
    const root = getRoot(html);
    if (!root || !isSheetInEditMode(app)) return;

    const image = findActorImage(root);
    if (!image || image.dataset.ktzTokenizerBound === "true") return;

    image.dataset.ktzTokenizerBound = "true";
    image.classList.add("ktz-clickable-image");
    image.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTokenizer(actor);
    }, { capture: true });
  }

  function isSheetInEditMode(app) {
    const editMode = app?.constructor?.MODES?.EDIT;
    if (editMode !== undefined && app?._mode !== undefined && app?._mode !== null) {
      return app._mode === editMode;
    }
    return app?.isEditable !== false;
  }

  function injectTokenVariantHud(app, html) {
    const root = getRoot(html);
    const tokenDocument = getHudTokenDocument(app);
    const actor = tokenDocument?.actor;
    if (!root || !tokenDocument || !actor) return;
    if (!actor.isOwner && !game.user.isGM) return;

    const variants = getActorTokenVariants(actor);
    if (!variants.length || root.querySelector(".ktz-token-variants-toggle")) return;

    const column = root.querySelector(".col.right") || root.querySelector(".col.left") || root;
    const toggle = document.createElement("div");
    toggle.className = "control-icon ktz-token-variants-toggle";
    toggle.title = game.i18n.localize(`${MODULE_ID}.buttons.openVariants`);
    const icon = document.createElement("i");
    icon.className = "fas fa-images";
    toggle.appendChild(icon);
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTokenVariantSelector(tokenDocument);
    });

    column.appendChild(toggle);
  }
  function openTokenVariantSelector(tokenDocument) {
    const id = getTokenVariantSelectorId(tokenDocument);
    const existing = findOpenApplication(id);
    if (existing) {
      bringApplicationToFront(existing);
      return existing;
    }
    const app = new KhuzoeTokenVariantSelectorApp(tokenDocument);
    app.render({ force: true });
    return app;
  }

  function getTokenVariantSelectorId(tokenDocument) {
    const identifier = tokenDocument?.uuid || tokenDocument?.id || "token";
    return `${MODULE_ID}-variant-selector-${String(identifier).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  }
  function getHudTokenDocument(app) {
    const object = app?.object;
    if (object?.document?.documentName === "Token") return object.document;
    if (object?.documentName === "Token") return object;
    return null;
  }

  async function applyTokenVariant(tokenDocument, variantOrId, options = {}) {
    if (!tokenDocument) return false;
    const variantActor = options.actor || tokenDocument.actor;
    const variant = typeof variantOrId === "string"
      ? getActorTokenVariants(variantActor).find((candidate) => candidate.id === variantOrId)
      : createTokenVariant(variantOrId || {});
    if (!variant?.src) return false;

    const storedBase = tokenDocument.getFlag(MODULE_ID, "tokenVariantBase");
    const activeVariantId = String(tokenDocument.getFlag(MODULE_ID, "activeTokenVariant") || "base");
    const refreshManagedBase = Boolean(options.actor) && activeVariantId === "base";
    const base = refreshManagedBase
      ? captureActorTokenVisualState(options.actor)
      : storedBase || (options.actor ? captureActorTokenVisualState(options.actor) : captureTokenVisualState(tokenDocument));
    const update = buildTokenVisualUpdate(tokenDocument, {
      width: variant.width,
      height: variant.height,
      texture: variantTexture(base.texture, variant)
    });
    update[`flags.${MODULE_ID}.tokenVariantBase`] = base;
    update[`flags.${MODULE_ID}.activeTokenVariant`] = variant.id;
    update[`flags.${MODULE_ID}.activeTokenVariantSource`] = options.source || "manual";
    update[`flags.${MODULE_ID}.variantOwnerActorId`] = options.actor?.id || variant.ownerActorId || variantActor?.id || "";

    await tokenDocument.update(update, {
      animate: false,
      khuzoeTokenizer: true,
      khuzoeTokenizerReason: options.reason || "variant-applied"
    });
    Hooks.callAll(`${MODULE_ID}.variantApplied`, tokenDocument, variant, options);
    return true;
  }

  async function restoreTokenVariantBase(tokenDocument, options = {}) {
    if (!tokenDocument) return false;

    const ownerActorId = String(tokenDocument.getFlag(MODULE_ID, "variantOwnerActorId") || "");
    const ownerActor = options.actor || game.actors?.get(ownerActorId) || null;
    const base = tokenDocument.getFlag(MODULE_ID, "tokenVariantBase")
      || (ownerActor ? captureActorTokenVisualState(ownerActor) : captureTokenVisualState(tokenDocument));
    const update = buildTokenVisualUpdate(tokenDocument, base);
    update[`flags.${MODULE_ID}.activeTokenVariant`] = "base";
    update[`flags.${MODULE_ID}.activeTokenVariantSource`] = null;

    await tokenDocument.update(update, {
      animate: false,
      khuzoeTokenizer: true,
      khuzoeTokenizerReason: options.reason || "variant-restored"
    });
    Hooks.callAll(`${MODULE_ID}.variantRestored`, tokenDocument, base, options);
    return true;
  }

  function captureTokenVisualState(tokenDocument) {
    const texture = tokenDocument.texture || {};
    return {
      width: normalizeTokenVariantSize(tokenDocument.width),
      height: normalizeTokenVariantSize(tokenDocument.height),
      texture: cleanTokenTextureState(texture, getActorTokenPath(tokenDocument.actor))
    };
  }

  function captureActorTokenVisualState(actor) {
    const prototypeToken = actor?.prototypeToken || {};
    const texture = prototypeToken.texture || {};
    return {
      width: normalizeTokenVariantSize(prototypeToken.width),
      height: normalizeTokenVariantSize(prototypeToken.height || prototypeToken.width),
      texture: cleanTokenTextureState(texture, getActorTokenPath(actor))
    };
  }

  function cleanTokenTextureState(texture, fallbackSrc = "") {
    return {
      src: stripCacheBust(texture?.src || fallbackSrc || ""),
      scaleX: texture?.scaleX ?? 1,
      scaleY: texture?.scaleY ?? 1,
      offsetX: texture?.offsetX ?? 0,
      offsetY: texture?.offsetY ?? 0,
      rotation: texture?.rotation ?? 0,
      tint: texture?.tint ?? null,
      alphaThreshold: texture?.alphaThreshold ?? undefined
    };
  }

  function buildTokenVisualUpdate(tokenDocument, visualState) {
    const width = normalizeTokenVariantSize(visualState.width);
    const height = normalizeTokenVariantSize(visualState.height || width);
    const grid = getTokenGridDimensions(tokenDocument);
    const centerX = (Number(tokenDocument.x) || 0) + ((Number(tokenDocument.width) || 1) * grid.width / 2);
    const centerY = (Number(tokenDocument.y) || 0) + ((Number(tokenDocument.height) || 1) * grid.height / 2);
    const desiredX = centerX - (width * grid.width / 2);
    const desiredY = centerY - (height * grid.height / 2);
    const snapWidth = grid.width * Math.min(1, width);
    const snapHeight = grid.height * Math.min(1, height);
    const update = {
      width,
      height,
      x: grid.enabled ? snapTokenCoordinate(desiredX, snapWidth, grid.offsetX) : Math.round(desiredX),
      y: grid.enabled ? snapTokenCoordinate(desiredY, snapHeight, grid.offsetY) : Math.round(desiredY)
    };
    // Changing only the artwork or its scale must not move an off-grid token.
    if (width === tokenDocument.width && height === tokenDocument.height) {
      delete update.x;
      delete update.y;
    }

    const texture = visualState.texture || {};
    for (const key of ["src", "scaleX", "scaleY", "offsetX", "offsetY", "rotation", "tint", "alphaThreshold"]) {
      if (texture[key] !== undefined) update[`texture.${key}`] = texture[key];
    }

    return update;
  }
  function getTokenGridDimensions(tokenDocument) {
    const sceneGrid = tokenDocument?.parent?.grid || {};
    const fallback = Number(sceneGrid.size) || Number(canvas?.dimensions?.size) || 100;
    return {
      enabled: Number(sceneGrid.type) !== 0,
      width: Number(sceneGrid.sizeX) || Number(canvas?.grid?.sizeX) || Number(canvas?.grid?.size) || fallback,
      height: Number(sceneGrid.sizeY) || Number(canvas?.grid?.sizeY) || Number(canvas?.grid?.size) || fallback,
      offsetX: Number(sceneGrid.shiftX ?? sceneGrid.offsetX) || 0,
      offsetY: Number(sceneGrid.shiftY ?? sceneGrid.offsetY) || 0
    };
  }

  function snapTokenCoordinate(value, gridSize, offset = 0) {
    const size = Math.max(1, Number(gridSize) || 1);
    const origin = Number(offset) || 0;
    return Math.round((Number(value) - origin) / size) * size + origin;
  }

  function findActorImage(root) {
    const selectors = [
      'img[data-edit="img"]',
      'img[data-edit="prototypeToken.texture.src"]',
      "img.profile",
      ".profile img",
      ".sidebar .portrait > img",
      ".sheet-sidebar .portrait > img",
      ".sheet-header img"
    ];

    for (const selector of selectors) {
      const image = root.querySelector(selector);
      if (image) return image;
    }

    return null;
  }

  function getActorTokenPath(actor) {
    if (!actor) return "";
    const path = foundry.utils.getProperty(actor, "prototypeToken.texture.src")
      || actor?.prototypeToken?.texture?.src
      || "";
    return stripCacheBust(path);
  }

  function stripCacheBustDeep(value) {
    if (typeof value === "string") return stripCacheBust(value);
    if (Array.isArray(value)) return value.map((entry) => stripCacheBustDeep(entry));
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stripCacheBustDeep(entry)])
    );
  }

  async function migrateLegacyCacheBustedPaths() {
    let updatedActors = 0;
    let updatedItems = 0;
    let updatedTokens = 0;
    let failures = 0;

    const recordFailure = (kind, document, error) => {
      failures += 1;
      console.warn(`${MODULE_ID} | Failed to migrate ${kind} ${document?.name || document?.id || "unknown"}`, error);
    };

    for (const actor of game.actors || []) {
      const updates = {};
      const actorImage = String(actor.img || "");
      const cleanActorImage = stripCacheBust(actorImage);
      if (cleanActorImage !== actorImage) updates.img = cleanActorImage;

      const prototypePath = String(
        foundry.utils.getProperty(actor, "prototypeToken.texture.src")
        || actor?.prototypeToken?.texture?.src
        || ""
      );
      const cleanPrototypePath = stripCacheBust(prototypePath);
      if (cleanPrototypePath !== prototypePath) {
        updates["prototypeToken.texture.src"] = cleanPrototypePath;
      }

      const moduleFlags = actor.flags?.[MODULE_ID];
      if (moduleFlags) {
        const cleanModuleFlags = stripCacheBustDeep(moduleFlags);
        if (JSON.stringify(cleanModuleFlags) !== JSON.stringify(moduleFlags)) {
          updates["flags." + MODULE_ID] = cleanModuleFlags;
        }
      }

      if (!Object.keys(updates).length) continue;
      try {
        await actor.update(updates);
        updatedActors += 1;
      } catch (error) {
        recordFailure("actor", actor, error);
      }
    }

    for (const item of game.items || []) {
      const updates = getLegacyDocumentImageUpdates(item);
      if (!Object.keys(updates).length) continue;
      try {
        await item.update(updates);
        updatedItems += 1;
      } catch (error) {
        recordFailure("world item", item, error);
      }
    }

    for (const actor of game.actors || []) {
      const updates = [];
      for (const item of actor.items || []) {
        const update = { _id: item.id, ...getLegacyDocumentImageUpdates(item) };
        if (Object.keys(update).length > 1) updates.push(update);
      }
      if (!updates.length) continue;
      try {
        await actor.updateEmbeddedDocuments("Item", updates);
        updatedItems += updates.length;
      } catch (batchError) {
        console.warn(`${MODULE_ID} | Embedded item migration batch failed for ${actor.name || actor.id}; retrying individually`, batchError);
        for (const update of updates) {
          const { _id, ...changes } = update;
          const item = actor.items?.get?.(_id) || Array.from(actor.items || []).find((entry) => entry.id === _id);
          if (!item) {
            recordFailure("embedded item", { id: _id }, new Error("Document not found"));
            continue;
          }
          try {
            await item.update(changes);
            updatedItems += 1;
          } catch (error) {
            recordFailure("embedded item", item, error);
          }
        }
      }
    }

    for (const scene of game.scenes || []) {
      const updates = [];
      for (const token of scene.tokens || []) {
        const update = { _id: token.id };
        const tokenPath = String(token.texture?.src || "");
        const cleanTokenPath = stripCacheBust(tokenPath);
        if (cleanTokenPath !== tokenPath) update["texture.src"] = cleanTokenPath;

        const moduleFlags = token.flags?.[MODULE_ID];
        if (moduleFlags) {
          const cleanModuleFlags = stripCacheBustDeep(moduleFlags);
          if (JSON.stringify(cleanModuleFlags) !== JSON.stringify(moduleFlags)) {
            update["flags." + MODULE_ID] = cleanModuleFlags;
          }
        }

        if (Object.keys(update).length > 1) updates.push(update);
      }

      if (!updates.length) continue;
      try {
        await scene.updateEmbeddedDocuments("Token", updates, { animate: false });
        updatedTokens += updates.length;
      } catch (batchError) {
        console.warn(`${MODULE_ID} | Token migration batch failed for ${scene.name || scene.id}; retrying individually`, batchError);
        for (const update of updates) {
          const { _id, ...changes } = update;
          const token = scene.tokens?.get?.(_id) || Array.from(scene.tokens || []).find((entry) => entry.id === _id);
          if (!token) {
            recordFailure("scene token", { id: _id }, new Error("Document not found"));
            continue;
          }
          try {
            await token.update(changes, { animate: false });
            updatedTokens += 1;
          } catch (error) {
            recordFailure("scene token", token, error);
          }
        }
      }
    }

    if (updatedActors || updatedItems || updatedTokens) {
      console.info(MODULE_ID + " | Normalized image paths for " + updatedActors + " actors, "
        + updatedItems + " items, and " + updatedTokens + " scene tokens");
    }
    return { updatedActors, updatedItems, updatedTokens, failures };
  }

  function getLegacyDocumentImageUpdates(document) {
    const updates = {};
    const imagePath = String(document?.img || "");
    const cleanImagePath = stripCacheBust(imagePath);
    if (cleanImagePath !== imagePath) updates.img = cleanImagePath;

    const moduleFlags = document?.flags?.[MODULE_ID];
    if (moduleFlags) {
      const cleanModuleFlags = stripCacheBustDeep(moduleFlags);
      if (JSON.stringify(cleanModuleFlags) !== JSON.stringify(moduleFlags)) {
        updates["flags." + MODULE_ID] = cleanModuleFlags;
      }
    }
    return updates;
  }
  function isStoredTokenEditCurrent(actor, stored = {}) {
    const tokenPath = getActorTokenPath(actor);
    const storedPath = stripCacheBust(stored?.path || "");
    if (!tokenPath || !storedPath || tokenPath !== storedPath) return false;

    const storedSourcePaths = [
      String(stored?.sourcePath || ""),
      ...(Array.isArray(stored?.layers) ? stored.layers.map((layer) => String(layer?.sourcePath || layer?.path || "")) : [])
    ].filter(Boolean);
    const variantPaths = new Set(getActorTokenVariants(actor).map((variant) => variant.src).filter(Boolean));
    const usesSavedVariantAsSource = storedSourcePaths.some((path) => (
      path !== tokenPath && (variantPaths.has(path) || fileNameFromPath(path).startsWith("token-variant-"))
    ));
    return !usesSavedVariantAsSource;
  }

  function isStoredAvatarEditCurrent(actor, stored = {}) {
    const avatarPath = stripCacheBust(actor?.img || "");
    const storedPath = stripCacheBust(stored?.path || "");
    return Boolean(avatarPath && storedPath && avatarPath === storedPath);
  }

  function getActorTokenWidth(actor) {
    if (!actor) return 1;
    return normalizeTokenVariantSize(foundry.utils.getProperty(actor, "prototypeToken.width") || actor?.prototypeToken?.width || 1);
  }

  function getActorTokenHeight(actor) {
    if (!actor) return 1;
    return normalizeTokenVariantSize(foundry.utils.getProperty(actor, "prototypeToken.height") || actor?.prototypeToken?.height || getActorTokenWidth(actor));
  }

  function tokenStateMatchesBaseImage(state, baseImage) {
    if (!state || !baseImage) return false;

    const size = 96;
    const rendered = document.createElement("canvas");
    const expected = document.createElement("canvas");
    rendered.width = expected.width = size;
    rendered.height = expected.height = size;

    drawTarget(rendered.getContext("2d"), state, size, size, { guides: false });
    drawTarget(expected.getContext("2d"), {
      target: "token",
      image: baseImage,
      visible: true,
      mode: "fit",
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      frame: createFrameState(),
      layers: [],
      layerOrder: ["base"],
      background: createBackgroundState()
    }, size, size, { guides: false });

    try {
      const actualPixels = rendered.getContext("2d").getImageData(0, 0, size, size).data;
      const expectedPixels = expected.getContext("2d").getImageData(0, 0, size, size).data;
      let totalDifference = 0;
      let changedPixels = 0;
      const pixelCount = size * size;

      for (let index = 0; index < actualPixels.length; index += 4) {
        const difference = (
          Math.abs(actualPixels[index] - expectedPixels[index])
          + Math.abs(actualPixels[index + 1] - expectedPixels[index + 1])
          + Math.abs(actualPixels[index + 2] - expectedPixels[index + 2])
          + Math.abs(actualPixels[index + 3] - expectedPixels[index + 3])
        ) / 4;
        totalDifference += difference;
        if (difference > 24) changedPixels += 1;
      }

      return (totalDifference / pixelCount) <= 6 && (changedPixels / pixelCount) <= 0.04;
    } catch (error) {
      return false;
    }
  }

  function drawTarget(context, state, frameWidth, frameHeight, options = {}) {
    if (!state || !hasRenderableStateImage(state)) return;

    const hasFrame = state.target === "token" && state.frame?.enabled && state.frame?.image;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const drawContent = () => {
      drawFlatBackground(context, state, frameWidth, frameHeight);
      for (const layer of getLayerRows(state)) drawImageLayer(context, layer, state, frameWidth, frameHeight);
    };

    if (hasFrame) {
      const clipMode = normalizeFrameClipMode(state.frame.clipMode);
      context.save();
      if (clipMode !== "free") {
        const radius = getFrameOuterRadius(state.frame, frameWidth, frameHeight);
        context.beginPath();
        context.arc(frameWidth / 2, frameHeight / 2, radius, 0, Math.PI * 2);
        context.clip();
      }
      drawContent();
      context.restore();
      drawTokenFrameImage(context, state.frame.image, frameWidth, frameHeight);
    } else {
      drawContent();
    }

    if (options.guides && state.target === "token" && !hasFrame) {
      context.save();
      context.strokeStyle = "rgba(255,255,255,0.8)";
      context.lineWidth = 1;
      context.setLineDash([6, 6]);
      context.beginPath();
      context.arc(frameWidth / 2, frameHeight / 2, Math.min(frameWidth, frameHeight) * 0.42, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  function drawFlatBackground(context, state, frameWidth, frameHeight) {
    if (!state.background?.enabled) return;
    context.save();
    context.fillStyle = normalizeColor(state.background.color, "#000000");
    context.fillRect(0, 0, frameWidth, frameHeight);
    context.restore();
  }

  function drawImageLayer(context, layer, ownerState, frameWidth, frameHeight) {
    if (!layer?.image || layer.visible === false) return;
    const rect = getImageRect(layer, frameWidth, frameHeight, layer.zoom, ownerState);
    context.drawImage(layer.image, rect.x, rect.y, rect.width, rect.height);
  }

  function drawTokenFrameImage(context, image, frameWidth, frameHeight) {
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, frameWidth, frameHeight);
    context.restore();
  }

  function getFrameOuterRadius(frame, frameWidth, frameHeight) {
    const ratio = frame?.geometry?.outerRatio ?? 0.5;
    return Math.min(frameWidth, frameHeight) * clamp(ratio, 0.2, 0.5);
  }


  function getImageRect(state, frameWidth, frameHeight, zoom, ownerState = state) {
    const image = state.image;
    const imageWidth = image.naturalWidth || image.width || 1;
    const imageHeight = image.naturalHeight || image.height || 1;
    const bounds = getImageFitBounds(ownerState, frameWidth, frameHeight);
    const scaleX = bounds.width / imageWidth;
    const scaleY = bounds.height / imageHeight;
    const baseScale = state.mode === "fit" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    const scale = baseScale * zoom;
    const width = imageWidth * scale;
    const height = imageHeight * scale;

    return {
      x: ((frameWidth - width) / 2) + (state.offsetX * frameWidth),
      y: ((frameHeight - height) / 2) + (state.offsetY * frameHeight),
      width,
      height
    };
  }

  function getImageFitBounds(state, frameWidth, frameHeight) {
    if (state.target === "token" && state.frame?.enabled && (state.frame.src || state.frame.image)) {
      const diameter = getFrameOuterRadius(state.frame, frameWidth, frameHeight) * 2;
      return { width: diameter, height: diameter };
    }
    return { width: frameWidth, height: frameHeight };
  }

  function getImageAspect(image) {
    const width = image?.naturalWidth || image?.width || 1;
    const height = image?.naturalHeight || image?.height || 1;
    return width / height;
  }

  function getTokenOutputSize(state) {
    const configuredSize = Math.round(Number(game.settings.get(MODULE_ID, "tokenSize")) || 1024);
    const sourceSize = getImageMaxDimension(state.image);
    const layerSize = Math.max(0, ...(state.layers || []).map((layer) => getImageMaxDimension(layer.image)));
    const frameSize = state.frame?.enabled ? getImageMaxDimension(state.frame.image) : 0;
    return clamp(Math.max(configuredSize, sourceSize, layerSize, frameSize, 1024), 1024, 4096);
  }

  function getImageMaxDimension(image) {
    if (!image) return 0;
    return Math.max(image.naturalWidth || image.width || 0, image.naturalHeight || image.height || 0);
  }

  function normalizeFrameClipMode(value) {
    return ["outer", "free"].includes(value) ? value : DEFAULT_FRAME.clipMode;
  }

  function createFrameState(data = {}) {
    return {
      enabled: Boolean(data.enabled),
      name: String(data.name || ""),
      src: stripCacheBust(data.src || data.path || ""),
      clipMode: normalizeFrameClipMode(data.clipMode),
      image: data.image || null,
      geometry: data.geometry || null,
      loading: Boolean(data.loading)
    };
  }

  function cleanFrameState(frame) {
    const state = createFrameState(frame || DEFAULT_FRAME);
    return {
      enabled: state.enabled,
      name: state.name,
      src: state.src,
      clipMode: state.clipMode
    };
  }

  function createLayerState(data = {}, target = "token") {
    return {
      target,
      id: String(data.id || generateLayerId()),
      name: String(data.name || data.sourceName || ""),
      image: data.image || null,
      sourceName: String(data.sourceName || data.name || ""),
      sourcePath: String(data.sourcePath || data.path || ""),
      mode: data.mode || "fit",
      zoom: Number(data.zoom) || 1,
      offsetX: Number(data.offsetX) || 0,
      offsetY: Number(data.offsetY) || 0,
      visible: data.visible !== false,
      loading: Boolean(data.loading)
    };
  }

  function cleanLayerState(layer) {
    const state = createLayerState(layer, layer.target || "token");
    return {
      id: state.id,
      name: state.name,
      sourceName: state.sourceName,
      sourcePath: state.sourcePath,
      mode: state.mode,
      zoom: state.zoom,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
      visible: state.visible
    };
  }

  function createBackgroundState(data = {}) {
    return {
      enabled: Boolean(data.enabled),
      color: normalizeColor(data.color, "#000000")
    };
  }

  function cleanBackgroundState(background) {
    const state = createBackgroundState(background);
    return {
      enabled: state.enabled,
      color: state.color
    };
  }

  function cloneTargetState(state) {
    if (!state) return null;
    return {
      target: state.target,
      image: state.image || null,
      sourceName: state.sourceName || "",
      sourcePath: state.sourcePath || "",
      outputPath: state.outputPath || "",
      mode: state.mode || "fit",
      zoom: Number(state.zoom) || 1,
      offsetX: Number(state.offsetX) || 0,
      offsetY: Number(state.offsetY) || 0,
      aspect: Number(state.aspect) || (state.target === "token" ? 1 : 0.75),
      visible: state.visible !== false,
      dirty: Boolean(state.dirty),
      loading: false,
      frame: state.frame ? createFrameState(state.frame) : null,
      layers: (state.layers || []).map((layer) => createLayerState(layer, state.target)),
      activeLayerId: state.activeLayerId || "base",
      layerOrder: [...(state.layerOrder || [])],
      background: createBackgroundState(state.background)
    };
  }
  function getActiveLayer(state) {
    return getLayerById(state, state?.activeLayerId) || getLayerRows(state)[0] || state;
  }

  function getLayerById(state, layerId) {
    if (!state) return null;
    const id = layerId || "base";
    if (id === "base") return hasBaseLayer(state) ? state : null;
    return (state.layers || []).find((layer) => layer.id === id) || null;
  }

  function getLayerRows(state) {
    if (!state) return [];
    const order = normalizeLayerOrder(state.layerOrder, state.layers || [], hasBaseLayer(state));
    state.layerOrder = order;
    return order
      .map((id) => {
        if (id === "base") {
          state.id = "base";
          state.name = game.i18n.localize(`${MODULE_ID}.labels.baseLayer`);
          return state;
        }
        return (state.layers || []).find((layer) => layer.id === id) || null;
      })
      .filter(Boolean);
  }

  function getLayerDisplayName(layer) {
    if (!layer) return "";
    return layer.sourceName || layer.name || fileNameFromPath(layer.sourcePath || "");
  }

  function hasBaseLayer(state) {
    return Boolean(state?.image || state?.sourceName || state?.sourcePath || (state?.layerOrder || []).includes("base"));
  }

  function getFirstLayerId(state) {
    return getLayerRows(state)[0]?.id || "";
  }

  function normalizeLayerOrder(order = [], layers = [], includeBase = true) {
    const valid = new Set(layers.map((layer) => layer.id));
    if (includeBase) valid.add("base");
    const normalized = [];

    for (const id of order || []) {
      const value = String(id || "");
      if (!valid.has(value) || normalized.includes(value)) continue;
      normalized.push(value);
    }

    if (includeBase && !normalized.includes("base")) normalized.unshift("base");
    for (const layer of layers) {
      if (!normalized.includes(layer.id)) normalized.push(layer.id);
    }

    return normalized;
  }

  function addLayerToOrder(order = [], layerId) {
    const id = String(layerId || "");
    if (!id) return order || [];
    return (order || []).includes(id) ? order : [...(order || []), id];
  }

  function removeLayerFromOrder(order = [], layerId) {
    const id = String(layerId || "");
    return (order || []).filter((candidate) => candidate !== id);
  }

  function hasRenderableStateImage(state) {
    if (!state) return false;
    if (state.image && state.visible !== false) return true;
    if ((state.layers || []).some((layer) => layer.image && layer.visible !== false)) return true;
    return Boolean(state.background?.enabled);
  }

  function normalizeColor(value, fallback = "#000000") {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function getTokenAvatar(tokenDocument) {
    const token = tokenDocument?.document || tokenDocument;
    const activeId = String(token?.getFlag?.(MODULE_ID, "activeTokenVariant") || "base");
    if (activeId !== "base") {
      const ownerId = token?.getFlag?.(MODULE_ID, "variantOwnerActorId");
      const catalogActor = (ownerId && game.actors?.get?.(ownerId)) || token?.actor;
      const variant = getActorTokenVariants(catalogActor).find((entry) => entry.id === activeId);
      if (variant?.avatarSrc) return variant.avatarSrc;
    }
    return String(token?.actor?.img || "");
  }

  function chooseVariantAvatar(actor, variantId, callback) {
    const variant = getActorTokenVariants(actor).find((entry) => entry.id === variantId);
    if (!variant || !isEditableTokenVariant(variant) || (!game.user?.isGM && !actor?.isOwner)) return;
    openFilePicker({ type: "image", current: variant.avatarSrc || actor.img || "", callback });
  }

  async function saveActorVariantAvatar(actor, variantId, source) {
    if (!actor || (!game.user?.isGM && !actor.isOwner)) throw createUserFacingError(`${MODULE_ID}.notifications.variantAvatarDenied`);
    const original = getActorTokenVariants(actor).find((entry) => entry.id === variantId);
    if (!original || !isEditableTokenVariant(original)) throw createUserFacingError(`${MODULE_ID}.notifications.managedVariant`);
    const avatarSrc = source ? await uploadVariantAvatarSource(actor, source, variantId) : "";
    // Re-read after the upload so concurrent metadata edits are not overwritten.
    const variants = getActorTokenVariants(actor);
    const variant = variants.find((entry) => entry.id === variantId);
    if (!variant || !isEditableTokenVariant(variant) || (!game.user?.isGM && !actor.isOwner)) throw createUserFacingError(`${MODULE_ID}.notifications.variantAvatarDenied`);
    variant.avatarSrc = stripCacheBust(avatarSrc);
    variant.updatedAt = new Date().toISOString();
    await actor.setFlag(MODULE_ID, "tokenVariants", variants.map(cleanTokenVariant));
    await emitTokenizerSaved(actor, { reason: "variant-avatar-updated", variantsChanged: true });
    refreshOpenTokenVariantViews(actor);
    return variant.avatarSrc;
  }

  function getActorTokenVariants(actor) {
    const variants = actor?.getFlag(MODULE_ID, "tokenVariants") || [];
    return Array.isArray(variants)
      ? variants.map((variant) => createTokenVariant(variant)).filter((variant) => variant.src)
      : [];
  }

  function isEditableTokenVariant(variant) {
    if (!variant) return false;
    const source = String(variant?.source || "manual");
    return source === "manual" || source === LEGACY_TOKEN_SWITCHER_SOURCE;
  }

  async function replaceActorTokenVariants(actor, payload = {}) {
    if (!actor?.setFlag) return false;
    const current = getActorTokenVariants(actor);
    const existingById = new Map(current.map((variant) => [variant.id, variant]));
    const now = new Date().toISOString();
    const incoming = (Array.isArray(payload.variants) ? payload.variants : [])
      .map((variant) => createTokenVariant({
        ...variant,
        scale: variant.scale === undefined ? existingById.get(String(variant.id))?.scale : variant.scale,
        avatarSrc: variant.avatarSrc === undefined ? existingById.get(String(variant.id))?.avatarSrc : variant.avatarSrc,
        source: "manual",
        createdAt: variant.createdAt || now,
        updatedAt: variant.updatedAt || now
      }))
      .filter((variant) => variant.id && variant.src);
    if (JSON.stringify(current.map(comparableTokenVariant)) === JSON.stringify(incoming.map(comparableTokenVariant))) return false;
    await actor.setFlag(MODULE_ID, "tokenVariants", incoming.map(cleanTokenVariant));
    await synchronizePlacedTokenVariants(actor, incoming);
    refreshOpenTokenVariantViews(actor);
    Hooks.callAll(`${MODULE_ID}.variantsSynchronized`, actor, {
      source: String(payload.source || "managed-actor"),
      variants: incoming.map(cleanTokenVariant),
      revision: Number(payload.revision || 0)
    });
    return true;
  }

  async function syncActorTokenVariants(actor, payload = {}) {
    if (!actor?.update) return false;
    const source = String(payload.source || "external").trim() || "external";
    const current = getActorTokenVariants(actor);
    const existingById = new Map(current.map((variant) => [variant.id, variant]));
    const incoming = (Array.isArray(payload.variants) ? payload.variants : [])
      .map((variant) => {
        const id = String(variant?.id || "");
        const previous = existingById.get(id);
        return createTokenVariant({
          ...variant,
          scale: variant.scale === undefined ? previous?.scale : variant.scale,
          avatarSrc: variant.avatarSrc === undefined ? previous?.avatarSrc : variant.avatarSrc,
          source,
          createdAt: previous?.createdAt || variant?.createdAt,
          updatedAt: previous?.updatedAt || variant?.updatedAt
        });
      })
      .filter((variant) => variant.id && variant.src);

    const next = [
      ...current.filter((variant) => variant.source !== source),
      ...incoming
    ];
    const previousComparable = current.map(comparableTokenVariant);
    const nextComparable = next.map(comparableTokenVariant);

    const manifests = foundry.utils.deepClone(actor.getFlag(MODULE_ID, "variantManifests") || {});
    const nextManifest = {
      actorId: String(payload.actorId || actor.id || ""),
      source,
      base: cleanTokenVariantBaseManifest(payload.base),
      variants: incoming.map((variant) => ({
        id: variant.id,
        revision: variant.revision
      }))
    };
    const manifestChanged = JSON.stringify(manifests[source] || null) !== JSON.stringify(nextManifest);
    const variantsChanged = JSON.stringify(previousComparable) !== JSON.stringify(nextComparable);
    if (!manifestChanged && !variantsChanged) return false;

    if (manifestChanged) manifests[source] = nextManifest;
    const now = new Date().toISOString();
    const storedVariants = next.map((variant) => {
      const previous = existingById.get(variant.id);
      const unchanged = previous && JSON.stringify(comparableTokenVariant(previous)) === JSON.stringify(comparableTokenVariant(variant));
      return cleanTokenVariant({
        ...variant,
        createdAt: previous?.createdAt || variant.createdAt || now,
        updatedAt: unchanged ? previous.updatedAt : now
      });
    });

    await actor.update({
      [`flags.${MODULE_ID}.tokenVariants`]: storedVariants,
      [`flags.${MODULE_ID}.variantManifests`]: manifests
    }, {
      khuzoeTokenizer: true,
      khuzoeTokenizerReason: "variants-synchronized"
    });
    await synchronizePlacedTokenVariants(actor, storedVariants);
    refreshOpenTokenVariantViews(actor);
    Hooks.callAll(`${MODULE_ID}.variantsSynchronized`, actor, {
      source,
      base: nextManifest.base,
      variants: storedVariants.filter((variant) => variant.source === source)
    });
    return true;
  }

  function cleanTokenVariantBaseManifest(base) {
    if (!base || typeof base !== "object") return null;
    return {
      image: String(base.image || base.src || ""),
      revision: normalizeTokenVariantRevision(base.revision)
    };
  }

  function comparableTokenVariant(variant) {
    const clean = cleanTokenVariant(variant);
    delete clean.createdAt;
    delete clean.updatedAt;
    return clean;
  }

  function refreshOpenTokenVariantViews(actor, sourceApp = null) {
    if (!actor) return;
    for (const app of openApplications()) {
      if (!app || app === sourceApp || app.actor?.id !== actor.id) continue;
      if (app instanceof KhuzoeTokenizerApp) {
        const editingVariant = getActorTokenVariants(actor).find((variant) => variant.id === app._editingTokenVariantId);
        if (editingVariant) app._setVariantFormValues(editingVariant.name, editingVariant.width, editingVariant.scale);
        app._syncVariantControls();
        continue;
      }
      if (app instanceof KhuzoeTokenVariantSelectorApp || app instanceof KhuzoeTokenVariantManagerApp) {
        renderApplication(app);
      }
    }
  }

  function createTokenVariant(data = {}) {
    const size = normalizeTokenVariantSize(data.size || data.width || 1);
    return {
      id: String(data.id || generateVariantId()),
      name: String(data.name || fileNameWithoutExtension(data.src || data.image || "") || "Token"),
      src: stripCacheBust(data.src || data.path || data.image || ""),
      avatarSrc: typeof data.avatarSrc === "string" ? stripCacheBust(data.avatarSrc.trim()) : "",
      remoteImage: String(data.remoteImage || data.remote || ""),
      revision: normalizeTokenVariantRevision(data.revision || data.imageRevision),
      width: normalizeTokenVariantSize(data.width || size),
      height: normalizeTokenVariantSize(data.height || size),
      scale: Number.isNaN(parseVariantScale(data.scale)) ? null : parseVariantScale(data.scale),
      source: String(data.source || "manual"),
      ownerActorId: String(data.ownerActorId || ""),
      matchNames: normalizeTokenVariantStringList(data.matchNames || data.names),
      matchActorIds: normalizeTokenVariantStringList(data.matchActorIds || data.actorIds),
      createdAt: String(data.createdAt || new Date().toISOString()),
      updatedAt: String(data.updatedAt || data.createdAt || new Date().toISOString())
    };
  }

  function cleanTokenVariant(variant) {
    return createTokenVariant(variant);
  }

  function normalizeTokenVariantStringList(value) {
    return Array.from(new Set((Array.isArray(value) ? value : []).map((entry) => String(entry || "").trim()).filter(Boolean)));
  }

  function normalizeTokenVariantRevision(value) {
    const revision = Math.floor(Number(value));
    return Number.isFinite(revision) && revision > 0 ? revision : 1;
  }

  function normalizeTokenVariantSize(value) {
    const size = parseDecimal(value);
    const normalized = Number.isFinite(size) && size > 0 ? Math.round(size * 4) / 4 : 1;
    return clamp(normalized, TOKEN_VARIANT_MIN_SIZE, TOKEN_VARIANT_MAX_SIZE);
  }

  function generateVariantId() {
    return `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function generateLayerId() {
    return `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function getFrameChoices(selectedSrc = "") {
    const directory = getFrameDirectory();
    try {
      const browse = await filePickerClass().browse(DATA_SOURCE, directory);
      return (browse.files || [])
        .filter((path) => isImagePath(path))
        .sort((a, b) => fileNameFromPath(a).localeCompare(fileNameFromPath(b)))
        .map((path) => ({
          src: path,
          name: fileNameWithoutExtension(path),
          selected: stripCacheBust(path) === stripCacheBust(selectedSrc)
        }));
    } catch (_error) {
      return [];
    }
  }

  function getFrameDirectory() {
    return sanitizeDirectory(game.settings.get(MODULE_ID, "frameDirectory") || `${MODULE_ID}/frames`);
  }

  async function ensureFrameDirectory() {
    const directory = getFrameDirectory();
    if (await directoryExists(DATA_SOURCE, directory)) return directory;
    if (game.user?.isGM) {
      await ensureDirectoryRecursive(DATA_SOURCE, directory);
      return directory;
    }
    if (pendingFrameDirectoryEnsure) return pendingFrameDirectoryEnsure;
    pendingFrameDirectoryEnsure = requestFrameDirectoryFromGm()
      .then(() => directory)
      .finally(() => { pendingFrameDirectoryEnsure = null; });
    return pendingFrameDirectoryEnsure;
  }

  function analyzeFrameGeometry(image) {
    const canvas = imageToCanvas(image);
    const context = canvas.getContext("2d");
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const centerX = width / 2;
    const centerY = height / 2;
    const base = Math.min(width, height);
    let minDistance = Infinity;
    let maxDistance = 0;

    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 24) continue;
      const pixel = (index - 3) / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const distance = Math.hypot(x - centerX, y - centerY);
      minDistance = Math.min(minDistance, distance);
      maxDistance = Math.max(maxDistance, distance);
    }

    if (!Number.isFinite(minDistance) || maxDistance <= 0) {
      return getDefaultFrameGeometry();
    }

    return {
      innerRatio: clamp(minDistance / base, 0.2, 0.5),
      outerRatio: clamp(maxDistance / base, 0.2, 0.5)
    };
  }

  function safeAnalyzeFrameGeometry(image) {
    try {
      return analyzeFrameGeometry(image);
    } catch (error) {
      console.warn(`${MODULE_ID} | Frame geometry analysis failed`, error);
      return getDefaultFrameGeometry();
    }
  }

  function getDefaultFrameGeometry() {
    return {
      innerRatio: 0.42,
      outerRatio: 0.5
    };
  }

  function imageToCanvas(image) {
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function getImageFile(dataTransfer) {
    return getImageFiles(dataTransfer)[0] || null;
  }

  function getImageFiles(dataTransfer) {
    if (!dataTransfer) return [];

    const files = Array.from(dataTransfer.files || []).filter((candidate) => isImageFile(candidate));
    if (files.length) return files;

    return Array.from(dataTransfer.items || [])
      .filter((item) => item.kind === "file" && item.type?.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file) => isImageFile(file));
  }

  function getDroppedPath(dataTransfer) {
    if (!dataTransfer) return "";

    const raw = dataTransfer.getData("text/uri-list")
      || dataTransfer.getData("text/plain")
      || "";
    const text = raw.trim();
    if (!text) return "";

    try {
      const parsed = JSON.parse(text);
      return parsed.path || parsed.src || parsed.texture?.src || "";
    } catch (_error) {
      return text;
    }
  }

  function isImageFile(file) {
    if (!file) return false;
    if (file.type?.startsWith("image/")) return true;
    return isImagePath(file.name || "");
  }

  function isImagePath(path) {
    return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(stripCacheBust(path).split(/[?#]/)[0]);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (!src.startsWith("data:")) image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load image: ${src}`));
      image.src = src;
    });
  }

  function canvasToWebpBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("The browser could not encode this image as WebP."));
          return;
        }
        resolve(blob);
      }, "image/webp", quality);
    });
  }

  async function hashBlob(blob) {
    if (!globalThis.crypto?.subtle) return foundry.utils.randomID(32).toLowerCase();
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }

  async function uploadVariantAvatarSource(actor, src, variantId) {
    const image = await loadImage(src);
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    const limit = clamp(Math.round(Number(game.settings.get(MODULE_ID, "avatarMaxDimension")) || 1024), 128, 4096);
    const scale = Math.min(1, limit / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToWebpBlob(canvas, getWebpQuality());
    const directory = await ensureActorOutputDirectory(actor);
    return uploadBlob(directory, `avatar-variant-${sanitizeSegment(variantId)}-${await hashBlob(blob)}.webp`, blob);
  }

  async function uploadTokenVariantSource(actor, src, sourceName = "", variantId = generateVariantId()) {
    if (!actor || !src) throw new Error("Missing Actor or token variant source.");

    const image = await loadImage(src);
    const configuredSize = Math.round(Number(game.settings.get(MODULE_ID, "tokenSize")) || 1024);
    const sourceSize = getImageMaxDimension(image);
    const size = clamp(Math.max(1024, configuredSize, sourceSize), 1024, 4096);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext("2d");
    const imageWidth = image.naturalWidth || image.width || 1;
    const imageHeight = image.naturalHeight || image.height || 1;
    const scale = Math.min(size / imageWidth, size / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

    const actorDirectory = await ensureActorOutputDirectory(actor);

    const blob = await canvasToWebpBlob(canvas, getWebpQuality());
    const imageHash = await hashBlob(blob);
    const fileName = `token-variant-${sanitizeSegment(variantId)}-${imageHash}.webp`;
    return uploadBlob(actorDirectory, fileName, blob);
  }
  async function uploadBlob(directory, fileName, blob) {
    const file = new File([blob], fileName, { type: "image/webp" });
    const response = await filePickerClass().upload(DATA_SOURCE, directory, file, {}, { notify: false });
    const uploadedPath = stripCacheBust(response?.path || "");
    if (!uploadedPath) {
      throw createUserFacingError(`${MODULE_ID}.notifications.uploadFailed`);
    }
    if (!(await dataFileExists(uploadedPath))) {
      throw createUserFacingError(`${MODULE_ID}.notifications.uploadVerificationFailed`);
    }
    return uploadedPath;
  }

  async function ensureDirectoryRecursive(source, directory) {
    const parts = sanitizeDirectory(directory).split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await directoryExists(source, current)) continue;

      try {
        await filePickerClass().createDirectory(source, current, { notify: false });
      } catch (error) {
        if (!(await directoryExists(source, current))) throw error;
      }
    }
  }

  function getActorOutputDirectory(actor) {
    const baseDirectory = sanitizeDirectory(game.settings.get(MODULE_ID, "outputDirectory"));
    return `${baseDirectory}/${getActorDirectorySegment(actor)}`;
  }

  function getActorDirectorySegment(actor) {
    const actorId = sanitizeSegment(actor?.id || "actor");
    const actorName = sanitizeSegment(actor?.name || "actor");
    const maxNameLength = Math.max(1, 60 - actorId.length - 1);
    const compactName = actorName.slice(0, maxNameLength).replace(/-+$/g, "") || "actor";
    return `${compactName}-${actorId}`;
  }

  async function ensureActorOutputDirectory(actor) {
    if (!actor?.id) throw createUserFacingError(`${MODULE_ID}.notifications.directoryInvalidActor`);

    const directory = getActorOutputDirectory(actor);
    if (await directoryExists(DATA_SOURCE, directory)) return directory;

    if (game.user.isGM) {
      await ensureDirectoryRecursive(DATA_SOURCE, directory);
      return directory;
    }

    const requestKey = `${actor.id}:${directory}`;
    const existingRequest = pendingActorDirectoryEnsures.get(requestKey);
    if (existingRequest) return existingRequest;

    const request = requestActorDirectoryFromGm(actor)
      .then(() => directory)
      .finally(() => pendingActorDirectoryEnsures.delete(requestKey));

    pendingActorDirectoryEnsures.set(requestKey, request);
    return request;
  }

  function initializeDirectorySocket() {
    game.socket.on(SOCKET_NAME, (message, senderUserId) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "directory-response" || message.type === "frame-directory-response") {
        resolveDirectoryRequest(message, senderUserId);
        return;
      }

      if (message.type === "directory-request") {
        void handleDirectoryRequestAsGm(message, senderUserId);
        return;
      }

      if (message.type === "frame-directory-request") {
        void handleFrameDirectoryRequestAsGm(message, senderUserId);
      }
    });
  }

  function getActiveDirectoryGm() {
    const activeGms = (game.users?.filter((user) => user.active && user.isGM) || [])
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return activeGms[0] || null;
  }

  function requestActorDirectoryFromGm(actor) {
    const gm = getActiveDirectoryGm();
    if (!gm) {
      return Promise.reject(createUserFacingError(`${MODULE_ID}.notifications.directoryNoGm`));
    }

    const requestId = foundry.utils.randomID(24);

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingDirectoryRequests.delete(requestId);
        reject(createUserFacingError(`${MODULE_ID}.notifications.directoryTimeout`));
      }, DIRECTORY_REQUEST_TIMEOUT_MS);

      pendingDirectoryRequests.set(requestId, { resolve, reject, timeout, gmUserId: gm.id });

      try {
        game.socket.emit(SOCKET_NAME, {
          type: "directory-request",
          requestId,
          actorId: actor.id,
          requesterUserId: game.user.id,
          gmUserId: gm.id
        });
      } catch (error) {
        window.clearTimeout(timeout);
        pendingDirectoryRequests.delete(requestId);
        reject(createUserFacingError(`${MODULE_ID}.notifications.directoryCreationFailed`, error));
      }
    });
  }

  function requestFrameDirectoryFromGm() {
    const gm = getActiveDirectoryGm();
    if (!gm) return Promise.reject(createUserFacingError(`${MODULE_ID}.notifications.directoryNoGm`));
    const requestId = foundry.utils.randomID(24);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingDirectoryRequests.delete(requestId);
        reject(createUserFacingError(`${MODULE_ID}.notifications.directoryTimeout`));
      }, DIRECTORY_REQUEST_TIMEOUT_MS);
      pendingDirectoryRequests.set(requestId, { resolve, reject, timeout, gmUserId: gm.id });
      try {
        game.socket.emit(SOCKET_NAME, {
          type: "frame-directory-request",
          requestId,
          requesterUserId: game.user.id,
          gmUserId: gm.id
        });
      } catch (error) {
        window.clearTimeout(timeout);
        pendingDirectoryRequests.delete(requestId);
        reject(createUserFacingError(`${MODULE_ID}.notifications.directoryCreationFailed`, error));
      }
    });
  }

  async function handleDirectoryRequestAsGm(message, senderUserId) {
    if (!game.user.isGM || message.gmUserId !== game.user.id) return;
    if (!message.requestId || !message.actorId || !message.requesterUserId) return;
    if (!senderUserId || senderUserId !== message.requesterUserId) return;

    const actor = game.actors?.get(message.actorId);
    const requester = game.users?.get(message.requesterUserId);
    let ok = false;
    let errorCode = "creation-failed";

    try {
      const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      if (!actor || !requester || !actor.testUserPermission(requester, ownerLevel)) {
        errorCode = "unauthorized";
      } else {
        const directory = getActorOutputDirectory(actor);
        await ensureDirectoryRecursive(DATA_SOURCE, directory);
        if (!(await directoryExists(DATA_SOURCE, directory))) {
          throw new Error(`Tokenizer directory was not created: ${directory}`);
        }
        ok = true;
        errorCode = "";
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Automatic GM directory creation failed`, error);
    }

    game.socket.emit(SOCKET_NAME, {
      type: "directory-response",
      requestId: message.requestId,
      requesterUserId: message.requesterUserId,
      gmUserId: game.user.id,
      ok,
      errorCode
    });
  }

  async function handleFrameDirectoryRequestAsGm(message, senderUserId) {
    if (!game.user?.isGM || message.gmUserId !== game.user.id || !message.requestId) return;
    if (!senderUserId || senderUserId !== message.requesterUserId) return;
    const requester = game.users?.get(senderUserId);
    let ok = false;
    let errorCode = "creation-failed";
    try {
      if (!requester || requester.can?.("FILES_UPLOAD") !== true) {
        errorCode = "denied";
      } else {
        const directory = getFrameDirectory();
        await ensureDirectoryRecursive(DATA_SOURCE, directory);
        ok = await directoryExists(DATA_SOURCE, directory);
        if (!ok) throw new Error(`Frame directory was not created: ${directory}`);
        errorCode = "";
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Automatic frame directory creation failed`, error);
    }
    game.socket.emit(SOCKET_NAME, {
      type: "frame-directory-response",
      requestId: message.requestId,
      requesterUserId: message.requesterUserId,
      gmUserId: game.user.id,
      ok,
      errorCode
    });
  }

  function resolveDirectoryRequest(message, senderUserId) {
    if (message.requesterUserId !== game.user.id || !message.requestId) return;
    const pending = pendingDirectoryRequests.get(message.requestId);
    if (!pending || message.gmUserId !== pending.gmUserId) return;
    if (!game.users?.get(senderUserId)?.isGM || senderUserId !== message.gmUserId) return;

    window.clearTimeout(pending.timeout);
    pendingDirectoryRequests.delete(message.requestId);

    if (message.ok) {
      pending.resolve();
      return;
    }

    const keyByCode = {
      denied: `${MODULE_ID}.notifications.directoryDenied`,
      unauthorized: `${MODULE_ID}.notifications.directoryUnauthorized`,
      "creation-failed": `${MODULE_ID}.notifications.directoryCreationFailed`
    };
    pending.reject(createUserFacingError(
      keyByCode[message.errorCode] || `${MODULE_ID}.notifications.directoryCreationFailed`
    ));
  }

  function createUserFacingError(key, cause = null) {
    const error = new Error(game.i18n.localize(key));
    if (cause) error.cause = cause;
    error.ktzUserMessage = error.message;
    return error;
  }

  function getUserFacingErrorMessage(error, fallbackKey) {
    return error?.ktzUserMessage || game.i18n.localize(fallbackKey);
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = String(value || "");
    return element.innerHTML;
  }

  async function directoryExists(source, directory) {
    try {
      await filePickerClass().browse(source, directory);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function dataFileExists(path) {
    const cleanPath = stripCacheBust(path).replace(/\\/g, "/").replace(/^\/+/, "");
    const separator = cleanPath.lastIndexOf("/");
    if (separator <= 0) return false;
    const directory = cleanPath.slice(0, separator);
    try {
      const result = await filePickerClass().browse(DATA_SOURCE, directory);
      return (result?.files || []).some((entry) => (
        stripCacheBust(entry).replace(/\\/g, "/").replace(/^\/+/, "") === cleanPath
      ));
    } catch (_error) {
      return false;
    }
  }

  async function updatePlacedTokens(actor, tokenPath) {
    let count = 0;
    const actorBase = captureActorTokenVisualState(actor);
    actorBase.texture = Object.assign({}, actorBase.texture, { src: stripCacheBust(tokenPath) });
    const variantIds = new Set(getActorTokenVariants(actor).map((variant) => variant.id));

    for (const scene of game.scenes || []) {
      const updates = [];

      for (const token of scene.tokens || []) {
        if (token.actorId !== actor.id || !canUpdatePlacedToken(token)) continue;

        const activeVariantId = String(token.getFlag(MODULE_ID, "activeTokenVariant") || "base");
        const storedBase = token.getFlag(MODULE_ID, "tokenVariantBase");
        const base = foundry.utils.deepClone(storedBase || actorBase);
        base.texture = Object.assign({}, actorBase.texture, base.texture || {}, { src: actorBase.texture.src });

        if (activeVariantId !== "base" && variantIds.has(activeVariantId)) {
          updates.push({
            _id: token.id,
            [`flags.${MODULE_ID}.tokenVariantBase`]: base
          });
          continue;
        }

        const update = {
          _id: token.id,
          "texture.src": actorBase.texture.src
        };
        if (storedBase) update[`flags.${MODULE_ID}.tokenVariantBase`] = base;
        if (activeVariantId !== "base") {
          Object.assign(update, buildTokenVisualUpdate(token, base));
          update[`flags.${MODULE_ID}.activeTokenVariant`] = "base";
          update[`flags.${MODULE_ID}.activeTokenVariantSource`] = null;
        }
        updates.push(update);
      }

      if (!updates.length) continue;
      count += await updateSceneTokens(scene, updates, "base-updated");
    }

    return count;
  }

  async function updatePlacedTokensUsingVariant(actor, variant) {
    if (!actor || !variant?.id || !variant?.src) return 0;
    let count = 0;

    for (const scene of game.scenes || []) {
      const updates = [];
      for (const token of scene.tokens || []) {
        if (!tokenUsesVariantCatalog(token, actor) || !canUpdatePlacedToken(token)) continue;
        if (String(token.getFlag(MODULE_ID, "activeTokenVariant") || "base") !== variant.id) continue;

        updates.push({
          _id: token.id,
          ...buildTokenVisualUpdate(token, {
            width: variant.width,
            height: variant.height,
            texture: updatedVariantTexture(token, variant, actor)
          })
        });
      }

      if (!updates.length) continue;
      count += await updateSceneTokens(scene, updates, "variant-updated");
    }

    return count;
  }

  async function restorePlacedTokensUsingVariant(actor, variantId) {
    if (!actor || !variantId) return 0;
    let count = 0;
    const actorBase = captureActorTokenVisualState(actor);

    for (const scene of game.scenes || []) {
      const updates = [];
      for (const token of scene.tokens || []) {
        if (!tokenUsesVariantCatalog(token, actor) || !canUpdatePlacedToken(token)) continue;
        if (String(token.getFlag(MODULE_ID, "activeTokenVariant") || "base") !== variantId) continue;

        const base = token.getFlag(MODULE_ID, "tokenVariantBase")
          || (token.actor ? captureActorTokenVisualState(token.actor) : actorBase);
        updates.push({
          _id: token.id,
          ...buildTokenVisualUpdate(token, base),
          [`flags.${MODULE_ID}.activeTokenVariant`]: "base",
          [`flags.${MODULE_ID}.activeTokenVariantSource`]: null
        });
      }

      if (!updates.length) continue;
      count += await updateSceneTokens(scene, updates, "variant-removed");
    }

    return count;
  }

  async function synchronizePlacedTokenVariants(actor, nextVariants) {
    if (!actor) return 0;
    const nextById = new Map((nextVariants || []).map((variant) => [variant.id, variant]));
    let count = 0;

    for (const scene of game.scenes || []) {
      const updates = [];
      for (const token of scene.tokens || []) {
        if (!tokenUsesVariantCatalog(token, actor) || !canUpdatePlacedToken(token)) continue;
        const activeVariantId = String(token.getFlag(MODULE_ID, "activeTokenVariant") || "base");
        if (activeVariantId === "base") continue;

        const variant = nextById.get(activeVariantId);
        if (variant?.src) {
          updates.push({
            _id: token.id,
            ...buildTokenVisualUpdate(token, {
              width: variant.width,
              height: variant.height,
              texture: updatedVariantTexture(token, variant, actor)
            })
          });
          continue;
        }

        const base = token.getFlag(MODULE_ID, "tokenVariantBase")
          || captureActorTokenVisualState(token.actor || actor);
        updates.push({
          _id: token.id,
          ...buildTokenVisualUpdate(token, base),
          [`flags.${MODULE_ID}.activeTokenVariant`]: "base",
          [`flags.${MODULE_ID}.activeTokenVariantSource`]: null
        });
      }

      if (!updates.length) continue;
      count += await updateSceneTokens(scene, updates, "variant-catalog-synchronized");
    }

    return count;
  }

  function updatedVariantTexture(token, variant, actor) {
    const base = token.getFlag(MODULE_ID, "tokenVariantBase") || captureActorTokenVisualState(actor);
    return variantTexture({
      ...cleanTokenTextureState(token.texture, getActorTokenPath(token.actor)),
      scaleX: base.texture?.scaleX ?? 1,
      scaleY: base.texture?.scaleY ?? 1
    }, variant);
  }

  function tokenUsesVariantCatalog(token, actor) {
    if (token?.actorId === actor?.id) return true;
    return String(token?.getFlag?.(MODULE_ID, "variantOwnerActorId") || "") === String(actor?.id || "");
  }

  function canUpdatePlacedToken(token) {
    if (game.user?.isGM || token?.isOwner) return true;
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return Boolean(token?.testUserPermission?.(game.user, ownerLevel));
  }

  async function updateSceneTokens(scene, updates, reason) {
    try {
      await scene.updateEmbeddedDocuments("Token", updates, {
        animate: false,
        khuzoeTokenizer: true,
        khuzoeTokenizerReason: reason
      });
      return updates.length;
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to synchronize ${updates.length} placed tokens in ${scene.name || scene.id}`, error);
      return 0;
    }
  }

  function sanitizeDirectory(value) {
    const directory = String(value || MODULE_ID)
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => sanitizeSegment(part))
      .filter(Boolean)
      .join("/");
    return directory || MODULE_ID;
  }

  function sanitizeSegment(value) {
    return String(value || "actor")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "actor";
  }

  function stripCacheBust(path) {
    return String(path || "")
      .replace(/([?&])ktz=[^&#]*(&?)/i, (_match, prefix, trailing) => trailing ? prefix : "")
      .replace(/[?&]$/, "");
  }


  function fileNameFromPath(path) {
    const cleanPath = stripCacheBust(path).split(/[?#]/)[0];
    return cleanPath.split(/[\\/]/).pop() || cleanPath;
  }

  function fileNameWithoutExtension(path) {
    return fileNameFromPath(path).replace(/\.[^.]+$/, "") || fileNameFromPath(path);
  }

  function getWebpQuality() {
    return clamp(Number(game.settings.get(MODULE_ID, "webpQuality")) || 1, 0.1, 1);
  }


  function roundForInput(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getRoot(htmlOrElement) {
    return applicationRoot(htmlOrElement);
  }
})();




























