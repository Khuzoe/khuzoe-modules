import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, zip, sha256 } from './publisher.mjs';

const dist = path.join(projectRoot, 'dist');
await mkdir(dist, { recursive: true });
const appFiles = new Map();
for (const name of ['KhuzoeUpdater.exe', 'KhuzoeUpdater.exe.config']) appFiles.set(name, await readFile(path.join(dist, name)));
appFiles.set('LEGGIMI.txt', Buffer.from('KHUZOE UPDATER\r\n\r\nApri KhuzoeUpdater.exe e scegli la cartella principale di Foundry.\r\nLa scelta viene ricordata. Chiudi Foundry prima di premere Aggiorna.\r\nLascia KhuzoeUpdater.exe.config accanto al programma.\r\n\r\nIl catalogo funzionera dopo la prima pubblicazione GitHub.\r\nhttps://github.com/Khuzoe/khuzoe-modules/releases\r\n'));
const app = zip(appFiles);
await writeFile(path.join(dist, 'KhuzoeUpdater-Windows.zip'), app);
const projectFiles = new Map();
async function collect(relative) {
  for (const entry of await readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (['node_modules', '.maintenance', '.git', 'LOCK', 'LOG', 'LOG.old'].includes(entry.name)) continue;
    if (entry.isDirectory()) await collect(name);
    else if (entry.isFile()) projectFiles.set(name, await readFile(path.join(projectRoot, name)));
    else throw new Error('Collegamento non distribuibile: ' + name);
  }
}
for (const folder of ['.github', 'app', 'modules', 'tests', 'tools']) await collect(folder);
for (const name of ['.gitignore', '.gitattributes', 'AGENTS.md', 'README.md', 'CONFIGURAZIONE-GITHUB.md', 'VERIFICHE.md', 'publisher.config.json']) projectFiles.set(name, await readFile(path.join(projectRoot, name)));
const project = zip(projectFiles);
await writeFile(path.join(dist, 'Khuzoe-Updater-progetto-GitHub.zip'), project);
await writeFile(path.join(dist, 'SHA256SUMS.txt'), `${sha256(app)}  KhuzoeUpdater-Windows.zip\n${sha256(project)}  Khuzoe-Updater-progetto-GitHub.zip\n`);
console.log(`App: ${app.length} byte; progetto GitHub: ${project.length} byte, ${projectFiles.size} file.`);
