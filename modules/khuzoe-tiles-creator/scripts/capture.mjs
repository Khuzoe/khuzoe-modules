import {MODULE_ID,MAX_SOURCE_BYTES,VERSION,planCapture,sourceCrop} from './model.mjs';

const hasImage=source=>typeof source==='string'&&source.trim().length>0;

export function mapLayers(scene,{excludeGenerationId}={}){
  // Like Scene#createThumbnail in v14, compose detached sprites. Never render
  // canvas.stage: that would capture tokens, fog, lights and selection handles.
  const center=scene.dimensions.sceneRect.center||{x:scene.dimensions.sceneRect.x+scene.dimensions.sceneRect.width/2,y:scene.dimensions.sceneRect.y+scene.dimensions.sceneRect.height/2};
  const sceneLayer=foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.SCENE,tilesLayer=foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.TILES;
  // The viewed level includes a foreground entry even when no image is set.
  // Its background color is already drawn by the fill; only load real textures.
  const backgrounds=scene._configureLevelTextures().filter(lt=>hasImage(lt.src)).map(lt=>({...lt,...lt.level.textures,x:center.x,y:center.y,width:scene.dimensions.sceneRect.width,height:scene.dimensions.sceneRect.height,sortLayer:sceneLayer,zIndex:-Infinity,alpha:lt.alpha??1}));
  const tiles=Array.from(scene.tiles).filter(t=>hasImage(t.texture?.src)&&!t.hidden&&t.viewed!==false&&(!excludeGenerationId||t.flags?.[MODULE_ID]?.generationId!==excludeGenerationId)).map(t=>({...t.texture,x:t.x,y:t.y,width:t.width,height:t.height,rotation:t.rotation,elevation:t.elevation,sort:t.sort,alpha:t.alpha,sortLayer:tilesLayer,zIndex:0,id:t.id}));
  return [...backgrounds,...tiles].sort(foundry.canvas.groups.PrimaryCanvasGroup._compareObjects);
}
export async function sceneFingerprint(scene,options){
  const fields=['id','src','x','y','width','height','rotation','elevation','sort','sortLayer','zIndex','alpha','tint','anchorX','anchorY','offsetX','offsetY','fit','scaleX','scaleY'];
  const value=JSON.stringify([scene.backgroundColor,mapLayers(scene,options).map(layer=>Object.fromEntries(fields.map(k=>[k,layer[k]])))]);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function captureArea(area,settings){
  if(!canvas.ready||!canvas.scene)throw new Error('Apri una scena prima di selezionare l’area.');
  const scene=canvas.scene,levelId=canvas.level?.id||scene._view,plan=planCapture(area,scene.dimensions.sceneRect,settings.resolution);
  const fingerprint=await sceneFingerprint(scene),layers=mapLayers(scene),stage=new PIXI.Container();let texture;
  const visibleTiles=[];
  try{
    const fill=new PIXI.Graphics();fill.beginFill(Number(scene.backgroundColor??0x101012)).drawRect(plan.frame.x,plan.frame.y,plan.frame.width,plan.frame.height).endFill();stage.addChild(fill);
    for(const layer of layers){
      const image=await foundry.canvas.loadTexture(layer.src);
      if(canvas.scene!==scene||(canvas.level?.id||scene._view)!==levelId)throw new Error('La scena è cambiata durante la cattura.');
      if(!image||image.baseTexture?.resource?.source instanceof HTMLVideoElement)throw new Error('La prima versione richiede sfondo e tile statici.');
      const sprite=new PIXI.Sprite(image);sprite.anchor.set(layer.anchorX??0.5,layer.anchorY??0.5);sprite.position.set(layer.x+(layer.offsetX||0),layer.y+(layer.offsetY||0));
      foundry.canvas.primary.PrimarySpriteMesh.prototype.resize.call(sprite,layer.width,layer.height,{fit:layer.fit||'fill',scaleX:layer.scaleX??1,scaleY:layer.scaleY??1});
      sprite.angle=layer.rotation||0;sprite.alpha=layer.alpha??1;if(layer.tint!=null)sprite.tint=layer.tint;
      stage.addChild(sprite);
      if(layer.id){const bounds=sprite.getBounds();if(bounds.x<plan.frame.x+plan.frame.width&&bounds.y<plan.frame.y+plan.frame.height&&bounds.x+bounds.width>plan.frame.x&&bounds.y+bounds.height>plan.frame.y)visibleTiles.push(layer);}
    }
    // A private render texture bounds the capture even for partially intersecting tiles.
    stage.scale.set(plan.width/plan.frame.width,plan.height/plan.frame.height);
    stage.position.set(-plan.frame.x*stage.scale.x,-plan.frame.y*stage.scale.y);
    texture=PIXI.RenderTexture.create({width:plan.width,height:plan.height,resolution:1});
    canvas.app.renderer.render(stage,{renderTexture:texture,clear:true});
    const result=canvas.app.renderer.extract.canvas(texture),blob=await new Promise(resolve=>result.toBlob(resolve,'image/webp',0.94));
    if(!blob||blob.size>MAX_SOURCE_BYTES)throw new Error('La cattura è troppo grande. Seleziona un’area più piccola.');
    const elevation=Math.max(Number(canvas.level?.elevation?.bottom??canvas.level?.elevation??0)||0,...visibleTiles.map(t=>t.elevation||0));
    const sort=Math.min(2000000000,Math.max(0,...visibleTiles.filter(t=>(t.elevation||0)===elevation).map(t=>t.sort||0))+1000);
    if(await sceneFingerprint(scene)!==fingerprint)throw new Error('La mappa o i tile sono cambiati durante la cattura. Seleziona di nuovo l’area.');
    return {blob,capture:{version:VERSION,...plan,elevation,sort,sceneFingerprint:fingerprint},tiles:visibleTiles.length};
  }finally{texture?.destroy(true);stage.destroy({children:true,texture:false,baseTexture:false});}
}
export async function composeTile(sourceBlob,generatedBlob,capture,feather=12){
  const [source,generated]=await Promise.all([createImageBitmap(sourceBlob),createImageBitmap(generatedBlob)]);
  try{
    if(source.width!==capture.width||source.height!==capture.height||generated.width!==capture.width||generated.height!==capture.height)throw new Error('Le dimensioni dell’anteprima non coincidono con la cattura.');
    const crop=sourceCrop(capture),width=Math.max(1,Math.round(crop.width)),height=Math.max(1,Math.round(crop.height));
    const result=document.createElement('canvas');result.width=width;result.height=height;const ctx=result.getContext('2d');
    ctx.drawImage(source,crop.x,crop.y,crop.width,crop.height,0,0,width,height);
    const overlay=document.createElement('canvas');overlay.width=width;overlay.height=height;const o=overlay.getContext('2d');
    o.drawImage(generated,crop.x,crop.y,crop.width,crop.height,0,0,width,height);
    const edge=Math.min(feather,Math.floor(Math.min(width,height)/4));
    if(edge>0){
      o.globalCompositeOperation='destination-in';
      const horizontal=o.createLinearGradient(0,0,width,0);horizontal.addColorStop(0,'transparent');horizontal.addColorStop(edge/width,'white');horizontal.addColorStop(1-edge/width,'white');horizontal.addColorStop(1,'transparent');o.fillStyle=horizontal;o.fillRect(0,0,width,height);
      const vertical=o.createLinearGradient(0,0,0,height);vertical.addColorStop(0,'transparent');vertical.addColorStop(edge/height,'white');vertical.addColorStop(1-edge/height,'white');vertical.addColorStop(1,'transparent');o.fillStyle=vertical;o.fillRect(0,0,width,height);
    }
    ctx.drawImage(overlay,0,0);
    const blob=await new Promise(resolve=>result.toBlob(resolve,'image/webp',0.96));if(!blob)throw new Error('Impossibile preparare il tile.');return blob;
  }finally{source.close();generated.close();}
}

export async function resizeInput(sourceBlob,size){
  const source=await createImageBitmap(sourceBlob);
  try{
    const output=document.createElement('canvas');output.width=size.width;output.height=size.height;
    output.getContext('2d').drawImage(source,0,0,size.width,size.height);
    const blob=await new Promise(resolve=>output.toBlob(resolve,'image/webp',0.98));
    if(!blob||blob.size>MAX_SOURCE_BYTES)throw new Error('L’immagine di partenza è troppo grande. Scegli una risoluzione inferiore.');
    return blob;
  }finally{source.close();}
}

export async function resultAsInput(sourceBlob,tileBlob,capture){
  const [source,tile]=await Promise.all([createImageBitmap(sourceBlob),createImageBitmap(tileBlob)]);
  try{
    const crop=sourceCrop(capture);
    if(source.width!==capture.width||source.height!==capture.height||tile.width!==Math.round(crop.width)||tile.height!==Math.round(crop.height))throw new Error('L’anteprima non corrisponde all’area selezionata.');
    // Keep the original context margin and replace only the authorized crop
    // with the exact preview shown to the DM, including its current feathering.
    const output=document.createElement('canvas');output.width=capture.width;output.height=capture.height;const ctx=output.getContext('2d');
    ctx.drawImage(source,0,0);ctx.drawImage(tile,crop.x,crop.y,crop.width,crop.height);
    const blob=await new Promise(resolve=>output.toBlob(resolve,'image/webp',0.98));
    if(!blob||blob.size>MAX_SOURCE_BYTES)throw new Error('L’immagine di partenza è troppo grande. Scegli una risoluzione inferiore.');
    return blob;
  }finally{source.close();tile.close();}
}

// This overlay listens only on the canvas DOM element. It does not change a
// Foundry layer, camera position, canvas visibility, or any Scene Document.
let cancelCurrentSelection;
export function cancelSelection(){cancelCurrentSelection?.();}
export function selectArea(){
  cancelSelection();
  const view=canvas.app?.view||canvas.app?.canvas;if(!view||!canvas.ready)return Promise.reject(new Error('Apri una scena.'));
  const sceneId=canvas.scene.id;
  return new Promise((resolve,reject)=>{
    let start,end;const abort=new AbortController(),overlay=document.createElement('div'),hint=document.createElement('div');
    overlay.className='ktc-selection';hint.className='ktc-selection-hint';hint.textContent='Trascina un rettangolo · Esc per annullare';document.body.append(overlay,hint);
    const cleanup=()=>{abort.abort();overlay.remove();hint.remove();view.classList.remove('ktc-selecting');cancelCurrentSelection=null;};
    const point=event=>canvas.stage.toLocal(new PIXI.Point(event.clientX-view.getBoundingClientRect().left,event.clientY-view.getBoundingClientRect().top));
    const cancel=()=>{cleanup();reject(new Error('Selezione annullata.'));};
    cancelCurrentSelection=cancel;
    const down=event=>{if(event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();start={point:point(event),x:event.clientX,y:event.clientY};view.setPointerCapture?.(event.pointerId);};
    const move=event=>{if(!start)return;event.preventDefault();event.stopImmediatePropagation();end={point:point(event),x:event.clientX,y:event.clientY};Object.assign(overlay.style,{display:'block',left:`${Math.min(start.x,end.x)}px`,top:`${Math.min(start.y,end.y)}px`,width:`${Math.abs(end.x-start.x)}px`,height:`${Math.abs(end.y-start.y)}px`});};
    const up=event=>{if(!start)return;event.preventDefault();event.stopImmediatePropagation();end={point:point(event)};view.releasePointerCapture?.(event.pointerId);const area={x:Math.round(Math.min(start.point.x,end.point.x)),y:Math.round(Math.min(start.point.y,end.point.y)),width:Math.round(Math.abs(end.point.x-start.point.x)),height:Math.round(Math.abs(end.point.y-start.point.y))};cleanup();if(canvas.scene?.id!==sceneId)reject(new Error('La scena è cambiata.'));else resolve(area);};
    const opts={capture:true,signal:abort.signal};view.classList.add('ktc-selecting');view.addEventListener('pointerdown',down,opts);view.addEventListener('pointermove',move,opts);view.addEventListener('pointerup',up,opts);view.addEventListener('pointercancel',cancel,opts);view.addEventListener('wheel',event=>{event.preventDefault();event.stopImmediatePropagation();},{...opts,passive:false});document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancel();}},opts);
  });
}
