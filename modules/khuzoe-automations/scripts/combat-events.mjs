const MODULE = "khuzoe-automations";
const pending = new Map();
const completed = new Set();
const queues = new Map();
const installed = new WeakSet();

export function isCombatExecutor() {
  if (!globalThis.game?.user?.isGM) return false;
  const query = globalThis.cat?.utils?.queryUtils;
  if (query?.isTheGM) return query.isTheGM();
  const gm = query?.gmUser?.() ?? globalThis.game?.users?.activeGM;
  return !gm || gm.id === game.user.id;
}

export function combatTurnKey({combat = globalThis.game?.combat, round, turn} = {}) {
  if (!combat?.started || !combat.isActive) return;
  round ??= combat.current?.round ?? combat.round;
  turn ??= combat.current?.turn ?? combat.turn;
  if (!(round > 0) || !Number.isInteger(turn) || turn < 0) return;
  return `${combat.id}:${round}:${turn}`;
}

/** A combat callback performs an effect; its result must not stop CAT's chain. */
export function combatCallback(callback, definition, trigger, index) {
  return async function khuzoeCombatCallback(context = {}) {
    if (!isCombatExecutor() || context.context?.turnEvents === false) return;
    const combat = context.combat ?? globalThis.game?.combat;
    const phase = trigger.pass.endsWith("TurnEnd") ? combat?.previous : combat?.current;
    const scoped = {...context, combat, round: context.round ?? phase?.round, turn: context.turn ?? phase?.turn};
    const stamp = combatTurnKey(scoped);
    const key = stamp && [stamp, definition.identifier, index, trigger.pass,
      context.document?.uuid ?? context.document?.id, context.token?.uuid ?? context.token?.id].join("|");
    if (key && completed.has(key)) return;
    if (key && pending.has(key)) { await pending.get(key); return; }
    const task = Promise.resolve().then(() => {
      const document = scoped.document;
      if (document?.documentName === "ActiveEffect" && (document.disabled || document.isSuppressed
        || document.active === false || document.duration?.expired)) return false;
      return callback(scoped);
    }).then(result => {
      if (key && result !== false && !result?.aborted) {
        completed.add(key);
        if (completed.size > 2048) completed.delete(completed.values().next().value);
      }
    });
    if (key) pending.set(key, task);
    try { await task; }
    finally { if (key && pending.get(key) === task) pending.delete(key); }
  };
}

/** Recover Khuzoe callbacks if an earlier CAT/core event failed. */
export function triggerCombatFallback(combat, prior = combat?.previous, current = combat?.current) {
  if (!isCombatExecutor() || !combat?.started || !combat.isActive) return Promise.resolve(false);
  if (!(current?.round > (prior?.round ?? 0)
    || (current?.round === prior?.round && current?.turn > prior?.turn))) return Promise.resolve(false);
  const CombatEvent = globalThis.cat?.lib?.Events?.CombatEvent;
  if (!CombatEvent) return Promise.resolve(false);
  const events = [];
  for (const [state, pass] of [[prior, "turnEnd"], [current, "turnStart"]]) {
    if (!state || !combatTurnKey({combat, ...state})) continue;
    const combatant = combat.combatants?.get?.(state.combatantId);
    const token = combatant?.token?.document ?? combatant?.token;
    if (!token?.actor) continue;
    try {
      const event = new CombatEvent(combat, pass, token, {combatant, round: state.round, turn: state.turn});
      // CAT still selects the strongest overlapping effect and orders priorities.
      // Snapshot targets and context before waiting for another turn's workflows.
      event.canOverlap = false;
      events.push(...event.sortedTriggers.filter(entry => entry.macroClass?.source === MODULE)
        .map(entry => ({...entry, combat})));
    } catch (error) {
      console.error("Khuzoe Automations | Raccolta degli effetti di turno non riuscita.", error);
    }
  }
  const previous = queues.get(combat.id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    for (const entry of events) {
      try { await entry.macro(entry); }
      catch (error) {
        console.error(`Khuzoe Automations | Effetto di turno non riuscito: ${entry.name}.`, error);
      }
    }
    return events.length > 0;
  });
  queues.set(combat.id, task);
  void task.finally(() => { if (queues.get(combat.id) === task) queues.delete(combat.id); });
  return task;
}

export function registerCombatFallbackHooks(hooks = globalThis.Hooks) {
  if (!hooks || installed.has(hooks)) return;
  installed.add(hooks);
  hooks.on("combatTurnChange", (combat, prior, current) => { void triggerCombatFallback(combat, prior, current); });
  hooks.on("updateCombat", (combat, changes, options) => {
    if (options?.turnEvents === false) return;
    if (!["round", "turn"].some(key => Object.hasOwn(changes ?? {}, key))) return;
    void triggerCombatFallback(combat);
  });
}
