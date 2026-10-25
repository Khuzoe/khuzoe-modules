import { cp, mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectRoot } from './publisher.mjs';

const cliArgument = process.argv.indexOf('--cli');
const cliPath = cliArgument >= 0 ? path.resolve(process.argv[cliArgument + 1]) : path.join(projectRoot, 'modules/khuzoe-automations/node_modules/@foundryvtt/foundryvtt-cli/index.mjs');
const { extractPack } = await import(pathToFileURL(cliPath).href);
await mkdir(path.join(projectRoot, '.work'), { recursive: true });
const work = await mkdtemp(path.join(projectRoot, '.work', 'verify-packs-'));
try {
  const config = JSON.parse(await readFile(path.join(projectRoot, 'publisher.config.json'), 'utf8'));
  for (const id of config.modules) {
    const moduleRoot = path.join(projectRoot, 'modules', id);
    const manifest = JSON.parse(await readFile(path.join(moduleRoot, 'module.json'), 'utf8'));
    for (const pack of manifest.packs ?? []) {
      const destination = path.join(work, id, pack.name);
      await cp(path.join(moduleRoot, pack.path), destination, { recursive: true });
      const extracted = destination + '-json';
      await extractPack(destination, extracted, { log: false });
      const names = (await readdir(extracted)).filter(n => n.endsWith('.json'));
      assert(names.length > 0, `${id}/${pack.name}: compendio vuoto`);
      const ids = new Set();
      for (const name of names) {
        const document = JSON.parse(await readFile(path.join(extracted, name), 'utf8'));
        assert(document._id && !ids.has(document._id), `ID mancante/duplicato: ${name}`);
        ids.add(document._id);
      }
      console.log(`${id}/${pack.name}: ${names.length} documenti leggibili, ID univoci.`);
    }
  }
} finally { await rm(work, { recursive: true, force: true }); }
