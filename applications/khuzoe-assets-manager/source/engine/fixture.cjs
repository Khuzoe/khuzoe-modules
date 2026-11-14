'use strict';
// Development fixtures only. This writer is never shipped in the scene-reader runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { ClassicLevel } = require('classic-level');
const rootFlag = process.argv.indexOf('--root');
const root = path.resolve(process.argv[rootFlag + 1] || '');
const allowed = path.resolve(__dirname, '..', 'build') + path.sep;
if (rootFlag < 0 || !root.startsWith(allowed)) throw new Error('Fixture path must be inside this project build directory.');

(async () => {
  const world = path.join(root, 'worlds', 'assets-fixture');
  const source = path.join(world, 'data', 'scenes');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(root, 'modules'), { recursive: true });
  await fs.mkdir(path.join(root, 'systems'), { recursive: true });
  await fs.writeFile(path.join(world, 'world.json'), JSON.stringify({ id: 'assets-fixture', title: 'Campagna di prova', system: 'dnd5e', coreVersion: '14.367' }));
  const db = new ClassicLevel(source, { valueEncoding: 'json' }); await db.open();
  const scenes = db.sublevel('scenes', { valueEncoding: 'json' });
  await scenes.put('scene00000000001', { _id: 'scene00000000001', name: 'La cittadella', width: 1600, height: 1200, padding: 0.25, grid: { type: 1, size: 100, distance: 5, units: 'm' },
    initialLevel: 'level00000000001', levels: ['level00000000001', 'level00000000002'],
    walls: ['wall000000000001', 'wall000000000002', 'wall000000000003', 'wall000000000004', 'wall000000000005', 'wall000000000006'],
    lights: ['light00000000001', 'light00000000002', 'light00000000003'], tiles: [] });
  const levelStore = db.sublevel('scenes.levels', { valueEncoding: 'json' });
  await levelStore.put('scene00000000001.level00000000001', { _id: 'level00000000001', name: 'Piano terra', sort: 0, background: { src: 'maps/fixture.png', color: '#333333' }, textures: {} });
  await levelStore.put('scene00000000001.level00000000002', { _id: 'level00000000002', name: 'Piano superiore', sort: 1, background: { src: 'maps/fixture.png' }, textures: {} });
  const walls = db.sublevel('scenes.walls', { valueEncoding: 'json' });
  const coordinates = [[500,400,1800,400], [1800,400,1800,1400], [1800,1400,500,1400], [500,1400,500,400], [1100,400,1100,800], [1100,800,1100,1000]];
  for (let i=0;i<coordinates.length;i++) {
    const id = `wall00000000000${i+1}`;
    await walls.put(`scene00000000001.${id}`, { _id:id, c:coordinates[i], door:i===5?1:0, ds:0, light:20, sight:20, move:1, sound:20, levels:['level00000000001'] });
  }
  const lights = db.sublevel('scenes.lights', { valueEncoding: 'json' });
  for (const [i,x,y,hidden] of [[1,700,600,false],[2,1500,1150,false],[3,1500,600,true]]) {
    const id=`light0000000000${i}`;
    await lights.put(`scene00000000001.${id}`, {_id:id,name:`Torcia ${i}`,x,y,hidden,levels:['level00000000001'],config:{bright:8,dim:16,color:i===2?'#88bbff':'#ffaa33',angle:360}});
  }
  const add = async () => scenes.put('scene00000000002', { _id:'scene00000000002', name:'Il sentiero', width:1200,height:800,padding:0,grid:{type:1,size:100,distance:5},levels:[],walls:[],lights:[],tiles:[] });
  if (process.argv.includes('--hold')) {
    process.stdout.write('READY\n');
    for await (const line of readline.createInterface({ input:process.stdin })) {
      if (line.trim()==='add') { await add(); process.stdout.write('UPDATED\n'); }
      if (line.trim()==='exit') break;
    }
  } else { await add(); process.stdout.write('FIXTURE READY\n'); }
  await db.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
