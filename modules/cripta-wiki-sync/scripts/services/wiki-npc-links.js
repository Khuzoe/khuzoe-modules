import { DEFAULT_CAMPAIGN_ID, DISCORD_WORKER_URL, MODULE_ID, SECTIONS, SETTINGS } from "../constants.js";
import { normalizeSearch } from "./wiki-utils.js";
import { policyFetch } from "./worker-gateway.js";

// Match the identity format used by managed-actor-sync, without invoking a sync.
function managedId(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

export function getNpcActor(document) {
    const kind = String(document?.documentName || document?.constructor?.documentName || "").toLowerCase();
    if (kind === "item") return null;
    const actor = kind === "token" ? document.actor : document;
    return actor?.type === "npc" ? actor : null;
}

function npcDocuments(document, actor) {
    const token = actor?.token || (document !== actor ? document : null);
    const baseActor = token?.baseActor || (token?.actorId ? game.actors?.get(token.actorId) : null);
    return [...new Set([document, actor, baseActor].filter(Boolean))];
}

async function readJson(url, headers = {}) {
    const response = await policyFetch(url, { method: "GET", headers, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.ok === false) throw new Error("Indice NPC non disponibile.");
    return payload;
}

async function loadDirectory(campaignId) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors`);
    url.searchParams.set("campaign", campaignId);
    url.searchParams.set("view", "directory");
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = game.user?.isGM ? String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim() : "";
    const payload = await readJson(url.toString(), {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {})
    });
    if (!Array.isArray(payload?.data)) throw new Error("Indice NPC non valido.");
    return payload.data.filter(entry => entry?.actorType === "npc" && entry.worldId && entry.actorId
        && (!entry.campaignId || managedId(entry.campaignId) === managedId(campaignId))
        && !(entry.permissions?.canReadStats === false && entry.permissions?.canReadProfile === false));
}

async function loadLegacyEntries(service, campaignId) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/data/characters`);
    url.searchParams.set("campaign", campaignId);
    const results = await Promise.allSettled([
        readJson(service.getFoundryUrl()).then(data => {
            if (!Array.isArray(data?.characters)) throw new Error("Indice wiki non valido.");
            return data.characters;
        }),
        readJson(url.toString()).then(data => {
            if (!Array.isArray(data?.data)) throw new Error("Indice NPC precedente non valido.");
            return data.data;
        })
    ]);
    if (results.every(result => result.status === "rejected")) throw new Error("Indice wiki non disponibile.");
    const entries = new Map();
    for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const entry of result.value) {
            if (!entry?.id) continue;
            entries.set(String(entry.id), entry);
        }
    }
    return [...entries.values()];
}

export async function resolveNpcWikiMatch(document, service, store) {
    const actor = getNpcActor(document);
    const documents = npcDocuments(document, actor);
    const link = documents.map(doc => store.getDocumentLink(doc)).find(Boolean);
    const campaignId = service.getCampaignId() || DEFAULT_CAMPAIGN_ID;
    const worldId = managedId(game.world?.id);
    const actorId = managedId(actor?.token?.actorId || actor?.id);
    const isWorldActor = Boolean(worldId && actorId && !actor?.pack && !actor?.compendium);
    const wikiNpcId = documents.map(doc => doc.getFlag?.(MODULE_ID, "wikiNpcId")).find(Boolean);
    const unmatched = reason => ({
        source: "unmatched", section: null, id: null, entity: null, document,
        key: `doc:${document?.uuid || "unknown"}`, unresolvedName: actor?.name || document?.name || "NPC",
        npcLinkReason: reason
    });
    const legacyMatch = (entity, section = SECTIONS.CHARACTERS) => ({
        source: "wiki", section, id: String(entity.id), entity, document, key: `wiki:${section}:${entity.id}`
    });
    const managedMatch = entry => ({
        source: "wiki", section: SECTIONS.CHARACTERS, id: `managed:${entry.worldId}:${entry.actorId}`,
        entity: entry, document, key: `wiki:managed:${campaignId}:${entry.worldId}:${entry.actorId}`,
        managedActor: { worldId: entry.worldId, actorId: entry.actorId, campaignId, permissions: entry.permissions }
    });

    if (link?.source === "draft") {
        const draft = store.getDraftEntries()[link.id];
        return draft ? { source: "draft", section: draft.section || SECTIONS.CHARACTERS, id: draft.id,
            entity: draft, document, key: `draft:${draft.id}` } : unmatched("missing-link");
    }
    if (link?.source === "wiki" && link.section && link.section !== SECTIONS.CHARACTERS && link.id) {
        await service.load({ force: true });
        const entity = service.getEntityByReference(link.section, link.id);
        return entity ? legacyMatch(entity, link.section) : unmatched("missing-link");
    }

    let directory = [], directoryFailed = false;
    if (isWorldActor) {
        try { directory = await loadDirectory(campaignId); }
        catch (_) { directoryFailed = true; }
    }
    const currentWorld = directory.filter(entry => managedId(entry.worldId) === worldId);
    const byIdentity = currentWorld.filter(entry => [entry.actorId, entry.foundryActorId]
        .some(value => managedId(value) === actorId));
    // Explicit manual links take precedence over automatic Actor associations.
    const manualId = link?.source === "wiki" && link.section === SECTIONS.CHARACTERS ? String(link.id || "") : "";
    if (!manualId && byIdentity.length === 1) return managedMatch(byIdentity[0]);
    if (!manualId && byIdentity.length > 1) return unmatched("ambiguous");
    const linkedId = manualId || String(wikiNpcId || "");
    if (linkedId) {
        const linked = currentWorld.filter(entry => String(entry.profile?.legacyCharacterId || "") === linkedId);
        if (linked.length === 1) return managedMatch(linked[0]);
        if (linked.length > 1) return unmatched("ambiguous");
    }

    let legacy;
    try { legacy = await loadLegacyEntries(service, campaignId); }
    catch (_) { return unmatched("unavailable"); }
    const inScope = entry => (!entry.foundry?.worldId || managedId(entry.foundry.worldId) === worldId)
        && (!entry.foundry?.campaignId || managedId(entry.foundry.campaignId) === managedId(campaignId));
    // A saved link must never silently open a different NPC with the same name.
    if (linkedId) {
        const entity = legacy.find(entry => String(entry.id) === linkedId && inScope(entry));
        return entity ? legacyMatch(entity) : unmatched(directoryFailed ? "unavailable" : "missing-link");
    }
    if (isWorldActor) {
        const identities = legacy.filter(entry => inScope(entry) && (
            (entry.foundry?.actorId && managedId(entry.foundry.actorId) === actorId)
            || documents.some(doc => doc.uuid && entry.foundry?.actorUuid === doc.uuid)
        ));
        if (identities.length === 1) return legacyMatch(identities[0]);
        if (identities.length > 1) return unmatched("ambiguous");
    }
    const names = [...new Set([actor?.name, actor?.prototypeToken?.name, document?.name]
        .map(normalizeSearch).filter(Boolean))];
    for (const name of names) {
        const matches = legacy.filter(entry => inScope(entry) && [entry.name, entry.id,
            ...[entry.aliases, entry.foundryName, entry.foundryNames].flatMap(value => Array.isArray(value) ? value : [value])
        ].map(normalizeSearch).includes(name));
        if (matches.length === 1) return legacyMatch(matches[0]);
        if (matches.length > 1) return unmatched("ambiguous");
    }
    return unmatched(directoryFailed ? "unavailable" : "not-found");
}
