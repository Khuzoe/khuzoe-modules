const MODULE_ID = "khuzoe-boss-bar";
const SETTING_STATE = "barState";
const SETTING_DISMISSED = "dismissedState";
const SETTING_ANCHOR = "screenAnchor";
const SETTING_EFFECT_MODE = "effectMode";
const STATE_VERSION = 1;
const EFFECT_PRIORITY = Object.freeze({ damage: 1, heavy: 2, critical: 3, defeat: 4 });
const EFFECT_COOLDOWN = Object.freeze({ damage: 800, heavy: 900, critical: 1400, defeat: 1800 });

let refreshTimeout = null;
let dragState = null;
let resizeState = null;
let manualPosition = null;
let minimizedPosition = null;
let manualSize = null;
let manualBarHeight = null;
let suppressClickUntil = 0;
let layoutObserver = null;
let layoutMutationObserver = null;
let layoutRefreshFrame = null;
let layoutTransitionTimer = null;
const paletteCache = new Map();
const pendingPalettes = new Set();
const lastRenderedPct = new Map();
const lastCinematicEffect = new Map();
const activeParticleGenerators = new Set();
let lastGlobalCinematicEffect = { at: 0, priority: 0 };

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  ensureRoot();
  renderBossBars();
  initializeLayoutTracking();
  window.addEventListener("resize", scheduleLayoutRefresh);
  document.addEventListener("click", onDocumentClick, true);
});

Hooks.on("canvasReady", () => {
  stopActiveParticleEffects();
  renderBossBars();
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM) return;

  // Foundry V14 exposes controls as a keyed record and renamed the token
  // control from "token" to "tokens".
  const tokenControls = Array.isArray(controls)
    ? controls.find(control => ["tokens", "token"].includes(control.name))
    : (controls?.tokens ?? controls?.token);
  if (!tokenControls?.tools) return;

  addSceneControlTool(tokenControls, {
    name: "khbb-show-selected",
    order: 100,
    title: localize("Controls.AddSelected"),
    icon: "fa-solid fa-heart",
    button: true,
    onChange: (_event, active) => {
      if (active) return addSelectedTokens();
    }
  });
});

Hooks.on("updateActor", actor => {
  if (!game.user?.isGM || !isPrimaryGM()) return;
  if (!trackedCreatures().some(entry => entry.actorId === actor.id)) return;
  scheduleRefresh();
});

Hooks.on("updateToken", tokenDocument => {
  if (!game.user?.isGM || !isPrimaryGM()) return;
  if (!trackedCreatures().some(entry => entryMatchesToken(entry, tokenDocument))) return;
  scheduleRefresh();
});

Hooks.on("deleteToken", tokenDocument => {
  if (!game.user?.isGM || !isPrimaryGM()) return;
  if (!trackedCreatures().some(entry => entryMatchesToken(entry, tokenDocument))) return;
  scheduleRefresh();
});

function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_STATE, {
    name: "Khuzoe Boss Bar State",
    scope: "world",
    config: false,
    type: Object,
    default: defaultState(),
    onChange: value => renderBossBars(value)
  });

  game.settings.register(MODULE_ID, SETTING_DISMISSED, {
    name: "Khuzoe Boss Bar Dismissed State",
    scope: "client",
    config: false,
    type: Object,
    default: defaultDismissedState(),
    onChange: () => renderBossBars()
  });

  game.settings.register(MODULE_ID, SETTING_ANCHOR, {
    name: "KHBB.Settings.Anchor.Name",
    hint: "KHBB.Settings.Anchor.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      top: "KHBB.Settings.Anchor.Top",
      bottom: "KHBB.Settings.Anchor.Bottom"
    },
    default: "top",
    onChange: () => {
      manualPosition = null;
      minimizedPosition = null;
      renderBossBars();
    }
  });

  game.settings.register(MODULE_ID, SETTING_EFFECT_MODE, {
    name: "KHBB.Settings.Effects.Name",
    hint: "KHBB.Settings.Effects.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      off: "KHBB.Settings.Effects.Off",
      subtle: "KHBB.Settings.Effects.Subtle",
      cinematic: "KHBB.Settings.Effects.Cinematic"
    },
    default: "subtle",
    onChange: () => renderBossBars()
  });
}

async function addSelectedTokens() {
  if (!game.user?.isGM) return;

  const controlledTokens = Array.from(canvas?.tokens?.controlled ?? []);
  if (!controlledTokens.length) {
    return;
  }

  const state = getState();
  const existingEntries = state.entries;
  const selectedEntries = controlledTokens
    .map((token, index) => buildEntryFromTokenDocument(token.document, index))
    .filter(Boolean);

  if (!selectedEntries.length) {
    return;
  }

  const nextEntries = mergeEntries(existingEntries, selectedEntries);

  await setState(nextEntries);
}

async function clearBars() {
  if (!game.user?.isGM) return;
  await setState([]);
}

async function hideBars() {
  const state = getState();
  const root = document.getElementById("khbb-root");
  if (root && !root.classList.contains("khbb-minimized")) {
    const rect = root.getBoundingClientRect();
    manualPosition = captureAnchoredPosition(rect);
    manualSize = normalizeSize({ width: rect.width, height: rect.height });
    manualBarHeight = currentBarHeight(root);
  }

  await game.settings.set(MODULE_ID, SETTING_DISMISSED, { updatedAt: state.updatedAt });
  renderBossBars(state);
}

async function showBars() {
  await game.settings.set(MODULE_ID, SETTING_DISMISSED, defaultDismissedState());
  renderBossBars();
}

async function removeBar(entryId) {
  if (!game.user?.isGM || !entryId) return;

  const entries = getState().entries
    .filter(entry => entry.id !== entryId)
    .map((entry, index) => ({ ...entry, sort: index }));

  await setState(entries);
}

async function addSelectedMinions(bossId) {
  if (!game.user?.isGM || !bossId) return;

  const controlledTokens = Array.from(canvas?.tokens?.controlled ?? []);
  if (!controlledTokens.length) return;

  const state = getState();
  const bossIds = new Set(state.entries.map(entry => entry.id));
  let changed = false;

  const entries = state.entries.map(entry => {
    if (entry.id !== bossId) return entry;

    const selectedMinions = controlledTokens
      .map((token, index) => buildMinionFromTokenDocument(token.document, index))
      .filter(minion => minion && minion.id !== entry.id && !bossIds.has(minion.id));

    if (!selectedMinions.length) return entry;

    const minions = mergeMinions(entry.minions, selectedMinions);
    changed = entriesChanged([entry], [{ ...entry, minions }]);

    return { ...entry, minions };
  });

  if (!changed) return;
  await setState(entries);
}

async function removeMinion(bossId, minionId) {
  if (!game.user?.isGM || !bossId || !minionId) return;

  const entries = getState().entries.map(entry => {
    if (entry.id !== bossId) return entry;
    return {
      ...entry,
      minions: entry.minions
        .filter(minion => minion.id !== minionId)
        .map((minion, index) => ({ ...minion, sort: index }))
    };
  });

  await setState(entries);
}

async function refreshTrackedBars() {
  if (!game.user?.isGM) return;

  const state = getState();
  if (!state.entries.length) return;

  const refreshedEntries = state.entries
    .map((entry, index) => refreshEntry(entry, index))
    .filter(Boolean);

  if (!entriesChanged(state.entries, refreshedEntries)) return;

  await setState(refreshedEntries);
}

function refreshEntry(entry, index) {
  const scene = entry.sceneId ? game.scenes?.get(entry.sceneId) : null;
  const tokenDocument = scene?.tokens?.get(entry.tokenId);
  let refreshedEntry = null;

  if (tokenDocument?.actor) {
    refreshedEntry = buildEntryFromTokenDocument(tokenDocument, index, entry);
  } else {
    const actor = entry.actorId ? game.actors?.get(entry.actorId) : null;
    if (!actor) refreshedEntry = normalizeEntry({ ...entry, sort: index, stale: true });
    else {
      const hp = getActorHp(actor);
      refreshedEntry = hp
        ? normalizeEntry({
          ...entry,
          actorId: actor.id,
          name: entry.name || actor.name,
          img: entry.img || actor.img,
          pct: hp.ratio,
          sort: index,
          stale: false,
          updatedAt: Date.now()
        })
        : normalizeEntry({ ...entry, sort: index, stale: true });
    }
  }

  return normalizeEntry({
    ...refreshedEntry,
    minions: refreshMinions(entry.minions)
  });
}

function refreshMinions(minions = []) {
  return minions
    .map((minion, index) => refreshMinion(minion, index))
    .filter(Boolean);
}

function refreshMinion(minion, index) {
  const scene = minion.sceneId ? game.scenes?.get(minion.sceneId) : null;
  const tokenDocument = scene?.tokens?.get(minion.tokenId);

  if (tokenDocument?.actor) {
    return buildMinionFromTokenDocument(tokenDocument, index, minion);
  }

  const actor = minion.actorId ? game.actors?.get(minion.actorId) : null;
  if (!actor) return normalizeMinion({ ...minion, sort: index, stale: true });

  const hp = getActorHp(actor);
  if (!hp) return normalizeMinion({ ...minion, sort: index, stale: true });

  return normalizeMinion({
    ...minion,
    actorId: actor.id,
    name: minion.name || actor.name,
    img: minion.img || actor.img,
    pct: hp.ratio,
    sort: index,
    stale: false,
    updatedAt: Date.now()
  });
}

function buildEntryFromTokenDocument(tokenDocument, index = 0, previous = {}) {
  const actor = tokenDocument?.actor;
  if (!actor) return null;

  const hp = getActorHp(actor);
  if (!hp) return null;

  const sceneId = tokenDocument.parent?.id ?? canvas?.scene?.id ?? previous.sceneId ?? null;
  const tokenId = tokenDocument.id ?? previous.tokenId ?? null;
  if (!sceneId || !tokenId) return null;

  return normalizeEntry({
    id: `${sceneId}.${tokenId}`,
    sceneId,
    tokenId,
    actorId: actor.id,
    name: tokenDocument.name || actor.name || previous.name || localize("Labels.Creature"),
    img: tokenDocument.texture?.src || actor.img || previous.img || "",
    color: previous.color || null,
    minions: previous.minions || [],
    pct: hp.ratio,
    sort: index,
    stale: false,
    updatedAt: Date.now()
  });
}

function buildMinionFromTokenDocument(tokenDocument, index = 0, previous = {}) {
  const entry = buildEntryFromTokenDocument(tokenDocument, index, previous);
  return entry ? normalizeMinion(entry) : null;
}

function getActorHp(actor) {
  const hp = actor?.system?.attributes?.hp ?? foundry.utils.getProperty(actor, "system.attributes.hp");
  if (!hp) return null;

  const value = numberOrNull(hp.value);
  const max = numberOrNull(hp.max);
  if (value === null || max === null || max <= 0) return null;

  const temp = Math.max(0, numberOrZero(hp.temp));
  const tempMax = Math.max(0, numberOrZero(hp.tempmax));
  const denominator = Math.max(1, max + tempMax);
  const ratio = clamp((Math.max(0, value) + temp) / denominator, 0, 1);

  return { ratio };
}

function ensureRoot() {
  if (!document.body) return null;

  let root = document.getElementById("khbb-root");
  if (!root) {
    root = document.createElement("section");
    root.id = "khbb-root";
    root.setAttribute("aria-live", "polite");
    root.addEventListener("click", onRootClick);
    root.addEventListener("contextmenu", onRootContextMenu);
    root.addEventListener("pointerdown", onDragStart);
    document.body.append(root);
  }

  syncRootAnchor(root);
  applyRootPosition(root);
  return root;
}

function configuredAnchor() {
  try {
    return game.settings.get(MODULE_ID, SETTING_ANCHOR) === "bottom" ? "bottom" : "top";
  } catch (_error) {
    return "top";
  }
}

function configuredEffectMode() {
  try {
    const mode = game.settings.get(MODULE_ID, SETTING_EFFECT_MODE);
    return ["off", "subtle", "cinematic"].includes(mode) ? mode : "subtle";
  } catch (_error) {
    return "subtle";
  }
}

function syncRootAnchor(root) {
  const anchor = configuredAnchor();
  root.dataset.khbbAnchor = anchor;
  root.classList.toggle("khbb-anchor-top", anchor === "top");
  root.classList.toggle("khbb-anchor-bottom", anchor === "bottom");
  return anchor;
}

function syncRootEffectMode(root) {
  const mode = configuredEffectMode();
  root.dataset.khbbEffects = mode;
  return mode;
}

function initializeLayoutTracking() {
  const ResizeObserverClass = globalThis.ResizeObserver ?? window.ResizeObserver;
  const MutationObserverClass = globalThis.MutationObserver ?? window.MutationObserver;

  if (typeof ResizeObserverClass === "function") {
    layoutObserver?.disconnect();
    layoutObserver = new ResizeObserverClass(scheduleLayoutRefresh);
  }
  if (typeof MutationObserverClass === "function") {
    layoutMutationObserver?.disconnect();
    layoutMutationObserver = new MutationObserverClass(scheduleLayoutTransitionRefresh);
  }

  observeLayoutElements();
}

function observeLayoutElements() {
  const selector = "#scene-controls, #sidebar, #sidebar-content, #players, #hotbar, #camera-views, #smalltime-app";
  const elements = document.querySelectorAll(selector);
  elements.forEach(element => layoutObserver?.observe(element));

  if (!layoutMutationObserver) return;
  layoutMutationObserver.disconnect();
  const interfaceRoot = document.getElementById("interface");
  if (interfaceRoot) {
    layoutMutationObserver.observe(interfaceRoot, { childList: true, subtree: true });
  }
  elements.forEach(element => {
    layoutMutationObserver.observe(element, {
      attributes: true,
      attributeFilter: ["class", "hidden", "style"]
    });
  });
}

function scheduleLayoutRefresh() {
  if (layoutRefreshFrame !== null) return;
  const requestFrame = window.requestAnimationFrame?.bind(window)
    ?? ((callback) => window.setTimeout(callback, 16));
  layoutRefreshFrame = requestFrame(() => {
    layoutRefreshFrame = null;
    observeLayoutElements();
    applyRootPosition();
  });
}

function scheduleLayoutTransitionRefresh() {
  scheduleLayoutRefresh();
  window.clearTimeout(layoutTransitionTimer);
  layoutTransitionTimer = window.setTimeout(() => {
    layoutTransitionTimer = null;
    scheduleLayoutRefresh();
  }, 300);
}

function renderBossBars(state = getState()) {
  const root = ensureRoot();
  if (!root) return;

  const normalizedState = normalizeState(state);
  const entries = normalizedState.entries;
  const dismissed = isStateDismissed(normalizedState);

  syncRootAnchor(root);
  syncRootEffectMode(root);
  root.hidden = !entries.length;
  root.classList.toggle("khbb-minimized", dismissed);
  root.classList.toggle("khbb-multiple", entries.length > 1 && !dismissed);
  const renderEntries = dismissed ? [] : decorateEntriesWithHealthChange(entries);
  root.innerHTML = dismissed ? renderRestoreButton() : renderEntries.map(renderBossBar).join("");
  if (!entries.length) {
    manualPosition = null;
    lastRenderedPct.clear();
    lastCinematicEffect.clear();
    lastGlobalCinematicEffect = { at: 0, priority: 0 };
  }
  applyRootPosition(root);
  observeLayoutElements();
  if (!dismissed) {
    hydrateEntryPalettes(entries);
    playBossBarEffects(renderEntries);
    rememberRenderedPcts(entries);
  }

  document.body?.classList.toggle("khbb-active", entries.length > 0 && !dismissed);
}

function decorateEntriesWithHealthChange(entries) {
  const now = Date.now();
  return entries.map(entry => {
    const decoratedEntry = decorateHealthChange(entry);
    decoratedEntry.effectAllowed = claimCinematicEffect(entry.id, decoratedEntry.effect, now);
    return {
      ...decoratedEntry,
      minions: entry.minions.map(minion => {
        const decoratedMinion = decorateHealthChange(minion);
        decoratedMinion.effectAllowed = claimCinematicEffect(minion.id, decoratedMinion.effect, now, { global: false });
        return decoratedMinion;
      })
    };
  });
}

function decorateHealthChange(entry) {
  const previousPct = lastRenderedPct.get(entry.id);
  let changeClass = "";
  const effect = classifyHealthEffect(previousPct, entry.pct);
  const previousFill = Number.isFinite(previousPct)
    ? `${Math.round(previousPct * 1000) / 10}%`
    : `${Math.round(entry.pct * 1000) / 10}%`;

  if (Number.isFinite(previousPct)) {
    if (entry.pct < previousPct - 0.002) changeClass = "khbb-health-damage";
    if (entry.pct > previousPct + 0.002) changeClass = "khbb-health-heal";
  }

  return { ...entry, changeClass, previousFill, effect };
}

function classifyHealthEffect(previousPct, currentPct) {
  if (!Number.isFinite(previousPct) || !Number.isFinite(currentPct)) return null;

  const delta = Math.max(0, previousPct - currentPct);
  if (previousPct > 0 && currentPct <= 0) return { kind: "defeat", priority: EFFECT_PRIORITY.defeat, delta };
  if (previousPct > 0.25 && currentPct <= 0.25) return { kind: "critical", priority: EFFECT_PRIORITY.critical, delta };
  if (delta >= 0.15) return { kind: "heavy", priority: EFFECT_PRIORITY.heavy, delta };
  if (delta >= 0.04) return { kind: "damage", priority: EFFECT_PRIORITY.damage, delta };
  return null;
}

function bossBarEffectClass(entry) {
  const kind = entry.effect?.kind;
  return kind && entry.effectAllowed ? ` khbb-impact-${kind}` : "";
}

function rememberRenderedPcts(entries) {
  const creatures = flattenCreatures(entries);
  const ids = new Set(creatures.map(entry => entry.id));

  for (const id of lastRenderedPct.keys()) {
    if (ids.has(id)) continue;
    lastRenderedPct.delete(id);
    lastCinematicEffect.delete(id);
  }

  for (const entry of creatures) {
    lastRenderedPct.set(entry.id, entry.pct);
  }
}

function claimCinematicEffect(entryId, effect, now = Date.now(), { global = true } = {}) {
  if (!entryId || !effect?.kind) return false;

  const priority = Number(effect.priority) || 0;
  const previous = lastCinematicEffect.get(entryId);
  const cooldown = EFFECT_COOLDOWN[effect.kind] ?? 800;
  if (previous && now - previous.at < cooldown && priority <= previous.priority) return false;

  if (global && now - lastGlobalCinematicEffect.at < 450 && priority <= lastGlobalCinematicEffect.priority) {
    return false;
  }

  lastCinematicEffect.set(entryId, { at: now, priority });
  if (global) lastGlobalCinematicEffect = { at: now, priority };
  return true;
}

function motionEffectsSuppressed() {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  return reducedMotion || canvas?.photosensitiveMode === true;
}

function playBossBarEffects(entries) {
  if (configuredEffectMode() !== "cinematic" || motionEffectsSuppressed()) return;

  const entry = entries
    .filter(candidate => candidate.effectAllowed && candidate.effect)
    .sort((left, right) => right.effect.priority - left.effect.priority)[0];
  if (!entry) return;

  const token = resolveBossBarToken(entry);
  if (!token) return;

  playCanvasShake(entry.effect);
  playTokenParticleBurst(token, entry.effect);
}

function resolveBossBarToken(entry) {
  if (!canvas?.ready || entry.sceneId !== canvas.scene?.id) return null;

  const token = canvas.tokens?.get?.(entry.tokenId)
    ?? canvas.tokens?.placeables?.find?.(candidate => candidate.document?.id === entry.tokenId)
    ?? null;
  if (!token || token.destroyed || token.visible === false) return null;
  if (token.document?.hidden && !game.user?.isGM) return null;
  return token;
}

function playCanvasShake(effect) {
  const ShakeEffect = globalThis.foundry?.canvas?.animation?.CanvasShakeEffect;
  if (typeof ShakeEffect !== "function" || !canvas?.stage) return;

  const profiles = {
    damage: { duration: 180, maxDisplacement: 1.5, smoothness: 0.58 },
    heavy: { duration: 280, maxDisplacement: 3.5, smoothness: 0.5 },
    critical: { duration: 420, maxDisplacement: 5, smoothness: 0.46 },
    defeat: { duration: 620, maxDisplacement: 7, smoothness: 0.42 }
  };
  const profile = profiles[effect.kind] ?? profiles.damage;

  try {
    const shake = new ShakeEffect({
      target: canvas.stage,
      duration: profile.duration,
      maxDisplacement: profile.maxDisplacement,
      smoothness: profile.smoothness,
      returnSpeed: 0.2,
      invalidateMasks: true
    });
    Promise.resolve(shake.play()).catch(error => console.debug(`${MODULE_ID} | Screen shake non disponibile`, error));
  } catch (error) {
    console.debug(`${MODULE_ID} | Screen shake non disponibile`, error);
  }
}

function particleProfile(kind) {
  const profiles = {
    damage: { count: 16, lifetime: [320, 620], speed: [55, 120], color: 0xb31d27, scale: [0.05, 0.12] },
    heavy: { count: 28, lifetime: [380, 760], speed: [70, 155], color: 0xd74735, scale: [0.06, 0.15] },
    critical: { count: 42, lifetime: [480, 920], speed: [65, 170], color: 0xe08a32, scale: [0.06, 0.17] },
    defeat: { count: 64, lifetime: [560, 1150], speed: [75, 190], color: 0xd4c08a, scale: [0.07, 0.2] }
  };
  return profiles[kind] ?? profiles.damage;
}

function playTokenParticleBurst(token, effect) {
  const ParticleGenerator = globalThis.foundry?.canvas?.animation?.ParticleGenerator;
  const whiteTexture = globalThis.PIXI?.Texture?.WHITE;
  if (typeof ParticleGenerator !== "function" || !whiteTexture) return;

  const profile = particleProfile(effect.kind);
  const radius = Math.max(Number(token.w) || 0, Number(token.h) || 0, 64) * 0.48;

  try {
    const generator = new ParticleGenerator({
      mode: "effect",
      manual: true,
      count: profile.count,
      textures: [whiteTexture],
      anchor: token,
      anchorPoint: "center",
      area: { radius },
      sampleMode: "interior",
      constraintMode: "kill",
      constraintArea: "view",
      lifetime: profile.lifetime,
      fade: { in: 0.04, out: 0.55 },
      velocity: { speed: profile.speed, angle: [205, 335] },
      alpha: [0.38, 0.78],
      scale: profile.scale,
      tint: profile.color,
      blend: globalThis.PIXI?.BLEND_MODES?.ADD,
      elevation: Number(token.document?.elevation) || 0,
      sort: 1000
    });

    activeParticleGenerators.add(generator);
    generator.start({ spawn: profile.count });
    window.setTimeout(() => stopParticleEffect(generator), Math.max(...profile.lifetime) + 300);
  } catch (error) {
    console.debug(`${MODULE_ID} | Particle burst non disponibile`, error);
  }
}

function stopParticleEffect(generator) {
  if (!generator) return;
  activeParticleGenerators.delete(generator);
  try {
    generator.stop({ hard: true });
  } catch (_error) {
    // The canvas may already have been torn down during a scene transition.
  }
}

function stopActiveParticleEffects() {
  for (const generator of activeParticleGenerators) stopParticleEffect(generator);
}

function renderRestoreButton() {
  return `
    <button class="khbb-restore-bars" type="button" data-khbb-restore title="${escapeHtml(localize("Controls.ShowAgain"))}" aria-label="${escapeHtml(localize("Controls.ShowAgain"))}">
      <i class="fas fa-eye" aria-hidden="true"></i>
    </button>
  `;
}

function renderBossBar(entry) {
  const status = healthStatus(entry.pct);
  const changeClass = entry.changeClass ? ` ${entry.changeClass}` : "";
  const effectClass = bossBarEffectClass(entry);
  const gmActions = game.user?.isGM
    ? `
      <button class="khbb-minion-add" type="button" data-khbb-add-minion="${escapeHtml(entry.id)}" title="${escapeHtml(localize("Controls.AddMinions"))}" aria-label="${escapeHtml(localize("Controls.AddMinions"))}">
        <i class="fas fa-user-plus" aria-hidden="true"></i>
      </button>
      ${renderColorControls(entry.id, entry.color)}
      <button class="khbb-remove-bar" type="button" data-khbb-remove="${escapeHtml(entry.id)}" title="${escapeHtml(localize("Controls.RemoveOne"))}" aria-label="${escapeHtml(localize("Controls.RemoveOne"))}">
        <i class="fas fa-trash" aria-hidden="true"></i>
      </button>
    `
    : "";
  const portrait = entry.img
    ? `<img class="khbb-portrait-image" src="${escapeHtml(entry.img)}" alt="">`
    : `<i class="khbb-portrait-icon fas fa-dragon" aria-hidden="true"></i>`;
  const minions = entry.minions.length
    ? `<div class="khbb-minions">${entry.minions.map(minion => renderMinionBar(entry.id, minion)).join("")}</div>`
    : "";

  return `
    <article class="khbb-boss-bar khbb-status-${status}${entry.stale ? " khbb-stale" : ""}${changeClass}${effectClass}" style="${escapeHtml(healthStyle(entry))};" aria-label="${escapeHtml(entry.name)}">
      <div class="khbb-portrait">${portrait}</div>
      <div class="khbb-content">
        ${renderHealthTrack(entry, "khbb-track")}
      </div>
      <div class="khbb-actions">
        <button class="khbb-hide-bars" type="button" data-khbb-hide title="${escapeHtml(localize("Controls.Clear"))}" aria-label="${escapeHtml(localize("Controls.Clear"))}">
          <i class="fas fa-eye-slash" aria-hidden="true"></i>
        </button>
        <button class="khbb-drag-handle" type="button" title="${escapeHtml(localize("Controls.Move"))}" aria-label="${escapeHtml(localize("Controls.Move"))}">
          <i class="fas fa-arrows-alt" aria-hidden="true"></i>
        </button>
        ${gmActions}
      </div>
      ${minions}
      <button class="khbb-resize-handle" type="button" title="${escapeHtml(localize("Controls.Resize"))}" aria-label="${escapeHtml(localize("Controls.Resize"))}"></button>
    </article>
  `;
}

function renderMinionBar(bossId, minion) {
  const status = healthStatus(minion.pct);
  const changeClass = minion.changeClass ? ` ${minion.changeClass}` : "";
  const effectClass = bossBarEffectClass(minion);
  const gmActions = game.user?.isGM
    ? `
      <div class="khbb-minion-actions">
        ${renderColorControls(minion.id, minion.color)}
        <button class="khbb-minion-remove" type="button" data-khbb-boss="${escapeHtml(bossId)}" data-khbb-remove-minion="${escapeHtml(minion.id)}" title="${escapeHtml(localize("Controls.RemoveMinion"))}" aria-label="${escapeHtml(localize("Controls.RemoveMinion"))}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
    `
    : "";

  return `
    <div class="khbb-minion-bar khbb-status-${status}${minion.stale ? " khbb-stale" : ""}${changeClass}${effectClass}" style="${escapeHtml(healthStyle(minion))};" aria-label="${escapeHtml(minion.name)}">
      ${renderHealthTrack(minion, "khbb-track khbb-minion-track")}
      ${gmActions}
    </div>
  `;
}

function renderColorControls(entryId, color) {
  return `
    <button class="khbb-color-bar" type="button" data-khbb-color="${escapeHtml(entryId)}" title="${escapeHtml(localize("Controls.Color"))}" aria-label="${escapeHtml(localize("Controls.Color"))}">
      <i class="fas fa-palette" aria-hidden="true"></i>
    </button>
    <div class="khbb-color-panel" data-khbb-color-panel="${escapeHtml(entryId)}">
      <input class="khbb-color-input" type="color" data-khbb-color-input="${escapeHtml(entryId)}" value="${escapeHtml(color || "#b31d27")}" aria-label="${escapeHtml(localize("Controls.Color"))}">
      <button class="khbb-color-confirm" type="button" data-khbb-color-confirm="${escapeHtml(entryId)}" title="${escapeHtml(localize("Controls.ConfirmColor"))}" aria-label="${escapeHtml(localize("Controls.ConfirmColor"))}">
        <i class="fas fa-check" aria-hidden="true"></i>
      </button>
      <button class="khbb-color-default" type="button" data-khbb-color-default="${escapeHtml(entryId)}" title="${escapeHtml(localize("Controls.DefaultRed"))}" aria-label="${escapeHtml(localize("Controls.DefaultRed"))}"></button>
    </div>
  `;
}
function renderHealthTrack(entry, trackClass) {
  return `
    <div class="${trackClass}" aria-hidden="true">
      <div class="khbb-change"></div>
      <div class="khbb-fill"></div>
      <div class="khbb-sheen"></div>
      <strong class="khbb-name">${escapeHtml(entry.name)}</strong>
    </div>
  `;
}

function healthStyle(entry) {
  const fill = `${Math.round(entry.pct * 1000) / 10}%`;
  const palette = getEntryPalette(entry);
  return [
    `--khbb-fill: ${fill}`,
    `--khbb-prev-fill: ${entry.previousFill || fill}`,
    `--khbb-bar-start: ${palette.start}`,
    `--khbb-bar-mid: ${palette.mid}`,
    `--khbb-bar-end: ${palette.end}`,
    `--khbb-bar-glow: ${palette.glow}`
  ].join("; ");
}
function getEntryPalette(entry) {
  if (isHexColor(entry.color)) return buildPalette(hexToRgb(entry.color));
  return paletteCache.get(entry.img) ?? defaultPalette();
}

function hydrateEntryPalettes(entries) {
  for (const entry of flattenCreatures(entries)) {
    if (!entry.img || paletteCache.has(entry.img) || pendingPalettes.has(entry.img)) continue;

    pendingPalettes.add(entry.img);
    extractPalette(entry.img)
      .then(palette => paletteCache.set(entry.img, palette))
      .catch(() => paletteCache.set(entry.img, defaultPalette()))
      .finally(() => {
        pendingPalettes.delete(entry.img);
        renderBossBars();
      });
  }
}

function extractPalette(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:\/\//i.test(src) && !src.startsWith(window.location.origin)) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 40;
        canvas.width = size;
        canvas.height = size;

        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, size, size);

        const pixels = context.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let index = 0; index < pixels.length; index += 12) {
          const alpha = pixels[index + 3];
          if (alpha < 180) continue;

          const color = {
            r: pixels[index],
            g: pixels[index + 1],
            b: pixels[index + 2]
          };
          const hsl = rgbToHsl(color);
          if (hsl.l < 0.08 || hsl.l > 0.92 || hsl.s < 0.08) continue;

          const key = [
            Math.round(color.r / 24),
            Math.round(color.g / 24),
            Math.round(color.b / 24)
          ].join(".");
          const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0, saturation: 0, lightness: 0, count: 0 };
          const chromaBias = Math.pow(hsl.s, 1.55);
          const lightnessBias = 1 - Math.abs(hsl.l - 0.48) * 1.25;
          const weight = Math.max(0.08, chromaBias * 2.2 + lightnessBias * 0.45);
          bucket.r += color.r * weight;
          bucket.g += color.g * weight;
          bucket.b += color.b * weight;
          bucket.saturation += hsl.s * weight;
          bucket.lightness += hsl.l * weight;
          bucket.weight += weight;
          bucket.count += 1;
          buckets.set(key, bucket);
        }

        const candidates = Array.from(buckets.values())
          .filter(bucket => bucket.weight > 0)
          .map(bucket => {
            const color = {
              r: Math.round(bucket.r / bucket.weight),
              g: Math.round(bucket.g / bucket.weight),
              b: Math.round(bucket.b / bucket.weight)
            };
            const hsl = rgbToHsl(color);
            const saturation = bucket.saturation / bucket.weight;
            const lightness = bucket.lightness / bucket.weight;
            const presence = Math.log1p(bucket.weight);
            const accentScore = presence * 0.72 + Math.pow(saturation, 1.35) * 2.8 + (1 - Math.abs(lightness - 0.46)) * 0.65;

            return { color, hsl, saturation, lightness, presence, accentScore };
          })
          .filter(candidate => candidate.saturation >= 0.12);
        if (!candidates.length) {
          reject(new Error("No usable colors"));
          return;
        }

        const dominant = [...candidates].sort((a, b) => b.presence - a.presence)[0];
        const accent = [...candidates].sort((a, b) => b.accentScore - a.accentScore)[0];
        resolve(buildPalette(dominant.color, accent.color));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = reject;
    image.src = src;
  });
}

function buildPalette(base, accent = base) {
  const baseHsl = rgbToHsl(base);
  const accentHsl = rgbToHsl(accent);
  const hue = accentHsl.s > baseHsl.s * 0.75 ? accentHsl.h : baseHsl.h;
  const saturation = clamp(Math.max(baseHsl.s, accentHsl.s) * 1.18, 0.44, 0.88);

  const start = hslToRgb({ h: hue, s: saturation, l: 0.19 });
  const mid = hslToRgb({ h: hue, s: saturation, l: 0.37 });
  const end = hslToRgb({ h: hue, s: Math.max(0.34, saturation * 0.92), l: 0.56 });

  return {
    start: rgbString(start),
    mid: rgbString(mid),
    end: rgbString(end),
    glow: `rgba(${mid.r}, ${mid.g}, ${mid.b}, 0.48)`
  };
}

function defaultPalette() {
  return {
    start: "var(--khbb-blood-700)",
    mid: "var(--khbb-blood-500)",
    end: "var(--khbb-blood-300)",
    glow: "rgba(123, 16, 24, 0.48)"
  };
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function hexToRgb(value) {
  const hex = String(value).replace("#", "");
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function onDragStart(event) {
  const resizeHandle = event.target.closest(".khbb-resize-handle");
  if (resizeHandle && event.button === 0) {
    onResizeStart(event, resizeHandle);
    return;
  }

  const handle = event.target.closest(".khbb-drag-handle, .khbb-restore-bars");
  if (!handle || event.button !== 0) return;

  const root = document.getElementById("khbb-root");
  if (!root) return;

  event.preventDefault();
  handle.setPointerCapture?.(event.pointerId);

  const rect = root.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: rect.left,
    top: rect.top,
    moved: false
  };

  root.classList.add("khbb-dragging");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  window.addEventListener("pointercancel", onDragEnd, { once: true });
}

function onResizeStart(event, handle) {
  const root = document.getElementById("khbb-root");
  if (!root || root.classList.contains("khbb-minimized")) return;

  event.preventDefault();
  handle.setPointerCapture?.(event.pointerId);

  const rect = root.getBoundingClientRect();
  const bossBar = handle.closest(".khbb-boss-bar");
  resizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    barHeight: currentBarHeight(root, bossBar),
    moved: false
  };

  root.classList.add("khbb-resizing");
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd, { once: true });
  window.addEventListener("pointercancel", onResizeEnd, { once: true });
}

function onDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const root = document.getElementById("khbb-root");
  if (!root) return;

  const x = dragState.left + event.clientX - dragState.startX;
  const y = dragState.top + event.clientY - dragState.startY;
  dragState.moved ||= Math.abs(event.clientX - dragState.startX) > 3 || Math.abs(event.clientY - dragState.startY) > 3;
  applyViewportPixelPosition(root, x, y);
}

function onResizeMove(event) {
  if (!resizeState || event.pointerId !== resizeState.pointerId) return;

  const root = document.getElementById("khbb-root");
  if (!root) return;

  const bounds = horizontalBoundsAvoidingFoundryUi();
  const safeLeft = Math.max(bounds.left, resizeState.left);
  const maxWidth = Math.max(1, bounds.right - safeLeft);
  const minWidth = Math.min(520, maxWidth);
  const minHeight = 48;
  const maxHeight = 112;
  const width = clamp(resizeState.width + event.clientX - resizeState.startX, minWidth, maxWidth);
  const height = clamp(resizeState.barHeight + event.clientY - resizeState.startY, minHeight, maxHeight);

  resizeState.moved ||= Math.abs(event.clientX - resizeState.startX) > 3 || Math.abs(event.clientY - resizeState.startY) > 3;
  applyPixelSize(root, width, height);
}

async function onDragEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const root = document.getElementById("khbb-root");
  const didMove = dragState.moved;
  dragState = null;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointercancel", onDragEnd);

  if (!root) return;

  root.classList.remove("khbb-dragging");
  const rect = root.getBoundingClientRect();
  if (didMove) suppressClickUntil = Date.now() + 250;
  if (root.classList.contains("khbb-minimized")) {
    minimizedPosition = captureAnchoredPosition(rect);
  } else {
    manualPosition = captureAnchoredPosition(rect);
  }
  applyRootPosition(root);
}

function onResizeEnd(event) {
  if (!resizeState || event.pointerId !== resizeState.pointerId) return;

  const root = document.getElementById("khbb-root");
  const didMove = resizeState.moved;
  resizeState = null;
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointercancel", onResizeEnd);

  if (!root) return;

  root.classList.remove("khbb-resizing");
  const rect = root.getBoundingClientRect();
  if (didMove) suppressClickUntil = Date.now() + 250;
  manualSize = normalizeSize({ width: rect.width, height: rect.height });
  manualBarHeight = currentBarHeight(root);
  applyRootPosition(root);
}

function applyRootPosition(root = document.getElementById("khbb-root")) {
  if (!root || dragState || resizeState) return;

  syncRootAnchor(root);
  applyRootWidth(root);
  applyRootHeight(root);

  if (root.classList.contains("khbb-minimized")) {
    const minimized = minimizedPosition ?? { x: null, y: null };
    if (minimized.x === null || minimized.y === null) {
      applyDefaultPosition(root);
      return;
    }

    applyPixelPosition(root, minimized.x, minimized.y);
    return;
  }

  const position = manualPosition ?? { x: null, y: null };
  if (position.x === null || position.y === null) {
    applyDefaultPosition(root);
    return;
  }

  applyPixelPosition(root, position.x, position.y);
}

function applyRootWidth(root) {
  if (root.classList.contains("khbb-minimized")) {
    root.style.removeProperty("width");
    root.style.removeProperty("max-width");
    return;
  }

  const bounds = horizontalBoundsAvoidingFoundryUi();
  const requestedWidth = manualSize?.width ?? bounds.width;
  const minimumWidth = Math.min(280, bounds.width);
  const width = clamp(requestedWidth, minimumWidth, bounds.width);
  root.style.width = `${Math.max(1, Math.round(width))}px`;
  root.style.maxWidth = "none";
}

function applyRootHeight(root) {
  if (root.classList.contains("khbb-minimized")) {
    root.style.removeProperty("--khbb-scale-height");
    return;
  }

  if (manualBarHeight) {
    root.style.setProperty("--khbb-scale-height", `${manualBarHeight}px`);
    return;
  }

  root.style.removeProperty("--khbb-scale-height");
}

function applyDefaultPosition(root) {
  root.classList.remove("khbb-positioned");
  const safeBounds = horizontalBoundsAvoidingFoundryUi();
  const rootWidth = root.getBoundingClientRect().width;
  const left = root.classList.contains("khbb-minimized")
    ? safeBounds.left + Math.max(0, (safeBounds.width - rootWidth) / 2)
    : safeBounds.left;

  root.style.left = `${Math.round(left)}px`;
  root.style.right = "auto";
  root.style.transform = "none";

  const rect = root.getBoundingClientRect();
  const rootLeft = rect.left;
  const rootRight = rect.right;
  if (configuredAnchor() === "bottom") {
    const bottom = bottomOffsetAvoidingFoundryUi(rootLeft, rootRight);
    root.style.top = "auto";
    root.style.bottom = `${bottom}px`;
  } else {
    const top = topOffsetAvoidingFoundryUi(rootLeft, rootRight);
    root.style.top = `${top}px`;
    root.style.bottom = "auto";
  }
}

function horizontalBoundsAvoidingFoundryUi() {
  const padding = 14;
  let left = padding;
  let right = window.innerWidth - padding;
  const selectors = [
    "#scene-controls",
    "#sidebar",
    "#sidebar-content.expanded",
    "#players",
    "#camera-views.vertical",
    "#smalltime-app"
  ];

  const elements = document.querySelectorAll(selectors.join(","));
  for (const element of elements) {
    if (!isVisibleElement(element)) continue;

    const rect = element.getBoundingClientRect();
    const isLeftDock = rect.right <= window.innerWidth * 0.5 && rect.height > 40;
    const isRightDock = rect.left >= window.innerWidth * 0.5 && rect.height > 40;

    if (isLeftDock) left = Math.max(left, rect.right + padding);
    if (isRightDock) right = Math.min(right, rect.left - padding);
  }

  left = clamp(left, padding, Math.max(padding, window.innerWidth - padding - 1));
  right = clamp(right, left + 1, window.innerWidth - padding);

  return {
    left: Math.round(left),
    right: Math.round(right),
    width: Math.round(right - left)
  };
}

function topOffsetAvoidingFoundryUi(rootLeft, rootRight) {
  const topPadding = 10;
  const gap = 10;
  const selectors = [
    "#navigation",
    "#scene-navigation > *",
    "#notifications > *"
  ];

  let top = topPadding;
  const elements = document.querySelectorAll(selectors.join(","));
  for (const element of elements) {
    if (element.id === "khbb-root" || !isVisibleElement(element)) continue;

    const rect = element.getBoundingClientRect();
    const isTopInterface = rect.top < window.innerHeight * 0.35;
    const overlapsHorizontally = rect.right > rootLeft && rect.left < rootRight;
    if (isTopInterface && overlapsHorizontally) top = Math.max(top, rect.bottom + gap);
  }

  return Math.round(clamp(top, topPadding, Math.max(topPadding, window.innerHeight - 72)));
}

function bottomOffsetAvoidingFoundryUi(rootLeft, rootRight) {
  const bottomPadding = 10;
  const gap = 10;
  const selectors = [
    "#hotbar",
    "#camera-views.horizontal",
    "#notifications > *"
  ];

  let bottom = bottomPadding;
  const elements = document.querySelectorAll(selectors.join(","));
  for (const element of elements) {
    if (element.id === "khbb-root" || !isVisibleElement(element)) continue;

    const rect = element.getBoundingClientRect();
    const isBottomInterface = rect.bottom > window.innerHeight * 0.65;
    const overlapsHorizontally = rect.right > rootLeft && rect.left < rootRight;
    if (isBottomInterface && overlapsHorizontally) {
      bottom = Math.max(bottom, window.innerHeight - rect.top + gap);
    }
  }

  return Math.round(clamp(bottom, bottomPadding, Math.max(bottomPadding, window.innerHeight - 72)));
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== "none"
    && style.visibility !== "hidden"
    && Number(style.opacity) !== 0;
}

function applyPixelPosition(root, x, y) {
  const rect = root.getBoundingClientRect();
  const padding = 8;
  const bounds = horizontalBoundsAvoidingFoundryUi();
  const maxX = Math.max(bounds.left, bounds.right - rect.width);
  const maxY = Math.max(padding, window.innerHeight - rect.height - padding);
  const nextX = clamp(x, bounds.left, maxX);
  const nextY = clamp(y, padding, maxY);

  root.classList.add("khbb-positioned");
  root.style.left = `${Math.round(nextX)}px`;
  root.style.right = "auto";
  root.style.transform = "none";

  if (configuredAnchor() === "bottom") {
    root.style.top = "auto";
    root.style.bottom = `${Math.round(nextY)}px`;
  } else {
    root.style.top = `${Math.round(nextY)}px`;
    root.style.bottom = "auto";
  }
}

function applyViewportPixelPosition(root, x, top) {
  const rect = root.getBoundingClientRect();
  const padding = 8;
  const bounds = horizontalBoundsAvoidingFoundryUi();
  const maxX = Math.max(bounds.left, bounds.right - rect.width);
  const maxTop = Math.max(padding, window.innerHeight - rect.height - padding);

  root.classList.add("khbb-positioned");
  root.style.left = `${Math.round(clamp(x, bounds.left, maxX))}px`;
  root.style.top = `${Math.round(clamp(top, padding, maxTop))}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";
  root.style.transform = "none";
}

function captureAnchoredPosition(rect) {
  const y = configuredAnchor() === "bottom"
    ? window.innerHeight - rect.bottom
    : rect.top;
  return normalizePosition({ x: rect.left, y });
}

function applyPixelSize(root, width, height) {
  root.style.width = `${Math.round(width)}px`;
  root.style.maxWidth = "none";
  root.style.setProperty("--khbb-scale-height", `${Math.round(height)}px`);
}

function currentBarHeight(root, bossBar = root?.querySelector(".khbb-boss-bar")) {
  if (!bossBar) return 66;

  const minHeight = Number.parseFloat(window.getComputedStyle(bossBar).minHeight);
  if (Number.isFinite(minHeight) && minHeight > 0) return Math.round(minHeight);

  return root?.classList.contains("khbb-multiple") ? 52 : 66;
}

function normalizePosition(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);

  return {
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null
  };
}

function normalizeSize(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);

  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  };
}

function addSceneControlTool(control, tool) {
  if (Array.isArray(control.tools)) {
    control.tools.push(tool);
    return;
  }

  if (control.tools && typeof control.tools === "object") {
    control.tools[tool.name] = tool;
  }
}

function closeOpenControls(root = document.getElementById("khbb-root")) {
  closeColorPanels(root);
  root?.querySelectorAll(".khbb-boss-bar.khbb-controls-open, .khbb-boss-bar.khbb-color-editing")
    .forEach(bar => bar.classList.remove("khbb-controls-open", "khbb-color-editing"));
}

function closeColorPanels(root = document.getElementById("khbb-root")) {
  root?.querySelectorAll(".khbb-color-panel-open")
    .forEach(panel => panel.classList.remove("khbb-color-panel-open"));
}

function findColorPanel(source, entryId) {
  const scope = source?.closest(".khbb-boss-bar") ?? document;
  return Array.from(scope.querySelectorAll("[data-khbb-color-panel]"))
    .find(panel => panel.dataset.khbbColorPanel === entryId);
}

function onDocumentClick(event) {
  const root = document.getElementById("khbb-root");
  if (!root || root.hidden || root.classList.contains("khbb-minimized") || dragState || resizeState) return;
  if (root.contains(event.target)) return;

  closeOpenControls(root);
}

function onRootClick(event) {
  const restoreButton = event.target.closest("[data-khbb-restore]");
  if (restoreButton) {
    event.preventDefault();
    if (Date.now() < suppressClickUntil) return;
    showBars();
    return;
  }

  const hideButton = event.target.closest("[data-khbb-hide]");
  if (hideButton) {
    event.preventDefault();
    hideBars();
    return;
  }

  const groupTrack = event.target.closest(".khbb-boss-bar > .khbb-content .khbb-track, .khbb-minion-track");
  if (groupTrack) {
    event.preventDefault();
    const bossBar = groupTrack.closest(".khbb-boss-bar");
    const isMinionTrack = groupTrack.classList.contains("khbb-minion-track");
    const shouldOpen = isMinionTrack || !bossBar.classList.contains("khbb-controls-open");

    bossBar.parentElement?.querySelectorAll(".khbb-boss-bar.khbb-controls-open")
      .forEach(bar => {
        if (bar === bossBar) return;
        closeOpenControls(bar.parentElement);
      });

    bossBar.classList.toggle("khbb-controls-open", shouldOpen);
    if (!shouldOpen) bossBar.classList.remove("khbb-color-editing");
    return;
  }

  const addMinionButton = event.target.closest("[data-khbb-add-minion]");
  if (addMinionButton) {
    event.preventDefault();
    addSelectedMinions(addMinionButton.dataset.khbbAddMinion);
    return;
  }

  const removeMinionButton = event.target.closest("[data-khbb-remove-minion]");
  if (removeMinionButton) {
    event.preventDefault();
    removeMinion(removeMinionButton.dataset.khbbBoss, removeMinionButton.dataset.khbbRemoveMinion);
    return;
  }

  const colorButton = event.target.closest("[data-khbb-color]");
  if (colorButton) {
    event.preventDefault();
    const panel = findColorPanel(colorButton, colorButton.dataset.khbbColor);
    const shouldOpen = !panel?.classList.contains("khbb-color-panel-open");
    closeColorPanels(colorButton.closest(".khbb-boss-bar"));
    panel?.classList.toggle("khbb-color-panel-open", shouldOpen);
    return;
  }

  const colorConfirm = event.target.closest("[data-khbb-color-confirm]");
  if (colorConfirm) {
    event.preventDefault();
    const colorInput = Array.from(document.querySelectorAll("[data-khbb-color-input]"))
      .find(input => input.dataset.khbbColorInput === colorConfirm.dataset.khbbColorConfirm);
    updateEntryColor(colorConfirm.dataset.khbbColorConfirm, colorInput?.value);
    colorConfirm.closest(".khbb-color-panel")?.classList.remove("khbb-color-panel-open");
    return;
  }

  const colorDefault = event.target.closest("[data-khbb-color-default]");
  if (colorDefault) {
    event.preventDefault();
    updateEntryColor(colorDefault.dataset.khbbColorDefault, "#b31d27");
    colorDefault.closest(".khbb-color-panel")?.classList.remove("khbb-color-panel-open");
    return;
  }

  const removeButton = event.target.closest("[data-khbb-remove]");
  if (!removeButton) return;

  event.preventDefault();
  removeBar(removeButton.dataset.khbbRemove);
}

function onRootContextMenu(event) {
  const colorButton = event.target.closest("[data-khbb-color]");
  if (!colorButton) return;

  event.preventDefault();
  updateEntryColor(colorButton.dataset.khbbColor, "#b31d27");
}

async function updateEntryColor(entryId, color) {
  if (!game.user?.isGM || !entryId || !isHexColor(color)) return;

  const normalizedColor = color.toLowerCase();
  let changed = false;
  const entries = getState().entries.map(entry => {
    if (entry.id === entryId) {
      changed = true;
      return { ...entry, color: normalizedColor };
    }

    const minions = entry.minions.map(minion => {
      if (minion.id !== entryId) return minion;
      changed = true;
      return { ...minion, color: normalizedColor };
    });

    return changed ? { ...entry, minions } : entry;
  });

  if (!changed) return;
  await setState(entries);
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimeout);
  refreshTimeout = window.setTimeout(() => refreshTrackedBars(), 150);
}

function entriesChanged(previousEntries, nextEntries) {
  if (previousEntries.length !== nextEntries.length) return true;

  return nextEntries.some((nextEntry, index) => creatureChanged(previousEntries[index], nextEntry));
}

function creatureChanged(previousEntry, nextEntry) {
  if (!previousEntry || !nextEntry) return true;

  if (previousEntry.id !== nextEntry.id
    || previousEntry.sceneId !== nextEntry.sceneId
    || previousEntry.tokenId !== nextEntry.tokenId
    || previousEntry.actorId !== nextEntry.actorId
    || previousEntry.name !== nextEntry.name
    || previousEntry.img !== nextEntry.img
    || previousEntry.color !== nextEntry.color
    || previousEntry.pct !== nextEntry.pct
    || previousEntry.sort !== nextEntry.sort
    || previousEntry.stale !== nextEntry.stale) {
    return true;
  }

  const previousMinions = previousEntry.minions || [];
  const nextMinions = nextEntry.minions || [];
  if (previousMinions.length !== nextMinions.length) return true;

  return nextMinions.some((nextMinion, index) => creatureChanged(previousMinions[index], nextMinion));
}

function mergeEntries(existingEntries, selectedEntries) {
  const merged = new Map(existingEntries.map(entry => [entry.id, entry]));

  for (const selectedEntry of selectedEntries) {
    const previousEntry = merged.get(selectedEntry.id);
    const sort = previousEntry?.sort ?? merged.size;
    merged.set(selectedEntry.id, normalizeEntry({ ...selectedEntry, sort }));
  }

  return Array.from(merged.values())
    .map((entry, index) => normalizeEntry({ ...entry, sort: index }))
    .filter(Boolean);
}

function mergeMinions(existingMinions = [], selectedMinions = []) {
  const merged = new Map(existingMinions.map(minion => [minion.id, minion]));

  for (const selectedMinion of selectedMinions) {
    const previousMinion = merged.get(selectedMinion.id);
    const sort = previousMinion?.sort ?? merged.size;
    merged.set(selectedMinion.id, normalizeMinion({ ...selectedMinion, sort }));
  }

  return Array.from(merged.values())
    .map((minion, index) => normalizeMinion({ ...minion, sort: index }))
    .filter(Boolean);
}

async function setState(entries) {
  if (!entries.length) {
    manualPosition = null;
    minimizedPosition = null;
    manualSize = null;
    manualBarHeight = null;
  }

  const state = {
    version: STATE_VERSION,
    entries: entries.map(normalizeEntry).filter(Boolean),
    updatedAt: Date.now()
  };

  await game.settings.set(MODULE_ID, SETTING_STATE, state);
}

function getState() {
  try {
    return normalizeState(game.settings.get(MODULE_ID, SETTING_STATE));
  } catch (_error) {
    return defaultState();
  }
}

function getDismissedState() {
  try {
    return normalizeDismissedState(game.settings.get(MODULE_ID, SETTING_DISMISSED));
  } catch (_error) {
    return defaultDismissedState();
  }
}

function normalizeState(value) {
  const entries = Array.isArray(value?.entries)
    ? value.entries.map(normalizeEntry).filter(Boolean)
    : [];

  return {
    version: Number(value?.version) || STATE_VERSION,
    entries: entries.sort((a, b) => a.sort - b.sort),
    updatedAt: Number(value?.updatedAt) || 0
  };
}

function normalizeEntry(entry) {
  const normalized = normalizeCreature(entry);
  if (!normalized) return null;

  const minions = Array.isArray(entry.minions)
    ? entry.minions.map(normalizeMinion).filter(Boolean)
    : [];

  return {
    ...normalized,
    color: isHexColor(entry.color) ? String(entry.color).toLowerCase() : null,
    minions: minions.sort((a, b) => a.sort - b.sort)
  };
}

function normalizeMinion(entry) {
  const normalized = normalizeCreature(entry);
  if (!normalized) return null;

  return {
    ...normalized,
    color: isHexColor(entry.color) ? String(entry.color).toLowerCase() : null
  };
}

function normalizeCreature(entry) {
  if (!entry) return null;

  const pct = clamp(Number(entry.pct), 0, 1);
  if (!Number.isFinite(pct)) return null;

  return {
    id: String(entry.id || `${entry.sceneId}.${entry.tokenId}`),
    sceneId: entry.sceneId ? String(entry.sceneId) : null,
    tokenId: entry.tokenId ? String(entry.tokenId) : null,
    actorId: entry.actorId ? String(entry.actorId) : null,
    name: String(entry.name || localize("Labels.Creature")),
    img: String(entry.img || ""),
    pct: Math.round(pct * 1000) / 1000,
    sort: Number(entry.sort) || 0,
    stale: Boolean(entry.stale),
    updatedAt: Number(entry.updatedAt) || Date.now()
  };
}

function defaultState() {
  return {
    version: STATE_VERSION,
    entries: [],
    updatedAt: 0
  };
}

function normalizeDismissedState(value) {
  return {
    updatedAt: Number(value?.updatedAt) || 0
  };
}

function defaultDismissedState() {
  return {
    updatedAt: 0
  };
}

function isStateDismissed(state) {
  const dismissedState = getDismissedState();
  return state.entries.length > 0 && dismissedState.updatedAt === state.updatedAt;
}

function trackedEntries() {
  return getState().entries;
}

function trackedCreatures() {
  return flattenCreatures(getState().entries);
}

function flattenCreatures(entries = []) {
  return entries.flatMap(entry => [entry, ...(entry.minions || [])]);
}

function entryMatchesToken(entry, tokenDocument) {
  const sceneId = tokenDocument.parent?.id ?? canvas?.scene?.id;
  return entry.sceneId === sceneId && entry.tokenId === tokenDocument.id;
}

function isPrimaryGM() {
  const activeGms = game.users
    .filter(user => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id));

  return activeGms[0]?.id === game.user.id;
}

function healthStatus(pct) {
  if (pct <= 0) return "defeated";
  if (pct <= 0.25) return "critical";
  if (pct <= 0.5) return "wounded";
  if (pct <= 0.75) return "hurt";
  return "healthy";
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  let hue = 0;

  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  if (max === green) hue = (blue - red) / delta + 2;
  if (max === blue) hue = (red - green) / delta + 4;

  return { h: hue / 6, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }) {
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
  };
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function rgbString({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  };

  return String(value).replace(/[&<>"']/g, character => map[character]);
}

function localize(key) {
  return game.i18n?.localize?.(`KHBB.${key}`) ?? key;
}
