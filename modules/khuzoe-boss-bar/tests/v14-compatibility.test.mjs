import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const moduleRoot = new URL("../", import.meta.url);

test("manifest targets Foundry V14", () => {
  const manifest = JSON.parse(readFileSync(new URL("module.json", moduleRoot), "utf8"));
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.367");
  assert.equal(manifest.relationships.systems[0].id, "dnd5e");
});

test("registers a personal top/bottom anchor and reserves the V14 side panels", () => {
  const hooks = {};
  const registrations = new Map();
  const sidePanels = [
    {
      getBoundingClientRect: () => ({ left: 0, right: 220, top: 0, bottom: 800, width: 220, height: 800 })
    },
    {
      getBoundingClientRect: () => ({ left: 900, right: 1200, top: 0, bottom: 800, width: 300, height: 800 })
    }
  ];
  const context = vm.createContext({
    canvas: { tokens: { controlled: [] } },
    console,
    document: {
      querySelectorAll: () => sidePanels
    },
    game: {
      settings: {
        get: (_moduleId, key) => {
          if (key === "screenAnchor") return "bottom";
          if (key === "effectMode") return "cinematic";
          return undefined;
        },
        register: (_moduleId, key, definition) => registrations.set(key, definition)
      },
      user: { id: "gm", isGM: true },
      i18n: { localize: key => key }
    },
    Hooks: {
      once: (name, callback) => { hooks[name] = callback; },
      on: (name, callback) => { hooks[name] = callback; }
    },
    window: {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    }
  });

  const source = readFileSync(new URL("scripts/khuzoe-boss-bar.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "khuzoe-boss-bar.js" });
  hooks.init();

  const anchor = registrations.get("screenAnchor");
  assert.equal(anchor.scope, "client");
  assert.equal(anchor.default, "top");
  assert.deepEqual({ ...anchor.choices }, {
    top: "KHBB.Settings.Anchor.Top",
    bottom: "KHBB.Settings.Anchor.Bottom"
  });
  assert.equal(vm.runInContext("configuredAnchor()", context), "bottom");

  const effects = registrations.get("effectMode");
  assert.equal(effects.scope, "client");
  assert.equal(effects.default, "subtle");
  assert.deepEqual({ ...effects.choices }, {
    off: "KHBB.Settings.Effects.Off",
    subtle: "KHBB.Settings.Effects.Subtle",
    cinematic: "KHBB.Settings.Effects.Cinematic"
  });
  assert.equal(vm.runInContext("configuredEffectMode()", context), "cinematic");

  const bounds = vm.runInContext("horizontalBoundsAvoidingFoundryUi()", context);
  assert.equal(bounds.left, 234);
  assert.equal(bounds.right, 886);
  assert.equal(bounds.width, 652);

  const css = readFileSync(new URL("styles/khuzoe-boss-bar.css", moduleRoot), "utf8");
  assert.match(css, /\.khbb-anchor-top[\s\S]*flex-direction: column;/);
  assert.match(css, /\.khbb-anchor-bottom[\s\S]*flex-direction: column-reverse;/);
  assert.match(source, /#sidebar-content\.expanded/);
  assert.match(source, /#smalltime-app/);
  assert.match(source, /MutationObserverClass/);
});

test("classifies cinematic thresholds and suppresses repeated effects", () => {
  const context = vm.createContext({
    canvas: { tokens: { controlled: [] } },
    console,
    document: { querySelectorAll: () => [] },
    game: {
      user: { id: "gm", isGM: true },
      i18n: { localize: key => key }
    },
    Hooks: {
      once: () => {},
      on: () => {}
    },
    window: {}
  });

  const source = readFileSync(new URL("scripts/khuzoe-boss-bar.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "khuzoe-boss-bar.js" });

  assert.equal(vm.runInContext("classifyHealthEffect(undefined, 0.5)", context), null);
  assert.equal(vm.runInContext("classifyHealthEffect(0.8, 0.77)", context), null);
  assert.equal(vm.runInContext("classifyHealthEffect(0.8, 0.74).kind", context), "damage");
  assert.equal(vm.runInContext("classifyHealthEffect(0.8, 0.6).kind", context), "heavy");
  assert.equal(vm.runInContext("classifyHealthEffect(0.3, 0.25).kind", context), "critical");
  assert.equal(vm.runInContext("classifyHealthEffect(0.1, 0).kind", context), "defeat");

  assert.equal(vm.runInContext("claimCinematicEffect('boss', classifyHealthEffect(0.8, 0.7), 1000)", context), true);
  assert.equal(vm.runInContext("claimCinematicEffect('boss', classifyHealthEffect(0.7, 0.6), 1500)", context), false);
  assert.equal(vm.runInContext("claimCinematicEffect('boss', classifyHealthEffect(0.3, 0.25), 1600)", context), true);
  assert.equal(vm.runInContext("claimCinematicEffect('other', classifyHealthEffect(0.8, 0.7), 1700)", context), false);
  assert.equal(vm.runInContext("claimCinematicEffect('boss', classifyHealthEffect(0.1, 0), 1800)", context), true);

  assert.match(source, /CanvasShakeEffect/);
  assert.match(source, /ParticleGenerator/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /photosensitiveMode/);
});

test("uses native V14 shake and particles only for a visible token", () => {
  let shakePlayed = 0;
  let particleStarted = 0;
  let particleConfig = null;

  class ShakeEffect {
    play() {
      shakePlayed += 1;
    }
  }

  class ParticleGenerator {
    constructor(config) {
      particleConfig = config;
    }

    start({ spawn }) {
      particleStarted = spawn;
    }

    stop() {}
  }

  const token = {
    visible: true,
    destroyed: false,
    w: 120,
    h: 120,
    document: { id: "token", hidden: false, elevation: 10 }
  };
  const context = vm.createContext({
    canvas: {
      ready: true,
      photosensitiveMode: false,
      scene: { id: "scene" },
      stage: {},
      tokens: { controlled: [], get: id => id === "token" ? token : null }
    },
    console,
    document: { querySelectorAll: () => [] },
    foundry: { canvas: { animation: { CanvasShakeEffect: ShakeEffect, ParticleGenerator } } },
    game: {
      settings: { get: (_moduleId, key) => key === "effectMode" ? "cinematic" : undefined },
      user: { id: "gm", isGM: true },
      i18n: { localize: key => key }
    },
    Hooks: {
      once: () => {},
      on: () => {}
    },
    PIXI: { Texture: { WHITE: {} }, BLEND_MODES: { ADD: "add" } },
    window: {
      matchMedia: () => ({ matches: false }),
      setTimeout: () => 1
    }
  });

  const source = readFileSync(new URL("scripts/khuzoe-boss-bar.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "khuzoe-boss-bar.js" });
  vm.runInContext(`playBossBarEffects([{
    id: "boss",
    sceneId: "scene",
    tokenId: "token",
    effectAllowed: true,
    effect: {kind: "critical", priority: 3, delta: 0.1}
  }])`, context);

  assert.equal(shakePlayed, 1);
  assert.equal(particleStarted, 42);
  assert.equal(particleConfig.anchor, token);
  assert.equal(particleConfig.elevation, 10);

  context.window.matchMedia = () => ({ matches: true });
  vm.runInContext(`playBossBarEffects([{
    id: "boss",
    sceneId: "scene",
    tokenId: "token",
    effectAllowed: true,
    effect: {kind: "defeat", priority: 4, delta: 0.25}
  }])`, context);
  assert.equal(shakePlayed, 1);
  assert.equal(particleStarted, 42);
});

test("adds a V14 button to the keyed tokens control", async () => {
  const hooks = {};
  const context = vm.createContext({
    canvas: { tokens: { controlled: [] } },
    console,
    game: {
      user: { id: "gm", isGM: true },
      i18n: { localize: key => key }
    },
    Hooks: {
      once: (name, callback) => { hooks[name] = callback; },
      on: (name, callback) => { hooks[name] = callback; }
    }
  });

  const source = readFileSync(new URL("scripts/khuzoe-boss-bar.js", moduleRoot), "utf8");
  vm.runInContext(source, context, { filename: "khuzoe-boss-bar.js" });

  const controls = { tokens: { name: "tokens", tools: {} } };
  hooks.getSceneControlButtons(controls);
  const tool = controls.tokens.tools["khbb-show-selected"];

  assert.ok(tool);
  assert.equal(tool.button, true);
  assert.equal(typeof tool.onChange, "function");
  assert.equal(tool.onClick, undefined);
  await tool.onChange(null, false);
  await tool.onChange(null, true);
});
