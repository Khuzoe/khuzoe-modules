import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/khuzoe-boss-bar.js", import.meta.url), "utf8");
const card = "https://sigillo-api.khuzoe.workers.dev/media/campaigns/test/card.webp?rev=2";
const gm = { id: "gm", isGM: true, active: true };
const player = { id: "player", isGM: false, active: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

function client(user, decode = async () => {}) {
  const settings = new Map(), hooks = {}, timers = new Map(), overlays = new Set();
  const state = { barState: { entries: [], updatedAt: 0 }, effectMode: "subtle" };
  let timerId = 0;
  const users = [gm, player];
  users.get = id => users.find(member => member.id === id);
  const context = vm.createContext({
    URL, console, queueMicrotask,
    CONFIG: { queries: {} },
    Hooks: { once: (key, fn) => { hooks[key] = fn; }, on: (key, fn) => { hooks[key] = fn; } },
    game: { user, users, scenes: new Map(), modules: new Map(), i18n: { localize: key => key },
      settings: {
        get: (_, key) => state[key],
        register: (_, key, config) => settings.set(key, config)
      } },
    canvas: { tokens: { controlled: [] } },
    window: {
      setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
      clearTimeout(id) { timers.delete(id); }
    },
    Image: class { naturalWidth = 800; naturalHeight = 1200; decode = decode; removeAttribute() {} },
    document: {
      body: { append: el => overlays.add(el) },
      createElement() {
        return { dataset: {}, style: { setProperty() {} }, setAttribute() {},
          append(...children) { this.children = children; }, remove() { overlays.delete(this); } };
      }
    }
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  // Exercise the actual settings and query callbacks, isolating the unrelated health-bar layout.
  run("renderBossBars = (s = getState()) => reconcileBossIntros(s, isStateDismissed(s))");
  hooks.init();
  function update(value, options) {
    state.barState = value;
    settings.get("barState").onChange(value, options, gm.id);
  }
  return { context, run, state, overlays, update,
    activate() {
      const controls = { tokens: { tools: {} } };
      hooks.getSceneControlButtons(controls);
      return controls.tokens.tools["khbb-show-selected"].onChange(null, true);
    },
    receive: (packet, user = gm) => context.CONFIG.queries["khuzoe-boss-bar.showBossCard"](packet, { user }),
    finish() { Array.from(timers.values()).find(timer => timer.delay === 4600).fn(); }
  };
}

const entry = (id, name = id) => ({ id, actorId: id, name, pct: 1, minions: [] });
const activation = (ids, updatedAt = 1) => [
  { entries: ids.map(id => entry(id)), updatedAt }, { khbbIntroIds: ids }
];
const packet = (id, activation = 1, url = card) => ({ id, activation, url });

test("the heart shows a selected NPC on both screens and replays only on explicit activation", async () => {
  const host = client(gm), viewer = client(player);
  const docs = ["dragon", "pc", "minion"].map(id => ({ id, parent: { id: "scene" },
    actor: { id, name: id, type: id === "pc" ? "character" : "npc", system: { attributes: { hp: { value: 8, max: 10 } } } } }));
  host.context.game.scenes.set("scene", { tokens: new Map(docs.map(doc => [doc.id, doc])) });
  host.context.canvas.tokens.controlled = docs.slice(0, 2).map(document => ({ document }));
  const lookups = [], queries = [];
  let resolveCard;
  host.context.game.modules.set("cripta-wiki-sync", { active: true, api: {
    getActorCardUrl(actor) { lookups.push(actor); return new Promise(resolve => { resolveCard = resolve; }); }
  } });
  host.context.game.users[1] = { ...player, query: async (_name, data) => {
    queries.push(data);
    await viewer.receive(data);
  } };
  host.context.game.settings.set = async (_, key, value, options) => {
    host.update(value, options);
    viewer.update(value, options);
  };
  await host.activate();
  assert.equal(viewer.state.barState.entries.length, 2);
  assert.deepEqual(lookups, [docs[0].actor]);
  assert.equal(viewer.overlays.size, 0);
  host.context.canvas.tokens.controlled = [{ document: docs[2] }];
  await host.run("addSelectedMinions('scene.dragon')");
  resolveCard(card);
  await tick();
  assert.equal(lookups.length, 1);
  assert.equal(queries.length, 1);
  assert.equal(viewer.overlays.size, 1);
  assert.equal(host.overlays.size, 1);
  assert.equal([...host.overlays][0].children[2].textContent, "dragon");
  assert.equal([...viewer.overlays][0].children[2].textContent, "dragon");
  assert.equal(JSON.stringify(viewer.state.barState).includes(card), false);
  viewer.update(viewer.state.barState); // HP/theme refresh or client repaint.
  viewer.finish();
  viewer.run("renderBossBars()");
  assert.equal(viewer.overlays.size, 0);
  host.context.canvas.tokens.controlled = [{ document: docs[0] }];
  await host.activate();
  resolveCard(card);
  await tick();
  assert.equal(lookups.length, 2);
  assert.equal(queries.length, 2);
  assert.equal(host.overlays.size, 1);
  assert.equal(viewer.overlays.size, 1);
  assert.equal(host.state.barState.entries.length, 2);
});

test("a solo GM sees the whole intro locally without a network query", async () => {
  const host = client(gm);
  host.context.game.users.pop();
  const doc = { id: "lich", parent: { id: "crypt" }, actor: {
    id: "lich", type: "npc", name: "Lich", system: { attributes: { hp: { value: 20, max: 20 } } }
  } };
  host.context.game.scenes.set("crypt", { tokens: new Map([["lich", doc]]) });
  host.context.game.modules.set("cripta-wiki-sync", { active: true, api: { getActorCardUrl: async () => card } });
  host.context.game.settings.set = async (_, key, value, options) => host.update(value, options);
  host.context.canvas.tokens.controlled = [{ document: doc }];
  await host.activate();
  await tick();
  assert.equal([...host.overlays][0]?.children[2].textContent, "Lich");
  host.finish();
  assert.equal(host.overlays.size, 0);
});

test("the GM can turn effects off while the lookup is pending and still share the card", async () => {
  const host = client(gm), viewer = client(player);
  let resolveCard;
  const boss = { ...entry("one"), sceneId: "scene", tokenId: "one" };
  const state = { entries: [boss], updatedAt: 1 };
  host.context.game.scenes.set("scene", { tokens: new Map([["one", { actor: { type: "npc" } }]]) });
  host.context.game.modules.set("cripta-wiki-sync", { active: true, api: {
    getActorCardUrl: () => new Promise(resolve => { resolveCard = resolve; })
  } });
  host.context.game.users[1] = { ...player, query: (_name, data) => viewer.receive(data) };
  host.update(state, { khbbIntroIds: ["one"] });
  viewer.update(state, { khbbIntroIds: ["one"] });
  host.state.effectMode = "off";
  host.run("renderBossBars()");
  resolveCard(card);
  await tick();
  assert.equal(host.overlays.size, 0);
  assert.equal(host.run("bossIntros.size"), 0);
  assert.equal(viewer.overlays.size, 1);
});

test("only current GM-issued reveals play, one at a time, including in reduced motion", async () => {
  const c = client(player);
  c.context.canvas.photosensitiveMode = true;
  c.update(...activation(["one", "two"]));
  await c.receive(packet("one"), player);
  await c.receive(packet("one", 0));
  await c.receive(packet("one", 1, card + "&token=private"));
  assert.equal(c.overlays.size, 0);
  await c.receive(packet("one"));
  await c.receive(packet("one"));
  await c.receive(packet("two"));
  assert.equal(c.overlays.size, 1);
  const first = [...c.overlays][0];
  assert.equal(first.dataset.motion, "off");
  assert.equal(first.children[2].textContent, "one");
  c.finish();
  await tick();
  assert.equal([...c.overlays][0].children[2].textContent, "two");
  c.state.dismissedState = { updatedAt: 1 };
  c.run("renderBossBars()");
  assert.equal(c.overlays.size, 0);
  c.state.effectMode = "off";
  c.update(...activation(["three"], 2));
  await c.receive(packet("three", 2));
  assert.equal(c.overlays.size, 0);
});

test("a late decode or old query cannot present a removed and re-added boss", async () => {
  let resume;
  const c = client(player, () => new Promise(resolve => { resume = resolve; }));
  c.update(...activation(["one"]));
  const old = c.receive(packet("one"));
  c.update({ entries: [], updatedAt: 2 });
  c.update(...activation(["one"], 3));
  resume();
  await old;
  await c.receive(packet("one"));
  assert.equal(c.overlays.size, 0);
  const fresh = c.receive(packet("one", 3));
  resume();
  await fresh;
  assert.equal(c.overlays.size, 1);
  c.update({ entries: [], updatedAt: 4 });
  assert.equal(c.overlays.size, 0);
});

test("missing wiki access, missing images and a reconnect leave only the health bar", async () => {
  const c = client(player, () => Promise.reject(new Error("missing image")));
  c.update(activation(["one"])[0]);
  await c.receive(packet("one"));
  assert.equal(c.run("bossIntros.size"), 0);
  c.update(...activation(["one"]));
  await c.receive(packet("one"));
  assert.equal(c.run("bossIntros.size"), 0);
  assert.equal(c.overlays.size, 0);
  const host = client(gm);
  host.update(...activation(["one"]));
  assert.equal(host.run("bossIntros.size"), 0);
});
