import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const baseSource = fs.readFileSync(new URL('../scripts/apps/base-shadow-app.js', import.meta.url), 'utf8');
function setup({ remote = false, origin = 'https://wiki.test', href = 'about:blank', readyState = 'complete' } = {}) {
    const sent = [], listeners = new Map(), messages = new Set();
    const child = {postMessage(data, target) {sent.push({data, target});}};
    Object.defineProperty(child, 'location', {get() {
        if (remote) {const error = new Error('Cross origin'); error.name = 'SecurityError'; throw error;}
        return {href};
    }});
    const frame = {src: origin + '/pages/characters/character.html?embed=1', contentWindow: child,
        contentDocument: {readyState}, addEventListener(type, handler) {listeners.set(type, handler);},
        removeEventListener(type, handler) {if (listeners.get(type) === handler) listeners.delete(type);}};
    const settings = {token: 'test-token'};
    const sandbox = {URL, console, MODULE_ID: 'cripta-wiki-sync', SETTINGS: {DISCORD_TOKEN: 'token'},
        HandlebarsApplicationV2: class {}, wikiDataService: {getBaseUrl: () => origin},
        game: {settings: {get: () => settings.token}},
        window: {addEventListener(type, handler) {messages.add(handler);}, removeEventListener(type, handler) {messages.delete(handler);}}};
    vm.runInNewContext(baseSource.replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') + '\nglobalThis.App = BaseShadowApp;', sandbox);
    const app = new sandbox.App(); app.getEmbeddedFrame = () => frame;
    return {app, sent, listeners, messages, settings, frame, navigate() {remote = true;}, message(event) {for (const handler of messages) handler(event);}};
}

test('initial blank frame never receives credentials, even if Foundry shares its origin', () => {
    for (const origin of ['https://wiki.test', 'http://localhost:30000']) {
        const state = setup({origin}); state.app.bindFrameMessageHandler();
        assert.equal(state.sent.length, 0);
        state.app.sendAuthToken('new-token'); assert.equal(state.sent.length, 0);
        state.navigate(); state.listeners.get('load')();
        assert.equal(state.sent.length, 1); assert.equal(state.sent[0].target, origin);
    }
});
test('same-origin Foundry document and incomplete wiki document are skipped', () => {
    for (const options of [{href: 'http://localhost:30000/game'}, {href: 'https://wiki.test/tree', readyState: 'loading'}]) {
        const state = setup(options); state.app.bindFrameMessageHandler(); assert.equal(state.sent.length, 0);
    }
});
test('already loaded cross-origin frame receives auth without relying on a missed load event', () => {
    const state = setup({remote: true}); state.app.bindFrameMessageHandler();
    assert.equal(state.sent.length, 1); assert.equal(state.sent[0].target, 'https://wiki.test');
});
test('already loaded same-origin wiki page receives auth', () => {
    const state = setup({origin: 'http://localhost:30000', href: 'http://localhost:30000/wiki/tree'});
    state.app.bindFrameMessageHandler(); assert.equal(state.sent.length, 1);
});
test('load, refresh and duplicate propagation do not repeatedly authenticate the same frame', () => {
    const state = setup({remote: true}); state.app.bindFrameMessageHandler();
    state.listeners.get('load')(); state.app.sendAuthToken('test-token');
    assert.equal(state.sent.length, 1);
    state.app.sendAuthToken('rotated-token'); assert.equal(state.sent.length, 2);
});
test('verified ready handshake retries auth; other windows and origins are ignored', () => {
    const state = setup({remote: true}); state.app.bindFrameMessageHandler();
    for (const event of [{source: {}, origin: 'https://wiki.test'}, {source: state.frame.contentWindow, origin: 'http://localhost:30000'}]) {
        state.message({...event, data: {type: 'cripta-embed-ready'}});
    }
    assert.equal(state.sent.length, 1);
    state.message({source: state.frame.contentWindow, origin: 'https://wiki.test', data: {type: 'cripta-embed-ready'}});
    assert.equal(state.sent.length, 2);
});
test('closing or replacing a frame detaches handlers from the actual old frame', () => {
    const state = setup({remote: true}); state.app.bindFrameMessageHandler();
    state.app.getEmbeddedFrame = () => null;
    state.app.unbindFrameMessageHandler();
    assert.equal(state.listeners.size, 0); assert.equal(state.messages.size, 0);
    assert.equal(state.app._lastFrameAuth, null);
});
test('SPA locations remain restricted to the configured origin', () => {
    const state = setup({remote: true}); state.app.bindFrameMessageHandler();
    const message = url => state.message({source: state.frame.contentWindow, origin: 'https://wiki.test', data: {type: 'cripta-spa-navigate', url}});
    message('https://other.test/'); assert.equal(state.app.currentIframeUrl, '');
    message('/wiki/tree'); assert.equal(state.app.currentIframeUrl, 'https://wiki.test/wiki/tree');
});
