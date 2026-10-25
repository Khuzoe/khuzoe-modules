import assert from "node:assert/strict";
import test from "node:test";

import {
  GENIE_CREATURE,
  GENIE_DAMAGE,
  GENIE_TYPE,
  registerDnd5eExtensions
} from "../scripts/config.mjs";

class FakeColor {
  constructor(value) {
    this.value = value;
  }
}

const italian = key => ({
  "KHZ_DND5E_EXTENSIONS.Damage.Genie": "Geniale",
  "KHZ_DND5E_EXTENSIONS.Creature.Genie": "Genio",
  "KHZ_DND5E_EXTENSIONS.Creature.GeniePlural": "Geni"
})[key] ?? key;

test("registra il danno Geniale come tipo non fisico", () => {
  const config = {
    damageTypes: { fire: { label: "Fuoco", isPhysical: false } },
    creatureTypes: {}
  };

  const { damageType } = registerDnd5eExtensions(config, {
    localize: italian,
    ColorClass: FakeColor
  });

  assert.equal(config.damageTypes[GENIE_TYPE], damageType);
  assert.equal(damageType.label, "Geniale");
  assert.equal(damageType.icon, GENIE_DAMAGE.icon);
  assert.equal(damageType.color.value, GENIE_DAMAGE.color);
  assert.equal(Object.hasOwn(damageType, "isPhysical"), false);
  assert.equal(config.damageTypes.fire.label, "Fuoco");
});

test("registra Genio e Geni come tipo autonomo dagli Elementali", () => {
  const elemental = { label: "Elementale", detectAlignment: true };
  const config = {
    damageTypes: {},
    creatureTypes: { elemental }
  };

  const { creatureType } = registerDnd5eExtensions(config, {
    localize: italian,
    ColorClass: FakeColor
  });

  assert.equal(config.creatureTypes[GENIE_TYPE], creatureType);
  assert.equal(creatureType.label, "Genio");
  assert.equal(creatureType.plural, "Geni");
  assert.equal(creatureType.icon, GENIE_CREATURE.icon);
  assert.equal(config.creatureTypes.elemental, elemental);
  assert.equal(Object.hasOwn(creatureType, "elemental"), false);
  assert.equal(Object.hasOwn(creatureType, "detectAlignment"), false);
});

test("sostituisce una registrazione genie incompatibile senza ereditarne i metadati", () => {
  const config = {
    damageTypes: { genie: { label: "vecchio", isPhysical: true } },
    creatureTypes: { genie: { label: "vecchio", elemental: true } }
  };

  registerDnd5eExtensions(config, {
    localize: italian,
    ColorClass: FakeColor
  });

  assert.equal(Object.hasOwn(config.damageTypes.genie, "isPhysical"), false);
  assert.equal(Object.hasOwn(config.creatureTypes.genie, "elemental"), false);
});
