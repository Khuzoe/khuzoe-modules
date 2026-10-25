import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID } from "../scripts/constants.js";
import { createDefaultAura } from "../scripts/model.js";
import { AuraStore } from "../scripts/store.js";

function tokenWithFlags(initial = {}) {
  const flags = structuredClone(initial);
  return {
    flags,
    getFlag(moduleId, key) {
      return moduleId === MODULE_ID ? this.flags[key] : undefined;
    },
    async setFlag(moduleId, key, value) {
      assert.equal(moduleId, MODULE_ID);
      // Foundry setFlag merges recursively; omitted keys are not deletions.
      this.flags[key] = mergeFlag(this.flags[key] ?? {}, value);
      return value;
    }
  };
}

function mergeFlag(current, update) {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith("-=")) delete next[key.slice(2)];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = mergeFlag(next[key] ?? {}, value);
    } else next[key] = structuredClone(value);
  }
  return next;
}

test("aura immunity is persisted per source aura and target", async () => {
  const token = tokenWithFlags();
  await AuraStore.grantImmunity(token, "aura-one", "target-one");

  assert.equal(AuraStore.isImmune(token, "aura-one", "target-one"), true);
  assert.equal(AuraStore.isImmune(token, "aura-one", "target-two"), false);
  assert.deepEqual(token.flags[FLAGS.IMMUNITIES], { "aura-one": ["target-one"] });
});

test("disabling or removing an aura clears its persisted immunities", async () => {
  const aura = createDefaultAura({
    enabled: true,
    actions: [{ save: { immunityOnSuccess: true } }]
  });
  const token = tokenWithFlags({
    [FLAGS.IMMUNITIES]: { [aura.id]: ["target"] }
  });

  await AuraStore.setAuras(token, [{ ...aura, enabled: false }]);
  assert.deepEqual(token.flags[FLAGS.IMMUNITIES], {});
});

test("removed auras stay removed after a merging flag write and do not alter other flags", async () => {
  const first = createDefaultAura({ id: "first", name: "First" });
  const second = createDefaultAura({ id: "second", name: "Second" });
  const token = tokenWithFlags({
    [FLAGS.AURAS]: { first, second },
    untouched: { nested: "keep" }
  });
  await AuraStore.setAuras(token, [{ ...second, name: "Edited" }]);
  assert.deepEqual(AuraStore.getAuras(token).map(aura => aura.name), ["Edited"]);
  await AuraStore.setAuras(token, []);
  assert.deepEqual(AuraStore.getAuras(token), []);
  assert.deepEqual(token.flags.untouched, { nested: "keep" });
});

test("pruning one aura immunity preserves the remaining aura's recipients", async () => {
  const token = tokenWithFlags({ [FLAGS.IMMUNITIES]: { keep: ["one", "two"], remove: ["three"] } });
  assert.equal(await AuraStore.pruneImmunities(token, new Set(["keep"])), true);
  assert.deepEqual(token.flags[FLAGS.IMMUNITIES], { keep: ["one", "two"] });
  assert.equal(await AuraStore.pruneImmunities(token, new Set(["keep"])), false);
});
