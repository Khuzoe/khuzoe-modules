import { MODULE_ID, SETTINGS } from "./constants.js";
import { AuraStore } from "./store.js";
import { buildLedgerKey, ExecutionLedger } from "./ledger.js";
import {
  getEligibleTargets,
  isSourceOperational,
  isTargetEligible
} from "./targeting.js";
import { createId } from "./model.js";
import { buildChatSummary } from "./chat-summary.js";

export class AuraEngine {
  #registry;
  #ledger = new ExecutionLedger();
  #membership = new Map();
  #queue = Promise.resolve();

  constructor(registry) {
    this.#registry = registry;
  }

  get actionTypes() {
    return this.#registry.types;
  }

  initialize() {
    this.#ledger.clear();
    this.#membership.clear();
    for (const scene of game.scenes ?? []) this.refreshMembership(scene, { emit: false });
  }

  get isExecutor() {
    if (typeof game.user?.isActiveGM === "boolean") return game.user.isActiveGM;
    return game.users?.activeGM?.id === game.user?.id;
  }

  enqueue(task, label = "task") {
    this.#queue = this.#queue
      .then(() => this.isExecutor ? task() : undefined)
      .catch(error => {
        console.error(`Khuzoe Auras | ${label} failed.`, error);
        if (this.isExecutor) {
          ui.notifications.error(game.i18n.format("KHZ_AURAS.Errors.Execution", {
            message: error.message
          }));
        }
      });
    return this.#queue;
  }

  handleCombatTurnChange(combat, prior, current) {
    const scene = resolveCombatScene(combat, current);
    if (!this.isExecutor || !scene || combat?.started === false || combat?.isActive === false
      || !(Number(current?.round ?? 0) > 0) || !isForwardTransition(prior, current)) return;

    return this.enqueue(async () => {
      const startedAt = performance.now();
      const results = [];

      if (prior?.tokenId) {
        const previousToken = scene.tokens.get(prior.tokenId);
        if (previousToken) {
          results.push(...await this.#dispatchTurnPhase(
            scene,
            "turnEnd",
            previousToken,
            eventContextForCombat(combat, prior, "turnEnd")
          ));
        }
      }

      if (Number(current?.round ?? 0) > Number(prior?.round ?? 0)) {
        if (Number(prior?.round ?? 0) > 0) {
          results.push(...await this.#dispatchRoundPhase(
            scene,
            "roundEnd",
            eventContextForCombat(combat, prior, "roundEnd")
          ));
        }
        results.push(...await this.#dispatchRoundPhase(
          scene,
          "roundStart",
          eventContextForCombat(combat, current, "roundStart")
        ));
      }

      if (current?.tokenId) {
        const currentToken = scene.tokens.get(current.tokenId);
        if (currentToken) {
          results.push(...await this.#dispatchTurnPhase(
            scene,
            "turnStart",
            currentToken,
            eventContextForCombat(combat, current, "turnStart")
          ));
        }
      }

      await this.#postSummary(results, scene);
      this.#debug("Combat transition processed.", {
        results: results.length,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100
      });
    }, "combat transition");
  }

  refreshMembership(scene, { emit = false } = {}) {
    if (!scene) return Promise.resolve();

    const task = async () => {
      const startedAt = performance.now();
      const previous = this.#membership.get(scene.id) ?? new Map();
      const next = new Map();
      const sources = new Map();
      let comparisons = 0;

      for (const { token: source, aura } of AuraStore.getSources(scene)) {
        if (aura.visualOnly) continue;
        if (!isSourceOperational(source, aura)) continue;
        const key = membershipKey(source.id, aura.id);
        const members = new Set();
        sources.set(key, { source, aura });

        for (const target of scene.tokens ?? []) {
          comparisons += 1;
          if (isTargetEligible(scene, source, target, aura)) members.add(target.id);
        }
        next.set(key, members);
      }

      this.#membership.set(scene.id, next);
      if (!emit || !this.isExecutor) {
        this.#debug("Membership refreshed.", {
          scene: scene.name,
          comparisons,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100
        });
        return;
      }

      const enteredCandidates = [];
      const exitedCandidates = [];
      for (const [key, members] of next.entries()) {
        if (!previous.has(key)) continue;
        const { source, aura } = sources.get(key);
        const oldMembers = previous.get(key);

        const entered = [...members]
          .filter(tokenId => !oldMembers.has(tokenId))
          .map(tokenId => scene.tokens.get(tokenId))
          .filter(Boolean);
        const exited = [...oldMembers]
          .filter(tokenId => !members.has(tokenId))
          .map(tokenId => scene.tokens.get(tokenId))
          .filter(Boolean);

        for (const trigger of aura.triggers.filter(entry => entry.event === "enter")) {
          for (const target of entered) {
            enteredCandidates.push({ scene, source, aura, trigger, target, ignoreRange: false });
          }
        }
        for (const trigger of aura.triggers.filter(entry => entry.event === "exit")) {
          for (const target of exited) {
            exitedCandidates.push({ scene, source, aura, trigger, target, ignoreRange: true });
          }
        }
      }

      const results = [
        ...await this.#executeCandidates(
          enteredCandidates,
          eventContextForMovement("enter")
        ),
        ...await this.#executeCandidates(
          exitedCandidates,
          eventContextForMovement("exit")
        )
      ];
      await this.#postSummary(results, scene);
      this.#debug("Membership transition processed.", {
        scene: scene.name,
        comparisons,
        results: results.length,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100
      });
    };

    return emit ? this.enqueue(task, "membership transition") : task();
  }

  async activateAura(source, auraId) {
    if (!this.isExecutor) {
      ui.notifications.warn(game.i18n.localize("KHZ_AURAS.Errors.GMOnly"));
      return;
    }

    const aura = AuraStore.getAura(source, auraId);
    const scene = source?.parent;
    if (!aura || !scene || !isSourceOperational(source, aura) || aura.visualOnly) return;

    const triggers = aura.triggers.filter(trigger => trigger.event === "manual");
    if (!triggers.length) {
      ui.notifications.warn(game.i18n.localize("KHZ_AURAS.Errors.NoManualTrigger"));
      return;
    }

    return this.enqueue(async () => {
      const currentAura = AuraStore.getAura(source, auraId);
      if (scene.tokens.get(source.id) !== source || !currentAura || currentAura.visualOnly || !isSourceOperational(source, currentAura)) return;
      const rollCache = new Map();
      const results = [];
      for (const trigger of currentAura.triggers.filter(entry => entry.event === "manual")) {
        results.push(...await this.#executeAuraTargets({
          scene,
          source,
          aura: currentAura,
          trigger,
          targets: getEligibleTargets(scene, source, currentAura),
          eventContext: eventContextForMovement("manual"),
          rollCache
        }));
      }
      await this.#postSummary(results, scene);
    }, "manual activation");
  }

  async #dispatchTurnPhase(scene, event, subjectToken, eventContext) {
    const candidates = [];

    for (const { token: source, aura } of AuraStore.getSources(scene)) {
      if (aura.visualOnly) continue;
      if (!isSourceOperational(source, aura)) continue;

      for (const trigger of aura.triggers.filter(entry => entry.event === event)) {
        if (trigger.subject === "source" && source.id === subjectToken.id) {
          for (const target of getEligibleTargets(scene, source, aura)) {
            candidates.push({ scene, source, aura, trigger, target });
          }
        } else if (
          trigger.subject === "affected"
          && isTargetEligible(scene, source, subjectToken, aura)
        ) {
          candidates.push({ scene, source, aura, trigger, target: subjectToken });
        }
      }
    }

    return this.#executeCandidates(candidates, eventContext);
  }

  async #dispatchRoundPhase(scene, event, eventContext) {
    const candidates = [];
    for (const { token: source, aura } of AuraStore.getSources(scene)) {
      if (aura.visualOnly) continue;
      if (!isSourceOperational(source, aura)) continue;
      for (const trigger of aura.triggers.filter(entry => entry.event === event)) {
        for (const target of getEligibleTargets(scene, source, aura)) {
          candidates.push({ scene, source, aura, trigger, target });
        }
      }
    }
    return this.#executeCandidates(candidates, eventContext);
  }

  async #executeCandidates(candidates, eventContext) {
    const selected = resolveStacking(candidates);
    const rollCache = new Map();
    const results = [];

    for (const candidate of selected) {
      results.push(...await this.#executeAuraTargets({
        ...candidate,
        targets: [candidate.target],
        eventContext,
        rollCache
      }));
    }
    return results;
  }

  async #executeAuraTargets({
    scene,
    source,
    aura,
    trigger,
    targets,
    eventContext,
    rollCache,
    ignoreRange = false
  }) {
    const results = [];
    if (!this.isExecutor || aura.visualOnly || !isSourceOperational(source, aura)) return results;
    for (const target of targets) {
      if (!isTargetEligible(scene, source, target, aura, { ignoreRange })) continue;
      if (AuraStore.isImmune(source, aura.id, target.id)) continue;

      const ledgerKey = buildLedgerKey({
        ...eventContext,
        sourceId: source.id,
        auraId: aura.id,
        targetId: target.id,
        frequency: trigger.frequency
      });
      for (const action of aura.actions) {
        if (!this.isExecutor) return results;
        const actionKey = `${ledgerKey}:${action.id}`;
        if (!this.#ledger.claim(actionKey)) continue;
        let executed = false;
        try {
          let result = await this.#registry.execute(action, {
            scene,
            source,
            aura,
            trigger,
            target,
            eventContext,
            rollCache
          });
          executed = true;
          if (result.grantAuraImmunity) {
            await AuraStore.grantImmunity(source, aura.id, target.id);
            result = { ...result, auraImmunityGranted: true };
          }
          results.push({
            sourceId: source.id, sourceName: source.name,
            targetId: target.id, targetName: target.name,
            auraId: aura.id, auraName: aura.name,
            ...result, event: eventContext.event, triggerSubject: trigger.subject
          });
          if (result.auraImmunityGranted) break;
        } catch (error) {
          if (!executed) this.#ledger.release(actionKey);
          console.error("Khuzoe Auras | Action execution failed.", {
            source: source.name,
            target: target.name,
            aura: aura.name,
            action,
            error
          });
          results.push({
            status: "error",
            actionType: action.type,
            sourceId: source.id,
            sourceName: source.name,
            targetId: target.id,
            targetName: target.name,
            auraId: aura.id,
            auraName: aura.name,
            event: eventContext.event,
            triggerSubject: trigger.subject,
            error: error.message
          });
        }
      }
    }
    return results;
  }

  async #postSummary(results, scene) {
    if (!results.length) return;

    const templateData = buildChatSummary(results);
    const render = globalThis.foundry?.applications?.handlebars?.renderTemplate
      ?? globalThis.renderTemplate;
    if (typeof render !== "function") throw new Error("Foundry template renderer is unavailable.");
    const content = await render(
      `modules/${MODULE_ID}/templates/chat-summary.hbs`,
      templateData
    );

    const rolls = [];
    const seenRolls = new Set();
    for (const result of results) {
      for (const roll of [result.roll, result.save?.roll]) {
        if (!roll || seenRolls.has(roll)) continue;
        seenRolls.add(roll);
        rolls.push(roll);
      }
    }

    const first = results[0];
    const sourceToken = scene.tokens.get(first.sourceId);
    const singleSource = results.every(result => result.sourceId === first.sourceId);
    const singleAura = results.every(result => result.auraId === first.auraId && result.sourceId === first.sourceId);
    const ChatMessageClass = globalThis.foundry?.documents?.ChatMessage?.implementation
      ?? globalThis.CONFIG?.ChatMessage?.documentClass
      ?? globalThis.ChatMessage;
    if (!ChatMessageClass?.create || !ChatMessageClass?.getSpeaker) {
      throw new Error("Foundry ChatMessage document class is unavailable.");
    }
    const messageData = {
      speaker: singleSource ? ChatMessageClass.getSpeaker({
        scene,
        token: sourceToken,
        actor: sourceToken?.actor,
        alias: first.sourceName
      }) : { scene: scene.id, alias: templateData.title },
      flavor: singleAura ? first.auraName : templateData.title,
      content,
      rolls,
      flags: {
        [MODULE_ID]: {
          summary: true
        }
      }
    };
    if (typeof ChatMessageClass.applyMode === "function") {
      ChatMessageClass.applyMode(messageData);
    } else if (typeof ChatMessageClass.applyRollMode === "function") {
      ChatMessageClass.applyRollMode(messageData, game.settings.get("core", "rollMode"));
    }
    await ChatMessageClass.create(messageData);
  }

  #debug(message, data) {
    if (!game.settings.get(MODULE_ID, SETTINGS.DEBUG)) return;
    console.debug(`Khuzoe Auras | ${message}`, data);
  }
}

export function resolveStacking(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const configuredGroup = candidate.aura.stacking?.group?.trim();
    const group = configuredGroup || `${candidate.source.id}:${candidate.aura.id}`;
    const key = `${candidate.target.id}:${group}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }

  const selected = [];
  for (const group of groups.values()) {
    const mode = group[0]?.aura.stacking?.mode ?? "stack";
    if (mode === "stack") {
      selected.push(...group);
      continue;
    }
    if (mode === "highest") {
      selected.push(group.toSorted((left, right) => (
        Number(right.aura.stacking?.priority ?? 0) - Number(left.aura.stacking?.priority ?? 0)
      ))[0]);
      continue;
    }
    selected.push(group[0]);
  }
  return selected;
}

function isForwardTransition(prior, current) {
  if (!current || current.turn === null || current.turn === undefined) return false;
  if (!prior || prior.turn === null || prior.turn === undefined) return true;

  const priorRound = Number(prior.round ?? 0);
  const currentRound = Number(current.round ?? 0);
  if (currentRound !== priorRound) return currentRound > priorRound;
  const priorTurn = Number(prior.turn);
  const currentTurn = Number(current.turn);
  if (currentTurn !== priorTurn) return currentTurn > priorTurn;
  return Boolean(current.combatantId && current.combatantId !== prior.combatantId);
}

function resolveCombatScene(combat, state) {
  if (combat?.scene?.tokens) return combat.scene;
  if (typeof combat?.scene === "string") {
    const linked = game.scenes?.get?.(combat.scene);
    if (linked) return linked;
  }
  const combatant = combat?.combatants?.get?.(state?.combatantId);
  return combatant?.token?.parent ?? canvas?.scene ?? null;
}

function eventContextForCombat(combat, state, event) {
  return {
    combatId: combat.id,
    round: Number(state?.round ?? combat.round ?? 0),
    turn: Number(state?.turn ?? combat.turn ?? 0),
    event,
    eventId: [combat.id, state?.round ?? combat.round, state?.turn ?? combat.turn, event].join(":")
  };
}

function eventContextForMovement(event) {
  const combat = game.combat?.started && game.combat?.isActive !== false ? game.combat : null;
  return {
    combatId: combat?.id ?? "no-combat",
    round: Number(combat?.round ?? 0),
    turn: Number(combat?.turn ?? 0),
    event,
    eventId: createId("event")
  };
}

function membershipKey(sourceId, auraId) {
  return `${sourceId}:${auraId}`;
}
