import { DEFAULT_MERCHANT, FLAG_KEY, MODULE_ID } from "./constants.js";
import { normalizeProduction } from "./production-data.js";
import { isProxyActor } from "./map-object.js";

export function duplicate(value) {
  return foundry.utils.deepClone(value);
}

export function canonicalActor(actor) {
  if (!actor || actor.documentName !== "Actor") return actor ?? null;
  const baseActorId = actor.token?.actorId ?? actor.parent?.actorId ?? actor.id;
  return game.actors?.get(baseActorId) ?? actor;
}

export function normalizeMerchant(source = {}) {
  const stored = source && typeof source === "object" ? source : {};
  const merchant = foundry.utils.mergeObject(duplicate(DEFAULT_MERCHANT), duplicate(stored), {
    inplace: false,
    overwrite: true,
    insertKeys: true,
    insertValues: true
  });
  merchant.enabled = Boolean(merchant.enabled);
  merchant.schemaVersion = 2;
  merchant.revision = Math.max(0, Math.floor(Number(merchant.revision) || 0));
  merchant.vaultRef = String(merchant.vaultRef || "").trim().slice(0, 80);
  merchant.distance = Math.max(0, Number(merchant.distance) || 0);
  merchant.subtitle = String(merchant.subtitle ?? "").slice(0, 160);
  merchant.inventory = Array.isArray(merchant.inventory) ? merchant.inventory : [];
  merchant.production = normalizeProduction(merchant.production);
  return merchant;
}

export function getMerchant(actor) {
  actor = canonicalActor(actor);
  return normalizeMerchant(actor?.getFlag(MODULE_ID, FLAG_KEY) ?? {});
}

export function isMerchant(actor) {
  return Boolean(getMerchant(actor).enabled);
}

export function isSupportedActor(actor) {
  if (!actor || actor.documentName !== "Actor") return false;
  if (isProxyActor(actor)) return false;
  if (isMerchant(actor)) return true;
  const configured = String(game.settings.get(MODULE_ID, "merchantActorTypes") ?? "npc")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes("*") || configured.includes(String(actor.type).toLowerCase());
}

export function localize(key, data = undefined) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

export function notifyError(key, data = undefined) {
  ui.notifications.error(localize(key, data));
}

export function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function plainText(value, maxLength = 180) {
  const element = document.createElement("div");
  element.innerHTML = String(value ?? "");
  const secrets = element.querySelectorAll?.(
    ".secret, [data-secret], [data-visibility='gm'], [data-visibility='owner']"
  ) || [];
  for (const secret of secrets) secret.remove();
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

export function itemDescription(source) {
  const systemDescription = source?.system?.description;
  const legacyDescription = source?.documentName
    ? undefined
    : source?.data?.system?.description;
  const candidates = [
    systemDescription?.value,
    systemDescription,
    legacyDescription?.value,
    legacyDescription,
    source?.description
  ];
  const description = candidates.find((value) => typeof value === "string" && value.trim());
  return plainText(description ?? "", Number.POSITIVE_INFINITY);
}

export async function refreshMerchantEntry(entry, source = undefined) {
  let item = source;
  if (item === undefined && entry?.sourceUuid && typeof globalThis.fromUuid === "function") {
    try {
      item = await globalThis.fromUuid(entry.sourceUuid);
    } catch (_error) {
      item = null;
    }
  }
  if (item?.documentName !== "Item") return entry;

  return {
    ...entry,
    name: String(item.name ?? entry?.name ?? "Item").slice(0, 120),
    img: item.img || entry?.img || "icons/svg/item-bag.svg",
    type: String(item.type ?? entry?.type ?? "item").slice(0, 60),
    description: itemDescription(item),
    data: item.toObject()
  };
}

/** Resolve each source UUID once per render, even if several entries reference it. */
export async function refreshMerchantEntries(entries = []) {
  const sources = new Map();
  const uuids = [...new Set(entries.map((entry) => String(entry?.sourceUuid || "")).filter(Boolean))];
  await Promise.all(uuids.map(async (uuid) => {
    try {
      sources.set(uuid, typeof globalThis.fromUuid === "function" ? await globalThis.fromUuid(uuid) : null);
    } catch (_error) {
      sources.set(uuid, null);
    }
  }));
  return Promise.all(entries.map((entry) => refreshMerchantEntry(
    entry,
    entry?.sourceUuid ? sources.get(String(entry.sourceUuid)) : undefined
  )));
}

export function clampInteger(value, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

export function primaryGM() {
  if (game.users?.activeGM) return game.users.activeGM;
  return Array.from(game.users || [])
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => (Number(b.role) - Number(a.role)) || String(a.id).localeCompare(String(b.id), "en"))[0] ?? null;
}

export function isActorOwner(actor, user = game.user) {
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return Boolean(actor?.testUserPermission(user, ownerLevel));
}

export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

export function logError(...args) {
  console.error(`${MODULE_ID} |`, ...args);
}
