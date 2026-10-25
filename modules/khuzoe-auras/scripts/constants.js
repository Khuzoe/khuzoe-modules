export const MODULE_ID = "khuzoe-auras";
export const MODULE_TITLE = "Khuzoe Auras";

export const FLAGS = Object.freeze({
  AURAS: "auras",
  IMMUNITIES: "immunities"
});

export const SETTINGS = Object.freeze({
  SHOW_VISUALS: "showVisuals",
  DEBUG: "debug"
});

export const TEMPLATES = Object.freeze({
  CONFIG: `modules/${MODULE_ID}/templates/aura-config.hbs`,
  CHAT_SUMMARY: `modules/${MODULE_ID}/templates/chat-summary.hbs`
});

export const TRIGGER_PRESETS = Object.freeze({
  sourceTurnStart: Object.freeze({ event: "turnStart", subject: "source" }),
  sourceTurnEnd: Object.freeze({ event: "turnEnd", subject: "source" }),
  affectedTurnStart: Object.freeze({ event: "turnStart", subject: "affected" }),
  affectedTurnEnd: Object.freeze({ event: "turnEnd", subject: "affected" }),
  roundStart: Object.freeze({ event: "roundStart", subject: "source" }),
  roundEnd: Object.freeze({ event: "roundEnd", subject: "source" }),
  enter: Object.freeze({ event: "enter", subject: "affected" }),
  exit: Object.freeze({ event: "exit", subject: "affected" }),
  manual: Object.freeze({ event: "manual", subject: "source" })
});

export const ACTION_TYPES = Object.freeze(["healing", "damage", "temphp", "effect"]);
export const TARGET_RELATIONS = Object.freeze(["ally", "enemy", "neutral", "all"]);
export const FREQUENCIES = Object.freeze(["oncePerPhase", "oncePerTurn", "oncePerRound", "always"]);
export const STACKING_MODES = Object.freeze(["stack", "highest", "first"]);
export const ROLL_MODES = Object.freeze(["perTarget", "shared"]);
export const SAVE_RESULTS = Object.freeze(["none", "half"]);

export const MOVEMENT_FIELDS = Object.freeze([
  "x",
  "y",
  "width",
  "height",
  "depth",
  "shape",
  "level",
  "elevation",
  "disposition"
]);

export const DEFAULT_COLOR = "#55d68b";
export const MAX_LEDGER_ENTRIES = 5000;
