import test from "node:test";
import assert from "node:assert/strict";
import { productionIntervalSeconds, productionSchedule, productionTimeUnits } from "../scripts/production-data.js";

test("world production uses calendar days while real production keeps 24-hour days", () => {
  globalThis.game = { time: { calendar: { days: { hoursPerDay: 40, minutesPerHour: 60, secondsPerMinute: 60 } } } };
  const rule = { enabled: true, intervalDays: 1, lastProcessedAt: 0, timeBasis: "world" };
  assert.equal(productionIntervalSeconds(rule), 144000);
  assert.equal(productionSchedule(rule, 86400).due, 0);
  assert.equal(productionSchedule(rule, 144000).due, 1);
  assert.equal(productionSchedule(rule, 3 * 144000).due, 3);
  assert.equal(productionIntervalSeconds({ ...rule, timeBasis: "real" }), 86400);
  assert.equal(productionSchedule({ ...rule, timeBasis: "real" }, 86400).due, 1);
  assert.deepEqual(productionTimeUnits("world"), { minute: 60, hour: 3600, day: 144000 });
});

test("calendar unit changes, fractional days and rewinds preserve bounded production", () => {
  globalThis.game = { time: { calendar: { days: { hoursPerDay: 30, minutesPerHour: 80, secondsPerMinute: 60 } } } };
  assert.equal(productionIntervalSeconds({ intervalDays: 0.5 }), 72000);
  assert.deepEqual(productionTimeUnits(), { minute: 60, hour: 4800, day: 144000 });
  const rule = { enabled: true, intervalDays: 1, lastProcessedAt: 10, maxCatchUp: 3 };
  assert.equal(productionSchedule(rule, 10 + 100 * 144000).due, 3);
  assert.equal(productionSchedule(rule, 5).reanchor, true);
  game.time.calendar = undefined;
  assert.equal(productionIntervalSeconds(), 86400);
});
