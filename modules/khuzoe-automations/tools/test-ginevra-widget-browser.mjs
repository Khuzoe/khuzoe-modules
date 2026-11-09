import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile, mkdir, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Real widget and charge service in an isolated page; no Foundry/world connection.
async function fixture() {
  try {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const until = async condition => {
      for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('Attesa scaduta');
    };
    const hooks = new Map(), once = new Map(), errors = [];
    window.Hooks = {
      once(name, callback) { const entries = once.get(name) ?? []; entries.push(callback); once.set(name, entries); },
      on(name, callback) { const entries = hooks.get(name) ?? []; entries.push(callback); hooks.set(name, entries); },
      callAll(name, ...args) { for (const fn of [...(once.get(name) ?? []), ...(hooks.get(name) ?? [])]) fn(...args); once.delete(name); }
    };
    window.foundry = {applications: {api: {ApplicationV2: class {}, HandlebarsApplicationMixin: base => base}}};
    const gm = {id: 'gm', isGM: true, active: true}, observer = {id: 'observer', isGM: false, active: true};
    const users = new Map([[gm.id, gm], [observer.id, observer]]);
    users.activeGM = gm;
    const actor = {id: 'garun', uuid: 'Actor.garun', name: 'Garun', documentName: 'Actor', isOwner: true,
      flags: {}, effects: [], items: [{uuid: 'Actor.garun.Item.ginevra', name: 'Abbraccio di Ginevra', system: {identifier: 'abbraccio-di-ginevra'}}],
      getFlag(scope, key) { return this.flags[scope]?.[key]; }, testUserPermission: () => true};
    const settings = new Map(), definitions = new Map();
    window.game = {user: gm, users, actors: new Map([[actor.id, actor]]), modules: new Map([['khuzoe-automations', {active: true}]]), settings: {
      register(scope, key, definition) { definitions.set(key, definition); settings.set(key, key === 'actorId' ? actor.id : definition.default); },
      registerMenu() {}, get(scope, key) { return settings.get(key); },
      async set(scope, key, value) { settings.set(key, value); definitions.get(key)?.onChange?.(); }
    }};
    window.ui = {notifications: {error: message => errors.push(message), warn: message => errors.push(message)}};
    let effectId = 0;
    window.cat = {utils: {
      effectUtils: {createEffects: async (actor, entries) => entries.forEach(entry => {
        const effect = {...entry, id: `effect${++effectId}`, parent: actor,
          async update(changes) {
            for (const [key, value] of Object.entries(changes)) {
              const parts = key.split('.'), leaf = parts.pop();
              parts.reduce((root, part) => root[part] ??= {}, this)[leaf] = value;
            }
            Hooks.callAll('updateActiveEffect', this);
          }};
        actor.effects.push(effect); Hooks.callAll('createActiveEffect', effect);
      })},
      documentUtils: {deleteDocument: async effect => {
        actor.effects = actor.effects.filter(candidate => candidate !== effect); Hooks.callAll('deleteActiveEffect', effect);
      }}
    }};
    const resource = await import('/modules/khuzoe-automations/scripts/ginevra-charges.mjs');
    resource.registerGinevraChargesApi();
    await import('/modules/energia-radiosa/main.mjs');
    Hooks.callAll('init'); Hooks.callAll('ready');
    await until(() => document.querySelector('#energia-radiosa-hud')?.shadowRoot.querySelector('.charge-value'));
    const host = document.querySelector('#energia-radiosa-hud'), root = host.shadowRoot;
    const number = root.querySelector('.charge-value'), slider = root.querySelector('.slider');
    check(number.readOnly && slider.disabled, 'Inactive buff is read only');
    check(root.querySelector('.source-status').textContent === 'Abbraccio non attivo', 'Inactive message');
    await resource.changeGinevraCharges(actor, 'activate', {itemUuid: actor.items[0].uuid});
    check(!number.readOnly && slider.max === '100', 'Activation enables the real 0–100 pool');
    const event = (control, name) => control.dispatchEvent(new Event(name, {bubbles: true}));
    number.value = '42'; event(number, 'input'); event(number, 'change');
    await until(() => resource.getGinevraCharges(actor).value === 42 && number.value === '42');
    slider.value = '70'; event(slider, 'input'); event(slider, 'change');
    await until(() => number.value === '70');
    const collect = (amount, id) => resource.changeGinevraCharges(actor, 'collect', {
      itemUuid: actor.items[0].uuid, effectId: actor.effects[0].id, amount, workflowId: id
    });
    await collect(8, 'hit1');
    check(number.value === '78', 'Damage updates the number via the effect hook');
    number.value = '12'; event(number, 'input');
    await collect(4, 'hit2');
    check(number.value === '12', 'Incoming updates preserve the number being typed');
    event(number, 'change');
    await until(() => errors.some(message => message.includes('cariche sono cambiate')) && number.value === '82');
    check(resource.getGinevraCharges(actor).value === 82, 'Stale input cannot erase incoming charges');
    game.user = observer; actor.isOwner = false; Hooks.callAll('updateUser', observer);
    check(number.readOnly && slider.disabled && !host.hidden, 'Observers see the widget but cannot edit');
    actor.testUserPermission = () => false; Hooks.callAll('updateUser', observer);
    check(host.hidden, 'Users without observation permission cannot see the widget');
    game.user = gm; actor.isOwner = true; Hooks.callAll('updateUser', gm);
    await cat.utils.documentUtils.deleteDocument(actor.effects[0]);
    check(number.readOnly && number.value === '0', 'Deleting the buff clears and disables the widget');
    await resource.changeGinevraCharges(actor, 'activate', {itemUuid: actor.items[0].uuid});
    await resource.setGinevraCharges(actor, 57);
    await game.settings.set('energia-radiosa', 'minimized', true);
    check(root.querySelector('.compact-count').textContent === '57', 'Compact view uses the same charges');
    await game.settings.set('energia-radiosa', 'minimized', false);
    document.documentElement.dataset.testResult = 'passed';
  } catch (error) { document.documentElement.dataset.testResult = 'failed'; document.body.append(String(error.stack)); }
}

const dataRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = fileURLToPath(new URL('../.maintenance/ginevra-widget-verification/', import.meta.url));
const profile = path.resolve(output, 'browser-profile');
assert.ok(profile.startsWith(path.resolve(output) + path.sep));
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#171c26}</style></head><body><script type="module">(${fixture})();</script></body></html>`);
      return;
    }
    if (!['/modules/energia-radiosa/', '/modules/khuzoe-automations/scripts/'].some(prefix => pathname.startsWith(prefix))) {
      response.writeHead(404).end(); return;
    }
    const filename = path.resolve(dataRoot, '.' + pathname);
    if (!filename.startsWith(dataRoot)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', {'.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.css': 'text/css'}[path.extname(filename)] ?? 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const executable = process.env.KHUZOE_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--window-size=1200,800', `--user-data-dir=${profile}`,
    '--virtual-time-budget=5000', '--dump-dom', `--screenshot=${path.join(output, 'widget.png')}`, `http://127.0.0.1:${server.address().port}/`], {windowsHide: true});
  let html = '', diagnostics = '';
  browser.stdout.on('data', chunk => { html += chunk; });
  browser.stderr.on('data', chunk => { diagnostics += chunk; });
  const timeout = setTimeout(() => browser.kill(), 25000);
  try {
    const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve); });
    assert.equal(code, 0, diagnostics.slice(-1800));
    assert.match(html, /data-test-result="passed"/, html.slice(-2200));
    console.log('Widget nel browser: campo numerico, slider, aggiornamenti automatici, conflitti, permessi, scadenza e vista ridotta verificati.');
  } finally { clearTimeout(timeout); }
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
