export const MODULE_ID = "khuzoe-monster-hud";
export const MODULE_TITLE = "Khuzoe Monster HUD";

export const FLAGS = Object.freeze({
  CONFIG: "config",
  TURN_USAGE: "turnUsage"
});

export const SETTINGS = Object.freeze({
  ENABLED: "enabled",
  FOLLOW_COMBAT: "followCombat",
  ALLOW_OWNERS: "allowOwners",
  ANCHOR: "anchor",
  SCALE: "scale",
  POSITION: "position"
});

export const TEMPLATES = Object.freeze({
  CONFIG: `modules/${MODULE_ID}/templates/config.hbs`
});

export const ABILITIES = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
export const QUICK_SKILLS = Object.freeze([
  Object.freeze({ key: "prc", short: "PER", icon: "fa-solid fa-eye" }),
  Object.freeze({ key: "ste", short: "FUR", icon: "fa-solid fa-user-ninja" }),
  Object.freeze({ key: "ath", short: "ATL", icon: "fa-solid fa-dumbbell" }),
  Object.freeze({ key: "acr", short: "ACR", icon: "fa-solid fa-person-running" })
]);

export const GROUP_MODES = Object.freeze(["fixed", "shared"]);
export const CONFIG_VERSION = 1;
export const MAX_QUICK_ACTIONS = 10;
