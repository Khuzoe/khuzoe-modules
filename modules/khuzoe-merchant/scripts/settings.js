import { MODULE_ID } from "./constants.js";
import { EconomyConfig } from "./economy-config.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, "defaultDistance", {
    name: "KM.Settings.DefaultDistance.Name",
    hint: "KM.Settings.DefaultDistance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });

  game.settings.register(MODULE_ID, "merchantActorTypes", {
    name: "KM.Settings.ActorTypes.Name",
    hint: "KM.Settings.ActorTypes.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "npc"
  });

  game.settings.register(MODULE_ID, "requireControlledToken", {
    name: "KM.Settings.RequireControlled.Name",
    hint: "KM.Settings.RequireControlled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "shopViewMode", {
    name: "KM.Settings.ShopView.Name",
    hint: "KM.Settings.ShopView.Hint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      list: "KM.Shop.ViewList",
      full: "KM.Shop.ViewFull"
    },
    default: "list"
  });

  game.settings.register(MODULE_ID, "currencyMode", {
    name: "KM.Settings.CurrencyMode.Name",
    hint: "KM.Settings.CurrencyMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      auto: "KM.Settings.CurrencyMode.Auto",
      dnd5e: "KM.Settings.CurrencyMode.Dnd5e",
      simple: "KM.Settings.CurrencyMode.Simple"
    },
    default: "auto"
  });

  game.settings.register(MODULE_ID, "simpleCurrencyPath", {
    name: "KM.Settings.CurrencyPath.Name",
    hint: "KM.Settings.CurrencyPath.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "system.currency.gp"
  });

  game.settings.register(MODULE_ID, "itemPricePath", {
    name: "KM.Settings.PricePath.Name",
    hint: "KM.Settings.PricePath.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "system.price.value"
  });

  game.settings.register(MODULE_ID, "currencyLabel", {
    name: "KM.Settings.CurrencyLabel.Name",
    hint: "KM.Settings.CurrencyLabel.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "gp"
  });

  game.settings.register(MODULE_ID, "chatReceipts", {
    name: "KM.Settings.ChatReceipts.Name",
    hint: "KM.Settings.ChatReceipts.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "allowUnownedActorTransfers", {
    name: "KM.Settings.UnownedTransfers.Name",
    hint: "KM.Settings.UnownedTransfers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "economyAutoSync", {
    name: "KM.Settings.EconomyAutoSync.Name",
    hint: "KM.Settings.EconomyAutoSync.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "economyRegistry", {
    name: "KM.Economy.Title",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
  game.settings.register(MODULE_ID, "transactionLedger", {
    name: "Khuzoe Merchant transaction ledger",
    scope: "world",
    config: false,
    type: Object,
    default: { entries: [] }
  });

  game.settings.registerMenu(MODULE_ID, "economyConfig", {
    name: "KM.Economy.Title",
    label: "KM.Economy.Open",
    hint: "KM.Economy.SettingsHint",
    icon: "fas fa-coins",
    type: EconomyConfig,
    restricted: true
  });

}
