import { MODULE_ID } from "./constants.js";
import { tokenDistance } from "./distance.js";
import { GROUND_LOOT_PROXY_FLAG, objectTokenDefaults } from "./map-object.js";

let groundLootProxyPromise = null;

function groundDocument(value) {
  return value?.document || value || null;
}

function gridMetrics(scene) {
  return {
    size: Number(scene?.grid?.size) || Number(scene?.dimensions?.size) || 100,
    distance: Number(scene?.grid?.distance) || 1
  };
}

function availableActorTypes() {
  const configured = game.system?.documentTypes?.Actor;
  if (Array.isArray(configured)) return configured.map(String).filter(Boolean);
  if (configured && typeof configured === "object") return Object.keys(configured);
  const labels = globalThis.CONFIG?.Actor?.typeLabels;
  return labels && typeof labels === "object" ? Object.keys(labels) : [];
}

function groundLootProxyActorType() {
  const types = availableActorTypes();
  return types.includes("npc") ? "npc" : types.find((type) => type !== "group") || types[0] || "npc";
}

export function getGroundLootProxyActor() {
  return Array.from(game.actors || []).find((actor) => actor?.getFlag?.(MODULE_ID, GROUND_LOOT_PROXY_FLAG) === true) || null;
}

export async function ensureGroundLootProxyActor() {
  const existing = getGroundLootProxyActor();
  if (existing) return existing;
  const activeGM = game.users?.activeGM;
  if (!game.user?.isGM || (activeGM && activeGM.id !== game.user.id)) return null;
  const ownershipLevel = Number(globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.LIMITED);
  const actorData = {
    name: "[Khuzoe] Oggetti a terra",
    type: groundLootProxyActorType(),
    img: "icons/svg/item-bag.svg",
    ownership: {
      default: Number.isFinite(ownershipLevel) ? ownershipLevel : 1
    },
    prototypeToken: {
      name: "Oggetto a terra",
      actorLink: false,
      displayName: globalThis.CONST?.TOKEN_DISPLAY_MODES?.HOVER ?? 20,
      ...objectTokenDefaults()
    },
    flags: {
      [MODULE_ID]: {
        [GROUND_LOOT_PROXY_FLAG]: true
      }
    }
  };
  const documentClass = globalThis.CONFIG?.Actor?.documentClass || globalThis.Actor;
  if (typeof documentClass?.create !== "function") return null;
  if (!groundLootProxyPromise) {
    groundLootProxyPromise = Promise.resolve(documentClass.create(actorData, {
      renderSheet: false,
      khuzoeMerchantGroundProxy: true
    })).finally(() => { groundLootProxyPromise = null; });
  }
  return groundLootProxyPromise;
}

export function cleanGroundLootName(value) {
  const source = typeof value === "string" ? value : value?.value ?? value?.name ?? "";
  const text = String(source)
    .replace(/@(?:UUID|Item)\[[^\]]*\]\{([^}]*)\}/gi, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  return (text || "Oggetto").slice(0, 160);
}

export function getGroundLoot(value) {
  return groundDocument(value)?.getFlag?.(MODULE_ID, "groundLoot") || null;
}

export function groundLootDistance(buyerToken, groundObject) {
  const document = groundDocument(groundObject);
  const scene = groundDocument(buyerToken)?.parent;
  if (!document || !scene || document.parent !== scene) return Number.POSITIVE_INFINITY;
  if (document.documentName !== "Tile") return tokenDistance(buyerToken, document, scene);

  const { size } = gridMetrics(scene);
  return tokenDistance(buyerToken, {
    parent: scene,
    x: Number(document.x) || 0,
    y: Number(document.y) || 0,
    width: Math.max(0.1, Number(document.width) || size) / size,
    height: Math.max(0.1, Number(document.height) || size) / size
  }, scene);
}

export function buildGroundLootTokenData(scene, loot, options = {}) {
  const { size } = gridMetrics(scene);
  const scale = Math.min(1.25, Math.max(0.35, Number(game.settings.get(MODULE_ID, "groundLootScale")) || 0.72));
  const visualWidth = Math.max(0.1, Number(options.width) || scale);
  const visualHeight = Math.max(0.1, Number(options.height) || scale);
  const width = Math.max(0.5, Math.ceil(visualWidth * 2) / 2);
  const height = Math.max(0.5, Math.ceil(visualHeight * 2) / 2);
  const pixelWidth = width * size;
  const pixelHeight = height * size;
  let x = Number(options.x);
  let y = Number(options.y);
  if (options.coordinates === "top-left") {
    x -= ((width - visualWidth) * size) / 2;
    y -= ((height - visualHeight) * size) / 2;
  } else {
    x -= pixelWidth / 2;
    y -= pixelHeight / 2;
  }

  const dimensions = scene?.dimensions || {};
  const minX = Number(dimensions.sceneX) || 0;
  const minY = Number(dimensions.sceneY) || 0;
  const maxX = minX + (Number(dimensions.sceneWidth) || Number(dimensions.width) || (x + pixelWidth));
  const maxY = minY + (Number(dimensions.sceneHeight) || Number(dimensions.height) || (y + pixelHeight));
  x = Math.round(Math.min(Math.max(minX, x), Math.max(minX, maxX - pixelWidth)));
  y = Math.round(Math.min(Math.max(minY, y), Math.max(minY, maxY - pixelHeight)));

  const name = cleanGroundLootName(loot?.name || loot?.item?.name);
  const normalizedLoot = { ...loot, name };
  return {
    name,
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
    actorId: String(options.actorId || "").trim() || null,
    actorLink: false,
    x,
    y,
    width,
    height,
    elevation: Number(options.elevation) || 0,
    sort: 999999,
    rotation: 0,
    lockRotation: true,
    alpha: 1,
    hidden: Boolean(options.hidden),
    locked: false,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    ...objectTokenDefaults(),
    texture: {
      src: String(normalizedLoot.img || "icons/svg/item-bag.svg"),
      fit: "contain",
      scaleX: visualWidth / width,
      scaleY: visualHeight / height
    },
    sight: { enabled: false },
    flags: { [MODULE_ID]: { groundLoot: normalizedLoot } }
  };
}

export function legacyTileTokenData(scene, tile, options = {}) {
  const document = groundDocument(tile);
  const loot = getGroundLoot(document);
  if (!document || !loot) return null;
  const { size } = gridMetrics(scene);
  return buildGroundLootTokenData(scene, loot, {
    x: document.x,
    y: document.y,
    width: Math.max(0.1, Number(document.width) || size) / size,
    height: Math.max(0.1, Number(document.height) || size) / size,
    elevation: document.elevation,
    hidden: document.hidden,
    actorId: options.actorId,
    coordinates: "top-left"
  });
}

