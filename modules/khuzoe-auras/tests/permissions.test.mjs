import test from "node:test";
import assert from "node:assert/strict";

import { canConfigureAuraToken } from "../scripts/permissions.js";

test("a token owner can configure its auras", () => {
  assert.equal(
    canConfigureAuraToken({ isOwner: true }, { isGM: false }),
    true
  );
});

test("an actor owner can configure auras on its token", () => {
  assert.equal(
    canConfigureAuraToken({ isOwner: false, actor: { isOwner: true } }, { isGM: false }),
    true
  );
});

test("a non-owner cannot configure another token's auras", () => {
  assert.equal(
    canConfigureAuraToken({ isOwner: false, actor: { isOwner: false } }, { isGM: false }),
    false
  );
});

test("a GM can configure every token's auras", () => {
  assert.equal(
    canConfigureAuraToken({ isOwner: false }, { isGM: true }),
    true
  );
});