import { imageField, documentImage, canEditDocumentImage } from "./image-document.js";
import {
  HandlebarsApplicationV2,
  applicationRoot,
  bringApplicationToFront,
  filePickerClass,
  findOpenApplication,
  openFilePicker,
  openApplications
} from "./foundry-compat.js";

(() => {
  "use strict";

  const MODULE_ID = "khuzoe-tokenizer";
  const DATA_SOURCE = "data";
  const SOCKET_NAME = "module." + MODULE_ID;
  const TEMPLATE_PATH = "modules/" + MODULE_ID + "/templates/item-image.hbs";
  const REQUEST_TIMEOUT_MS = 60000;
  const pendingRequests = new Map();
  const pendingDirectoryEnsures = new Map();

  class KhuzoeItemImageApp extends HandlebarsApplicationV2 {
    constructor(item, options = {}) {
      const identity = String(item?.uuid || item?.id || "item").replace(/[^a-zA-Z0-9_-]+/g, "-");
      super({ ...options, id: MODULE_ID + "-item-image-" + identity });
      this.item = item;
      this.isUserImage = item?.documentName === "User";
      this.initialPath = stripCacheBust(options.sourcePath ?? documentImage(item));
      const savedEdit = item?.getFlag?.(MODULE_ID, "imageEdit") || {};
      const stored = !savedEdit.path || stripCacheBust(savedEdit.path) === this.initialPath ? savedEdit : {};
      this.editorState = {
        image: null,
        sourceName: String(stored.sourceName || ""),
        sourcePath: stripCacheBust(stored.sourcePath || ""),
        outputPath: stripCacheBust(stored.path || this.initialPath),
        mode: stored.mode === "fit" ? "fit" : "cover",
        zoom: Number(stored.zoom) || 1,
        offsetX: Number(stored.offsetX) || 0,
        offsetY: Number(stored.offsetY) || 0,
        background: createBackground(stored.background),
        dirty: false,
        loading: false
      };
      this.canvas = null;
      this.dropzone = null;
      this.saving = false;
      this.boundPaste = this.onPaste.bind(this);
      this.eventDocument = null;
    }

    static DEFAULT_OPTIONS = {
      classes: [MODULE_ID, "khuzoe-item-image-window", "ktz-application-v14"],
      position: { width: 610, height: "auto" },
      window: { icon: "fa-solid fa-wand-magic-sparkles", resizable: true }
    };

    static PARTS = {
      main: { template: TEMPLATE_PATH }
    };

    get title() {
      return game.i18n.format(MODULE_ID + (this.isUserImage ? ".app.userImageTitle" : ".app.itemImageTitle"), { name: this.item?.name || "" });
    }

    async _prepareContext(options = {}) {
      const context = await super._prepareContext(options);
      return {
        ...context,
        item: this.item,
        itemImage: this.initialPath,
        imageLabel: MODULE_ID + (this.isUserImage ? ".labels.userImage" : ".labels.itemImage"),
        itemType: String(this.item?.type || "")
      };
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      const root = this.element;
      if (!root) return;

      this.canvas = root.querySelector("canvas[data-item-image-canvas]");
      this.dropzone = root.querySelector("[data-item-image-dropzone]");
      root.querySelectorAll("[data-item-image-action]").forEach((button) => {
        button.addEventListener("click", (event) => this.onAction(event));
      });
      root.querySelectorAll("[data-item-image-control]").forEach((input) => {
        input.addEventListener("input", (event) => this.onControl(event));
        input.addEventListener("change", (event) => this.onControl(event));
      });

      if (this.dropzone) {
        for (const eventName of ["dragenter", "dragover"]) {
          this.dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.dropzone.classList.add("is-dragging");
          });
        }
        this.dropzone.addEventListener("dragleave", (event) => {
          if (!this.dropzone.contains(event.relatedTarget)) this.dropzone.classList.remove("is-dragging");
        });
        this.dropzone.addEventListener("drop", (event) => this.onDrop(event));
        this.dropzone.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
        this.dropzone.addEventListener("pointerdown", (event) => this.onPointerDown(event));
      }

      this.eventDocument?.removeEventListener("paste", this.boundPaste);
      this.eventDocument = root.ownerDocument || document;
      this.eventDocument.addEventListener("paste", this.boundPaste);
      this.resizeObserver?.disconnect();
      const ResizeObserverClass = this.eventDocument.defaultView?.ResizeObserver || globalThis.ResizeObserver;
      if (ResizeObserverClass && this.dropzone) {
        this.resizeObserver = new ResizeObserverClass(() => this.draw());
        this.resizeObserver.observe(this.dropzone);
      }
      this.syncControls();
      void this.loadInitialImage();
    }

    async close(options) {
      this.eventDocument?.removeEventListener("paste", this.boundPaste);
      this.eventDocument = null;
      this.resizeObserver?.disconnect();
      return super.close(options);
    }

    async loadInitialImage() {
      const path = this.editorState.sourcePath || this.initialPath;
      if (!path) return;
      await this.setImage(path, {
        sourceName: this.editorState.sourceName || fileNameFromPath(path),
        sourcePath: path,
        restoreTransform: true,
        dirty: false
      });
    }

    onAction(event) {
      event.preventDefault();
      event.stopPropagation();
      const action = event.currentTarget.dataset.itemImageAction;
      if (action === "choose") return this.chooseImage();
      if (action === "fit" || action === "cover") {
        this.editorState.mode = action;
        this.editorState.zoom = 1;
        this.editorState.offsetX = 0;
        this.editorState.offsetY = 0;
        this.editorState.dirty = Boolean(this.editorState.image);
        this.syncControls();
        this.draw();
        return;
      }
      if (action === "save") return this.save();
      if (action === "cancel") return this.close();
    }

    onControl(event) {
      const input = event.currentTarget;
      const control = input.dataset.itemImageControl;
      if (control === "backgroundEnabled") this.editorState.background.enabled = Boolean(input.checked);
      if (control === "backgroundColor") this.editorState.background.color = normalizeColor(input.value, "#000000");
      if (control === "zoom") this.editorState.zoom = clamp(Number(input.value) || 1, 0.1, 5);
      if (control === "offsetX") this.editorState.offsetX = clamp(Number(input.value) || 0, -1.5, 1.5);
      if (control === "offsetY") this.editorState.offsetY = clamp(Number(input.value) || 0, -1.5, 1.5);
      this.editorState.dirty = Boolean(this.editorState.image || this.editorState.background.enabled);
      this.syncControls();
      this.draw();
    }

    chooseImage() {
      openFilePicker({
        type: "image",
        current: this.editorState.sourcePath || this.initialPath,
        callback: (path) => this.setImage(path, {
          sourceName: fileNameFromPath(path),
          sourcePath: path,
          restoreTransform: false,
          dirty: true
        })
      });
    }

    async onDrop(event) {
      event.preventDefault();
      event.stopPropagation();
      this.dropzone?.classList.remove("is-dragging");
      const file = getImageFile(event.dataTransfer);
      if (file) return this.loadFile(file);
      const path = getDroppedPath(event.dataTransfer);
      if (path && isImagePath(path)) {
        return this.setImage(path, {
          sourceName: fileNameFromPath(path),
          sourcePath: path,
          restoreTransform: false,
          dirty: true
        });
      }
      ui.notifications.warn(game.i18n.localize(MODULE_ID + ".notifications.noImageDrop"));
    }

    async onPaste(event) {
      if (!this.rendered) return;
      const file = getImageFile(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      await this.loadFile(file);
    }

    async loadFile(file) {
      if (!isImageFile(file)) {
        ui.notifications.warn(game.i18n.localize(MODULE_ID + ".notifications.unsupportedFile"));
        return;
      }
      const dataUrl = await readFileAsDataUrl(file);
      await this.setImage(dataUrl, {
        sourceName: file.name,
        sourcePath: "",
        restoreTransform: false,
        dirty: true
      });
    }

    async setImage(src, options = {}) {
      this.editorState.loading = true;
      this.syncControls();
      try {
        this.editorState.image = await loadImage(src);
        this.editorState.sourceName = String(options.sourceName || fileNameFromPath(src));
        this.editorState.sourcePath = stripCacheBust(options.sourcePath || "");
        if (!options.restoreTransform) {
          this.editorState.mode = "cover";
          this.editorState.zoom = 1;
          this.editorState.offsetX = 0;
          this.editorState.offsetY = 0;
        }
        this.editorState.dirty = Boolean(options.dirty);
      } catch (error) {
        console.error(MODULE_ID + " | Item image load failed", error);
        ui.notifications.error(game.i18n.localize(MODULE_ID + (this.isUserImage ? ".notifications.userImageLoadFailed" : ".notifications.itemImageLoadFailed")));
      } finally {
        this.editorState.loading = false;
        this.syncControls();
        this.draw();
      }
    }

    onWheel(event) {
      if (!this.editorState.image) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.06 : 1 / 1.06;
      this.editorState.zoom = clamp(this.editorState.zoom * factor, 0.1, 5);
      this.editorState.dirty = true;
      this.syncControls();
      this.draw();
    }

    onPointerDown(event) {
      if (!this.editorState.image || event.button !== 0) return;
      event.preventDefault();
      const start = {
        x: event.clientX,
        y: event.clientY,
        offsetX: this.editorState.offsetX,
        offsetY: this.editorState.offsetY
      };
      const eventWindow = event.currentTarget?.ownerDocument?.defaultView || window;
      const move = (moveEvent) => {
        const rect = this.dropzone?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        this.editorState.offsetX = clamp(start.offsetX + ((moveEvent.clientX - start.x) / rect.width), -1.5, 1.5);
        this.editorState.offsetY = clamp(start.offsetY + ((moveEvent.clientY - start.y) / rect.height), -1.5, 1.5);
        this.editorState.dirty = true;
        this.syncControls();
        this.draw();
      };
      const end = () => {
        eventWindow.removeEventListener("pointermove", move);
        eventWindow.removeEventListener("pointerup", end);
        eventWindow.removeEventListener("pointercancel", end);
      };
      eventWindow.addEventListener("pointermove", move);
      eventWindow.addEventListener("pointerup", end, { once: true });
      eventWindow.addEventListener("pointercancel", end, { once: true });
    }

    draw() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const size = Math.max(1, Math.min(rect.width || 1, rect.height || rect.width || 1));
      const dpr = this.canvas.ownerDocument?.defaultView?.devicePixelRatio || window.devicePixelRatio || 1;
      const pixels = Math.max(1, Math.round(size * dpr));
      if (this.canvas.width !== pixels) this.canvas.width = pixels;
      if (this.canvas.height !== pixels) this.canvas.height = pixels;
      const context = this.canvas.getContext("2d");
      context.clearRect(0, 0, pixels, pixels);
      context.save();
      context.scale(dpr, dpr);
      drawImageState(context, this.editorState, size);
      context.restore();
    }

    syncControls() {
      const root = getRoot(this.element);
      if (!root) return;
      root.classList.toggle("is-saving", this.saving);
      this.dropzone?.classList.toggle("has-image", Boolean(this.editorState.image));
      this.dropzone?.classList.toggle("is-loading", this.editorState.loading);
      root.querySelectorAll("[data-item-image-action='fit'], [data-item-image-action='cover']").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.itemImageAction === this.editorState.mode);
      });
      const values = {
        zoom: this.editorState.zoom,
        offsetX: this.editorState.offsetX,
        offsetY: this.editorState.offsetY,
        backgroundColor: this.editorState.background.color
      };
      for (const [control, value] of Object.entries(values)) {
        const input = root.querySelector("[data-item-image-control='" + control + "']");
        if (input && document.activeElement !== input) input.value = String(value);
        const output = root.querySelector("[data-item-image-output='" + control + "']");
        if (output) output.textContent = control === "zoom" ? Math.round(this.editorState.zoom * 100) + "%" : String(round(value));
      }
      const background = root.querySelector("[data-item-image-control='backgroundEnabled']");
      if (background) background.checked = this.editorState.background.enabled;
      const source = root.querySelector("[data-item-image-source]");
      if (source) source.textContent = this.editorState.sourceName || game.i18n.localize(MODULE_ID + ".labels.noImage");
      root.querySelectorAll("button, input").forEach((element) => {
        element.disabled = this.saving;
      });
    }

    renderOutputCanvas() {
      const setting = this.isUserImage ? "avatarMaxDimension" : "itemIconSize";
      const size = clamp(Math.round(Number(game.settings.get(MODULE_ID, setting)) || 512), this.isUserImage ? 128 : 256, this.isUserImage ? 4096 : 2048);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      drawImageState(canvas.getContext("2d"), this.editorState, size);
      return canvas;
    }

    renderSourceCanvas() {
      const maxDimension = clamp(Math.round(game.settings.get(MODULE_ID, "sourceMaxDimension") || 2048), 128, 4096);
      const image = this.editorState.image;
      const width = image?.naturalWidth || image?.width || maxDimension;
      const height = image?.naturalHeight || image?.height || maxDimension;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    async save() {
      if (this.saving) return;
      if (!canEditDocumentImage(this.item, game.user)) {
        ui.notifications.warn(game.i18n.localize(MODULE_ID + ".notifications.imageUnauthorized"));
        return;
      }
      if (!this.editorState.dirty || (!this.editorState.image && !this.editorState.background.enabled)) {
        ui.notifications.info(game.i18n.localize(MODULE_ID + ".notifications.noChanges"));
        return;
      }
      this.saving = true;
      this.syncControls();
      try {
        const directories = await ensureItemIconDirectories(this.item);
        const outputBlob = await canvasToWebpBlob(this.renderOutputCanvas(), getWebpQuality());
        const outputHash = await hashBlob(outputBlob);
        const fileName = this.isUserImage ? "user-" + outputHash + ".webp" : "item-" + outputHash + ".webp";
        const outputPath = stripCacheBust(await uploadBlob(directories.objects, fileName, outputBlob));

        let sourcePath = outputPath;
        let sourceWasStored = false;
        if (this.editorState.image && game.settings.get(MODULE_ID, "storeSources")) {
          const sourceBlob = await canvasToWebpBlob(this.renderSourceCanvas(), getWebpQuality());
          const sourceHash = await hashBlob(sourceBlob);
          sourcePath = stripCacheBust(await uploadBlob(directories.sources, "source-" + sourceHash + ".webp", sourceBlob));
          sourceWasStored = true;
        }

        const savedAt = new Date().toISOString();
        const previousPath = stripCacheBust(documentImage(this.item));
        const imageEdit = {
          schemaVersion: 1,
          path: outputPath,
          sourcePath,
          sourceName: this.editorState.sourceName,
          mode: sourceWasStored ? this.editorState.mode : "fit",
          zoom: sourceWasStored ? this.editorState.zoom : 1,
          offsetX: sourceWasStored ? this.editorState.offsetX : 0,
          offsetY: sourceWasStored ? this.editorState.offsetY : 0,
          background: sourceWasStored
            ? cleanBackground(this.editorState.background)
            : cleanBackground({ enabled: false, color: this.editorState.background.color }),
          previousPath,
          updatedAt: savedAt
        };
        const imageAsset = {
          schemaVersion: 1,
          id: outputHash,
          path: outputPath,
          sourcePath,
          previousPath,
          updatedAt: savedAt
        };
        await this.item.update({
          [imageField(this.item)]: outputPath,
          ["flags." + MODULE_ID + ".imageEdit"]: imageEdit,
          ["flags." + MODULE_ID + ".imageAsset"]: imageAsset
        }, {
          khuzoeTokenizer: true,
          khuzoeTokenizerReason: this.isUserImage ? "user-image-saved" : "item-image-saved",
          ...(this.isUserImage ? { render: false } : {})
        });
        if (this.isUserImage) synchronizeUserImageFields(this.item, outputPath);
        this.editorState.outputPath = outputPath;
        this.editorState.sourcePath = sourcePath;
        this.editorState.dirty = false;
        const payload = { schemaVersion: 1, previousPath, path: outputPath, sourcePath, assetId: outputHash, savedAt };
        Hooks.callAll(MODULE_ID + ".documentImageSaved", this.item, payload);
        Hooks.callAll(MODULE_ID + (this.isUserImage ? ".userImageSaved" : ".itemImageSaved"), this.item, payload);
        ui.notifications.info(game.i18n.format(MODULE_ID + ".notifications.itemImageSaved", { name: this.item.name }));
        this.close();
      } catch (error) {
        console.error(MODULE_ID + " | Item image save failed", error);
        ui.notifications.error(error?.ktzUserMessage || game.i18n.localize(MODULE_ID + ".notifications.itemImageSaveFailed"));
      } finally {
        this.saving = false;
        this.syncControls();
      }
    }
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "itemIconSize", {
      name: MODULE_ID + ".settings.itemIconSize.name",
      hint: MODULE_ID + ".settings.itemIconSize.hint",
      scope: "world",
      config: true,
      type: Number,
      default: 512,
      range: { min: 256, max: 2048, step: 128 }
    });
    game.settings.register(MODULE_ID, "itemIconDirectory", {
      name: MODULE_ID + ".settings.itemIconDirectory.name",
      hint: MODULE_ID + ".settings.itemIconDirectory.hint",
      scope: "world",
      config: true,
      type: String,
      default: "khuzoe-tokenizer-icons"
    });
  });

  Hooks.on("renderItemSheet", (app, html) => injectItemTrigger(app, html));
  Hooks.on("renderApplication", (app, html) => injectItemTrigger(app, html));
  Hooks.on("renderApplicationV2", (app, html) => injectItemTrigger(app, html));
  Hooks.on("renderUserConfig", (app, html) => injectUserTrigger(app, html));

  Hooks.once("ready", () => {
    initializeSocket();
    const existing = game.modules.get(MODULE_ID)?.api || game.khuzoeTokenizer || {};
    const api = Object.freeze({
      ...existing,
      openItem: (item) => openItemImage(item),
      openUser: (user = game.user) => openItemImage(user),
      openDocumentImage: (document) => ["Item", "User"].includes(document?.documentName) ? openItemImage(document) : existing.open?.(document)
    });
    game.khuzoeTokenizer = api;
    const module = game.modules.get(MODULE_ID);
    if (module) module.api = api;
  });

  function openItemImage(item, options = {}) {
    if (!canEditDocumentImage(item, game.user)) return null;
    const id = MODULE_ID + "-item-image-" + String(item.uuid || item.id || "item").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const existing = findOpenApplication(id);
    if (existing) {
      bringApplicationToFront(existing);
      return existing;
    }
    const app = new KhuzoeItemImageApp(item, options);
    app.render({ force: true });
    return app;
  }

  function getItemDocument(app) {
    const candidates = [app?.item, app?.document, app?.object, app?.options?.document];
    return candidates.find((candidate) => candidate?.documentName === "Item") || null;
  }

  function injectUserTrigger(app, html) {
    const user = app?.document || app?.object;
    if (user?.documentName !== "User" || app?.isEditable === false || !canEditDocumentImage(user, game.user)) return;
    const root = getRoot(html);
    const field = root?.querySelector('file-picker[name="avatar"], input[name="avatar"]');
    if (!field || root.querySelector(".ktz-user-image-button")) return;
    const button = (root.ownerDocument || document).createElement("button");
    button.type = "button";
    button.className = "ktz-user-image-button";
    button.textContent = game.i18n.localize(MODULE_ID + ".buttons.editUserImage");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openItemImage(user, { sourcePath: field.value || documentImage(user) });
    });
    (field.closest(".form-fields") || field.parentElement).appendChild(button);
  }

  function synchronizeUserImageFields(user, path) {
    // Preserve other unsaved profile fields and prevent a later Submit from restoring the old avatar.
    for (const app of openApplications()) {
      if ((app.document || app.object)?.uuid !== user.uuid) continue;
      app.element?.querySelectorAll('file-picker[name="avatar"], input[name="avatar"]').forEach((field) => {
        field.value = path;
      });
    }
  }

  function injectItemTrigger(app, html) {
    if (app instanceof KhuzoeItemImageApp) return;
    const item = getItemDocument(app);
    if (!item || app?.isEditable === false || (!item.isOwner && !game.user?.isGM)) return;
    if (!isSheetInEditMode(app)) return;
    const root = getRoot(html);
    if (!root) return;
    const image = findItemImage(root);
    if (!image || image.dataset.ktzItemImageBound === "true") return;
    image.dataset.ktzItemImageBound = "true";
    image.classList.add("ktz-clickable-image");
    image.title = game.i18n.localize(MODULE_ID + ".buttons.editItemImage");
    image.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      openItemImage(item);
    }, { capture: true });
  }

  function findItemImage(root) {
    const selectors = [
      "img[data-edit='img']",
      "img.item-image[data-edit='img']",
      "img[data-action='editImage']",
      "img[data-action='edit-image']",
      "[data-action='editImage'] img",
      "img.profile",
      ".profile img",
      ".sheet-header img",
      ".item-header img"
    ];
    for (const selector of selectors) {
      const image = root.querySelector(selector);
      if (image) return image;
    }
    return null;
  }

  function isSheetInEditMode(app) {
    const editMode = app?.constructor?.MODES?.EDIT;
    if (editMode !== undefined && app?._mode !== undefined && app?._mode !== null) return app._mode === editMode;
    return app?.isEditable !== false;
  }

  function initializeSocket() {
    game.socket.on(SOCKET_NAME, (message, senderUserId) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "item-directory-response") {
        resolveDirectoryRequest(message, senderUserId);
        return;
      }
      if (message.type === "item-directory-request") void handleDirectoryRequestAsGm(message, senderUserId);
    });
  }

  async function ensureItemIconDirectories(item) {
    const directories = getItemIconDirectories(item);
    if (await directoryExists(directories.objects) && await directoryExists(directories.sources)) return directories;
    if (game.user?.isGM) {
      await ensureDirectoryRecursive(directories.objects);
      await ensureDirectoryRecursive(directories.sources);
      return directories;
    }

    const key = String(item?.uuid || item?.id || "item");
    const pending = pendingDirectoryEnsures.get(key);
    if (pending) return pending;
    const request = requestDirectoriesFromGm(item)
      .then(() => directories)
      .finally(() => pendingDirectoryEnsures.delete(key));
    pendingDirectoryEnsures.set(key, request);
    return request;
  }

  function getItemIconDirectories(item = null) {
    const base = sanitizeDirectory(game.settings.get(MODULE_ID, "itemIconDirectory") || "khuzoe-tokenizer-icons");
    const worldId = sanitizeSegment(game.world?.id || "world");
    const root = base + "/" + worldId + (item?.documentName === "User" ? "/users/" + sanitizeSegment(item.id) : "");
    return { root, objects: root + "/objects", sources: root + "/sources" };
  }

  function requestDirectoriesFromGm(item) {
    const gm = getActiveGm();
    if (!gm) return Promise.reject(userError(MODULE_ID + ".notifications.itemDirectoryNoGm"));
    const requestId = foundry.utils.randomID(24);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(userError(MODULE_ID + ".notifications.itemDirectoryTimeout"));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, reject, timeout, gmUserId: gm.id });
      game.socket.emit(SOCKET_NAME, {
        type: "item-directory-request",
        requestId,
        requesterUserId: game.user.id,
        gmUserId: gm.id,
        itemUuid: item?.uuid || "",
        userId: item?.documentName === "User" ? item.id : "",
        actorId: item?.parent?.documentName === "Actor" ? item.parent.id : "",
        sceneId: item?.parent?.token?.parent?.id || "",
        tokenId: item?.parent?.token?.id || "",
        itemId: item?.id || ""
      });
    });
  }

  async function handleDirectoryRequestAsGm(message, senderUserId) {
    if (!game.user?.isGM || message.gmUserId !== game.user.id || !message.requestId) return;
    if (!senderUserId || senderUserId !== message.requesterUserId) return;
    const requester = game.users?.get(senderUserId);
    let item = null;
    try {
      if (message.userId) item = game.users?.get(message.userId);
      else if (message.itemUuid && typeof fromUuid === "function") item = await fromUuid(message.itemUuid);
    } catch (_error) {
      item = null;
    }
    if (!message.userId && item?.documentName !== "Item" && message.actorId && message.itemId) {
      item = game.actors?.get(message.actorId)?.items?.get(message.itemId) || null;
    }
    if (!message.userId && item?.documentName !== "Item" && message.sceneId && message.tokenId && message.itemId) {
      item = game.scenes?.get(message.sceneId)?.tokens?.get(message.tokenId)?.actor?.items?.get(message.itemId) || null;
    }

    let ok = false;
    let errorCode = "creation-failed";
    try {
      if (!canEditDocumentImage(item, requester)) {
        errorCode = "unauthorized";
      } else {
        const directories = getItemIconDirectories(item);
        await ensureDirectoryRecursive(directories.objects);
        await ensureDirectoryRecursive(directories.sources);
        ok = await directoryExists(directories.objects) && await directoryExists(directories.sources);
        if (!ok) throw new Error("Item image directories were not created.");
        errorCode = "";
      }
    } catch (error) {
      console.error(MODULE_ID + " | Automatic item directory creation failed", error);
    }
    game.socket.emit(SOCKET_NAME, {
      type: "item-directory-response",
      requestId: message.requestId,
      requesterUserId: message.requesterUserId,
      gmUserId: game.user.id,
      ok,
      errorCode
    });
  }

  function resolveDirectoryRequest(message, senderUserId) {
    if (message.requesterUserId !== game.user?.id || !message.requestId) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending || message.gmUserId !== pending.gmUserId) return;
    if (!game.users?.get(senderUserId)?.isGM || senderUserId !== message.gmUserId) return;
    window.clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    if (message.ok) return pending.resolve();
    const key = message.errorCode === "unauthorized"
      ? MODULE_ID + ".notifications.imageUnauthorized"
      : MODULE_ID + ".notifications.itemDirectoryCreationFailed";
    pending.reject(userError(key));
  }

  function getActiveGm() {
    return (game.users?.filter((user) => user.active && user.isGM) || [])
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] || null;
  }

  function userError(key) {
    const error = new Error(game.i18n.localize(key));
    error.ktzUserMessage = error.message;
    return error;
  }

  function drawImageState(context, state, size) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (state.background.enabled) {
      context.fillStyle = normalizeColor(state.background.color, "#000000");
      context.fillRect(0, 0, size, size);
    }
    const image = state.image;
    if (!image) return;
    const imageWidth = image.naturalWidth || image.width || 1;
    const imageHeight = image.naturalHeight || image.height || 1;
    const baseScale = state.mode === "fit"
      ? Math.min(size / imageWidth, size / imageHeight)
      : Math.max(size / imageWidth, size / imageHeight);
    const scale = baseScale * state.zoom;
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    const x = ((size - width) / 2) + (state.offsetX * size);
    const y = ((size - height) / 2) + (state.offsetY * size);
    context.drawImage(image, x, y, width, height);
  }

  function createBackground(data = {}) {
    return { enabled: Boolean(data.enabled), color: normalizeColor(data.color, "#000000") };
  }

  function cleanBackground(data = {}) {
    const background = createBackground(data);
    return { enabled: background.enabled, color: background.color };
  }

  function getImageFile(dataTransfer) {
    if (!dataTransfer) return null;
    const files = Array.from(dataTransfer.files || []);
    return files.find(isImageFile)
      || Array.from(dataTransfer.items || [])
        .filter((item) => item.kind === "file" && item.type?.startsWith("image/"))
        .map((item) => item.getAsFile())
        .find(isImageFile)
      || null;
  }

  function getDroppedPath(dataTransfer) {
    if (!dataTransfer) return "";
    const raw = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain") || "";
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
    return Boolean(file && (file.type?.startsWith("image/") || isImagePath(file.name || "")));
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
      if (!String(src).startsWith("data:")) image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to load item image: " + src));
      image.src = src;
    });
  }

  function canvasToWebpBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("WebP encoding failed.")), "image/webp", quality);
    });
  }

  async function hashBlob(blob) {
    if (!globalThis.crypto?.subtle) return foundry.utils.randomID(32).toLowerCase();
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }

  async function uploadBlob(directory, fileName, blob) {
    const file = new File([blob], fileName, { type: "image/webp" });
    const FilePickerClass = filePickerClass();
    const response = await FilePickerClass.upload(DATA_SOURCE, directory, file, {}, { notify: false });
    const uploadedPath = stripCacheBust(response?.path || "");
    if (!uploadedPath) throw userError(MODULE_ID + ".notifications.uploadFailed");
    if (!(await dataFileExists(uploadedPath))) {
      throw userError(MODULE_ID + ".notifications.uploadVerificationFailed");
    }
    return uploadedPath;
  }

  async function ensureDirectoryRecursive(directory) {
    const parts = sanitizeDirectory(directory).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? current + "/" + part : part;
      if (await directoryExists(current)) continue;
      try {
        await filePickerClass().createDirectory(DATA_SOURCE, current, { notify: false });
      } catch (error) {
        if (!(await directoryExists(current))) throw error;
      }
    }
  }

  async function directoryExists(directory) {
    try {
      await filePickerClass().browse(DATA_SOURCE, directory);
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

  function sanitizeDirectory(value) {
    const directory = String(value || "khuzoe-tokenizer-icons")
      .replace(/\\/g, "/")
      .split("/")
      .map(sanitizeSegment)
      .filter(Boolean)
      .join("/");
    return directory || "khuzoe-tokenizer-icons";
  }

  function sanitizeSegment(value) {
    return String(value || "item")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item";
  }

  function stripCacheBust(path) {
    return String(path || "")
      .replace(/([?&])ktz=[^&#]*(&?)/i, (_match, prefix, trailing) => trailing ? prefix : "")
      .replace(/[?&]$/, "");
  }

  function fileNameFromPath(path) {
    const clean = stripCacheBust(path).split(/[?#]/)[0];
    return clean.split(/[\\/]/).pop() || clean;
  }

  function normalizeColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function getWebpQuality() {
    return clamp(Number(game.settings.get(MODULE_ID, "webpQuality")) || 1, 0.1, 1);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function getRoot(htmlOrElement) {
    return applicationRoot(htmlOrElement);
  }
})();
