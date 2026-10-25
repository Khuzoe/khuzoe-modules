const values = collection => Array.from(collection?.contents ?? ((collection instanceof Map || collection instanceof Set) ? collection.values() : Array.isArray(collection) ? collection : Object.values(collection ?? {})));

/** Add cantrip dice to the weapon attack itself so criticals and reactions see one hit. */
export async function weaponCantripAttack(workflow, spell, {dice = 0, damageType} = {}) {
  const actor = spell.actor ?? workflow.actor;
  const targets = values(workflow.targets);
  if (targets.length !== 1) return null;
  const weapons = values(actor.items).filter(item => item.type === "weapon" && item.system?.equipped
    && values(item.system.activities).some(activity => activity.type === "attack" && activity.attack?.type?.value === "melee"));
  if (!weapons.length) {
    globalThis.ui?.notifications?.warn?.(`${spell.name}: equipaggia un'arma con un attacco in mischia.`);
    return null;
  }
  const weapon = weapons.length === 1 ? weapons[0] : await cat.utils.dialogUtils.selectDocumentDialog(
    spell.name, "Scegli l'arma per l'attacco.", weapons,
    {userId: cat.utils.queryUtils?.firstOwner?.(actor, true) ?? game.user.id}
  );
  if (!weapon) return null;
  const data = weapon.toObject();
  delete data._id;
  data.flags ??= {};
  data.flags["khuzoe-automations"] = {...data.flags["khuzoe-automations"], weaponCantrip: spell.system.identifier};
  const attacks = values(data.system.activities).filter(activity => activity.type === "attack" && activity.attack?.type?.value === "melee");
  data.system.activities = Object.fromEntries(attacks.map(activity => [activity._id, activity]));
  for (const attack of attacks) {
    attack.consumption = {targets: [], spellSlot: false, scaling: {allowed: false}};
    if (dice > 0) {
      attack.damage.parts ??= [];
      attack.damage.parts.push({number: dice, denomination: 8, bonus: "", types: [damageType],
        custom: {enabled: false, formula: ""}, scaling: {mode: "", number: null, formula: ""}});
    }
  }
  return cat.utils.workflowUtils.syntheticItemDataRoll(data, actor, targets, {
    consumeUsage: false, consumeResources: false, spellSlot: false,
    config: {consume: {action: false}},
    options: {workflowOptions: {targetConfirmation: "none", autoRollAttack: true, autoRollDamage: "always", khuzoeWeaponCantrip: true}}
  });
}
