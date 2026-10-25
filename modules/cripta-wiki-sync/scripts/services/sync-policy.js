import { MODULE_ID, SETTINGS } from "../constants.js";

export const SYNC_MODES = Object.freeze({
    DIAGNOSTIC: "diagnostic",
    PULL: "pull",
    PUSH: "push",
    BIDIRECTIONAL: "bidirectional"
});

const MODE_LABELS = Object.freeze({
    [SYNC_MODES.DIAGNOSTIC]: "Diagnostica (nessuna scrittura)",
    [SYNC_MODES.PULL]: "Solo sito → Foundry",
    [SYNC_MODES.PUSH]: "Solo Foundry → sito",
    [SYNC_MODES.BIDIRECTIONAL]: "Bidirezionale"
});

export function registerSyncPolicySettings() {
    game.settings.register(MODULE_ID, SETTINGS.SYNC_MODE, {
        name: "Modalità sincronizzazione",
        hint: "La modalità Diagnostica è il valore sicuro per il primo avvio v14. Pull può modificare il mondo Foundry; Push e Bidirezionale possono scrivere sul Worker.",
        scope: "world",
        config: true,
        restricted: true,
        type: String,
        choices: MODE_LABELS,
        default: SYNC_MODES.DIAGNOSTIC,
        requiresReload: true
    });
}

export function getSyncMode() {
    try {
        const configured = String(game.settings.get(MODULE_ID, SETTINGS.SYNC_MODE) || "").trim();
        return Object.values(SYNC_MODES).includes(configured) ? configured : SYNC_MODES.DIAGNOSTIC;
    } catch (_error) {
        return SYNC_MODES.DIAGNOSTIC;
    }
}

export function canReadRemote() {
    return true;
}

export function canPullFromWorker() {
    return [SYNC_MODES.PULL, SYNC_MODES.BIDIRECTIONAL].includes(getSyncMode());
}

export function canPushToWorker() {
    return [SYNC_MODES.PUSH, SYNC_MODES.BIDIRECTIONAL].includes(getSyncMode());
}

export function canAuthenticateRemote() {
    return getSyncMode() !== SYNC_MODES.DIAGNOSTIC;
}

export function canAcknowledgeRemotePull() {
    return canPullFromWorker();
}

export function canStartLiveSync() {
    return canPullFromWorker();
}

export function getSyncPolicyStatus() {
    const mode = getSyncMode();
    return {
        mode,
        label: MODE_LABELS[mode],
        remoteReads: canReadRemote(),
        localPullWrites: canPullFromWorker(),
        remoteWrites: canPushToWorker(),
        liveSync: canStartLiveSync()
    };
}

export function syncPolicyError(action) {
    const error = new Error(`Operazione bloccata dalla modalità ${MODE_LABELS[getSyncMode()] || getSyncMode()}: ${action}.`);
    error.code = "KHUZOE_SYNC_POLICY_BLOCKED";
    error.syncMode = getSyncMode();
    return error;
}
