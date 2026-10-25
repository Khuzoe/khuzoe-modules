import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticQuickActions,
  collectActionOptions,
  findMatchingOption,
  resolveReference
} from "../scripts/action-service.js";

function activity(id, name, img) {
  return {
    id,
    name,
    img,
    type: "attack",
    canUse: true,
    activation: { type: "action", value: 1 },
    uses: { max: 0 }
  };
}

function actorWith(items) {
  const map = new Map(items.map(item => [item.id, item]));
  const collection = {
    get: id => map.get(id),
    [Symbol.iterator]: () => map.values()
  };
  return { items: collection };
}

test("abilities are listed once per Item and always use the Item artwork", () => {
  const first = activity("attack-one", "Bite attack", "icons/activity-one.webp");
  const second = activity("attack-two", "Bite rider", "icons/activity-two.webp");
  const item = {
    id: "bite",
    identifier: "bite",
    name: "Bite",
    type: "feat",
    img: "icons/bite.webp",
    system: { activities: new Map([[first.id, first], [second.id, second]]) }
  };

  const options = collectActionOptions(actorWith([item]));
  assert.equal(options.length, 1);
  assert.equal(options[0].label, "Bite");
  assert.equal(options[0].img, "icons/bite.webp");
  assert.equal(options[0].activity, null);
  assert.equal(options[0].ref.activityId, "");
  assert.equal(options[0].hasActivities, true);
});

test("old Activity references resolve to their owning ability", () => {
  const attack = activity("attack", "Attack", "icons/activity.webp");
  const item = {
    id: "claw",
    identifier: "claw",
    name: "Claw",
    type: "feat",
    img: "icons/claw.webp",
    system: { activities: new Map([[attack.id, attack]]) }
  };

  const option = resolveReference(actorWith([item]), {
    itemId: "claw",
    activityId: "attack",
    activityName: "Attack",
    activityType: "attack"
  });
  assert.equal(option.key, "claw:item");
  assert.equal(option.activity, null);
  assert.equal(option.ref.activityId, "");
});

test("a saved quick action selects only its exact Item when identifiers are duplicated", () => {
  const options = [
    { key: "first:item", ref: { itemId: "first", itemIdentifier: "claw", itemName: "Claw", itemType: "feat" } },
    { key: "second:item", ref: { itemId: "second", itemIdentifier: "claw", itemName: "Claw", itemType: "feat" } }
  ];

  const selected = findMatchingOption(options, {
    itemId: "second",
    itemIdentifier: "claw",
    itemName: "Claw",
    itemType: "feat"
  });
  assert.equal(selected.key, "second:item");
});

test("a saved quick action still falls back after an embedded Item ID changes", () => {
  const options = [
    { key: "current:item", ref: { itemId: "current", itemIdentifier: "claw", itemName: "Claw", itemType: "feat" } }
  ];
  const selected = findMatchingOption(options, {
    itemId: "obsolete",
    itemIdentifier: "claw",
    itemName: "Claw",
    itemType: "feat"
  });
  assert.equal(selected.key, "current:item");
});

test("the generic icon is used only when the ability Item has no image", () => {
  const item = {
    id: "blank",
    name: "Blank",
    type: "feat",
    img: "",
    system: { activities: new Map() }
  };
  const [option] = collectActionOptions(actorWith([item]));
  assert.equal(option.img, "icons/svg/dice-target.svg");
});

test("Legendary Action abilities are exposed for the blue HUD treatment", () => {
  const legendary = activity("legendary-bite", "Legendary Bite", "icons/activity.webp");
  legendary.activation = { type: "legendary", value: 2 };
  const item = {
    id: "legendary-bite",
    name: "Legendary Bite",
    type: "feat",
    img: "icons/legendary-bite.webp",
    system: { activities: new Map([[legendary.id, legendary]]) }
  };
  const [option] = collectActionOptions(actorWith([item]));
  assert.equal(option.legendary, true);
  assert.equal(option.cost, 2);
});

test("Multiattack names are never enabled by automatic quick-action suggestions", () => {
  const makeItem = (id, name) => {
    const use = activity(`${id}-activity`, name, `icons/${id}.webp`);
    return {
      id,
      identifier: id,
      name,
      type: "feat",
      img: `icons/${id}.webp`,
      system: { activities: new Map([[use.id, use]]) }
    };
  };
  const actor = actorWith([
    makeItem("multiattack", "Multiattack"),
    makeItem("multiattacco", "Multiattacco"),
    makeItem("attacchi-multipli", "Attacchi multipli"),
    makeItem("bite", "Bite")
  ]);
  const suggested = automaticQuickActions(actor);
  assert.deepEqual(suggested.map(reference => reference.itemId), ["bite"]);
});
