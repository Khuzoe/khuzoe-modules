'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ClassicLevel } = require('classic-level');
const { readSnapshot } = require('./reader.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '..', 'build', 'reader-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'test-'));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); return fs.rm(root, { recursive: true, force: true }); });
  const db = new ClassicLevel(root, { valueEncoding: 'json' });
  await db.open();
  const scenes = db.sublevel('scenes', { valueEncoding: 'json' });
  await scenes.put('scene00000000001', { _id: 'scene00000000001', name: 'La cittadella', width: 1600, height: 1200, padding: 0.25,
    grid: { type: 1, size: 100, distance: 5 }, initialLevel: 'level00000000001', levels: ['level00000000001'], walls: ['wall000000000001'], lights: ['light00000000001'], tiles: [], tokens: ['private-token'] });
  await db.sublevel('scenes.levels', { valueEncoding: 'json' }).put('scene00000000001.level00000000001', { _id: 'level00000000001', name: 'Piano terra', background: { src: 'maps/map.webp' }, textures: { offsetX: 20, scaleX: -1 } });
  await db.sublevel('scenes.walls', { valueEncoding: 'json' }).put('scene00000000001.wall000000000001', { _id: 'wall000000000001', c: [400, 300, 800, 300], door: 1, ds: 2, levels: ['level00000000001'] });
  await db.sublevel('scenes.lights', { valueEncoding: 'json' }).put('scene00000000001.light00000000001', { _id: 'light00000000001', x: 600, y: 500, config: { bright: 10, dim: 20, color: '#ffaa33' } });
  await db.close();
  await fs.writeFile(path.join(root, 'khuzoe-snapshot.json'), JSON.stringify({ Schema: 1, Kind: 'KhuzoeSceneSnapshot', WorldId: 'test-world', CapturedAt: new Date().toISOString() }));
  return root;
}
test('lists actual world sublevel scene records, not embedded objects', async t => {
  const root = await fixture(t); const result = await readSnapshot(root);
  assert.equal(result.Scenes.length, 1); assert.equal(result.Scenes[0].Name, 'La cittadella'); assert.equal(result.Scenes[0].WallsCount, 1);
  assert.equal(result.WorldId, 'test-world');
});
test('expands v14 levels, walls and lights from the separate Foundry sublevels', async t => {
  const root = await fixture(t); const scene = await readSnapshot(root, 'scene00000000001');
  assert.equal(scene.Levels[0].Background, 'maps/map.webp'); assert.equal(scene.Levels[0].Textures.ScaleX, -1);
  assert.equal(scene.Walls[0].X1, 400); assert.equal(scene.Walls[0].DoorState, 2); assert.equal(scene.Lights[0].Bright, 10);
  assert.equal(scene.Lights[0].Color, '#ffaa33'); assert.equal(scene.Tokens, undefined);
});
test('refuses original databases without the private snapshot marker', async t => {
  const root = await fixture(t); await fs.unlink(path.join(root, 'khuzoe-snapshot.json'));
  await assert.rejects(readSnapshot(root));
});
test('rejects malformed scene identifiers', async t => {
  const root = await fixture(t); await assert.rejects(readSnapshot(root, '../other')); await assert.rejects(readSnapshot(root, 'scene.other'));
});
test('reports missing embedded entries without inventing geometry', async t => {
  const root = await fixture(t); const db = new ClassicLevel(root, { valueEncoding: 'json' });
  await db.open();
  await db.sublevel('scenes.walls', { valueEncoding: 'json' }).del('scene00000000001.wall000000000001'); await db.close();
  const scene = await readSnapshot(root, 'scene00000000001'); assert.equal(scene.Walls.length, 0); assert.ok(scene.Warnings.some(text => text.includes('walls')));
});
