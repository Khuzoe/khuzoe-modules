import { canAcknowledgeRemotePull, canAuthenticateRemote, canPushToWorker, getSyncMode, SYNC_MODES, syncPolicyError } from "./sync-policy.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FOUNDRY_CONTRACT_HEADER = "X-Khuzoe-Sync-Contract";
const FOUNDRY_GENERATION_HEADER = "X-Khuzoe-Foundry-Generation";
const AUTHENTICATION_PATHS = new Set([
    "/auth/device/login",
    "/api/foundry/live-ticket"
]);
const MANAGED_ACTOR_ACK_PATH = /^\/api\/managed-actor-commands\/[^/]+\/ack$/;
const MANAGED_ACTOR_DOCUMENT_PATH = /^\/api\/managed-actors\/[^/]+\/[^/]+$/;

function requestPath(input) {
    try {
        const value = typeof input === "string" || input instanceof URL ? input : input?.url;
        return new URL(value, globalThis.location?.href || "https://foundry.invalid").pathname;
    } catch (_error) {
        return "";
    }
}

export async function policyFetch(input, init = {}) {
    const nativeInit = { ...(init || {}) };
    const syncIntent = String(nativeInit.khuzoeSyncIntent || "");
    delete nativeInit.khuzoeSyncIntent;
    const method = String(nativeInit.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const headers = new Headers(nativeInit.headers || (input instanceof Request ? input.headers : undefined));
    const carriesFoundrySecret = headers.has("X-Cripta-Inventory-Secret") || headers.has("X-Inventory-Sync-Secret");
    const requestInit = (!SAFE_METHODS.has(method) || carriesFoundrySecret)
        ? withFoundryContractHeaders(nativeInit, headers)
        : nativeInit;
    if (SAFE_METHODS.has(method)) return globalThis.fetch(input, requestInit);

    const path = requestPath(input);
    if (AUTHENTICATION_PATHS.has(path) && canAuthenticateRemote()) {
        return globalThis.fetch(input, requestInit);
    }
    if (method === "POST" && MANAGED_ACTOR_ACK_PATH.test(path) && canAcknowledgeRemotePull()) {
        return globalThis.fetch(input, requestInit);
    }
    if (method === "POST"
        && MANAGED_ACTOR_DOCUMENT_PATH.test(path)
        && syncIntent === "managed-actor-command-reconciliation"
        && canAcknowledgeRemotePull()) {
        return globalThis.fetch(input, requestInit);
    }
    if (!canPushToWorker()) {
        throw syncPolicyError(`${method} ${path || "richiesta remota"}`);
    }
    return globalThis.fetch(input, requestInit);
}

function withFoundryContractHeaders(init, headers) {
    const generation = Number(globalThis.game?.release?.generation)
        || Number.parseInt(String(globalThis.game?.version || "").split(".")[0], 10)
        || 14;
    headers.set(FOUNDRY_CONTRACT_HEADER, "1");
    headers.set(FOUNDRY_GENERATION_HEADER, String(generation));
    return { ...init, headers };
}

export function assertRemoteWritesEnabled(action = "scrittura remota") {
    if (!canPushToWorker()) throw syncPolicyError(action);
}

export function isStrictDiagnosticMode() {
    return getSyncMode() === SYNC_MODES.DIAGNOSTIC;
}
