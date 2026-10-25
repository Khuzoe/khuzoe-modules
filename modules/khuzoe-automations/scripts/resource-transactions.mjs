import {withDocumentLock} from "./operation-locks.mjs";

let socket;
const receipts = new Map();
const reactionOwners = new Map();
const incapacitating = new Set(["dead", "incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]);

function prune() {
  const now = Date.now();
  for (const [id, receipt] of receipts) {
    if (now - receipt.created < 3_600_000) continue;
    receipts.delete(id);
    if (reactionOwners.get(receipt.actorUuid) === id) reactionOwners.delete(receipt.actorUuid);
  }
}

async function charge({actorUuid, itemUuid, slot, amount = 1, reaction = false, id}) {
  const actor = await fromUuid(actorUuid);
  if (!actor || !Number.isInteger(amount) || amount < 1) return null;
  return withDocumentLock(actor, "resources", async () => {
    prune();
    if (receipts.has(id)) return receipts.get(id).refunded ? null : id;
    const item = itemUuid ? await fromUuid(itemUuid) : null;
    if (itemUuid && item?.actor?.uuid !== actor.uuid) return null;
    const key = slot === "pact" ? "pact" : slot ? `spell${Number(slot)}` : null;
    const pool = key ? actor.system?.spells?.[key] : null;
    if (key && (!pool || Number(pool.value ?? 0) < amount)) return null;
    const uses = item?.system?.uses;
    const maximum = uses?.max === "@prof" ? actor.system?.attributes?.prof : Number(uses?.max);
    const remaining = uses ? Number(uses.value ?? (maximum - Number(uses.spent ?? 0))) : Infinity;
    if (item && !(remaining >= amount)) return null;
    if (reaction && cat.utils.actorUtils.hasUsedReaction(actor)) return null;
    if (reaction && (Number(actor.system?.attributes?.hp?.value ?? 1) <= 0
      || Array.from(actor.statuses ?? []).some(status => incapacitating.has(status)))) return null;
    const receipt = {actorUuid, itemUuid, key, amount, reaction, created: Date.now(), slotPaid: false, usePaid: false, reactionPaid: false};
    receipts.set(id, receipt);
    try {
      if (reaction) {
        await MidiQOL.setReactionUsed(actor);
        reactionOwners.set(actor.uuid, id); receipt.reactionPaid = true;
      }
      if (key) {
        await actor.update({[`system.spells.${key}.value`]: Number(pool.value) - amount});
        receipt.slotPaid = true;
      }
      if (item) {
        await item.update({"system.uses.spent": Number(uses.spent ?? 0) + amount});
        receipt.usePaid = true;
      }
      return id;
    } catch (error) {
      await refundReceipt(id, actor, item);
      throw error;
    }
  });
}

async function refundReceipt(id, actor, item) {
  const receipt = receipts.get(id);
  if (!receipt || receipt.refunded) return;
  if (receipt.slotPaid) {
    const pool = actor.system.spells[receipt.key];
    await actor.update({[`system.spells.${receipt.key}.value`]: Math.min(Number(pool.max ?? Infinity), Number(pool.value) + receipt.amount)});
    receipt.slotPaid = false;
  }
  if (receipt.usePaid && item) {
    await item.update({"system.uses.spent": Math.max(0, Number(item.system.uses.spent) - receipt.amount)});
    receipt.usePaid = false;
  }
  if (receipt.reactionPaid && reactionOwners.get(actor.uuid) === id) {
    await MidiQOL.removeReactionUsed(actor, true);
    reactionOwners.delete(actor.uuid); receipt.reactionPaid = false;
  }
  receipt.refunded = true;
}

async function refund({id}) {
  const receipt = receipts.get(id);
  if (!receipt) return;
  const actor = await fromUuid(receipt.actorUuid);
  if (!actor) return;
  const item = receipt.itemUuid ? await fromUuid(receipt.itemUuid) : null;
  return withDocumentLock(actor, "resources", () => refundReceipt(id, actor, item));
}

async function recoverUse({actorUuid, itemUuid, id}) {
  const actor = await fromUuid(actorUuid);
  if (!actor) return;
  return withDocumentLock(actor, "resources", async () => {
    prune();
    const key = `recover:${id}`;
    if (receipts.has(key)) return;
    const item = await fromUuid(itemUuid);
    if (item?.actor?.uuid !== actor.uuid) return;
    const spent = Number(item.system?.uses?.spent ?? 0);
    if (spent > 0) await item.update({"system.uses.spent": spent - 1});
    receipts.set(key, {actorUuid, created: Date.now(), refunded: true});
  });
}

function setup() {
  if (socket || !globalThis.socketlib) return;
  socket = socketlib.registerModule("khuzoe-automations");
  socket.register("khuzoeChargeResources", charge);
  socket.register("khuzoeRefundResources", refund);
  socket.register("khuzoeRecoverResourceUse", recoverUse);
}

async function dispatch(action, payload) {
  setup();
  const gm = cat.utils.queryUtils?.gmUser?.() ?? game.users?.activeGM;
  if (gm?.id && gm.id !== game.user.id && socket) return socket.executeAsUser(action, gm.id, payload);
  if (!game.user.isGM && gm && !socket) throw new Error("Connessione al GM non disponibile per riservare le risorse.");
  if (action === "khuzoeChargeResources") return charge(payload);
  if (action === "khuzoeRecoverResourceUse") return recoverUse(payload);
  return refund(payload);
}

export function reserveResources(actor, {item, slot, amount = 1, reaction = false} = {}) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${game.user.id}-${Date.now()}-${Math.random()}`;
  return dispatch("khuzoeChargeResources", {id, actorUuid: actor.uuid, itemUuid: item?.uuid, slot, amount, reaction});
}

export function refundResources(receipt) {
  if (receipt) return dispatch("khuzoeRefundResources", {id: receipt});
}

export function recoverResourceUse(actor, item, id) {
  return dispatch("khuzoeRecoverResourceUse", {actorUuid: actor.uuid, itemUuid: item.uuid, id});
}

globalThis.Hooks?.once?.("socketlib.ready", setup);
