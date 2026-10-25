import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const jsonFiles = ["module.json", "package.json", "lang/it.json", "lang/en.json"];
const parsed = new Map();
let failed = false;

for (const jsonFile of jsonFiles) {
  try {
    parsed.set(jsonFile, JSON.parse(readFileSync(join(root, jsonFile), "utf8")));
  } catch (error) {
    fail(`${jsonFile}: ${error.message}`);
  }
}

const manifest = parsed.get("module.json");
if (manifest) {
  const referencedPaths = [
    ...(manifest.esmodules ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map(language => language.path)
  ];
  for (const path of referencedPaths) {
    if (!existsSync(join(root, path))) fail(`module.json references missing file: ${path}`);
  }

  const packageData = parsed.get("package.json");
  if (packageData?.version !== manifest.version) {
    fail(`Version mismatch: module.json=${manifest.version}, package.json=${packageData?.version}`);
  }
  if (Number.parseInt(manifest.compatibility?.minimum, 10) !== 14) {
    fail("module.json must target Foundry VTT 14 as its minimum version.");
  }
}

const italianKeys = flattenKeys(parsed.get("lang/it.json"));
const englishKeys = flattenKeys(parsed.get("lang/en.json"));
for (const key of italianKeys) {
  if (!englishKeys.has(key)) fail(`English localization is missing: ${key}`);
}
for (const key of englishKeys) {
  if (!italianKeys.has(key)) fail(`Italian localization is missing: ${key}`);
}

if (failed) process.exit(1);
process.stdout.write(`Validated ${jsonFiles.length} JSON files, manifest paths, and ${italianKeys.size} localization keys.\n`);

function flattenKeys(value, prefix = "", output = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) output.add(prefix);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenKeys(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function fail(message) {
  failed = true;
  process.stderr.write(`${message}\n`);
}
