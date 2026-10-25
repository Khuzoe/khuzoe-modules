import { MODULE_ID } from "./constants.js";
import { isActorOwner } from "./utils.js";
import { isInventoryToken } from "./map-object.js";

function tokenRectangle(tokenDocument, scene) {
  const size = Number(scene.grid.size) || Number(scene.dimensions?.size) || 100;
  const width = Math.max(0.1, Number(tokenDocument.width) || 1) * size;
  const height = Math.max(0.1, Number(tokenDocument.height) || 1) * size;
  const x = Number(tokenDocument.x) || 0;
  const y = Number(tokenDocument.y) || 0;
  return { left: x, right: x + width, top: y, bottom: y + height };
}

/** Measure the shortest edge-to-edge distance between two token footprints. */
export function tokenDistance(tokenA, tokenB, scene = tokenA?.parent ?? tokenB?.parent) {
  const documentA = tokenA?.document ?? tokenA;
  const documentB = tokenB?.document ?? tokenB;
  if (!documentA || !documentB || !scene) return Number.POSITIVE_INFINITY;

  const a = tokenRectangle(documentA, scene);
  const b = tokenRectangle(documentB, scene);
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  const pixels = Math.hypot(dx, dy);
  const gridSize = Number(scene.grid.size) || Number(scene.dimensions?.size) || 100;
  const gridDistance = Number(scene.grid.distance) || 1;
  return (pixels / gridSize) * gridDistance;
}

export function isWithinDistance(buyerToken, merchantToken, maximum) {
  const scene = (buyerToken?.document ?? buyerToken)?.parent;
  const merchantScene = (merchantToken?.document ?? merchantToken)?.parent;
  if (!scene || scene !== merchantScene) return false;
  return tokenDistance(buyerToken, merchantToken, scene) <= Math.max(0, Number(maximum) || 0) + 1e-6;
}

export function selectBuyerToken(merchantToken) {
  if (!canvas?.ready || !merchantToken) return null;
  const requireControlled = game.settings.get(MODULE_ID, "requireControlledToken");
  const controlled = canvas.tokens.controlled.filter((token) => {
    return token.id !== merchantToken.id && isInventoryToken(token) && isActorOwner(token.actor);
  });

  let candidates = controlled;
  if (!candidates.length && !requireControlled) {
    candidates = canvas.tokens.placeables.filter((token) => {
      return token.id !== merchantToken.id && isInventoryToken(token) && isActorOwner(token.actor);
    });
    const characterTokens = candidates.filter((token) => token.actor?.id === game.user.character?.id);
    if (characterTokens.length) candidates = characterTokens;
  }

  return candidates.sort((a, b) => tokenDistance(a, merchantToken) - tokenDistance(b, merchantToken))[0] ?? null;
}
