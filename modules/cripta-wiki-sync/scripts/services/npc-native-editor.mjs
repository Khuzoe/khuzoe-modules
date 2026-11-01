import { NPC_NATIVE_EDITOR_VERSION, nativeGet, nativeHas, nativeValidateChanges, nativePatchConflict, nativePatchSatisfied, nativeEqual, nativeEditorSource } from "./npc-native-model.mjs";

const sourceOf = document => JSON.parse(JSON.stringify(document.toJSON?.() ?? document.toObject(true)));
const deletion = path => { const parts=path.split(".");parts[parts.length-1]="-="+parts.at(-1);return parts.join("."); };
function comparableSource(source,wanted,type) {
  if(type!=="Item")return source;
  const result=structuredClone(source);
  const generated=new Set((source.effects||[]).filter(effect=>{const rule=effect.flags?.['khuzoe-automations']?.npcRule;return rule&&source.flags?.['khuzoe-automations']?.npcRules?.activities?.[rule.activityId]?.conditions?.includes(rule.condition);}).map(effect=>effect._id));
  result.effects=(result.effects||[]).filter(effect=>!generated.has(effect._id)||(wanted.effects||[]).some(value=>value._id===effect._id));
  for(const [id,activity]of Object.entries(result.system?.activities||{}))if(Array.isArray(activity.effects))activity.effects=activity.effects.filter(link=>!generated.has(link._id)||wanted.system?.activities?.[id]?.effects?.some(value=>value._id===link._id));
  return result;
}

// Keep the native source as the baseline, never prepared HP/AC or a synthetic
// Actor. Updates are restricted to the selected document and changed fields.
export async function applyNpcNativeEditor(actor, command, services) {
  if (command.nativeEditorVersion !== NPC_NATIVE_EDITOR_VERSION || actor.isToken || actor.type !== "npc") return {status:"failed",error:"Editor NPC non compatibile."};
  const target = command.target;
  let document = target?.type === "Actor" && target.id === actor.id ? actor
    : target?.type === "Item" ? actor.items.get(target.id)
      : target?.type === "ActiveEffect" ? (target.itemId ? actor.items.get(target.itemId) : actor)?.effects?.get(target.id) : null;
  if (!document) return {status:"conflict",error:"L’elemento selezionato non esiste più."};
  const readSource=()=>nativeEditorSource(sourceOf(document),target.type);
  const before=readSource(),patches=command.patches;
  let next;
  try { next=nativeValidateChanges(before,target,patches,{...command.nativePermissions,sharedRuntime:actor.prototypeToken?.actorLink !== false}); }
  catch(error) { return {status:"failed",error:error.message}; }
  const comparableBefore=comparableSource(before,next,target.type);
  const conflicting=patches.filter(patch=>nativePatchConflict(comparableBefore,patch));
  if (conflicting.length) return {status:"conflict",error:`${document.name}: i campi sono cambiati in Foundry (${conflicting.map(patch=>patch.path).join(", ")}).`};
  if (patches.every(patch=>nativePatchSatisfied(comparableBefore,patch))) return {status:"applied",actor};
  // A detached document validates against the installed D&D5e model before
  // any document is written. It never creates an Actor in the world.
  // Document.clone() forces strict:false in v14, so use the constructor.
  try { new document.constructor(next,{parent:document.parent,pack:document.pack,strict:true}); }
  catch(error) { return {status:"failed",error:`Valori non accettati da Foundry: ${error.message}`}; }
  const grouped = new Set();
  if(target.type === "Item") {
    if(patches.some(patch=>patch.path.startsWith("system.activities"))) grouped.add("system.activities");
    if(patches.some(patch=>patch.path==="effects"))grouped.add("effects");
    for(const key of ["npcRules","midiRollConfig"]) if(patches.some(patch=>patch.path.startsWith(`flags.khuzoe-automations.${key}`))) grouped.add(`flags.khuzoe-automations.${key}`);
  }
  const groupedPatches = [...grouped].map(path=>({path,value:nativeGet(next,path)??(path.startsWith("flags.khuzoe-automations.")?{version:1,activities:{}}:path==="system.activities"?{}:undefined),baseValue:services.read(document,path)}));
  const clearedFlags=[...grouped].filter(path=>path.startsWith("flags.")&&!nativeHas(next,path));
  const ordinary=patches.filter(patch=>![...grouped].some(path=>patch.path===path||patch.path.startsWith(path+".")));
  const write = async (doc, changes) => {
    const update={};for(const patch of changes) update[patch.op==="delete"?deletion(patch.path):patch.path]=patch.op==="delete"?null:patch.value;
    if(Object.keys(update).length) await doc.update(update,{criptaWikiSyncCommand:true});
  };
  let written;
  try {
    if(groupedPatches.length) {
      const result=await services.applyItem({...command,nativeEditorVersion:undefined,patches:groupedPatches,target:{itemId:document.id}});
      if(result.status!=="applied") throw new Error(result.error || "Attività non aggiornate.");
    }
    await write(document,ordinary);
    await write(document,clearedFlags.map(path=>({path,op:"delete"})));
    written=readSource();
    document=target.type==="Actor"?actor:target.type==="Item"?actor.items.get(target.id):(target.itemId?actor.items.get(target.itemId):actor).effects.get(target.id);
    const saved=readSource();
    // The preset compiler can append linked, generated condition effects.
    // Verify every requested field, while allowing only these known additions.
    const comparable=comparableSource(saved,next,target.type);
    const missing=patches.filter(patch=>!nativePatchSatisfied(comparable,patch));
    if(missing.length) throw new Error(`Foundry non ha conservato: ${missing.map(patch=>patch.path).join(", ")}`);
    return {status:"applied",actor};
  } catch(error) {
    // Restore only fields touched by this command that still match our write.
    // Leave unrelated changes (including combat updates) in place.
    try {
      const current=readSource();
      const restore=ordinary.filter(patch=>written ? nativeHas(current,patch.path)===nativeHas(written,patch.path)&&nativeEqual(nativeGet(current,patch.path),nativeGet(written,patch.path)) : nativePatchSatisfied(current,patch)).map(patch=>({path:patch.path,op:nativeHas(before,patch.path)?"set":"delete",value:nativeGet(before,patch.path)}));
      await write(document,restore);
      if(groupedPatches.length){
        // Restore activities, effects and their rules together: an intermediate
        // combination could refer to effects or activities already removed.
        const paths=new Set([...grouped,"system.activities","effects"]);
        const rollbackPatches=[...paths].map(path=>({path,value:nativeGet(before,path)??(path.endsWith('.npcRules')?{version:1,activities:{}}:undefined),baseValue:services.read(document,path)})).filter(patch=>patch.value!==undefined);
        const rollback=await services.applyItem({...command,nativeEditorVersion:undefined,target:{itemId:document.id},patches:rollbackPatches});
        if(rollback.status!=="applied")throw new Error(rollback.error||"Attività ed effetti non ripristinati.");
        for(const path of grouped)if(!nativeHas(before,path))await write(document,[{path,op:"delete"}]);
      }
    } catch(rollback) { return {status:"failed",error:`${error.message} Ripristino incompleto: ${rollback.message}. Verifica l’elemento in Foundry.`}; }
    return {status:"failed",error:error.message};
  }
}
