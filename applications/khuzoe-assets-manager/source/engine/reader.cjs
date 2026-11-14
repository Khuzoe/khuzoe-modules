'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ClassicLevel } = require('classic-level');

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const number = (value, fallback = 0, min = -1e7, max = 1e7) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const levels = value => Array.isArray(value) ? value.filter(validId) : [];

async function assertSnapshot(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('La copia della scena non è una directory valida.');
  const markerPath = path.join(directory, 'khuzoe-snapshot.json');
  const markerStat = await fs.lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 10000) throw new Error('Identificatore della copia non valido.');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (marker.Schema !== 1 || marker.Kind !== 'KhuzoeSceneSnapshot' || !validId(marker.WorldId)) throw new Error('Il lettore apre soltanto copie temporanee di Khuzoe.');
  const current = await fs.lstat(path.join(directory, 'CURRENT'));
  if (!current.isFile() || current.isSymbolicLink()) throw new Error('La copia non contiene un database scene.');
  return marker;
}

async function expand(db, scene, collection, warnings) {
  const source = scene[collection];
  if (!Array.isArray(source)) return [];
  const ids = source.filter(value => typeof value === 'string');
  if (ids.some(id => !validId(id))) throw new Error(`Identificatori non validi nella raccolta ${collection}.`);
  if (!ids.length) return source.filter(value => value && typeof value === 'object' && validId(value._id));
  const sublevel = db.sublevel(`scenes.${collection}`, { valueEncoding: 'json' });
  const found = await sublevel.getMany(ids.map(id => `${scene._id}.${id}`));
  const records = found.filter(value => value && typeof value === 'object' && validId(value._id));
  if (records.length !== ids.length) warnings.push(`${ids.length - records.length} elementi ${collection} non disponibili nella copia.`);
  return records;
}

function summary(scene) {
  return {
    Id: scene._id, Name: text(scene.name, 250) || scene._id,
    Width: number(scene.width, 4000, 1, 2e6), Height: number(scene.height, 3000, 1, 2e6),
    WallsCount: Array.isArray(scene.walls) ? scene.walls.length : 0,
    LightsCount: Array.isArray(scene.lights) ? scene.lights.length : 0,
    LevelsCount: Math.max(1, Array.isArray(scene.levels) ? scene.levels.length : 0),
    Active: scene.active === true, ModifiedAt: number(scene._stats?.modifiedTime, 0, 0, 1e16)
  };
}
function texture(source = {}) {
  return {
    AnchorX: number(source.anchorX, 0.5, -5, 5), AnchorY: number(source.anchorY, 0.5, -5, 5),
    OffsetX: number(source.offsetX), OffsetY: number(source.offsetY),
    ScaleX: number(source.scaleX, 1, -100, 100), ScaleY: number(source.scaleY, 1, -100, 100),
    Rotation: number(source.rotation), Fit: text(source.fit, 30) || 'fill'
  };
}
function level(source) {
  return { Id: source._id, Name: text(source.name, 160) || 'Livello', Sort: number(source.sort),
    Background: text(source.background?.src, 2e6), Foreground: text(source.foreground?.src, 2e6),
    BackgroundColor: text(source.background?.color, 30) || '#333333',
    BackgroundTint: text(source.background?.tint, 30) || '#ffffff', ForegroundTint: text(source.foreground?.tint, 30) || '#ffffff',
    Textures: texture(source.textures) };
}
function wall(source) {
  if (!Array.isArray(source.c) || source.c.length !== 4 || source.c.some(value => !Number.isFinite(value))) return null;
  return { Id: source._id, X1: number(source.c[0]), Y1: number(source.c[1]), X2: number(source.c[2]), Y2: number(source.c[3]),
    Door: number(source.door), DoorState: number(source.ds), Direction: number(source.dir),
    Light: number(source.light), Sight: number(source.sight), Move: number(source.move), Sound: number(source.sound), Levels: levels(source.levels) };
}
function light(source) {
  const config = source.config || {};
  return { Id: source._id, Name: text(source.name, 160), X: number(source.x), Y: number(source.y),
    Hidden: source.hidden === true, Rotation: number(source.rotation), Levels: levels(source.levels), Walls: source.walls !== false,
    Bright: number(config.bright, 0, 0, 1e6), Dim: number(config.dim, 0, 0, 1e6),
    Angle: number(config.angle, 360, 0, 360), Alpha: number(config.alpha, 0.5, 0, 1),
    Luminosity: number(config.luminosity, 0.5, -1, 1), Color: text(config.color, 30), Animation: text(config.animation?.type, 80) };
}
function tile(source) {
  const tex = source.texture || {};
  return { Id: source._id, X: number(source.x), Y: number(source.y), Width: number(source.width, 1, 1, 2e6), Height: number(source.height, 1, 1, 2e6),
    Rotation: number(source.rotation), Sort: number(source.sort), Elevation: number(source.elevation), Hidden: source.hidden === true,
    Levels: levels(source.levels), Src: text(tex.src, 2e6), Tint: text(tex.tint, 30) || '#ffffff', Alpha: number(source.alpha, 1, 0, 1),
    Textures: texture(tex) };
}

async function readSnapshot(directory, sceneId) {
  const marker = await assertSnapshot(directory);
  if (sceneId && !validId(sceneId)) throw new Error('Identificatore scena non valido.');
  // Never open the Foundry source directory: only the marked private copy reaches ClassicLevel.
  const db = new ClassicLevel(directory, { keyEncoding: 'utf8', valueEncoding: 'json', createIfMissing: false });
  await db.open();
  try {
    const source = db.sublevel('scenes', { valueEncoding: 'json' });
    if (!sceneId) {
      const scenes = [];
      for await (const [id, data] of source.iterator()) {
        if (validId(id) && data && validId(data._id) && data._id === id && !data._tombstone) scenes.push(summary(data));
        if (scenes.length > 10000) throw new Error('Il mondo contiene troppe scene per questa anteprima.');
      }
      return { Schema: 1, WorldId: marker.WorldId, CapturedAt: marker.CapturedAt, Scenes: scenes.sort((a, b) => a.Name.localeCompare(b.Name, 'it')) };
    }
    const data = await source.get(sceneId);
    if (!data || data._id !== sceneId || data._tombstone) throw new Error('La scena non è disponibile nella copia. Premi Aggiorna.');
    const warnings = [];
    const [sourceLevels, sourceWalls, sourceLights, sourceTiles] = await Promise.all(['levels', 'walls', 'lights', 'tiles'].map(name => expand(db, data, name, warnings)));
    const sceneLevels = sourceLevels.map(level).sort((a, b) => a.Sort - b.Sort);
    if (!sceneLevels.length) sceneLevels.push(level({ _id: 'legacy', name: 'Principale', background: { src: data.background?.src || data.img || '' } }));
    const walls = sourceWalls.map(wall).filter(Boolean);
    if (walls.length !== sourceWalls.length) warnings.push('Alcuni muri hanno coordinate non valide e non vengono mostrati.');
    return {
      ...summary(data), Schema: 1, InitialLevel: validId(data.initialLevel) && sceneLevels.some(value => value.Id === data.initialLevel) ? data.initialLevel : sceneLevels[0].Id,
      Padding: number(data.padding, 0.25, 0, 0.5), ShiftX: number(data.shiftX), ShiftY: number(data.shiftY),
      GridType: number(data.grid?.type, 1, 0, 5), GridSize: number(data.grid?.size, 100, 1, 10000),
      GridDistance: number(data.grid?.distance, 5, 0.001, 1e6), GridUnits: text(data.grid?.units, 40),
      Darkness: number(data.environment?.darknessLevel, 0, 0, 1),
      Levels: sceneLevels, Walls: walls, Lights: sourceLights.map(light), Tiles: sourceTiles.map(tile), Warnings: warnings
    };
  } finally { await db.close(); }
}

module.exports = { readSnapshot, assertSnapshot };
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const directory = value('--snapshot');
  if (!directory) { process.stderr.write('Manca la copia temporanea della scena.\n'); process.exitCode = 1; }
  else readSnapshot(path.resolve(directory), value('--scene')).then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { process.stderr.write(`Lettura scene non riuscita: ${error.message}\n`); process.exitCode = 1; });
}
