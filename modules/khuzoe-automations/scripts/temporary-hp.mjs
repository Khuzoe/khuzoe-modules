import {updateDocumentSafely} from "./cat-compat.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
const SCOPE = "khuzoe-automations";
const FLAG = `flags.${SCOPE}.temporaryHPSource`;
const pendingDamage = new Map();
const get = (data, path) => globalThis.foundry?.utils?.getProperty?.(data, path) ?? path.split(".").reduce((value, key) => value?.[key], data);

export async function grantTemporaryHP(actor, amount, source) {
  amount = Math.max(0, Number(amount) || 0);
  return withDocumentLock(actor, "temporary-hp", async () => {
    if (amount <= Number(actor.system?.attributes?.hp?.temp ?? 0)) return false;
    await updateDocumentSafely(actor, {"system.attributes.hp.temp": amount, [FLAG]: source?.uuid ?? source ?? null});
    return true;
  });
}

export function rememberTemporaryDamage(token, data = {}) {
  const actor = (token?.document ?? token)?.actor;
  const damage = data.damageItem;
  if (!actor?.uuid || !damage || !(damage.tempDamage > 0)) return;
  for (const [uuid, pending] of pendingDamage) if (pending.expires < Date.now()) pendingDamage.delete(uuid);
  pendingDamage.set(actor.uuid, {value: damage.newTempHP, expires: Date.now() + 5000});
}

export function preserveTemporaryDamageSource(actor, amount, updates) {
  if (!(amount > 0) || !actor.flags?.[SCOPE]?.temporaryHPSource) return;
  const value = updates?.["system.attributes.hp.temp"] ?? get(updates, "system.attributes.hp.temp");
  if (value !== undefined && Number(value) <= Number(actor.system?.attributes?.hp?.temp ?? 0)) {
    updates[FLAG] = actor.flags[SCOPE].temporaryHPSource;
  }
}

export function prepareTemporaryHPUpdate(actor, updates) {
  const value = updates["system.attributes.hp.temp"] ?? get(updates, "system.attributes.hp.temp");
  if (value === undefined || updates[FLAG] !== undefined) return;
  const pending = pendingDamage.get(actor.uuid);
  pendingDamage.delete(actor.uuid);
  if (pending && pending.expires > Date.now() && Number(value) === pending.value) return;
  // An unclassified replacement must never be deleted with an older spell.
  if (actor.flags?.[SCOPE]?.temporaryHPSource) updates[FLAG] = null;
}

export async function removeOwnedTemporaryHP(actor, source) {
  return withDocumentLock(actor, "temporary-hp", async () => {
    if (!source?.uuid || actor.flags?.[SCOPE]?.temporaryHPSource !== source.uuid) return;
    await updateDocumentSafely(actor, {"system.attributes.hp.temp": 0, [FLAG]: null});
  });
}
