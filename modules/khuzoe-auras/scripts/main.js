import {
  MODULE_ID,
  MODULE_TITLE,
  MOVEMENT_FIELDS,
  SETTINGS
} from "./constants.js";
import { registerBuiltInActions } from "./actions.js";
import { AuraConfigApplication } from "./config.js";
import { AuraEngine } from "./engine.js";
import { AuraActionRegistry } from "./registry.js";
import { AuraRenderer } from "./renderer.js";
import { AuraStore } from "./store.js";
import { waitForTokenArrival } from "./movement.js";
import { canConfigureAuraToken } from "./permissions.js";
import { auraRadiusPixels, tokenCenter, tokenPixelBounds, isWithinAura } from "./distance.js";
import {
  getEligibleTargets as collectEligibleTargets,
  isSourceOperational,
  isTargetEligible as checkTargetEligibility
} from "./targeting.js";

const registry = new AuraActionRegistry();
const engine = new AuraEngine(registry);
const renderer = new AuraRenderer();
const movementRevisions = new Map();

Hooks.once("init", () => {
  registerSettings();
  registerBuiltInActions(registry);

  game.khuzoeAuras = {
    geometry: Object.freeze({auraRadiusPixels, tokenCenter, tokenPixelBounds, isWithinAura}),
    registerActionType: (type, handler, options) => registry.register(type, handler, options),
    registerVisualProvider: (id, provider) => renderer.registerVisualProvider(id, provider),
    getAuras: token => AuraStore.getAuras(token?.document ?? token),
    getAura: (token, auraId) => AuraStore.getAura(token?.document ?? token, auraId),
    isAuraImmune: (token, target, auraId) => AuraStore.isImmune(
      token?.document ?? token,
      auraId,
      (target?.document ?? target)?.id
    ),
    getAuraSources: (scene, auraId = null) => AuraStore
      .getSources(scene ?? canvas?.scene)
      .filter(({ aura }) => !auraId || aura.id === auraId),
    getEligibleTargets: (token, auraId, options = {}) => {
      const source = token?.document ?? token;
      const scene = source?.parent ?? canvas?.scene;
      const aura = AuraStore.getAura(source, auraId);
      if (!scene || !aura || aura.visualOnly || !checkSourceToken(scene, source)) return [];
      if (!options.includeInactiveSource && !isSourceOperational(source, aura)) return [];
      return collectEligibleTargets(scene, source, aura);
    },
    isTargetEligible: (token, target, auraId, options = {}) => {
      const source = token?.document ?? token;
      const targetDocument = target?.document ?? target;
      const scene = source?.parent ?? targetDocument?.parent ?? canvas?.scene;
      const aura = AuraStore.getAura(source, auraId);
      if (!scene || !aura || aura.visualOnly || !checkSourceToken(scene, source) || !isSourceOperational(source, aura)) return false;
      return checkTargetEligibility(scene, source, targetDocument, aura, options);
    },
    setAuras: async (token, auras) => {
      const document = token?.document ?? token;
      const result = await AuraStore.setAuras(document, auras);
      await refreshSceneMembership(document.parent, { emit: false });
      renderer.requestRefresh();
      return result;
    },
    activateAura: (token, auraId) => engine.activateAura(token?.document ?? token, auraId),
    refresh: scene => refreshSceneMembership(scene ?? canvas?.scene, { emit: false })
  };
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    ui.notifications.error(game.i18n.localize("KHZ_AURAS.Errors.WrongSystem"), {
      permanent: true
    });
    return;
  }

  engine.initialize();
  renderer.requestRefresh();
  Hooks.callAll("khuzoeAuras.ready", game.khuzoeAuras);
  console.info(`${MODULE_TITLE} | Ready for Foundry ${game.version} and dnd5e ${game.system.version}.`);
});

Hooks.on("combatTurnChange", (combat, prior, current) => {
  engine.handleCombatTurnChange(combat, prior, current);
});

// Foundry v14 emette combatTurnChange soltanto dopo avere atteso tutti i
// workflow nativi di fine/inizio turno. Se un ActiveEffect di un altro modulo
// fallisce prima, l'hook tardivo non viene raggiunto e l'aura salta del tutto.
// updateCombat fornisce un ingresso precoce indipendente; il ledger del motore
// rende sicura la successiva notifica ufficiale senza applicazioni duplicate.
Hooks.on("updateCombat", (combat, changed, options) => {
  if (options?.turnEvents === false) return;
  if (!["round", "turn", "combatants"].some(field => Object.hasOwn(changed ?? {}, field))) return;
  engine.handleCombatTurnChange(combat, combat.previous, combat.current);
});

Hooks.on("renderTokenHUD", (hud, html) => {
  const token = hud.object;
  if (!token?.document || !canConfigureAuraToken(token.document)) return;

  const root = html instanceof HTMLElement ? html : html[0];
  const column = root.querySelector(".col.right") ?? root;
  if (column.querySelector(".khz-aura-hud-control")) return;

  const control = document.createElement("div");
  control.className = "control-icon khz-aura-hud-control";
  control.dataset.tooltip = "KHZ_AURAS.HUD.Configure";
  control.setAttribute("aria-label", game.i18n.localize("KHZ_AURAS.HUD.Configure"));
  control.innerHTML = '<i class="fa-solid fa-sun"></i>';
  control.classList.toggle(
    "active",
    AuraStore.getAuras(token.document).some(aura => aura.enabled)
  );
  control.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    new AuraConfigApplication(token.document, engine).render({ force: true });
  });
  column.append(control);
});

Hooks.on("canvasReady", canvasInstance => {
  refreshSceneMembership(canvasInstance.scene, { emit: false });
  renderer.requestRefresh();
});

Hooks.on("canvasTearDown", () => renderer.clear());

Hooks.on("updateToken", (token, changed) => {
  handleTokenUpdate(token, changed).catch(error => {
    console.error("Khuzoe Auras | Token arrival handling failed.", error);
  });
});

Hooks.on("createToken", token => {
  refreshSceneMembership(token.parent, { emit: false });
  if (canvas?.scene?.id === token.parent?.id) renderer.requestRefresh();
});

Hooks.on("deleteToken", token => {
  refreshSceneMembership(token.parent, { emit: false });
  if (canvas?.scene?.id === token.parent?.id) renderer.requestRefresh();
});

Hooks.on("updateActor", (actor, changed) => {
  if (!hasChangedPath(changed, "system.attributes.hp")) return;
  refreshActorScenes(actor);
});

for (const hookName of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hookName, effect => refreshActorScenes(effect.parent));
}

Hooks.on("updateWall", wall => {
  refreshSceneMembership(wall.parent, { emit: false });
});

async function handleTokenUpdate(token, changed) {
  const scene = token.parent;
  if (!scene || !hasRelevantTokenChange(changed)) return;

  const movement = MOVEMENT_FIELDS.some(field => Object.hasOwn(changed, field));
  if (movement) {
    const key = token.uuid ?? `${scene.id}:${token.id}`;
    const revision = (movementRevisions.get(key) ?? 0) + 1;
    movementRevisions.set(key, revision);

    await waitForTokenArrival(token);
    if (movementRevisions.get(key) !== revision) return;
    movementRevisions.delete(key);
  }

  await refreshSceneMembership(scene, { emit: movement });
  if (canvas?.scene?.id === scene.id) renderer.requestRefresh();
}

function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.SHOW_VISUALS, {
    name: "KHZ_AURAS.Settings.ShowVisuals.Name",
    hint: "KHZ_AURAS.Settings.ShowVisuals.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => renderer.requestRefresh()
  });


  game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
    name: "KHZ_AURAS.Settings.Debug.Name",
    hint: "KHZ_AURAS.Settings.Debug.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true
  });
}


function hasRelevantTokenChange(changed) {
  if (MOVEMENT_FIELDS.some(field => Object.hasOwn(changed, field))) return true;
  return hasChangedPath(changed, `flags.${MODULE_ID}`);
}

function hasChangedPath(changed, path) {
  if (foundry.utils.hasProperty(changed, path)) return true;
  return Object.keys(changed ?? {}).some(key => key === path || key.startsWith(`${path}.`));
}

function refreshSceneMembership(scene, options = {}) {
  // Actor/effect updates during an animation must not consume the pending
  // membership transition. The final arriving token dispatches it once.
  if (Array.from(scene?.tokens ?? []).some(token => movementRevisions.has(token.uuid ?? `${scene.id}:${token.id}`))) return;
  return engine.refreshMembership(scene, options);
}

function refreshActorScenes(actor) {
  if (!actor) return;
  for (const scene of game.scenes ?? []) {
    const containsActor = [...scene.tokens].some(token => (
      token.actor?.uuid === actor.uuid || token.actor?.id === actor.id
    ));
    if (!containsActor) continue;
    refreshSceneMembership(scene, { emit: false });
    if (canvas?.scene?.id === scene.id) renderer.requestRefresh();
  }
}

function checkSourceToken(scene, source) {
  if (!source?.id || !scene?.tokens) return false;
  return scene.tokens.get?.(source.id) === source
    || [...scene.tokens].some(token => token.id === source.id);
}
