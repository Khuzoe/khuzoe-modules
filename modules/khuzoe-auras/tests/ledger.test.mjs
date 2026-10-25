import test from "node:test";
import assert from "node:assert/strict";

import { buildLedgerKey, ExecutionLedger } from "../scripts/ledger.js";

const base = {
  combatId: "combat",
  round: 2,
  turn: 3,
  event: "turnStart",
  eventId: "event-a",
  sourceId: "source",
  auraId: "aura",
  targetId: "target"
};

test("ledger accepts a key only once", () => {
  const ledger = new ExecutionLedger();
  assert.equal(ledger.claim("one"), true);
  assert.equal(ledger.claim("one"), false);
});

test("phase frequency distinguishes start from end", () => {
  const start = buildLedgerKey({ ...base, frequency: "oncePerPhase" });
  const end = buildLedgerKey({ ...base, event: "turnEnd", frequency: "oncePerPhase" });
  assert.notEqual(start, end);
});

test("turn frequency merges start and end of the same turn", () => {
  const start = buildLedgerKey({ ...base, frequency: "oncePerTurn" });
  const end = buildLedgerKey({ ...base, event: "turnEnd", frequency: "oncePerTurn" });
  assert.equal(start, end);
});

test("bounded ledger prunes its oldest entry", () => {
  const ledger = new ExecutionLedger(2);
  ledger.claim("one");
  ledger.claim("two");
  ledger.claim("three");
  assert.equal(ledger.has("one"), false);
  assert.equal(ledger.has("two"), true);
  assert.equal(ledger.has("three"), true);
});
