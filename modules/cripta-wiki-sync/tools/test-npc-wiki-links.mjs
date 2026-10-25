import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { wikiDataService } from "../scripts/services/wiki-data-service.js";
import { getNpcActor } from "../scripts/services/wiki-npc-links.js";
import { renderEntityShell, renderEmbeddedEntityShell } from "../scripts/renderers.js";
import { MODULE_ID, SETTINGS, SECTIONS } from "../scripts/constants.js";

const forbidWrite = () => { throw new Error("Navigation must not write documents, settings or remote data"); };
function actor(options = {}) {
    const result = { id: "ActorABC", uuid: "Actor.ActorABC", documentName: "Actor", type: "npc", name: "NPC rinominato",
        flags: {}, update: forbidWrite, setFlag: forbidWrite, ...options };
    result.getFlag = (module, key) => result.flags[module]?.[key];
    return result;
}
function entry(options = {}) {
    return { actorId: "actorabc", foundryActorId: "ActorABC", worldId: "test-world", actorType: "npc", name: "Vecchio nome", ...options };
}
function harness(options = {}) {
    const requests = [];
    const state = { directory: [], legacy: [], staticLegacy: [], players: [], items: [], failures: [], ...options };
    const service = new wikiDataService.constructor();
    const settings = {
        [SETTINGS.SITE_BASE_URL]: "https://wiki.example/campaign-site",
        [SETTINGS.CAMPAIGN_ID]: "test-campaign",
        [SETTINGS.DISCORD_TOKEN]: "test-token",
        [SETTINGS.INVENTORY_SYNC_SECRET]: "test-secret",
        [SETTINGS.DRAFTS]: { entries: state.drafts || {} }
    };
    globalThis.game = {
        world: { id: "test-world" }, user: { id: "test-user", isGM: state.isGM !== false },
        actors: new Map(), settings: { get: (_module, key) => settings[key], set: forbidWrite },
        release: { generation: 14 }
    };
    globalThis.foundry = { utils: { deepClone: structuredClone } };
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(init.method || "GET", "GET", "Only read requests are allowed");
        requests.push({ url, headers: new Headers(init.headers), method: init.method || "GET" });
        if (state.failures.some(path => url.pathname.endsWith(path))) return new Response("Unavailable", { status: 503 });
        let data;
        if (url.pathname === "/api/managed-actors") {
            assert.equal(url.searchParams.get("view"), "directory");
            assert.equal(url.searchParams.get("campaign"), settings[SETTINGS.CAMPAIGN_ID]);
            data = state.malformedDirectory ? {} : { data: state.directory };
        } else if (url.pathname === "/api/data/characters") {
            assert.equal(url.searchParams.get("campaign"), settings[SETTINGS.CAMPAIGN_ID]);
            data = { data: state.legacy };
        } else if (url.pathname.endsWith("foundry.json")) {
            data = { characters: state.staticLegacy, players: state.players };
        } else if (url.pathname.endsWith("items.json")) data = state.items;
        else if (url.pathname === "/api/data/items") data = { data: state.items };
        else throw new Error(`Unexpected request ${url.pathname}`);
        return Response.json(data);
    };
    return { state, service, requests, settings, run: doc => service.matchDocument(doc) };
}

test("renamed managed NPC opens the published managed route with one read and no legacy lookup", async () => {
    const h = harness({ directory: [entry()], failures: ["foundry.json"] });
    const doc = actor();
    const before = JSON.stringify(doc);
    const match = await h.run(doc);
    const url = new URL(h.service.getEntityUrl(match));
    assert.equal(url.pathname, "/campaign-site/pages/characters/managed-actor.html");
    assert.deepEqual(Object.fromEntries(url.searchParams), { world: "test-world", actor: "actorabc", campaign: "test-campaign", embed: "1" });
    assert.equal(h.requests.length, 1);
    assert.equal(JSON.stringify(doc), before);
});

test("token name is irrelevant to its Actor identity", async () => {
    const h = harness({ directory: [entry()] });
    const doc = { documentName: "Token", id: "TokenXYZ", uuid: "Scene.s.Token.TokenXYZ", actor: actor(), actorId: "ActorABC", name: "Guardia 7" };
    assert.equal((await h.run(doc)).managedActor.actorId, "actorabc");
});

test("synthetic Actor sheet uses the token base Actor identity", async () => {
    const h = harness({ directory: [entry()] });
    const doc = actor({ id: "SyntheticID", uuid: "Scene.s.Token.t.Actor.SyntheticID", isToken: true, token: { actorId: "ActorABC" } });
    assert.equal((await h.run(doc)).managedActor.actorId, "actorabc");
});

test("manual link inherited from the base Actor takes precedence over automatic identity", async () => {
    const h = harness({ directory: [entry()], legacy: [{ id: "manual-page", name: "Pagina scelta" }] });
    const base = actor({ flags: { [MODULE_ID]: { wikiLink: { source: "wiki", section: "characters", id: "manual-page" } } } });
    const doc = actor({ token: { actorId: "ActorABC", baseActor: base } });
    const match = await h.run(doc);
    assert.equal(match.id, "manual-page");
    assert.ok(!match.managedActor);
});

test("a manual token link overrides the Actor's manual link", async () => {
    const h = harness({ legacy: [{ id: "token-page", name: "Token" }, { id: "actor-page", name: "Actor" }] });
    const doc = { documentName: "Token", name: "Token", actor: actor({ flags: { [MODULE_ID]: { wikiLink: { source: "wiki", section: "characters", id: "actor-page" } } } }),
        getFlag: (_module, key) => key === "wikiLink" ? { source: "wiki", section: "characters", id: "token-page" } : undefined };
    assert.equal((await h.run(doc)).id, "token-page");
});

test("legacy wikiNpcId recognizes a renamed NPC from the current remote collection", async () => {
    const h = harness({ legacy: [{ id: "old-npc", name: "Nome sul sito" }] });
    const match = await h.run(actor({ flags: { [MODULE_ID]: { wikiNpcId: "old-npc" } } }));
    assert.equal(match.id, "old-npc");
    assert.equal(new URL(h.service.getEntityUrl(match)).searchParams.get("id"), "old-npc");
});

test("legacy saved ID follows a managed profile migration in this world", async () => {
    const h = harness({ directory: [entry({ actorId: "newid", foundryActorId: "NewID", profile: { legacyCharacterId: "old-npc" } })] });
    const match = await h.run(actor({ flags: { [MODULE_ID]: { wikiNpcId: "old-npc" } } }));
    assert.equal(match.managedActor.actorId, "newid");
    assert.equal(h.requests.length, 1);
});

for (const field of ["actorId", "actorUuid"]) test(`legacy ${field} recognizes an NPC after a rename`, async () => {
    const h = harness({ legacy: [{ id: "legacy", name: "Nome antico", foundry: { [field]: field === "actorId" ? "ActorABC" : "Actor.ActorABC" } }] });
    assert.equal((await h.run(actor())).id, "legacy");
});

test("an Actor ID from another world or campaign cannot select a managed NPC", async () => {
    const h = harness({ directory: [entry({ worldId: "another-world" }), entry({ campaignId: "another-campaign" })] });
    assert.equal((await h.run(actor())).npcLinkReason, "not-found");
});

test("legacy Foundry identity and name fallback also respect recorded world and campaign", async () => {
    const h = harness({ legacy: [
        { id: "other-world", name: "NPC rinominato", foundry: { actorId: "ActorABC", worldId: "another-world" } },
        { id: "other-campaign", name: "NPC rinominato", foundry: { actorId: "ActorABC", campaignId: "another-campaign" } }
    ] });
    assert.equal((await h.run(actor())).npcLinkReason, "not-found");
});

test("a compendium Actor cannot reuse an unrelated world Actor ID", async () => {
    const h = harness({ directory: [entry()] });
    assert.equal((await h.run(actor({ pack: "module.pack" }))).npcLinkReason, "not-found");
    assert.ok(h.requests.every(request => request.url.pathname !== "/api/managed-actors"));
});

test("an unsaved Actor without an ID cannot match an incomplete directory identity", async () => {
    const h = harness({ directory: [entry({ foundryActorId: undefined })] });
    assert.equal((await h.run(actor({ id: undefined, uuid: undefined }))).npcLinkReason, "not-found");
    assert.ok(h.requests.every(request => request.url.pathname !== "/api/managed-actors"));
});

test("managed identity normalization preserves underscores and the route uses server IDs", async () => {
    const h = harness({ directory: [entry({ actorId: "npc_ab-c", foundryActorId: "NPC_AB-C" })] });
    assert.equal((await h.run(actor({ id: "NPC_AB-C" }))).managedActor.actorId, "npc_ab-c");
});

test("missing saved link never falls back to a different NPC with the same name", async () => {
    const h = harness({ legacy: [{ id: "wrong", name: "NPC rinominato" }] });
    assert.equal((await h.run(actor({ flags: { [MODULE_ID]: { wikiNpcId: "missing" } } }))).npcLinkReason, "missing-link");
});

test("an unambiguous legacy alias remains a valid fallback", async () => {
    const h = harness({ legacy: [{ id: "alias", name: "Nome vecchio", foundryNames: ["NPC rinominato"] }] });
    assert.equal((await h.run(actor())).id, "alias");
});

test("identical names cannot pick an arbitrary NPC", async () => {
    const h = harness({ legacy: [{ id: "one", name: "NPC rinominato" }, { id: "two", name: "NPC rinominato" }] });
    assert.equal((await h.run(actor())).npcLinkReason, "ambiguous");
});

test("conflicting managed identities are reported instead of selecting the first", async () => {
    const h = harness({ directory: [entry(), entry({ actorId: "different" })] });
    assert.equal((await h.run(actor())).npcLinkReason, "ambiguous");
});

test("Player profile-only access uses the same profile URL parameter as the site", async () => {
    const h = harness({ isGM: false, directory: [entry({ permissions: { canReadStats: false, canReadProfile: true } })] });
    const url = new URL(h.service.getEntityUrl(await h.run(actor())));
    assert.equal(url.searchParams.get("profile"), "1");
    assert.ok(h.requests.every(request => !request.headers.has("X-Cripta-Inventory-Secret")));
    assert.ok(!url.href.includes("test-token") && !url.href.includes("test-secret"));
});

test("a directory entry without either read permission is not opened", async () => {
    const h = harness({ isGM: false, directory: [entry({ permissions: { canReadStats: false, canReadProfile: false } })] });
    assert.equal((await h.run(actor())).npcLinkReason, "not-found");
});

test("server failure is distinguished from NPC absence", async () => {
    const h = harness({ failures: ["/api/managed-actors"] });
    assert.equal((await h.run(actor())).npcLinkReason, "unavailable");
});

test("malformed directory response is not interpreted as an empty directory", async () => {
    const h = harness({ malformedDirectory: true });
    assert.equal((await h.run(actor())).npcLinkReason, "unavailable");
});

test("legacy links still work when the managed directory is unavailable", async () => {
    const h = harness({ failures: ["/api/managed-actors"], legacy: [{ id: "legacy", name: "NPC rinominato" }] });
    assert.equal((await h.run(actor())).id, "legacy");
});

test("static legacy fallback works when the remote collection is unavailable", async () => {
    const h = harness({ failures: ["/api/data/characters"], staticLegacy: [{ id: "static", name: "NPC rinominato" }] });
    assert.equal((await h.run(actor())).id, "static");
});

test("both legacy sources failing does not claim the NPC is absent", async () => {
    const h = harness({ failures: ["foundry.json", "/api/data/characters"] });
    assert.equal((await h.run(actor())).npcLinkReason, "unavailable");
});

test("remote legacy collection overrides stale static entries", async () => {
    const h = harness({ staticLegacy: [{ id: "same", name: "Vecchio" }], legacy: [{ id: "same", name: "NPC rinominato" }] });
    assert.equal((await h.run(actor())).entity.name, "NPC rinominato");
});

test("concurrent log and window lookups share reads, while reopening checks fresh data", async () => {
    const h = harness({ directory: [entry()] });
    const doc = actor();
    const [a, b] = await Promise.all([h.run(doc), h.run(doc)]);
    assert.equal(a, b);
    assert.equal(h.requests.length, 1);
    h.state.directory = [];
    assert.equal((await h.run(doc)).npcLinkReason, "not-found");
});

test("manual links to player pages are preserved", async () => {
    const h = harness({ players: [{ id: "player", name: "Giocatore" }] });
    const doc = actor({ flags: { [MODULE_ID]: { wikiLink: { source: "wiki", section: "players", id: "player" } } } });
    const match = await h.run(doc);
    assert.equal(new URL(h.service.getEntityUrl(match)).searchParams.get("type"), "player");
});

test("existing local drafts are preserved and never sent to a nonexistent site page", async () => {
    const h = harness({ drafts: { local: { id: "local", name: "Bozza", section: "characters" } } });
    const match = await h.run(actor({ flags: { [MODULE_ID]: { wikiLink: { source: "draft", id: "local" } } } }));
    assert.equal(match.source, "draft");
    assert.equal(h.service.getEntityUrl(match), null);
    assert.equal(h.requests.length, 0);
});

test("NPC items and normal player Actors keep the existing resolver", async () => {
    const h = harness({ players: [{ id: "hero", name: "Hero" }], items: [{ id: "sword", name: "Sword" }] });
    const item = actor({ documentName: "Item", type: "weapon", name: "Sword", actor: actor() });
    assert.equal(getNpcActor(item), null);
    assert.equal((await h.run(item)).section, SECTIONS.ITEMS);
    assert.equal((await h.run(actor({ type: "character", name: "Hero" }))).section, SECTIONS.PLAYERS);
    assert.ok(h.requests.every(request => request.url.pathname !== "/api/managed-actors"));
});

test("entity window opens the managed URL without loading unrelated legacy indexes", async () => {
    const h = harness({ directory: [entry()] });
    const source = fs.readFileSync(new URL("../scripts/apps/wiki-entity-app.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "").replace("export class CriptaWikiEntityApp", "globalThis.EntityApp = class CriptaWikiEntityApp");
    const ctx = vm.createContext({ MODULE_ID, SETTINGS, game, URL, wikiDataService: h.service,
        BaseShadowApp: class { withAuthToken(url) { return url; } }, renderEntityShell, renderEmbeddedEntityShell });
    vm.runInContext(source, ctx);
    const app = new ctx.EntityApp({ document: actor() });
    const html = await app.buildHtml();
    assert.match(html, /managed-actor\.html\?world=test-world&amp;actor=actorabc/);
    assert.equal(h.requests.length, 1);
    h.state.directory = [];
    const missing = await app.buildHtml();
    assert.match(missing, /Collegamento NPC non trovato/);
    assert.ok(!missing.includes("<iframe") && !missing.includes("data-create-draft"));
});

test("missing/ambiguous/unavailable messages remain distinct and escape NPC names", () => {
    const messages = ["not-found", "ambiguous", "unavailable", "missing-link"].map(reason => renderEntityShell({
        match: { unresolvedName: '<script>alert("x")</script>', npcLinkReason: reason }, canCreateDraft: false
    }));
    assert.equal(new Set(messages).size, 4);
    assert.ok(messages.every(html => !html.includes("<script>") && !html.includes("<iframe")));
});
