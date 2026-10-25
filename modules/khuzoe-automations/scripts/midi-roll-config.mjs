const MODULE = "khuzoe-automations";
const SUPPORTED_FACES = new Set([4, 6, 8, 10, 12, 20]);
const policies = new WeakMap();
let installed = false;

export function validateMidiRollConfig(config, activities) {
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(config) || (config.version !== undefined && config.version !== 1)
    || Object.keys(config).some(key => !["version", "activities"].includes(key))
    || !object(config.activities) || Object.keys(config.activities).length > 32) throw new Error("Configurazione tiri non valida.");
  for (const [id, rule] of Object.entries(config.activities)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)
      || (activities && !Object.hasOwn(activities, id)) || !object(rule)
      || Object.keys(rule).some(key => !["enabled", "attackMaxChance", "damageMaxChance"].includes(key))
      || (rule.enabled !== undefined && typeof rule.enabled !== "boolean")) throw new Error("Attività o configurazione tiri non valida.");
    for (const field of ["attackMaxChance", "damageMaxChance"]) {
      const value = rule[field];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        throw new Error("Le probabilità devono essere comprese tra 0 e 100.");
      }
    }
    if (activities && rule.attackMaxChance != null && activities[id].type !== "attack") throw new Error("La probabilità del d20 richiede un'attività di attacco.");
    if (activities && rule.damageMaxChance != null && !["attack", "save", "damage"].includes(activities[id].type)) throw new Error("La probabilità dei danni richiede un'attività con danni.");
  }
  return config;
}

/** One uniform draw, before keep/drop, rerolls, critical detection and animation. */
export function midiFace(faces, percentage, uniform) {
  const p = percentage / 100;
  if (uniform < p || p === 1) return faces;
  return Math.min(faces - 1, 1 + Math.floor((uniform - p) / (1 - p) * (faces - 1)));
}

export function configureMidiRolls(rolls, config, kind) {
  const activity = config?.subject;
  if (!activity?.item || !activity.id) return;
  // Read only the stored Item configuration, not derived Active Effect overrides.
  const settings = (activity.item._source?.flags ?? activity.item.flags)?.[MODULE]?.midiRollConfig;
  if (!settings) return;
  try { validateMidiRollConfig(settings); } catch { return; }
  const rule = settings.activities[activity.id];
  if (rule?.enabled !== true) return;
  if (kind === "attack" && activity.type !== "attack") return;
  if (kind === "damage" && !["attack", "save", "damage"].includes(activity.type)) return;
  const chance = rule[kind === "attack" ? "attackMaxChance" : "damageMaxChance"];
  if (chance == null) return;
  for (const roll of kind === "attack" ? rolls.slice(0, 1) : rolls) {
    if (!roll || roll._evaluated) continue;
    policies.set(roll, {kind, chance});
  }
}

export function midiMapRandomFace(wrapped, uniform) {
  const root = this._root;
  const policy = root && policies.get(root);
  if (!policy || !SUPPORTED_FACES.has(this.faces)) return wrapped(uniform);
  if (policy.kind === "attack" && (this.faces !== 20 || root.dice.find(die => die.faces === 20) !== this)) return wrapped(uniform);
  return midiFace(this.faces, policy.chance, uniform);
}

export function midiClone(wrapped, ...args) {
  const clone = wrapped(...args);
  const policy = policies.get(this);
  if (policy) policies.set(clone, policy);
  return clone;
}

export function registerMidiRollConfig() {
  if (installed || !globalThis.libWrapper) return;
  // WeakMaps keep configuration out of serialized Rolls and chat messages.
  libWrapper.register(MODULE, "foundry.dice.terms.Die.prototype.mapRandomFace", midiMapRandomFace, "MIXED");
  libWrapper.register(MODULE, "foundry.dice.Roll.prototype.clone", midiClone, "WRAPPER");
  Hooks.on("dnd5e.postAttackRollConfiguration", (rolls, config) => { configureMidiRolls(rolls, config, "attack"); });
  Hooks.on("dnd5e.postDamageRollConfiguration", (rolls, config) => { configureMidiRolls(rolls, config, "damage"); });
  const module = game.modules.get(MODULE);
  module.api ??= {};
  module.api.midiRollConfig = {version: 1, validate: validateMidiRollConfig};
  installed = true;
}
