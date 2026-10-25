export const MODULE_ID = "khuzoe-dnd5e-extensions";
export const GENIE_TYPE = "genie";

export const GENIE_DAMAGE = Object.freeze({
  label: "KHZ_DND5E_EXTENSIONS.Damage.Genie",
  icon: `modules/${MODULE_ID}/icons/genie-damage.svg`,
  color: 0x9A63D8
});

export const GENIE_CREATURE = Object.freeze({
  label: "KHZ_DND5E_EXTENSIONS.Creature.Genie",
  plural: "KHZ_DND5E_EXTENSIONS.Creature.GeniePlural",
  icon: `modules/${MODULE_ID}/icons/genie-creature.svg`
});

/**
 * Register Khuzoe's additions in dnd5e's public configuration dictionaries.
 * The system consumes both dictionaries dynamically in sheets, selectors,
 * damage rolls and damage traits, so no system files or document migrations
 * are required.
 *
 * @param {object} dnd5eConfig CONFIG.DND5E
 * @param {object} [options]
 * @param {(key: string) => string} [options.localize]
 * @param {Function} [options.ColorClass]
 * @returns {{ damageType: object, creatureType: object }}
 */
export function registerDnd5eExtensions(dnd5eConfig, {
  localize = key => key,
  ColorClass = globalThis.Color
} = {}) {
  if (!dnd5eConfig || typeof dnd5eConfig !== "object") {
    throw new TypeError("CONFIG.DND5E non disponibile.");
  }
  if (typeof ColorClass !== "function") {
    throw new TypeError("La classe Color di Foundry non è disponibile.");
  }

  dnd5eConfig.damageTypes ??= {};
  dnd5eConfig.creatureTypes ??= {};

  const damageType = {
    label: localize(GENIE_DAMAGE.label),
    icon: GENIE_DAMAGE.icon,
    color: new ColorClass(GENIE_DAMAGE.color)
  };
  const creatureType = {
    label: localize(GENIE_CREATURE.label),
    plural: localize(GENIE_CREATURE.plural),
    icon: GENIE_CREATURE.icon
  };

  // Replacing only the dedicated key prevents stale metadata from another
  // registration (for example isPhysical or elemental aliases) from leaking
  // into Khuzoe's intentionally independent types.
  dnd5eConfig.damageTypes[GENIE_TYPE] = damageType;
  dnd5eConfig.creatureTypes[GENIE_TYPE] = creatureType;

  return { damageType, creatureType };
}
