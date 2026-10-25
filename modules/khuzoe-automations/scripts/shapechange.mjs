import {withDocumentLock} from "./operation-locks.mjs";
import {setDocumentFlagSafely} from "./cat-compat.mjs";
import {calculateWildShapeOverflow} from "./wild-shape.mjs";

const MODULE = "khuzoe-automations";
const FLAG = "shapechange";
const TOKEN_FLAG = "shapechangeActor";
const VERSION = "0.27.0";
const wrapped = Symbol("khuzoeShapechangeRevert");
const pending = new WeakMap();
const visualKeys = ["name", "width", "height", "alpha", "lockRotation", "texture", "ring", "sight", "detectionModes"];
let socket;
const values = collection => collection && !collection[Symbol.iterator] && !collection.values
  ? Object.values(collection) : Array.from(collection?.values?.() ?? collection ?? []);
const clone = value => foundry.utils.deepClone(value);
const stateOf = actor => actor?.flags?.[MODULE]?.[FLAG];
const tokenDocument = token => token?.document ?? token;
const activeGm = () => game.user?.isGM && game.users?.activeGM?.id === game.user.id;
const owns = (actor, user) => Boolean(user?.isGM || actor?.testUserPermission?.(user, "OWNER"));
const fail = message => { throw new Error(message); };
const report = error => {
  console.error("Khuzoe Automations | Shapechange", error);
  ui.notifications.error(`Shapechange: ${error.message}`);
};

export const SHAPECHANGE_AUTOMATION = {
  source: MODULE, rules: "2014", type: "spell", identifier: "shapechange", version: VERSION,
  uuid: "Compendium.khuzoe-automations.KhuzoeSpells2014.Item.KhzShapechange01",
  notes: "Trasforma un bersaglio (oppure il lanciatore) in un actor visibile a chi lancia. Ritorno alla forma originale con fine concentrazione, durata o 0 PF."
};

export function canChooseShape(actor, user) {
  return Boolean(actor && ["character", "npc"].includes(actor.type) && !actor.isPolymorphed
    && !stateOf(actor) && (user?.isGM || actor.testUserPermission?.(user, "LIMITED")));
}

export function visibleShapes(user = game.user) {
  return values(game.actors).filter(actor => canChooseShape(actor, user))
    .map(actor => ({uuid: actor.uuid, name: actor.name, img: actor.img}))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectShapechangeTarget(workflow) {
  const targets = values(workflow?.targets).map(tokenDocument);
  if (targets.length > 1) fail("Seleziona una sola creatura, oppure nessuna per trasformare il lanciatore.");
  const target = targets[0] ?? tokenDocument(workflow?.token);
  if (!target?.actor || !target.parent) fail("Il destinatario deve avere un token nella scena.");
  if (target.actor.isPolymorphed || stateOf(target.actor)) fail("La creatura è già trasformata: torna prima alla forma originale.");
  return target;
}

const appApi = globalThis.foundry?.applications?.api;
const Base = appApi?.HandlebarsApplicationMixin?.(appApi.ApplicationV2) ?? class {};
export class ShapechangePicker extends Base {
  #forms;
  #target;
  #resolve;
  constructor({forms, target, resolve}, options = {}) {
    super(options);
    this.#forms = forms;
    this.#target = target;
    this.#resolve = resolve;
  }
  static DEFAULT_OPTIONS = {
    id: "khuzoe-shapechange-picker", tag: "form", classes: ["khz-shapechange-picker"],
    position: {width: 660, height: 650}, window: {icon: "fa-solid fa-wand-magic-sparkles", resizable: true},
    form: {closeOnSubmit: false, handler: ShapechangePicker.submit},
    actions: {choose: ShapechangePicker.submit, cancel: function () { return this.close(); }}
  };
  static PARTS = {main: {template: `modules/${MODULE}/templates/shapechange-picker.hbs`}};
  get title() { return "Shapechange — Scegli la forma"; }
  async _prepareContext(options) {
    return {...await super._prepareContext(options), forms: this.#forms, target: this.#target};
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
    this.element.querySelector("[data-search]").addEventListener("input", event => {
      const query = normalize(event.target.value.trim());
      let count = 0;
      for (const card of this.element.querySelectorAll("[data-form]")) {
        card.hidden = !normalize(card.dataset.name).includes(query);
        if (!card.hidden) count++;
      }
      this.element.querySelector("[data-empty]").hidden = count > 0;
    });
  }
  static async submit(event) {
    event?.preventDefault();
    const selected = new FormData(this.form).get("formUuid");
    if (!this.#forms.some(form => form.uuid === selected)) return ui.notifications.warn("Scegli una forma.");
    this.#resolve?.(selected);
    this.#resolve = null;
    await this.close();
  }
  async close(options) {
    this.#resolve?.(null);
    this.#resolve = null;
    return super.close(options);
  }
}

async function request(action, data) {
  if (game.user.isGM) return action === "transform"
    ? transformShapechange(data, game.user.id) : revertShapechange(data.actorUuid, game.user.id);
  if (!socket || !game.users.activeGM) fail("Serve un GM connesso per gestire la trasformazione.");
  return socket.executeAsGM(`shapechange.${action}`, data);
}

export async function prepareShapechange({workflow}) {
  if (!workflow) return true;
  try {
    if (!game.user.isGM && (!socket || !game.users.activeGM)) fail("Serve un GM connesso per gestire la trasformazione.");
    const target = selectShapechangeTarget(workflow);
    if (!workflow.targets?.size) workflow.setTargets(new Set([workflow.token]));
    const forms = visibleShapes().filter(form => form.uuid !== target.actor.uuid);
    if (!forms.length) fail("Nessun actor visibile disponibile come nuova forma.");
    const sourceUuid = await new Promise((resolve, reject) => {
      new ShapechangePicker({forms, target: target.name, resolve}).render({force: true}).catch(reject);
    });
    if (!sourceUuid) return true; // CAT aborts before spending the spell slot.
    pending.set(workflow, {sourceUuid, targetUuid: target.uuid,
      casterTokenUuid: tokenDocument(workflow.token)?.uuid, itemUuid: workflow.item.uuid,
      operation: foundry.utils.randomID(24)});
  } catch (error) { report(error); return true; }
}

export async function finishShapechange({workflow}) {
  const data = pending.get(workflow);
  pending.delete(workflow);
  if (!data || workflow.aborted) return;
  try { await request("transform", data); }
  catch (error) { report(error); }
}

export function shapechangeSettings() {
  return new dnd5e.dataModels.settings.TransformationSetting({
    effects: new Set(["origin", "otherOrigin", "spell", "feat", "class", "background"]),
    keep: new Set(["bio", "class", "feats", "mental", "spells", "languages", "gearProf"]),
    merge: new Set(["saves", "skills"]), other: new Set(), spellLists: new Set(),
    minimumAC: "", tempFormula: "", transformTokens: false
  });
}

export async function validateShapechange(data, userId) {
  if (!game.user.isGM) fail("La trasformazione deve essere eseguita dal GM.");
  const user = game.users.get(userId);
  if (!user?.active) fail("Utente non disponibile.");
  const [item, target, casterToken, source] = await Promise.all([
    fromUuid(data.itemUuid), fromUuid(data.targetUuid), fromUuid(data.casterTokenUuid), fromUuid(data.sourceUuid)
  ]);
  if (item?.type !== "spell" || item.system.identifier !== "shapechange" || !owns(item.actor, user)) fail("Incantesimo o permessi del lanciatore non validi.");
  if (target?.documentName !== "Token" || casterToken?.documentName !== "Token"
    || !target.actor || !casterToken.actor || casterToken.actor.uuid !== item.actor.uuid
    || target.parent?.id !== casterToken.parent?.id) fail("Lanciatore e destinatario devono essere nella stessa scena.");
  if (!user.isGM && target.hidden) fail("Il destinatario non è visibile.");
  if (game.actors.get(source?.id) !== source || !canChooseShape(source, user)) fail("La forma scelta non è più disponibile o visibile al lanciatore.");
  if (source.uuid === target.actor.uuid) fail("Scegli una forma diversa da quella attuale.");
  if (!data.operation || typeof data.operation !== "string" || data.operation.length > 64) fail("Richiesta non valida.");
  return {item, target, source, user};
}

function resourceSnapshot(actor) {
  const items = {};
  for (const item of values(actor.items)) if (["spell", "feat", "class", "subclass"].includes(item.type)) {
    items[item.id] = {spent: Number(item.system.uses?.spent ?? 0), activities: Object.fromEntries(
      values(item.system.activities).map(activity => [activity.id ?? activity._id, Number(activity.uses?.spent ?? 0)]))};
  }
  return {spells: Object.fromEntries(Object.entries(actor.system.spells ?? {}).map(([key, slot]) => [key, Number(slot.value ?? 0)])), items};
}

function snapshotToken(token) {
  const data = token.toObject();
  return Object.fromEntries([...visualKeys, "actorId", "actorLink", "delta"].filter(key => key in data).map(key => [key, clone(data[key])]));
}

function transformationAppearance(actor, token, sourceName) {
  const prototype = actor.prototypeToken.toObject();
  const update = Object.fromEntries(visualKeys.filter(key => key in prototype).map(key => [key, clone(prototype[key])]));
  update.name = `${token.name} (${sourceName})`;
  // Ownership of vision is a property of the placed token, not the form prototype.
  if (update.sight) update.sight.enabled = token.sight.enabled;
  return {...update, actorId: actor.id, actorLink: true};
}

async function concentrationFor(item) {
  return await globalThis.cat?.utils?.effectUtils?.getConcentrationEffect?.(item.actor, item) ?? null;
}

export async function transformShapechange(data, userId) {
  const prior = values(game.actors).find(actor => stateOf(actor)?.operation === data.operation);
  if (prior && game.user.isGM && game.users.get(userId)?.active && stateOf(prior).userId === userId
    && stateOf(prior).targetUuid === data.targetUuid && stateOf(prior).itemUuid === data.itemUuid) return prior.uuid;
  const validated = await validateShapechange(data, userId);
  return withDocumentLock(validated.target, "shapechange", async () => {
    const duplicate = values(game.actors).find(actor => stateOf(actor)?.operation === data.operation
      && stateOf(actor)?.userId === userId);
    if (duplicate) return duplicate.uuid;
    const {item, target, source} = await validateShapechange(data, userId);
    if (target.actor.isPolymorphed || stateOf(target.actor)) fail("La creatura è già trasformata.");
    const concentration = await concentrationFor(item);
    if (!concentration || concentration.disabled || concentration.duration?.expired) fail("La concentrazione di Shapechange non è attiva. Controlla la gestione della concentrazione del sistema e di Midi-QOL.");
    const original = target.actor;
    const state = {operation: data.operation, userId, targetUuid: target.uuid, itemUuid: item.uuid,
      originalActorUuid: original.uuid, casterActorUuid: item.actor.uuid,
      concentrationUuid: concentration.uuid, concentrationId: concentration.id,
      self: original.uuid === item.actor.uuid, original: snapshotToken(target),
      resources: resourceSnapshot(original), expiresAt: Number(game.time.worldTime) + 3600};
    let transformed;
    try {
      // A detached, in-memory host forces the native world-Actor path. The native
      // synthetic path edits embedded data and the linked path changes every active
      // token on the GM's canvas. Neither is suitable for a single targeted token.
      const host = new original.constructor(original.toObject());
      const hook = Hooks.on("dnd5e.transformActorV2", (actor, _source, created, _settings, options) => {
        if (actor !== host || options.khuzoeShapechange !== data.operation) return;
        created.flags ??= {};
        created.flags[MODULE] ??= {};
        created.flags[MODULE][FLAG] = clone(state);
        // The native transformation clones all flags, including Tokenizer's last
        // export event. Never let that receipt publish the runtime copy as an NPC.
        created.flags["cripta-wiki-sync"] ??= {};
        created.flags["cripta-wiki-sync"].excludeFromSync = true;
        if (created.flags["khuzoe-tokenizer"]) delete created.flags["khuzoe-tokenizer"].syncEvent;
        created.system.attributes.hp.value = source.system.attributes.hp.max;
        created.system.attributes.hp.temp = 0;
      });
      try { await host.transformInto(source, shapechangeSettings(), {renderSheet: false, khuzoeShapechange: data.operation}); }
      finally { Hooks.off("dnd5e.transformActorV2", hook); }
      transformed = values(game.actors).find(actor => stateOf(actor)?.operation === data.operation);
      if (!transformed) fail("Impossibile creare la nuova forma.");
      await transformed.update({[`flags.${MODULE}.${FLAG}.retainedEffects`]: values(original.effects)
        .filter(effect => transformed.effects.has(effect.id)).map(effect => effect.id)});
      if (state.self) {
        const copied = transformed.effects.get(state.concentrationId);
        const copiedItem = transformed.items.get(item.id);
        if (!copied || !copiedItem) fail("Impossibile conservare l'incantesimo nella nuova forma.");
        await copied.update({origin: copiedItem.uuid});
      }
      await transformed.createEmbeddedDocuments("ActiveEffect", [{
        name: "Shapechange — Forma attiva", img: item.img, origin: item.uuid,
        type: "base", showIcon: 1,
        duration: {value: 3600, units: "seconds", expiry: "updateWorldTime", expired: false},
        start: {time: game.time.worldTime},
        system: {changes: []}, flags: {[MODULE]: {shapechangeController: true}}
      }]);
      const currentConcentration = await fromUuid(state.concentrationUuid);
      if (!currentConcentration || currentConcentration.disabled) fail("La concentrazione è terminata durante la scelta della forma.");
      // A synthetic caster ceases to be addressable by its old Actor UUID after
      // the token swap; its copied concentration is the live authority instead.
      if (state.self && original.isToken) {
        const copied = transformed.effects.get(state.concentrationId);
        if (!copied) fail("Impossibile conservare la concentrazione nella nuova forma.");
        await transformed.update({[`flags.${MODULE}.${FLAG}.concentrationUuid`]: copied.uuid});
      }
      await target.update({...transformationAppearance(transformed, target, source.name),
        [`flags.${MODULE}.${TOKEN_FLAG}`]: transformed.uuid}, {khuzoeShapechange: true});
      installRevert(transformed);
      return transformed.uuid;
    } catch (error) {
      // A failed swap must never delete the actor to which a token now points.
      transformed ??= values(game.actors).find(actor => stateOf(actor)?.operation === data.operation);
      if (transformed && !tokensFor(transformed).length) await transformed.delete({khuzoeShapechangeCleanup: true});
      throw error;
    }
  });
}

function tokensFor(actor) {
  return values(game.scenes).flatMap(scene => values(scene.tokens)).filter(token => token.actorId === actor.id);
}

export function resourceReturnUpdates(original, transformed, state) {
  const updates = {};
  for (const [key, start] of Object.entries(state.resources.spells)) {
    const current = transformed.system.spells?.[key]?.value;
    const destination = original.system.spells?.[key];
    if (Number.isFinite(current) && destination && current !== start) {
      updates[`system.spells.${key}.value`] = Math.max(0, Math.min(Number(destination.max ?? Infinity), Number(destination.value) + current - start));
    }
  }
  const items = [];
  for (const [id, baseline] of Object.entries(state.resources.items)) {
    const current = transformed.items.get(id);
    const destination = original.items.get(id);
    if (!current || !destination) continue;
    const update = {_id: id};
    const spent = Number(current.system.uses?.spent ?? 0) - baseline.spent;
    if (spent) update["system.uses.spent"] = Math.max(0, Number(destination.system.uses?.spent ?? 0) + spent);
    for (const [key, start] of Object.entries(baseline.activities)) {
      const activity = current.system.activities?.get?.(key);
      const dest = destination.system.activities?.get?.(key);
      if (!activity || !dest) continue;
      const difference = Number(activity.uses?.spent ?? 0) - start;
      if (difference) update[`system.activities.${key}.uses.spent`] = Math.max(0, Number(dest.uses?.spent ?? 0) + difference);
    }
    if (Object.keys(update).length > 1) items.push(update);
  }
  if (items.length) updates.items = items;
  const overflow = Number(transformed.system.attributes.hp.value) <= 0
    ? Math.max(0, Number(state.pendingOverflow?.amount ?? 0)) : 0;
  if (overflow) {
    const hp = original.system.attributes.hp;
    const temp = Math.max(0, Number(hp.temp ?? 0));
    updates["system.attributes.hp.temp"] = Math.max(0, temp - overflow);
    updates["system.attributes.hp.value"] = Math.max(0, Number(hp.value) - Math.max(0, overflow - temp));
  }
  return updates;
}

export async function revertShapechange(actorUuid, userId) {
  if (!game.user.isGM) fail("Il ritorno alla forma originale deve essere eseguito dal GM.");
  const actor = await fromUuid(actorUuid);
  if (!stateOf(actor)) return null;
  const state = stateOf(actor);
  const user = game.users.get(userId);
  const caster = await fromUuid(state.casterActorUuid);
  if (!user?.active || !(owns(actor, user) || owns(caster, user))) fail("Non puoi terminare questa trasformazione.");
  return withDocumentLock({uuid: state.targetUuid}, "shapechange", async () => {
    if (game.actors.get(actor.id) !== actor) return null;
    const token = await fromUuid(state.targetUuid);
    const base = game.actors.get(state.original.actorId);
    if (!token || !base) fail("Il token o l'actor originale non è disponibile. La copia di recupero è stata conservata.");
    const isForm = token.actorId === actor.id;
    const isRestored = token.actorId === state.original.actorId && token.flags?.[MODULE]?.[TOKEN_FLAG] === actor.uuid;
    if (!isForm && !isRestored) fail("Il token è stato modificato dopo Shapechange: la copia di recupero è stata conservata.");
    if (isForm) {
      const replacement = foundry.data.operators.ForcedReplacement.create;
      const update = Object.fromEntries(Object.entries(clone(state.original)).map(([key, value]) =>
        [key, value && typeof value === "object" ? replacement(value) : value]));
      await token.update(update, {khuzoeShapechange: true});
    }
    // ActorDelta mutations can replace the synthetic Actor and its effect maps.
    // Resolve each effect from its current parent, and deduplicate by full UUID
    // (the original and transformed actors intentionally share effect IDs).
    const removedEffects = new Set();
    const removeEffect = async uuid => {
      if (!uuid || removedEffects.has(uuid)) return;
      const separator = uuid.lastIndexOf(".ActiveEffect.");
      if (separator < 0) return;
      const parent = await fromUuid(uuid.slice(0, separator));
      const effect = parent?.effects?.get(uuid.slice(separator + ".ActiveEffect.".length));
      if (effect) await effect.delete();
      removedEffects.add(uuid);
    };
    // Effects which ended on the transformed creature must not reappear when its
    // original delta is restored, notably its own concentration on another spell.
    for (const id of state.retainedEffects ?? []) {
      const copy = actor.effects.get(id);
      const effect = token.actor.effects.get(id);
      if (effect && (!copy || copy.disabled || copy.duration?.expired)) await removeEffect(effect.uuid);
    }
    const original = token.actor;
    // One atomic update makes recovery retries idempotent, including retained uses
    // and already-resolved damage overflowing from the form's HP pool.
    if (original.getFlag(MODULE, "shapechangeRestored") !== state.operation) {
      await original.update({...resourceReturnUpdates(original, actor, state),
        [`flags.${MODULE}.shapechangeRestored`]: state.operation}, {
        khuzoeShapechange: true, ...(state.self ? {dnd5e: {concentrationCheck: false}} : {})
      });
    }
    await removeEffect(state.concentrationUuid);
    if (state.self) {
      await removeEffect(`${token.actor.uuid}.ActiveEffect.${state.concentrationId}`);
    }
    await token.unsetFlag(MODULE, TOKEN_FLAG);
    await actor.sheet?.close();
    if (!tokensFor(actor).length) await actor.delete({khuzoeShapechangeCleanup: true});
    return original.uuid;
  });
}

function installRevert(actor) {
  if (!stateOf(actor) || actor[wrapped]) return;
  // Native sheet/context-menu restore delegates here only for our temporary actor.
  // The native implementation restores all active tokens and assumes the GM scene.
  Object.defineProperty(actor, wrapped, {value: true});
  actor.revertOriginalForm = async () => {
    try { return await request("revert", {actorUuid: actor.uuid}); }
    catch (error) { report(error); return null; }
  };
}

const ending = new Set();
async function endOnGm(actor) {
  if (!activeGm() || ending.has(actor.uuid)) return;
  ending.add(actor.uuid);
  try {
    const token = await fromUuid(stateOf(actor)?.targetUuid);
    if (token?.actorId !== actor.id && token?.flags?.[MODULE]?.[TOKEN_FLAG] !== actor.uuid) return;
    await revertShapechange(actor.uuid, game.user.id);
  }
  catch (error) { report(error); }
  finally { ending.delete(actor.uuid); }
}

async function checkLifetimes() {
  if (!activeGm()) return;
  for (const actor of values(game.actors).filter(actor => stateOf(actor))) {
    const state = stateOf(actor);
    const token = await fromUuid(state.targetUuid);
    if (token?.actorId !== actor.id) continue;
    const concentration = await fromUuid(state.concentrationUuid);
    if (!concentration || concentration.disabled || concentration.duration?.expired || Number(game.time.worldTime) >= state.expiresAt
      || Number(actor.system.attributes.hp.value) <= 0) await endOnGm(actor);
  }
}

function concentrationEnded(effect) {
  if (!activeGm()) return;
  for (const actor of values(game.actors)) {
    const state = stateOf(actor);
    if (!state) continue;
    if (effect.uuid === state.concentrationUuid || (effect.parent?.uuid === actor.uuid
      && (effect.flags?.[MODULE]?.shapechangeController || (state.self && effect.id === state.concentrationId)))) {
      void endOnGm(actor);
    }
  }
}

export function registerShapechange(api) {
  return {automations: [api.registerAutomation(SHAPECHANGE_AUTOMATION)], macros: [api.registerFnMacro({
    source: MODULE, rules: "2014", identifier: "shapechange", roll: [
      {pass: "itemPreItemRoll", macro: prepareShapechange, priority: 10},
      {pass: "itemRollFinished", macro: finishShapechange, priority: 100}
    ]
  })]};
}

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE);
  socket.register("shapechange.transform", function (data) { return transformShapechange(data, this.socketdata.userId); });
  socket.register("shapechange.revert", function (data) { return revertShapechange(data.actorUuid, this.socketdata.userId); });
});
Hooks.on("createActor", installRevert);
Hooks.on("preDeleteActor", (actor, options, userId) => {
  if (!stateOf(actor) || options.khuzoeShapechangeCleanup) return;
  if (userId === game.user.id) void actor.revertOriginalForm();
  return false;
});
Hooks.once("ready", () => {
  values(game.actors).forEach(installRevert);
  const module = game.modules.get(MODULE);
  module.api = {...module.api, revertShapechange: actor => request("revert", {actorUuid: actor?.uuid ?? actor})};
  void checkLifetimes().catch(report);
});
Hooks.on("updateWorldTime", () => { void checkLifetimes().catch(report); });
Hooks.on("updateUser", (_user, changes) => { if ("active" in changes) void checkLifetimes().catch(report); });
Hooks.on("deleteActiveEffect", concentrationEnded);
Hooks.on("updateActiveEffect", (effect, changes) => {
  if (changes.disabled === true || foundry.utils.getProperty(changes, "duration.expired") === true) concentrationEnded(effect);
});
Hooks.on("updateActor", (actor, changes) => {
  if (stateOf(actor) && foundry.utils.hasProperty(changes, "system.attributes.hp.value")
    && Number(actor.system.attributes.hp.value) <= 0) void endOnGm(actor);
});
Hooks.on("midi-qol.preItemRoll", workflow => {
  if (!stateOf(workflow.actor)) return;
  const concentration = workflow.activity?.duration?.concentration ?? workflow.item?.system?.properties?.has?.("concentration");
  if (!concentration) return;
  // Starting a new concentration spell would delete the temporary caster midway
  // through its own workflow. Abort before resource consumption instead.
  ui.notifications.warn("Torna alla forma originale prima di lanciare un nuovo incantesimo a concentrazione.");
  return false;
});
Hooks.on("midi-qol.preTargetDamageApplication", async (token, data) => {
  const actor = tokenDocument(token)?.actor;
  if (!stateOf(actor) || !data?.damageItem) return;
  const amount = calculateWildShapeOverflow(actor, data.damageItem);
  await setDocumentFlagSafely(actor, MODULE, `${FLAG}.pendingOverflow`, {amount});
});
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const actor = app.actor ?? app.document;
  if (!stateOf(actor) || !actor.isOwner) return;
  app.options.actions.khuzoeShapechangeRevert = () => actor.revertOriginalForm();
  controls.push({action: "khuzoeShapechangeRevert", label: "Torna alla forma originale", icon: "fa-solid fa-person"});
});
