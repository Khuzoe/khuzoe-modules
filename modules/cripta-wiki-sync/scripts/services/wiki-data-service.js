import { DEFAULT_CAMPAIGN_ID, DEFAULT_SITE_BASE_URL, DISCORD_WORKER_URL, MODULE_ID, SECTIONS, SETTINGS } from "../constants.js";
import { wikiStore } from "./wiki-store.js";
import { appendEmbedParam, normalizeSearch, slugify, withCampaign } from "./wiki-utils.js";
import { policyFetch } from "./worker-gateway.js";
import { getNpcActor, resolveNpcWikiMatch } from "./wiki-npc-links.js";

async function fetchJson(url) {
    const response = await policyFetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
    return response.json();
}

async function fetchDataCollection(collection, fallbackUrl, campaignId) {
    let fallbackData = [];
    try {
        const payload = await fetchJson(fallbackUrl);
        fallbackData = Array.isArray(payload) ? payload : [];
    } catch (error) {
        console.warn(`${MODULE_ID} | Dati ${collection} statici non disponibili.`, error);
    }

    try {
        const payload = await fetchJson(withCampaign(`${DISCORD_WORKER_URL}/api/data/${collection}`, campaignId));
        if (Array.isArray(payload?.data)) {
            return mergeCollectionByIdOrName(fallbackData, payload.data);
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Dati ${collection} KV non disponibili, uso JSON statico.`, error);
    }
    return fallbackData;
}

function mergeCollectionByIdOrName(baseItems, overrideItems) {
    const merged = new Map();
    const add = (item) => {
        if (!item || typeof item !== "object") return;
        const key = item.id || slugify(item.name);
        if (!key) return;
        merged.set(key, item);
    };
    (Array.isArray(baseItems) ? baseItems : []).forEach(add);
    (Array.isArray(overrideItems) ? overrideItems : []).forEach(add);
    return Array.from(merged.values());
}

function filterVisibleItems(items) {
    const list = Array.isArray(items) ? items : [];
    return list.filter(item => item?.hidden !== true && item?.status !== "hidden");
}

function normalizeNameList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === "") return [];
    return [value];
}

function normalizeAliases(entity) {
    return [
        ...normalizeNameList(entity?.aliases),
        ...normalizeNameList(entity?.foundryName),
        ...normalizeNameList(entity?.foundryNames)
    ].map(alias => normalizeSearch(alias)).filter(Boolean);
}

function getDocumentSearchCandidates(document) {
    const values = [
        { source: "actor.name", value: document?.actor?.name },
        { source: "actor.prototypeToken.name", value: document?.actor?.prototypeToken?.name },
        { source: "document.name", value: document?.name },
        { source: "prototypeToken.name", value: document?.prototypeToken?.name }
    ];
    const seen = new Set();

    return values
        .map(candidate => ({
            ...candidate,
            value: String(candidate.value || "").trim(),
            normalized: normalizeSearch(candidate.value)
        }))
        .filter(candidate => {
            if (!candidate.value || !candidate.normalized || seen.has(candidate.normalized)) return false;
            seen.add(candidate.normalized);
            return true;
        });
}

function isItemDocument(document) {
    const documentName = String(document?.documentName || document?.constructor?.documentName || "").toLowerCase();
    if (documentName === "item") return true;
    const type = String(document?.type || "").toLowerCase();
    return ["weapon", "equipment", "armor", "consumable", "tool", "loot", "backpack", "container"].includes(type);
}

function getPreferredSectionsForDocument(document) {
    if (isItemDocument(document)) {
        return [SECTIONS.ITEMS, SECTIONS.CHARACTERS, SECTIONS.PLAYERS];
    }
    if (document?.actor || String(document?.documentName || document?.constructor?.documentName || "").toLowerCase() === "actor") {
        return [SECTIONS.CHARACTERS, SECTIONS.PLAYERS, SECTIONS.ITEMS];
    }
    return [SECTIONS.CHARACTERS, SECTIONS.PLAYERS, SECTIONS.ITEMS];
}

class WikiDataService {
    constructor() {
        this.cache = null;
        this.npcMatchRequests = new WeakMap();
    }

    getBaseUrl() {
        let value = DEFAULT_SITE_BASE_URL;
        try {
            value = game.settings.get(MODULE_ID, SETTINGS.SITE_BASE_URL) || DEFAULT_SITE_BASE_URL;
        } catch (_) {
            value = DEFAULT_SITE_BASE_URL;
        }
        return String(value).replace(/\/+$/, "");
    }

    getCampaignId() {
        let value = DEFAULT_CAMPAIGN_ID;
        try {
            value = game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || DEFAULT_CAMPAIGN_ID;
        } catch (_) {
            value = DEFAULT_CAMPAIGN_ID;
        }
        return String(value || DEFAULT_CAMPAIGN_ID).trim() || DEFAULT_CAMPAIGN_ID;
    }

    getDataUrl(path) {
        const cleanPath = String(path || "").replace(/^\/+/, "").replace(/^assets\/data\//, "");
        const campaignId = this.getCampaignId();
        if (campaignId === DEFAULT_CAMPAIGN_ID) return `${this.getBaseUrl()}/assets/data/${cleanPath}`;
        return `${this.getBaseUrl()}/campaigns/${encodeURIComponent(campaignId)}/data/${cleanPath}`;
    }

    getCssUrl() {
        return `${this.getBaseUrl()}/assets/css/abyssal.css`;
    }

    getFoundryUrl() {
        return this.getDataUrl("foundry.json");
    }

    getItemsUrl() {
        return this.getDataUrl("items.json");
    }


    getWikiPageUrl(section) {
        const baseUrl = this.getBaseUrl();
        switch (section) {
            case SECTIONS.HOME:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/index.html`));
            case SECTIONS.SESSIONS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/sessioni.html`));
            case SECTIONS.CHARACTERS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/npcs.html`));
            case SECTIONS.PLAYERS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/giocatori.html`));
            case SECTIONS.ITEMS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/oggetti.html`));
            default:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/index.html`));
        }
    }

    withCampaignSiteUrl(url) {
        const target = new URL(url);
        const campaignId = this.getCampaignId();
        if (campaignId !== DEFAULT_CAMPAIGN_ID) target.searchParams.set("campaign", campaignId);
        return target.toString();
    }

    invalidate() {
        this.cache = null;
    }

    async load(options = {}) {
        if (options.force === true) this.invalidate();
        if (this.cache) return this.cache;

        const [foundryData, items] = await Promise.all([
            fetchJson(this.getFoundryUrl()),
            fetchDataCollection("items", this.getItemsUrl(), this.getCampaignId())
        ]);

        const allCharacters = Array.isArray(foundryData?.characters) ? foundryData.characters : [];
        const allPlayers = Array.isArray(foundryData?.players) ? foundryData.players : [];
        const allItems = Array.isArray(items) ? items : [];

        const data = {
            home: foundryData,
            characters: allCharacters.filter(entity => entity?.hidden !== true),
            players: allPlayers.filter(entity => entity?.hidden !== true),
            sessions: Array.isArray(foundryData?.sessions?.sessions) ? foundryData.sessions.sessions : [],
            items: filterVisibleItems(allItems),
            indexCharacters: allCharacters,
            indexPlayers: allPlayers,
            indexItems: allItems
        };

        data.index = this.buildIndex(data);
        this.cache = data;
        return data;
    }

    buildIndex(data) {
        const bySection = {
            [SECTIONS.CHARACTERS]: new Map(),
            [SECTIONS.PLAYERS]: new Map(),
            [SECTIONS.ITEMS]: new Map()
        };
        const byName = new Map();

        const register = (section, entity, extraNames = []) => {
            if (!entity) return;
            const id = entity.id || slugify(entity.name);
            bySection[section].set(id, entity);
            const names = [
                entity.name,
                id,
                ...(extraNames || [])
            ]
                .map(normalizeSearch)
                .filter(Boolean);
            names.forEach(name => {
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push({ section, id, entity });
            });
        };

        (data.indexCharacters || data.characters).forEach(entity => register(SECTIONS.CHARACTERS, entity, normalizeAliases(entity)));
        (data.indexPlayers || data.players).forEach(entity => register(SECTIONS.PLAYERS, entity, normalizeAliases(entity)));
        (data.indexItems || data.items).forEach(entity => register(SECTIONS.ITEMS, entity, normalizeAliases(entity)));

        return { bySection, byName };
    }

    getEntityByReference(section, id) {
        const index = this.cache?.index?.bySection?.[section];
        return index?.get(id) || null;
    }

    findEntityByName(name, options = {}) {
        const normalized = normalizeSearch(name);
        if (!normalized || !this.cache?.index?.byName) return null;
        const matches = this.cache.index.byName.get(normalized);
        if (!matches?.length) return null;

        const preferredSections = Array.isArray(options.preferredSections) ? options.preferredSections : [];
        if (preferredSections.length) {
            const preferred = matches
                .slice()
                .sort((left, right) => {
                    const leftRank = preferredSections.indexOf(left.section);
                    const rightRank = preferredSections.indexOf(right.section);
                    const safeLeftRank = leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER;
                    const safeRightRank = rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER;
                    return safeLeftRank - safeRightRank;
                })[0];
            if (preferred) return preferred;
        }

        return matches[0] || null;
    }

    getEntityUrl(match) {
        const baseUrl = this.getBaseUrl();
        if (!match?.entity || !match?.section) return null;
        if (match.source === "draft") return null;
        if (match.managedActor) {
            const { worldId, actorId, campaignId, permissions } = match.managedActor;
            const target = new URL(`${baseUrl}/pages/characters/managed-actor.html`);
            target.searchParams.set("world", worldId);
            target.searchParams.set("actor", actorId);
            target.searchParams.set("campaign", campaignId);
            if (permissions?.canReadStats === false && permissions?.canReadProfile === true) target.searchParams.set("profile", "1");
            return appendEmbedParam(target.toString());
        }

        switch (match.section) {
            case SECTIONS.CHARACTERS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/characters/character.html?id=${encodeURIComponent(match.id)}`));
            case SECTIONS.PLAYERS:
                return appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/characters/character.html?id=${encodeURIComponent(match.id)}&type=player`));
            case SECTIONS.ITEMS:
                return `${appendEmbedParam(this.withCampaignSiteUrl(`${baseUrl}/pages/oggetti.html`))}#${encodeURIComponent(match.id)}`;
            default:
                return null;
        }
    }

    getEntityKey(match, fallbackDocument) {
        if (match?.source === "draft") return `draft:${match.id}`;
        if (match?.source === "wiki") return `wiki:${match.section}:${match.id}`;
        if (fallbackDocument?.uuid) return `doc:${fallbackDocument.uuid}`;
        return "doc:unknown";
    }

    async matchDocument(document) {
        if (getNpcActor(document)) {
            const context = `${this.getCampaignId()}:${game.world?.id}:${game.user?.id}`;
            const pending = this.npcMatchRequests.get(document);
            if (pending?.context === context) return pending.promise;
            const promise = resolveNpcWikiMatch(document, this, wikiStore).finally(() => {
                if (this.npcMatchRequests.get(document)?.promise === promise) this.npcMatchRequests.delete(document);
            });
            this.npcMatchRequests.set(document, { context, promise });
            return promise;
        }
        await this.load({ force: true });

        const link = wikiStore.getDocumentLink(document);
        if (link?.source === "draft") {
            const draft = wikiStore.getDraftEntries()[link.id];
            if (draft) {
                return {
                    source: "draft",
                    section: draft.section || SECTIONS.CHARACTERS,
                    id: draft.id,
                    entity: draft,
                    document,
                    key: `draft:${draft.id}`
                };
            }
        }

        if (link?.source === "wiki" && link.section && link.id) {
            const entity = this.getEntityByReference(link.section, link.id);
            if (entity) {
                return {
                    source: "wiki",
                    section: link.section,
                    id: link.id,
                    entity,
                    document,
                    key: `wiki:${link.section}:${link.id}`
                };
            }
        }

        const candidates = getDocumentSearchCandidates(document);
        const preferredSections = getPreferredSectionsForDocument(document);
        for (const candidate of candidates) {
            const found = this.findEntityByName(candidate.value, { preferredSections });
            if (!found) continue;
            return {
                source: "wiki",
                section: found.section,
                id: found.id,
                entity: found.entity,
                document,
                key: `wiki:${found.section}:${found.id}`,
                matchedName: candidate.value,
                matchedNameSource: candidate.source
            };
        }

        return {
            source: "unmatched",
            section: null,
            id: null,
            entity: null,
            document,
            key: this.getEntityKey(null, document),
            unresolvedName: candidates[0]?.value || ""
        };
    }

    async logDocumentSearch(document, context = "manuale") {
        if (getNpcActor(document)) {
            const match = await this.matchDocument(document);
            console.debug(`[Cripta Wiki Sync] Ricerca wiki NPC (${context})`, {
                name: document.name, source: match.source, id: match.id,
                reason: match.npcLinkReason || "", page: this.getEntityUrl(match)
            });
            return;
        }
        await this.load({ force: true });

        const candidates = getDocumentSearchCandidates(document);
        const link = wikiStore.getDocumentLink(document);
        const preferredSections = getPreferredSectionsForDocument(document);
        const rows = candidates.map(candidate => {
            const found = this.findEntityByName(candidate.value, { preferredSections });
            return {
                sorgente: candidate.source,
                valore: candidate.value,
                normalizzato: candidate.normalized,
                esito: found ? "MATCH" : "NO MATCH",
                sezione: found?.section || "",
                id: found?.id || "",
                pagina: found?.entity?.name || ""
            };
        });

        console.groupCollapsed(`[Cripta Wiki Sync] Ricerca wiki token (${context})`);
        console.log("Documento Foundry:", document);
        console.log("Link manuale salvato:", link || null);
        console.table(rows);
        if (!rows.length) {
            console.warn("Nessun nome valido trovato sul documento/token.");
        }
        const firstMatch = rows.find(row => row.esito === "MATCH");
        if (firstMatch) {
            console.log("Risultato usato:", firstMatch);
        } else {
            console.warn("Nessuna pagina wiki trovata per i nomi cercati.");
        }
        console.groupEnd();
    }

    guessDraftSection(document) {
        if (isItemDocument(document)) return SECTIONS.ITEMS;
        return SECTIONS.CHARACTERS;
    }

    async createDraftFromDocument(document) {
        const now = new Date().toISOString();
        const section = this.guessDraftSection(document);
        const name = document?.name || "Nuova voce";
        const id = `${slugify(name)}-${foundry.utils.randomID(6).toLowerCase()}`;
        const draft = {
            id,
            section,
            name,
            type: section === SECTIONS.ITEMS ? "Bozza oggetto" : "Bozza NPC",
            summary: "Bozza generata da Foundry per un'entita non ancora presente nella wiki.",
            owner: null,
            image: document?.texture?.src || document?.img || document?.actor?.img || "",
            properties: [],
            notes: "",
            hidden: false,
            status: "draft",
            sourceDocumentUuid: document?.uuid || null,
            createdAt: now,
            createdBy: game.user?.id ?? null
        };
        await wikiStore.createDraftForDocument(document, draft);
        return draft;
    }
}

export const wikiDataService = new WikiDataService();
