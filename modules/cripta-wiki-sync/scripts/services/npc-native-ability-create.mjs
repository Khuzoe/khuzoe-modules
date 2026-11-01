import {nativeValuePreserved} from "./npc-native-model.mjs";
import {npcNativeSnapshotEnabled} from './npc-native-snapshot.mjs';

const sourceOf=document=>JSON.parse(JSON.stringify(document.toJSON?.()??document.toObject(true)));
const missing=(source,wanted)=>["name","type","img","system","flags","effects"].filter(key=>Object.hasOwn(wanted,key)&&!nativeValuePreserved(source[key],wanted[key]));

// This path is used only for newly generated pilot abilities. Existing Items
// are never replaced or deleted. Retrying verifies the same transfer identity.
export async function createVerifiedNpcAbility(actor,command,data,existing=null) {
 if(command.nativeAbilityVersion!==1||!npcNativeSnapshotEnabled(command.campaignId,actor))return{status:"failed",error:"Creazione nativa non compatibile con questo NPC."};
 if(existing){const lost=missing(sourceOf(existing),data);return lost.length?{status:"conflict",error:`La capacità esiste già ma alcuni valori sono cambiati (${lost.join(", ")}). Verificala in Foundry: non è stata creata una seconda copia.`}:{status:"applied",actor};}
 try {
  const ItemClass=globalThis.CONFIG?.Item?.documentClass;
  if(!ItemClass)throw new Error("Modello Item non disponibile.");
  const detached=new ItemClass(data,{parent:actor,strict:true});
  const lost=missing(sourceOf(detached),data);
  if(lost.length)throw new Error(`Il modello non conserva ${lost.join(", ")}.`);
 }catch(error){return{status:"failed",error:`Capacità non creata: ${error.message}`};}
 let created;
 try {
  const result=await actor.createEmbeddedDocuments("Item",[data],{criptaWikiSyncCommand:true});
  created=result?.[0];if(!created)throw new Error("Foundry non ha restituito la capacità creata.");
  const saved=actor.items?.get?.(created.id)||created,lost=missing(sourceOf(saved),data);
  if(lost.length)throw new Error(`Foundry non ha conservato ${lost.join(", ")}.`);
  return{status:"applied",actor};
 }catch(error){
  if(created){
   try {
    const identity=sourceOf(created).flags?.["cripta-wiki-sync"]?.transferId;
    if(!created.id||identity!==command.target?.transferId)throw new Error("Identità della nuova capacità non verificabile.");
    await actor.deleteEmbeddedDocuments("Item",[created.id],{criptaWikiSyncCommand:true});
   }catch(rollback){return{status:"failed",error:`${error.message} Ripristino incompleto: ${rollback.message}. Verifica la nuova capacità in Foundry.`};}
  }
  return{status:"failed",error:`Capacità non creata: ${error.message}`};
 }
}
