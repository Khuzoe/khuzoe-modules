const scope = "khuzoe-hud";
const pending = new Map();

function rolledWithoutHit(message) {
  const midi = message?.flags?.["midi-qol"];
  return Number.isFinite(midi?.attackRoll?.total) && midi.isHit === false && !midi.isHitEC
    && !midi.hitTargetUuids?.length && !midi.hitECTargetUuids?.length;
}

export function missedAttack(message) {
  // With automatic hit checks off, an evaluated attack can still be undecided.
  // Keep it on retry, but only report zero applied damage for a confirmed miss.
  return rolledWithoutHit(message) && (message.flags["midi-qol"].isFumble === true
    || /<li\b[^>]*\bclass=["'](?=[^"']*\bmidi-qol-hit-class\b)[^"']*\bfailure\b[^"']*["']/i.test(message.content ?? ""));
}

function repeatTargets(message) {
  if (game.user.targets?.size) return new Set(game.user.targets);
  const live = globalThis.MidiQOL?.Workflow?.getWorkflow(message.uuid)?.targets;
  if (live?.size) return new Set(live);
  const midi = message.flags["midi-qol"];
  const targets = midi.targets?.length ? midi.targets : midi.targetUuids ?? [];
  const uuids = targets.map(t => typeof t === "string" ? t : t?.uuid).filter(Boolean);
  return new Set(uuids.map(uuid => fromUuidSync(uuid, { strict: false })?.object).filter(Boolean));
}

// Wrap the three chat actions so D&D5e still resolves the owned, scaled activity
// and handles the button's busy state. Damage buttons retain their native handler.
export function registerAttackRetries() {
  Hooks.once("ready", () => {
    if (!game.modules.get("midi-qol")?.active) return;
    const types = CONFIG.DND5E?.activityTypes;
    const handlers = new Set([types?.attack, types?.midiAttack].map(t => t?.documentClass?.metadata?.usage?.actions).filter(Boolean));
    const busy = new Set();
    for (const actions of handlers) for (const name of ["rollAttack", "rollAttackAdvantage", "rollAttackDisadvantage"]) {
      const original = actions[name];
      if (!original) continue;
      actions[name] = async function(event, button, source) {
        if (!source?.isContentVisible || !rolledWithoutHit(source) || !this.item.isOwner) return original.call(this, event, button, source);
        if (busy.has(source.id)) return;
        const nonce = foundry.utils.randomID();
        const whisper = [...(source.whisper ?? [])];
        const blind = !!source.blind;
        const rollMode = blind ? "blind" : whisper.length ? "gm" : "public";
        busy.add(source.id);
        pending.set(nonce, { source, whisper, blind });
        try {
          const workflowOptions = { autoRollAttack: true };
          if (name !== "rollAttack") {
            workflowOptions.advantage = name === "rollAttackAdvantage";
            workflowOptions.disadvantage = !workflowOptions.advantage;
          }
          return await this.use({
            event, consume: false, scaling: source.system?.scaling ?? 0,
            midiOptions: { targetsToUse: repeatTargets(source), spellLevel: source.system?.spellLevel, workflowOptions }
          }, { configure: false }, { create: true, rollMode, data: { whisper: [...whisper], blind, flags: { [scope]: { retryNonce: nonce } } } });
        } finally {
          pending.delete(nonce);
          busy.delete(source.id);
        }
      };
    }
  });
  Hooks.on("preCreateChatMessage", message => {
    const nonce = message.flags?.[scope]?.retryNonce;
    if (!nonce) return;
    const operation = pending.get(nonce);
    if (!operation || !operation.source.isContentVisible || game.messages.get(operation.source.id) !== operation.source) return false;
    // An activity can override rollMode. Preserve the original recipient list
    // after the system has applied that setting and before the message is sent.
    message.updateSource({ whisper: [...operation.whisper], blind: operation.blind, [`flags.${scope}.-=retryNonce`]: null });
  });
}
