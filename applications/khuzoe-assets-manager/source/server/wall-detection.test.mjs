import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleWallDetection, WallDetectionStore, validateWallRequest, mapWallOutput, clipSegment, jpegSize } from './wall-detection.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const clone = value => value === undefined ? undefined : structuredClone(value);
class Storage {
  values = new Map(); alarm = null;
  async get(key) { return clone(this.values.get(key)); }
  async put(key, value) { assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024, 'Durable Object value over storage limit'); this.values.set(key, clone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)])); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(fn) { return fn(this); }
}
class Bucket {
  values = new Map();
  async put(key, value) { this.values.set(key, value); }
  async get(key) { const text = this.values.get(key); return text === undefined ? null : { json: async () => JSON.parse(text) }; }
  async delete(key) { this.values.delete(key); }
}
// Header fixture for metadata validation. Tests never submit images to a real provider.
function jpeg(width, height) { return 'data:image/jpeg;base64,' + Buffer.from([255,216,255,192,0,11,8,height >> 8,height & 255,width >> 8,width & 255,1,1,17,0,255,217]).toString('base64'); }
const frame = (x=0,y=0,width=100,height=100) => ({x,y,width,height});
function request(two=false) {
  const f = frame(-50,-20,200,100);
  return { id: crypto.randomUUID(), frame: f, tiles: two ? [{ frame: f, core: frame(-50,-20,100,100), width:200,height:100,image:jpeg(200,100) }, { frame:f,core:frame(50,-20,100,100),width:200,height:100,image:jpeg(200,100) }] : [{ frame:f,core:f,width:200,height:100,image:jpeg(200,100) }] };
}
function ai(paths=[{points:[{x:0,y:100},{x:1000,y:100}],uncertain:false}]) { return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({paths})}]}],usage:{input_tokens:500,output_tokens:100}}); }
function fixture() {
  const state={storage:new Storage()}, bucket=new Bucket(), calls=[];
  const env={MEDIA_BUCKET:bucket,OPENAI_API_KEY:'test-placeholder',ASSETS_WALL_MODEL:'test-vision',ASSETS_WALL_DETAIL:'high',wallFetch:async(url,init)=>{calls.push({url,init});return ai();}};
  const store=new WallDetectionStore(state,env);
  const send=async(action,body)=>{const response=await store.fetch(new Request('https://walls.internal/'+action,{method:'POST',body:JSON.stringify({...body,campaign:'test-campaign',account:'dm'})}));return {status:response.status,data:await response.json()};};
  return {state,bucket,env,store,send,calls};
}
test('metadata JPEG, request bounds and disjoint coverage',()=>{
  assert.deepEqual(jpegSize(Buffer.from(jpeg(200,100).split(',')[1],'base64')),{width:200,height:100});
  assert.equal(validateWallRequest(request(true)).tiles.length,2);
  const invalid=request(); invalid.tiles[0].width=201;assert.throws(()=>validateWallRequest(invalid));
  const duplicate=request(true);duplicate.tiles[1].core=duplicate.tiles[0].core;assert.throws(()=>validateWallRequest(duplicate));
  const hole=request();hole.tiles[0].core={...hole.tiles[0].core,width:90};assert.throws(()=>validateWallRequest(hole));
  const bad=request();bad.frame.x=NaN;assert.throws(()=>validateWallRequest(bad));
});
test('normalized paths map to negative scene coordinates and clip only to their core',()=>{
  const r=request(true), paths={paths:[{points:[{x:0,y:500},{x:1000,y:500}],uncertain:true}]};
  assert.deepEqual(mapWallOutput(paths,r.tiles[0]),[{x1:-50,y1:30,x2:50,y2:30,uncertain:true}]);
  assert.deepEqual(mapWallOutput(paths,r.tiles[1]),[{x1:50,y1:30,x2:150,y2:30,uncertain:true}]);
  assert.equal(clipSegment([-20,-20,-10,-10],frame()),null);
  const clipped=mapWallOutput({paths:[{points:[{x:0,y:0},{x:1001,y:2}],uncertain:false}]},r.tiles[0]);assert.equal(clipped.length,1);assert.equal(clipped[0].uncertain,true);
});
test('DM authentication and capabilities do not call the provider',async()=>{
  const services={requireUser:async()=>({id:'dm'}),isEditor:async()=>false,accountId:()=> 'dm'};
  let response=await handleWallDetection(new Request('https://site/api/assets/walls'),{},'campaign',{},services);assert.equal(response.status,403);
  services.isEditor=async()=>true; response=await handleWallDetection(new Request('https://site/api/assets/walls'),{},'campaign',{},services);assert.equal((await response.json()).enabled,false);
  services.requireUser=async()=>new Response('',{status:401});response=await handleWallDetection(new Request('https://site/api/assets/walls'),{},'campaign',{},services);assert.equal(response.status,401);
});
test('create is idempotent and polling never starts paid work',async()=>{
  const f=fixture(), r=request();
  assert.equal((await f.send('create',r)).status,202);
  assert.equal((await f.send('create',r)).data.job.status,'pending');
  for(let i=0;i<3;i++)await f.send('get',{id:r.id});assert.equal(f.calls.length,0);
  const conflict=structuredClone(r);conflict.tiles[0].image=jpeg(200,100)+'A';assert.equal((await f.send('create',conflict)).status,409);
  const next=request();assert.equal((await f.send('create',next)).status,409);
});
test('complete job uses server model, counts tokens, deletes raw inputs and preserves gaps',async()=>{
  const f=fixture(), r=request(true);await f.send('create',r);
  await f.store.alarm();assert.equal((await f.send('get',{id:r.id})).data.job.completed,1);
  await f.store.alarm();const job=(await f.send('get',{id:r.id})).data.job;
  assert.equal(job.status,'ready');assert.equal(job.inputTokens,1000);assert.equal(job.outputTokens,200);assert.equal(job.walls.length,2);assert.equal(f.bucket.values.size,0);
  const body=JSON.parse(f.calls[0].init.body);assert.equal(body.model,'test-vision');assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.input[1].content[0].detail,'high');
  await f.store.alarm();await f.send('create',r);assert.equal(f.calls.length,2);
});
test('provider failure and Durable Object restart never repeat a paid attempt',async()=>{
  const f=fixture(),r=request();await f.send('create',r);f.env.wallFetch=async()=>{f.calls.push({});return new Response('',{status:503});};
  await f.store.alarm();await f.store.alarm();assert.equal(f.calls.length,1);assert.equal((await f.send('get',{id:r.id})).data.job.status,'uncertain');assert.equal(f.bucket.values.size,0);
  const other=fixture(),s=request();await other.send('create',s);let job=await other.state.storage.get('job:'+s.id);job.status='running';await other.state.storage.put('job:'+s.id,job);await other.store.alarm();assert.equal(other.calls.length,0);assert.equal((await other.send('get',{id:s.id})).data.job.status,'uncertain');
});
test('stop between tiles prevents further calls and keeps partial walls',async()=>{
  const f=fixture(),r=request(true);await f.send('create',r);await f.store.alarm();await f.send('stop',{id:r.id});await f.store.alarm();
  const job=(await f.send('get',{id:r.id})).data.job;assert.equal(job.status,'stopped');assert.equal(job.completed,1);assert.equal(job.walls.length,1);assert.equal(f.calls.length,1);assert.equal(f.bucket.values.size,0);
});
test('stop while provider runs wins over a late response',async()=>{
  const f=fixture(),r=request();await f.send('create',r);let release,entered;
  const started=new Promise(resolve=>entered=resolve);f.env.wallFetch=()=>{entered();return new Promise(resolve=>release=resolve);};
  const run=f.store.alarm();await started;await f.send('stop',{id:r.id});release(ai());await run;const job=(await f.send('get',{id:r.id})).data.job;assert.equal(job.status,'stopped');assert.equal(job.completed,0);
});
test('model refusal stops processing and invalid coordinates produce a partial result',async()=>{
  for(const [response,status] of [[Response.json({status:'completed',output:[{content:[{type:'refusal'}]}]}),'uncertain'],[ai([{points:[{x:0,y:0},{x:5000,y:2}],uncertain:false}]),'partial']]){
    const f=fixture(),r=request();await f.send('create',r);f.env.wallFetch=async()=>response;await f.store.alarm();const job=(await f.send('get',{id:r.id})).data.job;assert.equal(job.status,status);assert.equal(job.walls.length,0);
  }
});
test('large geometric results are split below individual storage limits',async()=>{
  const f=fixture(),r=request();await f.send('create',r);f.env.wallFetch=async()=>ai(Array.from({length:500},()=>({points:[{x:0,y:1},{x:100,y:2},{x:200,y:3},{x:300,y:4},{x:400,y:5}],uncertain:true})));
  await f.store.alarm();assert.equal((await f.send('get',{id:r.id})).data.job.walls.length,2000);
});
test('expiry removes input and result data without a new model call',async()=>{
  const f=fixture(),r=request();await f.send('create',r);await f.store.alarm();const job=await f.state.storage.get('job:'+r.id);job.createdAt=Date.now()-8*86400000;await f.state.storage.put('job:'+r.id,job);await f.store.alarm();assert.equal((await f.send('get',{id:r.id})).status,404);assert.equal(f.state.storage.values.size,0);assert.equal(f.calls.length,1);
});

test('small edge overshoots are clipped as segments, never clamped into invented boundary walls',()=>{
  const tile=request().tiles[0], diagnostics={};
  const walls=mapWallOutput({paths:[{points:[{x:-1,y:100},{x:1001,y:900}],uncertain:false}]},tile,diagnostics);
  assert.equal(walls.length,1);assert.equal(walls[0].x1,-50);assert.equal(walls[0].x2,150);assert.equal(walls[0].uncertain,true);
  assert.ok(walls[0].y1>-10 && walls[0].y2<70);assert.equal(diagnostics.clippedSegments,1);assert.equal(diagnostics.discardedSegments,0);
  const outside=mapWallOutput({paths:[{points:[{x:-2,y:0},{x:-1,y:1000}],uncertain:false}]},tile);
  assert.equal(outside.length,0);
});
test('invalid vertices break only incident segments without bridging the gap or guessing coordinate scale',()=>{
  for(const bad of [{x:5000,y:500},{x:'200',y:500},{x:200,y:null},{x:Infinity,y:500},null]){
    const d={},walls=mapWallOutput({paths:[{points:[{x:0,y:500},{x:100,y:500},bad,{x:300,y:500},{x:400,y:500}],uncertain:false}]},request().tiles[0],d);
    assert.equal(walls.length,2);assert.equal(d.discardedSegments,2);assert.equal(walls[0].x2,-30);assert.equal(walls[1].x1,10);
    assert.ok(walls.every(wall=>wall.uncertain),'fragments of an invalid path must remain visibly uncertain');
    assert.ok(!walls.some(w=>w.x1===-30&&w.x2===10),'invalid point bridged a doorway');
  }
});
test('one malformed path does not discard valid sibling paths',()=>{
  const d={},walls=mapWallOutput({paths:[null,{points:'wrong',uncertain:false},{points:[{x:0,y:0},{x:100,y:0}],uncertain:false}]},request().tiles[0],d);
  assert.equal(walls.length,1);assert.equal(d.discardedPaths,2);
});
test('the ninth malformed tile does not stop a 24 tile map, repeat paid work or lose the first eight results',async()=>{
  const f=fixture(),r=request();r.tiles=[];
  for(let row=0;row<4;row++)for(let col=0;col<6;col++)r.tiles.push({frame:r.frame,core:frame(-50+col*200/6,-20+row*25,200/6,25),width:200,height:100,image:jpeg(200,100)});
  let calls=0;f.env.wallFetch=async()=>{calls++;return calls===9?ai([{points:[{x:0,y:0},{x:5000,y:2}],uncertain:false}]):ai();};
  await f.send('create',r);
  for(let i=0;i<8;i++)await f.store.alarm();
  assert.equal((await f.send('get',{id:r.id})).data.job.completed,8);
  await f.store.alarm();assert.equal((await f.send('get',{id:r.id})).data.job.status,'pending');
  for(let i=9;i<24;i++)await f.store.alarm();
  const job=(await f.send('get',{id:r.id})).data.job;
  assert.equal(job.completed,24);assert.equal(job.status,'partial');assert.equal(job.skippedTiles,1);assert.equal(job.discardedSegments,1);assert.equal(job.walls.length,6);
  assert.equal(job.inputTokens,24*500);assert.equal(job.outputTokens,24*100);assert.equal(calls,24);assert.match(job.error,/24\/24/);assert.equal(f.bucket.values.size,0);
  await f.send('get',{id:r.id});await f.send('create',r);await f.store.alarm();assert.equal(calls,24);
});
test('completed but unparseable geometry counts tokens and allows the next tile to run once',async()=>{
  for(const text of ['{',JSON.stringify({paths:'wrong'})]){
    const f=fixture(),r=request(true);let calls=0;
    f.env.wallFetch=async()=>{calls++;return calls===1?Response.json({status:'completed',output:[{content:[{type:'output_text',text}]}],usage:{input_tokens:411,output_tokens:99}}):ai();};
    await f.send('create',r);await f.store.alarm();await f.store.alarm();const job=(await f.send('get',{id:r.id})).data.job;
    assert.equal(job.status,'partial');assert.equal(job.completed,2);assert.equal(job.skippedTiles,1);assert.equal(job.inputTokens,911);assert.equal(job.outputTokens,199);assert.equal(job.walls.length,1);assert.equal(calls,2);
  }
});
test('the provider schema explicitly bounds normalized coordinates and polyline sizes',async()=>{
  const f=fixture(),r=request();await f.send('create',r);await f.store.alarm();const body=JSON.parse(f.calls[0].init.body),paths=body.text.format.schema.properties.paths,points=paths.items.properties.points;
  assert.equal(paths.maxItems,500);assert.equal(points.minItems,2);assert.equal(points.maxItems,256);
  for(const axis of ['x','y'])assert.deepEqual(points.items.properties[axis],{type:'number',minimum:0,maximum:1000});
  assert.match(body.input[0].content,/Never return source pixels/);
});
test('a partial result still stops on an ambiguous subsequent provider failure without retrying',async()=>{
  const f=fixture(),r=request(true);let calls=0;
  f.env.wallFetch=async()=>{calls++;return calls===1?ai([{points:[{x:0,y:0},{x:5000,y:2}],uncertain:false}]):new Response('',{status:503});};
  await f.send('create',r);await f.store.alarm();await f.store.alarm();await f.store.alarm();
  const job=(await f.send('get',{id:r.id})).data.job;assert.equal(job.status,'uncertain');assert.equal(job.completed,1);assert.equal(job.skippedTiles,1);assert.equal(calls,2);assert.equal(job.inputTokens,500);
});
