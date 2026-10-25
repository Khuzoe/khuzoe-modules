import assert from "node:assert/strict";
import test from "node:test";

import {
  createInferredMultiattackGroups,
  inferMultiattackGroups
} from "../scripts/multiattack-inference.js";
import { createGroup, referenceKey } from "../scripts/model.js";
import { groupUsage } from "../scripts/turn-tracker.js";

function fixture(description, names) {
  const multiattack = {
    id: "multiattack", identifier: "multiattack", name: "Multiattack",
    system: { description: { value: description } }
  };
  const abilities = names.map((name, index) => ({
    item: { id: `ability-${index}`, identifier: name.toLowerCase(), name },
    label: name,
    passive: false,
    ref: { itemId: `ability-${index}`, itemName: name, itemType: "feat" }
  }));
  return { actor: { items: [multiattack, ...abilities.map(option => option.item)] }, abilities };
}

test("infers clear English per-ability Multiattack quantities", () => {
  const { actor, abilities } = fixture(
    "The dinosaur makes three attacks: one with its Bite and two with its Claws.",
    ["Bite", "Claw"]
  );
  const [group] = inferMultiattackGroups(actor, abilities);
  assert.deepEqual(group.entries.map(entry => entry.limit), [1, 2]);
  assert.equal(group.capacity, 3);
});

test("infers clear Italian text and singular/plural ability names", () => {
  const { actor, abilities } = fixture(
    "Il dinosauro effettua tre attacchi: uno con il Morso e due con gli Artigli.",
    ["Morso", "Artiglio"]
  );
  const [group] = inferMultiattackGroups(actor, abilities);
  assert.deepEqual(group.entries.map(entry => entry.limit), [1, 2]);
});

test("does not guess when a mentioned ability has no explicit quantity", () => {
  const { actor, abilities } = fixture(
    "The monster makes two attacks with its Bite or its Claw.",
    ["Bite", "Claw"]
  );
  assert.deepEqual(inferMultiattackGroups(actor, abilities), []);
});

test("turns explicit OR alternatives into separate mutually exclusive groups", () => {
  const { actor, abilities } = fixture(
    "Klessa Camial makes four Unarmed Strikes or four Dart attacks.",
    ["Unarmed Strike", "Dart"]
  );
  const groups = inferMultiattackGroups(actor, abilities);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.capacity), [4, 4]);
  assert.deepEqual(groups.map(group => group.entries[0].limit), [4, 4]);
  assert.match(groups[0].name, /Unarmed Strike/);
  assert.match(groups[1].name, /Dart/);
});

test("automatic groups use the same normalized model and turn tracking as manual groups", () => {
  const { actor, abilities } = fixture(
    "Klessa Camial makes four Unarmed Strikes or four Dart attacks.",
    ["Unarmed Strike", "Dart"]
  );
  const automatic = createInferredMultiattackGroups(actor, abilities);
  assert.equal(automatic.length, 2);

  const manualEquivalent = createGroup({
    ...automatic[0],
    id: automatic[0].id,
    entries: automatic[0].entries
  });
  assert.deepEqual(automatic[0], manualEquivalent);

  const actionKey = referenceKey(automatic[0].entries[0].ref);
  const usage = {
    activeGroupId: automatic[0].id,
    groups: {
      [automatic[0].id]: { used: { [actionKey]: 1 }, total: 1 }
    }
  };
  const active = groupUsage(automatic[0], usage);
  const alternative = groupUsage(automatic[1], usage);
  assert.equal(active.total, 4);
  assert.equal(active.remaining, 3);
  assert.equal(active.entryUsed(automatic[0].entries[0].ref), 1);
  assert.equal(alternative.active, false);
});
