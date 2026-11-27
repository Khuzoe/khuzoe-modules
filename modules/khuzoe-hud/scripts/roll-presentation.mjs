// A chat action can await a dialog or Midi's own dice animation. Dice So Nice
// can also animate rolls appended by another client after the action returns.
const actions = new WeakMap();
const waiting = new WeakMap();

function rolling(message) {
  return actions.has(message) || (message._dice3danimating && game.dice3d
    && !game.dice3d.messageHookDisabled && !game.settings.get("dice-so-nice", "immediatelyDisplayChatMessages"));
}

export function pendingRoll(message) {
  if (!rolling(message)) return;
  if (!waiting.has(message)) waiting.set(message, Promise.withResolvers());
  return waiting.get(message).promise;
}

function release(message) {
  waiting.get(message)?.resolve();
  waiting.delete(message);
}

function finish(message) {
  if (message && waiting.has(message) && !rolling(message)) release(message);
}

async function duringRoll(message, roll) {
  if (!message?.isContentVisible) return roll();
  actions.set(message, (actions.get(message) ?? 0) + 1);
  try {
    return await roll();
  } finally {
    const count = actions.get(message) - 1;
    if (count) actions.set(message, count);
    else actions.delete(message);
    finish(message);
  }
}

function wrapActions() {
  const classes = new Set(Object.values(CONFIG.DND5E.activityTypes).map(type => type.documentClass).filter(Boolean));
  const handlers = new Set([...classes].map(type => type.metadata?.usage?.actions));
  for (const handler of handlers) {
    if (!handler || Object.isFrozen(handler)) continue;
    for (const [name, action] of Object.entries(handler)) {
      if (!/^roll[A-Z]/.test(name) || typeof action !== "function") continue;
      handler[name] = function(...args) {
        return duringRoll(args[2], () => action.apply(this, args));
      };
    }
  }
  // Auto-rolls initiated from a sheet also update an existing Midi usage card.
  if (!game.modules?.get("midi-qol")?.active) return;
  for (const type of classes) {
    for (const name of ["rollAttack", "rollDamage", "rollFormula"]) {
      const roll = type.prototype?.[name];
      if (typeof roll !== "function") continue;
      type.prototype[name] = function(...args) {
        const message = args[0]?.workflow?.chatCard;
        if (!message) return roll.apply(this, args);
        return duringRoll(message, () => roll.apply(this, args));
      };
    }
  }
}

// Delay only roll presentation. Audience, identity, visibility flags, and
// explicitly requested redraws must always go through Foundry immediately.
const rollFields = new Set(["_id", "_stats", "rolls", "content", "flags", "style"]);
const midiFields = new Set(["type", "attackRoll", "attackRollCount", "d20AttackRoll", "attackTotal", "damageRoll",
  "damageRollCount", "damageRolls", "damageTotal", "otherDamageTotal", "bonusDamageTotal", "damageDetail",
  "otherDamageDetail", "bonusDamageDetail", "isHit", "isHitEC", "isCritical", "isFumble", "targets", "targetUuids",
  "hitTargetUuids", "hitECTargetUuids", "currentAction", "damageList", "saveAttribution", "saveDisplayData"]);
function rollChange(change) {
  if (!change || !Object.keys(change).every(key => rollFields.has(key))) return false;
  return Object.entries(change.flags ?? {}).every(([scope, flags]) => {
    if (!flags) return false;
    if (scope === "khuzoe-hud") return Object.keys(flags).every(key => ["childAttack", "reducedId", "outcomes"].includes(key));
    if (scope === "midi-qol") return Object.keys(flags).every(key => midiFields.has(key)
      || (key === "GMOnlyAttackRoll" && flags[key] === false));
    return scope === "dnd5e" && Object.keys(flags).every(key => key === "roll" || key === "targets");
  });
}

export function registerRollPresentation() {
  Hooks.once("ready", () => {
    wrapActions();
    const chat = ui.chat;
    const update = chat.updateMessage.bind(chat);
    const tickets = new WeakMap();
    const queued = new WeakMap();
    Hooks.on("updateChatMessage", (message, change) => {
      const ticket = tickets.get(message);
      if (ticket) ticket.change = change;
    });
    chat.updateMessage = async function(message, options) {
      if (!actions.has(message) && !queued.has(message) && !(game.dice3d && message.isRoll)) return update(message, options);
      const ticket = {};
      tickets.set(message, ticket);
      // v14 requests the redraw in _onUpdate, then synchronously dispatches
      // updateChatMessage. DSN marks the animation in that second step.
      await Promise.resolve();
      if (tickets.get(message) === ticket) tickets.delete(message);
      if (game.messages.get(message.id) !== message) return;
      const previous = queued.get(message);
      const notify = !!(options?.notify || previous?.notify);
      const delay = message.isContentVisible && rollChange(ticket.change) && pendingRoll(message);
      if (!delay) {
        queued.delete(message);
        return update(message, { ...options, notify });
      }
      if (previous) {
        previous.notify = notify;
        return previous.done;
      }
      const entry = { notify };
      queued.set(message, entry);
      entry.done = (async () => {
        let pending = delay;
        while (pending) {
          await pending;
          if (queued.get(message) !== entry || game.messages.get(message.id) !== message) return;
          pending = pendingRoll(message);
        }
        queued.delete(message);
        return update(message, { ...options, notify: entry.notify });
      })();
      return entry.done;
    };
  });
  Hooks.on("diceSoNiceRollComplete", id => finish(game.messages.get(id)));
  Hooks.on("deleteChatMessage", release);
}
