/** Validate stored rules independently of the module which executes them. */
export function validateManagedMidiRollConfig(config, activities) {
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(config) || (config.version !== undefined && config.version !== 1)
    || Object.keys(config).some(key => !["version", "activities"].includes(key))
    || !object(config.activities) || Object.keys(config.activities).length > 32) throw new Error("Configurazione tiri non valida.");
  if (!object(activities)) throw new Error("Attività della capacità non disponibili.");
  for (const [id, rule] of Object.entries(config.activities)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)
      || !Object.hasOwn(activities, id) || !object(rule)
      || Object.keys(rule).some(key => !["enabled", "attackMaxChance", "damageMaxChance"].includes(key))
      || (rule.enabled !== undefined && typeof rule.enabled !== "boolean")) throw new Error("Attività o configurazione tiri non valida.");
    for (const field of ["attackMaxChance", "damageMaxChance"]) {
      const value = rule[field];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        throw new Error("Le probabilità devono essere comprese tra 0 e 100.");
      }
    }
    if (rule.attackMaxChance != null && activities[id]?.type !== "attack") throw new Error("La probabilità del d20 richiede un'attività di attacco.");
    if (rule.damageMaxChance != null && !["attack", "save", "damage"].includes(activities[id]?.type)) throw new Error("La probabilità dei danni richiede un'attività con danni.");
  }
  return config;
}
