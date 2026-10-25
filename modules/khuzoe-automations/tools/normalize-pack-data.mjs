import {readFile, readdir, writeFile} from "node:fs/promises";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";

const root = new URL("../packData/", import.meta.url);
let changed = 0;
for (const pack of await readdir(root, {withFileTypes: true})) {
  if (!pack.isDirectory()) continue;
  const directory = new URL(`${pack.name}/`, root);
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const url = new URL(file, directory);
    const original = await readFile(url, "utf8");
    const item = JSON.parse(original);
    normalizeAutomationData(item);
    for (const embedded of item.items ?? []) normalizeAutomationData(embedded);
    const result = `${JSON.stringify(item, null, 2)}\n`;
    if (result !== original) { await writeFile(url, result); changed++; }
  }
}
console.log(`Khuzoe: ${changed} sorgenti compendio normalizzate.`);
