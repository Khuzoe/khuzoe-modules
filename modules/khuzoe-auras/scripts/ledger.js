import { MAX_LEDGER_ENTRIES } from "./constants.js";

export class ExecutionLedger {
  #entries = new Set();
  #order = [];
  #maximum;

  constructor(maximum = MAX_LEDGER_ENTRIES) {
    this.#maximum = Math.max(1, Number(maximum) || MAX_LEDGER_ENTRIES);
  }

  claim(key) {
    if (this.#entries.has(key)) return false;
    this.#entries.add(key);
    this.#order.push(key);
    this.#prune();
    return true;
  }

  has(key) {
    return this.#entries.has(key);
  }

  release(key) {
    this.#entries.delete(key);
    const index = this.#order.indexOf(key);
    if (index >= 0) this.#order.splice(index, 1);
  }

  clear() {
    this.#entries.clear();
    this.#order.length = 0;
  }

  get size() {
    return this.#entries.size;
  }

  #prune() {
    while (this.#order.length > this.#maximum) {
      const oldest = this.#order.shift();
      this.#entries.delete(oldest);
    }
  }
}

export function buildLedgerKey({
  combatId = "no-combat",
  round = 0,
  turn = 0,
  event = "event",
  eventId = "event-id",
  sourceId,
  auraId,
  targetId,
  frequency = "oncePerPhase"
}) {
  const identity = [combatId, sourceId, auraId, targetId];
  if (combatId === "no-combat") identity.push(eventId);

  switch (frequency) {
    case "oncePerRound":
      return [...identity, round].join(":");
    case "oncePerTurn":
      return [...identity, round, turn].join(":");
    case "always":
      return [...identity, round, turn, event, eventId].join(":");
    case "oncePerPhase":
    default:
      return [...identity, round, turn, event].join(":");
  }
}
