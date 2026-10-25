import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { canStartLiveSync } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";
import { buildFoundrySyncContract } from "./sync-contract.js";

const EVENT_DEBOUNCE_MS = 450;
const CONSISTENCY_RETRY_MS = 5_000;
const RECONNECT_BASE_MS = 4_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const SAFETY_FALLBACK_INTERVAL_MS = 30 * 60_000;
const COMMAND_SAFETY_FALLBACK_INTERVAL_MS = 60_000;
const MAX_SEEN_EVENTS = 256;

let registered = false;
let started = false;
let callbacks = {};
let socket = null;
let reconnectTimer = null;
let eventTimer = null;
let consistencyTimer = null;
let safetyFallbackTimer = null;
let commandSafetyFallbackTimer = null;
let reconnectAttempts = 0;
let pendingNeedsConsistencyRetry = false;
let flushChain = Promise.resolve();
let initialHelloHandled = false;
const pendingCollections = new Set();
const pendingActorIds = new Set();
const seenEventIds = new Set();
const liveState = {
    status: "idle",
    connectedAt: "",
    disconnectedAt: "",
    lastEventAt: "",
    lastEventId: "",
    lastError: "",
    reconnectAttempts: 0
};

export function registerFoundryLiveSync(options = {}) {
    callbacks = { ...callbacks, ...options };
    if (registered) return;
    registered = true;

    Hooks.on("updateUser", () => scheduleEligibilityRefresh());
    Hooks.on("deleteUser", () => scheduleEligibilityRefresh());
    window.addEventListener("online", () => refreshFoundryLiveSync({ reason: "online" }));
    window.addEventListener("offline", () => closeLiveSocket("offline"));
    window.addEventListener("beforeunload", () => stopFoundryLiveSync(), { once: true });
}

export function startFoundryLiveSync() {
    if (!registered || started) return;
    started = true;
    scheduleConnect(350);
    if (!safetyFallbackTimer) {
        safetyFallbackTimer = window.setInterval(() => {
            if (!canOwnLiveConnection()) return;
            runCollections(new Set(["managed-actors", "campaign-items", "light-sync", "economy"]), new Set(), { reason: "safety-fallback" })
                .catch((error) => console.warn(`${MODULE_ID} | Controllo di sicurezza Foundry fallito.`, error));
        }, SAFETY_FALLBACK_INTERVAL_MS);
    }
    if (!commandSafetyFallbackTimer) {
        commandSafetyFallbackTimer = window.setInterval(() => {
            if (!canOwnLiveConnection() || !buildWorkerAuthHeaders()) return;
            queueManagedActorCommandCheck("command-safety-fallback");
        }, COMMAND_SAFETY_FALLBACK_INTERVAL_MS);
    }
}

export function refreshFoundryLiveSync({ reason = "refresh" } = {}) {
    if (!started) return;
    clearTimer("reconnect");
    closeLiveSocket(reason);
    reconnectAttempts = 0;
    scheduleConnect(250);
}

export function stopFoundryLiveSync() {
    started = false;
    clearTimer("reconnect");
    clearTimer("event");
    clearTimer("consistency");
    if (safetyFallbackTimer) window.clearInterval(safetyFallbackTimer);
    safetyFallbackTimer = null;
    if (commandSafetyFallbackTimer) window.clearInterval(commandSafetyFallbackTimer);
    commandSafetyFallbackTimer = null;
    closeLiveSocket("stop");
}

export function getFoundryLiveSyncStatus() {
    return {
        ...liveState,
        eligible: canOwnLiveConnection(),
        campaignId: getCampaignId(),
        worldId: getWorldId(),
        socketState: socket?.readyState ?? WebSocket.CLOSED
    };
}

async function connectLiveSocket() {
    reconnectTimer = null;
    if (!started) return;
    if (!canOwnLiveConnection()) {
        setLiveState("standby");
        scheduleConnect(30_000);
        return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setLiveState("offline");
        scheduleReconnect();
        return;
    }
    if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;

    const headers = buildWorkerAuthHeaders();
    if (!headers) {
        setLiveState("waiting-auth");
        scheduleConnect(60_000);
        return;
    }

    setLiveState("ticket");
    try {
        const campaignId = getCampaignId();
        const worldId = getWorldId();
        const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/api/foundry/live-ticket`), {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
                contract: buildFoundrySyncContract(),
                campaignId,
                worldId,
                clientId: normalizeId(game.user?.id || "gm")
            }),
            cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok === false || !payload?.ticket) {
            throw new Error(payload?.error || `Live ticket HTTP ${response.status}`);
        }
        if (!started || !canOwnLiveConnection()) return;

        const url = new URL(payload.socketUrl || `${DISCORD_WORKER_URL}/api/foundry/live`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("campaign", campaignId);
        url.searchParams.set("ticket", payload.ticket);
        openWebSocket(url.toString());
    } catch (error) {
        liveState.lastError = String(error?.message || error);
        setLiveState("disconnected");
        console.warn(`${MODULE_ID} | Canale live Foundry non disponibile; resta attivo il fallback.`, error);
        scheduleReconnect();
    }
}

function openWebSocket(url) {
    closeLiveSocket("replace");
    const current = new WebSocket(url);
    socket = current;
    setLiveState("connecting");

    current.addEventListener("open", () => {
        if (socket !== current) return;
        reconnectAttempts = 0;
        liveState.reconnectAttempts = 0;
        liveState.connectedAt = new Date().toISOString();
        liveState.lastError = "";
        setLiveState("connected");
        console.info(`${MODULE_ID} | Canale live Foundry collegato.`, {
            campaignId: getCampaignId(),
            worldId: getWorldId()
        });
    });

    current.addEventListener("message", (event) => {
        if (socket !== current) return;
        handleLiveMessage(event.data);
    });

    current.addEventListener("error", () => {
        if (socket !== current) return;
        liveState.lastError = "WebSocket error";
    });

    current.addEventListener("close", (event) => {
        if (socket !== current) return;
        socket = null;
        liveState.disconnectedAt = new Date().toISOString();
        if (!liveState.lastError && event.code !== 1000) {
            liveState.lastError = `WebSocket chiuso (${event.code})`;
        }
        setLiveState(started ? "disconnected" : "idle");
        if (started) scheduleReconnect();
    });
}

function handleLiveMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw || "")); }
    catch { return; }

    if (message?.type === "hello") {
        // The full startup reconciliation already runs independently. The first
        // hello still performs the lightweight command-only check so a command
        // created during the connection race cannot remain stranded.
        if (!initialHelloHandled) {
            initialHelloHandled = true;
            queueManagedActorCommandCheck("live-connected");
            return;
        }
        queueCollections(["managed-actors", "campaign-items", "light-sync", "economy"], [], {
            reason: "live-reconnect",
            consistencyRetry: false
        });
        return;
    }
    if (message?.type !== "invalidate") return;
    if (normalizeId(message.campaignId) !== getCampaignId()) return;
    if (message.worldId && normalizeId(message.worldId) !== getWorldId()) return;
    if (Array.isArray(message.worldIds) && message.worldIds.length
        && !message.worldIds.map(normalizeId).includes(getWorldId())) return;

    const eventId = String(message.eventId || "").trim();
    if (eventId && seenEventIds.has(eventId)) return;
    if (eventId) rememberEventId(eventId);
    liveState.lastEventAt = new Date().toISOString();
    liveState.lastEventId = eventId;
    queueCollections(message.collections, message.actorIds, {
        reason: message.reason || "live-invalidation",
        consistencyRetry: true
    });
}

function queueCollections(collections, actorIds, { reason = "live", consistencyRetry = true } = {}) {
    (Array.isArray(collections) ? collections : []).map(normalizeCollection).filter(Boolean)
        .forEach((collection) => pendingCollections.add(collection));
    (Array.isArray(actorIds) ? actorIds : []).map(normalizeId).filter(Boolean)
        .forEach((actorId) => pendingActorIds.add(actorId));
    pendingNeedsConsistencyRetry ||= consistencyRetry;
    if (eventTimer) window.clearTimeout(eventTimer);
    eventTimer = window.setTimeout(() => {
        eventTimer = null;
        const collectionSnapshot = new Set(pendingCollections);
        const actorSnapshot = new Set(pendingActorIds);
        const retry = pendingNeedsConsistencyRetry;
        pendingCollections.clear();
        pendingActorIds.clear();
        pendingNeedsConsistencyRetry = false;
        flushChain = flushChain
            .then(() => runCollections(collectionSnapshot, actorSnapshot, { reason }))
            .catch((error) => console.warn(`${MODULE_ID} | Applicazione evento live fallita.`, error));
        if (retry) scheduleConsistencyRetry(collectionSnapshot, actorSnapshot);
    }, EVENT_DEBOUNCE_MS);
}

async function runCollections(collections, actorIds, { reason = "live" } = {}) {
    const tasks = [];
    if (collections.has("managed-actors") && typeof callbacks.pullManagedActors === "function") {
        const commandOnly = String(reason || "").startsWith("managed-actor-command:")
            && typeof callbacks.pullManagedActorCommands === "function";
        tasks.push(Promise.resolve(commandOnly
            ? callbacks.pullManagedActorCommands({ reason })
            : callbacks.pullManagedActors({
                forceIndex: true,
                actorIds: Array.from(actorIds),
                reason
            })));
    }
    if (collections.has("campaign-items") && typeof callbacks.reconcileCampaignItems === "function") {
        tasks.push(Promise.resolve(callbacks.reconcileCampaignItems({ notify: false, reason })));
    }
    if (collections.has("light-sync") && typeof callbacks.runLightSync === "function") {
        tasks.push(Promise.resolve(callbacks.runLightSync({ refreshStatus: true, reason })));
    }
    if (collections.has("economy") && typeof callbacks.pullEconomy === "function") {
        tasks.push(Promise.resolve(callbacks.pullEconomy({ reason })));
    }
    if (!tasks.length) return false;
    const results = await Promise.allSettled(tasks);
    results.filter((result) => result.status === "rejected").forEach((result) => {
        console.warn(`${MODULE_ID} | Aggiornamento live parziale.`, result.reason);
    });
    return results.some((result) => result.status === "fulfilled" && result.value !== false);
}

function queueManagedActorCommandCheck(reason = "command-check") {
    if (typeof callbacks.pullManagedActorCommands !== "function") return Promise.resolve(false);
    flushChain = flushChain
        .then(() => callbacks.pullManagedActorCommands({ reason }))
        .catch((error) => {
            console.warn(`${MODULE_ID} | Controllo comandi Managed Actor fallito.`, error);
            return false;
        });
    return flushChain;
}

function scheduleConsistencyRetry(collections, actorIds) {
    if (consistencyTimer) window.clearTimeout(consistencyTimer);
    consistencyTimer = window.setTimeout(() => {
        consistencyTimer = null;
        flushChain = flushChain
            .then(() => runCollections(collections, actorIds, { reason: "kv-consistency-retry" }))
            .catch((error) => console.warn(`${MODULE_ID} | Retry consistenza live fallito.`, error));
    }, CONSISTENCY_RETRY_MS);
}

function scheduleEligibilityRefresh() {
    if (!started) return;
    window.setTimeout(() => {
        if (canOwnLiveConnection()) {
            if (!socket || socket.readyState === WebSocket.CLOSED) scheduleConnect(250);
        } else {
            closeLiveSocket("standby");
            setLiveState("standby");
        }
    }, 250);
}

function scheduleReconnect() {
    reconnectAttempts += 1;
    liveState.reconnectAttempts = reconnectAttempts;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(7, reconnectAttempts - 1)));
    const jitter = Math.floor(exponential * (0.15 * Math.random()));
    scheduleConnect(exponential + jitter);
}

function scheduleConnect(delay) {
    if (!started || reconnectTimer) return;
    reconnectTimer = window.setTimeout(connectLiveSocket, Math.max(0, delay));
}

function closeLiveSocket(reason = "close") {
    const current = socket;
    socket = null;
    if (!current) return;
    try { current.close(1000, String(reason).slice(0, 80)); } catch {}
}

function clearTimer(kind) {
    const timer = kind === "reconnect" ? reconnectTimer : kind === "event" ? eventTimer : consistencyTimer;
    if (timer) window.clearTimeout(timer);
    if (kind === "reconnect") reconnectTimer = null;
    else if (kind === "event") eventTimer = null;
    else consistencyTimer = null;
}

function canOwnLiveConnection() {
    if (!canStartLiveSync()) return false;
    if (!game?.user?.isGM) return false;
    const activeGm = game.users?.activeGM;
    return !activeGm?.id || String(activeGm.id) === String(game.user.id);
}

function buildWorkerAuthHeaders() {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    if (!token && !secret) return null;
    return {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {})
    };
}

function withCampaign(value) {
    const url = new URL(value);
    url.searchParams.set("campaign", getCampaignId());
    return url.toString();
}

function getCampaignId() {
    return normalizeId(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "cripta-di-sangue") || "cripta-di-sangue";
}

function getWorldId() {
    return normalizeId(game.world?.id || "world") || "world";
}

function normalizeId(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function normalizeCollection(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function rememberEventId(eventId) {
    seenEventIds.add(eventId);
    while (seenEventIds.size > MAX_SEEN_EVENTS) {
        seenEventIds.delete(seenEventIds.values().next().value);
    }
}

function setLiveState(status) {
    liveState.status = status;
}
