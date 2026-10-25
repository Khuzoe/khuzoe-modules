export function canConfigureAuraToken(tokenDocument, user = game.user) {
  return Boolean(
    user?.isGM
    || tokenDocument?.isOwner
    || tokenDocument?.actor?.isOwner
  );
}