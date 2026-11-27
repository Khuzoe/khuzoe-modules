import { opaqueKey } from "./roll-groups.mjs";

// Midi's individual reverse command writes the historical snapshot. In a ledger
// several snapshots can belong to one actor, so apply only this entry's change.
const queues = new Map();
const scope = "khuzoe-hud";

function difference(before, after) {
  return Number.isFinite(before) && Number.isFinite(after) ? after - before : 0;
}

export function receiptDelta(entry) {
  return {
    value: difference(entry.oldHP, entry.newHP),
    temp: entry.newTempHP === undefined ? 0 : difference(entry.oldTempHP ?? 0, entry.newTempHP ?? 0),
    tempmax: entry.newTempMax === undefined ? 0 : difference(entry.oldTempMax ?? 0, entry.newTempMax ?? 0),
    spent: difference(entry.oldVitalitySpent, entry.newVitalitySpent)
  };
}

export function hpUpdates(hp, delta, sign, baseTempMax = hp.tempmax ?? 0) {
  const changes = {};
  const maxChange = sign * delta.tempmax;
  if (maxChange) changes["system.attributes.hp.tempmax"] = baseTempMax + maxChange;
  const max = Math.max(0, (hp.effectiveMax ?? (hp.max ?? Infinity) + (hp.tempmax ?? 0)) + maxChange);
  if (delta.value || maxChange) changes["system.attributes.hp.value"] = Math.max(0, Math.min(max, hp.value + sign * delta.value));
  if (delta.temp) changes["system.attributes.hp.temp"] = Math.max(0, (hp.temp ?? 0) + sign * delta.temp);
  return changes;
}

const stateOf = (doc, key) => doc?.flags?.[scope]?.receiptState?.[key];

function pools(actor) {
  const hp = actor.system.attributes.hp;
  return { value: hp.value, temp: hp.temp ?? 0, tempmax: hp.tempmax ?? 0,
    spent: globalThis.MidiQOL?.getVitalityItem?.(actor)?.system.uses.spent ?? 0 };
}

// Midi finishes a multiplier operation by updating this particular native row.
// Its own calculation still handles resistances, vitality overflow and caps.
function nativeApplication(row, click) {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (row.dataset.hpApplied !== "true") return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(game.i18n.localize("KHUZOE_HUD.ApplicationUnconfirmed")));
    }, 30000);
    observer.observe(row, { attributes: true, attributeFilter: ["data-hp-applied"] });
    click();
  });
}

export async function changeApplication(actor, entry, key, undo, delta = receiptDelta(entry)) {
  if (!actor?.isOwner || stateOf(actor, key) === undo) return false;
  const sign = undo ? -1 : 1;
  const hp = actor.system.attributes.hp;
  const changes = hpUpdates(hp, delta, sign, actor.system._source?.attributes?.hp?.tempmax);
  const flag = `flags.${scope}.receiptState.${key}`;
  const options = foundry.utils.deepClone(entry.calcDamageOptions ?? {});
  const amount = hp.value - (changes["system.attributes.hp.value"] ?? hp.value)
    + (hp.temp ?? 0) - (changes["system.attributes.hp.temp"] ?? hp.temp ?? 0);
  if (Hooks.call("dnd5e.preApplyDamage", actor, amount, changes, options) === false) return false;
  const vitality = delta.spent && globalThis.MidiQOL?.getVitalityItem?.(actor);
  let restoreVitality;
  if (vitality && stateOf(vitality, key) !== undo) {
    const uses = vitality.system.uses;
    const previousSpent = uses.spent;
    const previousState = stateOf(vitality, key);
    const spent = Math.max(0, Math.min(uses.max ?? Infinity, uses.spent + sign * delta.spent));
    if (!await vitality.update({ "system.uses.spent": spent, [flag]: undo })) return false;
    restoreVitality = () => {
      if (vitality.system.uses.spent !== spent || stateOf(vitality, key) !== undo) return;
      const stateUpdate = previousState === undefined ? { [`flags.${scope}.receiptState.-=${key}`]: null } : { [flag]: previousState };
      return vitality.update({ "system.uses.spent": previousSpent, ...stateUpdate });
    };
  }
  changes[flag] = undo;
  const updateOptions = foundry.utils.mergeObject(options, entry.updateOptions ?? {}, { inplace: false });
  if (vitality) updateOptions.midiVitalityUpdatePending = true;
  let updated;
  try { updated = await actor.update(changes, updateOptions); }
  finally { if (!updated) await restoreVitality?.(); }
  if (!updated) return false;
  Hooks.call("dnd5e.applyDamage", updated, amount, options);
  return true;
}

export function bindReceiptReversal(message, row, entry, index, initialState) {
  const reverse = row.querySelector('button[id^="reverse-"]');
  const apply = row.querySelector('button[id^="apply-"]');
  if (!reverse || row.dataset.khhudReversal) return;
  const key = opaqueKey(`${message.id}/${index}`);
  row.dataset.khhudReversal = key;
  const actorOf = () => globalThis.fromUuidSync(entry.actorUuid, { strict: false });
  const base = receiptDelta(entry);
  let forwarding = false;
  function currentDelta(actor) {
    return message.flags?.[scope]?.applicationDeltas?.[key] ?? actor.flags?.[scope]?.applicationDeltas?.[key] ?? base;
  }
  async function rememberDelta(actor, delta) {
    const previous = currentDelta(actor);
    if (Object.keys(base).every(k => previous[k] === delta[k])) return;
    // Keep adjustments on the permission-scoped receipt. An owner operating a
    // player receipt can also record its already-published adjustment on their actor.
    const doc = message.canUserModify(game.user, "update") ? message : message.flags["midi-qol"].playerDamageCard && actor;
    if (doc) await doc.update({ [`flags.${scope}.applicationDeltas.${key}`]: delta });
  }
  function paint(undone) {
    row.closest(".chat-message")?.classList.add("khhud-managed-reversal");
    row.dataset.hpApplied = String(!undone);
    row.classList.remove("khhud-controls-used");
    const state = row.querySelector(".khhud-state") ?? row.previousElementSibling?.querySelector(".khhud-state");
    if (state) state.textContent = game.i18n.localize(`KHUZOE_HUD.${undone ? "Reverted" : "Reapplied"}`);
    const shell = row.closest(".khhud-results");
    const header = game.user.isGM && shell?.querySelector(".midi-qol-dmg-header-text");
    if (header) {
      const rows = shell.querySelectorAll("[data-actor-uuid][data-hp-applied]");
      const count = [...rows].filter(r => r.dataset.hpApplied === "true").length;
      header.textContent = game.i18n.localize(count ? "midi-qol.HPUpdated" : "midi-qol.HPNotUpdated")
        + (count && count < rows.length ? ` (${count}/${rows.length})` : "");
    }
    for (const [button, enabled] of [[reverse, !undone], [apply, undone]]) {
      button?.firstElementChild?.classList.toggle("midi-qol-enable-damage-button", enabled);
      button?.firstElementChild?.classList.toggle("midi-qol-disable-damage-button", !enabled);
    }
  }
  const saved = stateOf(actorOf(), key);
  if (typeof saved === "boolean") paint(saved);
  row.addEventListener("khhud-application-state", event => paint(event.detail));
  row.addEventListener("click", ev => {
    if (forwarding) return;
    const button = ev.target.closest("button");
    if (!button || (button !== reverse && button !== apply)) return;
    const actor = actorOf();
    const saved = stateOf(actor, key);
    if (!row.closest(".khhud-grouped-receipt") && saved === undefined) return;
    const multiplier = row.querySelector('select[id^="dmg-multiplier-"]');
    const undo = button === reverse;
    const mode = multiplier?.value || "calc";
    ev.preventDefault();
    ev.stopImmediatePropagation();
    row.classList.remove("khhud-controls-used");
    if (!message.isContentVisible || !actor?.isOwner) return;
    const prior = queues.get(actor.uuid) ?? Promise.resolve();
    const task = prior.then(async () => {
      const current = actorOf();
      if (!current?.isOwner || !message.isContentVisible) return;
      const status = stateOf(current, key);
      const delta = currentDelta(current);
      const before = pools(current);
      const multiplied = !undo && mode !== "calc";
      if (multiplied) {
        const alreadyApplied = status === false || (status === undefined && row.dataset.hpApplied === "true");
        await nativeApplication(row, () => {
          forwarding = true;
          try { multiplier.value = mode; button.click(); } finally { forwarding = false; }
        });
        const after = pools(current);
        const applied = {};
        for (const field of Object.keys(base)) applied[field] = after[field] - before[field] + (alreadyApplied ? delta[field] : 0);
        await current.update({ [`flags.${scope}.receiptState.${key}`]: false });
        await rememberDelta(current, applied);
      } else {
        if (status === undefined && (undo ? initialState === "Pending" && row.dataset.hpApplied !== "true"
          : row.dataset.hpApplied === "true")) return;
        if (!await changeApplication(current, entry, key, undo, delta)) return;
        const after = pools(current);
        const applied = {};
        for (const field of Object.keys(base)) applied[field] = (after[field] - before[field]) * (undo ? -1 : 1);
        await rememberDelta(current, applied);
      }
      if (multiplier) multiplier.value = "calc";
      paint(undo);
    }).catch(error => ui.notifications.error(error.message));
    queues.set(actor.uuid, task);
    void task.finally(() => { if (queues.get(actor.uuid) === task) queues.delete(actor.uuid); });
  }, { capture: true });
}

export function syncReceiptState(_actor, changes) {
  const states = changes.flags?.[scope]?.receiptState;
  if (!states) return;
  for (const [key, undone] of Object.entries(states)) {
    if (typeof undone !== "boolean") continue;
    for (const row of document.querySelectorAll(`[data-khhud-reversal="${CSS.escape(key)}"]`))
      row.dispatchEvent(new CustomEvent("khhud-application-state", { detail: undone }));
  }
}
