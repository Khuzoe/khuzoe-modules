import {sceneUnitsPerFoot} from "./geometry.mjs";
const doc = token => token?.document ?? token;

// CAT distances returned by getDistance are feet. Its movement/selection inputs
// are scene units, so a metric scene requires conversion in the other direction.
export function distanceInScene(feet, token) {
  return Number(feet) * sceneUnitsPerFoot(doc(token)?.parent ?? globalThis.canvas?.scene);
}

export function nearbyTokens(token, feet, options = {}) {
  return globalThis.cat.utils.tokenUtils.findNearby(doc(token), distanceInScene(feet, token), options);
}

export function slideTokenFeet(token, options = {}) {
  return globalThis.cat.utils.tokenUtils.slideToken(doc(token), {
    ...options, distance: distanceInScene(options.distance ?? 5, token)
  });
}

export function teleportTokenFeet(token, options = {}) {
  return globalThis.cat.utils.tokenUtils.teleportToken(doc(token), {
    ...options, range: distanceInScene(options.range ?? 30, token)
  });
}
