import {nativeGet,nativeHas,nativeSet,nativeEqual,nativeValidateChanges,nativePatchConflict,nativePatchSatisfied,nativePatchMissingPaths,nativeNormalizeActorRanges,nativeEditorSource,nativeTargetKey} from './npc-native-model.mjs';
import {applyNpcNativeEditor} from './npc-native-editor.mjs';
import {nativeUndoPatches} from './npc-native-undo.mjs';
import {npcNativeSnapshotEnabled} from './npc-native-snapshot.mjs';
import {nativePreserveActivityReferencePatches} from './npc-native-automation.mjs';

const clone=structuredClone,journalPath='flags.cripta-wiki-sync.nativeSheetJournal';
const sourceOf=document=>{const source=JSON.parse(JSON.stringify(document.toJSON?.()??document.toObject(true)));if(source.flags?.['cripta-wiki-sync'])delete source.flags['cripta-wiki-sync'].nativeSheetJournal;return source;};
const readJournal=actor=>nativeGet(actor.toJSON?.()??actor.toObject(true),journalPath);
const writeJournal=(actor,state)=>actor.update({[journalPath]:state},{criptaWikiSyncCommand:true});
const inFlight=new WeakMap();
const receiptPath='flags.cripta-wiki-sync.nativeSheetReceipts';
const resolve=(actor,target)=>target.type==='Actor'&&actor.id===target.id?actor:target.type==='Item'?actor.items.get(target.id):target.type==='ActiveEffect'?actor.effects.get(target.id):null;
function comparable(value){const next=clone(value);const visit=entry=>{if(!entry||typeof entry!=='object')return;delete entry._stats;for(const child of Object.values(entry))visit(child);};visit(next);return next;}
function prepareItem(data){
 const result=clone(data),rules=result.flags?.['khuzoe-automations']?.npcRules;
 if(rules){
  const compiler=globalThis.game?.modules?.get('khuzoe-automations')?.api?.npcRules;
  if(compiler?.version!==1)throw new Error('Attiva Khuzoe Automations aggiornato per usare le regole di questa capacità.');
  if(Object.values(rules.activities||{}).some(rule=>rule.healingTypes?.length)&&compiler.healingTypes!==1)throw new Error('Aggiorna Khuzoe Automations per la cura da tipi di danno.');
  const compiled=compiler.prepare({rules,activities:result.system?.activities||{},effects:result.effects||[],itemName:result.name,statusEffects:globalThis.CONFIG?.statusEffects||[]});
  result.system.activities=compiled.activities;result.effects=compiled.effects;
 }
 return result;
}
function strictDocument(document,data){
 const detached=new document.constructor(clone(data),{parent:document.parent,pack:document.pack,strict:true});
 return sourceOf(detached);
}
const creationFields=['_id','name','type','img','system','effects','flags','statuses','duration','disabled','transfer'];
const creationMissingPaths=(saved,data)=>creationFields.filter(key=>Object.hasOwn(data,key)).flatMap(path=>nativePatchMissingPaths(saved,{path,op:'set',value:data[path]}));
function strictNew(actor,type,data){
 const Class=globalThis.CONFIG?.[type]?.documentClass;
 if(!Class)throw new Error(`Modello ${type} non disponibile.`);
 // Foundry takes ownership of constructor input (cleanData copy:false).
 // Keep the reviewed source separate from pruned fields and undefined defaults.
 const detached=new Class(clone(data),{parent:actor,strict:true}),missing=creationMissingPaths(sourceOf(detached),data);
 if(missing.length)throw new Error(`Il modello non conserva ${data.name}: ${missing.slice(0,24).join(', ')}.`);
}
async function restoreJournal(actor,state,services,permissions){
 const failures=[],remaining=[];
 for(const entry of [...state.entries].reverse())try{
  const document=resolve(actor,entry.target);
  if(entry.operation==='create'){
   if(document){if(!nativeEqual(comparable(sourceOf(document)),comparable(entry.after||entry.document)))throw new Error('Il nuovo elemento è cambiato.');await actor.deleteEmbeddedDocuments(entry.target.type,[entry.target.id],{criptaWikiSyncCommand:true});}
  }else if(entry.operation==='delete'){
   if(!document)await actor.createEmbeddedDocuments(entry.target.type,[entry.before],{keepId:true,keepEmbeddedIds:true,criptaWikiSyncCommand:true});
   else if(!nativeEqual(comparable(sourceOf(document)),comparable(entry.before)))throw new Error('Identificativo occupato dopo la rimozione.');
  }else if(document){
   const patches=nativeUndoPatches(entry.before,entry.expectedAfter||entry.after,sourceOf(document),entry.target.type,permissions);
   if(patches.length){const result=await applyNpcNativeEditor(actor,{foundryActorId:actor.id,kind:entry.target.type==='Actor'?'actor.update':entry.target.type==='Item'?'item.update':'effect.update',nativeEditorVersion:1,target:entry.target,patches,nativePermissions:permissions},services);if(result.status!=='applied')throw new Error(result.error||'Ripristino non applicato.');}
  }else throw new Error('Elemento da ripristinare mancante.');
 }catch(error){remaining.unshift(entry);failures.push((entry.before?.name||entry.document?.name||entry.target.id)+': '+error.message);}
 state.entries=remaining;state.phase='rollback';await writeJournal(actor,remaining.length?state:null);
 return failures;
}
export function applyNpcNativeSheet(actor,command,services){
 const task=(inFlight.get(actor)||Promise.resolve()).catch(()=>{}).then(()=>applySheet(actor,command,services));inFlight.set(actor,task);
 return task.finally(()=>{if(inFlight.get(actor)===task)inFlight.delete(actor);});
}
// Validate every document before the first write. Foundry has no transaction
// across documents: a journal restores only this group's writes on failure.
async function applySheet(actor,command,services){
 if(command.nativeSheetVersion!==1||!npcNativeSnapshotEnabled(command.campaignId,actor)||command.target?.id!==actor.id)return{status:'failed',error:'Modifica completa non compatibile con questo NPC.'};
 const receipts=nativeGet(sourceOf(actor),receiptPath)||[];
 if(receipts.includes(command.id)){if(readJournal(actor)?.commandId===command.id)try{await writeJournal(actor,null);}catch{}return{status:'applied',actor};}
 const previous=readJournal(actor);
 if(previous&&receipts.includes(previous.commandId)){
  try{await writeJournal(actor,null);}catch(error){return{status:'failed',error:'Applicazione precedente completata; impossibile pulire il registro: '+error.message};}
 }else if(previous){
  if(previous.version!==1||!Array.isArray(previous.entries))return{status:'failed',error:'Registro di recupero non valido. Verifica la scheda in Foundry.'};
  try{const failures=await restoreJournal(actor,previous,services,{...command.nativePermissions,isAdmin:false,embeddedEffects:true,sharedRuntime:actor.prototypeToken?.actorLink!==false});if(failures.length)return{status:'failed',error:'Ripristino incompleto: '+failures.join('; ')};}
  catch(error){return{status:'failed',error:'Recupero della precedente applicazione non completato: '+error.message};}
 }
 const operations=command.document?.operations,permissions={...command.nativePermissions,isAdmin:false,embeddedEffects:true,sharedRuntime:actor.prototypeToken?.actorLink!==false},planned=[],seen=new Set();
 try{
  if(command.document?.version!==1||!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('Gruppo di modifiche non valido.');
  const final=sourceOf(actor);
  for(const operation of operations){
   const target=operation.target,key=target&&nativeTargetKey(target),document=target&&resolve(actor,target);
   if(!target||!['Actor','Item','ActiveEffect'].includes(target.type)||!/^[A-Za-z0-9]{16}$/.test(target.id)||target.itemId||seen.has(key))throw new Error('Destinazione non valida o duplicata.');seen.add(key);
   if(operation.operation==='update'){
    if(!document)throw new Error('Un elemento non esiste più.');
    const before=nativeEditorSource(sourceOf(document),target.type);let patches=operation.patches,next=nativeValidateChanges(before,target,patches,permissions);
    if(target.type==='Actor'){
     nativeNormalizeActorRanges(before,next);
     patches=patches.map(patch=>patch.op==='set'?{...patch,value:nativeGet(next,patch.path)}:patch);
     next=nativeValidateChanges(before,target,patches,permissions);
    }
    if(target.type==='Item'){patches=nativePreserveActivityReferencePatches(before,patches,permissions);next=nativeValidateChanges(before,target,patches,permissions);}
    if(patches.some(patch=>nativePatchConflict(before,patch)))return{status:'conflict',error:`${document.name}: alcuni campi sono cambiati. Nessuna modifica applicata.`};
    const checked=strictDocument(document,next);
    const missing=patches.flatMap(patch=>nativePatchMissingPaths(nativeEditorSource(checked,target.type),patch));
    if(missing.length)throw new Error(`${document.name}: il modello non conserva tutti i campi richiesti (${[...new Set(missing)].slice(0,24).join(', ')}).`);
    // Preset validation also happens before any ordinary field is changed.
    if(target.type==='Item'&&patches.some(patch=>patch.path==='effects'||patch.path.startsWith('system.activities')||patch.path.startsWith('flags.khuzoe-automations.npcRules')))prepareItem(next);
    planned.push({...operation,patches,before,next});
    if(target.type==='Actor')for(const patch of patches)nativeSet(final,patch.path,patch.value,patch.op==='delete');
    else {const list=target.type==='Item'?'items':'effects',index=final[list].findIndex(value=>value._id===target.id);final[list][index]=next;}
   }else if(operation.operation==='create'){
    if(target.type==='Actor'||document||operation.document?._id!==target.id||Object.hasOwn(operation.document,'ownership')||Object.hasOwn(operation.document,'_stats'))throw new Error('Identità del nuovo elemento non valida.');
    const data=target.type==='Item'?prepareItem(operation.document):clone(operation.document);strictNew(actor,target.type,data);planned.push({...operation,document:data});final[target.type==='Item'?'items':'effects'].push(data);
   }else if(operation.operation==='delete'){
    if(target.type==='Actor'||!document||!nativeEqual(comparable(nativeEditorSource(sourceOf(document),target.type)),comparable(operation.baseValue)))return{status:'conflict',error:'L’elemento da rimuovere è cambiato. Nessuna modifica applicata.'};
    planned.push({...operation,before:sourceOf(document)});final[target.type==='Item'?'items':'effects']=final[target.type==='Item'?'items':'effects'].filter(value=>value._id!==target.id);
   }else throw new Error('Operazione non supportata.');
  }
  strictDocument(actor,final);
 }catch(error){return{status:'failed',error:`Proposta non applicata: ${error.message}`};}
 const state={version:1,commandId:command.id,phase:'applying',entries:[]};
 try{
  await writeJournal(actor,state);
  for(const operation of [...planned.filter(value=>value.operation==='create'),...planned.filter(value=>value.operation==='update'),...planned.filter(value=>value.operation==='delete')]){
   const current=resolve(actor,operation.target),entry={operation:operation.operation,target:clone(operation.target)};
   if(operation.operation==='create'){
    if(current)throw new Error('Identificativo occupato prima della creazione.');entry.document=clone(operation.document);
   }else{
    if(!current)throw new Error('Elemento rimosso durante l’applicazione.');
    entry.before=sourceOf(current);
    if(operation.operation==='update'){
     if(operation.patches.some(patch=>nativePatchConflict(nativeEditorSource(entry.before,operation.target.type),patch)))throw new Error('Campi modificati durante l’applicazione.');
     entry.expectedAfter=nativeValidateChanges(entry.before,operation.target,operation.patches,permissions);
    }else if(!nativeEqual(comparable(entry.before),comparable(operation.before)))throw new Error('Elemento modificato prima della rimozione.');
   }
   state.entries.push(entry);await writeJournal(actor,state);
   if(operation.operation==='create'){
    await actor.createEmbeddedDocuments(operation.target.type,[clone(entry.document)],{keepId:true,keepEmbeddedIds:true,criptaWikiSyncCommand:true});
    const saved=resolve(actor,operation.target);if(!saved)throw new Error('Il nuovo elemento non è stato restituito da Foundry.');entry.after=sourceOf(saved);
    const missing=creationMissingPaths(entry.after,entry.document);if(missing.length)throw new Error(entry.document.name+': Foundry non ha conservato '+missing.slice(0,24).join(', ')+'.');
   }else if(operation.operation==='update'){
    const result=await applyNpcNativeEditor(actor,{...command,kind:operation.target.type==='Actor'?'actor.update':operation.target.type==='Item'?'item.update':'effect.update',nativeSheetVersion:undefined,nativeEditorVersion:1,target:operation.target,patches:operation.patches,nativePermissions:permissions},services);
    entry.after=sourceOf(resolve(actor,operation.target));if(result.status!=='applied')throw new Error(result.error||'Elemento non aggiornato.');
   }else{
    await actor.deleteEmbeddedDocuments(operation.target.type,[operation.target.id],{criptaWikiSyncCommand:true});if(resolve(actor,operation.target))throw new Error('Elemento non rimosso.');
   }
   entry.completed=true;await writeJournal(actor,state);
  }
  await actor.update({[receiptPath]:[...new Set([...(nativeGet(sourceOf(actor),receiptPath)||[]),command.id])].slice(-32)},{criptaWikiSyncCommand:true});
  try{await writeJournal(actor,null);}catch{console.warn('Wiki Sync: applicazione completata; registro da pulire alla prossima lettura.');}
  return{status:'applied',actor};
 }catch(error){
  // The receipt is the commit marker. A hook may throw after it was saved;
  // undoing here would contradict that durable acknowledgement on the next poll.
  if((nativeGet(sourceOf(actor),receiptPath)||[]).includes(command.id)){
   try{await writeJournal(actor,null);}catch{}
   return{status:'applied',actor};
  }
  let failures=[];
  try{failures=await restoreJournal(actor,state,services,permissions);}catch(rollback){failures.push(rollback.message);}
  return{status:'failed',error:error.message+' '+(failures.length?'Ripristino incompleto: '+failures.join('; ')+'. Verifica la scheda in Foundry.':'Modifiche del gruppo annullate.')};
 }
}
