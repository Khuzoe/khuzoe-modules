import test from "node:test";
import assert from "node:assert/strict";
import { getActorCardUrl } from "../scripts/services/actor-card.js";
import { DISCORD_WORKER_URL, SETTINGS } from "../scripts/constants.js";

const worldId = "test-world";
const form = { id: "FormId", type: "npc" };
const formPath = "/api/managed-actors/test-world/formid";
const ownerPath = "/api/managed-actors/test-world/baseid";
const card = { path: "media/test/card.webp", revision: 2 };
const expected = DISCORD_WORKER_URL + "/media/test/card.webp?rev=2";
const empty = { data: { media: {} } };

function group(ownerCard, canReadStats = true) {
    return { group: { owner: { worldId, actorId: "baseid" }, forms: [
        { worldId, actorId: "formid", canReadStats: true, current: true, media: {} },
        { worldId, actorId: "baseid", canReadStats, media: { card: ownerCard } }
    ] } };
}

function setup(t, routes) {
    const settings = { [SETTINGS.DISCORD_TOKEN]: "fixture", [SETTINGS.CAMPAIGN_ID]: "test-campaign" };
    globalThis.game = { world: { id: worldId }, settings: { get: (_, key) => settings[key] } };
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url.origin, DISCORD_WORKER_URL);
        assert.equal(url.searchParams.get("campaign"), "test-campaign");
        assert.equal(options.headers.Authorization, "Bearer fixture");
        calls.push(url.pathname);
        assert.ok(Object.hasOwn(routes, url.pathname), "Unexpected request: " + url.pathname);
        const reply = routes[url.pathname];
        return typeof reply === "number" ? new Response(null, { status: reply }) : Response.json(reply);
    });
    return { calls, settings };
}

test("a synthetic token uses its placed form's own card first", async t => {
    const { calls } = setup(t, { [formPath]: { data: { media: { card } } } });
    assert.equal(await getActorCardUrl({ ...form, id: "Synthetic", token: { actorId: form.id } }), expected);
    assert.deepEqual(calls, [formPath]);
});

test("a linked form can use the dossier owner's card", async t => {
    setup(t, { [formPath]: empty, [formPath + "/forms"]: group(card) });
    assert.equal(await getActorCardUrl(form), expected);
});

test("an older forms index can omit the card already saved in the owner's dossier", async t => {
    setup(t, { [formPath]: empty, [formPath + "/forms"]: group(null), [ownerPath]: { data: { media: { card } } } });
    assert.equal(await getActorCardUrl(form), expected);
});

test("a dossier without its own card can show its wiki-selected current form", async t => {
    const list = group(null);
    list.group.forms[0].media.card = card;
    setup(t, { [ownerPath]: empty, [ownerPath + "/forms"]: list });
    assert.equal(await getActorCardUrl({ type: "npc", id: "BaseId" }), expected);
});

test("a portrait-only link grants no access to the owner's card", async t => {
    const { calls } = setup(t, { [formPath]: 403, [formPath + "/profile"]: empty, [formPath + "/forms"]: group(card, false) });
    assert.equal(await getActorCardUrl(form), null);
    assert.equal(calls.length, 3);
});

test("missing, unrelated and logged-out actors keep their existing artwork", async t => {
    const { calls, settings } = setup(t, { [formPath]: empty, [formPath + "/forms"]: { group: null } });
    assert.equal(await getActorCardUrl(form), null);
    settings[SETTINGS.DISCORD_TOKEN] = "";
    assert.equal(await getActorCardUrl(form), null);
    assert.equal(calls.length, 2);
});
