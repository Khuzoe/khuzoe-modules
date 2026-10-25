import { DEFAULT_AUTO_DEVICE_LOGIN_CODES, DEFAULT_CAMPAIGN_ID, DISCORD_WORKER_URL, FLAGS, MENUS, MODULE_ID, MODULE_TITLE, SECTIONS, SETTINGS } from "./constants.js";
import { wikiStore } from "./services/wiki-store.js";
import { wikiDataService } from "./services/wiki-data-service.js";
import { escapeHtml, normalizeWikiItemKey, slugify, withCampaign as withCampaignUrl } from "./services/wiki-utils.js";
import { CriptaWikiBrowserApp } from "./apps/wiki-browser-app.js";
import { CriptaWikiEntityApp } from "./apps/wiki-entity-app.js";
import { CriptaWikiSkillTreeApp } from "./apps/wiki-skill-tree-app.js";
import {
    HandlebarsApplicationV2,
    confirmDialog,
    openApplications,
    renderApplication,
    renderDialog,
    rerenderApplication
} from "./foundry-compat.js";
import { ensureManagedActorTransferIds, isManagedActorShared, loadManagedActorRelationshipIndex, loadNpcCategoryRegistry, pullManagedActorCommandsNow, pullManagedActorVariants, queueManagedActorContentSync, registerManagedActorSync, resumeManagedActorSyncQueue, saveManagedActorNpcCategory, saveManagedActorRelationship, saveNpcCategoryRegistry, startManagedActorVariantPull, syncManagedActorNow } from "./services/managed-actor-sync.js";
import { reconcileCampaignItemsNow, registerCampaignItemSync, startCampaignItemSync } from "./services/campaign-item-sync.js";
import { getFoundryLiveSyncStatus, refreshFoundryLiveSync, registerFoundryLiveSync, startFoundryLiveSync } from "./services/foundry-live-sync.js";
import { pullEconomyRegistry, pushEconomyRegistry, registerEconomySync, startEconomySync } from "./services/economy-sync.js";
import { canAuthenticateRemote, canPullFromWorker, canPushToWorker, canStartLiveSync, getSyncMode, getSyncPolicyStatus, registerSyncPolicySettings, SYNC_MODES } from "./services/sync-policy.js";
import { policyFetch } from "./services/worker-gateway.js";
import { getCalendarContext, requestCalendar } from "./services/calendar-client.js";
import { normalizeActiveEffectChangesV14, normalizeActiveEffectSourceV14 } from "./services/foundry-v14.js";
import { buildFoundrySyncContract } from "./services/sync-contract.js";
import { applySkillTreeActorPlan, createSkillTreeSyncQueue, isArchivedSkillTree, isSharedSkillTree, isSkillTreeSyncLeader, planSkillTreeActor, summarizeSkillTreePlans, validateSkillTreeSnapshot } from "./services/skill-tree-sync.js";
import { createOverrideSummary, formatOverrideSummary, planSiteOverrideState, recordOverrideOutcome } from "./services/site-override-state.js";
import { readSpellPreparation, spellPreparationForWiki } from "./services/dnd5e-fields.js";
import { isTemporaryWikiActor } from "./services/actor-sync-eligibility.mjs";

let characterSyncTimer = null;
let suppressCharacterSync = false;
const regenerationTurnKeys = new Set();
const TOKENIZER_MODULE_ID = "khuzoe-tokenizer";
const TOKENIZER_SYNC_SOURCE = MODULE_ID;
const LEGACY_TOKEN_SWITCHER_MODULE_ID = "khuzoe-token-switcher";
const LEGACY_TOKEN_SWITCHER_IMAGES_FLAG = "images";
const LEGACY_TOKEN_SWITCHER_MIGRATED_FLAG = "legacyTokenSwitcherMigrated";
const MANAGED_MEDIA_FLAG = "managedMedia";
const LOCAL_MEDIA_ROOT = "cripta-wiki-sync";
const MODULE_UPDATE_MANIFEST_URL = "https://khuzoe.github.io/sigillo-del-male/dist/module.json";
const MEDIA_EXISTS_CACHE_TTL = 60_000;
const MEDIA_CHECK_BATCH_LIMIT = 100;
const MEDIA_CHECK_BATCH_DELAY_MS = 25;
const MEDIA_CHECK_BATCH_BACKOFF_MS = 5 * 60_000;
const LOCAL_FILE_EXISTS_CACHE_TTL = 10 * 60_000;
const MANAGED_MEDIA_NETWORK_LIMIT = 4;
const MANAGED_MEDIA_BOOTSTRAP_LIMIT = 3;
const ABILITY_ICON_SYNC_SIZE = 256;
const CHARACTER_IMAGE_SYNC_SIZE = 512;
const LIGHT_SYNC_SCHEMA_VERSION = 4;
const AUTOMATIC_REMOTE_SYNC_COLLECTIONS = new Set(["skill-trees", "skill-tree-states", "transformations"]);
const MANUAL_REMOTE_SYNC_COLLECTIONS = new Set(["asset-sync-jobs"]);
const CHARACTER_SYNC_DEBOUNCE_MS = 10_000;
let managedMediaNetworkActive = 0;
const managedMediaNetworkQueue = [];
const mediaExistsCache = new Map();
const mediaExistsPromises = new Map();
const mediaCheckBatchQueue = new Map();
const pendingItemImageSyncQueue = new Map();
const localFileExistsCache = new Map();
const localDirectoryCache = new Map();
const ensuredFoundryDirectories = new Set();
let mediaCheckBatchTimer = null;
let itemImageSyncTimer = null;
let mediaCheckBatchUnavailableUntil = 0;
let autoCharacterSyncDisabledWarningShown = false;
const transformationOverrideCache = {
    loadedAt: 0,
    promise: null,
    data: []
};
const managedActorShareSyncs = new Set();

async function withCharacterSyncSuppressed(task) {
    const previous = suppressCharacterSync;
    suppressCharacterSync = true;
    try {
        return await task();
    } finally {
        suppressCharacterSync = previous;
    }
}
const workerSyncStatusCache = {
    loadedAt: 0,
    promise: null,
    data: null
};
const WIKI_DAMAGE_TYPE_LABELS = {
    acid: "Acido",
    bludgeoning: "Contundente",
    cold: "Freddo",
    fire: "Fuoco",
    force: "Forza",
    genie: "Geniale",
    lightning: "Fulmine",
    necrotic: "Necrotico",
    piercing: "Perforante",
    poison: "Veleno",
    psychic: "Psichico",
    radiant: "Radiante",
    slashing: "Tagliente",
    thunder: "Tuono"
};
const WIKI_PLAYER_ID_ALIASES = {
    garun: ["garun", "ga run", "ga'run", "luca"],
    randra: ["randra", "ran dra", "ran'dra", "eli"],
    valdor: ["valdor", "sommo"],
    theldarion: ["theldarion", "theldarion tessaryn", "theldari", "dona"],
    apothecary: ["apothecary"]
};
const skillTreesCache = {
    loadedAt: 0,
    promise: null,
    data: null
};
let skillTreeAbilitySyncTimer = null;

function registerSettings() {
    registerSyncPolicySettings();
    game.settings.registerMenu(MODULE_ID, MENUS.AUTO_DEVICE_LOGIN, {
        name: "Login automatico utenti",
        label: "Configura codici",
        hint: "Assegna un codice accesso a ogni utente Foundry della campagna.",
        icon: "fas fa-user",
        type: AutoDeviceLoginConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, MENUS.COMPANION_MAPPINGS, {
        name: "Avanzato: mapping Actor",
        label: "Apri configurazione",
        hint: "Configurazione tecnica di fallback. Per aggiungere o rimuovere companion usa il pulsante Companion sulla scheda del personaggio.",
        icon: "fas fa-paw",
        type: CompanionMappingsConfigApp,
        restricted: true
    });

    game.settings.register(MODULE_ID, SETTINGS.SITE_BASE_URL, {
        name: "URL base della wiki",
        hint: "Origine usata per leggere dati e CSS della wiki pubblicata.",
        scope: "world",
        config: true,
        restricted: true,
        type: String,
        default: "https://khuzoe.github.io/sigillo-del-male",
        onChange: () => wikiDataService.invalidate()
    });

    game.settings.register(MODULE_ID, SETTINGS.CAMPAIGN_ID, {
        name: "Campagna wiki",
        hint: "Identificativo campagna usato per dati, appunti, sondaggi e sync personaggi.",
        scope: "world",
        config: true,
        restricted: true,
        type: String,
        default: DEFAULT_CAMPAIGN_ID,
        onChange: () => wikiDataService.invalidate()
    });

    game.settings.register(MODULE_ID, SETTINGS.SHARED_NOTES, {
        name: "Archivio appunti condivisi",
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    game.settings.register(MODULE_ID, SETTINGS.DRAFTS, {
        name: "Bozze generate da Foundry",
        scope: "world",
        config: false,
        type: Object,
        default: {
            entries: {}
        }
    });

    game.settings.register(MODULE_ID, SETTINGS.PERSONAL_NOTES, {
        name: "Appunti personali utente",
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    game.settings.register(MODULE_ID, SETTINGS.DISCORD_TOKEN, {
        name: "Token accesso wiki",
        scope: "client",
        config: false,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.DISCORD_USER, {
        name: "Utente wiki autenticato",
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    game.settings.register(MODULE_ID, SETTINGS.AUTO_DEVICE_LOGIN_CODES, {
        name: "Mappa login automatico con codice",
        hint: "Dato interno configurato dal menu Login automatico utenti.",
        scope: "world",
        config: false,
        restricted: true,
        type: String,
        default: DEFAULT_AUTO_DEVICE_LOGIN_CODES
    });

    game.settings.register(MODULE_ID, SETTINGS.AUTO_CHARACTER_SYNC, {
        name: "Sincronizza personaggi automaticamente",
        hint: "Il GM attivo invia al worker una snapshot dei personaggi giocanti all'avvio e quando cambiano actor/oggetti.",
        scope: "world",
        config: true,
        restricted: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET, {
        name: "Secret sync personaggi",
        hint: "Opzionale. Se il Worker ha INVENTORY_SYNC_SECRET, inserisci qui lo stesso valore per autorizzare il POST.",
        scope: "world",
        config: true,
        restricted: true,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.LAST_LIGHT_SYNC_STATE_TOKEN, {
        name: "Ultimo state token sync leggera",
        hint: "Dato interno usato per saltare sync leggere automatiche quando il worker non e cambiato.",
        scope: "world",
        config: false,
        restricted: true,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.LAST_CHARACTER_SYNC_STATE, {
        name: "Ultimo stato sync personaggi",
        hint: "Dato interno usato per saltare POST personaggi quando lo snapshot Foundry non e cambiato.",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: {}
    });

    game.settings.register(MODULE_ID, SETTINGS.LAST_REMOTE_SYNC_APPLIED_AT, {
        name: "Ultima sync remota applicata",
        hint: "Dato interno usato per leggere dal worker solo le modifiche del sito non ancora applicate a Foundry.",
        scope: "world",
        config: false,
        restricted: true,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.COMPANION_MAPPINGS, {
        name: "Mappatura companion",
        hint: "Dato interno configurato dal menu Companion personaggi.",
        scope: "world",
        config: false,
        restricted: true,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.PLAYER_ACTOR_MAPPINGS, {
        name: "Mappatura actor personaggi",
        hint: "Dato interno configurato dal menu Actor personaggi e companion.",
        scope: "world",
        config: false,
        restricted: true,
        type: String,
        default: ""
    });
}

class AutoDeviceLoginConfigApp extends HandlebarsApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "cripta-auto-device-login-config",
        tag: "form",
        classes: ["cripta-config-v14"],
        position: { width: 620, height: "auto" },
        window: { icon: "fa-solid fa-user-shield", resizable: true },
        form: { closeOnSubmit: true, handler: AutoDeviceLoginConfigApp._onSubmitForm }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/auto-device-login-config.hbs` }
    };

    get title() {
        return "Login automatico utenti";
    }

    async _prepareContext(options = {}) {
        const context = await super._prepareContext(options);
        const configured = parseAutoDeviceLoginConfig();
        const users = game.users
            .map((user) => ({
                id: user.id,
                name: user.name,
                code: configured.get(user.id) || configured.get(user.name) || ""
            }))
            .sort((left, right) => left.name.localeCompare(right.name, "it"));

        return { ...context, users };
    }

    static _onSubmitForm(event, _form, formData) {
        return this._updateObject(event, formData.object);
    }

    async _updateObject(_event, formData) {
        const rows = game.users
            .map((user) => {
                const code = String(formData[`code.${user.id}`] || "").trim();
                return code ? `${user.id} | ${code}` : "";
            })
            .filter(Boolean);

        await game.settings.set(MODULE_ID, SETTINGS.AUTO_DEVICE_LOGIN_CODES, rows.join("\n"));
        ui.notifications.info("Codici login automatico aggiornati.");
    }
}

class CompanionMappingsConfigApp extends HandlebarsApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "cripta-companion-mappings-config",
        tag: "form",
        classes: ["cripta-config-v14"],
        position: { width: 980, height: "auto" },
        window: { icon: "fa-solid fa-paw", resizable: true },
        form: { closeOnSubmit: true, handler: CompanionMappingsConfigApp._onSubmitForm }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/companion-mappings-config.hbs` }
    };

    get title() {
        return "Actor personaggi e companion";
    }

    async _prepareContext(options = {}) {
        const context = await super._prepareContext(options);
        const mappings = parseCompanionMappings();
        const playerMappings = parsePlayerActorMappings();
        const campaignPlayers = await loadCampaignPlayersForMappingConfig();
        const users = game.users
            .map((user) => {
                const accountId = getConfiguredAccountIdForUser(user, playerMappings);
                const mappedPlayer = getConfiguredPlayerMappingForUser(user, playerMappings);
                const suggestedPlayer = findCampaignPlayerForAccount(campaignPlayers, mappedPlayer?.ownerCharacterId, accountId);
                return {
                    id: user.id,
                    name: user.name,
                    isGM: user.isGM,
                    accountId,
                    characterId: mappedPlayer?.ownerCharacterId || suggestedPlayer?.id || "",
                    characterName: suggestedPlayer?.name || "",
                    actor: mappedPlayer?.actorRef || "",
                    companions: getConfiguredCompanionActorRefsForUser(user, mappings).join(", ")
                };
            })
            .sort((left, right) => {
                if (left.isGM !== right.isGM) return left.isGM ? 1 : -1;
                return left.name.localeCompare(right.name, "it");
            });

        return { ...context, users, campaignPlayers };
    }

    static _onSubmitForm(event, _form, formData) {
        return this._updateObject(event, formData.object);
    }

    async _updateObject(_event, formData) {
        const rows = game.users
            .map((user) => {
                const accountId = String(formData[`account.${user.id}`] || "").trim();
                const characterId = slugify(formData[`character.${user.id}`] || "");
                const actorRef = normalizeActorRef(formData[`actor.${user.id}`] || "");
                const companionActorIds = String(formData[`companions.${user.id}`] || "")
                    .split(/[,;]/)
                    .map(normalizeActorRef)
                    .filter(Boolean);
                return compactObject({
                    userId: user.id,
                    userName: user.name,
                    accountId,
                    characterId,
                    actorId: actorRef,
                    companionActorIds
                });
            })
            .filter((row) => row.accountId || row.characterId || row.actorId || row.companionActorIds?.length);
        const playerRows = rows
            .filter((row) => row.characterId && row.actorId)
            .map((row) => ({
                userId: row.userId,
                userName: row.userName,
                accountId: row.accountId,
                characterId: row.characterId,
                actorId: row.actorId
            }));
        const companionRows = rows
            .filter((row) => row.characterId && row.companionActorIds?.length)
            .map((row) => ({
                userId: row.userId,
                userName: row.userName,
                accountId: row.accountId,
                characterId: row.characterId,
                companionActorIds: row.companionActorIds
            })
        );

        await game.settings.set(MODULE_ID, SETTINGS.PLAYER_ACTOR_MAPPINGS, JSON.stringify({
            version: 2,
            campaignId: getCampaignId(),
            rows: playerRows
        }));
        await game.settings.set(MODULE_ID, SETTINGS.COMPANION_MAPPINGS, JSON.stringify({
            version: 2,
            campaignId: getCampaignId(),
            rows: companionRows
        }));
        ui.notifications.info("Mappatura actor aggiornata.");
        scheduleCharacterSync("actorMappings");
    }
}

function openWikiBrowser(section) {
    const application = new CriptaWikiBrowserApp({ section });
    renderApplication(application, { force: true });
    return application;
}

function resolveDocumentFromToken(tokenLike) {
    if (!tokenLike) return null;
    if (tokenLike.document) return tokenLike.document;
    return tokenLike;
}

function openWikiForDocument(document) {
    const application = new CriptaWikiEntityApp({ document });
    renderApplication(application, { force: true });
    return application;
}

function getOpenWikiWindows() {
    return Array.from(openApplications()).filter((windowApp) =>
        windowApp instanceof CriptaWikiBrowserApp
        || windowApp instanceof CriptaWikiEntityApp
        || windowApp instanceof CriptaWikiSkillTreeApp
    );
}

function propagateAuthToken(token, user = null) {
    game.settings.set(MODULE_ID, SETTINGS.DISCORD_TOKEN, String(token || "")).then(() => Hooks.callAll("khuzoeWikiSync.authChanged")).catch(() => {});
    if (user) {
        game.settings.set(MODULE_ID, SETTINGS.DISCORD_USER, user).catch(() => {});
    }
    getOpenWikiWindows().forEach((windowApp) => {
        if (typeof windowApp.sendAuthToken === "function") {
            windowApp.sendAuthToken(token);
        }
    });
    window.setTimeout(() => refreshFoundryLiveSync({ reason: "auth-token" }), 250);
}

async function getValidAuthSession() {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (!token) return null;

    try {
        const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/auth/discord/verify`), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data?.user) {
            throw new Error("Token non valido");
        }

        game.settings.set(MODULE_ID, SETTINGS.DISCORD_USER, data.user).catch(() => {});
        return data;
    } catch (_) {
        game.settings.set(MODULE_ID, SETTINGS.DISCORD_TOKEN, "").catch(() => {});
        game.settings.set(MODULE_ID, SETTINGS.DISCORD_USER, {}).catch(() => {});
        return null;
    }
}

function promptDeviceLogin() {
    renderDialog({
        title: "Login wiki",
        content: `
            <p>Accedi con il codice personale per usare gli appunti della wiki dentro Foundry.</p>
        `,
        buttons: {
            code: {
                icon: '<i class="fas fa-user"></i>',
                label: "Usa codice",
                callback: () => promptDeviceCodeLogin()
            },
            later: {
                icon: '<i class="fas fa-clock"></i>',
                label: "Piu tardi"
            }
        },
        default: "code"
    });
}

function promptDeviceCodeLogin() {
    renderDialog({
        title: "Codice accesso",
        content: `
            <form>
                <div class="form-group">
                    <label>Codice personale</label>
                    <input type="text" name="deviceCode" autocomplete="off" placeholder="GARUN-X7K9-Q2M4">
                </div>
            </form>
        `,
        buttons: {
            login: {
                icon: '<i class="fas fa-user"></i>',
                label: "Accedi",
                callback: (html) => {
                    const code = html.find?.("[name='deviceCode']").val?.() || "";
                    loginWithDeviceCode(code).catch((error) => {
                        ui.notifications.error(error?.message || String(error || "Login non riuscito."));
                    });
                }
            },
            cancel: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Annulla"
            }
        },
        default: "login"
    });
}

async function loginWithDeviceCode(code) {
    const cleanCode = String(code || "").trim();
    if (!cleanCode) {
        throw new Error("Inserisci un codice accesso.");
    }

    const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/auth/device/login`), {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ code: cleanCode, campaignId: getCampaignId() })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.token) {
        throw new Error(data?.error || `HTTP ${response.status}`);
    }

    propagateAuthToken(data.token, data.user || null);
    ui.notifications.info("Login con codice completato.");
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function toNumberFromValueOrObject(value) {
    if (value && typeof value === "object") {
        return toNumberOrNull(value.value ?? value.total ?? value.flat);
    }
    return toNumberOrNull(value);
}

function toLeadingNumberOrNull(value) {
    const match = String(value || "").trim().match(/^-?\d+(?:[.,]\d+)?/);
    if (!match) return null;
    const number = Number(match[0].replace(",", "."));
    return Number.isFinite(number) ? number : null;
}

function toChallengeRatingNumberOrZero(value) {
    const raw = value && typeof value === "object"
        ? value.value ?? value.cr ?? value.challenge ?? value.flat ?? value.total
        : value;
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;

    const text = String(raw).trim().replace(",", ".");
    const fraction = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (fraction) {
        const numerator = Number(fraction[1]);
        const denominator = Number(fraction[2]);
        const number = denominator ? numerator / denominator : NaN;
        return Number.isFinite(number) ? number : 0;
    }

    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return 0;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : 0;
}

function getPlainItemSystem(item) {
    return item?.toObject?.(false)?.system ?? item?.toObject?.()?.system ?? item?.system ?? {};
}

function getPrimaryActivityData(system) {
    const activities = system?.activities;
    if (!activities) return null;
    if (activities instanceof Map) return activities.values().next().value || null;
    if (Array.isArray(activities)) return activities[0] || null;
    if (typeof activities === "object") return Object.values(activities)[0] || null;
    return null;
}

function getActivityActivationData(system) {
    const activity = getPrimaryActivityData(system);
    return compactObject({
        type: activity?.activation?.type ?? system?.activation?.type,
        value: activity?.activation?.value ?? system?.activation?.value
    });
}

function getActivityRangeData(system) {
    const activity = getPrimaryActivityData(system);
    return compactObject({
        value: activity?.range?.value ?? system?.range?.value,
        units: activity?.range?.units ?? system?.range?.units
    });
}

function getActivityDurationData(system) {
    const activity = getPrimaryActivityData(system);
    return compactObject({
        value: activity?.duration?.value ?? system?.duration?.value,
        units: activity?.duration?.units ?? system?.duration?.units
    });
}

function compactObject(obj, options = {}) {
    const keepNullKeys = Array.isArray(options.keepNullKeys) ? options.keepNullKeys : [];
    return Object.fromEntries(Object.entries(obj).filter(([key, value]) => {
        if (value === undefined) return false;
        if (value === null) return keepNullKeys.includes(key);
        if (typeof value === "string") return value.trim() !== "";
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === "object") return Object.keys(value).length > 0;
        return true;
    }));
}

const CHARACTER_SYNC_ITEM_TYPES = new Set(["equipment", "weapon", "armor", "consumable", "tool", "loot", "backpack", "container", "feat"]);
const COMPANION_SYNC_ITEM_TYPES = new Set([...CHARACTER_SYNC_ITEM_TYPES, "feat"]);
const CHARACTER_SYNC_SPELL_METHODS = new Set(["spell", "atwill", "innate", "pact"]);
const CHARACTER_SYNC_DESCRIPTION_LIMIT = 2400;
const ITEM_LOADOUT_ROLE_FLAG = "loadoutRole";
const ITEM_LOADOUT_SUBTYPE_FLAG = "loadoutSubtype";
const ITEM_LOADOUT_ROLE_OPTIONS = new Set(["inventory", "ability"]);
const ITEM_LOADOUT_SUBTYPE_OPTIONS = new Set(["attack"]);
const SITE_OVERRIDE_STATE_FLAG = "siteOverrideState";

function cleanFoundryDescription(value, maxLength = CHARACTER_SYNC_DESCRIPTION_LIMIT) {
    if (!value) return "";
    const cleaned = String(value)
        .replace(/\s(?:class|style|data-[\w-]+)="[^"]*"/gi, "")
        .replace(/\s(?:class|style|data-[\w-]+)='[^']*'/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, maxLength).trim()}...`;
}

function isUsefulSpell(item) {
    const system = item?.system ?? {};
    const level = toNumberOrNull(system.level);
    const { method, prepared } = readSpellPreparation(system);
    if (prepared > 0) return true;
    if (level === 0) return true;
    return CHARACTER_SYNC_SPELL_METHODS.has(String(method || "").toLowerCase());
}

function isUsefulCharacterItem(item) {
    if (!item) return false;
    if (item.type === "spell") return isUsefulSpell(item);
    return CHARACTER_SYNC_ITEM_TYPES.has(item.type);
}

function isUsefulCompanionItem(item) {
    if (!item) return false;
    if (item.type === "spell") return isUsefulSpell(item);
    return COMPANION_SYNC_ITEM_TYPES.has(item.type);
}

function getItemQuantity(item) {
    return item?.system?.quantity ?? item?.system?.qty ?? item?.system?.amount ?? 1;
}

function getItemDocumentId(item) {
    return item?.id || item?._id || item?.document?._id || "";
}

function getItemContainer(item) {
    const raw = item?.system?.container;
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "string") {
        const containerItem = item?.actor?.items?.get?.(raw);
        return compactObject({ id: raw, name: containerItem?.name }, { keepNullKeys: ["id"] });
    }
    if (typeof raw === "object") {
        return compactObject({ id: raw.id ?? raw.value ?? raw.uuid ?? null, name: raw.name }, { keepNullKeys: ["id"] });
    }
    return null;
}

function isItemAttuned(item) {
    return item?.system?.attuned === true;
}

function mapStatusItem(item) {
    return compactObject({
        id: item.id,
        name: item.name,
        type: item.type,
        quantity: getItemQuantity(item),
        container: getItemContainer(item),
        equipped: item?.system?.equipped,
        attuned: item?.system?.attuned,
        attunement: item?.system?.attunement
    }, { keepNullKeys: ["container"] });
}

function mapItemForCharacterSync(item, allItems = []) {
    const system = getPlainItemSystem(item);
    const loadoutRole = getItemLoadoutRole(item);
    const loadoutSubtype = getItemLoadoutSubtype(item);
    const itemId = getItemDocumentId(item);
    const transferId = getItemTransferId(item);
    const sourceId = getItemStableSourceId(item);
    const transferKey = getTransferableItemKey({ itemId, itemName: item.name, itemType: item.type, sourceId, transferId });
    const summary = compactObject({
        id: itemId,
        uuid: item.uuid || "",
        transferId,
        sourceId,
        transferKey,
        name: item.name,
        type: item.type,
        loadoutRole,
        loadoutSubtype,
        img: item.img,
        quantity: getItemQuantity(item),
        container: getItemContainer(item),
        currency: getItemCurrency(item),
        capacity: getItemCapacity(item, allItems),
        description: cleanFoundryDescription(system?.description?.value)
    }, { keepNullKeys: ["container"] });

    if (item.type === "spell") {
        return compactObject({
            ...summary,
            level: system.level,
            school: system.school,
            activation: getActivityActivationData(system),
            range: getActivityRangeData(system),
            duration: getActivityDurationData(system),
            prepared: spellPreparationForWiki(system).prepared,
            concentration: Array.isArray(system?.properties) ? system.properties.includes("concentration") : false
        });
    }

    if (["equipment", "weapon", "armor", "consumable", "tool", "loot", "backpack"].includes(item.type)) {
        return compactObject({
            ...summary,
            rarity: system.rarity,
            identified: system.identified,
            equipped: system.equipped,
            attuned: system.attuned,
            attunement: system.attunement,
            activation: getActivityActivationData(system),
            range: getActivityRangeData(system),
            duration: getActivityDurationData(system),
            uses: compactObject({ max: system?.uses?.max, spent: system?.uses?.spent, value: system?.uses?.value })
        });
    }

    if (item.type === "feat") {
        return compactObject({
            ...summary,
            activation: getActivityActivationData(system),
            range: getActivityRangeData(system),
            duration: getActivityDurationData(system),
            uses: compactObject({ max: system?.uses?.max, spent: system?.uses?.spent, value: system?.uses?.value })
        });
    }

    return summary;
}

function getActorXp(actor) {
    const xp = actor?.system?.details?.xp ?? {};
    const current = toNumberOrNull(xp.value ?? xp.current);
    const nextLevel = toNumberOrNull(xp.max ?? xp.next);
    return compactObject({
        current,
        nextLevel,
        missingToLevel: current !== null && nextLevel !== null ? Math.max(nextLevel - current, 0) : null
    }, { keepNullKeys: ["current", "nextLevel", "missingToLevel"] });
}

function getActorSpellSlots(actor) {
    const spells = actor?.system?.spells ?? {};
    const perLevel = Object.entries(spells)
        .filter(([key]) => key === "pact" || /^spell\d+$/.test(key))
        .map(([key, slotData]) => {
            const total = toNumberOrNull(slotData?.max);
            const available = toNumberOrNull(slotData?.value);
            const explicitUsed = toNumberOrNull(slotData?.spent);
            const used = explicitUsed !== null ? explicitUsed : total !== null && available !== null ? Math.max(total - available, 0) : null;
            return compactObject({
                slot: key,
                level: key === "pact" ? "pact" : Number(key.replace("spell", "")),
                total,
                used,
                available
            });
        })
        .filter((slot) => (slot.total ?? 0) > 0 || (slot.used ?? 0) > 0 || (slot.available ?? 0) > 0);

    const totals = perLevel.reduce((acc, slot) => ({
        total: acc.total + (slot.total ?? 0),
        used: acc.used + (slot.used ?? 0),
        available: acc.available + (slot.available ?? 0)
    }), { total: 0, used: 0, available: 0 });

    return { perLevel, totals };
}

function getActorWeight(actor) {
    const encumbrance = actor?.system?.attributes?.encumbrance ?? {};
    const carried = toNumberOrNull(encumbrance.value ?? encumbrance.carried ?? encumbrance.total);
    const capacity = toNumberOrNull(encumbrance.max ?? encumbrance.capacity);
    const percent = toNumberOrNull(encumbrance.pct) ?? (carried !== null && capacity !== null && capacity > 0 ? (carried / capacity) * 100 : null);
    return compactObject({
        carried,
        capacity,
        percent,
        encumbered: typeof encumbrance.encumbered === "boolean" ? encumbrance.encumbered : undefined
    }, { keepNullKeys: ["carried", "capacity", "percent"] });
}

function getActorVitals(actor) {
    const attributes = actor?.system?.attributes ?? {};
    const hp = attributes.hp ?? {};
    return compactObject({
        hp: compactObject({
            value: toNumberOrNull(hp.value),
            max: toNumberOrNull(hp.max),
            temp: toNumberOrNull(hp.temp),
            tempmax: toNumberOrNull(hp.tempmax)
        }, { keepNullKeys: ["value", "max", "temp"] }),
        ac: toNumberOrNull(attributes.ac?.value ?? attributes.ac?.flat),
        initiative: toNumberOrNull(attributes.init?.total ?? attributes.init?.value),
        speed: attributes.movement || attributes.speed || null,
        prof: toNumberOrNull(attributes.prof)
    });
}

function getActorAbilities(actor) {
    const abilities = actor?.system?.abilities ?? {};
    return Object.fromEntries(Object.entries(abilities).map(([key, value]) => [key, compactObject({
        value: toNumberOrNull(value?.value),
        mod: toNumberOrNull(value?.mod),
        save: toNumberFromValueOrObject(value?.save)
    }, { keepNullKeys: ["value", "mod", "save"] })]));
}

function getActorResources(actor) {
    const resources = actor?.system?.resources ?? {};
    return Object.fromEntries(Object.entries(resources).map(([key, value]) => {
        const current = toNumberOrNull(value?.value);
        const max = toNumberOrNull(value?.max);
        return [key, compactObject({
            label: value?.label,
            value: current,
            max,
            sr: value?.sr,
            lr: value?.lr
        })];
    }).filter(([, value]) => {
        if (!Object.keys(value).length) return false;
        return Boolean(value.label) || (value.value ?? 0) > 0 || (value.max ?? 0) > 0;
    }));
}

function getActorCurrency(actor) {
    const currency = actor?.system?.currency ?? {};
    return Object.fromEntries(Object.entries(currency)
        .map(([key, value]) => [key, toNumberOrNull(value)])
        .filter(([, value]) => value !== null && value > 0));
}

function getItemCurrency(item) {
    const currency = item?.system?.currency
        ?? item?.system?.container?.currency
        ?? item?.system?.contents?.currency
        ?? {};
    return Object.fromEntries(Object.entries(currency)
        .map(([key, value]) => [key, toNumberFromValueOrObject(value)])
        .filter(([, value]) => value !== null && value > 0));
}

function getCurrencyWeight(currency) {
    if (!currency || typeof currency !== "object") return 0;
    const coinCount = Object.values(currency)
        .map(toNumberFromValueOrObject)
        .filter((value) => value !== null && value > 0)
        .reduce((sum, value) => sum + value, 0);
    return coinCount > 0 ? coinCount / 50 : 0;
}

function getItemWeight(item) {
    const system = item?.system ?? {};
    const quantity = Math.max(1, toNumberOrNull(system.quantity ?? system.qty ?? system.amount) ?? 1);
    const weight = system.weight;
    if (typeof weight === "object" && weight !== null) {
        const value = toNumberOrNull(weight.value ?? weight.total ?? weight.base);
        return value === null ? null : value * quantity;
    }
    const value = toNumberOrNull(weight);
    return value === null ? null : value * quantity;
}

function getContainedWeight(items, containerId) {
    const id = String(containerId || "").trim();
    if (!id) return null;
    const weights = (Array.isArray(items) ? items : [])
        .filter((item) => String(getItemContainer(item)?.id || "").trim() === id)
        .map(getItemWeight)
        .filter((value) => value !== null);
    return weights.length ? weights.reduce((sum, value) => sum + value, 0) : null;
}

function getItemCapacity(item, allItems = []) {
    const capacity = item?.system?.capacity ?? item?.system?.container?.capacity ?? {};
    if (!capacity || typeof capacity !== "object") return null;
    const weightCapacity = capacity.weight && typeof capacity.weight === "object" ? capacity.weight : null;
    const max = toNumberOrNull(weightCapacity?.value ?? weightCapacity?.max ?? capacity.max ?? capacity.value ?? capacity.capacity ?? capacity.total);
    const explicitUsed = toNumberOrNull(capacity.used ?? capacity.current ?? capacity.occupied ?? capacity.carried);
    const containedWeight = getContainedWeight(allItems, getItemDocumentId(item));
    const currencyWeight = getCurrencyWeight(getItemCurrency(item));
    const calculatedUsed = containedWeight !== null || currencyWeight > 0
        ? (containedWeight ?? 0) + currencyWeight
        : null;
    const used = explicitUsed ?? calculatedUsed;
    const unit = String(weightCapacity?.units || weightCapacity?.unit || capacity.units || capacity.unit || capacity.type || "lb").trim();
    if (max === null && used === null) return null;
    return compactObject({
        used,
        max,
        unit,
        type: capacity.type
    }, { keepNullKeys: ["used", "max"] });
}

function getActorDetails(actor) {
    const details = actor?.system?.details ?? {};
    return compactObject({
        level: toNumberOrNull(details.level),
        cr: toNumberOrNull(details.cr),
        type: typeof details.type === "string" ? details.type : details.type?.value,
        alignment: details.alignment,
        race: typeof details.race === "string" ? details.race : details.race?.name,
        class: typeof details.class === "string" ? details.class : details.class?.name
    });
}

function getActorTokenInfo(actor) {
    const token = actor?.prototypeToken ?? {};
    const texture = token.texture ?? {};
    return compactObject({
        img: texture.src || token.img,
        width: toNumberOrNull(token.width),
        height: toNumberOrNull(token.height),
        scale: toNumberOrNull(texture.scaleX)
    });
}

function mapActorForSync(actor, options = {}) {
    const usefulItemPredicate = options.usefulItemPredicate || isUsefulCharacterItem;
    const items = (actor.items?.contents ?? []).filter(usefulItemPredicate);
    return compactObject({
        id: actor.id,
        actorId: actor.id,
        characterId: options.ownerCharacterId,
        name: actor.name,
        displayName: options.displayName,
        type: actor.type,
        img: actor.img,
        token: getActorTokenInfo(actor),
        ownerCharacterId: options.ownerCharacterId,
        ownerAccountId: options.ownerAccountId,
        ownerDiscordId: options.ownerDiscordId,
        foundryName: actor.name,
        owners: game.users
            .filter((user) => !user.isGM && actor.testUserPermission(user, "OWNER"))
            .map((user) => ({ id: user.id, name: user.name })),
        details: getActorDetails(actor),
        vitals: getActorVitals(actor),
        xp: getActorXp(actor),
        abilities: getActorAbilities(actor),
        resources: getActorResources(actor),
        currency: getActorCurrency(actor),
        spellSlots: getActorSpellSlots(actor),
        equippedItems: items.filter((item) => item?.system?.equipped === true).map(mapStatusItem),
        attunementItems: items.filter(isItemAttuned).map(mapStatusItem),
        weight: getActorWeight(actor),
        inventory: items.map((item) => mapItemForCharacterSync(item, items))
    });
}

function parseCompanionMappings() {
    const raw = String(game.settings.get(MODULE_ID, SETTINGS.COMPANION_MAPPINGS) || "");
    const rows = parseStructuredActorMappingRows(raw);
    if (rows) {
        return rows
            .flatMap((row) => {
                const companionActorIds = normalizeActorIdList(row.companionActorIds || row.companions || row.actorIds || row.actorId);
                return companionActorIds.map((actorId) => compactObject({
                    actorId,
                    actorName: actorId,
                    ownerUserKey: row.userId || row.ownerUserKey,
                    ownerCharacterId: slugify(row.characterId || row.ownerCharacterId || ""),
                    ownerAccountId: row.accountId || row.ownerAccountId,
                    displayName: row.displayName
                }));
            })
            .filter((row) => row.actorId && row.ownerCharacterId);
    }
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .flatMap(parseCompanionMappingLine)
        .filter((row) => row.actorName && (row.ownerCharacterId || row.ownerUserKey));
}

function parsePlayerActorMappings() {
    const raw = String(game.settings.get(MODULE_ID, SETTINGS.PLAYER_ACTOR_MAPPINGS) || "");
    const rows = parseStructuredActorMappingRows(raw);
    if (rows) {
        return rows
            .map((row) => compactObject({
                ownerUserKey: row.userId || row.ownerUserKey,
                actorRef: normalizeActorRef(row.actorId || row.actorRef),
                ownerCharacterId: slugify(row.characterId || row.ownerCharacterId || ""),
                ownerAccountId: row.accountId || row.ownerAccountId
            }))
            .filter((row) => row.ownerUserKey && row.actorRef && row.ownerCharacterId);
    }
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const parts = line.split("|").map((part) => String(part || "").trim());
            if (parts.length < 2 || !parts[0] || !parts[1]) return null;
            return compactObject({
                ownerUserKey: parts[0],
                actorRef: normalizeActorRef(parts[1]),
                ownerCharacterId: parts[2],
                ownerAccountId: parts[3]
            });
        })
        .filter(Boolean);
}

function parseStructuredActorMappingRows(raw) {
    const text = String(raw || "").trim();
    if (!text || !/^[\[{]/.test(text)) return null;
    try {
        const payload = JSON.parse(text);
        const rows = Array.isArray(payload) ? payload : payload?.rows;
        return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
    } catch (error) {
        console.warn(`${MODULE_ID} | Mappatura actor JSON non valida.`, error);
        return [];
    }
}

function normalizeActorIdList(value) {
    if (Array.isArray(value)) return value.map(normalizeActorRef).filter(Boolean);
    return String(value || "")
        .split(/[,;]/)
        .map(normalizeActorRef)
        .filter(Boolean);
}

function normalizeActorRef(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const actorMatch = raw.match(/(?:^|\.)(Actor)\.([A-Za-z0-9]{8,})$/i);
    if (actorMatch?.[2]) return actorMatch[2];
    const uuidMatch = raw.match(/^Actor\.([A-Za-z0-9]{8,})(?:\.|$)/i);
    if (uuidMatch?.[1]) return uuidMatch[1];
    return raw;
}

function getConfiguredActor(value) {
    const actorId = normalizeActorRef(value);
    return actorId ? game.actors.get(actorId) : null;
}

async function loadCampaignPlayersForMappingConfig() {
    try {
        const response = await policyFetch(`${wikiDataService.getDataUrl("players.json")}?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const players = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
        return players
            .map((player) => compactObject({
                id: slugify(player?.id || ""),
                name: player?.name || player?.id || "",
                accountId: compactAutoLoginKey(player?.accountId || "")
            }))
            .filter((player) => player.id);
    } catch (error) {
        console.warn(`${MODULE_ID} | Impossibile caricare players.json per configurazione actor.`, error);
        return [];
    }
}

function findCampaignPlayerForAccount(players, characterId, accountId) {
    const wantedCharacterId = slugify(characterId || "");
    const wantedAccountId = compactAutoLoginKey(accountId || "");
    return (Array.isArray(players) ? players : []).find((player) => wantedCharacterId && player.id === wantedCharacterId)
        || (Array.isArray(players) ? players : []).find((player) => wantedAccountId && compactAutoLoginKey(player.accountId) === wantedAccountId)
        || null;
}

function getConfiguredPlayerMappingForUser(user, mappings = parsePlayerActorMappings()) {
    const userKeys = getFoundryUserCompanionKeys(user);
    return mappings.find((entry) => {
        const ownerUserKey = compactAutoLoginKey(entry.ownerUserKey);
        const ownerAccountId = compactAutoLoginKey(entry.ownerAccountId);
        return (ownerUserKey && userKeys.has(ownerUserKey))
            || (ownerAccountId && userKeys.has(ownerAccountId));
    }) || null;
}

function getConfiguredAccountIdForUser(user, mappings = parsePlayerActorMappings()) {
    const mapping = getConfiguredPlayerMappingForUser(user, mappings);
    return compactAutoLoginKey(mapping?.ownerAccountId || getPreferredAccountIdForFoundryUser(user));
}

function getConfiguredPlayerActorRefForUser(user, mappings = parsePlayerActorMappings()) {
    const mapping = getConfiguredPlayerMappingForUser(user, mappings);
    return mapping?.actorRef || "";
}

function getConfiguredCompanionActorRefsForUser(user, mappings = parseCompanionMappings()) {
    const userKeys = getFoundryUserCompanionKeys(user);
    return mappings
        .filter((entry) => {
            const ownerUserKey = compactAutoLoginKey(entry.ownerUserKey);
            const ownerAccountId = compactAutoLoginKey(entry.ownerAccountId);
            return (ownerUserKey && userKeys.has(ownerUserKey))
                || (ownerAccountId && userKeys.has(ownerAccountId));
        })
        .map((entry) => entry.actorId || entry.actorName)
        .filter(Boolean);
}


function resolveConfiguredPlayerActors(mappings = parsePlayerActorMappings()) {
    const seen = new Set();
    return mappings
        .map((mapping) => {
            const actor = getConfiguredActor(mapping.actorRef);
            if (!actor || actor.type !== "character") {
                console.warn(`${MODULE_ID} | Actor personaggio configurato non trovato.`, { mapping });
                return null;
            }
            if (seen.has(actor.id)) return null;
            seen.add(actor.id);
            return { actor, mapping };
        })
        .filter(Boolean);
}

function getConfiguredCompanionNamesForUser(user, mappings = parseCompanionMappings()) {
    const userKeys = getFoundryUserCompanionKeys(user);
    const playerActorKeys = new Set(game.actors
        .filter((actor) => actor.type === "character" && actor.testUserPermission(user, "OWNER"))
        .flatMap((actor) => {
            const actorName = normalizeWikiItemKey(actor.name);
            const keys = [actor.id, actor.name, slugify(actor.name), actorName];
            Object.entries(WIKI_PLAYER_ID_ALIASES).forEach(([wikiId, aliases]) => {
                const aliasMatch = aliases.map(normalizeWikiItemKey).some((alias) => alias && actorName && (alias === actorName || actorName.includes(alias) || alias.includes(actorName)));
                if (aliasMatch) keys.push(wikiId);
            });
            return keys.map(compactAutoLoginKey).filter(Boolean);
        }));

    const names = [];
    mappings.forEach((mapping) => {
        const ownerUserKey = compactAutoLoginKey(mapping.ownerUserKey);
        const ownerAccountId = compactAutoLoginKey(mapping.ownerAccountId);
        const ownerCharacterId = compactAutoLoginKey(mapping.ownerCharacterId);
        const belongsToUser = (ownerUserKey && userKeys.has(ownerUserKey))
            || (ownerAccountId && userKeys.has(ownerAccountId))
            || (ownerCharacterId && playerActorKeys.has(ownerCharacterId));
        if (!belongsToUser) return;
        const actorRef = mapping.actorId || mapping.actorName;
        const label = mapping.displayName && mapping.displayName !== actorRef
            ? `${actorRef} => ${mapping.displayName}`
            : actorRef;
        if (label && !names.includes(label)) names.push(label);
    });

    return names;
}

function parseCompanionMappingLine(line) {
    const parts = line.split("|").map((part) => String(part || "").trim());
    if (parts.length >= 3) {
        const [actorName, ownerCharacterId, ownerAccountId, displayName] = parts;
        return [compactObject({ actorName, ownerCharacterId, ownerAccountId, displayName, format: "character" })];
    }

    if (parts.length !== 2) return [];

    const [first, second] = parts;
    if (!first || !second) return [];

    // Backward compatibility for the old short form: companion actor | owner characterId.
    if (findActorByMappingName(first) && !findActorByMappingName(second)) {
        return [compactObject({ actorName: first, ownerCharacterId: second, format: "character" })];
    }

    return splitCompanionNames(second).map((entry) => compactObject({
        actorName: entry.actorName,
        displayName: entry.displayName,
        ownerUserKey: first,
        format: "user"
    }));
}

function splitCompanionNames(value) {
    return String(value || "")
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const match = entry.match(/^(.*?)\s*(?:=>|->|\bas\b|\bcome\b)\s*(.*?)$/i);
            if (!match) return { actorName: entry };
            return {
                actorName: String(match[1] || "").trim(),
                displayName: String(match[2] || "").trim()
            };
        })
        .filter((entry) => entry.actorName);
}

function findActorByMappingName(name) {
    const normalized = normalizeWikiItemKey(name);
    return game.actors.find((actor) => actor.id === name)
        || game.actors.find((actor) => normalizeWikiItemKey(actor.name) === normalized)
        || game.actors.find((actor) => {
            const actorName = normalizeWikiItemKey(actor.name);
            return actorName && normalized && (actorName.includes(normalized) || normalized.includes(actorName));
        })
        || null;
}

function getDeviceCodeAccountId(code) {
    const normalized = String(code || "").trim();
    const match = normalized.match(/^([A-Za-z0-9]+)/);
    return match ? compactAutoLoginKey(match[1]) : "";
}

function getFoundryUserCompanionKeys(user) {
    const keys = new Set([
        user?.id,
        user?.name
    ].map(compactAutoLoginKey).filter(Boolean));

    const configured = parseAutoDeviceLoginConfig();
    const userKeys = [user?.id, user?.name].map((key) => String(key || "").trim()).filter(Boolean);
    for (const [configKey, code] of configured.entries()) {
        const matchesUser = userKeys.some((candidate) => autoLoginKeyMatches(configKey, candidate));
        if (!matchesUser) continue;
        const normalizedConfigKey = compactAutoLoginKey(configKey);
        const accountId = getDeviceCodeAccountId(code);
        if (normalizedConfigKey) keys.add(normalizedConfigKey);
        if (accountId) keys.add(accountId);
    }

    return keys;
}

function findFoundryUserByCompanionKey(value) {
    const target = compactAutoLoginKey(value);
    if (!target) return null;
    return game.users.find((user) => getFoundryUserCompanionKeys(user).has(target)) || null;
}

function getPreferredAccountIdForFoundryUser(user) {
    const configured = parseAutoDeviceLoginConfig();
    const userKeys = [user?.id, user?.name].map((key) => String(key || "").trim()).filter(Boolean);
    for (const [configKey, code] of configured.entries()) {
        if (!userKeys.some((candidate) => autoLoginKeyMatches(configKey, candidate))) continue;
        const accountId = getDeviceCodeAccountId(code);
        if (accountId) return accountId;
    }
    return compactAutoLoginKey(user?.name || user?.id);
}

async function resolveOwnerCharacterIdForCompanionMapping(mapping, companionActor, playerActors) {
    if (mapping.ownerCharacterId) return mapping.ownerCharacterId;

    console.warn(`${MODULE_ID} | Companion senza characterId configurato, non esportato.`, { companion: companionActor?.name, mapping });
    return "";
}

function isConfiguredCompanionActor(actor) {
    if (!actor) return false;
    return parseCompanionMappings().some((mapping) => {
        const mappedActor = getConfiguredActor(mapping.actorId || mapping.actorName);
        return mappedActor?.id === actor.id;
    });
}

function isConfiguredPlayerActor(actor) {
    if (!actor) return false;
    const configured = resolveConfiguredPlayerActors();
    return configured.some((entry) => entry.actor?.id === actor.id);
}

function getPlayerActorsForWikiSync() {
    const configured = resolveConfiguredPlayerActors()
        .map((entry) => entry.actor)
        .filter(Boolean);
    return configured;
}

function getConfiguredCharacterIdForActor(actor) {
    const actorId = String(actor?.id || "").trim();
    if (!actorId) return "";
    const mapping = parsePlayerActorMappings().find((entry) => normalizeActorRef(entry.actorRef) === actorId);
    return mapping?.ownerCharacterId || "";
}

function getConfiguredCompanionOwnerCharacterIdForActor(actor) {
    const actorId = String(actor?.id || "").trim();
    if (!actorId) return "";
    const mapping = parseCompanionMappings().find((entry) => {
        const mappedActor = getConfiguredActor(entry.actorId || entry.actorName);
        return mappedActor?.id === actorId;
    });
    return slugify(mapping?.ownerCharacterId || "");
}

function getManagedActorLink(actor) {
    const actorId = String(actor?.id || "").trim();
    if (!actorId) return {};
    const playerMapping = parsePlayerActorMappings().find((entry) => normalizeActorRef(entry.actorRef) === actorId);
    if (playerMapping) {
        return compactObject({
            relationshipType: "player",
            ownerCharacterId: playerMapping.ownerCharacterId,
            ownerAccountId: playerMapping.ownerAccountId
        });
    }
    const companionMapping = parseCompanionMappings().find((entry) => {
        const mappedActor = getConfiguredActor(entry.actorId || entry.actorName);
        return mappedActor?.id === actorId;
    });
    if (companionMapping) {
        return compactObject({
            relationshipType: "companion",
            ownerCharacterId: companionMapping.ownerCharacterId,
            ownerAccountId: companionMapping.ownerAccountId
        });
    }
    return {};
}
async function setCompanionRelationshipMapping(actor, relationship = {}) {
    const actorId = String(actor?.id || "").trim();
    if (!actorId) throw new Error("Actor companion non disponibile.");
    const ownerCharacterId = slugify(relationship.ownerCharacterId || "");
    const existing = parseCompanionMappings()
        .map((mapping) => ({
            actorId: normalizeActorRef(mapping.actorId || mapping.actorName),
            ownerUserKey: String(mapping.ownerUserKey || "").trim(),
            ownerCharacterId: slugify(mapping.ownerCharacterId || ""),
            ownerAccountId: String(mapping.ownerAccountId || "").trim(),
            displayName: String(mapping.displayName || "").trim()
        }))
        .filter((mapping) => {
            const mappedActor = getConfiguredActor(mapping.actorId);
            return mappedActor?.id !== actorId && mapping.actorId !== actorId;
        });

    if (ownerCharacterId) {
        const playerMapping = parsePlayerActorMappings().find((entry) => slugify(entry.ownerCharacterId || "") === ownerCharacterId);
        existing.push({
            actorId,
            ownerUserKey: String(playerMapping?.ownerUserKey || "").trim(),
            ownerCharacterId,
            ownerAccountId: String(playerMapping?.ownerAccountId || relationship.ownerAccountIds?.[0] || "").trim(),
            displayName: actor.name || ""
        });
    }

    const groups = new Map();
    for (const mapping of existing) {
        if (!mapping.actorId || !mapping.ownerCharacterId) continue;
        const key = [mapping.ownerUserKey, mapping.ownerCharacterId, mapping.ownerAccountId].join("|");
        const group = groups.get(key) || {
            userId: mapping.ownerUserKey,
            userName: game.users.get(mapping.ownerUserKey)?.name || "",
            accountId: mapping.ownerAccountId,
            characterId: mapping.ownerCharacterId,
            companionActorIds: []
        };
        if (!group.companionActorIds.includes(mapping.actorId)) group.companionActorIds.push(mapping.actorId);
        groups.set(key, group);
    }
    const rows = Array.from(groups.values())
        .map((row) => ({ ...row, companionActorIds: row.companionActorIds.sort() }))
        .sort((left, right) => String(left.characterId || "").localeCompare(String(right.characterId || ""), "it"));
    await game.settings.set(MODULE_ID, SETTINGS.COMPANION_MAPPINGS, JSON.stringify({
        version: 3,
        campaignId: getCampaignId(),
        rows
    }));
    return { actorId, ownerCharacterId, rows };
}
function managedActorSummaryFoundryActor(summary) {
    return game.actors.get(String(summary?.foundryActorId || ""))
        || Array.from(game.actors || []).find((actor) => slugify(actor.id) === slugify(summary?.actorId || ""));
}

function managedActorSummaryImage(summary) {
    const path = String(summary?.media?.idle?.path || summary?.media?.avatar?.path || summary?.media?.token?.path || "").trim();
    if (!path) return "";
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    return `${DISCORD_WORKER_URL}/${path.replace(/^\/+/, "")}`;
}

function getManagedActorSheetRoot(sheet, html = null) {
    for (const candidate of [sheet?.element, html]) {
        const element = candidate instanceof HTMLElement ? candidate : candidate?.[0];
        if (!element) continue;
        return element.matches?.(".window-app, .application")
            ? element
            : (element.closest?.(".window-app, .application") || element);
    }
    return null;
}

function getManagedActorShareButton(sheet, html = null) {
    return getManagedActorSheetRoot(sheet, html)?.querySelector?.(
        '[data-action="cripta-managed-share-alert"], .cripta-managed-share-alert'
    ) || null;
}

function setManagedActorShareIndicator(sheet, state, html = null) {
    const button = getManagedActorShareButton(sheet, html);
    if (!button) return;
    const visible = state === "missing" || state === "loading";
    const loading = state === "loading";
    button.hidden = !visible;
    button.classList.toggle("is-missing", visible);
    button.classList.toggle("is-loading", loading);
    button.setAttribute("aria-busy", loading ? "true" : "false");
    if (loading) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    button.title = loading
        ? "Condivisione in corso..."
        : "Questo NPC non e ancora nel nuovo flusso. Clicca per condividerlo.";
    const icon = button.querySelector("i");
    if (icon) icon.className = loading ? "fas fa-spinner fa-spin" : "fas fa-cloud-arrow-up";
}

async function refreshManagedActorShareIndicator(sheet, html = null, { force = false } = {}) {
    const actor = sheet?.actor || sheet?.document || sheet?.object;
    if (isTemporaryWikiActor(actor)) return;
    if (!game.user?.isGM || actor?.type !== "npc") return;
    setManagedActorShareIndicator(sheet, "checking", html);
    try {
        const shared = await isManagedActorShared(actor, { force });
        setManagedActorShareIndicator(sheet, managedActorShareSyncs.has(actor.id) ? "loading" : (shared ? "shared" : "missing"), html);
    } catch (error) {
        setManagedActorShareIndicator(sheet, "unavailable", html);
        console.warn(`${MODULE_ID} | Stato condivisione Managed Actor non verificabile.`, { actor: actor.name, error });
    }
}

async function confirmManagedActorFirstShare(actor, sheet) {
    if (isTemporaryWikiActor(actor)) return;
    if (!game.user?.isGM || actor?.type !== "npc" || managedActorShareSyncs.has(actor.id)) return;
    const activeGm = game.users?.activeGM;
    if (activeGm?.id && activeGm.id !== game.user.id) {
        ui.notifications.warn(`La sincronizzazione e gestita dal GM attivo ${activeGm.name || ""}.`);
        return;
    }
    const confirmed = await confirmDialog({
        title: "Condividere questo NPC?",
        content: `
            <div class="cripta-managed-share-confirm">
                <p>Vuoi inserire <strong>${escapeHtml(actor.name || "questo NPC")}</strong> nel nuovo flusso condiviso?</p>
                <p>Verranno inviati statistiche, inventario, capacita, incantesimi, immagini e varianti token disponibili. Nessun Actor o dato esistente verra cancellato.</p>
            </div>
        `,
        yes: () => true,
        no: () => false,
        defaultYes: false
    });
    if (!confirmed || managedActorShareSyncs.has(actor.id)) return;

    managedActorShareSyncs.add(actor.id);
    setManagedActorShareIndicator(sheet, "loading");
    try {
        const alreadyShared = await isManagedActorShared(actor, { force: true });
        if (alreadyShared) {
            setManagedActorShareIndicator(sheet, "shared");
            ui.notifications.info(`${actor.name} era gia presente nel nuovo flusso.`);
            return;
        }
        const synced = await syncManagedActorNow(actor, { reason: "manual-first-share", forceCreate: true });
        if (!synced) throw new Error("La sincronizzazione non puo essere eseguita da questo client.");
        setManagedActorShareIndicator(sheet, "shared");
        ui.notifications.info(`${actor.name} ora usa il nuovo flusso condiviso.`);
    } catch (error) {
        let remotelyShared = false;
        try {
            remotelyShared = await isManagedActorShared(actor, { force: true });
        } catch (_) {
            remotelyShared = false;
        }
        if (remotelyShared) {
            setManagedActorShareIndicator(sheet, "shared");
            ui.notifications.warn(`${actor.name} e stato ricevuto dal Worker, ma Foundry non ha salvato tutto lo stato locale. Riapri la scheda per verificare.`);
        } else {
            setManagedActorShareIndicator(sheet, "missing");
            ui.notifications.error(`Condivisione di ${actor.name} fallita: ${error?.message || error}`);
        }
        console.warn(`${MODULE_ID} | Condivisione manuale Managed Actor fallita.`, { actor: actor.name, error });
    } finally {
        managedActorShareSyncs.delete(actor.id);
    }
}

async function openManagedNpcCategoryPicker(actor) {
    if (isTemporaryWikiActor(actor)) return;
    if (!game.user?.isGM || actor?.type !== "npc") return;
    let shared = false;
    try {
        shared = await isManagedActorShared(actor, { force: true });
    } catch (_) {
        shared = false;
    }
    if (!shared) {
        ui.notifications.warn("Condividi prima questo NPC nel nuovo flusso.");
        return;
    }

    let registry;
    let indexPayload;
    try {
        [registry, indexPayload] = await Promise.all([
            loadNpcCategoryRegistry({ force: true }),
            loadManagedActorRelationshipIndex({ force: true })
        ]);
    } catch (error) {
        ui.notifications.error(`Categorie NPC non disponibili: ${error.message}`);
        return;
    }

    const summary = (Array.isArray(indexPayload?.data) ? indexPayload.data : []).find((entry) => {
        if (slugify(entry.worldId || "") !== slugify(game.world?.id || "")) return false;
        return [entry.actorId, entry.foundryActorId].some((id) => slugify(id || "") === slugify(actor.id || ""));
    });
    const flag = actor.getFlag?.(MODULE_ID, "npcCategory") || {};
    const selectedId = slugify(summary?.profile?.categoryId || flag.id || "");
    const categories = (registry.categories || [])
        .filter((category) => (!category.archived && !category.mergedInto) || category.id === selectedId)
        .sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || String(left.name || "").localeCompare(String(right.name || ""), "it"));
    const options = [
        '<option value="">Senza categoria</option>',
        ...categories.map((category) => `<option value="${escapeHtml(category.id)}" ${slugify(category.id) === selectedId ? "selected" : ""}>${escapeHtml(category.name)}${category.archived ? " (archiviata)" : ""}</option>`)
    ].join("");

    renderDialog({
        title: `Categoria NPC - ${actor.name}`,
        content: `
            <form class="cripta-npc-category-picker">
                <label>
                    <span>Categoria</span>
                    <select name="categoryId">${options}</select>
                </label>
                <div class="cripta-npc-category-picker__divider"><span>oppure</span></div>
                <label>
                    <span>Nuova categoria</span>
                    <input type="text" name="newCategory" maxlength="120" placeholder="Nome categoria">
                </label>
            </form>
        `,
        buttons: {
            cancel: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Annulla"
            },
            save: {
                icon: '<i class="fas fa-folder-tree"></i>',
                label: "Salva",
                callback: async (html) => {
                    let categoryId = String(html.find('[name="categoryId"]').val() || "");
                    const newName = String(html.find('[name="newCategory"]').val() || "").trim();
                    try {
                        if (newName) {
                            categoryId = slugify(newName);
                            let category = registry.categories.find((entry) => slugify(entry.id) === categoryId);
                            if (category?.archived) throw new Error("La categoria esiste ma e archiviata.");
                            if (!category) {
                                const maxOrder = Math.max(0, ...registry.categories.map((entry) => Number(entry.order) || 0));
                                registry = await saveNpcCategoryRegistry([
                                    ...registry.categories,
                                    { id: categoryId, name: newName, order: maxOrder + 10, color: "#b99a45", icon: "fa-folder-open", archived: false, mergedInto: "" }
                                ], registry.revision);
                            }
                        }
                        await saveManagedActorNpcCategory(actor, categoryId);
                        ui.notifications.info(`Categoria di ${actor.name} aggiornata.`);
                        actor.sheet?.render?.(false);
                    } catch (error) {
                        ui.notifications.error(`Categoria non aggiornata: ${error.message}`);
                        return false;
                    }
                }
            }
        },
        default: "save"
    }, {
        width: 460,
        height: "auto",
        classes: ["cripta-npc-category-picker-dialog"]
    });
}

async function openManagedCompanionPicker(playerActor) {
    const playerLink = getManagedActorLink(playerActor);
    const ownerCharacterId = slugify(playerLink.ownerCharacterId || "");
    if (!ownerCharacterId) {
        ui.notifications.warn("Questo Actor non e ancora collegato a un personaggio wiki.");
        return;
    }
    let payload;
    try {
        payload = await loadManagedActorRelationshipIndex();
    } catch (error) {
        ui.notifications.error(`Lista NPC non disponibile: ${error.message}`);
        return;
    }
    const worldId = slugify(game.world?.id || "");
    const candidates = (Array.isArray(payload?.data) ? payload.data : [])
        .filter((entry) => slugify(entry.worldId || "") === worldId)
        .filter((entry) => String(entry.actorType || "").trim().toLowerCase() === "npc")
        .filter((entry) => Boolean(managedActorSummaryFoundryActor(entry)))
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "it"));
    if (!candidates.length) {
        ui.notifications.warn("Nessun NPC gestito disponibile. Apri prima l'NPC nel Tokenizer per inserirlo nel nuovo flusso.");
        return;
    }

    const rows = candidates.map((entry) => {
        const checked = slugify(entry.ownerCharacterId || "") === ownerCharacterId;
        const linkedElsewhere = entry.ownerCharacterId && !checked;
        const image = managedActorSummaryImage(entry);
        return `
            <label class="cripta-companion-choice" data-companion-choice data-search="${escapeHtml(String(entry.name || "").toLowerCase())}">
                <input type="checkbox" name="companion" value="${escapeHtml(entry.actorId || "")}" ${checked ? "checked" : ""}>
                <span class="cripta-companion-choice__image">${image ? `<img src="${escapeHtml(image)}" alt="">` : '<i class="fas fa-paw"></i>'}</span>
                <span class="cripta-companion-choice__copy">
                    <strong>${escapeHtml(entry.name || "NPC")}</strong>
                    <small>${linkedElsewhere ? `Attualmente companion di ${escapeHtml(entry.ownerCharacterId)}` : (checked ? "Companion attuale" : "NPC disponibile")}</small>
                </span>
                ${linkedElsewhere ? '<span class="cripta-companion-choice__transfer"><i class="fas fa-arrow-right-arrow-left"></i> trasferisci</span>' : ""}
            </label>
        `;
    }).join("");

    renderDialog({
        title: `Companion di ${playerActor.name}`,
        content: `
            <form class="cripta-companion-picker">
                <p>Seleziona gli NPC da collegare. Deselezionare rimuove soltanto il legame: l'Actor non viene cancellato.</p>
                <label class="cripta-companion-search">
                    <i class="fas fa-magnifying-glass"></i>
                    <input type="search" data-companion-search placeholder="Cerca un NPC..." autocomplete="off">
                </label>
                <div class="cripta-companion-choice-list">${rows}</div>
            </form>
        `,
        buttons: {
            cancel: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Annulla"
            },
            save: {
                icon: '<i class="fas fa-link"></i>',
                label: "Salva legami",
                callback: async (html) => {
                    const selected = new Set(html.find('input[name="companion"]:checked').map((_, input) => String(input.value || "")).get());
                    const transfers = candidates.filter((entry) => selected.has(String(entry.actorId || ""))
                        && entry.ownerCharacterId
                        && slugify(entry.ownerCharacterId) !== ownerCharacterId);
                    if (transfers.length) {
                        const confirmed = await confirmDialog({
                            title: "Trasferire companion?",
                            content: `<p>${escapeHtml(transfers.map((entry) => entry.name).join(", "))} e gia collegato a un altro personaggio. Vuoi trasferire il legame a ${escapeHtml(playerActor.name)}?</p>`
                        });
                        if (!confirmed) return false;
                    }
                    const changed = candidates.filter((entry) => {
                        const wasSelected = slugify(entry.ownerCharacterId || "") === ownerCharacterId;
                        return selected.has(String(entry.actorId || "")) !== wasSelected;
                    });
                    if (!changed.length) {
                        ui.notifications.info("Nessuna modifica ai companion.");
                        return;
                    }
                    let applied = 0;
                    try {
                        for (const entry of changed) {
                            const shouldLink = selected.has(String(entry.actorId || ""));
                            const linkedActor = managedActorSummaryFoundryActor(entry);
                            if (!linkedActor) continue;
                            await saveManagedActorRelationship(entry, shouldLink ? ownerCharacterId : "");
                            await setCompanionRelationshipMapping(linkedActor, {
                                relationshipType: shouldLink ? "companion" : "",
                                ownerCharacterId: shouldLink ? ownerCharacterId : "",
                                ownerAccountIds: shouldLink ? [playerLink.ownerAccountId].filter(Boolean) : []
                            });
                            applied += 1;
                        }
                    } catch (error) {
                        ui.notifications.error(`Aggiornamento companion interrotto: ${error.message}`);
                        return false;
                    }
                    ui.notifications.info(`Companion aggiornati: ${applied}.`);
                    playerActor.sheet?.render?.(false);
                }
            }
        },
        default: "save",
        render: (html) => {
            html.find("[data-companion-search]").on("input", (event) => {
                const query = String(event.currentTarget.value || "").trim().toLowerCase();
                html.find("[data-companion-choice]").each((_, row) => {
                    row.hidden = Boolean(query && !String(row.dataset.search || "").includes(query));
                });
            });
        }
    }, {
        width: 640,
        height: "auto",
        classes: ["cripta-companion-picker-dialog"]
    });
}
async function buildCharacterSyncPayload() {
    const configuredPlayerActors = resolveConfiguredPlayerActors();
    const playerActorEntries = configuredPlayerActors;
    const playerActors = playerActorEntries.map((entry) => entry.actor);
    const actors = await Promise.all(playerActorEntries.map(async ({ actor, mapping }) => {
        await withCharacterSyncSuppressed(() => ensureTransferIdsForActorItems(actor, isUsefulCharacterItem));
        return mapActorForSync(actor, {
            ownerCharacterId: mapping?.ownerCharacterId,
            ownerAccountId: mapping?.ownerAccountId
        });
    }));
    const companions = (await Promise.all(parseCompanionMappings()
        .map(async (mapping) => {
            const actor = getConfiguredActor(mapping.actorId || mapping.actorName);
            if (!actor) return null;
            const ownerCharacterId = await resolveOwnerCharacterIdForCompanionMapping(mapping, actor, playerActors);
            if (!ownerCharacterId) return null;
            const ownerUser = mapping.ownerUserKey ? findFoundryUserByCompanionKey(mapping.ownerUserKey) : null;
            await withCharacterSyncSuppressed(() => ensureTransferIdsForActorItems(actor, isUsefulCompanionItem));
            return mapActorForSync(actor, {
                displayName: mapping.displayName,
                ownerCharacterId,
                ownerAccountId: mapping.ownerAccountId || (ownerUser ? getPreferredAccountIdForFoundryUser(ownerUser) : undefined),
                ownerDiscordId: mapping.ownerDiscordId,
                usefulItemPredicate: isUsefulCompanionItem
            });
        }))).filter(Boolean);

    return {
        schemaVersion: 3,
        contract: buildFoundrySyncContract(),
        moduleId: MODULE_ID,
        world: { id: game.world.id, title: game.world.title },
        gm: { id: game.user.id, name: game.user.name },
        generatedAt: new Date().toISOString(),
        actors,
        companions
    };
}

function buildFoundryAssetRegistrySnapshot(payload) {
    const assets = [];
    const worldId = String(payload?.world?.id || game.world?.id || "").trim();
    const addAsset = (asset) => {
        const normalized = compactObject(asset);
        if (!normalized.entityType || !normalized.entityId || !normalized.slot) return;
        if (!String(normalized.value || "").trim()) return;
        const hashInput = {
            value: normalized.value,
            slot: normalized.slot,
            foundry: normalized.foundry || {}
        };
        assets.push({
            ...normalized,
            id: `${getCampaignId()}:${normalized.entityType}:${normalized.entityId}:${normalized.slot}`,
            hash: hashAssetValue(hashInput),
            updatedAt: payload?.generatedAt || new Date().toISOString()
        });
    };

    const addActorAssets = (actor, entityType) => {
        if (!actor) return;
        const entityId = entityType === "companion"
            ? buildCompanionMediaEntityId(actor.ownerCharacterId || "", actor.actorId || actor.id || "", actor.foundryName || actor.name || "")
            : slugify(actor.ownerCharacterId || actor.id || actor.name);
        const actorRef = {
            worldId,
            actorId: actor.id,
            actorName: actor.foundryName || actor.name,
            uuid: actor.id ? `Actor.${actor.id}` : ""
        };
        addAsset({
            entityType,
            entityId,
            slot: "avatar",
            label: `${actor.name || actor.foundryName || entityId} - Avatar`,
            value: actor.img,
            foundry: actorRef
        });
        addAsset({
            entityType,
            entityId,
            slot: "token",
            label: `${actor.name || actor.foundryName || entityId} - Token`,
            value: actor.token?.img,
            foundry: actorRef
        });
        (Array.isArray(actor.inventory) ? actor.inventory : []).forEach((item) => {
            addItemAssets(actor, item, actorRef);
        });
    };

    const addItemAssets = (actor, item, actorRef) => {
        if (!item) return;
        const itemType = item.type === "feat" || item.type === "spell" ? "ability" : "item";
        const ownerId = slugify(actor.ownerCharacterId || actor.id || actor.name || "actor");
        const itemKey = slugify(`${ownerId}-${item.type || "item"}-${item.name || item.id || "entry"}`);
        const foundry = {
            ...actorRef,
            itemId: item.id,
            itemName: item.name,
            uuid: actor.id && item.id ? `Actor.${actor.id}.Item.${item.id}` : actorRef.uuid
        };
        addAsset({
            entityType: itemType,
            entityId: itemKey,
            slot: "image",
            label: `${actor.name || actor.foundryName || ownerId} - ${item.name || "Elemento"} - Icona`,
            value: item.img,
            foundry
        });
        addAsset({
            entityType: itemType,
            entityId: itemKey,
            slot: "description",
            label: `${actor.name || actor.foundryName || ownerId} - ${item.name || "Elemento"} - Descrizione`,
            value: item.description,
            foundry
        });
    };

    (Array.isArray(payload?.actors) ? payload.actors : []).forEach((actor) => addActorAssets(actor, "player"));
    (Array.isArray(payload?.companions) ? payload.companions : []).forEach((actor) => addActorAssets(actor, "companion"));
    return assets;
}

function hashAssetValue(value) {
    const text = stableAssetStringify(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableAssetStringify(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return `[${value.map(stableAssetStringify).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableAssetStringify(value[key])}`).join(",")}}`;
}

function buildCharacterSyncFingerprint(payload) {
    const assets = (Array.isArray(payload?.assetRegistry?.assets) ? payload.assetRegistry.assets : [])
        .map(({ updatedAt, ...asset }) => asset)
        .sort((left, right) =>
            String(left.id || "").localeCompare(String(right.id || ""), "it")
            || String(left.hash || "").localeCompare(String(right.hash || ""), "it")
        );
    return hashAssetValue({
        schemaVersion: payload?.schemaVersion,
        moduleId: payload?.moduleId,
        campaignId: payload?.campaignId,
        world: payload?.world,
        actors: payload?.actors || [],
        companions: payload?.companions || [],
        assetRegistry: {
            schemaVersion: payload?.assetRegistry?.schemaVersion || 1,
            assets
        }
    });
}

function getLastCharacterSyncState() {
    const state = game.settings.get(MODULE_ID, SETTINGS.LAST_CHARACTER_SYNC_STATE);
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function canSyncCharacters() {
    if (!canPushToWorker()) return false;
    if (!game.user?.isGM) return false;
    if (game.users.activeGM?.id && game.users.activeGM.id !== game.user.id) return false;
    return true;
}

function canApplyRemoteChanges() {
    if (!canPullFromWorker()) return false;
    if (!game.user?.isGM) return false;
    if (game.users.activeGM?.id && game.users.activeGM.id !== game.user.id) return false;
    return true;
}

async function syncCharactersToWorker({ notify = false, force = false } = {}) {
    if (!canSyncCharacters()) return false;
    const payload = await buildCharacterSyncPayload();
    payload.assetRegistry = {
        schemaVersion: 1,
        generatedAt: payload.generatedAt,
        assets: buildFoundryAssetRegistrySnapshot(payload)
    };
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    payload.campaignId = getCampaignId();
    const fingerprint = buildCharacterSyncFingerprint(payload);
    const lastSyncState = getLastCharacterSyncState();
    if (!force && lastSyncState.hash === fingerprint && lastSyncState.campaignId === payload.campaignId) {
        console.info(`${MODULE_ID} | Sync personaggi saltata: snapshot Foundry invariato.`, {
            campaignId: payload.campaignId,
            hash: fingerprint,
            lastSyncedAt: lastSyncState.syncedAt || null
        });
        return false;
    }

    const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/api/inventory`), {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {})
        },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
    await game.settings.set(MODULE_ID, SETTINGS.LAST_CHARACTER_SYNC_STATE, {
        hash: fingerprint,
        campaignId: payload.campaignId,
        syncedAt: new Date().toISOString(),
        savedAt: data?.savedAt || "",
        actorCount: payload.actors.length,
        companionCount: payload.companions?.length || 0,
        assetCount: payload.assetRegistry.assets.length
    });
    if (notify) ui.notifications.info(`Personaggi sincronizzati (${payload.actors.length}, companion ${payload.companions?.length || 0}).`);
    console.info(`${MODULE_ID} | Personaggi sincronizzati.`, {
        actors: payload.actors.length,
        companions: payload.companions?.length || 0,
        assets: payload.assetRegistry.assets.length,
        hash: fingerprint,
        assetRegistry: data?.assetRegistry || null,
        savedAt: data?.savedAt
    });
    return true;
}

function scheduleCharacterSync(reason = "update") {
    if (suppressCharacterSync) return;
    if (!canSyncCharacters()) return;
    const enabled = game.settings.get(MODULE_ID, SETTINGS.AUTO_CHARACTER_SYNC);
    if (!enabled) {
        if (!autoCharacterSyncDisabledWarningShown) {
            autoCharacterSyncDisabledWarningShown = true;
            console.info(`${MODULE_ID} | Autosync personaggi disattivata. Attivala dalle impostazioni del modulo o usa "Forza sync personaggi".`, { reason });
        }
        return;
    }
    const alreadyScheduled = characterSyncTimer !== null;
    if (alreadyScheduled) window.clearTimeout(characterSyncTimer);
    if (!alreadyScheduled) console.info(`${MODULE_ID} | Sync personaggi schedulata.`, { reason, delayMs: CHARACTER_SYNC_DEBOUNCE_MS });
    characterSyncTimer = window.setTimeout(() => {
        characterSyncTimer = null;
        syncCharactersToWorker().catch((error) => {
            console.warn(`${MODULE_ID} | Sync personaggi fallito (${reason}).`, error);
        });
    }, CHARACTER_SYNC_DEBOUNCE_MS);
}

function scheduleCharacterSyncForActor(actor, reason = "update") {
    if (suppressCharacterSync) return;
    if (isConfiguredPlayerActor(actor) || isConfiguredCompanionActor(actor)) {
        scheduleCharacterSync(reason);
        return;
    }
    if (actor) {
        console.debug(`${MODULE_ID} | Sync personaggi non schedulata: actor non configurato.`, {
            reason,
            actor: actor.name,
            actorId: actor.id
        });
    }
}

function getCharacterSyncDebugState(actor = null) {
    const targetActor = typeof actor === "string"
        ? (game.actors.get(actor) || game.actors.find((entry) => normalizeWikiItemKey(entry.name) === normalizeWikiItemKey(actor)))
        : actor;
    return {
        canSync: canSyncCharacters(),
        autoCharacterSync: Boolean(game.settings.get(MODULE_ID, SETTINGS.AUTO_CHARACTER_SYNC)),
        activeGmId: game.users.activeGM?.id || "",
        currentUserId: game.user?.id || "",
        actor: targetActor ? {
            id: targetActor.id,
            name: targetActor.name,
            configuredPlayer: isConfiguredPlayerActor(targetActor),
            configuredCompanion: isConfiguredCompanionActor(targetActor),
            itemCount: targetActor.items?.size || targetActor.items?.contents?.length || 0
        } : null,
        lastCharacterSyncState: getLastCharacterSyncState()
    };
}

function getStoredWikiUser() {
    try {
        const user = game.settings.get(MODULE_ID, SETTINGS.DISCORD_USER) || {};
        const id = String(user.id || user.discordId || "").trim();
        return id ? { ...user, id } : null;
    } catch (_) {
        return null;
    }
}

async function requestNotesApi(path, options = {}) {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (!token) throw new Error("Login wiki richiesto.");

    const url = new URL(`${DISCORD_WORKER_URL}/${path.replace(/^\/+/, "")}`);
    Object.entries(options.query || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    url.searchParams.set("campaign", getCampaignId());

    const response = await policyFetch(url.toString(), {
        method: options.method || "GET",
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${token}`
        },
        body: options.body ? JSON.stringify({ ...options.body, campaignId: getCampaignId() }) : undefined
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

async function requestWorkerJson(path, options = {}) {
    const url = new URL(`${DISCORD_WORKER_URL}/${path.replace(/^\/+/, "")}`);
    Object.entries(options.query || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    if (!url.searchParams.has("campaign")) url.searchParams.set("campaign", getCampaignId());

    const body = options.body ? { ...options.body, campaignId: getCampaignId() } : null;
    const response = await policyFetch(url.toString(), {
        method: options.method || (body ? "POST" : "GET"),
        headers: {
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: options.cache || "no-store"
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

async function loadWorkerSyncStatus({ force = false } = {}) {
    const now = Date.now();
    if (!force && workerSyncStatusCache.data && now - workerSyncStatusCache.loadedAt < 30_000) {
        return workerSyncStatusCache.data;
    }
    if (!force && workerSyncStatusCache.promise) return workerSyncStatusCache.promise;

    workerSyncStatusCache.promise = requestWorkerJson("api/sync/status")
        .then((data) => {
            workerSyncStatusCache.data = data;
            workerSyncStatusCache.loadedAt = Date.now();
            return data;
        })
        .catch((error) => {
            console.warn(`${MODULE_ID} | Stato sync worker non disponibile.`, error);
            return null;
        })
        .finally(() => {
            workerSyncStatusCache.promise = null;
        });

    return workerSyncStatusCache.promise;
}

async function loadWorkerSyncChanges({ since = "", collections = [] } = {}) {
    const query = {};
    const cleanSince = String(since || "").trim();
    if (cleanSince) query.since = cleanSince;
    const requestedCollections = Array.from(new Set((Array.isArray(collections) ? collections : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)));
    if (requestedCollections.length) query.collections = requestedCollections.join(",");
    return requestWorkerJson("api/sync/changes", { query });
}

function getRemoteChangedCollectionSet(changesPayload) {
    const entries = Array.isArray(changesPayload?.changes?.collections)
        ? changesPayload.changes.collections
        : [];
    return new Set(entries.map((entry) => String(entry?.collection || "").trim()).filter(Boolean));
}

function getLastRemoteSyncAppliedAt() {
    return String(game.settings.get(MODULE_ID, SETTINGS.LAST_REMOTE_SYNC_APPLIED_AT) || "").trim();
}

function compactSyncStatusValue(value, maxLength = 68) {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    if (raw.length <= maxLength) return raw;
    const headLength = Math.max(18, Math.floor(maxLength * 0.62));
    const tailLength = Math.max(10, maxLength - headLength - 3);
    return `${raw.slice(0, headLength)}...${raw.slice(-tailLength)}`;
}

function formatSyncStatusDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat("it-IT", {
        timeZone: "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(date);
}

async function openWorkerSyncStatusDialog() {
    const status = await loadWorkerSyncStatus({ force: true });
    if (!status) throw new Error("Stato sync remoto non disponibile.");

    const collections = Object.values(status.collections || {});
    const collectionRows = collections.length
        ? collections.map((entry) => `
            <tr>
                <td>${escapeHtml(entry.collection || "-")}</td>
                <td>${escapeHtml(String(entry.count ?? "-"))}</td>
                <td title="${escapeHtml(entry.updatedAt || "")}">${escapeHtml(formatSyncStatusDate(entry.updatedAt))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="3">Nessuna collezione trovata.</td></tr>`;

    const summaryItems = [
        { label: "Campagna", value: status.campaignId },
        { label: "Token stato", value: compactSyncStatusValue(status.stateToken), title: status.stateToken },
        { label: "Ultimo update", value: formatSyncStatusDate(status.updatedAt), title: status.updatedAt },
        { label: "Inventario", value: formatSyncStatusDate(status.inventory?.updatedAt), title: status.inventory?.updatedAt || "" },
        { label: "Asset registry", value: formatSyncStatusDate(status.assetRegistry?.updatedAt), title: status.assetRegistry?.updatedAt || "" },
        { label: "Media manifest", value: compactSyncStatusValue(status.mediaManifest?.updatedAt || status.mediaManifest?.url || "-"), title: status.mediaManifest?.url || "" }
    ];

    const content = `
        <form class="cripta-sync-status">
            <p>Controllo leggero del worker: non carica immagini e non modifica dati.</p>
            <dl>
                ${summaryItems.map((item) => `
                    <dt>${escapeHtml(item.label)}</dt>
                    <dd title="${escapeHtml(item.title || item.value || "")}">${escapeHtml(String(item.value || "-"))}</dd>
                `).join("")}
            </dl>
            <div class="cripta-sync-status-table">
                <table>
                    <thead>
                        <tr>
                            <th>Dato</th>
                            <th>Record</th>
                            <th>Aggiornato</th>
                        </tr>
                    </thead>
                    <tbody>${collectionRows}</tbody>
                </table>
            </div>
        </form>
    `;

    renderDialog({
        title: "Stato sync remoto",
        content,
        buttons: {
            close: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Chiudi"
            }
        }
    }, {
        width: 640,
        classes: ["cripta-sync-status-dialog"]
    });
}

async function runAutomaticLightSyncFromWorkerStatus({ force = false, refreshStatus = false } = {}) {
    if (!canApplyRemoteChanges()) return false;

    const status = await loadWorkerSyncStatus({ force: force || refreshStatus });
    const stateToken = String(status?.stateToken || "").trim();
    if (!stateToken) {
        console.warn(`${MODULE_ID} | Sync leggera automatica saltata: stateToken assente.`);
        return false;
    }

    const previousStateToken = String(game.settings.get(MODULE_ID, SETTINGS.LAST_LIGHT_SYNC_STATE_TOKEN) || "").trim();
    const stateMarker = `v${LIGHT_SYNC_SCHEMA_VERSION}:${stateToken}`;
    const lightSyncSchemaChanged = !previousStateToken.startsWith(`v${LIGHT_SYNC_SCHEMA_VERSION}:`);
    if (!force && previousStateToken && previousStateToken === stateMarker) {
        console.info(`${MODULE_ID} | Sync leggera automatica saltata: worker invariato.`, {
            campaignId: status.campaignId,
            updatedAt: status.updatedAt
        });
        return false;
    }

    const results = {};
    let failed = false;
    const lastRemoteAppliedAt = getLastRemoteSyncAppliedAt();
    let changesPayload = null;
    let changedCollections = new Set();
    try {
        changesPayload = await loadWorkerSyncChanges({ since: lastRemoteAppliedAt });
        changedCollections = getRemoteChangedCollectionSet(changesPayload);
    } catch (error) {
        console.warn(`${MODULE_ID} | Sync leggera: elenco changes non disponibile, uso controllo completo sicuro.`, error);
    }

    const hasChangesPayload = Boolean(changesPayload);
    const shouldRunAllSafe = force || lightSyncSchemaChanged || !lastRemoteAppliedAt || !hasChangesPayload;
    const shouldRunSkillTrees = shouldRunAllSafe
        || changedCollections.has("skill-trees")
        || changedCollections.has("skill-tree-states");
    const shouldRunTransformations = shouldRunAllSafe || changedCollections.has("transformations");
    const shouldRunMediaOverrides = shouldRunAllSafe || changedCollections.has("media-overrides");
    const shouldRunAbilityOverrides = shouldRunAllSafe || changedCollections.has("ability-overrides");
    const shouldRunItemOverrides = shouldRunAllSafe || changedCollections.has("item-overrides");
    const manualChanges = Array.from(MANUAL_REMOTE_SYNC_COLLECTIONS).filter((collection) => changedCollections.has(collection));

    try {
        results.managedRemotePaths = await ensureManagedRemotePathsActive({ notify: false });
    } catch (error) {
        results.managedRemotePaths = false;
        failed = true;
        console.warn(`${MODULE_ID} | Sync leggera: attivazione path R2 fallita.`, error);
    }

    if (shouldRunSkillTrees) {
        try {
            results.skillTreeAbilities = await syncUnlockedSkillTreeAbilitiesToFoundry({ notify: false, force: true });
            loadWikiSkillTrees({ force: true })
                .then(rerenderOpenActorSheetsForSkillTreeButtons)
                .catch(() => {});
        } catch (error) {
            results.skillTreeAbilities = false;
            failed = true;
            console.warn(`${MODULE_ID} | Sync leggera: abilita alberi fallita.`, error);
        }
    } else {
        results.skillTreeAbilities = "unchanged";
    }

    if (shouldRunTransformations) {
        try {
            results.tokenizer = await syncTransformationsToTokenizer({ force: true, notify: false });
        } catch (error) {
            results.tokenizer = false;
            failed = true;
            console.warn(`${MODULE_ID} | Sync leggera: Tokenizer fallito.`, error);
        }
    } else {
        results.tokenizer = "unchanged";
    }

    if (shouldRunMediaOverrides) {
        try {
            results.mediaOverrides = await applyCharacterMediaOverridesFromWiki({ notify: false, autoSafe: true });
        } catch (error) {
            results.mediaOverrides = false;
            console.warn(`${MODULE_ID} | Sync leggera: immagini sito autoSafe fallite.`, error);
        }
    } else {
        results.mediaOverrides = "unchanged";
    }

    if (shouldRunAbilityOverrides) {
        try {
            results.abilityOverrides = await applyAbilityOverridesFromWiki({ notify: false, autoSafe: true });
        } catch (error) {
            results.abilityOverrides = false;
            console.warn(`${MODULE_ID} | Sync leggera: override abilita autoSafe falliti.`, error);
        }
    } else {
        results.abilityOverrides = "unchanged";
    }

    if (shouldRunItemOverrides) {
        try {
            results.itemOverrides = await applyItemOverridesFromWiki({ notify: false, autoSafe: true });
        } catch (error) {
            results.itemOverrides = false;
            console.warn(`${MODULE_ID} | Sync leggera: override inventario autoSafe falliti.`, error);
        }
    } else {
        results.itemOverrides = "unchanged";
    }

    if (manualChanges.length) {
        console.info(`${MODULE_ID} | Modifiche remote rilevate ma lasciate manuali.`, {
            collections: manualChanges
        });
    }

    if (failed) {
        console.warn(`${MODULE_ID} | Sync leggera automatica incompleta: stateToken non salvato per ritentare al prossimo avvio.`, {
            campaignId: status.campaignId,
            updatedAt: status.updatedAt,
            results
        });
        return false;
    }

    if (hasChangesPayload) {
        const appliedAt = String(changesPayload.updatedAt || status.updatedAt || "").trim();
        if (appliedAt) await game.settings.set(MODULE_ID, SETTINGS.LAST_REMOTE_SYNC_APPLIED_AT, appliedAt);
    }
    await game.settings.set(MODULE_ID, SETTINGS.LAST_LIGHT_SYNC_STATE_TOKEN, stateMarker);
    console.info(`${MODULE_ID} | Sync leggera automatica completata.`, {
        campaignId: status.campaignId,
        updatedAt: status.updatedAt,
        changedCollections: Array.from(changedCollections),
        manualChanges,
        results
    });
    return true;
}

function resolveAbilityOverrideImageUrl(image) {
    const value = String(image || "").trim();
    if (!value) return "";
    if (/^(https?:|data:|blob:)/i.test(value)) return value;
    if (value.startsWith("media/")) return `${DISCORD_WORKER_URL}/${value.replace(/^\/+/, "")}`;
    return value;
}

function renderAbilityOverrideDescription(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/<[^>]+>/.test(raw)) return raw;
    return raw
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
}

function normalizeOverrideCompareValue(value) {
    return String(value || "")
        .replace(/\r\n/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeOverrideImageValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const workerBase = DISCORD_WORKER_URL.replace(/\/+$/, "");
    return raw
        .replace(workerBase, "")
        .replace(/^https?:\/\/khuzoe\.github\.io\/sigillo-del-male\/assets\//i, "")
        .replace(/^\/+/, "")
        .trim();
}

function hashOverrideFieldValue(value) {
    return hashAssetValue(value);
}

function hashOverrideImageValue(value) {
    return hashOverrideFieldValue(normalizeManagedRemotePath(value) || normalizeOverrideImageValue(value));
}

function hashOverrideDescriptionValue(value) {
    return hashOverrideFieldValue(normalizeOverrideCompareValue(value));
}


function getSiteOverrideState(item) {
    const state = item?.getFlag?.(MODULE_ID, SITE_OVERRIDE_STATE_FLAG) || {};
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function canAutoApplyItemImageOverride(item, remotePath) {
    if (!item || !remotePath) return false;
    const current = String(item.img || "").trim();
    if (!current) return true;
    if (normalizeManagedRemotePath(current)) return true;

    const managed = getManagedMediaState(item, "image");
    const managedLocal = normalizeFoundryLocalMediaPath(managed?.local);
    const currentLocal = normalizeFoundryLocalMediaPath(current);
    if (managedLocal && currentLocal && managedLocal === currentLocal) return true;

    const state = getSiteOverrideState(item);
    return Boolean(state.image?.appliedHash && state.image.appliedHash === hashOverrideImageValue(current));
}

function canAutoApplyItemDescriptionOverride(item) {
    const current = String(item?.system?.description?.value || "").trim();
    if (!current) return true;
    const state = getSiteOverrideState(item);
    return Boolean(state.description?.appliedHash && state.description.appliedHash === hashOverrideDescriptionValue(current));
}


async function updateSiteOverrideState(item, updates = {}) {
    if (!item?.update) return false;
    const previous = getSiteOverrideState(item);
    const plan = planSiteOverrideState(previous, updates, {
        hashImage: hashOverrideImageValue,
        hashDescription: hashOverrideDescriptionValue
    });
    if (!plan.changed) return false;
    const result = await item.update({
        [`flags.${MODULE_ID}.${SITE_OVERRIDE_STATE_FLAG}`]: plan.state
    }, { criptaWikiSyncCommand: true, render: false });
    return Boolean(result);
}

function describeOverrideChanges(changes) {
    return changes.map((change) => change.label).join(", ");
}

async function selectWikiOverridesToApply({ title, description, entries }) {
    if (!entries.length) return [];
    if (entries.length === 1) return entries;

    const rows = entries.map((entry, index) => `
        <label class="cripta-override-select-row">
            <input type="checkbox" name="override" value="${index}" checked>
            <span>
                <strong>${escapeHtml(entry.label)}</strong>
                <small>${escapeHtml(entry.detail || "")}</small>
                <em>${escapeHtml(describeOverrideChanges(entry.changes || []))}</em>
            </span>
        </label>
    `).join("");

    let settled = false;
    return new Promise((resolve) => {
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        renderDialog({
            title,
            content: `
                <form class="cripta-override-select">
                    <p>${escapeHtml(description || "Seleziona gli elementi da sincronizzare dal sito verso Foundry.")}</p>
                    <div class="cripta-override-select-toolbar">
                        <button type="button" data-override-select-all>Seleziona tutto</button>
                        <button type="button" data-override-select-none>Deseleziona tutto</button>
                    </div>
                    <div class="cripta-override-select-list">
                        ${rows}
                    </div>
                </form>
                <style>
                    .cripta-override-select p { margin: 0 0 0.75rem; }
                    .cripta-override-select-toolbar { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
                    .cripta-override-select-toolbar button {
                        border: 1px solid rgba(184, 139, 43, 0.7);
                        border-radius: 6px;
                        background: rgba(0, 0, 0, 0.25);
                        color: #f0dfb6;
                        padding: 0.25rem 0.6rem;
                    }
                    .cripta-override-select-list { display: grid; gap: 0.45rem; max-height: 420px; overflow: auto; padding-right: 0.25rem; }
                    .cripta-override-select-row {
                        display: grid;
                        grid-template-columns: auto 1fr;
                        gap: 0.6rem;
                        align-items: start;
                        padding: 0.55rem 0.65rem;
                        border: 1px solid rgba(184, 139, 43, 0.35);
                        border-radius: 8px;
                        background: rgba(0, 0, 0, 0.18);
                    }
                    .cripta-override-select-row input { margin-top: 0.2rem; }
                    .cripta-override-select-row strong,
                    .cripta-override-select-row small,
                    .cripta-override-select-row em { display: block; }
                    .cripta-override-select-row small { opacity: 0.78; margin-top: 0.15rem; }
                    .cripta-override-select-row em { color: #f0c84a; font-style: normal; margin-top: 0.2rem; }
                </style>
            `,
            buttons: {
                apply: {
                    icon: '<i class="fas fa-check"></i>',
                    label: "Applica selezionati",
                    callback: (html) => {
                        const root = html instanceof HTMLElement ? html : html[0];
                        const selected = Array.from(root?.querySelectorAll?.('input[name="override"]:checked') || [])
                            .map((input) => entries[Number(input.value)])
                            .filter(Boolean);
                        finish(selected);
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-xmark"></i>',
                    label: "Annulla",
                    callback: () => finish(null)
                }
            },
            render: (html) => {
                const root = html instanceof HTMLElement ? html : html[0];
                root?.querySelector?.("[data-override-select-all]")?.addEventListener("click", () => {
                    root.querySelectorAll('input[name="override"]').forEach((input) => { input.checked = true; });
                });
                root?.querySelector?.("[data-override-select-none]")?.addEventListener("click", () => {
                    root.querySelectorAll('input[name="override"]').forEach((input) => { input.checked = false; });
                });
            },
            close: () => finish(null)
        }, {
            width: 620,
            classes: ["cripta-override-select-dialog"]
        });
    });
}

function findActorForAbilityOverride(override) {
    const actorId = normalizeActorRef(override?.actorId || "");
    const actorName = normalizeWikiItemKey(override?.actorName || override?.characterName || "");
    return (actorId ? game.actors.get(actorId) : null)
        || game.actors.find((actor) => actor.type === "character" && normalizeWikiItemKey(actor.name) === actorName)
        || game.actors.find((actor) => actor.type === "character" && actorName && normalizeWikiItemKey(actor.name).includes(actorName))
        || null;
}

function findActorAbilityItem(actor, override) {
    if (!actor) return null;
    const abilityId = String(override?.abilityId || "").trim();
    const abilityName = normalizeWikiItemKey(override?.abilityName || "");
    return (abilityId ? actor.items.get(abilityId) : null)
        || actor.items.find((item) => item.type === "feat" && normalizeWikiItemKey(item.name) === abilityName)
        || null;
}

function findActorInventoryItem(actor, override) {
    if (!actor) return null;
    const transferId = String(override?.transferId || "").trim();
    const transferKey = String(override?.transferKey || "").trim();
    const sourceId = normalizeWikiItemKey(override?.sourceId || "");
    const itemId = String(override?.itemId || "").trim();
    const itemName = normalizeWikiItemKey(override?.itemName || "");
    return actor.items.find((item) => transferId && getItemTransferId(item) === transferId)
        || actor.items.find((item) => transferKey && getItemOverrideIdentityForItem(actor, item).transferKey === transferKey)
        || actor.items.find((item) => sourceId && normalizeWikiItemKey(getItemStableSourceId(item)) === sourceId)
        || (itemId ? actor.items.get(itemId) : null)
        || actor.items.find((item) => itemName && normalizeWikiItemKey(item.name) === itemName)
        || null;
}

async function applyAbilityOverridesFromWiki({ notify = false, autoSafe = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo applicare override abilita dalla wiki.");
        return false;
    }

    const payload = await requestNotesApi("api/data/ability-overrides");
    const overrides = Array.isArray(payload?.data) ? payload.data : [];
    if (!overrides.length) {
        ui.notifications.info("Nessun override abilita trovato nella wiki.");
        return true;
    }

    const candidates = [];
    const summary = createOverrideSummary();
    for (const override of overrides) {
        const actor = findActorForAbilityOverride(override);
        const item = findActorAbilityItem(actor, override);
        if (!actor || !item) {
            summary.skipped += 1;
            if (!autoSafe) console.warn(`${MODULE_ID} | Override abilita non applicato: actor/item non trovato.`, override);
            continue;
        }

        const patch = {};
        const imageRemote = String(override.image || "").trim();
        const image = resolveAbilityOverrideImageUrl(imageRemote);
        const description = renderAbilityOverrideDescription(override.description);
        const changes = [];
        const baselineUpdates = {};
        let protectedChange = false;
        if (image && normalizeOverrideImageValue(image) !== normalizeOverrideImageValue(item.img)) {
            patch.img = imageRemote;
            changes.push({ field: "image", label: "Icona" });
        } else if (imageRemote && image) {
            baselineUpdates.image = { siteValue: imageRemote, appliedValue: item.img };
        }
        const currentDescription = item.system?.description?.value || "";
        if (description && normalizeOverrideCompareValue(description) !== normalizeOverrideCompareValue(currentDescription)) {
            patch["system.description.value"] = description;
            changes.push({ field: "description", label: "Descrizione" });
        } else if (description) {
            baselineUpdates.description = { siteValue: description, appliedValue: currentDescription };
        }
        if (autoSafe) {
            if (patch.img && !canAutoApplyItemImageOverride(item, patch.img)) {
                protectedChange = true;
                delete patch.img;
                const index = changes.findIndex((change) => change.field === "image");
                if (index >= 0) changes.splice(index, 1);
            }
            if (patch["system.description.value"] && !canAutoApplyItemDescriptionOverride(item)) {
                protectedChange = true;
                delete patch["system.description.value"];
                const index = changes.findIndex((change) => change.field === "description");
                if (index >= 0) changes.splice(index, 1);
            }

        }
        if (!Object.keys(patch).length) {
            const metadataUpdated = autoSafe && Object.keys(baselineUpdates).length
                ? await updateSiteOverrideState(item, baselineUpdates) : false;
            recordOverrideOutcome(summary, { metadataUpdated, skipped: protectedChange });
            continue;
        }

        candidates.push({
            label: `${actor.name} - ${item.name}`,
            detail: "Abilita",
            changes,
            apply: async () => {
                const nextPatch = { ...patch };
                const stateUpdates = { ...baselineUpdates };
                const previousMedia = JSON.stringify(getManagedMediaState(item, "image"));
                let failedImage = false;
                if (nextPatch.img) {
                    const identity = getAbilityOverrideIdentityForItem(actor, item);
                    const effectiveImage = await resolveAndRegisterManagedMedia(item, "image", {
                        remote: nextPatch.img,
                        local: item.img,
                        entityType: "ability",
                        entityId: identity.key,
                        actor,
                        item,
                        downloadFallback: true
                    });
                    if (effectiveImage) {
                        nextPatch.img = effectiveImage;
                        stateUpdates.image = { siteValue: imageRemote, appliedValue: effectiveImage };
                    } else {
                        delete nextPatch.img;
                        failedImage = true;
                    }
                }
                if (nextPatch["system.description.value"]) {
                    stateUpdates.description = {
                        siteValue: description,
                        appliedValue: nextPatch["system.description.value"]
                    };
                }
                if (nextPatch.img && normalizeOverrideImageValue(nextPatch.img) === normalizeOverrideImageValue(item.img)) delete nextPatch.img;
                if (nextPatch["system.description.value"] && normalizeOverrideCompareValue(nextPatch["system.description.value"]) === normalizeOverrideCompareValue(item.system?.description?.value)) delete nextPatch["system.description.value"];
                const mediaUpdated = previousMedia !== JSON.stringify(getManagedMediaState(item, "image"));
                const contentUpdated = Object.keys(nextPatch).length
                    ? Boolean(await item.update(nextPatch, { criptaWikiSyncCommand: true })) : false;
                if (Object.keys(nextPatch).length && !contentUpdated) return { metadataUpdated: mediaUpdated, skipped: true };
                const stateUpdated = Object.keys(stateUpdates).length ? await updateSiteOverrideState(item, stateUpdates) : false;
                return { contentUpdated, metadataUpdated: stateUpdated || mediaUpdated, skipped: protectedChange || failedImage };
            }
        });
    }

    if (autoSafe) {
        for (const entry of candidates) {
            recordOverrideOutcome(summary, await withCharacterSyncSuppressed(() => entry.apply()));
        }
        console.info(`${MODULE_ID} | Override abilita wiki automatici sicuri.`, summary);
        if (notify) ui.notifications.info(`Override abilita. ${formatOverrideSummary(summary)}`);
        return summary.updated > 0 || summary.metadataUpdated > 0;
    }

    const selected = await selectWikiOverridesToApply({
        title: "Applica override abilita",
        description: "Seleziona quali abilita rendere uguali al sito.",
        entries: candidates
    });
    if (selected === null) return false;

    for (const entry of selected) {
        recordOverrideOutcome(summary, await withCharacterSyncSuppressed(() => entry.apply()));
    }
    summary.skipped += candidates.length - selected.length;

    if (notify) ui.notifications.info(`Override abilita. ${formatOverrideSummary(summary)}`);
    console.info(`${MODULE_ID} | Override abilita wiki applicati.`, summary);
    return true;
}

async function applyItemOverridesFromWiki({ notify = false, autoSafe = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo applicare override inventario dalla wiki.");
        return false;
    }

    const payload = await requestNotesApi("api/data/item-overrides");
    const overrides = Array.isArray(payload?.data) ? payload.data : [];
    if (!overrides.length) {
        ui.notifications.info("Nessun override inventario trovato nella wiki.");
        return true;
    }

    const candidates = [];
    const summary = createOverrideSummary();
    for (const override of overrides) {
        const actor = findActorForAbilityOverride(override);
        const item = findActorInventoryItem(actor, override);
        if (!actor || !item) {
            summary.skipped += 1;
            if (!autoSafe) console.warn(`${MODULE_ID} | Override inventario non applicato: actor/item non trovato.`, override);
            continue;
        }

        const patch = {};
        const imageRemote = String(override.image || "").trim();
        const image = resolveAbilityOverrideImageUrl(imageRemote);
        const managedImageRemote = normalizeManagedRemotePath(imageRemote);
        const currentManagedImage = getManagedMediaState(item, "image");
        let needsManagedImageRegistration = Boolean(managedImageRemote)
            && normalizeManagedRemotePath(currentManagedImage?.remote) !== managedImageRemote;
        const description = renderAbilityOverrideDescription(override.description);
        const changes = [];
        const baselineUpdates = {};
        let protectedChange = false;
        if (image && normalizeOverrideImageValue(image) !== normalizeOverrideImageValue(item.img)) {
            patch.img = imageRemote;
            changes.push({ field: "image", label: "Icona" });
        } else if (imageRemote && image) {
            baselineUpdates.image = { siteValue: imageRemote, appliedValue: item.img };
        }
        if (needsManagedImageRegistration && !changes.some((change) => change.field === "image")) {
            changes.push({ field: "managedMedia", label: "Path R2" });
        }
        const currentDescription = item.system?.description?.value || "";
        if (description && normalizeOverrideCompareValue(description) !== normalizeOverrideCompareValue(currentDescription)) {
            patch["system.description.value"] = description;
            changes.push({ field: "description", label: "Descrizione" });
        } else if (description) {
            baselineUpdates.description = { siteValue: description, appliedValue: currentDescription };
        }
        if (autoSafe) {
            if ((patch.img || needsManagedImageRegistration) && !canAutoApplyItemImageOverride(item, imageRemote)) {
                protectedChange = true;
                delete patch.img;
                needsManagedImageRegistration = false;
                const imageIndex = changes.findIndex((change) => change.field === "image");
                if (imageIndex >= 0) changes.splice(imageIndex, 1);
                const managedIndex = changes.findIndex((change) => change.field === "managedMedia");
                if (managedIndex >= 0) changes.splice(managedIndex, 1);
            }
            if (patch["system.description.value"] && !canAutoApplyItemDescriptionOverride(item)) {
                protectedChange = true;
                delete patch["system.description.value"];
                const index = changes.findIndex((change) => change.field === "description");
                if (index >= 0) changes.splice(index, 1);
            }
        }
        if (!Object.keys(patch).length && !needsManagedImageRegistration) {
            const metadataUpdated = autoSafe && Object.keys(baselineUpdates).length
                ? await updateSiteOverrideState(item, baselineUpdates) : false;
            recordOverrideOutcome(summary, { metadataUpdated, skipped: protectedChange });
            continue;
        }

        candidates.push({
            label: `${actor.name} - ${item.name}`,
            detail: "Inventario",
            changes,
            apply: async () => {
                const nextPatch = { ...patch };
                const stateUpdates = { ...baselineUpdates };
                const previousMedia = JSON.stringify(getManagedMediaState(item, "image"));
                let failedImage = false;
                if (nextPatch.img || needsManagedImageRegistration) {
                    const identity = getItemOverrideIdentityForItem(actor, item);
                    const effectiveImage = await resolveAndRegisterManagedMedia(item, "image", {
                        remote: imageRemote,
                        local: item.img,
                        entityType: "item",
                        entityId: identity.key,
                        actor,
                        item,
                        downloadFallback: true
                    });
                    if (nextPatch.img) {
                        if (effectiveImage) {
                            nextPatch.img = effectiveImage;
                            stateUpdates.image = { siteValue: imageRemote, appliedValue: effectiveImage };
                        } else {
                            delete nextPatch.img;
                            failedImage = true;
                        }
                    } else if (effectiveImage) {
                        stateUpdates.image = { siteValue: imageRemote, appliedValue: item.img };
                    } else {
                        failedImage = true;
                    }
                }
                if (nextPatch["system.description.value"]) {
                    stateUpdates.description = {
                        siteValue: description,
                        appliedValue: nextPatch["system.description.value"]
                    };
                }
                if (nextPatch.img && normalizeOverrideImageValue(nextPatch.img) === normalizeOverrideImageValue(item.img)) delete nextPatch.img;
                if (nextPatch["system.description.value"] && normalizeOverrideCompareValue(nextPatch["system.description.value"]) === normalizeOverrideCompareValue(item.system?.description?.value)) delete nextPatch["system.description.value"];
                const mediaUpdated = previousMedia !== JSON.stringify(getManagedMediaState(item, "image"));
                const contentUpdated = Object.keys(nextPatch).length
                    ? Boolean(await item.update(nextPatch, { criptaWikiSyncCommand: true })) : false;
                if (Object.keys(nextPatch).length && !contentUpdated) return { metadataUpdated: mediaUpdated, skipped: true };
                const stateUpdated = Object.keys(stateUpdates).length ? await updateSiteOverrideState(item, stateUpdates) : false;
                return { contentUpdated, metadataUpdated: stateUpdated || mediaUpdated, skipped: protectedChange || failedImage };
            }
        });
    }

    if (autoSafe) {
        for (const entry of candidates) {
            recordOverrideOutcome(summary, await withCharacterSyncSuppressed(() => entry.apply()));
        }
        console.info(`${MODULE_ID} | Override inventario wiki automatici sicuri.`, summary);
        if (notify) ui.notifications.info(`Override inventario. ${formatOverrideSummary(summary)}`);
        return summary.updated > 0 || summary.metadataUpdated > 0;
    }

    const selected = await selectWikiOverridesToApply({
        title: "Applica override inventario",
        description: "Seleziona quali oggetti rendere uguali al sito.",
        entries: candidates
    });
    if (selected === null) return false;

    for (const entry of selected) {
        recordOverrideOutcome(summary, await withCharacterSyncSuppressed(() => entry.apply()));
    }
    summary.skipped += candidates.length - selected.length;

    if (notify) ui.notifications.info(`Override inventario. ${formatOverrideSummary(summary)}`);
    console.info(`${MODULE_ID} | Override inventario wiki applicati.`, summary);
    return true;
}

function getAbilityOverrideIdentityForItem(actor, item) {
    const actorId = String(actor?.id || "").trim();
    const actorName = String(actor?.name || "").trim();
    const abilityId = String(item?.id || "").trim();
    const abilityName = String(item?.name || "").trim();
    return {
        key: `${slugify(actorId || actorName || "personaggio")}:${slugify(abilityId || abilityName || "abilita")}`,
        actorId,
        actorName,
        abilityId,
        abilityName
    };
}

function getItemOverrideIdentityForItem(actor, item) {
    const actorId = String(actor?.id || "").trim();
    const actorName = String(actor?.name || "").trim();
    const itemId = String(item?.id || "").trim();
    const itemName = String(item?.name || "").trim();
    const itemType = String(item?.type || "").trim();
    const transferId = getItemTransferId(item);
    const sourceId = getItemStableSourceId(item);
    const transferKey = getTransferableItemKey({ itemId, itemName, itemType, sourceId, transferId });
    return {
        key: `${slugify(actorId || actorName || "personaggio")}:${slugify(itemId || itemName || "oggetto")}`,
        actorId,
        actorName,
        itemUuid: String(item?.uuid || "").trim(),
        transferId,
        sourceId,
        transferKey,
        itemId,
        itemName,
        itemType
    };
}

function getItemTransferId(item) {
    return String(item?.getFlag?.(MODULE_ID, "transferId") || item?.flags?.[MODULE_ID]?.transferId || "").trim();
}

async function ensureItemTransferId(item) {
    const existing = getItemTransferId(item);
    if (existing) return existing;
    const id = `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await item?.setFlag?.(MODULE_ID, "transferId", id);
    return id;
}

async function regenerateItemTransferId(item) {
    const id = `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await item?.setFlag?.(MODULE_ID, "transferId", id);
    return id;
}

function actorHasAnotherItemWithTransferId(actor, item, transferId) {
    const id = String(transferId || "").trim();
    if (!actor?.items || !item || !id) return false;
    return actor.items.some((candidate) =>
        candidate
        && candidate.id !== item.id
        && getItemTransferId(candidate) === id
    );
}

async function ensureCreatedItemTransferIdentity(item, usefulItemPredicate = isUsefulCharacterItem) {
    if (!shouldTrackTransferIdForItem(item, usefulItemPredicate)) return false;
    const transferId = getItemTransferId(item);
    if (!transferId) {
        await ensureItemTransferId(item);
        return true;
    }
    if (actorHasAnotherItemWithTransferId(item.actor, item, transferId)) {
        const nextId = await regenerateItemTransferId(item);
        console.info(`${MODULE_ID} | TransferId rigenerato per item duplicato sullo stesso actor.`, {
            actor: item.actor?.name,
            item: item.name,
            previousTransferId: transferId,
            transferId: nextId
        });
        return true;
    }
    return false;
}

function canCurrentUserUpdateItem(item) {
    const user = game.user;
    if (!user || !item) return false;
    if (user.isGM) return true;
    try {
        if (typeof item.canUserModify === "function") return Boolean(item.canUserModify(user, "update"));
        if (typeof item.actor?.canUserModify === "function") return Boolean(item.actor.canUserModify(user, "update"));
    } catch (_) {
        return false;
    }
    return Boolean(item.isOwner || item.actor?.isOwner);
}

function shouldEnsureCreatedItemTransferIdentityOnThisClient(item, userId = "") {
    const currentUserId = String(game.user?.id || "").trim();
    const originUserId = String(userId || "").trim();
    if (!currentUserId || !canCurrentUserUpdateItem(item)) return false;
    // Foundry inoltra createItem a tutti i client: soltanto chi ha originato
    // la creazione deve scrivere il transferId. Il GM attivo resta libero di
    // schedulare il successivo snapshot senza competere con il proprietario.
    if (originUserId) return originUserId === currentUserId;
    // Fallback difensivo per firme hook prive di userId: un solo GM autorevole.
    return canSyncCharacters();
}

function shouldTrackTransferIdForItem(item, usefulItemPredicate = isUsefulCharacterItem) {
    if (!item || item.documentName !== "Item") return false;
    if (typeof usefulItemPredicate === "function" && !usefulItemPredicate(item)) return false;
    return Boolean(item.actor && (isConfiguredPlayerActor(item.actor) || isConfiguredCompanionActor(item.actor)));
}

async function ensureTransferIdsForActorItems(actor, usefulItemPredicate = isUsefulCharacterItem) {
    if (!actor?.items) return 0;
    let updated = 0;
    for (const item of actor.items.contents || []) {
        if (!shouldTrackTransferIdForItem(item, usefulItemPredicate)) continue;
        if (getItemTransferId(item)) continue;
        await ensureItemTransferId(item);
        updated += 1;
    }
    if (updated) console.info(`${MODULE_ID} | TransferId assegnati agli item.`, { actor: actor.name, updated });
    return updated;
}

function getItemStableSourceId(item) {
    return String(
        item?._stats?.compendiumSource
        || item?._source?._stats?.compendiumSource
        || item?._source?.flags?.core?.sourceId
        || item?.flags?.core?.sourceId
        || item?.system?.source?.uuid
        || item?.system?.source?.id
        || item?.flags?.[MODULE_ID]?.wikiItemId
        || ""
    ).trim();
}

function getTransferableItemKey({ itemId = "", itemName = "", itemType = "", sourceId = "", transferId = "" } = {}) {
    const instance = normalizeWikiItemKey(transferId);
    if (instance) return `instance:${instance}`;
    const stableSource = normalizeWikiItemKey(sourceId);
    if (stableSource) return `source:${stableSource}`;
    const name = normalizeWikiItemKey(itemName);
    const type = normalizeWikiItemKey(itemType);
    if (name && type) return `name:${type}:${name}`;
    if (name) return `name:${name}`;
    const id = normalizeWikiItemKey(itemId);
    return id ? `id:${id}` : "";
}

async function resolveWikiCharacterIdForActor(actor) {
    const actorName = normalizeWikiItemKey(actor?.name);
    if (!actorName) return slugify(actor?.id || "personaggio");
    const knownMatch = Object.entries(WIKI_PLAYER_ID_ALIASES).find(([, aliases]) =>
        aliases.map(normalizeWikiItemKey).some((alias) => alias && (alias === actorName || actorName.includes(alias) || alias.includes(actorName)))
    );
    if (knownMatch?.[0]) return knownMatch[0];
    const findPlayerMatch = (players) => (Array.isArray(players) ? players : []).find((player) => {
        const keys = [
            player?.id,
            player?.name,
            player?.foundryName,
            player?.inventory_api_name,
            ...(Array.isArray(player?.inventory_api_aliases) ? player.inventory_api_aliases : [])
        ].map(normalizeWikiItemKey).filter(Boolean);
        return keys.some((key) => key === actorName || key.includes(actorName) || actorName.includes(key));
    });

    try {
        const data = await wikiDataService.load();
        const match = findPlayerMatch(data?.indexPlayers);
        if (match?.id) return slugify(match.id);
    } catch (error) {
        console.warn(`${MODULE_ID} | Indice wiki non disponibile per risolvere id personaggio, provo players.json.`, { actor: actor?.name, error });
    }

    try {
        if (typeof wikiDataService.getDataUrl === "function") {
            const response = await policyFetch(`${wikiDataService.getDataUrl("players.json")}?t=${Date.now()}`);
            if (response.ok) {
                const payload = await response.json();
                const players = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
                const match = findPlayerMatch(players);
                if (match?.id) return slugify(match.id);
            }
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Impossibile risolvere id wiki personaggio, uso fallback.`, { actor: actor?.name, error });
    }
    return slugify(actor?.name || actor?.id || "personaggio");
}

function findExistingAbilityOverrideRecord(records, identity) {
    const normalize = normalizeWikiItemKey;
    return (Array.isArray(records) ? records : []).find((record) => {
        if (!record || typeof record !== "object") return false;
        if (record.key && record.key === identity.key) return true;
        const sameActor = Boolean(record.actorId && identity.actorId && record.actorId === identity.actorId)
            || Boolean(record.actorName && identity.actorName && normalize(record.actorName) === normalize(identity.actorName));
        const sameAbility = Boolean(record.abilityId && identity.abilityId && record.abilityId === identity.abilityId)
            || Boolean(record.abilityName && identity.abilityName && normalize(record.abilityName) === normalize(identity.abilityName));
        return sameActor && sameAbility;
    }) || null;
}

function findExistingItemOverrideRecord(records, identity) {
    const normalize = normalizeWikiItemKey;
    return (Array.isArray(records) ? records : []).find((record) => {
        if (!record || typeof record !== "object") return false;
        if (record.key && record.key === identity.key) return true;
        const sameActor = Boolean(record.actorId && identity.actorId && record.actorId === identity.actorId)
            || Boolean(record.actorName && identity.actorName && normalize(record.actorName) === normalize(identity.actorName));
        if (record.transferId && identity.transferId && record.transferId === identity.transferId) return true;
        if (sameActor && record.transferKey && identity.transferKey && record.transferKey === identity.transferKey) return true;
        if (sameActor && record.sourceId && identity.sourceId && normalize(record.sourceId) === normalize(identity.sourceId)) return true;
        const sameItem = Boolean(record.itemId && identity.itemId && record.itemId === identity.itemId)
            || Boolean(record.itemName && identity.itemName && normalize(record.itemName) === normalize(identity.itemName));
        return sameActor && sameItem;
    }) || null;
}

function extractWorkerMediaPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const clean = raw.split(/[?#]/)[0].replace(/^\/+/, "");
    if (clean.startsWith("media/")) return clean;
    try {
        const url = new URL(raw);
        const workerUrl = new URL(DISCORD_WORKER_URL);
        if (url.origin !== workerUrl.origin) return "";
        const path = url.pathname.replace(/^\/+/, "");
        return path.startsWith("media/") ? path : "";
    } catch (_) {
        return "";
    }
}

function buildPlayerMediaPath(characterId, variant = "avatar") {
    const suffix = variant === "token" ? "-token" : "-avatar";
    const filename = `${slugify(characterId || "personaggio")}${suffix}.webp`;
    const campaignId = getCampaignId();
    return `media/campaigns/${campaignId}/players/${filename}`;
}

function buildReadableAssetSlug(...parts) {
    const seen = new Set();
    const slugs = parts
        .map((part) => slugify(part || ""))
        .filter(Boolean)
        .filter((slug) => {
            if (seen.has(slug)) return false;
            seen.add(slug);
            return true;
        });
    return slugs.join("-") || "asset";
}

function buildCompanionMediaEntityId(ownerCharacterId, actorId, actorName = "") {
    return buildReadableAssetSlug(ownerCharacterId || "personaggio", actorName || "companion", actorId || "");
}

function buildCompanionMediaPath(ownerCharacterId, actorId, variant = "avatar", actorName = "") {
    const entityId = buildCompanionMediaEntityId(ownerCharacterId, actorId, actorName);
    const suffix = variant === "token" ? "-token" : "-avatar";
    const folder = `campaigns/${getCampaignId()}/companions/${slugify(ownerCharacterId || "personaggio")}`;
    return `media/${folder}/${entityId}${suffix}.webp`;
}

function buildCampaignScopedOverrideFolder(kind, ownerId) {
    return `${kind}/${slugify(ownerId || "personaggio")}`;
}

function buildCampaignScopedMediaPath(folder, filename) {
    return `media/campaigns/${getCampaignId()}/${folder}/${filename}`;
}

function getCampaignScopedMediaFolderPrefix(folder) {
    const cleanFolder = String(folder || "").trim().replace(/^\/+|\/+$/g, "");
    return cleanFolder ? `media/campaigns/${getCampaignId()}/${cleanFolder}/` : "";
}

function isCurrentCampaignMediaPath(mediaPath) {
    const raw = String(mediaPath || "").trim().replace(/^\/+/, "");
    return raw.startsWith(`media/campaigns/${getCampaignId()}/`);
}

function isCurrentCampaignMediaPathInFolder(mediaPath, folder) {
    const raw = normalizeManagedRemotePath(mediaPath);
    const prefix = getCampaignScopedMediaFolderPrefix(folder);
    return Boolean(raw && prefix && raw.startsWith(prefix));
}

function runManagedMediaNetworkTask(task) {
    return new Promise((resolve, reject) => {
        managedMediaNetworkQueue.push({ task, resolve, reject });
        drainManagedMediaNetworkQueue();
    });
}

function drainManagedMediaNetworkQueue() {
    while (managedMediaNetworkActive < MANAGED_MEDIA_NETWORK_LIMIT && managedMediaNetworkQueue.length) {
        const job = managedMediaNetworkQueue.shift();
        managedMediaNetworkActive += 1;
        Promise.resolve()
            .then(job.task)
            .then(job.resolve, job.reject)
            .finally(() => {
                managedMediaNetworkActive -= 1;
                drainManagedMediaNetworkQueue();
            });
    }
}

function enqueueWorkerMediaPathCheck(mediaPath) {
    const raw = normalizeManagedRemotePath(mediaPath);
    if (!raw) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
        const entry = mediaCheckBatchQueue.get(raw) || { resolves: [], rejects: [] };
        entry.resolves.push(resolve);
        entry.rejects.push(reject);
        mediaCheckBatchQueue.set(raw, entry);

        if (!mediaCheckBatchTimer) {
            mediaCheckBatchTimer = window.setTimeout(flushWorkerMediaCheckBatch, MEDIA_CHECK_BATCH_DELAY_MS);
        }
    });
}

async function flushWorkerMediaCheckBatch() {
    mediaCheckBatchTimer = null;
    const batch = Array.from(mediaCheckBatchQueue.entries()).slice(0, MEDIA_CHECK_BATCH_LIMIT);
    batch.forEach(([raw]) => mediaCheckBatchQueue.delete(raw));
    if (mediaCheckBatchQueue.size && !mediaCheckBatchTimer) {
        mediaCheckBatchTimer = window.setTimeout(flushWorkerMediaCheckBatch, MEDIA_CHECK_BATCH_DELAY_MS);
    }
    if (!batch.length) return;

    try {
        const results = await checkWorkerMediaPathsBatch(batch.map(([raw]) => raw));
        batch.forEach(([raw, waiters]) => {
            const exists = Boolean(results.get(raw));
            mediaExistsCache.set(`${getCampaignId()}:${raw}`, { exists, checkedAt: Date.now() });
            waiters.resolves.forEach((resolve) => resolve(exists));
        });
    } catch (error) {
        mediaCheckBatchUnavailableUntil = Date.now() + MEDIA_CHECK_BATCH_BACKOFF_MS;
        console.warn(`${MODULE_ID} | Controllo media batch non disponibile, uso fallback singolo per ${batch.length} path.`, error);
        batch.forEach(([, waiters]) => {
            waiters.rejects.forEach((reject) => reject(error));
        });
    }
}

async function checkWorkerMediaPathsBatch(mediaPaths) {
    const paths = Array.from(new Set(mediaPaths.map(normalizeManagedRemotePath).filter(Boolean))).slice(0, MEDIA_CHECK_BATCH_LIMIT);
    if (!paths.length) return new Map();

    const data = await runManagedMediaNetworkTask(() => requestWorkerJson("api/media/check", {
        method: "POST",
        body: {
            paths,
            exact: true
        }
    }));
    const results = new Map();
    (Array.isArray(data?.results) ? data.results : []).forEach((entry) => {
        const exists = Boolean(entry?.exists);
        [
            entry?.path,
            entry?.input,
            entry?.key ? `media/${entry.key}` : ""
        ].map(normalizeManagedRemotePath).filter(Boolean).forEach((path) => {
            results.set(path, exists);
        });
    });
    paths.forEach((path) => {
        if (!results.has(path)) results.set(path, false);
    });
    return results;
}

async function workerMediaPathExistsLegacy(mediaPath) {
    const raw = normalizeManagedRemotePath(mediaPath);
    if (!raw) return false;
    return runManagedMediaNetworkTask(async () => {
        try {
            const url = new URL(`${DISCORD_WORKER_URL}/${raw}`);
            url.searchParams.set("campaign", getCampaignId());
            url.searchParams.set("exact", "1");
            const response = await policyFetch(url.toString(), { method: "GET", cache: "no-store" });
            const exists = response.ok;
            mediaExistsCache.set(`${getCampaignId()}:${raw}`, { exists, checkedAt: Date.now() });
            return exists;
        } catch (_) {
            mediaExistsCache.set(`${getCampaignId()}:${raw}`, { exists: false, checkedAt: Date.now() });
            return false;
        }
    });
}

async function workerMediaPathExists(mediaPath) {
    const raw = normalizeManagedRemotePath(mediaPath);
    if (!raw) return false;
    const cacheKey = `${getCampaignId()}:${raw}`;
    const cached = mediaExistsCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < MEDIA_EXISTS_CACHE_TTL) return cached.exists;
    if (mediaExistsPromises.has(cacheKey)) return mediaExistsPromises.get(cacheKey);

    const promise = (async () => {
        try {
            if (Date.now() >= mediaCheckBatchUnavailableUntil) {
                return await enqueueWorkerMediaPathCheck(raw);
            }
        } catch (_) {}
        return workerMediaPathExistsLegacy(raw);
    })().finally(() => {
        mediaExistsPromises.delete(cacheKey);
    });
    mediaExistsPromises.set(cacheKey, promise);
    return promise;
}

function markWorkerMediaPathExists(mediaPath, exists = true) {
    const raw = normalizeManagedRemotePath(mediaPath);
    if (!raw) return;
    mediaExistsCache.set(`${getCampaignId()}:${raw}`, { exists: Boolean(exists), checkedAt: Date.now() });
}

function markUploadedWorkerMediaPath(mediaPath) {
    markWorkerMediaPathExists(mediaPath, true);
}

function shouldDownloadManagedFallback(options = {}) {
    return options.downloadFallback === true;
}

function shouldVerifyManagedRemote(options = {}) {
    return options.verifyRemote !== false;
}

function shouldAssumeManagedRemote(options = {}) {
    return options.assumeRemoteAvailable === true || options.verifyRemote === false;
}

function resolveManagedRemoteWithoutCheck(remotePath, localPath = "") {
    const remote = normalizeManagedRemotePath(remotePath);
    if (remote) return resolveWikiAssetUrl(remote);
    return localPath || "";
}

function isManagedFallbackDownloadEnabled(options = {}) {
    return shouldDownloadManagedFallback(options);
}

function normalizeManagedMediaOptions(options = {}) {
    return {
        ...options,
        downloadFallback: isManagedFallbackDownloadEnabled(options),
        verifyRemote: shouldVerifyManagedRemote(options),
        assumeRemoteAvailable: shouldAssumeManagedRemote(options)
    };
}

async function markManagedMediaRemoteIfKnown(remotePath, options = {}) {
    const remote = normalizeManagedRemotePath(remotePath);
    if (!remote) return false;
    if (options.assumeRemoteAvailable) {
        markWorkerMediaPathExists(remote, true);
        return true;
    }
    return workerMediaPathExists(remote);
}

async function getReusableCampaignMediaPath(mediaPath) {
    const raw = normalizeManagedRemotePath(mediaPath);
    if (!isCurrentCampaignMediaPath(raw)) return "";
    return await workerMediaPathExists(raw) ? raw : "";
}

async function getReusableCampaignMediaPathInFolder(mediaPath, folder) {
    const raw = await getReusableCampaignMediaPath(mediaPath);
    return raw && isCurrentCampaignMediaPathInFolder(raw, folder) ? raw : "";
}

async function copyLegacyMediaPathToCampaign(legacyPath, folder, filename, { overwrite = false } = {}) {
    const raw = normalizeManagedRemotePath(legacyPath) || String(legacyPath || "").trim();
    const targetPath = buildCampaignScopedMediaPath(folder, filename);
    if (!raw || isCurrentCampaignMediaPathInFolder(raw, folder)) return "";

    const sourceUrl = raw.startsWith("media/")
        ? `${DISCORD_WORKER_URL.replace(/\/+$/, "")}/${raw}`
        : raw;
    if (!/^https?:/i.test(sourceUrl)) return "";
    if (!overwrite && await workerMediaPathExists(targetPath)) return targetPath;

    const response = await policyFetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) return "";
    const sourceBlob = await response.blob();
    if (!sourceBlob?.size) return "";
    const blob = sourceBlob.type === "image/webp"
        ? sourceBlob
        : new Blob([await sourceBlob.arrayBuffer()], { type: "image/webp" });
    return await uploadRawMediaBlobToWorker(blob, filename, folder);
}

async function uploadRawMediaBlobToWorker(blob, filename, folder) {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    if (!token && !(secret && folder === "items")) throw new Error("Login wiki o Secret sync richiesto.");

    const form = new FormData();
    form.set("folder", folder);
    form.set("filename", filename);
    form.set("campaignId", getCampaignId());
    form.set("file", new File([blob], filename, { type: "image/webp" }));

    const url = new URL(`${DISCORD_WORKER_URL}/media/upload`);
    url.searchParams.set("folder", folder);
    url.searchParams.set("campaign", getCampaignId());

    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(secret && folder === "items" ? { "X-Cripta-Inventory-Secret": secret } : {})
        },
        body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    validateWorkerMediaUploadPayload(payload, blob, filename);
    const uploadedPath = payload.path || payload.key || buildCampaignScopedMediaPath(folder, filename);
    markUploadedWorkerMediaPath(uploadedPath);
    return uploadedPath;
}

async function uploadCampaignCatalogItemImage(source, itemId) {
    const id = slugify(itemId || "oggetto") || "oggetto";
    const existing = extractWorkerMediaPath(source);
    const expectedSuffix = `/items/${id}.webp`;
    if (existing && existing.endsWith(expectedSuffix)) return existing;
    const effectiveSource = existing ? `${DISCORD_WORKER_URL}/${existing}` : String(source || "");
    const blob = await imagePathToSquareWebpBlob(effectiveSource, 512);
    return uploadRawMediaBlobToWorker(blob, `${id}.webp`, "items");
}
async function imagePathToSquareWebpBlob(imagePath, size) {
    const source = String(imagePath || "").trim();
    if (!source) throw new Error("Immagine mancante.");
    const image = await new Promise((resolve, reject) => {
        const element = new Image();
        if (/^https?:/i.test(source)) element.crossOrigin = "anonymous";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`Immagine non leggibile: ${source}`));
        element.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { alpha: true });
    context.clearRect(0, 0, size, size);

    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    if (!imageWidth || !imageHeight) throw new Error(`Dimensioni immagine non valide: ${source}`);
    const scale = Math.max(size / imageWidth, size / imageHeight);
    const drawWidth = imageWidth * scale;
    const drawHeight = imageHeight * scale;
    const x = (size - drawWidth) / 2;
    const y = (size - drawHeight) / 2;
    context.drawImage(image, x, y, drawWidth, drawHeight);

    return new Promise((resolve, reject) => {
        canvas.toBlob((webpBlob) => {
            if (!webpBlob) {
                reject(new Error("Conversione WebP fallita."));
                return;
            }
            resolve(webpBlob);
        }, "image/webp", 0.86);
    });
}

async function imagePathToWebpBlobPreserveSize(imagePath, quality = 0.96) {
    const source = String(imagePath || "").trim();
    if (!source) throw new Error("Immagine mancante.");
    const image = await new Promise((resolve, reject) => {
        const element = new Image();
        if (/^https?:/i.test(source)) element.crossOrigin = "anonymous";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`Immagine non leggibile: ${source}`));
        element.src = source;
    });

    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    if (!imageWidth || !imageHeight) throw new Error(`Dimensioni immagine non valide: ${source}`);

    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const context = canvas.getContext("2d", { alpha: true });
    context.clearRect(0, 0, imageWidth, imageHeight);
    context.drawImage(image, 0, 0, imageWidth, imageHeight);

    return new Promise((resolve, reject) => {
        canvas.toBlob((webpBlob) => {
            if (!webpBlob) {
                reject(new Error("Conversione WebP fallita."));
                return;
            }
            resolve(webpBlob);
        }, "image/webp", quality);
    });
}

async function imagePathToWebpIconBlob(imagePath) {
    return imagePathToSquareWebpBlob(imagePath, ABILITY_ICON_SYNC_SIZE);
}

async function uploadAbilityIconBlobToWorker(blob, actor, item, characterFolder) {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (!token) throw new Error("Login wiki richiesto.");

    const folder = buildCampaignScopedOverrideFolder("ability-overrides", characterFolder || actor?.name || actor?.id);
    const filename = `${slugify(item?.name || item?.id || "abilita")}.webp`;
    const form = new FormData();
    form.set("folder", folder);
    form.set("filename", filename);
    form.set("campaignId", getCampaignId());
    form.set("file", new File([blob], filename, { type: "image/webp" }));

    const url = new URL(`${DISCORD_WORKER_URL}/media/upload`);
    url.searchParams.set("folder", folder);
    url.searchParams.set("campaign", getCampaignId());

    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    validateWorkerMediaUploadPayload(payload, blob, filename);
    const uploadedPath = payload.path || payload.key || buildCampaignScopedMediaPath(folder, filename);
    markUploadedWorkerMediaPath(uploadedPath);
    return uploadedPath;
}

async function uploadItemIconBlobToWorker(blob, actor, item, characterFolder) {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (!token) throw new Error("Login wiki richiesto.");

    const folder = buildCampaignScopedOverrideFolder("item-overrides", characterFolder || actor?.name || actor?.id);
    const filename = `${slugify(item?.name || item?.id || "oggetto")}.webp`;
    const form = new FormData();
    form.set("folder", folder);
    form.set("filename", filename);
    form.set("campaignId", getCampaignId());
    form.set("file", new File([blob], filename, { type: "image/webp" }));

    const url = new URL(`${DISCORD_WORKER_URL}/media/upload`);
    url.searchParams.set("folder", folder);
    url.searchParams.set("campaign", getCampaignId());

    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    validateWorkerMediaUploadPayload(payload, blob, filename);
    const uploadedPath = payload.path || payload.key || buildCampaignScopedMediaPath(folder, filename);
    markUploadedWorkerMediaPath(uploadedPath);
    return uploadedPath;
}

async function uploadPlayerImageBlobToWorker(blob, filename, folder = "players") {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    if (!token) throw new Error("Login wiki richiesto.");

    const form = new FormData();
    form.set("folder", folder);
    form.set("filename", filename);
    form.set("campaignId", getCampaignId());
    form.set("file", new File([blob], filename, { type: "image/webp" }));

    const url = new URL(`${DISCORD_WORKER_URL}/media/upload`);
    url.searchParams.set("folder", folder);
    url.searchParams.set("campaign", getCampaignId());

    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    validateWorkerMediaUploadPayload(payload, blob, filename);
    const uploadedPath = payload.path || payload.key || `media/${folder}/${filename}`;
    markUploadedWorkerMediaPath(uploadedPath);
    return uploadedPath;
}

function validateWorkerMediaUploadPayload(payload, blob, filename = "media.webp") {
    const expectedSize = Number(blob?.size || 0);
    const storedSize = Number(payload?.storedSize || payload?.size || 0);
    if (expectedSize > 0 && storedSize > 0 && expectedSize !== storedSize) {
        throw new Error(`Upload R2 non coerente per ${filename}: inviati ${expectedSize} byte, salvati ${storedSize} byte.`);
    }
    if (!payload?.key && !payload?.path) {
        throw new Error(`Upload R2 senza path/key per ${filename}.`);
    }
}

function normalizeManagedRemotePath(value) {
    const remote = extractWorkerMediaPath(value) || String(value || "").trim().split(/[?#]/)[0].replace(/^\/+/, "");
    if (!remote) return "";
    if (remote.startsWith("media/")) return remote;
    if (remote.startsWith("campaigns/")) return `media/${remote}`;
    return "";
}

function buildLocalMediaPathForRemote(remotePath) {
    const remote = normalizeManagedRemotePath(remotePath);
    if (!remote) return "";
    const relative = remote.replace(/^media\//, "");
    const worldId = slugify(game.world?.id || game.world?.title || "world");
    return `worlds/${worldId}/${LOCAL_MEDIA_ROOT}/${relative}`;
}

function normalizeFoundryLocalMediaPath(value) {
    const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!raw || /^https?:|^data:|^blob:/i.test(raw) || normalizeManagedRemotePath(raw)) return "";
    return raw;
}

function getDirectoryPath(filePath) {
    const clean = String(filePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const index = clean.lastIndexOf("/");
    return index > 0 ? clean.slice(0, index) : "";
}

function getFilename(filePath) {
    return String(filePath || "").replace(/\\/g, "/").split("/").pop() || "media.webp";
}

async function browseFoundryDataDirectory(directory) {
    const clean = String(directory || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return null;
    const cached = localDirectoryCache.get(clean);
    if (cached && Date.now() - cached.checkedAt < LOCAL_FILE_EXISTS_CACHE_TTL) return cached.files;
    try {
        const result = await FilePicker.browse("data", clean);
        const files = new Set((result?.files || []).map((file) => String(file || "").replace(/\\/g, "/")));
        localDirectoryCache.set(clean, { files, checkedAt: Date.now() });
        return files;
    } catch (_) {
        localDirectoryCache.set(clean, { files: new Set(), checkedAt: Date.now() });
        return null;
    }
}

async function foundryDataFileExists(filePath) {
    const clean = String(filePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || /^https?:|^data:|^blob:/i.test(clean)) return false;
    const cached = localFileExistsCache.get(clean);
    if (cached && Date.now() - cached.checkedAt < LOCAL_FILE_EXISTS_CACHE_TTL) return cached.exists;
    const directory = getDirectoryPath(clean);
    const filename = getFilename(clean);
    if (!directory || !filename) return false;
    const files = await browseFoundryDataDirectory(directory);
    if (files) {
        const exists = files.has(clean);
        localFileExistsCache.set(clean, { exists, checkedAt: Date.now() });
        return exists;
    }
    localFileExistsCache.set(clean, { exists: false, checkedAt: Date.now() });
    return false;
}

function markFoundryDataFileExists(filePath, exists = true) {
    const clean = String(filePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) return;
    localFileExistsCache.set(clean, { exists: Boolean(exists), checkedAt: Date.now() });
    const directory = getDirectoryPath(clean);
    const cachedDirectory = localDirectoryCache.get(directory);
    if (cachedDirectory) {
        if (exists) cachedDirectory.files.add(clean);
        else cachedDirectory.files.delete(clean);
        cachedDirectory.checkedAt = Date.now();
    }
}

async function ensureFoundryDataDirectory(directory) {
    const clean = String(directory || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    const parts = clean.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (ensuredFoundryDirectories.has(current)) continue;
        try {
            await FilePicker.createDirectory("data", current, {});
        } catch (_) {
            // Directory gia esistente o non creabile: il browse/upload seguente gestisce l'errore reale.
        }
        ensuredFoundryDirectories.add(current);
    }
}

async function downloadRemoteMediaToLocal(remotePath, localPath = buildLocalMediaPathForRemote(remotePath), options = {}) {
    const remote = normalizeManagedRemotePath(remotePath);
    const local = String(localPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!remote || !local) return "";
    if (!options.skipLocalCheck && await foundryDataFileExists(local)) return local;

    const blob = await runManagedMediaNetworkTask(async () => {
        const url = new URL(`${DISCORD_WORKER_URL.replace(/\/+$/, "")}/${remote}`);
        url.searchParams.set("campaign", getCampaignId());
        url.searchParams.set("exact", "1");
        const response = await policyFetch(url.toString(), { cache: "no-store" });
        markWorkerMediaPathExists(remote, response.ok);
        if (!response.ok) return null;
        return response.blob();
    });
    if (!blob?.size) return "";

    const directory = getDirectoryPath(local);
    const filename = getFilename(local);
    await ensureFoundryDataDirectory(directory);
    const type = blob.type || (filename.toLowerCase().endsWith(".webp") ? "image/webp" : "application/octet-stream");
    const file = new File([blob], filename, { type });
    const result = await FilePicker.upload("data", directory, file, {}, { notify: false });
    const uploadedLocalPath = String(result?.path || local).replace(/\\/g, "/");
    markFoundryDataFileExists(uploadedLocalPath, true);
    return uploadedLocalPath;
}

async function getManagedMediaEffectivePath(remotePath, localPath, options = {}) {
    const remote = normalizeManagedRemotePath(remotePath);
    if (remote && shouldAssumeManagedRemote(options)) return resolveWikiAssetUrl(remote);
    if (remote && await workerMediaPathExists(remote)) return resolveWikiAssetUrl(remote);
    if (localPath && await foundryDataFileExists(localPath)) return localPath;
    return "";
}

function getManagedMediaState(document, slot) {
    const media = document?.getFlag?.(MODULE_ID, MANAGED_MEDIA_FLAG) || {};
    return media?.[slot] || {};
}

async function setManagedMediaState(document, slot, patch) {
    if (!document?.setFlag || !slot) return null;
    const media = foundry.utils.deepClone(document.getFlag(MODULE_ID, MANAGED_MEDIA_FLAG) || {});
    const previous = media[slot] || {};
    const next = {
        ...previous,
        ...patch,
    };
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
    media[slot] = {
        ...next,
        updatedAt: new Date().toISOString()
    };
    await document.update({
        [`flags.${MODULE_ID}.${MANAGED_MEDIA_FLAG}`]: media
    }, {
        criptaWikiSyncCommand: true,
        criptaManagedMediaMaintenance: true,
        render: false
    });
    return media[slot];
}

async function registerManagedMedia(document, slot, {
    remote,
    local = "",
    entityType = "",
    entityId = "",
    actor = null,
    item = null,
    name = "",
    downloadFallback = false,
    activateRemote = true
} = {}) {
    const remotePath = normalizeManagedRemotePath(remote);
    const previous = getManagedMediaState(document, slot);
    const localCandidates = [
        normalizeFoundryLocalMediaPath(local),
        normalizeFoundryLocalMediaPath(previous.local)
    ].filter(Boolean);
    let existingLocal = "";
    for (const candidate of localCandidates) {
        if (await foundryDataFileExists(candidate)) {
            existingLocal = candidate;
            break;
        }
    }
    const preferredLocal = existingLocal || buildLocalMediaPathForRemote(remotePath);
    let localPath = preferredLocal;
    if (remotePath && !existingLocal && downloadFallback) {
        localPath = await downloadRemoteMediaToLocal(remotePath, preferredLocal) || localPath;
    }
    const state = await setManagedMediaState(document, slot, {
        local: localPath || "",
        remote: remotePath || "",
        entityType,
        entityId: String(entityId || "").trim(),
        foundryActorId: actor?.id || item?.actor?.id || "",
        foundryItemId: item?.id || "",
        foundryUuid: item?.uuid || actor?.uuid || document?.uuid || "",
        name: name || item?.name || actor?.name || document?.name || "",
        aliases: Array.from(new Set([previous.name, previous.entityId].filter(Boolean)))
    });
    if (activateRemote && remotePath) await applyManagedRemotePathToDocument(document, slot, remotePath, localPath);
    return state;
}

async function resolveAndRegisterManagedMedia(document, slot, options = {}) {
    const normalizedOptions = normalizeManagedMediaOptions(options);
    if (!normalizeManagedRemotePath(options.remote)) {
        return resolveWikiAssetUrl(options.remote) || options.remote || options.local || "";
    }
    const state = await registerManagedMedia(document, slot, {
        ...normalizedOptions,
        activateRemote: false
    });
    return getManagedMediaEffectivePath(state?.remote, state?.local, normalizedOptions);
}

function getManagedMediaSlotLabel(slot) {
    const value = String(slot || "");
    if (value === "avatar") return "Avatar";
    if (value === "token") return "Token";
    if (value === "image" || value === "icon") return "Immagine";
    if (value.startsWith("transformation:")) return `Trasformazione ${value.slice("transformation:".length)}`;
    return value || "Media";
}

function getDocumentActiveMediaPath(document, slot) {
    const value = String(slot || "");
    if (document?.documentName === "Actor") {
        if (value === "avatar") return String(document.img || "");
        if (value === "token") return String(document.prototypeToken?.texture?.src || document.prototypeToken?.img || "");
    }
    if (document?.documentName === "Item" && (value === "image" || value === "icon")) {
        return String(document.img || "");
    }
    return "";
}

function getManagedMediaEntriesForDialog(document) {
    const media = document?.getFlag?.(MODULE_ID, MANAGED_MEDIA_FLAG) || {};
    return Object.entries(media)
        .filter(([, value]) => value && typeof value === "object" && (value.remote || value.local))
        .map(([slot, value]) => ({
            slot,
            label: getManagedMediaSlotLabel(slot),
            active: getDocumentActiveMediaPath(document, slot),
            remote: String(value.remote || ""),
            local: String(value.local || ""),
            entityType: String(value.entityType || ""),
            entityId: String(value.entityId || ""),
            updatedAt: String(value.updatedAt || "")
        }))
        .sort((left, right) => left.label.localeCompare(right.label, "it"));
}

function renderManagedMediaPathLine(label, value, { primary = false } = {}) {
    const path = String(value || "").trim();
    return `
        <div class="cripta-media-path-line${primary ? " is-primary" : ""}">
            <span>${escapeHtml(label)}</span>
            <code title="${escapeHtml(path)}">${path ? escapeHtml(path) : "-"}</code>
            ${path ? `<button type="button" data-copy-managed-media-path="${escapeHtml(path)}" title="Copia path"><i class="fas fa-copy"></i></button>` : ""}
        </div>
    `;
}

function renderManagedMediaPathsDialogContent(document, entries) {
    const rows = entries.map((entry) => `
        <section class="cripta-media-path-entry">
            <header>
                <strong>${escapeHtml(entry.label)}</strong>
                <small>${escapeHtml([entry.entityType, entry.entityId].filter(Boolean).join(" / "))}</small>
            </header>
            ${renderManagedMediaPathLine("DB/R2 canonico", entry.remote, { primary: true })}
            ${renderManagedMediaPathLine("Locale fallback", entry.local)}
            ${renderManagedMediaPathLine("Attivo in Foundry", entry.active)}
        </section>
    `).join("");

    return `
        <div class="cripta-media-paths-dialog">
            <p>I path DB/R2 sono quelli canonici della wiki; il locale e il path attivo servono come contesto e fallback.</p>
            ${entries.length ? '<button type="button" class="cripta-media-paths-use-r2" data-use-managed-media-r2><i class="fas fa-cloud"></i> Usa path R2 su questo elemento</button>' : ""}
            <div class="cripta-media-paths-list">
                ${rows || "<p>Nessun path media gestito su questo elemento.</p>"}
            </div>
        </div>
    `;
}

function openManagedMediaPathsDialog(document) {
    const entries = getManagedMediaEntriesForDialog(document);
    let dialog;
    dialog = renderDialog({
        title: `Path R2 - ${document?.name || "Elemento"}`,
        content: renderManagedMediaPathsDialogContent(document, entries),
        buttons: {
            close: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Chiudi"
            }
        },
        render: (html) => {
            const root = html instanceof HTMLElement ? html : html?.[0];
            root?.querySelectorAll?.("[data-copy-managed-media-path]").forEach((button) => {
                button.addEventListener("click", async () => {
                    const value = button.dataset.copyManagedMediaPath || "";
                    try {
                        await navigator.clipboard?.writeText(value);
                        ui.notifications.info("Path copiato.");
                    } catch (_) {
                        ui.notifications.warn(value);
                    }
                });
            });
            root?.querySelector?.("[data-use-managed-media-r2]")?.addEventListener("click", async () => {
                suppressCharacterSync = true;
                try {
                    const updated = await applyManagedRemotePathsForDocument(document);
                    ui.notifications.info(`Path R2 applicati: ${updated}.`);
                } finally {
                    suppressCharacterSync = false;
                }
                dialog.close();
                window.setTimeout(() => openManagedMediaPathsDialog(document), 100);
            });
        }
    }, {
        width: 720,
        classes: ["cripta-media-paths-window"]
    });
}

function addManagedMediaHeaderButton(document, buttons) {
    if (!document || !buttons) return;
    if (!getManagedMediaEntriesForDialog(document).length) return;
    buttons.unshift({
        label: "Path R2",
        class: "cripta-managed-media-paths",
        icon: "fas fa-images",
        onclick: () => openManagedMediaPathsDialog(document)
    });
}

function addPlayerSkillTreeHeaderButton(actor, buttons) {
    if (!actor || !buttons) return;
    const entries = getPlayerSkillTreeEntriesForActor(actor);
    if (!entries.length) return;
    buttons.unshift({
        label: entries.length > 1 ? "Alberi" : "Albero",
        class: "cripta-open-skill-tree",
        icon: "fas fa-crown",
        onclick: () => openPlayerSkillTreeForActor(actor).catch((error) => {
            ui.notifications.warn(error?.message || String(error || "Albero abilita non disponibile."));
        })
    });
}

function getItemLoadoutRole(item) {
    const value = String(item?.getFlag?.(MODULE_ID, ITEM_LOADOUT_ROLE_FLAG) || item?.flags?.[MODULE_ID]?.[ITEM_LOADOUT_ROLE_FLAG] || "").trim().toLowerCase();
    return ITEM_LOADOUT_ROLE_OPTIONS.has(value) ? value : "";
}

function getItemLoadoutSubtype(item) {
    const value = String(item?.getFlag?.(MODULE_ID, ITEM_LOADOUT_SUBTYPE_FLAG) || item?.flags?.[MODULE_ID]?.[ITEM_LOADOUT_SUBTYPE_FLAG] || "").trim().toLowerCase();
    return ITEM_LOADOUT_SUBTYPE_OPTIONS.has(value) ? value : "";
}

function renderItemLoadoutRoleDialogContent(item) {
    const role = getItemLoadoutRole(item);
    const subtype = getItemLoadoutSubtype(item);
    const selected = subtype === "attack" ? "attack" : role;
    const option = (value, label) => `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
    return `
        <form class="cripta-item-loadout-dialog">
            <label>
                <span>Sezione sito</span>
                <select name="role">
                    ${option("", "Automatico Foundry")}
                    ${option("inventory", "Inventario")}
                    ${option("ability", "Abilita")}
                    ${option("attack", "Attacco")}
                </select>
            </label>
            <p class="notes">Usa Attacco per oggetti Foundry come Unarmed Attack che devono comparire tra le abilita del personaggio.</p>
        </form>
    `;
}

function collectItemLoadoutRoleDialogDraft(html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const value = String(root?.querySelector?.('[name="role"]')?.value || "").trim();
    if (value === "attack") return { role: "ability", subtype: "attack" };
    if (value === "ability") return { role: "ability", subtype: "" };
    if (value === "inventory") return { role: "inventory", subtype: "" };
    return { role: "", subtype: "" };
}

async function saveItemLoadoutRoleFlags(item, draft) {
    if (!item) return;
    const role = String(draft?.role || "").trim();
    const subtype = String(draft?.subtype || "").trim();
    if (role) await item.setFlag(MODULE_ID, ITEM_LOADOUT_ROLE_FLAG, role);
    else await item.unsetFlag(MODULE_ID, ITEM_LOADOUT_ROLE_FLAG);
    if (subtype) await item.setFlag(MODULE_ID, ITEM_LOADOUT_SUBTYPE_FLAG, subtype);
    else await item.unsetFlag(MODULE_ID, ITEM_LOADOUT_SUBTYPE_FLAG);
    if (isConfiguredPlayerActor(item.actor) || isConfiguredCompanionActor(item.actor)) scheduleCharacterSync("itemLoadoutRole");
}

function openItemLoadoutRoleDialog(item) {
    if (!game.user?.isGM || !item) return;
    renderDialog({
        title: `Sezione sito - ${item.name || "Oggetto"}`,
        content: renderItemLoadoutRoleDialogContent(item),
        buttons: {
            save: {
                label: "Salva",
                callback: async (html) => {
                    await saveItemLoadoutRoleFlags(item, collectItemLoadoutRoleDialogDraft(html));
                    ui.notifications.info("Sezione sito dell'item aggiornata.");
                    return true;
                }
            },
            clear: {
                label: "Automatico",
                callback: async () => {
                    await saveItemLoadoutRoleFlags(item, { role: "", subtype: "" });
                    ui.notifications.info("Sezione sito dell'item ripristinata su automatico.");
                }
            },
            cancel: {
                label: "Annulla"
            }
        },
        default: "save"
    }, {
        width: 420
    });
}

function addItemLoadoutRoleHeaderButton(item, buttons) {
    if (!game.user?.isGM || !item?.actor || !buttons) return;
    const role = getItemLoadoutRole(item);
    const subtype = getItemLoadoutSubtype(item);
    const label = subtype === "attack" ? "Sito: Attacco" : role === "ability" ? "Sito: Abilita" : role === "inventory" ? "Sito: Inventario" : "Sito";
    buttons.unshift({
        label,
        class: "cripta-item-loadout-role",
        icon: subtype === "attack" ? "fas fa-hand-fist" : role === "ability" ? "fas fa-bolt" : "fas fa-layer-group",
        onclick: () => openItemLoadoutRoleDialog(item)
    });
}

function normalizeWikiDataList(payload) {
    return Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
            ? payload
            : [];
}

async function loadManagedMediaBootstrapCollection(collection) {
    try {
        const payload = await requestNotesApi(`api/data/${collection}`);
        return { collection, data: normalizeWikiDataList(payload), source: "kv" };
    } catch (_) {
        // Il bootstrap puo lavorare anche senza KV se esiste il JSON statico.
    }

    try {
        const response = await policyFetch(getSiteDataUrl(`${collection}.json`), {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-cache"
        });
        if (!response.ok) return { collection, data: [], source: "missing" };
        return { collection, data: normalizeWikiDataList(await response.json()), source: "static" };
    } catch (_) {
        return { collection, data: [], source: "missing" };
    }
}

function isDownloadableManagedMediaPath(path) {
    const remote = normalizeManagedRemotePath(path);
    return Boolean(remote && /\.(webp|png|jpe?g|gif)(?:[?#]|$)/i.test(remote));
}

function addManagedMediaPath(paths, value, source = "") {
    const remote = normalizeManagedRemotePath(value);
    if (!isDownloadableManagedMediaPath(remote)) return;
    if (!paths.has(remote)) paths.set(remote, { remote, sources: new Set() });
    if (source) paths.get(remote).sources.add(source);
}

function collectManagedMediaPathsFromString(paths, value, source = "") {
    const raw = String(value || "").trim();
    if (!raw) return;
    addManagedMediaPath(paths, raw, source);
    const mediaMatches = raw.match(/\b(?:media|campaigns)\/[^\s"'<>)]*/gi) || [];
    mediaMatches.forEach((match) => addManagedMediaPath(paths, match.replace(/[.,;:]+$/g, ""), source));
    const urlMatches = raw.match(/https?:\/\/[^\s"'<>)]*\/media\/[^\s"'<>)]*/gi) || [];
    urlMatches.forEach((match) => addManagedMediaPath(paths, match.replace(/[.,;:]+$/g, ""), source));
}

function collectManagedMediaPathsFromValue(paths, value, source = "") {
    if (!value) return;
    if (typeof value === "string") {
        collectManagedMediaPathsFromString(paths, value, source);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectManagedMediaPathsFromValue(paths, entry, `${source}[${index}]`));
        return;
    }
    if (typeof value === "object") {
        Object.entries(value).forEach(([key, entry]) => collectManagedMediaPathsFromValue(paths, entry, source ? `${source}.${key}` : key));
    }
}

function addExpectedConfiguredActorMediaPaths(paths) {
    getPlayerActorsForWikiSync().forEach((actor) => {
        const characterId = getConfiguredCharacterIdForActor(actor);
        if (!characterId) return;
        addManagedMediaPath(paths, buildPlayerMediaPath(characterId, "avatar"), `${actor.name}.avatar`);
        addManagedMediaPath(paths, buildPlayerMediaPath(characterId, "token"), `${actor.name}.token`);
    });

    parseCompanionMappings().forEach((mapping) => {
        const actor = getConfiguredActor(mapping.actorId || mapping.actorName);
        const ownerCharacterId = slugify(mapping.ownerCharacterId || "");
        if (!actor || !ownerCharacterId) return;
        addManagedMediaPath(paths, buildCompanionMediaPath(ownerCharacterId, actor.id, "avatar", actor.name), `${actor.name}.avatar`);
        addManagedMediaPath(paths, buildCompanionMediaPath(ownerCharacterId, actor.id, "token", actor.name), `${actor.name}.token`);
    });
}

async function collectManagedMediaBootstrapPaths() {
    const collections = [
        "players",
        "media-overrides",
        "ability-overrides",
        "item-overrides",
        "characters",
        "transformations"
    ];
    const paths = new Map();
    const loadedCollections = await Promise.all(collections.map((collection) => loadManagedMediaBootstrapCollection(collection)));
    loadedCollections.forEach((loaded) => collectManagedMediaPathsFromValue(paths, loaded.data, loaded.collection));

    game.actors.forEach((actor) => {
        collectManagedMediaPathsFromValue(paths, actor.getFlag?.(MODULE_ID, MANAGED_MEDIA_FLAG), `actor:${actor.name}`);
        collectManagedMediaPathsFromString(paths, actor.img, `actor:${actor.name}.img`);
        collectManagedMediaPathsFromString(paths, actor.prototypeToken?.texture?.src, `actor:${actor.name}.token`);
        actor.items?.forEach?.((item) => {
            collectManagedMediaPathsFromValue(paths, item.getFlag?.(MODULE_ID, MANAGED_MEDIA_FLAG), `item:${actor.name}.${item.name}`);
            collectManagedMediaPathsFromString(paths, item.img, `item:${actor.name}.${item.name}.img`);
        });
    });
    addExpectedConfiguredActorMediaPaths(paths);

    return { paths, loadedCollections };
}

async function runLimitedTasks(entries, limit, worker) {
    const results = new Array(entries.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), entries.length) }, async () => {
        while (nextIndex < entries.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(entries[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function getBootstrapCollectionData(loadedCollections, collection) {
    return loadedCollections.find((entry) => entry.collection === collection)?.data || [];
}

function findActorForWikiMediaRecord(record, { npcFlag = "" } = {}) {
    const foundry = record?.foundry || {};
    const actorId = normalizeActorRef(foundry.actorId || record?.actorId || record?.foundryActorId || "");
    const actorUuid = String(foundry.actorUuid || record?.actorUuid || record?.foundryActorUuid || "").trim();
    if (actorId && game.actors.get(actorId)) return game.actors.get(actorId);
    if (actorUuid) {
        const byUuid = game.actors.find((actor) => actor.uuid === actorUuid);
        if (byUuid) return byUuid;
    }
    const recordId = String(record?.id || record?.entityId || "").trim();
    if (npcFlag && recordId) {
        const byFlag = game.actors.find((actor) => String(actor.getFlag?.(MODULE_ID, npcFlag) || "") === recordId);
        if (byFlag) return byFlag;
    }
    const names = [
        record?.name,
        record?.foundryName,
        ...(Array.isArray(record?.foundryName) ? record.foundryName : []),
        ...(Array.isArray(record?.aliases) ? record.aliases : [])
    ].map(normalizeWikiItemKey).filter(Boolean);
    return game.actors.find((actor) => names.includes(normalizeWikiItemKey(actor.name))) || null;
}

function findPlayerActorForBootstrap(record) {
    const entityId = normalizeWikiItemKey(record?.id || record?.entityId || record?.characterId || "");
    if (!entityId) return null;
    const mapping = parsePlayerActorMappings().find((entry) => normalizeWikiItemKey(entry.ownerCharacterId) === entityId);
    const mapped = getConfiguredActor(mapping?.actorRef);
    if (mapped) return mapped;
    return getPlayerActorsForWikiSync().find((actor) => normalizeWikiItemKey(getConfiguredCharacterIdForActor(actor)) === entityId) || null;
}

function documentUsesManagedActorFlow(document) {
    const actor = document?.documentName === "Actor" ? document : document?.actor;
    if (!actor?.id) return false;
    try {
        const state = game.settings.get(MODULE_ID, "managedActorSyncState");
        return Boolean(Number(state?.[actor.id]?.revision || 0) > 0);
    } catch (_error) {
        return false;
    }
}

async function applyManagedRemotePathToDocument(document, slot, remote, local) {
    // The new Managed Actor flow is canonical for the Actor and every embedded
    // Item. Legacy managedMedia flags must never overwrite its current media.
    if (documentUsesManagedActorFlow(document)) return false;
    const remotePath = normalizeManagedRemotePath(remote);
    if (!document || !remotePath) return false;
    const activeRemotePath = resolveWikiAssetUrl(remotePath);

    if (slot === "avatar" && document.documentName === "Actor") {
        const current = String(document.img || "");
        if (current === activeRemotePath) return false;
        await document.update({ img: activeRemotePath }, { criptaWikiSyncCommand: true, criptaManagedMediaMaintenance: true });
        return true;
    }

    if (slot === "token" && document.documentName === "Actor") {
        const current = document.prototypeToken?.texture?.src || document.prototypeToken?.img || "";
        if (current === activeRemotePath) return false;
        await document.update({ "prototypeToken.texture.src": activeRemotePath }, { criptaWikiSyncCommand: true, criptaManagedMediaMaintenance: true });
        return true;
    }

    if ((slot === "image" || slot === "icon") && document.documentName === "Item") {
        const current = String(document.img || "");
        if (current === activeRemotePath) return false;
        await document.update({ img: activeRemotePath }, { criptaWikiSyncCommand: true, criptaManagedMediaMaintenance: true });
        return true;
    }

    return false;
}

async function applyManagedRemotePathsForDocument(document) {
    let updated = 0;
    for (const entry of getManagedMediaEntriesForDialog(document)) {
        if (await applyManagedRemotePathToDocument(document, entry.slot, entry.remote, entry.local)) updated += 1;
    }
    return updated;
}

async function applyManagedRemotePathsFromExistingFlags() {
    let updated = 0;
    for (const actor of game.actors || []) {
        updated += await applyManagedRemotePathsForDocument(actor);
        for (const item of actor.items || []) {
            updated += await applyManagedRemotePathsForDocument(item);
        }
    }
    return updated;
}

async function ensureManagedRemotePathsActive({ notify = false } = {}) {
    suppressCharacterSync = true;
    try {
        const updated = await applyManagedRemotePathsFromExistingFlags();
        if (notify) ui.notifications.info(`Path R2 attivati: ${updated}.`);
        if (updated) console.info(`${MODULE_ID} | Path R2 attivati dai flag managedMedia.`, { updated });
        return updated;
    } finally {
        suppressCharacterSync = false;
    }
}

async function registerManagedMediaBootstrapFlags(loadedCollections, localByRemote) {
    let registered = 0;
    let remoteActivated = 0;
    const registerIfPossible = async (document, slot, options) => {
        const remote = normalizeManagedRemotePath(options.remote);
        if (!document || !remote) return;
        const local = localByRemote.get(remote) || options.local || "";
        await registerManagedMedia(document, slot, {
            ...options,
            remote,
            local,
            downloadFallback: false,
            activateRemote: false
        });
        registered += 1;
        if (await applyManagedRemotePathToDocument(document, slot, remote, local)) remoteActivated += 1;
    };

    for (const record of getBootstrapCollectionData(loadedCollections, "players")) {
        const actor = findPlayerActorForBootstrap(record);
        if (!actor) continue;
        const images = record.images || record;
        await registerIfPossible(actor, "avatar", { remote: images.avatar || images.portrait, entityType: "player", entityId: record.id, actor, name: record.name });
        await registerIfPossible(actor, "token", { remote: images.token, entityType: "player", entityId: record.id, actor, name: record.name });
    }

    for (const record of getBootstrapCollectionData(loadedCollections, "media-overrides")) {
        const actor = record.entityType === "companion"
            ? resolveCompanionActorForMediaOverride(record)
            : await resolvePlayerActorForMediaOverride(record);
        if (!actor) continue;
        await registerIfPossible(actor, "avatar", { remote: record.images?.avatar || record.images?.portrait, entityType: record.entityType || "player", entityId: record.entityId || record.id, actor, name: record.name });
        await registerIfPossible(actor, "token", { remote: record.images?.token, entityType: record.entityType || "player", entityId: record.entityId || record.id, actor, name: record.name });
    }

    for (const record of getBootstrapCollectionData(loadedCollections, "ability-overrides")) {
        const actor = resolveActorFromAssetRecord(record);
        const item = actor ? resolveItemFromAssetRecord(actor, record) : null;
        await registerIfPossible(item, "image", { remote: record.image, entityType: "ability", entityId: record.key || record.id, actor, item, name: record.abilityName || record.itemName });
    }

    for (const record of getBootstrapCollectionData(loadedCollections, "item-overrides")) {
        const actor = resolveActorFromAssetRecord(record);
        const item = actor ? resolveItemFromAssetRecord(actor, record) : null;
        await registerIfPossible(item, "image", { remote: record.image, entityType: "item", entityId: record.key || record.id, actor, item, name: record.itemName });
    }

    for (const record of getBootstrapCollectionData(loadedCollections, "characters")) {
        const actor = findActorForWikiMediaRecord(record, { npcFlag: "wikiNpcId" });
        if (!actor) continue;
        await registerIfPossible(actor, "avatar", { remote: record.images?.avatar || record.images?.portrait, entityType: "npc", entityId: record.id, actor, name: record.name });
        await registerIfPossible(actor, "token", { remote: record.images?.token, entityType: "npc", entityId: record.id, actor, name: record.name });
    }


    for (const record of getBootstrapCollectionData(loadedCollections, "transformations")) {
        const actor = findActorForTransformation(normalizeTransformationOverrides([record])[0] || record);
        if (!actor) continue;
        await registerIfPossible(actor, `transformation:${record.id}`, { remote: record.tokenImage, entityType: "transformation", entityId: record.id, actor, name: record.name || record.creatureName });
    }

    return { registered, remoteActivated };
}

async function bootstrapManagedMediaFallbacksFromR2({ notify = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo popolare i fallback locali.");
        return false;
    }

    const confirmed = await confirmDialog({
        title: "Popola fallback locali",
        content: `
            <div>
                <p>Scarica in locale le immagini R2 gia referenziate dalla wiki e dai flag Foundry.</p>
                <p>Non carica nulla su R2, non scrive KV e non cancella file locali.</p>
            </div>
        `,
        yes: () => true,
        no: () => false,
        defaultYes: false
    });
    if (!confirmed) return false;

    const { paths, loadedCollections } = await collectManagedMediaBootstrapPaths();
    const entries = Array.from(paths.values()).sort((left, right) => left.remote.localeCompare(right.remote));
    let existing = 0;
    let downloaded = 0;
    let missing = 0;
    let failed = 0;
    const localByRemote = new Map();

    await runLimitedTasks(entries, MANAGED_MEDIA_BOOTSTRAP_LIMIT, async (entry) => {
        const localPath = buildLocalMediaPathForRemote(entry.remote);
        try {
            const hadLocal = await foundryDataFileExists(localPath);
            if (hadLocal) {
                localByRemote.set(entry.remote, localPath);
                existing += 1;
                return;
            }
            const result = await downloadRemoteMediaToLocal(entry.remote, localPath, { skipLocalCheck: true });
            if (result) {
                localByRemote.set(entry.remote, result);
                downloaded += 1;
            } else {
                missing += 1;
            }
        } catch (error) {
            failed += 1;
            console.warn(`${MODULE_ID} | Fallback locale non scaricato.`, { path: entry.remote, error });
        }
    });

    let bootstrapFlags = { registered: 0, remoteActivated: 0 };
    suppressCharacterSync = true;
    try {
        bootstrapFlags = await registerManagedMediaBootstrapFlags(loadedCollections, localByRemote);
        bootstrapFlags.remoteActivated += await applyManagedRemotePathsFromExistingFlags();
    } finally {
        suppressCharacterSync = false;
    }
    const registered = bootstrapFlags.registered || 0;
    const remoteActivated = bootstrapFlags.remoteActivated || 0;
    const message = `Fallback locali: ${downloaded} scaricati, ${existing} gia presenti, ${missing} mancanti, ${failed} errori, ${registered} flag aggiornati, ${remoteActivated} path Foundry su R2.`;
    if (notify) ui.notifications.info(message);
    console.info(`${MODULE_ID} | Bootstrap fallback locali completato.`, { downloaded, existing, missing, failed, registered, remoteActivated, total: entries.length });
    return true;
}

async function syncCharacterImagesToWiki({ actors = null, notify = false } = {}) {
    if (!game.user?.isGM) {
        if (notify) ui.notifications.warn("Solo il GM puo sincronizzare immagini personaggi verso la wiki.");
        return false;
    }

    const playerActors = Array.isArray(actors)
        ? actors
        : getPlayerActorsForWikiSync();
    let uploaded = 0;
    let existing = 0;
    let skipped = 0;
    const errors = [];

    for (const actor of playerActors) {
        const characterId = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
        const imageJobs = [
            { variant: "avatar", source: actor.img },
            { variant: "token", source: actor?.prototypeToken?.texture?.src || actor?.prototypeToken?.img }
        ];

        for (const job of imageJobs) {
            const mediaPath = buildPlayerMediaPath(characterId, job.variant);
            const filename = `${slugify(characterId)}${job.variant === "token" ? "-token" : "-avatar"}.webp`;
            try {
                if (await workerMediaPathExists(mediaPath)) {
                    await registerManagedMedia(actor, job.variant, {
                        remote: mediaPath,
                        local: job.source,
                        entityType: "player",
                        entityId: characterId,
                        actor
                    });
                    existing += 1;
                    continue;
                }
                if (!String(job.source || "").trim()) {
                    skipped += 1;
                    continue;
                }
                const blob = job.variant === "avatar"
                    ? await imagePathToWebpBlobPreserveSize(job.source)
                    : await imagePathToSquareWebpBlob(job.source, CHARACTER_IMAGE_SYNC_SIZE);
                const uploadedPath = await uploadPlayerImageBlobToWorker(blob, filename);
                await registerManagedMedia(actor, job.variant, {
                    remote: uploadedPath,
                    local: job.source,
                    entityType: "player",
                    entityId: characterId,
                    actor
                });
                uploaded += 1;
            } catch (error) {
                skipped += 1;
                errors.push({ actor: actor.name, variant: job.variant, source: job.source, error: String(error?.message || error) });
            }
        }
    }

    const companionMappings = parseCompanionMappings();
    for (const mapping of companionMappings) {
        const actor = getConfiguredActor(mapping.actorId || mapping.actorName);
        const ownerCharacterId = slugify(mapping.ownerCharacterId || "");
        if (!actor || !ownerCharacterId) {
            skipped += 1;
            continue;
        }
        const imageJobs = [
            { variant: "avatar", source: actor.img },
            { variant: "token", source: actor?.prototypeToken?.texture?.src || actor?.prototypeToken?.img }
        ];

        for (const job of imageJobs) {
            const actorName = actor.name || actor.prototypeToken?.name || "companion";
            const mediaPath = buildCompanionMediaPath(ownerCharacterId, actor.id, job.variant, actorName);
            const entityId = buildCompanionMediaEntityId(ownerCharacterId, actor.id, actorName);
            const filename = `${entityId}${job.variant === "token" ? "-token" : "-avatar"}.webp`;
            try {
                if (await workerMediaPathExists(mediaPath)) {
                    await registerManagedMedia(actor, job.variant, {
                        remote: mediaPath,
                        local: job.source,
                        entityType: "companion",
                        entityId,
                        actor
                    });
                    existing += 1;
                    continue;
                }
                if (!String(job.source || "").trim()) {
                    skipped += 1;
                    continue;
                }
                const blob = job.variant === "avatar"
                    ? await imagePathToWebpBlobPreserveSize(job.source)
                    : await imagePathToSquareWebpBlob(job.source, CHARACTER_IMAGE_SYNC_SIZE);
                const uploadedPath = await uploadPlayerImageBlobToWorker(blob, filename, `companions/${ownerCharacterId}`);
                await registerManagedMedia(actor, job.variant, {
                    remote: uploadedPath,
                    local: job.source,
                    entityType: "companion",
                    entityId,
                    actor
                });
                uploaded += 1;
            } catch (error) {
                skipped += 1;
                errors.push({ actor: actor.name, variant: job.variant, source: job.source, error: String(error?.message || error) });
            }
        }
    }

    if (errors.length) console.warn(`${MODULE_ID} | Alcune immagini personaggio non sono state sincronizzate.`, errors);
    if (notify) ui.notifications.info(`Immagini personaggi sincronizzate. Caricate: ${uploaded}. Gia presenti: ${existing}. Saltate: ${skipped}.`);
    console.info(`${MODULE_ID} | Immagini personaggi sincronizzate verso wiki.`, { uploaded, existing, skipped, actors: playerActors.length });
    return true;
}

async function confirmBulkWikiMediaOperation({ title, total, description }) {
    const count = Number(total) || 0;
    if (count <= 0) return true;
    return confirmDialog({
        title,
        content: `
            <div>
                <p>${escapeHtml(description || "Questa azione puo generare chiamate verso Cloudflare/R2.")}</p>
                <p><strong>Elementi candidati:</strong> ${count}</p>
                <p>Procedi solo se vuoi davvero sincronizzare questi asset adesso.</p>
            </div>
        `,
        yes: () => true,
        no: () => false,
        defaultYes: false
    });
}

async function syncAbilityIconsToWiki({ notify = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo sincronizzare icone abilita verso la wiki.");
        return false;
    }

    const loaded = await requestNotesApi("api/data/ability-overrides");
    const records = Array.isArray(loaded?.data) ? loaded.data : [];
    const expectedVersion = loaded?.source === "kv" ? (loaded.version ?? 0) : 0;
    const nextRecords = records.slice();
    const playerActors = getPlayerActorsForWikiSync();
    const abilityCandidates = playerActors.flatMap((actor) => (
        actor.items.filter((item) => item.type === "feat" && String(item.img || "").trim())
    ));
    const confirmed = await confirmBulkWikiMediaOperation({
        title: "Sincronizza icone abilita",
        total: abilityCandidates.length,
        description: "Il modulo riusa gli override gia presenti e carica su R2 solo le icone abilita mancanti."
    });
    if (!confirmed) return false;

    let uploaded = 0;
    let reused = 0;
    let skipped = 0;
    let changed = 0;
    const errors = [];

    for (const actor of playerActors) {
        const characterFolder = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
        const abilities = actor.items.filter((item) => item.type === "feat" && String(item.img || "").trim());
        for (const item of abilities) {
            const identity = getAbilityOverrideIdentityForItem(actor, item);
            const existing = findExistingAbilityOverrideRecord(nextRecords, identity);
            const existingImagePath = String(existing?.image || "").trim();
            const foundryImagePath = extractWorkerMediaPath(item.img);
            const folder = buildCampaignScopedOverrideFolder("ability-overrides", characterFolder || actor?.name || actor?.id);
            const filename = `${slugify(item?.name || item?.id || "abilita")}.webp`;
            let imagePath = await getReusableCampaignMediaPathInFolder(existingImagePath, folder)
                || await copyLegacyMediaPathToCampaign(existingImagePath, folder, filename)
                || await getReusableCampaignMediaPathInFolder(foundryImagePath, folder)
                || await copyLegacyMediaPathToCampaign(foundryImagePath, folder, filename);
            try {
                if (imagePath) {
                    reused += 1;
                } else {
                    const blob = await imagePathToWebpIconBlob(item.img);
                    imagePath = await uploadAbilityIconBlobToWorker(blob, actor, item, characterFolder);
                    uploaded += 1;
                }
            } catch (error) {
                skipped += 1;
                errors.push({ actor: actor.name, ability: item.name, error: String(error?.message || error) });
                continue;
            }
            await registerManagedMedia(item, "image", {
                remote: imagePath,
                local: item.img,
                entityType: "ability",
                entityId: identity.key,
                actor,
                item
            });

            const record = {
                ...(existing || {}),
                id: existing?.id || identity.key,
                key: existing?.key || identity.key,
                actorId: identity.actorId,
                actorName: identity.actorName,
                abilityId: identity.abilityId,
                abilityName: identity.abilityName,
                image: imagePath,
                updatedAt: existing?.image === imagePath && existing?.updatedAt ? existing.updatedAt : new Date().toISOString()
            };
            const existingIndex = nextRecords.findIndex((entry) => entry === existing || entry?.key === record.key || entry?.id === record.id);
            const hasChanged = JSON.stringify(existing || null) !== JSON.stringify(record);
            if (existingIndex >= 0) nextRecords[existingIndex] = record;
            else nextRecords.push(record);
            if (hasChanged) changed += 1;
        }
    }

    nextRecords.sort((left, right) => {
        const actorSort = String(left.actorName || left.characterName || "").localeCompare(String(right.actorName || right.characterName || ""), "it");
        if (actorSort !== 0) return actorSort;
        return String(left.abilityName || "").localeCompare(String(right.abilityName || ""), "it");
    });

    if (changed > 0) {
        await requestNotesApi("api/data/ability-overrides", {
            method: "POST",
            body: {
                data: nextRecords,
                expectedVersion
            }
        });
    }

    if (errors.length) console.warn(`${MODULE_ID} | Alcune icone abilita non sono state sincronizzate.`, errors);
    if (notify) ui.notifications.info(`Icone abilita sincronizzate. Caricate: ${uploaded}. Gia registrate: ${reused}. Saltate: ${skipped}.`);
    console.info(`${MODULE_ID} | Icone abilita sincronizzate verso wiki.`, { uploaded, reused, skipped, changed, actors: playerActors.length });
    return true;
}

async function syncInventoryItemIconsToWiki({ notify = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo sincronizzare icone inventario verso la wiki.");
        return false;
    }

    const loaded = await requestNotesApi("api/data/item-overrides");
    const records = Array.isArray(loaded?.data) ? loaded.data : [];
    const expectedVersion = loaded?.source === "kv" ? (loaded.version ?? 0) : 0;
    const nextRecords = records.slice();
    const playerActors = getPlayerActorsForWikiSync();
    const itemCandidates = playerActors.flatMap((actor) => (
        actor.items.filter((item) =>
            item
            && item.type !== "feat"
            && item.type !== "spell"
            && CHARACTER_SYNC_ITEM_TYPES.has(item.type)
            && String(item.img || "").trim()
        )
    ));
    const confirmed = await confirmBulkWikiMediaOperation({
        title: "Sincronizza icone inventario",
        total: itemCandidates.length,
        description: "Il modulo riusa gli override gia presenti e carica su R2 solo le icone inventario mancanti."
    });
    if (!confirmed) return false;

    let uploaded = 0;
    let reused = 0;
    let skipped = 0;
    let changed = 0;
    const errors = [];

    for (const actor of playerActors) {
        const characterFolder = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
        const inventoryItems = actor.items.filter((item) =>
            item
            && item.type !== "feat"
            && item.type !== "spell"
            && CHARACTER_SYNC_ITEM_TYPES.has(item.type)
            && String(item.img || "").trim()
        );

        for (const item of inventoryItems) {
            const identity = getItemOverrideIdentityForItem(actor, item);
            const existing = findExistingItemOverrideRecord(nextRecords, identity);
            const existingImagePath = String(existing?.image || "").trim();
            const foundryImagePath = extractWorkerMediaPath(item.img);
            const folder = buildCampaignScopedOverrideFolder("item-overrides", characterFolder || actor?.name || actor?.id);
            const filename = `${slugify(item?.name || item?.id || "oggetto")}.webp`;
            let imagePath = await getReusableCampaignMediaPathInFolder(existingImagePath, folder)
                || await copyLegacyMediaPathToCampaign(existingImagePath, folder, filename)
                || await getReusableCampaignMediaPathInFolder(foundryImagePath, folder)
                || await copyLegacyMediaPathToCampaign(foundryImagePath, folder, filename);
            const hasSiteImage = existing?.imageSource === "site" && Boolean(imagePath);
            try {
                if (imagePath) {
                    reused += 1;
                } else {
                    const blob = await imagePathToWebpIconBlob(item.img);
                    imagePath = await uploadItemIconBlobToWorker(blob, actor, item, characterFolder);
                    uploaded += 1;
                }
            } catch (error) {
                skipped += 1;
                errors.push({ actor: actor.name, item: item.name, error: String(error?.message || error) });
                continue;
            }
            await registerManagedMedia(item, "image", {
                remote: imagePath,
                local: item.img,
                entityType: "item",
                entityId: identity.key,
                actor,
                item
            });

            const record = {
                ...(existing || {}),
                id: existing?.id || identity.key,
                key: existing?.key || identity.key,
                actorId: identity.actorId,
                actorName: identity.actorName,
                itemUuid: identity.itemUuid,
                transferId: identity.transferId,
                sourceId: identity.sourceId,
                transferKey: identity.transferKey,
                itemId: identity.itemId,
                itemName: identity.itemName,
                itemType: identity.itemType,
                image: imagePath,
                imageSource: hasSiteImage ? "site" : "foundry",
                updatedAt: existing?.image === imagePath && existing?.updatedAt ? existing.updatedAt : new Date().toISOString()
            };
            const existingIndex = nextRecords.findIndex((entry) => entry === existing || entry?.key === record.key || entry?.id === record.id);
            const hasChanged = JSON.stringify(existing || null) !== JSON.stringify(record);
            if (existingIndex >= 0) nextRecords[existingIndex] = record;
            else nextRecords.push(record);
            if (hasChanged) changed += 1;
        }
    }

    nextRecords.sort((left, right) => {
        const actorSort = String(left.actorName || left.characterName || "").localeCompare(String(right.actorName || right.characterName || ""), "it");
        if (actorSort !== 0) return actorSort;
        return String(left.itemName || "").localeCompare(String(right.itemName || ""), "it");
    });

    if (changed > 0) {
        await requestNotesApi("api/data/item-overrides", {
            method: "POST",
            body: {
                data: nextRecords,
                expectedVersion
            }
        });
    }

    if (errors.length) console.warn(`${MODULE_ID} | Alcune icone inventario non sono state sincronizzate.`, errors);
    if (notify) ui.notifications.info(`Icone inventario sincronizzate. Caricate: ${uploaded}. Gia registrate: ${reused}. Saltate: ${skipped}.`);
    console.info(`${MODULE_ID} | Icone inventario sincronizzate verso wiki.`, { uploaded, reused, skipped, changed, actors: playerActors.length });
    return true;
}

function getWikiOverrideKindForItemImage(item) {
    if (!item) return "";
    const role = getItemLoadoutRole(item);
    if (role === "ability") return "ability";
    if (role === "inventory") return "item";
    if (item.type === "feat" || item.type === "spell") return "ability";
    if (CHARACTER_SYNC_ITEM_TYPES.has(item.type) || COMPANION_SYNC_ITEM_TYPES.has(item.type)) return "item";
    return "";
}

function hasItemImageChange(changes) {
    if (!changes || typeof changes !== "object") return false;
    return Object.prototype.hasOwnProperty.call(changes, "img")
        || Object.keys(foundry.utils.flattenObject(changes || {})).includes("img");
}

function scheduleItemImageOverrideSync(item, reason = "itemImage") {
    if (suppressCharacterSync) return;
    if (!canSyncCharacters()) return;
    if (!item?.actor || !String(item.img || "").trim()) return;
    if (!isConfiguredPlayerActor(item.actor) && !isConfiguredCompanionActor(item.actor)) return;
    const kind = getWikiOverrideKindForItemImage(item);
    if (!kind) return;

    const key = `${item.actor.id}:${item.id}`;
    pendingItemImageSyncQueue.set(key, {
        actorId: item.actor.id,
        itemId: item.id,
        kind,
        reason
    });
    window.clearTimeout(itemImageSyncTimer);
    console.info(`${MODULE_ID} | Sync immagine item schedulata.`, { actor: item.actor.name, item: item.name, kind, delayMs: CHARACTER_SYNC_DEBOUNCE_MS, reason });
    itemImageSyncTimer = window.setTimeout(() => {
        flushPendingItemImageOverrideSync().catch((error) => {
            console.warn(`${MODULE_ID} | Sync immagini item fallita.`, error);
        });
    }, CHARACTER_SYNC_DEBOUNCE_MS);
}

async function syncItemImageOverrideRecordToWiki(actor, item, collectionDrafts) {
    const kind = getWikiOverrideKindForItemImage(item);
    if (!kind) return null;

    const collection = kind === "ability" ? "ability-overrides" : "item-overrides";
    const folderBase = kind === "ability" ? "ability-overrides" : "item-overrides";
    const characterFolder = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
    const folder = buildCampaignScopedOverrideFolder(folderBase, characterFolder || actor?.name || actor?.id);
    const filename = `${slugify(item?.name || item?.id || (kind === "ability" ? "abilita" : "oggetto"))}.webp`;
    const sourcePath = String(item.img || "").trim();
    if (!sourcePath) return null;

    const workerPath = extractWorkerMediaPath(sourcePath);
    let imagePath = await getReusableCampaignMediaPathInFolder(workerPath, folder)
        || await copyLegacyMediaPathToCampaign(sourcePath, folder, filename, { overwrite: true });

    if (!imagePath) {
        const blob = await imagePathToWebpIconBlob(sourcePath);
        imagePath = kind === "ability"
            ? await uploadAbilityIconBlobToWorker(blob, actor, item, characterFolder)
            : await uploadItemIconBlobToWorker(blob, actor, item, characterFolder);
    }

    const draft = await getAssetJobCollectionDraft(collectionDrafts, collection);
    const now = new Date().toISOString();
    if (kind === "ability") {
        const identity = getAbilityOverrideIdentityForItem(actor, item);
        await withCharacterSyncSuppressed(() => registerManagedMedia(item, "image", {
            remote: imagePath,
            local: sourcePath,
            entityType: "ability",
            entityId: identity.key,
            actor,
            item
        }));
        upsertRecord(draft.data, (entry) => findExistingAbilityOverrideRecord([entry], identity), (existing) => ({
            ...existing,
            id: existing.id || identity.key,
            key: existing.key || identity.key,
            actorId: identity.actorId,
            actorName: identity.actorName,
            abilityId: identity.abilityId,
            abilityName: identity.abilityName,
            image: imagePath,
            imageSource: "foundry",
            updatedAt: now
        }));
        return { collection, imagePath, kind, actor: actor.name, item: item.name };
    }

    const identity = getItemOverrideIdentityForItem(actor, item);
    await withCharacterSyncSuppressed(() => registerManagedMedia(item, "image", {
        remote: imagePath,
        local: sourcePath,
        entityType: "item",
        entityId: identity.key,
        actor,
        item
    }));
    upsertRecord(draft.data, (entry) => findExistingItemOverrideRecord([entry], identity), (existing) => ({
        ...existing,
        id: existing.id || identity.key,
        key: existing.key || identity.key,
        actorId: identity.actorId,
        actorName: identity.actorName,
        itemUuid: identity.itemUuid,
        transferId: identity.transferId,
        sourceId: identity.sourceId,
        transferKey: identity.transferKey,
        itemId: identity.itemId,
        itemName: identity.itemName,
        itemType: identity.itemType,
        image: imagePath,
        imageSource: "foundry",
        updatedAt: now
    }));
    return { collection, imagePath, kind, actor: actor.name, item: item.name };
}

async function flushPendingItemImageOverrideSync() {
    const entries = Array.from(pendingItemImageSyncQueue.values());
    pendingItemImageSyncQueue.clear();
    window.clearTimeout(itemImageSyncTimer);
    itemImageSyncTimer = null;
    if (!entries.length || !canSyncCharacters()) return false;

    const collectionDrafts = new Map();
    let synced = 0;
    let skipped = 0;
    const errors = [];
    for (const entry of entries) {
        const actor = game.actors.get(entry.actorId);
        const item = actor?.items?.get?.(entry.itemId);
        if (!actor || !item) {
            skipped += 1;
            continue;
        }
        try {
            const result = await syncItemImageOverrideRecordToWiki(actor, item, collectionDrafts);
            if (result) synced += 1;
            else skipped += 1;
        } catch (error) {
            skipped += 1;
            errors.push({ actor: actor.name, item: item.name, error: String(error?.message || error) });
        }
    }

    await saveAssetJobCollectionDrafts(collectionDrafts);
    if (errors.length) console.warn(`${MODULE_ID} | Alcune immagini item non sono state sincronizzate verso wiki.`, errors);
    if (synced || skipped) console.info(`${MODULE_ID} | Sync immagini item verso wiki completata.`, { synced, skipped });
    return synced > 0;
}

async function resolvePlayerActorForMediaOverride(record) {
    const actorId = normalizeActorRef(record?.actorId || "");
    if (actorId && game.actors.get(actorId)) return game.actors.get(actorId);
    const entityId = normalizeWikiItemKey(record?.entityId || record?.characterId || record?.ownerCharacterId || "");
    const mapping = parsePlayerActorMappings().find((entry) => normalizeWikiItemKey(entry.ownerCharacterId) === entityId);
    const mappedActor = getConfiguredActor(mapping?.actorRef);
    if (mappedActor) return mappedActor;
    return null;
}

function resolveCompanionActorForMediaOverride(record) {
    const actorId = normalizeActorRef(record?.actorId || "");
    if (actorId && game.actors.get(actorId)) return game.actors.get(actorId);
    const names = [
        record?.foundryName,
        record?.name,
        record?.entityId
    ].map(normalizeWikiItemKey).filter(Boolean);
    return game.actors.find((actor) => {
        const actorName = normalizeWikiItemKey(actor.name);
        return names.some((name) => actorName === name || actorName.includes(name) || name.includes(actorName));
    }) || null;
}

function getActorMediaCurrentValue(actor, slot) {
    if (slot === "avatar") return String(actor?.img || "").trim();
    if (slot === "token") return String(actor?.prototypeToken?.texture?.src || actor?.prototypeToken?.img || "").trim();
    return "";
}

function canAutoApplyManagedActorMedia(actor, slot, remotePath) {
    const remote = normalizeManagedRemotePath(remotePath);
    if (!actor || !remote) return false;
    const current = getActorMediaCurrentValue(actor, slot);
    const currentRemote = normalizeManagedRemotePath(current);
    if (!current || currentRemote === remote) return true;
    if (currentRemote) return false;

    const managed = getManagedMediaState(actor, slot);
    const managedLocal = normalizeFoundryLocalMediaPath(managed?.local);
    const currentLocal = normalizeFoundryLocalMediaPath(current);
    if (managedLocal && currentLocal && managedLocal === currentLocal) return true;

    return false;
}

async function applyCharacterMediaOverridesFromWiki({ notify = false, autoSafe = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo applicare immagini personaggi dalla wiki.");
        return false;
    }

    const payload = await requestNotesApi("api/data/media-overrides");
    const overrides = Array.isArray(payload?.data) ? payload.data : [];
    if (!overrides.length) {
        ui.notifications.info("Nessun override immagini trovato nella wiki.");
        return true;
    }

    const candidates = [];
    let skipped = 0;
    for (const record of overrides) {
        const images = record?.images || {};
        const avatarRemote = String(images.avatar || images.portrait || "").trim();
        const tokenRemote = String(images.token || "").trim();
        const avatar = resolveWikiAssetUrl(avatarRemote);
        const token = resolveWikiAssetUrl(tokenRemote);
        if (!avatar && !token) {
            skipped += 1;
            continue;
        }

        const actor = record.entityType === "companion"
            ? resolveCompanionActorForMediaOverride(record)
            : await resolvePlayerActorForMediaOverride(record);
        if (!actor) {
            skipped += 1;
            console.warn(`${MODULE_ID} | Override immagini non applicato: actor non trovato.`, record);
            continue;
        }

        const patch = {};
        const changes = [];
        if (avatar && normalizeOverrideImageValue(avatar) !== normalizeOverrideImageValue(actor.img)) {
            patch.img = avatarRemote;
            changes.push({ field: "avatar", label: "Avatar" });
        }
        const currentToken = actor.prototypeToken?.texture?.src || "";
        if (token && normalizeOverrideImageValue(token) !== normalizeOverrideImageValue(currentToken)) {
            patch["prototypeToken.texture.src"] = tokenRemote;
            changes.push({ field: "token", label: "Token" });
        }
        if (autoSafe) {
            if (patch.img && !canAutoApplyManagedActorMedia(actor, "avatar", patch.img)) {
                delete patch.img;
                const index = changes.findIndex((change) => change.field === "avatar");
                if (index >= 0) changes.splice(index, 1);
            }
            if (patch["prototypeToken.texture.src"] && !canAutoApplyManagedActorMedia(actor, "token", patch["prototypeToken.texture.src"])) {
                delete patch["prototypeToken.texture.src"];
                const index = changes.findIndex((change) => change.field === "token");
                if (index >= 0) changes.splice(index, 1);
            }
        }
        if (!Object.keys(patch).length) {
            skipped += 1;
            continue;
        }

        candidates.push({
            label: actor.name,
            detail: record.entityType === "companion" ? "Companion" : "Personaggio",
            changes,
            apply: async () => {
                const nextPatch = { ...patch };
                const entityType = record.entityType === "companion" ? "companion" : "player";
                const entityId = record.entityId || record.characterId || record.id || actor.name || actor.id;
                if (nextPatch.img) {
                    const effectiveAvatar = await resolveAndRegisterManagedMedia(actor, "avatar", {
                        remote: nextPatch.img,
                        local: actor.img,
                        entityType,
                        entityId,
                        actor,
                        name: record.name || actor.name,
                        downloadFallback: true
                    });
                    if (effectiveAvatar) nextPatch.img = effectiveAvatar;
                    else delete nextPatch.img;
                }
                if (nextPatch["prototypeToken.texture.src"]) {
                    const effectiveToken = await resolveAndRegisterManagedMedia(actor, "token", {
                        remote: nextPatch["prototypeToken.texture.src"],
                        local: actor.prototypeToken?.texture?.src || "",
                        entityType,
                        entityId,
                        actor,
                        name: record.name || actor.name,
                        downloadFallback: true
                    });
                    if (effectiveToken) nextPatch["prototypeToken.texture.src"] = effectiveToken;
                    else delete nextPatch["prototypeToken.texture.src"];
                }
                if (!Object.keys(nextPatch).length) return null;
                return actor.update(nextPatch, { criptaWikiSyncCommand: true, criptaWikiLegacyMediaSync: true });
            }
        });
    }

    if (autoSafe) {
        let updated = 0;
        for (const entry of candidates) {
            await withCharacterSyncSuppressed(() => entry.apply());
            updated += 1;
        }
        if (updated || skipped) console.info(`${MODULE_ID} | Override immagini wiki automatici sicuri.`, { updated, skipped });
        if (notify && updated) ui.notifications.info(`Immagini personaggi applicate automaticamente: ${updated}.`);
        return updated > 0;
    }

    const selected = await selectWikiOverridesToApply({
        title: "Applica immagini sito",
        description: "Seleziona quali immagini rendere uguali al sito.",
        entries: candidates
    });
    if (selected === null) return false;

    let updated = 0;
    for (const entry of selected) {
        await withCharacterSyncSuppressed(() => entry.apply());
        updated += 1;
    }
    skipped += candidates.length - selected.length;

    if (notify) ui.notifications.info(`Immagini personaggi applicate: ${updated}. Saltate: ${skipped}.`);
    console.info(`${MODULE_ID} | Override immagini wiki applicati.`, { updated, skipped });
    return true;
}

function resolveActorFromAssetRecord(record) {
    const foundry = record?.foundry || {};
    const actorId = normalizeActorRef(foundry.actorId || record?.actorId || "");
    if (actorId && game.actors.get(actorId)) return game.actors.get(actorId);
    const actorName = normalizeWikiItemKey(foundry.actorName || record?.label || "");
    return game.actors.find((actor) => actorName && normalizeWikiItemKey(actor.name) === actorName) || null;
}

function resolveItemFromAssetRecord(actor, record) {
    if (!actor) return null;
    const foundry = record?.foundry || {};
    const transferId = String(record?.transferId || foundry.transferId || "").trim();
    const transferKey = String(record?.transferKey || foundry.transferKey || "").trim();
    const sourceId = normalizeWikiItemKey(record?.sourceId || foundry.sourceId || "");
    const itemId = String(foundry.itemId || record?.itemId || "").trim();
    const itemName = normalizeWikiItemKey(foundry.itemName || record?.label || "");
    return actor.items.find((item) => transferId && getItemTransferId(item) === transferId)
        || actor.items.find((item) => transferKey && getItemOverrideIdentityForItem(actor, item).transferKey === transferKey)
        || actor.items.find((item) => sourceId && normalizeWikiItemKey(getItemStableSourceId(item)) === sourceId)
        || (itemId ? actor.items.get(itemId) : null)
        || actor.items.find((item) => itemName && normalizeWikiItemKey(item.name) === itemName)
        || null;
}

function buildAssetJobCandidate(job) {
    const record = job?.record || {};
    const direction = String(job?.direction || "");
    const sourceState = direction === "site-to-foundry" ? record.siteState : record.foundryState;
    const targetState = direction === "site-to-foundry" ? record.foundryState : record.siteState;
    return {
        label: record.label || job.label || job.assetId || "Asset",
        detail: `${direction === "site-to-foundry" ? "Sito -> Foundry" : "Foundry -> Sito"} | ${record.entityType || ""} / ${record.slot || ""}`,
        changes: [{ label: `${String(sourceState?.value || "").slice(0, 80)} -> ${String(targetState?.value || "").slice(0, 80)}` }],
        job
    };
}

async function applyAssetJobToFoundry(job) {
    const record = job?.record || {};
    const actor = resolveActorFromAssetRecord(record);
    if (!actor) throw new Error("Actor Foundry non trovato.");
    const value = String(record.siteState?.value || "").trim();
    if (!value) throw new Error("Valore sito mancante.");
    const slot = String(record.slot || "").trim();
    const entityType = String(record.entityType || "").trim();
    const resolvedImage = resolveWikiAssetUrl(value);

    if ((entityType === "player" || entityType === "companion") && (slot === "avatar" || slot === "token")) {
        const local = slot === "avatar"
            ? actor.img
            : actor.prototypeToken?.texture?.src || "";
        const effectiveImage = await resolveAndRegisterManagedMedia(actor, slot, {
            remote: value,
            local,
            entityType,
            entityId: record.entityId || record.characterId || record.id || actor.id || actor.name,
            actor,
            name: record.label || actor.name,
            downloadFallback: true
        });
        if (!effectiveImage) throw new Error("Immagine remota non disponibile e fallback locale assente.");
        const patch = slot === "avatar"
            ? { img: effectiveImage }
            : { "prototypeToken.texture.src": effectiveImage };
        await actor.update(patch);
        return;
    }

    const item = resolveItemFromAssetRecord(actor, record);
    if (!item) throw new Error("Item/abilita Foundry non trovato.");
    if (slot === "image" || slot === "icon") {
        const effectiveImage = await resolveAndRegisterManagedMedia(item, "image", {
            remote: value,
            local: item.img,
            entityType: entityType === "ability" ? "ability" : "item",
            entityId: record.entityId || record.id || item.id || item.name,
            actor,
            item,
            downloadFallback: true
        });
        if (!effectiveImage) throw new Error("Immagine remota non disponibile e fallback locale assente.");
        await item.update({ img: effectiveImage });
        return;
    }
    if (slot === "description") {
        await item.update({ "system.description.value": renderAbilityOverrideDescription(value) });
        return;
    }
    throw new Error(`Slot non supportato: ${slot}`);
}

function getCurrentFoundryAssetValue(record) {
    const actor = resolveActorFromAssetRecord(record);
    if (!actor) throw new Error("Actor Foundry non trovato per backup.");
    const slot = String(record?.slot || "").trim();
    const entityType = String(record?.entityType || "").trim();

    if ((entityType === "player" || entityType === "companion") && slot === "avatar") {
        return {
            actor,
            item: null,
            value: String(actor.img || "").trim()
        };
    }

    if ((entityType === "player" || entityType === "companion") && slot === "token") {
        return {
            actor,
            item: null,
            value: String(actor.prototypeToken?.texture?.src || "").trim()
        };
    }

    const item = resolveItemFromAssetRecord(actor, record);
    if (!item) throw new Error("Item/abilita Foundry non trovato per backup.");
    if (slot === "image" || slot === "icon") {
        return {
            actor,
            item,
            value: String(item.img || "").trim()
        };
    }
    if (slot === "description") {
        return {
            actor,
            item,
            value: String(item.system?.description?.value || "").trim()
        };
    }

    throw new Error(`Slot non supportato per backup: ${slot}`);
}

function buildAssetSyncBackupEntry(job) {
    const record = job?.record || {};
    const current = getCurrentFoundryAssetValue(record);
    const foundry = record.foundry || {};
    const now = new Date().toISOString();
    const previousValue = current.value;
    const incomingValue = String(record.siteState?.value || "").trim();
    return {
        id: `${getCampaignId()}:backup:${hashString(`${job?.id || record.id || ""}:${previousValue}:${now}`)}`,
        campaignId: getCampaignId(),
        jobId: job?.id || "",
        assetId: job?.assetId || record.id || "",
        direction: "site-to-foundry",
        entityType: record.entityType || "",
        entityId: record.entityId || "",
        slot: record.slot || "",
        label: record.label || job?.label || record.entityId || "",
        actorId: current.actor?.id || foundry.actorId || "",
        actorName: current.actor?.name || foundry.actorName || "",
        itemId: current.item?.id || foundry.itemId || "",
        itemName: current.item?.name || foundry.itemName || "",
        previousValue,
        incomingValue,
        previousHash: hashString(previousValue),
        incomingHash: hashString(incomingValue),
        createdAt: now,
        createdBy: game.user?.name || "GM"
    };
}

async function saveAssetSyncFoundryBackups(jobs) {
    const backupJobs = (Array.isArray(jobs) ? jobs : [])
        .filter((job) => job?.direction === "site-to-foundry");
    if (!backupJobs.length) return 0;

    const entries = [];
    for (const job of backupJobs) {
        const entry = buildAssetSyncBackupEntry(job);
        entries.push(entry);
    }
    if (!entries.length) return 0;

    const payload = await requestNotesApi("api/data/asset-sync-backups");
    const existing = Array.isArray(payload?.data) ? payload.data.slice() : [];
    const existingKeys = new Set(existing.map((entry) => `${entry.jobId}:${entry.previousHash}:${entry.incomingHash}`));
    const nextEntries = entries.filter((entry) => {
        const key = `${entry.jobId}:${entry.previousHash}:${entry.incomingHash}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
    });
    if (!nextEntries.length) return 0;

    await requestNotesApi("api/data/asset-sync-backups", {
        method: "POST",
        body: {
            data: [...existing, ...nextEntries],
            expectedVersion: payload?.source === "kv" ? (payload.version ?? 0) : 0
        }
    });
    return nextEntries.length;
}

async function resolveAssetJobImageForSite(record, actor, item, value) {
    const slot = String(record?.slot || "").trim();
    const entityType = String(record?.entityType || "").trim();
    const workerPath = extractWorkerMediaPath(value);

    if ((entityType === "player" || entityType === "companion") && (slot === "avatar" || slot === "token")) {
        if (await getReusableCampaignMediaPath(workerPath)) return workerPath;
        const isAvatar = slot === "avatar";
        const blob = isAvatar
            ? await imagePathToWebpBlobPreserveSize(value)
            : await imagePathToSquareWebpBlob(value, CHARACTER_IMAGE_SYNC_SIZE);
        if (entityType === "companion") {
            const ownerCharacterId = getConfiguredCompanionOwnerCharacterIdForActor(actor)
                || slugify(record?.ownerCharacterId || record?.characterId || "");
            const actorName = actor?.name || "companion";
            const entityId = buildCompanionMediaEntityId(ownerCharacterId, actor?.id || "", actorName);
            const filename = `${entityId}${slot === "token" ? "-token" : "-avatar"}.webp`;
            return uploadPlayerImageBlobToWorker(blob, filename, `companions/${ownerCharacterId || slugify(actorName)}`);
        }
        const characterId = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
        const filename = `${slugify(characterId)}${slot === "token" ? "-token" : "-avatar"}.webp`;
        return uploadPlayerImageBlobToWorker(blob, filename);
    }

    const folderBase = entityType === "ability" ? "ability-overrides" : "item-overrides";
    const characterFolder = getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor);
    const folder = buildCampaignScopedOverrideFolder(folderBase, characterFolder || actor?.name || actor?.id);
    const filename = `${slugify(item?.name || item?.id || "asset")}.webp`;
    const reusableWorkerPath = await getReusableCampaignMediaPathInFolder(workerPath, folder);
    if (reusableWorkerPath) return reusableWorkerPath;
    const copied = await copyLegacyMediaPathToCampaign(value, folder, filename, { overwrite: true });
    if (copied) return copied;
    const blob = await imagePathToWebpIconBlob(value);
    return uploadRawMediaBlobToWorker(blob, filename, folder);
}

function upsertRecord(records, matcher, buildRecord) {
    const existing = records.find(matcher);
    const next = buildRecord(existing || {});
    const index = existing ? records.indexOf(existing) : -1;
    if (index >= 0) records[index] = next;
    else records.push(next);
    return next;
}

async function applyAssetJobToSite(job, collectionDrafts) {
    const record = job?.record || {};
    const actor = resolveActorFromAssetRecord(record);
    if (!actor) throw new Error("Actor Foundry non trovato.");
    const item = ["ability", "item"].includes(String(record.entityType || "")) ? resolveItemFromAssetRecord(actor, record) : null;
    if (["ability", "item"].includes(String(record.entityType || "")) && !item) throw new Error("Item/abilita Foundry non trovato.");

    const slot = String(record.slot || "").trim();
    const entityType = String(record.entityType || "").trim();
    const sourceValue = String(record.foundryState?.value || "").trim();
    if (!sourceValue) throw new Error("Valore Foundry mancante.");
    const now = new Date().toISOString();

    if (entityType === "ability") {
        const draft = await getAssetJobCollectionDraft(collectionDrafts, "ability-overrides");
        const identity = getAbilityOverrideIdentityForItem(actor, item);
        const value = slot === "description" ? sourceValue : await resolveAssetJobImageForSite(record, actor, item, sourceValue);
        if (slot !== "description") {
            await registerManagedMedia(item, "image", {
                remote: value,
                local: sourceValue,
                entityType: "ability",
                entityId: identity.key,
                actor,
                item
            });
        }
        upsertRecord(draft.data, (entry) => findExistingAbilityOverrideRecord([entry], identity), (existing) => ({
            ...existing,
            id: existing.id || identity.key,
            key: existing.key || identity.key,
            actorId: identity.actorId,
            actorName: identity.actorName,
            abilityId: identity.abilityId,
            abilityName: identity.abilityName,
            ...(slot === "description" ? { description: value } : { image: value, imageSource: "foundry" }),
            updatedAt: now
        }));
        return;
    }

    if (entityType === "item") {
        const draft = await getAssetJobCollectionDraft(collectionDrafts, "item-overrides");
        const identity = getItemOverrideIdentityForItem(actor, item);
        const value = slot === "description" ? sourceValue : await resolveAssetJobImageForSite(record, actor, item, sourceValue);
        if (slot !== "description") {
            await registerManagedMedia(item, "image", {
                remote: value,
                local: sourceValue,
                entityType: "item",
                entityId: identity.key,
                actor,
                item
            });
        }
        upsertRecord(draft.data, (entry) => findExistingItemOverrideRecord([entry], identity), (existing) => ({
            ...existing,
            id: existing.id || identity.key,
            key: existing.key || identity.key,
            actorId: identity.actorId,
            actorName: identity.actorName,
            itemUuid: identity.itemUuid,
            transferId: identity.transferId,
            sourceId: identity.sourceId,
            transferKey: identity.transferKey,
            itemId: identity.itemId,
            itemName: identity.itemName,
            itemType: identity.itemType,
            ...(slot === "description" ? { description: value } : { image: value, imageSource: "foundry" }),
            updatedAt: now
        }));
        return;
    }

    if ((entityType === "player" || entityType === "companion") && (slot === "avatar" || slot === "token")) {
        const draft = await getAssetJobCollectionDraft(collectionDrafts, "media-overrides");
        const imagePath = await resolveAssetJobImageForSite(record, actor, null, sourceValue);
        const ownerCharacterId = entityType === "companion" ? getConfiguredCompanionOwnerCharacterIdForActor(actor) : "";
        const entityId = record.entityId || (entityType === "player"
            ? (getConfiguredCharacterIdForActor(actor) || await resolveWikiCharacterIdForActor(actor))
            : buildCompanionMediaEntityId(ownerCharacterId || record.ownerCharacterId || "", actor.id, actor.name));
        await registerManagedMedia(actor, slot, {
            remote: imagePath,
            local: sourceValue,
            entityType,
            entityId,
            actor
        });
        upsertRecord(draft.data, (entry) => entry?.entityType === entityType && entry?.entityId === entityId, (existing) => ({
            ...existing,
            id: existing.id || `${entityType}:${entityId}`,
            key: existing.key || `${entityType}:${entityId}`,
            entityType,
            entityId,
            ...(ownerCharacterId ? { characterId: ownerCharacterId, ownerCharacterId } : {}),
            actorId: actor.id,
            name: actor.name,
            foundryName: actor.name,
            images: {
                ...(existing.images || {}),
                [slot === "token" ? "token" : "avatar"]: imagePath,
                ...(slot === "avatar" ? { portrait: imagePath } : {})
            },
            updatedAt: now
        }));
        return;
    }

    throw new Error(`Tipo/slot non supportato: ${entityType}/${slot}`);
}

async function getAssetJobCollectionDraft(collectionDrafts, collection) {
    if (collectionDrafts.has(collection)) return collectionDrafts.get(collection);
    const payload = await requestNotesApi(`api/data/${collection}`);
    const draft = {
        collection,
        expectedVersion: payload?.source === "kv" ? (payload.version ?? 0) : 0,
        data: Array.isArray(payload?.data) ? payload.data.slice() : []
    };
    collectionDrafts.set(collection, draft);
    return draft;
}

async function saveAssetJobCollectionDrafts(collectionDrafts) {
    for (const draft of collectionDrafts.values()) {
        await requestNotesApi(`api/data/${draft.collection}`, {
            method: "POST",
            body: {
                data: draft.data,
                expectedVersion: draft.expectedVersion
            }
        });
    }
}

async function applyQueuedAssetSyncJobsFromWiki({ notify = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo applicare richieste asset.");
        return false;
    }

    const payload = await requestNotesApi("api/data/asset-sync-jobs");
    const jobs = Array.isArray(payload?.data) ? payload.data : [];
    const pending = jobs.filter((job) => job?.status === "pending");
    if (!pending.length) {
        ui.notifications.info("Nessuna richiesta asset in coda.");
        return true;
    }

    const selected = await selectWikiOverridesToApply({
        title: "Applica richieste asset",
        description: "Seleziona le richieste create dal sito da applicare ora. Ogni richiesta aggiorna una sola cosa.",
        entries: pending.map(buildAssetJobCandidate)
    });
    if (selected === null) return false;

    const selectedIds = new Set(selected.map((entry) => entry.job.id));
    const selectedJobs = jobs.filter((entry) => selectedIds.has(entry.id));
    let backupCount = 0;
    try {
        backupCount = await saveAssetSyncFoundryBackups(selectedJobs);
    } catch (error) {
        ui.notifications.error("Backup richieste asset non riuscito. Applicazione annullata per sicurezza.");
        console.warn(`${MODULE_ID} | Backup richieste asset non riuscito.`, error);
        return false;
    }

    const collectionDrafts = new Map();
    let applied = 0;
    let failed = 0;
    const nextJobs = jobs.map((job) => ({ ...job }));

    for (const job of nextJobs.filter((entry) => selectedIds.has(entry.id))) {
        try {
            if (job.direction === "site-to-foundry") await applyAssetJobToFoundry(job);
            else if (job.direction === "foundry-to-site") await applyAssetJobToSite(job, collectionDrafts);
            else throw new Error(`Direzione non supportata: ${job.direction}`);
            job.status = "applied";
            job.appliedAt = new Date().toISOString();
            job.appliedBy = game.user?.name || "GM";
            delete job.error;
            applied += 1;
        } catch (error) {
            job.status = "failed";
            job.error = String(error?.message || error);
            job.failedAt = new Date().toISOString();
            failed += 1;
            console.warn(`${MODULE_ID} | Richiesta asset fallita.`, { job, error });
        }
    }

    await saveAssetJobCollectionDrafts(collectionDrafts);
    await requestNotesApi("api/data/asset-sync-jobs", {
        method: "POST",
        body: {
            data: nextJobs,
            expectedVersion: payload?.source === "kv" ? (payload.version ?? 0) : 0
        }
    });

    if (notify) ui.notifications.info(`Richieste asset applicate: ${applied}. Fallite: ${failed}. Backup creati: ${backupCount}.`);
    console.info(`${MODULE_ID} | Richieste asset applicate.`, { applied, failed, backupCount });
    return true;
}

function getSiteBaseUrl() {
    const configured = String(game.settings.get(MODULE_ID, SETTINGS.SITE_BASE_URL) || "").trim();
    return (configured || "https://khuzoe.github.io/sigillo-del-male").replace(/\/+$/, "");
}

function getCampaignId() {
    const configured = String(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "").trim();
    return configured || DEFAULT_CAMPAIGN_ID;
}

function withCampaign(url) {
    return withCampaignUrl(url, getCampaignId());
}

function getSiteDataUrl(path) {
    const cleanPath = String(path || "").replace(/^\/+/, "").replace(/^assets\/data\//, "");
    const campaignId = getCampaignId();
    if (campaignId === DEFAULT_CAMPAIGN_ID) return `${getSiteBaseUrl()}/assets/data/${cleanPath}`;
    return `${getSiteBaseUrl()}/campaigns/${encodeURIComponent(campaignId)}/data/${cleanPath}`;
}

async function fetchPublicJson(url, options = {}) {
    const response = await policyFetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function normalizeSkillTreesPayload(payload) {
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (Array.isArray(data)) {
        return data.reduce((acc, entry) => {
            if (!entry || typeof entry !== "object") return acc;
            const key = String(entry.id || entry.key || entry.characterId || entry.ownerCharacterId || "").trim();
            const tree = entry.tree && typeof entry.tree === "object" ? entry.tree : entry;
            if (key && Array.isArray(tree.nodes)) acc[key] = { ...tree, id: key };
            return acc;
        }, {});
    }
    if (!data || typeof data !== "object") return {};
    return Object.entries(data).reduce((acc, [key, tree]) => {
        if (tree && typeof tree === "object" && Array.isArray(tree.nodes)) acc[key] = tree;
        return acc;
    }, {});
}

async function loadWikiSkillTrees({ force = false } = {}) {
    if (!force && skillTreesCache.data) return skillTreesCache.data;
    if (!force && skillTreesCache.promise) return skillTreesCache.promise;

    skillTreesCache.promise = (async () => {
        const workerUrl = new URL(`${DISCORD_WORKER_URL}/api/data/skill-trees`);
        workerUrl.searchParams.set("campaign", getCampaignId());
        try {
            const onlinePayload = await fetchPublicJson(workerUrl.toString());
            const onlineTrees = normalizeSkillTreesPayload(onlinePayload);
            if (Object.keys(onlineTrees).length) {
                skillTreesCache.data = onlineTrees;
                skillTreesCache.loadedAt = Date.now();
                return onlineTrees;
            }
        } catch (error) {
            console.warn(`${MODULE_ID} | Alberi abilita KV non disponibili, uso JSON statico.`, error);
        }

        const staticPayload = await fetchPublicJson(getSiteDataUrl("skills.json"));
        const staticTrees = normalizeSkillTreesPayload(staticPayload);
        skillTreesCache.data = staticTrees;
        skillTreesCache.loadedAt = Date.now();
        return staticTrees;
    })();

    try {
        return await skillTreesCache.promise;
    } finally {
        skillTreesCache.promise = null;
    }
}

function getCachedWikiSkillTrees() {
    return skillTreesCache.data || null;
}

function getActorSkillTreeCandidateIds(actor) {
    const actorName = normalizeWikiItemKey(actor?.name || "");
    const values = new Set([
        getConfiguredCharacterIdForActor(actor),
        actor?.name
    ].map((value) => String(value || "").trim()).filter(Boolean));

    Object.entries(WIKI_PLAYER_ID_ALIASES).forEach(([wikiId, aliases]) => {
        const matches = aliases
            .map(normalizeWikiItemKey)
            .some((alias) => alias && actorName && (alias === actorName || actorName.includes(alias) || alias.includes(actorName)));
        if (matches) values.add(wikiId);
    });

    return Array.from(values);
}

function getSkillTreeOwnerIds(tree) {
    return [
        tree?.characterId,
        tree?.ownerCharacterId,
        ...(Array.isArray(tree?.characterIds) ? tree.characterIds : []),
        ...(Array.isArray(tree?.ownerCharacterIds) ? tree.ownerCharacterIds : [])
    ].map((value) => String(value || "").trim()).filter(Boolean);
}

function getPlayerSkillTreeEntriesForActor(actor, allSkillTrees = getCachedWikiSkillTrees(), { includeArchived = false } = {}) {
    if (!actor || actor.type !== "character" || !allSkillTrees || typeof allSkillTrees !== "object") return [];
    const candidates = getActorSkillTreeCandidateIds(actor);
    const normalizedCandidates = new Set(candidates.map(normalizeWikiItemKey).filter(Boolean));
    const slugCandidates = new Set(candidates.map(slugify).filter(Boolean));
    const entries = [];

    Object.entries(allSkillTrees).forEach(([key, tree]) => {
        if (!tree || typeof tree !== "object" || !Array.isArray(tree.nodes) || (!tree.nodes.length && !includeArchived)) return;
        if (!includeArchived && isArchivedSkillTree(tree)) return;
        if (isSharedSkillTree(tree, key)) {
            entries.push({ key, tree });
            return;
        }
        const owners = getSkillTreeOwnerIds(tree);
        if (owners.length) {
            if (owners.some((owner) => normalizedCandidates.has(normalizeWikiItemKey(owner)))) {
                entries.push({ key, tree });
            }
            return;
        }

        const normalizedKey = normalizeWikiItemKey(key);
        const keySlug = slugify(key);
        if (normalizedCandidates.has(normalizedKey)
            || slugCandidates.has(keySlug)
            || Array.from(slugCandidates).some((candidate) => keySlug.startsWith(`${candidate}-`) || keySlug.startsWith(`${candidate}_`))) {
            entries.push({ key, tree });
        }
    });

    return entries.sort((left, right) => {
        const leftOrder = Number(left.tree.order ?? 0);
        const rightOrder = Number(right.tree.order ?? 0);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return String(left.tree.name || left.tree.title || left.key).localeCompare(String(right.tree.name || right.tree.title || right.key), "it");
    });
}

function resolveSkillTreeNodeImage(node) {
    const raw = String(node?.icon || node?.img || node?.image || "").trim();
    if (!raw) return "icons/svg/aura.svg";
    if (/^(https?:|data:|\/)/i.test(raw) || raw.startsWith("media/")) return resolveWikiAssetUrl(raw);
    if (raw.startsWith("assets/")) return resolveWikiAssetUrl(raw);
    return `${DISCORD_WORKER_URL}/media/campaigns/${encodeURIComponent(getCampaignId())}/skill-trees/${raw.replace(/^\/+/, "")}`;
}

function renderSkillTreeNodeDescription(node, tree, level = 1) {
    const parts = [];
    const flavor = String(node?.flavor || "").trim();
    const desc = String(node?.desc || node?.description || "").trim();
    if (flavor) parts.push(`<p><em>${escapeHtml(flavor)}</em></p>`);
    if (desc) parts.push(/<[^>]+>/.test(desc) ? desc : `<p>${escapeHtml(desc)}</p>`);
    if (Number(node?.maxLevel || 1) > 1) {
        parts.push(`<p><strong>Livello albero:</strong> ${escapeHtml(level)} / ${escapeHtml(node.maxLevel)}</p>`);
    }
    parts.push(`<hr><p><strong>Origine:</strong> Albero abilita${tree?.name || tree?.title ? ` - ${escapeHtml(tree.name || tree.title)}` : ""}.</p>`);
    return parts.join("");
}

function buildFoundryItemFromSkillTreeNode(node, tree, treeKey, level = 1) {
    const name = String(node?.title || node?.name || `Abilita ${node?.id || ""}`).trim() || "Abilita";
    const item = buildFoundryActorItemFromWikiAbility({
        name,
        type: node?.itemType || "feat",
        iconImage: resolveSkillTreeNodeImage(node),
        activation: node?.activation || "",
        target: node?.target || "",
        range: node?.range || "",
        saveAbility: node?.saveAbility || "",
        saveDc: node?.saveDc || "",
        damageFormula: node?.damageFormula || "",
        damageType: node?.damageType || "",
        attackBonus: node?.attackBonus || "",
        flags: node?.flags || {}
    }, {});

    item.name = name;
    item.img = resolveSkillTreeNodeImage(node);
    item.system = item.system || {};
    item.system.description = item.system.description || { value: "", chat: "" };
    item.system.description.value = renderSkillTreeNodeDescription(node, tree, level);
    item.system.source = item.system.source || {};
    item.system.source.custom = "Albero abilita wiki";
    item.flags = {
        ...(item.flags || {}),
        [MODULE_ID]: {
            ...(item.flags?.[MODULE_ID] || {}),
            skillTree: {
                treeKey,
                nodeId: String(node?.id || ""),
                level,
                syncedAt: new Date().toISOString()
            }
        }
    };
    return item;
}

let lastSkillTreeSyncReport = null;
let lastSkillTreeWarningSignature = "";

async function loadAuthoritativeSkillTreeSnapshot() {
    const campaignId = getCampaignId();
    const payloads = await Promise.all(["skill-trees", "skill-tree-states"].map(collection => {
        const url = new URL(DISCORD_WORKER_URL + "/api/data/" + collection);
        url.searchParams.set("campaign", campaignId);
        return fetchPublicJson(url.toString(), { signal: AbortSignal.timeout(15_000) });
    }));
    const snapshot = validateSkillTreeSnapshot(payloads[0], payloads[1], campaignId);
    if (campaignId !== getCampaignId()) throw new Error("Campagna cambiata durante la lettura degli alberi.");
    skillTreesCache.data = snapshot.trees;
    skillTreesCache.loadedAt = Date.now();
    return snapshot;
}

function makeSkillTreeSyncPlans(snapshot) {
    return game.actors.filter(actor => actor.type === "character"
        && !actor.isPolymorphed && !actor.flags?.dnd5e?.isPolymorphed && !actor.flags?.dnd5e?.summonedCopy)
        .map(actor => {
            const entries = getPlayerSkillTreeEntriesForActor(actor, snapshot.trees, { includeArchived: true });
            const characterId = getPreferredSkillTreeCharacterId(actor);
            const hasManagedItems = actor.items.some(item => item.flags?.[MODULE_ID]?.skillTree);
            if ((!entries.length && !hasManagedItems) || !characterId) return null;
            return planSkillTreeActor({ actor, snapshot, entries, characterId,
                candidates: getActorSkillTreeCandidateIds(actor), buildItem: buildFoundryItemFromSkillTreeNode });
        }).filter(Boolean);
}

function getSkillTreeEffectActors() {
    const actors = [...game.actors];
    for (const scene of game.scenes || []) {
        for (const token of scene.tokens || []) if (token.actor) actors.push(token.actor);
    }
    return [...new Map(actors.map(actor => [actor.uuid, actor])).values()];
}

async function previewSkillTreeSync() {
    if (!game.user?.isGM) throw new Error("Solo il GM può verificare l’allineamento delle abilità.");
    const snapshot = await loadAuthoritativeSkillTreeSnapshot();
    return { dryRun: true, campaignId: snapshot.campaignId, ...summarizeSkillTreePlans(makeSkillTreeSyncPlans(snapshot)) };
}

async function showSkillTreeSyncPreview() {
    const report = await previewSkillTreeSync();
    const lines = report.actors.flatMap(actor => [
        ...actor.create.map(name => [actor.actor, name, "Da aggiungere"]),
        ...actor.update.map(entry => [actor.actor, entry.name, "Da aggiornare"]),
        ...actor.retire.map(name => [actor.actor, name, "Da ritirare (copia conservata)"])
    ]);
    const reasons = { "unlinked-name": "Nome coincidente: collegamento da verificare", "unlinked-item": "Origine non certificata: conservata",
        "unresolved-origin": "Albero originario non identificabile: conservata", "duplicate-managed": "Più copie gestite: da verificare" };
    for (const warning of report.warnings) lines.push([warning.actor, warning.name, reasons[warning.code] || "Da verificare"]);
    renderDialog({
        title: "Allineamento abilità degli alberi",
        content: `<p>Confronto con gli alberi non archiviati del sito. Questa anteprima non modifica le schede.</p><table>
            <thead><tr><th>Personaggio</th><th>Capacità</th><th>Esito</th></tr></thead><tbody>
            ${lines.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value || "")}</td>`).join("")}</tr>`).join("") || '<tr><td colspan="3">Tutto allineato.</td></tr>'}
            </tbody></table>`,
        buttons: { close: { label: "Chiudi" } }
    }, { width: 850, resizable: true });
    return report;
}

async function reconcileSkillTreeAbilities() {
    if (!canPullFromWorker() || !isSkillTreeSyncLeader(game)) return false;
    const snapshot = await loadAuthoritativeSkillTreeSnapshot();
    const canWrite = () => canPullFromWorker() && isSkillTreeSyncLeader(game) && getCampaignId() === snapshot.campaignId;
    // Validate and plan every actor before the first mutation. No static/offline fallback may revoke items.
    const plans = makeSkillTreeSyncPlans(snapshot);
    for (const plan of plans) await applySkillTreeActorPlan(plan, { canWrite, effectActors: getSkillTreeEffectActors });
    const report = { campaignId: snapshot.campaignId, ...summarizeSkillTreePlans(plans) };
    lastSkillTreeSyncReport = report;
    const signature = JSON.stringify(report.warnings);
    if (report.warnings.length && signature !== lastSkillTreeWarningSignature) {
        ui.notifications.warn("Alberi sincronizzati: alcune capacità richiedono un collegamento certo. Apri Wiki Sync → Verifica abilità alberi.");
    }
    lastSkillTreeWarningSignature = signature;
    console.info(MODULE_ID + " | Allineamento abilità alberi.", report);
    return report;
}

const runSkillTreeSync = createSkillTreeSyncQueue(() => {
    const locks = globalThis.navigator?.locks;
    const key = MODULE_ID + ":skill-trees:" + (game.world?.id || "world") + ":" + getCampaignId();
    return locks ? locks.request(key, reconcileSkillTreeAbilities) : reconcileSkillTreeAbilities();
});

async function syncUnlockedSkillTreeAbilitiesToFoundry({ notify = false, dryRun = false } = {}) {
    if (dryRun) return previewSkillTreeSync();
    if (!canPullFromWorker() || !isSkillTreeSyncLeader(game)) {
        if (notify) ui.notifications.warn("L’allineamento richiede il GM attivo e una modalità che consenta sito → Foundry.");
        return false;
    }
    try {
        const report = await runSkillTreeSync();
        if (notify && report) ui.notifications.info(
            "Abilità allineate. Aggiunte: " + report.created + ". Aggiornate: " + report.updated
            + ". Ritirate: " + report.retired + ". Da verificare: " + report.warnings.length + "."
        );
        return report;
    } catch (error) {
        if (notify) ui.notifications.error("Allineamento abilità interrotto: " + error.message);
        throw error;
    }
}

function getPreferredSkillTreeCharacterId(actor, treeEntry = null) {
    const configured = slugify(getConfiguredCharacterIdForActor(actor) || "");
    if (configured && configured !== "entity") return configured;

    const owner = getSkillTreeOwnerIds(treeEntry?.tree).map(slugify).find((value) => value && value !== "entity");
    if (owner) return owner;

    const actorName = normalizeWikiItemKey(actor?.name || "");
    const aliasMatch = Object.entries(WIKI_PLAYER_ID_ALIASES).find(([, aliases]) =>
        aliases.map(normalizeWikiItemKey).some((alias) => alias && actorName && (alias === actorName || actorName.includes(alias) || alias.includes(actorName)))
    );
    if (aliasMatch?.[0]) return slugify(aliasMatch[0]);

    return "";
}

async function openPlayerSkillTreeForActor(actor) {
    const skillTrees = await loadWikiSkillTrees();
    const entries = getPlayerSkillTreeEntriesForActor(actor, skillTrees);
    if (!entries.length) {
        ui.notifications.info("Questo personaggio non ha alberi abilita associati nella wiki.");
        return null;
    }

    const treeKey = entries[0].key || "default";
    const characterId = getPreferredSkillTreeCharacterId(actor, entries[0]) || await resolveWikiCharacterIdForActor(actor);
    const application = new CriptaWikiSkillTreeApp({
        characterId,
        title: `Albero - ${actor?.name || characterId}`,
        treeKey
    });
    renderApplication(application, { force: true });
    return application;
}

function rerenderOpenActorSheetsForSkillTreeButtons() {
    openApplications().forEach((app) => {
        if (!app?.actor || !app?.rendered) return;
        rerenderApplication(app);
    });
}

function resolveWikiAssetUrl(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    const mediaPath = normalizeManagedRemotePath(raw);
    if (mediaPath) return `${DISCORD_WORKER_URL}/${mediaPath}`;
    if (/^(https?:|data:|\/)/i.test(raw)) return raw;
    return `${getSiteBaseUrl()}/assets/${raw.replace(/^assets\//, "").replace(/^\/+/, "")}`;
}

async function loadWikiItemsCatalog() {
    const normalizeCatalog = (payload) => {
        const items = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload)
                ? payload
                : [];
        return items.filter((item) => item && typeof item === "object" && (item.id || item.name));
    };

    try {
        const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/api/data/items`), {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-cache"
        });
        if (!response.ok) throw new Error(`api/data/items HTTP ${response.status}`);
        const items = normalizeCatalog(await response.json());
        if (items.length) return items;
    } catch (error) {
        console.warn(`${MODULE_ID} | Catalogo oggetti KV non disponibile, uso JSON statico.`, error);
    }

    const response = await policyFetch(getSiteDataUrl("items.json"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-cache"
    });
    if (!response.ok) throw new Error(`items.json HTTP ${response.status}`);
    return normalizeCatalog(await response.json());
}

function getWikiItemAliases(item) {
    const aliases = [
        item.id,
        item.name,
        item.foundryName,
        item.unidentifiedName,
        ...(Array.isArray(item.foundryNames) ? item.foundryNames : []),
        ...(Array.isArray(item.aliases) ? item.aliases : [])
    ].filter(Boolean);
    if (item.owner && item.name && String(item.name).includes(":")) {
        const localName = String(item.name).split(":").slice(1).join(":").trim();
        if (localName) aliases.push(`${localName} di ${item.owner}`);
    }
    return Array.from(new Set(aliases)).filter(Boolean);
}

function getWikiItemFoundryNames(item) {
    return [
        item.foundryName,
        ...(Array.isArray(item.foundryNames) ? item.foundryNames : [])
    ].filter(Boolean);
}

function getPreferredFoundryItemName(item) {
    return getWikiItemFoundryNames(item)[0] || item.name || "Oggetto wiki";
}

function getExistingItemKeys() {
    const keys = new Set();
    game.items.forEach((item) => {
        const wikiId = item.getFlag?.(MODULE_ID, "wikiItemId");
        if (wikiId) keys.add(`id:${String(wikiId)}`);
        const flaggedNames = item.getFlag?.(MODULE_ID, "foundryNames");
        const names = [
            item.name,
            item.getFlag?.(MODULE_ID, "wikiItemName"),
            ...(Array.isArray(flaggedNames) ? flaggedNames : [])
        ];
        names.forEach((name) => {
            const key = normalizeWikiItemKey(name);
            if (key) keys.add(`name:${key}`);
        });
    });
    return keys;
}

function isWikiItemPresent(item, existingKeys = getExistingItemKeys()) {
    if (item.id && existingKeys.has(`id:${String(item.id)}`)) return true;
    return getWikiItemAliases(item).some((alias) => existingKeys.has(`name:${normalizeWikiItemKey(alias)}`));
}

function getWikiMissingItems(items) {
    const existingKeys = getExistingItemKeys();
    return items
        .filter((item) => !isWikiItemPresent(item, existingKeys))
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "it"));
}

function mapWikiItemTypeToFoundry(item) {
    const type = String(item?.type || "").toLowerCase();
    if (type.includes("arma")) return "weapon";
    if (type.includes("pozione") || type.includes("pergamena")) return "consumable";
    if (type.includes("bottino")) return "loot";
    if (type.includes("strumento")) return "tool";
    return "equipment";
}

function mapWikiRarityToFoundry(rarity) {
    const key = normalizeWikiItemKey(rarity);
    const map = {
        comune: "common",
        noncomune: "uncommon",
        raro: "rare",
        epico: "veryRare",
        moltoraro: "veryRare",
        leggendario: "legendary",
        artefatto: "artifact"
    };
    return map[key] || "";
}

function renderWikiItemDescription(item) {
    const parts = [];
    if (item.summary) parts.push(`<p>${escapeHtml(item.summary)}</p>`);
    const properties = Array.isArray(item.properties) ? item.properties.filter((property) => property && property.hidden !== true) : [];
    if (properties.length) {
        parts.push("<hr>");
        properties.forEach((property) => {
            const title = [property.name, property.charges ? `(${property.charges})` : ""].filter(Boolean).join(" ");
            if (title) parts.push(`<h3>${escapeHtml(title)}</h3>`);
            if (property.description) parts.push(`<p>${escapeHtml(property.description)}</p>`);
        });
    }
    if (item.notes) {
        parts.push("<hr>");
        parts.push(`<p><em>${escapeHtml(item.notes)}</em></p>`);
    }
    return parts.join("") || `<p>${escapeHtml(item.name || "Oggetto importato dalla wiki.")}</p>`;
}

function buildFoundryItemDataFromWiki(item, folder) {
    const type = mapWikiItemTypeToFoundry(item);
    const description = renderWikiItemDescription(item);
    const preferredFoundryName = getPreferredFoundryItemName(item);
    const foundryNames = Array.from(new Set([
        preferredFoundryName,
        ...getWikiItemFoundryNames(item)
    ].filter(Boolean)));
    const system = {
        description: {
            value: description,
            unidentified: item.unidentifiedDescription ? `<p>${escapeHtml(item.unidentifiedDescription)}</p>` : "",
            chat: ""
        },
        quantity: 1,
        rarity: mapWikiRarityToFoundry(item.rarity),
        identified: item.unidentified !== true,
        attunement: item.attunement === true ? "required" : "",
        attuned: false
    };

    return {
        name: preferredFoundryName,
        type,
        img: resolveWikiAssetUrl(item.image) || "icons/svg/item-bag.svg",
        folder: folder?.id || null,
        system,
        flags: {
            [MODULE_ID]: {
                wikiItemId: item.id || slugify(item.name),
                campaignItemId: item.id || slugify(item.name),
                managedCampaignItem: true,
                wikiItemName: item.name || "",
                preferredFoundryName,
                foundryNames,
                wikiItemUrl: withCampaign(`${getSiteBaseUrl()}/pages/oggetti.html#${encodeURIComponent(item.id || slugify(item.name))}`),
                importedAt: new Date().toISOString()
            }
        }
    };
}

async function getOrCreateWikiItemsFolder() {
    const existing = game.folders.find((folder) => folder.type === "Item" && folder.name === "Cripta Wiki Items");
    if (existing) return existing;
    return Folder.create({ name: "Cripta Wiki Items", type: "Item", sorting: "a" });
}

async function createFoundryItemsFromWiki(items) {
    const folder = await getOrCreateWikiItemsFolder();
    const created = [];
    for (const item of items) {
        const data = buildFoundryItemDataFromWiki(item, folder);
        created.push(await Item.create(data));
    }
    return created;
}

function renderMissingWikiItemsDialog(items) {
    const rows = items.map((item, index) => `
        <label class="cripta-import-item-row">
            <input type="checkbox" name="item" value="${index}" checked>
            ${item.image ? `<img src="${escapeHtml(resolveWikiAssetUrl(item.image))}" alt="">` : `<span class="cripta-import-item-icon"><i class="fas ${escapeHtml(item.icon || "fa-box-open")}"></i></span>`}
            <span>
                <strong>${escapeHtml(item.name || "Oggetto senza nome")}</strong>
                <small>${escapeHtml([
                    `Foundry: ${getPreferredFoundryItemName(item)}`,
                    item.type,
                    item.rarity,
                    item.status === "hidden" ? "Nascosto" : ""
                ].filter(Boolean).join(" | "))}</small>
            </span>
        </label>
    `).join("");

    return `
        <form class="cripta-import-items-form">
            <p>Oggetti presenti nella wiki ma non trovati nel mondo Foundry. Seleziona quelli da creare nella cartella <strong>Cripta Wiki Items</strong>.</p>
            <div class="cripta-import-items-list">${rows}</div>
        </form>
    `;
}

async function openWikiItemsImporter() {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo importare oggetti dalla wiki.");
        return;
    }

    let items;
    try {
        items = getWikiMissingItems(await loadWikiItemsCatalog());
    } catch (error) {
        console.error(`${MODULE_ID} | Import oggetti wiki fallito.`, error);
        ui.notifications.error(`Impossibile leggere gli oggetti dalla wiki: ${error?.message || error}`);
        return;
    }

    if (!items.length) {
        ui.notifications.info("Nessun oggetto wiki mancante in Foundry.");
        return;
    }

    renderDialog({
        title: "Importa oggetti dalla wiki",
        content: renderMissingWikiItemsDialog(items),
        buttons: {
            create: {
                label: "Crea selezionati",
                icon: '<i class="fas fa-file-import"></i>',
                callback: async (html) => {
                    const form = html[0]?.querySelector("form");
                    const indexes = Array.from(new FormData(form).getAll("item")).map((value) => Number(value));
                    const selected = indexes.map((index) => items[index]).filter(Boolean);
                    if (!selected.length) {
                        ui.notifications.warn("Nessun oggetto selezionato.");
                        return;
                    }
                    try {
                        const created = await createFoundryItemsFromWiki(selected);
                        ui.notifications.info(`Creati ${created.length} oggetti dalla wiki.`);
                    } catch (error) {
                        console.error(`${MODULE_ID} | Creazione oggetti wiki fallita.`, error);
                        ui.notifications.error(`Creazione oggetti fallita: ${error?.message || error}`);
                    }
                }
            },
            cancel: {
                label: "Annulla"
            }
        },
        default: "create"
    }, {
        width: 720,
        height: "auto",
        classes: ["cripta-import-items-dialog"]
    });
}

function normalizeTransformationOverrides(payload) {
    const list = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
            ? payload
            : [];
    return list
        .filter((entry) => entry && typeof entry === "object" && entry.enabled !== false && (entry.tokenImage || entry.image))
        .map((entry) => {
            const rawTokenImage = String(entry.tokenImage || entry.image || "").trim();
            const revision = normalizeTransformationRevision(entry.revision || entry.imageRevision);
            return {
                ...entry,
                id: entry.id || `${entry.characterId || entry.ownerAccountId || "player"}-${slugify(entry.creatureName || entry.name || entry.foundryName || "forma")}`,
                actorId: normalizeActorRef(entry.actorId || entry.actorRef || entry.foundryActorId || ""),
                entityId: String(entry.entityId || "").trim(),
                ownerCharacterId: slugify(entry.ownerCharacterId || ""),
                tokenImage: appendMediaRevision(resolveWikiAssetUrl(rawTokenImage), revision),
                remoteTokenImage: normalizeManagedRemotePath(rawTokenImage),
                revision,
                names: [
                    entry.creatureName,
                    entry.name,
                    entry.foundryName,
                    ...(Array.isArray(entry.foundryNames) ? entry.foundryNames : []),
                    ...(Array.isArray(entry.aliases) ? entry.aliases : [])
                ].map(normalizeWikiItemKey).filter(Boolean),
                ownerAliases: [
                    entry.characterId,
                    entry.ownerCharacterId,
                    entry.entityId,
                    entry.actorId,
                    entry.ownerAccountId,
                    entry.ownerDiscordId,
                    ...(Array.isArray(entry.ownerAliases) ? entry.ownerAliases : [])
                ].map(normalizeWikiItemKey).filter(Boolean),
                isCompanion: entry.isCompanion === true
                    || String(entry.characterId || "").startsWith("companion-")
                    || String(entry.entityType || "") === "companion",
                switcher: entry.switcher !== false,
                label: String(entry.label || entry.creatureName || entry.name || entry.foundryName || "").trim(),
                size: getTransformationTokenSize(entry)
            };
        })
        .filter((entry) => entry.tokenImage && entry.names.length && (entry.ownerAliases.length || entry.actorId));
}

function normalizeTransformationRevision(value) {
    const revision = Math.floor(Number(value));
    return Number.isFinite(revision) && revision > 0 ? revision : 1;
}

function appendMediaRevision(path, revision) {
    const value = String(path || "").trim();
    if (!value || !/^https?:/i.test(value)) return value;
    try {
        const url = new URL(value);
        url.searchParams.set("v", String(normalizeTransformationRevision(revision)));
        return url.toString();
    } catch (_) {
        return value;
    }
}

async function loadWikiTransformationOverrides({ force = false, online = false } = {}) {
    const includeOnline = force || online === true;
    const maxAgeMs = includeOnline ? 60 * 1000 : 10 * 60 * 1000;
    if (!force && transformationOverrideCache.loadedAt && Date.now() - transformationOverrideCache.loadedAt < maxAgeMs) {
        return transformationOverrideCache.data;
    }
    if (!force && transformationOverrideCache.promise) return transformationOverrideCache.promise;

    transformationOverrideCache.promise = (async () => {
        let staticData = [];
        try {
            const response = await policyFetch(getSiteDataUrl("transformations.json"), {
                method: "GET",
                headers: { Accept: "application/json" },
                cache: "no-cache"
            });
            if (response.ok) staticData = normalizeTransformationOverrides(await response.json());
        } catch (error) {
            console.warn(`${MODULE_ID} | transformations.json non disponibile.`, error);
        }

        let onlineData = [];
        if (includeOnline) {
            try {
                const response = await policyFetch(withCampaign(`${DISCORD_WORKER_URL}/api/data/transformations`), {
                    method: "GET",
                    headers: { Accept: "application/json" },
                    cache: "no-cache"
                });
                if (response.ok) onlineData = normalizeTransformationOverrides(await response.json());
            } catch (error) {
                console.warn(`${MODULE_ID} | Trasformazioni KV non disponibili.`, error);
            }
        }

        const merged = new Map();
        [...staticData, ...onlineData].forEach((entry) => merged.set(entry.id, entry));
        transformationOverrideCache.data = Array.from(merged.values());
        transformationOverrideCache.loadedAt = Date.now();
        return transformationOverrideCache.data;
    })();

    try {
        return await transformationOverrideCache.promise;
    } finally {
        transformationOverrideCache.promise = null;
    }
}

function buildFoundryActorItemFromWikiAbility(ability, foundry = {}) {
    if (ability?.foundryItem && typeof ability.foundryItem === "object") {
        const itemData = foundry.utils.deepClone(ability.foundryItem);
        delete itemData._id;
        delete itemData.folder;
        delete itemData.sort;
        itemData.name = itemData.name || ability.name || "Abilita";
        itemData.img = resolveWikiAssetUrl(ability.iconImage || ability.img) || itemData.img || "icons/svg/aura.svg";
        return itemData;
    }

    const description = buildWikiAbilityDescription(ability);
    const type = foundryItemTypeFromWikiAbility(ability);
    const effects = buildWikiPassiveEffects(ability, foundry);
    const system = {
        description: { value: description, chat: "" },
        source: { custom: "Sigillo del Male Wiki", revision: 1, rules: "2024" },
        uses: { spent: 0, max: "", recovery: [] },
        activities: buildWikiAbilityActivities(ability, type, effects),
        identifier: "",
        requirements: "",
        type: foundryItemSubtypeFromWikiAbility(type)
    };
    if (type === "weapon") {
        const damageParts = getWikiAbilityDamageParts(ability).filter((part) => part.formula);
        system.quantity = 1;
        system.weight = { value: 0, units: "lb" };
        system.price = { value: 0, denomination: "gp" };
        system.attunement = "";
        system.equipped = true;
        system.rarity = "";
        system.identified = true;
        system.range = buildWikiAbilityWeaponRange(ability);
        system.damage = {
            base: wikiDamageFormulaToDnd5ePart(damageParts[0]?.formula || ability.damageFormula || "", damageParts[0]?.type || ability.damageType || ""),
            versatile: {
                number: null,
                denomination: null,
                types: [],
                custom: { enabled: false },
                scaling: { number: 1 }
            }
        };
        system.unidentified = { description: "" };
        system.container = null;
        system.attuned = false;
        system.cover = null;
        system.crewed = false;
        system.ammunition = {};
        system.armor = { value: null };
        system.magicalBonus = null;
        system.properties = [];
        system.proficient = 1;
    } else {
        system.advancement = [];
        system.cover = null;
        system.crewed = false;
        system.enchant = {};
        system.prerequisites = { level: null, repeatable: false };
        system.properties = [];
    }
    const item = {
        name: ability.name || "Abilita",
        type,
        img: resolveWikiAssetUrl(ability.iconImage || ability.img) || "icons/svg/aura.svg",
        system,
        effects,
        flags: {
            "midi-qol": {},
            dae: {},
            dnd5e: { persistSourceMigration: true },
            [MODULE_ID]: {
                riders: buildWikiRiderFlags(ability),
                passive: buildWikiPassiveFlags(ability)
            },
            ...(ability.flags || {})
        }
    }
    return item;
}

function buildWikiAbilityDescription(ability) {
    const lines = [];
    const base = ability.description ? `<p>${escapeHtml(ability.description)}</p>` : "";
    const passive = buildWikiPassiveFlags(ability);
    if (passive.enabled && passive.value && passive.valueLabel) {
        const displayValue = passive.id === "absorption"
            ? (WIKI_DAMAGE_TYPE_LABELS[passive.value] || passive.value)
            : passive.value;
        lines.push(`${escapeHtml(passive.valueLabel)}: ${escapeHtml(displayValue)}.`);
    }
    if (passive.id === "regeneration" && passive.breakDamageTypes?.length) {
        const labels = passive.breakDamageTypes.map((type) => WIKI_DAMAGE_TYPE_LABELS[type] || type).join(", ");
        lines.push(`Interrotta fino al prossimo turno da: ${escapeHtml(labels)}.`);
    }
    if (!lines.length) return base;
    return [base, `<hr><p><strong>Effetti passivi.</strong> ${lines.join(" ")}</p>`].filter(Boolean).join("");
}

function buildWikiPassiveFlags(ability) {
    const passive = ability?.passive && typeof ability.passive === "object" ? ability.passive : {};
    const id = String(passive.id || "").trim();
    if (!id) return { enabled: false };
    return {
        enabled: true,
        id,
        automation: passive.automation || "manual",
        value: String(ability.passiveValue || "").trim(),
        valueLabel: ability.passiveValueLabel || passive.valueLabel || "",
        breakDamageTypes: normalizeWikiDamageTypeList(ability.passiveBreakDamageTypes)
    };
}

function buildWikiPassiveEffects(ability, foundry = {}) {
    const passive = buildWikiPassiveFlags(ability);
    if (!passive.enabled) return [];
    if (passive.id === "magic-resistance") {
        return [buildWikiTransferEffect("Magic Resistance", "icons/magic/defensive/shield-barrier-glowing-blue.webp", [
            { key: "flags.midi-qol.magicResistance.all", mode: 0, value: "1", priority: 20 }
        ])];
    }
    if (passive.id === "enlarge") {
        const changes = [
            { key: "system.traits.size", mode: 5, value: nextWikiFoundrySize(foundry.size), priority: 20 }
        ];
        if (passive.value) {
            changes.push(
                { key: "system.bonuses.mwak.damage", mode: 2, value: passive.value, priority: 20 },
                { key: "system.bonuses.rwak.damage", mode: 2, value: passive.value, priority: 20 }
            );
        }
        return [buildWikiTemporaryEffect("Enlarge", "icons/magic/control/buff-strength-muscle-damage.webp", changes, {
            seconds: 60,
            rounds: 10
        })];
    }
    if (passive.id === "absorption" && passive.value) {
        return [];
    }
    return [];
}

function nextWikiFoundrySize(size) {
    const order = ["tiny", "sm", "med", "lg", "huge", "grg"];
    const index = order.indexOf(size || "med");
    return order[Math.min(order.length - 1, Math.max(0, index) + 1)] || "lg";
}

function buildWikiTemporaryEffect(name, img, changes, duration = {}) {
    return {
        ...buildWikiTransferEffect(name, img, changes),
        transfer: false,
        duration: {
            startTime: null,
            seconds: duration.seconds ?? null,
            combat: null,
            rounds: duration.rounds ?? null,
            turns: duration.turns ?? null,
            startRound: null,
            startTurn: null
        }
    };
}

function normalizeWikiDamageTypeList(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
    return values
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter((entry) => Object.prototype.hasOwnProperty.call(WIKI_DAMAGE_TYPE_LABELS, entry))
        .filter((entry, index, list) => list.indexOf(entry) === index);
}

function buildWikiTransferEffect(name, img, changes) {
    return normalizeActiveEffectSourceV14({
        _id: `effect${slugify(name).replace(/-/g, "").slice(0, 10).padEnd(10, "0")}`,
        name,
        img,
        origin: null,
        disabled: false,
        transfer: true,
        description: "",
        tint: "#ffffff",
        statuses: [],
        duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
        flags: {
            dae: { showIcon: true, specialDuration: [] },
            "midi-qol": {},
            core: { overlay: false }
        },
        type: "base",
        system: { changes: normalizeActiveEffectChangesV14(changes) },
        sort: 0
    });
}

function buildWikiRiderFlags(ability) {
    const rider = ability.rider || {};
    return {
        enabled: true,
        alwaysConditions: normalizeWikiConditionList(rider.alwaysConditions),
        failConditions: normalizeWikiConditionList(rider.failConditions),
        saveAbility: rider.saveAbility || "",
        saveDc: rider.saveDc || "",
        successMode: rider.successMode || "",
        failDamageParts: getWikiAbilityRiderDamageParts(ability).filter((part) => part.formula),
        advancedEffects: normalizeWikiAdvancedRiderEffects(rider.advancedEffects),
        notes: rider.notes || ""
    };
}

function normalizeWikiAdvancedRiderEffects(effects) {
    return (Array.isArray(effects) ? effects : [])
        .map((effect) => ({
            id: slugify(effect?.id || effect?.name || "advanced-effect"),
            name: String(effect?.name || "Effetto avanzato"),
            timing: String(effect?.timing || "hit"),
            kind: String(effect?.kind || "effect"),
            iconImage: effect?.iconImage || "",
            duration: effect?.duration || {},
            changes: normalizeWikiAdvancedEffectChanges(effect),
            damage: effect?.damage || null,
            endsOnDamageType: effect?.endsOnDamageType || ""
        }));
}

function normalizeWikiAdvancedEffectChanges(effect) {
    const id = String(effect?.id || "");
    return (Array.isArray(effect?.changes) ? effect.changes : []).map((change) => {
        const normalized = { ...change };
        const key = String(normalized.key || "");
        if (id === "half-speed" && key.startsWith("system.attributes.movement.") && String(normalized.value) === "0.5") {
            normalized.mode = 1;
        }
        return normalized;
    });
}

function foundryItemTypeFromWikiAbility(ability) {
    return isWikiAttackAbility(ability) ? "weapon" : (ability.type || "feat");
}

function foundryItemSubtypeFromWikiAbility(type) {
    if (type === "weapon") return { value: "natural", baseItem: "" };
    return { value: "", subtype: "" };
}

function isWikiAttackAbility(ability) {
    return ability?.kind === "attack" || ability?.type === "weapon" || Boolean(ability?.attackBonus);
}

function isWikiRangedAttackAbility(ability) {
    const range = String(ability?.range || "").toLowerCase();
    if (range.includes("/")) return true;
    const value = parseWikiAbilityRangeValue(range);
    return Number.isFinite(value) && value > 10;
}

function buildWikiAbilityActivities(ability, type, effects) {
    if (type === "weapon") {
        const activities = { dnd5eactivity000: buildWikiAbilityAttackActivity(ability, effects) };
        if (hasWikiAbilitySaveRider(ability)) activities.dnd5eactivity001 = buildWikiAbilitySaveActivity(ability, effects, "dnd5eactivity001", { includeBaseDamage: false });
        return activities;
    }
    if (ability.saveAbility || ability.rider?.saveAbility) return { dnd5eactivity000: buildWikiAbilitySaveActivity(ability, effects) };
    return { dnd5eactivity000: buildWikiAbilityUtilityActivity(ability, effects) };
}

function buildWikiAbilityAttackActivity(ability, effects) {
    const ranged = isWikiRangedAttackAbility(ability);
    const attackAbility = ability.attackAbility === "custom" ? "" : (ability.attackAbility || "str");
    const damageParts = getWikiAbilityDamageParts(ability).filter((part) => part.formula);
    return {
        _id: "dnd5eactivity000",
        type: "attack",
        activation: buildWikiActivityActivation(ability),
        consumption: buildWikiActivityConsumption(),
        description: { chatFlavor: "" },
        duration: buildWikiInstantDuration(),
        effects: [],
        range: { units: ranged ? "ft" : "self", special: "", override: false, ...(ranged ? { value: parseWikiAbilityRangeValue(ability.range) || "" } : {}) },
        target: buildWikiSingleCreatureTarget(),
        uses: { spent: 0, max: "", recovery: [] },
        attack: {
            ability: attackAbility,
            bonus: ability.attackAbility === "custom" ? (ability.attackBonus || "") : (ability.attackBonusExtra || ""),
            critical: { threshold: null },
            flat: ability.attackAbility === "custom",
            type: { value: ranged ? "ranged" : "melee", classification: "weapon" }
        },
        damage: {
            critical: { bonus: "" },
            includeBase: true,
            parts: damageParts.slice(1).map((part) => wikiDamageFormulaToDnd5ePart(part.formula, part.type))
        },
        sort: 0,
        ...wikiMidiActivityDefaults(),
        attackMode: "oneHanded",
        ammunition: "",
        otherActivityUuid: ""
    };
}

function buildWikiAbilitySaveActivity(ability, effects, activityId = "dnd5eactivity000", options = {}) {
    const rider = ability.rider || {};
    const damageParts = [
        ...(options.includeBaseDamage === false ? [] : getWikiAbilityDamageParts(ability).filter((part) => part.formula)),
        ...getWikiAbilityRiderDamageParts(ability).filter((part) => part.formula)
    ];
    return {
        _id: activityId,
        type: "save",
        activation: buildWikiActivityActivation(ability),
        consumption: buildWikiActivityConsumption(),
        description: { chatFlavor: "" },
        duration: buildWikiInstantDuration(),
        effects: [],
        range: { value: parseWikiAbilityRangeValue(ability.range) || "", units: parseWikiAbilityRangeUnits(ability.range) || "ft", special: "", override: false },
        target: buildWikiSingleCreatureTarget(),
        uses: { spent: 0, max: "", recovery: [] },
        damage: {
            onSave: rider.successMode === "negates" ? "none" : "half",
            parts: damageParts.map((part) => wikiDamageFormulaToDnd5ePart(part.formula, part.type)),
            critical: { allow: false }
        },
        save: {
            ability: [ability.saveAbility || rider.saveAbility || "con"],
            dc: { calculation: "", formula: String(ability.saveDc || rider.saveDc || "") }
        },
        sort: 0,
        ...wikiMidiActivityDefaults()
    };
}

function hasWikiAbilitySaveRider(ability) {
    const rider = ability.rider || {};
    return Boolean(
        rider.saveAbility
        || rider.saveDc
        || getWikiAbilityRiderDamageParts(ability).some((part) => part.formula)
        || normalizeWikiConditionList(rider.failConditions).length
    );
}

function buildWikiAbilityUtilityActivity(ability, effects) {
    return {
        _id: "dnd5eactivity000",
        type: "utility",
        activation: buildWikiActivityActivation(ability),
        consumption: buildWikiActivityConsumption(),
        description: { chatFlavor: "" },
        duration: buildWikiInstantDuration(),
        effects: effects.map((effect) => ({ _id: effect._id })),
        range: { units: "self", special: "", override: false },
        target: buildWikiSingleCreatureTarget(),
        uses: { spent: 0, max: "", recovery: [] },
        roll: { formula: "", name: "", prompt: false, visible: false },
        sort: 0,
        ...wikiMidiActivityDefaults(),
        otherActivityId: "none"
    };
}

function buildWikiActivityActivation(ability) {
    return { type: ability.activation || activationFromWikiAbilitySection(ability.section), value: 1, condition: "", override: false };
}

function buildWikiActivityConsumption() {
    return { targets: [], scaling: { allowed: false, max: "" }, spellSlot: true };
}

function buildWikiInstantDuration() {
    return { concentration: false, units: "inst", special: "", override: false };
}

function buildWikiSingleCreatureTarget() {
    return {
        template: { count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "" },
        affects: { count: "1", type: "creature", choice: false, special: "" },
        prompt: true,
        override: false
    };
}

function wikiMidiActivityDefaults() {
    return {
        useConditionText: "",
        useConditionReason: "",
        effectConditionText: "",
        macroData: { name: "", command: "" },
        ignoreTraits: { idi: false, idr: false, idv: false, ida: false },
        midiProperties: {
            ignoreTraits: [],
            triggeredActivityId: "none",
            triggeredActivityConditionText: "",
            triggeredActivityTargets: "targets",
            triggeredActivityRollAs: "self",
            forceDialog: false,
            confirmTargets: "default",
            autoTargetType: "any",
            autoTargetAction: "default",
            automationOnly: false,
            otherActivityCompatible: true,
            identifier: "",
            displayActivityName: false,
            rollMode: "default",
            chooseEffects: false,
            toggleEffect: false,
            ignoreFullCover: false
        },
        isOverTimeFlag: false,
        overTimeProperties: { saveRemoves: true, preRemoveConditionText: "", postRemoveConditionText: "" },
        otherActivityId: ""
    };
}

function buildWikiConditionEffect(name, statuses, description) {
    return normalizeActiveEffectSourceV14({
        name,
        img: wikiConditionEffectIcon(statuses),
        origin: null,
        disabled: false,
        transfer: false,
        description,
        tint: "#ffffff",
        statuses,
        duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
        flags: { dae: {}, "midi-qol": {} },
        type: "base",
        system: { changes: normalizeActiveEffectChangesV14(wikiConditionChanges(statuses)) },
        sort: 0
    });
}

function wikiConditionChanges(statuses) {
    if (!statuses.includes("grappled")) return [];
    return ["walk", "fly", "swim", "climb", "burrow"].map((movement) => ({
        key: `system.attributes.movement.${movement}`,
        mode: 5,
        value: "0",
        priority: 20
    }));
}

function wikiConditionEffectIcon(statuses) {
    if (statuses.includes("grappled") || statuses.includes("restrained")) return "icons/svg/net.svg";
    if (statuses.includes("prone")) return "icons/svg/falling.svg";
    if (statuses.includes("poisoned")) return "icons/svg/poison.svg";
    if (statuses.includes("frightened")) return "icons/svg/terror.svg";
    return "icons/svg/aura.svg";
}

function wikiDamageFormulaToDnd5ePart(formula, type) {
    const cleanFormula = String(formula || "").trim();
    const match = cleanFormula.match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i);
    if (match) {
        return {
            number: Number(match[1]),
            denomination: Number(match[2]),
            bonus: match[3] ? match[3].replace(/\s+/g, "") : "",
            types: type ? [type] : [],
            custom: { enabled: false, formula: "" },
            scaling: { mode: "whole", number: null, formula: "" }
        };
    }
    return {
        number: null,
        denomination: null,
        bonus: "",
        types: type ? [type] : [],
        custom: { enabled: Boolean(cleanFormula), formula: cleanFormula },
        scaling: { mode: "whole", number: null, formula: "" }
    };
}

function buildWikiAbilityWeaponRange(ability) {
    if (isWikiRangedAttackAbility(ability)) {
        return { value: parseWikiAbilityRangeValue(ability.range), long: null, units: parseWikiAbilityRangeUnits(ability.range) || "ft" };
    }
    return { value: null, long: null, units: "self", reach: parseWikiAbilityRangeValue(ability.range) || 5 };
}

function getWikiAbilityDamageParts(ability) {
    const parts = Array.isArray(ability?.damageParts) ? ability.damageParts : [];
    return parts.map((part) => ({
        formula: String(part?.formula || part?.damage || "").trim(),
        type: String(part?.type || part?.damageType || "").trim()
    }));
}

function getWikiAbilityRiderDamageParts(ability) {
    const parts = Array.isArray(ability?.rider?.failDamageParts) ? ability.rider.failDamageParts : [];
    return parts.map((part) => ({
        formula: String(part?.formula || part?.damage || "").trim(),
        type: String(part?.type || part?.damageType || "").trim()
    }));
}

function normalizeWikiConditionList(values) {
    const aliases = {
        accecato: "blinded",
        affascinato: "charmed",
        assordato: "deafened",
        spaventato: "frightened",
        afferrato: "grappled",
        incapacitato: "incapacitated",
        invisibile: "invisible",
        paralizzato: "paralyzed",
        pietrificato: "petrified",
        avvelenato: "poisoned",
        prono: "prone",
        trattenuto: "restrained",
        stordito: "stunned",
        "privo-di-sensi": "unconscious",
        indebolimento: "exhaustion"
    };
    return (Array.isArray(values) ? values : [])
        .map((value) => {
            const key = slugify(value);
            return aliases[key] || key;
        })
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index);
}

function parseWikiAbilityRangeValue(value) {
    return toLeadingNumberOrNull(value);
}

function parseWikiAbilityRangeUnits(value) {
    return String(value || "").trim() ? "ft" : "";
}

function activationFromWikiAbilitySection(section) {
    return {
        bonus: "bonus",
        reaction: "reaction",
        legendary: "legendary"
    }[section] || "action";
}

function mapFoundrySizeToWikiSize(value) {
    const key = String(value || "").toLowerCase();
    const map = {
        tiny: "Minuscola",
        sm: "Piccola",
        small: "Piccola",
        med: "Media",
        medium: "Media",
        lg: "Grande",
        large: "Grande",
        huge: "Enorme",
        grg: "Mastodontica",
        gargantuan: "Mastodontica"
    };
    return map[key] || "Media";
}

function mapFoundryTypeToWikiType(value) {
    const raw = typeof value === "object" && value ? (value.value || value.custom || value.subtype || "") : value;
    const key = normalizeWikiItemKey(raw);
    const map = {
        aberration: "Aberrazione",
        beast: "Bestia",
        celestial: "Celestiale",
        construct: "Costrutto",
        dragon: "Drago",
        elemental: "Elementale",
        fey: "Folletto",
        fiend: "Immondo",
        genie: "Genio",
        giant: "Gigante",
        humanoid: "Umanoide",
        monstrosity: "Mostruosita",
        ooze: "Melma",
        plant: "Pianta",
        undead: "Non morto"
    };
    return map[key] || String(raw || "Creatura").trim();
}

function mapFoundryDamageListToWikiLabels(values) {
    return (Array.isArray(values) ? values : [])
        .map((value) => WIKI_DAMAGE_TYPE_LABELS[String(value || "").trim().toLowerCase()] || String(value || "").trim())
        .filter(Boolean);
}

function mapFoundryConditionListToWikiLabels(values) {
    const labels = {
        blinded: "Accecato",
        charmed: "Affascinato",
        deafened: "Assordato",
        frightened: "Spaventato",
        grappled: "Afferrato",
        incapacitated: "Incapacitato",
        invisible: "Invisibile",
        paralyzed: "Paralizzato",
        petrified: "Pietrificato",
        poisoned: "Avvelenato",
        prone: "Prono",
        restrained: "Trattenuto",
        stunned: "Stordito",
        unconscious: "Privo di sensi",
        exhaustion: "Indebolimento"
    };
    return (Array.isArray(values) ? values : [])
        .map((value) => labels[String(value || "").trim().toLowerCase()] || String(value || "").trim())
        .filter(Boolean);
}

function stripFoundryHtml(value) {
    const html = String(value || "").trim();
    if (!html) return "";
    const element = document.createElement("div");
    element.innerHTML = html;
    return String(element.textContent || element.innerText || "").replace(/\s+/g, " ").trim();
}

function getFoundryDescriptionHtml(document) {
    return String(document?.system?.description?.value || document?.system?.details?.biography?.value || "").trim();
}

function getActorMovementValue(actor, key) {
    const value = actor?.system?.attributes?.movement?.[key];
    if (typeof value === "object" && value) return Number(value.value) || 0;
    return Number(value) || 0;
}

function getActorSensesData(actor) {
    const senses = actor?.system?.attributes?.senses || {};
    return Object.fromEntries(Object.entries(senses)
        .filter(([, value]) => Number(typeof value === "object" && value ? value.value : value) > 0)
        .map(([key, value]) => [key, Number(typeof value === "object" && value ? value.value : value) || 0]));
}

function getActorTraitsList(actor, key) {
    const trait = actor?.system?.traits?.[key];
    if (Array.isArray(trait?.value)) return trait.value;
    if (trait?.value instanceof Set) return Array.from(trait.value);
    return [];
}

function buildWikiAbilityFromFoundryItem(item) {
    const itemData = item.toObject();
    const activities = Object.values(itemData.system?.activities || {});
    const primaryActivity = activities[0] || {};
    const descriptionHtml = getFoundryDescriptionHtml(itemData);
    const type = String(itemData.type || "");
    const kind = primaryActivity.type === "attack"
        ? "attack"
        : primaryActivity.type === "save"
            ? "save"
            : type === "spell"
                ? "spell"
                : "passive";

    return {
        id: slugify(item.name || item.id || "abilita"),
        name: item.name || "Abilita",
        kind,
        type,
        iconImage: item.img || "",
        description: stripFoundryHtml(descriptionHtml),
        foundryItem: itemData
    };
}

function buildWikiNpcEntryFromActor(actor, images = {}) {
    const actorData = actor.toObject();
    const system = actorData.system || {};
    const details = system.details || {};
    const description = stripFoundryHtml(getFoundryDescriptionHtml(actorData));
    const id = slugify(actor.name || actor.id || "npc");
    const typeLabel = mapFoundryTypeToWikiType(details.type);
    const race = [
        mapFoundrySizeToWikiSize(system.traits?.size),
        typeLabel
    ].filter(Boolean).join(" ");
    const tokenImage = images.token
        || extractWorkerMediaPath(actor.prototypeToken?.texture?.src || actor.prototypeToken?.img)
        || actor.prototypeToken?.texture?.src
        || actor.prototypeToken?.img
        || "assets/img/logo.webp";
    const avatarImage = images.avatar
        || extractWorkerMediaPath(actor.img)
        || actor.img
        || "assets/img/logo.webp";
    const imageSet = {
        token: tokenImage,
        avatar: avatarImage
    };
    if (images.idle) imageSet.idle = images.idle;
    if (images.hover) imageSet.hover = images.hover;

    return {
        id,
        name: actor.name || "NPC Foundry",
        type: "npc",
        role: details.type?.value || typeLabel || "NPC",
        status: "ignoto",
        hidden: false,
        quote: description ? description.split(/\n+/)[0].slice(0, 180) : "",
        images: imageSet,
        summary: {
            race,
            height: "",
            weight: ""
        },
        blocks: [
            {
                id: "biografia",
                type: "text",
                title: "Biografia",
                icon: "fa-book-open",
                hidden: false,
                text: description || `Voce generata da Foundry per ${actor.name}.`
            }
        ],
        foundry: {
            source: "foundry-export",
            actorId: actor.id,
            actorUuid: actor.uuid,
            exportedAt: new Date().toISOString()
        }
    };
}

async function uploadNpcActorImage(actor, source, folder, filename) {
    const raw = String(source || "").trim();
    if (!raw) return "";
    const existingMediaPath = extractWorkerMediaPath(raw)
        || (raw.startsWith("/media/") ? raw.replace(/^\/+/, "") : "");
    const imageSource = existingMediaPath
        ? `${DISCORD_WORKER_URL.replace(/\/+$/, "")}/${existingMediaPath}`
        : raw;
    const blob = await imagePathToWebpBlobPreserveSize(imageSource, 0.96);
    return uploadRawMediaBlobToWorker(blob, filename, folder);
}

function findNpcEntryForActor(records, actor) {
    const actorName = normalizeWikiItemKey(actor?.name || "");
    const actorId = String(actor?.id || "");
    const actorUuid = String(actor?.uuid || "");
    return (Array.isArray(records) ? records : []).find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        if (actorId && entry.foundry?.actorId === actorId) return true;
        if (actorUuid && entry.foundry?.actorUuid === actorUuid) return true;
        const names = [
            entry.name,
            ...(Array.isArray(entry.aliases) ? entry.aliases : [])
        ].map(normalizeWikiItemKey).filter(Boolean);
        return names.includes(actorName);
    }) || null;
}

async function exportActorToWikiNpc(actor, { updateExisting = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo creare NPC nella wiki.");
        return false;
    }
    if (!actor || actor.type !== "npc") {
        ui.notifications.warn("Apri la scheda di un NPC per esportarlo nella sezione NPC.");
        return false;
    }

    const loaded = await requestNotesApi("api/data/characters");
    const records = Array.isArray(loaded?.data) ? loaded.data : [];
    const expectedVersion = loaded?.source === "kv" ? (loaded.version ?? 0) : 0;
    const existing = findNpcEntryForActor(records, actor);
    if (existing && !updateExisting) {
        const confirmed = await confirmDialog({
            title: "NPC gia presente",
            content: `<p><strong>${escapeHtml(existing.name || actor.name)}</strong> sembra gia presente nella wiki. Vuoi aggiornarlo con i dati dell'actor Foundry?</p>`,
            yes: () => true,
            no: () => false,
            defaultYes: false
        });
        if (!confirmed) {
            ui.notifications.info("Export NPC annullato.");
            return false;
        }
    }

    const slug = slugify(existing?.id || actor.name || actor.id || "npc");
    const folder = `characters/${slug}`;
    const tokenSource = actor.prototypeToken?.texture?.src || actor.prototypeToken?.img || actor.img;
    const images = {
        idle: existing?.images?.idle || "",
        avatar: existing?.images?.avatar || "",
        hover: existing?.images?.hover || "",
        token: existing?.images?.token || ""
    };

    try {
        images.token = await uploadNpcActorImage(actor, tokenSource, folder, "token.webp") || images.token;
        if (images.token) {
            await registerManagedMedia(actor, "token", {
                remote: images.token,
                local: tokenSource,
                entityType: "npc",
                entityId: slug,
                actor
            });
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Token NPC non esportato, uso fallback token/actor.`, error);
    }
    try {
        images.avatar = await uploadNpcActorImage(actor, actor.img, folder, "avatar.webp") || images.avatar;
        if (images.avatar) {
            await registerManagedMedia(actor, "avatar", {
                remote: images.avatar,
                local: actor.img,
                entityType: "npc",
                entityId: slug,
                actor
            });
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Avatar NPC non esportato, uso fallback actor.img.`, error);
    }

    const exported = buildWikiNpcEntryFromActor(actor, images);
    const nextEntry = existing
        ? {
            ...existing,
            ...exported,
            id: existing.id || exported.id,
            role: existing.role || exported.role,
            status: existing.status || exported.status,
            hidden: Boolean(existing.hidden),
            quote: existing.quote || exported.quote,
            images: {
                ...exported.images,
                ...existing.images,
                idle: images.idle || existing.images?.idle || exported.images.idle,
                hover: images.hover || existing.images?.hover || exported.images.hover,
                token: images.token || existing.images?.token || exported.images.token,
                avatar: images.avatar || existing.images?.avatar || exported.images.avatar
            },
            blocks: Array.isArray(existing.blocks) && existing.blocks.length ? existing.blocks : exported.blocks,
            foundry: {
                ...(existing.foundry || {}),
                ...exported.foundry
            }
        }
        : exported;

    const nextRecords = existing
        ? records.map((entry) => entry === existing ? nextEntry : entry)
        : [...records, nextEntry];
    nextRecords.sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "it"));

    await requestNotesApi("api/data/characters", {
        method: "POST",
        body: {
            data: nextRecords,
            expectedVersion
        }
    });

    await actor.setFlag(MODULE_ID, "wikiNpcId", nextEntry.id || slug);
    await actor.setFlag(MODULE_ID, "wikiNpcName", nextEntry.name || actor.name);
    ui.notifications.info(`${actor.name} esportato come NPC wiki.`);
    console.info(`${MODULE_ID} | Actor esportato negli NPC wiki.`, { actor: actor.name, id: nextEntry.id, updated: Boolean(existing) });
    return true;
}

function openModuleUpdateDialog() {
    const manifestUrl = game.modules.get(MODULE_ID)?.manifest || MODULE_UPDATE_MANIFEST_URL;
    const content = `
        <form class="cripta-module-update">
            <p>Per aggiornare gli altri DM, installa il modulo usando questo manifest. Dopo l'installazione, Foundry potra controllare e scaricare gli aggiornamenti senza inviare file manualmente.</p>
            <label>
                <span>Manifest pubblico</span>
                <input type="text" value="${escapeHtml(manifestUrl)}" readonly>
            </label>
            <p class="notes">Quando pubblichi una nuova versione, aumenta <code>version</code>, esegui <code>npm run build:module</code> e pubblica <code>dist/module.json</code> + <code>dist/cripta-wiki-sync.zip</code>.</p>
        </form>
    `;
    renderDialog({
        title: "Aggiorna modulo",
        content,
        buttons: {
            copy: {
                icon: '<i class="fas fa-copy"></i>',
                label: "Copia manifest",
                callback: async () => {
                    await navigator.clipboard?.writeText(manifestUrl);
                    ui.notifications.info("Manifest modulo copiato.");
                }
            },
            packages: {
                icon: '<i class="fas fa-box-open"></i>',
                label: "Gestione moduli",
                callback: () => {
                    if (typeof game.shutDown === "function") {
                        ui.notifications.info("Apri Setup > Add-on Modules e usa il manifest copiato.");
                    } else {
                        ui.notifications.info("Apri la schermata Setup di Foundry e aggiorna il modulo dagli Add-on Modules.");
                    }
                }
            },
            close: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Chiudi"
            }
        }
    }, {
        width: 560,
        classes: ["cripta-module-update-dialog"]
    });
}
function openWikiSyncPanel() {
    if (!game.user?.isGM) {
        ui.notifications.warn("Solo il GM puo usare il pannello Wiki Sync.");
        return;
    }

    const actions = [
        {
            id: "update-module",
            icon: "fas fa-download",
            title: "Aggiorna modulo",
            description: "Apri le istruzioni per installare o aggiornare il modulo sugli altri server Foundry.",
            scope: "Installazione", opensDialog: true,
            run: () => openModuleUpdateDialog()
        },
        {
            id: "sync-characters",
            icon: "fas fa-cloud-arrow-up",
            title: "Invia personaggi al sito",
            description: "Invia subito le schede e gli inventari aggiornati, senza attendere la sincronizzazione automatica.",
            scope: "Foundry → sito",
            run: () => syncCharactersToWorker({ notify: true, force: true })
        },
        {
            id: "sync-campaign-items",
            icon: "fas fa-vault",
            title: "Sincronizza catalogo oggetti",
            description: "Allinea il catalogo della campagna, la cartella oggetti e le copie collegate negli inventari.",
            scope: "Catalogo e inventari",
            run: () => reconcileCampaignItemsNow({ notify: true })
        },
        {
            id: "sync-status",
            icon: "fas fa-signal",
            title: "Controlla stato sincronizzazione",
            description: "Consulta lo stato dei dati sul sito senza modificare le schede o scaricare immagini.",
            scope: "Sola lettura", opensDialog: true,
            run: () => openWorkerSyncStatusDialog()
        },
        {
            id: "bootstrap-media-fallbacks",
            icon: "fas fa-hard-drive",
            title: "Scarica copie locali delle immagini",
            description: "Conserva in Foundry una copia delle immagini già collegate, da usare quando il sito non è disponibile.",
            scope: "Sito → archivio locale",
            run: () => bootstrapManagedMediaFallbacksFromR2({ notify: true })
        },
        {
            id: "apply-asset-sync-jobs",
            icon: "fas fa-list-check",
            title: "Applica richieste Asset Sync",
            description: "Esegui le richieste che hai selezionato nella pagina Asset Sync del sito.",
            scope: "Richieste dal sito",
            run: () => applyQueuedAssetSyncJobsFromWiki({ notify: true })
        },
        {
            id: "apply-ability-overrides",
            icon: "fas fa-wand-magic-sparkles",
            title: "Aggiorna descrizioni e icone delle abilità",
            description: "Applica alle capacità in Foundry le modifiche alle descrizioni e alle icone effettuate sul sito.",
            scope: "Sito → Foundry",
            run: () => applyAbilityOverridesFromWiki({ notify: true })
        },
        {
            id: "preview-skill-tree-abilities",
            icon: "fas fa-list-check",
            title: "Verifica abilità alberi",
            description: "Mostra le differenze tra sito e schede, comprese le capacità il cui collegamento richiede una verifica.",
            scope: "Sola lettura", opensDialog: true,
            run: () => showSkillTreeSyncPreview()
        },
        {
            id: "sync-skill-tree-abilities",
            icon: "fas fa-crown",
            title: "Allinea abilità alberi",
            description: "Applica gli sblocchi degli alberi attivi alle schede. Le capacità ritirate conservano una copia di recupero.",
            scope: "Sito → Foundry", featured: true,
            run: () => syncUnlockedSkillTreeAbilitiesToFoundry({ notify: true, force: true })
        },
        {
            id: "apply-item-overrides",
            icon: "fas fa-box-open",
            title: "Aggiorna descrizioni e icone degli oggetti",
            description: "Applica agli oggetti in Foundry le modifiche alle descrizioni e alle icone effettuate sul sito.",
            scope: "Sito → Foundry",
            run: () => applyItemOverridesFromWiki({ notify: true })
        },
        {
            id: "sync-ability-icons",
            icon: "fas fa-images",
            title: "Invia icone delle abilità",
            description: "Carica sul sito le icone delle capacità dei personaggi, ottimizzate per la consultazione.",
            scope: "Foundry → sito",
            run: () => syncAbilityIconsToWiki({ notify: true })
        },
        {
            id: "sync-item-icons",
            icon: "fas fa-boxes-stacked",
            title: "Invia icone dell’inventario",
            description: "Carica sul sito le icone degli oggetti posseduti dai personaggi.",
            scope: "Foundry → sito",
            run: () => syncInventoryItemIconsToWiki({ notify: true })
        },
        {
            id: "sync-character-images",
            icon: "fas fa-user-circle",
            title: "Invia immagini dei personaggi",
            description: "Carica avatar e token dei personaggi che non sono ancora presenti sul sito.",
            scope: "Foundry → sito",
            run: () => syncCharacterImagesToWiki({ notify: true })
        },
        {
            id: "apply-character-media-overrides",
            icon: "fas fa-id-card-clip",
            title: "Aggiorna immagini dal sito",
            description: "Applica in Foundry gli avatar e i token di personaggi e compagni modificati sul sito.",
            scope: "Sito → Foundry",
            run: () => applyCharacterMediaOverridesFromWiki({ notify: true })
        },
        {
            id: "sync-tokenizer",
            icon: "fas fa-retweet",
            title: "Sincronizza varianti token",
            description: "Aggiorna Khuzoe Tokenizer con le trasformazioni configurate sulla wiki.",
            scope: "Sito → Tokenizer",
            run: () => syncTransformationsToTokenizer({ force: true, notify: true })
        }
    ];

    const sections = [
        { id: "characters", title: "Personaggi e abilità", icon: "fas fa-user-group",
            description: "Confronta gli alberi delle abilità con le schede e applica gli aggiornamenti.",
            actions: ["preview-skill-tree-abilities", "sync-skill-tree-abilities", "sync-characters", "apply-ability-overrides"] },
        { id: "items", title: "Oggetti", icon: "fas fa-box-open",
            description: "Gestisci il catalogo della campagna e gli oggetti negli inventari.",
            actions: ["sync-campaign-items", "apply-item-overrides"] },
        { id: "images", title: "Immagini e token", icon: "fas fa-images",
            description: "Scegli quali immagini inviare al sito o recuperare in Foundry.",
            actions: ["apply-character-media-overrides", "sync-character-images", "sync-tokenizer", "sync-ability-icons", "sync-item-icons", "apply-asset-sync-jobs", "bootstrap-media-fallbacks"] },
        { id: "status", title: "Stato e aggiornamenti", icon: "fas fa-sliders",
            description: "Consulta lo stato della sincronizzazione e le istruzioni per aggiornare il modulo.",
            actions: ["sync-status", "update-module"] }
    ];
    const panelId = `cripta-sync-${foundry.utils.randomID()}`;
    const modeLabel = getSyncPolicyStatus().label;
    const renderActionRows = (entries) => entries.map((action) => `
        <button type="button" class="cripta-sync-panel-action${action.featured ? " is-featured" : ""}" data-cripta-sync-action="${escapeHtml(action.id)}">
            <i class="cripta-sync-action-icon ${escapeHtml(action.icon)}" aria-hidden="true"></i>
            <span class="cripta-sync-action-copy">
                <span class="cripta-sync-action-scope">${escapeHtml(action.scope)}</span>
                <strong>${escapeHtml(action.title)}</strong>
                <small>${escapeHtml(action.description)}</small>
            </span>
            <i class="cripta-sync-action-arrow fas fa-chevron-right" aria-hidden="true"></i>
        </button>
    `).join("");

    return renderDialog({
        title: "Khuzoe Wiki Sync",
        content: `
            <div class="cripta-sync-panel">
                <header class="cripta-sync-panel-header">
                    <div class="cripta-sync-panel-brand"><i class="fas fa-book-open" aria-hidden="true"></i>
                        <div><h1>Wiki Sync</h1><p>La tua campagna, tra sito e Foundry.</p></div>
                    </div>
                    <div class="cripta-sync-panel-mode"><span>Modalità sincronizzazione</span><strong>${escapeHtml(modeLabel)}</strong></div>
                </header>
                <div class="cripta-sync-panel-workspace">
                    <nav class="cripta-sync-panel-tabs" role="tablist" aria-label="Sezioni Wiki Sync" aria-orientation="vertical">
                        ${sections.map((section, index) => `
                            <button type="button" role="tab" id="${panelId}-tab-${section.id}" aria-controls="${panelId}-${section.id}"
                                aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-cripta-sync-tab="${section.id}">
                                <i class="${section.icon}" aria-hidden="true"></i><span>${section.title}</span>
                            </button>`).join("")}
                    </nav>
                    <div class="cripta-sync-panel-pages">
                        ${sections.map((section, index) => `
                            <section role="tabpanel" id="${panelId}-${section.id}" aria-labelledby="${panelId}-tab-${section.id}"
                                data-cripta-sync-page="${section.id}" tabindex="0" ${index === 0 ? "" : "hidden"}>
                                <header class="cripta-sync-section-heading"><h2>${section.title}</h2><p>${section.description}</p></header>
                                <div class="cripta-sync-panel-actions">${renderActionRows(section.actions.map(id => actions.find(action => action.id === id)))}</div>
                            </section>`).join("")}
                    </div>
                </div>
                <p class="cripta-sync-panel-feedback" role="status" aria-live="polite">Scegli un comando. La verifica degli alberi mostra un’anteprima delle differenze.</p>
            </div>
        `,
        buttons: {
            close: {
                icon: '<i class="fas fa-xmark"></i>',
                label: "Chiudi"
            }
        },
        render: (html) => {
            const root = html instanceof HTMLElement ? html : html[0];
            if (!root) return;
            const tabs = [...root.querySelectorAll("[data-cripta-sync-tab]")];
            const pages = [...root.querySelectorAll("[data-cripta-sync-page]")];
            const activate = tab => {
                for (const entry of tabs) {
                    entry.setAttribute("aria-selected", String(entry === tab));
                    entry.tabIndex = entry === tab ? 0 : -1;
                }
                for (const page of pages) page.hidden = page.dataset.criptaSyncPage !== tab.dataset.criptaSyncTab;
                root.querySelector(".cripta-sync-panel-pages").scrollTop = 0;
            };
            tabs.forEach((tab, index) => {
                tab.addEventListener("click", () => activate(tab));
                tab.addEventListener("keydown", event => {
                    let next;
                    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (index + 1) % tabs.length;
                    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (index + tabs.length - 1) % tabs.length;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = tabs.length - 1;
                    else return;
                    event.preventDefault(); event.stopPropagation();
                    activate(tabs[next]); tabs[next].focus();
                });
            });
            const feedback = root.querySelector(".cripta-sync-panel-feedback");
            root?.querySelectorAll?.("[data-cripta-sync-action]").forEach((button) => {
                button.addEventListener("click", async () => {
                    const action = actions.find((entry) => entry.id === button.dataset.criptaSyncAction);
                    if (!action) return;
                    button.disabled = true;
                    button.setAttribute("aria-busy", "true");
                    button.classList.add("is-running");
                    const icon = button.querySelector(".cripta-sync-action-icon");
                    const originalIcon = icon.className;
                    icon.className = "cripta-sync-action-icon fas fa-spinner fa-spin";
                    feedback.textContent = `${action.title}: in corso…`;
                    try {
                        const result = await action.run();
                        feedback.textContent = `${action.title}: ${result === false ? "operazione non eseguita" : action.opensDialog ? "pannello aperto" : "completato"}.`;
                    } catch (error) {
                        console.error(`${MODULE_ID} | Azione Wiki Sync fallita.`, { action: action.id, error });
                        feedback.textContent = `${action.title}: ${error?.message || error}`;
                        ui.notifications.error(`${action.title} fallito: ${error?.message || error}`);
                    } finally {
                        button.disabled = false;
                        button.removeAttribute("aria-busy");
                        button.classList.remove("is-running");
                        icon.className = originalIcon;
                    }
                });
            });
        }
    }, {
        width: Math.min(920, window.innerWidth - 32),
        height: Math.min(800, window.innerHeight - 48),
        resizable: true,
        classes: ["cripta-sync-panel-dialog"]
    });
}

function parseNotesContent(content) {
    const raw = String(content || "").trim();
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.notes)) return parsed.notes;
    } catch (_) {
        // Legacy/plain notes are not expected here, but keep them readable.
    }

    return [];
}

function serializeNotesContent(notes, ownerDiscordId) {
    return JSON.stringify({
        version: 2,
        page: "appunti",
        ownerDiscordId,
        targetDiscordId: ownerDiscordId,
        notes
    });
}

function htmlToPlainText(html) {
    const root = document.createElement("div");
    root.innerHTML = String(html || "");

    let output = "";
    const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
    const appendNewline = (count = 1) => {
        const suffix = "\n".repeat(count);
        output = `${output.replace(/\s+$/g, "")}${suffix}`;
    };
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            output += node.nodeValue || "";
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        if (node.tagName === "BR") {
            appendNewline(1);
            return;
        }

        const isBlock = blockTags.has(node.tagName);
        if (isBlock && output.trim() && !output.endsWith("\n")) appendNewline(1);
        node.childNodes.forEach(walk);
        if (isBlock) appendNewline(2);
    };

    root.childNodes.forEach(walk);
    return output
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function plainTextToNoteHtml(text) {
    const blocks = String(text || "")
        .replace(/\r\n/g, "\n")
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);
    if (!blocks.length) return "<p></p>";
    return blocks.map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join("");
}

function appendTextToNoteHtml(currentHtml, text) {
    const addition = plainTextToNoteHtml(text);
    if (!String(text || "").trim()) return currentHtml || "<p></p>";
    const current = String(currentHtml || "").trim();
    if (!current || current === "<p></p>") return addition;
    return `${current}${addition}`;
}

function normalizeAutoLoginKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function compactAutoLoginKey(value) {
    return normalizeAutoLoginKey(value).replace(/\s+/g, "");
}

function autoLoginKeyMatches(configKey, userKey) {
    const normalizedConfig = normalizeAutoLoginKey(configKey);
    const normalizedUser = normalizeAutoLoginKey(userKey);
    const compactConfig = compactAutoLoginKey(configKey);
    const compactUser = compactAutoLoginKey(userKey);

    if (!normalizedConfig || !normalizedUser) return false;
    if (normalizedConfig === normalizedUser) return true;
    if (compactConfig && compactConfig === compactUser) return true;
    if (normalizedUser.includes(normalizedConfig)) return true;
    if (compactConfig && compactUser.includes(compactConfig)) return true;
    return false;
}

function getConfiguredDeviceCodeForCurrentUser() {
    const configured = parseAutoDeviceLoginConfig();
    const userKeys = [
        game.user?.id,
        game.user?.name
    ].map((key) => String(key || "").trim()).filter(Boolean);

    if (!userKeys.length) return "";

    for (const [configKey, code] of configured.entries()) {
        if (code && userKeys.some((candidate) => autoLoginKeyMatches(configKey, candidate))) return code;
    }

    return "";
}

function parseAutoDeviceLoginConfig() {
    let rawConfig = "";
    try {
        rawConfig = String(game.settings.get(MODULE_ID, SETTINGS.AUTO_DEVICE_LOGIN_CODES) || "");
    } catch (_) {
        return new Map();
    }

    const entries = rawConfig
        .split(/\r?\n|;/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    const configured = new Map();
    for (const entry of entries) {
        const [rawUserKey, rawCode] = entry.includes("|")
            ? entry.split("|")
            : entry.includes("=")
                ? entry.split("=")
                : entry.split(":");

        const userKey = String(rawUserKey || "").trim();
        const code = String(rawCode || "").trim();
        if (userKey && code) configured.set(userKey, code);
    }

    return configured;
}

async function tryAutomaticDeviceLogin() {
    const code = getConfiguredDeviceCodeForCurrentUser();
    if (!code) return false;

    try {
        await loginWithDeviceCode(code);
        return true;
    } catch (error) {
        ui.notifications.warn(`Login automatico con codice fallito: ${error?.message || error}`);
        return false;
    }
}

function seedDefaultAutoLoginCodes() {
    if (!game.user?.isGM) return;

    try {
        const current = String(game.settings.get(MODULE_ID, SETTINGS.AUTO_DEVICE_LOGIN_CODES) || "").trim();
        if (current) return;
        game.settings.set(MODULE_ID, SETTINGS.AUTO_DEVICE_LOGIN_CODES, DEFAULT_AUTO_DEVICE_LOGIN_CODES).catch(() => {});
    } catch (_) {
        // Ignore settings that are not ready or not writable.
    }
}

async function promptDeviceLoginIfNeeded() {
    const session = await getValidAuthSession();
    if (session?.user) return;
    const didAutoLogin = await tryAutomaticDeviceLogin();
    if (didAutoLogin) return;
    promptDeviceLogin();
}

function scheduleUnlockedSkillTreeAbilitySync({ force = true, delay = 900 } = {}) {
    if (!canPullFromWorker() || !isSkillTreeSyncLeader(game)) return;
    window.clearTimeout(skillTreeAbilitySyncTimer);
    skillTreeAbilitySyncTimer = window.setTimeout(() => {
        skillTreeAbilitySyncTimer = null;
        syncUnlockedSkillTreeAbilitiesToFoundry({ notify: false, force }).catch((error) => {
            console.warn(`${MODULE_ID} | Sincronizzazione automatica abilita alberi fallita.`, error);
        });
    }, delay);
}

function handleEmbeddedWikiMessage(event) {
    const sourceApp = getOpenWikiWindows().find((application) => {
        const frame = application?.getEmbeddedFrame?.();
        if (!frame?.contentWindow || event?.source !== frame.contentWindow) return false;
        return event.origin === application.getFrameOrigin?.(frame);
    });
    if (!sourceApp) return;
    if (event?.data?.type === "cripta-auth-token" && event?.data?.token) {
        propagateAuthToken(event.data.token);
    }
    if (event?.data?.type === "cripta-skill-tree-state-updated") {
        scheduleUnlockedSkillTreeAbilitySync({ force: true });
    }
}

function hideTokenQuickHud() {
    document.querySelector(".cripta-token-quick-hud")?.remove();
}

let lastCanvasPointerPosition = null;

function getTokenTopRightPosition(token) {
    const view = canvas?.app?.view || canvas?.app?.canvas;
    const rect = view?.getBoundingClientRect?.();
    const transform = canvas?.stage?.worldTransform;
    if (!rect || !transform || !token) {
        return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
    }

    const bounds = token.bounds;
    const worldX = bounds?.right ?? ((token.x || 0) + (token.w ?? token.width ?? 0));
    const worldY = bounds?.top ?? (token.y || 0);
    const screenPoint = transform.apply(new PIXI.Point(worldX, worldY));

    return {
        x: Math.round(rect.left + screenPoint.x),
        y: Math.round(rect.top + screenPoint.y)
    };
}

function positionTokenQuickHud(hud, token) {
    const position = getTokenTopRightPosition(token);
    const margin = 8;
    const hudRect = hud.getBoundingClientRect();
    const left = Math.min(
        window.innerWidth - hudRect.width - margin,
        Math.max(margin, position.x - hudRect.width + 8)
    );
    const top = Math.min(
        window.innerHeight - hudRect.height - margin,
        Math.max(margin, position.y - 8)
    );

    hud.style.left = `${left}px`;
    hud.style.top = `${top}px`;
}

function showTokenQuickHud(token, event, options = {}) {
    const foundryDocument = resolveDocumentFromToken(token);
    if (!foundryDocument) return;
    if (!isTokenVisibleForCurrentUser(token)) return;

    if (options.consumeEvent !== false) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
    }
    hideTokenQuickHud();
    const hud = document.createElement("div");
    hud.className = "cripta-token-quick-hud";
    hud.innerHTML = `
        <button type="button" data-action="wiki" title="Apri scheda wiki">
            <i class="fas fa-book-open"></i>
        </button>
    `;

    hud.addEventListener("click", (clickEvent) => {
        const button = clickEvent.target.closest("button[data-action]");
        if (!button) return;
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        const action = button.dataset.action;
        hideTokenQuickHud();

        if (action === "wiki") {
            wikiDataService.logDocumentSearch(foundryDocument, "right-click token").catch(error => {
                console.warn("[Cripta Wiki Sync] Impossibile loggare la ricerca wiki token.", error);
            });
            openWikiForDocument(foundryDocument);
            return;
        }
    });

    document.body.appendChild(hud);
    positionTokenQuickHud(hud, token);
}

function canUseFoundryTokenHud(token) {
    return Boolean(game.user?.isGM || token?.document?.isOwner || token?.actor?.isOwner);
}

function isTokenVisibleForCurrentUser(token) {
    if (!token || token.destroyed) return false;
    if (token.visible === false || token.renderable === false) return false;
    if (typeof token.worldVisible === "boolean" && token.worldVisible === false) return false;
    if (typeof token.isVisible === "boolean" && token.isVisible === false) return false;
    if (typeof token.isVisible === "function") {
        try {
            if (!token.isVisible()) return false;
        } catch (_error) {
            // Older Foundry versions expose visibility as a property, not a method.
        }
    }
    if (token.document?.hidden && !game.user?.isGM) return false;
    return true;
}

function openWikiFromToken(token, context = "token") {
    const foundryDocument = resolveDocumentFromToken(token);
    if (!foundryDocument) return;

    wikiDataService.logDocumentSearch(foundryDocument, context).catch(error => {
        console.warn("[Cripta Wiki Sync] Impossibile loggare la ricerca wiki token.", error);
    });
    openWikiForDocument(foundryDocument);
}

function appendTokenHudButtons(html, token) {
    if (html.find(".cripta-wiki-hud").length) return;

    const wikiButton = $(
        `<div class="control-icon cripta-wiki-hud" title="Apri scheda wiki">
            <i class="fas fa-book-open"></i>
        </div>`
    );

    wikiButton.on("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openWikiFromToken(token, "icona libro token");
    });
    html.find(".left").append(wikiButton);
}

function attachTokenQuickHudListener(token) {
    // Foundry's native TokenHUD must keep ownership of token right-clicks.
    // The DOM fallback below covers non-owned tokens, where Foundry does not show the HUD.
    return token;
}

function bindCanvasTokenRightClicks() {
    canvas?.tokens?.placeables?.forEach(attachTokenQuickHudListener);
}

function getTokenActor(tokenLike) {
    const document = tokenLike?.document || tokenLike;
    return document?.actor || tokenLike?.actor || null;
}

function getTokenDocument(tokenLike) {
    return tokenLike?.document || tokenLike || null;
}

function getTokenNameCandidates(tokenLike) {
    const document = getTokenDocument(tokenLike);
    const actor = getTokenActor(tokenLike);
    return [
        actor?.name,
        actor?.prototypeToken?.name,
        document?.name,
        document?.actor?.name
    ].map(normalizeWikiItemKey).filter(Boolean);
}

function getTokenOwnerAliases(tokenLike) {
    const actor = getTokenActor(tokenLike);
    if (!actor) return [];
    const aliases = [actor.name, actor.id, actor.uuid];
    game.users
        .filter((user) => !user.isGM && actor.testUserPermission?.(user, "OWNER"))
        .forEach((user) => aliases.push(user.id, user.name));
    return aliases.map(normalizeWikiItemKey).filter(Boolean);
}

function findTransformationOverrideForToken(tokenLike, overrides) {
    const names = new Set(getTokenNameCandidates(tokenLike));
    if (!names.size) return null;
    const actor = getTokenActor(tokenLike);
    const document = getTokenDocument(tokenLike);
    const ownerActorId = String(document?.getFlag?.(TOKENIZER_MODULE_ID, "variantOwnerActorId") || "").trim();
    const flaggedOwnerActor = ownerActorId ? game.actors.get(ownerActorId) : null;
    const nameMatches = (overrides || []).filter((entry) => hasFuzzySetMatch(entry.names, names));

    if (flaggedOwnerActor) {
        const flaggedMatch = nameMatches.find((entry) => transformationEntryMatchesActor(entry, flaggedOwnerActor));
        if (flaggedMatch) return flaggedMatch;
    }

    if (actor) {
        const directMatch = nameMatches.find((entry) => transformationEntryMatchesActor(entry, actor));
        if (directMatch) return directMatch;

        const permissionMatch = nameMatches.find((entry) => {
            const ownerActor = findActorForTransformation(entry);
            return ownerActor && actorsSharePlayerOwners(actor, ownerActor);
        });
        if (permissionMatch) return permissionMatch;
    }

    const ownerAliases = new Set(getTokenOwnerAliases(tokenLike));
    if (ownerAliases.size) {
        const aliasMatch = nameMatches.find((entry) => hasFuzzySetMatch(entry.ownerAliases, ownerAliases));
        if (aliasMatch) return aliasMatch;
    }

    return nameMatches.length === 1 ? nameMatches[0] : null;
}

function actorsSharePlayerOwners(leftActor, rightActor) {
    if (!leftActor || !rightActor) return false;
    return game.users.some((user) =>
        !user.isGM
        && leftActor.testUserPermission?.(user, "OWNER")
        && rightActor.testUserPermission?.(user, "OWNER")
    );
}
function hasFuzzySetMatch(leftValues, rightSet) {
    const rightValues = Array.from(rightSet || []).filter(Boolean);
    return (leftValues || []).some((left) => {
        if (!left) return false;
        return rightValues.some((right) => right === left || right.includes(left) || left.includes(right));
    });
}

function getActorOwnerAliases(actor) {
    if (!actor) return [];
    const aliases = [actor.name, actor.id, actor.uuid];
    game.users
        .filter((user) => !user.isGM && actor.testUserPermission?.(user, "OWNER"))
        .forEach((user) => aliases.push(user.id, user.name));

    const actorId = String(actor.id || "").trim();
    if (actorId) {
        parsePlayerActorMappings()
            .filter((mapping) => normalizeActorRef(mapping.actorRef) === actorId)
            .forEach((mapping) => aliases.push(mapping.ownerCharacterId, mapping.ownerAccountId, mapping.ownerUserKey));
    }

    return aliases.map(normalizeWikiItemKey).filter(Boolean);
}

function findConfiguredPlayerActorForTransformation(entry) {
    const characterIds = new Set([
        entry?.characterId,
        entry?.ownerCharacterId,
        entry?.entityId,
        ...(Array.isArray(entry?.ownerAliases) ? entry.ownerAliases : [])
    ].map(normalizeWikiItemKey).filter(Boolean));
    const accountIds = new Set([
        entry?.ownerAccountId,
        ...(Array.isArray(entry?.ownerAliases) ? entry.ownerAliases : [])
    ].map(compactAutoLoginKey).filter(Boolean));
    if (!characterIds.size && !accountIds.size) return null;

    const mapping = parsePlayerActorMappings().find((entry) => {
        const ownerCharacterId = normalizeWikiItemKey(entry.ownerCharacterId || "");
        const ownerAccountId = compactAutoLoginKey(entry.ownerAccountId || "");
        return (ownerCharacterId && characterIds.has(ownerCharacterId))
            || (ownerAccountId && accountIds.has(ownerAccountId));
    });
    return mapping ? getConfiguredActor(mapping.actorRef) : null;
}

function findPlayerActorForTransformation(entry) {
    const configuredActor = findConfiguredPlayerActorForTransformation(entry);
    if (configuredActor) return configuredActor;

    const ownerAliases = new Set((entry?.ownerAliases || []).filter(Boolean));
    if (!ownerAliases.size) return null;
    return game.actors.find((actor) => {
        const actorAliases = getActorOwnerAliases(actor);
        return hasFuzzySetMatch(actorAliases, ownerAliases);
    }) || null;
}

function transformationEntryMatchesActor(entry, actor) {
    if (!entry || !actor) return false;
    const actorId = normalizeActorRef(entry.actorId || entry.actorRef || entry.foundryActorId || "");
    if (actorId && actor.id === actorId) return true;
    const actorAliases = new Set(getActorOwnerAliases(actor));
    return hasFuzzySetMatch(entry.ownerAliases, actorAliases);
}

function findConfiguredCompanionActorForTransformation(entry) {
    if (!entry?.isCompanion && !String(entry?.characterId || "").startsWith("companion-")) return null;
    const actorId = normalizeActorRef(entry.actorId || entry.actorRef || entry.foundryActorId || "");
    if (actorId) {
        const directActor = game.actors.get(actorId);
        if (directActor && isConfiguredCompanionActor(directActor)) return directActor;
    }
    const ownerCharacterId = slugify(entry.ownerCharacterId || "");
    if (!ownerCharacterId) return null;
    return parseCompanionMappings()
        .map((mapping) => ({
            mapping,
            actor: getConfiguredActor(mapping.actorId || mapping.actorName)
        }))
        .find(({ mapping, actor }) =>
            actor
            && slugify(mapping.ownerCharacterId || "") === ownerCharacterId
            && transformationEntryMatchesActor(entry, actor)
        )?.actor || null;
}

function findActorForTransformation(entry) {
    const actorId = normalizeActorRef(entry?.actorId || entry?.actorRef || entry?.foundryActorId || "");
    if (actorId) {
        const directActor = game.actors.get(actorId);
        if (directActor) return directActor;
    }
    return findConfiguredCompanionActorForTransformation(entry)
        || findPlayerActorForTransformation(entry);
}

function getKhuzoeTokenizerApi() {
    const module = game.modules.get(TOKENIZER_MODULE_ID);
    const api = module?.active ? (module.api || game.khuzoeTokenizer) : null;
    return api && typeof api.syncVariants === "function" ? api : null;
}

function getConfiguredTransformationSubjects() {
    const subjects = resolveConfiguredPlayerActors()
        .map(({ actor, mapping }) => ({
            actor,
            subjectId: mapping.ownerCharacterId,
            ownerCharacterId: mapping.ownerCharacterId,
            ownerAccountId: mapping.ownerAccountId,
            isCompanion: false
        }))
        .filter((entry) => entry.actor && entry.subjectId);

    parseCompanionMappings().forEach((mapping) => {
        const actor = getConfiguredActor(mapping.actorId || mapping.actorName);
        const ownerCharacterId = slugify(mapping.ownerCharacterId || "");
        if (!actor || !ownerCharacterId) return;
        const entityId = buildCompanionMediaEntityId(ownerCharacterId, actor.id, actor.name || mapping.displayName || "companion");
        subjects.push({
            actor,
            subjectId: `companion-${entityId}`,
            ownerCharacterId,
            ownerAccountId: mapping.ownerAccountId,
            isCompanion: true,
            entityId
        });
    });

    return subjects;
}

function findConfiguredTransformationSubjectActor(entry, subjects = getConfiguredTransformationSubjects()) {
    const actorId = normalizeActorRef(entry?.actorId || entry?.actorRef || entry?.foundryActorId || "");
    if (actorId) {
        const direct = subjects.find((subject) => subject.actor?.id === actorId)?.actor;
        if (direct) return direct;
    }

    const characterId = slugify(entry?.ownerCharacterId || entry?.characterId || "");
    if (!characterId) return null;
    return subjects.find((subject) =>
        slugify(subject.subjectId || "") === characterId
        || slugify(subject.ownerCharacterId || "") === characterId
    )?.actor || null;
}

function getLegacyTokenSwitcherEntries(actor) {
    // Archived flags remain readable after uninstalling the old module, but
    // Foundry's getFlag rejects scopes which are no longer active.
    const raw = actor?.flags?.[LEGACY_TOKEN_SWITCHER_MODULE_ID]?.[LEGACY_TOKEN_SWITCHER_IMAGES_FLAG] || [];
    return (Array.isArray(raw) ? raw : [])
        .map((entry) => typeof entry === "string" ? { path: entry } : entry)
        .map((entry) => ({
            path: String(entry?.path || entry?.src || "").trim(),
            name: String(entry?.name || "").trim(),
            width: getTransformationTokenSize(entry) || 1,
            height: Number(entry?.height || entry?.width || 1) || 1
        }))
        .filter((entry) => entry.path);
}

async function migrateLegacyTokenSwitcherVariants(actor, tokenizerApi, managedPaths = new Set()) {
    if (!actor || actor.getFlag(MODULE_ID, LEGACY_TOKEN_SWITCHER_MIGRATED_FLAG)) return false;
    const basePath = String(actor.prototypeToken?.texture?.src || actor.prototypeToken?.img || "").split(/[?#]/)[0];
    const legacy = getLegacyTokenSwitcherEntries(actor)
        .filter((entry) => String(entry.path).split(/[?#]/)[0] !== basePath)
        .filter((entry) => !managedPaths.has(String(entry.path).split(/[?#]/)[0]))
        .filter((entry) => normalizeWikiItemKey(entry.name) !== "base")
        .map((entry) => ({
            id: `legacy-${slugify(entry.name || getFilename(entry.path))}`,
            name: entry.name || getFilename(entry.path).replace(/\.[^.]+$/, "") || "Variante",
            src: entry.path,
            width: entry.width,
            height: entry.height,
            revision: 1,
            source: LEGACY_TOKEN_SWITCHER_MODULE_ID
        }));

    if (legacy.length) {
        await tokenizerApi.syncVariants(actor, {
            source: LEGACY_TOKEN_SWITCHER_MODULE_ID,
            variants: legacy
        });
    }
    await actor.setFlag(MODULE_ID, LEGACY_TOKEN_SWITCHER_MIGRATED_FLAG, true);
    return legacy.length > 0;
}

async function mapTransformationToTokenizerVariant(actor, entry) {
    const remotePath = entry.remoteTokenImage || normalizeManagedRemotePath(entry.tokenImage);
    let effectivePath = entry.tokenImage;
    if (remotePath) {
        effectivePath = await resolveAndRegisterManagedMedia(actor, `transformation:${entry.id}`, {
            remote: remotePath,
            entityType: "transformation",
            entityId: entry.id,
            actor,
            name: entry.label || entry.creatureName || entry.name || "Forma",
            downloadFallback: false
        });
    }
    if (!effectivePath) {
        console.warn(`${MODULE_ID} | Variante Tokenizer saltata: media mancante.`, {
            actor: actor?.name,
            transformation: entry.label || entry.id,
            remote: remotePath
        });
        return null;
    }

    const size = getTransformationTokenSize(entry) || 1;
    return {
        id: String(entry.id),
        name: entry.label || entry.creatureName || entry.name || "Forma",
        src: appendMediaRevision(effectivePath, entry.revision),
        remoteImage: remotePath || "",
        revision: normalizeTransformationRevision(entry.revision),
        width: size,
        height: size,
        source: TOKENIZER_SYNC_SOURCE,
        ownerActorId: actor.id,
        matchNames: Array.from(new Set(entry.names || [])),
        matchActorIds: [entry.actorId, entry.entityId].filter(Boolean)
    };
}

async function syncTransformationsToTokenizer({ force = false, notify = false } = {}) {
    const tokenizerApi = getKhuzoeTokenizerApi();
    if (!tokenizerApi) {
        const message = "Khuzoe Tokenizer non e attivo o deve essere aggiornato alla versione 0.2.0.";
        if (notify) ui.notifications.warn(message);
        throw new Error(message);
    }

    const overrides = await loadWikiTransformationOverrides({ force });
    const configuredSubjects = getConfiguredTransformationSubjects();
    const byActor = new Map();
    overrides.filter((entry) => entry.switcher).forEach((entry) => {
        const actor = findConfiguredTransformationSubjectActor(entry, configuredSubjects)
            || findActorForTransformation(entry);
        if (!actor) {
            console.warn(`${MODULE_ID} | Trasformazione Tokenizer senza Actor associato.`, {
                id: entry.id,
                characterId: entry.characterId,
                ownerCharacterId: entry.ownerCharacterId,
                actorId: entry.actorId
            });
            return;
        }
        if (!byActor.has(actor.id)) byActor.set(actor.id, { actor, entries: [] });
        byActor.get(actor.id).entries.push(entry);
    });

    const actors = new Map();
    configuredSubjects.forEach(({ actor }) => actors.set(actor.id, actor));
    byActor.forEach(({ actor }) => actors.set(actor.id, actor));
    for (const actor of game.actors || []) {
        const hasManaged = tokenizerApi.getVariants?.(actor)?.some?.((entry) => entry.source === TOKENIZER_SYNC_SOURCE);
        if (hasManaged) actors.set(actor.id, actor);
    }

    let updated = 0;
    let migrated = 0;
    for (const actor of actors.values()) {
        const entries = byActor.get(actor.id)?.entries || [];
        const variants = [];
        for (const entry of entries) {
            const variant = await mapTransformationToTokenizerVariant(actor, entry);
            if (variant) variants.push(variant);
        }

        const changed = await tokenizerApi.syncVariants(actor, {
            source: TOKENIZER_SYNC_SOURCE,
            actorId: actor.id,
            base: {
                image: String(actor.prototypeToken?.texture?.src || actor.prototypeToken?.img || actor.img || ""),
                revision: 1
            },
            variants
        });
        if (changed) updated += 1;

        const managedPaths = new Set(variants.map((entry) => String(entry.src || "").split(/[?#]/)[0]));
        if (await migrateLegacyTokenSwitcherVariants(actor, tokenizerApi, managedPaths)) migrated += 1;
    }

    if (notify) {
        ui.notifications.info(`Varianti Khuzoe Tokenizer sincronizzate: ${updated}. Migrazioni legacy: ${migrated}.`);
    }
    if (updated || migrated) {
        console.info(`${MODULE_ID} | Varianti Khuzoe Tokenizer sincronizzate.`, {
            actors: actors.size,
            updated,
            migrated
        });
    }
    applyTransformationOverridesToScene({ delay: 0 });
    return updated > 0 || migrated > 0;
}

async function sanitizeTokenImageIfMissing(tokenLike) {
    const document = getTokenDocument(tokenLike);
    if (!document?.actor || typeof document.update !== "function") return false;
    const current = String(document.texture?.src || "").trim();
    if (current) return false;

    const fallback = String(
        document.actor?.prototypeToken?.texture?.src
        || document.actor?.prototypeToken?.img
        || document.actor?.img
        || ""
    ).trim();
    if (!fallback) return false;

    await document.update({ "texture.src": fallback });
    console.warn(`${MODULE_ID} | Token con texture vuota corretto usando fallback actor.`, {
        token: document.name,
        actor: document.actor?.name,
        fallback
    });
    return true;
}

async function sanitizeCurrentSceneTokenImages() {
    const tokens = canvas?.scene?.tokens || game.scenes?.current?.tokens || [];
    let updated = 0;
    for (const tokenDocument of tokens) {
        try {
            if (await sanitizeTokenImageIfMissing(tokenDocument)) updated += 1;
        } catch (error) {
            console.warn(`${MODULE_ID} | Correzione texture token vuota fallita.`, {
                token: tokenDocument?.name,
                error
            });
        }
    }
    if (updated) console.info(`${MODULE_ID} | Texture token vuote corrette.`, { updated });
    return updated;
}

async function applyTransformationTokenOverride(tokenLike, options = {}) {
    const document = getTokenDocument(tokenLike);
    const tokenizerApi = getKhuzoeTokenizerApi();
    if (!document?.actor || !tokenizerApi) return false;

    let overrides;
    try {
        overrides = await loadWikiTransformationOverrides(options);
    } catch (error) {
        console.warn(`${MODULE_ID} | Impossibile leggere le trasformazioni token.`, error);
        return false;
    }

    const match = findTransformationOverrideForToken(tokenLike, overrides);
    if (!match) {
        const activeSource = document.getFlag?.(TOKENIZER_MODULE_ID, "activeTokenVariantSource");
        if (activeSource === TOKENIZER_SYNC_SOURCE) {
            return Boolean(await tokenizerApi.restoreBase(document, {
                reason: "transformation-reverted"
            }));
        }
        return false;
    }

    const ownerActor = findActorForTransformation(match) || document.actor;
    const variantExists = tokenizerApi.getVariants?.(ownerActor)
        ?.some?.((variant) => String(variant.id) === String(match.id));
    if (!variantExists) return false;

    const activeId = String(document.getFlag?.(TOKENIZER_MODULE_ID, "activeTokenVariant") || "");
    if (activeId === String(match.id)) return false;

    const applied = await tokenizerApi.applyVariant(document, match.id, {
        actor: ownerActor,
        source: TOKENIZER_SYNC_SOURCE,
        reason: "dnd5e-transformation"
    });
    if (applied) {
        console.info(`${MODULE_ID} | Variante Tokenizer applicata alla trasformazione.`, {
            token: document.name,
            actor: document.actor?.name,
            ownerActor: ownerActor?.name,
            transformation: match.id
        });
    }
    return Boolean(applied);
}
function getTransformationTokenSize(entry) {
    const size = Number(entry?.size);
    if (Number.isFinite(size) && size > 0) return size;
    const width = Number(entry?.width);
    if (Number.isFinite(width) && width > 0) return width;
    const height = Number(entry?.height);
    return Number.isFinite(height) && height > 0 ? height : null;
}

function scheduleTransformationTokenOverride(tokenLike, options = {}) {
    window.setTimeout(() => {
        applyTransformationTokenOverride(tokenLike, options).catch((error) => {
            console.warn(`${MODULE_ID} | Applicazione token trasformazione fallita.`, error);
        });
    }, options.delay ?? 250);
}

function applyTransformationOverridesToScene(options = {}) {
    canvas?.tokens?.placeables?.forEach((token) => scheduleTransformationTokenOverride(token, options));
}

function getCanvasTokenAtClientPoint(event) {
    const view = canvas?.app?.view || canvas?.app?.canvas;
    if (!view || !canvas?.stage || !canvas?.tokens?.placeables?.length) return null;

    const rect = view.getBoundingClientRect();
    const screenPoint = new PIXI.Point(event.clientX - rect.left, event.clientY - rect.top);
    const worldPoint = canvas.stage.worldTransform.applyInverse(screenPoint);
    const tokens = [...canvas.tokens.placeables].reverse().filter(isTokenVisibleForCurrentUser);

    return tokens.find((token) => {
        const bounds = token.bounds;
        if (bounds?.contains?.(worldPoint.x, worldPoint.y)) return true;
        const width = token.w ?? token.width ?? 0;
        const height = token.h ?? token.height ?? 0;
        return worldPoint.x >= token.x
            && worldPoint.x <= token.x + width
            && worldPoint.y >= token.y
            && worldPoint.y <= token.y + height;
    }) || null;
}

function rememberCanvasPointerPosition(event) {
    const view = canvas?.app?.view || canvas?.app?.canvas;
    if (!view) return;
    if (event.target !== view) {
        if (lastCanvasPointerPosition?.target === view) lastCanvasPointerPosition = null;
        return;
    }

    lastCanvasPointerPosition = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: view
    };
}

function isTypingInTextInput() {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    if (active.isContentEditable) return true;
    if (active.closest?.("[contenteditable='true'], .editor, .tox, .ProseMirror, .CodeMirror")) return true;
    return ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
}

function handleTokenQuickHudKeydown(event) {
    if (event.key === "Escape") {
        hideTokenQuickHud();
        return;
    }

    if (event.key?.toLowerCase?.() !== "n") return;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || isTypingInTextInput()) return;

    const view = canvas?.app?.view || canvas?.app?.canvas;
    if (!view || !lastCanvasPointerPosition || lastCanvasPointerPosition.target !== view) return;

    const token = getCanvasTokenAtClientPoint(lastCanvasPointerPosition);
    if (!token) return;

    event.preventDefault();
    event.stopPropagation();
    showTokenQuickHud(token, event);
}

function registerMidiRiderHooks() {
    console.warn(`${MODULE_ID} | Hook Midi registrati per rider, rigenerazione, undead fortitude e assorbimento.`);
    Hooks.on("midi-qol.RollComplete", (workflow) => {
        queueWikiAbsorptionApplication(workflow, "RollComplete", 1500);
        queueWikiRiderApplication(workflow, "RollComplete", 250);
    });
    Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
        queueWikiAbsorptionApplication(workflow, "DamageRollComplete", 1500);
    });
    Hooks.on("midi-qol.WorkflowComplete", (workflow) => {
        removeAdvancedEffectsBrokenByDamage(workflow).catch((error) => {
            console.warn(`${MODULE_ID} | Rimozione rider wiki su danno fallita.`, error);
        });
        suppressRegenerationFromMidiWorkflow(workflow).catch((error) => {
            console.warn(`${MODULE_ID} | Interruzione rigenerazione wiki fallita.`, error);
        });
        queueWikiAbsorptionApplication(workflow, "WorkflowComplete", 1500);
        applyUndeadFortitudeFromMidiWorkflow(workflow).catch((error) => {
            console.warn(`${MODULE_ID} | Undead Fortitude wiki fallita.`, error);
        });
        queueWikiRiderApplication(workflow, "WorkflowComplete", 0);
    });
    Hooks.on("updateCombat", (combat, changed) => {
        if (!("turn" in changed) && !("round" in changed)) return;
        queueWikiRegeneration(combat);
    });
}

function queueWikiAbsorptionApplication(workflow, source, delayMs = 0) {
    window.setTimeout(() => {
        applyAbsorptionFromMidiWorkflow(workflow, source).catch((error) => {
            console.warn(`${MODULE_ID} | Assorbimento wiki fallito da ${source}.`, error);
        });
    }, delayMs);
}

function queueWikiRiderApplication(workflow, source, delayMs = 0) {
    window.setTimeout(() => {
        applyWikiRidersFromMidiWorkflow(workflow, source).catch((error) => {
            console.warn(`${MODULE_ID} | Applicazione rider wiki fallita (${source}).`, error);
        });
    }, delayMs);
}

async function removeAdvancedEffectsBrokenByDamage(workflow) {
    const damageTypes = extractWorkflowDamageTypes(workflow);
    if (!damageTypes.size) return;
    const actors = getWorkflowDamageActors(workflow);
    for (const actor of actors) {
        const effects = actor.effects.filter((effect) => {
            const type = effect.getFlag?.(MODULE_ID, "endsOnDamageType");
            return type && damageTypes.has(String(type).toLowerCase());
        });
        if (effects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map((effect) => effect.id));
    }
}

async function suppressRegenerationFromMidiWorkflow(workflow) {
    const events = getWorkflowDamageEvents(workflow);
    if (!events.length) return;
    const workflowDamageTypes = extractWorkflowDamageTypes(workflow);
    for (const event of events) {
        const actor = event.actor;
        if (!actor) continue;
        const passive = getActorWikiPassive(actor, "regeneration");
        if (!passive?.enabled) continue;
        const breakTypes = normalizeWikiDamageTypeList(passive.breakDamageTypes);
        if (!breakTypes.length) continue;
        const damageTypes = new Set([...workflowDamageTypes, ...event.damageTypes]);
        const matched = breakTypes.filter((type) => damageTypes.has(type));
        if (!matched.length) continue;
        await actor.setFlag(MODULE_ID, "regenerationSuppressed", {
            combatId: game.combat?.id || "",
            round: game.combat?.round || 0,
            turn: game.combat?.turn ?? null,
            damageTypes: matched,
            updatedAt: Date.now()
        });
    }
}

function queueWikiRegeneration(combat) {
    if (!game.user?.isGM) return;
    window.setTimeout(() => {
        applyWikiRegenerationAtTurnStart(combat).catch((error) => {
            console.warn(`${MODULE_ID} | Rigenerazione wiki fallita.`, error);
        });
    }, 100);
}

async function applyWikiRegenerationAtTurnStart(combat) {
    const combatant = combat?.combatant;
    const actor = combatant?.actor;
    if (!actor) return;
    const passive = getActorWikiPassive(actor, "regeneration");
    if (!passive?.enabled) return;
    const amount = Math.floor(Number(passive.value) || 0);
    if (amount <= 0) return;
    const key = `${combat.id || "combat"}:${combat.round || 0}:${combat.turn ?? ""}:${actor.uuid || actor.id}`;
    if (regenerationTurnKeys.has(key)) return;
    if (regenerationTurnKeys.size > 200) regenerationTurnKeys.clear();
    regenerationTurnKeys.add(key);

    const suppression = actor.getFlag?.(MODULE_ID, "regenerationSuppressed");
    if (suppression) {
        await actor.unsetFlag(MODULE_ID, "regenerationSuppressed");
        const damageLabels = normalizeWikiDamageTypeList(suppression.damageTypes).map((type) => WIKI_DAMAGE_TYPE_LABELS[type] || type).join(", ");
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<p><strong>Regeneration.</strong> ${escapeHtml(actor.name)} non rigenera${damageLabels ? ` a causa di: ${escapeHtml(damageLabels)}` : ""}.</p>`
        });
        return;
    }

    const hp = actor.system?.attributes?.hp || {};
    const current = Number(hp.value ?? 0);
    const max = Number(hp.max ?? 0);
    if (!Number.isFinite(current) || !Number.isFinite(max) || current <= 0 || max <= 0 || current >= max) return;
    const next = Math.min(max, current + amount);
    await actor.update({ "system.attributes.hp.value": next });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p><strong>Regeneration.</strong> ${escapeHtml(actor.name)} recupera ${next - current} PF.</p>`
    });
}

function extractWorkflowDamageTypes(workflow) {
    const values = new Set();
    visitDamageTypeCandidate(workflow?.damageDetail, values);
    visitDamageTypeCandidate(workflow?.damageList, values);
    visitDamageTypeCandidate(workflow?.damageItem, values);
    visitDamageTypeCandidate(workflow?.damageRolls, values);
    visitDamageTypeCandidate(workflow?.item, values);
    visitDamageTypeCandidate(workflow?.activity, values);
    visitDamageTypeCandidate(workflow?.activity?.damage, values);
    return values;
}

function visitDamageTypeCandidate(value, values, depth = 0, seen = new Set()) {
    if (value == null || depth > 6) return;
    if (typeof value === "string") {
        addKnownDamageTypesFromString(value, values);
        return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Set || Array.isArray(value)) {
        Array.from(value).forEach((entry) => visitDamageTypeCandidate(entry, values, depth + 1, seen));
        return;
    }
    if (value instanceof Map) {
        Array.from(value.values()).forEach((entry) => visitDamageTypeCandidate(entry, values, depth + 1, seen));
        return;
    }
    ["type", "damageType", "damageTypeId", "damageTypeValue", "value"].forEach((key) => {
        if (typeof value[key] === "string") addKnownDamageTypesFromString(value[key], values);
    });
    ["damage", "damageDetail", "damageDetails", "parts", "rolls", "damages", "system", "activities", "activity", "base", "custom"].forEach((key) => {
        if (value[key] != null) visitDamageTypeCandidate(value[key], values, depth + 1, seen);
    });
}

function addKnownDamageTypesFromString(text, values) {
    const known = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
    const normalized = String(text).toLowerCase();
    known.forEach((type) => {
        if (normalized === type || normalized.includes(type)) values.add(type);
    });
}

async function applyAbsorptionFromMidiWorkflow(workflow, source = "") {
    if (!workflow || typeof workflow !== "object") {
        console.warn(`${MODULE_ID} | Assorbimento: workflow non valido da ${source}.`, workflow);
        return;
    }
    let events = getWorkflowDamageEvents(workflow);
    if (!events.length) {
        events = getWorkflowDamageActors(workflow).map((actor) => ({
            actor,
            raw: null,
            oldHp: null,
            newHp: null,
            damage: 0,
            damageTypes: new Set(),
            critical: Boolean(workflow?.isCritical || workflow?.criticalHit)
        }));
    }
    const workflowDamageTypes = extractWorkflowDamageTypes(workflow);
    const workflowAmount = getWorkflowTotalDamage(workflow);
    if (!events.length) {
        console.warn(`${MODULE_ID} | Assorbimento: nessun actor danneggiato trovato da ${source}.`, {
            item: workflow?.item?.name || workflow?.damageItem?.name || "",
            damageTypes: Array.from(workflowDamageTypes),
            amount: workflowAmount
        });
        return;
    }
    const appliedKey = `${MODULE_ID}AbsorptionApplied`;
    if (!workflow[appliedKey]) workflow[appliedKey] = new Set();
    for (const event of events) {
        const actor = event.actor;
        if (!actor) continue;
        const actorKey = actor.uuid || actor.id;
        if (workflow[appliedKey].has(actorKey)) continue;
        const absorbedTypes = getActorAbsorptionTypes(actor);
        const damageTypes = new Set([...workflowDamageTypes, ...event.damageTypes]);
        const matched = absorbedTypes.filter((type) => damageTypes.has(type));
        const amount = getWorkflowAbsorbedDamageAmount(workflow, event, matched, damageTypes, workflowAmount);
        console.warn(`${MODULE_ID} | Assorbimento check da ${source}`, {
            actor: actor.name,
            absorbedTypes,
            damageTypes: Array.from(damageTypes),
            matched,
            amount,
            item: workflow?.item?.name || workflow?.damageItem?.name || ""
        });
        if (!absorbedTypes.length) continue;
        if (!matched.length) continue;
        if (!amount || amount <= 0) continue;
        workflow[appliedKey].add(actorKey);
        await convertDamageToHealing(actor, amount, matched, event);
    }
}

function getWorkflowAbsorbedDamageAmount(workflow, event, matchedTypes, damageTypes, workflowAmount) {
    if (!matchedTypes.length) return 0;
    const detailSources = [
        event?.raw,
        workflow?.damageDetail,
        workflow?.damageDetails,
        workflow?.damageItem?.damageDetail,
        workflow?.damageItem?.damageDetails,
        workflow?.damageItem?.damageRolls,
        workflow?.damageRolls,
        workflow?.damageRoll
    ];
    for (const source of detailSources) {
        const directAmount = sumDamageAmountsForTypes(matchedTypes, source);
        if (directAmount > 0) return directAmount;
    }
    const nonAbsorbedTypes = Array.from(damageTypes || []).filter((type) => !matchedTypes.includes(type));
    if (!nonAbsorbedTypes.length) return event.damage > 0 ? event.damage : workflowAmount;
    console.warn(`${MODULE_ID} | Assorbimento: danno misto senza dettaglio per tipo, cura saltata per evitare sovracura.`, {
        matchedTypes,
        damageTypes: Array.from(damageTypes || []),
        workflowAmount
    });
    return 0;
}

function sumDamageAmountsForTypes(types, ...sources) {
    const wanted = new Set(types);
    let total = 0;
    const seen = new Set();
    const visit = (value) => {
        if (value == null) return;
        if (typeof value !== "object") return;
        if (seen.has(value)) return;
        seen.add(value);
        if (value instanceof Set || Array.isArray(value)) {
            Array.from(value).forEach(visit);
            return;
        }
        if (value instanceof Map) {
            Array.from(value.values()).forEach(visit);
            return;
        }
        const nodeTypes = getDirectDamageTypes(value).filter((type) => wanted.has(type));
        const amount = getDirectDamageAmount(value);
        if (nodeTypes.length && amount > 0) {
            total += amount;
            return;
        }
        ["damage", "damageDetail", "damageDetails", "parts", "rolls", "damages", "base", "custom"].forEach((key) => {
            if (value[key] != null) visit(value[key]);
        });
    };
    sources.forEach(visit);
    return total;
}

function getDirectDamageTypes(value) {
    const types = new Set();
    ["type", "damageType", "damageTypeId", "damageTypeValue"].forEach((key) => {
        if (typeof value?.[key] === "string") addKnownDamageTypesFromString(value[key], types);
    });
    if (typeof value?.options?.type === "string") addKnownDamageTypesFromString(value.options.type, types);
    if (typeof value?.options?.damageType === "string") addKnownDamageTypesFromString(value.options.damageType, types);
    return Array.from(types);
}

function getDirectDamageAmount(value) {
    return firstFiniteNumber(value?.damage, value?.total, value?.amount, value?.appliedDamage, value?.hpDamage, 0);
}

async function convertDamageToHealing(actor, amount, damageTypes, damageEvent = {}) {
    const hp = actor.system?.attributes?.hp || {};
    const current = Number(hp.value ?? 0);
    const max = Number(hp.max ?? 0);
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return;
    const healing = Math.floor(Number(amount) || 0);
    if (healing <= 0) return;
    const next = Math.min(max, current + healing);
    if (next <= current) return;
    await delayedActorHpUpdate(actor, next, "Assorbimento");
    const labels = damageTypes.map((type) => WIKI_DAMAGE_TYPE_LABELS[type] || type).join(", ");
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p><strong>Assorbimento.</strong> ${escapeHtml(actor.name)} converte ${healing} danni ${escapeHtml(labels)} in cura.</p>`
    });
}

async function delayedActorHpUpdate(actor, hpValue, reason = "") {
    const apply = () => {
        actor.update({ "system.attributes.hp.value": hpValue }).catch((error) => {
            console.warn(`${MODULE_ID} | Update PF fallito (${reason}).`, error);
        });
    };
    await actor.update({ "system.attributes.hp.value": hpValue });
    window.setTimeout(apply, 150);
    window.setTimeout(apply, 450);
}

function getActorAbsorptionTypes(actor) {
    const values = new Set();
    const flagValues = actor.getFlag?.(MODULE_ID, "damageAbsorptions") || actor.flags?.[MODULE_ID]?.damageAbsorptions;
    (Array.isArray(flagValues) ? flagValues : []).forEach((type) => {
        const normalized = String(type || "").trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(WIKI_DAMAGE_TYPE_LABELS, normalized)) values.add(normalized);
    });
    const traitValues = actor.system?.traits?.da?.value;
    (Array.isArray(traitValues) ? traitValues : []).forEach((type) => {
        const normalized = String(type || "").trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(WIKI_DAMAGE_TYPE_LABELS, normalized)) values.add(normalized);
    });
    actor.items?.forEach?.((item) => {
        const passive = item.getFlag?.(MODULE_ID, "passive") || item.flags?.[MODULE_ID]?.passive;
        if (passive?.enabled && passive.id === "absorption") {
            const normalized = String(passive.value || "").trim().toLowerCase();
            if (Object.prototype.hasOwnProperty.call(WIKI_DAMAGE_TYPE_LABELS, normalized)) values.add(normalized);
        }
    });
    return Array.from(values);
}

async function applyUndeadFortitudeFromMidiWorkflow(workflow) {
    const events = getWorkflowDamageEvents(workflow);
    if (!events.length) return;
    const workflowDamageTypes = extractWorkflowDamageTypes(workflow);
    const appliedKey = `${MODULE_ID}UndeadFortitudeApplied`;
    if (!workflow[appliedKey]) workflow[appliedKey] = new Set();
    for (const event of events) {
        const actor = event.actor;
        if (!actor || workflow[appliedKey].has(actor.uuid || actor.id)) continue;
        if (!actorHasWikiPassive(actor, "undead-fortitude")) continue;
        const hp = Number(actor.system?.attributes?.hp?.value ?? 0);
        if (!Number.isFinite(hp) || hp > 0) continue;
        if (event.damageTypes.has("radiant") || workflowDamageTypes.has("radiant")) continue;
        if (event.critical) continue;

        workflow[appliedKey].add(actor.uuid || actor.id);
        const damage = event.damage > 0 ? event.damage : getWorkflowTotalDamage(workflow);
        const dc = Math.max(5, 5 + Math.floor(Number(damage) || 0));
        const save = await rollUndeadFortitudeSave(actor, dc);
        if (save.total >= dc) {
            await restoreActorToOneHp(actor, "Undead Fortitude");
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<p><strong>Undead Fortitude.</strong> ${escapeHtml(actor.name)} resta a 1 PF (TS ${save.total} contro CD ${dc}).</p>`
            });
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<p><strong>Undead Fortitude.</strong> ${escapeHtml(actor.name)} fallisce il TS ${save.total} contro CD ${dc}.</p>`
            });
        }
    }
}

async function restoreActorToOneHp(actor, reason = "") {
    const updates = [
        { delay: 0, hp: 1 },
        { delay: 150, hp: 1 },
        { delay: 450, hp: 1 }
    ];
    for (const update of updates) {
        window.setTimeout(() => {
            const current = Number(actor.system?.attributes?.hp?.value ?? 0);
            if (Number.isFinite(current) && current <= 0) {
                actor.update({ "system.attributes.hp.value": update.hp }).catch((error) => {
                    console.warn(`${MODULE_ID} | Ripristino PF fallito (${reason}).`, error);
                });
            }
        }, update.delay);
    }
    await actor.update({ "system.attributes.hp.value": 1 });
}

function getWorkflowDamageEvents(workflow) {
    const events = [];
    const visit = (value) => {
        if (value == null) return;
        if (value instanceof Set || Array.isArray(value)) {
            Array.from(value).forEach(visit);
            return;
        }
        if (value instanceof Map) {
            Array.from(value.values()).forEach(visit);
            return;
        }
        if (typeof value !== "object") return;
        const actor = normalizeWorkflowActor(value) || normalizeWorkflowActor(value.actor) || normalizeWorkflowActor(value.token) || normalizeWorkflowActor(value.target);
        if (!actor) return;
        const damageTypes = new Set();
        visitDamageTypeCandidate(value, damageTypes);
        const oldHp = firstFiniteNumber(value.oldHP, value.oldHp, value.hpOld, value.startingHP, value.startingHp);
        const newHp = firstFiniteNumber(value.newHP, value.newHp, value.hpNew, value.endingHP, value.endingHp);
        const damage = firstFiniteNumber(
            value.appliedDamage,
            value.damageApplied,
            value.hpDamage,
            value.totalDamage,
            value.damage,
            Number.isFinite(oldHp) && Number.isFinite(newHp) ? oldHp - newHp : NaN
        );
        events.push({
            actor,
            raw: value,
            oldHp: Number.isFinite(oldHp) ? oldHp : null,
            newHp: Number.isFinite(newHp) ? newHp : null,
            damage: Number.isFinite(damage) ? Math.max(0, damage) : 0,
            damageTypes,
            critical: Boolean(value.isCritical || value.critical || value.criticalHit || workflow?.isCritical || workflow?.criticalHit)
        });
    };
    visit(workflow?.damageList);
    visit(workflow?.damageItem?.damageList);
    return events;
}

function getWorkflowTotalDamage(workflow) {
    return firstFiniteNumber(workflow?.damageTotal, workflow?.damageItem?.damageTotal, workflow?.damageRoll?.total, workflow?.damageRolls?.[0]?.total, 0);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return NaN;
}

function actorHasWikiPassive(actor, passiveId) {
    return Boolean(getActorWikiPassive(actor, passiveId));
}

function getActorWikiPassive(actor, passiveId) {
    return actor.items?.find?.((item) => {
        const passive = item.getFlag?.(MODULE_ID, "passive") || item.flags?.[MODULE_ID]?.passive;
        return passive?.enabled && passive?.id === passiveId;
    })?.getFlag?.(MODULE_ID, "passive")
        || actor.items?.find?.((item) => {
            const passive = item.flags?.[MODULE_ID]?.passive;
            return passive?.enabled && passive?.id === passiveId;
        })?.flags?.[MODULE_ID]?.passive
        || null;
}

async function rollUndeadFortitudeSave(actor, dc) {
    const flavor = `Undead Fortitude CD ${dc}`;
    try {
        if (typeof actor.rollAbilitySave === "function") {
            const result = await actor.rollAbilitySave("con", { dc, flavor, fastForward: true });
            const total = extractRollTotal(result);
            if (Number.isFinite(total)) return { total };
        }
    } catch (error) {
        console.debug(`${MODULE_ID} | rollAbilitySave non disponibile per Undead Fortitude.`, error);
    }
    const roll = await new Roll("1d20 + @abilities.con.save", actor.getRollData?.() || {}).evaluate({ async: true });
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor
    });
    return { total: roll.total };
}

function extractRollTotal(result) {
    if (Number.isFinite(Number(result?.total))) return Number(result.total);
    if (Number.isFinite(Number(result?.roll?.total))) return Number(result.roll.total);
    if (Array.isArray(result?.rolls)) {
        const roll = result.rolls.find((entry) => Number.isFinite(Number(entry?.total)));
        if (roll) return Number(roll.total);
    }
    if (Array.isArray(result)) {
        const roll = result.find((entry) => Number.isFinite(Number(entry?.total || entry?.roll?.total)));
        if (roll) return Number(roll.total || roll.roll.total);
    }
    return NaN;
}

function getWorkflowDamageActors(workflow) {
    return collectWorkflowActors(
        workflow?.hitTargets,
        workflow?.targets,
        workflow?.damageList,
        workflow?.damageItem?.hitTargets,
        workflow?.damageItem?.targets
    );
}

async function applyWikiRidersFromMidiWorkflow(workflow, source = "") {
    const item = workflow?.item;
    const riders = item?.getFlag?.(MODULE_ID, "riders") || item?.flags?.[MODULE_ID]?.riders;
    if (!riders?.enabled) return;

    const targets = getWorkflowHitTargets(workflow);
    if (targets.length && !workflow?.[`${MODULE_ID}HitRidersApplied`]) {
        workflow[`${MODULE_ID}HitRidersApplied`] = true;
        await applyConditionsToTargets(targets, normalizeWikiConditionList(riders.alwaysConditions), item, "hit");
        await applyAdvancedEffectsToTargets(targets, getAdvancedEffectsForTiming(riders, "hit"), item, "hit");
    }

    const failedTargets = getWorkflowFailedSaveTargets(workflow);
    if (failedTargets.length && !workflow?.[`${MODULE_ID}FailedSaveRidersApplied`]) {
        workflow[`${MODULE_ID}FailedSaveRidersApplied`] = true;
        await applyConditionsToTargets(failedTargets, normalizeWikiConditionList(riders.failConditions), item, "failed-save");
        await applyAdvancedEffectsToTargets(failedTargets, getAdvancedEffectsForTiming(riders, "failed-save"), item, "failed-save");
    }
}

function getWorkflowHitTargets(workflow) {
    const candidates = workflow?.hitTargets?.size ? workflow.hitTargets : workflow?.targets;
    return Array.from(candidates || [])
        .map((target) => target?.actor ? target : target?.document?.object)
        .filter((target) => target?.actor);
}

function getWorkflowFailedSaveTargets(workflow) {
    const failed = collectWorkflowTargets(
        workflow?.failedSaves,
        workflow?.failedSaveTargets,
        workflow?.saves?.failed,
        workflow?.saveResults?.failed,
        workflow?.saveResult?.failed
    );
    const succeeded = collectWorkflowTargets(
        workflow?.succeededSaves,
        workflow?.successfulSaves,
        workflow?.saves?.succeeded,
        workflow?.saves?.success,
        workflow?.saveResults?.succeeded,
        workflow?.saveResults?.success,
        workflow?.saveResult?.succeeded,
        workflow?.saveResult?.success
    );
    if (!failed.length) return [];
    if (!succeeded.length) return failed;
    const succeededIds = new Set(succeeded.map(getWorkflowTargetIdentity).filter(Boolean));
    return failed.filter((target) => !succeededIds.has(getWorkflowTargetIdentity(target)));
}

function collectWorkflowTargets(...candidates) {
    const targets = [];
    const seen = new Set();
    const visit = (value) => {
        if (value == null) return;
        const target = normalizeWorkflowTarget(value);
        if (target) {
            const id = getWorkflowTargetIdentity(target);
            if (!seen.has(id)) {
                seen.add(id);
                targets.push(target);
            }
            return;
        }
        if (value instanceof Set || Array.isArray(value)) {
            Array.from(value).forEach(visit);
            return;
        }
        if (value instanceof Map) {
            Array.from(value.values()).forEach(visit);
        }
    };
    candidates.forEach(visit);
    return targets;
}

function normalizeWorkflowTarget(value) {
    if (!value) return null;
    if (value.actor) return value;
    if (value.document?.object?.actor) return value.document.object;
    if (value.object?.actor) return value.object;
    if (value.token?.actor) return value.token;
    if (value.target?.actor) return value.target;
    if (value.target?.document?.object?.actor) return value.target.document.object;
    return null;
}

function getWorkflowTargetIdentity(target) {
    return target?.document?.uuid || target?.uuid || target?.id || target?.actor?.uuid || target?.actor?.id || "";
}

function collectWorkflowActors(...candidates) {
    const actors = [];
    const seen = new Set();
    const visit = (value) => {
        if (value == null) return;
        const actor = normalizeWorkflowActor(value);
        if (actor) {
            const id = actor.uuid || actor.id;
            if (!seen.has(id)) {
                seen.add(id);
                actors.push(actor);
            }
            return;
        }
        if (value instanceof Set || Array.isArray(value)) {
            Array.from(value).forEach(visit);
            return;
        }
        if (value instanceof Map) {
            Array.from(value.values()).forEach(visit);
        }
    };
    candidates.forEach(visit);
    return actors;
}

function normalizeWorkflowActor(value) {
    if (!value) return null;
    if (value.effects && value.createEmbeddedDocuments) return value;
    if (value.actor?.effects) return value.actor;
    if (value.document?.actor?.effects) return value.document.actor;
    if (value.document?.object?.actor?.effects) return value.document.object.actor;
    if (value.object?.actor?.effects) return value.object.actor;
    if (value.token?.actor?.effects) return value.token.actor;
    if (value.target?.actor?.effects) return value.target.actor;
    if (value.target?.document?.object?.actor?.effects) return value.target.document.object.actor;
    return null;
}

async function applyConditionsToTargets(targets, conditions, item, reason) {
    if (!conditions.length) return;
    for (const target of targets) {
        const actor = target.actor;
        for (const condition of conditions) {
            if (hasActorStatus(actor, condition)) continue;
            await actor.toggleStatusEffect(condition, { active: true, overlay: false });
        }
    }
}

function getAdvancedEffectsForTiming(riders, timing) {
    return (Array.isArray(riders?.advancedEffects) ? riders.advancedEffects : []).filter((effect) => (effect.timing || "hit") === timing);
}

async function applyAdvancedEffectsToTargets(targets, effects, item, reason) {
    if (!effects.length) return;
    for (const target of targets) {
        const actor = target.actor;
        const toCreate = [];
        for (const effect of effects) {
            const existing = getRuntimeAdvancedEffect(actor, item, effect);
            if (existing) {
                await ensureRuntimeAdvancedEffectVisible(actor, existing, effect);
                continue;
            }
            toCreate.push(buildRuntimeAdvancedEffect(effect, item, reason));
        }
        if (toCreate.length) await actor.createEmbeddedDocuments("ActiveEffect", toCreate);
        await refreshTokenEffectIcons(target);
    }
}

function hasRuntimeAdvancedEffect(actor, item, effect) {
    return Boolean(getRuntimeAdvancedEffect(actor, item, effect));
}

function getRuntimeAdvancedEffect(actor, item, effect) {
    const key = runtimeAdvancedEffectKey(item, effect);
    return actor.effects.find((activeEffect) => activeEffect.getFlag?.(MODULE_ID, "advancedKey") === key) || null;
}

async function ensureRuntimeAdvancedEffectVisible(actor, effect, sourceEffect = null) {
    const updates = {};
    const img = sourceEffect ? runtimeAdvancedEffectImage(sourceEffect) : "";
    if (img && effect.img !== img) updates.img = img;
    const always = globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2;
    if (effect.showIcon !== always) updates.showIcon = always;
    if (!Array.isArray(effect.getFlag?.("dae", "specialDuration"))) updates["flags.dae.specialDuration"] = [];
    if (effect.getFlag?.("core", "overlay") !== false) updates["flags.core.overlay"] = false;
    if (Object.keys(updates).length) await actor.updateEmbeddedDocuments("ActiveEffect", [{ _id: effect.id, ...updates }]);
}

async function refreshTokenEffectIcons(target) {
    const token = target?.document?.object || target;
    try {
        if (typeof token?.drawEffects === "function") await token.drawEffects();
        else token?.renderFlags?.set?.({ refreshEffects: true });
    } catch (error) {
        console.debug(`${MODULE_ID} | Refresh icone effetti token non riuscito.`, error);
    }
}

function runtimeAdvancedEffectKey(item, effect) {
    return `${item?.uuid || item?.id || "item"}:${effect.id || slugify(effect.name)}`;
}

function buildRuntimeAdvancedEffect(effect, item, reason) {
    const isOverTime = effect.kind === "startTurnDamage";
    const changes = (Array.isArray(effect.changes) ? effect.changes : []).map((change) => ({ ...change }));
    if (isOverTime && effect.damage?.formula) {
        changes.push({
            key: "flags.midi-qol.OverTime",
            mode: 0,
            value: `turn=start,damageRoll=${effect.damage.formula},damageType=${effect.damage.type || "cold"},label=${effect.name || "Effetto"}`,
            priority: 20
        });
    }
    return normalizeActiveEffectSourceV14({
        name: effect.name || "Effetto avanzato",
        img: runtimeAdvancedEffectImage(effect),
        origin: item?.uuid || null,
        disabled: false,
        transfer: false,
        description: `Applicato dal modulo ${MODULE_TITLE}: ${reason}.`,
        duration: effect.duration || {},
        flags: {
            [MODULE_ID]: {
                runtimeRider: true,
                reason,
                advancedKey: runtimeAdvancedEffectKey(item, effect),
                endsOnDamageType: effect.endsOnDamageType || ""
            },
            dae: {
                specialDuration: [],
                enableCondition: "",
                disableCondition: "",
                disableIncapacitated: false,
                showIcon: true,
                macroRepeat: "none"
            },
            dnd5e: {
                riders: { statuses: [] }
            },
            core: {
                overlay: false
            }
        },
        statuses: [],
        tint: "#ffffff",
        type: "base",
        system: { changes: normalizeActiveEffectChangesV14(changes) }
    });
}

function runtimeAdvancedEffectImage(effect) {
    return resolveWikiAssetUrl(effect?.iconImage) || (effect?.kind === "startTurnDamage" ? "icons/magic/water/snowflake-ice-blue.webp" : "icons/svg/aura.svg");
}

function hasActorStatus(actor, condition) {
    return actor.effects.some((effect) => effect.statuses?.has?.(condition) || Array.from(effect.statuses || []).includes(condition));
}

Hooks.once("init", () => {
    registerSettings();
    registerManagedActorSync({
        ensureTransferIds: (actor) => withCharacterSyncSuppressed(() => ensureManagedActorTransferIds(actor)),
        getActorLink: getManagedActorLink,
        setCompanionRelationship: setCompanionRelationshipMapping
    });
    registerCampaignItemSync({
        loadCatalog: loadWikiItemsCatalog,
        buildItemData: buildFoundryItemDataFromWiki,
        uploadItemImage: uploadCampaignCatalogItemImage,
        onLinkedActorsUpdated: async (actors) => {
            for (const actor of actors) scheduleCharacterSyncForActor(actor, "campaign-item-propagation");
            for (const actor of actors) {
                await queueManagedActorContentSync(actor, "campaign-item-propagation");
            }
        }
    });
    registerEconomySync();
    registerFoundryLiveSync({
        pullManagedActors: pullManagedActorVariants,
        pullManagedActorCommands: pullManagedActorCommandsNow,
        reconcileCampaignItems: reconcileCampaignItemsNow,
        runLightSync: runAutomaticLightSyncFromWorkerStatus,
        pullEconomy: pullEconomyRegistry
    });
});

Hooks.once("ready", () => {
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
        mod.api = {
            calendar: Object.freeze({ getContext: getCalendarContext, request: requestCalendar, login: promptDeviceLogin }),
            openWikiBrowser,
            openWikiForDocument,
            openWikiItemsImporter,
            loadWikiItemsCatalog,
            getWikiMissingItems,
            loadWikiTransformationOverrides,
            applyTransformationOverridesToScene,
            syncTransformationsToTokenizer,
            applyAbilityOverridesFromWiki,
            applyItemOverridesFromWiki,
            syncAbilityIconsToWiki,
            syncInventoryItemIconsToWiki,
            syncCharacterImagesToWiki,
            syncUnlockedSkillTreeAbilitiesToFoundry,
            previewSkillTreeSync,
            showSkillTreeSyncPreview,
            getSkillTreeSyncReport: () => lastSkillTreeSyncReport,
            bootstrapManagedMediaFallbacksFromR2,
            ensureManagedRemotePathsActive,
            applyCharacterMediaOverridesFromWiki,
            applyQueuedAssetSyncJobsFromWiki,
            openWikiSyncPanel,
            propagateAuthToken,
            syncCharactersToWorker,
            syncManagedActorNow,
            reconcileCampaignItemsNow,
            getFoundryLiveSyncStatus,
            refreshFoundryLiveSync,
            buildCharacterSyncPayload,
            getCharacterSyncDebugState,
            pullEconomyRegistry,
            pushEconomyRegistry,
            loadWorkerSyncStatus,
            loadWorkerSyncChanges,
            openWorkerSyncStatusDialog,
            runAutomaticLightSyncFromWorkerStatus,
            exportActorToWikiNpc,
            wikiDataService,
            wikiStore
            ,getSyncPolicyStatus
        };
    }

    window.addEventListener("message", handleEmbeddedWikiMessage);
    document.addEventListener("click", (event) => {
        if (!event.target.closest?.(".cripta-token-quick-hud")) hideTokenQuickHud();
    });
    document.addEventListener("keydown", handleTokenQuickHudKeydown);
    document.addEventListener("pointermove", rememberCanvasPointerPosition, true);
    registerMidiRiderHooks();
    window.setTimeout(() => {
        const syncMode = getSyncMode();
        if (syncMode === SYNC_MODES.DIAGNOSTIC) {
            ui.notifications?.warn?.("Khuzoe Wiki Sync è in modalità Diagnostica: nessun dato Foundry o Cloudflare verrà modificato.", { permanent: true });
        }
        if (canAuthenticateRemote()) promptDeviceLoginIfNeeded().catch(() => {});
        if (canPullFromWorker()) {
            runAutomaticLightSyncFromWorkerStatus().catch((error) => {
                console.warn(`${MODULE_ID} | Sync leggera automatica fallita.`, error);
            });
        }
        const bootstrapManagedActors = async () => {
            if (canPullFromWorker()) {
                try {
                    await pullManagedActorVariants({ forceIndex: true, pullCommands: true });
                } catch (error) {
                    console.warn(`${MODULE_ID} | Riallineamento iniziale Managed Actor fallito.`, error);
                }
            }
            if (canPushToWorker()) {
                try {
                    await resumeManagedActorSyncQueue();
                } catch (error) {
                    console.warn(`${MODULE_ID} | Ripristino coda Managed Actor fallito.`, error);
                }
            }
            if (canStartLiveSync()) startManagedActorVariantPull({ initialPull: false });
        };
        bootstrapManagedActors().catch((error) => {
            console.warn(`${MODULE_ID} | Avvio Managed Actor non completato.`, error);
        });
        startCampaignItemSync();
        startEconomySync();
        if (canStartLiveSync()) startFoundryLiveSync();
        loadWikiSkillTrees()
            .then(rerenderOpenActorSheetsForSkillTreeButtons)
            .catch((error) => {
                console.warn(`${MODULE_ID} | Alberi abilita non caricati.`, error);
            });
    }, 500);
});

Hooks.on("getSceneControlButtons", controls => {
    const tokenControls = Array.isArray(controls)
        ? controls.find(control => control.name === "token")
        : controls?.tokens || controls?.token;
    if (!tokenControls) return;

    const addTool = (tool) => {
        if (Array.isArray(tokenControls.tools)) {
            tokenControls.tools.push(tool);
            return;
        }
        tokenControls.tools ??= {};
        const { onClick, ...v14Tool } = tool;
        tokenControls.tools[tool.name] = {
            ...v14Tool,
            order: Object.keys(tokenControls.tools).length,
            onChange: () => onClick?.()
        };
    };

    addTool({
        name: "cripta-wiki-browser",
        title: MODULE_TITLE,
        icon: "fas fa-book-skull",
        button: true,
        onClick: () => openWikiBrowser()
    });

    addTool({
        name: "cripta-wiki-sync-panel",
        title: "Wiki Sync",
        icon: "fas fa-arrows-rotate",
        button: true,
        visible: game.user?.isGM,
        onClick: () => openWikiSyncPanel()
    });
});

Hooks.on("canvasReady", () => {
    bindCanvasTokenRightClicks();
    sanitizeCurrentSceneTokenImages().catch((error) => {
        console.warn(`${MODULE_ID} | Bonifica texture token scena fallita.`, error);
    });
    applyTransformationOverridesToScene();
});
Hooks.on("refreshToken", (token) => {
    attachTokenQuickHudListener(token);
});
Hooks.on("createToken", (tokenDocument) => {
    window.setTimeout(bindCanvasTokenRightClicks, 50);
    sanitizeTokenImageIfMissing(tokenDocument).catch((error) => {
        console.warn(`${MODULE_ID} | Bonifica texture token creato fallita.`, error);
    });
    scheduleTransformationTokenOverride(tokenDocument, { delay: 500 });
});
Hooks.on("updateToken", (tokenDocument, changes, options = {}) => {
    sanitizeTokenImageIfMissing(tokenDocument).catch((error) => {
        console.warn(`${MODULE_ID} | Bonifica texture token aggiornato fallita.`, error);
    });
    if (options.khuzoeTokenizer) return;
    const changedKeys = Object.keys(foundry.utils.flattenObject(changes || {}));
    const transformationChanged = changedKeys.some((key) =>
        key === "actorId"
        || key === "name"
        || key.startsWith("delta.")
        || key.startsWith("actorData.")
        || key.startsWith("flags.dnd5e.")
    );
    if (transformationChanged) scheduleTransformationTokenOverride(tokenDocument, { delay: 150 });
});

Hooks.on("updateActor", (actor, changes, options = {}) => {
    if (suppressCharacterSync || options.khuzoeTokenizer || options.criptaWikiSyncCommand) return;
    scheduleCharacterSyncForActor(actor, "updateActor");
    const changedKeys = Object.keys(foundry.utils.flattenObject(changes || {}));
    const transformationChanged = changedKeys.some((key) =>
        key === "name"
        || key.startsWith("system.details.type")
        || key.startsWith("flags.dnd5e.")
    );
    if (!transformationChanged) return;
    window.setTimeout(() => {
        canvas?.tokens?.placeables
            ?.filter((token) => token.actor?.id === actor?.id || token.document?.actor?.id === actor?.id)
            .forEach((token) => scheduleTransformationTokenOverride(token, { delay: 0 }));
    }, 150);
});
function isInternalCriptaItemUpdate(options = {}) {
    return Boolean(options?.criptaWikiSyncCommand
        || options?.criptaCampaignItemSync
        || options?.criptaManagedMediaMaintenance);
}

Hooks.on("createItem", (item, options = {}, userId = "") => {
    if (suppressCharacterSync || isInternalCriptaItemUpdate(options)) return;
    const usefulItemPredicate = isConfiguredCompanionActor(item?.actor) ? isUsefulCompanionItem : isUsefulCharacterItem;
    const shouldTrackTransferId = shouldTrackTransferIdForItem(item, usefulItemPredicate);
    if (shouldTrackTransferId && shouldEnsureCreatedItemTransferIdentityOnThisClient(item, userId)) {
        withCharacterSyncSuppressed(() => ensureCreatedItemTransferIdentity(item, usefulItemPredicate))
            .catch((error) => console.warn(`${MODULE_ID} | TransferId non verificato sul nuovo item.`, { item: item?.name, actor: item?.actor?.name, error }))
            .finally(() => scheduleCharacterSyncForActor(item?.actor, "createItem"));
        return;
    }
    scheduleCharacterSyncForActor(item?.actor, "createItem");
});

Hooks.on("preUpdateItem", (item, changes, options = {}) => {
    if (suppressCharacterSync || isInternalCriptaItemUpdate(options)) return;
    const changedKeys = Object.keys(foundry.utils.flattenObject(changes || {}));
    const relevant = changedKeys.some((key) =>
        key === "system.quantity"
        || key === "system.qty"
        || key === "system.amount"
        || key.startsWith("system.currency.")
        || key.startsWith("system.container.")
        || key.startsWith("system.capacity.")
    );
    if (relevant) scheduleCharacterSyncForActor(item?.actor, "preUpdateItem");
});

Hooks.on("updateItem", (item, changes, options = {}) => {
    if (suppressCharacterSync || isInternalCriptaItemUpdate(options)) return;
    if (hasItemImageChange(changes)) scheduleItemImageOverrideSync(item, "updateItemImage");
    scheduleCharacterSyncForActor(item?.actor, "updateItem");
});

Hooks.on("deleteItem", (item, options = {}) => {
    if (suppressCharacterSync || isInternalCriptaItemUpdate(options)) return;
    scheduleCharacterSyncForActor(item?.actor, "deleteItem");
});

Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet.actor || sheet.document || sheet.object;
    const managedLink = getManagedActorLink(actor);
    if (game.user?.isGM && managedLink.relationshipType === "player" && managedLink.ownerCharacterId) {
        buttons.unshift({
            label: "Companion",
            class: "cripta-manage-companions",
            icon: "fas fa-paw",
            onclick: () => openManagedCompanionPicker(actor)
        });
    }
    addPlayerSkillTreeHeaderButton(actor, buttons);
    if (game.user?.isGM && actor?.type === "npc" && !isTemporaryWikiActor(actor)) {
        buttons.unshift({
            label: "Categoria",
            class: "cripta-manage-npc-category",
            icon: "fas fa-folder-tree",
            onclick: () => openManagedNpcCategoryPicker(actor)
        });
        buttons.unshift({
            label: "Sincronizza",
            class: "cripta-managed-share-alert",
            icon: "fas fa-cloud-arrow-up",
            onclick: () => confirmManagedActorFirstShare(actor, sheet)
        });
    }
    buttons.unshift({
        label: "Wiki",
        class: "cripta-open-wiki",
        icon: "fas fa-book-open",
        onclick: () => openWikiForDocument(actor)
    });
});

Hooks.on("getHeaderControlsActorSheetV2", (sheet, controls) => {
    const actor = sheet.actor || sheet.document || sheet.object;
    if (!actor || !Array.isArray(controls)) return;
    const managedLink = getManagedActorLink(actor);

    if (game.user?.isGM && managedLink.relationshipType === "player" && managedLink.ownerCharacterId) {
        controls.unshift({
            action: "cripta-manage-companions",
            label: "Companion",
            icon: "fa-solid fa-paw",
            onClick: () => openManagedCompanionPicker(actor)
        });
    }

    const skillTrees = getPlayerSkillTreeEntriesForActor(actor);
    if (skillTrees.length) {
        controls.unshift({
            action: "cripta-open-skill-tree",
            label: skillTrees.length > 1 ? "Alberi" : "Albero",
            icon: "fa-solid fa-crown",
            onClick: () => openPlayerSkillTreeForActor(actor).catch((error) => {
                ui.notifications.warn(error?.message || String(error || "Albero abilita non disponibile."));
            })
        });
    }

    if (game.user?.isGM && actor.type === "npc" && !isTemporaryWikiActor(actor)) {
        controls.unshift({
            action: "cripta-manage-npc-category",
            label: "Categoria",
            icon: "fa-solid fa-folder-tree",
            onClick: () => openManagedNpcCategoryPicker(actor)
        });
        controls.unshift({
            action: "cripta-managed-share-alert",
            label: "Sincronizza",
            icon: "fa-solid fa-cloud-arrow-up",
            onClick: () => confirmManagedActorFirstShare(actor, sheet)
        });
    }

    controls.unshift({
        action: "cripta-open-wiki",
        label: "Wiki",
        icon: "fa-solid fa-book-open",
        onClick: () => openWikiForDocument(actor)
    });
});

Hooks.on("renderActorSheet", (app, html) => {
    refreshManagedActorShareIndicator(app, html);
});

Hooks.on("renderActorSheetV2", (app, element) => {
    refreshManagedActorShareIndicator(app, element);
});



