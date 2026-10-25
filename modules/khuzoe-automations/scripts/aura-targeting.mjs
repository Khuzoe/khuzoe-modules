/** Merchant map objects use NPC proxy Actors. Check their explicit markers,
 * never NPC/construct types or merchant ownership. Read persisted flags directly
 * so this also works with Merchant inactive and without a hard dependency.
 * Khuzoe Auras keeps the same standalone predicate for its own engine.
 */
export function isAuraCreature(value) {
  const token = value?.document ?? value;
  const flags = token?.flags?.["khuzoe-merchant"];
  return Boolean(token?.actor && !flags?.container && !flags?.groundLoot
    && token.actor.flags?.["khuzoe-merchant"]?.groundLootProxy !== true);
}
