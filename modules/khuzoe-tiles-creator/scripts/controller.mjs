import {MODULE_ID,ACTIVE_STATUSES,contextKey,options,tileData,outputSize,placedTileMatches,sourceCrop} from './model.mjs';
import {TilesClient} from './client.mjs';
import {PendingDrafts} from './pending.mjs';
import {captureArea,composeTile,selectArea,sceneFingerprint,resultAsInput,resizeInput} from './capture.mjs';
import {openEraser,applyEraseMask,resizeEraseMask} from './eraser.mjs';
import {prepareReference,checkReferences,imageDataUrl} from './references.mjs';

export class TilesController{
  constructor({client=new TilesClient(),drafts=new PendingDrafts(),eraser=openEraser}={}){this.client=client;this.drafts=drafts;this.eraser=eraser;this.references=[];this.referenceUrls=[];this.tileEdits=new Map();this.eraserMask=null;this.eraserJobId=null;this.eraserBrush=48;this.composeRevision=0;this.settings=options();this.details='';this.job=null;this.busy=false;this.error='';this.notice='';this.urls={};this.blobs={};this.opened=false;this.fresh=false;this.timer=null;this.epoch=0;}
  emit(){this.onChange?.();}
  draftKey(){return `${game.user.id}:${contextKey(this.client.context)}`;}
  async open(){if(this.opening)return;this.opening=true;try{
    const origin=this.client.identity();
    if(this.origin!==origin){
      this.reset();this.origin=origin;this.activeDraftKey=this.draftKey();
      await this.draftWrite;
      const saved=await this.drafts.get(this.activeDraftKey);
      if(saved){
        this.details=saved.details;this.settings={...saved.options};this.selection={blob:saved.blob,capture:saved.capture,parentJobId:saved.parentJobId,eraseMask:saved.eraseMask};this.setBlob('source',saved.blob);this.setReferences(saved.references||[]);
        if(['refinement','selection'].includes(saved.kind)){this.previousJob=saved.previousJob;this.fresh=true;this.setBlob('before',await composeTile(saved.blob,saved.blob,saved.capture,0));this.notice=saved.kind==='refinement'?'Base precedente recuperata. Descrivi le altre modifiche.':'Area e reference recuperate. Puoi continuare a preparare la modifica.';}
        else this.pending=saved;
      }
    }
    this.opened=true;await this.load();
  }finally{this.opening=false;}}
  close({save=true}={}){this.opened=false;this.eraserAbort?.abort();clearTimeout(this.timer);this.timer=null;clearTimeout(this.draftTimer);if(save)void this.saveRefinement();}
  reset(){this.epoch++;this.composeRevision++;this.close({save:false});this.job=null;this.pending=null;this.previousJob=null;this.selection=null;this.setReferences([]);this.referenceJobId=null;this.referenceSupport=undefined;this.eraserMask=null;this.eraserJobId=null;this.tileEdits.clear();this.fresh=false;this.details='';this.error='';this.notice='';this.loginRequired=false;this.settings=options();for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.renderedJobId=null;}
  writeDraft(value,key=this.activeDraftKey||this.draftKey()){
    const previous=this.draftWrite||Promise.resolve();
    this.draftWrite=previous.catch(()=>{}).then(()=>value===null?this.drafts.delete(key):this.drafts.put(key,value));
    return this.draftWrite;
  }
  saveRefinement(){
    if(this.pending||this.job||!this.selection)return Promise.resolve(true);
    return this.writeDraft({kind:this.selection.parentJobId?'refinement':'selection',parentJobId:this.selection.parentJobId,previousJob:structuredClone(this.previousJob),details:this.details,options:{...this.settings},capture:structuredClone(this.selection.capture),blob:this.selection.blob,eraseMask:this.selection.eraseMask,references:structuredClone(this.references)});
  }
  deferDraftSave(){clearTimeout(this.draftTimer);if(this.selection&&!this.job&&!this.pending)this.draftTimer=setTimeout(()=>{void this.saveRefinement();},300);}
  setReferences(references){for(const url of this.referenceUrls)URL.revokeObjectURL(url);this.references=references.map(reference=>({...reference}));this.referenceUrls=this.references.map(reference=>URL.createObjectURL(reference.blob));}
  assertReferenceEdit(){
    if(!this.selection||this.job||this.pending)throw new Error('Scegli prima un’area, oppure usa il risultato come nuovo input.');
    if(!this.referenceSupport)throw new Error('Pubblica il Worker aggiornato per usare le reference secondarie.');
  }
  async addReferenceFiles(files){return this.act(async()=>{
    this.assertReferenceEdit();const origin=this.client.identity(),references=[...this.references];
    const selected=Array.from(files);if(!selected.length)return;checkReferences([...references,...selected.map(()=>({blob:{size:0}}))]);
    for(const file of selected)references.push(await prepareReference(file,{name:file.name||'Immagine allegata'}));
    checkReferences(references);this.client.assert(origin);this.setReferences(references);const saved=await this.saveRefinement();
    this.notice=`${selected.length===1?'Reference aggiunta':'Reference aggiunte'}. La mappa resta l’immagine 1.`+(saved?'':' Mantieni aperta questa finestra per conservare gli allegati.');
  });}
  async removeReference(index){return this.act(async()=>{this.assertReferenceEdit();if(!Number.isInteger(index)||index<0||index>=this.references.length)return;this.setReferences(this.references.filter((_,position)=>position!==index));await this.saveRefinement();this.notice='Reference rimossa. La mappa di partenza non è cambiata.';});}
  async captureReference(){
    if(this.busy||this.selecting)return;
    try{this.assertReferenceEdit();checkReferences([...this.references,{blob:{size:0}}]);}catch(error){this.error=error.message;this.emit();return;}
    this.selecting=true;const origin=this.client.identity();await this.onSelecting?.();
    try{
      const area=await selectArea();this.client.assert(origin);
      await this.act(async()=>{
        const selected=await captureArea(area,options({resolution:'medium',feather:0}));
        const crop=await composeTile(selected.blob,selected.blob,selected.capture,0);
        const reference=await prepareReference(crop,{name:`Area ${area.width} × ${area.height}`,kind:'scene'});
        this.client.assert(origin);const references=[...this.references,reference];checkReferences(references);this.setReferences(references);await this.saveRefinement();this.notice='Area aggiunta come reference secondaria. La mappa da modificare non è cambiata.';
      });
    }catch(error){if(error.message!=='Selezione annullata.')this.error=error.message;}finally{this.selecting=false;this.opened=true;await this.onSelected?.();this.emit();}
  }
  setBlob(name,blob){if(this.urls[name])URL.revokeObjectURL(this.urls[name]);this.blobs[name]=blob;this.urls[name]=URL.createObjectURL(blob);}
  editKey(job){return `${game.user.id}:${contextKey(job.context)}:tile-edit:${job.id}`;}
  async saveTileEdit(job,mask,feather=this.settings.feather){
    const crop=sourceCrop(job.capture),record={kind:'tile-edit',jobId:job.id,mask,feather,width:Math.round(crop.width),height:Math.round(crop.height)},key=this.editKey(job);
    this.tileEdits.set(key,record);return this.writeDraft(record,key);
  }
  async readTileEdit(job){
    const key=this.editKey(job),epoch=this.epoch;
    let saved=this.tileEdits.get(key);
    if(!this.tileEdits.has(key)){saved=await this.drafts.get?.(key);if(saved?.kind!=='tile-edit'||saved.jobId!==job.id)saved=null;this.tileEdits.set(key,saved);}
    if(epoch!==this.epoch||this.job?.id!==job.id)return;
    const crop=sourceCrop(job.capture);
    this.eraserJobId=job.id;this.eraserMask=saved?.width===Math.round(crop.width)&&saved?.height===Math.round(crop.height)?saved.mask:null;
    if(this.eraserMask&&[0,8,12,24].includes(saved.feather))this.settings.feather=saved.feather;
  }
  async act(fn){if(this.busy)return;this.busy=true;this.error='';this.emit();try{await fn();}catch(error){this.error=error.message||String(error);if(error.status===401)this.loginRequired=true;}finally{this.busy=false;this.emit();this.schedule();}}
  async load(){
    if(this.loading)return;this.loading=true;const epoch=this.epoch;
    try{
      const result=await this.client.request();if(epoch!==this.epoch)return;this.enabled=result.enabled;this.quota=result.quota;this.referenceSupport=result.referencesVersion===1;
      if(this.pending&&result.job?.id!==this.pending.id){this.notice='L’invio precedente non è ancora verificato. Puoi riprovare lo stesso invio senza avviare una richiesta diversa.';return;}
      if(result.job&&(this.pending||!this.fresh)){const keepFeather=this.job?.id===result.job.id&&this.blobs.generated,feather=this.settings.feather;this.job=result.job;this.fresh=false;if(this.pending){if(this.pending.eraseMask)await this.saveTileEdit(this.job,this.pending.eraseMask,this.pending.options.feather);this.pending=null;await this.writeDraft(null);}this.details=this.job.details;this.settings={...this.job.options,...(keepFeather?{feather}:{})};await this.loadImages();}
      this.error='';this.loginRequired=false;
    }catch(error){if(epoch===this.epoch){this.error=error.message;if(error.status===401)this.loginRequired=true;}}finally{this.loading=false;if(epoch===this.epoch){this.emit();this.schedule();}}
  }
  schedule(){clearTimeout(this.timer);if(this.opened&&(ACTIVE_STATUSES.includes(this.job?.status)||this.job?.status==='uncertain'||this.pending))this.timer=setTimeout(()=>this.load(),this.job?.status==='uncertain'?30000:5000);}
  async loadImages(){
    const job=this.job,epoch=this.epoch;if(!job)return;
    if(this.renderedJobId!==job.id){for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.setReferences([]);this.referenceJobId=null;this.eraserMask=null;this.eraserJobId=null;this.renderedJobId=job.id;await this.readTileEdit(job);if(epoch!==this.epoch||this.job?.id!==job.id)return;}
    if(!this.blobs.source){const blob=await this.client.request('source',undefined,job.id);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.setBlob('source',blob);}
    if(!this.blobs.before){const blob=await composeTile(this.blobs.source,this.blobs.source,job.capture,0);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.setBlob('before',blob);}
    if(this.referenceJobId!==job.id){const references=[];for(let index=0;index<(job.references?.length||0);index++){const blob=await this.client.request(`reference-${index+1}`,undefined,job.id);if(epoch!==this.epoch||this.job?.id!==job.id)return;references.push({...job.references[index],blob});}this.setReferences(references);this.referenceJobId=job.id;}
    if(['ready','placed'].includes(job.status)&&!this.blobs.generated){const blob=await this.client.request('preview',undefined,job.id);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.blobs.generated=blob;await this.compose();}
  }
  async compose(){if(this.blobs.source&&this.blobs.generated){
    const epoch=this.epoch,id=this.job?.id,revision=++this.composeRevision,mask=this.eraserJobId===id?this.eraserMask:null;
    const raw=await composeTile(this.blobs.source,this.blobs.generated,this.job.capture,this.settings.feather),blob=await applyEraseMask(raw,mask);
    if(epoch===this.epoch&&this.job?.id===id&&revision===this.composeRevision){this.blobs.unmasked=raw;this.setBlob('result',blob);if(mask)await this.saveTileEdit(this.job,mask);}
  }}
  async erase(){return this.act(async()=>{
    const job=this.job,origin=this.client.identity(),epoch=this.epoch;
    if(job?.status!=='ready'||!this.blobs.result)throw new Error('La gomma è disponibile sull’anteprima prima del posizionamento.');
    await this.compose();this.eraserAbort=new AbortController();
    const edited=await this.eraser({blob:this.blobs.unmasked||this.blobs.result,mask:this.eraserJobId===job.id?this.eraserMask:null,brushSize:this.eraserBrush,signal:this.eraserAbort.signal});
    if(!edited)return;this.client.assert(origin);if(epoch!==this.epoch||this.job?.id!==job.id)return;
    this.composeRevision++;this.eraserMask=edited.mask;this.eraserJobId=job.id;this.eraserBrush=edited.brushSize;this.setBlob('result',edited.result);
    const saved=await this.saveTileEdit(job,edited.mask);this.notice='Gomma applicata. Le parti cancellate saranno trasparenti sulla mappa.'+(saved?'':' Mantieni aperta questa scheda per conservare il ritocco.');
  });}
  async recapture(){if(!this.selection||this.job||this.pending)return;return this.act(async()=>{
    const origin=this.client.identity();let selected;
    if(this.selection.parentJobId){
      const size=outputSize(this.selection.capture.frame.width,this.selection.capture.frame.height,this.settings.resolution);
      const blob=await resizeInput(this.selection.blob,size);
      const capture={...this.selection.capture,...size},crop=sourceCrop(capture),eraseMask=this.selection.eraseMask?await resizeEraseMask(this.selection.eraseMask,{width:Math.round(crop.width),height:Math.round(crop.height)}):undefined;
      selected={...this.selection,blob,capture,eraseMask};
    }else selected=await captureArea(this.selection.capture.target,this.settings);
    this.client.assert(origin);this.selection=selected;this.setBlob('source',selected.blob);this.setBlob('before',await composeTile(selected.blob,selected.blob,selected.capture,0));await this.saveRefinement();this.notice=`Area aggiornata · ${selected.capture.width} × ${selected.capture.height} per la generazione`;
  });}
  async refine(){return this.act(async()=>{
    const parent=this.job,origin=this.client.identity();
    if(!parent||!['ready','placed'].includes(parent.status)||!this.blobs.result)throw new Error('Attendi un’anteprima pronta prima di usarla come nuovo input.');
    if(contextKey(parent.context)!==contextKey(this.client.context))throw new Error('Riapri la scena e il livello originali.');
    await this.compose();
    const current=await sceneFingerprint(canvas.scene),capture=structuredClone(parent.capture);
    if(current!==capture.sceneFingerprint){
      const placed=Array.from(canvas.scene.tiles).find(t=>t.flags?.[MODULE_ID]?.generationId===parent.id);
      if(!placedTileMatches(parent,placed)||await sceneFingerprint(canvas.scene,{excludeGenerationId:parent.id})!==capture.sceneFingerprint)throw new Error('Lo sfondo o i tile sono cambiati. Seleziona di nuovo l’area prima di continuare.');
      capture.sceneFingerprint=current;capture.sort=Math.min(2000000000,Math.max(capture.sort,placed.sort+1000));
    }
    const blob=await resultAsInput(this.blobs.source,this.blobs.result,parent.capture);
    const before=await composeTile(blob,blob,capture,0);this.client.assert(origin);
    const eraseMask=this.eraserJobId===parent.id?this.eraserMask:null;
    this.previousJob={...structuredClone(parent),options:{...this.settings}};this.epoch++;this.job=null;this.fresh=true;this.pending=null;this.selection={blob,capture,parentJobId:parent.id,eraseMask};this.eraserMask=null;this.eraserJobId=null;this.details='';this.renderedJobId=null;
    for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.setBlob('source',blob);this.setBlob('before',before);
    const saved=await this.saveRefinement();this.notice='Anteprima impostata come nuovo input. Descrivi le altre modifiche.'+(saved?'':' Mantieni aperta questa scheda: il browser non consente il recupero dopo una ricarica.');this.focusRequest=true;
  });}
  async cancelRefinement(){return this.act(async()=>{
    if(!this.previousJob||this.pending||this.job)return;
    clearTimeout(this.draftTimer);this.epoch++;this.job=structuredClone(this.previousJob);this.previousJob=null;this.fresh=false;this.selection=null;this.details=this.job.details;this.settings={...this.job.options};this.renderedJobId=null;
    await this.writeDraft(null);await this.loadImages();this.notice='Anteprima precedente ripristinata. Nessuna nuova generazione avviata.';
  });}
  async select(){
    if(this.busy||this.selecting||this.pending||ACTIVE_STATUSES.includes(this.job?.status))return;
    this.selecting=true;
    const origin=this.client.identity();await this.onSelecting?.();
    try{
      const area=await selectArea();this.client.assert(origin);
      await this.act(async()=>{const selected=await captureArea(area,this.settings);this.client.assert(origin);clearTimeout(this.draftTimer);await this.writeDraft(null);this.epoch++;this.origin=origin;this.selection=selected;this.previousJob=null;this.fresh=true;this.job=null;this.renderedJobId=null;for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.setBlob('source',selected.blob);this.setBlob('before',await composeTile(selected.blob,selected.blob,selected.capture,0));await this.saveRefinement();this.notice=`Area pronta · ${selected.tiles} ${selected.tiles===1?'tile incluso':'tile inclusi'}`;});
    }catch(error){if(error.message!=='Selezione annullata.')this.error=error.message;}finally{this.selecting=false;this.opened=true;await this.onSelected?.();this.emit();}
  }
  async generate(){return this.act(async()=>{
    if(!this.enabled)throw new Error('La generazione immagini non è attiva sul sito.');
    if((this.pending?.references||this.references).length&&!this.referenceSupport)throw new Error('Aggiorna il Worker prima di inviare le reference. Nessuna generazione è stata avviata.');
    if(!this.pending){
      if(!this.selection)throw new Error('Seleziona prima un’area della scena.');
      if(!this.details.trim())throw new Error('Descrivi la modifica desiderata.');
      this.pending={id:crypto.randomUUID(),parentJobId:this.selection.parentJobId,details:this.details.trim(),options:{...this.settings},capture:this.selection.capture,blob:this.selection.blob,eraseMask:this.selection.eraseMask,references:structuredClone(this.references)};
      clearTimeout(this.draftTimer);const saved=await this.writeDraft(this.pending);if(!saved)this.notice='Il browser non consente il recupero dopo una ricarica. Mantieni aperta questa scheda durante l’invio.';
    }
    const pending=this.pending,origin=this.client.identity();
    const source=await imageDataUrl(pending.blob),references=[];
    if(pending.references?.length&&!this.referenceSupport)throw new Error('Aggiorna il Worker prima di inviare le reference. Nessuna generazione è stata avviata.');
    for(const reference of pending.references||[]){const {blob,...metadata}=reference;references.push({...metadata,image:await imageDataUrl(blob)});}
    const result=await this.client.request('',{requestId:pending.id,...(pending.parentJobId?{parentJobId:pending.parentJobId}:{}),details:pending.details,options:pending.options,capture:pending.capture,source,...(references.length?{references}:{})});this.client.assert(origin);
    if(result.job?.id!==pending.id)throw new Error('Risposta non coerente con la richiesta.');
    this.job=result.job;this.fresh=false;if(pending.eraseMask)await this.saveTileEdit(this.job,pending.eraseMask,pending.options.feather);this.pending=null;await this.writeDraft(null);this.notice='';await this.loadImages();
  });}
  async stop(){
    // This action deliberately does not share the long-running UI busy lock.
    const id=this.pending?.id||this.job?.id;if(!id)return;
    try{const result=await this.client.request('stop',{},id);this.job=result.job;this.fresh=false;if(this.pending){if(this.pending.eraseMask)await this.saveTileEdit(this.job,this.pending.eraseMask,this.pending.options.feather);this.pending=null;await this.writeDraft(null);}this.notice='Attesa interrotta. Un eventuale risultato tardivo resta recuperabile.';this.error='';}catch(error){this.error=error.message;}finally{this.emit();this.schedule();}
  }
  async place(){return this.act(async()=>{
    const job=this.job,origin=this.client.identity(),c=this.client.context;
    if(!job||!['ready','placed'].includes(job.status)||!this.blobs.result)throw new Error('Attendi l’anteprima.');
    if(contextKey(job.context)!==contextKey(c))throw new Error('Riapri il mondo, la scena e il livello originali prima di posizionare il tile.');
    if(!game.user.isGM||!c.remoteWrites||!game.user.can('FILES_UPLOAD'))throw new Error('Sono necessari i permessi GM di caricamento file e Wiki Sync in scrittura.');
    const scene=canvas.scene;
    let tile=Array.from(scene.tiles).find(t=>t.flags?.[MODULE_ID]?.generationId===job.id);
    if(!tile){
      if(await sceneFingerprint(scene)!==job.capture.sceneFingerprint)throw new Error('Lo sfondo o i tile sono cambiati dopo la cattura. Per evitare di coprirli con una versione precedente, seleziona di nuovo l’area.');
      const Picker=foundry.applications.apps.FilePicker.implementation,folder=`khuzoe-tiles/${game.world.id}`;
      for(const path of ['khuzoe-tiles',folder]){try{await Picker.browse('data',path);}catch{await Picker.createDirectory('data',path,{notify:false});}}
      const filename=`${job.id}.webp`,path=`${folder}/${filename}`;
      const result=await Picker.upload('data',folder,new File([this.blobs.result],filename,{type:'image/webp'}),{},{notify:false});
      if(!result?.path||result.path!==path)throw new Error('Il file non è stato salvato nella cartella prevista.');
      this.client.assert(origin);if(canvas.scene!==scene||!game.user.isGM||!this.client.context.remoteWrites)throw new Error('La scena o i permessi sono cambiati prima della conferma.');
      if(await sceneFingerprint(scene)!==job.capture.sceneFingerprint)throw new Error('La mappa è cambiata durante il caricamento. Il tile non è stato creato.');
      const id=job.id.replaceAll('-','').slice(0,16),existing=scene.tiles.get(id);
      if(existing&&existing.flags?.[MODULE_ID]?.generationId!==job.id)throw new Error('Identificativo tile già occupato. Nessun tile esistente è stato modificato.');
      try{tile=existing||(await scene.createEmbeddedDocuments('Tile',[{...tileData(job,path),_id:id}],{keepId:true}))[0];}
      catch(error){tile=scene.tiles.get(id);if(tile?.flags?.[MODULE_ID]?.generationId!==job.id)throw error;}
      if(!tile||tile.flags?.[MODULE_ID]?.generationId!==job.id)throw new Error('Creazione tile non verificata.');
    }
    try{const result=await this.client.request('placed',{tileId:tile.id},job.id);this.job=result.job;this.notice='Tile posizionato. Puoi nasconderlo o eliminarlo per tornare all’originale.';}
    catch{this.job={...job,status:'placed',tileId:tile.id};this.notice='Tile posizionato in Foundry. La ricevuta sul sito sarà aggiornata alla prossima conferma.';}
  });}
}
