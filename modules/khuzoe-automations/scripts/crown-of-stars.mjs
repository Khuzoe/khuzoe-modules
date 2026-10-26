import {withDocumentLock} from "./operation-locks.mjs";
import {sceneUnitsPerFoot} from "./geometry.mjs";

const MODULE = "khuzoe-automations";
const IDENTIFIER = "crown-of-stars";
const FLAG = "crownOfStars";
const CAST = "crownOfStars";
const ATTACK = "crownOfStarsMote";
const INTERNAL = {khuzoeCrownOfStars: true};
const finished = new WeakSet();
const values = collection => Array.from(collection?.values?.() ?? collection ?? []);
const state = effect => effect?.flags?.[MODULE]?.[FLAG];
const time = () => Number(game.time.worldTime);
const crowns = actor => values(actor?.effects).filter(effect => state(effect));
const root = item => crowns(item?.actor).find(effect => state(effect).itemUuid === item.uuid);
const managed = item => item?.system?.identifier === IDENTIFIER && item?.flags?.cat?.automation?.source === MODULE;
const moteActivity = item => item?.system?.activities?.get?.(item.flags?.[MODULE]?.activityIdentifiers?.[ATTACK])
  ?? Object.values(item?.system?.activities ?? {}).find(activity => activity.midiProperties?.identifier === ATTACK);
const usesPath = item => `system.activities.${moteActivity(item)?.id ?? moteActivity(item)?._id}.uses`;
const active = effect => effect && !effect.disabled && !effect.isSuppressed && !effect.duration?.expired
  && state(effect).expiresAt > time();
const key = activity => activity?.midiProperties?.identifier;
const lock = (actor, callback) => withDocumentLock(actor, FLAG, callback);
const warn = message => ui.notifications.warn(`Crown of Stars: ${message}`);
const report = error => { console.error("Khuzoe Automations | Crown of Stars", error); ui.notifications.error(`Crown of Stars: ${error.message}`); };
const update = (document, data) => document.update(data, INTERNAL);

export const CROWN_OF_STARS_AUTOMATION = {
  source: MODULE, rules: "2014", type: "spell", identifier: IDENTIFIER, version: "0.28.0",
  uuid: `Compendium.${MODULE}.KhuzoeSpells2014.Item.KhzCrownStars001`,
  notes: "7/9/11 stelle, attacco a distanza come azione bonus, consumo anche su un mancato e luce secondo le stelle rimaste."
};

export function crownMotes(item) {
  const uses = moteActivity(item)?.uses;
  const max = Number(uses?.max) || 0;
  return Math.max(0, max - (Number(uses?.spent) || 0));
}

export function crownLight(motes, units = 1) {
  // Upgrade preserves stronger light from another spell or the token itself.
  return [
    {key: "token.light.bright", value: (motes >= 4 ? 30 : 0) * units, type: "upgrade", priority: 20},
    {key: "token.light.dim", value: (motes >= 4 ? 60 : motes > 0 ? 30 : 0) * units, type: "upgrade", priority: 20}
  ];
}

async function visibility(item, visible) {
  if (!item) return;
  const method = visible ? "unhideActivities" : "rehideActivities";
  await cat.utils.itemUtils[method](item, [ATTACK]);
}

async function clearCounter(item) {
  if (item && crownMotes(item)) await update(item, {[`${usesPath(item)}.spent`]: Number(moteActivity(item).uses.max)});
}

async function end(effect, item) {
  await effect.delete(INTERNAL);
  await clearCounter(item);
  await visibility(item, false);
}

async function sync(item, {endEmpty = false, scene} = {}) {
  const effect = root(item);
  if (!effect) return;
  if (effect.duration?.expired || state(effect).expiresAt <= time()) return end(effect, item);
  const motes = crownMotes(item);
  if (!motes && endEmpty) return end(effect, item);
  const units = scene ? sceneUnitsPerFoot(scene) : state(effect).units;
  const changes = crownLight(motes, units);
  const name = `${item.name} — ${motes} ${motes === 1 ? "stella" : "stelle"}`;
  const patch = {};
  if (name !== effect.name) patch.name = name;
  if (effect.system.changes.length !== changes.length || changes.some((change, i) =>
    Object.entries(change).some(([key, value]) => String(effect.system.changes[i]?.[key]) !== String(value))
  )) patch["system.changes"] = changes;
  if (units !== state(effect).units) patch[`flags.${MODULE}.${FLAG}.units`] = units;
  if (Object.keys(patch).length) await update(effect, patch);
  await visibility(item, Boolean(active(effect) && motes));
}

export async function prepareCrownOfStars({workflow, activity = workflow?.activity} = {}) {
  if (key(activity) !== ATTACK) return;
  const original = activity.item ?? workflow?.item;
  const item = await fromUuid(original.uuid) ?? original;
  if (!active(root(item)) || !crownMotes(item)) {
    warn("non ci sono stelle disponibili. Lancia prima l'incantesimo.");
    return true; // CAT cancels a pre-use event on a truthy result.
  }
  if (workflow && values(workflow.targets).length !== 1) {
    warn("seleziona una sola creatura o un oggetto.");
    return true;
  }
}

export async function castCrownOfStars({workflow} = {}) {
  if (!workflow || workflow.aborted || key(workflow.activity) !== CAST || finished.has(workflow)) return;
  finished.add(workflow);
  const item = await fromUuid(workflow.item.uuid) ?? workflow.item;
  await lock(item.actor, async () => {
    const castLevel = Number(workflow.castData?.castLevel ?? workflow.workflowOptions?.castData?.castLevel
      ?? workflow.activity.flags?.cat?.castData?.castLevel ?? item.system.level);
    const max = 7 + 2 * (Math.max(7, Math.min(9, Number.isFinite(castLevel) ? castLevel : 7)) - 7);
    const scene = (workflow.token?.document ?? workflow.token)?.parent ?? globalThis.canvas?.scene;
    const units = sceneUnitsPerFoot(scene);
    const existing = root(item);
    // A second copy of this spell must not produce a second crown on the caster.
    for (const other of crowns(item.actor)) if (other !== existing) {
      await end(other, await fromUuid(state(other).itemUuid));
    }
    const data = {
      name: `${item.name} — ${max} stelle`, img: item.img, type: "base", origin: workflow.activity.uuid,
      transfer: false, disabled: false, showIcon: 1,
      start: {time: time(), combat: null, combatant: null, initiative: null, round: null, turn: null},
      duration: {value: 3600, units: "seconds", expiry: "turnStart", expired: false},
      system: {changes: crownLight(max, units)},
      flags: {
        [MODULE]: {[FLAG]: {itemUuid: item.uuid, expiresAt: time() + 3600, units}},
        cat: {identifier: IDENTIFIER, noAnimation: true},
        dae: {stackable: "multi", expiryMode: "delete", specialDuration: []}
      }
    };
    // Reuse the effect so a delayed deletion handler cannot hide the new crown.
    if (existing) await update(existing, data);
    else await item.actor.createEmbeddedDocuments("ActiveEffect", [data], INTERNAL);
    const path = usesPath(item);
    await update(item, {[`${path}.max`]: String(max), [`${path}.spent`]: 0, [`${path}.recovery`]: []});
    await visibility(item, true);
  });
}

export async function finishCrownMote({workflow} = {}) {
  if (!workflow || key(workflow.activity) !== ATTACK) return;
  // Native activity consumption spends exactly one use, independently of hits.
  // Delay final deletion until a roll exists: Midi can refund a rejected use
  // after its chat card was created, including the final available star.
  const rolled = Boolean(workflow.attackRoll || workflow.attackRolls?.length);
  const item = await fromUuid(workflow.item.uuid) ?? workflow.item;
  await lock(item.actor, () => sync(item, {endEmpty: rolled}));
}

export async function crownItemUpdated(item, changes, options, userId) {
  if (userId !== game.user.id || options?.khuzoeCrownOfStars || !managed(item) || !item.actor) return;
  const path = usesPath(item);
  if (!foundry.utils.hasProperty(changes, path)
    && !Object.keys(changes).some(key => key.startsWith(`${path}.`))) return;
  // Resource updates and native refunds both refresh the name and light.
  await lock(item.actor, () => sync(item));
}

export async function crownEffectDeleted(effect, options, userId) {
  if (!state(effect) || options?.khuzoeCrownOfStars || userId !== game.user.id) return;
  await lock(effect.parent, async () => {
    const item = await fromUuid(state(effect).itemUuid);
    if (!item || root(item)) return;
    await clearCounter(item);
    await visibility(item, false);
  });
}

export async function crownEffectUpdated(effect, changes, options, userId) {
  if (!state(effect) || options?.khuzoeCrownOfStars || userId !== game.user.id) return;
  await lock(effect.parent, async () => {
    const item = await fromUuid(state(effect).itemUuid);
    if (item) await sync(item);
  });
}

export async function reconcileCrowns(scene) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const actors = new Set([...values(game.actors), ...values(scene?.tokens).map(token => token.actor)].filter(Boolean));
  for (const actor of actors) for (const effect of crowns(actor)) {
    await lock(actor, async () => {
      const item = await fromUuid(state(effect).itemUuid);
      if (!item) { await effect.delete(INTERNAL); return; }
      const onScene = values(scene?.tokens).some(token => token.actor === actor);
      await sync(item, {scene: onScene ? scene : undefined});
    });
  }
}

export function registerCrownOfStars(api) {
  return {automations: [api.registerAutomation(CROWN_OF_STARS_AUTOMATION)], macros: [api.registerFnMacro({
    source: MODULE, rules: "2014", identifier: IDENTIFIER,
    roll: [
      {pass: "itemPreTargeting", macro: prepareCrownOfStars, priority: 10},
      {pass: "itemPreItemRoll", macro: prepareCrownOfStars, priority: 10},
      {pass: "itemAttackRollComplete", macro: finishCrownMote, priority: 100},
      {pass: "itemRollFinished", macro: castCrownOfStars, priority: 100},
      {pass: "itemRollFinished", macro: finishCrownMote, priority: 101}
    ]
  })]};
}

Hooks.on("updateItem", (...args) => { void crownItemUpdated(...args).catch(report); });
Hooks.on("deleteActiveEffect", (...args) => { void crownEffectDeleted(...args).catch(report); });
Hooks.on("updateActiveEffect", (...args) => { void crownEffectUpdated(...args).catch(report); });
Hooks.on("deleteItem", (item, options, userId) => {
  if (!managed(item) || !item.actor || userId !== game.user.id) return;
  void lock(item.actor, async () => { const effect = root(item); if (effect) await effect.delete(INTERNAL); }).catch(report);
});
Hooks.once("ready", () => { void reconcileCrowns(globalThis.canvas?.scene).catch(report); });
Hooks.on("canvasReady", canvas => { void reconcileCrowns(canvas.scene).catch(report); });
Hooks.on("updateWorldTime", () => { void reconcileCrowns(globalThis.canvas?.scene).catch(report); });
