import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const ignored = new Set(['node_modules', '.git', '.maintenance', 'dist', 'LOCK', 'LOG', 'LOG.old']);

export function compare(a, b) {
  if (![a, b].every(v => typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v))) throw new Error('Versione non valida');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}
function safeRelative(name) {
  if (!name || name.includes('\\') || name.includes(':') || path.posix.isAbsolute(name) ||
      name.split('/').some(p => !p || p === '..' || p === '.' || /[. ]$/.test(p))) throw new Error(`Percorso non valido: ${name}`);
  return name;
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deterministic ZIP, no npm packages. Dates and file order never depend on the runner.
export function zip(files) {
  const contents = [], directory = [];
  let offset = 0;
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    safeRelative(name);
    const encoded = Buffer.from(name), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(encoded.length, 26);
    contents.push(header, encoded, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, encoded);
    offset += header.length + encoded.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, central, end]);
}
export async function collectModule(root, id, config) {
  const source = JSON.parse(await readFile(path.join(root, 'module.json'), 'utf8'));
  if (source.id !== id || !/^\d+\.\d+\.\d+$/.test(source.version)) throw new Error(`Manifest non valido: ${id}`);
  if (!(source.compatibility?.minimum)) throw new Error(`Compatibilità Foundry assente: ${id}`);
  const manifest = structuredClone(source);
  const tag = `${id}-v${source.version}`;
  manifest.url = `https://github.com/${config.repository}`;
  manifest.manifest = `${config.pagesUrl}/modules/${id}/module.json`;
  manifest.download = `https://github.com/${config.repository}/releases/download/${tag}/module.zip`;
  for (const required of manifest.relationships?.requires ?? []) {
    if (config.modules.includes(required.id)) required.manifest = `${config.pagesUrl}/modules/${required.id}/module.json`;
  }
  const files = new Map(), folded = new Map();
  async function add(relative, optional = false) {
    safeRelative(relative);
    const absolute = path.join(root, ...relative.split('/'));
    let info;
    try { info = await lstat(absolute); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Collegamento non distribuibile: ${relative}`);
    if (info.isDirectory()) {
      for (const item of (await readdir(absolute)).sort()) {
        if (ignored.has(item) || item.startsWith('.') || /\.(zip|bak|tmp)$/i.test(item)) continue;
        await add(`${relative}/${item}`);
      }
    } else if (info.isFile()) {
      const lower = relative.toLowerCase();
      if (folded.has(lower) && folded.get(lower) !== relative) throw new Error(`Collisione Windows: ${relative}`);
      folded.set(lower, relative);
      files.set(relative, await readFile(absolute));
    }
  }
  // Copy the complete runtime trees; for packs include only paths declared by this version.
  for (const dir of ['scripts', 'styles', 'templates', 'lang', 'assets', 'icons', 'images', 'fonts', 'lib']) await add(dir, true);
  for (const pack of manifest.packs ?? []) await add(pack.path);
  for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) await add(name, true);
  for (const name of [...(manifest.esmodules ?? []), ...(manifest.scripts ?? []), ...(manifest.styles ?? []).map(s => typeof s === 'string' ? s : s.src), ...(manifest.languages ?? []).map(l => l.path)]) {
    if (!files.has(name)) await add(name);
  }
  files.set('module.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  const hash = createHash('sha256');
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) hash.update(name + '\0').update(data).update('\0');
  return { manifest, files, tag, fingerprint: hash.digest('hex') };
}
export async function prepare({ root = projectRoot, previous = null, output = path.join(root, 'build', 'publication') } = {}) {
  const config = JSON.parse(await readFile(path.join(root, 'publisher.config.json'), 'utf8'));
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_.-]+$/.test(config.pagesUrl)) throw new Error('Repository o URL Pages non valido');
  if (!Array.isArray(config.modules) || new Set(config.modules).size !== config.modules.length || config.modules.some(id => !/^[a-z0-9-]+$/.test(id))) throw new Error('Elenco moduli non valido');
  if (previous && (previous.schemaVersion !== 1 || previous.repository !== config.repository || !Array.isArray(previous.modules))) throw new Error('Catalogo precedente non valido');
  const before = new Map((previous?.modules ?? []).map(m => [m.id, m]));
  const releases = [], catalog = { schemaVersion: 1, repository: config.repository, modules: [] };
  const site = path.join(output, 'site');
  await mkdir(site, { recursive: true });
  for (const id of config.modules) {
    const collected = await collectModule(path.join(root, 'modules', id), id, config);
    const { manifest, files, tag, fingerprint } = collected;
    const old = before.get(id);
    const comparison = old ? compare(manifest.version, old.version) : 1;
    if (comparison < 0) throw new Error(`${id}: versione ${manifest.version} precedente a quella pubblicata ${old.version}`);
    if (comparison === 0 && old.fingerprint !== fingerprint) throw new Error(`${id}: file cambiati senza aumentare la versione ${manifest.version}`);
    let entry;
    if (comparison === 0) entry = old;
    else {
      const archive = zip(files);
      entry = { id, title: manifest.title, version: manifest.version, download: manifest.download,
        manifest: manifest.manifest, sha256: sha256(archive), size: archive.length, fingerprint,
        compatibility: manifest.compatibility, relationships: manifest.relationships ?? {} };
      const releaseDir = path.join(output, 'packages', id);
      await mkdir(releaseDir, { recursive: true });
      await writeFile(path.join(releaseDir, 'module.zip'), archive);
      await writeFile(path.join(releaseDir, 'module.json'), files.get('module.json'));
      releases.push({ id, version: manifest.version, tag, sha256: entry.sha256, directory: `packages/${id}` });
    }
    catalog.modules.push(entry);
    const dir = path.join(site, 'modules', id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'module.json'), files.get('module.json'));
  }
  await writeFile(path.join(site, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(path.join(site, '.nojekyll'), '');
  await writeFile(path.join(site, 'index.html'), '<!doctype html><html lang="it"><meta charset="utf-8"><title>Moduli Khuzoe</title><body><h1>Moduli Khuzoe</h1><p>Apri Khuzoe Updater per aggiornare i tuoi moduli.</p><p><a href="https://github.com/' + config.repository + '/releases">Versioni e download</a></p></body></html>');
  await writeFile(path.join(output, 'plan.json'), JSON.stringify({ repository: config.repository, releases }, null, 2) + '\n');
  return { catalog, releases };
}
async function priorCatalog(config) {
  if (process.env.PREVIOUS_CATALOG) return JSON.parse(await readFile(process.env.PREVIOUS_CATALOG, 'utf8'));
  const response = await fetch(`${config.pagesUrl}/catalog.json`, { signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Catalogo precedente non raggiungibile: HTTP ${response.status}`);
  return response.json();
}
export async function publish(output, { token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  const plan = JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8'));
  if (!token) throw new Error('GH_TOKEN mancante');
  async function api(endpoint, options = {}) {
    const response = await fetchImpl(`https://api.github.com/repos/${plan.repository}${endpoint}`, { ...options,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers }, signal: AbortSignal.timeout(120000) });
    return response;
  }
  // Independent immutable release tag per module. Never overwrite an existing asset.
  for (const item of plan.releases) {
    let response = await api(`/releases/tags/${encodeURIComponent(item.tag)}`);
    let release;
    if (response.status === 404) {
      response = await api('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        tag_name: item.tag, target_commitish: process.env.GITHUB_SHA, name: `${item.id} ${item.version}`,
        body: `Aggiornamento di ${item.id} alla versione ${item.version}.`, draft: true, make_latest: 'false' }) });
    }
    if (!response.ok) throw new Error(`Release ${item.tag}: HTTP ${response.status}`);
    release = await response.json();
    for (const name of ['module.zip', 'module.json']) {
      const data = await readFile(path.join(output, item.directory, name));
      const existing = release.assets.find(a => a.name === name);
      if (existing) {
        const downloaded = await fetchImpl(existing.browser_download_url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
        // Draft assets must be downloaded through the authenticated asset API.
        const assetResponse = downloaded.ok ? downloaded : await api(`/releases/assets/${existing.id}`, { headers: { Accept: 'application/octet-stream' } });
        if (!assetResponse.ok || sha256(Buffer.from(await assetResponse.arrayBuffer())) !== sha256(data))
          throw new Error(`La release ${item.tag} esiste con contenuto diverso. Aumenta la versione del modulo.`);
        continue;
      }
      if (!release.draft) throw new Error(`La release pubblicata ${item.tag} è incompleta: usare una nuova versione.`);
      const url = release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name);
      const upload = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'application/json' }, body: data, signal: AbortSignal.timeout(120000) });
      if (!upload.ok) throw new Error(`Caricamento ${item.tag}/${name}: HTTP ${upload.status}`);
    }
    if (release.draft) {
      const published = await api(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: 'false' }) });
      if (!published.ok) throw new Error(`Pubblicazione ${item.tag}: HTTP ${published.status}`);
    }
    console.log(`Pubblicato: ${item.tag}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'prepare';
  const output = process.env.PUBLICATION_OUTPUT ? path.resolve(process.env.PUBLICATION_OUTPUT) : path.join(projectRoot, 'build', 'publication');
  if (command === 'prepare' || command === 'preview') {
    const config = JSON.parse(await readFile(path.join(projectRoot, 'publisher.config.json'), 'utf8'));
    const previous = command === 'preview' ? null : await priorCatalog(config);
    const result = await prepare({ previous, output });
    console.log(`${result.releases.length} pacchetti preparati; ${result.catalog.modules.length} moduli nel catalogo.`);
  } else if (command === 'publish') await publish(output);
  else throw new Error(`Comando sconosciuto: ${command}`);
}
