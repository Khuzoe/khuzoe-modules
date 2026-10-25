import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const moduleRoot = new URL("../", import.meta.url);

function loadModule() {
  const hooks = {};
  const registered = new Map();
  const values = new Map([
    ["customPort", 31000],
    ["discordWebhook", ""],
    ["lastSentAddress", ""],
    ["lastSentWebhook", ""]
  ]);
  const notifications = { errors: 0 };

  const context = vm.createContext({
    AbortController,
    console,
    fetch: async () => ({ ok: true, text: async () => "203.0.113.42" }),
    game: {
      user: { isGM: true },
      i18n: { localize: key => key },
      settings: {
        register: (_moduleId, key, definition) => registered.set(key, definition),
        get: (_moduleId, key) => values.get(key),
        set: async (_moduleId, key, value) => values.set(key, value)
      }
    },
    Hooks: {
      once: (name, callback) => { hooks[name] = callback; },
      on: (name, callback) => { hooks[name] = callback; }
    },
    ui: {
      sidebar: { tabs: {} },
      notifications: {
        error: () => { notifications.errors += 1; },
        info: () => {},
        warn: () => {}
      }
    },
    window: {
      clearTimeout,
      location: { port: "30000", protocol: "http:" },
      setTimeout
    }
  });

  const source = readFileSync(new URL("ip-address.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "ip-address.js" });
  hooks.init();
  return { context, hooks, notifications, registered, values };
}

test("manifest uses the Foundry V14 schema", () => {
  const manifest = JSON.parse(readFileSync(new URL("module.json", moduleRoot), "utf8"));
  assert.equal(manifest.id, "khuzoe-address-sender");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.367");
  assert.ok(!("minimumCoreVersion" in manifest));
});

test("keeps existing setting identifiers and resolves the configured public port", async () => {
  const { context, registered } = loadModule();
  assert.deepEqual([...registered.keys()], [
    "discordWebhook",
    "lastSentAddress",
    "lastSentWebhook",
    "customPort"
  ]);
  assert.equal(registered.get("customPort").default, 0);
  assert.equal(await vm.runInContext("getServerAddress()", context), "203.0.113.42:31000");
});

test("does not report an HTTP webhook rejection as a successful send", async () => {
  const { context, notifications } = loadModule();
  context.fetch = async () => ({ ok: false, status: 401 });
  const result = await vm.runInContext("postAddressToDiscord('203.0.113.42:30000', 'https://discord.test/webhook')", context);
  assert.equal(result, false);
  assert.equal(notifications.errors, 1);
});
