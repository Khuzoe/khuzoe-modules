/** Minimal document store for GM resource transactions, including synchronous prepared values. */
const documents = new Map();
const installed = new WeakSet();
let serial = 0;

export function registerDocuments(...entries) {
  const previous = globalThis.fromUuid;
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? previous?.(uuid) ?? null;
  for (const document of entries.filter(Boolean)) {
    if (document.actor) registerDocuments(document.actor);
    document.id ??= `fixture${++serial}`;
    document.uuid ??= document.actor ? `${document.actor.uuid}.Item.${document.id}` : `Actor.${document.id}`;
    documents.set(document.uuid, document);
    if (installed.has(document)) continue;
    installed.add(document);
    const update = document.update?.bind(document);
    document.update = async changes => {
      if (update) await update(changes);
      else await globalThis.cat?.utils?.documentUtils?.update?.(document, changes);
      for (const [path, value] of Object.entries(changes)) {
        const keys = path.split(".");
        let target = document;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = value;
      }
      return document;
    };
    for (const item of Array.from(document.items?.values?.() ?? document.items ?? [])) {
      item.actor ??= document;
      registerDocuments(item);
    }
  }
}
