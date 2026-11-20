import test from "node:test";
import assert from "node:assert/strict";
import { damageTypes, hpChange } from "../scripts/damage.mjs";

test("uses the selected target calculation even though Midi saves raw parts in undoDamage.damageDetail", () => {
  const raw = [{ type: "slashing", value: 8 }, { type: "fire", value: 10 }];
  const calculated = [raw[0], { type: "fire", value: 5, active: { type: { resistance: true } } }];
  const entry = { damageSelector: "combinedDamage", damageDetail: raw, damageDetails: { combinedDamage: calculated } };
  assert.deepEqual(damageTypes(entry), [
    { type: "slashing", rolled: 8, result: 8, reasons: [] },
    { type: "fire", rolled: 10, result: 5, reasons: ["Resistance"] }
  ]);
  assert.deepEqual(hpChange(31, 22), { before: 31, after: 22, delta: -9 });
  assert.deepEqual(hpChange(4, 0), { before: 4, after: 0, delta: -4 });
});

test("keeps missing outcomes distinct from immunity and supports custom types", () => {
  const raw = [{ type: "genie", value: 4 }, { type: "genie", value: 3 }];
  const entry = { damageSelector: "otherDamage", rawDamageDetail: raw };
  assert.equal(damageTypes(entry)[0].result, undefined);
  entry.damageDetails = { combinedDamage: raw, otherDamage: [{ type: "genie", value: 0, active: { all: { immunity: true } } }] };
  assert.deepEqual(damageTypes(entry), [{ type: "genie", rolled: 7, result: 0, reasons: ["Immunity"] }]);
});

test("separates healing and temporary HP from damaging components", () => {
  const entry = {
    damageSelector: "combinedDamage",
    damageDetail: [{ type: "healing", value: 12 }, { type: "temphp", value: 8 }, { type: "midi-none", value: 0 }],
    damageDetails: { combinedDamage: [{ type: "healing", value: -12 }, { type: "temphp", value: 8 }] }
  };
  assert.deepEqual(damageTypes(entry), [
    { type: "healing", rolled: 12, result: 12, reasons: [] },
    { type: "temphp", rolled: 8, result: 8, reasons: [] }
  ]);
  assert.equal(hpChange(null, 8), null);
  assert.equal(hpChange(10, 10).delta, 0);
});
