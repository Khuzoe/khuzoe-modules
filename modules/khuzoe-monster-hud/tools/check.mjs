import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const jsonFiles = ["module.json", "package.json", "lang/it.json", "lang/en.json"];
const parsed = new Map();
let failed = false;

for (const file of jsonFiles) {
  try {
    parsed.set(file, JSON.parse(readFileSync(join(root, file), "utf8")));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}

const manifest = parsed.get("module.json");
const packageData = parsed.get("package.json");
if (manifest) {
  const paths = [
    ...(manifest.esmodules ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map(language => language.path)
  ];
  for (const path of paths) {
    if (!existsSync(join(root, path))) fail(`Missing manifest path: ${path}`);
  }
  if (manifest.version !== packageData?.version) fail("module.json and package.json versions differ.");
  if (Number.parseInt(manifest.compatibility?.minimum, 10) !== 14) fail("Foundry minimum must be 14.");
  if (manifest.relationships?.systems?.[0]?.id !== "dnd5e") fail("D&D5e system relationship is missing.");
}

const italian = flatten(parsed.get("lang/it.json"));
const english = flatten(parsed.get("lang/en.json"));
for (const key of italian) if (!english.has(key)) fail(`English localization missing: ${key}`);
for (const key of english) if (!italian.has(key)) fail(`Italian localization missing: ${key}`);

if (failed) process.exit(1);
process.stdout.write(`Validated ${jsonFiles.length} JSON files and ${italian.size} localization keys.\n`);

function flatten(value, prefix = "", output = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) output.add(prefix);
    return output;
  }
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, output);
  return output;
}

function fail(message) {
  failed = true;
  process.stderr.write(`${message}\n`);
}
