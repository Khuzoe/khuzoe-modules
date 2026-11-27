import assert from "node:assert/strict";
import test from "node:test";

test("a disabled client registers only its preference and disables only the HUD stylesheet", async () => {
  const hooks = new Map();
  globalThis.Hooks = { once: (name, fn) => hooks.set(name, fn) };
  globalThis.CSS = { supports: () => true };
  globalThis.CSSRule = { IMPORT_RULE: 3 };
  globalThis.HTMLElement = class {};
  const hud = new URL("../styles/chat-cards.css", import.meta.url);
  const cssImport = href => ({ type: 3, href, media: { mediaText: "all" } });
  const hudImport = cssImport(hud.href + "?v=14");
  const otherImport = cssImport("other-module/chat-cards.css");
  const linked = { href: hud.href, disabled: false };
  globalThis.document = { baseURI: hud.href, styleSheets: [linked, { href: null, cssRules: [otherImport, hudImport] }] };
  let preference;
  globalThis.game = { settings: {
    register(id, key, options) { assert.equal(id + "." + key, "khuzoe-hud.enabled"); preference = options; },
    get: () => false
  } };

  // No DOM observers, custom element registry, socket, or gameplay hooks
  // are provided in this client. Touching any of them should fail the test.
  await import("../scripts/chat-cards.mjs");
  hooks.get("init")();
  assert.deepEqual([...hooks.keys()], ["init"]);
  assert.equal(preference.scope, "client");
  assert.equal(preference.default, true);
  assert.equal(preference.config, true);
  assert.equal(preference.requiresReload, true);
  assert.equal(linked.disabled, true);
  assert.equal(hudImport.media.mediaText, "not all");
  assert.equal(otherImport.media.mediaText, "all");
});
