import { createGroup } from "./model.js";

const NUMBER_WORDS = new Map(Object.entries({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9
}));

const CONNECTORS = new Set([
  "attack", "attacks", "attacco", "attacchi", "weapon", "weapons", "arma", "armi",
  "time", "times", "volta", "volte", "with", "using", "its", "the", "of",
  "con", "usando", "il", "lo", "la", "i", "gli", "le", "l", "suo", "sua", "suoi", "sue"
]);

const MULTIATTACK_NAMES = ["multiattack", "multi attack", "multiattacco", "attacchi multipli"];
const ALTERNATIVES = new Set(["or", "oppure", "o"]);

/**
 * Infer an initial fixed Multiattack only from unambiguous quantities in the
 * feature text. This never changes the Actor and is deliberately conservative.
 */
export function inferMultiattackGroups(actor, actionOptions = []) {
  const source = findMultiattackItem(actor);
  const description = source?.system?.description?.value ?? source?.system?.description ?? "";
  const tokens = tokenize(description);
  if (!source || !tokens.length) return [];

  const candidates = actionOptions.filter(option => option.item?.id !== source.id && !option.passive);
  const mentions = [];
  let mentionedWithoutQuantity = false;

  for (const option of candidates) {
    const starts = findAliasStarts(tokens, aliasesFor(option));
    if (!starts.length) continue;
    for (const start of starts) {
      const limit = quantityBefore(tokens, start);
      if (!limit) mentionedWithoutQuantity = true;
      else mentions.push({ ref: option.ref, label: option.label, limit, start });
    }
  }

  if (!mentions.length || mentionedWithoutQuantity) return [];
  mentions.sort((left, right) => left.start - right.start);
  const branches = alternativeBranches(tokens, mentions);
  const total = explicitAttackTotal(tokens);
  const groups = branches.map((branch, index) => createInferredGroup(source, branch, index, branches.length));
  if (groups.some(group => total && group.capacity !== total)) return [];
  if (groups.length === 1 && !total && groups[0].entries.length < 2 && groups[0].capacity < 2) return [];
  return groups;
}

/**
 * Materialize suggestions through the exact same normalized group factory used
 * by the manual configuration UI. From this point onward there is no separate
 * automatic runtime path.
 */
export function createInferredMultiattackGroups(actor, actionOptions = []) {
  return inferMultiattackGroups(actor, actionOptions).map(group => createGroup(group));
}

function alternativeBranches(tokens, mentions) {
  const branches = [[]];
  let previous = null;
  for (const mention of mentions) {
    if (previous && tokens.slice(previous.start + 1, mention.start).some(token => ALTERNATIVES.has(token))) {
      branches.push([]);
    }
    branches.at(-1).push(mention);
    previous = mention;
  }
  return branches;
}

function createInferredGroup(source, mentions, index, count) {
  const combined = new Map();
  for (const mention of mentions) {
    const key = mention.ref.itemId || mention.ref.itemIdentifier || mention.ref.itemName;
    const existing = combined.get(key);
    if (existing) existing.limit = Math.min(99, existing.limit + mention.limit);
    else combined.set(key, { ref: mention.ref, label: mention.label, limit: mention.limit });
  }
  const values = [...combined.values()];
  const capacity = values.reduce((sum, entry) => sum + entry.limit, 0);
  const suffix = values.length === 1 ? values[0].label : String(index + 1);
  return {
    name: count > 1 ? `${source.name || "Multiattack"} — ${suffix}` : (source.name || "Multiattack"),
    mode: "fixed",
    capacity,
    entries: values.map(({ ref, limit }) => ({ ref, limit }))
  };
}

function findMultiattackItem(actor) {
  for (const item of actor?.items ?? []) {
    const identifiers = [item.identifier, item.name].map(normalizeText).filter(Boolean);
    if (identifiers.some(value => MULTIATTACK_NAMES.some(name => value === name || value.includes(name)))) return item;
  }
  return null;
}

function aliasesFor(option) {
  const raw = [option.item?.identifier?.replaceAll?.("-", " "), option.label];
  const aliases = [];
  for (const value of raw) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    aliases.push(normalized.split(" "));
    const base = normalizeText(String(value).split("(")[0]);
    if (base && base !== normalized) aliases.push(base.split(" "));
  }
  for (const alias of [...aliases]) aliases.push(...pluralVariants(alias));
  return uniqueArrays(aliases).filter(alias => alias.length && alias.join(" ").length >= 3);
}

function pluralVariants(alias) {
  const last = alias.at(-1) ?? "";
  if (!last) return [];
  const variants = [];
  const add = word => variants.push([...alias.slice(0, -1), word]);

  if (last.endsWith("io")) add(`${last.slice(0, -2)}i`);
  else if (last.endsWith("o")) add(`${last.slice(0, -1)}i`);
  else if (last.endsWith("a")) add(`${last.slice(0, -1)}e`);
  else if (last.endsWith("e")) add(`${last.slice(0, -1)}i`);

  if (/[^aeiou]y$/.test(last)) add(`${last.slice(0, -1)}ies`);
  else if (/(?:s|x|z|ch|sh)$/.test(last)) add(`${last}es`);
  else if (!last.endsWith("s")) add(`${last}s`);
  return variants;
}

function findAliasStarts(tokens, aliases) {
  const starts = new Set();
  for (const alias of aliases) {
    for (let index = 0; index <= tokens.length - alias.length; index += 1) {
      if (alias.every((word, offset) => tokens[index + offset] === word)) starts.add(index);
    }
  }
  return [...starts].toSorted((left, right) => left - right);
}

function quantityBefore(tokens, start) {
  for (let index = start - 1, distance = 0; index >= 0 && distance < 7; index -= 1, distance += 1) {
    const quantity = parseQuantity(tokens[index]);
    if (quantity) return quantity;
    if (!CONNECTORS.has(tokens[index])) return null;
  }
  return null;
}

function explicitAttackTotal(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    if (!["attacks", "attacchi"].includes(tokens[index])) continue;
    const quantity = parseQuantity(tokens[index - 1]);
    if (quantity) return quantity;
  }
  return 0;
}

function parseQuantity(value) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 99) return numeric;
  return NUMBER_WORDS.get(value) ?? 0;
}

function tokenize(value) {
  return normalizeText(String(value).replace(/<[^>]*>/g, " ")).split(" ").filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, " and ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueArrays(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = value.join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
