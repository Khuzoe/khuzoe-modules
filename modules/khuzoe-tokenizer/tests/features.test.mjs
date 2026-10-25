import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { parseDecimal, parseVariantScale, variantTexture } from "../scripts/variant-scale.js";
import { imageField, documentImage, canEditDocumentImage } from "../scripts/image-document.js";

const moduleId = "khuzoe-tokenizer";
const clone = value => JSON.parse(JSON.stringify(value));
function assignPaths(target, update) {
  for (const [path, value] of Object.entries(update)) {
    const keys = path.split(".");
    let container = target;
    for (const key of keys.slice(0, -1)) container = container[key] ??= {};
    container[keys.at(-1)] = structuredClone(value);
  }
}

function runtime(file, exports) {
  const events = [], notices = [], uploads = [], socketMessages = [], applications = new Map();
  class Application {
    constructor(options = {}) { this.options = options; this.id = options.id; }
    async _prepareContext() { return {}; }
    render() { applications.set(this.id, this); return this; }
    close() { applications.delete(this.id); return Promise.resolve(); }
  }
  const storedFiles = new Set();
  const filePicker = {
    async browse(_source, directory) { return { files: [...storedFiles].filter(p => p.startsWith(directory + "/")) }; },
    async upload(_source, directory, file) {
      const path = directory + "/" + file.name;
      uploads.push(path); storedFiles.add(path); return { path };
    },
    async createDirectory() {}
  };
  const settings = { itemIconDirectory: "icons", storeSources: true, migrationVersion: 1 };
  const game = {
    user: { id: "player", isGM: false }, users: new Map(), actors: new Map(), scenes: [], world: { id: "test" },
    settings: { get: (_id, key) => settings[key] },
    i18n: { localize: key => key, format: key => key },
    socket: { emit: (_channel, payload) => socketMessages.push(payload) }
  };
  const sandbox = {
    console, Blob, File, crypto: webcrypto, parseDecimal, parseVariantScale, variantTexture,
    imageField, documentImage, canEditDocumentImage,
    HandlebarsApplicationV2: Application, game, canvas: {},
    foundry: { utils: { deepClone: structuredClone, randomID: () => "random-id", getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object) } },
    Hooks: { on() {}, once() {}, callAll: (...args) => events.push(args) },
    ui: { notifications: Object.fromEntries(["warn", "info", "error"].map(key => [key, message => notices.push([key, message])])) },
    filePickerClass: () => filePicker,
    applicationRoot: root => root,
    openApplications: () => applications.values(),
    findOpenApplication: id => applications.get(id),
    bringApplicationToFront() {}, renderApplication() {},
    window: { setTimeout, clearTimeout }
  };
  const source = fs.readFileSync(new URL("../scripts/" + file, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replace(/\}\)\(\);\s*$/, `globalThis.exposed = { ${exports.join(", ")} };\n})();`);
  vm.runInNewContext(source, sandbox, { filename: file });
  return { ...sandbox.exposed, sandbox, game, events, notices, uploads, socketMessages, applications, filePicker, settings };
}

function variantRuntime() {
  return runtime("khuzoe-tokenizer.js", [
    "createTokenVariant", "applyTokenVariant", "restoreTokenVariantBase", "replaceActorTokenVariants",
    "syncActorTokenVariants", "updatePlacedTokensUsingVariant", "KhuzoeTokenVariantManagerApp",
    "getTokenAvatar", "saveActorVariantAvatar"
  ]);
}
function imageRuntime() {
  return runtime("item-image.js", [
    "KhuzoeItemImageApp", "openItemImage", "injectUserTrigger", "handleDirectoryRequestAsGm", "drawImageState"
  ]);
}
function actorFixture() {
  return {
    documentName: "Actor", id: "actor", img: "portrait.webp", flags: {},
    prototypeToken: { width: 1, height: 1, texture: { src: "base.webp", scaleX: -0.8, scaleY: 0.9 } },
    getFlag(_scope, key) { return this.flags[key]; },
    async setFlag(_scope, key, value) { this.flags[key] = clone(value); },
    async update(update) {
      for (const [key, value] of Object.entries(update)) this.flags[key.replace(`flags.${moduleId}.`, "")] = clone(value);
    }
  };
}
function tokenFixture(actor) {
  return {
    id: "token", actor, actorId: actor.id, isOwner: true, width: 1, height: 1, x: 23, y: 31,
    texture: { ...actor.prototypeToken.texture, tint: "#ff0000", offsetX: 0.1 },
    parent: { grid: { type: 1, size: 100 } }, flags: {}, updates: [],
    getFlag(_scope, key) { return this.flags[moduleId]?.[key]; },
    async update(update) { this.updates.push(clone(update)); assignPaths(this, update); }
  };
}

test("decimal comma and dot scales, boundaries, inheritance, and invalid entries", () => {
  for (const [input, expected] of [["1,25", 1.25], [" 0,75 ", .75], [".5", .5], ["1.125", 1.125], [10, 10], ["0,01", .01]]) {
    assert.equal(parseVariantScale(input), expected);
  }
  for (const input of ["", "   ", null, undefined]) assert.equal(parseVariantScale(input), null);
  for (const input of [0, -1, Infinity, NaN, true, "0,001", "10,1", "1,2.3", "1foo", "1e2", "0x10"]) {
    assert.ok(Number.isNaN(parseVariantScale(input)), String(input));
  }
});

test("explicit scale keeps mirroring; inherited scale retains separate axes and offsets", () => {
  const base = { src: "base", scaleX: -.8, scaleY: .9, offsetX: .2, tint: "#fff" };
  assert.deepEqual(variantTexture(base, { src: "v", scale: "1,25" }), { ...base, src: "v", scaleX: -1.25, scaleY: 1.25 });
  assert.deepEqual(variantTexture(base, { src: "v" }), { ...base, src: "v" });
  assert.equal(base.scaleX, -.8);
});

test("switch variants repeatedly, inherit legacy scale, and restore the exact base", async () => {
  const rt = variantRuntime(), actor = actorFixture(), token = tokenFixture(actor);
  const base = clone(token.texture);
  await rt.applyTokenVariant(token, { id: "large-art", src: "v.webp", width: 1, scale: "1,25" });
  assert.equal(token.texture.scaleX, -1.25);
  assert.equal(token.texture.scaleY, 1.25);
  assert.equal(token.width, 1);
  assert.equal(token.x, 23); assert.equal(token.y, 31);
  assert.equal(token.updates[0].x, undefined, "scale-only changes do not snap position");
  await rt.applyTokenVariant(token, { id: "smaller", src: "v2.webp", scale: .5 });
  assert.equal(token.texture.scaleX, -.5, "absolute scale never compounds");
  await rt.applyTokenVariant(token, { id: "legacy", src: "old.webp" });
  assert.equal(token.texture.scaleX, -.8);
  assert.equal(token.texture.scaleY, .9);
  await rt.restoreTokenVariantBase(token);
  for (const [key, value] of Object.entries(base)) assert.equal(token.texture[key], value, key);
  assert.equal(token.getFlag(moduleId, "activeTokenVariant"), "base");
});

test("grid dimensions and visual scale stay independent, including comma grid input", async () => {
  const rt = variantRuntime(), actor = actorFixture(), token = tokenFixture(actor);
  const variant = rt.createTokenVariant({ id: "big", src: "big.webp", width: "2,5", height: "1,5", scale: "0,75" });
  await rt.applyTokenVariant(token, variant);
  assert.equal(token.width, 2.5); assert.equal(token.height, 1.5);
  assert.equal(token.texture.scaleX, -.75);
  await rt.restoreTokenVariantBase(token);
  assert.equal(token.width, 1); assert.equal(token.height, 1);
});

test("external replace and sync preserve omitted scales, accept explicit changes and null reset", async () => {
  const rt = variantRuntime(), actor = actorFixture();
  await rt.replaceActorTokenVariants(actor, { variants: [{ id: "v", src: "v.webp", scale: 1.25 }] });
  await rt.replaceActorTokenVariants(actor, { variants: [{ id: "v", src: "changed.webp" }] });
  assert.equal(actor.flags.tokenVariants[0].scale, 1.25);
  assert.equal(await rt.replaceActorTokenVariants(actor, { variants: [{ id: "v", src: "changed.webp" }] }), false);
  await rt.replaceActorTokenVariants(actor, { variants: [{ id: "v", src: "changed.webp", scale: null }] });
  assert.equal(actor.flags.tokenVariants[0].scale, null);
  await rt.syncActorTokenVariants(actor, { source: "site", variants: [{ id: "managed", src: "managed.webp", scale: "1,7" }] });
  await rt.syncActorTokenVariants(actor, { source: "site", variants: [{ id: "managed", src: "managed2.webp" }] });
  assert.equal(actor.flags.tokenVariants.find(v => v.id === "managed").scale, 1.7);
});

test("manager saves decimal scales and updates only editable tokens using that variant", async () => {
  const rt = variantRuntime(), actor = actorFixture(), token = tokenFixture(actor);
  await rt.replaceActorTokenVariants(actor, { variants: [{ id: "v", src: "v.webp" }] });
  await rt.applyTokenVariant(token, "v");
  const untouched = tokenFixture(actor); untouched.id = "base";
  const locked = tokenFixture(actor); locked.id = "locked"; locked.isOwner = false;
  await rt.applyTokenVariant(locked, "v");
  const updates = [];
  rt.game.scenes = [{ tokens: [token, untouched, locked], async updateEmbeddedDocuments(type, changes) {
    assert.equal(type, "Token"); updates.push(...changes);
    for (const update of changes) assignPaths(token, update);
  } }];
  const app = new rt.KhuzoeTokenVariantManagerApp(actor);
  const change = value => app._updateVariant({ currentTarget: { dataset: { variantId: "v", variantManagerField: "scale" }, value } });
  await change("1,25");
  assert.equal(actor.flags.tokenVariants[0].scale, 1.25);
  assert.equal(token.texture.scaleX, -1.25);
  assert.equal(updates.length, 1); assert.equal(updates[0]._id, "token");
  assert.equal(token.x, 23);
  await change("invalid");
  assert.equal(actor.flags.tokenVariants[0].scale, 1.25);
  await change("");
  assert.equal(token.texture.scaleX, -.8); assert.equal(token.texture.scaleY, .9);
  assert.ok(rt.events.some(([event]) => event === moduleId + ".variantsChanged"));
});

test("User image permission follows self/GM ownership and never uses assigned Actor permissions", () => {
  const player = { id: "p" }, other = { id: "q" }, gm = { id: "gm", isGM: true };
  const user = { documentName: "User", id: "p", avatar: "user.webp", img: "wrong.webp", character: { img: "actor.webp" } };
  assert.equal(canEditDocumentImage(user, player), true);
  assert.equal(canEditDocumentImage(user, other), false);
  assert.equal(canEditDocumentImage(user, gm), true);
  assert.equal(canEditDocumentImage({ documentName: "Actor" }, gm), false);
  assert.equal(imageField(user), "avatar"); assert.equal(documentImage(user), "user.webp");
  assert.equal(imageField({ documentName: "Item" }), "img");
});

test("profile editor respects changed image paths, restores stored source transforms, and labels the User", async () => {
  const rt = imageRuntime();
  const user = { documentName: "User", id: "player", uuid: "User.player", name: "Player", avatar: "saved.webp",
    getFlag: () => ({ path: "saved.webp", sourcePath: "source.webp", zoom: 2, offsetX: .2 }) };
  const app = rt.openItemImage(user);
  assert.equal(app.editorState.sourcePath, "source.webp"); assert.equal(app.editorState.zoom, 2);
  assert.equal((await app._prepareContext()).imageLabel, moduleId + ".labels.userImage");
  const different = new rt.KhuzoeItemImageApp(user, { sourcePath: "chosen.webp" });
  assert.equal(different.editorState.sourcePath, ""); assert.equal(different.editorState.zoom, 1);
  assert.equal(different.initialPath, "chosen.webp");
  assert.equal(rt.openItemImage({ ...user, id: "someone-else" }), null);
});

test("saving a User portrait uploads verified images, updates avatar only, and retains unsaved profile fields", async () => {
  const rt = imageRuntime(), writes = [];
  const user = { documentName: "User", id: "player", uuid: "User.player", name: "Player", avatar: "old.webp",
    character: { img: "actor.webp" }, getFlag: () => null,
    async update(data, options) { writes.push({ data, options }); assignPaths(this, data); } };
  const field = { value: "old.webp" }, profile = { document: user, untouchedName: "draft", element: { querySelectorAll: () => [field] } };
  rt.applications.set("profile", profile);
  const app = rt.openItemImage(user);
  const canvas = { toBlob(callback) { callback(new Blob(["webp-content"], { type: "image/webp" })); } };
  app.renderOutputCanvas = () => canvas; app.renderSourceCanvas = () => canvas;
  Object.assign(app.editorState, { dirty: true, image: {}, zoom: 1.25, offsetX: .1 });
  await app.save();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.img, undefined);
  assert.equal(user.character.img, "actor.webp");
  assert.ok(user.avatar.startsWith("icons/test/users/player/objects/user-"));
  assert.equal(field.value, user.avatar); assert.equal(profile.untouchedName, "draft");
  assert.equal(writes[0].options.render, false);
  const edit = writes[0].data[`flags.${moduleId}.imageEdit`];
  assert.ok(edit.sourcePath.includes("/sources/source-")); assert.equal(edit.zoom, 1.25);
  assert.equal(rt.uploads.length, 2);
  assert.ok(rt.events.some(([event]) => event === moduleId + ".userImageSaved"));
  assert.ok(!rt.events.some(([event]) => event === moduleId + ".itemImageSaved"));
  assert.equal(rt.notices.filter(([level]) => level === "error").length, 0);
});

test("without stored sources the exported image reopens without applying its crop twice", async () => {
  const rt = imageRuntime(); rt.settings.storeSources = false;
  const user = { documentName: "User", id: "player", avatar: "old.webp", getFlag: () => null,
    async update(data) { assignPaths(this, data); } };
  const app = rt.openItemImage(user);
  app.renderOutputCanvas = () => ({ toBlob: callback => callback(new Blob(["pixels"])) });
  Object.assign(app.editorState, { dirty: true, image: {}, zoom: 2, offsetX: .3 });
  await app.save();
  const edit = user.flags[moduleId].imageEdit;
  assert.equal(edit.zoom, 1); assert.equal(edit.mode, "fit"); assert.equal(edit.offsetX, 0);
  assert.equal(edit.sourcePath, edit.path); assert.equal(rt.uploads.length, 1);
});

test("failed upload verification and revoked ownership cannot change the profile", async () => {
  const rt = imageRuntime(); let writes = 0;
  const user = { documentName: "User", id: "player", avatar: "old.webp", getFlag: () => null, async update() { writes++; } };
  const app = rt.openItemImage(user);
  app.renderOutputCanvas = () => ({ toBlob: callback => callback(new Blob(["pixels"])) });
  Object.assign(app.editorState, { dirty: true, image: {} });
  rt.filePicker.upload = async () => ({ path: "missing/file.webp" });
  rt.sandbox.console = { ...console, error() {} };
  await app.save(); assert.equal(writes, 0); assert.equal(user.avatar, "old.webp");
  rt.game.user = { id: "other" };
  await app.save(); assert.equal(writes, 0);
  assert.ok(rt.notices.some(([level]) => level === "error"));
});

test("profile button binds the avatar field, opens its selected source and is absent for other players", () => {
  const rt = imageRuntime(), appended = [];
  const user = { documentName: "User", id: "player", avatar: "old.webp", getFlag: () => null };
  let click;
  const field = { value: "selected.webp", closest: () => ({ appendChild: button => appended.push(button) }) };
  const root = { querySelector: selector => selector.startsWith("file-picker") ? field : null,
    ownerDocument: { createElement: () => ({ addEventListener: (_event, handler) => { click = handler; } }) } };
  rt.injectUserTrigger({ document: user }, root);
  assert.equal(appended.length, 1);
  click({ preventDefault() {}, stopPropagation() {} });
  assert.equal([...rt.applications.values()][0].initialPath, "selected.webp");
  rt.game.user = { id: "other" };
  rt.injectUserTrigger({ document: user }, root);
  assert.equal(appended.length, 1);
});

test("GM directory requests authenticate sender and only accept own User or owned Item", async () => {
  const rt = imageRuntime();
  rt.game.user = { id: "gm", isGM: true };
  rt.game.users.set("player", { documentName: "User", id: "player" });
  rt.game.users.set("victim", { documentName: "User", id: "victim" });
  const message = { requestId: "request", requesterUserId: "player", gmUserId: "gm", userId: "player" };
  await rt.handleDirectoryRequestAsGm(message, "forged");
  assert.equal(rt.socketMessages.length, 0);
  await rt.handleDirectoryRequestAsGm(message, "player");
  assert.equal(rt.socketMessages.at(-1).ok, true);
  await rt.handleDirectoryRequestAsGm({ ...message, userId: "victim" }, "player");
  assert.equal(rt.socketMessages.at(-1).ok, false);
  assert.equal(rt.socketMessages.at(-1).errorCode, "unauthorized");
});

test("shared crop renderer applies cover, zoom and framing to the exported portrait", () => {
  const rt = imageRuntime(), draws = [];
  const context = { drawImage: (...args) => draws.push(args) };
  rt.drawImageState(context, { image: { width: 400, height: 200 }, background: { enabled: false }, mode: "cover", zoom: 1.25, offsetX: .1, offsetY: -.1 }, 100);
  assert.deepEqual(draws[0].slice(1), [-65, -22.5, 250, 125]);
});

test("variant portraits follow individual linked tokens, not the shared Actor", async () => {
  const r = variantRuntime(), actor = actorFixture();
  const variants = [r.createTokenVariant({ id: "one", src: "one.webp", avatarSrc: "one-portrait.webp" }), r.createTokenVariant({ id: "two", src: "two.webp", avatarSrc: "two-portrait.webp" }), r.createTokenVariant({ id: "legacy", src: "legacy.webp" })];
  actor.flags.tokenVariants = variants;
  const first = tokenFixture(actor), second = tokenFixture(actor);
  first.actorLink = second.actorLink = true;
  second.id = "second";
  await r.applyTokenVariant(first, "one");
  await r.applyTokenVariant(second, "two");
  assert.equal(r.getTokenAvatar(first), "one-portrait.webp");
  assert.equal(r.getTokenAvatar({ document: second }), "two-portrait.webp");
  assert.equal(actor.img, "portrait.webp");
  assert.equal(actor.prototypeToken.texture.src, "base.webp");
  const secondBefore = clone(second.updates);
  await r.applyTokenVariant(first, "legacy");
  assert.equal(r.getTokenAvatar(first), actor.img);
  assert.deepEqual(second.updates, secondBefore);
  assert.equal(r.getTokenAvatar(second), "two-portrait.webp");
  await r.restoreTokenVariantBase(second);
  assert.equal(r.getTokenAvatar(second), actor.img);
  assert.equal(r.getTokenAvatar(null), "");
});

test("portrait resolves the variant owner catalog and falls back after deletion", async () => {
  const r = variantRuntime(), actor = actorFixture(), owner = actorFixture();
  owner.id = "catalog-owner";
  owner.flags.tokenVariants = [r.createTokenVariant({ id: "form", src: "form.webp", avatarSrc: "form-portrait.webp" })];
  r.game.actors.set(owner.id, owner);
  const token = tokenFixture(actor);
  await r.applyTokenVariant(token, "form", { actor: owner });
  assert.equal(r.getTokenAvatar(token), "form-portrait.webp");
  owner.flags.tokenVariants = [];
  assert.equal(r.getTokenAvatar(token), actor.img);
  assert.equal(actor.img, "portrait.webp");
});

test("external variant synchronization preserves omitted portraits and supports explicit reset", async () => {
  const r = variantRuntime(), actor = actorFixture();
  actor.flags.tokenVariants = [r.createTokenVariant({ id: "one", src: "one.webp", avatarSrc: "local-portrait.webp", scale: 1.25 })];
  await r.replaceActorTokenVariants(actor, { variants: [{ id: "one", src: "updated.webp" }] });
  assert.equal(actor.flags.tokenVariants[0].avatarSrc, "local-portrait.webp");
  assert.equal(actor.flags.tokenVariants[0].scale, 1.25);
  await r.replaceActorTokenVariants(actor, { variants: [{ id: "one", src: "updated.webp", avatarSrc: null }] });
  assert.equal(actor.flags.tokenVariants[0].avatarSrc, "");
  await r.syncActorTokenVariants(actor, { source: "external", variants: [{ id: "other", src: "other.webp", avatarSrc: "external.webp" }] });
  await r.syncActorTokenVariants(actor, { source: "external", variants: [{ id: "other", src: "changed.webp" }] });
  assert.equal(actor.flags.tokenVariants.find(v => v.id === "other").avatarSrc, "external.webp");
  await r.syncActorTokenVariants(actor, { source: "external", variants: [{ id: "other", src: "changed.webp", avatarSrc: "" }] });
  assert.equal(actor.flags.tokenVariants.find(v => v.id === "other").avatarSrc, "");
  assert.equal(actor.img, "portrait.webp");
});

function portraitUploadRuntime() {
  const r = variantRuntime();
  const canvases = [];
  r.sandbox.Image = class {
    constructor() { this.naturalWidth = 600; this.naturalHeight = 1800; }
    set src(value) { this.onload(); }
  };
  r.sandbox.document = { createElement() {
    const canvas = { getContext() { return { drawImage() {} }; }, toBlob(callback) { callback(new Blob(["portrait"], { type: "image/webp" })); } };
    canvases.push(canvas); return canvas;
  } };
  return { ...r, canvases };
}

test("portrait upload retains vertical shape, metadata and active token isolation", async () => {
  const r = portraitUploadRuntime(), actor = actorFixture();
  actor.isOwner = true;
  actor.flags.tokenVariants = [r.createTokenVariant({ id: "one", name: "Forma", src: "one.webp", scale: 1.25, width: 2 })];
  const first = tokenFixture(actor), second = tokenFixture(actor);
  await r.applyTokenVariant(first, "one");
  await r.saveActorVariantAvatar(actor, "one", "source.png");
  assert.equal(r.canvases[0].height, 1024);
  assert.equal(r.canvases[0].width, 341);
  assert.match(actor.flags.tokenVariants[0].avatarSrc, /avatar-variant-one-[a-f0-9]+\.webp$/);
  assert.equal(actor.flags.tokenVariants[0].src, "one.webp");
  assert.equal(actor.flags.tokenVariants[0].name, "Forma");
  assert.equal(actor.flags.tokenVariants[0].scale, 1.25);
  assert.equal(actor.flags.tokenVariants[0].width, 2);
  assert.equal(r.getTokenAvatar(first), actor.flags.tokenVariants[0].avatarSrc);
  assert.equal(r.getTokenAvatar(second), actor.img);
  assert.equal(actor.img, "portrait.webp");
  assert.ok(r.events.some(([name]) => name === moduleId + ".variantsChanged"));
  await r.saveActorVariantAvatar(actor, "one", "");
  assert.equal(r.getTokenAvatar(first), actor.img);
  assert.equal(r.uploads.length, 1, "removing an association never uploads or deletes files");
});

test("failed portrait uploads and unauthorized edits leave the catalog unchanged", async () => {
  const r = portraitUploadRuntime(), actor = actorFixture();
  actor.isOwner = true;
  actor.flags.tokenVariants = [r.createTokenVariant({ id: "one", src: "one.webp", avatarSrc: "previous.webp" })];
  const before = clone(actor.flags);
  r.filePicker.upload = async () => ({ path: "missing.webp" });
  await assert.rejects(r.saveActorVariantAvatar(actor, "one", "source.png"));
  assert.deepEqual(clone(actor.flags), before);
  assert.equal(r.events.length, 0);
  actor.isOwner = false;
  await assert.rejects(r.saveActorVariantAvatar(actor, "one", ""));
  assert.deepEqual(clone(actor.flags), before);
  actor.isOwner = true;
  actor.flags.tokenVariants[0].source = "managed";
  await assert.rejects(r.saveActorVariantAvatar(actor, "one", ""));
  assert.equal(actor.flags.tokenVariants[0].avatarSrc, "previous.webp");
});
