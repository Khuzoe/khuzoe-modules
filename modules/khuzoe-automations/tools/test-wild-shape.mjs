import assert from "node:assert/strict";

globalThis.Hooks = {once() {}, on() {}};
globalThis.foundry = {
  applications: {api: {}},
  utils: {
    deepClone(value) {
      return structuredClone(value);
    },
    getProperty(object, path) {
      return String(path).split(".").reduce((value, key) => value?.[key], object);
    },
    setProperty(object, path, value) {
      const parts = String(path).split(".");
      const key = parts.pop();
      const target = parts.reduce((current, part) => current[part] ??= {}, object);
      target[key] = value;
      return true;
    }
  }
};

const {
  calculateWildShapeOverflow,
  getDruidLevel,
  getWildShapeKeepOptions,
  getWildShapeLimits,
  HEALING_ACTIVITY_ID,
  isEligibleWildShapeForm,
  prepareWildShapeItemUpdate,
  resolveWildShapeSourceConfig,
  wildShapeOverflowUpdate
} = await import("../scripts/wild-shape.mjs");

assert.equal(HEALING_ACTIVITY_ID.length, 16);
assert.match(HEALING_ACTIVITY_ID, /^[A-Za-z0-9]{16}$/);

const standardKeep = getWildShapeKeepOptions(
  ["bio", "class", "feats", "hp", "tempHP", "languages", "type", "spells"],
  {beastSpells: false, archdruid: false}
);
assert.deepEqual(Array.from(standardKeep), ["bio", "class", "feats"]);
assert.equal(standardKeep.has("tempHP"), false);

const beastSpellsKeep = getWildShapeKeepOptions(["bio", "tempHP"], {beastSpells: true});
assert.deepEqual(Array.from(beastSpellsKeep), ["bio", "spells"]);

const worldSources = {packs: ["world.default"], folders: ["world-folder"]};
const legacyActorSources = resolveWildShapeSourceConfig({
  actorConfig: {inherit: false, packs: ["legacy.actor"], folders: [], knownForms: ["Actor.wolf"]},
  worldConfig: worldSources
});
assert.equal(legacyActorSources.scope, "actor");
assert.deepEqual(legacyActorSources.packs, ["legacy.actor"]);
assert.deepEqual(legacyActorSources.knownForms, ["Actor.wolf"]);

const abilityOneSources = resolveWildShapeSourceConfig({
  itemConfig: {inherit: false, packs: ["forms.beasts"], folders: ["beasts-folder"]},
  actorConfig: {inherit: false, packs: ["legacy.actor"]},
  worldConfig: worldSources
});
const abilityTwoSources = resolveWildShapeSourceConfig({
  itemConfig: {inherit: false, packs: ["forms.elementals"], folders: ["elementals-folder"]},
  actorConfig: {inherit: false, packs: ["legacy.actor"]},
  worldConfig: worldSources
});
assert.equal(abilityOneSources.scope, "item");
assert.deepEqual(abilityOneSources.packs, ["forms.beasts"]);
assert.deepEqual(abilityTwoSources.packs, ["forms.elementals"]);
assert.notDeepEqual(abilityOneSources, abilityTwoSources);

const inheritedAbilitySources = resolveWildShapeSourceConfig({
  itemConfig: {inherit: true, packs: ["ignored.item"]},
  worldConfig: worldSources
});
assert.deepEqual(inheritedAbilitySources.packs, ["world.default"]);
assert.deepEqual(inheritedAbilitySources.folders, ["world-folder"]);

const savedAbilityConfig = {
  inherit: false,
  packs: ["forms.personal"],
  folders: ["personal-folder"],
  knownOnly: true,
  knownForms: ["Actor.bear"]
};
const configuredAbility = {
  system: {identifier: "wild-shape", uses: {max: 2, spent: 1}},
  flags: {"khuzoe-automations": {wildShapeConfig: savedAbilityConfig}},
  actor: {items: []}
};
const automationUpdate = {
  system: {},
  flags: {cat: {automation: {source: "khuzoe-automations"}}}
};
prepareWildShapeItemUpdate(configuredAbility, automationUpdate);
assert.deepEqual(
  automationUpdate.flags["khuzoe-automations"].wildShapeConfig,
  savedAbilityConfig
);

function feature(identifier) {
  return {type: "feat", name: identifier, system: {identifier}};
}

function druid(level, features = []) {
  const classItem = {type: "class", name: "Druid", system: {identifier: "druid", levels: level}};
  return {items: [classItem, ...features], classes: {druid: classItem}};
}

assert.equal(getDruidLevel(druid(7)), 7);
assert.deepEqual(getWildShapeLimits(druid(2)), {
  level: 2,
  maxCr: 0.25,
  forbidSwim: true,
  forbidFly: true,
  moon: false,
  combatWildShape: false,
  primalStrike: false,
  elementalWildShape: false,
  beastSpells: false,
  archdruid: false
});

const moon10 = getWildShapeLimits(druid(10, [
  feature("circle-forms"),
  feature("combat-wild-shape"),
  feature("primal-strike"),
  feature("elemental-wild-shape")
]));
assert.equal(moon10.maxCr, 3);
assert.equal(moon10.combatWildShape, true);
assert.equal(moon10.primalStrike, true);
assert.equal(moon10.elementalWildShape, true);

const wolf = {
  uuid: "Compendium.test.beasts.Actor.wolf",
  type: "beast",
  cr: 0.25,
  movement: {walk: 40, swim: 0, fly: 0}
};
const eagle = {...wolf, uuid: "Compendium.test.beasts.Actor.eagle", movement: {walk: 10, swim: 0, fly: 60}};
const elemental = {...wolf, uuid: "Compendium.test.beasts.Actor.fire", type: "elemental", elemental: true, cr: 5};

assert.equal(isEligibleWildShapeForm(wolf, getWildShapeLimits(druid(2)), {remainingUses: 2}), true);
assert.equal(isEligibleWildShapeForm(eagle, getWildShapeLimits(druid(2)), {remainingUses: 2}), false);
assert.equal(isEligibleWildShapeForm(elemental, moon10, {remainingUses: 1}), false);
assert.equal(isEligibleWildShapeForm(elemental, moon10, {remainingUses: 2}), true);
assert.equal(isEligibleWildShapeForm(wolf, moon10, {
  remainingUses: 2,
  knownOnly: true,
  knownForms: []
}), false);

const transformed = {system: {attributes: {hp: {value: 6, temp: 2}}}};
assert.equal(calculateWildShapeOverflow(transformed, {
  damageDetail: [{type: "slashing", value: 11}]
}), 3);
assert.equal(calculateWildShapeOverflow(transformed, {
  damageDetail: [{type: "slashing", value: 4}, {type: "fire", value: 4}]
}), 0);

assert.deepEqual(wildShapeOverflowUpdate({system: {attributes: {hp: {value: 25, temp: 8}}}}, 5), {
  "system.attributes.hp.temp": 3,
  "system.attributes.hp.value": 25
});
assert.deepEqual(wildShapeOverflowUpdate({system: {attributes: {hp: {value: 25, temp: 3}}}}, 8), {
  "system.attributes.hp.temp": 0,
  "system.attributes.hp.value": 20
});

console.log("Khuzoe Automations Wild Shape rules: OK");
