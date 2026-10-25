export const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;
export const HandlebarsApplicationV2 = HandlebarsApplicationMixin(ApplicationV2);

export function bindElements(root, selector, events, handler) {
  if (!root?.querySelectorAll || typeof handler !== "function") return;
  const names = Array.isArray(events) ? events : String(events ?? "").split(/\s+/).filter(Boolean);
  for (const element of root.querySelectorAll(selector)) {
    for (const name of names) element.addEventListener(name, handler);
  }
}
