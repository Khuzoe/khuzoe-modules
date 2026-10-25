import { MODULE_ID } from "./config.mjs";

export const SETTINGS = Object.freeze({
  DEFAULT_GENIE_VULNERABILITY: "defaultGenieVulnerability"
});

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_GENIE_VULNERABILITY, {
    name: "KHZ_DND5E_EXTENSIONS.Settings.DefaultGenieVulnerability.Name",
    hint: "KHZ_DND5E_EXTENSIONS.Settings.DefaultGenieVulnerability.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: false
  });
}
