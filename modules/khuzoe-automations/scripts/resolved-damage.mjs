import {runSyntheticActivityData} from "./activity-compat.mjs";

/** Apply an already resolved share through Midi so target reactions still run. */
export async function applyResolvedDamage(actor, amount, {sourceItem, token, origin, damageType = "force"} = {}) {
  if (!(amount > 0)) return true;
  token ??= cat.utils.actorUtils.getFirstToken(actor);
  token = token?.document ?? token;
  if (!token) throw new Error("Il destinatario del danno deve avere un token nella scena.");
  const activity = {
    _id: "KhzResolvedDmg01", name: sourceItem?.name ?? "Danno trasferito", type: "damage",
    activation: {type: "special", value: null, override: true},
    consumption: {targets: [], spellSlot: false, scaling: {allowed: false}},
    duration: {units: "inst", concentration: false, override: true},
    range: {units: "any", override: true},
    target: {override: true, prompt: false, affects: {count: "1", type: "creature"}, template: {units: "ft"}},
    damage: {critical: {allow: false}, parts: [{number: null, denomination: 0, bonus: "", types: [damageType],
      custom: {enabled: true, formula: String(amount)}, scaling: {mode: "", number: null}}]},
    midiProperties: {automationOnly: true, confirmTargets: "never", ignoreTraits: ["idi", "idr", "idv", "ida", "idm"]}
  };
  const item = cat.utils.itemUtils.syntheticItem({name: activity.name, type: "feat", img: sourceItem?.img,
    system: {identifier: "khuzoe-resolved-damage", activities: {[activity._id]: activity}},
    flags: {"khuzoe-automations": {damageOrigin: origin ?? sourceItem?.uuid}}}, sourceItem?.actor ?? actor);
  const result = await runSyntheticActivityData(activity, item, [token], {
    options: {workflowOptions: {khuzoeDamageTransfer: true}}
  });
  return Boolean(result && !result.aborted);
}
