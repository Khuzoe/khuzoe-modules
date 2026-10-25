export const MODULE_ID = "cripta-wiki-sync";
export const MODULE_TITLE = "Khuzoe Wiki Sync";
export const DEFAULT_SITE_BASE_URL = "https://khuzoe.github.io/sigillo-del-male";
export const DISCORD_WORKER_URL = "https://sigillo-api.khuzoe.workers.dev";
export const DEFAULT_CAMPAIGN_ID = "cripta-di-sangue";
// Device codes are credentials and must only be configured in the world.
// Never ship working defaults in the client module.
export const DEFAULT_AUTO_DEVICE_LOGIN_CODES = "";

export const SETTINGS = {
    SITE_BASE_URL: "siteBaseUrl",
    CAMPAIGN_ID: "campaignId",
    SHARED_NOTES: "sharedNotes",
    DRAFTS: "draftEntries",
    PERSONAL_NOTES: "personalNotes",
    DISCORD_TOKEN: "discordToken",
    DISCORD_USER: "discordUser",
    AUTO_DEVICE_LOGIN_CODES: "autoDeviceLoginCodes",
    INVENTORY_SYNC_SECRET: "inventorySyncSecret",
    AUTO_CHARACTER_SYNC: "autoCharacterSync",
    LAST_LIGHT_SYNC_STATE_TOKEN: "lastLightSyncStateToken",
    LAST_CHARACTER_SYNC_STATE: "lastCharacterSyncState",
    LAST_REMOTE_SYNC_APPLIED_AT: "lastRemoteSyncAppliedAt",
    PLAYER_ACTOR_MAPPINGS: "playerActorMappings",
    COMPANION_MAPPINGS: "companionMappings",
    SYNC_MODE: "syncMode"
};

export const MENUS = {
    AUTO_DEVICE_LOGIN: "autoDeviceLoginMenu",
    COMPANION_MAPPINGS: "companionMappingsMenu"
};

export const FLAGS = {
    LINK: "wikiLink"
};

export const SECTIONS = {
    HOME: "home",
    SESSIONS: "sessions",
    CHARACTERS: "characters",
    PLAYERS: "players",
    ITEMS: "items"
};
