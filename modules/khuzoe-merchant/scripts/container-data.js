import { DEFAULT_CONTAINER, MODULE_ID } from "./constants.js";
import { tokenDistance } from "./distance.js";
import { normalizeProduction } from "./production-data.js";
import { duplicate, itemDescription } from "./utils.js";
import { objectTokenDefaults } from "./map-object.js";

const CONTAINER_FLAG = "container";
const CONTAINER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function containerDocument(value) {
  return value?.document || value || null;
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 10000) / 10000 : 0;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function containerItemFingerprint(item) {
  const data = duplicate(item?.toObject ? item.toObject() : item || {});
  const campaignId = foundry.utils.getProperty(data, "flags.cripta-wiki-sync.campaignItemId")
    || foundry.utils.getProperty(data, "flags.cripta-wiki-sync.wikiItemId");
  if (campaignId) return `campaign:${String(campaignId).trim().toLowerCase()}`;
  const sourceId = data?._stats?.compendiumSource || foundry.utils.getProperty(data, "flags.core.sourceId");
  if (sourceId) return `source:${String(sourceId).trim().toLowerCase()}`;
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  delete data._stats;
  if (data.system) {
    delete data.system.quantity;
    delete data.system.equipped;
    delete data.system.attuned;
    delete data.system.attunement;
    delete data.system.container;
  }
  if (data.flags?.[MODULE_ID]) {
    delete data.flags[MODULE_ID].containerTransfer;
    delete data.flags[MODULE_ID].containerDeposit;
    delete data.flags[MODULE_ID].groundTransfer;
    delete data.flags[MODULE_ID].purchased;
    delete data.flags[MODULE_ID].containerKey;
    delete data.flags[MODULE_ID].keyIdentity;
    if (!Object.keys(data.flags[MODULE_ID]).length) delete data.flags[MODULE_ID];
  }
  if (data.flags?.["cripta-wiki-sync"]) delete data.flags["cripta-wiki-sync"].transferId;
  return `data:${shortHash(stableStringify(data))}`;
}

function cleanKey(key) {
  if (!key || typeof key !== "object") return null;
  const fingerprint = String(key.fingerprint || "").trim();
  const name = String(key.name || "").trim().slice(0, 120);
  if (!fingerprint || !name) return null;
  const inserted = Boolean(key.inserted);
  return {
    fingerprint,
    identityId: String(key.identityId || "").trim().slice(0, 80),
    identityBound: Boolean(key.identityBound),
    sourceUuid: String(key.sourceUuid || ""),
    name,
    img: String(key.img || "icons/svg/key.svg"),
    type: String(key.type || "loot").slice(0, 60),
    data: duplicate(key.data || {}),
    inserted,
    insertedData: inserted && key.insertedData && typeof key.insertedData === "object"
      ? duplicate(key.insertedData)
      : null
  };
}

/**
 * New keys carry a private, module-level identity after their first use. Existing
 * worlds keep working through the legacy fingerprint and are upgraded in-place
 * the first time the key is inserted.
 */
export function containerKeyMatches(item, key) {
  if (!item || !key) return false;
  const itemIdentity = String(foundry.utils.getProperty(
    item?.toObject ? item.toObject() : item,
    `flags.${MODULE_ID}.keyIdentity`
  ) || "").trim();
  const expectedIdentity = String(key.identityId || "").trim();
  if (key.identityBound) return Boolean(expectedIdentity && itemIdentity === expectedIdentity);
  if (expectedIdentity && itemIdentity) return expectedIdentity === itemIdentity;
  return containerItemFingerprint(item) === String(key.fingerprint || "");
}

function cleanEntry(entry, index = 0) {
  const quantity = Math.max(0, Math.floor(Number(entry?.quantity) || 0));
  return {
    id: String(entry?.id || `container-entry-${index}`),
    sourceUuid: String(entry?.sourceUuid || ""),
    name: String(entry?.name || "Oggetto").slice(0, 120),
    img: String(entry?.img || "icons/svg/item-bag.svg"),
    type: String(entry?.type || "item").slice(0, 60),
    description: itemDescription(entry),
    quantity,
    sort: Number.isFinite(Number(entry?.sort)) ? Number(entry.sort) : index,
    data: duplicate(entry?.data || {}),
    dataBundleMode: entry?.dataBundleMode === "single" ? "single" : "copies",
    dataBundle: Array.isArray(entry?.dataBundle) && entry.dataBundle.length
      ? duplicate(entry.dataBundle)
      : undefined
  };
}

export function normalizeContainer(source = {}) {
  const raw = source && typeof source === "object" ? source : {};
  const production = normalizeProduction(raw.production);
  const currency = {};
  for (const [id, value] of Object.entries(raw.currency || {})) {
    const normalizedId = String(id).trim().toLowerCase();
    const amount = finiteAmount(value);
    if (CONTAINER_ID_PATTERN.test(normalizedId) && amount > 0) currency[normalizedId] = amount;
  }

  const inventory = (Array.isArray(raw.inventory) ? raw.inventory : [])
    .map(cleanEntry)
    .filter((entry) => entry.quantity > 0);
  const sourceUuids = [...new Set([
    ...(Array.isArray(raw.sourceUuids) ? raw.sourceUuids : []),
    ...inventory.map((entry) => entry.sourceUuid),
    ...production.rules.map((rule) => rule.sourceUuid)
  ].map((uuid) => String(uuid || "").trim()).filter(Boolean))].slice(0, 500);

  return {
    schemaVersion: 2,
    revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
    vaultRef: String(raw.vaultRef || "").trim().slice(0, 80),
    name: String(raw.name || DEFAULT_CONTAINER.name).trim().slice(0, 120) || DEFAULT_CONTAINER.name,
    img: String(raw.img || DEFAULT_CONTAINER.img).trim().slice(0, 500) || DEFAULT_CONTAINER.img,
    description: String(raw.description || "").trim().slice(0, 1000),
    emptyBehavior: raw.emptyBehavior === "delete" ? "delete" : "keep",
    key: cleanKey(raw.key),
    sourceUuids,
    inventory,
    currency,
    production
  };
}

export function getContainer(value) {
  const stored = containerDocument(value)?.getFlag?.(MODULE_ID, CONTAINER_FLAG);
  return stored && typeof stored === "object" ? normalizeContainer(stored) : null;
}

export function containerIsLocked(container) {
  const normalized = normalizeContainer(container);
  return Boolean(normalized.key && !normalized.key.inserted);
}

export function containerIsEmpty(container) {
  const normalized = normalizeContainer(container);
  if (normalized.key) return false;
  if (normalized.production.enabled && normalized.production.rules.length) return false;
  return !normalized.inventory.some((entry) => entry.quantity > 0)
    && !Object.values(normalized.currency).some((amount) => finiteAmount(amount) > 0);
}
export function containerDistance(buyerToken, containerToken) {
  const buyerDocument = containerDocument(buyerToken);
  const chestDocument = containerDocument(containerToken);
  const scene = buyerDocument?.parent;
  if (!buyerDocument || !chestDocument || !scene || chestDocument.parent !== scene) {
    return Number.POSITIVE_INFINITY;
  }
  return tokenDistance(buyerDocument, chestDocument, scene);
}

export function containerCurrencyIcon(currency) {
  const raw = String(currency?.icon || "").trim();
  if (/^media\//i.test(raw)) return `https://sigillo-api.khuzoe.workers.dev/${raw.replace(/^\/+/, "")}`;
  if (raw) return raw;
  const defaults = {
    pp: "icons/commodities/currency/coins-assorted-mix-platinum.webp",
    gp: "icons/commodities/currency/coins-plain-stack-gold.webp",
    ep: "icons/commodities/currency/coin-engraved-oval-steel.webp",
    sp: "icons/commodities/currency/coins-plain-stack-silver.webp",
    cp: "icons/commodities/currency/coins-wheat-stack-copper.webp"
  };
  return defaults[currency?.id] || "";
}

export function buildContainerTokenData(scene, source, options = {}) {
  const container = normalizeContainer(source);
  const size = Number(scene?.grid?.size) || Number(scene?.dimensions?.size) || 100;
  const width = Math.max(0.5, Number(options.width) || 1);
  const height = Math.max(0.5, Number(options.height) || 1);
  const pixelWidth = width * size;
  const pixelHeight = height * size;
  let x = Number(options.x) - (pixelWidth / 2);
  let y = Number(options.y) - (pixelHeight / 2);

  const dimensions = scene?.dimensions || {};
  const minX = Number(dimensions.sceneX) || 0;
  const minY = Number(dimensions.sceneY) || 0;
  const maxX = minX + (Number(dimensions.sceneWidth) || Number(dimensions.width) || (x + pixelWidth));
  const maxY = minY + (Number(dimensions.sceneHeight) || Number(dimensions.height) || (y + pixelHeight));
  x = Math.round(Math.min(Math.max(minX, x), Math.max(minX, maxX - pixelWidth)));
  y = Math.round(Math.min(Math.max(minY, y), Math.max(minY, maxY - pixelHeight)));

  return {
    name: container.name,
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
    actorId: String(options.actorId || "").trim() || null,
    actorLink: false,
    x,
    y,
    width,
    height,
    elevation: Number(options.elevation) || 0,
    rotation: 0,
    lockRotation: true,
    alpha: 1,
    hidden: Boolean(options.hidden),
    locked: false,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    ...objectTokenDefaults(),
    texture: {
      src: container.img,
      fit: "contain",
      scaleX: 0.9,
      scaleY: 0.9
    },
    sight: { enabled: false },
    flags: {
      [MODULE_ID]: {
        [CONTAINER_FLAG]: container
      }
    }
  };
}
