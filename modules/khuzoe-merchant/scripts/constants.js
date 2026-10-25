export const MODULE_ID = "khuzoe-merchant";
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const FLAG_KEY = "merchant";
export const MAX_PURCHASE_QUANTITY = 99;
export const REQUEST_TIMEOUT_MS = 15000;

export const TEMPLATES = {
  config: `modules/${MODULE_ID}/templates/merchant-config.hbs`,
  shop: `modules/${MODULE_ID}/templates/merchant-shop.hbs`,
  economy: `modules/${MODULE_ID}/templates/economy-config.hbs`,
  containerConfig: `modules/${MODULE_ID}/templates/container-config.hbs`,
  containerSheet: `modules/${MODULE_ID}/templates/container-sheet.hbs`
};

export const DEFAULT_MERCHANT = Object.freeze({
  schemaVersion: 2,
  revision: 0,
  vaultRef: "",
  enabled: false,
  subtitle: "",
  distance: 5,
  inventory: [],
  production: {}
});

export const DEFAULT_CONTAINER = Object.freeze({
  schemaVersion: 2,
  revision: 0,
  name: "Forziere",
  img: "icons/containers/chest/chest-reinforced-brown.webp",
  description: "",
  emptyBehavior: "keep",
  key: null,
  inventory: [],
  currency: {},
  production: {}
});
