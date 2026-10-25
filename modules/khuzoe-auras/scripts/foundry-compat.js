/** Native Foundry VTT v14 application APIs used by Khuzoe Auras. */

export const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;
export const HandlebarsApplicationV2 = HandlebarsApplicationMixin(ApplicationV2);
export const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;

/** Bind one handler to each matching element. */
export function bindElements(root, selector, events, handler) {
  if (!root?.querySelectorAll || typeof handler !== "function") return;
  const eventNames = Array.isArray(events)
    ? events
    : String(events ?? "").split(/\s+/).filter(Boolean);

  for (const element of root.querySelectorAll(selector)) {
    for (const eventName of eventNames) element.addEventListener(eventName, handler);
  }
}
