import {RELEASE_VERSION} from "./release.mjs";
import {expandedSpellId} from "./expanded-spell-catalog.mjs";

export const SPECIAL_SPELL_VERSION = RELEASE_VERSION;
export const SPECIAL_EFFECT = "khuzoe-special-spell-effect";
export const specialId = key => expandedSpellId(`special-2014:${key}`);
export const SPECIAL_SPELL_CATALOG = Object.freeze([
  ["chaosBolt", "chaos-bolt", "Chaos Bolt"],
  ["dragonsBreath", "dragons-breath", "Dragon's Breath"],
  ["heatMetal", "heat-metal", "Heat Metal"],
  ["holyWeapon", "holy-weapon", "Holy Weapon"],
  ["mirrorImage", "mirror-image", "Mirror Image"],
  ["vampiricTouch", "vampiric-touch", "Vampiric Touch"]
].map(([source, identifier, name]) => Object.freeze({source, identifier, name, id: specialId(identifier)})));

export function specialDamage(number, denomination, type, scaling = false) {
  return {
    number, denomination, bonus: "", types: type ? [type] : [],
    custom: {enabled: false, formula: ""},
    scaling: {mode: scaling ? "whole" : "", number: scaling ? 1 : null, formula: ""}
  };
}

/** Shared by the build tool and the temporary, concentration-bound breath. */
export function specialActivity(key, {
  type = "utility", name = "", activation = "special", hidden = false,
  spellSlot = false, targetType = "creature", count = "1", range = "any",
  distance, parts = [], save, dc, concentration = false, duration = "inst", durationValue
} = {}) {
  const activity = {
    _id: specialId(key), type, name, img: "",
    activation: {type: activation, value: 1, override: true, condition: ""},
    consumption: {spellSlot, targets: [], scaling: {allowed: false, max: ""}},
    description: {chatFlavor: ""},
    duration: {units: duration, value: durationValue, concentration, override: true},
    effects: [],
    range: {units: range, value: distance, override: true, special: ""},
    target: {
      override: true, prompt: true,
      affects: {type: targetType, count, choice: false, special: ""},
      template: {type: "", units: "ft", contiguous: false, size: "", count: ""}
    },
    uses: {spent: 0, max: "", recovery: []}, sort: 0,
    visibility: {level: {min: null, max: null}},
    midiProperties: {
      identifier: key, automationOnly: hidden && !["heatMetalPulse", "holyWeaponDismiss", "vampiricTouchAttack"].includes(key), confirmTargets: "default",
      autoTargetType: "any", autoTargetAction: "default", magicEffect: true,
      magicDamage: parts.length > 0
    },
    flags: {cat: {hidden}}
  };
  if (type === "utility") activity.roll = {formula: "", name: "", prompt: false, visible: false};
  if (["attack", "damage", "save"].includes(type)) {
    activity.damage = {parts, includeBase: false, critical: type === "attack" ? {bonus: ""} : {allow: false}};
  }
  if (type === "attack") activity.attack = {
    ability: "", bonus: "", flat: false, critical: {threshold: null},
    type: {value: key === "vampiricTouchAttack" ? "melee" : "ranged", classification: "spell"}
  };
  if (type === "save") {
    activity.damage.onSave = parts.length ? "half" : "none";
    activity.save = {ability: [save ?? "con"], dc: dc == null
      ? {calculation: "spellcasting", formula: ""}
      : {calculation: "", formula: String(dc)}};
  }
  return activity;
}
