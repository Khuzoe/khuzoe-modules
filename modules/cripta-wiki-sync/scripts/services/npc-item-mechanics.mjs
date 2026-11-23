import {nativeEqual} from './npc-native-model.mjs';

const damageActivities = ['attack', 'save', 'damage'];
const activeItems = ['weapon', 'consumable', 'feat', 'spell', 'tool', 'equipment'];
const physicalItems = ['weapon', 'consumable', 'equipment', 'container', 'tool', 'loot'];
const knownItems = new Set([...activeItems, ...physicalItems]);
const itemFields = {
  activities: activeItems, uses: activeItems, quantity: physicalItems,
  level: ['spell'], school: ['spell'], prepared: ['spell'], range: ['spell', 'weapon'],
  activation: ['spell'], target: ['spell'], duration: ['spell'],
  attack: [], save: [], healing: []
};
const activityFields = {attack: ['attack'], save: ['save'], healing: ['heal'], roll: ['utility'], damage: damageActivities};
// Midi-QOL also supports critical on saves.
const damageFields = {attack: ['parts', 'includeBase', 'critical'], save: ['parts', 'onSave', 'critical'], damage: ['parts', 'critical']};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const changed = (before, after, key) => Object.hasOwn(after, key) && !nativeEqual(before?.[key], after[key]);

export class NpcItemMechanicsError extends Error {}

function invalid(path, reason) {
  throw new NpcItemMechanicsError(`${path} — ${reason}`);
}

// Spell and activity ranges share D&D5e's RangeField. A weapon's system.range
// has its own numeric schema and must never pass through this conversion.
const rangeModes = new Set(['self', 'touch', 'spec', 'any']);
function normalizeRange(range, previous, path) {
  if (nativeEqual(range, previous)) return;
  if (!record(range)) invalid(path, 'indica la gittata con valore e unità.');
  if (!changed(previous, range, 'value') && !changed(previous, range, 'units')) return;
  if (typeof range.value === 'number' && Number.isFinite(range.value)) {
    range.value = String(range.value);
    return;
  }
  if (typeof range.value !== 'string') return;
  const mode = range.value.trim().toLowerCase();
  if (!rangeModes.has(mode)) return;
  if (range.units && range.units !== mode) {
    invalid(path, `il valore «${mode}» e l’unità «${range.units}» indicano gittate diverse. Per «${mode}» scegli questa unità e lascia vuoto il valore. Per una distanza inserisci la misura.`);
  }
  range.units = mode;
  range.value = '';
}

function checkKeys(data, before, keys, path) {
  if (!record(data)) invalid(path, 'è richiesto un oggetto.');
  for (const key of Object.keys(data)) {
    if (!keys.includes(key) && !Object.hasOwn(before || {}, key)) invalid(`${path}.${key}`, 'campo assente nello schema D&D5e di questo elemento.');
  }
}

function damageTypes(value, path) {
  const types = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(types) || types.some(type => typeof type !== 'string' || !type.trim())) invalid(path, 'indica un elenco di tipi di danno.');
  return [...new Set(types)];
}

function formulaPart(formula, path) {
  if (typeof formula !== 'string' || !formula.trim()) invalid(path, 'indica una formula di danno.');
  const dice = formula.trim().match(/^(\d+)d(4|6|8|10|12|20)(?:\s*([+-])\s*(\d+|@[\w.]+))?$/i);
  if (!dice || Number(dice[1]) === 0) return {custom: {enabled: true, formula}};
  return {number: Number(dice[1]), denomination: Number(dice[2]), bonus: dice[3] === '-' ? '-' + dice[4] : dice[4] || ''};
}

function damagePart(input, before, path, outerTypes) {
  let part = input;
  if (typeof input === 'string') part = formulaPart(input, path);
  if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'string' && input[0].trim() && typeof input[1] === 'string') {
    part = {...formulaPart(input[0], path), types: input[1] ? [input[1]] : []};
  }
  if (record(part) && changed(before, part, 'formula')) {
    if (['number','denomination','bonus','custom'].some(key => Object.hasOwn(part, key))) invalid(path + '.formula', 'specifica un solo calcolo per questa parte.');
    const {formula, ...rest} = part;
    part = {...rest, ...formulaPart(formula, path + '.formula')};
  }
  checkKeys(part, before, ['number', 'denomination', 'bonus', 'types', 'custom', 'scaling'], path);
  if (outerTypes !== undefined) {
    const supplied = damageTypes(outerTypes, path + '.types');
    if (part.types !== undefined && !nativeEqual([...damageTypes(part.types, path + '.types')].sort(), [...supplied].sort())) {
      invalid(path + '.types', 'i tipi di danno indicati in due punti sono diversi. Specifica quelli da usare nella parte di danno.');
    }
    part.types ??= supplied;
  }
  if (changed(before, part, 'types')) part.types = damageTypes(part.types, path + '.types');
  for (const key of ['number', 'denomination']) {
    if (!changed(before, part, key) || part[key] === null) continue;
    if (typeof part[key] === 'string' && /^\d+$/.test(part[key])) part[key] = Number(part[key]);
    if (!Number.isSafeInteger(part[key]) || part[key] < 0) invalid(path + '.' + key, 'indica un intero non negativo.');
  }
  if (changed(before, part, 'bonus') && typeof part.bonus === 'number') part.bonus = String(part.bonus);
  if (changed(before, part, 'custom')) checkKeys(part.custom, before?.custom, ['enabled', 'formula'], path + '.custom');
  if (changed(before, part, 'scaling')) checkKeys(part.scaling, before?.scaling, ['mode', 'number', 'formula'], path + '.scaling');
  return part;
}

function itemDamage(item, previous) {
  const {system, type} = item, damage = system.damage;
  const baseSupported = type === 'weapon' || type === 'consumable';
  const keys = baseSupported ? ['base', 'types', type === 'weapon' ? 'versatile' : 'replace'] : ['base', 'types'];
  checkKeys(damage, previous, keys, 'system.damage');
  const moveTypes = changed(previous, damage, 'types');
  if (changed(previous, damage, 'versatile')) damage.versatile = damagePart(damage.versatile, previous?.versatile, 'system.damage.versatile');
  if (!Object.hasOwn(damage, 'base')) {
    if (moveTypes || !baseSupported) invalid('system.damage', 'indica anche la parte di danno e l’attività che la tira.');
    return;
  }
  if (baseSupported && !moveTypes && !changed(previous, damage, 'base')) return;
  const part = damagePart(damage.base, previous?.base, 'system.damage.base', moveTypes ? damage.types : undefined);
  if (baseSupported) {
    damage.base = part;
    if (moveTypes) delete damage.types;
    return;
  }
  // A feature has no shared base. Moving it is lossless only when the roll is unique.
  const candidates = Object.values(system.activities || {}).filter(activity => damageActivities.includes(activity.type));
  if (previous !== undefined || candidates.length !== 1) invalid('system.damage.base', 'specifica il danno in damage.parts dell’attività che lo tira.');
  const activity = candidates[0];
  activity.damage ??= {};
  const parts = activity.damage.parts ?? [];
  if (!Array.isArray(parts) || (parts.length && !nativeEqual(parts, [part]))) {
    invalid('system.damage.base', 'l’attività ha già altri danni. Indica le parti esatte in damage.parts per evitare un tiro duplicato.');
  }
  activity.damage.parts = [part];
  delete system.damage;
}

// Work on the caller's detached draft. Untouched archived fields, including
// module extensions and older imports, must survive unrelated edits.
export function normalizeNpcItemMechanics(item, baseline = {}) {
  if (!knownItems.has(item.type) || !record(item.system)) return;
  const {system} = item, before = baseline.system || {};
  try {
    if (item.type === 'spell' && Object.hasOwn(system, 'range')) normalizeRange(system.range, before.range, 'system.range');
    for (const [key, types] of Object.entries(itemFields)) {
      if (Object.hasOwn(system, key) && !Object.hasOwn(before, key) && !types.includes(item.type)) {
        invalid('system.' + key, `campo non disponibile su un Item ${item.type}. Controlla il tipo di oggetto o configura l’attività.`);
      }
    }
    for (const [id, activity] of Object.entries(system.activities || {})) {
      const original = before.activities?.[id];
      if (nativeEqual(original, activity) || !['attack', 'save', 'damage', 'heal', 'utility'].includes(activity?.type)) continue;
      const path = 'system.activities.' + id;
      if (Object.hasOwn(activity, 'range')) normalizeRange(activity.range, original?.range, `${activity.name || id} · ${path}.range`);
      for (const [key, types] of Object.entries(activityFields)) {
        if (Object.hasOwn(activity, key) && !Object.hasOwn(original || {}, key) && !types.includes(activity.type)) {
          invalid(path + '.' + key, `campo non disponibile su un’attività ${activity.type}.`);
        }
      }
      if (activity.type === 'heal' && changed(original, activity, 'healing')) activity.healing = damagePart(activity.healing, original?.healing, path + '.healing');
      if (!damageActivities.includes(activity.type) || !changed(original, activity, 'damage')) continue;
      const damage = activity.damage, old = original?.damage;
      checkKeys(damage, old, damageFields[activity.type], path + '.damage');
      if (changed(old, damage, 'critical')) checkKeys(damage.critical, old?.critical, activity.type === 'attack' ? ['bonus'] : ['allow','bonus'], path + '.damage.critical');
      if (!changed(old, damage, 'parts')) continue;
      if (!Array.isArray(damage.parts)) invalid(path + '.damage.parts', 'è richiesto un elenco di parti di danno.');
      damage.parts = damage.parts.map((part, i) => nativeEqual(part, old?.parts?.[i]) ? part : damagePart(part, old?.parts?.[i], path + '.damage.parts.' + i));
    }
    if (changed(before, system, 'damage')) itemDamage(item, before.damage);
  } catch (error) {
    if (!(error instanceof NpcItemMechanicsError)) throw error;
    throw new NpcItemMechanicsError(`${item.name} (${item.type}): ${error.message}`);
  }
}
