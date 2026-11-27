import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { policyFetch } from "./worker-gateway.js";
import { getCalendarContext } from "./calendar-client.js";
import { wikiDataService } from "./wiki-data-service.js";

function mediaUrl(card) {
    if (typeof card?.path !== "string" || !card.path.trim()) return null;
    const url = URL.parse(card.path, DISCORD_WORKER_URL);
    if (!url || url.origin !== new URL(DISCORD_WORKER_URL).origin || !url.pathname.startsWith("/media/") || url.username || url.password) return null;
    const revision = card.updatedAt || card.revision;
    if (revision) url.searchParams.set("rev", String(revision));
    return url.href;
}

export async function getActorCardUrl(actor) {
    const actorId = actor?.token?.actorId || actor?.id;
    if (!actorId || actor.pack || !["npc", "character"].includes(actor.type)) return null;
    const context = getCalendarContext();
    if (!context.authenticated) return null;
    const campaign = wikiDataService.getCampaignId();
    const world = game.world.id.toLowerCase();
    const id = actorId.toLowerCase();
    const actorPath = `/api/managed-actors/${encodeURIComponent(world)}/${encodeURIComponent(id)}`;
    const token = game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN);
    const current = () => context.identityVersion === getCalendarContext().identityVersion && campaign === wikiDataService.getCampaignId();
    async function read(path) {
        if (!current()) return null;
        const route = new URL(path, DISCORD_WORKER_URL);
        route.searchParams.set("campaign", campaign);
        const response = await policyFetch(route, {
            headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
            cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000)
        });
        if (response.status === 403) return { forbidden: true };
        if ([401, 404].includes(response.status)) return null;
        if (!response.ok) throw new Error(`Wiki actor card HTTP ${response.status}`);
        const payload = await response.json();
        if (!current() || !payload || payload.ok === false || (payload.campaignId && payload.campaignId !== campaign)
            || (payload.data?.campaignId && payload.data.campaignId !== campaign)) return null;
        return payload;
    }

    let dossier = await read(actorPath);
    if (dossier?.forbidden) dossier = await read(actorPath + "/profile");
    if (!dossier?.data || !current()) return null;
    const own = mediaUrl(dossier.data.media?.card);
    if (own || actor.type !== "npc") return own;

    // A placed form is a separate Foundry Actor. The wiki owns the association
    // and filters both the list of forms and their media for the current reader.
    const { group } = await read(actorPath + "/forms") ?? {};
    if (!current() || group?.owner?.worldId !== world || !Array.isArray(group.forms)) return null;
    const member = group.forms.find(form => form.worldId === world && form.actorId === id);
    if (!member) return null;
    const permittedCard = form => form?.canReadStats === true ? mediaUrl(form.media?.card) : null;
    const owner = group.forms.find(form => form.worldId === world && form.actorId === group.owner.actorId);
    const fallback = member === owner ? group.forms.find(form => form.current && form.worldId === world) : owner;
    const listed = permittedCard(member) || permittedCard(fallback);
    if (listed || fallback?.canReadStats !== true || fallback.actorId === id) return listed;

    // Older directory entries can omit media that already exists on the dossier.
    const related = await read(`/api/managed-actors/${encodeURIComponent(world)}/${encodeURIComponent(fallback.actorId)}`);
    return current() ? mediaUrl(related?.data?.media?.card) : null;
}
