/** Shared boundary between native V14 applications and third-party system sheets. */

export const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;
export const HandlebarsApplicationV2 = HandlebarsApplicationMixin(ApplicationV2);
export const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;

/** Bind one handler to every matching element while preserving currentTarget. */
export function bindElements(root, selector, events, handler) {
  if (!root?.querySelectorAll || typeof handler !== "function") return;
  const eventNames = Array.isArray(events) ? events : String(events || "").split(/\s+/).filter(Boolean);
  for (const element of root.querySelectorAll(selector)) {
    for (const eventName of eventNames) element.addEventListener(eventName, handler);
  }
}

export function applicationRoot(html, app = null) {
  const HTMLElementClass = globalThis.HTMLElement;
  if (HTMLElementClass && html instanceof HTMLElementClass) return html;
  if (HTMLElementClass && html?.[0] instanceof HTMLElementClass) return html[0];
  if (HTMLElementClass && html?.element instanceof HTMLElementClass) return html.element;
  if (HTMLElementClass && app?.element instanceof HTMLElementClass) return app.element;
  return null;
}

export function openApplications() {
  const applications = new Set();
  for (const app of Object.values(globalThis.ui?.windows || {})) applications.add(app);

  const instances = globalThis.foundry?.applications?.instances;
  if (instances?.values) {
    for (const app of instances.values()) applications.add(app);
  }
  return applications;
}

export function rerenderApplication(app, { force = false } = {}) {
  if (!app?.render) return null;
  const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
  if (ApplicationV2 && app instanceof ApplicationV2) return app.render({ force });
  return app.render(force);
}

export function openFilePicker(options = {}) {
  const FilePickerClass = globalThis.foundry?.applications?.apps?.FilePicker
    || globalThis.FilePicker;
  if (typeof FilePickerClass !== "function") return null;

  const picker = new FilePickerClass(options);
  const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
  if (ApplicationV2 && picker instanceof ApplicationV2) picker.render({ force: true });
  else picker.render(true);
  return picker;
}

export function openImagePopout(src, { title = "", uuid = null } = {}) {
  if (!src) return null;
  const ImagePopoutV2 = globalThis.foundry?.applications?.apps?.ImagePopout;
  if (typeof ImagePopoutV2 === "function") {
    const popout = new ImagePopoutV2({
      src,
      uuid,
      window: { title }
    });
    popout.render({ force: true });
    return popout;
  }

  const ImagePopoutV1 = globalThis.ImagePopout;
  if (typeof ImagePopoutV1 !== "function") return null;
  const popout = new ImagePopoutV1(src, { title, shareable: false });
  popout.render(true);
  return popout;
}
