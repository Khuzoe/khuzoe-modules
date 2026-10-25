import { MODULE_ID } from "./calendar-math.mjs";
import { CalendarController } from "./controller.mjs";
import { CalendarWindow, configureApps, openCalendar, updateViews } from "./apps.mjs";

const controller = new CalendarController();
configureApps(controller);
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "binding", { scope: "world", config: false, type: Object, default: { enabled: false }, onChange: () => { if (game.ready) controller.applyBinding(); } });
  game.settings.register(MODULE_ID, "showClock", { name: "Mostra l'orologio compatto", hint: "Apre il calendario con un clic. Questa preferenza vale solo per te.", scope: "client", config: true, type: Boolean, default: true, onChange: () => { if (game.ready) updateViews(); } });
  game.settings.register(MODULE_ID, "clockPosition", { scope: "client", config: false, type: Object, default: {} });
  game.settings.registerMenu(MODULE_ID, "calendar", { name: "Calendario della campagna", label: "Apri calendario", hint: "Data, eventi e note condivisi con la wiki.", icon: "fa-solid fa-calendar-days", type: CalendarWindow, restricted: false });
  game.keybindings.register(MODULE_ID, "openCalendar", { name: "Apri calendario", editable: [{ key: "KeyK", modifiers: ["Shift"] }], onDown: () => { openCalendar(); return true; }, restricted: false });
});
Hooks.on("getSceneControlButtons", controls => {
  const tokens = Array.isArray(controls) ? controls.find(c => c.name === "token") : controls.tokens || controls.token;
  if (!tokens?.tools) return;
  const tool = { name: MODULE_ID, title: "Calendario della campagna", icon: "fa-solid fa-calendar-days", button: true, visible: true, onChange: openCalendar };
  if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: openCalendar });
  else tokens.tools[MODULE_ID] = { ...tool, order: Object.keys(tokens.tools).length };
});
Hooks.on("updateWorldTime", (...args) => controller.onWorldTime(...args));
Hooks.on("updateUser", () => { if (game.ready) controller.onUsersChanged(); });
Hooks.on("userConnected", () => { if (game.ready) controller.onUsersChanged(); });
Hooks.on("khuzoeWikiSync.authChanged", () => controller.onContextChanged());
Hooks.on(`${MODULE_ID}.change`, () => { if (game.ready) updateViews(); });
Hooks.on("updateSetting", (setting) => {
  if (game.ready && ["cripta-wiki-sync.campaignId", "cripta-wiki-sync.discordToken", "cripta-wiki-sync.syncMode"].includes(setting.key)) {
    controller.onContextChanged();
  }
});
Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = Object.freeze({ open: openCalendar, refresh: () => controller.refresh() });
  game.socket.on(`module.${MODULE_ID}`, message => controller.onRemoteChanged(message));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) controller.scheduleHint(); });
  // Let dependency ready hooks expose their service before the first request.
  setTimeout(() => void controller.start().catch(error => ui.notifications.error(error.message)), 0);
});
