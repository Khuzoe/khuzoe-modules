import test from "node:test";
import assert from "node:assert/strict";

import { waitForTokenArrival } from "../scripts/movement.js";

test("arrival waits for the active Foundry token animation", async () => {
  let finishAnimation;
  const animationPromise = new Promise(resolve => {
    finishAnimation = resolve;
  });
  const animationContexts = new Map();
  const tokenDocument = {
    object: {
      movementAnimationName: "Token.source.animateMovement",
      animationContexts
    }
  };
  let arrived = false;

  const waiting = waitForTokenArrival(tokenDocument, {
    nextFrame: async () => {
      animationContexts.set("Token.source.animateMovement", { promise: animationPromise });
    }
  }).then(() => {
    arrived = true;
  });

  await Promise.resolve();
  assert.equal(arrived, false);
  finishAnimation(true);
  await waiting;
  assert.equal(arrived, true);
});

test("arrival prefers the public v14 movement animation promise", async () => {
  let finishAnimation;
  const movementAnimationPromise = new Promise(resolve => {
    finishAnimation = resolve;
  });
  const tokenDocument = {
    object: {
      movementAnimationName: "Token.source.animateMovement",
      movementAnimationPromise,
      animationContexts: new Map()
    }
  };
  let arrived = false;

  const waiting = waitForTokenArrival(tokenDocument, {
    nextFrame: async () => undefined
  }).then(() => {
    arrived = true;
  });

  await Promise.resolve();
  assert.equal(arrived, false);
  finishAnimation(true);
  await waiting;
  assert.equal(arrived, true);
});

test("arrival is immediate when the scene has no token animation", async () => {
  await waitForTokenArrival({ object: null }, {
    nextFrame: async () => assert.fail("No frame should be requested without a placeable token.")
  });
});
