import {RELEASE_VERSION} from "./release.mjs";
export const FOLLOW_UP_ACTIVITIES = new Set([
  "farStepTeleport", "fireShieldDismiss", "flameBladeScimitar", "flameBladeEvoke",
  "hexMove", "huntersMarkMove", "investitureOfFlameFire", "investitureOfIceCone",
  "investitureOfStoneEarthquake", "wardingBondDismiss", "auraOfVitalityHeal",
  "heatMetalPulse", "holyWeaponDismiss", "vampiricTouchAttack", "crownOfStarsMote"
]);

/** Applied to generated data only; no migration of world Items. */
export function normalizeAutomationData(item) {
  if (item?.flags?.cat?.automation?.source === "khuzoe-automations") {
    item.flags.cat.automation.version = item.system?.identifier === "crown-of-stars" ? "0.28.0" : RELEASE_VERSION;
  }
  if (!item?.system?.activities) return item;
  const identifier = item.system.identifier;
  if (identifier === "create-bonfire") {
    const damage = item.system.activities.KhzBonfireDmg001;
    const cast = item.system.activities.KhzBonfireCast01;
    if (damage && cast?.regionBehavior) {
      // Midi keys its once-per-turn ledger by activity UUID. Entry and turn end are separate triggers.
      const end = structuredClone(damage);
      end._id = "KhzBonfireEnd001";
      end.midiProperties.identifier = "khuzoe-create-bonfire-end";
      item.system.activities[end._id] = end;
      for (const rule of cast.regionBehavior.rules) if (rule.trigger === "turnEnd") rule.targetId = end.midiProperties.identifier;
    }
  }
  const map = item.flags?.["khuzoe-automations"]?.activityIdentifiers ?? {};
  const activities = Object.values(item.system.activities);
  for (const activity of activities) {
    const key = Object.entries(map).find(([, id]) => id === activity._id)?.[0]
      ?? activity.midiProperties?.identifier;
    activity.midiProperties ??= {};
    if (key) activity.midiProperties.identifier ??= key;
    const followUp = FOLLOW_UP_ACTIVITIES.has(key) || (identifier === "aura-of-vitality" && activity.type === "heal");
    if (followUp) {
      activity.midiProperties.automationOnly = false;
      activity.consumption = {targets: [], spellSlot: false, scaling: {allowed: false}};
      if (key === "crownOfStarsMote") activity.consumption.targets = [{type: "activityUses", value: "1", target: "", scaling: {}}];
      activity.duration = {units: "inst", concentration: false, override: true};
    } else if (activity.flags?.cat?.hidden) {
      activity.midiProperties.automationOnly = true;
    }
    if (identifier === "wall-of-fire") activity.midiProperties.identifier = key === "damage" ? "khuzoe-wall-of-fire-damage" : "khuzoe-wall-of-fire-cast";
    if (["disintegrate", "earth-tremor"].includes(identifier) && activity.damage) activity.damage.onSave = "none";
    if (identifier === "naniss-p-come-azione-bonus-na") activity.consumption = {targets: [], spellSlot: false, scaling: {allowed: false}};
  }
  item.flags ??= {};
  if (identifier === "naniss-p-come-azione-bonus-na" && item.system.uses) item.system.uses.spent = 0;
  if (identifier === "spirito-elementale-fatato-p-quando-una-creatura-n") {
    item.flags.cat ??= {};
    item.flags.cat.macros ??= {};
    item.flags.cat.macros.aura = [{source: "khuzoe-automations", rules: "2014", identifier}];
  }
  item.flags.dnd5e ??= {};
  item.flags.dnd5e.riders ??= {};
  // Internal calls use activity-compat; regions are invoked directly by Midi.
  item.flags.dnd5e.riders.activity = activities.filter(activity =>
    activity.flags?.cat?.hidden && activity.midiProperties?.automationOnly
    && identifier !== "create-bonfire"
  ).map(activity => activity._id);
  if (identifier === "synaptic-static") {
    for (const effect of item.effects ?? []) {
      const changes = effect.system?.changes;
      if (changes?.some(change => change.key === "system.bonuses.abilities.check")
        && !changes.some(change => change.key === "flags.midi-qol.concentrationSaveBonus")) {
        changes.push({key: "flags.midi-qol.concentrationSaveBonus", value: "-1d6", type: "add", priority: 20});
      }
    }
  }
  for (const effect of item.effects ?? []) {
    if (["charm-person", "gaseous-form", "hypnotic-pattern", "tashas-caustic-brew", "rimes-binding-ice", "death-ward"].includes(identifier)) {
      effect.flags ??= {}; effect.flags["khuzoe-automations"] ??= {};
      effect.flags["khuzoe-automations"].expandedSpell ??= {identifier, kind: "native"};
    }
    if (identifier === "charm-person" && effect.flags?.dae?.specialDuration) {
      effect.flags.dae.specialDuration = effect.flags.dae.specialDuration.filter(value => value !== "isDamaged");
    }
  }
  return item;
}
