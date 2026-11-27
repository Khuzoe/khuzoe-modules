import assert from "node:assert/strict";
import test from "node:test";

test("players read wiki banners and only the GM provisions missing persistent storage", async () => {
  const actor = { id: "A", type: "npc" }, gm = { id: "gm", isGM: true };
  const player = { id: "pc", isGM: false, can: () => true }; // Even with FILES_UPLOAD.
  const directory = "modules/khuzoe-hud/storage";
  const wikiImage = "https://wiki.test/banner.webp";
  const files = new Set(), ready = [], requests = [], operations = [];
  let receive, hasFolder = false, allowCreate = true, revision = 1;
  const remote = () => `${wikiImage}?rev=${revision}`;
  globalThis.Hooks = { on() {}, once(event, fn) { if (event === "ready") ready.push(fn); } };
  globalThis.HTMLElement = class {};
  globalThis.IntersectionObserver = class {};
  globalThis.customElements = { define() {} };
  globalThis.foundry = { utils: { getRoute: path => "/" + path } };
  globalThis.Image = class {
    async decode() { if (this.src !== remote() && !files.has(this.src)) throw Error("missing image"); }
  };
  globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob() });
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.document = { querySelectorAll: () => [], createElement: () => ({
    getContext: () => ({ drawImage() {} }), toBlob: done => done(new Blob())
  }) };
  const api = { calendar: { getContext: () => ({ authenticated: true, identityVersion: revision }) },
    wikiDataService: { getCampaignId: () => "campaign" }, getActorCardUrl: async () => remote() };
  globalThis.game = { user: player, users: { activeGM: gm }, world: { id: "world" },
    modules: new Map([["cripta-wiki-sync", { active: true, api }]]), actors: new Map([[actor.id, actor]]),
    socket: { on: (_channel, handler) => { receive = handler; }, emit: (_channel, packet) => requests.push(packet) } };
  globalThis.CONFIG = { ux: { FilePicker: {
    async browse(source, parent) {
      assert.deepEqual([source, parent], ["data", "modules/khuzoe-hud"]);
      operations.push("browse");
      return { dirs: hasFolder ? [directory] : [] };
    },
    async createDirectory(source, path) {
      assert.deepEqual([source, path], ["data", directory]);
      operations.push("mkdir");
      if (!allowCreate) throw Error("cannot create");
      hasFolder = true;
    },
    async uploadPersistent(_id, _path, file) {
      operations.push("upload");
      assert.ok(hasFolder);
      const path = `/${directory}/${file.name}`;
      files.add(path);
      return { path };
    }
  } } };
  const { wikiBanner } = await import("../scripts/wiki-banner.mjs");
  for (const fn of ready) fn();
  assert.equal(await wikiBanner(actor), remote());
  assert.deepEqual(operations, []);
  assert.equal(requests.length, 1);

  game.user = gm;
  await receive(requests[0]);
  assert.deepEqual(operations, ["browse", "mkdir", "upload"]);
  game.user = player;
  revision++; // New wiki session and image revision, with the GM offline.
  game.users.activeGM = null;
  const previous = operations.length;
  assert.equal(await wikiBanner(actor), remote());
  assert.equal(operations.length, previous);
  assert.equal(requests.length, 1);

  game.user = gm;
  assert.ok(files.has(await wikiBanner(actor)));
  assert.deepEqual(operations.slice(previous), ["browse", "upload"]);
  hasFolder = false;
  allowCreate = false;
  revision++;
  assert.equal(await wikiBanner(actor), remote());
  assert.deepEqual(operations.slice(-3), ["browse", "mkdir", "browse"]);
});
