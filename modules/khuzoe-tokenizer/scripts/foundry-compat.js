/** Native Foundry V14 application and file-system boundary. */

const api = globalThis.foundry?.applications?.api;

export const ApplicationV2 = api?.ApplicationV2;
export const HandlebarsApplicationV2 = api?.HandlebarsApplicationMixin?.(ApplicationV2);

export function applicationRoot(html, app = null) {
  if (html?.nodeType === 1) return html;
  if (html?.[0]?.nodeType === 1) return html[0];
  if (html?.element?.nodeType === 1) return html.element;
  if (app?.element?.nodeType === 1) return app.element;
  const HTMLElementClass = globalThis.HTMLElement;
  if (HTMLElementClass && html instanceof HTMLElementClass) return html;
  if (HTMLElementClass && html?.[0] instanceof HTMLElementClass) return html[0];
  if (HTMLElementClass && html?.element instanceof HTMLElementClass) return html.element;
  if (HTMLElementClass && app?.element instanceof HTMLElementClass) return app.element;
  return null;
}

export function openApplications() {
  const applications = new Set(Object.values(globalThis.ui?.windows || {}));
  const instances = globalThis.foundry?.applications?.instances;
  if (instances?.values) {
    for (const app of instances.values()) applications.add(app);
  }
  return applications;
}

export function findOpenApplication(id) {
  if (!id) return null;
  return globalThis.foundry?.applications?.instances?.get?.(id)
    || Object.values(globalThis.ui?.windows || {}).find((app) => app?.id === id)
    || null;
}

export function renderApplication(app, { force = false } = {}) {
  if (!app?.render) return null;
  if (ApplicationV2 && app instanceof ApplicationV2) return app.render({ force });
  return app.render(force);
}

export function bringApplicationToFront(app) {
  if (!app) return;
  if (typeof app.bringToFront === "function") app.bringToFront();
  else app.bringToTop?.();
}

export function filePickerClass() {
  return globalThis.foundry?.applications?.apps?.FilePicker?.implementation
    || globalThis.foundry?.applications?.apps?.FilePicker
    || globalThis.FilePicker;
}

export function openFilePicker(options = {}) {
  const FilePickerClass = filePickerClass();
  if (typeof FilePickerClass !== "function") return null;
  const picker = new FilePickerClass(options);
  renderApplication(picker, { force: true });
  return picker;
}

export function openImagePopout(src, { title = "", uuid = null } = {}) {
  if (!src) return null;
  const ImagePopoutV2 = globalThis.foundry?.applications?.apps?.ImagePopout;
  if (typeof ImagePopoutV2 === "function") {
    const popout = new ImagePopoutV2({ src, uuid, window: { title } });
    popout.render({ force: true });
    return popout;
  }

  const LegacyImagePopout = globalThis.ImagePopout;
  if (typeof LegacyImagePopout !== "function") return null;
  const popout = new LegacyImagePopout(src, { title, uuid, shareable: false });
  popout.render(true);
  return popout;
}
