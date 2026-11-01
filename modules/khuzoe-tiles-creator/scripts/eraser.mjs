const makeCanvas=(width,height)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;};
const encode=(canvas,type)=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Impossibile preparare l’immagine con trasparenza.')),type,0.98));
export function brushPoint(event,bounds,width,height){
  if(!bounds.width||!bounds.height)throw new Error('L’anteprima non è ancora visibile.');
  return {x:Math.max(0,Math.min(width,(event.clientX-bounds.left)*width/bounds.width)),y:Math.max(0,Math.min(height,(event.clientY-bounds.top)*height/bounds.height))};
}
export function drawErasure(ctx,stroke){
  if(!stroke.points.length)return;
  ctx.save();ctx.globalCompositeOperation='destination-out';ctx.fillStyle='#fff';ctx.strokeStyle='#fff';ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=stroke.size;
  if(stroke.points.length===1){const p=stroke.points[0];ctx.beginPath();ctx.arc(p.x,p.y,stroke.size/2,0,Math.PI*2);ctx.fill();}
  else{ctx.beginPath();ctx.moveTo(stroke.points[0].x,stroke.points[0].y);for(const p of stroke.points.slice(1))ctx.lineTo(p.x,p.y);ctx.stroke();}
  ctx.restore();
}
export async function applyEraseMask(blob,mask){
  if(!mask)return blob;
  const [image,alpha]=await Promise.all([createImageBitmap(blob),createImageBitmap(mask)]);
  try{
    if(image.width!==alpha.width||image.height!==alpha.height)throw new Error('La gomma non corrisponde alle dimensioni dell’anteprima.');
    const canvas=makeCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);ctx.globalCompositeOperation='destination-in';ctx.drawImage(alpha,0,0);return await encode(canvas,'image/webp');
  }finally{image.close();alpha.close();}
}
export async function resizeEraseMask(blob,size){
  const image=await createImageBitmap(blob);
  try{if(image.width===size.width&&image.height===size.height)return blob;const canvas=makeCanvas(size.width,size.height);canvas.getContext('2d').drawImage(image,0,0,size.width,size.height);return await encode(canvas,'image/png');}finally{image.close();}
}

// The image and alpha mask stay in this browser. Stroke history stores points,
// not a full-resolution image snapshot for every pointer movement.
export async function openEraser({blob,mask,brushSize=48,signal}){
  const image=await createImageBitmap(blob);let initial;
  try{if(mask)initial=await createImageBitmap(mask);}catch(error){image.close();throw error;}
  if(initial&&(initial.width!==image.width||initial.height!==image.height)){image.close();initial.close();throw new Error('La gomma salvata non corrisponde all’anteprima.');}
  if(signal?.aborted){image.close();initial?.close();return null;}
  const dialog=document.createElement('dialog');dialog.className='ktc-eraser';dialog.setAttribute('aria-labelledby','ktc-eraser-title');
  dialog.innerHTML=`<header><div><small>RITOCCO LOCALE</small><h2 id="ktc-eraser-title">Gomma del tile</h2><p>Le parti cancellate diventano trasparenti e lasciano vedere la mappa sottostante.</p></div><button type="button" data-close aria-label="Chiudi gomma">×</button></header>
    <div class="ktc-eraser-toolbar"><label for="ktc-eraser-size">Dimensione pennello</label><input id="ktc-eraser-size" type="range" min="4" max="300" step="2" value="48"><input data-size-number type="number" min="4" max="300" step="2" value="48" aria-label="Dimensione pennello in pixel"><span>px</span><div><button type="button" data-undo disabled>Annulla tratto</button><button type="button" data-redo disabled>Rifai</button><button type="button" data-reset>Ripristina tutto</button></div></div>
    <div class="ktc-eraser-workspace"><div class="ktc-eraser-cursor" hidden></div></div>
    <p class="ktc-eraser-error" role="alert" hidden></p><footer><span>Il motivo a scacchi indica la trasparenza. Nessuna nuova chiamata AI.</span><div><button type="button" data-cancel>Annulla</button><button type="button" data-apply>Applica gomma</button></div></footer>`;
  const preview=makeCanvas(image.width,image.height),alpha=makeCanvas(image.width,image.height),ctx=preview.getContext('2d'),a=alpha.getContext('2d');
  preview.setAttribute('aria-label','Area di cancellazione del tile');preview.className='ktc-eraser-canvas';
  const workspace=dialog.querySelector('.ktc-eraser-workspace'),cursor=dialog.querySelector('.ktc-eraser-cursor');workspace.append(preview);
  const range=dialog.querySelector('[type=range]'),number=dialog.querySelector('[data-size-number]'),undo=dialog.querySelector('[data-undo]'),redo=dialog.querySelector('[data-redo]');
  const entries=[],future=[];let active=null,pointer=null,size=Math.max(4,Math.min(300,Number(brushSize)||48)),frame=null,settled=false,committing=false;
  const setSize=value=>{size=Math.max(4,Math.min(300,Math.round(Number(value)||4)));range.value=number.value=String(size);};setSize(size);
  function render(){
    if(frame!==null)cancelAnimationFrame(frame);frame=null;if(settled)return;a.clearRect(0,0,alpha.width,alpha.height);
    if(initial)a.drawImage(initial,0,0);else{a.fillStyle='#fff';a.fillRect(0,0,alpha.width,alpha.height);}
    for(const entry of [...entries,...(active?[active]:[])]){
      if(entry.reset){a.clearRect(0,0,alpha.width,alpha.height);a.fillStyle='#fff';a.fillRect(0,0,alpha.width,alpha.height);}else drawErasure(a,entry);
    }
    ctx.clearRect(0,0,preview.width,preview.height);ctx.globalCompositeOperation='source-over';ctx.drawImage(image,0,0);ctx.globalCompositeOperation='destination-in';ctx.drawImage(alpha,0,0);ctx.globalCompositeOperation='source-over';
    undo.disabled=committing||!entries.length;redo.disabled=committing||!future.length;
  }
  const schedule=()=>{if(frame===null)frame=requestAnimationFrame(render);};
  const updateCursor=event=>{const b=preview.getBoundingClientRect(),w=workspace.getBoundingClientRect(),diameter=size*b.width/preview.width;cursor.hidden=false;Object.assign(cursor.style,{left:`${event.clientX-w.left}px`,top:`${event.clientY-w.top}px`,width:`${diameter}px`,height:`${diameter}px`});};
  return await new Promise(resolve=>{
    const listeners=new AbortController();
    const settle=value=>{if(settled)return;settled=true;listeners.abort();signal?.removeEventListener('abort',abort);if(frame!==null)cancelAnimationFrame(frame);image.close();initial?.close();dialog.close();dialog.remove();resolve(value);};
    const abort=()=>settle(null);
    const listen=(node,event,fn)=>node.addEventListener(event,fn,{signal:listeners.signal});
    const finish=()=>{if(!active)return;entries.push(active);future.length=0;active=null;pointer=null;schedule();};
    listen(preview,'pointerdown',event=>{if(committing||event.button!==0)return;event.preventDefault();pointer=event.pointerId;active={size,points:[brushPoint(event,preview.getBoundingClientRect(),preview.width,preview.height)]};preview.setPointerCapture(event.pointerId);updateCursor(event);schedule();});
    listen(preview,'pointermove',event=>{if(committing)return;updateCursor(event);if(!active||event.pointerId!==pointer)return;event.preventDefault();active.points.push(brushPoint(event,preview.getBoundingClientRect(),preview.width,preview.height));schedule();});
    listen(preview,'pointerup',event=>{if(event.pointerId!==pointer)return;event.preventDefault();finish();if(preview.hasPointerCapture(event.pointerId))preview.releasePointerCapture(event.pointerId);});
    listen(preview,'pointercancel',finish);listen(preview,'lostpointercapture',finish);listen(preview,'pointerleave',()=>{cursor.hidden=true;});
    listen(range,'input',()=>{setSize(range.value);cursor.hidden=true;});
    listen(number,'input',()=>{const value=Number(number.value);if(Number.isFinite(value)&&value>=4&&value<=300){size=Math.round(value);range.value=String(size);cursor.hidden=true;}});
    listen(number,'change',()=>{setSize(number.value);cursor.hidden=true;});
    const undoStroke=()=>{finish();if(entries.length){future.push(entries.pop());render();}},redoStroke=()=>{if(future.length){entries.push(future.pop());render();}};
    listen(undo,'click',undoStroke);listen(redo,'click',redoStroke);
    listen(dialog.querySelector('[data-reset]'),'click',()=>{finish();entries.push({reset:true});future.length=0;render();});
    listen(dialog,'keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!committing){event.preventDefault();event.stopPropagation();event.shiftKey?redoStroke():undoStroke();}});
    for(const button of dialog.querySelectorAll('[data-close],[data-cancel]'))listen(button,'click',()=>settle(null));
    listen(dialog,'cancel',event=>{event.preventDefault();settle(null);});listen(dialog,'close',()=>settle(null));signal?.addEventListener('abort',abort,{once:true});
    listen(dialog.querySelector('[data-apply]'),'click',async()=>{
      if(committing)return;finish();render();committing=true;for(const control of dialog.querySelectorAll('input,button'))control.disabled=true;
      try{const [mask,result]=await Promise.all([encode(alpha,'image/png'),encode(preview,'image/webp')]);settle({mask,result,brushSize:size});}
      catch(error){if(settled)return;const message=dialog.querySelector('[role=alert]');message.hidden=false;message.textContent=error.message;committing=false;for(const control of dialog.querySelectorAll('input,button'))control.disabled=false;render();}
    });
    document.body.append(dialog);dialog.showModal();render();
  });
}
