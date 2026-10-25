import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/^\uFEFF/, "");

test("manifest targets Foundry V14 and loads one ES module entry", () => {
  const manifest = JSON.parse(read("module.json"));
  assert.equal(manifest.version, "1.2.0");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.367");
  assert.deepEqual(manifest.esmodules, ["scripts/main.js"]);
  assert.equal(manifest.scripts, undefined);
  assert.ok(manifest.styles.includes("styles/v14.css"));
});

test("all internal windows use the native V14 application lifecycle", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");
  const itemImage = read("scripts/item-image.js");
  const combined = `${tokenizer}\n${itemImage}`;

  assert.equal((combined.match(/extends HandlebarsApplicationV2/g) || []).length, 4);
  assert.equal((combined.match(/static DEFAULT_OPTIONS/g) || []).length, 4);
  assert.equal((combined.match(/static PARTS/g) || []).length, 4);
  assert.equal((combined.match(/async _prepareContext/g) || []).length, 4);
  assert.equal((combined.match(/async _onRender/g) || []).length, 4);
  assert.doesNotMatch(combined, /extends Application\b/);
  assert.doesNotMatch(combined, /static get defaultOptions/);
  assert.doesNotMatch(combined, /activateListeners\s*\(/);
  assert.doesNotMatch(combined, /this\.element\?\.\[0\]/);
  assert.doesNotMatch(combined, /\bthis\.state\b/, "ApplicationV2.state is read-only in Foundry V14");
  assert.match(combined, /\bthis\.editorState\b/);
  assert.doesNotMatch(tokenizer, /root\.querySelectorAll\("\[data-action\]"\)/,
    "module controls must not intercept native V14 window actions");
  assert.match(tokenizer, /content\.querySelectorAll\("\[data-action\]"\)/);
});

test("V14 boundaries replace deprecated global integrations", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");
  const itemImage = read("scripts/item-image.js");
  const combined = `${tokenizer}\n${itemImage}`;

  assert.doesNotMatch(combined, /Object\.values\(ui\.windows/);
  assert.doesNotMatch(combined, /\bnew FilePicker\s*\(/);
  assert.doesNotMatch(combined, /\bFilePicker\.(browse|upload|createDirectory)/);
  assert.doesNotMatch(combined, /\bnew ImagePopout\s*\(/);
  assert.doesNotMatch(combined, /patchItemSheetImageHandler/);
  assert.doesNotMatch(combined, /prototype\._onEditImage\s*=/);
  assert.match(combined, /findOpenApplication/);
  assert.match(combined, /filePickerClass/);
  assert.match(combined, /senderUserId !== message\.requesterUserId/);
});

test("legacy data contract and public integration events are preserved", () => {
  const source = `${read("scripts/khuzoe-tokenizer.js")}\n${read("scripts/item-image.js")}`;
  for (const flag of [
    "lastEdit", "syncEvent", "tokenVariants", "variantManifests",
    "tokenVariantBase", "activeTokenVariant", "imageEdit", "imageAsset"
  ]) assert.ok(source.includes(flag), `preserves ${flag}`);

  for (const eventName of [
    "saved", "variantsChanged", "variantsSynchronized", "variantApplied",
    "variantRestored", "documentImageSaved", "itemImageSaved"
  ]) assert.match(source, new RegExp(eventName));

  assert.match(source, /game\.settings\.register\(MODULE_ID, "migrationVersion"/);
  assert.match(source, /game\.settings\.set\(MODULE_ID, "migrationVersion", 1\)/);
  assert.match(read("scripts/item-image.js"), /dataFileExists\(uploadedPath\)/);
});

test("the M preview uses Merchant ground-loot artwork instead of the shared proxy Actor", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");

  assert.match(tokenizer, /getFlag\?\.\(MERCHANT_MODULE_ID, "groundLoot"\)/);
  assert.match(tokenizer, /loot\.img,[\s\S]*loot\.item\?\.img,[\s\S]*token\?\.document\?\.texture\?\.src/);
  assert.match(tokenizer, /const source = String\(groundLootPreview\?\.source \|\| getTokenAvatar\(token\.document\)/);
  assert.match(tokenizer, /const title = groundLootPreview\?\.title \|\|/);
  assert.match(tokenizer, /uuid: !groundLootPreview && canIdentify/);
});

test("saved images use immutable content-addressed paths", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");
  const itemImage = read("scripts/item-image.js");

  assert.match(tokenizer, /const outputHash = await hashBlob\(outputBlob\)/);
  assert.ok(tokenizer.includes("`${target}-base-${outputHash}.webp`"));
  assert.ok(tokenizer.includes("`token-variant-${sanitizeSegment(variantId)}-${imageHash}.webp`"));
  assert.ok(tokenizer.includes("`${sanitizeSegment(fileNameWithoutExtension(file.name))}-${hash}.webp`"));
  assert.doesNotMatch(tokenizer, /const outputFileName = `\$\{target\}-base\.webp`/);
  assert.match(itemImage, /"item-" \+ outputHash \+ "\.webp"/);
  assert.match(itemImage, /"source-" \+ sourceHash \+ "\.webp"/);
});

test("flattened outputs reopen without applying the old transform twice", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");
  const itemImage = read("scripts/item-image.js");

  assert.match(tokenizer, /sourceIsFlattened: !shouldStoreSource/);
  assert.match(tokenizer, /mode: flattened \? "fit" : state\.mode/);
  assert.match(tokenizer, /zoom: flattened \? 1 : state\.zoom/);
  assert.match(tokenizer, /editData\.layers = flattened \? \[\]/);
  assert.match(itemImage, /mode: sourceWasStored \? this\.editorState\.mode : "fit"/);
  assert.match(itemImage, /zoom: sourceWasStored \? this\.editorState\.zoom : 1/);
});

test("placed tokens remain coherent when bases and variants change", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");

  assert.match(tokenizer, /async function updatePlacedTokensUsingVariant/);
  assert.match(tokenizer, /async function restorePlacedTokensUsingVariant/);
  assert.match(tokenizer, /async function synchronizePlacedTokenVariants/);
  assert.match(tokenizer, /activeVariantId !== "base" && variantIds\.has\(activeVariantId\)/);
  assert.match(tokenizer, /flags\.\$\{MODULE_ID\}\.tokenVariantBase/);
  assert.match(tokenizer, /khuzoeTokenizerReason: reason/);
});

test("detached V14 windows, frame uploads, and migrations use guarded boundaries", () => {
  const tokenizer = read("scripts/khuzoe-tokenizer.js");
  const itemImage = read("scripts/item-image.js");
  const compat = read("scripts/foundry-compat.js");
  const combined = `${tokenizer}\n${itemImage}`;

  assert.match(combined, /ownerDocument\?\.defaultView\?\.devicePixelRatio/);
  assert.match(combined, /defaultView\?\.ResizeObserver/);
  assert.match(combined, /event\.currentTarget\?\.ownerDocument\?\.defaultView/);
  assert.match(compat, /html\?\.nodeType === 1/);
  assert.match(tokenizer, /frame-directory-request/);
  assert.match(tokenizer, /frame-directory-response/);
  assert.match(tokenizer, /await ensureFrameDirectory\(\)/);
  assert.doesNotMatch(tokenizer, /"\.window-content img"/);
  assert.ok(tokenizer.includes('img[data-edit="prototypeToken.texture.src"]'));
  assert.ok(tokenizer.includes('".sidebar .portrait > img"'));
  assert.match(tokenizer, /return \{ updatedActors, updatedItems, updatedTokens, failures \}/);
  assert.match(tokenizer, /if \(migration\.failures === 0\)/);
});

test("templates retain one non-nested form and V14 owns the window headers", () => {
  for (const template of [
    "templates/tokenizer.hbs",
    "templates/token-variant-selector.hbs",
    "templates/token-variant-manager.hbs",
    "templates/item-image.hbs"
  ]) {
    const source = read(template);
    assert.equal((source.match(/<form\b/g) || []).length, 1, `${template} has one form`);
    assert.equal((source.match(/<\/form>/g) || []).length, 1, `${template} closes its form`);
  }

  const css = `${read("styles/khuzoe-tokenizer.css")}\n${read("styles/item-image.css")}`;
  assert.match(css, /:not\(\.ktz-application-v14\) \.window-header/);
  assert.match(read("styles/v14.css"), /The core owns frames and header controls/);
});

test("Italian and English catalogs stay aligned and valid", () => {
  const italian = JSON.parse(read("lang/it.json"));
  const english = JSON.parse(read("lang/en.json"));
  assert.deepEqual(Object.keys(italian).sort(), Object.keys(english).sort());
  assert.equal(/Ã|�/.test(JSON.stringify(italian)), false);
});

test("the ES module entry can register its hooks with a V14-shaped runtime", async () => {
  class MockApplicationV2 {
    constructor(options = {}) {
      this.options = options;
      this.id = options.id || "mock";
    }
    static DEFAULT_OPTIONS = {};
    static PARTS = {};
    async _prepareContext() { return {}; }
    async _onRender() {}
    render() { return this; }
    close() { return Promise.resolve(this); }
  }

  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: MockApplicationV2,
        HandlebarsApplicationMixin: (Base) => class extends Base {}
      },
      apps: {},
      instances: new Map()
    }
  };
  const hookHandlers = new Map();
  globalThis.Hooks = {
    once() {},
    on(name, handler) {
      const handlers = hookHandlers.get(name) || [];
      handlers.push(handler);
      hookHandlers.set(name, handlers);
    }
  };
  globalThis.game = {
    system: { id: "dnd5e" },
    user: { isGM: true }
  };

  await import(`${pathToFileURL(path.join(root, "scripts/main.js")).href}?test=${Date.now()}`);

  class MockActorSheet {
    static MODES = { PLAY: 1, EDIT: 2 };
  }
  const actor = { documentName: "Actor", id: "actor-1", type: "character", isOwner: true };
  const listeners = new Map();
  const image = {
    dataset: {},
    classList: { add() {} },
    addEventListener(name, handler, options) { listeners.set(name, { handler, options }); }
  };
  const actorSheetRoot = {
    nodeType: 1,
    querySelector(selector) {
      if (selector === 'img[data-edit="prototypeToken.texture.src"]') return image;
      return null;
    }
  };
  const actorSheet = {
    constructor: MockActorSheet,
    document: actor,
    _mode: MockActorSheet.MODES.EDIT,
    isEditable: true
  };
  for (const handler of hookHandlers.get("renderApplicationV2") || []) {
    handler(actorSheet, actorSheetRoot);
  }
  assert.equal(image.dataset.ktzTokenizerBound, "true");
  assert.equal(listeners.get("click")?.options?.capture, true);
});
