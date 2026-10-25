import {RELEASE_VERSION} from "./release.mjs";
export const EXPANDED_SPELL_VERSION = RELEASE_VERSION;

const EASY = "easy";
const MEDIUM = "medium";

const entries = [
  ["acidArrow", "melfs-acid-arrow", "Melf's Acid Arrow", MEDIUM],
  ["antagonize", "antagonize", "Antagonize", MEDIUM],
  ["armsOfHadar", "arms-of-hadar", "Arms of Hadar", MEDIUM],
  ["auraOfPurity", "aura-of-purity", "Aura of Purity", MEDIUM],
  ["beaconOfHope", "beacon-of-hope", "Beacon of Hope", MEDIUM],
  ["bladeWard", "blade-ward", "Blade Ward", EASY],
  ["blight", "blight", "Blight", EASY],
  ["blindingSmite", "blinding-smite", "Blinding Smite", MEDIUM],
  ["borrowedKnowledge", "borrowed-knowledge", "Borrowed Knowledge", EASY],
  ["brandingSmite", "branding-smite", "Branding Smite", MEDIUM],
  ["burningHands", "burning-hands", "Burning Hands", EASY],
  ["chainLightning", "chain-lightning", "Chain Lightning", MEDIUM],
  ["charmPerson", "charm-person", "Charm Person", MEDIUM],
  ["chillTouch", "chill-touch", "Chill Touch", MEDIUM],
  ["chromaticOrb", "chromatic-orb", "Chromatic Orb", EASY],
  ["crusadersMantle", "crusaders-mantle", "Crusader's Mantle", MEDIUM],
  ["destructiveWave", "destructive-wave", "Destructive Wave", MEDIUM],
  ["detectMagic", "detect-magic", "Detect Magic", MEDIUM],
  ["disintegrate", "disintegrate", "Disintegrate", MEDIUM],
  ["earthTremor", "earth-tremor", "Earth Tremor", MEDIUM],
  ["eldritchBlast", "eldritch-blast", "Eldritch Blast", MEDIUM],
  ["elementalWeapon", "elemental-weapon", "Elemental Weapon", MEDIUM],
  ["enlargeReduce", "enlarge-reduce", "Enlarge/Reduce", MEDIUM],
  ["faerieFire", "faerie-fire", "Faerie Fire", EASY],
  ["farStep", "far-step", "Far Step", MEDIUM],
  ["fireShield", "fire-shield", "Fire Shield", MEDIUM],
  ["flameBlade", "flame-blade", "Flame Blade", MEDIUM],
  ["fly", "fly", "Fly", EASY],
  ["frostFingers", "frost-fingers", "Frost Fingers", EASY],
  ["gaseousForm", "gaseous-form", "Gaseous Form", MEDIUM],
  ["grease", "grease", "Grease", MEDIUM],
  ["greenFlameBlade", "green-flame-blade", "Green-Flame Blade", MEDIUM],
  ["guardianOfNature", "guardian-of-nature", "Guardian of Nature", MEDIUM],
  ["guidingBolt", "guiding-bolt", "Guiding Bolt", MEDIUM],
  ["hailOfThorns", "hail-of-thorns", "Hail of Thorns", MEDIUM],
  ["heroism", "heroism", "Heroism", MEDIUM],
  ["hex", "hex", "Hex", MEDIUM],
  ["holdPerson", "hold-person", "Hold Person", EASY],
  ["huntersMark", "hunters-mark", "Hunter's Mark", MEDIUM],
  ["hypnoticPattern", "hypnotic-pattern", "Hypnotic Pattern", MEDIUM],
  ["iceStorm", "ice-storm", "Ice Storm", MEDIUM],
  ["investitureOfFlame", "investiture-of-flame", "Investiture of Flame", MEDIUM],
  ["investitureOfIce", "investiture-of-ice", "Investiture of Ice", MEDIUM],
  ["investitureOfStone", "investiture-of-stone", "Investiture of Stone", MEDIUM],
  ["lifeTransference", "life-transference", "Life Transference", MEDIUM],
  ["lightningArrow", "lightning-arrow", "Lightning Arrow", MEDIUM],
  ["lightningLure", "lightning-lure", "Lightning Lure", MEDIUM],
  ["magicMissile", "magic-missile", "Magic Missile", MEDIUM],
  ["massCureWounds", "mass-cure-wounds", "Mass Cure Wounds", EASY],
  ["mindSliver", "mind-sliver", "Mind Sliver", MEDIUM],
  ["mistyStep", "misty-step", "Misty Step", MEDIUM],
  ["passWithoutTrace", "pass-without-trace", "Pass without Trace", MEDIUM],
  ["raulothimsPsychicLance", "raulothims-psychic-lance", "Raulothim's Psychic Lance", MEDIUM],
  ["rayOfEnfeeblement", "ray-of-enfeeblement", "Ray of Enfeeblement", MEDIUM],
  ["rimesBindingIce", "rimes-binding-ice", "Rime's Binding Ice", MEDIUM],
  ["sappingSting", "sapping-sting", "Sapping Sting", EASY],
  ["scorchingRay", "scorching-ray", "Scorching Ray", EASY],
  ["searingSmite", "searing-smite", "Searing Smite", MEDIUM],
  ["shadowBlade", "shadow-blade", "Shadow Blade", MEDIUM],
  ["shadowOfMoil", "shadow-of-moil", "Shadow of Moil", MEDIUM],
  ["shockingGrasp", "shocking-grasp", "Shocking Grasp", MEDIUM],
  ["skillEmpowerment", "skill-empowerment", "Skill Empowerment", EASY],
  ["spiritShroud", "spirit-shroud", "Spirit Shroud", MEDIUM],
  ["sprayOfCards", "spray-of-cards", "Spray of Cards", MEDIUM],
  ["staggeringSmite", "staggering-smite", "Staggering Smite", MEDIUM],
  ["synapticStatic", "synaptic-static", "Synaptic Static", MEDIUM],
  ["tashasCausticBrew", "tashas-caustic-brew", "Tasha's Caustic Brew", MEDIUM],
  ["tashasOtherworldlyGuise", "tashas-otherworldly-guise", "Tasha's Otherworldly Guise", MEDIUM],
  ["thornWhip", "thorn-whip", "Thorn Whip", MEDIUM],
  ["thunderousSmite", "thunderous-smite", "Thunderous Smite", MEDIUM],
  ["thunderwave", "thunderwave", "Thunderwave", MEDIUM],
  ["tidalWave", "tidal-wave", "Tidal Wave", EASY],
  ["tollTheDead", "toll-the-dead", "Toll the Dead", EASY],
  ["vitriolicSphere", "vitriolic-sphere", "Vitriolic Sphere", MEDIUM],
  ["vortexWarp", "vortex-warp", "Vortex Warp", MEDIUM],
  ["wardingBond", "warding-bond", "Warding Bond", MEDIUM],
  ["witherAndBloom", "wither-and-bloom", "Wither and Bloom", MEDIUM],
  ["wrathfulSmite", "wrathful-smite", "Wrathful Smite", MEDIUM]
];

function hash32(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function expandedSpellId(identifier) {
  return `${hash32(identifier)}${hash32(`${identifier}:khuzoe`, 2246822519)}`;
}

export const EXPANDED_SPELL_CATALOG = Object.freeze(entries.map(([source, identifier, name, difficulty]) => Object.freeze({
  source,
  identifier,
  name,
  difficulty,
  id: expandedSpellId(identifier)
})));

export const EXPANDED_SPELL_IDENTIFIERS = Object.freeze(EXPANDED_SPELL_CATALOG.map(entry => entry.identifier));
