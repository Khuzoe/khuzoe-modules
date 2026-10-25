import {damageDealt} from "./damage-adjustment.mjs";
export {damageDealt} from "./damage-adjustment.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {distanceInScene} from "./movement-compat.mjs";
import {SPECIAL_SPELL_CATALOG, SPECIAL_SPELL_VERSION, SPECIAL_EFFECT, specialActivity, specialDamage} from "./special-spell-catalog.mjs";

const MODULE = "khuzoe-automations";
const STATE = "specialSpell";
const locks = new Map();
const workflowState = new WeakMap();
const DAMAGE_TYPES = ["acid", "cold", "fire", "force", "lightning", "poison", "psychic", "thunder"];

export const SPECIAL_SPELL_AUTOMATIONS = Object.freeze(SPECIAL_SPELL_CATALOG.map(spell => Object.freeze({
  source: MODULE, rules: "2014", type: "spell", identifier: spell.identifier,
  version: SPECIAL_SPELL_VERSION,
  uuid: `Compendium.${MODULE}.KhuzoeSpells2014.Item.${spell.id}`,
  notes: `Automazione Khuzoe v14 per ${spell.name}: gestione indipendente, attività successive e concentrazione.`
})));

const utils = () => globalThis.cat.utils;
const values = collection => collection ? Array.from(collection.contents ?? (collection instanceof Map ? collection.values() : collection[Symbol.iterator] ? collection : Object.values(collection))) : [];
const doc = token => token?.document ?? token;
const clone = data => globalThis.foundry?.utils?.deepClone?.(data) ?? structuredClone(data);
const effectState = effect => effect?.flags?.[MODULE]?.[STATE] ?? {};
const tokenUuid = token => doc(token)?.uuid;
const sameToken = (a, b) => Boolean(tokenUuid(a) && tokenUuid(a) === tokenUuid(b));
const warn = message => globalThis.ui?.notifications?.warn?.(`Khuzoe Automations: ${message}`);
const activeEffect = effect => !effect.disabled && !effect.isSuppressed && !effect.duration?.expired;

function state(workflow) {
  if (!workflowState.has(workflow)) workflowState.set(workflow, {});
  return workflowState.get(workflow);
}

async function locked(key, callback) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  locks.set(key, current);
  try { return await current; }
  finally { if (locks.get(key) === current) locks.delete(key); }
}

function itemFrom(context) {
  return context.workflow?.item ?? context.item ?? context.activity?.item
    ?? (context.document?.documentName === "Item" ? context.document : null);
}

function activityKey(item, activity) {
  return activity?.midiProperties?.identifier
    ?? Object.entries(item?.flags?.[MODULE]?.activityIdentifiers ?? {}).find(([, id]) => id === (activity?.id ?? activity?._id))?.[0]
    ?? "";
}

function activityFor(item, key) {
  const id = item?.flags?.[MODULE]?.activityIdentifiers?.[key];
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activityKey(item, activity) === key);
}

function tokens(workflow, key = "targets") {
  return values(workflow?.[key]).map(doc).filter(token => token?.actor);
}

function currentScene(token) {
  return Boolean(token?.parent?.id && token.parent.id === globalThis.canvas?.scene?.id);
}

function casterToken(workflow) {
  return doc(workflow?.token) ?? doc(utils().actorUtils.getFirstToken(workflow?.actor));
}

function level(workflow) {
  return Math.max(1, Number(workflow?.castData?.castLevel ?? workflow?.workflowOptions?.castData?.castLevel
    ?? workflow?.activity?.flags?.cat?.castData?.castLevel ?? workflow?.item?.system?.level ?? 1));
}

function saveDC(item) {
  return Number(utils().itemUtils.getSaveDC(item)) || 10;
}

function owner(actor) {
  // Keep the controlling owner when several users own this actor.
  const user = globalThis.game?.user;
  if (!user?.isGM && actor?.isOwner) return user?.id;
  return utils().queryUtils?.firstOwner?.(actor, true) ?? user?.id;
}

function rootEffect(item, kind = item?.system?.identifier) {
  return values(item?.actor?.effects).find(effect => activeEffect(effect)
    && effectState(effect).kind === kind && effectState(effect).itemUuid === item.uuid);
}

async function resolve(uuid) {
  return uuid ? globalThis.fromUuid(uuid) : null;
}

async function remove(document) {
  if (!document) return;
  return locked(`delete:${document.uuid}`, async () => {
    if (document.uuid && !await resolve(document.uuid)) return;
    try { await utils().documentUtils.deleteDocument(document); }
    catch (error) {
      if (!/does not exist/i.test(String(error?.message ?? error))) throw error;
    }
  });
}

function macroReference() { return {source: MODULE, rules: "2014", identifier: SPECIAL_EFFECT}; }

async function createEffect(actor, item, {kind, name = item.name, data = {}, seconds = 60,
  changes = [], statuses = [], parent, activity, unhide = [], groups = [], showIcon = 1, specialDuration = []} = {}) {
  const effect = (await utils().effectUtils.createEffects(actor, [{
    name, img: item.img, origin: activity?.uuid ?? item.uuid, type: "base", transfer: false,
    disabled: false, showIcon, statuses, system: {changes},
    duration: {value: seconds, units: "seconds", expiry: "turnStart", expired: false},
    flags: {
      [MODULE]: {[STATE]: {kind, itemUuid: item.uuid, ...data}},
      cat: {identifier: `${SPECIAL_EFFECT}-${kind}`, activityUuid: activity?.uuid,
        macros: Object.fromEntries(groups.map(group => [group, [macroReference()]]))},
      dae: {transfer: false, stackable: "multi", expiryMode: "delete", specialDuration},
      "midi-qol": {forceCEOff: true}
    }
  }], {rules: "2014", unhideActivities: unhide}))?.[0];
  if (!effect) throw new Error(`${item.name}: creazione dell'effetto non riuscita.`);
  if (parent) {
    try { await utils().documentUtils.makeDependent(parent, [effect]); }
    catch (error) { await remove(effect); throw error; }
  }
  return effect;
}

async function startEffect(workflow, options = {}) {
  const item = workflow.item;
  return locked(`cast:${item.uuid}`, async () => {
    const existing = rootEffect(item);
    if (existing) await remove(existing);
    const concentration = utils().effectUtils.getConcentrationEffect(item.actor, item);
    if (!concentration) {
      warn(`${item.name}: manca l'effetto di concentrazione. Controlla le impostazioni Midi-QOL.`);
      return null;
    }
    return createEffect(item.actor, item, {
      kind: item.system.identifier, activity: workflow.activity, parent: concentration,
      ...options, data: {castLevel: level(workflow), concentrationUuid: concentration.uuid, ...options.data}
    });
  });
}

async function buttons(item, prompt, entries, actor = item.actor) {
  return utils().dialogUtils.buttonDialog(item.name, prompt, entries.map(([label, value]) => [label, value]), {userId: owner(actor)});
}

async function selectTokens(item, prompt, candidates, multiple = false) {
  const selection = await utils().dialogUtils.selectTargetDialog(item.name, prompt, candidates, {
    userId: owner(item.actor), type: multiple ? "multiple" : "one", displayDistance: false,
    skipDeadAndUnconscious: false, maxAmount: multiple ? candidates.length : 1
  });
  if (!selection?.result) return null;
  return (Array.isArray(selection.result) ? selection.result : [selection.result]).map(doc).filter(Boolean);
}

function canSee(source, target) {
  if (!source || !target) return false;
  return globalThis.MidiQOL?.canSee?.(source.object ?? source, target.object ?? target) ?? true;
}

function within(source, target, range) {
  if (!currentScene(source) || !currentScene(target)) return false;
  return utils().tokenUtils.getDistance(source, target, {wallsBlock: false}) <= range + 0.001;
}

/** Copies a rider into a usable activity; hidden/automationOnly riders otherwise abort in D&D5e. */
async function runActivity(item, key, targets, {castLevel = item.system.level, chain, damageType} = {}) {
  const original = activityFor(item, key);
  if (!original) throw new Error(`${item.name}: attività ${key} mancante; riapplica l'automazione.`);
  const data = original.toObject ? original.toObject() : clone(original);
  data.flags ??= {};
  data.flags.cat = {...data.flags.cat, hidden: false};
  data.midiProperties = {...data.midiProperties, automationOnly: false, confirmTargets: "none"};
  data.activation = {type: "special", value: null, override: true};
  data.consumption = {spellSlot: false, targets: [], scaling: {allowed: false}};
  data.duration = {units: "inst", concentration: false, override: true};
  // Bake scaling into this isolated copy. Works for NPC innate/pact casts too,
  // without selecting or consuming an unavailable slot on subsequent uses.
  for (const part of data.damage?.parts ?? []) {
    if (part.scaling?.mode === "whole") part.number += Math.max(0, castLevel - Number(item.system.level)) * (Number(part.scaling.number) || 1);
    part.scaling = {mode: "", number: null, formula: ""};
    if (damageType) part.types = [damageType];
  }
  const itemData = item.toObject();
  itemData.system.activities = {[data._id]: data};
  itemData.flags ??= {};
  itemData.flags.dnd5e ??= {};
  itemData.flags.dnd5e.riders = {activity: [], effect: []};
  itemData.flags.dnd5e.scaling = 0;
  delete itemData.flags.dnd5e.spellLevel;
  const synthetic = utils().itemUtils.syntheticItem(itemData, item.actor);
  const runnable = synthetic.system.activities.get(data._id);
  return utils().workflowUtils.syntheticActivityRoll(runnable, targets.map(doc), {
    userId: globalThis.game.user.id, consumeUsage: false, consumeResources: false, spellSlot: false,
    config: {scaling: 0, consume: {action: false}},
    options: {workflowOptions: {targetConfirmation: "none", khuzoeSpecial: {internal: key, castLevel, chain}}}
  });
}

export async function prepareSpecialUse(context = {}) {
  const item = itemFrom(context);
  const key = activityKey(item, context.activity);
  if (!item) return;
  if (key === "dragonBreath") {
    const effect = await resolve(item.flags?.[MODULE]?.grantedBy);
    if (!effect || !activeEffect(effect)) { warn("il soffio non è più attivo."); return true; }
    return;
  }
  if (!["heatMetalPulse", "holyWeaponDismiss", "vampiricTouchAttack"].includes(key)) return;
  const effect = rootEffect(item);
  if (!effect) { warn(`${item.name}: l'incantesimo non è attivo.`); return true; }
  const concentration = await resolve(effectState(effect).concentrationUuid);
  if (!concentration || !activeEffect(concentration)) { warn(`${item.name}: la concentrazione è terminata.`); return true; }
  if (context.dialog) context.dialog.configure = false;
  if (context.config) {
    context.config.consume = {...context.config.consume, spellSlot: false, resources: false};
    context.config.consumeUsage = false;
    context.config.scaling = Math.max(0, Number(effectState(effect).castLevel) - Number(item.system.level));
    // The system uses the chosen slot to derive scaling even when not consumed.
    const spellLabel = utils().actorUtils.getEquivalentSpellSlotName?.(item.actor, effectState(effect).castLevel);
    if (spellLabel) context.config.spell = {...context.config.spell, slot: spellLabel};
    context.config.midiOptions ??= {};
    context.config.midiOptions.workflowOptions ??= {};
    context.config.midiOptions.workflowOptions.khuzoeSpecial = {castLevel: effectState(effect).castLevel};
  }
}

export async function prepareSpecialSpell({workflow} = {}) {
  if (!workflow) return;
  const item = workflow.item;
  const key = activityKey(item, workflow.activity);
  const local = state(workflow);
  if (key === "heatMetal") {
    if (!tokens(workflow).length) { warn("Heat Metal: seleziona chi è in contatto con l'oggetto metallico."); return true; }
  }
  if (key === "dragonsBreath" || key === "holyWeapon") {
    const targets = tokens(workflow);
    if (targets.length !== 1) { warn(`${item.name}: seleziona una sola creatura.`); return true; }
    if (key === "dragonsBreath") {
      const chosen = await buttons(item, "Tipo di danno del soffio (il bersaglio deve essere consenziente).",
        ["acid", "cold", "fire", "lightning", "poison"].map(type => [globalThis.CONFIG?.DND5E?.damageTypes?.[type]?.label ?? type, type]));
      if (!chosen) return true;
      local.damageType = chosen;
    } else {
      const weapons = values(targets[0].actor.items).filter(weapon => weapon.type === "weapon");
      if (!weapons.length) { warn("Holy Weapon: il bersaglio non possiede armi."); return true; }
      const weapon = weapons.length === 1 ? weapons[0] : await utils().dialogUtils.selectDocumentDialog(
        item.name, "Scegli l'arma da potenziare.", weapons, {userId: owner(item.actor)});
      if (!weapon) return true;
      local.weaponUuid = weapon.uuid;
    }
  }
}

export async function castMirrorImage(workflow) {
  const item = workflow.item;
  return locked(`mirror:${item.actor.uuid}`, async () => {
    for (const effect of values(item.actor.effects).filter(e => effectState(e).kind === "mirror-image")) await remove(effect);
    await createEffect(item.actor, item, {kind: "mirror-image", name: `${item.name} (3)`,
      data: {duplicates: 3, baseName: item.name}, groups: ["roll"]});
  });
}

export async function redirectMirrorAttack({document: effect, workflow} = {}) {
  if (!effect || !workflow || effectState(effect).kind !== "mirror-image" || !activeEffect(effect)) return;
  if (workflow.activity?.type !== "attack" || !workflow.attackRoll || workflow.isFumble) return;
  const target = tokens(workflow).find(token => token.actor?.uuid === effect.parent?.uuid);
  const attacker = casterToken(workflow);
  if (!target || !attacker || !canSee(attacker, target)) return;
  if (globalThis.MidiQOL?.canSense?.(attacker.object ?? attacker, target.object ?? target, ["blindsight", "seeAll"])) return;
  // Truesight configured on the actor may not have been added as a token mode.
  const ranges = attacker.actor?.system?.attributes?.senses?.ranges ?? {};
  const specialSense = Math.max(Number(ranges.truesight) || 0, Number(ranges.blindsight) || 0);
  if (specialSense && within(attacker, target, specialSense)) return;
  await locked(`mirror:${effect.parent.uuid}`, async () => {
    const current = await resolve(effect.uuid);
    if (!current || !activeEffect(current)) return;
    const local = state(workflow);
    local.mirrors ??= new Set();
    if (local.mirrors.has(effect.uuid)) return;
    local.mirrors.add(effect.uuid);
    const duplicates = Number(effectState(current).duplicates);
    if (duplicates < 1) return;
    const RollClass = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
    const roll = await new RollClass("1d20").evaluate();
    await roll.toMessage({speaker: globalThis.ChatMessage.implementation.getSpeaker({actor: target.actor}), flavor: current.name});
    if (roll.total < (duplicates >= 3 ? 6 : duplicates === 2 ? 8 : 11)) return;
    for (const key of ["hitTargets", "hitTargetsEC"]) {
      for (const entry of values(workflow[key])) if (sameToken(entry, target)) workflow[key].delete(entry);
    }
    const duplicateAC = 10 + Number(target.actor.system?.abilities?.dex?.mod ?? 0);
    if (!workflow.isCritical && Number(workflow.attackTotal ?? workflow.attackRoll.total) < duplicateAC) return;
    if (duplicates === 1) await remove(current);
    else await updateDocumentSafely(current, {
      name: `${effectState(current).baseName} (${duplicates - 1})`,
      [`flags.${MODULE}.${STATE}.duplicates`]: duplicates - 1
    });
  });
}

export async function castDragonBreath(workflow) {
  const item = workflow.item;
  const target = tokens(workflow)[0];
  if (!target) return;
  const concentration = utils().effectUtils.getConcentrationEffect(item.actor, item);
  if (!concentration) { warn(`${item.name}: manca la concentrazione.`); return; }
  const damageType = state(workflow).damageType;
  if (!damageType) return;
  // An identical named spell cannot stack; old granted items are dependents.
  for (const old of values(target.actor.effects).filter(effect => effectState(effect).kind === "dragons-breath")) await remove(old);
  const effect = await createEffect(target.actor, item, {kind: "dragons-breath", parent: concentration,
    activity: workflow.activity, data: {castLevel: level(workflow), damageType}});
  const activity = specialActivity("dragonBreath", {name: "Soffio del drago", type: "save", activation: "action",
    range: "self", count: "", save: "dex", dc: saveDC(item), parts: [specialDamage(level(workflow) + 1, 6, damageType)]});
  activity.img = item.img;
  activity.target.template = {...activity.target.template, type: "cone", size: "15", count: "1"};
  const data = {
    name: `${item.name} — Soffio`, img: item.img, type: "feat", effects: [],
    system: {
      identifier: "dragons-breath-exhale", type: {value: "monster"},
      source: {rules: "2014", custom: "Khuzoe Automations"},
      description: {value: "Capacità temporanea concessa da Dragon's Breath. Usa la CD e il livello dello slot dell'incantatore originale."},
      activities: {[activity._id]: activity}, uses: {max: "", spent: 0, recovery: []}
    },
    flags: {[MODULE]: {grantedBy: effect.uuid, activityIdentifiers: {dragonBreath: activity._id}},
      cat: {macros: {roll: [{source: MODULE, rules: "2014", identifier: "dragons-breath"}]}}}
  };
  let created = [];
  try {
    created = await utils().documentUtils.createEmbeddedDocuments(target.actor, "Item", [data]);
    if (!created?.length) throw new Error("Il soffio temporaneo non è stato creato.");
    await utils().documentUtils.makeDependent(effect, created);
  } catch (error) {
    for (const item of created ?? []) await remove(item);
    await remove(effect);
    throw error;
  }
}


async function heatContact(workflow, source, target) {
  const item = workflow.item;
  const choices = [["Lo lascio cadere", "drop"], ["Provo a trattenerlo (TS COS)", "hold"], ["Non posso toglierlo (es. armatura)", "unable"]];
  const choice = await buttons(item, `${target.name}: l'oggetto è rovente.`, choices, target.actor);
  if (!choice) return {uuid: target.uuid, contact: true};
  let dropped = choice === "drop";
  if (choice === "hold" || choice === "unable") {
    const result = await runActivity(item, "heatMetalHeld", [target]);
    if (!result || result.aborted) return {uuid: target.uuid, contact: true};
    dropped = choice !== "unable" && tokens(result, "failedSaves").some(t => sameToken(t, target));
  }
  const previous = values(target.actor.effects).filter(effect => effectState(effect).kind === "heat-metal-held"
    && effectState(effect).itemUuid === item.uuid);
  for (const effect of previous) await remove(effect);
  if (!dropped) await createEffect(target.actor, item, {
    kind: "heat-metal-held", name: `${item.name} — Oggetto trattenuto`, parent: source,
    specialDuration: ["turnStartSource"], seconds: 12,
    changes: ["flags.midi-qol.disadvantage.attack.all", "flags.midi-qol.disadvantage.ability.check.all"]
      .map(key => ({key, value: "1", type: "override", priority: 20}))
  });
  if (dropped) globalThis.ui?.notifications?.info?.(`${target.name} lascia l'oggetto riscaldato. Gli impulsi non lo danneggeranno finché non torna in contatto.`);
  return {uuid: target.uuid, contact: !dropped};
}

export async function pulseHeatMetal(workflow, source) {
  if (!source) return;
  await locked(`pulse:${source.uuid}`, async () => {
    const sourceState = effectState(source);
    let contacts = (await Promise.all((sourceState.contacts ?? []).filter(c => c.contact).map(c => resolve(c.uuid))))
      .map(doc).filter(token => token?.actor && currentScene(token));
    if (!contacts.length) {
      const candidates = values(globalThis.game.user.targets).map(doc).filter(token => token?.actor && currentScene(token));
      if (!candidates.length) { warn("nessuna creatura ancora a contatto. Per un nuovo contatto, bersaglia chi sta toccando lo stesso oggetto."); return; }
      const confirm = await buttons(workflow.item, "Confermi che i bersagli selezionati sono ora in contatto con lo stesso oggetto riscaldato?", [["Conferma", true], ["Annulla", false]]);
      if (!confirm) return;
      contacts = candidates;
    }
    const damage = await runActivity(workflow.item, "heatMetalDamage", contacts, {castLevel: sourceState.castLevel});
    if (!damage || damage.aborted) return;
    const remaining = [];
    for (const target of contacts) {
      // Immunity to fire also prevents the forced drop/disadvantage rider.
      remaining.push(damageDealt(damage, target, "fire") > 0
        ? await heatContact(workflow, source, target) : {uuid: target.uuid, contact: true});
    }
    if (await resolve(source.uuid)) await updateDocumentSafely(source, {[`flags.${MODULE}.${STATE}.contacts`]: remaining});
  });
}

export async function castHolyWeapon(workflow) {
  const item = workflow.item;
  const bearer = tokens(workflow)[0];
  const weapon = await resolve(state(workflow).weaponUuid);
  if (!bearer || !weapon) return;
  // Same named spell on a weapon never adds a second radiant damage rider.
  for (const old of values(bearer.actor.effects).filter(effect => effectState(effect).kind === "holy-weapon-target"
    && effectState(effect).weaponUuid === weapon.uuid)) {
    await remove(await resolve(effectState(old).sourceUuid) ?? old);
  }
  const source = await startEffect(workflow, {seconds: 3600, unhide: ["holyWeaponDismiss"],
    data: {targetUuid: bearer.uuid, weaponUuid: weapon.uuid}});
  if (!source) return;
  let enchantments = [];
  try {
    enchantments = await utils().itemUtils.enchantItem(weapon, {
      name: item.name, img: item.img, origin: workflow.activity.uuid ?? item.uuid,
      duration: {value: 3600, units: "seconds", expiry: "turnStart", expired: false},
      system: {changes: [{key: "system.properties", value: "mgc", type: "add", priority: 20}]},
      flags: {[MODULE]: {[STATE]: {kind: "holy-weapon-enchantment", itemUuid: item.uuid}}}
    });
    if (!enchantments?.length) throw new Error("Holy Weapon: potenziamento dell'arma non riuscito.");
    await utils().documentUtils.makeDependent(source, enchantments);
    const bright = distanceInScene(30, bearer), dim = distanceInScene(60, bearer);
    const lightChanges = [{key: "ATL.light.bright", value: String(bright), type: "upgrade", priority: 20},
      {key: "ATL.light.dim", value: String(dim), type: "upgrade", priority: 20}];
    const buff = await createEffect(bearer.actor, item, {
      kind: "holy-weapon-target", seconds: 3600, parent: source, groups: ["roll", "effect"],
      data: {weaponUuid: weapon.uuid, sourceUuid: source.uuid, tokenUuid: bearer.uuid},
      changes: globalThis.game.modules?.get?.("ATL")?.active ? lightChanges : []
    });
    if (!globalThis.game.modules?.get?.("ATL")?.active) {
      const before = {bright: Number(bearer.light?.bright ?? 0), dim: Number(bearer.light?.dim ?? 0)};
      const applied = {bright: Math.max(bright, before.bright), dim: Math.max(dim, before.dim)};
      await updateDocumentSafely(buff, {[`flags.${MODULE}.${STATE}.light`]: {before, applied}});
      await updateDocumentSafely(bearer, {"light.bright": applied.bright, "light.dim": applied.dim});
    }
  } catch (error) {
    for (const effect of enchantments ?? []) await remove(effect);
    await remove(source);
    throw error;
  }
}

export async function holyWeaponDamage({document: effect, workflow} = {}) {
  if (!effect || !workflow || effectState(effect).kind !== "holy-weapon-target" || !activeEffect(effect)) return;
  if (workflow.item?.uuid !== effectState(effect).weaponUuid || workflow.activity?.type !== "attack") return;
  if (workflow.activity.attack?.type?.classification && workflow.activity.attack.type.classification !== "weapon") return;
  const local = state(workflow);
  if (local.holyDamage) return;
  local.holyDamage = true;
  await utils().workflowUtils.bonusDamage(workflow, "2d8", {damageType: "radiant"});
}

export async function restoreSpecialLight({document: effect} = {}) {
  const data = effectState(effect);
  if (data.kind !== "holy-weapon-target" || !data.light) return;
  const token = await resolve(data.tokenUuid);
  if (!token) return;
  const updates = {};
  for (const key of ["bright", "dim"]) {
    // A later manual change belongs to the user and must not be overwritten.
    if (Number(token.light?.[key]) === data.light.applied[key]) updates[`light.${key}`] = data.light.before[key];
  }
  if (Object.keys(updates).length) await updateDocumentSafely(token, updates);
}

export async function detonateHolyWeapon(workflow) {
  const item = workflow.item;
  const source = rootEffect(item);
  if (!source) return;
  await locked(`detonate:${source.uuid}`, async () => {
    if (!await resolve(source.uuid)) return;
    const bearer = doc(await resolve(effectState(source).targetUuid));
    const caster = casterToken(workflow);
    if (!bearer || !currentScene(bearer) || !currentScene(caster)) { warn("l'arma sacra non è nella scena corrente."); return; }
    const candidates = values(bearer.parent.tokens).filter(token => token.actor && within(bearer, token, 30) && canSee(caster, token));
    const selected = candidates.length ? await selectTokens(item, "Scegli le creature da colpire entro 30 ft dall'arma. Conferma senza selezioni per terminarla senza bersagli.", candidates, true) : [];
    if (selected === null) return;
    const result = selected.length ? await runActivity(item, "holyWeaponBurst", selected) : null;
    if (selected.length && (!result || result.aborted)) return;
    for (const target of tokens(result, "failedSaves")) {
      // The blindness outlives concentration; do not make it a dependent.
      await createEffect(target.actor, item, {
        kind: "holy-weapon-blind", name: `${item.name} — Accecato`, statuses: ["blinded"], seconds: 60,
        changes: [{key: "flags.midi-qol.OverTime", type: "add", priority: 20,
          value: `turn=end,allowIncapacitated=true,label=Holy Weapon,saveAbility=con,saveDC=${saveDC(item)},saveMagic=true,saveCount=1-`}]
      });
    }
    await remove(source);
    await remove(await resolve(effectState(source).concentrationUuid));
  });
}

export async function healVampiricTouch(workflow) {
  const targets = tokens(workflow, "hitTargets");
  if (targets.length !== 1 || state(workflow).healed) return;
  const amount = Math.floor(damageDealt(workflow, targets[0], "necrotic") / 2);
  const caster = casterToken(workflow);
  if (!amount || !caster?.object) return;
  state(workflow).healed = true;
  // Midi applies healing normally, including effects that block it. No HP
  // overwrite and no intervention in the attack's damage-application hook.
  await globalThis.MidiQOL.applyTokenDamage([{value: amount, type: "healing", properties: new Set(["mgc"])}], amount,
    new Set([caster.object]), workflow.item, new Set(), {forceApply: true, noConcentrationCheck: true});
}

export function chaosDice(workflow) {
  for (const roll of values(workflow?.damageRolls)) {
    const dice = values(roll.dice?.length ? roll.dice : roll.terms).filter(term => Number(term.faces) === 8);
    const results = dice.flatMap(die => values(die.results).filter(result => result.active !== false && !result.discarded).map(result => Number(result.result)));
    if (results.length >= 2) return results.slice(0, 2);
  }
  return [];
}

export async function changeChaosDamage({workflow} = {}) {
  if (!workflow || !["chaosBolt", "chaosBoltBounce"].includes(activityKey(workflow.item, workflow.activity))) return;
  const local = state(workflow);
  if (local.chaos) return;
  const [first, second] = chaosDice(workflow);
  if (!DAMAGE_TYPES[first - 1] || !DAMAGE_TYPES[second - 1]) return;
  const choices = [...new Set([DAMAGE_TYPES[first - 1], DAMAGE_TYPES[second - 1]])];
  const chosen = choices.length === 1 ? choices[0] : await buttons(workflow.item, "Scegli il tipo di danno fra i due d8.",
    choices.map(type => [globalThis.CONFIG?.DND5E?.damageTypes?.[type]?.label ?? type, type]));
  const damageType = choices.includes(chosen) ? chosen : choices[0];
  for (const roll of values(workflow.damageRolls)) roll.options.type = damageType;
  workflow.defaultDamageType = damageType;
  await workflow.setDamageRolls(workflow.damageRolls);
  local.chaos = {bounce: first === second, damageType};
}

export async function bounceChaosBolt(workflow) {
  const local = state(workflow);
  if (!local.chaos?.bounce || local.bounced) return;
  const target = tokens(workflow, "hitTargets")[0];
  if (!target || !currentScene(target)) return;
  local.bounced = true;
  const inherited = workflow.workflowOptions?.khuzoeSpecial ?? {};
  const visited = new Set(inherited.chain?.visited ?? []);
  for (const token of tokens(workflow)) visited.add(token.uuid);
  const candidates = values(target.parent.tokens).filter(token => token.actor && !visited.has(token.uuid) && within(target, token, 30));
  if (!candidates.length) return;
  const next = (await selectTokens(workflow.item, "I d8 sono uguali: scegli il prossimo bersaglio del rimbalzo, oppure annulla.", candidates))?.[0];
  if (!next || visited.has(next.uuid) || !within(target, next, 30)) return;
  await runActivity(workflow.item, "chaosBoltBounce", [next], {
    castLevel: inherited.castLevel ?? level(workflow), chain: {visited: [...visited]}
  });
}

export async function finishSpecialSpell({workflow} = {}) {
  if (!workflow || workflow.aborted) return;
  const key = activityKey(workflow.item, workflow.activity);
  const local = state(workflow);
  if (local.finished) return;
  local.finished = true;
  switch (key) {
    case "mirrorImage": await castMirrorImage(workflow); break;
    case "dragonsBreath": await castDragonBreath(workflow); break;
    case "heatMetal": {
      const source = await startEffect(workflow, {unhide: ["heatMetalPulse"], data: {contacts: tokens(workflow).map(token => ({uuid: token.uuid, contact: true}))}});
      if (source) await pulseHeatMetal(workflow, source);
      break;
    }
    case "heatMetalPulse": await pulseHeatMetal(workflow, rootEffect(workflow.item)); break;
    case "holyWeapon": await castHolyWeapon(workflow); break;
    case "holyWeaponDismiss": await detonateHolyWeapon(workflow); break;
    case "vampiricTouch":
      await startEffect(workflow, {unhide: ["vampiricTouchAttack"]});
      await healVampiricTouch(workflow);
      break;
    case "vampiricTouchAttack": await healVampiricTouch(workflow); break;
    case "chaosBolt": case "chaosBoltBounce": await bounceChaosBolt(workflow); break;
  }
}

export function registerSpecialSpells2014(api) {
  const macros = SPECIAL_SPELL_CATALOG.map(spell => api.registerFnMacro({
    source: MODULE, rules: "2014", identifier: spell.identifier,
    roll: [
      {pass: "itemPreTargeting", macro: prepareSpecialUse, priority: 20},
      {pass: "itemPreambleComplete", macro: prepareSpecialSpell, priority: 20},
      {pass: "itemDamageRoll", macro: changeChaosDamage, priority: 30},
      {pass: "itemRollFinished", macro: finishSpecialSpell, priority: 100}
    ]
  }));
  macros.push(api.registerFnMacro({
    source: MODULE, rules: "2014", identifier: SPECIAL_EFFECT,
    roll: [
      {pass: "targetAttackRollComplete", macro: redirectMirrorAttack, priority: 80},
      {pass: "actorDamageRollBonuses", macro: holyWeaponDamage, priority: 50}
    ],
    effect: [{pass: "deleted", macro: restoreSpecialLight, priority: 50}]
  }));
  return {macros, automations: SPECIAL_SPELL_AUTOMATIONS.map(automation => api.registerAutomation(automation))};
}
