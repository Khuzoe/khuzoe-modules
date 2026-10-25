export async function waitForTokenArrival(tokenDocument, {
  nextFrame = waitForNextFrame
} = {}) {
  const token = tokenDocument?.object;
  if (!token) return;

  // The animation context is installed during the document update. Waiting one
  // frame makes its completion promise available without polling.
  await nextFrame();

  // V14 exposes a dedicated movement animation promise. The old generic
  // animation name can point at unrelated token updates and is only retained
  // below as a compatibility fallback for interrupted or non-standard moves.
  const context = token.animationContexts?.get?.(token.movementAnimationName)
    ?? token.animationContexts?.get?.(token.animationName);
  const completion = token.movementAnimationPromise ?? context?.promise;
  if (!completion) return;

  try {
    await completion;
  } catch (error) {
    console.debug("Khuzoe Auras | Token movement animation was interrupted.", error);
  }
}

function waitForNextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}
