import {withDocumentLock} from "./operation-locks.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE = "khuzoe-automations";
export const GINEVRA_EFFECT = "khuzoe-ginevra-embrace";
export const GINEVRA_MAX_CHARGES = 100;
const HANDLER = "changeGinevraCharges";
let socket;
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? (Array.isArray(collection) ? collection : []));
const active = effect => !effect.disabled && !effect.isSuppressed && !effect.duration?.expired;
const clamp = value => Math.min(GINEVRA_MAX_CHARGES, Math.max(0, Math.floor(Number(value) || 0)));

export function ginevraEffect(actor, item) {
  return values(actor?.effects).find(effect => active(effect) && effect.flags?.cat?.identifier === GINEVRA_EFFECT
    && (!item || effect.origin === item.uuid));
}

export function getGinevraCharges(actor) {
  const effect = ginevraEffect(actor);
  return {
    available: Boolean(effect || values(actor?.items).some(item => item.system?.identifier === "abbraccio-di-ginevra"
      || String(item.name).trim().toLocaleLowerCase("it") === "abbraccio di ginevra")),
    active: Boolean(effect), value: effect ? clamp(effect.flags?.[MODULE]?.charges) : 0,
    min: 0, max: GINEVRA_MAX_CHARGES, effectId: effect?.id ?? null, origin: effect?.origin ?? null
  };
}

async function writeCharges(effect, value, extra = {}) {
  const item = values(effect.parent?.items).find(item => item.uuid === effect.origin);
  const name = item?.name ?? String(effect.name).replace(/ \(\d+\/\d+\)$/, "");
  await updateDocumentSafely(effect, {...resistanceUpdate(effect), ...extra, [`flags.${MODULE}.charges`]: clamp(value),
    name: `${name} (${clamp(value)}/${GINEVRA_MAX_CHARGES})`});
}

// Repair only the active Ginevra buff during its normal charge operations.
// This is DAE's documented field mapping; retain every other effect change.
function resistanceUpdate(effect) {
  const changes = effect.system?.changes ?? effect.changes ?? [];
  if (!changes.some(change => change.key === "system.traits.dr.all")) return {};
  return {[effect.system?.changes ? "system.changes" : "changes"]: changes.map(change => {
    const data = change.toObject?.() ?? {...change};
    return data.key === "system.traits.dr.all"
      ? {...data, key: "system.traits.dr.value", value: "ALL", type: "add"} : data;
  })};
}

function canManage(actor, user) {
  return Boolean(user && (user.isGM || actor?.testUserPermission?.(user, "OWNER")));
}

// All clients, including additional GMs, use the same GM and the same lock.
// The expected effect/value prevents a stale manual edit from replacing damage
// gained or charges spent while the player was typing or dragging the slider.
async function performChange(actor, action, data, user) {
  if (!actor || !canManage(actor, user)) throw new Error("Non hai il permesso di modificare le cariche di questo personaggio.");
  return withDocumentLock(actor, GINEVRA_EFFECT, async () => {
    const item = values(actor.items).find(item => item.uuid === data.itemUuid);
    if (action === "activate") {
      if (!item || item.system?.identifier !== "abbraccio-di-ginevra") throw new Error("Capacità di Ginevra non disponibile.");
      const previous = ginevraEffect(actor, item);
      if (previous) await cat.utils.documentUtils.deleteDocument(previous);
      await cat.utils.effectUtils.createEffects(actor, [{
        name: `${item.name} (0/${GINEVRA_MAX_CHARGES})`, img: item.img, origin: item.uuid, type: "base", transfer: false,
        system: {changes: [{key: "system.traits.dr.value", type: "add", value: "ALL", priority: 20}]},
        disabled: false, duration: {value: 60, units: "seconds", expiry: "turnStart", expired: false},
        showIcon: globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
        flags: {cat: {identifier: GINEVRA_EFFECT}, dae: {specialDuration: [], expiryMode: "delete", stackable: "noneNameOnly"},
          [MODULE]: {charges: 0, processed: []}}
      }], {rules: "2024"});
      return getGinevraCharges(actor);
    }
    if (!["set", "collect", "reserve", "refund"].includes(action)) throw new Error("Operazione cariche non valida.");
    const effect = item ? ginevraEffect(actor, item) : ginevraEffect(actor);
    if (action !== "set" && !item) throw new Error("Capacità di Ginevra non disponibile.");
    if (!effect || effect.id !== data.effectId) {
      if (action === "set") throw new Error("Abbraccio di Ginevra non è più attivo o è stato riattivato. Riprova sul valore aggiornato.");
      return null;
    }
    const current = clamp(effect.flags?.[MODULE]?.charges);
    if (action === "set") {
      if (!Number.isSafeInteger(data.value) || !Number.isSafeInteger(data.expectedValue)) throw new Error("Inserisci un numero intero di cariche.");
      if (current !== data.expectedValue) throw new Error("Le cariche sono cambiate durante la modifica. Il valore è stato aggiornato: riprova.");
      if (current !== clamp(data.value) || Object.keys(resistanceUpdate(effect)).length) await writeCharges(effect, data.value);
      return getGinevraCharges(actor);
    }
    if (action === "reserve") {
      if (!current) return null;
      await writeCharges(effect, 0);
      return {effectId: effect.id, charges: current};
    }
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) return null;
    if (action === "collect") {
      if (typeof data.workflowId !== "string" || !data.workflowId) return null;
      const seen = effect.flags?.[MODULE]?.processed ?? [];
      if (seen.includes(data.workflowId)) return null;
      await writeCharges(effect, current + data.amount, {[`flags.${MODULE}.processed`]: [...seen, data.workflowId].slice(-50)});
    } else await writeCharges(effect, current + data.amount);
    return getGinevraCharges(actor);
  });
}

export async function changeGinevraCharges(actor, action, data = {}) {
  const users = values(globalThis.game?.users);
  const gm = game.users?.activeGM ?? users.filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!gm) throw new Error("Serve un Gamemaster connesso per aggiornare le cariche di Ginevra.");
  if (gm.id === game.user?.id) return performChange(actor, action, data, game.user);
  if (!socket) throw new Error("Collegamento a Ginevra non pronto. Ricarica anche il client del Gamemaster.");
  const response = await socket.executeAsUser(HANDLER, gm.id, {actorUuid: actor.uuid, action, data});
  if (!response?.ok) throw new Error(response?.error ?? "Aggiornamento delle cariche non riuscito.");
  return response.result;
}

export function setGinevraCharges(actor, value, expected = getGinevraCharges(actor)) {
  if (!canManage(actor, game.user)) return Promise.reject(new Error("Non hai il permesso di modificare le cariche di questo personaggio."));
  return changeGinevraCharges(actor, "set", {value, expectedValue: expected.value, effectId: expected.effectId});
}

export function registerGinevraChargesApi() {
  const module = game.modules.get(MODULE);
  if (module) {
    module.api ??= {};
    module.api.ginevra = Object.freeze({get: getGinevraCharges, set: setGinevraCharges});
  }
}

export function registerGinevraChargesSocket() {
  if (socket || !globalThis.socketlib) return;
  socket = socketlib.registerModule(MODULE);
  socket?.register(HANDLER, async function ({actorUuid, action, data = {}} = {}) {
    try {
      if (!game.user.isGM) throw new Error("Le cariche devono essere gestite dal Gamemaster.");
      const actor = await fromUuid(actorUuid);
      if (actor?.documentName !== "Actor") throw new Error("Personaggio non disponibile.");
      const result = await performChange(actor, action, data, game.users.get(this.socketdata.userId));
      return {ok: true, result};
    } catch (error) { return {ok: false, error: error.message}; }
  });
}
