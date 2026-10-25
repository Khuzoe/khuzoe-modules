import {combatCallback} from "./combat-events.mjs";
/** Khuzoe's boundary with CAT. Never changes the source Item or CAT's public API. */
const clone = value => globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value);

export function runnableItemData(item) {
  const data = clone(item.toObject ? item.toObject() : item);
  data.flags ??= {};
  data.flags.dnd5e ??= {};
  data.flags.dnd5e.riders = {...data.flags.dnd5e.riders, activity: []};
  return data;
}

function runnableItem(item) {
  if (!item) return item;
  const create = globalThis.cat?.utils?.itemUtils?.syntheticItem;
  if (create && item.toObject) return create(runnableItemData(item), item.actor);
  if (item.clone) return item.clone({"flags.dnd5e.riders.activity": []}, {keepId: true});
  // Plain documents are used by the isolated test adapters.
  return item;
}

function internalOptions(options = {}) {
  return {
    consumeUsage: false, consumeResources: false, spellSlot: false,
    ...options,
    config: {...options.config, consume: {action: false, ...options.config?.consume}},
    options: {...options.options, workflowOptions: {
      ...options.options?.workflowOptions, khuzoeInternalActivity: true
    }}
  };
}

export function runSyntheticActivityData(data, item, targets = [], options = {}) {
  return globalThis.cat.utils.workflowUtils.syntheticActivityDataRoll(
    clone(data), runnableItem(item), targets, internalOptions(options)
  );
}

export function runSyntheticActivity(activity, targets = [], options = {}) {
  const item = runnableItem(activity?.item);
  const runnable = item?.system?.activities?.get?.(activity.id ?? activity._id) ?? activity;
  return globalThis.cat.utils.workflowUtils.syntheticActivityRoll(runnable, targets, internalOptions(options));
}

export function runCompleteActivity(activity, targets = [], options = {}) {
  const item = runnableItem(activity?.item);
  const runnable = item?.system?.activities?.get?.(activity.id ?? activity._id) ?? activity;
  return globalThis.cat.utils.workflowUtils.completeActivityUse(runnable, targets, internalOptions(options));
}

/** CAT stops a normal modifier chain on any truthy return value. */
export function continueModifiers(callback) {
  return async function khuzoeModifier(...args) { await callback(...args); };
}

export function khuzoeRegistrationApi(api) {
  if (!api) return api;
  const modifierPass = /(?:AttackRollConfig|AttackRollBonuses|AttackRollComplete|DamageRoll|DamageRollBonuses|DamageFlatReductions|DamageBonuses|DamageComplete|RollFinished|OnHit)$/;
  return new Proxy(api, {get(target, property) {
    if (property === "registerFnMacro") return definition => target.registerFnMacro({
      ...definition,
      ...(definition.roll ? {roll: definition.roll.map(trigger => modifierPass.test(trigger.pass)
        ? {...trigger, macro: continueModifiers(trigger.macro)} : trigger)} : {}),
      ...(definition.combat ? {combat: definition.combat.map((trigger, index) => ({
        ...trigger, macro: combatCallback(trigger.macro, definition, trigger, index)
      }))} : {})
    });
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  }});
}
