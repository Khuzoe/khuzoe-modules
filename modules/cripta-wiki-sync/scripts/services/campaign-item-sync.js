import { DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { canPullFromWorker, canPushToWorker } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";
import { buildFoundrySyncContract } from "./sync-contract.js";
import { normalizeActiveEffectSourceV14 } from "./foundry-v14.js";

const STATE_SETTING = "campaignItemSyncState";
const ROOT_FOLDER_NAME = "Cripta Wiki Items";
const ROOT_FOLDER_FLAG = "campaignItemRoot";
const ARCHIVE_FOLDER_NAME = "_ARCHIVIATI";
const ARCHIVE_FOLDER_FLAG = "campaignItemArchive";
const CATEGORY_FOLDER_ID_FLAG = "campaignItemCategoryId";
const CATEGORY_FOLDER_NAME_FLAG = "campaignItemCategoryName";
const PUSH_DEBOUNCE_MS = 2_500;
const INSTANCE_RUNTIME_PATHS = [
    "system.quantity",
    "system.equipped",
    "system.attuned",
    "system.uses.value",
    "system.uses.spent",
    "system.uses.max",
    "system.prepared",
    "system.container"
];

export function isCampaignItemAttunementRequired(value) {
    return value === "required" || value === 1 || value === true;
}

export function shouldRepairLegacyCampaignItemAttunement(record, item) {
    if (!record || !item || record?.attunement !== true) return false;
    const sync = record?.sync && typeof record.sync === "object" ? record.sync : {};
    if (sync.pendingFoundry === true || Number(sync.siteRevision || 0) > 0) return false;
    const storedValue = record?.foundry?.document?.system?.attunement;
    const liveValue = item?.system?.attunement;
    return !isCampaignItemAttunementRequired(storedValue) && !isCampaignItemAttunementRequired(liveValue);
}
let registered = false;
let callbacks = {};
let pullStarted = false;
let pushTimer = null;
let reconciling = false;
const pendingWorldItemIds = new Set();
const pendingPropagationTimers = new Map();
let reconcileRequested = false;
let latestCatalogRecords = [];
let latestCategoryRegistry = { revision: 0, categories: [] };
let categoryFolderQueue = Promise.resolve();
let categoryReconcileTimer = null;

export function registerCampaignItemSync(options = {}) {
    if (registered) return;
    registered = true;
    callbacks = options;
    game.settings.register(MODULE_ID, STATE_SETTING, {
        name: "Stato catalogo oggetti di campagna",
        scope: "world",
        config: false,
        restricted: true,
        type: Object,
        default: { schemaVersion: 1, items: {} }
    });

    Hooks.on("createItem", (item, hookOptions = {}) => {
        if (isInternalCampaignItemUpdate(hookOptions) || !canRunCampaignItemSync()) return;
        if (item?.actor) {
            linkEmbeddedCampaignItem(item).catch((error) => console.warn(`${MODULE_ID} | Collegamento copia oggetto fallito.`, error));
            return;
        }
        if (!isManagedWorldItem(item)) return;
        ensureWorldItemIdentity(item)
            .then(() => scheduleCampaignItemPush(item))
            .catch((error) => console.warn(`${MODULE_ID} | Identita oggetto di campagna non assegnata.`, error));
    });

    Hooks.on("updateItem", (item, changes = {}, hookOptions = {}) => {
        if (isInternalCampaignItemUpdate(hookOptions) || !canRunCampaignItemSync() || item?.actor || !isManagedWorldItem(item)) return;
        const flattened = foundry?.utils?.flattenObject?.(changes || {}) || changes || {};
        if (Object.keys(flattened).some((path) => path === "folder" || path.startsWith("folder."))) {
            const categoryFolder = categoryFolderForItem(item);
            if (categoryFolderNeedsRegistration(categoryFolder)) queueCategoryFolderChange(categoryFolder, "item-move");
        }
        if (!getCampaignItemId(item)) {
            ensureWorldItemIdentity(item)
                .then(() => scheduleCampaignItemPush(item))
                .catch((error) => console.warn(`${MODULE_ID} | Identita oggetto di campagna non assegnata.`, error));
            return;
        }
        if (!hasCampaignItemContentChanges(changes)) return;
        scheduleCampaignItemPush(item);
        if (hasLinkedInstanceContentChanges(changes)) scheduleLinkedInstancePropagation(item);
    });
    Hooks.on("createActiveEffect", (effect, hookOptions = {}) => scheduleCampaignItemEffectChange(effect, hookOptions));
    Hooks.on("updateActiveEffect", (effect, _changes = {}, hookOptions = {}) => scheduleCampaignItemEffectChange(effect, hookOptions));
    Hooks.on("deleteActiveEffect", (effect, hookOptions = {}) => scheduleCampaignItemEffectChange(effect, hookOptions));

    Hooks.on("createFolder", (folder, hookOptions = {}) => {
        if (isInternalCampaignItemUpdate(hookOptions) || !canRunCampaignItemSync() || folder?.type !== "Item") return;
        queueCategoryFolderChange(folder, "create");
    });
    Hooks.on("updateFolder", (folder, changes = {}, hookOptions = {}) => {
        if (isInternalCampaignItemUpdate(hookOptions) || !canRunCampaignItemSync() || folder?.type !== "Item") return;
        const flattened = foundry?.utils?.flattenObject?.(changes || {}) || changes || {};
        if (!Object.keys(flattened).some((path) => path === "name" || path === "folder" || path.startsWith("flags."))) return;
        queueCategoryFolderChange(folder, "update");
    });
    Hooks.on("deleteFolder", (folder, hookOptions = {}) => {
        if (isInternalCampaignItemUpdate(hookOptions) || !canRunCampaignItemSync() || folder?.type !== "Item") return;
        // La cancellazione di una cartella non cancella mai categorie o oggetti dal sito.
        // Foundry ricolloca i documenti e i normali hook Item sincronizzano la nuova posizione.
        if (getFolderCategoryId(folder) || isRootFolder(folder) || isArchiveFolder(folder)) requestCampaignItemReconcile();
    });
}

export function startCampaignItemSync() {
    if (!canRunCampaignItemSync("pull") || pullStarted) return;
    pullStarted = true;
    window.setTimeout(() => reconcileCampaignItemsNow().catch(reportSyncError), 1_500);
}

export async function reconcileCampaignItemsNow({ notify = false } = {}) {
    if (!canRunCampaignItemSync("pull")) return false;
    if (reconciling) {
        reconcileRequested = true;
        return false;
    }
    reconciling = true;
    try {
        const [records, loadedCategoryRegistry] = await Promise.all([loadCatalog(), loadCategoryRegistry()]);
        let categoryRegistry = await prepareCategoryRegistry(loadedCategoryRegistry);
        latestCategoryRegistry = categoryRegistry;
        latestCatalogRecords = records;
        const byId = new Map(records.map((record) => [campaignItemId(record), record]).filter(([id]) => id));
        const state = getSyncState();
        const nextItemsState = { ...(state.items || {}) };
        const snapshots = [];
        const unknownWorldItemIds = new Set();
        let localChanges = 0;
        let importedWorldItems = false;

        for (const category of Array.isArray(categoryRegistry?.categories) ? categoryRegistry.categories : []) {
            if (category?.archived || category?.mergedInto || !category?.id || !category?.name) continue;
            await getOrCreateCategoryFolder({ categoryId: category.id, category: category.name }, categoryRegistry);
        }

        for (const record of records) {
            const id = campaignItemId(record);
            if (!id) continue;
            let item = findWorldItemByCampaignId(id, record);
            const shouldManage = recordHasFoundryIntent(record, item);
            if (!shouldManage) continue;

            if (!item) {
                const folder = await getOrCreateItemFolder(record, categoryRegistry);
                const data = buildWorldItemData(record, folder);
                item = await Item.create(data, { criptaCampaignItemSync: true });
                localChanges += 1;
            } else {
                await ensureWorldItemIdentity(item, id);
            }

            const repairMissingPresentation = shouldRepairMissingPresentation(record, item);
            const repairLegacyAttunement = shouldRepairLegacyCampaignItemAttunement(record, item);
            const targetFolder = await getOrCreateItemFolder(record, categoryRegistry);
            const targetCategory = categoryIdentityForFolder(targetFolder, resolveRecordCategory(record, categoryRegistry), categoryRegistry);
            const folderChanged = String(item.folder?.id || item.folder || "") !== String(targetFolder?.id || "");
            const categoryIdentityChanged = normalizeId(item.getFlag?.(MODULE_ID, "categoryId") || "") !== targetCategory.id
                || String(item.getFlag?.(MODULE_ID, "categoryName") || "") !== targetCategory.name;
            const projectSiteContent = Boolean(record?.sync?.pendingFoundry || repairMissingPresentation);
            if (projectSiteContent) {
                const update = buildWorldItemUpdate(record, item, targetFolder);
                if (hasMeaningfulUpdate(item, update)) {
                    await item.update(update, { criptaCampaignItemSync: true });
                    localChanges += 1;
                }
                await propagateWorldItemToLinkedInstances(item);
            } else if (folderChanged || categoryIdentityChanged) {
                // Una migrazione o rinomina di categoria non deve mai proiettare
                // sul documento contenuti eventualmente piu recenti in Foundry.
                await item.update({
                    folder: targetFolder?.id || null,
                    [`flags.${MODULE_ID}.categoryId`]: targetCategory.id,
                    [`flags.${MODULE_ID}.categoryName`]: targetCategory.name
                }, { criptaCampaignItemSync: true });
                localChanges += 1;
            }

            // I cataloghi creati prima del flusso bidirezionale possono avere
            // "Richiede sintonia" sul sito senza una revisione pendente. In quel
            // caso allineiamo soltanto il campo dnd5e, senza riproiettare sul
            // documento Foundry una copia potenzialmente meno recente degli
            // altri dati dell'oggetto.
            if (repairLegacyAttunement && !isCampaignItemAttunementRequired(item.system?.attunement)) {
                await item.update({ "system.attunement": "required" }, { criptaCampaignItemSync: true });
                localChanges += 1;
                await propagateWorldItemToLinkedInstances(item);
            }

            const snapshot = await buildWorldItemSnapshot(item, record);
            const previousHash = String(nextItemsState[id]?.foundryHash || "");
            const mustConfirmSite = Boolean(record?.sync?.pendingFoundry);
            if (mustConfirmSite || snapshot.hash !== previousHash) {
                snapshots.push({ campaignItemId: id, appliedSiteRevision: mustConfirmSite ? Number(record.sync?.siteRevision || 0) : 0, document: snapshot });
            }
        }

        for (const item of managedWorldItems()) {
            if (!getCampaignItemId(item)) await ensureWorldItemIdentity(item);
        }

        let linksMigrated = state.linksMigrated === true;
        if (!linksMigrated) {
            await reconcileExistingEmbeddedLinks();
            linksMigrated = true;
        }

        for (const item of managedWorldItems()) {
            const id = getCampaignItemId(item) || await ensureWorldItemIdentity(item);
            if (!id || byId.has(id)) continue;
            const snapshot = await buildWorldItemSnapshot(item, null);
            // Gli ID assenti dal catalogo vanno ritentati anche se una vecchia
            // versione del modulo aveva salvato per errore l'hash di un rifiuto.
            snapshots.push({ campaignItemId: id, appliedSiteRevision: 0, document: snapshot });
            unknownWorldItemIds.add(id);
        }

        if (snapshots.length && canPushToWorker()) {
            const response = await postFoundrySnapshots(snapshots);
            const acceptedIds = applyCampaignItemSnapshotResults(response, snapshots, nextItemsState);
            importedWorldItems = acceptedIds.some((id) => unknownWorldItemIds.has(id));
        }

        await setSyncState({ schemaVersion: 1, items: nextItemsState, linksMigrated, pulledAt: new Date().toISOString() });
        // Un oggetto appena scoperto viene prima salvato senza perdere il documento
        // Foundry e poi, in un secondo passaggio, collocato nella cartella canonica.
        if (importedWorldItems) reconcileRequested = true;
        if (notify) ui.notifications.info(`Catalogo oggetti sincronizzato${localChanges ? `: ${localChanges} modifiche applicate` : ""}.`);
        return Boolean(localChanges || snapshots.length);
    } finally {
        reconciling = false;
        if (reconcileRequested) {
            reconcileRequested = false;
            window.setTimeout(() => {
                reconcileCampaignItemsNow().catch(reportSyncError);
            }, 500);
        }
    }
}

export async function linkEmbeddedCampaignItem(item) {
    if (!item?.actor) return false;
    let campaignId = getCampaignItemId(item);
    let source = null;
    const sourceUuid = String(
        item._stats?.compendiumSource
        || item._source?._stats?.compendiumSource
        || item._source?.flags?.core?.sourceId
        || item.flags?.core?.sourceId
        || ""
    );
    if (sourceUuid) {
        try { source = await fromUuid(sourceUuid); } catch (_) { source = null; }
    }
    if (!campaignId && source) campaignId = getCampaignItemId(source);
    if (!campaignId) {
        const candidates = managedWorldItems().filter((entry) => normalizeName(entry.name) === normalizeName(item.name));
        if (candidates.length === 1) {
            source = candidates[0];
            campaignId = getCampaignItemId(source);
        }
    }
    if (!campaignId) return false;
    const currentLibraryUuid = String(item.getFlag?.(MODULE_ID, "campaignLibraryUuid") || "");
    const libraryUuid = String(source?.uuid || currentLibraryUuid || "");
    const updates = {};
    if (getCampaignItemId(item) !== campaignId) updates[`flags.${MODULE_ID}.campaignItemId`] = campaignId;
    if (libraryUuid && currentLibraryUuid !== libraryUuid) updates[`flags.${MODULE_ID}.campaignLibraryUuid`] = libraryUuid;
    if (!Object.keys(updates).length) return false;
    await item.update(updates, { criptaCampaignItemSync: true });
    return true;
}

async function reconcileExistingEmbeddedLinks() {
    for (const actor of Array.from(game.actors || [])) {
        for (const item of Array.from(actor.items || [])) {
            if (getCampaignItemId(item)) continue;
            await linkEmbeddedCampaignItem(item);
        }
    }
}
function isInternalCampaignItemUpdate(options = {}) {
    return Boolean(options?.criptaCampaignItemSync
        || options?.criptaWikiSyncCommand
        || options?.criptaManagedMediaMaintenance);
}

function hasCampaignItemContentChanges(changes = {}) {
    const flatten = foundry?.utils?.flattenObject;
    const flattened = typeof flatten === "function" ? flatten(changes || {}) : changes || {};
    return Object.keys(flattened).some((path) => path === "name"
        || path === "type"
        || path === "img"
        || path.startsWith("system.")
        || path === "effects"
        || path.startsWith("effects.")
        || path === "flags.khuzoe-merchant.cost"
        || path.startsWith("flags.khuzoe-merchant.cost.")
        || path === "folder"
        || path.startsWith("folder."));
}
function hasLinkedInstanceContentChanges(changes = {}) {
    const flatten = foundry?.utils?.flattenObject;
    const flattened = typeof flatten === "function" ? flatten(changes || {}) : changes || {};
    return Object.keys(flattened).some((path) => path === "name"
        || path === "type"
        || path === "img"
        || path.startsWith("system.")
        || path === "effects"
        || path.startsWith("effects.")
        || path === "flags.khuzoe-merchant.cost"
        || path.startsWith("flags.khuzoe-merchant.cost."));
}
function scheduleCampaignItemEffectChange(effect, options = {}) {
    const item = effect?.parent;
    if (isInternalCampaignItemUpdate(options) || !canRunCampaignItemSync()
        || item?.documentName !== "Item" || item.actor || !isManagedWorldItem(item)) return;
    const enqueue = () => {
        scheduleCampaignItemPush(item);
        scheduleLinkedInstancePropagation(item);
    };
    if (getCampaignItemId(item)) {
        enqueue();
        return;
    }
    ensureWorldItemIdentity(item)
        .then(enqueue)
        .catch((error) => console.warn(`${MODULE_ID} | Identita oggetto di campagna non assegnata.`, error));
}
function scheduleCampaignItemPush(item) {
    if (item?.id) pendingWorldItemIds.add(item.id);
    if (pushTimer) window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(flushCampaignItemPush, PUSH_DEBOUNCE_MS);
}

async function flushCampaignItemPush() {
    pushTimer = null;
    if (!canRunCampaignItemSync("push")) return;
    if (reconciling || !pendingWorldItemIds.size) return;
    const ids = Array.from(pendingWorldItemIds);
    pendingWorldItemIds.clear();
    const state = getSyncState();
    const nextItemsState = { ...(state.items || {}) };
    const snapshots = [];
    for (const itemId of ids) {
        const item = game.items.get(itemId);
        if (!item || !isManagedWorldItem(item)) continue;
        const id = await ensureWorldItemIdentity(item);
        const document = await buildWorldItemSnapshot(item, null);
        if (document.hash === String(nextItemsState[id]?.foundryHash || "")) continue;
        snapshots.push({ campaignItemId: id, appliedSiteRevision: 0, document });
    }
    if (!snapshots.length) return;
    try {
        if (!latestCatalogRecords.length) latestCatalogRecords = await loadCatalog();
        const response = await postFoundrySnapshots(snapshots);
        applyCampaignItemSnapshotResults(response, snapshots, nextItemsState);
        await setSyncState({ ...state, schemaVersion: 1, items: nextItemsState, pushedAt: new Date().toISOString() });
    } catch (error) {
        ids.forEach((id) => pendingWorldItemIds.add(id));
        reportSyncError(error);
    }
}

export function recordHasFoundryIntent(record, item = null) {
    return Boolean(item || record?.sync?.managed || record?.sync?.pendingFoundry
        || record?.foundry?.document
        // Un foundryNames esplicito e gia una scelta di collegamento legacy.
        || (Array.isArray(record?.foundryNames) && record.foundryNames.some((name) => String(name || "").trim())));
}

export function isAcceptedCampaignItemSnapshotResult(result) {
    return Boolean(result?.campaignItemId && ["saved", "unchanged"].includes(String(result.status || "")));
}

function applyCampaignItemSnapshotResults(response, snapshots, nextItemsState) {
    const acceptedIds = [];
    for (const result of Array.isArray(response?.results) ? response.results : []) {
        if (!isAcceptedCampaignItemSnapshotResult(result)) {
            if (result?.status === "invalid") {
                const sent = snapshots.find((entry) => entry.campaignItemId === result.campaignItemId);
                console.warn(`${MODULE_ID} | Oggetto Foundry non accettato dal catalogo; verra ritentato.`, {
                    campaignItemId: result.campaignItemId,
                    item: sent?.document?.document?.name || "",
                    reason: result.reason || "snapshot-invalid"
                });
            }
            continue;
        }
        const sent = snapshots.find((entry) => entry.campaignItemId === result.campaignItemId);
        if (!sent) continue;
        nextItemsState[result.campaignItemId] = { foundryHash: sent.document.hash, syncedAt: new Date().toISOString() };
        acceptedIds.push(result.campaignItemId);
    }
    return acceptedIds;
}

function hasMeaningfulLinkedInstanceUpdate(item, update) {
    const source = item.toObject();
    const costPath = "flags.khuzoe-merchant.cost";
    const currentCost = source.flags?.["khuzoe-merchant"]?.cost ?? null;
    const desiredCost = Object.prototype.hasOwnProperty.call(update, costPath) ? update[costPath] : currentCost;
    const current = {
        name: source.name,
        type: source.type,
        img: source.img,
        system: source.system || {},
        effects: source.effects || [],
        campaignItemId: getCampaignItemId(item),
        campaignLibraryUuid: String(item.getFlag?.(MODULE_ID, "campaignLibraryUuid") || ""),
        merchantCost: currentCost
    };
    const desired = {
        name: update.name,
        type: update.type,
        img: update.img,
        system: update.system || {},
        effects: update.effects || [],
        campaignItemId: String(update[`flags.${MODULE_ID}.campaignItemId`] || ""),
        campaignLibraryUuid: String(update[`flags.${MODULE_ID}.campaignLibraryUuid`] || ""),
        merchantCost: desiredCost
    };
    return hashValue(current) !== hashValue(desired);
}

function scheduleLinkedInstancePropagation(item) {
    const itemId = String(item?.id || "");
    if (!itemId) return;
    window.clearTimeout(pendingPropagationTimers.get(itemId));
    pendingPropagationTimers.set(itemId, window.setTimeout(() => {
        pendingPropagationTimers.delete(itemId);
        propagateWorldItemToLinkedInstances(item)
            .catch((error) => console.warn(`${MODULE_ID} | Propagazione oggetto collegato fallita.`, error));
    }, 500));
}

async function propagateWorldItemToLinkedInstances(worldItem) {
    const id = getCampaignItemId(worldItem);
    if (!id) return 0;
    const source = worldItem.toObject();
    const sourceRequiresAttunement = isCampaignItemAttunementRequired(source?.system?.attunement);
    const changedActors = [];
    let changed = 0;
    for (const actor of Array.from(game.actors || [])) {
        const updates = [];
        for (const embedded of Array.from(actor.items || [])) {
            if (getCampaignItemId(embedded) !== id) continue;
            const runtime = Object.fromEntries(INSTANCE_RUNTIME_PATHS.map((path) => [path, getProperty(embedded, path)]));
            const update = {
                _id: embedded.id,
                name: source.name,
                type: source.type,
                img: source.img,
                system: deepClone(source.system || {}),
                effects: normalizeCampaignItemEffects(source.effects),
                [`flags.${MODULE_ID}.campaignItemId`]: id,
                [`flags.${MODULE_ID}.campaignLibraryUuid`]: worldItem.uuid,
                ...merchantCostUpdate(source.flags)
            };
            for (const [path, value] of Object.entries(runtime)) {
                if (path === "system.attuned" && !sourceRequiresAttunement) {
                    setProperty(update, path, false);
                } else if (value !== undefined) {
                    setProperty(update, path, deepClone(value));
                }
            }
            if (hasMeaningfulLinkedInstanceUpdate(embedded, update)) updates.push(update);
        }
        if (updates.length) {
            await actor.updateEmbeddedDocuments("Item", updates, {
                criptaCampaignItemSync: true,
                criptaWikiSyncCommand: true
            });
            changed += updates.length;
            changedActors.push(actor);
        }
    }
    if (changedActors.length && typeof callbacks.onLinkedActorsUpdated === "function") {
        try {
            await callbacks.onLinkedActorsUpdated(changedActors, worldItem);
        } catch (error) {
            console.warn(`${MODULE_ID} | Accodamento Actor collegati fallito.`, error);
        }
    }
    return changed;
}

async function ensureWorldItemIdentity(item, requestedId = "") {
    const id = normalizeId(requestedId || getCampaignItemId(item) || item.getFlag?.(MODULE_ID, "wikiItemId") || item.name);
    if (!id) throw new Error("ID oggetto di campagna non valido.");
    const updates = {};
    if (getCampaignItemId(item) !== id) updates[`flags.${MODULE_ID}.campaignItemId`] = id;
    if (String(item.getFlag?.(MODULE_ID, "wikiItemId") || "") !== id) updates[`flags.${MODULE_ID}.wikiItemId`] = id;
    if (Object.keys(updates).length) await item.update(updates, { criptaCampaignItemSync: true });
    return id;
}

function buildWorldItemData(record, folder) {
    const id = campaignItemId(record);
    const category = categoryIdentityForFolder(folder, resolveRecordCategory(record, latestCategoryRegistry));
    const foundryDocument = record?.foundry?.document;
    const base = foundryDocument && typeof foundryDocument === "object"
        ? sanitizeFoundryDocument(foundryDocument)
        : callbacks.buildItemData?.(record, folder) || fallbackWorldItemData(record, folder);
    const pendingSiteWrite = record?.sync?.pendingFoundry === true;
    const repairMissingPresentation = shouldProjectMissingPresentation(record, base);
    if (pendingSiteWrite || repairMissingPresentation) {
        projectSitePresentationOntoFoundryDocument(record, base, { missingOnly: !pendingSiteWrite });
    }
    base.folder = folder?.id || base.folder || null;
    base.flags = mergeObject(base.flags || {}, { [MODULE_ID]: { campaignItemId: id, wikiItemId: id, managedCampaignItem: true, categoryId: category.id, categoryName: category.name, archived: isArchivedRecord(record), archiveIdentityVersion: 1 } });
    return base;
}

function buildWorldItemUpdate(record, item, folder = item.folder) {
    const desired = buildWorldItemData(record, folder);
    const category = categoryIdentityForFolder(folder, resolveRecordCategory(record, latestCategoryRegistry));
    const hasCanonicalDocument = Boolean(record?.foundry?.document && typeof record.foundry.document === "object");
    const currentSource = item.toObject();
    const system = hasCanonicalDocument
        ? (desired.system || {})
        : mergeObject(currentSource.system || {}, desired.system || {});
    return {
        name: desired.name,
        type: desired.type,
        img: desired.img,
        system,
        effects: hasCanonicalDocument ? (desired.effects || []) : (currentSource.effects || []),
        [`flags.${MODULE_ID}.campaignItemId`]: campaignItemId(record),
        folder: desired.folder,
        [`flags.${MODULE_ID}.wikiItemId`]: campaignItemId(record),
        [`flags.${MODULE_ID}.managedCampaignItem`]: true,
        [`flags.${MODULE_ID}.categoryId`]: category.id,
        [`flags.${MODULE_ID}.categoryName`]: category.name,
        [`flags.${MODULE_ID}.archived`]: isArchivedRecord(record),
        [`flags.${MODULE_ID}.archiveIdentityVersion`]: 1,
        ...merchantCostUpdate(desired.flags)
    };
}

function fallbackWorldItemData(record, folder) {
    const classification = normalizeRecordClassification(record);
    return {
        name: String(record?.name || "Oggetto di campagna"),
        type: mapRecordType(record),
        img: resolveItemImage(record?.image) || "icons/svg/item-bag.svg",
        folder: folder?.id || null,
        system: {
            description: { value: renderLegacyDescription(record), unidentified: String(record?.unidentifiedDescription || ""), chat: "" },
            quantity: 1,
            rarity: mapRarity(record?.rarity),
            identified: record?.unidentified !== true,
            attunement: record?.attunement === true ? "required" : "",
            attuned: false,
            type: {
                value: String(classification.subtype || ""),
                baseItem: String(classification.baseItem || "")
            }
        }
    };
}

function shouldRepairMissingPresentation(record, item) {
    if (!record || !item) return false;
    return shouldProjectMissingPresentation(record, item.toObject());
}

function shouldProjectMissingPresentation(record, documentValue) {
    const system = documentValue?.system || {};
    const mainMissing = hasReadableSiteNarrative(record)
        && !String(system?.description?.value || "").trim();
    const unidentifiedMissing = Boolean(String(record?.unidentifiedDescription || "").trim())
        && !String(system?.unidentified?.description || system?.description?.unidentified || "").trim();
    return mainMissing || unidentifiedMissing;
}

function hasReadableSiteNarrative(record) {
    return Boolean(
        String(record?.summary || "").trim()
        || String(record?.notes || "").trim()
        || (Array.isArray(record?.properties) && record.properties.some((property) => property?.hidden !== true
            && (String(property?.name || "").trim() || String(property?.description || "").trim())))
    );
}

function projectSitePresentationOntoFoundryDocument(record, documentValue, { missingOnly = false } = {}) {
    documentValue.system = documentValue.system && typeof documentValue.system === "object"
        ? documentValue.system
        : {};
    const system = documentValue.system;
    const description = system.description && typeof system.description === "object"
        ? system.description
        : {};
    if (!missingOnly || !String(description.value || "").trim()) {
        system.description = { ...description, value: buildSiteDescriptionHtml(record) };
    }

    const unidentified = system.unidentified && typeof system.unidentified === "object"
        ? system.unidentified
        : {};
    const currentUnidentified = String(unidentified.description || description.unidentified || "").trim();
    if (!missingOnly || !currentUnidentified) {
        system.unidentified = {
            ...unidentified,
            description: String(record?.unidentifiedDescription || "")
        };
        if (Object.prototype.hasOwnProperty.call(description, "unidentified")) {
            system.description.unidentified = String(record?.unidentifiedDescription || "");
        }
    }

    if (!missingOnly) {
        system.rarity = mapRarity(record?.rarity);
        system.identified = record?.unidentified !== true;
        system.attunement = record?.attunement === true ? "required" : "";
        if (record?.classification && typeof record.classification === "object" && !Array.isArray(record.classification)) {
            const classification = normalizeRecordClassification(record);
            const currentType = system.type && typeof system.type === "object" && !Array.isArray(system.type) ? system.type : {};
            documentValue.type = mapRecordType(record);
            system.type = {
                ...currentType,
                value: String(classification.subtype || ""),
                baseItem: String(classification.baseItem || "")
            };
        }
        const rawWeight = String(record?.weight ?? "").trim();
        if (rawWeight !== "" && Number.isFinite(Number(rawWeight))) {
            const currentWeight = system.weight && typeof system.weight === "object" ? system.weight : {};
            system.weight = { ...currentWeight, value: Math.max(0, Number(rawWeight)) };
        }
    }
    return documentValue;
}
function sanitizeFoundryDocument(documentValue) {
    return {
        name: String(documentValue.name || "Oggetto di campagna"),
        type: String(documentValue.type || "equipment"),
        img: resolveItemImage(documentValue.img) || "icons/svg/item-bag.svg",
        system: deepClone(documentValue.system || {}),
        effects: normalizeCampaignItemEffects(documentValue.effects),
        flags: deepClone(documentValue.flags || {})
    };
}

function normalizeCampaignItemEffects(effects) {
    return (Array.isArray(effects) ? effects : [])
        .filter((effect) => effect && typeof effect === "object")
        .map((effect) => normalizeActiveEffectSourceV14(effect));
}

async function buildWorldItemSnapshot(item, record) {
    const source = item.toObject();
    const id = getCampaignItemId(item);
    const img = await ensureCampaignItemImage(item, id);
    const folderPath = itemFolderPath(item);
    const category = categoryIdentityForWorldItem(item, record, latestCategoryRegistry);
    const documentValue = {
        name: String(source.name || "Oggetto di campagna"),
        type: String(source.type || "equipment"),
        img: img || String(source.img || ""),
        system: deepClone(source.system || {}),
        effects: normalizeCampaignItemEffects(source.effects),
        flags: sharedCampaignItemFlags(source.flags, category, { archived: isArchivedWorldItem(item) })
    };
    return {
        worldId: normalizeId(game.world?.id || "world"),
        itemId: String(item.id || ""),
        uuid: String(item.uuid || `Item.${item.id}`),
        folderPath,
        document: documentValue,
        hash: hashValue({ document: documentValue, folderPath }),
        recordName: String(record?.name || source.name || "")
    };
}

async function ensureCampaignItemImage(item, id) {
    const source = String(item?.img || "");
    const existing = extractWorkerMediaPath(source);
    if (existing && existing.includes(`/items/${id}.webp`)) return existing;
    if (!source || /^(icons|systems|modules)\//i.test(source)) return source;
    if (typeof callbacks.uploadItemImage !== "function") return source;
    try { return await callbacks.uploadItemImage(source, id); }
    catch (error) {
        console.warn(`${MODULE_ID} | Icona catalogo non caricata; uso il riferimento Foundry.`, { item: item?.name, error });
        return source;
    }
}

async function postFoundrySnapshots(items) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/campaign-items/foundry-sync`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            contract: buildFoundrySyncContract(),
            campaignId: getCampaignId(),
            worldId: normalizeId(game.world?.id || "world"),
            items,
            seedData: latestCatalogRecords
        })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Catalogo oggetti HTTP ${response.status}`);
    return data;
}

async function loadCatalog() {
    if (typeof callbacks.loadCatalog === "function") return callbacks.loadCatalog();
    const url = new URL(`${DISCORD_WORKER_URL}/api/data/items`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-cache" });
    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
}

function managedWorldItems() {
    return Array.from(game.items || []).filter(isManagedWorldItem);
}

function isManagedWorldItem(item) {
    if (!item || item.actor || item.pack) return false;
    if (getCampaignItemId(item) || item.getFlag?.(MODULE_ID, "wikiItemId")) return true;
    return itemIsInsideManagedRoot(item);
}

function itemIsInsideManagedRoot(item) {
    const root = getRootFolder();
    if (!root) return itemFolderPath(item).split(" / ")[0] === ROOT_FOLDER_NAME;
    let folder = item?.folder || null;
    const seen = new Set();
    while (folder) {
        if (typeof folder === "string") folder = game.folders.get(folder) || null;
        if (!folder || seen.has(folder.id)) return false;
        if (folder.id === root.id) return true;
        seen.add(folder.id);
        folder = folder.folder || folder.parent || null;
    }
    return false;
}

function findWorldItemByCampaignId(id, record = null) {
    const direct = managedWorldItems().find((item) => getCampaignItemId(item) === id || normalizeId(item.getFlag?.(MODULE_ID, "wikiItemId")) === id);
    if (direct) return direct;
    const aliases = new Set([record?.name, ...(Array.isArray(record?.foundryNames) ? record.foundryNames : []), ...(Array.isArray(record?.aliases) ? record.aliases : [])].map(normalizeName).filter(Boolean));
    const managedMatch = aliases.size ? managedWorldItems().find((item) => aliases.has(normalizeName(item.name))) || null : null;
    if (managedMatch) return managedMatch;

    // foundryNames e un collegamento esplicito: possiamo adottare un Item fuori
    // dalla radice gestita soltanto quando la corrispondenza e unica.
    const explicitNames = new Set((Array.isArray(record?.foundryNames) ? record.foundryNames : []).map(normalizeName).filter(Boolean));
    if (!explicitNames.size) return null;
    const candidates = Array.from(game.items || []).filter((item) => !item?.actor && !item?.pack && explicitNames.has(normalizeName(item.name)));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        console.warn(`${MODULE_ID} | Alias Foundry ambiguo; creo una copia gestita senza modificare gli originali.`, {
            item: record?.name,
            foundryNames: Array.from(explicitNames),
            matches: candidates.map((item) => item.name)
        });
    }
    return null;
}

async function loadCategoryRegistry() {
    const url = new URL(`${DISCORD_WORKER_URL}/api/item-categories`);
    url.searchParams.set("campaign", getCampaignId());
    url.searchParams.set("_sync", String(Date.now()));
    const response = await policyFetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store"
    });
    if (!response.ok) return { categories: [] };
    const payload = await response.json().catch(() => null);
    return normalizeCategoryRegistry(payload?.data);
}

function normalizeCategoryRegistry(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
        ...source,
        revision: Math.max(0, Math.floor(Number(source.revision || 0))),
        categories: (Array.isArray(source.categories) ? source.categories : []).filter((category) => category?.id && category?.name)
    };
}

async function postCategoryRegistry(categories, expectedRevision) {
    const url = new URL(`${DISCORD_WORKER_URL}/api/item-categories`);
    url.searchParams.set("campaign", getCampaignId());
    const response = await policyFetch(url.toString(), {
        method: "POST",
        headers: { ...buildWorkerAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision, categories })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error || `Categorie oggetti HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return normalizeCategoryRegistry(payload?.data);
}

async function prepareCategoryRegistry(registry) {
    let current = normalizeCategoryRegistry(registry);
    if (canPushToWorker() && current.categories.some((category) => category?.inferred === true)) {
        try {
            current = await postCategoryRegistry(current.categories, current.revision);
        } catch (error) {
            if (error?.status === 409) current = await loadCategoryRegistry();
            else console.warn(`${MODULE_ID} | Registro categorie non ancora reso esplicito; riprovero senza modificare i dati.`, error);
        }
    }
    latestCategoryRegistry = current;
    await getOrCreateRootFolder();
    return current;
}

async function getOrCreateRootFolder() {
    let root = getRootFolder();
    if (!root) {
        root = await Folder.create({
            name: ROOT_FOLDER_NAME,
            type: "Item",
            sorting: "a",
            flags: { [MODULE_ID]: { [ROOT_FOLDER_FLAG]: true } }
        }, { criptaCampaignItemSync: true });
        return root;
    }
    if (root.getFlag?.(MODULE_ID, ROOT_FOLDER_FLAG) !== true) {
        await root.update({ [`flags.${MODULE_ID}.${ROOT_FOLDER_FLAG}`]: true }, { criptaCampaignItemSync: true });
    }
    return root;
}

function getRootFolder() {
    return game.folders.find((folder) => folder?.type === "Item" && folder.getFlag?.(MODULE_ID, ROOT_FOLDER_FLAG) === true)
        || game.folders.find((folder) => folder?.type === "Item" && folder.name === ROOT_FOLDER_NAME && !folderParentId(folder))
        || null;
}

function isRootFolder(folder) {
    if (!folder || folder.type !== "Item") return false;
    if (folder.getFlag?.(MODULE_ID, ROOT_FOLDER_FLAG) === true) return true;
    return folder.name === ROOT_FOLDER_NAME && !folderParentId(folder);
}

function isArchivedRecord(record) {
    return record?.archived === true || String(record?.status || "").trim().toLowerCase() === "archived";
}

function getArchiveFolder() {
    const root = getRootFolder();
    if (!root) return null;
    return Array.from(game.folders || []).find((folder) => folder?.type === "Item"
        && folderParentId(folder) === String(root.id)
        && (folder.getFlag?.(MODULE_ID, ARCHIVE_FOLDER_FLAG) === true || folder.name === ARCHIVE_FOLDER_NAME)) || null;
}

function isArchiveFolder(folder) {
    if (!folder || folder.type !== "Item") return false;
    if (folder.getFlag?.(MODULE_ID, ARCHIVE_FOLDER_FLAG) === true) return true;
    const root = getRootFolder();
    return Boolean(root && folder.name === ARCHIVE_FOLDER_NAME && folderParentId(folder) === String(root.id));
}

async function getOrCreateArchiveFolder() {
    const root = await getOrCreateRootFolder();
    let folder = getArchiveFolder();
    if (!folder) {
        folder = await Folder.create({
            name: ARCHIVE_FOLDER_NAME,
            type: "Item",
            sorting: "a",
            folder: root.id,
            flags: { [MODULE_ID]: { [ARCHIVE_FOLDER_FLAG]: true } }
        }, { criptaCampaignItemSync: true });
    } else if (folder.getFlag?.(MODULE_ID, ARCHIVE_FOLDER_FLAG) !== true || folder.name !== ARCHIVE_FOLDER_NAME) {
        await folder.update({
            name: ARCHIVE_FOLDER_NAME,
            [`flags.${MODULE_ID}.${ARCHIVE_FOLDER_FLAG}`]: true
        }, { criptaCampaignItemSync: true });
    }
    return folder;
}

async function getOrCreateItemFolder(record, registry = null) {
    return isArchivedRecord(record)
        ? getOrCreateArchiveFolder()
        : getOrCreateCategoryFolder(record, registry);
}

function isArchivedWorldItem(item) {
    const folder = categoryFolderForItem(item);
    return folder ? isArchiveFolder(folder) : item?.getFlag?.(MODULE_ID, "archived") === true;
}

function folderParentId(folder) {
    return String(folder?.folder?.id || folder?.folder || folder?.parent?.id || folder?.parent || "");
}

function getFolderCategoryId(folder) {
    return normalizeId(folder?.getFlag?.(MODULE_ID, CATEGORY_FOLDER_ID_FLAG)
        || folder?.flags?.[MODULE_ID]?.[CATEGORY_FOLDER_ID_FLAG]
        || "");
}

function getFolderCategoryName(folder) {
    return String(folder?.getFlag?.(MODULE_ID, CATEGORY_FOLDER_NAME_FLAG)
        || folder?.flags?.[MODULE_ID]?.[CATEGORY_FOLDER_NAME_FLAG]
        || "").trim().slice(0, 120);
}

export function categoryFolderName(value) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "Senza categoria";
}

async function ensureCategoryFolderIdentity(folder, category, { rename = false } = {}) {
    if (!folder || !category?.id || !category?.name) return folder;
    const update = {};
    if (getFolderCategoryId(folder) !== category.id) update[`flags.${MODULE_ID}.${CATEGORY_FOLDER_ID_FLAG}`] = category.id;
    if (getFolderCategoryName(folder) !== category.name) update[`flags.${MODULE_ID}.${CATEGORY_FOLDER_NAME_FLAG}`] = category.name;
    if (rename && folder.name !== categoryFolderName(category.name)) update.name = categoryFolderName(category.name);
    if (Object.keys(update).length) await folder.update(update, { criptaCampaignItemSync: true });
    return folder;
}

async function getOrCreateCategoryFolder(record, registry = null) {
    const category = resolveRecordCategory(record, registry || latestCategoryRegistry);
    const root = await getOrCreateRootFolder();
    const children = Array.from(game.folders || []).filter((folder) => folder?.type === "Item" && folderParentId(folder) === String(root.id));
    let child = children.find((folder) => getFolderCategoryId(folder) === category.id);
    if (!child) {
        const wantedName = normalizeName(category.name);
        child = children.find((folder) => !getFolderCategoryId(folder) && normalizeName(folder.name) === wantedName)
            || children.find((folder) => getFolderCategoryId(folder) === category.id && normalizeName(folder.name) === wantedName)
            || null;
    }
    if (!child) {
        child = await Folder.create({
            name: categoryFolderName(category.name),
            type: "Item",
            sorting: "a",
            folder: root.id,
            flags: { [MODULE_ID]: { [CATEGORY_FOLDER_ID_FLAG]: category.id, [CATEGORY_FOLDER_NAME_FLAG]: category.name } }
        }, { criptaCampaignItemSync: true });
    } else {
        await ensureCategoryFolderIdentity(child, category, { rename: true });
    }
    return child;
}

export function resolveRecordCategory(record, registry = null) {
    const categories = Array.isArray(registry?.categories) ? registry.categories : [];
    const byId = new Map(categories.map((category) => [normalizeId(category?.id || category?.name), category]).filter(([id]) => id));
    const byName = new Map(categories.map((category) => [normalizeName(category?.name), category]).filter(([name]) => name));
    let categoryId = normalizeId(record?.categoryId || record?.category || "");
    let category = byId.get(categoryId) || byName.get(normalizeName(record?.category || "")) || null;
    const visited = new Set();
    while (category && !visited.has(normalizeId(category.id))) {
        categoryId = normalizeId(category.id);
        visited.add(categoryId);
        const merged = normalizeId(category.mergedInto || "");
        if (!merged || !byId.has(merged)) return { id: categoryId, name: String(category.name).trim().slice(0, 120) };
        category = byId.get(merged);
    }
    const explicit = String(record?.category || record?.type || "").trim();
    const type = String(record?.foundry?.document?.type || mapRecordType(record));
    const name = explicit || defaultCategoryNameForFoundryType(type);
    return { id: categoryId || normalizeId(name) || "senza-categoria", name: name.slice(0, 120) || "Senza categoria" };
}

function defaultCategoryNameForFoundryType(type) {
    return ({
        weapon: "Arma",
        equipment: "Oggetto meraviglioso",
        consumable: "Consumabile",
        tool: "Strumento",
        container: "Contenitore",
        loot: "Bottino"
    })[String(type || "")] || "Senza categoria";
}

function folderCategory(record, registry = null) {
    return resolveRecordCategory(record, registry).name;
}

function categoryIdentityForFolder(folder, fallback = null, registry = latestCategoryRegistry) {
    if (isArchiveFolder(folder)) return fallback?.id && fallback?.name ? fallback : { id: "senza-categoria", name: "Senza categoria" };
    const flaggedId = getFolderCategoryId(folder);
    const flaggedName = getFolderCategoryName(folder);
    if (flaggedId) return resolveRecordCategory({ categoryId: flaggedId, category: flaggedName || folder?.name }, registry);
    const exact = (Array.isArray(registry?.categories) ? registry.categories : [])
        .find((category) => normalizeName(category?.name) === normalizeName(folder?.name));
    if (exact) return resolveRecordCategory({ categoryId: exact.id, category: exact.name }, registry);
    if (fallback?.id && fallback?.name) return fallback;
    const name = categoryFolderName(folder?.name || "Senza categoria");
    return { id: normalizeId(name) || "senza-categoria", name };
}

function categoryFolderForItem(item) {
    const root = getRootFolder();
    if (!root) return null;
    let folder = item?.folder || null;
    const seen = new Set();
    while (folder) {
        if (typeof folder === "string") folder = game.folders.get(folder) || null;
        if (!folder || seen.has(folder.id)) return null;
        seen.add(folder.id);
        if (folderParentId(folder) === String(root.id)) return folder;
        folder = folder.folder || folder.parent || null;
    }
    return null;
}

function categoryIdentityForWorldItem(item, record = null, registry = latestCategoryRegistry) {
    const folder = categoryFolderForItem(item);
    const flaggedId = normalizeId(item?.getFlag?.(MODULE_ID, "categoryId") || "");
    const flaggedName = String(item?.getFlag?.(MODULE_ID, "categoryName") || "").trim();
    const fallback = record
        ? resolveRecordCategory(record, registry)
        : flaggedId && flaggedName
            ? resolveRecordCategory({ categoryId: flaggedId, category: flaggedName }, registry)
            : null;
    if (folder) return categoryIdentityForFolder(folder, fallback, registry);
    if (fallback) return fallback;
    return { id: "senza-categoria", name: "Senza categoria" };
}

function categoryFolderNeedsRegistration(folder, registry = latestCategoryRegistry) {
    if (!folder || isArchiveFolder(folder)) return false;
    const id = getFolderCategoryId(folder);
    if (!id) return true;
    const category = (Array.isArray(registry?.categories) ? registry.categories : [])
        .find((entry) => normalizeId(entry?.id) === id);
    return !category || category.inferred === true || normalizeName(category.name) !== normalizeName(folder.name);
}

function queueCategoryFolderChange(folder, reason) {
    categoryFolderQueue = categoryFolderQueue
        .catch(() => undefined)
        .then(() => synchronizeCategoryFolderFromFoundry(folder, reason))
        .catch((error) => console.warn(`${MODULE_ID} | Categoria cartella non sincronizzata; nessun dato e stato rimosso.`, { folder: folder?.name, error }));
}

async function synchronizeCategoryFolderFromFoundry(folder, reason) {
    if (!folder || folder.type !== "Item") return false;
    if (isRootFolder(folder)) {
        await getOrCreateRootFolder();
        requestCampaignItemReconcile();
        return true;
    }
    const root = await getOrCreateRootFolder();
    if (folderParentId(folder) !== String(root.id)) return false;
    if (isArchiveFolder(folder)) {
        if (folder.getFlag?.(MODULE_ID, ARCHIVE_FOLDER_FLAG) !== true) {
            await folder.update({ [`flags.${MODULE_ID}.${ARCHIVE_FOLDER_FLAG}`]: true }, { criptaCampaignItemSync: true });
        }
        requestCampaignItemReconcile();
        return true;
    }

    let registry = await loadCategoryRegistry();
    const exact = registry.categories.find((category) => normalizeName(category?.name) === normalizeName(folder.name));
    let categoryId = getFolderCategoryId(folder) || normalizeId(exact?.id || folder.name) || `categoria-${normalizeId(folder.id)}`;
    const collision = registry.categories.find((category) => normalizeId(category?.id) === categoryId && normalizeName(category?.name) !== normalizeName(folder.name));
    if (!getFolderCategoryId(folder) && collision) categoryId = `${categoryId}-${normalizeId(folder.id).slice(0, 8)}`;

    const currentCategory = registry.categories.find((category) => normalizeId(category?.id) === categoryId);
    const categoryChanged = !currentCategory
        || currentCategory.inferred === true
        || normalizeName(currentCategory.name) !== normalizeName(folder.name);
    if (categoryChanged) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const categories = registry.categories.map((category) => ({ ...category }));
            const index = categories.findIndex((category) => normalizeId(category?.id) === categoryId);
            if (index >= 0) categories[index] = { ...categories[index], name: categoryFolderName(folder.name) };
            else categories.push({
                id: categoryId,
                name: categoryFolderName(folder.name),
                order: categories.reduce((max, category) => Math.max(max, Number(category?.order || 0)), 0) + 10,
                color: "#b99a45",
                icon: "fa-folder-open",
                archived: false,
                mergedInto: ""
            });
            try {
                registry = await postCategoryRegistry(categories, registry.revision);
                break;
            } catch (error) {
                if (error?.status !== 409 || attempt === 2) throw error;
                registry = await loadCategoryRegistry();
            }
        }
    }

    const resolved = resolveRecordCategory({ categoryId, category: folder.name }, registry);
    await ensureCategoryFolderIdentity(folder, resolved);
    latestCategoryRegistry = registry;
    for (const item of managedWorldItems()) {
        if (categoryFolderForItem(item)?.id === folder.id) scheduleCampaignItemPush(item);
    }
    requestCampaignItemReconcile();
    console.info(`${MODULE_ID} | Categoria oggetti sincronizzata dalla cartella Foundry.`, { categoryId: resolved.id, name: resolved.name, reason });
    return true;
}

function requestCampaignItemReconcile() {
    reconcileRequested = true;
    if (reconciling) return;
    if (categoryReconcileTimer) window.clearTimeout(categoryReconcileTimer);
    categoryReconcileTimer = window.setTimeout(() => {
        categoryReconcileTimer = null;
        reconcileRequested = false;
        reconcileCampaignItemsNow().catch(reportSyncError);
    }, 600);
}

function itemFolderPath(item) {
    const names = [];
    let folder = item?.folder || null;
    const seen = new Set();
    while (folder) {
        if (typeof folder === "string") folder = game.folders.get(folder) || null;
        if (!folder || seen.has(folder.id)) break;
        seen.add(folder.id);
        names.unshift(String(folder.name || ""));
        const parent = folder.folder || folder.parent || null;
        folder = typeof parent === "string" ? game.folders.get(parent) || null : parent;
    }
    return names.filter(Boolean).join(" / ");
}

function campaignItemId(record) {
    return normalizeId(record?.id || record?.campaignItemId || record?.name);
}

function getCampaignItemId(item) {
    return normalizeId(item?.getFlag?.(MODULE_ID, "campaignItemId") || item?.flags?.[MODULE_ID]?.campaignItemId || "");
}

function normalizeRecordClassification(record) {
    const source = record?.classification && typeof record.classification === "object" && !Array.isArray(record.classification)
        ? record.classification
        : {};
    const supported = new Set(["weapon", "armor", "consumable", "equipment", "tool", "material", "loot", "container"]);
    const explicitFamily = String(source.family || "").trim().toLowerCase();
    const legacyType = normalizeName(record?.type);
    const legacyFamily = legacyType.includes("arma") && !legacyType.includes("armatura")
        ? "weapon"
        : legacyType.includes("armatura") || legacyType === "scudo"
            ? "armor"
            : legacyType.includes("pozione") || legacyType.includes("pergamena") || legacyType.includes("consum")
                ? "consumable"
                : legacyType.includes("material")
                    ? "material"
                    : legacyType.includes("bottino")
                        ? "loot"
                        : legacyType.includes("strument")
                            ? "tool"
                            : legacyType.includes("conten")
                                ? "container"
                                : "equipment";
    const family = supported.has(explicitFamily) ? explicitFamily : legacyFamily;
    const subtype = String(source.subtype || "").trim().slice(0, 80);
    const baseItem = String(source.baseItem || "").trim().slice(0, 120);
    return { version: 1, family, ...(subtype ? { subtype } : {}), ...(baseItem ? { baseItem } : {}) };
}

function mapRecordType(record) {
    const family = normalizeRecordClassification(record).family;
    return ({ weapon: "weapon", armor: "equipment", consumable: "consumable", equipment: "equipment", tool: "tool", material: "loot", loot: "loot", container: "container" })[family] || "equipment";
}

function mapRarity(value) {
    const map = { comune: "common", noncomune: "uncommon", raro: "rare", epico: "veryRare", moltoraro: "veryRare", leggendario: "legendary", artefatto: "artifact" };
    return map[normalizeName(value).replace(/\s/g, "")] || "";
}

function renderLegacyDescription(record) {
    return buildSiteDescriptionHtml(record) || "<p>" + escapeFoundryHtml(record?.name || "Oggetto di campagna") + "</p>";
}

function buildSiteDescriptionHtml(record) {
    const summary = renderFoundryParagraphs(record?.summary);
    const properties = (Array.isArray(record?.properties) ? record.properties : []).filter((property) => property?.hidden !== true);
    const propertyCards = properties.map((property) => {
        const toneClass = property?.negative === true
            ? "cripta-catalog-property--negative"
            : property?.genial === true ? "cripta-catalog-property--genial" : "cripta-catalog-property--normal";
        const heading = property?.name
            ? "<h3><span>" + escapeFoundryHtml(property.name) + "</span>"
                + (property.charges ? '<small class="cripta-catalog-property-charges">' + escapeFoundryHtml(property.charges) + "</small>" : "")
                + "</h3>"
            : "";
        const description = renderFoundryParagraphs(property?.description);
        return '<section class="cripta-catalog-property ' + toneClass + '">' + heading + description + "</section>";
    }).filter(Boolean).join("");
    const notes = renderFoundryParagraphs(record?.notes);
    const parts = [
        summary ? '<section class="cripta-catalog-summary">' + summary + "</section>" : "",
        propertyCards ? '<div class="cripta-catalog-properties">' + propertyCards + "</div>" : "",
        notes ? '<aside class="cripta-catalog-notes"><h4>Note della campagna</h4>' + notes + "</aside>" : ""
    ].filter(Boolean);
    return parts.length ? '<div class="cripta-catalog-description">' + parts.join("") + "</div>" : "";
}

function renderFoundryParagraphs(value, { emphasis = false } = {}) {
    const text = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return "";
    return text.split(/\n{2,}/).map((block) => {
        const content = escapeFoundryHtml(block).replace(/\n/g, "<br />");
        return "<p>" + (emphasis ? "<em>" + content + "</em>" : content) + "</p>";
    }).join("");
}

function escapeFoundryHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function resolveItemImage(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^(https?:|data:|icons\/|systems\/|modules\/|worlds\/)/i.test(raw)) return raw;
    if (raw.startsWith("media/")) return `${DISCORD_WORKER_URL}/${raw}`;
    return `${String(game.settings.get(MODULE_ID, SETTINGS.SITE_BASE_URL) || "").replace(/\/$/, "")}/${raw.replace(/^\/+/, "")}`;
}

function extractWorkerMediaPath(value) {
    const clean = String(value || "").split(/[?#]/)[0].replace(/\\/g, "/");
    const index = clean.indexOf("/media/");
    if (index >= 0) return clean.slice(index + 1);
    return clean.replace(/^\/+/, "").startsWith("media/") ? clean.replace(/^\/+/, "") : "";
}

function sharedCampaignItemFlags(flags, category = null, { archived = false } = {}) {
    const merchant = flags?.["khuzoe-merchant"];
    const campaign = flags?.[MODULE_ID] || {};
    const categoryId = normalizeId(category?.id || campaign.categoryId || "");
    const categoryName = String(category?.name || campaign.categoryName || "").trim().slice(0, 120);
    return {
        ...(merchant && Object.prototype.hasOwnProperty.call(merchant, "cost") ? { "khuzoe-merchant": { cost: deepClone(merchant.cost) } } : {}),
        [MODULE_ID]: { categoryId, categoryName, categoryIdentityVersion: 2, archived: archived === true, archiveIdentityVersion: 1 }
    };
}

function merchantCostUpdate(flags) {
    const merchant = flags?.["khuzoe-merchant"];
    if (!merchant || !Object.prototype.hasOwnProperty.call(merchant, "cost")) return {};
    return { "flags.khuzoe-merchant.cost": deepClone(merchant.cost) };
}

function hasMeaningfulUpdate(item, update) {
    const source = item.toObject();
    const merchantCostPath = "flags.khuzoe-merchant.cost";
    const currentCost = source.flags?.["khuzoe-merchant"]?.cost ?? null;
    const desiredCost = Object.prototype.hasOwnProperty.call(update, merchantCostPath) ? update[merchantCostPath] : currentCost;
    const desired = {
        name: update.name, type: update.type, img: update.img,
        system: update.system || {}, effects: update.effects || [], merchantCost: desiredCost, folder: String(update.folder || ""),
        categoryId: String(update[`flags.${MODULE_ID}.categoryId`] || ""),
        categoryName: String(update[`flags.${MODULE_ID}.categoryName`] || "")
    };
    const current = {
        name: item.name, type: item.type, img: item.img,
        system: source.system || {}, effects: source.effects || [], merchantCost: currentCost, folder: String(item.folder?.id || item.folder || ""),
        categoryId: String(source.flags?.[MODULE_ID]?.categoryId || ""),
        categoryName: String(source.flags?.[MODULE_ID]?.categoryName || "")
    };
    return hashValue(desired) !== hashValue(current);
}

function canRunCampaignItemSync(direction = "push") {
    if (!game.user?.isGM) return false;
    if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return false;
    return direction === "pull" ? canPullFromWorker() : canPushToWorker();
}

function getSyncState() {
    try {
        const value = game.settings.get(MODULE_ID, STATE_SETTING);
        return value && typeof value === "object" ? value : { schemaVersion: 1, items: {} };
    } catch (_) { return { schemaVersion: 1, items: {} }; }
}

function setSyncState(value) {
    return game.settings.set(MODULE_ID, STATE_SETTING, value);
}

function buildWorkerAuthHeaders() {
    const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
    const secret = String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_SYNC_SECRET) || "").trim();
    if (!secret && !token) throw new Error("Configura il Secret sync per sincronizzare il catalogo oggetti.");
    return { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(secret ? { "X-Cripta-Inventory-Secret": secret } : {}) };
}

function getCampaignId() {
    return normalizeId(game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || "cripta-di-sangue") || "cripta-di-sangue";
}

function normalizeId(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function normalizeName(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function deepClone(value) {
    return foundry?.utils?.deepClone ? foundry.utils.deepClone(value) : JSON.parse(JSON.stringify(value));
}

function mergeObject(left, right) {
    return foundry?.utils?.mergeObject ? foundry.utils.mergeObject(left, right, { inplace: false }) : { ...left, ...right };
}

function getProperty(object, path) {
    return foundry?.utils?.getProperty ? foundry.utils.getProperty(object, path) : path.split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
    if (foundry?.utils?.setProperty) return foundry.utils.setProperty(object, path, value);
    const keys = path.split(".");
    let cursor = object;
    while (keys.length > 1) cursor = cursor[keys.shift()] ||= {};
    cursor[keys[0]] = value;
    return true;
}

function hashValue(value) {
    const stable = (entry) => entry && typeof entry === "object"
        ? Array.isArray(entry) ? `[${entry.map(stable).join(",")}]` : `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${stable(entry[key])}`).join(",")}}`
        : JSON.stringify(entry);
    const text = stable(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function reportSyncError(error) {
    console.warn(`${MODULE_ID} | Sync catalogo oggetti rimandata.`, error);
}




