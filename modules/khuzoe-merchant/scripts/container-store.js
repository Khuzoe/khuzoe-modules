import { MODULE_ID } from "./constants.js";
import { containerIsLocked, getContainer, normalizeContainer } from "./container-data.js";
import { publicProduction } from "./production-data.js";
import { canonicalActor, getMerchant, itemDescription, logError, normalizeMerchant, primaryGM } from "./utils.js";

const VAULT_FLAG = "containerVault";
const MERCHANT_VAULT_FLAG = "merchantVault";
const VAULT_MARKER = "khuzoe-container-vault";
const VAULT_KEY_FLAG = "vaultKey";
const VAULT_RECORD_FLAG = "vaultRecord";

function tokenDocument(value) {
  return value?.document || value || null;
}

function vaultById(id) {
  return id ? game.journal?.get?.(id) || null : null;
}

function existingVault() {
  return Array.from(game.journal || []).find((journal) => journal.getFlag?.(MODULE_ID, VAULT_MARKER)) || null;
}

async function ensureVault() {
  let vault = existingVault();
  if (vault) return vault;
  if (!game.user?.isGM) return null;
  vault = await JournalEntry.create({
    name: "[Khuzoe Merchant] Archivio protetto",
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: {
      [MODULE_ID]: {
        [VAULT_MARKER]: true,
        [VAULT_FLAG]: {},
        [MERCHANT_VAULT_FLAG]: {}
      }
    }
  }, { khuzoeMerchantContainerVault: true });
  return vault || null;
}

function vaultPage(vault, key) {
  return Array.from(vault?.pages || []).find((page) => page.getFlag?.(MODULE_ID, VAULT_KEY_FLAG) === key) || null;
}

function legacyVaultRecord(vault, collectionFlag, key) {
  return vault?.getFlag?.(MODULE_ID, collectionFlag)?.[key] || null;
}

function readVaultRecord(vault, collectionFlag, key) {
  return vaultPage(vault, key)?.getFlag?.(MODULE_ID, VAULT_RECORD_FLAG)
    || legacyVaultRecord(vault, collectionFlag, key);
}

async function writeVaultPage(vault, key, name, record) {
  let page = vaultPage(vault, key);
  const previousRecord = page?.getFlag?.(MODULE_ID, VAULT_RECORD_FLAG) || null;
  let created = false;
  if (!page) {
    const pages = await vault.createEmbeddedDocuments("JournalEntryPage", [{
      name: String(name || "Record").slice(0, 120),
      type: "text",
      text: { content: "" },
      flags: {
        [MODULE_ID]: {
          [VAULT_KEY_FLAG]: key,
          [VAULT_RECORD_FLAG]: record
        }
      }
    }], { khuzoeMerchantVault: true });
    page = pages?.[0] || null;
    created = true;
    if (!page) throw new Error("Unable to create the vault page.");
  } else {
    await page.setFlag(MODULE_ID, VAULT_RECORD_FLAG, record);
  }
  return {
    record,
    rollback: async () => {
      if (created) {
        await vault.deleteEmbeddedDocuments("JournalEntryPage", [page.id], { khuzoeMerchantRollback: true });
      } else {
        await page.setFlag(MODULE_ID, VAULT_RECORD_FLAG, previousRecord);
      }
    }
  };
}

function publicMerchant(merchant, vaultId) {
  const clean = normalizeMerchant(merchant);
  return normalizeMerchant({
    ...clean,
    vaultRef: vaultId,
    production: publicProduction(clean.production),
    inventory: clean.inventory.map((entry) => ({
      ...entry,
      description: itemDescription(entry),
      data: {},
      dataBundle: undefined
    }))
  });
}

export async function getAuthoritativeMerchant(value) {
  const actor = canonicalActor(value);
  const visible = getMerchant(actor);
  if (!actor || !game.user?.isGM || !visible.vaultRef) return visible;
  const vault = vaultById(visible.vaultRef) || existingVault();
  const stored = readVaultRecord(vault, MERCHANT_VAULT_FLAG, `merchant:${actor.uuid}`)
    || legacyVaultRecord(vault, MERCHANT_VAULT_FLAG, actor.uuid);
  if (!stored) return visible;
  const authoritative = normalizeMerchant(stored);
  return authoritative.revision >= visible.revision ? authoritative : visible;
}

export async function saveAuthoritativeMerchant(value, merchant) {
  const actor = canonicalActor(value);
  if (!actor) throw new Error("Merchant Actor unavailable.");
  const clean = normalizeMerchant(merchant);
  const vault = clean.vaultRef ? vaultById(clean.vaultRef) || await ensureVault() : await ensureVault();
  if (!vault) throw new Error("Merchant vault unavailable.");
  const stored = normalizeMerchant({ ...clean, vaultRef: vault.id });
  const written = await writeVaultPage(vault, `merchant:${actor.uuid}`, `Mercante — ${actor.name || actor.id}`, stored);
  try {
    await actor.setFlag(MODULE_ID, "merchant", publicMerchant(stored, vault.id));
  } catch (error) {
    try {
      await written.rollback();
    } catch (rollbackError) {
      logError("Merchant vault rollback failed", rollbackError);
    }
    throw error;
  }
  return stored;
}

function publicContainer(container, vaultId) {
  const clean = normalizeContainer(container);
  const locked = containerIsLocked(clean);
  return normalizeContainer({
    ...clean,
    vaultRef: vaultId,
    production: publicProduction(clean.production),
    sourceUuids: clean.sourceUuids,
    inventory: locked ? [] : clean.inventory.map((entry) => ({
      ...entry,
      description: itemDescription(entry),
      sourceUuid: "",
      data: {},
      dataBundle: undefined
    })),
    currency: locked ? {} : clean.currency,
    key: clean.key ? {
      fingerprint: "vault",
      identityId: "",
      identityBound: false,
      sourceUuid: "",
      name: clean.key.name,
      img: clean.key.img,
      type: clean.key.type,
      data: {},
      inserted: clean.key.inserted,
      insertedData: null
    } : null
  });
}

async function writeVaultRecord(vault, token, container) {
  const stored = normalizeContainer({ ...container, vaultRef: vault.id });
  return writeVaultPage(vault, `container:${token.uuid}`, `Contenitore — ${token.name || token.id}`, stored);
}

export async function getAuthoritativeContainer(value) {
  const token = tokenDocument(value);
  const visible = getContainer(token);
  if (!visible || !game.user?.isGM || !visible.vaultRef) return visible;
  const vault = vaultById(visible.vaultRef) || existingVault();
  const stored = readVaultRecord(vault, VAULT_FLAG, `container:${token.uuid}`)
    || legacyVaultRecord(vault, VAULT_FLAG, token.uuid);
  if (!stored) return visible;
  const authoritative = normalizeContainer(stored);
  return authoritative.revision >= visible.revision ? authoritative : visible;
}

/**
 * Save the complete state to a GM-only Journal first. The Token receives display
 * metadata only; locked chests additionally hide their inventory and currencies.
 */
export async function saveAuthoritativeContainer(value, container, update = {}, options = {}) {
  const token = tokenDocument(value);
  if (!token) throw new Error("Container Token unavailable.");
  const clean = normalizeContainer(container);
  let publicData = clean;
  let vault = clean.vaultRef ? vaultById(clean.vaultRef) : null;
  let written = null;

  vault ||= await ensureVault();
  if (!vault) throw new Error("Container vault unavailable.");
  written = await writeVaultRecord(vault, token, clean);
  const stored = written.record;
  publicData = publicContainer(stored, vault.id);

  try {
    await token.update({
      ...update,
      [`flags.${MODULE_ID}.container`]: publicData
    }, options);
  } catch (error) {
    if (written) {
      try {
        await written.rollback();
      } catch (rollbackError) {
        logError("Container vault rollback failed", rollbackError);
      }
    }
    throw error;
  }
  return clean;
}

export async function migrateContainersToVault() {
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return 0;
  let migrated = 0;
  for (const scene of game.scenes || []) {
    for (const token of scene.tokens || []) {
      const container = getContainer(token);
      if (!container || container.vaultRef) continue;
      try {
        await saveAuthoritativeContainer(token, container, {}, { khuzoeMerchantContainerMigration: true });
        migrated += 1;
      } catch (error) {
        logError("Container vault migration failed", { token: token.uuid, error });
      }
    }
  }
  return migrated;
}

export async function migrateMerchantsToVault() {
  const gm = primaryGM();
  if (!game.user?.isGM || gm?.id !== game.user.id) return 0;
  let migrated = 0;
  for (const actor of game.actors || []) {
    const merchant = getMerchant(actor);
    if (!actor.getFlag?.(MODULE_ID, "merchant") || merchant.vaultRef) continue;
    try {
      await saveAuthoritativeMerchant(actor, merchant);
      migrated += 1;
    } catch (error) {
      logError("Merchant vault migration failed", { actor: actor.uuid, error });
    }
  }
  return migrated;
}
