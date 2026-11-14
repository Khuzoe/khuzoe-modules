import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compare, prepare, collectModule, applicationMetadata, collectApplication, validateApplicationArchive, zip, sha256, publish } from '../tools/publisher.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'khuzoe-publish-'));
  const config = { repository: 'Khuzoe/khuzoe-modules', pagesUrl: 'https://khuzoe.github.io/khuzoe-modules', modules: ['khuzoe-merchant', 'khuzoe-calendar'] };
  try {
    await writeFile(path.join(root, 'publisher.config.json'), JSON.stringify(config));
    for (const id of config.modules) {
      const dir = path.join(root, 'modules', id);
      await mkdir(path.join(dir, 'scripts'), { recursive: true });
      await writeFile(path.join(dir, 'module.json'), JSON.stringify({ id, title: id, version: '1.0.0', compatibility: { minimum: '14' }, esmodules: ['scripts/main.js'] }));
      await writeFile(path.join(dir, 'scripts', 'main.js'), 'export const version = 1;');
      await mkdir(path.join(dir, 'node_modules'), { recursive: true });
      await writeFile(path.join(dir, 'node_modules', 'secret.txt'), 'excluded');
    }
    await run(root, config);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('numeric versions', () => { assert.equal(compare('0.10.0', '0.9.0'), 1); assert.equal(compare('14', '14.0'), 0); });
test('initial publication, deterministic packages and no-op rerun', () => fixture(async (root, config) => {
  const first = await prepare({ root });
  assert.equal(first.releases.length, 2);
  const second = await prepare({ root, previous: first.catalog, output: path.join(root, 'second') });
  assert.equal(second.releases.length, 0);
  assert.deepEqual(first.catalog, second.catalog);
  const moduleRoot = path.join(root, 'modules', 'khuzoe-merchant');
  const a = await collectModule(moduleRoot, 'khuzoe-merchant', config);
  const b = await collectModule(moduleRoot, 'khuzoe-merchant', config);
  assert.equal(sha256(zip(a.files)), sha256(zip(b.files)));
  assert(![...a.files.keys()].some(n => n.includes('node_modules')));
  assert.equal(a.manifest.download, 'https://github.com/Khuzoe/khuzoe-modules/releases/download/khuzoe-merchant-v1.0.0/module.zip');
  assert.equal(JSON.parse(await readFile(path.join(moduleRoot, 'module.json'), 'utf8')).manifest, undefined, 'source manifest unchanged');
}));
test('only changed module published, missing bump rejected, downgrades rejected', () => fixture(async root => {
  const first = await prepare({ root });
  const source = path.join(root, 'modules', 'khuzoe-merchant');
  await writeFile(path.join(source, 'scripts', 'main.js'), 'export const version = 2;');
  await assert.rejects(prepare({ root, previous: first.catalog }), /senza aumentare/);
  const manifestPath = path.join(source, 'module.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '1.1.0'; await writeFile(manifestPath, JSON.stringify(manifest));
  const second = await prepare({ root, previous: first.catalog });
  assert.deepEqual(second.releases.map(r => r.id), ['khuzoe-merchant']);
  assert.deepEqual(second.catalog.modules[1], first.catalog.modules[1]);
  manifest.version = '0.9.0'; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(prepare({ root, previous: second.catalog }), /precedente/);
}));
test('missing runtime file and wrong id fail before publication', () => fixture(async (root, config) => {
  const source = path.join(root, 'modules', 'khuzoe-merchant');
  await assert.rejects(collectModule(source, 'khuzoe-calendar', config), /Manifest non valido/);
  const manifestPath = path.join(source, 'module.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.esmodules = ['scripts/missing.js']; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(collectModule(source, 'khuzoe-merchant', config), /ENOENT/);
}));
test('only declared pack revisions and no local development folders included', () => fixture(async (root, config) => {
  const source = path.join(root, 'modules', 'khuzoe-merchant');
  for (const revision of ['pack-v1', 'pack-v2']) {
    await mkdir(path.join(source, 'packs', revision), { recursive: true });
    await writeFile(path.join(source, 'packs', revision, 'CURRENT'), 'MANIFEST-000001');
  }
  await writeFile(path.join(source, 'packs', 'pack-v2', 'LOCK'), 'locked');
  const manifestPath = path.join(source, 'module.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.packs = [{ path: 'packs/pack-v2' }]; await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await collectModule(source, 'khuzoe-merchant', config);
  assert(result.files.has('packs/pack-v2/CURRENT'));
  assert(!result.files.has('packs/pack-v2/LOCK'));
  assert(!result.files.has('packs/pack-v1/CURRENT'));
}));
test('unsafe ZIP names rejected', () => {
  assert.throws(() => zip(new Map([['../other-module/module.json', Buffer.from('bad')]])), /Percorso non valido/);
});
test('publish uses an independent draft release per module and uploads before making it public', () => fixture(async root => {
  const output = path.join(root, 'publication');
  await prepare({ root, output });
  const calls = [];
  let sequence = 0;
  const mock = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/releases/tags/')) return new Response('{}', { status: 404 });
    if (url.endsWith('/releases') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.draft, true);
      assert.equal(body.make_latest, 'false');
      return Response.json({ id: ++sequence, draft: true, assets: [], upload_url: `https://uploads.github.com/releases/${sequence}/assets{?name}` });
    }
    if (url.startsWith('https://uploads.github.com/')) return Response.json({});
    if (options.method === 'PATCH') { assert.equal(JSON.parse(options.body).draft, false); return Response.json({}); }
    throw new Error('Unexpected request ' + url);
  };
  await publish(output, { token: 'test-only', fetchImpl: mock });
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 2);
  assert.equal(calls.filter(c => c.url.includes('assets?name=')).length, 4);
  const creates = calls.filter(c => c.url.endsWith('/releases') && c.method === 'POST').map(c => JSON.parse(c.body).tag_name);
  assert.deepEqual(creates, ['khuzoe-merchant-v1.0.0', 'khuzoe-calendar-v1.0.0']);
  for (let i = 0; i < calls.length; i++) if (calls[i].method === 'PATCH') assert.equal(calls[i - 1].method, 'POST');
}));
test('published release with different bytes is never overwritten', () => fixture(async root => {
  const output = path.join(root, 'publication');
  await prepare({ root, output });
  const calls = [];
  const mock = async (url, options = {}) => {
    calls.push(options.method ?? 'GET');
    if (url.includes('/releases/tags/')) return Response.json({ id: 1, draft: false, assets: [{ id: 1, name: 'module.zip', browser_download_url: 'https://github.com/test.zip' }] });
    return new Response('wrong bytes');
  };
  await assert.rejects(publish(output, { token: 'test-only', fetchImpl: mock }), /contenuto diverso/);
  assert(calls.every(m => m === 'GET'));
}));

async function addApplication(root, config) {
  config.applications = ['khuzoe-assets-manager']; await writeFile(path.join(root, 'publisher.config.json'), JSON.stringify(config));
  const app = path.join(root, 'applications', config.applications[0]);
  await mkdir(app, { recursive: true });
  await writeBinary(app, { id: config.applications[0], title: 'Assets Manager', version: '0.3.0', entryPoint: 'KhuzoeAssetsManager.exe', compatibility: { minimum: '14' } });
  return app;
}
async function writeBinary(app, manifest, options = {}) {
  const reader = Buffer.from('fixture reader'), native = Buffer.from('fixture native binary');
  const files = new Map([
    ['application.json', Buffer.from(JSON.stringify(options.inside ?? manifest))],
    [manifest.entryPoint, Buffer.from(options.exe ?? 'compiled fixture')], [manifest.entryPoint + '.config', Buffer.from('fixture config')],
    ['scene-reader/reader.cjs', reader], ['scene-reader/fixture.node', native],
    ['scene-reader/integrity.json', Buffer.from(JSON.stringify({ 'reader.cjs': sha256(reader), 'fixture.node': sha256(native) }))]
  ]);
  if (options.extra) for (const [name, value] of options.extra) files.set(name, Buffer.from(value));
  const archive = zip(files);
  await writeFile(path.join(app, 'application.json'), JSON.stringify(manifest));
  await writeFile(path.join(app, 'application.zip'), archive);
  await writeFile(path.join(app, 'release.json'), JSON.stringify({ id: manifest.id, version: manifest.version, size: archive.length, sha256: sha256(archive) }));
}
test('application catalog remains compatible with existing module clients and runtime excludes user state', () => fixture(async (root, config) => {
  const app = await addApplication(root, config), first = await prepare({ root });
  assert.equal(first.catalog.modules.length, 2); assert.equal(first.catalog.applications.length, 1);
  const entry = first.catalog.applications[0]; assert.equal(entry.id, 'khuzoe-assets-manager'); assert.equal(entry.entryPoint, 'KhuzoeAssetsManager.exe');
  assert.equal(entry.download, 'https://github.com/Khuzoe/khuzoe-modules/releases/download/khuzoe-assets-manager-v0.3.0/application.zip');
  const metadata = await applicationMetadata(app, entry.id, config), archive = await collectApplication(app, metadata), files = validateApplicationArchive(archive, metadata.manifest);
  assert(files.includes('scene-reader/fixture.node')); assert(files.includes('application.json')); assert(!files.includes('module.json')); assert(!files.includes('session.bin')); assert(!files.includes('app/Main.cs'));
  const second = await prepare({ root, previous: first.catalog }); assert.equal(second.releases.length, 0); assert.deepEqual(second.catalog, first.catalog);
}));
test('compiled application changes require its own version bump and only that application is published', () => fixture(async (root, config) => {
  const app = await addApplication(root, config), first = await prepare({ root });
  const file = path.join(app, 'application.json'), manifest = JSON.parse(await readFile(file)); manifest.version = '0.3.1';
  manifest.version = '0.3.0'; await writeBinary(app, manifest, { exe: 'changed compiled fixture' }); await assert.rejects(prepare({ root, previous: first.catalog }), /senza aumentare/);
  manifest.version = '0.3.1'; await writeBinary(app, manifest);
  const next = await prepare({ root, previous: first.catalog }); assert.deepEqual(next.releases.map(item => item.id), ['khuzoe-assets-manager']); assert.deepEqual(next.catalog.modules, first.catalog.modules);
  assert.deepEqual(next.releases[0].assets, ['application.zip', 'application.json']);
  manifest.version = '0.2.0'; await writeBinary(app, manifest);
  await assert.rejects(prepare({ root, previous: next.catalog }), /precedente/);
}));
test('precompiled ZIP is checked against its declared digest', () => fixture(async (root, config) => {
  const app = await addApplication(root, config); const file = path.join(app, 'application.zip'), bytes = await readFile(file); bytes[50] ^= 1; await writeFile(file, bytes);
  await assert.rejects(prepare({ root }), /Impronta pacchetto/);
}));
test('private project files and user sessions are rejected even inside a correctly hashed archive', () => fixture(async (root, config) => {
  const app = await addApplication(root, config), manifest = JSON.parse(await readFile(path.join(app, 'application.json')));
  for (const name of ['app/Main.cs', 'scene-reader/private.cs', 'session.bin', 'tools/build.ps1']) {
    await writeBinary(app, manifest, { extra: [[name, 'must remain local']] }); await assert.rejects(prepare({ root }), /File non runtime o sorgente privato/);
  }
}));
test('embedded application identity must match the public descriptor', () => fixture(async (root, config) => {
  const app = await addApplication(root, config), manifest = JSON.parse(await readFile(path.join(app, 'application.json')));
  await writeBinary(app, manifest, { inside: { ...manifest, version: '99.0.0' } }); await assert.rejects(prepare({ root }), /manifest nello ZIP/);
}));
test('application publication uploads its application ZIP and manifest before exposing the release', () => fixture(async (root, config) => {
  await addApplication(root, config); const output = path.join(root, 'publication'), modulesOnly = await prepare({ root, output });
  const previous = { ...modulesOnly.catalog, applications: [] }; await prepare({ root, previous, output }); const uploaded = [];
  await publish(output, { token: 'test-only', fetchImpl: async (url, options = {}) => {
    if (url.includes('/releases/tags/')) return new Response('{}', { status: 404 });
    if (url.endsWith('/releases')) return Response.json({ id: 1, draft: true, assets: [], upload_url: 'https://uploads.github.com/assets{?name}' });
    if (url.startsWith('https://uploads.github.com/')) { uploaded.push(new URL(url).searchParams.get('name')); return Response.json({}); }
    assert.equal(options.method, 'PATCH'); assert.deepEqual(uploaded, ['application.zip', 'application.json']); return Response.json({});
  } });
}));
