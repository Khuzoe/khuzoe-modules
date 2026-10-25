import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const settings = new Map([
  ["currencyMode", "auto"],
  ["simpleCurrencyPath", "system.currency.gp"],
  ["itemPricePath", "system.price.value"],
  ["currencyLabel", "gp"],
  ["requireControlledToken", false]
]);

globalThis.game = {
  i18n: { lang: "en" },
  system: { id: "dnd5e" },
  settings: { get: (_namespace, key) => settings.get(key) }
};

function getProperty(object, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  let target = object;
  for (const part of parts.slice(0, -1)) target = target[part] ??= {};
  target[parts.at(-1)] = value;
  return true;
}

let randomCounter = 0;
globalThis.foundry = { utils: {
  getProperty,
  setProperty,
  deepClone: (value) => structuredClone(value),
  randomID: () => `test-id-${++randomCounter}`
} };
globalThis.document = {
  addEventListener: () => {},
  createElement: () => ({
    textContent: "",
    set innerHTML(value) {
      this.textContent = String(value).replace(/<[^>]*>/g, " ");
    }
  })
};

const currency = await import("../scripts/currency-v2.js");
const distance = await import("../scripts/distance.js");
const utils = await import("../scripts/utils.js");
const economy = await import("../scripts/economy.js");
const productionData = await import("../scripts/production-data.js");
const uiTabs = await import("../scripts/ui-tabs.js");

const applicationV2FormRoot = {
  0: { querySelectorAll: () => { throw new Error("the first form control must not be used as the application root"); } },
  querySelectorAll: () => []
};
assert.equal(
  uiTabs.resolveInterfaceRoot(applicationV2FormRoot),
  applicationV2FormRoot,
  "ApplicationV2 form roots are not mistaken for legacy array-like wrappers"
);

const legacyProduction = productionData.normalizeProduction();
assert.equal(legacyProduction.enabled, false, "existing merchants and containers never start producing after an update");
assert.equal(legacyProduction.rules.length, 0);
const catchUpSchedule = productionData.productionSchedule({
  enabled: true,
  timeBasis: "world",
  intervalDays: 2,
  maxCatchUp: 3,
  lastProcessedAt: 100,
  rules: []
}, 100 + (10 * 86400));
assert.equal(catchUpSchedule.totalDue, 5, "two-day production intervals count elapsed world-time cycles");
assert.equal(catchUpSchedule.due, 3, "production catch-up honors its configured safety cap");
assert.equal(catchUpSchedule.skipped, 2, "older excess cycles are explicitly skipped");
assert.equal(productionData.productionFormulaIsSafe("1d2 + 1"), true);
assert.equal(productionData.productionFormulaIsSafe("1000d100"), false, "unbounded dice formulas are rejected");
const productiveItem = {
  id: "lunarmana",
  sourceUuid: "Item.lunarmana",
  name: "Lunarmana Rosso",
  img: "lunarmana.webp",
  type: "consumable",
  stock: 0,
  data: { name: "Lunarmana Rosso", type: "consumable", system: { quantity: 1 } }
};
const redRule = productionData.productionRuleFromEntry(productiveItem, {}, {
  quantityFormula: "1d2",
  chance: 25,
  maximum: 10
});
const unstableRule = productionData.productionRuleFromEntry({ ...productiveItem, id: "unstable", name: "Lunarmana Instabile" }, {}, {
  quantityFormula: "1d2",
  chance: 75,
  maximum: 20
});
const weightedProduction = productionData.normalizeProduction({
  enabled: true,
  mode: "weighted",
  intervalDays: 2,
  rules: [redRule, unstableRule]
});
assert.equal(productionData.validateProduction(weightedProduction, { merchant: true, inventory: [productiveItem] }).ok, true);
assert.equal(productionData.productionRows([], weightedProduction)[0].missing, true, "depleted container production keeps its Item template");
assert.equal(productionData.publicProduction(weightedProduction).rules.length, 0, "public production metadata strips private Item snapshots");
assert.equal(productionData.publicProduction(weightedProduction).enabled, true, "public metadata retains only the scheduling signal");
assert.equal(productionData.selectProductionRules(weightedProduction, () => 0.1)[0].name, "Lunarmana Rosso");
assert.equal(productionData.selectProductionRules(weightedProduction, () => 0.5)[0].name, "Lunarmana Instabile");
assert.equal(productionData.selectProductionRules({ ...weightedProduction, rules: [{ ...redRule, chance: 25 }] }, () => 0.8).length, 0, "unused weighted probability produces an empty cycle");
const independentRolls = [0.2, 0.8];
assert.equal(productionData.selectProductionRules({ ...weightedProduction, mode: "independent" }, () => independentRolls.shift()).length, 1, "independent chances can produce one of several matching Items");
const invalidWeighted = productionData.validateProduction({
  ...weightedProduction,
  rules: [{ ...redRule, chance: 60 }, { ...unstableRule, chance: 60 }]
});
assert.equal(invalidWeighted.ok, false);
assert.equal(invalidWeighted.errorKey, "KM.Production.Errors.ProbabilityTotal");

const baseMerchantActor = { id: "merchant-base" };
globalThis.game.actors = {
  get: (id) => id === baseMerchantActor.id ? baseMerchantActor : null
};
assert.equal(
  utils.canonicalActor({
    id: "synthetic-copy",
    documentName: "Actor",
    token: { actorId: baseMerchantActor.id }
  }),
  baseMerchantActor,
  "unlinked token Actors resolve to the canonical world Actor"
);

const item5eDocument = {
  documentName: "Item",
  name: "Live Item",
  img: "icons/live.webp",
  type: "loot",
  system: { description: { value: "<p>Modern description</p>" } },
  toObject: () => ({ name: "Live Item", type: "loot", system: { description: { value: "<p>Modern description</p>" } } }),
  get data() {
    throw new Error("Legacy Item.data must not be accessed");
  }
};
assert.equal(
  utils.itemDescription(item5eDocument),
  "Modern description",
  "Item5e descriptions use system without touching the removed data getter"
);
assert.equal(
  utils.itemDescription({ data: { system: { description: { value: "Legacy snapshot" } } } }),
  "Legacy snapshot",
  "plain saved snapshots can still use their legacy data path"
);
globalThis.fromUuid = async (uuid) => uuid === "Item.live" ? item5eDocument : null;
const refreshedEntry = await utils.refreshMerchantEntry({
  sourceUuid: "Item.live",
  name: "Old name",
  description: "Old description",
  price: { value: 25, denomination: "gp" },
  stock: 3
});
assert.equal(refreshedEntry.name, "Live Item");
assert.equal(refreshedEntry.description, "Modern description");
assert.deepEqual(refreshedEntry.price, { value: 25, denomination: "gp" }, "merchant price remains independent");
assert.equal(refreshedEntry.stock, 3, "merchant stock remains independent");

const tinyPrice = currency.normalizePrice({ price: { value: 0.001, denomination: "gp" } });
assert.deepEqual(tinyPrice, { value: 0.01, denomination: "gp" }, "positive D&D5e prices cost at least 1 cp");


const customRegistry = structuredClone(currency.economySnapshot());
customRegistry.groups.push({
  id: "zara-coins",
  name: "Monete di Zara",
  conversionMode: "none",
  baseCurrencyId: "pezza",
  order: 200,
  currencies: [{
    id: "pezza",
    name: "Moneta di pezza",
    symbol: "pezza",
    factor: 1,
    precision: 0,
    order: 10,
    color: "#b16ce0",
    icon: "media/campaigns/cripta-di-sangue/economy/currencies/pezza.webp",
    active: true,
    storage: { kind: "flag", path: "flags.khuzoe-merchant.wallet.pezza" }
  }]
});
settings.set("economyRegistry", customRegistry);
const mixedBuyer = {
  system: { currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 } },
  flags: { "khuzoe-merchant": { wallet: { pezza: 5 } } }
};
const mixedDeduction = currency.planDeduction(mixedBuyer, {
  cost: { components: [{ currencyId: "sp", amount: 7 }, { currencyId: "pezza", amount: 2 }] }
}, 1);
assert.equal(mixedDeduction.sufficient, true, "convertible and independent currencies can be charged atomically");
assert.equal(mixedDeduction.update["system.currency.sp"], 3);
assert.equal(mixedDeduction.update["flags.khuzoe-merchant.wallet.pezza"], 3);
const customWithdrawal = currency.planCurrencyTransfer(mixedBuyer, "pezza", 2, { direction: "withdraw" });
assert.equal(customWithdrawal.valid, true, "custom currency drops are valid");
assert.equal(customWithdrawal.sufficient, true, "custom currency drops validate available balance");
assert.equal(customWithdrawal.update["flags.khuzoe-merchant.wallet.pezza"], 3);
assert.equal(customWithdrawal.rollback["flags.khuzoe-merchant.wallet.pezza"], 5);
const customDeposit = currency.planCurrencyTransfer(mixedBuyer, "pezza", 3, { direction: "deposit" });
assert.equal(customDeposit.update["flags.khuzoe-merchant.wallet.pezza"], 8, "custom currency pickup increments the selected Actor wallet");
const excessiveWithdrawal = currency.planCurrencyTransfer(mixedBuyer, "pezza", 6, { direction: "withdraw" });
assert.equal(excessiveWithdrawal.sufficient, false, "currency cannot be dropped beyond the authoritative balance");
const duplicatePathRegistry = structuredClone(customRegistry);
duplicatePathRegistry.groups[1].currencies[0].storage.path = "system.currency.gp";
assert.throws(
  () => economy.validateEconomyRegistry(duplicatePathRegistry),
  (error) => error.code === "ECONOMY_DUPLICATE_PATH",
  "two currencies cannot silently overwrite the same Actor storage path"
);
assert.match(mixedDeduction.totalLabel, /7 sp/);
assert.match(mixedDeduction.totalLabel, /2 pezza/);
const flaggedItemPrice = currency.extractItemPrice({
  system: { price: { value: 99, denomination: "gp" } },
  flags: { "khuzoe-merchant": { cost: { components: [{ currencyId: "pezza", amount: 4 }] } } }
});
assert.deepEqual(flaggedItemPrice, { value: 4, denomination: "pezza" }, "campaign item custom prices override the native D&D display price");
settings.delete("economyRegistry");
const buyer = { system: { currency: { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 } } };
const deduction = currency.planDeduction(buyer, { price: { value: 7, denomination: "sp" } }, 1);
assert.equal(deduction.sufficient, true);
assert.equal(deduction.update["system.currency.gp"], 0);
assert.equal(deduction.update["system.currency.ep"], 0);
assert.equal(deduction.update["system.currency.sp"], 3);

settings.set("currencyMode", "simple");
settings.set("currencyLabel", "   ");
const simplePrice = currency.normalizePrice({ price: { value: 2.5, denomination: "credits" } });
assert.deepEqual(simplePrice, { value: 2.5, denomination: "gp" }, "simple mode uses the configured accounting label");

const scene = { grid: { size: 100, distance: 5 } };
const tokenA = { x: 0, y: 0, width: 1, height: 1, parent: scene };
const tokenB = { x: 200, y: 0, width: 1, height: 1, parent: scene };
assert.equal(distance.tokenDistance(tokenA, tokenB, scene), 5, "distance is measured edge-to-edge");
assert.equal(distance.isWithinDistance(tokenA, tokenB, 5), true);
assert.equal(distance.isWithinDistance(tokenA, { ...tokenB, parent: {} }, 5), false, "tokens must share a scene");

const mainSource = await readFile(new URL("../scripts/main.js", import.meta.url), "utf8");
const moduleManifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url), "utf8"));
const actorWalletSource = await readFile(new URL("../scripts/actor-wallet.js", import.meta.url), "utf8");
const currencySource = await readFile(new URL("../scripts/currency-v2.js", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../scripts/settings.js", import.meta.url), "utf8");
const configSource = await readFile(new URL("../scripts/merchant-config.js", import.meta.url), "utf8");
const shopSource = await readFile(new URL("../scripts/merchant-shop.js", import.meta.url), "utf8");
const socketSource = await readFile(new URL("../scripts/socket.js", import.meta.url), "utf8");
const groundLootSource = await readFile(new URL("../scripts/ground-loot.js", import.meta.url), "utf8");
const groundLootDataSource = await readFile(new URL("../scripts/ground-loot-data.js", import.meta.url), "utf8");
const lootSocketSource = await readFile(new URL("../scripts/loot-socket.js", import.meta.url), "utf8");
const quantityDialogSource = await readFile(new URL("../scripts/quantity-dialog.js", import.meta.url), "utf8");
const shopTemplate = await readFile(new URL("../templates/merchant-shop.hbs", import.meta.url), "utf8");
const configTemplate = await readFile(new URL("../templates/merchant-config.hbs", import.meta.url), "utf8");
const containerSource = await readFile(new URL("../scripts/container.js", import.meta.url), "utf8");
const containerDataSource = await readFile(new URL("../scripts/container-data.js", import.meta.url), "utf8");
const containerConfigSource = await readFile(new URL("../scripts/container-config.js", import.meta.url), "utf8");
const containerSheetSource = await readFile(new URL("../scripts/container-sheet.js", import.meta.url), "utf8");
const containerSocketSource = await readFile(new URL("../scripts/container-socket.js", import.meta.url), "utf8");
const containerConfigTemplate = await readFile(new URL("../templates/container-config.hbs", import.meta.url), "utf8");
const containerSheetTemplate = await readFile(new URL("../templates/container-sheet.hbs", import.meta.url), "utf8");
const economyConfigSource = await readFile(new URL("../scripts/economy-config.js", import.meta.url), "utf8");
const economyTemplate = await readFile(new URL("../templates/economy-config.hbs", import.meta.url), "utf8");
const merchantLoaderStyle = await readFile(new URL("../styles/merchant.css", import.meta.url), "utf8");
const merchantStyle = await readFile(new URL("../styles/merchant-legacy.css", import.meta.url), "utf8");
const interfaceStyle = await readFile(new URL("../styles/interface-v2.css", import.meta.url), "utf8");
const v14Style = await readFile(new URL("../styles/v14.css", import.meta.url), "utf8");
const uiTabsSource = await readFile(new URL("../scripts/ui-tabs.js", import.meta.url), "utf8");
const coordinatorSource = await readFile(new URL("../scripts/transaction-coordinator.js", import.meta.url), "utf8");
const itemTransferSource = await readFile(new URL("../scripts/item-transfer.js", import.meta.url), "utf8");
const containerStoreSource = await readFile(new URL("../scripts/container-store.js", import.meta.url), "utf8");
const utilsSource = await readFile(new URL("../scripts/utils.js", import.meta.url), "utf8");
const productionSource = await readFile(new URL("../scripts/production.js", import.meta.url), "utf8");
const productionDataSource = await readFile(new URL("../scripts/production-data.js", import.meta.url), "utf8");
const foundryCompatSource = await readFile(new URL("../scripts/foundry-compat.js", import.meta.url), "utf8");
assert.equal(moduleManifest.version, "1.21.2", "the container preview release has the expected module version");
assert.equal(moduleManifest.compatibility.minimum, "14", "the module only activates on the supported Foundry major");
assert.equal(moduleManifest.compatibility.verified, "14.367", "the portable Foundry build is recorded as verified");
assert.equal("maximum" in moduleManifest.compatibility, false, "future v14 maintenance builds are not blocked by a maximum cap");
assert.doesNotMatch(mainSource, /globalThis\.Token\b/, "merchant interactions avoid the deprecated Token global");
assert.doesNotMatch(containerSource, /globalThis\.Token\b/, "container interactions avoid the deprecated Token global");
assert.doesNotMatch(groundLootSource, /globalThis\.(?:Token|Tile)\b/, "ground loot avoids deprecated canvas globals");
assert.match(mainSource, /globalThis\.foundry\?\.canvas\?\.placeables\?\.Token/, "merchant interactions use the Foundry v14 Token namespace");
assert.match(containerSource, /globalThis\.foundry\?\.canvas\?\.placeables\?\.Token/, "container interactions use the Foundry v14 Token namespace");
assert.match(groundLootSource, /globalThis\.foundry\?\.canvas\?\.placeables\?\.Tile/, "ground loot uses the Foundry v14 Tile namespace");
assert.match(mainSource, /Hooks\.on\("getActorSheetHeaderButtons"/, "Actor sheet header integration is registered");
assert.match(mainSource, /Hooks\.on\("getHeaderControlsApplicationV2"/, "Foundry v14 Actor sheets receive a header control");
assert.doesNotMatch(mainSource, /getApplicationHeaderButtons/, "merchant controls are never added to unrelated application headers");
assert.match(mainSource, /registerActorWallet/, "Actor wallet integration is registered");
assert.match(actorWalletSource, /Hooks\.on\("renderApplicationV2"/, "Foundry v14 document sheets receive the custom wallet");
assert.match(actorWalletSource, /includeActor: false/, "unrelated ApplicationV2 dialogs are excluded unless they own an Actor or Item document");
assert.match(actorWalletSource, /openApplications\(\)/, "wallet refreshes include every registered Foundry window");
assert.match(actorWalletSource, /hideArchivedNativeCurrencies/, "archived native denominations are hidden without deleting balances");
assert.match(actorWalletSource, /\[name\^='system\.currency\.'/i, "custom currencies attach beside native D&D currency inputs");
assert.match(actorWalletSource, /khuzoe-wallet-native/, "custom currencies reuse the native compact D&D wallet layout");
assert.match(actorWalletSource, /currencyIconUrl/, "campaign currency icons are rendered in Actor wallets");
assert.match(actorWalletSource, /flags\\\.khuzoe-merchant\\\.wallet/, "custom balances remain on the stable Actor flag path");
assert.match(actorWalletSource, /KhuzoeCurrency/, "native and custom wallet denominations provide currency drag data");
assert.match(actorWalletSource, /event\.altKey/, "Alt-drag transfers one currency unit");
assert.match(currencySource, /planCurrencyTransfer/, "currency deposit and withdrawal use one authoritative planner");
assert.doesNotMatch(mainSource, /renderActorSheet|km-sheet-merchant/, "no invasive in-sheet merchant control is registered");
assert.match(mainSource, /khuzoeMerchantDoubleClick/, "player double-left-click integration is installed");
assert.match(mainSource, /khuzoeMerchantCanView/, "active merchants pass the token view interaction gate");
assert.match(mainSource, /MerchantShop\.openForToken\(this\)/, "double-left-click opens the merchant shop");
assert.equal(
  moduleManifest.languages.every((language) => language.path === "lang/it.json"),
  true,
  "all client language selections load the Italian localization"
);
assert.match(mainSource, /Hooks\.on\("updateItem"/, "source Item updates synchronize merchant entries");
assert.match(utilsSource, /querySelectorAll\?\.[\s\S]*?data-visibility='gm'/, "GM-only Item description sections are removed from public summaries");
assert.match(
  mainSource,
  /Hooks\.once\("init"[\s\S]*?patchMerchantTokenInteractions\(\)/,
  "token interaction patches are installed before the canvas is ready"
);
assert.doesNotMatch(mainSource, /renderTokenHUD|khuzoe-merchant-hud/, "Token HUD integration stays disabled");
assert.match(
  settingsSource,
  /"requireControlledToken"[\s\S]*?default:\s*false/,
  "automatic owned-token selection is the default"
);
assert.match(settingsSource, /"shopViewMode"[\s\S]*?scope:\s*"client"/, "shop view is remembered per client");
assert.doesNotMatch(configSource, /description:[^\n]*slice\(0,\s*180\)/, "item descriptions are not truncated");
assert.match(configSource, /_openSourceItem/, "the GM can open an original Item from merchant configuration");
assert.match(configTemplate, /km-edit-source-item/, "source Item edit control is rendered");
for (const [source, name] of [
  [configSource, "merchant configuration"],
  [shopSource, "merchant shop"],
  [containerConfigSource, "container configuration"],
  [containerSheetSource, "container sheet"],
  [economyConfigSource, "economy configuration"]
]) {
  assert.match(source, /extends HandlebarsApplicationV2/, `${name} uses the native Foundry v14 application stack`);
  assert.match(source, /static DEFAULT_OPTIONS/, `${name} declares ApplicationV2 options`);
  assert.match(source, /static PARTS/, `${name} renders through Handlebars application parts`);
}
assert.match(shopSource, /openImagePopout/, "item images use the Foundry v14 ImagePopout adapter");
assert.match(foundryCompatSource, /foundry\?\.applications\?\.apps\?\.ImagePopout/, "the v14 namespaced ImagePopout is preferred");
assert.doesNotMatch(shopSource, /_openItemImage[\s\S]{0,160}_viewMode !== "full"/, "image enlargement works in every view");
assert.match(shopTemplate, /data-view-mode="list"/, "list view control is rendered");
assert.match(shopTemplate, /data-view-mode="full"/, "full view control is rendered");
assert.match(shopTemplate, /km-item-details-button/, "list items expose a details control");
assert.match(shopSource, /_toggleItemDetails/, "list item details can be expanded");
assert.match(shopTemplate, /km-shop-filter/, "the player shop exposes availability filters");
assert.match(shopTemplate, /km-shop-sort/, "the player shop exposes sorting controls");
assert.match(shopTemplate, /km-quantity-stepper/, "the player shop provides accessible quantity step controls");
assert.match(shopTemplate, /data-action="purchase"/, "shop commands use native ApplicationV2 actions");
assert.match(configTemplate, /km-bulk-toolbar/, "the GM catalog supports bulk price and stock changes");
assert.match(configTemplate, /km-save-state/, "the GM sees unsaved configuration state");
assert.doesNotMatch(configTemplate, /<form\b/i, "the merchant template does not nest a form inside its ApplicationV2 form root");
assert.doesNotMatch(containerConfigTemplate, /<form\b/i, "the container template does not nest a form inside its ApplicationV2 form root");
assert.doesNotMatch(economyTemplate, /<form\b/i, "the economy template does not nest a form inside its ApplicationV2 form root");
assert.match(economyTemplate, /km-economy-validation/, "economy validation is visible before saving");
assert.match(economyTemplate, /km-economy-conversion-preview/, "automatic currency groups show a conversion preview");
assert.match(v14Style, /body\.theme-light[\s\S]*--km-v14-bg/, "the v14 layer supports Foundry's light theme");
assert.match(v14Style, /prefers-reduced-motion/, "the v14 layer respects reduced-motion preferences");
assert.doesNotMatch(shopTemplate, /km-distance-pill/, "the redundant distance badge is not rendered");
assert.match(socketSource, /merchantActor:\s*canonicalActor\(merchantToken\?\.actor\)/, "purchases update canonical merchant stock");
assert.match(mainSource, /registerGroundLoot\(\)/, "ground loot is registered during init");
assert.match(mainSource, /initializeGroundLoot\(\)/, "ground loot socket starts at ready");
assert.match(groundLootSource, /khuzoeGroundLootDoubleClick/, "ground Item Tokens open on double click");
assert.match(groundLootSource, /Hooks\.on\("dropCanvasData"/, "Items can be dragged natively from sheets and the Directory onto the canvas");
assert.doesNotMatch(groundLootSource, /getItemSheetHeaderButtons|khuzoe-merchant-ground-drop/, "ground drops do not add sheet buttons");
assert.match(groundLootSource, /DialogV2\.confirm/, "dropping an Item on another Actor uses the native v14 confirmation dialog");
assert.match(groundLootSource, /dropActorSheetData/, "Actor-to-Actor transfers also work from sheet drops");
assert.match(lootSocketSource, /processTransfer/, "Actor-to-Actor transfers are executed by the authoritative GM");
assert.match(lootSocketSource, /rollbackAppliedItems/, "failed Actor transfers restore the recipient inventory");
assert.match(lootSocketSource, /allowUnownedActorTransfers/, "recipient ownership is required unless the GM explicitly opts in");
assert.match(groundLootSource, /khuzoeGroundLootDragDrop/, "the dropper can drag ground loot to a new position");
assert.match(lootSocketSource, /processMove/, "ground loot movement is validated by the authoritative GM");
assert.match(lootSocketSource, /createEmbeddedDocuments\("Token"/, "ground drops create a lightweight Token");
assert.doesNotMatch(lootSocketSource, /createEmbeddedDocuments\("Tile"/, "new ground drops never create Tiles");
assert.match(groundLootDataSource, /ensureGroundLootProxyActor/, "ground Item Tokens share one lightweight proxy Actor");
assert.match(groundLootDataSource, /actorId:\s*String\(options\.actorId/, "ground Item Tokens always receive their proxy Actor");
assert.doesNotMatch(groundLootSource, /prototype\._onDragLeftStart\s*=/, "Foundry keeps ownership of the native Token drag lifecycle");
assert.match(groundLootDataSource, /fit:\s*"contain"/, "ground Item artwork remains fully visible");
assert.match(groundLootSource, /migrateGroundLootInfrastructure/, "legacy ground Items are migrated safely");
assert.match(itemTransferSource, /deleteEmbeddedDocuments\("Item"/, "a completed transfer removes the authoritative source Item");
assert.match(lootSocketSource, /const consumeSource = Boolean\(sourceActor\)/, "Directory Items remain reusable templates");
assert.match(lootSocketSource, /buildGroundLootTokenData\(scene, loot/, "ground previews use the exact canvas drop position");
assert.match(lootSocketSource, /if \(gm\.id === game\.user\.id\)/, "the active GM executes ground operations locally without a socket timeout");
assert.match(lootSocketSource, /payload\.local = true/, "local GM operations skip the response round trip");
assert.match(itemTransferSource, /createEmbeddedDocuments\("Item"/, "pickup recreates the Item in the buyer inventory");
assert.match(lootSocketSource, /deleteEmbeddedDocuments\(groundDocument\.documentName/, "pickup removes either a current Token or a legacy Tile");
assert.match(lootSocketSource, /cleanGroundLootName/, "drop and pickup logs use normalized Item names");
assert.match(coordinatorSource, /authoritativeQueue/, "all ground, merchant, and container mutations share one queue");
assert.match(groundLootSource, /canvas\.tokens\.controlled/, "pickup uses the explicitly selected Token");
assert.match(groundLootSource, /khuzoeGroundLootLeftClick/, "clicking ground loot preserves the selected recipient Token");
assert.doesNotMatch(groundLootSource, /owned\(canvas\.tokens\.placeables/, "pickup never falls back to an arbitrary nearby Actor");
assert.match(groundLootSource, /chooseItemQuantity/, "multi-Item drags ask how many to place");
assert.match(quantityDialogSource, /DialogV2\.input/, "quantity choices use the native v14 input dialog");
assert.match(lootSocketSource, /consumeGroundLootDocument/, "partial pickups leave the remaining ground stack in place");
assert.match(lootSocketSource, /request\.quantity/, "the authoritative GM validates the requested pickup quantity");
assert.match(itemTransferSource, /findStackTarget/, "compatible Item stacks merge through the shared transfer layer");
assert.match(lootSocketSource, /lootKind === "currency"/, "ground drops support currencies");
assert.match(lootSocketSource, /planCurrencyTransfer/, "currency movement is validated on the GM client");
assert.match(mainSource, /registerContainers\(\)/, "containers are registered during init");
assert.match(mainSource, /initializeContainers\(\)/, "the container socket starts at ready");
assert.match(mainSource, /initializeProduction\(\)/, "periodic production starts only after the authoritative vault migrations");
assert.equal(moduleManifest.styles.includes("styles/merchant.css"), true, "the main interface stylesheet is loaded");
assert.equal(moduleManifest.styles.includes("styles/v14.css"), true, "the native v14 theme layer is loaded last");
assert.equal(moduleManifest.styles.includes("styles/interface-v2.css"), false, "Foundry only needs the stable historic UI entry point");
assert.match(merchantLoaderStyle, /@import url\("\.\/merchant-legacy\.css\?v=1\.20\.3"\);[\s\S]*@import url\("\.\/interface-v2\.css\?v=1\.20\.3"\);/, "the stable stylesheet loads cache-busted legacy foundations before the redesigned interface");
assert.doesNotMatch(merchantStyle, /\.khuzoe-merchant\s+button\s*\{[\s\S]*?font:\s*inherit/, "module typography never overrides native ApplicationV2 header icons");
assert.match(merchantStyle, /\.khuzoe-merchant \.window-content button\s*\{[\s\S]*?font:\s*inherit/, "module typography remains scoped to content controls");
assert.match(mainSource, /ensureInterfaceStylesheet\(\)/, "module initialization explicitly ensures the redesigned interface stylesheet is present");
assert.match(mainSource, /\["interface-v2", "v14"\]/, "both the interface foundation and native v14 layer are cache-safe");
assert.equal(moduleManifest.styles.includes("styles/container.css"), false, "container styles are bundled to avoid stale Foundry manifests");
assert.equal([...configTemplate.matchAll(/data-km-tab=/g)].length, 3, "merchant configuration separates general, catalog, and production tasks");
assert.equal([...configTemplate.matchAll(/data-km-panel=/g)].length, 3, "every merchant tab owns one panel");
assert.equal([...containerConfigTemplate.matchAll(/data-km-tab=/g)].length, 4, "container configuration separates general, content, lock, and production tasks");
assert.equal([...containerConfigTemplate.matchAll(/data-km-panel=/g)].length, 4, "every container tab owns one panel");
assert.match(uiTabsSource, /ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/, "configuration tabs support keyboard navigation");
assert.match(uiTabsSource, /aria-selected/, "configuration tabs expose their active state to assistive technology");
assert.match(interfaceStyle, /\.km-config-workspace[\s\S]*?overflow-y:\s*auto/, "configuration content has one reliable vertical scroll region");
assert.match(interfaceStyle, /\.km-ui-v2\.is-view-list \.km-shop-card[\s\S]*?width:\s*100%/, "compact player rows use the full available width");
assert.match(interfaceStyle, /@media \(max-width:\s*560px\)/, "the redesigned interfaces include a narrow-window layout");
assert.match(containerSource, /getSceneControlButtons/, "the GM receives a scene control for creating containers");
assert.match(containerSource, /stage\.on\("pointerdown"/, "container creation uses a click-to-place cursor");
assert.match(containerSource, /createEmbeddedDocuments\("Token"/, "containers are real movable Token documents");
assert.match(containerSource, /ensureGroundLootProxyActor/, "containers reuse the lightweight proxy Actor");
assert.match(containerSource, /khuzoeContainerDoubleClick/, "container Tokens open on double-left-click");
assert.doesNotMatch(containerSource, /_canControl|_canDrag|_onDragLeftDrop/, "container movement remains native Foundry behavior");
assert.match(containerDataSource, /locked:\s*false/, "new container Tokens are not locked on the map");
assert.match(containerDataSource, /flags:[\s\S]*CONTAINER_FLAG/, "each Token stores an independent container inventory flag");
assert.match(containerDataSource, /containerItemFingerprint/, "configured keys use a stable Item identity");
assert.match(containerDataSource, /containerIsLocked/, "keyed containers expose an authoritative locked state");
assert.match(containerStoreSource, /ownership:\s*\{ default: CONST\.DOCUMENT_OWNERSHIP_LEVELS\.NONE \}/, "locked contents are copied to a GM-only vault before Token redaction");
assert.match(containerStoreSource, /written\.rollback/, "a failed Actor or Token update restores the previous vault record");
assert.match(containerStoreSource, /createEmbeddedDocuments\("JournalEntryPage"/, "vault records are sharded per merchant or container instead of rewriting one giant snapshot");
assert.match(containerStoreSource, /function publicMerchant[\s\S]*?data:\s*\{\}/, "raw merchant Item snapshots are not exposed on the public Actor flag");
assert.match(containerStoreSource, /function publicContainer[\s\S]*?data:\s*\{\}/, "raw container Item snapshots are not exposed on the public Token flag");
assert.match(containerStoreSource, /publicProduction\(clean\.production\)/, "production Item templates and logs remain in the GM-only vault");
assert.match(containerDataSource, /key: cleanKey\(raw\.key\)/, "container normalization preserves the configured lock key");
assert.match(containerConfigSource, /_onItemDrop/, "the GM can drag Items into container configuration");
assert.match(containerConfigSource, /dragData\.type === "KhuzoeCurrency"/, "currencies can be dragged into container configuration");
assert.match(containerConfigSource, /promptQuantity/, "container deposits ask for the amount to add");
assert.match(containerConfigSource, /requestContainerDeposit/, "container drops use the authoritative transfer flow");
assert.match(containerConfigSource, /_onKeyDrop/, "the GM can associate an Item as the container key");
assert.match(containerConfigTemplate, /km-container-key-drop-zone/, "container configuration includes a dedicated key slot");
assert.match(containerSocketSource, /container-deposit-request/, "container deposits are serialized by the GM");
assert.match(containerSocketSource, /direction: "withdraw"/, "deposited currency is removed from the source wallet");
assert.match(itemTransferSource, /consumeSourceItem/, "a fully deposited Item stack is removed from its source Actor");
assert.match(containerSocketSource, /rollbackConsumedSource/, "failed deposits restore the source Item");
assert.match(containerConfigSource, /data-currency-id/, "the GM can configure every campaign currency");
assert.match(containerConfigTemplate, /km-container-pick-image/, "the container artwork can be selected from Foundry");
assert.match(containerConfigSource, /openFilePicker/, "the container artwork selector uses the Foundry compatibility adapter");
assert.match(foundryCompatSource, /foundry\?\.applications\?\.apps\?\.FilePicker/, "the v14 namespaced FilePicker is preferred");
assert.match(containerConfigTemplate, /type="hidden" name="img"/, "the container image path stays available without cluttering the form");
assert.doesNotMatch(containerConfigTemplate, /type="text" name="img"/, "the token image path is not exposed as a text field");
assert.match(containerConfigSource, /economyCurrencies\(\{ includeInactive: true \}\)/, "the GM can see and recover archived container balances");
assert.match(containerSheetSource, /includeInactive: Boolean\(game\.user\?\.isGM\)/, "archived balances stay hidden from players but visible to the GM");
assert.match(containerSocketSource, /includeInactive: Boolean\(user\?\.isGM\)/, "only the GM can withdraw an archived currency");
assert.match(containerConfigTemplate, /km-container-config-scroll/, "container configuration has one dedicated scroll region");
assert.match(containerConfigTemplate, /km-container-open-loot/, "the GM can open the withdrawal view from container configuration");
assert.match(containerConfigSource, /ContainerSheet\.openForToken/, "the GM withdrawal command uses the normal validated container sheet");
assert.match(containerSheetSource, /!game\.user\?\.isGM/, "the GM can open the withdrawal view regardless of distance");
assert.match(containerSheetTemplate, /km-container-take-all/, "players can take the complete contents");
assert.match(containerSheetTemplate, /km-container-player-drop-zone/, "players can deposit Items and currency from the open container sheet");
assert.match(containerSheetTemplate, /km-container-key-slot/, "an inserted key has a visible slot in the open container");
assert.match(containerSheetSource, /requestContainerKey/, "players can recover the inserted key and close the container");
assert.match(containerSource, /handleContainerCanvasItemDrop/, "dragging an Item onto the container Token is intercepted");
assert.match(groundLootSource, /handleContainerCanvasItemDrop/, "container drops take precedence over ground loot creation");
assert.match(containerSocketSource, /container-key-request/, "key insertion and removal are serialized by the GM");
assert.match(containerSocketSource, /containerKeyMatches\(item, container\.key\)/, "the GM validates the exact configured key");
assert.match(containerSocketSource, /khuzoeMerchantContainerKey/, "inserting the key consumes it through a transactional update");
assert.match(containerSocketSource, /containerIsLocked\(container\) && !user\.isGM/, "locked contents remain unavailable to players");
assert.match(containerSocketSource, /sourceActor\.items\?\.get\?\.\(item\.id\)/, "key insertion verifies the source inventory changed");
assert.match(containerSocketSource, /buyerActor\.createEmbeddedDocuments\([\s\S]*?khuzoeMerchantContainerKey/, "key removal creates a physical Item in the recipient inventory");
assert.match(containerSocketSource, /buyerActor\.items\?\.get\?\.\(createdKey\.id\)/, "the chest only closes after the returned key is found in the recipient inventory");
assert.match(containerSocketSource, /setProperty\(keyData, "system\.container", null\)/, "returned keys are visible at the top level of D&D5e inventory");
assert.match(containerSheetSource, /promptQuantity/, "individual container withdrawals ask for an amount");
assert.doesNotMatch(containerSheetTemplate, /km-container-quantity/, "container cards avoid a duplicate inline quantity field");
assert.match(containerSheetTemplate, /km-container-content-scroll/, "player containers keep header controls outside the scroll region");
assert.match(containerSheetTemplate, /km-container-details-button/, "compact Item rows expose their full details");
assert.match(containerSheetTemplate, /km-card-image-button/, "container Item images can be enlarged");
assert.match(containerSheetSource, /containerDistance/, "opening and taking content both honor interaction distance");
assert.match(containerSocketSource, /primaryGM\(\)/, "container transfers run on the authoritative GM");
assert.match(containerSocketSource, /enqueueAuthoritativeRequest/, "container withdrawals use the shared idempotent transaction coordinator");
assert.match(containerSocketSource, /isActorOwner\(buyerActor, user\)/, "the GM validates ownership of the recipient Actor");
assert.match(itemTransferSource, /createEmbeddedDocuments\("Item"/, "container Items are recreated in the recipient inventory");
assert.match(containerSocketSource, /planCurrencyTransfer/, "container currencies use the shared campaign economy");
assert.match(containerSocketSource, /request\.mode === "all"/, "take-all transfers Items and currencies in one request");
assert.match(containerSocketSource, /emptyBehavior === "delete"/, "an empty container can remove its Token");
assert.match(containerSocketSource, /rollbackItemTransfers/, "failed withdrawals restore recipient inventory changes");
assert.match(itemTransferSource, /createWithContents/, "D&D5e Item containers retain their nested contents");
assert.match(itemTransferSource, /system\.container", null/, "top-level transferred Items are detached from their previous container");
assert.match(coordinatorSource, /completedRequests/, "completed request IDs are retained for idempotent replay");
assert.match(coordinatorSource, /transactionLedger/, "recent completed request IDs survive an authoritative GM handoff");
assert.match(coordinatorSource, /transaction-status-request/, "clients query a timed-out transaction instead of blindly repeating it");
assert.match(merchantStyle, /km-container-currency-panel/, "currency content has a dedicated readable panel");
assert.match(merchantStyle, /container-name:\s*km-container-window/, "container layouts respond to their window width");
assert.match(merchantStyle, /scrollbar-gutter:\s*stable/, "container scroll regions reserve visible scrollbar space");
assert.match(merchantStyle, /km-container-key-slot/, "the bundled Foundry stylesheet includes the inserted-key cell");
assert.match(merchantStyle, /km-container-player-drop-zone/, "the bundled stylesheet includes the player deposit target");
assert.match(merchantStyle, /km-container-shell\.is-view-list[\s\S]*?grid-template-columns:\s*66px minmax\(0, 1fr\) minmax\(252px, 0\.8fr\)/, "compact rows use container-specific proportions");
assert.match(merchantStyle, /Bundled container interface/, "container styles ship inside Foundry's long-lived main stylesheet");
assert.match(merchantStyle, /\.khuzoe-container \.km-container-currency-input > img,[\s\S]*?width:\s*30px\s*!important/, "the bundled compatibility rules keep currency icons compact");
assert.match(productionSource, /Hooks\.on\("updateWorldTime"/, "world-time changes trigger due production checks");
assert.match(productionSource, /setInterval[\s\S]*60000/, "real-time production is checked without a busy loop");
assert.match(productionSource, /enqueueTransaction/, "production shares the authoritative mutation queue");
assert.match(productionDataSource, /totalDue - due/, "excess offline cycles are skipped instead of producing an unbounded backlog");
assert.match(containerDataSource, /production\.enabled && normalized\.production\.rules\.length/, "productive containers are not deleted merely because their current stock is empty");

const itemTransfer = await import("../scripts/item-transfer.js");
const containerData = await import("../scripts/container-data.js");
const coordinator = await import("../scripts/transaction-coordinator.js");
globalThis.CONFIG = {
  Item: {
    documentClass: {
      createWithContents: async ([root], { keepId = false, transformAll } = {}) => {
        const child = [...(await root.system.contents)][0];
        const rootData = await transformAll(root, { depth: 0, container: null });
        const childData = await transformAll(child, { depth: 1, container: rootData._id });
        rootData._id = keepId ? root.id : foundry.utils.randomID();
        childData._id = keepId ? child.id : foundry.utils.randomID();
        foundry.utils.setProperty(rootData, "system.container", null);
        foundry.utils.setProperty(childData, "system.container", rootData._id);
        return [rootData, childData];
      }
    }
  }
};
const nestedChild = {
  id: "child-id",
  name: "Gemma",
  type: "loot",
  system: { quantity: 1, contents: [] },
  toObject: () => ({ _id: "child-id", name: "Gemma", type: "loot", system: { quantity: 1, container: "root-id" } })
};
const nestedRoot = {
  id: "root-id",
  name: "Zaino",
  type: "container",
  system: { quantity: 1, contents: [nestedChild] },
  toObject: () => ({ _id: "root-id", name: "Zaino", type: "container", system: { quantity: 1, container: "old-parent" } })
};
const nestedBundle = await itemTransfer.prepareItemBundle(nestedRoot, { quantity: 1 });
assert.equal(nestedBundle.length, 2, "D&D5e nested Item contents are included in the transfer bundle");
assert.equal(nestedBundle[0].system.container, null, "the transferred root is detached from its old container");
assert.equal(nestedBundle[1].system.container, nestedBundle[0]._id, "nested Item links are rebuilt against the new root ID");
const weaponData = { name: "Spada", type: "weapon", system: { quantity: 1, damage: "1d8" } };
assert.equal(itemTransfer.itemStackKey(weaponData), null, "weapons are never merged merely because they have quantity");
const potionA = { name: "Pozione", type: "consumable", system: { quantity: 1, uses: { max: 1 } } };
const potionB = { name: "Pozione", type: "consumable", system: { quantity: 1, uses: { max: 2 } } };
assert.notEqual(
  itemTransfer.itemStackKey(potionA),
  itemTransfer.itemStackKey(potionB),
  "customized consumables do not merge only because their source or name matches"
);
const legacyKey = {
  name: "Chiave",
  type: "loot",
  system: { quantity: 1 },
  flags: { "khuzoe-merchant": {} }
};
const keyFingerprint = containerData.containerItemFingerprint(legacyKey);
const returnedKey = structuredClone(legacyKey);
returnedKey.flags["khuzoe-merchant"].containerKey = { returnedAt: "now" };
assert.equal(
  containerData.containerKeyMatches(returnedKey, { fingerprint: keyFingerprint }),
  true,
  "a returned key remains valid after module transfer metadata is added"
);
let executions = 0;
const idempotentRequest = { requestId: "same-request" };
const firstResult = await coordinator.enqueueAuthoritativeRequest({
  request: idempotentRequest,
  senderUserId: "player",
  execute: async () => ({ ok: true, count: ++executions })
});
const replayedResult = await coordinator.enqueueAuthoritativeRequest({
  request: idempotentRequest,
  senderUserId: "player",
  execute: async () => ({ ok: true, count: ++executions })
});
assert.deepEqual(replayedResult, firstResult);
assert.equal(executions, 1, "the same authenticated request can mutate state only once");

class TestApplicationV2 {
  static DEFAULT_OPTIONS = {};

  constructor(options = {}) {
    this.options = options;
  }

  render(options) {
    this.renderOptions = options;
    return this;
  }

  async _prepareContext() { return {}; }
  async _onRender() {}
  bringToFront() { this.broughtToFront = true; }
  async close() { this.closed = true; return this; }
}
class TestFilePickerV2 extends TestApplicationV2 {}
class TestImagePopoutV2 extends TestApplicationV2 {}
globalThis.foundry.applications = {
  api: {
    ApplicationV2: TestApplicationV2,
    HandlebarsApplicationMixin: (Base) => class extends Base {},
    DialogV2: class TestDialogV2 extends TestApplicationV2 {
      static async input() { return null; }
      static async confirm() { return false; }
    }
  },
  apps: { FilePicker: TestFilePickerV2, ImagePopout: TestImagePopoutV2 },
  instances: new Map()
};
const compat = await import("../scripts/foundry-compat.js");
const filePickerV2 = compat.openFilePicker({ type: "image", current: "icons/test.webp" });
assert.equal(filePickerV2.options.current, "icons/test.webp", "the v14 FilePicker receives the current image path");
assert.deepEqual(filePickerV2.renderOptions, { force: true }, "the v14 FilePicker is force-rendered with ApplicationV2 options");
const imagePopoutV2 = compat.openImagePopout("icons/test.webp", { title: "Immagine" });
assert.equal(imagePopoutV2.options.src, "icons/test.webp", "the v14 ImagePopout receives its image in the options object");
assert.equal(imagePopoutV2.options.window.title, "Immagine", "the v14 ImagePopout title uses window options");
assert.deepEqual(imagePopoutV2.renderOptions, { force: true }, "the v14 ImagePopout is force-rendered with ApplicationV2 options");
compat.rerenderApplication(imagePopoutV2);
assert.deepEqual(imagePopoutV2.renderOptions, { force: false }, "existing ApplicationV2 sheets rerender through v14 options");
const trackedApplicationV2 = new TestApplicationV2();
globalThis.foundry.applications.instances.set("tracked", trackedApplicationV2);
globalThis.ui = { windows: { legacy: { render: () => {} } } };
assert.equal(compat.openApplications().has(trackedApplicationV2), true, "the v14 application registry participates in refreshes");

const onceHooks = new Map();
const onHooks = new Map();
globalThis.Hooks = {
  once: (name, callback) => onceHooks.set(name, callback),
  on: (name, callback) => {
    const callbacks = onHooks.get(name) || [];
    callbacks.push(callback);
    onHooks.set(name, callbacks);
  }
};
globalThis.loadTemplates = () => {};
globalThis.game.settings.registerMenu = () => {};
globalThis.game.user = { id: "player", isGM: false };
globalThis.game.i18n.localize = (key) => key;
globalThis.game.i18n.format = (key) => key;
globalThis.game.settings.register = () => {};
globalThis.foundry.utils.mergeObject = (base, update) => ({ ...base, ...update });

class NativeToken {
  constructor(actor) {
    this.actor = actor;
  }

  _canView() {
    return false;
  }

  _onClickLeft2() {
    this.originalDoubleClickCalled = true;
  }
}

class TestToken extends NativeToken {}
globalThis.foundry.canvas = { placeables: { Token: NativeToken } };
globalThis.CONFIG = { Token: { objectClass: TestToken } };
const appendedInterfaceStyles = [];
globalThis.document.head = { append: (node) => { appendedInterfaceStyles.push(node); } };
globalThis.document.querySelectorAll = () => [];
globalThis.document.getElementById = () => null;
globalThis.game.modules = new Map([["khuzoe-merchant", { version: "1.20.3" }]]);

const { MerchantShop } = await import("../scripts/merchant-shop.js");
const { ContainerSheet } = await import("../scripts/container-sheet.js");
const originalOpenForToken = MerchantShop.openForToken;
const originalOpenContainer = ContainerSheet.openForToken;
let openedToken = null;
let openedContainer = null;
MerchantShop.openForToken = async (token) => {
  openedToken = token;
  return token;
};
ContainerSheet.openForToken = async (token) => {
  openedContainer = token;
  return token;
};

await import("../scripts/main.js");
onceHooks.get("init")();
assert.deepEqual(
  appendedInterfaceStyles.map((style) => style.id),
  ["khuzoe-merchant-interface-v2", "khuzoe-merchant-v14"],
  "init injects both missing UI layers when Foundry retained an old manifest"
);
assert.match(appendedInterfaceStyles[0]?.href || "", /interface-v2\.css\?kmv=1\.20\.3$/, "the injected interface foundation bypasses stale caches");
assert.match(appendedInterfaceStyles[1]?.href || "", /v14\.css\?kmv=1\.20\.3$/, "the native v14 theme bypasses stale caches");

game.user.isGM = true;
const headerControls = [];
const actorForV14Sheet = {
  id: "v14-npc",
  documentName: "Actor",
  type: "npc",
  getFlag: () => null
};
onHooks.get("getHeaderControlsApplicationV2")[0]({ document: actorForV14Sheet }, headerControls);
assert.equal(headerControls[0]?.action, "khuzoeMerchantConfigure", "the v14 Actor sheet exposes the merchant configuration control");
assert.equal(typeof headerControls[0]?.onClick, "function", "the v14 header control keeps a direct configuration action");

const sceneControls = { tokens: { tools: { select: { name: "select" } } } };
onHooks.get("getSceneControlButtons")[0](sceneControls);
assert.equal(typeof sceneControls.tokens.tools["khuzoe-container-create"]?.onChange, "function", "the v14 Token controls expose container placement through onChange");
game.user.isGM = false;

const merchantToken = new TestToken({ getFlag: () => ({ enabled: true }) });
assert.equal(merchantToken._canView(game.user, {}), true, "players may interact with active merchant tokens");
await merchantToken._onClickLeft2({ preventDefault() {}, stopPropagation() {} });
assert.equal(openedToken, merchantToken, "player double-left-click reaches the merchant shop");

const containerToken = new TestToken({ getFlag: () => ({ enabled: false }) });
containerToken.getFlag = (_scope, key) => key === "container" ? {
  name: "Forziere di prova", inventory: [], currency: {}
} : null;
assert.equal(containerToken._canView(game.user, {}), true, "players may interact with container Tokens");
await containerToken._onClickLeft2({ preventDefault() {}, stopPropagation() {} });
assert.equal(openedContainer, containerToken, "player double-left-click reaches the container sheet");

const ordinaryToken = new TestToken({ getFlag: () => ({ enabled: false }) });
assert.equal(ordinaryToken._canView(game.user, {}), false, "ordinary NPC view permissions remain unchanged");
await ordinaryToken._onClickLeft2({});
assert.equal(ordinaryToken.originalDoubleClickCalled, true, "ordinary NPCs retain Foundry's original behavior");
MerchantShop.openForToken = originalOpenForToken;
ContainerSheet.openForToken = originalOpenContainer;

console.log("Khuzoe Merchant module tests passed.");
