import { MODULE_ID, MODULE_TITLE, SETTINGS } from "./constants.js";
import { MonsterHudConfig } from "./config-app.js";
import { canUserAccessHudActor, MonsterHudController } from "./hud.js";

const hud = new MonsterHudController();

Hooks.once("init", () => {
  registerSettings();
  game.khuzoeMonsterHud = {
    render: () => hud.requestRender(),
    getToken: () => hud.currentTokenDocument(),
    configure: token => {
      const document = token?.document ?? token ?? hud.currentTokenDocument();
      if (!document) return null;
      if (!canUserAccessHudActor(document.actor, game.user)) {
        ui.notifications.warn(game.i18n.localize("KHMH.Errors.OwnerRequired"));
        return null;
      }
      const app = new MonsterHudConfig(document, { onSave: () => hud.requestRender() });
      app.render({ force: true });
      return app;
    }
  };
});

Hooks.once("ready", () => {
  if (game.system?.id !== "dnd5e") {
    ui.notifications.error(game.i18n.localize("KHMH.Errors.WrongSystem"), { permanent: true });
    return;
  }
  hud.initialize();
  console.info(`${MODULE_TITLE} | Ready for Foundry ${game.version} and dnd5e ${game.system.version}.`);
});

for (const hookName of ["canvasReady", "controlToken", "updateToken", "deleteToken", "updateCombat", "updateCombatant"]) {
  Hooks.on(hookName, () => hud.requestRender());
}

for (const hookName of ["createItem", "updateItem", "deleteItem", "updateActor"]) {
  Hooks.on(hookName, document => {
    const actor = document?.documentName === "Actor" ? document : document?.parent;
    const current = hud.currentTokenDocument()?.actor;
    if (!actor || !current || (actor.uuid !== current.uuid && actor.id !== current.id)) return;
    hud.requestRender();
  });
}

for (const hookName of ["createChatMessage", "updateChatMessage", "deleteChatMessage"]) {
  Hooks.on(hookName, () => hud.requestRender());
}

Hooks.on("dnd5e.postUseActivity", activity => {
  void hud.handlePostUseActivity(activity).catch(error => {
    console.error(`${MODULE_TITLE} | Multiattack tracking failed.`, error);
  });
});

Hooks.on("khuzoeMonsterHud.configUpdated", () => hud.requestRender());

Hooks.on("renderTokenHUD", (tokenHud, html) => {
  const token = tokenHud.object;
  if (!token?.document) return;
  if (!canUserAccessHudActor(token.actor, game.user)) return;

  const HTMLElementClass = globalThis.HTMLElement;
  const root = HTMLElementClass && html instanceof HTMLElementClass ? html : html?.[0];
  if (!root?.querySelector || root.querySelector(".khmh-token-control")) return;
  const column = root.querySelector(".col.right") ?? root;
  const control = document.createElement("div");
  control.className = "control-icon khmh-token-control";
  control.dataset.tooltip = "KHMH.HUD.Configure";
  control.innerHTML = '<i class="fa-solid fa-dragon"></i>';
  control.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    game.khuzoeMonsterHud.configure(token.document);
  });
  column.append(control);
});

function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.ENABLED, {
    name: "KHMH.Settings.Enabled.Name",
    hint: "KHMH.Settings.Enabled.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => hud.requestRender()
  });
  game.settings.register(MODULE_ID, SETTINGS.FOLLOW_COMBAT, {
    name: "KHMH.Settings.FollowCombat.Name",
    hint: "KHMH.Settings.FollowCombat.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => hud.requestRender()
  });
  game.settings.register(MODULE_ID, SETTINGS.ALLOW_OWNERS, {
    name: "KHMH.Settings.AllowOwners.Name",
    hint: "KHMH.Settings.AllowOwners.Hint",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: () => hud.requestRender()
  });
  game.settings.register(MODULE_ID, SETTINGS.ANCHOR, {
    name: "KHMH.Settings.Anchor.Name",
    hint: "KHMH.Settings.Anchor.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      left: "KHMH.Settings.Anchor.Left",
      center: "KHMH.Settings.Anchor.Center",
      right: "KHMH.Settings.Anchor.Right"
    },
    default: "center",
    onChange: () => hud.requestRender()
  });
  game.settings.register(MODULE_ID, SETTINGS.SCALE, {
    name: "KHMH.Settings.Scale.Name",
    hint: "KHMH.Settings.Scale.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0.75, max: 1.25, step: 0.05 },
    default: 1,
    onChange: () => hud.requestRender()
  });
  game.settings.register(MODULE_ID, SETTINGS.POSITION, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: () => hud.requestRender()
  });
}
