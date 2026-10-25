import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const moduleRoot = new URL("../", import.meta.url);

class MockFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type ?? "";
    this.lastModified = options.lastModified;
  }
}

function loadModule() {
  const hooks = {};
  const registrations = new Map();

  class FilePickerImplementation {
    static async upload(...args) {
      return { receiver: this, args };
    }
  }

  class MockImage {
    #listeners = {};
    naturalWidth = 16;
    naturalHeight = 12;

    addEventListener(type, callback) {
      this.#listeners[type] = callback;
    }

    set src(_value) {
      queueMicrotask(() => this.#listeners.load());
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (callback, type) => callback({ type })
  };

  const context = vm.createContext({
    console,
    Date,
    document: { createElement: () => canvas },
    File: MockFile,
    foundry: { applications: { apps: { FilePicker: { implementation: FilePickerImplementation } } } },
    game: {
      settings: {
        get: () => 85,
        register: (_moduleId, key, definition) => registrations.set(key, definition)
      }
    },
    Hooks: {
      once: (name, callback) => { hooks[name] = callback; }
    },
    Image: MockImage,
    queueMicrotask,
    Symbol,
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {}
    }
  });

  const source = readFileSync(new URL("scripts/main.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "main.js" });
  hooks.init();
  hooks.ready();
  return { FilePickerImplementation, registrations };
}

test("manifest targets Foundry V14", () => {
  const manifest = JSON.parse(readFileSync(new URL("module.json", moduleRoot), "utf8"));
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.367");
});

test("preserves all five V14 upload arguments for untouched files", async () => {
  const { FilePickerImplementation, registrations } = loadModule();
  const file = { name: "notes.txt", type: "text/plain" };
  const body = { bucket: "assets" };
  const options = { notify: false };
  const result = await FilePickerImplementation.upload("data", "worlds/test", file, body, options);

  assert.equal(registrations.get("webpQuality").default, 85);
  assert.equal(result.receiver, FilePickerImplementation);
  assert.equal(result.args[2], file);
  assert.equal(result.args[3], body);
  assert.equal(result.args[4], options);
});

test("converts PNG uploads and changes only their extension", async () => {
  const { FilePickerImplementation } = loadModule();
  const png = { name: "boss.PnG", type: "image/png", lastModified: 1234 };
  const result = await FilePickerImplementation.upload("data", "worlds/test", png, {}, {});
  const converted = result.args[2];

  assert.ok(converted instanceof MockFile);
  assert.equal(converted.name, "boss.webp");
  assert.equal(converted.type, "image/webp");
  assert.equal(converted.lastModified, 1234);
});
