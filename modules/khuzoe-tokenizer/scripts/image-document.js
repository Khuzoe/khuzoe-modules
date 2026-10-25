/** User portraits use avatar; Item artwork uses img. Never touch the assigned Actor. */
export function imageField(document) {
  return document?.documentName === "User" ? "avatar" : "img";
}

export function documentImage(document) {
  return String(document?.[imageField(document)] || "");
}

export function canEditDocumentImage(document, user) {
  if (!document || !user) return false;
  if (!["User", "Item"].includes(document.documentName)) return false;
  if (user.isGM) return true;
  if (document.documentName === "User") return Boolean(user.id && document.id === user.id);
  const owner = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const target = document.parent?.documentName === "Actor" ? document.parent : document;
  return Boolean(target.testUserPermission?.(user, owner));
}
