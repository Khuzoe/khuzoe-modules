import {RELEASE_VERSION} from "./release.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {removeOwnedTemporaryHP} from "./temporary-hp.mjs";

const MODULE = "khuzoe-automations";
const MODEL_EFFECT = "khuzoe-armorer-model";
const MARK = "khuzoe-thunder-gauntlets-mark";
const values = collection => Array.from(collection?.contents ?? collection?.values?.() ?? (Array.isArray(collection) ? collection : Object.values(collection ?? {})));
const slug = text => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const automated = item => item?.flags?.cat?.automation?.source === MODULE && !item.isSuppressed && !item.disabled;
const feature = (actor, identifier) => values(actor?.items).find(item => item.type === "feat" && item.system?.identifier === identifier && automated(item));
const state = actor => actor?.flags?.[MODULE]?.armorer ?? {};
const userId = actor => cat.utils.queryUtils?.firstOwner?.(actor, true) ?? game.user.id;
const inform = message => globalThis.ui?.notifications?.warn?.(message);
const randomId = () => globalThis.crypto.randomUUID();
export const ARMORER_IDS = Object.freeze({armor: "arcane-armor", model: "armor-model", gauntlets: "thunder-gauntlets",
  field: "defensive-field", launcher: "lightning-launcher", steps: "powered-steps", dampening: "dampening-field"});
const definitions = [
  ["armor", "KhzArcaneArmor01", "Arcane Armor", "Associa un'armatura indossata; i benefici del modello richiedono quell'armatura. La rimozione fa perdere i PF temporanei del Defensive Field."],
  ["model", "KhzArmorModel001", "Armor Model", "Scelta Guardian/Infiltrator dopo un riposo, con strumenti da fabbro; selezione Intelligenza o caratteristica ordinaria per le armi dell'armatura."],
  ["gauntlets", "KhzThunderGaunt1", "Thunder Gauntlets", "1d8 tuono. Chi viene colpito ha svantaggio contro altre creature fino all'inizio del prossimo turno dell'Armorer."],
  ["field", "KhzDefensField01", "Defensive Field", "Azione bonus: sostituisce i PF temporanei con il livello da artefice. Usi pari alla competenza, recuperati al riposo lungo."],
  ["launcher", "KhzLightLaunch01", "Lightning Launcher", "1d6 fulmine, gittata 90/300 piedi; propone 1d6 extra dopo un colpo a segno una volta in ciascun proprio turno."],
  ["steps", "KhzPoweredSteps1", "Powered Steps", "+5 piedi alla velocità sul terreno soltanto con Infiltrator indossato."],
  ["dampening", "KhzDampenField01", "Dampening Field", "Vantaggio a Furtività soltanto con Infiltrator indossato; cancella normalmente lo svantaggio dell'armatura."]
];
export const ARMORER_AUTOMATIONS = definitions.map(([key, id, name, notes]) => ({source: MODULE, type: "feat", key, identifier: ARMORER_IDS[key], name, notes,
  rules: "2014", version: RELEASE_VERSION, uuid: `Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.${id}`}));
for (const [key, id] of [["gauntlets", "KhzThunderWeap01"], ["launcher", "KhzLaunchWeap001"]]) {
  const base = ARMORER_AUTOMATIONS.find(entry => entry.key === key);
  ARMORER_AUTOMATIONS.push({...base, type: "weapon", uuid: `Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.${id}`});
}
export function getArmorerAutomation(item) {
  let identifier = item?.system?.identifier, rules = item?.system?.source?.rules;
  // This one audited import is tagged 2024 but has the complete 2014 rule text.
  // Never convert arbitrary 2024 class features or generic unidentified Items.
  if (item?.type === "feat" && !identifier && slug(item.name) === "defensive-field") {
    const text = String(item.system?.description?.value ?? "").replace(/<[^>]*>/g, " ");
    if (/temporary hit points equal to your level in this class/i.test(text) && /proficiency bonus/i.test(text) && /long rest/i.test(text)) {
      identifier = ARMORER_IDS.field; rules = "2014";
    }
  }
  return ARMORER_AUTOMATIONS.find(entry => entry.type === item?.type && entry.identifier === identifier && entry.rules === rules) ?? null;
}
export async function applyArmorerAlias(item, automation, apply) {
  if (!ARMORER_AUTOMATIONS.includes(automation)) return apply();
  const old = {"system.identifier": item.system.identifier ?? "", "system.source.rules": item.system.source?.rules ?? "2024"};
  if (old["system.identifier"] === automation.identifier && old["system.source.rules"] === automation.rules) return apply();
  await updateDocumentSafely(item, {"system.identifier": automation.identifier, "system.source.rules": automation.rules});
  try {
    const result = await apply();
    if (item.flags?.cat?.automation?.source !== MODULE || item.flags.cat.automation.version !== automation.version) throw new Error("Armorer: CAT non ha applicato l'automazione.");
    return result;
  } catch (error) { await updateDocumentSafely(item, old); throw error; }
}
export function prepareArmorerUpdate(item, changes) {
  if (changes.flags?.cat?.automation?.source !== MODULE || !Object.values(ARMORER_IDS).includes(changes.system?.identifier ?? item.system?.identifier)) return;
  if (item.img) changes.img = item.img;
  changes.flags[MODULE] = {...changes.flags[MODULE], ...(item.flags?.[MODULE] ?? {})};
  if ((changes.system.identifier ?? item.system.identifier) === ARMORER_IDS.field) {
    changes.system.uses = {max: "@prof", spent: Number(item.system?.uses?.spent ?? 0), recovery: [{period: "lr", type: "recoverAll"}]};
  }
  if (item.type === "weapon") {
    const source = item.toObject?.().system ?? item.system;
    const previousFlags = structuredClone(item.toObject?.().flags ?? item.flags ?? {});
    delete previousFlags["chris-premades"];
    delete previousFlags.cat;
    changes.flags = {...previousFlags, ...changes.flags, dnd5e: {...previousFlags.dnd5e, ...changes.flags.dnd5e}};
    const retained = values(item.effects).filter(effect => !effect.flags?.[MODULE]?.armorerFeature)
      .map(effect => effect.toObject?.() ?? structuredClone(effect));
    changes.effects = [...retained, ...(changes.effects ?? []).filter(effect => !retained.some(old => old._id === effect._id))];
    // Keep infusions, magic bonuses, custom base damage and physical item data.
    for (const key of ["damage", "magicalBonus", "properties", "quantity", "weight", "price", "container", "proficient", "attunement", "attuned"]) {
      if (source[key] !== undefined) changes.system[key] = structuredClone(source[key]);
    }
  }
}
export function artificerLevel(actor) {
  return Number(actor?.classes?.artificer?.system?.levels ?? values(actor?.items)
    .find(item => item.type === "class" && ["artificer", "artefice"].includes(item.system?.identifier))?.system?.levels ?? 0);
}
export function boundArmor(actor) {
  const data = state(actor);
  return values(actor?.items).find(item => item.uuid === data.armorUuid && item.type === "equipment");
}
export function activeArmorModel(actor) {
  const data = state(actor), armor = boundArmor(actor);
  if (!feature(actor, ARMORER_IDS.armor) || !feature(actor, ARMORER_IDS.model) || !armor?.system?.equipped
    || values(actor?.statuses).includes("dead")) return null;
  return ["guardian", "infiltrator"].includes(data.model) ? data.model : null;
}
function combatFor(actor) {
  return [globalThis.game?.combat, ...values(globalThis.game?.combats)]
    .find(combat => combat?.started && values(combat.combatants).some(c => c.actor?.uuid === actor?.uuid));
}
export function launcherTurn(actor) {
  const combat = combatFor(actor);
  if (!combat) return `world:${Math.floor(Number(game.time?.worldTime ?? 0) / 6)}`;
  if (combat.combatant?.actor?.uuid !== actor.uuid) return null;
  return `${combat.id}:${combat.round}:${combat.turn}`;
}
const canonicalField = actor => values(actor?.items).filter(item => item.type === "feat" && item.system?.identifier === ARMORER_IDS.field && automated(item));
const fieldSpent = actor => Math.max(0, ...canonicalField(actor).map(item => Number(item.system?.uses?.spent ?? 0)));
/** D&D5e's activity RangeField has no persisted long range for a feat.
 * Supply derived data just as a weapon activity inherits it from its Item. */
export function prepareArmorerActivity(activity) {
  const item = activity?.item;
  if (!automated(item) || item.type !== "feat" || item.system?.identifier !== ARMORER_IDS.launcher || activity.type !== "attack") return;
  activity.range.long = 300;
}
function armorChoices(actor) {
  return values(actor?.items).filter(item => item.type === "equipment" && item.system?.equipped
    && ["light", "medium", "heavy"].includes(item.system?.type?.value ?? item.system?.armor?.type));
}
async function chooseModel(actor) {
  return cat.utils.dialogUtils.buttonDialog("Armor Model", "<p>Scegli il modello dell'armatura. Devi avere a disposizione gli strumenti da fabbro.</p>",
    [["Guardian", "guardian"], ["Infiltrator", "infiltrator"], ["Annulla", false]], {userId: userId(actor)});
}
async function chooseAbility(actor) {
  return cat.utils.dialogUtils.buttonDialog("Armi dell'armatura", "<p>Quale caratteristica vuoi usare per colpire e per i danni delle armi dell'armatura?</p>",
    [["Intelligenza", "int"], ["Forza / Destrezza", "ordinary"], ["Annulla", false]], {userId: userId(actor)});
}
export async function prepareArmorerUse({workflow, document} = {}) {
  const item = workflow?.item ?? document, actor = workflow?.actor ?? item?.actor;
  if (!item || !actor || workflow?.aborted) return;
  const id = item.system?.identifier;
  if (id === ARMORER_IDS.armor) {
    const choices = armorChoices(actor);
    if (!choices.length) { inform("Arcane Armor: indossa prima un'armatura."); return true; }
    const armorUuid = await cat.utils.dialogUtils.buttonDialog("Arcane Armor", "<p>Scegli l'armatura indossata da trasformare usando gli strumenti da fabbro.</p>",
      [...choices.map(armor => [armor.name, armor.uuid]), ["Annulla", false]], {userId: userId(actor)});
    if (!armorUuid) return true;
    const model = state(actor).model ?? await chooseModel(actor);
    const ability = state(actor).ability ?? await chooseAbility(actor);
    if (!model || !ability) return true;
    workflow.khuzoeArmorerChoice = {action: "bind", armorUuid, model, ability};
  } else if (id === ARMORER_IDS.model) {
    if (!boundArmor(actor)?.system?.equipped) { inform("Armor Model: usa prima Arcane Armor sull'armatura indossata."); return true; }
    if (state(actor).model && !state(actor).restAvailable) { inform("Armor Model: puoi cambiare modello dopo un riposo breve o lungo."); return true; }
    const model = await chooseModel(actor);
    if (!model) return true;
    const ability = await chooseAbility(actor);
    if (!ability) return true;
    workflow.khuzoeArmorerChoice = {action: "model", model, ability};
  } else if ([ARMORER_IDS.field, ARMORER_IDS.gauntlets, ARMORER_IDS.launcher].includes(id)) {
    const required = id === ARMORER_IDS.launcher ? "infiltrator" : "guardian";
    if (activeArmorModel(actor) !== required) { inform(`${item.name}: richiede il modello ${required === "guardian" ? "Guardian" : "Infiltrator"} indossato.`); return true; }
    if (id === ARMORER_IDS.field && fieldSpent(actor) >= Number(actor.system?.attributes?.prof ?? 0)) {
      inform("Defensive Field: non rimangono usi prima del prossimo riposo lungo."); return true;
    }
    if (id === ARMORER_IDS.field && Number(actor.system?.attributes?.hp?.temp ?? 0) >= artificerLevel(actor)) {
      const yes = await cat.utils.dialogUtils.buttonDialog("Defensive Field", `<p>Sostituire i ${Number(actor.system.attributes.hp.temp)} PF temporanei attuali con ${artificerLevel(actor)} PF temporanei, consumando un uso?</p>`,
        [["Sostituisci", true], ["Annulla", false]], {userId: userId(actor)});
      if (!yes) return true;
    }
    if (workflow.activity?.type === "attack") {
      if (values(workflow.targets).length > 1) { inform(`${item.name}: scegli un solo bersaglio per questo attacco.`); return true; }
      const activity = workflow.activity.toObject?.() ?? structuredClone(workflow.activity);
      activity.attack.ability = state(actor).ability === "ordinary" ? (id === ARMORER_IDS.gauntlets ? "str" : "dex") : "int";
      cat.utils.workflowUtils.setActivity(workflow, activity);
    }
  }
}

let socket;
function setupSocket() {
  if (socket || !globalThis.socketlib) return;
  socket = socketlib.registerModule(MODULE);
  socket.register("khuzoeArmorer", executeArmorerCommand);
}
async function command(actor, data) {
  setupSocket();
  const gm = cat.utils.queryUtils?.gmUser?.() ?? game.users?.activeGM;
  const payload = {...data, actorUuid: actor.uuid};
  if (gm?.id && gm.id !== game.user.id) {
    if (!socket) throw new Error("Armorer: collegamento al GM non disponibile.");
    return socket.executeAsUser("khuzoeArmorer", gm.id, payload);
  }
  return executeArmorerCommand(payload);
}
export async function executeArmorerCommand({actorUuid, action, ...data}) {
  const actor = await fromUuid(actorUuid);
  if (!actor) return;
  return withDocumentLock(actor, "armorer", async () => {
    const previous = state(actor);
    if (action === "bind" || action === "model") {
      if (!feature(actor, ARMORER_IDS.armor) || !feature(actor, ARMORER_IDS.model)) return false;
      if (!["guardian", "infiltrator"].includes(data.model) || !["int", "ordinary"].includes(data.ability)) return false;
      const armor = action === "bind" ? armorChoices(actor).find(item => item.uuid === data.armorUuid) : boundArmor(actor);
      if (!armor?.system?.equipped) return false;
      if (action === "model" && previous.model && !previous.restAvailable) return false;
      if (action === "bind" && previous.model && (data.model !== previous.model || data.ability !== previous.ability)) return false;
      if (previous.armorUuid && previous.armorUuid !== armor.uuid) await clearDefensiveHP(actor);
      await actor.update({[`flags.${MODULE}.armorer`]: {...previous, armorUuid: armor.uuid, model: data.model, ability: data.ability, restAvailable: false}});
      await reconcileArmorer(actor);
      return true;
    }
    if (action === "rest") {
      if (feature(actor, ARMORER_IDS.model)) await actor.update({[`flags.${MODULE}.armorer.restAvailable`]: true});
      return true;
    }
    if (action === "closeRest") {
      if (previous.restAvailable) await actor.update({[`flags.${MODULE}.armorer.restAvailable`]: false});
      return true;
    }
    if (action === "field") {
      if (activeArmorModel(actor) !== "guardian" || !(artificerLevel(actor) > 0)) return false;
      const items = canonicalField(actor), spent = fieldSpent(actor);
      if (!items.length || spent >= Number(actor.system.attributes.prof) || (previous.fieldUses ?? []).includes(data.id)) return false;
      const uses = items.map(item => Number(item.system.uses.spent ?? 0));
      const updated = [];
      try {
        for (const item of items) { await item.update({"system.uses.spent": spent + 1}); updated.push(item); }
        const applied = await actor.update({"system.attributes.hp.temp": artificerLevel(actor), [`flags.${MODULE}.temporaryHPSource`]: items[0].uuid,
          [`flags.${MODULE}.armorer.fieldUses`]: [...(previous.fieldUses ?? []), data.id].slice(-64)});
        if (!applied) throw new Error("Defensive Field: applicazione dei PF temporanei annullata.");
      } catch (error) {
        for (const item of updated) await item.update({"system.uses.spent": uses[items.indexOf(item)]});
        throw error;
      }
      return true;
    }
    if (action === "launcherReserve") {
      const turn = launcherTurn(actor);
      if (activeArmorModel(actor) !== "infiltrator" || !turn || previous.launcher?.turn === turn || data.turn !== turn) return false;
      await actor.update({[`flags.${MODULE}.armorer.launcher`]: {turn, id: data.id}});
      return true;
    }
    if (action === "launcherRefund" && previous.launcher?.id === data.id) {
      await actor.update({[`flags.${MODULE}.armorer.launcher`]: null});
      return true;
    }
  });
}
export async function finishArmorerUse({workflow} = {}) {
  if (!workflow || workflow.aborted || workflow.khuzoeArmorerFinished) return;
  workflow.khuzoeArmorerFinished = true;
  if (workflow.khuzoeArmorerChoice) {
    const applied = await command(workflow.actor, workflow.khuzoeArmorerChoice);
    if (!applied) inform("Armorer: la configurazione è cambiata; ripeti la scelta.");
  } else if (workflow.item?.system?.identifier === ARMORER_IDS.field) {
    await command(workflow.actor, {action: "field", id: workflow.id ?? workflow.uuid ?? randomId()});
  }
}
export async function launcherBonus({workflow} = {}) {
  const actor = workflow?.actor;
  if (!actor || workflow.aborted || workflow.khuzoeLauncherAsked || !workflow.attackRoll || !values(workflow.hitTargets).length
    || activeArmorModel(actor) !== "infiltrator" || !launcherTurn(actor) || state(actor).launcher?.turn === launcherTurn(actor)) return;
  workflow.khuzoeLauncherAsked = true;
  const accepted = await cat.utils.dialogUtils.buttonDialog("Lightning Launcher", "<p>Aggiungere 1d6 da fulmine a questo colpo? Una volta in ciascun tuo turno.</p>",
    [["Aggiungi 1d6", true], ["Non ora", false]], {userId: userId(actor)});
  if (!accepted) return;
  const id = workflow.id ?? workflow.uuid ?? randomId();
  if (!await command(actor, {action: "launcherReserve", id, turn: launcherTurn(actor)})) return;
  try { await cat.utils.workflowUtils.bonusDamage(workflow, "1d6", {damageType: "lightning"}); }
  catch (error) { await command(actor, {action: "launcherRefund", id}); throw error; }
}
export function gauntletExpiry(actor) {
  const combat = combatFor(actor), combatant = values(combat?.combatants).find(c => c.actor?.uuid === actor.uuid);
  return {duration: {value: combatant ? 1 : 6, units: combatant ? "turns" : "seconds", expiry: "turnStart", expired: false},
    ...(combatant ? {start: {combat: combat.id, combatant: combatant.id, round: combat.round, turn: combat.turn, initiative: combatant.initiative}} : {})};
}
export async function gauntletsHit({workflow} = {}) {
  const actor = workflow?.actor;
  if (!actor || workflow.aborted || workflow.khuzoeGauntletsMarked || !workflow.attackRoll || activeArmorModel(actor) !== "guardian") return;
  workflow.khuzoeGauntletsMarked = true;
  const seen = new Set();
  for (const token of values(workflow.hitTargets)) {
    const target = token.actor;
    if (!target || seen.has(target.uuid)) continue;
    seen.add(target.uuid);
    const existing = values(target.effects).find(effect => effect.flags?.cat?.identifier === MARK && effect.flags?.[MODULE]?.gauntletSource === actor.uuid);
    const effect = {name: `Thunder Gauntlets (${actor.name})`, img: workflow.item.img, origin: workflow.item.uuid, type: "base", transfer: false,
      showIcon: 1, system: {changes: []}, ...gauntletExpiry(actor),
      flags: {cat: {identifier: MARK, macros: {roll: [{source: MODULE, rules: "2014", identifier: MARK}]}},
        dae: {specialDuration: [], expiryMode: "delete"}, [MODULE]: {gauntletSource: actor.uuid}}};
    if (existing) await updateDocumentSafely(existing, effect);
    else await cat.utils.effectUtils.createEffects(target, [effect], {rules: "2014"});
  }
}
export function gauntletDisadvantage({workflow, document} = {}) {
  if (!workflow?.activity?.attack || document?.disabled || document?.duration?.expired) return;
  const source = document?.flags?.[MODULE]?.gauntletSource;
  const targets = values(workflow.targets);
  if (source && targets.some(token => token.actor?.uuid !== source)) workflow.disadvantage = true;
}
export function checkGauntletTargets({workflow, document} = {}) {
  if (!workflow?.activity?.attack || document?.disabled || document?.duration?.expired) return;
  const source = document?.flags?.[MODULE]?.gauntletSource, targets = values(workflow.targets);
  if (source && targets.some(token => token.actor?.uuid === source) && targets.some(token => token.actor?.uuid !== source)) {
    inform("Thunder Gauntlets: effettua separatamente gli attacchi contro l'Armorer e le altre creature, perché hanno condizioni di svantaggio diverse.");
    return true;
  }
}
export function dampeningStealth({document, actor, options, skillId, config} = {}) {
  actor ??= document?.actor;
  if ((skillId ?? config?.skill) === "ste" && activeArmorModel(actor) === "infiltrator" && options) options.advantage = true;
}
async function clearDefensiveHP(actor) {
  const source = actor.flags?.[MODULE]?.temporaryHPSource;
  if (!source) return;
  const item = values(actor.items).find(item => item.uuid === source && item.system?.identifier === ARMORER_IDS.field);
  if (item) await removeOwnedTemporaryHP(actor, item);
}
export async function reconcileArmorer(actor) {
  if (!actor?.uuid || !state(actor).armorUuid) return;
  return withDocumentLock(actor, "armorer-effects", async () => {
    const model = activeArmorModel(actor);
    const effects = values(actor.effects).filter(effect => effect.flags?.cat?.identifier === MODEL_EFFECT);
    if (!model) {
      for (const effect of effects) await cat.utils.documentUtils.deleteDocument(effect);
      await clearDefensiveHP(actor);
      if (values(actor.statuses).includes("dead")) await actor.update({[`flags.${MODULE}.armorer.armorUuid`]: null});
      return;
    }
    const otherSteps = values(actor.items).some(item => item.system?.identifier === ARMORER_IDS.steps && !automated(item)
      && values(item.effects).some(effect => !effect.disabled && !effect.isSuppressed && effect.transfer
        && (effect.system?.changes ?? []).some(change => change.key === "system.attributes.movement.walk" && Number(change.value) === 5)));
    const changes = model === "infiltrator" && !otherSteps ? [{key: "system.attributes.movement.walk", type: "add", value: "5", priority: 20}] : [];
    const origin = feature(actor, ARMORER_IDS.model);
    const name = `Arcane Armor — ${model === "guardian" ? "Guardian" : "Infiltrator"}`;
    if (effects[0]) {
      if (effects[0].name !== name || JSON.stringify(effects[0].system?.changes) !== JSON.stringify(changes)) {
        await updateDocumentSafely(effects[0], {name, "system.changes": changes});
      }
      for (const duplicate of effects.slice(1)) await cat.utils.documentUtils.deleteDocument(duplicate);
    } else await cat.utils.effectUtils.createEffects(actor, [{name, img: origin.img, origin: origin.uuid, type: "base", transfer: false,
      showIcon: 1, duration: {units: "seconds", value: null}, system: {changes}, flags: {cat: {identifier: MODEL_EFFECT}}}], {rules: "2014"});
  });
}
let hooksInstalled = false;
export function registerArmorerHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  setupSocket();
  if (globalThis.libWrapper) libWrapper.register(MODULE, "CONFIG.DND5E.activityTypes.attack.documentClass.prototype.prepareFinalData", function(wrapped, ...args) {
    const result = wrapped(...args);
    prepareArmorerActivity(this);
    return result;
  }, "WRAPPER");
  // Actors prepared before ready need only this derived range; no document update.
  for (const actor of values(game.actors)) for (const item of values(actor.items)) {
    if (automated(item) && item.system?.identifier === ARMORER_IDS.launcher) for (const activity of values(item.system.activities)) prepareArmorerActivity(activity);
  }
  const authority = () => game.user?.id === (cat.utils.queryUtils?.gmUser?.() ?? game.users?.activeGM)?.id || (game.user?.isGM && !game.users?.activeGM);
  Hooks.on("dnd5e.restCompleted", (actor, result, config) => {
    if (actor.isOwner && ["long", "short"].includes(config?.type ?? result?.type)) void command(actor, {action: "rest"});
  });
  Hooks.on("midi-qol.RollComplete", workflow => {
    if (!workflow?.aborted && state(workflow?.actor).restAvailable && ![ARMORER_IDS.armor, ARMORER_IDS.model].includes(workflow.item?.system?.identifier)) {
      void command(workflow.actor, {action: "closeRest"});
    }
  });
  for (const hook of ["updateItem", "deleteItem", "createItem"]) Hooks.on(hook, item => {
    if (authority() && item.actor && (item.uuid === state(item.actor).armorUuid || Object.values(ARMORER_IDS).includes(item.system?.identifier))) void reconcileArmorer(item.actor);
  });
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) Hooks.on(hook, effect => {
    if (authority() && effect.parent?.documentName === "Actor" && values(effect.statuses).includes("dead")) void reconcileArmorer(effect.parent);
  });
  if (authority()) for (const actor of values(game.actors)) if (state(actor).armorUuid) void reconcileArmorer(actor);
}
export function registerArmorer(api) {
  const macros = [];
  const add = (identifier, events) => macros.push(api.registerFnMacro({source: MODULE, rules: "2014", identifier, ...events}));
  for (const identifier of [ARMORER_IDS.armor, ARMORER_IDS.model, ARMORER_IDS.field]) add(identifier, {
    roll: [{pass: "itemPreItemRoll", macro: prepareArmorerUse, priority: 10}, {pass: "itemRollFinished", macro: finishArmorerUse, priority: 50}],
    ...(identifier === ARMORER_IDS.model ? {skill: [{pass: "actorSituational", macro: dampeningStealth, priority: 50}]} : {})
  });
  add(ARMORER_IDS.gauntlets, {roll: [{pass: "itemPreItemRoll", macro: prepareArmorerUse, priority: 10}, {pass: "itemAttackRollComplete", macro: gauntletsHit, priority: 70}]});
  add(ARMORER_IDS.launcher, {roll: [{pass: "itemPreItemRoll", macro: prepareArmorerUse, priority: 10}, {pass: "itemDamageRollBonuses", macro: launcherBonus, priority: 60}]});
  add(MARK, {roll: [{pass: "actorPreItemRoll", macro: checkGauntletTargets, priority: 10}, {pass: "actorAttackRollConfig", macro: gauntletDisadvantage, priority: 100}]});
  return {macros, automations: ARMORER_AUTOMATIONS.map(({key, ...data}) => api.registerAutomation(data))};
}
