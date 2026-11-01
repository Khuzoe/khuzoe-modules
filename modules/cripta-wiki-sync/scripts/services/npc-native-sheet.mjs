import {nativeGet,nativeHas,nativeSet,nativeEqual,nativeValidateChanges,nativePatchConflict,nativePatchSatisfied,nativeEditorSource,nativeValuePreserved,nativeTargetKey} from './npc-native-model.mjs';
import {applyNpcNativeEditor} from './npc-native-editor.mjs';
import {npcNativeSnapshotEnabled} from './npc-native-snapshot.mjs';

const clone=structuredClone,sourceOf=document=>JSON.parse(JSON.stringify(document.toJSON?.()??document.toObject(true)));
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
 const detached=new document.constructor(data,{parent:document.parent,pack:document.pack,strict:true});
 return sourceOf(detached);
}
function strictNew(actor,type,data){
 const Class=globalThis.CONFIG?.[type]?.documentClass;
 if(!Class)throw new Error(`Modello ${type} non disponibile.`);
 const detached=new Class(data,{parent:actor,strict:true}),saved=sourceOf(detached);
 for(const key of ['_id','name','type','system','effects','flags','statuses','duration','disabled','transfer'])if(Object.hasOwn(data,key)&&!nativeValuePreserved(saved[key],data[key]))throw new Error(`Il modello non conserva ${data.name}: ${key}.`);
}
function rollbackPatches(before,after,type,patches){
 const paths=new Set(patches.map(patch=>patch.path));
 if(type==='Item'&&[...paths].some(path=>path==='effects'||path.startsWith('system.activities')||path.startsWith('flags.khuzoe-automations.npcRules'))){
  for(const path of [...paths])if(path==='effects'||path.startsWith('system.activities')||path.startsWith('flags.khuzoe-automations.npcRules'))paths.delete(path);
  for(const path of ['system.activities','effects','flags.khuzoe-automations.npcRules'])paths.add(path);
 }
 return [...paths].filter(path=>!nativeEqual(nativeGet(before,path),nativeGet(after,path))||nativeHas(before,path)!==nativeHas(after,path)).map(path=>({path,op:nativeHas(before,path)?'set':'delete',baseExists:nativeHas(after,path),...(nativeHas(after,path)?{baseValue:nativeGet(after,path)}:{}),...(nativeHas(before,path)?{value:nativeGet(before,path)}:{})}));
}

// Validate every document before the first write. Foundry has no transaction
// across documents: a journal restores only this group's writes on failure.
export async function applyNpcNativeSheet(actor,command,services){
 if(command.nativeSheetVersion!==1||!npcNativeSnapshotEnabled(command.campaignId,actor)||command.target?.id!==actor.id)return{status:'failed',error:'Modifica completa non compatibile con questo NPC.'};
 const receipts=nativeGet(sourceOf(actor),receiptPath)||[];
 if(receipts.includes(command.id))return{status:'applied',actor};
 const operations=command.document?.operations,permissions={...command.nativePermissions,isAdmin:false,embeddedEffects:true,sharedRuntime:actor.prototypeToken?.actorLink!==false},planned=[],seen=new Set();
 try{
  if(command.document?.version!==1||!Array.isArray(operations)||!operations.length||operations.length>256)throw new Error('Gruppo di modifiche non valido.');
  const final=sourceOf(actor);
  for(const operation of operations){
   const target=operation.target,key=target&&nativeTargetKey(target),document=target&&resolve(actor,target);
   if(!target||!['Actor','Item','ActiveEffect'].includes(target.type)||!/^[A-Za-z0-9]{16}$/.test(target.id)||target.itemId||seen.has(key))throw new Error('Destinazione non valida o duplicata.');seen.add(key);
   if(operation.operation==='update'){
    if(!document)throw new Error('Un elemento non esiste più.');
    const before=nativeEditorSource(sourceOf(document),target.type),next=nativeValidateChanges(before,target,operation.patches,permissions);
    if(operation.patches.some(patch=>nativePatchConflict(before,patch)))return{status:'conflict',error:`${document.name}: alcuni campi sono cambiati. Nessuna modifica applicata.`};
    const checked=strictDocument(document,next);
    if(operation.patches.some(patch=>!nativePatchSatisfied(nativeEditorSource(checked,target.type),patch)))throw new Error(`${document.name}: il modello non conserva tutti i campi richiesti.`);
    // Preset validation also happens before any ordinary field is changed.
    if(target.type==='Item')prepareItem(next);
    planned.push({...operation,before,next});
    if(target.type==='Actor')for(const patch of operation.patches)nativeSet(final,patch.path,patch.value,patch.op==='delete');
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
 const journal=[];
 try{
  for(const operation of [...planned.filter(value=>value.operation==='create'),...planned.filter(value=>value.operation==='update'),...planned.filter(value=>value.operation==='delete')]){
   const entry={...operation};journal.push(entry);
   if(operation.operation==='create'){
    await actor.createEmbeddedDocuments(operation.target.type,[operation.document],{keepId:true,keepEmbeddedIds:true,criptaWikiSyncCommand:true});
    const saved=resolve(actor,operation.target);if(!saved)throw new Error('Il nuovo elemento non è stato restituito da Foundry.');entry.after=sourceOf(saved);
    for(const key of ['name','type','system','effects','flags','statuses','duration','disabled','transfer'])if(Object.hasOwn(operation.document,key)&&!nativeValuePreserved(entry.after[key],operation.document[key]))throw new Error(`${operation.document.name}: Foundry non ha conservato ${key}.`);
   }else if(operation.operation==='update'){
    const result=await applyNpcNativeEditor(actor,{...command,nativeSheetVersion:undefined,nativeEditorVersion:1,kind:operation.target.type==='Actor'?'actor.update':operation.target.type==='Item'?'item.update':'effect.update',target:operation.target,patches:operation.patches,nativePermissions:permissions},services);
    entry.after=sourceOf(resolve(actor,operation.target));
    if(result.status!=='applied')throw new Error(result.error||'Un elemento non è stato aggiornato.');
   }else{
    const current=resolve(actor,operation.target);
    if(!current||!nativeEqual(comparable(sourceOf(current)),comparable(operation.before)))throw new Error('L’elemento da rimuovere è cambiato durante l’applicazione.');
    await actor.deleteEmbeddedDocuments(operation.target.type,[operation.target.id],{criptaWikiSyncCommand:true});
    if(resolve(actor,operation.target))throw new Error('Foundry non ha rimosso l’elemento richiesto.');
   }
  }
  await actor.update({[receiptPath]:[...new Set([...(nativeGet(sourceOf(actor),receiptPath)||[]),command.id])].slice(-32)},{criptaWikiSyncCommand:true});
  return{status:'applied',actor};
 }catch(error){
  const failures=[];
  if((nativeGet(sourceOf(actor),receiptPath)||[]).includes(command.id))try{await actor.update({[receiptPath]:(nativeGet(sourceOf(actor),receiptPath)||[]).filter(id=>id!==command.id)},{criptaWikiSyncCommand:true});}catch(rollback){failures.push(`Ricevuta: ${rollback.message}`);}
  for(const entry of journal.reverse())try{
   const document=resolve(actor,entry.target);
   if(entry.operation==='create'){
    if(document){const written=entry.after||entry.document;if(!nativeValuePreserved(comparable(sourceOf(document)),comparable(written)))throw new Error('Il nuovo elemento è stato modificato da un’altra operazione.');await actor.deleteEmbeddedDocuments(entry.target.type,[entry.target.id],{criptaWikiSyncCommand:true});}
   }else if(entry.operation==='delete'){
    if(!document)await actor.createEmbeddedDocuments(entry.target.type,[entry.before],{keepId:true,keepEmbeddedIds:true,criptaWikiSyncCommand:true});
    else if(!nativeEqual(comparable(sourceOf(document)),comparable(entry.before)))throw new Error('Identificativo occupato dopo la rimozione.');
   }else if(document){
    const after=entry.after||nativeEditorSource(sourceOf(document),entry.target.type),patches=rollbackPatches(entry.before,nativeEditorSource(after,entry.target.type),entry.target.type,entry.patches);
    if(!patches.length)continue;
    if(patches.some(patch=>nativePatchConflict(nativeEditorSource(sourceOf(document),entry.target.type),patch)))throw new Error('Campi modificati da un’altra operazione durante il ripristino.');
    const result=await applyNpcNativeEditor(actor,{...command,nativeSheetVersion:undefined,nativeEditorVersion:1,kind:entry.target.type==='Actor'?'actor.update':entry.target.type==='Item'?'item.update':'effect.update',target:entry.target,patches,nativePermissions:permissions},services);if(result.status!=='applied')throw new Error(result.error);
   }else throw new Error('Elemento da ripristinare mancante.');
  }catch(rollback){failures.push(`${entry.before?.name||entry.document?.name||entry.target.id}: ${rollback.message}`);}
  return{status:'failed',error:`${error.message} ${failures.length?`Ripristino incompleto: ${failures.join('; ')}. Verifica la scheda in Foundry.`:'Modifiche del gruppo annullate.'}`};
 }
}
