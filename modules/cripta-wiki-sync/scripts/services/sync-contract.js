import { MODULE_ID } from "../constants.js";

export const FOUNDRY_SYNC_CONTRACT_VERSION = 1;

export function buildFoundrySyncContract() {
    const moduleVersion = String(game.modules.get(MODULE_ID)?.version || "");
    return {
        name: "khuzoe-wiki-sync",
        version: FOUNDRY_SYNC_CONTRACT_VERSION,
        module: { id: MODULE_ID, version: moduleVersion },
        foundry: {
            generation: Math.max(0, Number(game.release?.generation || String(game.version || "").split(".")[0] || 0)),
            version: String(game.version || game.release?.version || "")
        },
        system: {
            id: String(game.system?.id || ""),
            version: String(game.system?.version || "")
        }
    };
}
