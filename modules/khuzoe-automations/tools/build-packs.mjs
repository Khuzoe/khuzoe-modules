import {compilePack, extractPack} from "@foundryvtt/foundryvtt-cli";
import {fileURLToPath} from "node:url";
import {existsSync} from "node:fs";
import {readFile, readdir, writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {RELEASE_VERSION} from "../scripts/release.mjs";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("module.json", root);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
// Optional focused releases leave unrelated open compendia and CAT versions alone.
const args = process.argv.slice(2);
const requestedPack = args.find(arg => arg.startsWith("--pack="))?.slice(7);
const version = args.find(arg => arg.startsWith("--version="))?.slice(10) ?? RELEASE_VERSION;
assert.match(version, /^\d+\.\d+\.\d+$/, "Versione non valida");
if (requestedPack) assert.ok(manifest.packs.some(pack => pack.path.startsWith(`packs/${requestedPack}-v`)), "Pack non valido");
const packs = [
  "khuzoe-spells-2014", "khuzoe-spells-2024", "khuzoe-class-features-2014",
  "khuzoe-summons-2014", "khuzoe-npc-features-2014"
].filter(source => !requestedPack || source === requestedPack).map(source => {
  const current = manifest.packs.find(pack => pack.path.startsWith(`packs/${source}-v`));
  assert.ok(current, `Pack non dichiarato: ${source}`);
  let revision = Number(/-v(\d+)$/.exec(current.path)?.[1] ?? 0) + 1;
  while (existsSync(new URL(`packs/${source}-v${revision}/`, root))) revision++;
  return [source, `${source}-v${revision}`];
});

// Foundry can hold its active LevelDB packs open. Never overwrite an existing pack.
for (const [, destination] of packs) {
  if (existsSync(new URL(`packs/${destination}/`, root))) throw new Error(`Destinazione già presente: ${destination}. Scegli una nuova revisione prima di compilare.`);
}
const verification = new URL(`.maintenance/verified-packs-${version}-${Date.now()}/`, root);
if (existsSync(verification)) throw new Error("Directory di verifica già presente.");
const counts = {};
for (const [source, destination] of packs) {
  const input = new URL(`packData/${source}/`, root);
  const output = new URL(`packs/${destination}/`, root);
  await compilePack(fileURLToPath(input), fileURLToPath(output), {log: false});
  const extracted = new URL(`${source}/`, verification);
  await extractPack(fileURLToPath(output), fileURLToPath(extracted), {log: false});
  const originals = new Map();
  for (const name of await readdir(input)) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(new URL(name, input), "utf8"));
    originals.set(data._id, data);
  }
  let count = 0;
  for (const name of await readdir(extracted)) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(new URL(name, extracted), "utf8"));
    const expected = originals.get(data._id);
    assert.ok(expected, `${source}: ID inatteso ${data._id}`);
    assert.deepEqual(data, expected, `${source}: dati compilati diversi dalla sorgente ${data._id}`);
    count++;
  }
  assert.equal(count, originals.size, `${source}: numero di documenti diverso`);
  counts[source] = count;
  console.log(`${source}: ${count} documenti compilati e riletti senza differenze.`);
}
// Publish only after every new pack has been compiled and compared with its sources.
manifest.version = version;
for (const [source, destination] of packs) {
  const pack = manifest.packs.find(pack => pack.path.startsWith(`packs/${source}-v`));
  assert.ok(pack, `Pack non dichiarato: ${source}`);
  pack.path = `packs/${destination}`;
}
for (const name of ["package.json", "package-lock.json"]) {
  const url = new URL(name, root);
  if (!existsSync(url)) continue;
  const data = JSON.parse(await readFile(url, "utf8"));
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
  await writeFile(url, `${JSON.stringify(data, null, 2)}\n`);
}
await writeFile(new URL(".maintenance/pack-verification.json", root), `${JSON.stringify({version, counts, packs}, null, 2)}\n`);
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifesto aggiornato a ${version}; compendi precedenti conservati.`);
