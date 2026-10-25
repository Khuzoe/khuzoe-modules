import {
  GENIE_TYPE,
  MODULE_ID,
  registerDnd5eExtensions
} from "./config.mjs";
import { registerDefaultGenieVulnerability } from "./genie-vulnerability.mjs";
import { registerSettings, SETTINGS } from "./settings.mjs";

Hooks.once("init", () => {
  if (game.system.id !== "dnd5e") return;

  const extensions = registerDnd5eExtensions(CONFIG.DND5E, {
    localize: key => game.i18n.localize(key),
    ColorClass: foundry.utils.Color
  });
  registerSettings();
  registerDefaultGenieVulnerability();

  game.khuzoeDnd5eExtensions = Object.freeze({
    damageTypes: Object.freeze({ [GENIE_TYPE]: extensions.damageType }),
    creatureTypes: Object.freeze({ [GENIE_TYPE]: extensions.creatureType }),
    settings: SETTINGS
  });

  console.info(`${MODULE_ID} | Registrati il danno Geniale e il tipo di creatura Genio.`);
});
