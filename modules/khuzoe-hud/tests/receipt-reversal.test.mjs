import test from "node:test";
import assert from "node:assert/strict";
import { changeApplication, hpUpdates, receiptDelta } from "../scripts/receipt-reversal.mjs";

function resource(data) {
  return {
    isOwner: true, flags: {}, system: data,
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const fields = path.split(".");
        const name = fields.pop();
        const dest = fields.reduce((obj, field) => obj[field] ??= {}, this);
        if (name.startsWith("-=")) delete dest[name.slice(2)];
        else dest[name] = value;
      }
      return this;
    }
  };
}

test("undoing the earlier hit preserves the later damage, subsequent healing and temporary HP", async () => {
  globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject: (a, b) => ({ ...a, ...b }) } };
  globalThis.Hooks = { call: () => true };
  const hp = { value: 76, max: 100, temp: 3 };
  const actor = resource({ attributes: { hp } });
  const first = { oldHP: 100, newHP: 91, oldTempHP: 4, newTempHP: 0 };
  const second = { oldHP: 91, newHP: 74, oldTempHP: 0, newTempHP: 0 };
  assert.ok(await changeApplication(actor, first, "first", true));
  assert.deepEqual([hp.value, hp.temp], [85, 7]);
  assert.equal(await changeApplication(actor, first, "first", true), false);
  assert.ok(await changeApplication(actor, first, "first", false));
  assert.deepEqual([hp.value, hp.temp], [76, 3]);
  assert.ok(await changeApplication(actor, second, "second", true));
  assert.deepEqual([hp.value, hp.temp], [93, 3]);
  actor.isOwner = false;
  assert.equal(await changeApplication(actor, second, "second", false), false);
});

test("resource updates respect the new HP cap and a failed actor write rolls back vitality", async () => {
  globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject: (a, b) => ({ ...a, ...b }) } };
  globalThis.Hooks = { call: () => true };
  const hp = { max: 100, value: 74, temp: 0, tempmax: -20, effectiveMax: 80 };
  const actor = resource({ attributes: { hp } });
  const vitality = resource({ uses: { spent: 7, max: 10 } });
  globalThis.MidiQOL = { getVitalityItem: () => vitality };
  const entry = { oldHP: 100, newHP: 70, oldTempMax: 0, newTempMax: -10, oldVitalitySpent: 1, newVitalitySpent: 4 };
  assert.deepEqual(hpUpdates(hp, receiptDelta(entry), -1), { "system.attributes.hp.value": 90, "system.attributes.hp.tempmax": -10 });
  actor.update = async () => { throw Error("write failed"); };
  await assert.rejects(changeApplication(actor, entry, "one", true), /write failed/);
  assert.equal(vitality.system.uses.spent, 7);
  assert.equal(vitality.flags["khuzoe-hud"].receiptState.one, undefined);
  delete globalThis.MidiQOL;
});
