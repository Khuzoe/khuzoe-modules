export const NPC_NATIVE_EDITOR_VERSION = 1;
const protectedSegments = new Set(["__proto__", "prototype", "constructor"]);
const effectFields = new Set(["name", "img", "disabled", "transfer", "origin", "duration", "changes", "statuses", "flags", "description", "system", "tint", "showIcon"]);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a],[b]) => a.localeCompare(b))) : entry);
export const nativeEqual = (left, right) => canonical(left) === canonical(right);
export function nativeGet(value, path) { return String(path || "").split(".").reduce((object, key) => object?.[key], value); }
export function nativeHas(value, path) {
  const parts = String(path).split("."); let object = value;
  for (const part of parts) { if (object == null || !Object.hasOwn(object, part)) return false; object = object[part]; }
  return true;
}
export function nativeSet(value, path, next, remove = false) {
  const parts = String(path).split(".");
  if (parts.some(part => protectedSegments.has(part) || !part)) throw new Error("Percorso non valido.");
  let object = value;
  for (const part of parts.slice(0,-1)) { if (!object[part] || typeof object[part] !== "object") object[part] = {}; object = object[part]; }
  if (remove) delete object[parts.at(-1)]; else object[parts.at(-1)] = clone(next);
}
export function nativePrivatePath(path) { return String(path).split(".").includes("midiRollConfig"); }
export function nativeEditablePath(type, path, permissions = {}) {
  if (typeof path !== "string" || path.length > 700) return false;
  const parts = path.split(".");
  if (permissions.activityReadOnly && (path.startsWith("system.activities") || path.startsWith("flags.khuzoe-automations.npcRules") || path.startsWith("flags.khuzoe-automations.midiRollConfig"))) return false;
  if (parts.some(part => !part || protectedSegments.has(part) || part.startsWith("-="))) return false;
  if (parts.some(part => ["_id", "_stats"].includes(part))) return false;
  if (!permissions.isAdmin && nativePrivatePath(path)) return false;
  if (parts[0] === "flags") {
    if (parts.length < 2 || ["core", "cripta-wiki-sync"].includes(parts[1])) return false;
    if (parts[1] === "khuzoe-automations" && parts.length < 3) return false;
    return true;
  }
  if (type === "ActiveEffect") return effectFields.has(parts[0]) && parts[0] !== "flags";
  if (type === "Item" && parts[0] === "effects") return permissions.embeddedEffects === true && parts.length === 1;
  if (type === "Item" && parts[0] === "img") return parts.length === 1;
  if (parts[0] === "name") return parts.length === 1;
  if (parts[0] !== "system" || parts.length < 2) return false;
  // Source identities and generated advancement records are managed by D&D5e.
  if (["source", "advancement", "sourceItem"].includes(parts[1])) return false;
  if (parts[1] === "activities" && parts.length === 4 && parts[3] === "type") return false;
  if (type === "Actor" && path === "system.attributes.prof") return false;
  if (type === "Actor" && permissions.sharedRuntime === false && (/^system\.attributes\.hp\.(value|temp)$/.test(path) || /^system\.spells\.[^.]+\.(value|spent)$/.test(path))) return false;
  return true;
}
export function nativeValidateValue(value, depth = 0) {
  if (depth > 32) throw new Error("Struttura troppo profonda.");
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Inserisci un numero valido."); return; }
  if (!value || typeof value !== "object") throw new Error("Valore non valido.");
  for (const [key, child] of Object.entries(value)) { if (protectedSegments.has(key)) throw new Error("La struttura contiene un campo riservato."); nativeValidateValue(child, depth + 1); }
}
export function nativeValidatePatch(type, patch, permissions = {}) {
  if (!patch || !["set", "delete"].includes(patch.op) || !nativeEditablePath(type, patch.path, permissions)) throw new Error(`Campo non modificabile: ${patch?.path || ""}`);
  if (typeof patch.baseExists !== "boolean") throw new Error("Manca il valore di partenza.");
  if (patch.baseExists) nativeValidateValue(patch.baseValue);
  if (patch.op === "set") {
    nativeValidateValue(patch.value);
    if (!permissions.isAdmin && !(type === "Item" && patch.path === "effects" && permissions.embeddedEffects) && JSON.stringify(patch.value).includes('"midiRollConfig"')) throw new Error("Configurazione riservata all’admin.");
    if (patch.path === "name" && (typeof patch.value !== "string" || !patch.value.trim())) throw new Error("Il nome non può essere vuoto.");
    if (patch.path === "img" && (typeof patch.value!=="string"||patch.value.length>4096||/^\s*(?:javascript|data):/i.test(patch.value)))throw new Error("Immagine non valida.");
  }
  return patch;
}
export function nativeDiff(base, next, type, permissions = {}, prefix = "") {
  const result = [];
  for (const key of new Set([...Object.keys(base || {}), ...Object.keys(next || {})])) {
    const path = prefix ? `${prefix}.${key}` : key, hasBase = Object.hasOwn(base || {}, key), hasNext = Object.hasOwn(next || {}, key);
    if (nativeEqual(base?.[key], next?.[key]) && hasBase === hasNext) continue;
    const a = base?.[key], b = next?.[key], objects = hasBase && hasNext && a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    const literalKeys = objects && [...Object.keys(a), ...Object.keys(b)].some(name => name.includes("."));
    const newContainer = !hasBase && hasNext && b && typeof b === "object" && !Array.isArray(b) && ["flags", "flags.khuzoe-automations"].includes(path);
    if ((objects && !literalKeys) || newContainer) result.push(...nativeDiff(a || {},b,type,permissions,path));
    else {
      const patch = { path, op: hasNext ? "set" : "delete", baseExists: hasBase, ...(hasBase ? {baseValue: clone(a)} : {}), ...(hasNext ? {value: clone(b)} : {}) };
      nativeValidatePatch(type,patch,permissions); result.push(patch);
    }
  }
  return result;
}
export function nativeApply(base, patches) { const next = clone(base); for (const patch of patches) nativeSet(next,patch.path,patch.value,patch.op === "delete"); return next; }
export function nativePatchSatisfied(source, patch) { return patch.op === "delete" ? !nativeHas(source,patch.path) : nativeHas(source,patch.path) && nativeValuePreserved(nativeGet(source,patch.path),patch.value,patch.baseValue); }
// Schemas may append defaults to new activities, damage parts or effect changes.
// Every requested value must survive; additional default keys are acceptable.
export function nativeValuePreserved(actual, wanted, previous) {
  if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length && wanted.every((value,index)=>nativeValuePreserved(actual[index],value,previous?.[index]));
  if (wanted && typeof wanted === "object") return actual && typeof actual === "object" && Object.entries(wanted).every(([key,value])=>Object.hasOwn(actual,key)&&nativeValuePreserved(actual[key],value,previous?.[key]))
    && (!previous || typeof previous !== "object" || Object.keys(previous).every(key=>Object.hasOwn(wanted,key)||!Object.hasOwn(actual,key)));
  return nativeEqual(actual,wanted);
}
export function nativePatchConflict(source, patch) { return !nativePatchSatisfied(source,patch) && (nativeHas(source,patch.path) !== patch.baseExists || (patch.baseExists && !nativeEqual(nativeGet(source,patch.path),patch.baseValue))); }
export const nativeTargetKey = target => `${target.type}:${target.itemId || ""}:${target.id}`;
function visibleFlags(flags, permissions) {
  const value = clone(flags || {}); delete value.core; delete value["cripta-wiki-sync"];
  const strip = object => { if (!object || typeof object !== "object") return; for (const key of Object.keys(object)) { if (key === "midiRollConfig" && !permissions.isAdmin) delete object[key]; else strip(object[key]); } };
  strip(value); return value;
}
export function nativeEntityData(source, type, permissions) {
  source = nativeEditorSource(source,type);
  const result = { name: source.name || "" };
  if (type === "ActiveEffect") for (const key of effectFields) { if (key !== "name" && key !== "flags" && Object.hasOwn(source,key)) result[key] = clone(source[key]); }
  else result.system = clone(source.system || {});
  result.flags = visibleFlags(source.flags, permissions);
  if (!permissions.isAdmin) {
    const strip = object => { if(!object||typeof object!=="object")return;for(const key of Object.keys(object)){if(key==="midiRollConfig")delete object[key];else strip(object[key]);} };strip(result);
  }
  return result;
}
// Older imports can store activity maps under a different key, or as arrays.
// The editor addresses the stable activity _id without rewriting that archive.
export function nativeActivitiesAmbiguous(source) { const ids=Object.entries(source.system?.activities||{}).map(([key,value])=>value?._id||key);return new Set(ids).size!==ids.length; }
export function nativeNormalizeEffect(effect) {
  const result=clone(effect),types=["custom","multiply","add","downgrade","upgrade","override"];
  const changes=result.system?.changes||result.changes||[];
  result.system={...result.system,changes:changes.map(change=>{const type=change.type||types[Number(change.mode)]||"add";return{key:String(change.key||""),type,value:change.value??"",phase:change.phase||"initial",priority:Number.isFinite(Number(change.priority))?Number(change.priority):({custom:0,multiply:10,add:20,subtract:20,downgrade:30,upgrade:40,override:50}[type]??0)};})};
  delete result.changes;
  if(result.duration&&!Object.hasOwn(result.duration,"value")&&!result.duration.units){const unit=["rounds","turns","seconds"].find(unit=>Number.isFinite(Number(result.duration[unit])));result.duration=unit?{value:Number(result.duration[unit]),units:unit,expiry:unit==="seconds"?null:"turnStart",expired:false}:{value:null,units:"seconds",expiry:null,expired:false};}
  if(!result.img&&result.icon)result.img=result.icon;delete result.icon;
  if(result.showIcon===undefined)result.showIcon=result.flags?.dae?.showIcon===true?2:result.flags?.dae?.showIcon===false?0:1;
  return result;
}
export function nativeEditorSource(source,type) {
  const result=clone(source);
  if(type === "Item" && Array.isArray(result.effects))result.effects=result.effects.map(effect=>{delete effect._stats;return nativeNormalizeEffect(effect);}).sort((a,b)=>String(a._id).localeCompare(String(b._id)));
  if(type === "Item" && result.system?.activities) {
    const entries=Object.entries(result.system.activities).map(([key,value])=>[value?._id||key,value]);
    if(!nativeActivitiesAmbiguous(result))result.system.activities=Object.fromEntries(entries);
  }
  return result;
}
// Check protected descendants as well: replacing a parent must not bypass the
// leaf policy or erase a setting hidden from the current account.
export function nativeValidateChanges(source, target, patches, permissions = {}) {
  source = nativeEditorSource(source,target.type);
  if (!Array.isArray(patches) || !patches.length || patches.length > 512) throw new Error("Seleziona da 1 a 512 campi da modificare.");
  const paths = patches.map(patch => patch.path);
  if (new Set(paths).size !== paths.length || paths.some((path,i) => paths.some((other,j) => i !== j && other.startsWith(path + ".")))) throw new Error("La richiesta contiene campi sovrapposti.");
  for (const patch of patches) nativeValidatePatch(target.type,patch,permissions);
  const next = nativeApply(source,patches);
  if (target.type === "Item" && nativeActivitiesAmbiguous(source) && (!nativeEqual(source.system?.activities,next.system?.activities)
    || !nativeEqual(source.flags?.["khuzoe-automations"]?.npcRules,next.flags?.["khuzoe-automations"]?.npcRules)
    || !nativeEqual(source.flags?.["khuzoe-automations"]?.midiRollConfig,next.flags?.["khuzoe-automations"]?.midiRollConfig))) throw new Error("Questa capacità contiene attività con identificativi duplicati. Correggile in Foundry prima di cambiarne le meccaniche.");
  const immutable = ["flags.core", "flags.cripta-wiki-sync"];
  if (target.type === "Actor") {
    immutable.push("system.source","system.advancement","system.sourceItem","system.attributes.prof");
    if (permissions.sharedRuntime === false) {
      immutable.push("system.attributes.hp.value","system.attributes.hp.temp");
      for (const slot of Object.keys(source.system?.spells || {})) immutable.push(`system.spells.${slot}.value`,`system.spells.${slot}.spent`);
    }
  } else if (target.type === "Item") immutable.push("system.source","system.advancement","system.sourceItem");
  const privateFields = (object,prefix="") => { if (!object || typeof object !== "object") return; for (const [key,value] of Object.entries(object)) { const path=prefix?`${prefix}.${key}`:key; if(key === "midiRollConfig") immutable.push(path); else if (!(target.type === "Item" && path === "effects")) privateFields(value,path); } };
  if (!permissions.isAdmin) { privateFields(source); privateFields(next); }
  if (immutable.some(path => !nativeEqual(nativeGet(source,path),nativeGet(next,path)))) throw new Error("La modifica include dati riservati o gestiti automaticamente.");
  if (target.type === "Item" && !nativeEqual(source.effects,next.effects)) {
    if (!permissions.embeddedEffects || !Array.isArray(next.effects) || next.effects.length > 64 || new Set(next.effects.map(e=>e._id)).size !== next.effects.length) throw new Error("Effetti non validi.");
    const hidden = value => { if(!value||typeof value!=="object")return false;return Object.entries(value).some(([key,child])=>key==="midiRollConfig"||hidden(child)); };
    for(const effect of next.effects) {
      const previous=(source.effects||[]).find(e=>e._id===effect._id);
      if(nativeEqual(previous,effect))continue;
      if(!/^[A-Za-z0-9]{16}$/.test(effect._id)||typeof effect.name!=="string"||!effect.name.trim())throw new Error("Effetto non valido.");
      for(const path of ["_stats","ownership","flags.core","flags.cripta-wiki-sync"])if(!nativeEqual(nativeGet(previous,path),nativeGet(effect,path)))throw new Error("L’effetto contiene dati gestiti automaticamente.");
      if(!permissions.isAdmin) {
        const privateOnly=(value)=>value&&typeof value==="object"?Object.fromEntries(Object.entries(value).filter(([key,child])=>key==="midiRollConfig"||hidden(child)).map(([key,child])=>[key,key==="midiRollConfig"?child:privateOnly(child)])):value;
        if(!nativeEqual(privateOnly(previous||{}),privateOnly(effect)))throw new Error("L’effetto contiene dati riservati.");
      }
    }
    if(!permissions.isAdmin && (source.effects||[]).some(effect=>hidden(effect)&&!next.effects.some(e=>e._id===effect._id)))throw new Error("Questo effetto contiene dati riservati.");
  }
  for (const [id,activity] of Object.entries(next.system?.activities || {})) {
    if(nativeEqual(activity,source.system?.activities?.[id]))continue;
    if (!/^[A-Za-z0-9]{16}$/.test(id) || activity?._id !== id || !activity.type) throw new Error("Attività non valida.");
    const previous = source.system?.activities?.[id];
    if (previous && (activity._id !== previous._id || activity.type !== previous.type)) throw new Error("Il tipo di un’attività esistente non può essere cambiato.");
  }
  return next;
}
export function nativeEntities(actor, permissions = {}) {
  const entities = [{ key:`Actor::${actor._id}`, target:{type:"Actor",id:actor._id}, name:actor.name, type:"Actor", category:"stats", data:nativeEntityData(actor,"Actor",permissions) }];
  for (const item of actor.items || []) {
    const category = item.type === "spell" ? "spells" : ["feat","weapon"].includes(item.type) ? "abilities" : "inventory";
    entities.push({key:nativeTargetKey({type:"Item",id:item._id}),target:{type:"Item",id:item._id},type:"Item",itemType:item.type,activityReadOnly:nativeActivitiesAmbiguous(item),name:item.name,img:item.img,category,data:nativeEntityData(item,"Item",permissions)});
    for (const effect of item.effects || []) entities.push({key:nativeTargetKey({type:"ActiveEffect",id:effect._id,itemId:item._id}),target:{type:"ActiveEffect",id:effect._id,itemId:item._id},type:"ActiveEffect",name:effect.name,img:effect.img,parentName:item.name,category:"effects",data:nativeEntityData(effect,"ActiveEffect",permissions)});
  }
  for (const effect of actor.effects || []) entities.push({key:nativeTargetKey({type:"ActiveEffect",id:effect._id}),target:{type:"ActiveEffect",id:effect._id},type:"ActiveEffect",name:effect.name,img:effect.img,category:"effects",data:nativeEntityData(effect,"ActiveEffect",permissions)});
  return entities;
}
export function nativeFindDocument(actor, target) {
  if (target?.type === "Actor") return target.id === actor._id ? actor : null;
  if (target?.type === "Item") return (actor.items || []).find(item => item._id === target.id) || null;
  if (target?.type === "ActiveEffect") { const parent = target.itemId ? (actor.items || []).find(item => item._id === target.itemId) : actor; return (parent?.effects || []).find(effect => effect._id === target.id) || null; }
  return null;
}
export function nativeNewId() { const bytes = new Uint8Array(8); crypto.getRandomValues(bytes); return Array.from(bytes, value => value.toString(16).padStart(2,"0")).join(""); }
export function nativeActivityTemplate(type, name = "Nuova attività") {
  const id = nativeNewId();
  const activity = {_id:id,type,name,activation:{type:"action",value:1,override:true},consumption:{targets:[],scaling:{allowed:false},spellSlot:false},description:{chatFlavor:""},duration:{units:"inst",override:true},effects:[],range:{value:"5",units:"ft",override:true},target:{affects:{count:"1",type:"creature",choice:false},template:{units:"ft"},prompt:true,override:true},uses:{spent:0,max:"",recovery:[]}};
  if (type === "attack") activity.damage={includeBase:false,parts:[],critical:{bonus:""}};
  if (type === "save") activity.damage={onSave:"none",parts:[]};
  if (type === "damage") activity.damage={parts:[],critical:{allow:false,bonus:""}};
  if (type === "attack") activity.attack={ability:"",bonus:"0",flat:true,type:{value:"melee",classification:"weapon"},critical:{threshold:null}};
  if (type === "save") activity.save={ability:["con"],dc:{calculation:"",formula:"10"}};
  if (type === "heal") activity.healing={number:1,denomination:8,bonus:"",types:["healing"],custom:{enabled:false,formula:""},scaling:{mode:"",number:null,formula:""}};
  if (type === "utility") activity.roll={prompt:false,visible:false,name:"",formula:""};
  return activity;
}
