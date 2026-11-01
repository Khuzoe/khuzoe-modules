import {MODULE_ID,ACTIVE_STATUSES,contextKey,options,tileData} from './model.mjs';
import {TilesClient} from './client.mjs';
import {PendingDrafts} from './pending.mjs';
import {captureArea,composeTile,selectArea,sceneFingerprint} from './capture.mjs';

export class TilesController{
  constructor({client=new TilesClient(),drafts=new PendingDrafts()}={}){this.client=client;this.drafts=drafts;this.settings=options();this.details='';this.job=null;this.busy=false;this.error='';this.notice='';this.urls={};this.blobs={};this.opened=false;this.fresh=false;this.timer=null;this.epoch=0;}
  emit(){this.onChange?.();}
  draftKey(){return `${game.user.id}:${contextKey(this.client.context)}`;}
  async open(){if(this.opening)return;this.opening=true;try{const origin=this.client.identity();if(this.origin!==origin){this.reset();this.origin=origin;this.pending=await this.drafts.get(this.draftKey());if(this.pending){this.details=this.pending.details;this.settings=this.pending.options;this.selection={blob:this.pending.blob,capture:this.pending.capture};this.setBlob('source',this.pending.blob);}}this.opened=true;await this.load();}finally{this.opening=false;}}
  close(){this.opened=false;clearTimeout(this.timer);this.timer=null;}
  reset(){this.epoch++;this.close();this.job=null;this.pending=null;this.selection=null;this.fresh=false;this.details='';this.error='';this.notice='';this.loginRequired=false;this.settings=options();for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.renderedJobId=null;}
  setBlob(name,blob){if(this.urls[name])URL.revokeObjectURL(this.urls[name]);this.blobs[name]=blob;this.urls[name]=URL.createObjectURL(blob);}
  async act(fn){if(this.busy)return;this.busy=true;this.error='';this.emit();try{await fn();}catch(error){this.error=error.message||String(error);if(error.status===401)this.loginRequired=true;}finally{this.busy=false;this.emit();this.schedule();}}
  async load(){
    if(this.loading)return;this.loading=true;const epoch=this.epoch;
    try{
      const result=await this.client.request();if(epoch!==this.epoch)return;this.enabled=result.enabled;this.quota=result.quota;
      if(this.pending&&result.job?.id!==this.pending.id){this.notice='L’invio precedente non è ancora verificato. Puoi riprovare lo stesso invio senza avviare una richiesta diversa.';return;}
      if(!this.fresh&&result.job){this.job=result.job;if(this.pending){await this.drafts.delete(this.draftKey());this.pending=null;}this.details=this.job.details;this.settings=this.job.options;await this.loadImages();}
      this.error='';this.loginRequired=false;
    }catch(error){if(epoch===this.epoch){this.error=error.message;if(error.status===401)this.loginRequired=true;}}finally{this.loading=false;if(epoch===this.epoch){this.emit();this.schedule();}}
  }
  schedule(){clearTimeout(this.timer);if(this.opened&&(ACTIVE_STATUSES.includes(this.job?.status)||this.job?.status==='uncertain'||this.pending))this.timer=setTimeout(()=>this.load(),this.job?.status==='uncertain'?30000:5000);}
  async loadImages(){
    const job=this.job,epoch=this.epoch;if(!job)return;
    if(this.renderedJobId!==job.id){for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.renderedJobId=job.id;}
    if(!this.blobs.source){const blob=await this.client.request('source',undefined,job.id);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.setBlob('source',blob);}
    if(!this.blobs.before){const blob=await composeTile(this.blobs.source,this.blobs.source,job.capture,0);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.setBlob('before',blob);}
    if(['ready','placed'].includes(job.status)&&!this.blobs.generated){const blob=await this.client.request('preview',undefined,job.id);if(epoch!==this.epoch||this.job?.id!==job.id)return;this.blobs.generated=blob;await this.compose();}
  }
  async compose(){if(this.blobs.source&&this.blobs.generated){const epoch=this.epoch,id=this.job?.id,blob=await composeTile(this.blobs.source,this.blobs.generated,this.job.capture,this.settings.feather);if(epoch===this.epoch&&this.job?.id===id)this.setBlob('result',blob);}}
  async recapture(){if(!this.selection||this.job||this.pending)return;return this.act(async()=>{const origin=this.client.identity(),selected=await captureArea(this.selection.capture.target,this.settings);this.client.assert(origin);this.selection=selected;this.setBlob('source',selected.blob);this.setBlob('before',await composeTile(selected.blob,selected.blob,selected.capture,0));this.notice=`Area aggiornata · ${selected.capture.width} × ${selected.capture.height} per la generazione`;});}
  async select(){
    if(this.busy||this.selecting||this.pending||ACTIVE_STATUSES.includes(this.job?.status))return;
    this.selecting=true;
    const origin=this.client.identity();await this.onSelecting?.();
    try{
      const area=await selectArea();this.client.assert(origin);
      await this.act(async()=>{const selected=await captureArea(area,this.settings);this.client.assert(origin);this.epoch++;this.origin=origin;this.selection=selected;this.fresh=true;this.job=null;this.renderedJobId=null;for(const url of Object.values(this.urls))URL.revokeObjectURL(url);this.urls={};this.blobs={};this.setBlob('source',selected.blob);this.setBlob('before',await composeTile(selected.blob,selected.blob,selected.capture,0));this.notice=`Area pronta · ${selected.tiles} ${selected.tiles===1?'tile incluso':'tile inclusi'}`;});
    }catch(error){if(error.message!=='Selezione annullata.')this.error=error.message;}finally{this.selecting=false;this.opened=true;await this.onSelected?.();this.emit();}
  }
  async generate(){return this.act(async()=>{
    if(!this.enabled)throw new Error('La generazione immagini non è attiva sul sito.');
    if(!this.pending){
      if(!this.selection)throw new Error('Seleziona prima un’area della scena.');
      if(!this.details.trim())throw new Error('Descrivi la modifica desiderata.');
      this.pending={id:crypto.randomUUID(),details:this.details.trim(),options:{...this.settings},capture:this.selection.capture,blob:this.selection.blob};
      const saved=await this.drafts.put(this.draftKey(),this.pending);if(!saved)this.notice='Il browser non consente il recupero dopo una ricarica. Mantieni aperta questa scheda durante l’invio.';
    }
    const pending=this.pending,origin=this.client.identity();
    const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Impossibile leggere la cattura.'));reader.readAsDataURL(pending.blob);});
    const result=await this.client.request('',{requestId:pending.id,details:pending.details,options:pending.options,capture:pending.capture,source});this.client.assert(origin);
    if(result.job?.id!==pending.id)throw new Error('Risposta non coerente con la richiesta.');
    this.job=result.job;this.fresh=false;this.pending=null;await this.drafts.delete(this.draftKey());this.notice='';await this.loadImages();
  });}
  async stop(){
    // This action deliberately does not share the long-running UI busy lock.
    const id=this.pending?.id||this.job?.id;if(!id)return;
    try{const result=await this.client.request('stop',{},id);this.job=result.job;this.fresh=false;if(this.pending){this.pending=null;await this.drafts.delete(this.draftKey());}this.notice='Attesa interrotta. Un eventuale risultato tardivo resta recuperabile.';this.error='';}catch(error){this.error=error.message;}finally{this.emit();this.schedule();}
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
