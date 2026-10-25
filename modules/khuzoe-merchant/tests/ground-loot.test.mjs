import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

// Every document below is in memory. This suite never opens a Foundry world/database.
const MODULE = "khuzoe-merchant";
let serial = 0;
const id = () => String(++serial).padStart(16, "0");
const clone = structuredClone;
const getProperty = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function setProperty(object, path, value) {
  const keys = path.split(".");
  for (const key of keys.slice(0, -1)) object = object[key] ??= {};
  object[keys.at(-1)] = value;
}
function updateData(document, changes) {
  for (const [key, value] of Object.entries(changes)) setProperty(document, key, clone(value));
}
class Collection extends Map {
  [Symbol.iterator]() { return this.values(); }
}
class ApplicationV2 {}
const callbacks = new Map();
globalThis.Hooks = {
  on(name, callback) { const list = callbacks.get(name) || []; list.push(callback); callbacks.set(name, list); },
  once() {}
};
globalThis.foundry = {
  utils: { deepClone: clone, getProperty, setProperty, randomID: id, mergeObject: (base, data) => ({ ...base, ...data }) },
  applications: {
    api: { ApplicationV2, HandlebarsApplicationMixin: Base => Base,
      DialogV2: { input: async () => ({ quantity: 1 }), confirm: async () => true } },
    instances: new Map()
  }
};
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OWNER: 3 },
  TOKEN_DISPLAY_MODES: { NONE: 0, HOVER: 20 }, TOKEN_DISPOSITIONS: { NEUTRAL: 0 }
};
globalThis.document = { addEventListener() {} };
const errors = [];
globalThis.ui = { notifications: { info() {}, error: key => errors.push(key) } };
globalThis.CONFIG = { Actor: {}, Token: {}, Item: {} };
globalThis.game = {};
globalThis.canvas = {};

const map = await import("../scripts/map-object.js");
const groundData = await import("../scripts/ground-loot-data.js");
const items = await import("../scripts/item-transfer.js");
const socket = await import("../scripts/loot-socket.js");
const ground = await import("../scripts/ground-loot.js");
const preview = await import("../scripts/ground-loot-preview.js");
const integration = await import("../scripts/ground-loot-integration.js");
const coordinator = await import("../scripts/transaction-coordinator.js");

class Actor {
  constructor(name, flags = {}) {
    this.id = id(); this.uuid = `Actor.${this.id}`; this.name = name; this.documentName = "Actor";
    this.type = "character"; this.token = null; this.flags = flags; this.items = new Collection();
    this.system = { currency: { gp: 10, sp: 0, cp: 0, ep: 0, pp: 0 } };
    this.owner = true;
  }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  testUserPermission(user) { return user.isGM || this.owner; }
  async update(changes, options = {}) { if (!this.skipWallet || options.khuzoeMerchantRollback) updateData(this, changes); return this; }
  async createEmbeddedDocuments(_type, data, options = {}) {
    const accepted = this.partialCreation ? data.slice(0, 1) : data;
    const created = accepted.map(value => {
      const item = new Item(this, { ...value, _id: options.keepId ? value._id : id() });
      this.items.set(item.id, item); return item;
    });
    if (this.throwAfterCreation) throw new Error("simulated lost creation response");
    return created;
  }
  async deleteEmbeddedDocuments(_type, ids, options = {}) {
    if (this.preventDeletion && !options.khuzoeMerchantRollback) return [];
    const accepted = this.partialDeletion ? ids.slice(0, 1) : ids;
    for (const key of accepted) this.items.delete(key);
    if (this.throwAfterDeletion && !options.khuzoeMerchantRollback) throw new Error("lost source deletion response");
    return accepted;
  }
}
class Item {
  constructor(actor, data) {
    this.parent = actor; this.documentName = "Item";
    Object.assign(this, clone(data)); this.id = data._id || id(); this._id = this.id;
    this.uuid = `${actor.uuid}.Item.${this.id}`;
    this.flags ??= {};
    Object.defineProperty(this.system, "contents", {
      configurable: true, get: () => Promise.resolve([...this.parent.items].filter(child => child.system.container === this.id))
    });
  }
  toObject() { return clone({ _id: this.id, name: this.name, type: this.type, system: this.system, flags: this.flags }); }
  async update(changes, options = {}) {
    if (!this.skipUpdate || options.khuzoeMerchantRollback) updateData(this, changes);
    if (this.throwAfterUpdate && !options.khuzoeMerchantRollback) throw new Error("lost source quantity response");
    return this;
  }
}
class Token {
  constructor(scene, actor, data = {}) {
    this.id = data._id || id(); this.documentName = "Token"; this.actor = actor; this.actorId = actor?.id;
    this.parent = scene; this.x = 0; this.y = 0; this.width = 1; this.height = 1;
    this.flags = {}; this.hidden = false; this.locked = false; this.displayBars = 50;
    this.bar1 = { attribute: "attributes.hp" }; this.bar2 = { attribute: "resources.secondary" };
    Object.assign(this, clone(data)); this.uuid = `Scene.${scene.id}.Token.${this.id}`;
  }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  getBarAttribute(name) { return { attribute: this[name].attribute, value: 10, max: 10 }; }
  toObject() { return clone({ _id: this.id, actorId: this.actorId, x: this.x, y: this.y, flags: this.flags, name: this.name }); }
  async update(changes, options = {}) {
    if (!this.skipUpdate || options.khuzoeMerchantRollback) updateData(this, changes);
    if (this.throwAfterUpdate && !options.khuzoeMerchantRollback) throw new Error("lost ground quantity response");
    return this;
  }
  async move(points, options) {
    this.lastMove = { points, options };
    if (this.preventMove) return false;
    updateData(this, points.at(-1)); return true;
  }
}
class Scene {
  constructor() {
    this.id = id(); this.grid = { size: 100, distance: 5, units: "ft" };
    this.tokens = new Collection(); this.tiles = new Collection(); this.levels = new Collection();
    this.updates = []; this.creations = 0;
  }
  async createEmbeddedDocuments(type, records, options = {}) {
    this.creations++;
    if (this.preventCreation && !options.khuzoeMerchantRollback) return [];
    const created = records.map(data => {
      const token = new Token(this, game.actors.get(data.actorId), data); token.documentName = type;
      (type === "Tile" ? this.tiles : this.tokens).set(token.id, token); return token;
    });
    if (this.throwAfterCreation && !options.khuzoeMerchantRollback) throw new Error("lost ground creation response");
    return created;
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    if (this.preventDeletion && !options.khuzoeMerchantRollback) return [];
    for (const key of ids) (type === "Tile" ? this.tiles : this.tokens).delete(key);
    if (this.throwAfterDeletion && !options.khuzoeMerchantRollback) throw new Error("lost ground deletion response");
    return ids;
  }
  async updateEmbeddedDocuments(type, updates) {
    this.updates.push(clone(updates));
    for (const update of updates) await this.tokens.get(update._id).update(update);
  }
}
let scene, gm, player, buyer, buyerToken, sourceActor, sourceToken, proxy, socketHandler, responses;
beforeEach(context => {
  // Failure-path logging is expected; assertions below verify the outcome and rollback.
  context.mock.method(console, "error", () => {});
  callbacks.clear(); errors.length = 0;
  scene = new Scene(); gm = { id: "gm", isGM: true, active: true, viewedScene: scene.id };
  player = { id: "player", isGM: false, active: true, viewedScene: scene.id };
  const users = new Collection([[gm.id, gm], [player.id, player]]); users.activeGM = gm;
  buyer = new Actor("Recipient"); sourceActor = new Actor("Source");
  proxy = new Actor("Ground proxy", { [MODULE]: { groundLootProxy: true } }); proxy.type = "npc";
  game.user = gm; game.users = users; game.system = { id: "dnd5e", documentTypes: { Actor: ["npc", "character"] } };
  game.scenes = new Collection([[scene.id, scene]]);
  game.actors = new Collection([buyer, sourceActor, proxy].map(actor => [actor.id, actor]));
  game.items = new Collection(); game.modules = new Map(); game.paused = false; game.activeTool = "select";
  game.i18n = { lang: "it", localize: key => key, format: key => key };
  game.settings = { get: (_scope, key) => ({ groundLootDistance: 5, groundLootScale: 0.72, currencyMode: "auto", allowUnownedActorTransfers: false })[key] };
  responses = [];
  game.socket = { on: (_name, handler) => { socketHandler = handler; }, emit: (_name, payload) => responses.push(payload) };
  socket.initializeLootSocket();
  buyerToken = new Token(scene, buyer, { x: 100 }); sourceToken = new Token(scene, sourceActor);
  scene.tokens.set(buyerToken.id, buyerToken); scene.tokens.set(sourceToken.id, sourceToken);
  canvas.ready = true; canvas.scene = scene; canvas.regions = {};
  canvas.tokens = { controlled: [], placeables: [buyerToken, sourceToken], get: key => scene.tokens.get(key) };
  CONFIG.Token.documentClass = Token;
  CONFIG.Item.documentClass = {
    async createWithContents(roots, { keepId, transformAll }) {
      const bundle = [];
      const visit = async (document, parent, depth) => {
        const data = await transformAll(document, { depth, container: parent });
        data._id = keepId ? document.id : id(); data.system.container = parent;
        bundle.push(data);
        for (const child of await document.system.contents) await visit(child, data._id, depth + 1);
      };
      for (const root of roots) await visit(root, null, 0);
      return bundle;
    }
  };
  globalThis.fromUuid = async uuid => {
    for (const actor of game.actors) for (const item of actor.items) if (item.uuid === uuid) return item;
    return null;
  };
});
function item(actor = sourceActor, quantity = 3, type = "consumable") {
  const value = new Item(actor, { _id: id(), name: "Potion", type, system: { quantity, container: null } });
  actor.items.set(value.id, value); return value;
}
function lootToken(loot = {}) {
  const value = new Token(scene, proxy, { x: 100, flags: { [MODULE]: { groundLoot: {
    name: "Potion", quantity: 3, droppedBy: player.id,
    item: { name: "Potion", type: "consumable", system: { quantity: 3, container: null } }, ...loot
  } } } });
  scene.tokens.set(value.id, value); return value;
}
function nestedLoot() {
  return lootToken({ quantity: 1, name: "Backpack", itemBundle: [
    { _id: "bag", name: "Backpack", type: "container", system: { quantity: 1, container: null } },
    { _id: "pouch", name: "Pouch", type: "container", system: { quantity: 1, container: "bag" } },
    { _id: "gem", name: "Gem", type: "loot", system: { quantity: 2, container: "pouch" } }
  ] });
}
async function remote(operation, data, sender = player) {
  const requestId = id();
  socketHandler({ type: `ground-loot-${operation}-request`, requestId, userId: sender.id, ...data }, sender.id);
  await coordinator.enqueueTransaction(async () => {});
  return responses.find(response => response.requestId === requestId);
}
const pickup = (token, quantity = 1) => socket.requestPickupLoot({ groundObject: token, buyerToken, quantity });

test("players can inspect nested ground containers and leave without changing any document", async context => {
  game.user = player;
  const token = nestedLoot();
  const loot = groundData.getGroundLoot(token);
  loot.itemBundle[2].name = '<img src=x onerror="alert(1)"> Gem';
  loot.itemBundle[1].system.currency = {gp: 7};
  const before = clone(token.toObject());
  canvas.tokens.controlled = [buyerToken];
  let shown = 0;
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async dialog => {
    shown++;
    assert.match(dialog.content, /Pouch/);
    assert.match(dialog.content, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; Gem/);
    assert.doesNotMatch(dialog.content, /<img/);
    assert.match(dialog.content, /× 2/);
    assert.match(dialog.content, /\(GP\)/);
    assert.equal(dialog.no.label, "KM.GroundLoot.LeaveOnGround");
    assert.equal(dialog.no.default, true);
    assert.equal(dialog.rejectClose, false);
    assert.equal(buyer.items.size, 0);
    return false;
  });
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(shown, 1);
  assert.deepEqual(token.toObject(), before);
  assert.equal(buyer.items.size, 0);
  assert.equal(responses.length, 0, "Inspection sends no pickup request");
  assert.equal(scene.tokens.get(token.id), token);
});

test("closing a container preview never collects it, including empty legacy backpacks", async context => {
  canvas.tokens.controlled = [buyerToken];
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async dialog => {
    assert.match(dialog.content, /KM.GroundLoot.EmptyContainer/);
    return null;
  });
  const token = lootToken({name: "Old bag", quantity: 1, item: {type: "backpack", name: "Old bag", system: {quantity: 1}}});
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(scene.tokens.get(token.id), token);
  assert.equal(buyer.items.size, 0);
});

test("confirmation collects the entire previewed bundle with nested links intact", async context => {
  canvas.tokens.controlled = [buyerToken];
  const token = nestedLoot();
  groundData.getGroundLoot(token).quantity = 2;
  let shown = 0;
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async dialog => {
    shown++;
    assert.match(dialog.content, /Backpack/);
    assert.equal(buyer.items.size, 0);
    return true;
  });
  context.mock.method(foundry.applications.api.DialogV2, "input", async () => assert.fail("A full bundle cannot be partly taken"));
  assert.equal(await ground.openGroundLoot(token), true);
  assert.equal(shown, 1);
  const [bag, pouch, gem] = [...buyer.items];
  assert.equal(bag.system.quantity, 2);
  assert.equal(pouch.system.container, bag.id);
  assert.equal(gem.system.container, pouch.id);
  assert.equal(scene.tokens.has(token.id), false);
});

test("ground previews keep hidden, distant and unowned containers inaccessible", async context => {
  game.user = player; canvas.tokens.controlled = [buyerToken];
  const token = nestedLoot();
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async () => assert.fail("No preview expected"));
  token.hidden = true;
  assert.equal(await ground.openGroundLoot(token), false);
  token.hidden = false; token.x = 1000;
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(errors.at(-1), "KM.GroundLoot.Errors.OutOfRange");
  token.x = 100; buyer.owner = false;
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(responses.length, 0);
});

test("the GM still checks distance and availability after the preview closes", async context => {
  canvas.tokens.controlled = [buyerToken];
  const token = nestedLoot();
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async () => { buyerToken.x = 1000; return true; });
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(buyer.items.size, 0);
  assert.equal(scene.tokens.has(token.id), true);
  assert.equal(errors.at(-1), "KM.GroundLoot.Errors.OutOfRange");
  buyerToken.x = 100;
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async () => { scene.tokens.delete(token.id); return true; });
  assert.equal(await ground.openGroundLoot(token), false);
  assert.equal(buyer.items.size, 0);
  assert.equal(errors.at(-1), "KM.GroundLoot.Errors.AlreadyTaken");
});

test("ordinary items and loose currency retain their existing pickup flow", async context => {
  canvas.tokens.controlled = [buyerToken];
  context.mock.method(foundry.applications.api.DialogV2, "confirm", async () => assert.fail("No container confirmation expected"));
  assert.equal(await ground.openGroundLoot(lootToken({quantity: 1})), true);
  assert.equal(preview.groundLootContainerPreview({kind: "currency", type: "container"}), null);
  assert.equal(await ground.openGroundLoot(lootToken({kind: "currency", currencyId: "gp", amount: 1, quantity: 1})), true);
  assert.equal(buyer.system.currency.gp, 11);
});

test("new loot and existing ground/container tokens have no resource bars; normal actors keep theirs", async () => {
  const data = groundData.buildGroundLootTokenData(scene, { name: "Coin" }, { x: 10, y: 20, actorId: proxy.id });
  assert.equal(data.bar1.attribute, null); assert.equal(data.bar2.attribute, null); assert.equal(data.displayBars, 0);
  integration.patchObjectTokenDocument(Token);
  const old = lootToken(); const snapshot = clone(old.bar1);
  assert.equal(old.getBarAttribute("bar1"), null); assert.deepEqual(old.bar1, snapshot);
  const chest = new Token(scene, proxy, { flags: { [MODULE]: { container: { name: "Chest" } } } });
  assert.equal(chest.getBarAttribute("bar2"), null);
  assert.equal(buyerToken.getBarAttribute("bar1").value, 10);
  assert.equal(map.isInventoryToken(chest), false); assert.equal(map.isInventoryActor(proxy), false);
  assert.equal(map.mapObjectKind(old), "groundLoot"); assert.equal(map.mapObjectKind(chest), "container");
});

test("combat and health integrations exclude only managed map objects", () => {
  const groundToken = lootToken();
  assert.equal(integration.canCreateObjectCombatant({ token: groundToken }), false);
  assert.equal(integration.canCreateObjectCombatant({ token: buyerToken }), undefined);
  const provider = { breakCondition: () => false }; integration.patchHealthEstimate(provider);
  assert.equal(provider.breakCondition(groundToken), true); assert.equal(provider.breakCondition(buyerToken), false);
  const Utils = { getControlledTokens: () => [groundToken, buyerToken], getFirstControlledToken: () => groundToken };
  integration.patchActionHud({ Utils }); canvas.tokens.controlled = [groundToken, buyerToken];
  assert.deepEqual(Utils.getControlledTokens(), [buyerToken]); assert.equal(Utils.getFirstControlledToken(), buyerToken);
  class Hud { currentTokenDocument() { return this.token; } }
  integration.patchMonsterHud(Hud); const hud = new Hud(); hud.token = groundToken;
  assert.equal(hud.currentTokenDocument(), null); hud.token = buyerToken; assert.equal(hud.currentTokenDocument(), buyerToken);
});

test("nested pickup preserves every parent reference and removes the ground token", async () => {
  const token = nestedLoot(); const result = await pickup(token);
  assert.equal(result.ok, true); assert.equal(scene.tokens.has(token.id), false);
  const [bag, pouch, gem] = [...buyer.items];
  assert.equal(pouch.system.container, bag.id); assert.equal(gem.system.container, pouch.id);
  assert.equal(gem.system.quantity, 2); assert.notEqual(bag.id, "bag");
});

test("partial pickup leaves the remainder, and a subsequent pickup stacks correctly", async () => {
  const token = lootToken(); assert.equal((await pickup(token, 1)).ok, true);
  assert.equal(groundData.getGroundLoot(token).quantity, 2);
  assert.equal((await pickup(token, 2)).ok, true);
  assert.equal(buyer.items.size, 1); assert.equal([...buyer.items][0].system.quantity, 3);
});

test("a vetoed ground deletion rolls back the received inventory", async () => {
  const token = nestedLoot(); scene.preventDeletion = true;
  assert.equal((await pickup(token)).ok, false);
  assert.equal(buyer.items.size, 0); assert.equal(scene.tokens.has(token.id), true);
});

test("partial Item creation and a lost creation response roll back all created Items", async () => {
  const token = nestedLoot(); buyer.partialCreation = true;
  assert.equal((await pickup(token)).ok, false); assert.equal(buyer.items.size, 0);
  buyer.partialCreation = false; buyer.throwAfterCreation = true;
  assert.equal((await pickup(token)).ok, false); assert.equal(buyer.items.size, 0);
  assert.equal(scene.tokens.has(token.id), true);
});

test("vetoed ground quantity updates and stack updates never duplicate loot", async () => {
  const token = lootToken(); token.skipUpdate = true;
  assert.equal((await pickup(token)).ok, false); assert.equal(buyer.items.size, 0);
  token.skipUpdate = false; assert.equal((await pickup(token)).ok, true);
  [...buyer.items][0].skipUpdate = true;
  assert.equal((await pickup(token)).ok, false);
  assert.equal(groundData.getGroundLoot(token).quantity, 2); assert.equal([...buyer.items][0].system.quantity, 1);
});

test("currency pickup verifies wallet updates and restores them when removal fails", async () => {
  const token = lootToken({ kind: "currency", quantity: 4, amount: 4, currencyId: "gp" });
  buyer.skipWallet = true; assert.equal((await pickup(token, 2)).ok, false);
  assert.equal(buyer.system.currency.gp, 10); assert.equal(groundData.getGroundLoot(token).amount, 4);
  buyer.skipWallet = false; assert.equal((await pickup(token, 2)).ok, true);
  assert.equal(buyer.system.currency.gp, 12); assert.equal(groundData.getGroundLoot(token).amount, 2);
  scene.preventDeletion = true; assert.equal((await pickup(token, 2)).ok, false);
  assert.equal(buyer.system.currency.gp, 12);
});

test("a linked Actor transfers to an adjacent authorized token through the GM", async () => {
  const sourceItem = item(); canvas.tokens.controlled = [sourceToken];
  const result = await remote("transfer", { itemUuid: sourceItem.uuid, targetSceneId: scene.id,
    targetTokenId: buyerToken.id, sourceSceneId: scene.id, quantity: 1 });
  assert.equal(result.ok, true); assert.equal(sourceItem.system.quantity, 2); assert.equal(buyer.items.size, 1);
});

test("the client resolves linked source and target Tokens for sheet transfers", async () => {
  const sourceItem = item(); game.user = player; canvas.tokens.controlled = [sourceToken];
  const originalEmit = game.socket.emit;
  // Reject immediately after observing the emitted request, without starting network timers.
  game.socket.emit = (_channel, payload) => { originalEmit(_channel, payload); throw new Error("captured request"); };
  await assert.rejects(socket.requestTransferItem({ item: sourceItem, targetActor: buyer }), /captured request/);
  const payload = responses.at(-1);
  assert.equal(payload.sourceTokenId, sourceToken.id); assert.equal(payload.sourceSceneId, scene.id);
  assert.equal(payload.targetTokenId, buyerToken.id);
});

test("distance validation rejects an unrelated source token, remote sheets and ambiguous sources", async () => {
  const sourceItem = item(); const base = { itemUuid: sourceItem.uuid, targetActorId: buyer.id, quantity: 1 };
  assert.equal((await remote("transfer", { ...base, sourceTokenId: buyerToken.id })).ok, false);
  sourceToken.x = 2000; assert.equal((await remote("transfer", base)).ok, false);
  sourceToken.x = 0; const another = new Token(scene, sourceActor); scene.tokens.set(another.id, another);
  assert.equal((await remote("transfer", base)).ok, false);
  assert.equal(sourceItem.system.quantity, 3); assert.equal(buyer.items.size, 0);
});

test("a vetoed source removal rolls back direct delivery and ground drops", async () => {
  const sourceItem = item(sourceActor, 1); sourceActor.preventDeletion = true;
  assert.equal((await socket.requestTransferItem({ item: sourceItem, targetToken: buyerToken })).ok, false);
  assert.equal(buyer.items.size, 0); assert.equal(sourceActor.items.has(sourceItem.id), true);
  const count = scene.tokens.size;
  assert.equal((await socket.requestDropItem({ item: sourceItem, scene, x: 50, y: 50 })).ok, false);
  assert.equal(scene.tokens.size, count);
});

test("ground loot and chest proxy Actors cannot receive pickups or deliveries even for a GM", async () => {
  const token = lootToken();
  assert.equal((await socket.requestPickupLoot({ groundObject: token, buyerToken: token })).ok, false);
  assert.equal((await socket.requestTransferItem({ item: item(), targetToken: token })).ok, false);
  assert.equal(proxy.items.size, 0);
});

test("replayed player pickups execute only once", async () => {
  const token = lootToken(); const request = { type: "ground-loot-pickup-request", requestId: id(), userId: player.id,
    sceneId: scene.id, lootId: token.id, buyerTokenId: buyerToken.id, quantity: 1 };
  socketHandler(request, player.id); socketHandler(request, player.id);
  await coordinator.enqueueTransaction(async () => {});
  assert.equal(groundData.getGroundLoot(token).quantity, 2); assert.equal([...buyer.items][0].system.quantity, 1);
});

class Placeable {
  constructor(token) {
    this.document = token; this.actor = token.actor; this.id = token.id;
    this.layer = { active: true, clearPreviewContainer: () => { this.cleared = true; } };
  }
  _onClickLeft() { canvas.tokens.controlled = [this]; }
  _onClickLeft2() { this.nativeClick = true; }
  _onDragLeftDrop() { this.nativeDrop = true; }
  _getDragConstrainOptions() { return { ignoreCost: false, ignoreWalls: false }; }
  _prepareDragLeftDropUpdates() {
    if (this.failPrepare) throw new Error("invalid preview");
    return [[{ _id: this.id }], { movement: { [this.id]: { waypoints: [{ x: 220, y: 100, elevation: 5 }] } } }];
  }
}
ground.patchGroundLootPlaceableClass(Placeable);
test("v14 dragging uses native movement waypoints, preserves elevation and cleans up previews", async () => {
  const token = lootToken(); const placeable = new Placeable(token); const event = { interactionData: {} };
  await placeable._onDragLeftDrop(event);
  assert.equal(token.x, 220); assert.equal(token.elevation, 5); assert.equal(placeable.cleared, true);
  assert.equal(token.lastMove.options.constrainOptions.ignoreCost, true);
  assert.equal(placeable._getDragConstrainOptions().ignoreCost, true);
  const normal = new Placeable(buyerToken); await normal._onDragLeftDrop(event);
  assert.equal(normal.nativeDrop, true); assert.equal(normal._getDragConstrainOptions().ignoreCost, false);
});

test("cancelled, rejected and failed drags clear their previews without moving", async () => {
  const token = lootToken(); const placeable = new Placeable(token);
  await placeable._onDragLeftDrop({ interactionData: { cancelled: true } });
  assert.equal(placeable.cleared, true); assert.equal(token.x, 100);
  placeable.failPrepare = true; placeable.cleared = false;
  await placeable._onDragLeftDrop({ interactionData: {} });
  assert.equal(placeable.cleared, true); assert.equal(token.x, 100);
  placeable.failPrepare = false; token.preventMove = true;
  await placeable._onDragLeftDrop({ interactionData: {} }); assert.equal(token.x, 100);
});

test("player moves require the dropper, visibility and an unlocked unpaused token", async () => {
  const token = lootToken(); const payload = { sceneId: scene.id, lootId: token.id, waypoints: [{ x: 180, y: 100 }] };
  assert.equal((await remote("move", payload)).ok, true);
  token.hidden = true; assert.equal((await remote("move", payload)).ok, false); token.hidden = false;
  token.locked = true; assert.equal((await remote("move", payload)).ok, false); token.locked = false;
  game.paused = true; assert.equal((await remote("move", payload)).ok, false); game.paused = false;
  token.flags[MODULE].groundLoot.droppedBy = "someone-else";
  assert.equal((await remote("move", payload)).ok, false);
});

test("double click preserves exactly one recipient; multiple selected characters never use a previous recipient", async () => {
  const token = lootToken({ quantity: 1 }); const placeable = new Placeable(token);
  canvas.tokens.controlled = [buyerToken]; placeable._onClickLeft();
  assert.equal(await ground.openGroundLoot(token), true); assert.equal(buyer.items.size, 1);
  const next = lootToken({ quantity: 1 }); const nextPlaceable = new Placeable(next);
  canvas.tokens.controlled = [buyerToken, sourceToken]; nextPlaceable._onClickLeft();
  assert.equal(await ground.openGroundLoot(next), false);
  assert.equal(errors.at(-1), "KM.GroundLoot.Errors.MultipleBuyerTokens"); assert.equal(sourceActor.items.size, 0);
});

test("settings maintenance is read only by default, selective and idempotent when explicitly applied", async () => {
  const token = lootToken(); const preview = await ground.migrateGroundLootTokenSettings();
  assert.equal(preview.applied, false); assert.equal(scene.updates.length, 0); assert.equal(scene.creations, 0);
  assert.deepEqual(preview.changes[0].updates.map(change => change._id), [token.id]);
  await ground.migrateGroundLootTokenSettings({ apply: true });
  assert.equal(token.bar1.attribute, null); assert.equal(buyerToken.bar1.attribute, "attributes.hp");
  assert.deepEqual((await ground.migrateGroundLootTokenSettings()).changes, []);
});

test("HUD reuse restores creature controls and targeting never selects map objects", () => {
  const classes = new Set();
  const root = { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
  const token = lootToken();
  integration.prepareObjectTokenHud({ object: token }, root);
  assert.equal(classes.has("km-map-object-hud"), true);
  integration.prepareObjectTokenHud({ object: buyerToken }, [root]);
  assert.equal(classes.has("km-map-object-hud"), false);
  class Target { constructor(document) { this.document = document; } setTarget(value) { this.targeted = value; } }
  integration.patchObjectTokenPlaceable(Target);
  const object = new Target(token); object.setTarget(true); assert.equal(object.targeted, undefined);
  object.setTarget(false); assert.equal(object.targeted, false);
  const character = new Target(buyerToken); character.setTarget(true); assert.equal(character.targeted, true);
});

function sourceBag() {
  const outer = item(sourceActor, 1, "container"); outer.name = "Outer";
  const bag = item(sourceActor, 1, "container"); bag.name = "Bag"; bag.system.container = outer.id;
  const pouch = item(sourceActor, 1, "container"); pouch.name = "Pouch"; pouch.system.container = bag.id;
  const gem = item(sourceActor, 2, "loot"); gem.name = "Gem"; gem.system.container = pouch.id;
  return { outer, bag, pouch, gem };
}

test("a nested bag completes inventory-to-ground-to-inventory with its full contents", async () => {
  const { outer, bag } = sourceBag();
  const result = await socket.requestDropItem({ item: bag, scene, x: 100, y: 0 });
  assert.equal(result.ok, true); assert.deepEqual([...sourceActor.items].map(value => value.id), [outer.id]);
  const groundToken = scene.tokens.get(result.lootId);
  assert.equal(groundData.getGroundLoot(groundToken).itemBundle.length, 3);
  assert.equal((await pickup(groundToken)).ok, true);
  const [receivedBag, pouch, gem] = [...buyer.items];
  assert.equal(receivedBag.system.container, null);
  assert.equal(pouch.system.container, receivedBag.id); assert.equal(gem.system.container, pouch.id);
  assert.equal(gem.system.quantity, 2);
});

test("partial nested source deletion restores the original IDs and external parent", async () => {
  const { outer, bag, pouch, gem } = sourceBag();
  sourceActor.partialDeletion = true;
  assert.equal((await socket.requestTransferItem({ item: bag, targetToken: buyerToken })).ok, false);
  assert.equal(buyer.items.size, 0); assert.equal(sourceActor.items.size, 4);
  assert.equal(sourceActor.items.get(bag.id).system.container, outer.id);
  assert.equal(sourceActor.items.get(pouch.id).system.container, bag.id);
  assert.equal(sourceActor.items.get(gem.id).system.container, pouch.id);
});

test("source quantity and deletion errors restore both inventories even after the write happened", async () => {
  const sourceItem = item(); sourceItem.throwAfterUpdate = true;
  assert.equal((await socket.requestTransferItem({ item: sourceItem, targetToken: buyerToken })).ok, false);
  assert.equal(sourceItem.system.quantity, 3); assert.equal(buyer.items.size, 0);
  sourceItem.throwAfterUpdate = false; sourceActor.throwAfterDeletion = true;
  assert.equal((await socket.requestTransferItem({ item: sourceItem, targetToken: buyerToken, quantity: 3 })).ok, false);
  assert.equal(sourceActor.items.get(sourceItem.id).system.quantity, 3); assert.equal(buyer.items.size, 0);
});

test("ground quantity and deletion errors restore the loot even after the write happened", async () => {
  const token = lootToken(); token.throwAfterUpdate = true;
  assert.equal((await pickup(token)).ok, false);
  assert.equal(groundData.getGroundLoot(token).quantity, 3); assert.equal(buyer.items.size, 0);
  token.throwAfterUpdate = false; scene.throwAfterDeletion = true;
  assert.equal((await pickup(token, 3)).ok, false);
  assert.equal(groundData.getGroundLoot(scene.tokens.get(token.id)).quantity, 3); assert.equal(buyer.items.size, 0);
});

test("vetoed and partially completed ground creation leave the source inventory untouched", async () => {
  const sourceItem = item(); const count = scene.tokens.size;
  scene.preventCreation = true;
  assert.equal((await socket.requestDropItem({ item: sourceItem, scene, x: 100, y: 0 })).ok, false);
  scene.preventCreation = false; scene.throwAfterCreation = true;
  assert.equal((await socket.requestDropItem({ item: sourceItem, scene, x: 100, y: 0 })).ok, false);
  assert.equal(sourceItem.system.quantity, 3); assert.equal(scene.tokens.size, count);
});

test("currency drops preserve total funds and roll back if the wallet write is vetoed", async () => {
  const count = scene.tokens.size; sourceActor.skipWallet = true;
  assert.equal((await socket.requestDropCurrency({ sourceActor, scene, x: 100, y: 0, currencyId: "gp", amount: 2 })).ok, false);
  assert.equal(scene.tokens.size, count); assert.equal(sourceActor.system.currency.gp, 10);
  sourceActor.skipWallet = false;
  const result = await socket.requestDropCurrency({ sourceActor, scene, x: 100, y: 0, currencyId: "gp", amount: 2 });
  assert.equal(result.ok, true); assert.equal(sourceActor.system.currency.gp, 8);
  assert.equal((await pickup(scene.tokens.get(result.lootId), 2)).ok, true);
  assert.equal(buyer.system.currency.gp, 12); assert.equal(scene.tokens.size, count);
});

test("player pickups reject hidden, distant and unowned recipients without consuming loot", async () => {
  const token = lootToken(); const data = { sceneId: scene.id, lootId: token.id, buyerTokenId: buyerToken.id, quantity: 1 };
  token.hidden = true; assert.equal((await remote("pickup", data)).ok, false); token.hidden = false;
  buyerToken.x = 2000; assert.equal((await remote("pickup", data)).ok, false); buyerToken.x = 100;
  buyer.owner = false; assert.equal((await remote("pickup", data)).ok, false);
  assert.equal(groundData.getGroundLoot(token).quantity, 3); assert.equal(buyer.items.size, 0);
});

test("synthetic Actor identity cannot be replaced by another token of its base Actor", () => {
  const sibling = new Token(scene, sourceActor); scene.tokens.set(sibling.id, sibling);
  sourceActor.token = sourceToken; sourceActor.uuid = `${sourceToken.uuid}.Actor.${sourceActor.id}`;
  const otherActor = new Actor("Sibling"); otherActor.id = sourceActor.id;
  otherActor.token = sibling; otherActor.uuid = `${sibling.uuid}.Actor.${otherActor.id}`; sibling.actor = otherActor;
  assert.equal(map.resolveActorToken(sourceActor, scene), sourceToken);
  assert.equal(map.resolveActorToken(sourceActor, scene, { tokenId: sibling.id }), null);
});

test("missing bundle parents and incomplete system snapshots abort before consuming source items", async () => {
  const invalid = nestedLoot(); invalid.flags[MODULE].groundLoot.itemBundle[1].system.container = "missing";
  assert.equal((await pickup(invalid)).ok, false); assert.equal(buyer.items.size, 0);
  const { bag } = sourceBag(); const count = scene.tokens.size;
  CONFIG.Item.documentClass.createWithContents = async () => [bag.toObject()];
  assert.equal((await socket.requestDropItem({ item: bag, scene, x: 100, y: 0 })).ok, false);
  assert.equal(sourceActor.items.size, 4); assert.equal(scene.tokens.size, count);
});

test("movement rejects non-finite coordinates and unknown levels, stripping non-positional fields", async () => {
  const token = lootToken(); const data = { sceneId: scene.id, lootId: token.id };
  for (const point of [{ x: NaN, y: 100 }, { x: 100, y: Infinity }, { x: 100, y: 100, level: "missing" }]) {
    assert.equal((await remote("move", { ...data, waypoints: [point] })).ok, false);
  }
  assert.equal(token.x, 100);
  assert.equal((await remote("move", { ...data, waypoints: [{ x: 180, y: 100, actorId: buyer.id, hidden: true }] })).ok, true);
  assert.deepEqual(token.lastMove.points, [{ x: 180, y: 100 }]);
  assert.equal(token.actorId, proxy.id); assert.equal(token.hidden, false);
});

test("a native v14 deferred drop keeps the preview until movement is confirmed", async () => {
  const token = lootToken(); const placeable = new Placeable(token); let prevented = false;
  placeable._shouldPreventDragLeftDrop = () => true;
  const event = { interactionData: {}, preventDefault: () => { prevented = true; } };
  await placeable._onDragLeftDrop(event);
  assert.equal(prevented, true); assert.equal(placeable.cleared, undefined); assert.equal(token.x, 100);
  event.interactionData.dropped = true; await placeable._onDragLeftDrop(event);
  assert.equal(token.x, 220); assert.equal(placeable.cleared, true);
});
