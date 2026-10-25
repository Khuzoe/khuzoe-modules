import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { canPullFromWorker, canPushToWorker } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";
import { buildFoundrySyncContract } from "./sync-contract.js";

const MERCHANT_MODULE_ID = "khuzoe-merchant";
const STATE_SETTING = "economySyncState";
const PUSH_DELAY_MS = 900;

let registered = false;
let started = false;
let pushTimer = null;
let pendingRegistry = null;
let syncChain = Promise.resolve();

export function registerEconomySync() {
    if (registered) return;
    registered = true;
    game.settings.register(MODULE_ID, STATE_SETTING, {
        name: "Stato sincronizzazione economia",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: { version: 0, registryRevision: 0, updatedAt: "" }
    });

    Hooks.on(`${MERCHANT_MODULE_ID}.economyUpdated`, (registry) => {
        if (!canSync() || registry?.source === "site") return;
        pendingRegistry = registry;
        if (pushTimer) window.clearTimeout(pushTimer);
        pushTimer = window.setTimeout(() => {
            pushTimer = null;
            const snapshot = pendingRegistry;
            pendingRegistry = null;
            syncChain = syncChain
                .then(() => pushEconomyRegistry(snapshot))
                .catch((error) => console.warn(`${MODULE_ID} | Sync valute verso il sito fallita.`, error));
        }, PUSH_DELAY_MS);
    });
}

export function startEconomySync() {
    if (started || !canSync("pull")) return;
    started = true;
    window.setTimeout(() => {
        syncChain = syncChain
            .then(() => reconcileEconomyRegistry())
            .catch((error) => console.warn(`${MODULE_ID} | Avvio sincronizzazione valute fallito.`, error));
    }, 1_200);
}

export async function pullEconomyRegistry({ reason = "site-update" } = {}) {
    if (!canSync("pull")) return false;
    const payload = await requestEconomy();
    if (!payload?.registry) return false;
    const api = merchantEconomyApi();
    const local = api.getRegistry();
    const changed = comparable(local) !== comparable(payload.registry);
    if (changed) await api.applyRegistrySnapshot(payload.registry, { source: "site" });
    await saveState(payload);
    if (changed) {
        ui.notifications?.info?.("Valute della campagna aggiornate dal sito.");
        console.info(`${MODULE_ID} | Valute aggiornate dal sito.`, {
            reason,
            version: payload.version,
            revision: payload.registry.revision
        });
    }
    return changed;
}

export async function pushEconomyRegistry(registry = null) {
    if (!canSync("push")) return false;
    const api = merchantEconomyApi();
    const snapshot = registry || api.getRegistry();
    let state = getState();
    if (!Number.isFinite(Number(state.version))) {
        const current = await requestEconomy();
        state = await saveState(current);
    }
    const response = await policyFetch(economyUrl(), {
        method: "POST",
        headers: { ...buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            contract: buildFoundrySyncContract(),
            expectedVersion: Number(state.version || 0),
            worldId: normalizeId(game.world?.id || "world"),
            registry: snapshot
        }),
        cache: "no-store"
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 409) {
        await pullEconomyRegistry({ reason: "version-conflict" });
        ui.notifications?.warn?.("Le valute erano state modificate sul sito: ho caricato la versione più recente senza sovrascriverla.");
        return false;
    }
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Economy sync HTTP ${response.status}`);
    await saveState(payload);
    console.info(`${MODULE_ID} | Valute sincronizzate con il sito.`, { version: payload.version, revision: payload.registry?.revision });
    return true;
}

async function reconcileEconomyRegistry() {
    const remote = await requestEconomy();
    const local = merchantEconomyApi().getRegistry();
    if (Number(remote?.version || 0) <= 0) {
        await saveState(remote || { version: 0, registry: { revision: 0 } });
        return pushEconomyRegistry(local);
    }
    return pullEconomyRegistry({ reason: "startup" });
}

async function requestEconomy() {
    // The registry is public to read. A stale site token must not make a valid
    // GET fail; authentication remains mandatory for writes.
    const response = await policyFetch(economyUrl(), { headers: { Accept: "application/json" }, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Economy HTTP ${response.status}`);
    return payload;
}

function merchantEconomyApi() {
    const api = game.modules.get(MERCHANT_MODULE_ID)?.api?.economy;
    if (!api?.getRegistry || !api?.applyRegistrySnapshot) {
        throw new Error("Khuzoe Merchant 1.6.0 o successivo non è disponibile.");
    }
    return api;
}

function canSync(direction = "push") {
    if (!game.user?.isGM || !game.modules.get(MERCHANT_MODULE_ID)?.active) return false;
    const activeGm = game.users?.activeGM;
    if (activeGm?.id && String(activeGm.id) !== String(game.user.id)) return false;
    return direction === "pull" ? canPullFromWorker() : canPushToWorker();
}

function economyUrl() {
    const url = new URL(`${DISCORD_WORKER_URL}/api/economy`);
    url.searchParams.set("campaign", normalizeId(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "cripta-di-sangue"));
    return url.toString();
}

function buildHeaders() {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    return {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {})
    };
}

function getState() {
    const value = game.settings.get(MODULE_ID, STATE_SETTING);
    return value && typeof value === "object" ? value : { version: 0, registryRevision: 0, updatedAt: "" };
}

async function saveState(payload) {
    const state = {
        version: Math.max(0, Number(payload?.version || 0)),
        registryRevision: Math.max(0, Number(payload?.registry?.revision || 0)),
        updatedAt: String(payload?.updatedAt || new Date().toISOString())
    };
    await game.settings.set(MODULE_ID, STATE_SETTING, state);
    return state;
}

function comparable(value) {
    return JSON.stringify({ ...(value || {}), updatedAt: "", source: "" });
}

function normalizeId(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}
