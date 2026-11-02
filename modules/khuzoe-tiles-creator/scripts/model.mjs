// Shared, side-effect-free contract used by Foundry and the Worker.
export const MODULE_ID = 'khuzoe-tiles-creator';
export const VERSION = 1;
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_RESULT_BYTES = 12 * 1024 * 1024;
export const MAX_REFERENCES = 15;
export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 6 * 1024 * 1024;
export const MAX_REFERENCE_EDGE = 1536;
export const MAX_REQUEST_BYTES = Math.ceil((MAX_SOURCE_BYTES + MAX_REFERENCE_TOTAL_BYTES) / 3) * 4 + 30000;
export const ACTIVE_STATUSES = ['pending', 'running'];
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || '');
export function rect(value) {
  if (!value || !['x','y','width','height'].every(k => Number.isSafeInteger(value[k]))) throw new Error('Area non valida.');
  if (Math.abs(value.x)>1000000 || Math.abs(value.y)>1000000 || value.width<32 || value.height<32 || value.width>30000 || value.height>30000) throw new Error('Seleziona un’area tra 32 e 30.000 pixel di scena per lato.');
  return Object.fromEntries(['x','y','width','height'].map(k=>[k,value[k]]));
}
export function options(value = {}) {
  const result = {quality:value.quality ?? 'medium',resolution:value.resolution ?? 'medium',feather:value.feather ?? 12};
  if (!['medium','high'].includes(result.quality) || !['medium','high'].includes(result.resolution) || ![0,8,12,24].includes(result.feather)) throw new Error('Impostazioni immagine non valide.');
  return result;
}
export function outputSize(width,height,resolution='medium') {
  const ratio=width/height;
  if (ratio>3 || ratio<1/3) throw new Error('Seleziona un’area meno allungata: il rapporto massimo è 3:1.');
  const pixels=resolution==='high'?2359296:1048576;
  let w=Math.ceil(Math.sqrt(pixels*ratio)/16)*16,h=Math.ceil(Math.sqrt(pixels/ratio)/16)*16;
  if(w>h*3)h=Math.ceil(w/3/16)*16;if(h>w*3)w=Math.ceil(h/3/16)*16;
  return {width:w,height:h};
}
export function planCapture(area,sceneRect,resolution='medium') {
  const target=rect(area), s=sceneRect;
  if(target.x<s.x || target.y<s.y || target.x+target.width>s.x+s.width || target.y+target.height>s.y+s.height) throw new Error('Seleziona un’area all’interno della mappa.');
  const padding=Math.min(64,Math.round(Math.min(target.width,target.height)*0.08));
  const left=Math.max(s.x,target.x-padding),top=Math.max(s.y,target.y-padding);
  const right=Math.min(s.x+s.width,target.x+target.width+padding),bottom=Math.min(s.y+s.height,target.y+target.height+padding);
  const frame=rect({x:Math.round(left),y:Math.round(top),width:Math.round(right-left),height:Math.round(bottom-top)});
  return {target,frame,...outputSize(frame.width,frame.height,resolution)};
}
export function validateCapture(value,settings) {
  if(!value || value.version!==VERSION) throw new Error('Formato della cattura non supportato.');
  const target=rect(value.target),frame=rect(value.frame),size=outputSize(frame.width,frame.height,settings.resolution);
  if(value.width!==size.width || value.height!==size.height || target.x<frame.x || target.y<frame.y || target.x+target.width>frame.x+frame.width || target.y+target.height>frame.y+frame.height || frame.width-target.width>128 || frame.height-target.height>128) throw new Error('Dimensioni della cattura non coerenti.');
  if(!Number.isFinite(value.elevation)||Math.abs(value.elevation)>1000000 || !Number.isSafeInteger(value.sort) || Math.abs(value.sort)>2000000000)throw new Error('Livello del tile non valido.');
  if(!/^[a-f0-9]{64}$/.test(value.sceneFingerprint||''))throw new Error('Identità della cattura mancante.');
  return {version:VERSION,target,frame,...size,elevation:value.elevation,sort:value.sort,sceneFingerprint:value.sceneFingerprint};
}
export function sourceCrop(capture) {
  return {x:(capture.target.x-capture.frame.x)*capture.width/capture.frame.width,y:(capture.target.y-capture.frame.y)*capture.height/capture.frame.height,width:capture.target.width*capture.width/capture.frame.width,height:capture.target.height*capture.height/capture.frame.height};
}
export function tileData(job,path) {
  if(!uuid(job?.id) || !/^khuzoe-tiles\/[a-z0-9_-]+\/[a-f0-9-]+\.webp$/i.test(path))throw new Error('Immagine del tile non valida.');
  const area=rect(job.capture.target);
  return {name:'Tile AI',...area,texture:{src:path,anchorX:0,anchorY:0,fit:'fill',scaleX:1,scaleY:1},rotation:0,alpha:1,hidden:false,locked:true,elevation:job.capture.elevation,sort:job.capture.sort,levels:[job.context.levelId],flags:{[MODULE_ID]:{generationId:job.id,version:VERSION}}};
}
export function placedTileMatches(job,tile){
  if(!tile||tile.flags?.[MODULE_ID]?.generationId!==job.id)return false;
  const expected=tileData(job,`khuzoe-tiles/${job.context.worldId}/${job.id}.webp`),texture=tile.texture||{};
  const levels=Array.from(tile.levels||[]);
  return ['x','y','width','height','rotation','alpha','elevation','sort'].every(k=>Number(tile[k])===Number(expected[k]))
    &&!tile.hidden&&levels.length===1&&levels[0]===job.context.levelId
    &&texture.src===expected.texture.src&&texture.anchorX===0&&texture.anchorY===0
    &&(texture.fit??'fill')==='fill'&&(texture.scaleX??1)===1&&(texture.scaleY??1)===1
    &&Number(texture.tint??0xffffff)===0xffffff;
}
export function contextKey(context) { return JSON.stringify([context.campaignId,context.worldId,context.sceneId,context.levelId]); }
