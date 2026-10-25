import {runSyntheticActivityData} from "./activity-compat.mjs";

/** An independent healing workflow avoids re-running the source attack's macros. */
export async function healActor(actor, formula, {sourceItem, token, name = sourceItem?.name ?? "Guarigione", maximizeFormula} = {}) {
  if (!actor) return 0;
  const before = Number(actor.system?.attributes?.hp?.value ?? 0);
  const maxFlag = actor.flags?.["midi-qol"]?.grants?.max?.damage?.heal;
  const beacon = Array.from(actor.effects ?? []).some(effect => !effect.disabled && !effect.isSuppressed && effect.flags?.["khuzoe-automations"]?.expandedSpell?.identifier === "beacon-of-hope");
  if (maximizeFormula && (maxFlag === true || maxFlag === 1 || maxFlag === "1" || beacon)) {
    formula = Number((await new Roll(maximizeFormula).evaluate({maximize: true})).total);
  }
  token ??= cat.utils.actorUtils.getFirstToken(actor);
  token = token?.document ?? token;
  const create = cat.utils.itemUtils?.syntheticItem;
  if (!token || !create) {
    // Off-canvas fallback still uses D&D5e's healing immunity and modifiers.
    const roll = await new Roll(String(formula), sourceItem?.actor?.getRollData?.() ?? {}).evaluate();
    await actor.applyDamage([{type: "healing", value: Number(roll.total)}]);
  } else {
    const data = {
      _id: "KhzHealingAction", name, type: "heal",
      activation: {type: "special", value: null, override: true},
      consumption: {targets: [], spellSlot: false, scaling: {allowed: false}},
      duration: {units: "inst", concentration: false, override: true},
      range: {units: "any", override: true},
      target: {override: true, prompt: false, affects: {count: "1", type: "creature"}, template: {units: "ft"}},
      healing: {number: null, denomination: 0, bonus: "", types: ["healing"],
        custom: {enabled: true, formula: String(formula)}, scaling: {mode: "", number: null}},
      midiProperties: {automationOnly: true, confirmTargets: "never", magicEffect: true}
    };
    const item = create({name, type: "feat", img: sourceItem?.img,
      system: {identifier: "khuzoe-healing", activities: {[data._id]: data}},
      flags: {"khuzoe-automations": {healingSource: sourceItem?.uuid}}}, sourceItem?.actor ?? actor);
    const workflow = await runSyntheticActivityData(data, item, [token]);
    if (!workflow || workflow.aborted) throw new Error(`${name}: guarigione annullata.`);
  }
  return Math.max(0, Number(actor.system.attributes.hp.value) - before);
}
