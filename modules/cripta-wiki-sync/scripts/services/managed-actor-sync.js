import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { canPullFromWorker, canPushToWorker } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";
import { getActiveEffectChanges, normalizeActiveEffectChangesV14, normalizeActiveEffectSourceV14 } from "./foundry-v14.js";
import { buildFoundrySyncContract } from "./sync-contract.js";
import { modernizeSpellPreparationUpdate, normalizePreparedState, readDnd5eSenses, readSpellPreparation, spellPreparationForWiki } from "./dnd5e-fields.js";
import { NpcDossierVisibilitySync, NPC_VISIBILITY_SETTING } from "./npc-dossier-visibility.mjs";
import { validateManagedMidiRollConfig } from "./midi-roll-config.mjs";
import { isTemporaryWikiActor } from "./actor-sync-eligibility.mjs";

const TOKENIZER_MODULE_ID = "khuzoe-tokenizer";
const MERCHANT_MODULE_ID = "khuzoe-merchant";
const MERCHANT_FLAG_KEY = "merchant";
const TOKENIZER_SAVED_HOOK = `${TOKENIZER_MODULE_ID}.saved`;
const TOKENIZER_SYNC_EVENT_PATH = `flags.${TOKENIZER_MODULE_ID}.syncEvent`;
const PENDING_SETTING = "managedActorPendingQueue";
const STATE_SETTING = "managedActorSyncState";
const RECOVERY_SETTING = "managedActorRecoveryBackups";
const KNOWN_ACTOR_DELTA_RECOVERIES = Object.freeze([{
    actorId: "K0rlUf1C7QEmUNc9",
    sceneId: "vpAvxF9fMmMU8TG6",
    tokenId: "x8alUyv0cEYCrUU9",
    deltaId: "7LokFUhbXDqG5L59",
    label: "Dinosauro Spaziale Distruttore Assoluto Vero",
    expectedItemNames: ["Multiattack", "Bite", "Swallow", "Stomp", "Tail"]
}]);

const MANAGED_STATE_SCHEMA_VERSION = 4;
const MANAGED_MERCHANT_SCHEMA_VERSION = 6;
const MANAGED_MEDIA_APPLICATION_VERSION = 4;
const MANAGED_ACTOR_LINK_CANONICAL_SCHEMA_VERSION = 2;
const MANAGED_ACTOR_LINK_BACKUP_SCHEMA_VERSION = 6;
const applyingManagedActivityCommands = new WeakSet();
const SYNC_BATCH_WINDOW_MS = 60_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ICON_UPLOADS = 250;
const MAX_MERCHANT_ITEMS = 200;
const RUNTIME_SYNC_INTERVAL_MS = 30 * 60_000;
const RUNTIME_SYNC_MIN_DELAY_MS = 4_000;
const RUNTIME_RETRY_DELAY_MS = 60_000;
const MANAGED_ACTOR_INDEX_CACHE_TTL_MS = 60_000;
const DEFAULT_VISIBILITY = Object.freeze({ state: "dm", published: false });

const pendingJobs = new Map();
const pendingTimers = new Map();
let managedActorFlushChain = Promise.resolve();
let managedActorRuntimeChain = Promise.resolve();
let managedActorCommandPullPromise = null;
const managedActorLinkConversions = new Map();
const managedActorLinkNativeImports = new Set();
let callbacks = {};
const runtimeTimers = new Map();
const runtimeLastSyncedAt = new Map();
let registered = false;
let managedVariantPullStarted = false;
let npcDossierVisibilitySync;
const managedActorRelationshipCache = {
    campaignId: "",
    loadedAt: 0,
    payload: null,
    promise: null
};
const npcCategoryRegistryCache = {
    campaignId: "",
    loadedAt: 0,
    revision: 0,
    categories: []
};
const recentlyConfirmedManagedActors = new Map();
const reportedManagedActorCreateErrors = new Set();

export function registerManagedActorSync(options = {}) {
    if (registered) return;
    registered = true;
    callbacks = options;

    game.settings.register(MODULE_ID, NPC_VISIBILITY_SETTING, { scope: "world", config: false, restricted: true, type: Object, default: { pending: {}, applied: {}, initialHoverChecked: {} } });
    npcDossierVisibilitySync = new NpcDossierVisibilitySync({
        game, campaignId: getCampaignId, canPush: canRunManagedActorSync, canPull: canRunManagedActorPull,
        isManaged: actor => {
            const identity = getManagedActorIdentity(actor);
            if (!identity) return false;
            // The first index pull already knows shared actors, before their
            // local content-sync state has been populated. No extra request.
            if (managedActorRelationshipCache.campaignId === identity.campaignId && managedActorRelationshipCache.payload) {
                return (managedActorRelationshipCache.payload.data || []).some(summary => sanitizeId(summary.worldId) === identity.worldId
                    && [summary.actorId, summary.foundryActorId].some(id => sanitizeId(id) === identity.actorId));
            }
            return hasManagedActorState(actor);
        },
        readState: () => getWorldObjectSetting(NPC_VISIBILITY_SETTING),
        writeState: state => game.settings.set(MODULE_ID, NPC_VISIBILITY_SETTING, state),
        request: async (identity, body) => {
            if (identity.campaignId !== getCampaignId() || identity.worldId !== game.world.id) throw new Error("Campagna cambiata durante l'allineamento del dossier.");
            const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(identity.worldId)}/${encodeURIComponent(identity.actorId)}/profile`);
            url.searchParams.set("campaign", identity.campaignId);
            const response = await policyFetch(url, {
                method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(20000),
                headers: { ...buildWorkerAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || result?.ok === false || !result?.data) throw Object.assign(new Error(result?.error || `Dossier HTTP ${response.status}`), { status: response.status });
            return result.data;
        },
        report: error => { console.warn(`${MODULE_ID} | Visibilità dossier NPC non allineata.`, error); ui.notifications.warn(`Visibilità dossier NPC: ${error.message}`); }
    });
    Hooks.on("updateActor", (...args) => npcDossierVisibilitySync.onActorUpdate(...args));
    Hooks.on("updateToken", (...args) => npcDossierVisibilitySync.onTokenUpdate(...args));
    Hooks.on("userConnected", () => { if (game.ready) npcDossierVisibilitySync.resume(); });
    Hooks.on("updateUser", () => { if (game.ready) npcDossierVisibilitySync.resume(); });

    game.settings.register(MODULE_ID, PENDING_SETTING, {
        name: "Coda Managed Actor",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: {}
    });
    game.settings.register(MODULE_ID, STATE_SETTING, {
        name: "Stato Managed Actor",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: {}
    });
    game.settings.register(MODULE_ID, RECOVERY_SETTING, {
        name: "Backup recuperi Managed Actor",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: {}
    });

    Hooks.on(TOKENIZER_SAVED_HOOK, (actor, event = {}) => {
        if (!canRunManagedActorSync(actor)) return;
        queueManagedActorSync(actor, event).catch((error) => {
            console.warn(`${MODULE_ID} | Impossibile accodare Managed Actor.`, { actor: actor?.name, error });
        });
    });

    Hooks.on("updateActor", (actor, changes = {}, options = {}, userId = "") => {
        if (options?.criptaWikiSyncCommand
            || options?.khuzoeTokenizerSave
            || managedActorLinkConversions.has(String(actor?.id || ""))
            || managedActorLinkNativeImports.has(String(actor?.id || ""))
            || !canRunManagedActorSync(actor)) return;

        const tokenizerEvent = getTokenizerSyncEvent(actor, changes);
        if (tokenizerEvent) {
            if (String(userId || "") !== String(game.user.id || "")) {
                queueManagedActorSync(actor, tokenizerEvent).catch((error) => {
                    console.warn(`${MODULE_ID} | Sync Tokenizer remoto non accodato.`, { actor: actor?.name, error });
                });
            }
            return;
        }

        if (!hasManagedActorState(actor)) {
            if (hasManagedMerchantChanges(changes) && isManagedMerchant(actor)) {
                queueManagedActorSync(actor, {
                    reason: "merchant-enabled",
                    forceCreate: true,
                    allowMissingBaseMedia: true
                }).catch((error) => console.warn(`${MODULE_ID} | Creazione Managed Actor mercante non accodata.`, error));
            }
            return;
        }
        if (hasManagedRuntimeChanges(changes) && managedActorUsesSharedRuntime(actor)) {
            scheduleManagedActorRuntimeSync(actor.id);
        }
        if (managedActorUsesSharedRuntime(actor) && hasManagedLinkedPrototypeChanges(changes)) {
            updateLinkedPlacedTokens(actor).catch((error) => {
                console.warn(`${MODULE_ID} | Configurazione dei token collegati non propagata.`, { actor: actor?.name, error });
            });
        }
        if (hasManagedDefinitionChanges(changes)) {
            queueManagedActorSync(actor, {
                reason: "actor-update",
                changedTargets: getManagedMediaChangedTargets(changes),
                forceContentSync: true,
            }).catch((error) => console.warn(`${MODULE_ID} | Sync Actor modificato non accodata.`, error));
        }
    });
    Hooks.on("updateItem", (item, changes = {}, options = {}) => queueManagedItemOwnerSync(item, "item-update", options));
    Hooks.on("createItem", (item, options = {}) => queueManagedItemOwnerSync(item, "item-create", options));
    Hooks.on("deleteItem", (item, options = {}) => queueManagedItemOwnerSync(item, "item-delete", options));
    Hooks.on("updateActiveEffect", (effect, changes = {}, options = {}) => queueManagedEffectOwnerSync(effect, "effect-update", options));
    Hooks.on("createActiveEffect", (effect, options = {}) => queueManagedEffectOwnerSync(effect, "effect-create", options));
    Hooks.on("deleteActiveEffect", (effect, options = {}) => queueManagedEffectOwnerSync(effect, "effect-delete", options));
}

async function recoverPreparedManagedActorLinkConversions() {
    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    let nextStateRoot = { ...stateRoot };
    let changed = false;
    for (const [actorId, actorState] of Object.entries(stateRoot)) {
        const conversion = actorState?.actorLinkConversion;
        if (conversion?.status !== "prepared" || !conversion.snapshot) continue;
        const actor = game.actors.get(actorId);
        if (!actor) {
            console.warn(`${MODULE_ID} | Backup Link Actor Data in attesa: Actor non trovato.`, { actorId });
            continue;
        }
        try {
            await restoreManagedActorLinkSnapshot(actor, conversion.snapshot);
            const { actorLinkConversion: _discarded, ...restoredState } = actorState;
            nextStateRoot[actorId] = restoredState;
            changed = true;
            console.warn(`${MODULE_ID} | Conversione Link Actor Data interrotta ripristinata dal backup.`, {
                actor: actor.name,
                commandId: conversion.snapshot.commandId || ""
            });
        } catch (error) {
            console.error(`${MODULE_ID} | Ripristino automatico Link Actor Data non completato; il backup resta disponibile.`, {
                actor: actor.name,
                error
            });
        }
    }
    if (changed) await game.settings.set(MODULE_ID, STATE_SETTING, nextStateRoot);
    return changed;
}

export async function resumeManagedActorSyncQueue() {
    if (!canRunManagedActorSync()) return false;
    npcDossierVisibilitySync?.resume();
    await recoverPreparedManagedActorLinkConversions();
    await recoverKnownActorDeltas();
    const stored = getWorldObjectSetting(PENDING_SETTING);
    let nextStored = { ...stored };
    let queueChanged = false;
    for (const [actorId, event] of Object.entries(stored)) {
        const actor = game.actors.get(actorId);
        if (!actor || isTemporaryWikiActor(actor)) continue;
        pendingJobs.set(actorId, normalizeTokenizerEvent(event));
        scheduleManagedActorFlush(actorId, 2_500);
    }
    const state = getWorldObjectSetting(STATE_SETTING);
    Array.from(game.actors || []).forEach((actor, index) => {
        if (isTemporaryWikiActor(actor)) return;
        const actorState = state[actor.id];
        if (pendingJobs.has(actor.id)) return;
        let event = null;
        if (actorState?.revision && Number(actorState.schemaVersion || 0) < MANAGED_STATE_SCHEMA_VERSION) {
            event = normalizeTokenizerEvent({ reason: "schema-upgrade" });
        } else if (actorState?.revision && isManagedMerchant(actor)
            && Number(actorState.merchantSchemaVersion || 0) < MANAGED_MERCHANT_SCHEMA_VERSION) {
            event = normalizeTokenizerEvent({ reason: "merchant-schema-upgrade", forceContentSync: true });
        } else if (!actorState?.revision) {
            if (isManagedMerchant(actor)) {
                event = normalizeTokenizerEvent({
                    reason: "merchant-resume",
                    forceCreate: true,
                    allowMissingBaseMedia: true
                });
            } else {
                const tokenizerEvent = actor.getFlag?.(TOKENIZER_MODULE_ID, "syncEvent");
                if (tokenizerEvent && typeof tokenizerEvent === "object" && String(tokenizerEvent.eventId || "").trim()) {
                    event = normalizeTokenizerEvent({ ...tokenizerEvent, reason: "tokenizer-resume", forceCreate: true });
                }
            }
        }
        if (!event) return;
        pendingJobs.set(actor.id, event);
        nextStored[actor.id] = event;
        queueChanged = true;
        scheduleManagedActorFlush(actor.id, 2_500 + (index * 100));
    });
    if (queueChanged) await game.settings.set(MODULE_ID, PENDING_SETTING, nextStored);
    return pendingJobs.size > 0;
}

export function startManagedActorVariantPull({ initialPull = true } = {}) {
    if (!canRunManagedActorSync() || managedVariantPullStarted) return;
    managedVariantPullStarted = true;
    if (initialPull) pullManagedActorVariants().catch((error) => console.warn(`${MODULE_ID} | Pull varianti Managed Actor fallito.`, error));
    Array.from(game.actors || []).filter((actor) => hasManagedActorState(actor) && managedActorUsesSharedRuntime(actor)).forEach((actor, index) => {
        scheduleManagedActorRuntimeSync(actor.id, 2_500 + (index * 250));
    });
}

export async function loadManagedActorRelationshipIndex({ force = false } = {}) {
    const campaignId = getCampaignId();
    resetManagedActorRelationshipCacheForCampaign(campaignId);
    const cacheIsFresh = managedActorRelationshipCache.payload
        && (Date.now() - managedActorRelationshipCache.loadedAt) < MANAGED_ACTOR_INDEX_CACHE_TTL_MS;
    if (!force && cacheIsFresh) return managedActorRelationshipCache.payload;
    if (managedActorRelationshipCache.promise) return managedActorRelationshipCache.promise;

    const request = (async () => {
        const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors`);
        url.searchParams.set("campaign", campaignId);
        const response = await policyFetch(url.toString(), { headers: buildWorkerAuthHeaders() });
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.ok === false) throw new Error(data?.error || `Managed Actor index HTTP ${response.status}`);
        if (managedActorRelationshipCache.campaignId === campaignId) {
            managedActorRelationshipCache.payload = data;
            managedActorRelationshipCache.loadedAt = Date.now();
        }
        return data;
    })();
    managedActorRelationshipCache.promise = request;
    try {
        return await request;
    } finally {
        if (managedActorRelationshipCache.promise === request) managedActorRelationshipCache.promise = null;
    }
}

export async function isManagedActorShared(actor, { force = false } = {}) {
    const identity = getManagedActorIdentity(actor);
    if (!identity) return false;
    const recentlyConfirmedAt = Number(recentlyConfirmedManagedActors.get(identity.key) || 0);
    if (!force && recentlyConfirmedAt && (Date.now() - recentlyConfirmedAt) < MANAGED_ACTOR_INDEX_CACHE_TTL_MS) return true;

    const payload = await loadManagedActorRelationshipIndex({ force });
    const shared = (Array.isArray(payload?.data) ? payload.data : []).some((summary) => {
        if (sanitizeId(summary?.worldId) !== identity.worldId) return false;
        return [summary?.actorId, summary?.foundryActorId].some((value) => sanitizeId(value) === identity.actorId);
    });
    if (shared) recentlyConfirmedManagedActors.set(identity.key, Date.now());
    else recentlyConfirmedManagedActors.delete(identity.key);
    return shared;
}

export async function saveManagedActorRelationship(summary, ownerCharacterId = "") {
    const worldId = sanitizeId(summary?.worldId || game.world?.id || "world");
    const actorId = sanitizeId(summary?.actorId || summary?.foundryActorId || "");
    if (!worldId || !actorId) throw new Error("Identita Managed Actor mancante.");
    const cleanOwnerCharacterId = sanitizeId(ownerCharacterId);
    const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(worldId)}/${encodeURIComponent(actorId)}/relationship`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            campaignId: getCampaignId(),
            relationshipType: cleanOwnerCharacterId ? "companion" : "",
            ownerCharacterId: cleanOwnerCharacterId,
            expectedRelationshipRevision: Math.max(0, Math.floor(Number(summary?.relationshipRevision) || 0))
        })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Relazione companion HTTP ${response.status}`);
    managedActorRelationshipCache.loadedAt = 0;
    return data;
}
export async function loadNpcCategoryRegistry({ force = false } = {}) {
    const campaignId = getCampaignId();
    const fresh = npcCategoryRegistryCache.campaignId === campaignId
        && npcCategoryRegistryCache.loadedAt
        && (Date.now() - npcCategoryRegistryCache.loadedAt) < MANAGED_ACTOR_INDEX_CACHE_TTL_MS;
    if (!force && fresh) {
        return {
            campaignId,
            revision: npcCategoryRegistryCache.revision,
            categories: npcCategoryRegistryCache.categories.map((category) => ({ ...category }))
        };
    }
    const url = new URL(`${DISCORD_WORKER_URL}/api/npc-categories`);
    url.searchParams.set("campaign", campaignId);
    const response = await policyFetch(url, { headers: buildWorkerAuthHeaders() });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Categorie NPC HTTP ${response.status}`);
    const data = payload?.data || payload || {};
    npcCategoryRegistryCache.campaignId = campaignId;
    npcCategoryRegistryCache.loadedAt = Date.now();
    npcCategoryRegistryCache.revision = Math.max(0, Math.floor(Number(data.revision ?? payload?.revision) || 0));
    npcCategoryRegistryCache.categories = (Array.isArray(data.categories) ? data.categories : []).map((category) => ({ ...category }));
    return {
        campaignId,
        revision: npcCategoryRegistryCache.revision,
        categories: npcCategoryRegistryCache.categories.map((category) => ({ ...category }))
    };
}

export async function saveNpcCategoryRegistry(categories, expectedRevision = 0) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/npc-categories`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url, {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            campaignId: getCampaignId(),
            expectedRevision: Math.max(0, Math.floor(Number(expectedRevision) || 0)),
            categories: Array.isArray(categories) ? categories : []
        })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Salvataggio categorie NPC HTTP ${response.status}`);
    npcCategoryRegistryCache.loadedAt = 0;
    return loadNpcCategoryRegistry({ force: true });
}

export async function saveManagedActorNpcCategory(actor, categoryId = "") {
    const identity = getManagedActorIdentity(actor);
    if (!identity) throw new Error("Identita Managed Actor mancante.");
    const registry = await loadNpcCategoryRegistry();
    const cleanId = sanitizeId(categoryId);
    const category = cleanId
        ? registry.categories.find((entry) => sanitizeId(entry.id) === cleanId && !entry.mergedInto)
        : null;
    if (cleanId && !category) throw new Error("Categoria NPC non disponibile.");

    const profileUrl = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(identity.worldId)}/${encodeURIComponent(identity.actorId)}/profile`);
    profileUrl.searchParams.set("campaign", getCampaignId());
    const headers = buildWorkerAuthHeaders();
    const currentResponse = await policyFetch(profileUrl, { headers });
    const currentPayload = await currentResponse.json().catch(() => null);
    if (!currentResponse.ok || currentPayload?.ok === false) throw new Error(currentPayload?.error || `Profilo NPC HTTP ${currentResponse.status}`);

    const profile = currentPayload?.data || {};
    const response = await policyFetch(profileUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
            campaignId: getCampaignId(),
            expectedRevision: Math.max(0, Math.floor(Number(profile.revision) || 0)),
            data: {
                ...profile,
                categoryId: category?.id || "",
                category: category?.name || ""
            }
        })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Aggiornamento categoria NPC HTTP ${response.status}`);
    const savedProfile = payload?.data || {};
    const flag = category
        ? { id: category.id, name: category.name, profileRevision: Math.max(0, Number(savedProfile.revision) || 0) }
        : null;
    const update = flag
        ? { [`flags.${MODULE_ID}.npcCategory`]: flag }
        : { [`flags.${MODULE_ID}.-=npcCategory`]: null };
    await actor.update(update, { criptaWikiSyncCommand: true });
    managedActorRelationshipCache.loadedAt = 0;
    return { profile: savedProfile, category: flag };
}

function managedActorProfileRuntimePolicy(_profile = {}) {
    // La classificazione scelta sul sito e soltanto presentativa: Link Actor Data
    // resta lo stato strutturale autorevole per la politica runtime.
    return "";
}

async function applyManagedActorNpcCategory(actor, profile = {}) {
    const desired = profile?.categoryId
        ? {
            id: sanitizeId(profile.categoryId),
            name: String(profile.category || "").trim(),
            profileRevision: Math.max(0, Math.floor(Number(profile.revision) || 0))
        }
        : null;
    const current = actor.getFlag?.(MODULE_ID, "npcCategory") || null;
    if (stableStringify(current) === stableStringify(desired)) return false;
    const update = desired
        ? { [`flags.${MODULE_ID}.npcCategory`]: desired }
        : { [`flags.${MODULE_ID}.-=npcCategory`]: null };
    await actor.update(update, { criptaWikiSyncCommand: true });
    return true;
}

function managedActorBaseMediaNeedsApplication(actor, media = {}) {
    return ["avatar", "token"].some((slot) => {
        const descriptor = media?.[slot];
        if (!descriptor?.path) return false;
        const expected = withMediaRevision(toWorkerMediaUrl(descriptor.path), descriptor.revision || 1);
        const current = slot === "avatar"
            ? String(actor?.img || "")
            : String(actor?.prototypeToken?.texture?.src || actor?.prototypeToken?.img || "");
        return current !== expected;
    });
}

export async function pullManagedActorVariants({ forceIndex = false, actorIds = [], pullCommands = true } = {}) {
    if (!canRunManagedActorPull()) return false;
    const worldId = sanitizeId(game.world?.id || "world");
    const campaignId = getCampaignId();
    const requestedActorIds = new Set((Array.isArray(actorIds) ? actorIds : [])
        .map(sanitizeId)
        .filter(Boolean));

    const tokenizerApi = game.modules.get("khuzoe-tokenizer")?.api || game.khuzoeTokenizer;
    const canReplaceVariants = typeof tokenizerApi?.replaceVariants === "function";
    const indexPayload = await loadManagedActorRelationshipIndex({ force: forceIndex });
    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    let nextState = stateRoot;
    let changed = false;
    for (const summary of Array.isArray(indexPayload?.data) ? indexPayload.data : []) {
        if (getCampaignId() !== campaignId || sanitizeId(game.world?.id || "world") !== worldId || !canRunManagedActorPull()) return false;
        if (sanitizeId(summary.worldId) !== worldId) continue;
        if (requestedActorIds.size && ![summary.actorId, summary.foundryActorId]
            .map(sanitizeId)
            .some((actorId) => requestedActorIds.has(actorId))) {
            continue;
        }
        const actor = game.actors.get(summary.foundryActorId) || game.actors.get(summary.actorId);
        if (!actor || isTemporaryWikiActor(actor)) continue;
        let previous = nextState[actor.id] || {};
        await npcDossierVisibilitySync?.pull(actor, summary.profile);
        const categoryChanged = await applyManagedActorNpcCategory(actor, summary.profile || {});
        const runtimePolicyOverride = managedActorProfileRuntimePolicy(summary.profile || {});
        const runtimePolicyChanged = String(previous.runtimePolicyOverride || "") !== runtimePolicyOverride;
        if (runtimePolicyChanged) {
            previous = { ...previous, runtimePolicyOverride };
            nextState = { ...nextState, [actor.id]: previous };
            changed = true;
            await queueManagedActorSync(actor, {
                reason: "profile-runtime-policy",
                forceContentSync: true
            });
        }
        const remoteRevision = Number(summary.revision || 0);
        const appliedVariantRevision = previous.variantRevision === undefined ? Number(previous.revision || 0) : Number(previous.variantRevision || 0);
        const needsDocument = remoteRevision > Number(previous.revision || 0)
            || (canReplaceVariants && remoteRevision > appliedVariantRevision)
            || Number(previous.mediaApplicationVersion || 0) < MANAGED_MEDIA_APPLICATION_VERSION
            || managedActorBaseMediaNeedsApplication(actor, summary.media);
        if (!needsDocument) {
            changed = changed || categoryChanged;
            continue;
        }
        const detailUrl = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(summary.worldId)}/${encodeURIComponent(summary.actorId)}`);
        detailUrl.searchParams.set("campaign", getCampaignId());
        const response = await policyFetch(detailUrl, { headers: buildWorkerAuthHeaders() });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok === false) continue;

        const mediaApplication = await applyManagedActorBaseMedia(actor, payload.data?.media, previous);
        let pulledVariants = previous.variants || {};
        let variantRevision = previous.variantRevision === undefined ? Number(previous.revision || 0) : Number(previous.variantRevision || 0);
        if (canReplaceVariants && remoteRevision > variantRevision) {
            const variants = (Array.isArray(payload.data?.media?.variants) ? payload.data.media.variants : []).map((variant) => ({
                ...variant,
                src: toWorkerMediaUrl(variant.path),
                source: "manual",
                updatedAt: payload.data.updatedAt
            }));
            await tokenizerApi.replaceVariants(actor, { source: "managed-actor", revision: payload.data.revision, variants });
            pulledVariants = Object.fromEntries(variants.map((variant) => [variant.id, {
                source: stripCacheBust(variant.src),
                path: variant.path,
                revision: Number(variant.revision || 1),
                updatedAt: variant.updatedAt || "",
                signature: managedVariantSignature(variant, variant.src)
            }]));
            variantRevision = remoteRevision;
        }
        nextState = { ...nextState, [actor.id]: { ...previous,
            revision: remoteRevision,
            variantRevision,
            mediaHash: hashValue(payload.data.media || {}),
            mediaApplicationVersion: mediaApplication.complete
                ? MANAGED_MEDIA_APPLICATION_VERSION
                : Number(previous.mediaApplicationVersion || 0),
            slots: mediaApplication.slots,
            variants: pulledVariants,
            syncedAt: new Date().toISOString()
        } };
        changed = true;
    }
    if (changed) await game.settings.set(MODULE_ID, STATE_SETTING, nextState);
    const commandChanges = pullCommands
        ? await pullManagedActorCommands(worldId).catch((error) => {
            console.warn(`${MODULE_ID} | Pull comandi Managed Actor fallito.`, error);
            return false;
        })
        : false;
    return changed || commandChanges;
}

export async function pullManagedActorCommandsNow() {
    if (!canRunManagedActorPull()) return false;
    return pullManagedActorCommands(sanitizeId(game.world?.id || "world"));
}

async function realignManagedActorAfterConflict(actor, minimumRevision = 0) {
    const identity = getManagedActorIdentity(actor);
    if (!identity) throw new Error("Identita Managed Actor non valida durante il riallineamento.");

    const detailUrl = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(identity.worldId)}/${encodeURIComponent(identity.actorId)}`);
    detailUrl.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(detailUrl, { headers: buildWorkerAuthHeaders() });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false || !payload?.data) {
        throw new Error(payload?.error || `Managed Actor detail HTTP ${response.status}`);
    }

    const remoteRevision = Math.max(0, Number(payload.data.revision || 0));
    if (remoteRevision < Math.max(0, Number(minimumRevision || 0))) {
        throw new Error(`Revisione Managed Actor non ancora aggiornata: ricevuta ${remoteRevision}, richiesta almeno ${minimumRevision}.`);
    }

    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    const previous = stateRoot[actor.id] && typeof stateRoot[actor.id] === "object" ? stateRoot[actor.id] : {};
    const mediaApplication = await applyManagedActorBaseMedia(actor, payload.data.media || {}, previous);
    const tokenizerApi = game.modules.get(TOKENIZER_MODULE_ID)?.api || game.khuzoeTokenizer;
    const canReplaceVariants = typeof tokenizerApi?.replaceVariants === "function";
    let pulledVariants = previous.variants || {};
    let variantRevision = previous.variantRevision === undefined ? Number(previous.revision || 0) : Number(previous.variantRevision || 0);

    if (canReplaceVariants && remoteRevision > variantRevision) {
        const variants = (Array.isArray(payload.data?.media?.variants) ? payload.data.media.variants : []).map((variant) => ({
            ...variant,
            src: toWorkerMediaUrl(variant.path),
            source: "manual",
            updatedAt: payload.data.updatedAt
        }));
        await tokenizerApi.replaceVariants(actor, { source: "managed-actor", revision: remoteRevision, variants });
        pulledVariants = Object.fromEntries(variants.map((variant) => [variant.id, {
            source: stripCacheBust(variant.src),
            path: variant.path,
            revision: Number(variant.revision || 1),
            updatedAt: variant.updatedAt || "",
            signature: managedVariantSignature(variant, variant.src)
        }]));
        variantRevision = remoteRevision;
    }

    const freshStateRoot = getWorldObjectSetting(STATE_SETTING);
    const freshPrevious = freshStateRoot[actor.id] && typeof freshStateRoot[actor.id] === "object"
        ? freshStateRoot[actor.id]
        : previous;
    await game.settings.set(MODULE_ID, STATE_SETTING, {
        ...freshStateRoot,
        [actor.id]: {
            ...freshPrevious,
            revision: remoteRevision,
            variantRevision,
            mediaHash: hashValue(payload.data.media || {}),
            mediaApplicationVersion: mediaApplication.complete
                ? MANAGED_MEDIA_APPLICATION_VERSION
                : Number(freshPrevious.mediaApplicationVersion || 0),
            slots: mediaApplication.slots,
            variants: pulledVariants,
            syncedAt: new Date().toISOString()
        }
    });
    return remoteRevision;
}

async function applyManagedActorBaseMedia(actor, media = {}, previousState = {}) {
    const slots = { ...(previousState.slots || {}) };
    const update = {};
    let linkedTokenPath = "";
    let complete = true;
    const applicationUpgrade = Number(previousState.mediaApplicationVersion || 0) < MANAGED_MEDIA_APPLICATION_VERSION;
    for (const slot of ["avatar", "token"]) {
        const descriptor = media?.[slot];
        if (!descriptor?.path) continue;
        const revision = Math.max(1, Number(descriptor.revision || 1));
        const remote = withMediaRevision(toWorkerMediaUrl(descriptor.path), revision);
        const current = slot === "avatar" ? actor.img : (actor.prototypeToken?.texture?.src || actor.prototypeToken?.img || "");
        const previousSlot = slots[slot] || {};
        const descriptorChanged = stripCacheBust(previousSlot.source || "") !== stripCacheBust(remote)
            || Number(previousSlot.revision || 0) !== revision;
        const currentChanged = String(current || "") !== remote;
        if ((applicationUpgrade || descriptorChanged || currentChanged) && !(await managedActorMediaExists(remote))) {
            complete = false;
            console.warn(`${MODULE_ID} | Media canonico Managed Actor non disponibile; mantengo l'immagine corrente.`, {
                actor: actor.name,
                slot,
                path: descriptor.path,
                revision
            });
            continue;
        }
        if (slot === "token") linkedTokenPath = remote;
        if (descriptorChanged || currentChanged) {
            if (slot === "avatar") update.img = remote;
            else update["prototypeToken.texture.src"] = remote;
        }
        slots[slot] = {
            source: stripCacheBust(remote),
            path: descriptor.path,
            revision
        };
    }
    if (Object.keys(update).length) await actor.update(update, { criptaWikiSyncCommand: true });
    if (linkedTokenPath) await updateLinkedPlacedTokens(actor, linkedTokenPath);
    return { slots, complete };
}

async function managedActorMediaExists(path) {
    try {
        const response = await policyFetch(path, { method: "HEAD", cache: "no-store" });
        return response.ok;
    } catch (_error) {
        return false;
    }
}

function withMediaRevision(path, revision) {
    const value = String(path || "").trim();
    if (!value) return "";
    const separator = value.includes("?") ? "&" : "?";
    return `${value}${separator}rev=${encodeURIComponent(String(Math.max(1, Number(revision || 1))))}`;
}

async function updateLinkedPlacedTokens(actor, tokenPath = "") {
    const prototype = actor?.prototypeToken || {};
    // Preserve the placed-token HOVER that triggered publication while the
    // initial media pull (or a retry) runs before that publication completes.
    const preserveNameDisplay = npcDossierVisibilitySync?.hasPending(actor);
    const prototypeTexture = prototype.texture || {};
    const resolvedTokenPath = String(tokenPath || prototypeTexture.src || prototype.img || "");
    for (const scene of game.scenes || []) {
        const updates = [];
        for (const token of scene.tokens || []) {
            if (String(token.actorId || "") !== String(actor.id || "") || token.actorLink !== true) continue;
            const activeVariant = String(token.getFlag?.(TOKENIZER_MODULE_ID, "activeTokenVariant") || "base");
            const storedBase = token.getFlag?.(TOKENIZER_MODULE_ID, "tokenVariantBase");
            const base = foundry.utils.deepClone(storedBase && typeof storedBase === "object" ? storedBase : {});
            base.width = Number(prototype.width || base.width || token.width || 1);
            base.height = Number(prototype.height || prototype.width || base.height || token.height || token.width || 1);
            base.texture = {
                ...(storedBase?.texture || {}),
                src: resolvedTokenPath || token.texture?.src || token.img || ""
            };
            for (const path of ["scaleX", "scaleY", "offsetX", "offsetY", "rotation", "tint", "alphaThreshold"]) {
                if (prototypeTexture[path] !== undefined) base.texture[path] = prototypeTexture[path];
            }

            const update = { _id: token.id };
            if (stableStringify(storedBase || null) !== stableStringify(base)) {
                update[`flags.${TOKENIZER_MODULE_ID}.tokenVariantBase`] = base;
            }
            const commonFields = [
                ["name", token.name, actor.name || prototype.name],
                ["displayName", token.displayName, prototype.displayName]
            ];
            for (const [path, currentValue, desiredValue] of commonFields) {
                if (path === "displayName" && preserveNameDisplay) continue;
                if (desiredValue !== undefined && stableStringify(currentValue) !== stableStringify(desiredValue)) {
                    update[path] = foundry.utils.deepClone(desiredValue);
                }
            }
            if (activeVariant === "base") {
                const desiredWidth = Number(prototype.width || token.width || 1);
                const desiredHeight = Number(prototype.height || prototype.width || token.height || token.width || 1);
                if (Number(token.width || 1) !== desiredWidth) update.width = desiredWidth;
                if (Number(token.height || 1) !== desiredHeight) update.height = desiredHeight;
                for (const path of ["scaleX", "scaleY", "offsetX", "offsetY", "rotation", "tint", "alphaThreshold"]) {
                    const desiredValue = prototypeTexture[path];
                    if (desiredValue === undefined) continue;
                    if (stableStringify(token.texture?.[path]) !== stableStringify(desiredValue)) {
                        update[`texture.${path}`] = foundry.utils.deepClone(desiredValue);
                    }
                }
                if (resolvedTokenPath) {
                    const current = token.texture?.src || token.img || "";
                    if (String(current || "") !== resolvedTokenPath) update["texture.src"] = resolvedTokenPath;
                }
            }
            if (Object.keys(update).length > 1) updates.push(update);
        }
        if (!updates.length) continue;
        await scene.updateEmbeddedDocuments("Token", updates, {
            criptaWikiSyncCommand: true,
            criptaManagedMediaSync: true
        });
    }
}

async function updatePlacedTokenNames(actor, actorName) {
    const name = String(actorName || "").trim();
    if (!name) return;
    for (const scene of game.scenes || []) {
        const updates = [];
        for (const token of scene.tokens || []) {
            if (String(token.actorId || "") !== String(actor.id || "")) continue;
            if (String(token.name || "") === name) continue;
            updates.push({ _id: token.id, name });
        }
        if (!updates.length) continue;
        await scene.updateEmbeddedDocuments("Token", updates, {
            criptaWikiSyncCommand: true,
            criptaManagedIdentitySync: true
        });
    }
}
async function pullManagedActorCommands(worldId) {
    if (managedActorCommandPullPromise) return managedActorCommandPullPromise;
    managedActorCommandPullPromise = executeManagedActorCommandPull(worldId);
    try {
        return await managedActorCommandPullPromise;
    } finally {
        managedActorCommandPullPromise = null;
    }
}

async function executeManagedActorCommandPull(worldId) {
    const url = new URL(DISCORD_WORKER_URL + "/api/managed-actor-commands/" + encodeURIComponent(worldId));
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url, { headers: buildWorkerAuthHeaders() });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ("Managed Actor commands HTTP " + response.status));
    const commands = Array.isArray(payload?.commands) ? payload.commands : [];
    const createRequests = Array.isArray(payload?.createRequests) ? payload.createRequests : [];
    if (!commands.length && !createRequests.length) return false;

    const acknowledgements = [];
    const createAcknowledgements = [];
    const appliedByActor = new Map();

    const actionableCreateRequests = canPushToWorker() ? createRequests : [];
    if (createRequests.length && !actionableCreateRequests.length) {
        console.info(`${MODULE_ID} | Richieste di creazione NPC lasciate in attesa: la modalita Pull non consente le scritture di profilo necessarie sul Worker.`, {
            count: createRequests.length
        });
    }

    for (const request of actionableCreateRequests) {
        try {
            const result = await applyManagedActorCreateRequest(request);
            reportedManagedActorCreateErrors.delete(String(request.id || ""));
            if (result.status === "applied" && result.actor) {
                await syncManagedActorNow(result.actor, {
                    source: "site-create",
                    reason: "site-create",
                    forceCreate: true,
                    variantsChanged: true,
                    changedTargets: ["avatar", "token"],
                    allowMissingBaseMedia: true
                });
                if (request.profile && typeof request.profile === "object") await applyManagedActorCreateProfile(result.actor, request);
                else await adoptManagedActorLegacyProfile(result.actor, request);
                createAcknowledgements.push({ id: request.id, status: "applied" });
            } else {
                createAcknowledgements.push({ id: request.id, status: result.status, error: result.error || "", current: result.current });
            }
        } catch (error) {
            console.warn(MODULE_ID + " | Creazione NPC dal sito non completata; verra ritentata.", { requestId: request.id, error });
            const requestId = String(request.id || "");
            if (!reportedManagedActorCreateErrors.has(requestId)) {
                reportedManagedActorCreateErrors.add(requestId);
                const message = String(error?.message || error || "Errore sconosciuto");
                ui.notifications.error("Creazione automatica di " + (request.document?.name || "NPC") + " non completata: " + message);
            }
        }
    }

    for (const command of commands) {
        try {
            const result = await applyManagedActorCommand(command);
            if (result.status === "applied" && result.actor) {
                const group = appliedByActor.get(result.actor.id) || { actor: result.actor, commandIds: [] };
                group.commandIds.push(command.id);
                appliedByActor.set(result.actor.id, group);
            } else {
                acknowledgements.push({
                    id: command.id,
                    status: result.status,
                    error: result.error || "",
                    current: result.current,
                    diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : []
                });
            }
        } catch (error) {
            console.warn(MODULE_ID + " | Comando Managed Actor non applicato; verra ritentato.", { commandId: command.id, error });
        }
    }

    for (const group of appliedByActor.values()) {
        const pullCommandReconciliation = !canPushToWorker();
        try {
            const synchronized = await syncManagedActorNow(group.actor, { source: "site-command", forceContentSync: true, pullCommandReconciliation });
            if (!synchronized) continue;
            acknowledgements.push(...group.commandIds.map((id) => ({ id, status: "applied" })));
        } catch (error) {
            if (error?.code === "VERSION_CONFLICT") {
                try {
                    await realignManagedActorAfterConflict(group.actor, error.currentRevision);
                    const synchronized = await syncManagedActorNow(group.actor, {
                        source: "site-command-retry",
                        forceContentSync: true,
                        pullCommandReconciliation
                    });
                    if (!synchronized) continue;
                    acknowledgements.push(...group.commandIds.map((id) => ({ id, status: "applied" })));
                    continue;
                } catch (retryError) {
                    console.warn(MODULE_ID + " | Riallineamento del comando Managed Actor non completato; verra ritentato.", { actor: group.actor.name, error: retryError });
                    continue;
                }
            }
            console.warn(MODULE_ID + " | Actor modificato ma non ancora confermato al Worker; verra ritentato.", { actor: group.actor.name, error });
        }
    }

    if (acknowledgements.length || createAcknowledgements.length) {
        await acknowledgeManagedActorCommands(worldId, acknowledgements, createAcknowledgements);
    }
    return [...acknowledgements, ...createAcknowledgements].some((entry) => entry.status === "applied");
}

function managedActorCreateImageSource(value, fallback = "icons/svg/mystery-man.svg") {
    const clean = String(value || "").trim();
    if (!clean) return fallback;
    if (/^https?:/i.test(clean)) return clean;
    if (clean.startsWith("media/")) return toWorkerMediaUrl(clean);
    if (["icons/", "systems/", "modules/", "worlds/"].some((prefix) => clean.startsWith(prefix))) return clean;
    return fallback;
}

function buildManagedActorBaseNpcSystem(source = {}) {
    const input = source && typeof source === "object" ? source : {};
    const hpMax = Math.max(1, Math.floor(Number(input.attributes?.hp?.max) || 1));
    const hpValue = Math.max(0, Math.min(hpMax, Math.floor(Number(input.attributes?.hp?.value ?? hpMax) || hpMax)));
    const ac = Math.max(0, Math.floor(Number(input.attributes?.ac?.flat) || 10));
    const speed = Math.max(0, Math.floor(Number(input.attributes?.movement?.walk) || 30));
    const size = ["tiny", "sm", "med", "lg", "huge", "grg"].includes(String(input.traits?.size || "med")) ? String(input.traits.size) : "med";
    return {
        abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map((ability) => [ability, { value: 10, proficient: 0 }])),
        attributes: {
            hp: { value: hpValue, max: hpMax, temp: 0, tempmax: 0 },
            ac: { calc: "flat", flat: ac },
            movement: { walk: speed, units: "ft", hover: false }
        },
        details: { cr: input.details?.cr ?? 0 },
        traits: { size }
    };
}

async function ensureManagedActorCreateFolder(folderName) {
    const name = String(folderName || "Cripta Wiki NPC").trim().slice(0, 100) || "Cripta Wiki NPC";
    const existing = Array.from(game.folders || []).find((folder) => folder.type === "Actor" && folder.name === name);
    if (existing) return existing;
    return Folder.create({ name, type: "Actor", sorting: "a" }, { render: false });
}

async function applyManagedActorCreateRequest(request) {
    if (String(request?.kind || "") !== "actor.create") return { status: "failed", error: "Tipo di richiesta non supportato" };
    const requestId = String(request?.id || "").trim();
    const legacyCharacterId = sanitizeId(request?.legacyCharacterId || "");
    const actors = Array.from(game.actors || []).filter(actor => !isTemporaryWikiActor(actor));
    let actor = actors.find((entry) => String(entry.getFlag?.(MODULE_ID, "siteCreateRequestId") || "") === requestId);
    if (!actor && legacyCharacterId) {
        actor = actors.find((entry) => sanitizeId(entry.getFlag?.(MODULE_ID, "legacyCharacterId") || "") === legacyCharacterId);
    }
    if (actor) return { status: "applied", actor, created: false };

    const document = request.document && typeof request.document === "object" ? request.document : {};
    const requestedProfile = request.profile && typeof request.profile === "object" ? request.profile : {};
    const actorLink = String(requestedProfile.kind || "person").trim().toLowerCase() !== "creature";
    const name = String(document.name || "Nuovo NPC").trim().slice(0, 180) || "Nuovo NPC";
    const sameName = actors.filter((entry) => String(entry.name || "").trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (sameName.length) {
        return {
            status: "conflict",
            error: "Esiste gia un Actor chiamato " + name + "; collegamento automatico bloccato per evitare duplicati.",
            current: { actorIds: sameName.map((entry) => entry.id) }
        };
    }

    const folder = await ensureManagedActorCreateFolder(document.folderName);
    const avatar = managedActorCreateImageSource(document.media?.avatar);
    const token = managedActorCreateImageSource(document.media?.token, avatar);
    actor = await Actor.create({
        name,
        type: "npc",
        folder: folder?.id || null,
        img: avatar,
        system: buildManagedActorBaseNpcSystem(document.system),
        prototypeToken: {
            name,
            actorLink,
            texture: { src: token }
        },
        flags: {
            [MODULE_ID]: {
                siteCreateRequestId: requestId,
                legacyCharacterId,
                siteCreatedAt: new Date().toISOString()
            }
        }
    }, { renderSheet: false, criptaWikiSyncCommand: true });
    return { status: "applied", actor, created: true };
}

async function applyManagedActorCreateProfile(actor, request) {
    const profile = request?.profile && typeof request.profile === "object" ? request.profile : null;
    if (!profile) return false;
    const identity = getManagedActorIdentity(actor);
    if (!identity) throw new Error("Identita Managed Actor non valida dopo la creazione.");
    const profileUrl = new URL(DISCORD_WORKER_URL + "/api/managed-actors/" + encodeURIComponent(identity.worldId) + "/" + encodeURIComponent(identity.actorId) + "/profile");
    profileUrl.searchParams.set("campaign", getCampaignId());
    const currentResponse = await policyFetch(profileUrl, { headers: buildWorkerAuthHeaders() });
    const currentPayload = await currentResponse.json().catch(() => null);
    if (!currentResponse.ok || !currentPayload?.data) throw new Error(currentPayload?.error || ("Managed Actor profile HTTP " + currentResponse.status));
    const saveResponse = await policyFetch(profileUrl, {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(true), "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: Number(currentPayload.data.revision || 0), data: { ...profile, name: actor.name } })
    });
    const savePayload = await saveResponse.json().catch(() => null);
    if (!saveResponse.ok || savePayload?.ok === false) throw new Error(savePayload?.error || ("Managed Actor profile save HTTP " + saveResponse.status));
    return true;
}

async function adoptManagedActorLegacyProfile(actor, request) {
    const legacyCharacterId = sanitizeId(request?.legacyCharacterId || "");
    if (!legacyCharacterId) return false;
    const identity = getManagedActorIdentity(actor);
    if (!identity) throw new Error("Identita Managed Actor non valida dopo la creazione.");

    const detailUrl = new URL(DISCORD_WORKER_URL + "/api/managed-actors/" + encodeURIComponent(identity.worldId) + "/" + encodeURIComponent(identity.actorId));
    detailUrl.searchParams.set("campaign", getCampaignId());
    const detailResponse = await policyFetch(detailUrl, { headers: buildWorkerAuthHeaders() });
    const detailPayload = await detailResponse.json().catch(() => null);
    if (!detailResponse.ok || !detailPayload?.data) {
        throw new Error(detailPayload?.error || ("Managed Actor detail HTTP " + detailResponse.status));
    }

    const adoptUrl = new URL(detailUrl.toString().split("?")[0] + "/adopt-legacy");
    adoptUrl.searchParams.set("campaign", getCampaignId());
    const adoptResponse = await policyFetch(adoptUrl, {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(true), "Content-Type": "application/json" },
        body: JSON.stringify({
            campaignId: getCampaignId(),
            expectedRevision: Number(detailPayload.data.revision || 0),
            legacyCharacterId
        })
    });
    const adoptPayload = await adoptResponse.json().catch(() => null);
    if (!adoptResponse.ok || adoptPayload?.ok === false) {
        throw new Error(adoptPayload?.error || ("Managed Actor legacy adoption HTTP " + adoptResponse.status));
    }
    return true;
}

function unsetManagedActorLinkPath(target, path) {
    if (!target || typeof target !== "object") return false;
    const parts = String(path || "").split(".").filter(Boolean);
    if (!parts.length) return false;
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
        if (!cursor || typeof cursor !== "object" || !(part in cursor)) return false;
        cursor = cursor[part];
    }
    if (!cursor || typeof cursor !== "object") return false;
    return delete cursor[parts.at(-1)];
}
const MANAGED_ACTOR_LINK_UNORDERED_SEMANTIC_KEYS = new Set(["properties", "types", "statuses", "bypasses", "effects"]);


function managedActorLinkSchemaCleanDocumentSource(document, source) {
    const DocumentClass = document?.constructor;
    if (!DocumentClass || DocumentClass === Object) return foundry.utils.deepClone(source || {});
    let candidate = foundry.utils.deepClone(source || {});
    try {
        if (typeof DocumentClass.migrateDataSafe === "function") {
            const migrated = DocumentClass.migrateDataSafe(foundry.utils.deepClone(candidate));
            if (migrated && typeof migrated === "object") candidate = migrated;
        }
        if (typeof DocumentClass.cleanData === "function") {
            const cleaned = DocumentClass.cleanData(foundry.utils.deepClone(candidate), { partial: false });
            if (cleaned && typeof cleaned === "object") candidate = cleaned;
        }
    } catch (error) {
        // Never mutate the live document to normalize a candidate. If a module
        // supplies a custom DataModel which cannot clean out of context, the
        // database update will still validate it and the transaction can roll
        // back safely.
        console.debug(`${MODULE_ID} | Normalizzazione DataModel non disponibile; uso la sorgente effettiva.`, {
            document: document?.name || document?.id || document?.documentName || "Document",
            error: String(error?.message || error)
        });
    }
    return foundry.utils.deepClone(candidate);
}

function managedActorLinkActivitiesSourceMap(value) {
    let entries;
    if (Array.isArray(value)) entries = value.map((activity, index) => [activity?._id || activity?.id || String(index), activity]);
    else if (value && typeof value.get === "function" && typeof value.values === "function") {
        entries = Array.from(value.values()).map((activity, index) => [activity?._id || activity?.id || String(index), activity]);
    } else if (value && typeof value === "object") entries = Object.entries(value);
    else entries = [];
    return Object.fromEntries(entries.map(([key, activity]) => {
        // Use stored Activity data: prepared attacks can inject the base damage
        // into damage.parts, where persisting it would duplicate that damage.
        const source = activity?.toObject?.(true) || activity?._source || activity || {};
        const id = String(source?._id || activity?._id || activity?.id || key);
        return [id, foundry.utils.deepClone({ ...source, _id: id })];
    }));
}

function managedActorLinkDocumentSource(document) {
    let source = null;
    try {
        // `source=true` is essential for synthetic Token Actors. Foundry builds
        // their source by applying ActorDelta to the base Actor, so this keeps
        // every persisted override selected by the user without also copying
        // values injected later by D&D5e preparation or Active Effects.
        source = document?.toObject?.(true);
    } catch (_) {
        source = null;
    }
    if (!source || typeof source !== "object") source = document?._source || document || {};
    source = foundry.utils.deepClone(source);

    let persistentActivities = null;
    // ActivitiesField is stored as a mapping. Keep that persistent shape even
    // when an older snapshot or a third-party DataModel exposes it as an array.
    try {
        const activities = source?.system?.activities;
        const storedActivities = activities === undefined ? {} : managedActorLinkActivitiesSourceMap(activities);
        // Synthetic Token Items can serialize a partial inherited branch even
        // while their live Activity documents contain the complete authoritative
        // state. Each live Activity is still read with source=true, so this copies
        // persisted attacks, damage and saves without prepared/derived values.
        const liveActivities = managedActorLinkActivitiesSourceMap(document?.system?.activities);
        persistentActivities = Object.keys(liveActivities).length ? liveActivities : storedActivities;
        if (activities !== undefined || Object.keys(persistentActivities).length) {
            source.system ??= {};
            source.system.activities = persistentActivities;
        }
    } catch (_) {
        // The complete persistent source remains the safe fallback.
    }
    const cleaned = managedActorLinkSchemaCleanDocumentSource(document, source);
    // Some D&D5e/third-party Item DataModels clean an out-of-context synthetic
    // source by dropping ActivitiesField. The live source above is already in
    // the current schema, so restore that exact branch after generic cleaning.
    if (persistentActivities && Object.keys(persistentActivities).length) {
        cleaned.system ??= {};
        cleaned.system.activities = foundry.utils.deepClone(persistentActivities);
    }
    return cleaned;
}
function managedActorLinkNativeActorSource(actor) {
    let source = null;
    try {
        // Match Foundry's native JSON export source. In particular, keep
        // `_stats`: ClientDocument.fromImport uses it to run the correct core
        // and system migrations before validating the complete Actor.
        source = actor?.toJSON?.();
    } catch (_) {
        source = null;
    }
    if (!source || typeof source !== "object") {
        try {
            source = actor?.toObject?.(true);
        } catch (_) {
            source = null;
        }
    }
    if (!source || typeof source !== "object") source = actor?._source || actor || {};
    return foundry.utils.deepClone(source);
}

async function importManagedActorLinkActorDocument(actor, source) {
    if (!actor || !source || typeof source !== "object") {
        throw new Error("Sorgente Actor completa non disponibile");
    }
    const DocumentClass = actor.constructor;
    const collection = actor.collection;
    // Use Foundry's complete native import workflow, validating before the
    // first write. importFromJSON itself enables dropInvalidEmbedded, which
    // can silently omit Items/Effects, and exposes no pre-write expected data.
    if (typeof DocumentClass?.fromImport === "function" && typeof collection?.fromCompendium === "function") {
        const imported = await DocumentClass.fromImport(foundry.utils.deepClone(source), { strict: true, dropInvalidEmbedded: false });
        const data = collection.fromCompendium(imported);
        const preserved = Object.fromEntries((DocumentClass.metadata?.preserveOnImport || []).map((path) => (
            [path, foundry.utils.getProperty(actor, path)]
        )));
        preserved.folder = actor.folder?.id ?? null;
        foundry.utils.mergeObject(data, preserved);
        // Keep the normalized request independent of data passed to update:
        // hooks/backend processing may mutate that payload or ignore fields.
        const expectedSource = foundry.utils.deepClone(data);
        const actorId = String(actor.id || "");
        managedActorLinkNativeImports.add(actorId);
        try {
            await actor.update(data, {
                diff: false,
                recursive: false,
                noHook: true,
                render: false,
                criptaWikiSyncCommand: true
            });
        } finally {
            managedActorLinkNativeImports.delete(actorId);
        }
        return { actor, expectedSource };
    }

    throw new Error("Questa versione di Foundry non supporta l'importazione completa degli Actor");
}

const MANAGED_ACTOR_LINK_NATIVE_IGNORED_ROOT_KEYS = new Set([
    "prototypeToken", "folder", "sort", "ownership"
]);

function managedActorLinkNativeDocumentComparable(value, path = []) {
    if (value?.toObject && typeof value.toObject === "function") value = value.toObject();
    if (value instanceof Set) {
        return Array.from(value)
            .map((entry) => managedActorLinkNativeDocumentComparable(entry, [...path, "*"]))
            .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
    }
    if (value instanceof Map) value = Object.fromEntries(value.entries());
    if (Array.isArray(value)) {
        const entries = value
            .map((entry) => managedActorLinkNativeDocumentComparable(entry, [...path, "*"]))
            .filter((entry) => entry !== undefined);
        const collection = String(path.at(-1) || "");
        if (collection === "items" || collection === "effects") {
            entries.sort((left, right) => {
                const leftKey = `${String(left?._id || "")}:${String(left?.name || "")}`;
                const rightKey = `${String(right?._id || "")}:${String(right?.name || "")}`;
                return leftKey.localeCompare(rightKey);
            });
        }
        return entries;
    }
    if (!value || typeof value !== "object") return value;
    // fromCompendium removes embedded ownership, then Item's ownership field
    // restores {default: NONE} during persistence. Compare those equivalent
    // defaults only on embedded Items, preserving every explicit user grant
    // and every other field (including module/system fields named ownership).
    const embeddedItem = path.length === 2 && path[0] === "items" && path[1] === "*";
    const ownership = value.ownership;
    const defaultItemOwnership = embeddedItem && ownership
        && Object.prototype.toString.call(ownership) === "[object Object]"
        && Object.keys(ownership).every((key) => key === "default" && ownership[key] === 0);
    return Object.fromEntries(Object.entries(value)
        .filter(([key, entry]) => entry !== undefined
            && key !== "_stats"
            && !(key === "ownership" && defaultItemOwnership)
            && !(path.length === 0 && MANAGED_ACTOR_LINK_NATIVE_IGNORED_ROOT_KEYS.has(key)))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, managedActorLinkNativeDocumentComparable(entry, [...path, key])])
        .filter(([, entry]) => entry !== undefined));
}

function verifyManagedActorLinkNativeDocument(actor, expectedSource) {
    const expected = managedActorLinkNativeDocumentComparable(expectedSource || {});
    const actual = managedActorLinkNativeDocumentComparable(managedActorLinkNativeActorSource(actor));
    const paths = managedActorLinkCanonicalDifferencePaths(expected, actual, Number.POSITIVE_INFINITY);
    return {
        ok: paths.length === 0,
        expected,
        actual,
        summary: paths.slice(0, 8).map((path) => managedActorLinkCanonicalDifferenceLabel(path, expected, actual))
    };
}


function managedActorLinkSemanticValue(value, path = []) {
    const cleanPath = path.join(".");
    const leaf = String(path.at(-1) || "");
    const insideEffect = path.includes("effects");
    if (cleanPath === "system.source") return undefined;
    if (/^system\.activities\.\*\.(?:_id|id|sort)$/.test(cleanPath)) return undefined;
    // Foundry rebuilds bookkeeping fields whenever an Active Effect is moved
    // between an unlinked Token Actor and its prototype. They do not change
    // the effect's mechanics and therefore must not invalidate the copy.
    if (leaf === "_stats") return undefined;
    if (insideEffect && ["_id", "id", "origin", "sort"].includes(leaf)) return undefined;
    if (value === undefined || value === null || value === "") return undefined;
    if (value === false && ["override", "enabled", "disabled", "transfer"].includes(leaf)) return undefined;
    if (insideEffect && value === 0 && ["startTime", "startRound", "startTurn"].includes(leaf)) return undefined;
    if (value === 0 && leaf === "value" && ["range", "target"].includes(String(path.at(-2) || ""))) return undefined;
    if (value instanceof Set) {
        return Array.from(value)
            .map((entry) => managedActorLinkSemanticValue(entry, [...path, "*"]))
            .filter((entry) => entry !== undefined)
            .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
    }
    if (value instanceof Map) {
        value = Object.fromEntries(value.entries());
    } else if (value?.toObject && typeof value.toObject === "function") {
        value = value.toObject(false);
    }
    if (Array.isArray(value)) {
        const entries = value
            .map((entry) => managedActorLinkSemanticValue(entry, [...path, "*"]))
            .filter((entry) => entry !== undefined);
        if (MANAGED_ACTOR_LINK_UNORDERED_SEMANTIC_KEYS.has(String(path.at(-1) || ""))) {
            entries.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
        }
        return entries.length ? entries : undefined;
    }
    if (typeof value === "string") {
        const clean = value.trim();
        if (!clean) return undefined;
        if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) {
            const number = Number(clean);
            if (Number.isFinite(number)) return number;
        }
        return clean;
    }
    if (["number", "boolean"].includes(typeof value)) return value;
    if (!value || typeof value !== "object") return undefined;
    if (cleanPath === "system.activities") {
        const activities = Object.values(value)
            .map((entry) => managedActorLinkSemanticValue(entry, [...path, "*"]))
            .filter((entry) => entry !== undefined)
            .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
        return activities.length
            ? Object.fromEntries(activities.map((entry, index) => [`activity-${index + 1}`, entry]))
            : undefined;
    }
    const normalized = Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, managedActorLinkSemanticValue(entry, [...path, key])])
        .filter(([, entry]) => entry !== undefined));
    return Object.keys(normalized).length ? normalized : undefined;
}


function managedActorLinkGeneratedItemIdentifier(name) {
    const label = String(name || "").trim();
    if (!label) return "";
    try {
        const generated = foundry.utils.slugify?.(label, { strict: true });
        if (generated) return String(generated).trim().toLowerCase();
    } catch (_) {
        // Use the deterministic fallback below in tests and older Foundry builds.
    }
    return label.normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/['?]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function managedActorLinkLogicalItemIdentifier(item) {
    const explicit = String(item?.system?.identifier || "").trim().toLowerCase();
    if (explicit) return explicit;
    return managedActorLinkGeneratedItemIdentifier(item?.name);
}
function managedActorLinkItemDefinitionSource(item) {
    const source = managedActorLinkDocumentSource(item);
    if (item?.type === "spell" && source.system) {
        const { method } = readSpellPreparation(source.system);
        if (method !== undefined) source.system.method = method;
        delete source.system.preparation;
    }
    delete source._id;
    delete source.img;
    delete source._stats;
    delete source.folder;
    delete source.sort;
    delete source.ownership;
    if (source.flags) {
        delete source.flags[MODULE_ID];
        delete source.flags[TOKENIZER_MODULE_ID];
    }
    unsetManagedActorLinkPath(source, "flags.core.sourceId");
    for (const namespace of ["core"]) {
        if (source.flags?.[namespace] && !Object.keys(source.flags[namespace]).length) delete source.flags[namespace];
    }
    if (source.flags && !Object.keys(source.flags).length) delete source.flags;
    const identifier = String(source?.system?.identifier || "").trim().toLowerCase();
    const generatedIdentifier = managedActorLinkGeneratedItemIdentifier(source?.name);
    if (identifier && generatedIdentifier && identifier === generatedIdentifier) {
        unsetManagedActorLinkPath(source, "system.identifier");
    }
    for (const path of [
        "system.quantity", "system.equipped", "system.attuned",
        "system.uses.value", "system.uses.spent", "system.prepared", "system.preparation.prepared"
    ]) unsetManagedActorLinkPath(source, path);
    return managedActorLinkSemanticValue(source) || {};
}

function managedActorLinkItemDefinitionSignature(item) {
    return hashValue(managedActorLinkItemDefinitionSource(item));
}
function managedActorLinkItemState(actor) {
    return Array.from(actor?.items || []).map((item) => {
        const system = item?.system || {};
        const uses = system.uses || {};
        // D&D5e 4+ stores uses.spent and prepares uses.value as max - spent.
        // Keep value only for legacy schemas which do not expose spent.
        const storedUses = uses.spent !== undefined && uses.spent !== null;
        return {
            id: String(item?.id || ""),
            transferId: String(getItemTransferId(item) || ""),
            logicalIdentifier: managedActorLinkLogicalItemIdentifier(item),
            name: String(item?.name || "Elemento"),
            type: String(item?.type || "item"),
            quantity: system.quantity ?? system.qty ?? system.amount,
            equipped: system.equipped,
            attuned: system.attuned,
            uses: { value: storedUses ? undefined : uses.value, spent: uses.spent },
            prepared: item.type === "spell" ? readSpellPreparation(system).prepared : undefined,
            definitionHash: managedActorLinkItemDefinitionSignature(item)
        };
    }).sort((left, right) => `${left.transferId}:${left.id}`.localeCompare(`${right.transferId}:${right.id}`));
}

function managedActorLinkPairRecords(baseEntries, sourceEntries, selectors) {
    const base = Array.from(baseEntries || []);
    const source = Array.from(sourceEntries || []);
    const remainingBase = new Set(base.map((_, index) => index));
    const remainingSource = new Set(source.map((_, index) => index));
    const pairs = [];
    for (const selector of selectors) {
        const buckets = new Map();
        for (const baseIndex of remainingBase) {
            const key = selector(base[baseIndex]);
            if (!key) continue;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(baseIndex);
        }
        for (const sourceIndex of Array.from(remainingSource)) {
            const key = selector(source[sourceIndex]);
            const matches = key ? buckets.get(key) : null;
            if (!matches?.length) continue;
            const baseIndex = matches.shift();
            remainingBase.delete(baseIndex);
            remainingSource.delete(sourceIndex);
            pairs.push({ base: base[baseIndex], source: source[sourceIndex] });
        }
    }
    return {
        pairs,
        baseOnly: Array.from(remainingBase, (index) => base[index]),
        sourceOnly: Array.from(remainingSource, (index) => source[index])
    };
}

function managedActorLinkItemIdentity(entry) {
    return `${String(entry?.type || "").trim().toLowerCase()}:${String(entry?.name || "").trim().toLowerCase()}`;
}

function managedActorLinkPairItemStates(baseEntries, sourceEntries) {
    return managedActorLinkPairRecords(baseEntries, sourceEntries, [
        (entry) => entry.transferId ? `transfer:${entry.transferId}` : "",
        (entry) => entry.id ? `id:${entry.id}` : "",
        // D&D5e permits an empty identifier and derives it from the Item name.
        // Match that representation with the same explicit identifier before
        // falling back to name/definition, so renaming `Slam (Copy)` to `Slam`
        // replaces the original Item instead of creating a second document.
        (entry) => entry.logicalIdentifier
            ? `identifier:${String(entry.type || "").trim().toLowerCase()}:${entry.logicalIdentifier}`
            : "",
        (entry) => {
            const identity = managedActorLinkItemIdentity(entry);
            return identity && entry.definitionHash ? `definition:${identity}:${entry.definitionHash}` : "";
        },
        (entry) => {
            const identity = managedActorLinkItemIdentity(entry);
            return identity ? `identity:${identity}` : "";
        }
    ]);
}
function managedActorLinkEffectChanges(effect, source = managedActorLinkDocumentSource(effect)) {
    if (Array.isArray(source?.system?.changes)) return source.system.changes;
    if (Array.isArray(effect?.system?.changes)) return effect.system.changes;
    if (Array.isArray(source?.changes)) return source.changes;
    if (Array.isArray(effect?.changes)) return effect.changes;
    return [];
}
function managedActorLinkEffectSemanticState(effect) {
    const source = managedActorLinkDocumentSource(effect);
    delete source._id;
    delete source._stats;
    delete source.origin;
    return managedActorLinkSemanticValue({
        name: String(effect?.name || source.name || ""),
        disabled: effect?.disabled === true || source.disabled === true,
        transfer: effect?.transfer === true || source.transfer === true,
        changes: managedActorLinkEffectChanges(effect, source),
        statuses: Array.from(effect?.statuses || source.statuses || []),
        duration: source.duration || effect?.duration || {},
        flags: source.flags || effect?.flags || {},
        system: source.system || effect?.system || {},
        description: source.description || effect?.description || ""
    }, ["effects", "*"]) || {};
}

function managedActorLinkStructureSignature(actor) {
    return hashValue({
        items: managedActorLinkItemState(actor).map((item) => ({
            name: item.name,
            type: item.type,
            definitionHash: item.definitionHash
        })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
        effects: Array.from(actor?.effects || []).map(managedActorLinkEffectSemanticState).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
    });
}
function managedActorLinkDifferenceValue(value) {
    if (value === undefined || value === null || value === "") return "\u2014";
    if (typeof value === "boolean") return value ? "Si" : "No";
    if (["string", "number"].includes(typeof value)) return String(value).slice(0, 120);
    const semantic = managedActorLinkSemanticValue(value, ["difference"]);
    const serialized = stableStringify(semantic);
    return serialized ? serialized.slice(0, 120) : "\u2014";
}

const MANAGED_ACTOR_LINK_DAMAGE_TYPE_LABELS = Object.freeze({
    acid: "acido",
    bludgeoning: "contundente",
    cold: "freddo",
    fire: "fuoco",
    force: "forza",
    genie: "geniale",
    lightning: "fulmine",
    necrotic: "necrotico",
    piercing: "perforante",
    poison: "veleno",
    psychic: "psichico",
    radiant: "radiante",
    slashing: "tagliente",
    thunder: "tuono",
    healing: "cura",
    temphp: "PF temporanei"
});

function managedActorLinkDifferenceCollection(value) {
    if (value === undefined || value === null || value === "") return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set || value instanceof Map) return Array.from(value.values());
    if (typeof value === "object") return Object.values(value);
    return [value];
}

function managedActorLinkDamageDifferencePart(part) {
    if (Array.isArray(part)) {
        const formula = String(part[0] || "").trim();
        const types = managedActorLinkDifferenceCollection(part[1]).map(String).filter(Boolean);
        return formula ? `${formula}${types.length ? ` (${types.map((type) => MANAGED_ACTOR_LINK_DAMAGE_TYPE_LABELS[type] || type).join("/")})` : ""}` : "";
    }
    if (!part || typeof part !== "object") return "";
    const customFormula = part.custom?.enabled ? String(part.custom?.formula || "").trim() : "";
    const number = Number(part.number ?? part.dice?.number ?? 0);
    const denomination = Number(part.denomination ?? part.dice?.denomination ?? 0);
    const bonus = String(part.bonus ?? "").trim();
    let formula = customFormula || String(part.formula || "").trim();
    if (!formula) {
        const dice = number > 0 && denomination > 0 ? `${number}d${denomination}` : "";
        formula = dice && bonus ? `${dice}${bonus.startsWith("-") ? " " : " + "}${bonus}` : (dice || bonus);
    }
    if (!formula) return "";
    const types = managedActorLinkDifferenceCollection(part.types ?? part.type)
        .map((type) => MANAGED_ACTOR_LINK_DAMAGE_TYPE_LABELS[String(type)] || String(type))
        .filter(Boolean);
    const scaling = part.scaling && typeof part.scaling === "object" ? part.scaling : {};
    let scalingText = "";
    if (scaling.mode) {
        const scalingNumber = Number(scaling.number || 0);
        const scalingFormula = String(scaling.formula || "").trim();
        const increment = scalingFormula || (scalingNumber > 0 && denomination > 0 ? `${scalingNumber}d${denomination}` : "");
        if (increment) {
            const modeLabel = ({ whole: "per livello", half: "ogni 2 livelli" })[scaling.mode] || String(scaling.mode);
            scalingText = `; +${increment} ${modeLabel}`;
        }
    }
    return `${formula}${types.length ? ` (${types.join("/")})` : ""}${scalingText}`;
}

function managedActorLinkReadableDamageDifference(value) {
    if (!value || typeof value !== "object") return managedActorLinkDifferenceValue(value);
    const parts = managedActorLinkDifferenceCollection(value.parts ?? value.base ?? (Array.isArray(value) ? value : []))
        .map(managedActorLinkDamageDifferencePart)
        .filter(Boolean);
    const entries = [];
    if (value.includeBase === true) entries.push("danno base incluso");
    else if (value.includeBase === false) entries.push("senza danno base");
    entries.push(...parts);
    const criticalBonus = String(value.critical?.bonus || "").trim();
    if (criticalBonus) entries.push(`critico +${criticalBonus}`);
    return entries.length ? entries.join(" + ").slice(0, 180) : managedActorLinkDifferenceValue(value);
}

function managedActorLinkReadableObjectDifference(value) {
    const labels = {
        ability: "abilita", bonus: "bonus", value: "valore", type: "tipo", classification: "categoria",
        cost: "costo", units: "unita", count: "quantita", formula: "formula", mode: "modalita",
        threshold: "soglia", condition: "condizione", target: "bersaglio", scaling: "scala"
    };
    const entries = [];
    const visit = (entry, key = "", depth = 0) => {
        if (entries.length >= 6 || entry === undefined || entry === null || entry === "") return;
        if (["string", "number", "boolean"].includes(typeof entry)) {
            const label = labels[key] || key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
            const display = typeof entry === "boolean" ? (entry ? "si" : "no") : String(entry);
            if (label) entries.push(`${label}: ${display}`);
            else entries.push(display);
            return;
        }
        if (Array.isArray(entry) || entry instanceof Set) {
            const values = Array.from(entry).filter((item) => ["string", "number", "boolean"].includes(typeof item));
            if (values.length) visit(values.join(", "), key, depth + 1);
            else Array.from(entry).forEach((item) => visit(item, key, depth + 1));
            return;
        }
        if (typeof entry !== "object" || depth > 3) return;
        Object.entries(entry).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
    };
    visit(value);
    return entries.join(" \u00B7 ").slice(0, 180);
}

function managedActorLinkReadableItemDifferenceValue(path, value) {
    if (value === undefined || value === null || value === "" || typeof value !== "object") {
        return managedActorLinkDifferenceValue(value);
    }
    if (/\.damage(\.|$)/.test(String(path || ""))) return managedActorLinkReadableDamageDifference(value);
    return managedActorLinkReadableObjectDifference(value) || managedActorLinkDifferenceValue(value);
}
function managedActorLinkDefinitionDifferenceLabel(path) {
    const clean = String(path || "");
    if (clean === "name") return "Nome";
    if (clean === "type") return "Tipo";
    if (clean.includes(".activities.")) {
        if (clean.includes(".damage")) return "Danni attivita";
        if (clean.includes(".attack")) return "Tiro per colpire";
        if (clean.includes(".save")) return "Tiro salvezza / CD";
        if (clean.includes(".range")) return "Gittata attivita";
        if (clean.includes(".target")) return "Bersaglio attivita";
        if (clean.includes(".activation")) return "Attivazione";
        if (clean.includes(".consumption")) return "Consumo attivita";
        if (clean.endsWith(".name")) return "Nome attivita";
        return "Configurazione attivita";
    }
    const labels = [
        [/description\.value$/, "Descrizione"],
        [/\.damage(\.|$)/, "Danni"],
        [/\.range(\.|$)/, "Gittata"],
        [/\.target(\.|$)/, "Bersaglio"],
        [/\.activation(\.|$)/, "Attivazione"],
        [/\.properties(\.|$)/, "Proprieta"],
        [/\.uses(\.|$)/, "Utilizzi"],
        [/^effects(\.|$)/, "Effetti incorporati"],
        [/^flags(\.|$)/, "Flag meccanici"]
    ];
    const known = labels.find(([pattern]) => pattern.test(clean));
    if (known) return known[1];
    return clean.replace(/^system\./, "").replace(/\.[A-Za-z0-9_-]{12,}(?=\.|$)/g, "").replace(/\./g, " \u00B7 ").slice(0, 80) || "Definizione";
}

function managedActorLinkDefinitionStopPath(path, before, after) {
    if (Array.isArray(before) || Array.isArray(after)) return true;
    if (before === null || after === null || typeof before !== "object" || typeof after !== "object") return true;
    return /system\.description\.value$/.test(path)
        || /system\.activities\.[^.]+\.(damage|attack|save|range|target|activation|consumption)(\.|$)/.test(path)
        || /^effects(\.|$)/.test(path)
        || /^flags(\.|$)/.test(path);
}

function managedActorLinkItemDefinitionDifferences(baseItem, sourceItem) {
    const base = managedActorLinkItemDefinitionSource(baseItem);
    const source = managedActorLinkItemDefinitionSource(sourceItem);
    const differences = [];
    const visit = (before, after, path = "") => {
        if (differences.length >= 8 || stableStringify(before) === stableStringify(after)) return;
        if (managedActorLinkDefinitionStopPath(path, before, after)) {
            differences.push({
                label: managedActorLinkDefinitionDifferenceLabel(path),
                before: managedActorLinkReadableItemDifferenceValue(path, before),
                after: managedActorLinkReadableItemDifferenceValue(path, after)
            });
            return;
        }
        const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
        if (!keys.length) {
            differences.push({
                label: managedActorLinkDefinitionDifferenceLabel(path),
                before: managedActorLinkReadableItemDifferenceValue(path, before),
                after: managedActorLinkReadableItemDifferenceValue(path, after)
            });
            return;
        }
        for (const key of keys) visit(before?.[key], after?.[key], path ? `${path}.${key}` : key);
    };
    visit(base, source);
    return differences.slice(0, 8);
}
function managedActorLinkItemStateValueEqual(path, left, right) {
    if (path === "prepared") return (normalizePreparedState(left) ?? 0) === (normalizePreparedState(right) ?? 0);
    if (stableStringify(left) === stableStringify(right)) return true;
    const empty = (value) => value === undefined || value === null || value === "";
    if (["uses.value", "uses.spent"].includes(path)) {
        if ((empty(left) && Number(right) === 0) || (empty(right) && Number(left) === 0)) return true;
    }
    if (["equipped", "attuned", "prepared"].includes(path)) {
        if ((empty(left) && right === false) || (empty(right) && left === false)) return true;
    }
    return false;
}

function managedActorLinkItemStateDifferences(baseActor, sourceActor) {
    const baseStates = managedActorLinkItemState(baseActor);
    const sourceStates = managedActorLinkItemState(sourceActor);
    const matched = managedActorLinkPairItemStates(baseStates, sourceStates);
    const baseDocuments = new Map(Array.from(baseActor?.items || []).map((item) => [String(item.id || ""), item]));
    const sourceDocuments = new Map(Array.from(sourceActor?.items || []).map((item) => [String(item.id || ""), item]));
    const fields = [
        ["quantity", "Quantita"],
        ["equipped", "Equipaggiato"],
        ["attuned", "Sintonia"],
        ["uses.value", "Utilizzi"],
        ["uses.spent", "Utilizzi spesi"],
        ["prepared", "Preparato"]
    ];
    const read = (entry, path) => path.split(".").reduce((value, key) => value?.[key], entry);
    const differences = matched.pairs.flatMap(({ base: previous, source: current }) => {
        const changes = fields.flatMap(([path, label]) => {
            const before = read(previous, path);
            const after = read(current, path);
            return managedActorLinkItemStateValueEqual(path, before, after)
                ? []
                : [{ label, before: managedActorLinkDifferenceValue(before), after: managedActorLinkDifferenceValue(after) }];
        });
        const definitionChanged = previous.name !== current.name || previous.type !== current.type || previous.definitionHash !== current.definitionHash;
        if (definitionChanged) {
            const detailed = managedActorLinkItemDefinitionDifferences(
                baseDocuments.get(previous.id),
                sourceDocuments.get(current.id)
            );
            changes.unshift(...(detailed.length ? detailed : [{
                label: "Definizione tecnica",
                before: `${previous.type}: ${previous.name}`.slice(0, 120),
                after: `${current.type}: ${current.name}`.slice(0, 120)
            }]));
        }
        return changes.length ? [{
            name: String(current.name || previous.name || "Elemento"),
            type: String(current.type || previous.type || "item"),
            kind: "changed",
            structural: definitionChanged,
            changes: changes.slice(0, 8)
        }] : [];
    });
    for (const entry of matched.baseOnly) {
        differences.push({
            name: String(entry?.name || "Elemento"),
            type: String(entry?.type || "item"),
            kind: "missing",
            structural: true,
            changes: [{ label: "Presenza", before: "Presente", after: "Assente" }]
        });
    }
    for (const entry of matched.sourceOnly) {
        differences.push({
            name: String(entry?.name || "Elemento"),
            type: String(entry?.type || "item"),
            kind: "added",
            structural: true,
            changes: [{ label: "Presenza", before: "Assente", after: "Presente" }]
        });
    }
    return differences.slice(0, 32);
}
function managedActorLinkEffectDifferences(baseActor, sourceActor) {
    const readEffects = (actor) => Array.from(actor?.effects || []).map((effect) => ({
        ...managedActorLinkEffectSemanticState(effect),
        id: String(effect?.id || "")
    }));
    const matched = managedActorLinkPairRecords(readEffects(baseActor), readEffects(sourceActor), [
        (entry) => entry.id ? `id:${entry.id}` : "",
        (entry) => {
            const name = String(entry?.name || "").trim().toLowerCase();
            const { id: _id, name: _name, ...definition } = entry || {};
            const definitionHash = hashValue(definition);
            return name ? `definition:${name}:${definitionHash}` : "";
        },
        (entry) => {
            const name = String(entry?.name || "").trim().toLowerCase();
            return name ? `identity:${name}` : "";
        }
    ]);
    const effectDefinition = (entry) => {
        const { id: _id, name: _name, ...definition } = entry || {};
        return definition;
    };
    const differences = matched.pairs.flatMap(({ base: previous, source: current }) => (
        stableStringify(effectDefinition(previous)) === stableStringify(effectDefinition(current))
            ? []
            : [{ name: current.name || previous.name, kind: "changed", detail: "Stato, durata o configurazione differenti" }]
    ));
    for (const entry of matched.baseOnly) differences.push({ name: entry.name, kind: "missing", detail: "Assente sul token" });
    for (const entry of matched.sourceOnly) differences.push({ name: entry.name, kind: "added", detail: "Presente soltanto sul token" });
    return differences.slice(0, 24);
}
const MANAGED_ACTOR_LINK_DEFINITION_PATHS = [
    "abilities",
    "skills",
    "traits",
    "attributes.ac",
    "attributes.prof",
    "attributes.movement",
    "attributes.senses",
    "attributes.spellcasting",
    "attributes.hp.max",
    "attributes.hp.formula",
    "details.cr",
    "details.type",
    "details.alignment"
];

function managedActorLinkDefinitionState(actor) {
    const actorSource = actor?._source || actor?.toObject?.(true) || {};
    const resolvedSystem = actor?.system?.toObject?.(false) || actor?.system;
    const system = resolvedSystem || actorSource.system || {};
    const state = {};
    for (const path of MANAGED_ACTOR_LINK_DEFINITION_PATHS) {
        const value = foundry.utils.getProperty(system, path);
        if (value !== undefined) foundry.utils.setProperty(state, path, foundry.utils.deepClone(
            path === "attributes.senses" ? readDnd5eSenses(value) : value
        ));
    }
    // These values are deliberately derived by D&D5e and therefore are not in
    // DataModel.toObject(). Capture them separately for post-copy verification;
    // their persistent causes (AC calculation, CR, items and effects) are still
    // copied from source and verified independently.
    for (const path of ["attributes.ac.value", "attributes.prof"]) {
        const value = foundry.utils.getProperty(actor?.system || {}, path);
        if (value !== undefined) foundry.utils.setProperty(state, path, foundry.utils.deepClone(value));
    }
    return state;
}

function managedActorLinkSystemState(actor) {
    const source = managedActorLinkDocumentSource(actor);
    const system = source?.system ?? actor?.system?.toObject?.(true) ?? actor?.system;
    if (!system || typeof system !== "object" || Array.isArray(system)) return {};
    return foundry.utils.deepClone(system);
}

// Foundry's PrototypeToken schema is the Token schema minus these per-scene
// fields, plus `randomImg`. Only the schema intersection is shared.
const MANAGED_ACTOR_LINK_TOKEN_INSTANCE_KEYS = new Set([
    "_id", "id", "_stats", "actorId", "actorLink", "delta",
    "x", "y", "elevation", "sort", "hidden", "locked", "_regions"
]);
const MANAGED_ACTOR_LINK_TOKEN_PROTOTYPE_ONLY_KEYS = new Set(["randomImg", "appendNumber", "prependAdjective"]);
const MANAGED_ACTOR_LINK_TOKEN_NON_SHARED_KEYS = new Set([
    ...MANAGED_ACTOR_LINK_TOKEN_INSTANCE_KEYS,
    ...MANAGED_ACTOR_LINK_TOKEN_PROTOTYPE_ONLY_KEYS
]);

function managedActorLinkActorEnvelopeState(actor) {
    const source = managedActorLinkDocumentSource(actor);
    return {
        name: String(source?.name || actor?.name || ""),
        img: String(source?.img || actor?.img || ""),
        flags: foundry.utils.deepClone(source?.flags || actor?.flags || {})
    };
}

function managedActorLinkTokenConfigurationState(token) {
    let source = {};
    try {
        source = token?.toObject?.(false) || token?._source || token || {};
    } catch (_) {
        source = token?._source || token || {};
    }
    return Object.fromEntries(Object.entries(source || {})
        .filter(([key]) => !MANAGED_ACTOR_LINK_TOKEN_NON_SHARED_KEYS.has(key))
        .map(([key, value]) => [key, foundry.utils.deepClone(value)]));
}

function managedActorLinkActorEnvelopeComparable(value) {
    return managedActorLinkSemanticValue(value || {}, ["actorEnvelope"]) || {};
}

function managedActorLinkTokenConfigurationComparable(value) {
    return managedActorLinkSemanticValue(value || {}, ["tokenConfiguration"]) || {};
}

async function applyManagedActorLinkActorEnvelope(targetActor, state) {
    const requested = state && typeof state === "object" ? state : {};
    const shell = managedActorLinkDocumentSource(targetActor);
    shell.name = String(requested.name || targetActor.name || "Actor");
    shell.img = String(requested.img || targetActor.img || "icons/svg/mystery-man.svg");
    shell.flags = foundry.utils.deepClone(requested.flags || {});
    const cleaned = managedActorLinkSchemaCleanDocumentSource(targetActor, shell);
    await targetActor.update({
        name: cleaned.name,
        img: cleaned.img,
        flags: foundry.utils.deepClone(cleaned.flags || {})
    }, { criptaWikiSyncCommand: true, render: false, diff: false, recursive: false });
}

function prepareManagedActorLinkBarUpdate(update) {
    if (!game.modules?.get("barbrawl")?.active || !globalThis._del) return update;
    // Bar Brawl 1.9.3 dereferences a missing resourceBars entry when a full
    // Token update includes bar1/bar2.attribute=null. Express an absent bar
    // with Foundry's deletion operator, which Bar Brawl explicitly supports.
    // This only changes detached update data; custom bars remain untouched.
    for (const barId of ["bar1", "bar2"]) {
        if (update?.[barId]?.attribute !== null) continue;
        const path = `flags.barbrawl.resourceBars.${barId}`;
        if (foundry.utils.getProperty(update, path) !== undefined) continue;
        foundry.utils.setProperty(update, path, globalThis._del);
    }
    return update;
}

async function applyManagedActorLinkPrototypeConfiguration(actor, configuration, actorLink = true) {
    const desired = {
        ...foundry.utils.deepClone(configuration || {}),
        actorLink: actorLink === true
    };
    for (const key of MANAGED_ACTOR_LINK_TOKEN_NON_SHARED_KEYS) {
        if (key !== "actorLink") delete desired[key];
    }
    for (const key of MANAGED_ACTOR_LINK_TOKEN_PROTOTYPE_ONLY_KEYS) {
        const current = actor?.prototypeToken?.[key];
        if (current !== undefined) desired[key] = foundry.utils.deepClone(current);
    }
    const cleaned = actor?.prototypeToken
        ? managedActorLinkSchemaCleanDocumentSource(actor.prototypeToken, desired)
        : desired;
    cleaned.actorLink = actorLink === true;
    const prototypeUpdate = prepareManagedActorLinkBarUpdate(cleaned);
    // Update the embedded model normally. In v14 a non-recursive replacement
    // resets omitted fields to defaults: Bar Brawl deliberately removes an
    // unchanged displayBars from the payload, so replacing the whole model
    // would reset it to NONE. Only flags require replacement (not a merge).
    prototypeUpdate.flags = globalThis._replace(prototypeUpdate.flags || {});
    await actor.update({ prototypeToken: prototypeUpdate }, {
        criptaWikiSyncCommand: true, render: false, diff: false
    });
    // Link state is a transaction requirement, independent of normalization
    // of the complete embedded PrototypeToken configuration. Use Foundry's
    // normal partial-update path too, including when restoring a backup.
    // An already persisted value produces no additional database write.
    if (actor.prototypeToken?.actorLink !== (actorLink === true)) {
        await actor.update({ "prototypeToken.actorLink": actorLink === true }, {
            criptaWikiSyncCommand: true, render: false
        });
    }
    if (actor.prototypeToken?.actorLink !== (actorLink === true)) {
        const error = new Error("Foundry non ha mantenuto Link Actor Data nel token predefinito. La conversione viene annullata.");
        error.diagnostics = [{
            Categoria: "Configurazione token",
            Percorso: "Prototype Token \u00B7 Link Actor Data",
            PercorsoTecnico: "prototypeToken.actorLink",
            Atteso: actorLink === true ? "Si" : "No",
            Ottenuto: actor.prototypeToken?.actorLink === true ? "Si" : "No",
            Istruzione: "Questo campo viene impostato automaticamente. Non modificarlo manualmente: il modulo non ha ricevuto conferma del valore richiesto da Foundry."
        }];
        throw error;
    }
}

function managedActorLinkPlacedTokenSource(token, actor, configuration) {
    const current = foundry.utils.deepClone(token?.toObject?.(false) || token?._source || {});
    const desired = {
        ...foundry.utils.deepClone(configuration || {}),
        _id: String(token?.id || current._id || ""),
        actorId: String(actor?.id || current.actorId || ""),
        actorLink: true,
        delta: {},
        x: current.x,
        y: current.y,
        elevation: current.elevation,
        sort: current.sort,
        hidden: current.hidden,
        locked: current.locked,
        _regions: foundry.utils.deepClone(current._regions || [])
    };
    return prepareManagedActorLinkBarUpdate(managedActorLinkSchemaCleanDocumentSource(token, desired));
}

async function applyManagedActorLinkPlacedTokens(actor, configuration) {
    for (const scene of game.scenes || []) {
        const updates = Array.from(scene.tokens || [])
            .filter((token) => String(token.actorId || "") === String(actor.id || ""))
            .map((token) => managedActorLinkPlacedTokenSource(token, actor, configuration));
        if (!updates.length) continue;
        await scene.updateEmbeddedDocuments("Token", updates, {
            criptaWikiSyncCommand: true,
            render: false,
            diff: false,
            recursive: false
        });
    }
}

function verifyManagedActorLinkPlacedTokens(actor, configuration) {
    const expected = managedActorLinkTokenConfigurationComparable(configuration);
    const mismatches = [];
    const diagnostics = [];
    const addDiagnostic = (token, field, path, before, after) => diagnostics.push({
        Categoria: "Configurazione token",
        Percorso: `${token.name || token.id} \u00B7 ${field}`,
        PercorsoTecnico: `scenes.${token.parent?.id || "scene"}.tokens.${token.id}.${path}`,
        Atteso: managedActorLinkDiagnosticValue(before),
        Ottenuto: managedActorLinkDiagnosticValue(after),
        Istruzione: managedActorLinkDiagnosticInstruction("Configurazione token")
    });
    for (const scene of game.scenes || []) {
        for (const token of scene.tokens || []) {
            if (String(token.actorId || "") !== String(actor.id || "")) continue;
            if (token.actorLink !== true) {
                mismatches.push(`${token.name || token.id}: non collegato`);
                addDiagnostic(token, "Link Actor Data", "actorLink", true, token.actorLink === true);
                continue;
            }
            const actual = managedActorLinkTokenConfigurationComparable(managedActorLinkTokenConfigurationState(token));
            const paths = managedActorLinkCanonicalDifferencePaths(expected, actual, Number.POSITIVE_INFINITY);
            if (paths.length) mismatches.push(`${token.name || token.id}: configurazione token differente`);
            for (const path of paths) {
                addDiagnostic(
                    token,
                    managedActorLinkCanonicalDifferenceLabel(`tokenConfiguration.${path}`, {}, {}),
                    path,
                    managedActorLinkDiagnosticPathValue(expected, path),
                    managedActorLinkDiagnosticPathValue(actual, path)
                );
            }
        }
    }
    return { ok: mismatches.length === 0, summary: mismatches.slice(0, 8), diagnostics };
}
function managedActorLinkResolvedSystemValue(actor, path, fallback) {
    const value = foundry.utils.getProperty(actor?.system || {}, path);
    if (path === "attributes.senses") return foundry.utils.deepClone(readDnd5eSenses(value ?? fallback));
    if (value === undefined) return fallback;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    try {
        return foundry.utils.deepClone(value?.toObject?.() ?? value);
    } catch (_) {
        return fallback;
    }
}

function managedActorLinkReadableDefinitionValue(value) {
    if (value === undefined || value === null || value === "") return "\u2014";
    if (value instanceof Set) value = Array.from(value).sort();
    if (value instanceof Map) value = Object.fromEntries(value.entries());
    if (typeof value === "boolean") return value ? "Si" : "No";
    if (["string", "number"].includes(typeof value)) return String(value).slice(0, 120);
    if (Array.isArray(value)) return value.map(String).join(", ").slice(0, 120) || "\u2014";
    if (typeof value === "object") {
        const main = Array.isArray(value.value) ? value.value.join(", ") : (value.value ?? value.label ?? "");
        const custom = String(value.custom || "").trim();
        const bypasses = Array.isArray(value.bypasses) && value.bypasses.length ? `; ignora ${value.bypasses.join(", ")}` : "";
        const readable = [main, custom].filter((entry) => entry !== "" && entry !== undefined && entry !== null).join("; ") + bypasses;
        if (readable) return readable.slice(0, 120);
        return Object.entries(value).filter(([, entry]) => ["string", "number", "boolean"].includes(typeof entry)).map(([key, entry]) => `${key}: ${entry}`).join("; ").slice(0, 120) || "Configurazione differente";
    }
    return String(value).slice(0, 120);
}

function managedActorLinkDamageTraitComparable(value) {
    const values = (collection) => {
        let entries = [];
        if (collection instanceof Set || Array.isArray(collection)) entries = Array.from(collection);
        else if (collection && typeof collection.values === "function") entries = Array.from(collection.values());
        else if (collection && typeof collection === "object") {
            entries = Object.entries(collection)
                .filter(([, enabled]) => enabled === true || enabled === 1)
                .map(([key]) => key);
        }
        return Array.from(new Set(entries
            .map((entry) => String((entry?.id ?? entry) || "").trim())
            .filter(Boolean)))
            .sort((left, right) => left.localeCompare(right));
    };
    const custom = String(value?.custom || "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
    return {
        value: values(value?.value),
        bypasses: values(value?.bypasses),
        custom
    };
}

function managedActorLinkConditionTraitComparable(value) {
    const normalized = managedActorLinkDamageTraitComparable(value);
    return {
        value: normalized.value,
        custom: normalized.custom
    };
}

function managedActorLinkLanguageTraitComparable(value) {
    const base = managedActorLinkDamageTraitComparable({
        value: value?.value,
        custom: value?.custom,
        bypasses: []
    });
    const rawCommunication = value?.communication;
    const entries = rawCommunication instanceof Map
        ? Array.from(rawCommunication.entries())
        : Object.entries(rawCommunication && typeof rawCommunication === "object" ? rawCommunication : {});
    const communication = Object.fromEntries(entries
        .map(([key, entry]) => [String(key), {
            value: Number(entry?.value || 0),
            units: String(entry?.units || "").trim()
        }])
        .filter(([, entry]) => entry.value !== 0 || entry.units)
        .sort(([left], [right]) => left.localeCompare(right)));
    return {
        value: base.value,
        custom: base.custom,
        communication
    };
}

function managedActorLinkDefinitionDifferences(baseActor, sourceActor) {
    const base = managedActorLinkDefinitionState(baseActor);
    const source = managedActorLinkDefinitionState(sourceActor);
    const differences = [];
    const comparable = (value, label) => {
        const sortCollections = (entry) => {
            if (Array.isArray(entry)) {
                return entry.map(sortCollections)
                    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
            }
            if (!entry || typeof entry !== "object") return entry;
            return Object.fromEntries(Object.entries(entry)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, sortCollections(child)]));
        };
        return sortCollections(managedActorLinkSemanticValue(value, ["definition", label]));
    };
    const add = (label, before, after, group = "stat") => {
        const beforeComparable = comparable(before, label);
        const afterComparable = comparable(after, label);
        if (stableStringify(beforeComparable) === stableStringify(afterComparable)) return;
        differences.push({
            label,
            before: managedActorLinkReadableDefinitionValue(before),
            after: managedActorLinkReadableDefinitionValue(after),
            group
        });
    };
    const abilityLabels = { str: "Forza", dex: "Destrezza", con: "Costituzione", int: "Intelligenza", wis: "Saggezza", cha: "Carisma" };
    const proficiencyText = (value) => ({ "0": "Nessuna", "0.5": "Mezza competenza", "1": "Competente", "2": "Maestria" }[String(value ?? 0)] || String(value ?? 0));
    for (const key of Object.keys(abilityLabels)) {
        const baseValue = managedActorLinkResolvedSystemValue(baseActor, `abilities.${key}.value`, base.abilities?.[key]?.value);
        const sourceValue = managedActorLinkResolvedSystemValue(sourceActor, `abilities.${key}.value`, source.abilities?.[key]?.value);
        const baseProficiency = managedActorLinkResolvedSystemValue(baseActor, `abilities.${key}.proficient`, base.abilities?.[key]?.proficient);
        const sourceProficiency = managedActorLinkResolvedSystemValue(sourceActor, `abilities.${key}.proficient`, source.abilities?.[key]?.proficient);
        add(abilityLabels[key], baseValue, sourceValue, "ability");
        add(`Tiro salvezza ${abilityLabels[key]}`, proficiencyText(baseProficiency), proficiencyText(sourceProficiency), "proficiency");
    }
    const skillLabels = { acr: "Acrobazia", ani: "Addestrare Animali", arc: "Arcano", ath: "Atletica", dec: "Inganno", his: "Storia", ins: "Intuizione", itm: "Intimidire", inv: "Investigare", med: "Medicina", nat: "Natura", prc: "Percezione", prf: "Intrattenere", per: "Persuasione", rel: "Religione", slt: "Rapidita di Mano", ste: "Furtivita", sur: "Sopravvivenza" };
    const skillKeys = Array.from(new Set([...Object.keys(base.skills || {}), ...Object.keys(source.skills || {})])).sort();
    for (const key of skillKeys) {
        const baseValue = managedActorLinkResolvedSystemValue(baseActor, `skills.${key}.value`, base.skills?.[key]?.value);
        const sourceValue = managedActorLinkResolvedSystemValue(sourceActor, `skills.${key}.value`, source.skills?.[key]?.value);
        add(`Competenza ${skillLabels[key] || key.toUpperCase()}`, proficiencyText(baseValue), proficiencyText(sourceValue), "proficiency");
    }

    add("Classe Armatura",
        managedActorLinkResolvedSystemValue(baseActor, "attributes.ac.value", base.attributes?.ac?.value ?? base.attributes?.ac),
        managedActorLinkResolvedSystemValue(sourceActor, "attributes.ac.value", source.attributes?.ac?.value ?? source.attributes?.ac),
        "stat");
    add("Bonus competenza",
        managedActorLinkResolvedSystemValue(baseActor, "attributes.prof", base.attributes?.prof),
        managedActorLinkResolvedSystemValue(sourceActor, "attributes.prof", source.attributes?.prof),
        "proficiency");
    add("PF massimi",
        managedActorLinkResolvedSystemValue(baseActor, "attributes.hp.max", base.attributes?.hp?.max),
        managedActorLinkResolvedSystemValue(sourceActor, "attributes.hp.max", source.attributes?.hp?.max),
        "stat");
    add("Formula PF",
        managedActorLinkResolvedSystemValue(baseActor, "attributes.hp.formula", base.attributes?.hp?.formula),
        managedActorLinkResolvedSystemValue(sourceActor, "attributes.hp.formula", source.attributes?.hp?.formula),
        "stat");
    add("Caratteristica da incantatore",
        managedActorLinkResolvedSystemValue(baseActor, "attributes.spellcasting", base.attributes?.spellcasting),
        managedActorLinkResolvedSystemValue(sourceActor, "attributes.spellcasting", source.attributes?.spellcasting),
        "stat");

    const movementLabels = { walk: "Velocita", fly: "Volo", swim: "Nuoto", climb: "Scalata", burrow: "Scavo", hover: "Fluttuazione", units: "Unita movimento" };
    for (const [key, label] of Object.entries(movementLabels)) {
        add(label,
            managedActorLinkResolvedSystemValue(baseActor, `attributes.movement.${key}`, base.attributes?.movement?.[key]),
            managedActorLinkResolvedSystemValue(sourceActor, `attributes.movement.${key}`, source.attributes?.movement?.[key]),
            "movement");
    }
    const baseSenses = managedActorLinkResolvedSystemValue(baseActor, "attributes.senses", base.attributes?.senses || {}) || {};
    const sourceSenses = managedActorLinkResolvedSystemValue(sourceActor, "attributes.senses", source.attributes?.senses || {}) || {};
    const senseLabels = { darkvision: "Scurovisione", blindsight: "Vista cieca", tremorsense: "Percezione tellurica", truesight: "Vista pura" };
    const senseKeys = Array.from(new Set([...Object.keys(baseSenses.ranges || {}), ...Object.keys(sourceSenses.ranges || {})])).sort();
    for (const key of senseKeys) add(senseLabels[key] || `Senso ${key}`, baseSenses.ranges?.[key], sourceSenses.ranges?.[key], "trait");
    for (const key of new Set([...Object.keys(baseSenses), ...Object.keys(sourceSenses)])) {
        if (key === "ranges") continue;
        add(({ units: "Unità dei sensi", special: "Sensi speciali" })[key] || `Senso ${key}`, baseSenses[key], sourceSenses[key], "trait");
    }

    const traitLabels = {
        size: "Taglia",
        dr: "Resistenze ai danni",
        di: "Immunita ai danni",
        dv: "Vulnerabilita ai danni",
        ci: "Immunita alle condizioni",
        languages: "Linguaggi",
        weaponProf: "Competenze nelle armi",
        armorProf: "Competenze nelle armature",
        toolProf: "Competenze negli strumenti"
    };
    for (const [key, label] of Object.entries(traitLabels)) {
        let before = managedActorLinkResolvedSystemValue(baseActor, `traits.${key}`, base.traits?.[key]);
        let after = managedActorLinkResolvedSystemValue(sourceActor, `traits.${key}`, source.traits?.[key]);
        if (["dr", "di", "dv"].includes(key)) {
            before = managedActorLinkDamageTraitComparable(before);
            after = managedActorLinkDamageTraitComparable(after);
        } else if (key === "ci") {
            before = managedActorLinkConditionTraitComparable(before);
            after = managedActorLinkConditionTraitComparable(after);
        } else if (key === "languages") {
            before = managedActorLinkLanguageTraitComparable(before);
            after = managedActorLinkLanguageTraitComparable(after);
        }
        add(label, before, after, "trait");
    }
    add("Grado di Sfida",
        managedActorLinkResolvedSystemValue(baseActor, "details.cr", base.details?.cr),
        managedActorLinkResolvedSystemValue(sourceActor, "details.cr", source.details?.cr),
        "stat");
    add("Tipo di creatura",
        managedActorLinkResolvedSystemValue(baseActor, "details.type", base.details?.type),
        managedActorLinkResolvedSystemValue(sourceActor, "details.type", source.details?.type),
        "trait");
    add("Allineamento",
        managedActorLinkResolvedSystemValue(baseActor, "details.alignment", base.details?.alignment),
        managedActorLinkResolvedSystemValue(sourceActor, "details.alignment", source.details?.alignment),
        "trait");
    return differences.slice(0, 96);
}

function managedActorLinkDefinitionUpdate(sourceActorOrState) {
    const state = sourceActorOrState?.system || sourceActorOrState?.toObject || sourceActorOrState?._source
        ? managedActorLinkDefinitionState(sourceActorOrState)
        : (sourceActorOrState || {});
    const update = {};
    for (const path of MANAGED_ACTOR_LINK_DEFINITION_PATHS) {
        const value = foundry.utils.getProperty(state, path);
        if (value !== undefined) update[`system.${path}`] = foundry.utils.deepClone(value);
    }
    return update;
}

async function applyManagedActorLinkDefinition(targetActor, sourceActorOrState) {
    const update = managedActorLinkDefinitionUpdate(sourceActorOrState);
    if (Object.keys(update).length) await targetActor.update(update, { criptaWikiSyncCommand: true, render: false });
}
async function applyManagedActorLinkSystemState(targetActor, state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("Snapshot meccanico Actor non valido");
    }
    const shell = managedActorLinkDocumentSource(targetActor);
    shell.system = foundry.utils.deepClone(state);
    const cleaned = managedActorLinkSchemaCleanDocumentSource(targetActor, shell);
    if (!cleaned?.system || typeof cleaned.system !== "object" || Array.isArray(cleaned.system)) {
        throw new Error("Il DataModel Foundry ha rifiutato lo snapshot meccanico Actor");
    }
    await targetActor.update({ system: foundry.utils.deepClone(cleaned.system) }, {
        criptaWikiSyncCommand: true, render: false, diff: false, recursive: false
    });
}

function inspectManagedActorLink(actor) {
    const baseStructure = managedActorLinkStructureSignature(actor);
    const sources = [{
        id: "actor",
        kind: "actor",
        label: "Actor originale",
        actorDocument: actor,
        tokenDocument: actor?.prototypeToken,
        actorLink: actor?.prototypeToken?.actorLink === true,
        currentScene: false,
        runtime: buildManagedActorRuntime(actor),
        itemStateChanges: 0,
        itemStateDifferences: [],
        effectDifferences: [],
        definitionDifferences: [],
        structuralDifferences: false,
        effectCount: Array.from(actor?.effects || []).length
    }];
    const tokenRecords = [];
    for (const scene of game.scenes || []) {
        for (const token of scene.tokens || []) {
            if (String(token.actorId || "") !== String(actor.id || "")) continue;
            const syntheticActor = token.actor || actor;
            const itemStateDifferences = managedActorLinkItemStateDifferences(actor, syntheticActor);
            const effectDifferences = managedActorLinkEffectDifferences(actor, syntheticActor);
            const definitionDifferences = managedActorLinkDefinitionDifferences(actor, syntheticActor);
            const record = {
                id: `token:${scene.id}:${token.id}`,
                kind: "token",
                label: `${token.name || actor.name} \u00B7 ${scene.name || "Scena"}`,
                sceneId: String(scene.id || ""),
                sceneName: String(scene.name || "Scena"),
                tokenId: String(token.id || ""),
                tokenName: String(token.name || actor.name || "Token"),
                actorDocument: syntheticActor,
                actorLink: token.actorLink === true,
                currentScene: String(globalThis.canvas?.scene?.id || "") === String(scene.id || ""),
                runtime: buildManagedActorRuntime(syntheticActor),
                itemStateChanges: itemStateDifferences.length,
                itemStateDifferences,
                effectDifferences,
                definitionDifferences,
                structuralDifferences: managedActorLinkStructureSignature(syntheticActor) !== baseStructure,
                effectCount: Array.from(syntheticActor?.effects || []).length,
                tokenDocument: token,
                sceneDocument: scene
            };
            sources.push(record);
            tokenRecords.push(record);
        }
    }
    const hashPayload = {
        actorId: String(actor.id || ""),
        actorLink: actor?.prototypeToken?.actorLink === true,
        sources: sources.map((source) => ({
            id: source.id,
            actorLink: source.actorLink,
            runtime: source.runtime,
            definition: managedActorLinkDefinitionState(source.actorDocument),
            resolvedDifferences: source.definitionDifferences,
            itemState: managedActorLinkItemState(source.actorDocument),
            structure: managedActorLinkStructureSignature(source.actorDocument),
            canonicalSignature: hashValue(managedActorLinkCanonicalMechanicalSnapshot(source.actorDocument, {
                actorEnvelope: managedActorLinkActorEnvelopeState(source.actorDocument),
                tokenConfiguration: managedActorLinkTokenConfigurationState(source.tokenDocument)
            }))
        }))
    };
    const snapshotHash = hashValue(hashPayload);
    return {
        sources,
        tokenRecords,
        review: {
            actorLink: actor?.prototypeToken?.actorLink === true,
            snapshotHash,
            inspectedAt: new Date().toISOString(),
            tokenCount: tokenRecords.length,
            sources: sources.map(({ actorDocument, tokenDocument, sceneDocument, ...source }) => source)
        }
    };
}

function setManagedActorLinkUpdate(update, path, value) {
    if (value === undefined) return;
    update[path] = foundry.utils.deepClone(value);
}

function managedActorLinkRuntimeUpdate(sourceActor) {
    const source = sourceActor?.system || {};
    const update = {};
    for (const path of [
        "attributes.hp.value", "attributes.hp.temp", "attributes.hp.tempmax",
        "attributes.inspiration", "attributes.death.success", "attributes.death.failure"
    ]) {
        setManagedActorLinkUpdate(update, `system.${path}`, foundry.utils.getProperty(source, path));
    }
    for (const [key, resource] of Object.entries(source.resources || {})) {
        setManagedActorLinkUpdate(update, `system.resources.${key}.value`, resource?.value);
        setManagedActorLinkUpdate(update, `system.resources.${key}.max`, resource?.max);
    }
    for (const [key, slot] of Object.entries(source.spells || {})) {
        if (!/^spell\d+$/.test(key) && key !== "pact") continue;
        setManagedActorLinkUpdate(update, `system.spells.${key}.value`, slot?.value);
        setManagedActorLinkUpdate(update, `system.spells.${key}.spent`, slot?.spent);
        setManagedActorLinkUpdate(update, `system.spells.${key}.max`, slot?.max);
        setManagedActorLinkUpdate(update, `system.spells.${key}.override`, slot?.override);
    }
    return update;
}

function managedActorLinkItemUpdates(targetActor, sourceActor) {
    const matched = managedActorLinkPairItemStates(
        managedActorLinkItemState(targetActor),
        managedActorLinkItemState(sourceActor)
    );
    const sourceByTargetId = new Map(matched.pairs.map(({ base, source }) => [base.id, source]));
    return Array.from(targetActor?.items || []).flatMap((item) => {
        const source = sourceByTargetId.get(String(item.id || ""));
        if (!source) return [];
        const update = { _id: item.id };
        const paths = [
            ["system.quantity", source.quantity],
            ["system.equipped", source.equipped],
            ["system.attuned", source.attuned],
            ["system.uses.value", source.uses?.value],
            ["system.uses.spent", source.uses?.spent],
            ["system.prepared", source.prepared]
        ];
        for (const [path, value] of paths) {
            if (value === undefined) continue;
            const current = path === "system.prepared" ? readSpellPreparation(item.system).prepared : foundry.utils.getProperty(item, path);
            if (stableStringify(current) !== stableStringify(value)) update[path] = foundry.utils.deepClone(value);
        }
        return Object.keys(update).length > 1 ? [update] : [];
    });
}

async function applyManagedActorLinkRuntime(targetActor, sourceActor) {
    const actorUpdate = managedActorLinkRuntimeUpdate(sourceActor);
    if (Object.keys(actorUpdate).length) {
        await targetActor.update(actorUpdate, { criptaWikiSyncCommand: true, render: false });
    }
    const itemUpdates = managedActorLinkItemUpdates(targetActor, sourceActor);
    if (itemUpdates.length) {
        await targetActor.updateEmbeddedDocuments("Item", itemUpdates, { criptaWikiSyncCommand: true, render: false });
    }
}

function managedActorLinkRuntimeSourceSnapshot(actor) {
    const system = foundry.utils.deepClone(actor?.system?.toObject?.(false) || actor?.system || {});
    const items = Array.from(actor?.items || []).map((item) => {
        const data = managedActorLinkDocumentSource(item);
        const flags = foundry.utils.deepClone(item?.flags || data?.flags || {});
        return {
            ...data,
            id: String(item?.id || data?._id || ""),
            system: foundry.utils.deepClone(item?.system?.toObject?.(false) || item?.system || data?.system || {}),
            flags,
            getFlag: (moduleId, key) => foundry.utils.getProperty(flags, `${moduleId}.${key}`)
        };
    });
    return { system, items };
}

function managedActorLinkMappedRuntimeSnapshot(actor, structuralState) {
    const snapshot = managedActorLinkRuntimeSourceSnapshot(actor);
    if (!Array.isArray(structuralState?.items)) return snapshot;
    snapshot.items = structuralState.items.map((data) => {
        const flags = foundry.utils.deepClone(data?.flags || {});
        return {
            ...foundry.utils.deepClone(data),
            id: String(data?._id || ""),
            system: foundry.utils.deepClone(data?.system || {}),
            flags,
            getFlag: (moduleId, key) => foundry.utils.getProperty(flags, `${moduleId}.${key}`)
        };
    });
    return snapshot;
}

function managedActorLinkRetargetReferences(value, replacements) {
    if (typeof value === "string") {
        return replacements.reduce((current, entry) => entry.from ? current.split(entry.from).join(entry.to) : current, value);
    }
    if (Array.isArray(value)) return value.map((entry) => managedActorLinkRetargetReferences(entry, replacements));
    if (!value || typeof value !== "object") return value;
    for (const key of Object.keys(value)) value[key] = managedActorLinkRetargetReferences(value[key], replacements);
    return value;
}

function managedActorLinkStructuralItemSources(targetActor, sourceActor) {
    const targetStates = managedActorLinkItemState(targetActor);
    const sourceStates = managedActorLinkItemState(sourceActor);
    const matched = managedActorLinkPairItemStates(targetStates, sourceStates);
    const targetDocuments = new Map(Array.from(targetActor?.items || []).map((item) => [String(item.id || ""), item]));
    const targetBySourceId = new Map(matched.pairs.map(({ base, source }) => [source.id, targetDocuments.get(base.id)]));
    const mappings = Array.from(sourceActor?.items || []).map((sourceItem) => {
        const targetItem = targetBySourceId.get(String(sourceItem.id || "")) || null;
        return {
            sourceItem,
            targetItem,
            sourceId: String(sourceItem.id || ""),
            targetId: String(targetItem?.id || sourceItem.id || "")
        };
    });
    const replacements = mappings.flatMap((entry) => entry.sourceId && entry.targetId ? [{
        from: `${sourceActor.uuid}.Item.${entry.sourceId}`,
        to: `${targetActor.uuid}.Item.${entry.targetId}`
    }] : []);
    if (sourceActor?.uuid && targetActor?.uuid) replacements.push({ from: sourceActor.uuid, to: targetActor.uuid });
    replacements.sort((left, right) => right.from.length - left.from.length);
    return {
        replacements,
        data: mappings.map(({ sourceItem, targetItem, targetId }) => {
            const data = managedActorLinkDocumentSource(sourceItem);
            if (targetId) data._id = targetId;
            const sourceModuleFlags = data.flags?.[MODULE_ID] && typeof data.flags[MODULE_ID] === "object" ? data.flags[MODULE_ID] : {};
            const targetModuleFlags = targetItem?.flags?.[MODULE_ID] && typeof targetItem.flags[MODULE_ID] === "object" ? targetItem.flags[MODULE_ID] : {};
            data.flags = { ...(data.flags || {}), [MODULE_ID]: { ...sourceModuleFlags, ...foundry.utils.deepClone(targetModuleFlags) } };
            if (!data.flags[MODULE_ID].transferId) data.flags[MODULE_ID].transferId = `item-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
            return managedActorLinkRetargetReferences(data, replacements);
        })
    };
}

function managedActorLinkStructuralEffectSources(targetActor, sourceActor, replacements = []) {
    const target = Array.from(targetActor?.effects || []);
    const source = Array.from(sourceActor?.effects || []);
    const matched = managedActorLinkPairRecords(target, source, [
        (effect) => effect?.id ? `id:${effect.id}` : "",
        (effect) => {
            const name = String(effect?.name || "").trim().toLowerCase();
            return name ? `name:${name}` : "";
        }
    ]);
    const targetBySourceId = new Map(matched.pairs.map(({ base, source: sourceEffect }) => [String(sourceEffect.id || ""), base]));
    return uniqueManagedActorLinkEffects(source.map((sourceEffect) => {
        const data = managedActorLinkDocumentSource(sourceEffect);
        const targetEffect = targetBySourceId.get(String(sourceEffect.id || ""));
        if (targetEffect?.id) data._id = targetEffect.id;
        return managedActorLinkRetargetReferences(data, replacements);
    }));
}

async function replaceManagedActorLinkEmbeddedDocuments(actor, documentName, data) {
    if (documentName === "ActiveEffect") {
        await reconcileManagedActorLinkEffects(actor, data);
        return;
    }
    if (documentName === "Item") {
        await reconcileManagedActorLinkItems(actor, data);
        return;
    }
    throw new Error(`Tipo di documento incorporato non supportato: ${documentName}`);
}


function uniqueManagedActorLinkItems(data = []) {
    const seen = new Set();
    return Array.from(data || []).map((item) => {
        const copy = foundry.utils.deepClone(item);
        const id = String(copy?._id || "");
        if (id && seen.has(id)) throw new Error(`ID oggetto duplicato durante la conversione: ${id}`);
        if (id) seen.add(id);
        return copy;
    });
}

async function reconcileManagedActorLinkItems(actor, data = []) {
    const desired = uniqueManagedActorLinkItems(data);
    const current = Array.from(actor.items || []);
    const currentById = new Map(current.map((item) => [String(item.id || ""), item]).filter(([id]) => id));
    const desiredIds = new Set(desired.map((item) => String(item?._id || "")).filter(Boolean));
    const options = { criptaWikiSyncCommand: true, render: false };
    const createOptions = { ...options, keepId: true, keepEmbeddedIds: true, renderSheet: false };
    const creates = [];
    const replacements = [];

    for (const item of desired) {
        const id = String(item?._id || "");
        const existing = id ? currentById.get(id) : null;
        if (!existing) {
            creates.push(item);
            continue;
        }
        if (String(existing.type || "") !== String(item?.type || "")) {
            replacements.push({ id, item });
            continue;
        }
        const currentSource = managedActorLinkDocumentSource(existing);
        const currentSemantic = managedActorLinkSemanticValue(currentSource) || {};
        const desiredSemantic = managedActorLinkSemanticValue(item) || {};
        if (stableStringify(currentSemantic) !== stableStringify(desiredSemantic)) {
            replacements.push({ id, item: { ...item, _id: id } });
        }
    }

    // Create before removing stale entries. If Foundry rejects one
    // document, the enclosing transaction can still restore the full snapshot.
    if (creates.length) {
        await actor.createEmbeddedDocuments("Item", creates, {
            ...createOptions,
            keepId: creates.every((item) => Boolean(item?._id))
        });
    }
    // A partial update can retain keys which only exist on the previous Item
    // (old activities, module flags or embedded effects). Recreate just the
    // changed document with the same ID so the chosen source is authoritative
    // while Actor/item UUID references remain stable.
    for (const replacement of replacements) {
        await actor.deleteEmbeddedDocuments("Item", [replacement.id], options);
        await actor.createEmbeddedDocuments("Item", [replacement.item], createOptions);
    }

    const staleIds = current
        .map((item) => String(item.id || ""))
        .filter((id) => id && !desiredIds.has(id));
    if (staleIds.length) await actor.deleteEmbeddedDocuments("Item", staleIds, options);
}
function uniqueManagedActorLinkEffects(data = []) {
    const seen = new Set();
    return Array.from(data || []).filter((effect) => {
        const id = String(effect?._id || "");
        if (id && seen.has(id)) return false;
        if (id) seen.add(id);
        return true;
    });
}

async function reconcileManagedActorLinkEffects(actor, data = []) {
    const desired = uniqueManagedActorLinkEffects(data).map((effect) => foundry.utils.deepClone(effect));
    // Static D&D5e status IDs can exist on a synthetic Token's client Actor
    // while the base Actor has no corresponding server-side document. Replace
    // the whole effect branch through the parent so no stale per-effect lookup
    // can produce `ActiveEffect "..." does not exist!`.
    //
    // Foundry treats recursive:false as an atomic branch replacement. The Link
    // Actor transaction still verifies the canonical result and restores its
    // complete v4 snapshot if persistence changes any actual mechanic.
    await actor.update({ effects: desired }, {
        criptaWikiSyncCommand: true,
        render: false,
        diff: false,
        recursive: false
    });
}

function managedActorLinkStructuralStateActor(state) {
    const items = uniqueManagedActorLinkItems(state?.items || []).map((data) => ({
        id: String(data?._id || ""),
        name: data?.name,
        type: data?.type,
        system: data?.system || {},
        flags: data?.flags || {},
        _source: data,
        toObject: () => foundry.utils.deepClone(data),
        getFlag: (moduleId, key) => foundry.utils.getProperty(data?.flags || {}, `${moduleId}.${key}`)
    }));
    const effects = uniqueManagedActorLinkEffects(state?.effects || []).map((data) => ({
        id: String(data?._id || ""),
        name: data?.name,
        disabled: data?.disabled === true,
        transfer: data?.transfer === true,
        changes: getActiveEffectChanges(data),
        statuses: data?.statuses || [],
        duration: data?.duration || {},
        flags: data?.flags || {},
        system: data?.system || {},
        description: data?.description || "",
        _source: data,
        toObject: () => foundry.utils.deepClone(data)
    }));
    return { items, effects };
}

function managedActorLinkStructuralStateSignature(state) {
    return managedActorLinkStructureSignature(managedActorLinkStructuralStateActor(state));
}

function captureManagedActorLinkStructuralState(targetActor, sourceActor) {
    const items = managedActorLinkStructuralItemSources(targetActor, sourceActor);
    const effects = managedActorLinkStructuralEffectSources(targetActor, sourceActor, items.replacements);
    const state = { items: items.data, effects };
    return { ...state, signature: managedActorLinkStructuralStateSignature(state) };
}

async function applyManagedActorLinkStructuralState(targetActor, state) {
    await replaceManagedActorLinkEmbeddedDocuments(targetActor, "Item", state?.items || []);
    await replaceManagedActorLinkEmbeddedDocuments(targetActor, "ActiveEffect", state?.effects || []);
}

function managedActorLinkRuntimeComparable(value) {
    const semantic = managedActorLinkSemanticValue(value, ["runtime"]);
    const pruneDefaults = (entry) => {
        if (entry === undefined || entry === null || entry === "" || entry === false || entry === 0) return undefined;
        if (Array.isArray(entry)) {
            const values = entry.map(pruneDefaults).filter((item) => item !== undefined);
            return values.length ? values : undefined;
        }
        if (typeof entry !== "object") return entry;
        const values = Object.fromEntries(Object.entries(entry)
            .map(([key, item]) => [key, pruneDefaults(item)])
            .filter(([, item]) => item !== undefined));
        return Object.keys(values).length ? values : undefined;
    };
    const comparable = pruneDefaults(semantic) || {};
    // Encumbrance is derived from inventory; NPC experience is derived from CR.
    // Neither is an independent current-state value to copy or verify.
    delete comparable.weight;
    delete comparable.xp;
    return comparable;
}
function managedActorLinkCanonicalOptionalState(value) {
    return value === undefined || value === null || value === "" || value === false || value === 0 ? undefined : value;
}

function managedActorLinkCanonicalItemRuntimeState(state) {
    const uses = state?.uses || {};
    return managedActorLinkSemanticValue({
        quantity: state?.quantity,
        equipped: managedActorLinkCanonicalOptionalState(state?.equipped),
        attuned: managedActorLinkCanonicalOptionalState(state?.attuned),
        prepared: managedActorLinkCanonicalOptionalState(normalizePreparedState(state?.prepared)),
        uses: {
            value: managedActorLinkCanonicalOptionalState(uses.value),
            spent: managedActorLinkCanonicalOptionalState(uses.spent)
        }
    }, ["items", "*", "runtime"]) || {};
}

function managedActorLinkCanonicalItems(structuralActor, runtimeActor = structuralActor) {
    const runtimeStates = managedActorLinkItemState(runtimeActor);
    const runtimeById = new Map(runtimeStates.map((entry) => [String(entry.id || ""), entry]));
    return Array.from(structuralActor?.items || []).map((item) => {
        const id = String(item?.id || "");
        const runtimeState = runtimeById.get(id) || managedActorLinkItemState({ items: [item] })[0] || {};
        return {
            id,
            name: String(item?.name || "Elemento"),
            type: String(item?.type || "item"),
            definition: managedActorLinkItemDefinitionSource(item),
            runtime: managedActorLinkCanonicalItemRuntimeState(runtimeState)
        };
    }).sort((left, right) => `${left.id}:${left.name}`.localeCompare(`${right.id}:${right.name}`));
}

function managedActorLinkCanonicalEffects(actor) {
    return Array.from(actor?.effects || [])
        .map(managedActorLinkEffectSemanticState)
        .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function managedActorLinkCanonicalMechanicalSnapshot(actor, overrides = {}) {
    const hasSystemOverride = Object.prototype.hasOwnProperty.call(overrides, "system");
    const hasEnvelopeOverride = Object.prototype.hasOwnProperty.call(overrides, "actorEnvelope");
    const hasTokenConfigurationOverride = Object.prototype.hasOwnProperty.call(overrides, "tokenConfiguration");
    const structuralActor = overrides.structural
        ? managedActorLinkStructuralStateActor(overrides.structural)
        : actor;
    const runtimeActor = overrides.runtime || actor;
    const system = hasSystemOverride ? overrides.system : managedActorLinkSystemState(actor);
    const actorEnvelope = hasEnvelopeOverride ? overrides.actorEnvelope : managedActorLinkActorEnvelopeState(actor);
    const tokenConfiguration = hasTokenConfigurationOverride
        ? overrides.tokenConfiguration
        : managedActorLinkTokenConfigurationState(actor?.prototypeToken);
    if (!structuralActor || !runtimeActor) throw new Error("Sorgente snapshot canonico incompleta");
    return {
        schemaVersion: MANAGED_ACTOR_LINK_CANONICAL_SCHEMA_VERSION,
        actorEnvelope: managedActorLinkActorEnvelopeComparable(actorEnvelope),
        tokenConfiguration: managedActorLinkTokenConfigurationComparable(tokenConfiguration),
        system: managedActorLinkSemanticValue(system || {}, ["system"]) || {},
        items: managedActorLinkCanonicalItems(structuralActor, runtimeActor),
        effects: managedActorLinkCanonicalEffects(structuralActor),
        runtime: managedActorLinkRuntimeComparable(buildManagedActorRuntime(runtimeActor))
    };
}

function managedActorLinkCanonicalDifferencePaths(expected, actual, limit = 12) {
    const paths = [];
    const visit = (left, right, path = "") => {
        if (paths.length >= limit || stableStringify(left) === stableStringify(right)) return;
        const leftArray = Array.isArray(left);
        const rightArray = Array.isArray(right);
        if (leftArray || rightArray) {
            if (!leftArray || !rightArray) {
                paths.push(path || "snapshot");
                return;
            }
            for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
                visit(left[index], right[index], `${path}.${index}`);
            }
            return;
        }
        const leftObject = left && typeof left === "object";
        const rightObject = right && typeof right === "object";
        if (!leftObject || !rightObject) {
            paths.push(path || "snapshot");
            return;
        }
        const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
        for (const key of keys) visit(left[key], right[key], path ? `${path}.${key}` : key);
    };
    visit(expected, actual);
    return paths;
}

function managedActorLinkCanonicalDifferenceLabel(path, expected, actual) {
    const readableSuffix = (prefix) => String(path.slice(prefix.length) || "valore").replace(/\.(\d+)(?=\.|$)/g, " [$1]");
    if (path.startsWith("actorEnvelope.")) return `Actor \u00B7 ${readableSuffix("actorEnvelope.")}`;
    if (path.startsWith("tokenConfiguration.")) return `Token \u00B7 ${readableSuffix("tokenConfiguration.")}`;
    if (path.startsWith("system.")) return `Sistema Actor \u00B7 ${readableSuffix("system.")}`;
    if (path.startsWith("runtime.")) return `Stato corrente \u00B7 ${readableSuffix("runtime.")}`;
    const itemMatch = path.match(/^items\.(\d+)(?:\.(.*))?$/);
    if (itemMatch) {
        const index = Number(itemMatch[1]);
        const item = expected.items?.[index] || actual.items?.[index];
        const field = String(itemMatch[2] || "configurazione persistente").replace(/\.(\d+)(?=\.|$)/g, " [$1]");
        return `${item?.name || "Elemento"} \u00B7 ${field}`;
    }
    const effectMatch = path.match(/^effects\.(\d+)(?:\.(.*))?$/);
    if (effectMatch) {
        const index = Number(effectMatch[1]);
        const effect = expected.effects?.[index] || actual.effects?.[index];
        const field = String(effectMatch[2] || "configurazione persistente").replace(/\.(\d+)(?=\.|$)/g, " [$1]");
        return `${effect?.name || "Effetto"} \u00B7 ${field}`;
    }
    return path || "Snapshot meccanico";
}
function verifyManagedActorLinkCanonicalState(actor, selectedState) {
    const expected = managedActorLinkCanonicalMechanicalSnapshot(null, {
        actorEnvelope: selectedState?.actorEnvelope || {},
        tokenConfiguration: selectedState?.tokenConfiguration || {},
        system: selectedState?.system || {},
        structural: selectedState?.canonicalStructural || selectedState?.structural || { items: [], effects: [] },
        runtime: selectedState?.runtime
    });
    const actual = managedActorLinkCanonicalMechanicalSnapshot(actor);

    const expectedActor = managedActorLinkStructuralStateActor(
        selectedState?.canonicalStructural || selectedState?.structural || { items: [], effects: [] }
    );
    const expectedDefinition = selectedState?.definition || selectedState?.system || {};
    expectedActor.system = foundry.utils.deepClone(expectedDefinition);
    expectedActor._source = { system: foundry.utils.deepClone(expectedDefinition) };
    const definitionDifferences = managedActorLinkDefinitionDifferences(expectedActor, actor);
    const canonicalMatches = stableStringify(expected) === stableStringify(actual);
    if (canonicalMatches && !definitionDifferences.length) {
        return { ok: true, expected, actual, definitionDifferences: [], summary: [] };
    }

    const itemDifferences = managedActorLinkItemStateDifferences(expectedActor, actor);
    const effectDifferences = managedActorLinkEffectDifferences(expectedActor, actor);
    const runtimeVerification = verifyManagedActorLinkRuntimeState(actor, selectedState?.runtime);
    const genericSummary = managedActorLinkCanonicalDifferencePaths(expected, actual)
        .map((path) => managedActorLinkCanonicalDifferenceLabel(path, expected, actual));
    const summary = Array.from(new Set([
        ...definitionDifferences.map((entry) => entry.label),
        ...itemDifferences.flatMap((item) => (item.changes || []).map((change) => `${item.name} - ${change.label}`)),
        ...effectDifferences.map((effect) => `${effect.name || "Effetto"} - ${effect.detail || "configurazione"}`),
        ...(runtimeVerification.summary || []),
        ...genericSummary
    ])).slice(0, 8);
    return {
        ok: false,
        expected,
        actual,
        definitionDifferences,
        itemDifferences,
        effectDifferences,
        runtimeVerification,
        summary
    };
}


function managedActorLinkRuntimeDifferenceSummary(expected, actual) {
    const paths = [];
    const visit = (left, right, path = "") => {
        if (paths.length >= 12 || stableStringify(left) === stableStringify(right)) return;
        const leftObject = left && typeof left === "object" && !Array.isArray(left);
        const rightObject = right && typeof right === "object" && !Array.isArray(right);
        if (!leftObject || !rightObject) {
            paths.push(path || "runtime");
            return;
        }
        const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
        for (const key of keys) visit(left[key], right[key], path ? `${path}.${key}` : key);
    };
    visit(expected, actual);
    const label = (path) => {
        if (path.startsWith("hp.")) return `PF (${path.slice(3)})`;
        if (path.startsWith("spellSlots.")) return `Slot ${path.split(".")[1] || "incantesimo"}`;
        if (path.startsWith("resources.")) return `Risorsa ${path.split(".")[1] || ""}`.trim();
        if (path.startsWith("death.")) return "Tiri salvezza contro morte";
        if (path.startsWith("xp.")) return "Esperienza";
        if (path.startsWith("weight.")) return "Ingombro";
        if (path === "inspiration") return "Ispirazione";
        return path || "Stato corrente";
    };
    return Array.from(new Set(paths.map(label))).slice(0, 8);
}

function verifyManagedActorLinkRuntimeState(actor, sourceActor) {
    const expected = managedActorLinkRuntimeComparable(buildManagedActorRuntime(sourceActor));
    const actual = managedActorLinkRuntimeComparable(buildManagedActorRuntime(actor));
    const runtimeMatches = stableStringify(expected) === stableStringify(actual);
    const runtimeLabels = new Set(["Quantita", "Equipaggiato", "Sintonia", "Utilizzi", "Utilizzi spesi", "Preparato"]);
    const itemDifferences = managedActorLinkItemStateDifferences(sourceActor, actor).flatMap((item) => {
        const changes = (item.changes || []).filter((change) => runtimeLabels.has(change.label));
        return changes.length ? [{ ...item, changes, structural: false }] : [];
    });
    if (runtimeMatches && !itemDifferences.length) return { ok: true, summary: [] };
    const summary = [
        ...(!runtimeMatches ? managedActorLinkRuntimeDifferenceSummary(expected, actual) : []),
        ...itemDifferences.flatMap((item) => item.changes.map((change) => `${item.name} - ${change.label}`))
    ].slice(0, 8);
    return { ok: false, expected, actual, itemDifferences, summary };
}

function managedActorLinkDiagnosticPathValue(root, path) {
    return String(path || "").split(".").filter(Boolean)
        .reduce((value, key) => value?.[key], root);
}

function managedActorLinkDiagnosticValue(value) {
    if (value === undefined || value === null || value === "") return "—";
    const semantic = managedActorLinkSemanticValue(value, ["diagnostic"]);
    const serialized = stableStringify(semantic);
    return serialized || String(value);
}

function managedActorLinkDiagnosticCategory(path) {
    if (path.startsWith("items.")) return "Oggetto, capacit\u00E0 o incantesimo";
    if (path.startsWith("effects.")) return "Effetto";
    if (path.startsWith("tokenConfiguration.")) return "Configurazione token";
    if (path.startsWith("runtime.")) return "Stato corrente";
    if (path.startsWith("actorEnvelope.")) return "Actor";
    if (path.startsWith("system.")) return "Statistiche e meccaniche";
    return "Scheda";
}

function managedActorLinkDiagnosticInstruction(category) {
    if (category === "Oggetto, capacit\u00E0 o incantesimo") return "Apri questo elemento sul token scelto, riallinea il campo al valore accettato da Foundry e salvalo.";
    if (category === "Effetto") return "Apri gli effetti del token scelto, riallinea presenza o configurazione e salva.";
    if (category === "Configurazione token") return "Apri la configurazione del token scelto, imposta il valore accettato da Foundry e salva il token.";
    return "Apri la scheda del token scelto, imposta il valore accettato da Foundry e salva.";
}

function managedActorLinkVerificationDiagnostics(verification) {
    const rows = [];
    const add = (category, path, expected, actual, technicalPath = "") => rows.push({
        Categoria: category,
        Percorso: path,
        PercorsoTecnico: technicalPath,
        Atteso: managedActorLinkDiagnosticValue(expected),
        Ottenuto: managedActorLinkDiagnosticValue(actual),
        Istruzione: managedActorLinkDiagnosticInstruction(category)
    });
    const canonicalPaths = managedActorLinkCanonicalDifferencePaths(
        verification?.expected,
        verification?.actual,
        Number.POSITIVE_INFINITY
    );
    for (const path of canonicalPaths) {
        const category = managedActorLinkDiagnosticCategory(path);
        add(
            category,
            managedActorLinkCanonicalDifferenceLabel(path, verification?.expected || {}, verification?.actual || {}),
            managedActorLinkDiagnosticPathValue(verification?.expected, path),
            managedActorLinkDiagnosticPathValue(verification?.actual, path),
            path
        );
    }
    if (!canonicalPaths.length) {
        for (const entry of verification?.definitionDifferences || []) {
            add("Statistiche e meccaniche", entry.label, entry.before, entry.after);
        }
        for (const item of verification?.itemDifferences || []) {
            for (const change of item.changes || []) add("Oggetto, capacit\u00E0 o incantesimo", `${item.name} \u00B7 ${change.label}`, change.before, change.after);
        }
        for (const effect of verification?.effectDifferences || []) {
            add("Effetto", effect.name || "Effetto", effect.kind || "presente", effect.detail || "configurazione differente");
        }
    }
    const seen = new Set();
    return rows.filter((row) => {
        const key = stableStringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function assertManagedActorLinkVerification(actor, label, verification) {
    if (verification.ok) return;
    const diagnostics = managedActorLinkVerificationDiagnostics(verification);
    console.groupCollapsed(`${MODULE_ID} | Verifica ${label} Link Actor Data non superata · ${actor.name}`);
    if (diagnostics.length && typeof console.table === "function") console.table(diagnostics);
    else console.warn("Differenze rilevate", diagnostics);
    console.debug("Snapshot atteso", verification.expected);
    console.debug("Snapshot ottenuto", verification.actual);
    console.debug("Verifica completa", verification);
    console.groupEnd();
    const details = verification.summary?.length ? `: ${verification.summary.slice(0, 3).join("; ")}` : "";
    const error = new Error(`La copia ${label} dello stato selezionato non ha superato la verifica${details}`);
    error.diagnostics = diagnostics;
    error.verificationSummary = Array.from(verification.summary || []);
    throw error;
}
function captureManagedActorLinkSnapshot(actor, inspection, command) {
    return {
        schemaVersion: MANAGED_ACTOR_LINK_BACKUP_SCHEMA_VERSION,
        commandId: String(command?.id || ""),
        actorId: String(actor?.id || ""),
        createdAt: new Date().toISOString(),
        prototypeActorLink: actor?.prototypeToken?.actorLink === true,
        actorDocument: managedActorLinkNativeActorSource(actor),
        actorEnvelope: managedActorLinkActorEnvelopeState(actor),
        prototypeTokenConfiguration: managedActorLinkTokenConfigurationState(actor?.prototypeToken),

        actorSystem: managedActorLinkSystemState(actor),
        actorRuntime: buildManagedActorRuntime(actor),
        actorItemState: managedActorLinkItemState(actor),
        actorItems: Array.from(actor?.items || []).map(managedActorLinkDocumentSource),
        actorEffects: Array.from(actor?.effects || []).map(managedActorLinkDocumentSource),
        tokens: inspection.tokenRecords.map((record) => ({
            sceneId: record.sceneId,
            tokenId: record.tokenId,
            actorLink: record.tokenDocument?.actorLink === true,
            source: foundry.utils.deepClone(record.tokenDocument?.toObject?.(false) || record.tokenDocument?._source || {}),
            delta: foundry.utils.deepClone(record.tokenDocument?.delta?.toObject?.(false) || record.tokenDocument?._source?.delta || {})
        }))
    };
}

async function restoreManagedActorLinkSnapshot(actor, snapshot) {
    const source = {
        system: {
            attributes: {
                hp: snapshot.actorRuntime?.hp || {},
                inspiration: snapshot.actorRuntime?.inspiration,
                death: snapshot.actorRuntime?.death || {}
            },
            details: { xp: snapshot.actorRuntime?.xp || {} },
            resources: snapshot.actorRuntime?.resources || {},
            spells: snapshot.actorRuntime?.spellSlots || {}
        },
        items: (snapshot.actorItemState || []).map((entry) => ({
            id: entry.id,
            name: entry.name,
            type: entry.type,
            system: {
                quantity: entry.quantity,
                equipped: entry.equipped,
                attuned: entry.attuned,
                uses: entry.uses || {},
                prepared: normalizePreparedState(entry.prepared)
            },
            getFlag: (_module, key) => key === "transferId" ? entry.transferId : ""
        }))
    };
    let restoredItems = [];
    let nativeExpectedSource = null;
    if (snapshot.actorDocument && typeof snapshot.actorDocument === "object") {
        const nativeImport = await importManagedActorLinkActorDocument(actor, snapshot.actorDocument);
        nativeExpectedSource = nativeImport.expectedSource;
        restoredItems = Array.from(snapshot.actorDocument.items || []).map((entry) => foundry.utils.deepClone(entry));
    } else {
        // Backward-compatible rollback for snapshots created before schema 6.
        if (snapshot.actorEnvelope && typeof snapshot.actorEnvelope === "object") {
            await applyManagedActorLinkActorEnvelope(actor, snapshot.actorEnvelope);
        }
        if (snapshot.actorSystem && typeof snapshot.actorSystem === "object") {
            await applyManagedActorLinkSystemState(actor, snapshot.actorSystem);
        } else {
            await applyManagedActorLinkDefinition(actor, snapshot.actorDefinitionState || {});
        }
        if (Array.isArray(snapshot.actorItems) && Array.isArray(snapshot.actorEffects)) {
            restoredItems = snapshot.actorItems.map((entry) => {
                const data = foundry.utils.deepClone(entry);
                if (data?.system?.activities !== undefined) {
                    // Backups created before 0.8.63 can contain the runtime array
                    // returned by ActivityCollection.toObject(). Convert it before
                    // restoring so older safe snapshots remain fully usable.
                    data.system.activities = managedActorLinkActivitiesSourceMap(data.system.activities);
                }
                return data;
            });
            await replaceManagedActorLinkEmbeddedDocuments(actor, "Item", restoredItems);
            await replaceManagedActorLinkEmbeddedDocuments(actor, "ActiveEffect", snapshot.actorEffects.map((entry) => foundry.utils.deepClone(entry)));
        }
        await applyManagedActorLinkRuntime(actor, source);
    }
    if (snapshot.prototypeTokenConfiguration && typeof snapshot.prototypeTokenConfiguration === "object") {
        await applyManagedActorLinkPrototypeConfiguration(actor, snapshot.prototypeTokenConfiguration, snapshot.prototypeActorLink === true);
    } else {
        await actor.update({ "prototypeToken.actorLink": snapshot.prototypeActorLink === true }, { criptaWikiSyncCommand: true, render: false });
    }
    for (const scene of game.scenes || []) {
        const updates = (snapshot.tokens || []).flatMap((entry) => {
            const token = entry.sceneId === scene.id ? scene.tokens?.get(entry.tokenId) : null;
            if (!token) return [];
            const current = foundry.utils.deepClone(token?.toObject?.(false) || token?._source || {});
            const desired = entry.source && typeof entry.source === "object"
                ? foundry.utils.deepClone(entry.source)
                : { ...current, delta: foundry.utils.deepClone(entry.delta || {}) };
            desired._id = String(entry.tokenId || token.id || "");
            desired.actorId = String(actor.id || desired.actorId || "");
            desired.actorLink = entry.actorLink === true;
            if (!entry.source) desired.delta = foundry.utils.deepClone(entry.delta || {});
            return [prepareManagedActorLinkBarUpdate(managedActorLinkSchemaCleanDocumentSource(token, desired))];
        });
        if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, {
            criptaWikiSyncCommand: true,
            render: false,
            diff: false,
            recursive: false
        });
    }

    if (nativeExpectedSource) {
        assertManagedActorLinkVerification(
            actor,
            "del backup nativo",
            verifyManagedActorLinkNativeDocument(actor, nativeExpectedSource)
        );
    } else if (snapshot.actorSystem && Array.isArray(snapshot.actorItems) && Array.isArray(snapshot.actorEffects)) {
        const restoredState = {
            actorEnvelope: snapshot.actorEnvelope || managedActorLinkActorEnvelopeState(actor),
            tokenConfiguration: snapshot.prototypeTokenConfiguration || managedActorLinkTokenConfigurationState(actor?.prototypeToken),
            system: snapshot.actorSystem,
            definition: snapshot.actorDefinitionState || snapshot.actorSystem,
            runtime: source,
            structural: { items: restoredItems, effects: snapshot.actorEffects },
            canonicalStructural: { items: restoredItems, effects: snapshot.actorEffects }
        };
        assertManagedActorLinkVerification(
            actor,
            "del backup",
            verifyManagedActorLinkCanonicalState(actor, restoredState)
        );
    }
    for (const entry of snapshot.tokens || []) {
        const token = game.scenes?.get?.(entry.sceneId)?.tokens?.get?.(entry.tokenId);
        if (!token) continue;
        if (token.actorLink !== (entry.actorLink === true)) {
            throw new Error(`Il token ${token.name || entry.tokenId} non ha ripristinato actorLink`);
        }
        if (entry.source && typeof entry.source === "object") {
            const expectedConfiguration = managedActorLinkTokenConfigurationComparable(managedActorLinkTokenConfigurationState(entry.source));
            const actualConfiguration = managedActorLinkTokenConfigurationComparable(managedActorLinkTokenConfigurationState(token));
            if (stableStringify(expectedConfiguration) !== stableStringify(actualConfiguration)) {
                throw new Error(`Il token ${token.name || entry.tokenId} non ha ripristinato la configurazione del backup`);
            }
            for (const key of ["x", "y", "elevation", "sort", "hidden", "locked", "_regions"]) {
                if (stableStringify(token[key]) !== stableStringify(entry.source[key])) {
                    throw new Error(`Il token ${token.name || entry.tokenId} non ha ripristinato ${key}`);
                }
            }
            const actualDelta = token?.delta?.toObject?.(false) || token?._source?.delta || {};
            if (stableStringify(managedActorLinkSemanticValue(actualDelta, ["delta"]) || {})
                !== stableStringify(managedActorLinkSemanticValue(entry.source.delta || {}, ["delta"]) || {})) {
                throw new Error(`Il token ${token.name || entry.tokenId} non ha ripristinato il delta del backup`);
            }
        }
    }
}
async function executeManagedActorLinkConversion(actor, command) {
    if (String(actor?.type || "").toLowerCase() !== "npc") return { status: "conflict", error: "Link Actor Data e disponibile soltanto per gli NPC" };
    const storedConversion = getWorldObjectSetting(STATE_SETTING)?.[actor.id]?.actorLinkConversion;
    const commandAlreadyCompleted = storedConversion?.status === "complete"
        && String(storedConversion?.snapshot?.commandId || "") === String(command?.id || "")
        && actor?.prototypeToken?.actorLink === true
        && Array.from(game.scenes || []).every((scene) => Array.from(scene.tokens || []).every((token) => (
            String(token.actorId || "") !== String(actor.id || "") || token.actorLink === true
        )));
    if (commandAlreadyCompleted) {
        console.info(`${MODULE_ID} | Link Actor Data gia completato; confermo il comando rimasto in coda.`, {
            actor: actor.name,
            commandId: command.id
        });
        return { status: "applied", actor };
    }
    const inspection = inspectManagedActorLink(actor);
    if (String(command?.document?.snapshotHash || "") !== inspection.review.snapshotHash) {
        return { status: "conflict", error: "Le istanze sono cambiate dopo l'ispezione. Controllale di nuovo.", current: inspection.review };
    }
    const selected = inspection.sources.find((source) => source.id === String(command?.document?.sourceId || ""));
    if (!selected) return { status: "conflict", error: "Stato sorgente non trovato", current: inspection.review };
    // Capture every authoritative branch before the base Actor changes: Foundry
    // can otherwise recalculate a synthetic Actor delta while the transaction is
    // still running. The preliminary difference report never decides what gets
    // copied; it is presentation-only.
    const selectedState = {
        actorDocument: managedActorLinkNativeActorSource(selected.actorDocument),
        tokenConfiguration: managedActorLinkTokenConfigurationState(selected.tokenDocument || actor.prototypeToken)
    };
    const structuralSources = inspection.sources.filter((source) => source.kind === "token" && source.structuralDifferences);
    if (structuralSources.length && command?.document?.acceptStructural !== true) {
        return { status: "conflict", error: "La conversione contiene differenze strutturali non ancora confermate.", current: inspection.review };
    }
    if (inspection.tokenRecords.length > 64) return { status: "conflict", error: "Troppe istanze da convertire in una sola operazione", current: inspection.review };

    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    const previousState = stateRoot[actor.id] && typeof stateRoot[actor.id] === "object" ? stateRoot[actor.id] : {};
    const snapshot = captureManagedActorLinkSnapshot(actor, inspection, command);
    await game.settings.set(MODULE_ID, STATE_SETTING, {
        ...stateRoot,
        [actor.id]: { ...previousState, actorLinkConversion: { status: "prepared", snapshot } }
    });

    try {
        const nativeImport = await importManagedActorLinkActorDocument(actor, selectedState.actorDocument);
        assertManagedActorLinkVerification(actor, "dell'Actor importato", verifyManagedActorLinkNativeDocument(actor, nativeImport.expectedSource));
        await applyManagedActorLinkPrototypeConfiguration(actor, selectedState.tokenConfiguration, true);

        await applyManagedActorLinkPlacedTokens(actor, selectedState.tokenConfiguration);
        const tokenVerification = verifyManagedActorLinkPlacedTokens(actor, selectedState.tokenConfiguration);
        if (!tokenVerification.ok || actor.prototypeToken?.actorLink !== true) {
            const details = tokenVerification.summary.length ? `: ${tokenVerification.summary.join("; ")}` : "";
            const error = new Error(`Le istanze non corrispondono integralmente alla sorgente selezionata${details}`);
            error.diagnostics = Array.from(tokenVerification.diagnostics || []);
            if (actor.prototypeToken?.actorLink !== true) {
                error.diagnostics.unshift({
                    Categoria: "Configurazione token",
                    Percorso: "Prototype Token \u00B7 Link Actor Data",
                    PercorsoTecnico: "prototypeToken.actorLink",
                    Atteso: "Si",
                    Ottenuto: "No",
                    Istruzione: "Il collegamento del token predefinito è cambiato durante la conversione. Non impostarlo manualmente su No: richiedi una nuova ispezione dopo aver ricaricato Foundry."
                });
            }
            throw error;
        }
        // Prototype/Token updates can invoke system/module processing too.
        // Confirm the complete persisted Actor again before saving success.
        assertManagedActorLinkVerification(actor, "dell'Actor collegato", verifyManagedActorLinkNativeDocument(actor, nativeImport.expectedSource));
        const freshStateRoot = getWorldObjectSetting(STATE_SETTING);
        const freshState = freshStateRoot[actor.id] && typeof freshStateRoot[actor.id] === "object" ? freshStateRoot[actor.id] : {};
        await game.settings.set(MODULE_ID, STATE_SETTING, {
            ...freshStateRoot,
            [actor.id]: { ...freshState, runtimePolicyOverride: "shared", actorLinkConversion: { status: "complete", completedAt: new Date().toISOString(), snapshot } }
        });
        console.info(`${MODULE_ID} | Link Actor Data attivato.`, { actor: actor.name, tokens: inspection.tokenRecords.length });
        return { status: "applied", actor };
    } catch (error) {
        try {
            await restoreManagedActorLinkSnapshot(actor, snapshot);
            const rollbackRoot = getWorldObjectSetting(STATE_SETTING);
            await game.settings.set(MODULE_ID, STATE_SETTING, { ...rollbackRoot, [actor.id]: previousState });
            console.warn(`${MODULE_ID} | Conversione Link Actor annullata; backup ripristinato.`, {
                actor: actor.name,
                conversionError: error,
                diagnostics: error?.diagnostics || []
            });
        } catch (rollbackError) {
            console.error(`${MODULE_ID} | Rollback Link Actor Data non completato.`, {
                actor: actor.name,
                conversionError: error,
                conversionDiagnostics: error?.diagnostics || [],
                rollbackError,
                rollbackDiagnostics: rollbackError?.diagnostics || []
            });
        }
        let current;
        try { current = inspectManagedActorLink(actor).review; }
        catch (inspectionError) { console.warn(`${MODULE_ID} | Ispezione dopo rollback non disponibile.`, inspectionError); }
        return {
            status: "failed",
            error: `Conversione non completata: ${String(error?.message || error)}`,
            diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
            ...(current ? { current } : {})
        };
    }
}

async function applyManagedActorLinkConversion(actor, command) {
    const actorId = String(actor?.id || "");
    if (managedActorLinkConversions.has(actorId)) {
        return { status: "conflict", error: "Una conversione Link Actor Data e gia in corso per questo Actor", current: inspectManagedActorLink(actor).review };
    }
    const conversion = executeManagedActorLinkConversion(actor, command);
    managedActorLinkConversions.set(actorId, conversion);
    try {
        return await conversion;
    } finally {
        if (managedActorLinkConversions.get(actorId) === conversion) managedActorLinkConversions.delete(actorId);
    }
}

async function rollbackManagedActorLinkConversion(actor) {
    if (String(actor?.type || "").toLowerCase() !== "npc") {
        return { status: "conflict", error: "Link Actor Data e disponibile soltanto per gli NPC" };
    }
    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    const actorState = stateRoot[actor.id] && typeof stateRoot[actor.id] === "object" ? stateRoot[actor.id] : {};
    const conversion = actorState.actorLinkConversion;
    if (conversion?.status !== "complete" || !conversion.snapshot) {
        return { status: "conflict", error: "Nessun backup completo Link Actor Data disponibile per questo Actor" };
    }

    try {
        await restoreManagedActorLinkSnapshot(actor, conversion.snapshot);
        if (actor.prototypeToken?.actorLink !== (conversion.snapshot.prototypeActorLink === true)) {
            throw new Error("Il prototype non ha conservato lo stato Link Actor del backup");
        }
        for (const entry of conversion.snapshot.tokens || []) {
            const token = game.scenes?.get?.(entry.sceneId)?.tokens?.get?.(entry.tokenId);
            if (!token) continue;
            if (token.actorLink !== (entry.actorLink === true)) {
                throw new Error(`Il token ${token.name || entry.tokenId} non ha conservato lo stato Link Actor del backup`);
            }
        }

        const { actorLinkConversion: _discardedConversion, runtimePolicyOverride: _discardedPolicy, ...restoredState } = actorState;
        await game.settings.set(MODULE_ID, STATE_SETTING, { ...stateRoot, [actor.id]: restoredState });
        console.info(`${MODULE_ID} | Link Actor Data disattivato e stato precedente ripristinato.`, {
            actor: actor.name,
            restoredTokens: Array.isArray(conversion.snapshot.tokens) ? conversion.snapshot.tokens.length : 0
        });
        return { status: "applied", actor };
    } catch (error) {
        console.error(`${MODULE_ID} | Ripristino Link Actor Data non completato; il backup resta disponibile.`, {
            actor: actor.name,
            error
        });
        return { status: "failed", error: `Ripristino non completato: ${String(error?.message || error)}` };
    }
}
async function applyManagedActorCommand(command) {
    const kind = String(command?.kind || "");
    const allowed = new Set(["relationship.update", "actor.update", "item.update", "item.create", "item.delete", "effect.update", "effect.create", "effect.delete", "actor-link.inspect", "actor-link.apply", "actor-link.rollback"]);
    if (!allowed.has(kind)) return { status: "failed", error: "Tipo di comando non supportato" };
    const actor = game.actors.get(String(command.foundryActorId || ""))
        || Array.from(game.actors || []).find((entry) => sanitizeId(entry.id) === sanitizeId(command.actorId));
    if (!actor) return { status: "conflict", error: "Actor non trovato in questo mondo" };
    if (isTemporaryWikiActor(actor)) return { status: "conflict", error: "Le forme temporanee non sono sincronizzate con la wiki" };
    if (kind === "relationship.update") {
        if (typeof callbacks.setCompanionRelationship !== "function") {
            return { status: "failed", error: "Gestione companion non disponibile" };
        }
        await callbacks.setCompanionRelationship(actor, command.document || {});
        return { status: "applied", actor };
    }

    if (kind === "actor-link.inspect") return { status: "review", current: inspectManagedActorLink(actor).review };
    if (kind === "actor-link.apply") return applyManagedActorLinkConversion(actor, command);
    if (kind === "actor-link.rollback") return rollbackManagedActorLinkConversion(actor);
    if (kind === "actor.update") return applyManagedActorDocumentUpdate(actor, command);
    if (kind === "item.create") return applyManagedItemCreate(actor, command);
    if (kind === "item.delete") return applyManagedItemDelete(actor, command);
    if (kind === "effect.create") return applyManagedEffectCreate(actor, command);
    if (kind === "effect.delete") return applyManagedEffectDelete(actor, command);

    if (kind === "item.update") {
        const item = findManagedCommandItem(actor, command.target || {});
        if (!item) return { status: "conflict", error: "Elemento non trovato nell'Actor" };
        return applyManagedDocumentPatches(item, command.patches, async (update) => {
            let requestedActivities = foundry.utils.getProperty(update, "system.activities");
            let requestedEffects = update.effects;
            const midiConfig = foundry.utils.getProperty(update, "flags.khuzoe-automations.midiRollConfig");
            if (midiConfig !== undefined) {
                validateManagedMidiRollConfig(midiConfig, requestedActivities ?? readManagedCommandPath(item, "system.activities"));
            }
            const requestedRules = foundry.utils.getProperty(update, "flags.khuzoe-automations.npcRules")
                ?? (command.patches.some(patch => patch.path === "flags.khuzoe-automations.npcRules")
                    ? readManagedCommandPath(item, "flags.khuzoe-automations.npcRules") : undefined);
            if (requestedRules !== undefined || (requestedActivities !== undefined && item.flags?.["khuzoe-automations"]?.npcRules)) {
                const compiler = game.modules?.get("khuzoe-automations")?.api?.npcRules;
                if (compiler?.version !== 1) throw new Error("Ricarica Foundry con Khuzoe Automations aggiornato e attivo per usare i preset NPC.");
                const compiled = compiler.prepare({
                    rules: requestedRules ?? item.flags["khuzoe-automations"].npcRules,
                    activities: requestedActivities ?? readManagedCommandPath(item, "system.activities"),
                    effects: requestedEffects ?? getManagedItemEffects(item),
                    itemName: update.name ?? item.name, statusEffects: CONFIG.statusEffects
                });
                requestedActivities = compiled.activities;
                requestedEffects = compiled.effects;
            }
            const currentActivities = requestedActivities === undefined
                ? null
                : readManagedCommandPath(item, "system.activities");
            // Validate all new embedded data before performing the first write.
            if (requestedEffects !== undefined) validateManagedItemEffects(item, requestedEffects);
            if (requestedActivities !== undefined || requestedEffects !== undefined) {
                if (requestedActivities !== undefined) managedActivityChanges(currentActivities, requestedActivities);
                const ids = new Set((requestedEffects ?? getManagedItemEffects(item)).map(effect => effect._id));
                for (const activity of Object.values(requestedActivities ?? readManagedCommandPath(item, "system.activities"))) {
                    if ((activity.effects ?? []).some(effect => !ids.has(effect._id))) throw new Error("Un'attività fa riferimento a un effetto mancante.");
                }
            }
            const itemUpdate = foundry.utils.deepClone(update);
            if (item.type === "spell") modernizeSpellPreparationUpdate(itemUpdate, item.system);
            if (requestedActivities !== undefined) deleteManagedCommandPath(itemUpdate, "system.activities");
            delete itemUpdate.effects;
            for (const patch of command.patches.filter(patch => patch.path.startsWith("flags."))) {
                const wanted = foundry.utils.getProperty(update, patch.path);
                if (wanted !== undefined) writeManagedCommandPath(itemUpdate, patch.path,
                    managedFlagReplacement(readManagedCommandPath(item, patch.path), wanted));
            }
            // Embedded effects are Documents. Never submit them as ordinary Item properties.
            if (requestedEffects !== undefined) await applyManagedItemEffects(item, requestedEffects, false);
            if (managedCommandObjectHasValues(itemUpdate)) {
                await actor.updateEmbeddedDocuments("Item", [{ _id: item.id, ...itemUpdate }], { criptaWikiSyncCommand: true });
            }
            if (requestedActivities !== undefined) {
                const refreshedItem = actor.items.get(item.id) || item;
                await applyManagedActivitiesUpdate(refreshedItem, currentActivities, requestedActivities);
            }
            if (requestedEffects !== undefined) await applyManagedItemEffects(actor.items.get(item.id) || item, requestedEffects, true);
            const persisted = actor.items.get(item.id) || item;
            for (const patch of command.patches.filter(patch => patch.path.startsWith("flags."))) {
                const wanted = foundry.utils.getProperty(update, patch.path);
                if (wanted !== undefined && !sameManagedCommandValue(readManagedCommandPath(persisted, patch.path), wanted)) {
                    throw new Error(`Foundry non ha conservato ${patch.path}`);
                }
            }
        }, actor, command.patches.some(patch => patch.path === "flags.khuzoe-automations.npcRules"));
    }

    const effect = findManagedCommandEffect(actor, command.target || {});
    if (!effect) return { status: "conflict", error: "Effetto non trovato nell'Actor" };
    return applyManagedDocumentPatches(effect, command.patches, async (update) => {
        const v14Update = foundry.utils.deepClone(update);
        if (Object.hasOwn(v14Update, "changes")) {
            v14Update["system.changes"] = normalizeActiveEffectChangesV14(v14Update.changes);
            delete v14Update.changes;
        }
        await actor.updateEmbeddedDocuments("ActiveEffect", [{ _id: effect.id, ...v14Update }], { criptaWikiSyncCommand: true });
    }, actor);
}

function findManagedCommandItem(actor, target = {}) {
    return actor.items.get(String(target.itemId || ""))
        || Array.from(actor.items || []).find((entry) => String(getItemTransferId(entry) || "") === String(target.transferId || ""));
}

function findManagedCommandEffect(actor, target = {}) {
    return actor.effects.get(String(target.effectId || ""))
        || Array.from(actor.effects || []).find((entry) => String(entry.getFlag?.(MODULE_ID, "clientId") || "") === String(target.clientId || ""));
}

function normalizeManagedPatchForFoundry(patch) {
    if (patch?.path !== "img") return patch;
    const normalize = (value) => {
        const text = String(value || "").trim();
        return text && (text.startsWith("media/") || extractWorkerMediaPath(text)) ? toWorkerMediaUrl(text) : value;
    };
    return { ...patch, value: normalize(patch.value), baseValue: normalize(patch.baseValue) };
}

function managedCommandChangedPaths(baseValue, desiredValue, path = [], output = []) {
    if (sameManagedCommandValue(baseValue, desiredValue)) return output;
    if (Array.isArray(baseValue) && Array.isArray(desiredValue) && baseValue.length === desiredValue.length) {
        baseValue.forEach((entry, index) => managedCommandChangedPaths(entry, desiredValue[index], [...path, String(index)], output));
        return output;
    }
    const baseObject = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue);
    const desiredObject = desiredValue && typeof desiredValue === "object" && !Array.isArray(desiredValue);
    if (baseObject && desiredObject) {
        const keys = new Set([...Object.keys(baseValue), ...Object.keys(desiredValue)]);
        keys.forEach((key) => managedCommandChangedPaths(baseValue[key], desiredValue[key], [...path, key], output));
        return output;
    }
    output.push(path);
    return output;
}

function managedCommandRelativeValue(value, path) {
    return path.reduce((entry, key) => entry?.[key], value);
}

function sameManagedCommandPatchValue(path, left, right) {
    if (path === "system.attributes.init.bonus") {
        const normalizeInitiative = (value) => (
            value === null || value === undefined || value === "" || Number(value) === 0
                ? 0
                : value
        );
        return sameManagedCommandValue(normalizeInitiative(left), normalizeInitiative(right));
    }
    return sameManagedCommandValue(left, right);
}

function writeManagedCommandRelativeValue(value, path, desiredValue) {
    if (!path.length) return foundry.utils.deepClone(desiredValue);
    const root = value && typeof value === "object"
        ? foundry.utils.deepClone(value)
        : (/^\d+$/.test(path[0]) ? [] : {});
    let cursor = root;
    for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index];
        const nextKey = path[index + 1];
        if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = /^\d+$/.test(nextKey) ? [] : {};
        cursor = cursor[key];
    }
    const finalKey = path[path.length - 1];
    if (desiredValue === undefined) delete cursor[finalKey];
    else cursor[finalKey] = foundry.utils.deepClone(desiredValue);
    return root;
}

function resolveManagedCommandPatch(currentValue, patch) {
    if (sameManagedCommandPatchValue(patch?.path, currentValue, patch.value)) {
        return { value: currentValue, changed: false, conflict: false };
    }
    const changedPaths = managedCommandChangedPaths(patch.baseValue, patch.value);
    if (!changedPaths.length) return { value: currentValue, changed: false, conflict: false };
    let merged = foundry.utils.deepClone(currentValue);
    let changed = false;
    for (const path of changedPaths) {
        const currentPart = managedCommandRelativeValue(currentValue, path);
        const desiredPart = managedCommandRelativeValue(patch.value, path);
        if (sameManagedCommandValue(currentPart, desiredPart)) continue;
        const basePart = managedCommandRelativeValue(patch.baseValue, path);
        if (!sameManagedCommandPatchValue(patch?.path, currentPart, basePart)) {
            return { value: currentValue, changed: false, conflict: true };
        }
        merged = writeManagedCommandRelativeValue(merged, path, desiredPart);
        changed = true;
    }
    return { value: merged, changed, conflict: false };
}
async function applyManagedDocumentPatches(documentValue, rawPatches, applyUpdate, actor, alwaysApply = false) {
    const patches = (Array.isArray(rawPatches) ? rawPatches : []).map(normalizeManagedPatchForFoundry);
    if (!patches.length) return { status: "failed", error: "Comando senza modifiche" };
    const current = {};
    const resolved = new Map();
    for (const patch of patches) {
        const currentValue = readManagedCommandPath(documentValue, patch.path);
        current[patch.path] = currentValue;
        const resolution = resolveManagedCommandPatch(currentValue, patch);
        if (resolution.conflict) {
            return { status: "conflict", error: `Il campo ${patch.path} e cambiato anche in Foundry`, current };
        }
        resolved.set(patch, resolution.value);
    }
    const update = {};
    for (const patch of patches) {
        const desiredValue = resolved.get(patch);
        if (!sameManagedCommandPatchValue(patch.path, readManagedCommandPath(documentValue, patch.path), desiredValue)) {
            writeManagedCommandPath(update, patch.path, desiredValue);
        }
    }
    if (Object.keys(update).length || alwaysApply) {
        try {
            await applyUpdate(update);
        } catch (error) {
            return {
                status: "failed",
                error: String(error?.message || "Foundry non ha accettato la modifica"),
                current: Object.fromEntries(patches.map((patch) => [patch.path, readManagedCommandPath(documentValue, patch.path)]))
            };
        }
    }
    return { status: "applied", actor };
}

async function applyManagedActorDocumentUpdate(actor, command) {
    if ((command?.patches || []).some((patch) => patch.path === "system.attributes.prof")) {
        return { status: "failed", error: "Il bonus di competenza è calcolato da D&D5e. Modifica il GS, il livello o l'effetto che lo determina." };
    }
    // actorLink and resource bars are local Foundry state. Never apply them from
    // website commands, including commands queued by an older module version.
    const safePatches = (Array.isArray(command?.patches) ? command.patches : [])
        .filter((patch) => patch?.path !== "prototypeToken.actorLink")
        .filter((patch) => !/^prototypeToken\.(displayBars|bar1|bar2)(\.|$)/.test(String(patch?.path || "")));
    if (!safePatches.length) return { status: "applied", actor };
    const overridden = safePatches.filter((patch) => foundry.utils.getProperty(actor.overrides || {}, patch.path) !== undefined);
    if (overridden.length) return {
        status: "failed",
        error: `Valori controllati da effetti attivi: ${overridden.map((patch) => patch.path).join(", ")}. Modifica l'effetto in Foundry prima di cambiare questi valori dal sito.`,
        current: Object.fromEntries(overridden.map((patch) => [patch.path, readManagedCommandPath(actor, patch.path)]))
    };
    const namePatch = safePatches.find((patch) => patch?.path === "name");
    const requestedName = String(namePatch?.value || "").trim();
    const result = await applyManagedDocumentPatches(actor, safePatches, async (update) => {
        if (typeof update.name === "string" && update.name.trim()) update["prototypeToken.name"] = update.name.trim();
        await actor.update(update, { criptaWikiSyncCommand: true });
    }, actor);
    if (result.status === "applied") {
        const current = Object.fromEntries(safePatches.map((patch) => [patch.path, readManagedCommandPath(actor, patch.path)]));
        const rejected = safePatches.filter((patch) => managedCommandChangedPaths(patch.baseValue, patch.value)
            .some((path) => !sameManagedCommandPatchValue(patch.path,
                managedCommandRelativeValue(current[patch.path], path),
                managedCommandRelativeValue(patch.value, path))));
        if (rejected.length) return {
            status: "failed",
            error: `Foundry non ha mantenuto il valore richiesto per: ${rejected.map((patch) => patch.path).join(", ")}. Controlla campi calcolati, effetti o limiti della scheda.`,
            current
        };
    }
    if (result.status === "applied" && requestedName) {
        if (String(actor.prototypeToken?.name || "") !== requestedName) {
            await actor.update({ "prototypeToken.name": requestedName }, { criptaWikiSyncCommand: true });
        }
        await updatePlacedTokenNames(actor, requestedName);
    }
    return result;
}

async function applyManagedItemCreate(actor, command) {
    const source = command.document || {};
    const transferId = String(command.target?.transferId || source.transferId || "");
    const existing = transferId ? Array.from(actor.items || []).find((entry) => String(getItemTransferId(entry) || "") === transferId) : null;
    if (existing) return { status: "applied", actor };
    const campaignItemId = sanitizeId(source.campaignItemId || "");
    const libraryItem = campaignItemId
        ? Array.from(game.items || []).find((entry) => sanitizeId(entry.getFlag?.(MODULE_ID, "campaignItemId") || entry.getFlag?.(MODULE_ID, "wikiItemId")) === campaignItemId)
        : null;
    const librarySource = libraryItem?.toObject?.() || null;
    const itemFlags = foundry.utils.mergeObject(foundry.utils.deepClone(librarySource?.flags || {}), {
        [MODULE_ID]: {
            ...(librarySource?.flags?.[MODULE_ID] || {}),
            transferId: transferId || `item-${crypto.randomUUID?.() || Date.now().toString(36)}`,
            ...(campaignItemId ? { campaignItemId, campaignLibraryUuid: String(libraryItem?.uuid || "") } : {})
        },
        ...(libraryItem?.uuid ? { core: { ...(librarySource?.flags?.core || {}), sourceId: libraryItem.uuid } } : {})
    }, { inplace: false });
    const data = {
        name: String(librarySource?.name || source.name || "Nuovo elemento"),
        type: String(librarySource?.type || source.type || "feat"),
        ...((librarySource?.img || source.img) ? { img: librarySource?.img || toWorkerMediaUrl(source.img) } : {}),
        system: foundry.utils.deepClone(librarySource?.system || source.system || {}),
        effects: foundry.utils.deepClone(librarySource?.effects || (Array.isArray(source.effects) ? source.effects : [])),
        flags: itemFlags
    };
    await actor.createEmbeddedDocuments("Item", [data], { criptaWikiSyncCommand: true });
    return { status: "applied", actor };
}

async function applyManagedItemDelete(actor, command) {
    const item = findManagedCommandItem(actor, command.target || {});
    if (!item) return { status: "applied", actor };
    await actor.deleteEmbeddedDocuments("Item", [item.id], { criptaWikiSyncCommand: true });
    return { status: "applied", actor };
}

async function applyManagedEffectCreate(actor, command) {
    const source = command.document || {};
    const clientId = String(command.target?.clientId || source.clientId || "");
    const existing = clientId ? findManagedCommandEffect(actor, { clientId }) : null;
    if (existing) return { status: "applied", actor };
    const data = normalizeActiveEffectSourceV14({
        name: String(source.name || "Nuovo effetto"),
        ...(source.img ? { img: toWorkerMediaUrl(source.img) } : {}),
        disabled: source.disabled === true,
        duration: foundry.utils.deepClone(source.duration || {}),
        system: { ...(source.system || {}), changes: getActiveEffectChanges(source) },
        statuses: Array.isArray(source.statuses) ? source.statuses : [],
        flags: { [MODULE_ID]: { clientId: clientId || `effect-${crypto.randomUUID?.() || Date.now().toString(36)}` } }
    });
    await actor.createEmbeddedDocuments("ActiveEffect", [data], { criptaWikiSyncCommand: true });
    return { status: "applied", actor };
}

async function applyManagedEffectDelete(actor, command) {
    const effect = findManagedCommandEffect(actor, command.target || {});
    if (!effect) return { status: "applied", actor };
    await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { criptaWikiSyncCommand: true });
    return { status: "applied", actor };
}
function managedActivitiesSourceMap(value) {
    let entries;
    if (Array.isArray(value)) entries = value.map((activity, index) => [activity?._id || activity?.id || String(index), activity]);
    else if (value && typeof value.get === "function" && typeof value.values === "function") {
        entries = Array.from(value.values()).map((activity, index) => [activity?._id || activity?.id || String(index), activity]);
    } else if (value && typeof value === "object") entries = Object.entries(value);
    else entries = [];
    return Object.fromEntries(entries.map(([key, activity]) => {
        const source = activity?.toObject?.(true) || activity?._source || activity || {};
        const id = String(source?._id || activity?._id || activity?.id || key);
        return [id, foundry.utils.deepClone({ ...source, _id: id })];
    }));
}

const MANAGED_ACTIVITY_ARRAY_PATHS = [
    ["consumption", "targets"],
    ["damage", "parts"],
    ["effects"],
    ["profiles"],
    ["uses", "recovery"]
];

function managedActivityUpdatePath(path) {
    for (const arrayPath of MANAGED_ACTIVITY_ARRAY_PATHS) {
        if (arrayPath.every((key, index) => path[index] === key)) return arrayPath;
    }
    return path;
}

function managedActivityChanges(currentActivities, requestedActivities) {
    const current = managedActivitiesSourceMap(currentActivities);
    const requested = managedActivitiesSourceMap(requestedActivities);
    const changedPaths = managedCommandChangedPaths(current, requested);
    const grouped = new Map();
    for (const changedPath of changedPaths) {
        const [activityId, ...relativePath] = changedPath;
        if (!activityId || !relativePath.length || !current[activityId] || !requested[activityId]) {
            throw new Error("Creazione e rimozione delle attivita D&D5e non sono disponibili da questa modifica");
        }
        if (relativePath[0] === "_id") continue;
        if (relativePath[0] === "type") {
            throw new Error("Il tipo di un'attivita D&D5e non puo essere cambiato dal sito");
        }
        const updatePath = managedActivityUpdatePath(relativePath);
        const updateKey = updatePath.join(".");
        const group = grouped.get(activityId) || { changes: {}, verifyPaths: [] };
        group.changes[updateKey] = foundry.utils.deepClone(managedCommandRelativeValue(requested[activityId], updatePath));
        group.verifyPaths.push(relativePath);
        grouped.set(activityId, group);
    }
    return { requested, grouped };
}

async function applyManagedActivitiesUpdate(item, currentActivities, requestedActivities) {
    const { requested, grouped } = managedActivityChanges(currentActivities, requestedActivities);
    if (!grouped.size) return;
    applyingManagedActivityCommands.add(item);
    try {
        for (const [activityId, group] of grouped) {
            const activity = item.system?.activities?.get?.(activityId);
            if (!activity) throw new Error(`Attivita ${activityId} non trovata nell'elemento`);
            if (typeof activity.update !== "function") throw new Error("Aggiornamento attivita D&D5e non disponibile");
            await activity.update(group.changes);
        }
    } finally {
        applyingManagedActivityCommands.delete(item);
    }
    const refreshedItem = item.parent?.items?.get?.(item.id) || item;
    const persisted = managedActivitiesSourceMap(refreshedItem.system?.activities);
    const missingPaths = [];
    for (const [activityId, group] of grouped) {
        for (const path of group.verifyPaths) {
            const actual = managedCommandRelativeValue(persisted[activityId], path);
            const desired = managedCommandRelativeValue(requested[activityId], path);
            if (!sameManagedCommandValue(actual, desired)) missingPaths.push(`${activityId}.${path.join(".")}`);
        }
    }
    if (missingPaths.length) {
        throw new Error(`Foundry non ha conservato le modifiche alle attivita: ${missingPaths.slice(0, 3).join(", ")}`);
    }
}

function readManagedCommandPath(documentValue, path) {
    if (path === "flags.khuzoe-automations.midiRollConfig") return foundry.utils.deepClone(documentValue.flags?.["khuzoe-automations"]?.midiRollConfig ?? {version: 1, activities: {}});
    if (path === "effects" && documentValue?.documentName === "Item") return getManagedItemEffects(documentValue);
    if (path === "flags.khuzoe-automations.npcRules") return foundry.utils.deepClone(documentValue.flags?.["khuzoe-automations"]?.npcRules ?? {version: 1, activities: {}});
    if (["flags.midi-qol", "flags.dae"].includes(path)) return foundry.utils.deepClone(documentValue.flags?.[path.slice(6)] ?? {});
    if (documentValue?.type === "spell" && ["system.preparation", "system.preparation.mode", "system.preparation.prepared"].includes(path)) {
        const preparation = spellPreparationForWiki(documentValue.system);
        return path === "system.preparation" ? preparation : preparation[path.split(".").at(-1)];
    }
    if (path === "changes" && documentValue?.documentName === "ActiveEffect") {
        return getActiveEffectChanges(documentValue);
    }
    const getter = foundry?.utils?.getProperty;
    const value = typeof getter === "function"
        ? getter(documentValue, path)
        : String(path || "").split(".").reduce((entry, key) => entry?.[key], documentValue);
    return path === "system.activities" ? managedActivitiesSourceMap(value) : value;
}

function writeManagedCommandPath(target, path, value) {
    const setter = foundry?.utils?.setProperty;
    if (typeof setter === "function") {
        setter(target, path, value);
        return;
    }
    const keys = String(path || "").split(".");
    let cursor = target;
    while (keys.length > 1) {
        const key = keys.shift();
        cursor[key] ||= {};
        cursor = cursor[key];
    }
    cursor[keys[0]] = value;
}

function deleteManagedCommandPath(target, path) {
    const keys = String(path || "").split(".").filter(Boolean);
    const parents = [];
    let cursor = target;
    for (const key of keys.slice(0, -1)) {
        if (!cursor || typeof cursor !== "object") return;
        parents.push([cursor, key]);
        cursor = cursor[key];
    }
    if (!cursor || typeof cursor !== "object") return;
    delete cursor[keys[keys.length - 1]];
    for (let index = parents.length - 1; index >= 0; index -= 1) {
        const [parent, key] = parents[index];
        const value = parent[key];
        if (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) delete parent[key];
        else break;
    }
}

function managedCommandObjectHasValues(value) {
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry !== undefined;
        return managedCommandObjectHasValues(entry);
    });
}

function sameManagedCommandValue(left, right) {
    const empty = (value) => value === null || value === undefined || value === "";
    if (empty(left) && empty(right)) return true;
    return stableStringify(normalizeManagedCommandComparable(left)) === stableStringify(normalizeManagedCommandComparable(right));
}

function normalizeManagedCommandComparable(value) {
    if (value === null || value === undefined || value === "") return undefined;
    if (value instanceof Set) {
        return Array.from(value)
            .map(normalizeManagedCommandComparable)
            .filter((entry) => entry !== undefined);
    }
    if (Array.isArray(value)) {
        return value
            .map(normalizeManagedCommandComparable)
            .filter((entry) => entry !== undefined);
    }
    if (typeof value === "string") {
        const clean = value.trim();
        if (clean && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) {
            const number = Number(clean);
            if (Number.isFinite(number)) return number;
        }
    }
    if (value && typeof value === "object") {
        const plain = value.toObject ? value.toObject() : value;
        return Object.fromEntries(Object.entries(plain)
            .map(([key, entry]) => [key, normalizeManagedCommandComparable(entry)])
            .filter(([, entry]) => entry !== undefined));
    }
    return value;
}

async function acknowledgeManagedActorCommands(worldId, results = [], createResults = []) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actor-commands/${encodeURIComponent(worldId)}/ack`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url, {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(true), "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: getCampaignId(), results, createResults })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Managed Actor ack HTTP ${response.status}`);
    return payload;
}

function toWorkerMediaUrl(path) {
    const value = String(path || "").trim();
    return /^https?:/i.test(value) ? value : `${DISCORD_WORKER_URL}/${value.replace(/^\/+/, "")}`;
}

function managedVariantSignature(variant, source = "") {
    return hashValue({
        source: stripCacheBust(source || variant?.src || variant?.path),
        name: String(variant?.name || "Variante"),
        width: Number(variant?.width || 1),
        height: Number(variant?.height || variant?.width || 1),
        updatedAt: String(variant?.updatedAt || "")
    });
}

export async function syncManagedActorNow(actor, event = {}) {
    const pullCommandReconciliation = event?.pullCommandReconciliation === true && canRunManagedActorPull(actor);
    if (!canRunManagedActorSync(actor) && !pullCommandReconciliation) return false;
    await callbacks.ensureTransferIds?.(actor);

    const worldId = sanitizeId(game.world?.id || "world");
    const actorId = sanitizeId(actor.id);
    if (!worldId || !actorId) throw new Error("Identit\u00E0 Foundry non valida per Managed Actor.");

    const normalizedEvent = normalizeTokenizerEvent(event);
    const stateRoot = getWorldObjectSetting(STATE_SETTING);
    const mediaOnlyWrite = !normalizedEvent.forceCreate
        && !normalizedEvent.forceContentSync
        && (normalizedEvent.changedTargets.length > 0 || normalizedEvent.variantsChanged || normalizedEvent.removedVariantIds.length > 0);

    if (!mediaOnlyWrite) {
        const knownRecovery = KNOWN_ACTOR_DELTA_RECOVERIES.find((entry) => String(entry.actorId) === String(actor.id));
        if (knownRecovery && actorLooksLikeUninitializedNpc(actor)) {
            throw new Error(`Sync bloccata: ${actor.name} corrisponde a uno statblock protetto ma l'Actor base risulta vuoto. Nessun dato e stato inviato al sito.`);
        }
        const deltaRisk = findSuspiciousActorDelta(actor);
        if (deltaRisk) {
            throw new Error(`Sync bloccata: ${actor.name} ha uno statblock completo nel token ${deltaRisk.token.name || deltaRisk.token.id} della scena ${deltaRisk.scene.name || deltaRisk.scene.id}, mentre l'Actor base sembra vuoto. Recupera prima il delta.`);
        }
    }


    const previousState = stateRoot[actor.id] && typeof stateRoot[actor.id] === "object" ? stateRoot[actor.id] : {};
    const mediaResult = await syncManagedActorMedia(actor, normalizedEvent, previousState, worldId, actorId);
    const link = await callbacks.getActorLink?.(actor) || {};
    const document = buildManagedActorDocument(actor, mediaResult.media, link, mediaResult.state.icons);
    document.mediaWriteTargets = normalizedEvent.changedTargets;
    document.writeScopes = mediaOnlyWrite ? ["media"] : ["content", "media"];
    document.expectedRevision = Math.max(0, Number(previousState.revision || 0));
    document.variantSyncMode = normalizedEvent.forceCreate
        ? "merge"
        : (!Number(previousState.revision || 0) ? "replace" : (normalizedEvent.variantsChanged ? "merge" : "preserve"));
    document.variantSync = document.variantSyncMode !== "preserve";
    document.variantUpsertIds = normalizedEvent.forceCreate
        ? mediaResult.media.variants.map((variant) => variant.id)
        : mediaResult.state.changedVariantIds;
    document.removedVariantIds = normalizedEvent.removedVariantIds;
    document.contentHash = hashValue({
        identity: {
            name: document.name,
            actorType: document.actorType,
            relationshipType: document.relationshipType,
            ownerCharacterId: document.ownerCharacterId,
            ownerAccountIds: document.ownerAccountIds
        },
        definition: document.definition,
        runtime: document.runtime,
        system: document.system
    });
    document.mediaHash = hashValue(document.media);

    const unchanged = !normalizedEvent.forceCreate
        && !normalizedEvent.forceContentSync
        && previousState.contentHash === document.contentHash
        && previousState.mediaHash === document.mediaHash
        && normalizedEvent.removedVariantIds.length === 0;
    if (unchanged) {
        const localStateNeedsUpgrade = Number(previousState.schemaVersion || 0) < MANAGED_STATE_SCHEMA_VERSION
            || (isManagedMerchant(actor) && Number(previousState.merchantSchemaVersion || 0) < MANAGED_MERCHANT_SCHEMA_VERSION)
            || !previousState.runtimeHash;
        if (localStateNeedsUpgrade) {
            await game.settings.set(MODULE_ID, STATE_SETTING, {
                ...stateRoot,
                [actor.id]: {
                    ...previousState,
                    schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
                    merchantSchemaVersion: isManagedMerchant(actor) ? MANAGED_MERCHANT_SCHEMA_VERSION : 0,
                    runtimeHash: hashValue(buildManagedActorRuntime(actor))
                }
            });
        }
        console.info(`${MODULE_ID} | Managed Actor invariato, nessuna chiamata al Worker.`, { actor: actor.name });
        return false;
    }

    const response = await postManagedActor(worldId, actorId, document, { pullCommandReconciliation });
    rememberManagedActorShared(actor, worldId, actorId, document, response);
    const nextState = {
        schemaVersion: MANAGED_STATE_SCHEMA_VERSION,

        contentHash: document.contentHash,
        mediaHash: document.mediaHash,
        revision: response.revision || previousState.revision || 0,
        syncedAt: new Date().toISOString(),
        slots: mediaResult.state.slots,
        variants: mediaResult.state.variants,
        icons: mediaResult.state.icons,
        runtimePolicyOverride: String(previousState.runtimePolicyOverride || ""),
        runtimeHash: hashValue(buildManagedActorRuntime(actor)),
        merchantSchemaVersion: isManagedMerchant(actor) ? MANAGED_MERCHANT_SCHEMA_VERSION : 0
    };
    await game.settings.set(MODULE_ID, STATE_SETTING, { ...stateRoot, [actor.id]: nextState });
    console.info(`${MODULE_ID} | Managed Actor sincronizzato.`, {
        actor: actor.name,
        actorId,
        saved: response.saved,
        revision: response.revision,
        reason: normalizedEvent.reason,
        media: mediaResult.uploaded
    });
    return true;
}

async function queueManagedActorSync(actor, event) {
    if (!canRunManagedActorSync(actor)) return false;
    const actorId = String(actor?.id || "");
    if (!actorId) return;
    const next = mergeTokenizerEvents(pendingJobs.get(actorId), normalizeTokenizerEvent(event));
    pendingJobs.set(actorId, next);
    const stored = getWorldObjectSetting(PENDING_SETTING);
    await game.settings.set(MODULE_ID, PENDING_SETTING, { ...stored, [actorId]: next });
    // Use a fixed collection window from the first edit. Further edits are folded
    // into the same job without postponing the upload indefinitely.
    if (!pendingTimers.has(actorId)) scheduleManagedActorFlush(actorId, SYNC_BATCH_WINDOW_MS);
}

function scheduleManagedActorFlush(actorId, delay) {
    window.clearTimeout(pendingTimers.get(actorId));
    pendingTimers.set(actorId, window.setTimeout(() => {
        pendingTimers.delete(actorId);
        enqueueManagedActorFlush(actorId);
    }, delay));
}

function enqueueManagedActorFlush(actorId) {
    managedActorFlushChain = managedActorFlushChain
        .catch(() => undefined)
        .then(() => flushManagedActor(actorId));
    return managedActorFlushChain;
}

async function flushManagedActor(actorId) {
    const actor = game.actors.get(actorId);
    const event = pendingJobs.get(actorId);
    if (!actor || !event || !canRunManagedActorSync(actor)) return;
    try {
        await syncManagedActorNow(actor, event);
        // An edit may arrive while the Worker request is in flight. Never erase
        // the newer merged job when acknowledging the snapshot just sent.
        if (pendingJobs.get(actorId) !== event) {
            if (!pendingTimers.has(actorId)) scheduleManagedActorFlush(actorId, SYNC_BATCH_WINDOW_MS);
            return;
        }
        pendingJobs.delete(actorId);
        const stored = getWorldObjectSetting(PENDING_SETTING);
        const next = { ...stored };
        delete next[actorId];
        await game.settings.set(MODULE_ID, PENDING_SETTING, next);
        const latest = pendingJobs.get(actorId);
        if (latest) {
            const freshStored = getWorldObjectSetting(PENDING_SETTING);
            await game.settings.set(MODULE_ID, PENDING_SETTING, { ...freshStored, [actorId]: latest });
            if (!pendingTimers.has(actorId)) scheduleManagedActorFlush(actorId, SYNC_BATCH_WINDOW_MS);
        }
    } catch (error) {
        if (error?.code === "VERSION_CONFLICT") {
            try {
                await realignManagedActorAfterConflict(actor, error.currentRevision);
                console.info(`${MODULE_ID} | Revisione Managed Actor riallineata; sincronizzazione nuovamente in coda.`, {
                    actor: actor.name,
                    revision: error.currentRevision
                });
                scheduleManagedActorFlush(actorId, 2_500);
                return;
            } catch (pullError) {
                console.warn(`${MODULE_ID} | Riallineamento dopo conflitto Managed Actor fallito.`, { actor: actor.name, error: pullError });
            }
        }
        console.warn(`${MODULE_ID} | Sync Managed Actor fallita; resta in coda.`, { actor: actor.name, error });
        scheduleManagedActorFlush(actorId, RETRY_DELAY_MS);
    }
}

function canRunManagedActorSync(actor = null) {
    if (!canPushToWorker()) return false;
    return canOwnManagedActorSync(actor);
}

function getManagedItemEffects(item) {
    return Array.from(item.effects ?? []).map(effect => {
        const source = effect.toObject ? effect.toObject() : foundry.utils.deepClone(effect._source ?? effect);
        delete source._stats;
        return source;
    }).sort((left, right) => String(left._id).localeCompare(String(right._id)));
}

function managedFlagReplacement(current, desired) {
    if (!desired || typeof desired !== "object" || Array.isArray(desired)) return desired;
    const result = {};
    for (const key of Object.keys(current ?? {})) if (!Object.hasOwn(desired, key)) result[`-=${key}`] = null;
    for (const [key, value] of Object.entries(desired)) result[key] = managedFlagReplacement(current?.[key], value);
    return result;
}

function managedContainsRequestedValue(actual, desired) {
    if (desired && typeof desired === "object" && !Array.isArray(desired)) {
        return Object.entries(desired).every(([key, value]) => managedContainsRequestedValue(actual?.[key], value));
    }
    return sameManagedCommandValue(actual, desired);
}

function validateManagedItemEffects(item, effects) {
    if (!Array.isArray(effects) || effects.length > 64 || JSON.stringify(effects).length > 64 * 1024) throw new Error("Troppi effetti o dati effetto troppo grandi.");
    const ids = new Set();
    for (const effect of effects) {
        if (!/^[A-Za-z0-9]{16}$/.test(effect?._id ?? "") || ids.has(effect._id)) throw new Error("Gli effetti richiedono ID Foundry distinti di 16 caratteri.");
        ids.add(effect._id);
        if (!effect.name || !Array.isArray(effect.statuses ?? [])) throw new Error("Effetto non valido.");
        const normalized = normalizeActiveEffectSourceV14(effect);
        const EffectClass = item.effects?.documentClass ?? globalThis.CONFIG?.ActiveEffect?.documentClass;
        if (EffectClass) new EffectClass(normalized, {parent: item, strict: true});
    }
}

async function applyManagedItemEffects(item, effects, removeObsolete) {
    const existing = new Map(getManagedItemEffects(item).map(effect => [effect._id, effect]));
    const options = {criptaWikiSyncCommand: true, keepId: true};
    if (removeObsolete) {
        const requestedIds = new Set(effects.map(effect => effect._id));
        const obsolete = [...existing.keys()].filter(id => !requestedIds.has(id));
        if (obsolete.length) await item.deleteEmbeddedDocuments("ActiveEffect", obsolete, options);
        const persisted = new Map(getManagedItemEffects(item.parent?.items?.get?.(item.id) ?? item).map(effect => [effect._id, effect]));
        if (persisted.size !== requestedIds.size || [...persisted.keys()].some(id => !requestedIds.has(id))) {
            throw new Error("Foundry non ha conservato l'elenco degli effetti richiesto.");
        }
        for (const effect of effects) {
            const actual = persisted.get(effect._id);
            const normalized = normalizeActiveEffectSourceV14(effect);
            // Foundry adds schema defaults; compare only fields explicitly supplied.
            if (!actual || !managedContainsRequestedValue(actual, normalized)) {
                throw new Error(`Foundry non ha conservato l'effetto ${effect.name}`);
            }
        }
        return;
    }
    const creates = effects.filter(effect => !existing.has(effect._id)).map(normalizeActiveEffectSourceV14);
    const updates = effects.filter(effect => existing.has(effect._id) && !sameManagedCommandValue(existing.get(effect._id), normalizeActiveEffectSourceV14(effect)))
        .map(effect => ({...normalizeActiveEffectSourceV14(effect)}));
    if (creates.length) await item.createEmbeddedDocuments("ActiveEffect", creates, options);
    if (updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates, {...options, recursive: false});
}

function canRunManagedActorPull(actor = null) {
    if (!canPullFromWorker()) return false;
    return canOwnManagedActorSync(actor);
}

function canOwnManagedActorSync(actor = null) {
    if (isTemporaryWikiActor(actor)) return false;
    if (!game.user?.isGM) return false;
    if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return false;
    return !actor || actor.documentName === "Actor";
}

function actorDeltaCollectionSources(collection, fallback = []) {
    const values = Array.from(collection?.contents || collection || []);
    const sources = values
        .map((entry) => entry?.toObject ? entry.toObject(false) : foundry.utils.deepClone(entry))
        .filter((entry) => entry && typeof entry === "object");
    if (sources.length) return sources;
    return (Array.isArray(fallback) ? fallback : []).map((entry) => foundry.utils.deepClone(entry));
}

function readTokenActorDeltaSnapshot(token) {
    const deltaDocument = token?.delta;
    const fallback = token?._source?.delta;
    const delta = deltaDocument?.toObject
        ? deltaDocument.toObject(false)
        : foundry.utils.deepClone(fallback && typeof fallback === "object" ? fallback : {});
    if (!delta || typeof delta !== "object" || !Object.keys(delta).length) return null;
    return {
        token: token?.toObject ? token.toObject(false) : foundry.utils.deepClone(token?._source || {}),
        delta,
        items: actorDeltaCollectionSources(deltaDocument?.items, delta.items),
        effects: actorDeltaCollectionSources(deltaDocument?.effects, delta.effects)
    };
}

function actorLooksLikeUninitializedNpc(actor) {
    if (!actor || actor.type !== "npc" || Number(actor.items?.size || 0) > 0) return false;
    const abilities = ["str", "dex", "con", "int", "wis", "cha"].map((key) => Number(actor.system?.abilities?.[key]?.value));
    const allDefaultAbilities = abilities.every((value) => value === 10);
    const ac = Number(actor.system?.attributes?.ac?.flat ?? actor.system?.attributes?.ac?.value ?? 10);
    const cr = Number(actor.system?.details?.cr ?? 0);
    return allDefaultAbilities && ac === 10 && cr <= 0.25;
}

function findSuspiciousActorDelta(actor) {
    if (!actorLooksLikeUninitializedNpc(actor)) return null;
    for (const scene of game.scenes || []) {
        for (const token of scene.tokens || []) {
            if (String(token.actorId || "") !== String(actor.id || "")) continue;
            const snapshot = readTokenActorDeltaSnapshot(token);
            if (!snapshot || snapshot.items.length < 3) continue;
            const abilities = snapshot.delta?.system?.abilities || {};
            const changedAbility = ["str", "dex", "con", "int", "wis", "cha"]
                .some((key) => Number(abilities?.[key]?.value) !== 10 && Number.isFinite(Number(abilities?.[key]?.value)));
            if (changedAbility) return { scene, token, snapshot };
        }
    }
    return null;
}

function knownRecoverySnapshotIsValid(snapshot, specification) {
    if (!snapshot?.delta?.system || !Array.isArray(snapshot.items)) return false;
    const system = snapshot.delta.system;
    const itemNames = new Set(snapshot.items.map((item) => String(item?.name || "")));
    return Number(system.abilities?.str?.value) === 24
        && Number(system.abilities?.con?.value) === 18
        && Number(system.attributes?.ac?.flat ?? system.attributes?.ac?.value) === 16
        && Number(system.attributes?.hp?.max) === 203
        && Number(system.details?.cr) === 10
        && specification.expectedItemNames.every((name) => itemNames.has(name));
}

function managedActorRecoverySummary(actor) {
    return {
        abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
            .map((key) => [key, Number(actor.system?.abilities?.[key]?.value)])),
        ac: Number(actor.system?.attributes?.ac?.flat ?? actor.system?.attributes?.ac?.value),
        hpMax: Number(actor.system?.attributes?.hp?.max),
        cr: Number(actor.system?.details?.cr),
        itemIds: Array.from(actor.items || []).map((item) => String(item.id || "")),
        itemNames: Array.from(actor.items || []).map((item) => String(item.name || ""))
    };
}

async function applyKnownActorDeltaRecovery(actor, snapshot) {
    const flattenedSystem = foundry.utils.flattenObject(foundry.utils.deepClone(snapshot.delta.system || {}));
    const systemUpdate = Object.fromEntries(Object.entries(flattenedSystem)
        .filter(([path]) => path && !path.startsWith("_"))
        .map(([path, value]) => [`system.${path}`, value]));
    if (Object.keys(systemUpdate).length) {
        await actor.update(systemUpdate, {
            criptaWikiSyncCommand: true,
            criptaManagedActorRecovery: true,
            render: false
        });
    }

    const missingItems = snapshot.items.filter((item) => item?._id && !actor.items?.get(item._id));
    if (missingItems.length) {
        await actor.createEmbeddedDocuments("Item", missingItems.map((item) => foundry.utils.deepClone(item)), {
            keepId: true,
            renderSheet: false,
            criptaWikiSyncCommand: true,
            criptaManagedActorRecovery: true
        });
    }

    const missingEffects = snapshot.effects.filter((effect) => effect?._id && !actor.effects?.get(effect._id));
    if (missingEffects.length) {
        await actor.createEmbeddedDocuments("ActiveEffect", missingEffects.map((effect) => foundry.utils.deepClone(effect)), {
            keepId: true,
            renderSheet: false,
            criptaWikiSyncCommand: true,
            criptaManagedActorRecovery: true
        });
    }
}

async function recoverKnownActorDeltas() {
    if (!canRunManagedActorSync()) return false;
    let recoveryRoot = getWorldObjectSetting(RECOVERY_SETTING);
    let recovered = 0;

    for (const specification of KNOWN_ACTOR_DELTA_RECOVERIES) {
        const actor = game.actors.get(specification.actorId);
        if (!actor) continue;
        const existingEntry = recoveryRoot[specification.actorId];
        if (existingEntry?.status === "complete") continue;
        if (knownRecoverySnapshotIsValid({
            delta: { system: actor.system || {} },
            items: Array.from(actor.items || []).map((item) => ({ name: item.name }))
        }, specification)) {
            recoveryRoot = {
                ...recoveryRoot,
                [specification.actorId]: {
                    ...(existingEntry || {}),
                    status: "complete",
                    completedAt: new Date().toISOString(),
                    source: "actor-already-valid",
                    after: managedActorRecoverySummary(actor)
                }
            };
            await game.settings.set(MODULE_ID, RECOVERY_SETTING, recoveryRoot);
            continue;
        }

        let snapshot = existingEntry?.snapshot || null;
        if (!snapshot) {
            const scene = game.scenes.get(specification.sceneId);
            const token = scene?.tokens?.get(specification.tokenId);
            if (!token || String(token.actorId || "") !== specification.actorId) {
                console.warn(`${MODULE_ID} | Recupero ${specification.label} non avviato: token sorgente non trovato.`);
                continue;
            }
            snapshot = readTokenActorDeltaSnapshot(token);
            if (!snapshot || String(snapshot.delta?._id || "") !== specification.deltaId || !knownRecoverySnapshotIsValid(snapshot, specification)) {
                console.error(`${MODULE_ID} | Recupero ${specification.label} bloccato: il delta non corrisponde allo statblock atteso.`);
                continue;
            }
            recoveryRoot = {
                ...recoveryRoot,
                [specification.actorId]: {
                    status: "prepared",
                    preparedAt: new Date().toISOString(),
                    actorId: specification.actorId,
                    sceneId: specification.sceneId,
                    tokenId: specification.tokenId,
                    beforeActor: actor.toObject(false),
                    snapshot
                }
            };
            await game.settings.set(MODULE_ID, RECOVERY_SETTING, recoveryRoot);
        }

        try {
            if (!knownRecoverySnapshotIsValid(snapshot, specification)) {
                throw new Error("Backup delta non valido");
            }
            await applyKnownActorDeltaRecovery(actor, snapshot);
            const after = managedActorRecoverySummary(actor);
            const itemNames = new Set(after.itemNames);
            const verified = after.abilities.str === 24
                && after.abilities.con === 18
                && after.ac === 16
                && after.hpMax === 203
                && after.cr === 10
                && specification.expectedItemNames.every((name) => itemNames.has(name));
            if (!verified) throw new Error("Verifica dello statblock recuperato non superata");

            recoveryRoot = {
                ...recoveryRoot,
                [specification.actorId]: {
                    ...recoveryRoot[specification.actorId],
                    status: "complete",
                    completedAt: new Date().toISOString(),
                    after
                }
            };
            await game.settings.set(MODULE_ID, RECOVERY_SETTING, recoveryRoot);
            await queueManagedActorSync(actor, {
                reason: "actor-delta-recovery",
                forceCreate: !hasManagedActorState(actor),
                forceContentSync: true,
                allowMissingBaseMedia: true
            });
            recovered += 1;
            ui.notifications.info(`Statblock di ${specification.label} recuperato e verificato. Il delta originale e il backup sono stati conservati.`);
        } catch (error) {
            recoveryRoot = {
                ...recoveryRoot,
                [specification.actorId]: {
                    ...recoveryRoot[specification.actorId],
                    status: "failed",
                    failedAt: new Date().toISOString(),
                    error: String(error?.message || error)
                }
            };
            await game.settings.set(MODULE_ID, RECOVERY_SETTING, recoveryRoot);
            console.error(`${MODULE_ID} | Recupero ${specification.label} fallito; backup conservato.`, error);
            ui.notifications.error(`Recupero di ${specification.label} non completato. Nessun dato sorgente e stato eliminato.`);
        }
    }

    return recovered > 0;
}

function hasManagedActorState(actor) {
    if (isTemporaryWikiActor(actor)) return false;
    const state = getWorldObjectSetting(STATE_SETTING);
    return Boolean(actor?.id && Number(state[actor.id]?.revision || 0) > 0);
}

function getTokenizerSyncEvent(actor, changes = {}) {
    const flattened = flattenManagedChanges(changes);
    const changedPaths = Object.keys(flattened || {});
    const carriesSyncEvent = changedPaths.some((path) => path === TOKENIZER_SYNC_EVENT_PATH || path.startsWith(`${TOKENIZER_SYNC_EVENT_PATH}.`));
    if (!carriesSyncEvent) return null;

    const event = actor?.getFlag?.(TOKENIZER_MODULE_ID, "syncEvent");
    if (!event || typeof event !== "object" || !String(event.eventId || "").trim()) return null;
    return event;
}

function isInternalCriptaDocumentUpdate(options = {}) {
    return Boolean(options?.criptaWikiSyncCommand
        || options?.criptaCampaignItemSync
        || options?.criptaManagedMediaMaintenance);
}

export async function queueManagedActorContentSync(actor, reason = "actor-content-update") {
    if (!canRunManagedActorSync(actor) || !hasManagedActorState(actor)) return false;
    await queueManagedActorSync(actor, { reason });
    return true;
}

function queueManagedItemOwnerSync(item, reason, options = {}) {
    if (isInternalCriptaDocumentUpdate(options) || applyingManagedActivityCommands.has(item)) return;
    const actor = item?.parent;
    if (managedActorLinkConversions.has(String(actor?.id || "")) || managedActorLinkNativeImports.has(String(actor?.id || ""))) return;
    if (!canRunManagedActorSync(actor) || !hasManagedActorState(actor)) return;
    queueManagedActorSync(actor, { reason }).catch((error) => console.warn(`${MODULE_ID} | Sync elemento modificato non accodata.`, { item: item?.name, error }));
}

function queueManagedEffectOwnerSync(effect, reason, options = {}) {
    if (isInternalCriptaDocumentUpdate(options)) return;
    const actor = effect?.parent;
    if (managedActorLinkConversions.has(String(actor?.id || "")) || managedActorLinkNativeImports.has(String(actor?.id || ""))) return;
    if (!canRunManagedActorSync(actor) || !hasManagedActorState(actor)) return;
    queueManagedActorSync(actor, { reason }).catch((error) => console.warn(`${MODULE_ID} | Sync effetto modificato non accodata.`, { effect: effect?.name, error }));
}
function flattenManagedChanges(changes = {}) {
    const flatten = foundry?.utils?.flattenObject;
    return typeof flatten === "function" ? flatten(changes) : changes;
}

function getManagedActorTokenState(actor) {
    const actorType = String(actor?.type || "").trim().toLowerCase();
    const rawActorLink = actor?.prototypeToken?.actorLink;
    const actorLink = typeof rawActorLink === "boolean" ? rawActorLink : true;
    const perInstance = actorType === "npc" && actorLink === false;
    return {
        actorLink,
        mode: perInstance ? "per-instance" : "shared",
        entityKind: perInstance ? "creature" : "person"
    };
}

function managedActorUsesSharedRuntime(actor) {
    return getManagedActorTokenState(actor).mode === "shared";
}

function hasManagedLinkedPrototypeChanges(changes = {}) {
    const paths = Object.keys(flattenManagedChanges(changes) || {});
    return paths.some((path) => path === "name"
        || path === "prototypeToken.name"
        || /^prototypeToken\.(width|height|displayName)(\.|$)/.test(path)
        || /^prototypeToken\.texture\.(src|scaleX|scaleY|offsetX|offsetY|rotation|tint|alphaThreshold)$/.test(path));
}

function isManagedRuntimePath(path) {
    return /^system\.attributes\.hp\.(value|temp|tempmax|max)$/.test(path)
        || /^system\.spells\.(spell\d+|pact)\.(value|spent|max)$/.test(path)
        || /^system\.resources\.[^.]+\.(value|max)$/.test(path)
        || /^system\.attributes\.(inspiration|death|encumbrance)(\.|$)/.test(path)
        || /^system\.details\.xp\.(value|max|current|next)$/.test(path);
}

function isManagedRuntimeDefinitionPath(path) {
    return /^system\.attributes\.hp\.(max|tempmax)$/.test(path)
        || /^system\.spells\.(spell\d+|pact)\.max$/.test(path)
        || /^system\.resources\.[^.]+\.max$/.test(path)
        || /^system\.details\.xp\.(max|next)$/.test(path);
}

function hasManagedRuntimeChanges(changes = {}) {
    return Object.keys(flattenManagedChanges(changes) || {}).some(isManagedRuntimePath);
}

function getManagedMediaChangedTargets(changes = {}) {
    const paths = Object.keys(flattenManagedChanges(changes) || {});
    const targets = [];
    if (paths.some((path) => path === "img" || path.startsWith("img."))) targets.push("avatar");
    if (paths.some((path) => path === "prototypeToken.img"
        || path.startsWith("prototypeToken.img.")
        || path === "prototypeToken.texture.src"
        || path.startsWith("prototypeToken.texture.src."))) {
        targets.push("token");
    }
    return targets;
}

function hasManagedDefinitionChanges(changes = {}) {
    return Object.keys(flattenManagedChanges(changes) || {})
        .some((path) => !isManagedRuntimePath(path) || isManagedRuntimeDefinitionPath(path));
}

function scheduleManagedActorRuntimeSync(actorId, delay = null) {
    const actor = game.actors.get(actorId);
    if (!actor || !managedActorUsesSharedRuntime(actor)) return;
    if (runtimeTimers.has(actorId)) return;

    const explicitDelay = delay === null ? NaN : Number(delay);
    const elapsed = Date.now() - Number(runtimeLastSyncedAt.get(actorId) || 0);
    const effectiveDelay = Number.isFinite(explicitDelay)
        ? Math.max(0, explicitDelay)
        : Math.max(RUNTIME_SYNC_MIN_DELAY_MS, RUNTIME_SYNC_INTERVAL_MS - elapsed);

    runtimeTimers.set(actorId, window.setTimeout(() => {
        managedActorRuntimeChain = managedActorRuntimeChain
            .catch(() => undefined)
            .then(() => flushManagedActorRuntime(actorId));
    }, effectiveDelay));
}

async function flushManagedActorRuntime(actorId) {
    runtimeTimers.delete(actorId);
    const actor = game.actors.get(actorId);
    if (!actor || !canRunManagedActorSync(actor) || !hasManagedActorState(actor) || !managedActorUsesSharedRuntime(actor)) return;
    if (pendingJobs.has(actorId) || pendingTimers.has(actorId)) {
        scheduleManagedActorRuntimeSync(actorId, 10_000);
        return;
    }
    try {
        const runtime = buildManagedActorRuntime(actor);
        const runtimeHash = hashValue(runtime);
        const stateRoot = getWorldObjectSetting(STATE_SETTING);
        const previousState = stateRoot[actorId] && typeof stateRoot[actorId] === "object" ? stateRoot[actorId] : {};
        if (previousState.runtimeHash === runtimeHash) {
            runtimeLastSyncedAt.set(actorId, Date.now());
            return;
        }
        // Older versions already sent a runtime snapshot at startup but did not
        // persist its hash. Backfill it locally without repeating all KV writes.
        if (!previousState.runtimeHash && previousState.revision && previousState.syncedAt) {
            await game.settings.set(MODULE_ID, STATE_SETTING, {
                ...stateRoot,
                [actorId]: { ...previousState, runtimeHash }
            });
            runtimeLastSyncedAt.set(actorId, Date.now());
            return;
        }
        await postManagedActorRuntime(actor, runtime);
        const freshStateRoot = getWorldObjectSetting(STATE_SETTING);
        const freshState = freshStateRoot[actorId] && typeof freshStateRoot[actorId] === "object" ? freshStateRoot[actorId] : {};
        await game.settings.set(MODULE_ID, STATE_SETTING, {
            ...freshStateRoot,
            [actorId]: { ...freshState, runtimeHash, runtimeSyncedAt: new Date().toISOString() }
        });
        runtimeLastSyncedAt.set(actorId, Date.now());
        if (runtimeTimers.has(actorId)) {
            window.clearTimeout(runtimeTimers.get(actorId));
            runtimeTimers.delete(actorId);
            scheduleManagedActorRuntimeSync(actorId);
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Sync runtime Managed Actor fallita; nuovo tentativo tra un minuto.`, { actor: actor.name, error });
        if (runtimeTimers.has(actorId)) {
            window.clearTimeout(runtimeTimers.get(actorId));
            runtimeTimers.delete(actorId);
        }
        scheduleManagedActorRuntimeSync(actorId, RUNTIME_RETRY_DELAY_MS);
    }
}

function buildManagedActorRuntime(actor) {
    const system = actor?.system || {};
    const attributes = system.attributes || {};
    const hp = attributes.hp || {};
    const xp = system.details?.xp || {};
    const encumbrance = attributes.encumbrance || {};
    return compactValue({
        hp: { value: hp.value, temp: hp.temp, max: hp.max, tempmax: hp.tempmax },
        xp: { value: xp.value ?? xp.current, max: xp.max ?? xp.next },
        weight: {
            value: encumbrance.value ?? encumbrance.carried ?? encumbrance.total,
            max: encumbrance.max ?? encumbrance.capacity,
            pct: encumbrance.pct,
            encumbered: encumbrance.encumbered
        },
        inspiration: attributes.inspiration,
        death: attributes.death,
        resources: mapResourceRuntime(system.resources),
        spellSlots: mapSpellSlotRuntime(system.spells)
    }, 0, 4_000);
}

async function postManagedActorRuntime(actor, runtime = buildManagedActorRuntime(actor)) {
    const worldId = sanitizeId(game.world?.id || "world");
    const actorId = sanitizeId(actor?.id);
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    if (!worldId || !actorId) throw new Error("Identita Foundry non valida per il runtime Managed Actor.");
    if (!secret) throw new Error("Configura il Secret sync personaggi per aggiornare HP e slot.");
    const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(worldId)}/${encodeURIComponent(actorId)}/runtime`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Cripta-Inventory-Secret": secret
        },
        body: JSON.stringify({ campaignId: getCampaignId(), runtime })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Managed Actor runtime HTTP ${response.status}`);
    return data;
}
function normalizeTokenizerEvent(event = {}) {
    return {
        schemaVersion: 1,
        reason: String(event.reason || "save"),
        forceCreate: Boolean(event.forceCreate),
        forceContentSync: Boolean(event.forceContentSync),
        variantsChanged: Boolean(event.variantsChanged) || String(event.reason || "").startsWith("variant-"),
        allowMissingBaseMedia: Boolean(event.allowMissingBaseMedia),
        changedTargets: Array.from(new Set((Array.isArray(event.changedTargets) ? event.changedTargets : []).filter((target) => ["avatar", "token"].includes(target)))),
        removedVariantIds: Array.from(new Set((Array.isArray(event.removedVariantIds) ? event.removedVariantIds : []).map(String).filter(Boolean))),
        savedAt: String(event.savedAt || new Date().toISOString())
    };
}

function mergeTokenizerEvents(previous, next) {
    if (!previous) return next;
    return {
        ...next,
        changedTargets: Array.from(new Set([...previous.changedTargets, ...next.changedTargets])),
        forceCreate: Boolean(previous.forceCreate || next.forceCreate),
        forceContentSync: Boolean(previous.forceContentSync || next.forceContentSync),
        variantsChanged: Boolean(previous.variantsChanged || next.variantsChanged),
        allowMissingBaseMedia: Boolean(previous.allowMissingBaseMedia || next.allowMissingBaseMedia),
        removedVariantIds: Array.from(new Set([...previous.removedVariantIds, ...next.removedVariantIds]))
    };
}

async function syncManagedActorMedia(actor, event, previousState, worldId, actorId) {
    const slots = {};
    const variants = {};
    const icons = { ...(previousState.icons || {}) };
    const media = { variants: [] };
    const uploaded = { base: 0, variants: 0, icons: 0 };
    const actorMediaRepair = {};
    const previousSlots = previousState.slots || {};
    const baseDescriptorsBySource = new Map();
    let avatarSource = "";
    let avatarDescriptor = null;

    for (const [slot, source] of [["avatar", actor.img], ["token", actor.prototypeToken?.texture?.src || actor.prototypeToken?.img]]) {
        let cleanSource = stripCacheBust(source);
        if (!cleanSource) continue;
        const previous = previousSlots[slot] || {};
        const previousRemote = previous.path ? toWorkerMediaUrl(previous.path) : "";
        const previousMissing = Boolean(previousRemote && extractWorkerMediaPath(previousRemote))
            && !(await managedActorMediaExists(previousRemote));
        const mustUpload = event.changedTargets.includes(slot) || !previous.path || previous.source !== cleanSource || previousMissing;
        let descriptor;
        try {
            const reusedDescriptor = baseDescriptorsBySource.get(cleanSource);
            descriptor = mustUpload
                ? (reusedDescriptor ? { ...reusedDescriptor, uploaded: false }
                    : await uploadManagedMediaSource(
                        cleanSource,
                        worldId,
                        actorId,
                        "base",
                        `${slot}.webp`,
                        slot === "token" ? 2048 : 1600,
                        getTokenizerManagedMediaFallbacks(actor, slot)
                    ))
                : { path: previous.path };
        } catch (error) {
            const previousAvailable = Boolean(previousRemote) && await managedActorMediaExists(previousRemote);
            if (previous.path && previousAvailable) {
                cleanSource = previousRemote;
                descriptor = { path: previous.path, uploaded: false };
                const update = slot === "avatar"
                    ? { img: previousRemote }
                    : { "prototypeToken.texture.src": previousRemote };
                await actor.update(update, { criptaWikiSyncCommand: true });
                console.warn(`${MODULE_ID} | Media sorgente non disponibile; ripristino la copia canonica verificata.`, { actor: actor.name, slot, error });
            } else if (slot === "token" && avatarDescriptor?.path && avatarSource) {
                cleanSource = avatarSource;
                descriptor = { ...avatarDescriptor, uploaded: false };
                await actor.update({ "prototypeToken.texture.src": avatarSource }, { criptaWikiSyncCommand: true });
                console.warn(`${MODULE_ID} | Token non disponibile; uso l'avatar verificato come fallback.`, { actor: actor.name, error });
            } else if (event.allowMissingBaseMedia && Number(previousState.revision || 0) === 0) {
                console.warn(`${MODULE_ID} | Media iniziale non disponibile; lo salto senza inventare un percorso.`, { actor: actor.name, slot, error });
                continue;
            } else {
                throw error;
            }
        }
        if (!descriptor?.path) continue;
        baseDescriptorsBySource.set(cleanSource, descriptor);
        if (slot === "avatar") {
            avatarSource = cleanSource;
            avatarDescriptor = descriptor;
        }
        const revision = mustUpload ? Number(previous.revision || 0) + 1 : Number(previous.revision || 1);
        media[slot] = { path: descriptor.path, revision: Math.max(1, revision), source: "foundry" };
        slots[slot] = { source: descriptor.source || cleanSource, path: descriptor.path, revision: media[slot].revision };
        if (descriptor.recoveredFromFallback) {
            const repairedRemote = withMediaRevision(toWorkerMediaUrl(descriptor.path), media[slot].revision);
            if (slot === "avatar") actorMediaRepair.img = repairedRemote;
            else actorMediaRepair["prototypeToken.texture.src"] = repairedRemote;
        }
        if (mustUpload && descriptor.uploaded) uploaded.base += 1;
    }
    if (Object.keys(actorMediaRepair).length) {
        await actor.update(actorMediaRepair, {
            criptaWikiSyncCommand: true,
            criptaManagedMediaRepair: true,
            render: false
        });
    }

    const previousVariants = previousState.variants || {};
    const changedVariantIds = [];
    const actorVariants = getManualTokenizerVariants(actor);
    for (const variant of actorVariants) {
        const previous = previousVariants[variant.id] || {};
        const source = stripCacheBust(variant.src);
        const signature = managedVariantSignature(variant, source);
        const mediaChanged = !previous.path || previous.signature !== signature;
        const revision = mediaChanged ? Number(previous.revision || 0) + 1 : Number(previous.revision || 1);
        const descriptor = mediaChanged
            ? await uploadManagedMediaSource(source, worldId, actorId, "variants", `${sanitizeId(variant.id)}-foundry-r${Math.max(1, revision)}.webp`, 2048)
            : { path: previous.path };
        if (!descriptor?.path) continue;
        media.variants.push({
            id: variant.id,
            name: variant.name,
            path: descriptor.path,
            revision: Math.max(1, revision),
            source: "foundry",
            width: variant.width,
            height: variant.height
        });
        variants[variant.id] = { source, path: descriptor.path, revision: Math.max(1, revision), updatedAt: variant.updatedAt || "", signature };
        if (mediaChanged) changedVariantIds.push(variant.id);
        if (mediaChanged && descriptor.uploaded) uploaded.variants += 1;
    }

    const actorItems = Array.from(actor.items?.contents || actor.items || []);
    const activeTransferIds = new Set(actorItems.map((item) => getItemTransferId(item) || String(item.id || "")).filter(Boolean));
    Object.keys(icons).forEach((transferId) => {
        if (!activeTransferIds.has(transferId)) delete icons[transferId];
    });
    for (const item of actorItems.slice(0, MAX_ICON_UPLOADS)) {
        const transferId = getItemTransferId(item) || String(item.id || "");
        const source = stripCacheBust(item.img);
        if (!transferId || !source || !isCustomIconSource(source)) continue;
        const previous = previousState.icons?.[transferId] || {};
        const signature = source;
        const mediaChanged = !previous.path || previous.source !== source;
        try {
            const descriptor = mediaChanged
                ? await uploadManagedMediaSource(source, worldId, actorId, "icons", `${sanitizeId(transferId)}.webp`, 384)
                : { path: previous.path };
            if (!descriptor?.path) continue;
            icons[transferId] = { source, signature, path: descriptor.path, revision: mediaChanged ? Number(previous.revision || 0) + 1 : Number(previous.revision || 1) };
            if (mediaChanged && descriptor.uploaded) uploaded.icons += 1;
        } catch (error) {
            if (previous.path) icons[transferId] = previous;
            console.warn(`${MODULE_ID} | Icona Managed Actor saltata; mantengo la precedente.`, { actor: actor.name, item: item.name, error });
        }
    }

    return { media, state: { slots, variants, icons, changedVariantIds }, uploaded };
}
function buildManagedActorCurrency(actor) {
    const nativeCurrency = actor?.system?.currency && typeof actor.system.currency === "object"
        ? foundry.utils.deepClone(actor.system.currency)
        : {};
    try {
        const economy = game.modules.get(MERCHANT_MODULE_ID)?.api?.economy;
        const wallet = economy?.readWallet?.(actor, { includeInactive: true });
        return wallet && typeof wallet === "object" ? { ...nativeCurrency, ...wallet } : nativeCurrency;
    } catch (error) {
        console.warn(`${MODULE_ID} | Portamonete personalizzato non esportato.`, { actor: actor?.name, error });
        return nativeCurrency;
    }
}


function mapManagedActorSenses(actor, preparedSenses = {}) {
    const storedSenses = managedActorLinkDocumentSource(actor)?.system?.attributes?.senses;
    const source = storedSenses && typeof storedSenses === "object" && !Array.isArray(storedSenses)
        ? storedSenses
        : (preparedSenses && typeof preparedSenses === "object" ? preparedSenses : {});
    const ranges = source.ranges && typeof source.ranges === "object" && !Array.isArray(source.ranges)
        ? source.ranges
        : {};
    const readStoredSense = (key) => {
        if (Object.hasOwn(ranges, key)) return ranges[key];
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    };
    return compactValue({
        ranges,
        darkvision: readStoredSense("darkvision"),
        blindsight: readStoredSense("blindsight"),
        tremorsense: readStoredSense("tremorsense"),
        truesight: readStoredSense("truesight"),
        units: source.units,
        special: source.special
    }, 0, 1_000) || {};
}

function buildManagedActorDocument(actor, media, link = {}, iconStates = {}) {
    const system = actor.system || {};
    const tokenState = getManagedActorTokenState(actor);
    const attributes = system.attributes || {};
    const hp = attributes.hp || {};
    const items = Array.from(actor.items?.contents || actor.items || []).map((item) => buildManagedActorEntry(item, iconStates));
    const ownerAccountIds = Array.from(new Set([
        ...(Array.isArray(link.ownerAccountIds) ? link.ownerAccountIds : []),
        link.ownerAccountId
    ].map((value) => String(value || "").trim()).filter(Boolean)));

    const document = {
        schemaVersion: 4,
        contract: buildFoundrySyncContract(),
        actorUuid: String(actor.uuid || `Actor.${actor.id}`),
        foundryActorId: String(actor.id || ""),
        name: String(actor.name || "Actor"),
        actorType: String(actor.type || "npc"),
        entityKind: tokenState.entityKind,
        runtimePolicy: tokenState.mode,
        relationshipType: String(link.relationshipType || ""),
        ownerCharacterId: String(link.ownerCharacterId || ""),
        ownerAccountIds,
        visibility: DEFAULT_VISIBILITY,
        media: {
            ...media,
            variants: media.variants || []
        },
        system: {
            id: String(game.system?.id || ""),
            version: String(game.system?.version || ""),
            foundryVersion: String(game.version || game.release?.version || "")
        },
        definition: compactValue({
            details: system.details,
            abilities: system.abilities,
            skills: system.skills,
            attributes: {
                ac: attributes.ac,
                hp: { max: hp.max, formula: hp.formula, tempmax: hp.tempmax },
                movement: attributes.movement,
                senses: mapManagedActorSenses(actor, attributes.senses),
                prof: attributes.prof,
                init: attributes.init,
                spellcasting: attributes.spellcasting,
                encumbrance: attributes.encumbrance,
                exhaustion: attributes.exhaustion
            },
            traits: system.traits,
            bonuses: system.bonuses,
            currency: buildManagedActorCurrency(actor),
            resources: mapResourceDefinition(system.resources),
            spellSlots: mapSpellSlotDefinition(system.spells),
            prototypeToken: mapPrototypeToken(actor.prototypeToken),
            merchant: buildManagedMerchantDefinition(actor),
            items,
            effects: mapActorEffects(actor)
        }, 0, 12_000),
        ...(tokenState.mode === "shared" ? {
            runtime: compactValue({
                ...buildManagedActorRuntime(actor),
                items: items.map((entry) => ({ transferId: entry.transferId, itemId: entry.itemId, state: entry.state })).filter((entry) => Object.keys(entry.state || {}).length)
            }, 0, 4_000)
        } : {})
    };
    document.definition.items = items;
    document.definition.editor = buildManagedEditorMetadata(actor);
    return document;
}

function buildManagedEditorMetadata(actor) {
    const source = actor._source ?? actor.toObject?.() ?? {};
    const paths = ["system.attributes.hp.max", "system.attributes.ac.flat", "system.attributes.init.bonus",
        ...["str", "dex", "con", "int", "wis", "cha"].map(key => `system.abilities.${key}.value`),
        ...["walk", "fly", "swim", "climb", "burrow"].map(key => `system.attributes.movement.${key}`)];
    const fields = {};
    for (const path of paths) {
        const base = foundry.utils.getProperty(source, path);
        const effective = foundry.utils.getProperty(actor, path);
        if (base === undefined || effective === undefined) continue;
        const overridden = foundry.utils.getProperty(actor.overrides ?? {}, path) !== undefined;
        fields[path] = {base, effective, editable: !overridden,
            ...(overridden ? {reason: "Valore controllato da un effetto attivo: modifica l'effetto in Foundry."} : {})};
    }
    return {version: 1, itemEffects: true, npcRules: game.modules?.get("khuzoe-automations")?.api?.npcRules?.version ?? 0, midiRollConfig: game.modules?.get("khuzoe-automations")?.api?.midiRollConfig?.version ?? 0, fields};
}

function normalizeManagedRollFormula(value, rollData = {}) {
    const source = String(value ?? "").trim();
    if (!source) return "";
    try {
        const resolved = globalThis.Roll?.replaceFormulaData
            ? globalThis.Roll.replaceFormulaData(source, rollData, { missing: 0, warn: false })
            : source;
        return String(resolved || source).replace(/\s+/g, " ").trim();
    } catch (_) {
        return source;
    }
}

function managedCollectionValues(value) {
    if (value === undefined || value === null || value === "") return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set || value instanceof Map) return Array.from(value.values());
    if (typeof value?.values === "function") {
        try {
            return Array.from(value.values());
        } catch (_) { /* prosegue con il formato plain-object */ }
    }
    if (typeof value === "object") return Object.values(value);
    return [value];
}

function managedDamagePartSummary(part, rollData = {}, metadata = {}) {
    if (Array.isArray(part)) {
        const formula = normalizeManagedRollFormula(part[0], rollData);
        const types = managedCollectionValues(part[1]).map(String).filter(Boolean);
        return formula ? { formula, types, ...metadata } : null;
    }
    if (!part || typeof part !== "object") return null;
    const customFormula = part.custom?.enabled ? part.custom?.formula : "";
    let formula = String(customFormula || part.formula || "").trim();
    if (!formula) {
        const number = part.number ?? part.dice?.number;
        const denomination = part.denomination ?? part.dice?.denomination;
        const bonus = String(part.bonus ?? "").trim();
        const dice = number && denomination ? `${number}d${denomination}` : "";
        formula = dice && bonus
            ? `${dice}${bonus.startsWith("-") ? " " : " + "}${bonus}`
            : (dice || bonus);
    }
    formula = normalizeManagedRollFormula(formula, rollData);
    const rawTypes = part.types ?? part.type ?? [];
    const types = managedCollectionValues(rawTypes).map(String).filter(Boolean);
    return formula ? { formula, types, ...metadata } : null;
}

function managedPreparedActivity(item, activityId) {
    const activities = item?.system?.activities;
    if (!activities) return null;
    const direct = typeof activities.get === "function" ? activities.get(String(activityId || "")) : null;
    if (direct) return direct;
    return managedCollectionValues(activities).find((activity) => [activity?.id, activity?._id]
        .some((candidate) => String(candidate || "") === String(activityId || ""))) || null;
}

function managedPreparedDamageSummaries(item, activityId) {
    const activity = managedPreparedActivity(item, activityId);
    if (!activity || typeof activity.getDamageConfig !== "function") return [];
    try {
        const config = activity.getDamageConfig();
        return managedCollectionValues(config?.rolls).map((roll, index) => {
            const parts = managedCollectionValues(roll?.parts).map((part) => String(part || "").trim()).filter(Boolean);
            let formula = normalizeManagedRollFormula(parts.join(" + "), roll?.data || {});
            formula = formula.replace(/\+\s+-\s*/g, "- ").replace(/\+\s+\+\s*/g, "+ ").trim();
            const types = managedCollectionValues(roll?.options?.types ?? roll?.options?.type).map(String).filter(Boolean);
            return formula ? { formula, types, role: index > 0 ? "secondary" : "primary" } : null;
        }).filter(Boolean);
    } catch (error) {
        console.debug(`${MODULE_ID} | Riepilogo danni preparato non disponibile; uso il formato persistito.`, {
            item: item?.name,
            activityId,
            error
        });
        return [];
    }
}

function managedSaveSummary(save, actor, rollData = {}) {
    if (!save || typeof save !== "object") return null;
    const dcSource = save.dc && typeof save.dc === "object" ? save.dc : {};
    let dc = Number(dcSource.value ?? save.value ?? save.dc);
    if (!Number.isFinite(dc) || dc <= 0) {
        const formula = normalizeManagedRollFormula(dcSource.formula || save.formula || "", rollData);
        if (formula && !/[dD]/.test(formula)) {
            try {
                const evaluated = globalThis.Roll?.safeEval ? Number(globalThis.Roll.safeEval(formula)) : Number(formula);
                if (Number.isFinite(evaluated) && evaluated > 0) dc = evaluated;
            } catch (_) { /* conserva il fallback calcolato sotto */ }
        }
    }
    const calculation = String(dcSource.calculation || save.scaling || "").toLowerCase();
    if ((!Number.isFinite(dc) || dc <= 0) && calculation === "spellcasting") {
        dc = Number(actor?.system?.attributes?.spell?.dc || actor?.system?.attributes?.spelldc);
    }
    if ((!Number.isFinite(dc) || dc <= 0) && ["str", "dex", "con", "int", "wis", "cha"].includes(calculation)) {
        dc = 8 + Number(actor?.system?.attributes?.prof || 0) + Number(actor?.system?.abilities?.[calculation]?.mod || 0);
    }
    if (!Number.isFinite(dc) || dc <= 0) return null;
    const abilitySource = save.ability ?? save.abilities ?? [];
    const abilities = managedCollectionValues(abilitySource).map(String).filter(Boolean);
    return { dc: Math.round(dc), abilities };
}

function buildManagedEntryEffectiveRolls(item, system = {}) {
    const actor = item?.actor;
    const actorRollData = actor?.getRollData?.() || {};
    const activitiesSource = system.activities && typeof system.activities === "object" ? system.activities : {};
    const activityEntries = activitiesSource instanceof Map
        ? Array.from(activitiesSource.entries())
        : Array.isArray(activitiesSource)
            ? activitiesSource.map((activity, index) => [activity?._id || activity?.id || index, activity])
            : Object.entries(activitiesSource);
    const summaries = [];

    const summarize = (id, activity = {}, fallbackName = "") => {
        const ability = String(activity.attack?.ability || system.attack?.ability || system.ability || "").toLowerCase();
        const rollData = {
            ...actorRollData,
            mod: Number(actor?.system?.abilities?.[ability]?.mod || 0),
            prof: Number(actor?.system?.attributes?.prof || 0)
        };
        const preparedDamage = managedPreparedDamageSummaries(item, id);
        const damage = preparedDamage.length ? preparedDamage : [];
        if (!preparedDamage.length) {
            if (activity.damage?.includeBase !== false && system.damage?.base) {
                const base = managedDamagePartSummary(system.damage.base, rollData, { role: "primary" });
                if (base) damage.push(base);
            }
            const activityParts = managedCollectionValues(activity.damage?.parts);
            activityParts.forEach((part, index) => {
                const role = damage.length || index > 0 ? "secondary" : "primary";
                const summary = managedDamagePartSummary(part, rollData, { role });
                if (summary) damage.push(summary);
            });
        }
        const save = managedSaveSummary(activity.save, actor, rollData);
        if (!damage.length && !save) return;
        summaries.push({ id: String(id || ""), name: String(activity.name || fallbackName || item?.name || "Attivit\u00E0"), damage, save });
    };

    activityEntries.forEach(([id, activity]) => summarize(id, activity));
    if (!summaries.length) {
        const ability = String(system.attack?.ability || system.ability || "").toLowerCase();
        const rollData = {
            ...actorRollData,
            mod: Number(actor?.system?.abilities?.[ability]?.mod || 0),
            prof: Number(actor?.system?.attributes?.prof || 0)
        };
        const legacyParts = managedCollectionValues(system.damage?.parts);
        const damage = legacyParts.map((part, index) => managedDamagePartSummary(part, rollData, {
            role: index > 0 ? "secondary" : "primary"
        })).filter(Boolean);
        if (!damage.length && system.damage?.base) {
            const base = managedDamagePartSummary(system.damage.base, rollData, { role: "primary" });
            if (base) damage.push(base);
        }
        const save = managedSaveSummary(system.save, actor, rollData);
        if (damage.length || save) summaries.push({ id: "base", name: String(item?.name || "Attivit\u00E0"), damage, save });
    }
    return summaries.length ? { formulaVersion: 2, activities: summaries } : undefined;
}
function buildManagedActorEntry(item, iconStates = {}) {
    // Serialize the persistent source together with D&D5e's live ActivityCollection.
    // Items first opened after a v12 migration can still have an empty stored
    // activities branch even though D&D5e has created authoritative Activity
    // documents in memory. The shared source helper preserves those documents
    // without copying prepared values or invoking deprecated compatibility getters.
    const source = managedActorLinkDocumentSource(item);
    const system = source?.system && typeof source.system === "object" ? source.system : {};
    const flags = source?.flags && typeof source.flags === "object" ? source.flags : {};
    const transferId = getItemTransferId(item) || String(item.id || "");
    const iconState = iconStates[transferId];
    const entry = compactValue({
        itemId: String(item.id || ""),
        uuid: String(item.uuid || ""),
        transferId,
        campaignItemId: String(flags?.[MODULE_ID]?.campaignItemId || ""),
        sourceId: String(source?._stats?.compendiumSource || item?._stats?.compendiumSource || flags?.core?.sourceId || ""),
        name: String(item.name || "Elemento"),
        type: String(item.type || "item"),
        media: iconState?.path ? { icon: { path: iconState.path, revision: iconState.revision || 1, source: "foundry" } } : undefined,
        definition: {
            img: String(source?.img || item.img || ""),
            description: cleanHtml(system.description?.value || system.description || ""),
            quantity: system.quantity ?? system.qty ?? system.amount,
            container: system.container,
            weight: system.weight,
            price: system.price,
            rarity: system.rarity,
            identified: system.identified,
            equipped: system.equipped,
            attuned: system.attuned,
            attunement: system.attunement,
            level: system.level,
            school: system.school,
            method: item.type === "spell" ? readSpellPreparation(system).method : undefined,
            preparation: item.type === "spell" ? spellPreparationForWiki(system) : undefined,
            properties: system.properties,
            materials: system.materials,
            activation: system.activation,
            target: system.target,
            range: system.range,
            duration: system.duration,
            uses: { max: system.uses?.max, recovery: system.uses?.recovery, per: system.uses?.per },
            recharge: system.recharge,
            damage: system.damage,
            damageBonus: system.damageBonus,
            magicalBonus: system.magicalBonus,
            magicAvailable: system.magicAvailable,
            attack: system.attack,
            save: system.save,
            activities: system.activities,
            effectiveRolls: buildManagedEntryEffectiveRolls(item, system),
            type: system.type,
            identifier: system.identifier,
            requirements: system.requirements,
            advancement: system.advancement,
            currency: system.currency,
            capacity: system.capacity
        },
        state: {
            quantity: system.quantity ?? system.qty ?? system.amount,
            equipped: system.equipped,
            attuned: system.attuned,
            uses: { value: system.uses?.value, spent: system.uses?.spent, max: system.uses?.max },
            prepared: item.type === "spell" ? spellPreparationForWiki(system).prepared : undefined,
            definitionHash: managedActorLinkItemDefinitionSignature(item)
        }
    }, 0, 12_000);
    // Keep source values intact: nulls and empty arrays are meaningful when clearing effects/flags.
    entry.definition.effects = getManagedItemEffects(item);
    entry.definition.flags = {
        "midi-qol": foundry.utils.deepClone(flags["midi-qol"] ?? {}),
        dae: foundry.utils.deepClone(flags.dae ?? {}),
        "khuzoe-automations": {npcRules: foundry.utils.deepClone(flags["khuzoe-automations"]?.npcRules ?? {version: 1, activities: {}}), midiRollConfig: foundry.utils.deepClone(flags["khuzoe-automations"]?.midiRollConfig ?? {version: 1, activities: {}})}
    };
    return entry;
}

function mapPrototypeToken(token) {
    if (!token) return {};
    const source = token.toObject ? token.toObject() : token;
    return compactValue({
        name: source.name,
        actorLink: typeof source.actorLink === "boolean" ? source.actorLink : undefined,
        width: source.width,
        height: source.height,
        disposition: source.disposition,
        displayName: source.displayName,
        texture: {
            scaleX: source.texture?.scaleX,
            scaleY: source.texture?.scaleY,
            offsetX: source.texture?.offsetX,
            offsetY: source.texture?.offsetY,
            rotation: source.texture?.rotation,
            tint: source.texture?.tint,
            alphaThreshold: source.texture?.alphaThreshold,
            fit: source.texture?.fit
        },
        sight: source.sight,
        detectionModes: source.detectionModes
    }, 0, 2_000);
}

function mapActorEffects(actor) {
    return Array.from(actor.effects || []).slice(0, 128).map((effect) => compactValue({
        id: effect.id,
        clientId: String(effect.getFlag?.(MODULE_ID, "clientId") || ""),
        name: effect.name,
        img: effect.img,
        disabled: effect.disabled,
        duration: effect.duration,
        changes: getActiveEffectChanges(effect),
        statuses: Array.from(effect.statuses || [])
    }, 0, 2_000));
}

function mapResourceDefinition(resources = {}) {
    return Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, compactValue({ label: value?.label, max: value?.max, sr: value?.sr, lr: value?.lr })]));
}

function mapResourceRuntime(resources = {}) {
    return Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, { value: value?.value, max: value?.max }]));
}

function mapSpellSlotDefinition(spells = {}) {
    return Object.fromEntries(Object.entries(spells).map(([key, value]) => [key, compactValue({ max: value?.max, override: value?.override, level: value?.level })]));
}

function mapSpellSlotRuntime(spells = {}) {
    return Object.fromEntries(Object.entries(spells).map(([key, value]) => [key, compactValue({ value: value?.value, spent: value?.spent, max: value?.max })]));
}

function getTokenizerManagedMediaFallbacks(actor, slot) {
    const lastEdit = actor?.getFlag?.(TOKENIZER_MODULE_ID, "lastEdit") || {};
    const edit = lastEdit?.[slot] && typeof lastEdit[slot] === "object" ? lastEdit[slot] : {};
    return Array.from(new Set([edit.path, edit.sourcePath]
        .map(stripCacheBust)
        .filter((value) => value && !extractWorkerMediaPath(value))));
}

async function uploadManagedMediaSource(source, worldId, actorId, category, filename, maxDimension, fallbackSources = []) {
    const existing = extractWorkerMediaPath(source);
    const targetPrefix = `media/campaigns/${getCampaignId()}/managed-actors/${worldId}/${actorId}/${category}/`;
    const existingIsCanonical = Boolean(existing && existing.startsWith(targetPrefix));
    if (existingIsCanonical && await managedActorMediaExists(toWorkerMediaUrl(existing))) {
        return { path: existing, uploaded: false, source: stripCacheBust(source) };
    }

    const candidates = existingIsCanonical
        ? fallbackSources
        : [existing ? `${DISCORD_WORKER_URL}/${existing}` : source, ...fallbackSources];
    let blob = null;
    let effectiveSource = "";
    let lastError = null;
    for (const candidate of Array.from(new Set(candidates.map(stripCacheBust).filter(Boolean)))) {
        try {
            blob = await imageSourceToWebpBlob(candidate, maxDimension);
            effectiveSource = candidate;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (!blob) {
        const detail = existingIsCanonical ? `Media R2 mancante e nessun fallback locale leggibile: ${existing}` : `Media non leggibile: ${source}`;
        throw new Error(`${detail}${lastError?.message ? ` (${lastError.message})` : ""}`);
    }

    const folder = `managed-actors/${worldId}/${actorId}/${category}`;
    const form = new FormData();
    form.set("folder", folder);
    form.set("filename", filename);
    form.set("campaignId", getCampaignId());
    form.set("file", new File([blob], filename, { type: "image/webp" }));
    const headers = buildWorkerAuthHeaders(false);
    const url = new URL(`${DISCORD_WORKER_URL}/media/upload`);
    url.searchParams.set("campaign", getCampaignId());
    url.searchParams.set("folder", folder);
    const response = await policyFetch(url.toString(), { method: "POST", headers, body: form });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Upload media HTTP ${response.status}`);
    const path = String(data?.path || (data?.key ? `media/${data.key}` : "")).trim();
    if (!path) throw new Error("Il Worker non ha restituito il percorso del media caricato.");
    if (!(await managedActorMediaExists(toWorkerMediaUrl(path)))) {
        throw new Error(`Il media caricato non risulta leggibile dal Worker: ${path}`);
    }
    return {
        path,
        uploaded: true,
        source: effectiveSource,
        recoveredFromFallback: existingIsCanonical
    };
}

async function imageSourceToWebpBlob(source, maxDimension = 1600) {
    const image = await new Promise((resolve, reject) => {
        const element = new Image();
        if (/^https?:/i.test(source)) element.crossOrigin = "anonymous";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`Immagine non leggibile: ${source}`));
        element.src = source;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { alpha: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Conversione WebP fallita.")), "image/webp", 0.9));
}

async function postManagedActor(worldId, actorId, document, { pullCommandReconciliation = false } = {}) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/managed-actors/${encodeURIComponent(worldId)}/${encodeURIComponent(actorId)}`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(true), "Content-Type": "application/json" },
        body: JSON.stringify({ ...document, campaignId: getCampaignId() }),
        ...(pullCommandReconciliation ? { khuzoeSyncIntent: "managed-actor-command-reconciliation" } : {})
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error || `Managed Actor HTTP ${response.status}`);
        error.status = response.status;
        error.code = String(data?.code || "");
        error.currentRevision = Number(data?.currentRevision || 0);
        throw error;
    }
    return data;
}

function buildWorkerAuthHeaders(includeAccept = true) {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    if (!token && !secret) throw new Error("Configura il Secret sync personaggi o effettua il login wiki prima di sincronizzare Managed Actor.");
    return {
        ...(includeAccept ? { Accept: "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {})
    };
}

async function ensureTransferIdentity(item) {
    let transferId = getItemTransferId(item);
    if (!transferId) {
        transferId = `item-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
        await item.setFlag(MODULE_ID, "transferId", transferId);
    }
    return transferId;
}

export async function ensureManagedActorTransferIds(actor) {
    const seen = new Set();
    for (const item of Array.from(actor.items?.contents || actor.items || [])) {
        let transferId = await ensureTransferIdentity(item);
        if (seen.has(transferId)) {
            transferId = `item-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
            await item.setFlag(MODULE_ID, "transferId", transferId);
        }
        seen.add(transferId);
    }
}

function getManualTokenizerVariants(actor) {
    const variants = actor.getFlag?.("khuzoe-tokenizer", "tokenVariants") || [];
    return (Array.isArray(variants) ? variants : [])
        .filter((variant) => String(variant?.source || "manual") === "manual")
        .map((variant) => ({
            id: String(variant.id || ""),
            name: String(variant.name || "Variante"),
            src: String(variant.src || variant.path || ""),
            width: Number(variant.width) || 1,
            height: Number(variant.height || variant.width) || 1,
            updatedAt: String(variant.updatedAt || "")
        }))
        .filter((variant) => variant.id && variant.src);
}

function readManagedMerchant(actor) {
    const stored = actor?.getFlag?.(MERCHANT_MODULE_ID, MERCHANT_FLAG_KEY);
    if (!stored || typeof stored !== "object") return null;
    return {
        enabled: Boolean(stored.enabled),
        subtitle: String(stored.subtitle || "").trim().slice(0, 160),
        distance: Math.max(0, Number(stored.distance) || 0),
        inventory: Array.isArray(stored.inventory) ? stored.inventory : []
    };
}

function isManagedMerchant(actor) {
    return readManagedMerchant(actor)?.enabled === true;
}

function hasManagedMerchantChanges(changes = {}) {
    return Object.keys(flattenManagedChanges(changes) || {}).some((path) => path === `flags.${MERCHANT_MODULE_ID}.${MERCHANT_FLAG_KEY}`
        || path.startsWith(`flags.${MERCHANT_MODULE_ID}.${MERCHANT_FLAG_KEY}.`));
}

function getManagedMerchantEntryId(entry, index = 0) {
    const explicit = String(entry?.id || "").trim();
    if (explicit) return explicit;
    const sourceUuid = String(entry?.sourceUuid || "").trim();
    return sourceUuid ? `source-${hashValue(sourceUuid)}` : `entry-${index + 1}`;
}

function normalizeManagedMerchantCurrencyId(value, fallback = "gp") {
    const currencyId = String(value || "").trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(currencyId) ? currencyId : fallback;
}

function normalizeManagedMerchantPrice(value) {
    const price = value && typeof value === "object" ? value : {};
    const amount = Math.max(0, Number(price.value ?? price.amount ?? value) || 0);
    const denomination = normalizeManagedMerchantCurrencyId(price.denomination || price.currency || "gp");
    return { value: amount, denomination };
}

function normalizeManagedMerchantCost(entry, fallbackPrice) {
    const source = Array.isArray(entry?.cost?.components)
        ? entry.cost.components
        : Array.isArray(entry?.price?.components)
            ? entry.price.components
            : [{ currencyId: fallbackPrice.denomination, amount: fallbackPrice.value }];
    const totals = new Map();
    source.slice(0, 12).forEach((component) => {
        const currencyId = normalizeManagedMerchantCurrencyId(component?.currencyId ?? component?.denomination, fallbackPrice.denomination);
        const amount = Math.max(0, Number(component?.amount ?? component?.value) || 0);
        if (!amount) return;
        totals.set(currencyId, (totals.get(currencyId) || 0) + amount);
    });
    return { components: Array.from(totals, ([currencyId, amount]) => ({ currencyId, amount })) };
}

function getManagedMerchantDescription(value) {
    if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        return /^\[object\s+Object\]$/i.test(text) ? "" : text;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    for (const candidate of [value.value, value.chat, value.unidentified, value.description, value.text, value.html]) {
        const text = getManagedMerchantDescription(candidate);
        if (text) return text;
    }
    return "";
}

function getManagedMerchantCampaignItemId(entry, source) {
    const snapshotFlags = source?.flags?.[MODULE_ID] || {};
    const sourceUuid = String(entry?.sourceUuid || "").trim();
    const worldItemMatch = sourceUuid.match(/^Item\.([A-Za-z0-9]+)$/i);
    const worldItem = worldItemMatch ? game.items?.get?.(worldItemMatch[1]) : null;
    const liveId = worldItem?.getFlag?.(MODULE_ID, "campaignItemId")
        || worldItem?.getFlag?.(MODULE_ID, "wikiItemId")
        || "";
    return sanitizeId(entry?.campaignItemId
        || snapshotFlags.campaignItemId
        || snapshotFlags.wikiItemId
        || liveId);
}

function buildManagedMerchantDefinition(actor) {
    const merchant = readManagedMerchant(actor);
    if (!merchant?.enabled) return undefined;
    const inventory = merchant.inventory.slice(0, MAX_MERCHANT_ITEMS).map((entry, index) => {
        const entryId = getManagedMerchantEntryId(entry, index);
        const source = entry?.data && typeof entry.data === "object" ? entry.data : {};
        const system = source.system && typeof source.system === "object" ? source.system : {};
        const campaignItemId = getManagedMerchantCampaignItemId(entry, source);
        const stock = entry?.stock === null || entry?.stock === undefined || entry?.stock === ""
            ? null
            : Math.max(0, Math.floor(Number(entry.stock) || 0));
        const price = normalizeManagedMerchantPrice(entry?.price ?? system.price);
        return compactValue({
            id: entryId,
            sourceUuid: String(entry?.sourceUuid || ""),
            campaignItemId,
            name: String(entry?.name || source.name || "Oggetto").slice(0, 120),
            type: String(entry?.type || source.type || "item").slice(0, 60),
            description: cleanHtml(getManagedMerchantDescription(system.description) || getManagedMerchantDescription(entry?.description)).slice(0, 6_000),
            price,
            cost: normalizeManagedMerchantCost(entry, price),
            stock,
            definition: {
                rarity: system.rarity,
                identified: system.identified,
                weight: system.weight,
                quantity: system.quantity ?? system.qty,
                equipped: system.equipped,
                attuned: system.attuned,
                attunement: system.attunement,
                level: system.level,
                school: system.school,
                properties: system.properties,
                materials: system.materials,
                activation: system.activation,
                target: system.target,
                range: system.range,
                duration: system.duration,
                uses: { max: system.uses?.max, recovery: system.uses?.recovery, per: system.uses?.per },
                recharge: system.recharge,
                damage: system.damage,
                attack: system.attack,
                save: system.save,
                activities: system.activities,
                type: system.type,
                identifier: system.identifier,
                requirements: system.requirements,
                capacity: system.capacity
            }
        }, 0, 6_000);
    });
    return compactValue({
        enabled: true,
        subtitle: merchant.subtitle,
        distance: merchant.distance,
        inventory
    }, 0, 6_000);
}


function getItemTransferId(item) {
    return String(item?.getFlag?.(MODULE_ID, "transferId") || item?.flags?.[MODULE_ID]?.transferId || "").trim();
}

function isCustomIconSource(source) {
    const clean = String(source || "").toLowerCase().replace(/^\/+/, "");
    if (!clean || clean.startsWith("icons/") || clean.startsWith("systems/") || clean.startsWith("modules/")) return false;
    return !/^(data:image\/svg|icons\/svg\/)/.test(clean);
}

function extractWorkerMediaPath(value) {
    const clean = String(value || "").trim().split(/[?#]/)[0].replace(/\\/g, "/");
    if (!clean) return "";
    const mediaIndex = clean.indexOf("/media/");
    if (mediaIndex >= 0) return clean.slice(mediaIndex + 1);
    return clean.replace(/^\/+/, "").startsWith("media/") ? clean.replace(/^\/+/, "") : "";
}

function stripCacheBust(value) {
    return String(value || "").trim().split(/[?#]/)[0];
}

function cleanHtml(value) {
    return String(value || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/\son\w+\s*=\s*(["']).*?\1/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 12_000);
}

function compactValue(value, depth = 0, stringLimit = 4_000) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "string") return value.length > stringLimit ? `${value.slice(0, stringLimit)}...` : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (depth >= 12) return undefined;
    if (value instanceof Set) return Array.from(value).slice(0, 128).map((entry) => compactValue(entry, depth + 1, stringLimit)).filter((entry) => entry !== undefined);
    if (Array.isArray(value)) return value.slice(0, 500).map((entry) => compactValue(entry, depth + 1, stringLimit)).filter((entry) => entry !== undefined);
    if (typeof value === "object") {
        const plain = value.toObject ? value.toObject() : value;
        return Object.fromEntries(Object.entries(plain).slice(0, 160).map(([key, entry]) => [key, compactValue(entry, depth + 1, stringLimit)]).filter(([, entry]) => entry !== undefined));
    }
    return undefined;
}

function stableStringify(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashValue(value) {
    const text = stableStringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeId(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function resetManagedActorRelationshipCacheForCampaign(campaignId) {
    if (managedActorRelationshipCache.campaignId === campaignId) return;
    managedActorRelationshipCache.campaignId = campaignId;
    managedActorRelationshipCache.loadedAt = 0;
    managedActorRelationshipCache.payload = null;
    managedActorRelationshipCache.promise = null;
    recentlyConfirmedManagedActors.clear();
}

function getManagedActorIdentity(actor) {
    if (isTemporaryWikiActor(actor)) return null;
    const campaignId = getCampaignId();
    const worldId = sanitizeId(game.world?.id || "world");
    const actorId = sanitizeId(actor?.id);
    if (!worldId || !actorId) return null;
    return { campaignId, worldId, actorId, key: `${campaignId}:${worldId}:${actorId}` };
}

function rememberManagedActorShared(actor, worldId, actorId, document, response) {
    const identity = getManagedActorIdentity(actor);
    if (!identity) return;
    resetManagedActorRelationshipCacheForCampaign(identity.campaignId);
    recentlyConfirmedManagedActors.set(identity.key, Date.now());
    const payload = managedActorRelationshipCache.payload;
    if (!payload || !Array.isArray(payload.data)) return;

    const summary = {
        actorId,
        foundryActorId: String(actor?.id || actorId),
        worldId,
        actorType: String(actor?.type || document?.actorType || "npc"),
        name: String(actor?.name || document?.name || "NPC"),
        revision: Number(response?.revision || 1),
        media: document?.media || {}
    };
    const matchingIndex = payload.data.findIndex((entry) => sanitizeId(entry?.worldId) === worldId
        && [entry?.actorId, entry?.foundryActorId].some((value) => sanitizeId(value) === actorId));
    const nextData = [...payload.data];
    if (matchingIndex >= 0) nextData[matchingIndex] = { ...nextData[matchingIndex], ...summary };
    else nextData.push(summary);
    managedActorRelationshipCache.payload = { ...payload, data: nextData };
    managedActorRelationshipCache.loadedAt = Date.now();
}

function getCampaignId() {
    return sanitizeId(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "cripta-di-sangue") || "cripta-di-sangue";
}

function getWorldObjectSetting(key) {
    try {
        const value = game.settings.get(MODULE_ID, key);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}
