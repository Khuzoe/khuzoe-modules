import {RELEASE_VERSION} from "./release.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {getWizardLevel} from "./wizard.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {preserveTemporaryDamageSource} from "./temporary-hp.mjs";

const MODULE = "khuzoe-automations";
const PLAN = "khuzoeArcaneWard";
const IDENTIFIER = "arcane-ward";
const EFFECT = "khuzoe-arcane-ward";
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? (Array.isArray(collection) ? collection : Object.values(collection ?? {})));
const clone = value => globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value);
const uuid = () => globalThis.crypto.randomUUID();
const excluded = new Set(["healing", "temphp", "maximum", "vitality", "midi-none"]);
export const ARCANE_WARD_AUTOMATION = Object.freeze({
  source: MODULE, type: "feat", identifier: IDENTIFIER, rules: "2014", version: RELEASE_VERSION,
  name: "Arcane Ward", uuid: "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzArcaneWard001",
  notes: "Protezione 2014: creazione con un incantesimo di abiurazione, recupero in base al livello di lancio e assorbimento prima di resistenze e PF temporanei. Si azzera al riposo lungo."
});
export function wardItem(actor) {
  return values(actor?.items).find(item => item.type === "feat" && item.system?.identifier === IDENTIFIER
    && item.flags?.cat?.automation?.source === MODULE && !item.isSuppressed && !item.disabled);
}
export function wardMaximum(actor) { return Math.max(0, 2 * getWizardLevel(actor) + Number(actor?.system?.abilities?.int?.mod ?? 0)); }
export function wardPoints(actor) {
  const item = wardItem(actor);
  return item?.flags?.[MODULE]?.wardCreated ? Math.max(0, wardMaximum(actor) - Number(item.system?.uses?.spent ?? 0)) : 0;
}
export function prepareArcaneWardUpdate(item, changes) {
  if ((changes.system?.identifier ?? item.system?.identifier) !== IDENTIFIER || changes.flags?.cat?.automation?.source !== MODULE) return;
  if (item.img) changes.img = item.img;
  changes.flags[MODULE] = {...changes.flags[MODULE], ...clone(item.flags?.[MODULE] ?? {})};
  changes.system.uses = {max: "max(0, 2 * @classes.wizard.levels + @abilities.int.mod)",
    spent: Math.max(0, Number(item.system?.uses?.spent ?? wardMaximum(item.actor))), recovery: []};
}

export function syncWardIcon(actor) {
  return withDocumentLock(actor, "arcane-ward-icon", () => updateWardIcon(actor));
}
async function updateWardIcon(actor) {
  const item = wardItem(actor);
  const effects = values(actor?.effects).filter(effect => effect.flags?.cat?.identifier === EFFECT);
  if (!item?.flags?.[MODULE]?.wardCreated) {
    for (const effect of effects) await cat.utils.documentUtils.deleteDocument(effect);
    return;
  }
  const name = `Arcane Ward — ${wardPoints(actor)}/${wardMaximum(actor)}`;
  if (effects[0]) {
    if (effects[0].name !== name) await updateDocumentSafely(effects[0], {name});
    for (const duplicate of effects.slice(1)) await cat.utils.documentUtils.deleteDocument(duplicate);
  } else await cat.utils.effectUtils.createEffects(actor, [{name, img: item.img, origin: item.uuid, type: "base",
    showIcon: 1, transfer: false, system: {changes: []}, duration: {units: "seconds", value: null},
    flags: {cat: {identifier: EFFECT}, [MODULE]: {ward: true}}}], {rules: "2014"});
}

let socket;
function setupSocket() {
  if (socket || !globalThis.socketlib) return;
  socket = socketlib.registerModule(MODULE);
  socket.register("khuzoeWardSpell", applyWardSpell);
  socket.register("khuzoeWardRest", resetWard);
  socket.register("khuzoeWardDamage", async ({actorUuid, updates, options}) => {
    const actor = await fromUuid(actorUuid);
    if (!actor || !options?.[PLAN]) return null;
    await actor.update(updates, unpack(options));
    return actor.uuid;
  });
}
async function dispatch(action, data) {
  setupSocket();
  const gm = cat.utils.queryUtils?.gmUser?.() ?? game.users?.activeGM;
  if (gm?.id && gm.id !== game.user.id) {
    if (!socket) throw new Error("Arcane Ward: collegamento al GM non disponibile.");
    return socket.executeAsUser(action, gm.id, data);
  }
  if (action === "khuzoeWardSpell") return applyWardSpell(data);
  if (action === "khuzoeWardRest") return resetWard(data);
}
export async function applyWardSpell({actorUuid, castLevel, id, create = false}) {
  const actor = await fromUuid(actorUuid);
  if (!actor || !(castLevel >= 1 && castLevel <= 9)) return;
  return withDocumentLock(actor, IDENTIFIER, async () => {
    const item = wardItem(actor);
    if (!item) return;
    const state = item.flags?.[MODULE] ?? {};
    if ((state.wardCasts ?? []).includes(id)) return;
    if (!state.wardCreated && !create) return;
    const spent = state.wardCreated ? Math.max(0, Number(item.system.uses.spent ?? 0) - 2 * castLevel) : 0;
    await item.update({"system.uses.spent": spent, [`flags.${MODULE}.wardCreated`]: true,
      [`flags.${MODULE}.wardCasts`]: [...(state.wardCasts ?? []), id].slice(-64)});
    await syncWardIcon(actor);
    return true;
  });
}
export async function wardAfterSpell({workflow, document} = {}) {
  const actor = workflow?.actor ?? document?.actor;
  const item = wardItem(actor);
  if (!item || workflow?.aborted || workflow?.counterspelled || workflow?.item?.type !== "spell"
    || workflow.workflowOptions?.khuzoeInternalActivity || workflow.workflowOptions?.isOverTime || workflow.activity?.midiProperties?.automationOnly
    || workflow.item.system?.school !== "abj" || workflow[PLAN]?.spellHandled) return;
  const castLevel = Number(workflow.castData?.castLevel ?? workflow.castData?.baseLevel ?? workflow.item.system.level);
  if (!(castLevel >= 1)) return;
  (workflow[PLAN] ??= {}).spellHandled = true;
  let create = false;
  if (!item.flags?.[MODULE]?.wardCreated) {
    create = await cat.utils.dialogUtils.buttonDialog("Arcane Ward", `<p>Creare la protezione con ${wardMaximum(actor)} PF? Puoi crearla una volta per riposo lungo.</p>`,
      [["Crea protezione", true], ["Non ora", false]], {userId: cat.utils.queryUtils?.firstOwner?.(actor, true) ?? game.user.id});
    if (!create) return;
  }
  return dispatch("khuzoeWardSpell", {actorUuid: actor.uuid, castLevel, id: workflow.id ?? workflow.uuid ?? uuid(), create});
}
export async function resetWard({actorUuid}) {
  const actor = await fromUuid(actorUuid);
  if (!actor) return;
  return withDocumentLock(actor, IDENTIFIER, async () => {
    const item = wardItem(actor);
    if (!item) return;
    await item.update({"system.uses.spent": wardMaximum(actor), [`flags.${MODULE}.wardCreated`]: false,
      [`flags.${MODULE}.wardCasts`]: [], [`flags.${MODULE}.wardApplications`]: []});
    await syncWardIcon(actor);
  });
}

// Calculation is deliberately pure. A preview or a damage card must not spend ward HP.
// Save multipliers precede the ward; all traits of the protected actor follow it.
function ignores(options, key, type) {
  const entry = options.ignore?.[key];
  return options.ignore === true || entry === true || entry?.has?.(type) || (Array.isArray(entry) && entry.includes(type));
}
export function beforeWardDamage(damage, options = {}) {
  let amount = Number(damage.value ?? 0);
  if (!(amount > 0) || excluded.has(damage.type) || options.only === "healing") return 0;
  const midi = options.midi;
  if (midi && options.ignore !== true) {
    const superSaver = midi.superSaver && !ignores(options, "superSaver", damage.type);
    if (midi.saved && !ignores(options, "saved", damage.type)) amount *= superSaver ? 0
      : midi.superSaver ? (globalThis.MidiQOL?.configSettings?.().defaultSaveMultiplier ?? 0.5) : midi.saveMultiplier ?? 1;
    else if (superSaver) amount *= globalThis.MidiQOL?.configSettings?.().defaultSaveMultiplier ?? 0.5;
  }
  return Math.max(0, Math.floor(amount * Number(options.multiplier ?? 1)));
}
function summaries(details) {
  return details.reduce((result, damage) => {
    const value = Number(damage.value ?? 0);
    if (damage.type === "temphp") result.temp += value;
    else if (damage.type === "maximum") result.tempMax += value;
    else if (!["vitality", "midi-none"].includes(damage.type)) result.amount += value;
    return result;
  }, {amount: 0, temp: 0, tempMax: 0});
}
export function calculateWardDamage(actor, chunks, points = wardPoints(actor)) {
  let available = Math.max(0, points), absorbed = 0;
  const details = [];
  for (const chunk of chunks) {
    const options = unpack(chunk.options ?? {});
    const remaining = chunk.damages.map(entry => {
      const damage = unpack(entry);
      if (excluded.has(damage.type) || Number(damage.value) <= 0 || options.only === "healing") return damage;
      const incoming = beforeWardDamage(damage, options);
      const spent = Math.min(available, incoming);
      available -= spent; absorbed += spent;
      damage.value = incoming - spent;
      damage.active = {};
      return damage;
    });
    // Saves/multiplier have already been accounted for. Do not disable resistance,
    // immunity, vulnerability, absorption or the actor's other reductions.
    options.multiplier = 1;
    if (options.midi) Object.assign(options.midi, {saved: false, save: false, superSaver: false, semiSuperSaver: false, saveMultiplier: 1});
    delete options[PLAN];
    const calculated = actor.calculateDamage(remaining, options);
    if (calculated === false) return null;
    details.push(...calculated);
  }
  return {details, absorbed, ...summaries(details)};
}
// Keep Sets intact across Midi's damage-card JSON and Socketlib transport.
function pack(value) {
  if (value?.documentName && value?.uuid) return {khuzoeDocument: value.uuid};
  if (value instanceof Set) return {khuzoeSet: [...value]};
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pack(entry)]));
  return value;
}
function unpack(value) {
  if (value?.khuzoeDocument) return globalThis.fromUuidSync?.(value.khuzoeDocument) ?? null;
  if (value?.khuzoeSet) return new Set(value.khuzoeSet);
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unpack(entry)]));
  return value;
}
function damageChunks(ditem) {
  const all = ditem.damageDetails;
  if (ditem.damageSelector === "combinedDamage" && all?.calcDamageOptions) {
    const keys = ["defaultDamage", "bonusDamage"];
    if (globalThis.MidiQOL?.configSettings?.().singleConcentrationRoll) keys.push("otherDamage");
    return keys.filter(key => all[`raw${key}`]?.length).map(key => ({damages: pack(all[`raw${key}`]), options: pack(all.calcDamageOptions[key] ?? ditem.calcDamageOptions)}));
  }
  return [{damages: pack(ditem.rawDamageDetail ?? []), options: pack(ditem.calcDamageOptions ?? {})}];
}
function hpUpdates(actor, amount, temp = 0, tempMax = 0) {
  const hp = actor.system.attributes.hp;
  amount = Math.trunc(amount);
  const deltaTemp = amount > 0 ? Math.min(Number(hp.temp ?? 0), amount) : 0;
  const maximum = Number(hp.max) + Number(hp.tempmax ?? 0) - tempMax;
  return {"system.attributes.hp.value": Math.max(0, Math.min(maximum, Number(hp.value) - (amount - deltaTemp))),
    "system.attributes.hp.temp": Math.max(0, Number(hp.temp ?? 0) - deltaTemp, temp)};
}
export function wardDamagePreview({workflow, targetToken, sourceToken, ditem, document} = {}) {
  const actor = document?.actor ?? targetToken?.actor ?? sourceToken?.actor;
  if (!wardPoints(actor) || !ditem || ditem.calcDamageOptions?.[PLAN] || workflow?.workflowOptions?.khuzoeUnreducible) return;
  const chunks = damageChunks(ditem);
  const result = calculateWardDamage(actor, chunks);
  if (!result?.absorbed) return;
  const plan = {id: `${workflow?.id ?? workflow?.uuid ?? uuid()}:${actor.uuid}:${ditem.damageSelector ?? "damage"}`,
    chunks, previewAmount: result.amount, absorbed: result.absorbed,
    before: {hp: Number(actor.system.attributes.hp.value), temp: Number(actor.system.attributes.hp.temp ?? 0),
      tempSource: actor.flags?.[MODULE]?.temporaryHPSource ?? null}};
  (ditem.calcDamageOptions ??= {})[PLAN] = plan;
  ditem.damageDetail = result.details;
  if (ditem.damageDetails && ditem.damageSelector) ditem.damageDetails[ditem.damageSelector] = result.details;
  const updates = hpUpdates(actor, result.amount, result.temp, result.tempMax);
  ditem.newHP = updates["system.attributes.hp.value"];
  ditem.newTempHP = updates["system.attributes.hp.temp"];
  ditem.hpDamage = Number(actor.system.attributes.hp.value) - ditem.newHP;
  ditem.tempDamage = Number(actor.system.attributes.hp.temp ?? 0) - ditem.newTempHP;
  ditem.totalDamage = result.amount;
  ditem.healingAdjustedTotalDamage = result.amount;
  plan.after = {hp: ditem.newHP, temp: ditem.newTempHP};
  (ditem.details ??= []).push(`Arcane Ward: ${result.absorbed} danni assorbiti`);
}
const cardIntents = new Map();
export function markWardCardAction(message, buttonId) {
  const intent = buttonId?.includes("reverse") ? "undo" : buttonId?.includes("apply") ? "apply" : null;
  if (!intent) return;
  for (const [key, pending] of cardIntents) if (pending.until < Date.now()) cardIntents.delete(key);
  for (const entry of message.flags?.["midi-qol"]?.undoDamage ?? []) {
    const plan = entry.calcDamageOptions?.[PLAN];
    if (!plan || !(buttonId.startsWith("all-") || buttonId.endsWith(entry.actorUuid?.replaceAll(".", "")))) continue;
    cardIntents.set(`${entry.actorUuid}:${plan.id}`, {intent, id: plan.id, actorUuid: entry.actorUuid, until: Date.now() + 60_000});
  }
}
export function captureWardApplication(actor, amount, updates, options = {}) {
  const plan = options[PLAN];
  if (!plan) return;
  const key = `${actor.uuid}:${plan.id}`, pending = cardIntents.get(key);
  delete plan.intent;
  if (pending?.until >= Date.now()) plan.intent = pending.intent;
  // Midi's manual Apply and Reverse buttons both send newHP-oldHP, including
  // zero for fully warded hits. The DOM action disambiguates their intention.
  if (plan.intent) {
    if (plan.appliedAmount === undefined) {
      const hp = updates["system.attributes.hp.value"] ?? updates.system?.attributes?.hp?.value;
      const temp = updates["system.attributes.hp.temp"] ?? updates.system?.attributes?.hp?.temp;
      plan.appliedAmount = plan.previewAmount + (plan.after?.hp ?? hp) - hp + (plan.after?.temp ?? temp) - temp;
    }
  } else plan.appliedAmount = amount;
}

/** The real HP update (including fully absorbed hits) commits the resource once.
 * All writers are routed to the active GM and serialized with spells/rests.
 * The item is refunded if the Actor update is canceled or throws. */
export async function wardActorUpdate(wrapped, updates = {}, options = {}) {
  const plan = options[PLAN];
  if (plan?.chunks) {
    // The installed Midi single-actor Apply button clones options before firing
    // preApplyDamage; recover its intent here too, on the real update options.
    const key = `${this.uuid}:${plan.id}`, pending = cardIntents.get(key);
    if (pending?.until >= Date.now()) captureWardApplication(this, 0, updates, options);
    cardIntents.delete(key);
  }
  if (!plan?.chunks || plan.appliedAmount === undefined) return wrapped(updates, options);
  const gm = cat.utils.queryUtils?.gmUser?.() ?? game.users?.activeGM;
  if (gm?.id && gm.id !== game.user.id) {
    setupSocket();
    if (!socket) throw new Error("Arcane Ward: collegamento al GM non disponibile.");
    const result = await socket.executeAsUser("khuzoeWardDamage", gm.id, {actorUuid: this.uuid, updates, options: pack(options)});
    return result ? this : undefined;
  }
  return withDocumentLock(this, IDENTIFIER, async () => {
    const item = wardItem(this);
    if (!item) {
      if (plan.intent === "undo") return wrapped(updates, options);
      const remaining = calculateWardDamage(this, plan.chunks, 0);
      if (!remaining) return;
      Object.assign(updates, hpUpdates(this, Number(plan.appliedAmount) + remaining.amount - plan.previewAmount, remaining.temp, remaining.tempMax));
      preserveTemporaryDamageSource(this, remaining.amount, updates);
      return wrapped(updates, options);
    }
    const history = item.flags?.[MODULE]?.wardApplications ?? [];
    const receipt = history.find(entry => entry.id === plan.id);
    const previousSpent = Number(item.system.uses.spent ?? 0);
    if (plan.intent === "undo") {
      if (!receipt || receipt.undone) return wrapped(updates, options);
      const restored = history.map(entry => entry.id === plan.id ? {...entry, undone: true} : entry);
      await item.update({"system.uses.spent": Math.max(0, previousSpent - receipt.absorbed), [`flags.${MODULE}.wardApplications`]: restored});
      updates[`flags.${MODULE}.wardLastDamage`] = `undo:${plan.id}`;
      if (plan.before) updates[`flags.${MODULE}.temporaryHPSource`] = plan.before.tempSource;
      let changed;
      try { changed = await wrapped(updates, options); return changed; }
      finally {
        if (!changed) await item.update({"system.uses.spent": previousSpent, [`flags.${MODULE}.wardApplications`]: history});
        await syncWardIcon(this);
      }
    }
    if (receipt && !receipt.undone) return this;
    const result = calculateWardDamage(this, plan.chunks);
    if (!result) return;
    const amount = Number(plan.appliedAmount) + result.amount - plan.previewAmount;
    // Retain later reductions, but recalculate overflow if another hit used the ward.
    // Preserve explicit death-prevention changes unless the ward pool changed.
    if (result.absorbed !== plan.absorbed) Object.assign(updates, hpUpdates(this, amount, result.temp, result.tempMax));
    preserveTemporaryDamageSource(this, amount, updates);
    // A completely absorbed hit still needs a real Actor update so its resource
    // transaction is not mistaken for a canceled, empty update by Foundry.
    updates[`flags.${MODULE}.wardLastDamage`] = plan.id;
    await item.update({"system.uses.spent": Math.min(wardMaximum(this), previousSpent + result.absorbed),
      [`flags.${MODULE}.wardApplications`]: [...history.filter(entry => entry.id !== plan.id), {id: plan.id, absorbed: result.absorbed, undone: false}].slice(-64)});
    let changed;
    try {
      changed = await wrapped(updates, options);
      return changed;
    } finally {
      if (!changed) await item.update({"system.uses.spent": previousSpent, [`flags.${MODULE}.wardApplications`]: history});
      await syncWardIcon(this);
    }
  });
}

/** Native damage application (chat-card Apply, damage bar and system activities).
 * Midi workflows already carry a preview plan and bypass this preparation. */
export async function wardApplyDamage(wrapped, damages, options = {}) {
  if (!wardPoints(this) || options[PLAN] || options.khuzoeUnreducible) return wrapped(damages, options);
  options = {...options};
  if (typeof damages === "number") { damages = [{value: damages}]; options.ignore ??= true; }
  const chunks = [{damages: pack(damages), options: pack(options)}];
  const result = calculateWardDamage(this, chunks);
  if (!result?.absorbed) return wrapped(damages, options);
  const card = [...cardIntents.values()].find(entry => entry.actorUuid === this.uuid && entry.intent === "apply" && entry.until >= Date.now());
  const after = hpUpdates(this, result.amount, result.temp, result.tempMax);
  options[PLAN] = {id: card?.id ?? uuid(), chunks, previewAmount: result.amount, absorbed: result.absorbed,
    before: {hp: this.system.attributes.hp.value, temp: this.system.attributes.hp.temp ?? 0, tempSource: this.flags?.[MODULE]?.temporaryHPSource ?? null},
    after: {hp: after["system.attributes.hp.value"], temp: after["system.attributes.hp.temp"]}};
  // The native method must not calculate traits a second time.
  options.ignore = true;
  options.multiplier = 1;
  options.midi = {...options.midi, noCalc: true};
  options.invertHealing = false;
  return wrapped(result.details, options);
}
let installed = false;
export function registerArcaneWardHooks() {
  if (installed || !globalThis.libWrapper) return;
  installed = true;
  setupSocket();
  libWrapper.register(MODULE, "CONFIG.Actor.documentClass.prototype.update", wardActorUpdate, "MIXED");
  libWrapper.register(MODULE, "CONFIG.Actor.documentClass.prototype.applyDamage", wardApplyDamage, "WRAPPER");
  Hooks.on("dnd5e.preApplyDamage", captureWardApplication);
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.flags?.["midi-qol"]?.undoDamage?.some(entry => entry.calcDamageOptions?.[PLAN])) return;
    html.addEventListener("click", event => {
      const button = event.target.closest?.('[id^="reverse-"],[id^="apply-"],#all-reverse,#all-apply');
      if (button) markWardCardAction(message, button.id);
    }, {capture: true});
  });
  Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
    if (actor.isOwner && (config?.type ?? result?.type) === "long") void dispatch("khuzoeWardRest", {actorUuid: actor.uuid});
  });
  Hooks.on("updateItem", (item, changes, options, userId) => {
    if (userId === game.user.id && item.actor && item.system?.identifier === IDENTIFIER) void syncWardIcon(item.actor);
  });
  Hooks.on("deleteItem", (item, options, userId) => {
    if (userId === game.user.id && item.actor && item.system?.identifier === IDENTIFIER) void syncWardIcon(item.actor);
  });
}
export function registerArcaneWard(api) {
  return {automations: [api.registerAutomation(ARCANE_WARD_AUTOMATION)], macros: [api.registerFnMacro({
    source: MODULE, identifier: IDENTIFIER, rules: "2014",
    roll: [{pass: "actorRollFinished", macro: wardAfterSpell, priority: 70},
      {pass: "targetDamage", macro: wardDamagePreview, priority: 1}]
  })]};
}
