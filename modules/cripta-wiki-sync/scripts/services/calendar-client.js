import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { getSyncPolicyStatus } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";

const PATHS = new Set(["", "events/upsert", "events/archive", "clock", "config"]);
let lastToken;
let identityVersion = 0;

export function getCalendarContext() {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "");
    if (token !== lastToken) { identityVersion++; lastToken = token; }
    return {
        identityVersion,
        campaignId: String(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "").trim(),
        siteUrl: String(game.settings.get(MODULE_ID, SETTINGS.SITE_BASE_URL) || ""),
        authenticated: Boolean(token),
        ...getSyncPolicyStatus()
    };
}

export async function requestCalendar(path = "", body = undefined) {
    if (!PATHS.has(path)) throw new Error("Operazione calendario non supportata.");
    const context = getCalendarContext();
    if (!context.campaignId) throw new Error("Seleziona la campagna nelle impostazioni di Khuzoe Wiki Sync.");
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (body !== undefined && !token) throw new Error("Accedi alla wiki prima di modificare il calendario.");
    const url = new URL(`${DISCORD_WORKER_URL}/api/calendar${path ? `/${path}` : ""}`);
    url.searchParams.set("campaign", context.campaignId);
    const response = await policyFetch(url, {
        method: body === undefined ? "GET" : "POST", cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json().catch(() => null);
    if (getCalendarContext().identityVersion !== context.identityVersion) throw new Error("L'account wiki è cambiato durante la richiesta. Aggiorna il calendario.");
    if (!response.ok || !result || result.ok === false) {
        const error = new Error(result?.error || `Calendario non disponibile (${response.status}).`);
        error.code = result?.code || "CALENDAR_REQUEST_FAILED";
        error.status = response.status;
        throw error;
    }
    if (result.campaignId !== context.campaignId) throw new Error("Il calendario ricevuto appartiene a un'altra campagna.");
    return result;
}
