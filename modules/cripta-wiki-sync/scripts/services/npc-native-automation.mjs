import {nativeGet,nativeSet,nativeApply,nativeDiff,nativeActivitiesAmbiguous} from './npc-native-model.mjs';

const entries=item=>Object.entries(item?.system?.activities||{});
const activeReference=value=>typeof value==='string'&&value!==''&&value!=='none';
const referencePaths=['otherActivityId','midiProperties.triggeredActivityId'];
const latin={'ß':'ss','ẞ':'SS','æ':'ae','Æ':'AE','œ':'oe','Œ':'OE','ø':'o','Ø':'O','ð':'d','Ð':'D','þ':'th','Þ':'TH','ł':'l','Ł':'L','đ':'dj','Đ':'DJ','‘':"'",'’':"'",'&':'and','%':'percent','$':'dollar','♥':'love'};
export function nativeActivityIdentifier(activity){
 if(activity?.midiProperties?.identifier)return activity.midiProperties.identifier;
 const name=String(activity?.name||'');
 if(typeof name.slugify==='function')return name.slugify();
 return [...name].map(char=>latin[char]||char).join('').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[\s-]+/g,'-');
}
export function nativeResolveActivity(item,reference){
 if(!activeReference(reference))return null;
 const list=entries(item),byId=list.filter(([key,value])=>(value?._id||key)===reference);
 if(byId.length===1)return{id:byId[0][1]._id||byId[0][0],activity:byId[0][1],kind:'id'};
 if(byId.length>1)return{ambiguous:true};
 const byIdentifier=list.filter(([,activity])=>nativeActivityIdentifier(activity)===reference);
 if(byIdentifier.length===1)return{id:byIdentifier[0][1]._id||byIdentifier[0][0],activity:byIdentifier[0][1],kind:'identifier'};
 if(byIdentifier.length>1)return{ambiguous:true};
 if(/^(?:Actor|Item|Scene|Compendium)\.[^\s]+\.[^\s]+$/.test(reference))return{external:true};
 return null;
}
// Only a future, explicitly reviewed rename can need this adjustment. Baseline
// documents and references that still resolve to the same activity stay intact.
export function nativePreserveActivityReferences(before,after){
 if(nativeActivitiesAmbiguous(before)||nativeActivitiesAmbiguous(after))return after;
 for(const [key,activity]of entries(after)){
  const original=before.system?.activities?.[key];if(!original)continue;
  for(const path of referencePaths){
   const reference=nativeGet(activity,path);
   if(!activeReference(reference)||reference!==nativeGet(original,path))continue;
   const oldTarget=nativeResolveActivity(before,reference),newTarget=nativeResolveActivity(after,reference);
   if(oldTarget?.kind!=='identifier'||!after.system?.activities?.[oldTarget.id]||newTarget?.id===oldTarget.id)continue;
   nativeSet(activity,path,oldTarget.id);
  }
 }
 return after;
}
export function nativePreserveActivityReferencePatches(before,patches,permissions={}){
 const proposed=nativeApply(before,patches),after=structuredClone(proposed);nativePreserveActivityReferences(before,after);
 const fixups=nativeDiff(proposed,after,'Item',permissions);if(!fixups.length)return patches;
 const covers=(patch,path)=>patch.path===path||path.startsWith(patch.path+'.');
 // Keep every original concurrency baseline. Only the requested values and
 // disjoint reference fixups may change; a stale edit must still conflict.
 return [...patches.map(patch=>patch.op==='set'&&fixups.some(fixup=>covers(patch,fixup.path))?{...patch,value:nativeGet(after,patch.path)}:patch),...fixups.filter(fixup=>!patches.some(patch=>covers(patch,fixup.path)))];
}
export function nativeEquivalentActivityReference(before,after,patch){
 const match=patch.path.match(/^system\.activities\.([^.]+)\.(otherActivityId|midiProperties\.triggeredActivityId)$/);
 if(!match||patch.op!=='set'||nativeActivitiesAmbiguous(before)||nativeActivitiesAmbiguous(after))return false;
 const a=nativeResolveActivity(before,patch.baseValue),b=nativeResolveActivity(after,patch.value);
 return Boolean(a?.id&&a.id===b?.id&&before.system?.activities?.[match[1]]&&after.system?.activities?.[match[1]]);
}
export const nativeEffectsAmbiguous=item=>{const ids=(item?.effects||[]).map(effect=>effect?._id);return new Set(ids).size!==ids.length;};
export function nativeAbilityAutomationWarnings(item){
 const warnings=[],name=item.name||'Capacità',activities=entries(item),effectIds=new Set((item.effects||[]).map(effect=>effect?._id));
 if(nativeActivitiesAmbiguous(item))warnings.push(`${name}: attività con identificativi duplicati conservate; le loro meccaniche restano in sola lettura.`);
 if(nativeEffectsAmbiguous(item))warnings.push(`${name}: effetti con identificativi duplicati conservati; i loro dati restano in sola lettura.`);
 for(const [,activity]of activities){
  for(const path of referencePaths){const reference=nativeGet(activity,path);if(!activeReference(reference))continue;const target=nativeResolveActivity(item,reference);if(!target||target.ambiguous)warnings.push(`${name} · ${activity.name||'Attività'}: collegamento automatico ${target?.ambiguous?'ambiguo':'non risolto'} (${reference}). Gestione manuale del GM.`);}
  for(const link of activity.effects||[])if(!effectIds.has(link?._id))warnings.push(`${name} · ${activity.name||'Attività'}: l’effetto collegato ${link?._id||'senza identificativo'} non è presente. La regola può essere gestita manualmente.`);
 }
 const cycles=new Set();
 for(const [key,start]of activities){let activity=start;const visited=new Set([key]);while(activity){const next=nativeResolveActivity(item,activity.midiProperties?.triggeredActivityId);if(!next?.id)break;if(visited.has(next.id)){cycles.add(next.id);break;}visited.add(next.id);activity=next.activity;}}
 if(cycles.size)warnings.push(`${name}: il seguito automatico contiene un ciclo. Gestione manuale del GM.`);
 const rules=item.flags?.['khuzoe-automations']?.npcRules;
 if(rules&&(rules.version!==1||!rules.activities||typeof rules.activities!=='object'||Array.isArray(rules.activities)))warnings.push(`${name}: preset di automazione non riconosciuto. I dati esistenti vengono conservati per la gestione manuale.`);
 for(const id of Object.keys(rules?.activities||{}))if(!item.system?.activities?.[id])warnings.push(`${name}: il preset richiama un’attività assente (${id}). Gestione manuale del GM.`);
 return [...new Set(warnings)];
}
