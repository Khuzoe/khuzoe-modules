const operations = new Map();

/** Serialize overlapping decisions on a resource; revalidate inside the callback after any dialog. */
export async function withDocumentLock(document, action, callback) {
  const key = `${document?.uuid ?? document?.id}:${action}`;
  const previous = operations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(callback);
  operations.set(key, next);
  try { return await next; }
  finally { if (operations.get(key) === next) operations.delete(key); }
}
