import { MODULE_ID, TEMPLATES } from "./constants.js";
import { registerActorWallet } from "./actor-wallet.js";
import { containerApi, initializeContainers, registerContainers, synchronizeContainerSourceItem } from "./container.js";
import { ContainerSheet } from "./container-sheet.js";
import { denominationOptions, formatCost, normalizeCost, planDeduction, readWallet } from "./currency-v2.js";
import { economyApi } from "./economy.js";
import { groundLootApi, initializeGroundLoot, registerGroundLoot } from "./ground-loot.js";
import { registerGroundLootIntegration, initializeGroundLootIntegration } from "./ground-loot-integration.js";
import { MerchantConfig } from "./merchant-config.js";
import { MerchantShop } from "./merchant-shop.js";
import { registerSettings } from "./settings.js";
import { initializeSocket } from "./socket.js";
import { enqueueTransaction, initializeTransactionCoordinator } from "./transaction-coordinator.js";
import { prepareItemBundle } from "./item-transfer.js";
import { getAuthoritativeMerchant, migrateContainersToVault, migrateMerchantsToVault, saveAuthoritativeMerchant } from "./container-store.js";
import { initializeProduction, productionApi } from "./production.js";
import { canonicalActor, getMerchant, isSupportedActor, itemDescription, localize, log } from "./utils.js";

function ensureInterfaceStylesheet() {
  const head = globalThis.document?.head;
  if (!head || typeof document.createElement !== "function") return;
  const version = String(game.modules?.get?.(MODULE_ID)?.version || "1.21.1");
  const links = [...(document.querySelectorAll?.("link[rel='stylesheet']") || [])];
  for (const stylesheet of ["interface-v2", "v14"]) {
    const id = `khuzoe-merchant-${stylesheet}`;
    const source = `modules/${MODULE_ID}/styles/${stylesheet}.css?kmv=${encodeURIComponent(version)}`;
    const existing = document.getElementById?.(id)
      || links.find((link) => String(link.href || "").includes(`/${MODULE_ID}/styles/${stylesheet}.css`));
    if (existing) {
      existing.id = id;
      if (!String(existing.href || "").includes(`kmv=${encodeURIComponent(version)}`)) existing.href = source;
      continue;
    }
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = source;
    head.append(link);
  }
}

function canonicalMerchantActor(actor) {
  return canonicalActor(actor);
}

async function openConfiguration(actor) {
  const canonicalActor = canonicalMerchantActor(actor);
  if (!game.user.isGM || !isSupportedActor(canonicalActor)) return;
  await MerchantConfig.openForActor(canonicalActor);
}

async function synchronizeMerchantSourceItem(item) {
  MerchantConfig.refreshForItem(item);
  MerchantShop.refreshForDocument(item);
  if (!game.user?.isGM) return;
  if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return;

  return enqueueTransaction(async () => {
    const itemData = item.toObject();
    const preparedBundle = await prepareItemBundle(item, { quantity: 1 });
    const dataBundle = preparedBundle.length > 1 ? preparedBundle : undefined;
    for (const actor of game.actors ?? []) {
      const visible = getMerchant(actor);
      if (!visible.inventory.some((entry) => entry.sourceUuid === item.uuid)) continue;
      const current = await getAuthoritativeMerchant(actor);
      const merchant = foundry.utils.deepClone(current);
      merchant.revision = current.revision + 1;
      merchant.schemaVersion = 2;
      merchant.inventory = merchant.inventory.map((entry) => {
        if (entry.sourceUuid !== item.uuid) return entry;
        return {
          ...entry,
          name: String(item.name ?? entry.name ?? "Item").slice(0, 120),
          img: item.img || entry.img || "icons/svg/item-bag.svg",
          type: String(item.type ?? entry.type ?? "item").slice(0, 60),
          description: itemDescription(item),
          data: foundry.utils.deepClone(itemData),
          dataBundle: dataBundle ? foundry.utils.deepClone(dataBundle) : undefined
        };
      });
      merchant.production.rules = merchant.production.rules.map((rule) => {
        if (rule.sourceUuid !== item.uuid) return rule;
        return {
          ...rule,
          name: String(item.name ?? rule.name ?? "Item").slice(0, 120),
          img: item.img || rule.img || "icons/svg/item-bag.svg",
          type: String(item.type ?? rule.type ?? "item").slice(0, 60),
          description: itemDescription(item),
          data: foundry.utils.deepClone(itemData),
          dataBundle: dataBundle ? foundry.utils.deepClone(dataBundle) : undefined
        };
      });
      await saveAuthoritativeMerchant(actor, merchant);
    }
  }, "merchant source synchronization");
}

function actorFromSheet(app) {
  const actor = app?.actor ?? app?.document ?? app?.object;
  return canonicalMerchantActor(actor);
}

async function adoptSyntheticMerchantFlags() {
  if (!game.user?.isGM) return 0;
  if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return 0;

  const candidatesByActor = new Map();
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (!token?.actorId || token.actorLink) continue;
      const baseActor = game.actors?.get(token.actorId);
      if (!baseActor || baseActor.getFlag(MODULE_ID, "merchant")) continue;
      const stored = token.actor?.getFlag?.(MODULE_ID, "merchant");
      if (!stored || typeof stored !== "object") continue;
      const candidates = candidatesByActor.get(baseActor.id) ?? [];
      candidates.push({ scene: scene.name, token: token.name, merchant: stored });
      candidatesByActor.set(baseActor.id, candidates);
    }
  }

  let adopted = 0;
  for (const [actorId, candidates] of candidatesByActor) {
    const baseActor = game.actors.get(actorId);
    if (!baseActor || baseActor.getFlag(MODULE_ID, "merchant")) continue;
    candidates.sort((left, right) => {
      const enabled = Number(Boolean(right.merchant.enabled)) - Number(Boolean(left.merchant.enabled));
      if (enabled) return enabled;
      return (right.merchant.inventory?.length ?? 0) - (left.merchant.inventory?.length ?? 0);
    });
    const signatures = new Set(candidates.map(({ merchant }) => JSON.stringify(merchant)));
    if (signatures.size > 1) {
      console.warn(`${MODULE_ID} | Più configurazioni token per ${baseActor.name}; adotto quella attiva con più articoli senza eliminare le altre.`, {
        tokens: candidates.map(({ scene, token }) => `${scene}: ${token}`)
      });
    }
    await saveAuthoritativeMerchant(baseActor, foundry.utils.deepClone(candidates[0].merchant));
    adopted += 1;
  }
  if (adopted) log(`Adottati ${adopted} negozi token sugli Actor principali.`);
  return adopted;
}

function addActorHeaderButton(app, buttons) {
  if (!game.user.isGM) return;
  const actor = actorFromSheet(app);
  if (!isSupportedActor(actor)) return;
  if (buttons.some((button) => button.class === "khuzoe-merchant-configure")) return;

  const enabled = getMerchant(actor).enabled;
  buttons.unshift({
    label: localize(enabled ? "KM.Header.MerchantActive" : "KM.Header.Merchant"),
    class: "khuzoe-merchant-configure",
    icon: "fas fa-store",
    onclick: () => openConfiguration(actor)
  });
}

function addActorHeaderControlV2(app, controls) {
  if (!game.user?.isGM || !Array.isArray(controls)) return;
  const actor = actorFromSheet(app);
  if (!isSupportedActor(actor)) return;
  if (controls.some((control) => control.action === "khuzoeMerchantConfigure")) return;

  const enabled = getMerchant(actor).enabled;
  controls.unshift({
    action: "khuzoeMerchantConfigure",
    label: localize(enabled ? "KM.Header.MerchantActive" : "KM.Header.Merchant"),
    icon: "fa-solid fa-store",
    classes: "khuzoe-merchant-configure",
    visible: true,
    onClick: () => openConfiguration(actor)
  });
}

function patchMerchantTokenClass(tokenClass) {
  const prototype = tokenClass?.prototype;
  if (!prototype) return;

  const originalCanView = prototype._canView;
  if (typeof originalCanView === "function" && !originalCanView._khuzoeMerchantPatched) {
    const patchedCanView = function khuzoeMerchantCanView(user, event) {
      if (!user?.isGM && getMerchant(this.actor).enabled) return true;
      return originalCanView.call(this, user, event);
    };
    patchedCanView._khuzoeMerchantPatched = true;
    patchedCanView._khuzoeMerchantOriginal = originalCanView;
    prototype._canView = patchedCanView;
  }

  const originalDoubleClick = prototype._onClickLeft2;
  if (typeof originalDoubleClick === "function" && !originalDoubleClick._khuzoeMerchantPatched) {
    const patchedDoubleClick = async function khuzoeMerchantDoubleClick(event) {
      if (!game.user.isGM && getMerchant(this.actor).enabled) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return MerchantShop.openForToken(this);
      }
      return originalDoubleClick.call(this, event);
    };
    patchedDoubleClick._khuzoeMerchantPatched = true;
    patchedDoubleClick._khuzoeMerchantOriginal = originalDoubleClick;
    prototype._onClickLeft2 = patchedDoubleClick;
  }
}

function patchMerchantTokenInteractions() {
  const TokenClass = globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.foundry?.canvas?.placeables?.Token;
  const tokenClasses = new Set([
    TokenClass
  ].filter(Boolean));
  for (const tokenClass of tokenClasses) {
    patchMerchantTokenClass(tokenClass);
    log(`Player merchant interaction enabled for ${tokenClass.name}`);
  }
}

Hooks.once("init", () => {
  ensureInterfaceStylesheet();
  registerSettings();
  registerActorWallet();
  registerGroundLoot();
  registerGroundLootIntegration();
  registerContainers();
  loadTemplates(Object.values(TEMPLATES));
  patchMerchantTokenInteractions();

  Hooks.on("getActorSheetHeaderButtons", addActorHeaderButton);
  Hooks.on("getHeaderControlsApplicationV2", addActorHeaderControlV2);
  Hooks.on("updateActor", (actor) => {
    MerchantShop.refreshForDocument(actor);
    ContainerSheet.refreshForDocument(actor);
  });
  Hooks.on("updateToken", (token) => {
    MerchantShop.refreshForDocument(token);
    ContainerSheet.refreshForDocument(token);
  });
  Hooks.on("updateItem", (item, _changes, options = {}) => {
    synchronizeMerchantSourceItem(item).catch((error) => {
      console.error(`${MODULE_ID} | Impossibile sincronizzare l'Oggetto del mercante`, error);
    });
    if (!options.khuzoeMerchantContainerDeposit && !options.khuzoeMerchantRollback) {
      synchronizeContainerSourceItem(item).catch((error) => {
        console.error(`${MODULE_ID} | Impossibile sincronizzare l'Oggetto del contenitore`, error);
      });
    }
  });
  Hooks.on("deleteToken", (token) => {
    MerchantShop.closeForToken(token);
    ContainerSheet.closeForToken(token);
  });
});

Hooks.once("ready", async () => {
  initializeTransactionCoordinator();
  initializeSocket();
  initializeGroundLoot();
  initializeGroundLootIntegration();
  initializeContainers();
  game.modules.get(MODULE_ID).api = {
    MerchantConfig,
    MerchantShop,
    configure: openConfiguration,
    open: MerchantShop.openForToken,
    groundLoot: groundLootApi(),
    containers: containerApi(),
    production: productionApi(),
    economy: {
      ...economyApi(),
      denominations: denominationOptions,
      normalizeCost,
      formatCost,
      readWallet,
      planDeduction
    }
  };
  await adoptSyntheticMerchantFlags();
  await enqueueTransaction(() => migrateMerchantsToVault(), "merchant vault migration");
  await enqueueTransaction(() => migrateContainersToVault(), "container vault migration");
  initializeProduction();
  log("Pronto per Foundry Virtual Tabletop v14");
});
