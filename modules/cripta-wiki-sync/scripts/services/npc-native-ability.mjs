import {nativeActivityTemplate, nativeValidateValue} from "./npc-native-model.mjs";

export const NATIVE_ABILITY_FORMAT = "npc-native-ability-v1";
export const NATIVE_ABILITY_VERSION = 1;
const damageTypes=["acid","bludgeoning","cold","fire","force","lightning","necrotic","piercing","poison","psychic","radiant","slashing","thunder"];
const conditions=["blinded","charmed","deafened","frightened","grappled","incapacitated","invisible","paralyzed","petrified","poisoned","prone","restrained","stunned","unconscious"];
const abilities=["str","dex","con","int","wis","cha"];
const types=["attack","save","damage","heal","utility"];
const activations=["action","bonus","reaction","legendary","lair","special",""];
const clone=value=>JSON.parse(JSON.stringify(value));
const obj=properties=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const str={type:"string"},num={type:"integer"},choice=values=>({type:"string",enum:values}),array=items=>({type:"array",items});
// A bounded description of native D&D5e activities. IDs, Item documents and
// module settings are assembled by code, never invented by the model.
export const NATIVE_ABILITY_SCHEMA=obj({
 name:str,flavor:str,uses:num,recovery:choice(["day","lr","sr"]),
 activities:array(obj({key:str,name:str,type:choice(types),activation:obj({type:choice(activations),value:num}),
  range:obj({value:num,units:choice(["ft","m","self","touch"])}),
  target:obj({count:num,type:choice(["creature","ally","enemy","self"]),area:choice(["","cone","cube","cylinder","line","radius","sphere"]),size:num}),
  attack:obj({kind:choice(["melee","ranged"]),classification:choice(["weapon","spell","unarmed"]),bonus:num}),
  save:obj({ability:choice(abilities),dc:num,onSave:choice(["none","half","full"])}),
  damage:array(obj({formula:str,type:choice(damageTypes)})),
  healing:obj({formula:str,type:choice(["healing","temphp"])}),
  rules:obj({healing:{type:"number",enum:[0,0.5,1]},conditions:array(choice(conditions)),rounds:num,expiry:choice(["turnStart","turnEnd"])}),
  next:str
 })),balance:str,assumptions:array(str),unsupported:array(str),iconPrompt:str
});

function schemaValue(value,schema,path="proposta") {
 if(schema.type==="object") {keys(value,Object.keys(schema.properties),path);for(const key of schema.required)schemaValue(value[key],schema.properties[key],`${path}.${key}`);}
 else if(schema.type==="array") {if(!Array.isArray(value)||value.length>14)throw new Error(`${path}: elenco non valido.`);for(const child of value)schemaValue(child,schema.items,path);}
 else if(schema.type==="integer"?!Number.isInteger(value):schema.type==="number"?!Number.isFinite(value):typeof value!==schema.type)throw new Error(`${path}: valore non valido.`);
 if(schema.enum&&!schema.enum.includes(value))throw new Error(`${path}: scelta non valida.`);
 if(typeof value==="string")text(value,path,4000);
}
function keys(value,allowed,label) {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error(`${label}: campi non supportati.`);}
function text(value,label,max=4000) {if(typeof value!=="string"||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error(`${label}: testo non valido.`);}
function range(value,min,max,label) {if(!Number.isFinite(Number(value))||value===""||value===null||typeof value==="boolean"||Number(value)<min||Number(value)>max)throw new Error(`${label}: valore fuori intervallo.`);}
function formula(value,label="Danni") {
 text(value,label,80);const normalized=value.replace(/\s/g,"").toLowerCase();
 if(!/^(?:[1-9]|[1-3][0-9]|40)d(?:4|6|8|10|12|20)(?:[+-](?:[0-9]|[1-9][0-9]))?$|^(?:0|[1-9][0-9]{0,2})$/.test(normalized))throw new Error(`${label}: usa una formula semplice, per esempio 2d8+4.`);
 return normalized;
}
const escape=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const part=entry=>{const value=formula(entry.formula),dice=value.match(/^(\d+)d(\d+)([+-]\d+)?$/);return{number:dice?Number(dice[1]):1,denomination:dice?Number(dice[2]):6,bonus:dice?.[3]?String(Number(dice[3])):"",types:[entry.type],custom:{enabled:!dice,formula:dice?"":value},scaling:{mode:"",number:null,formula:""}};};
const typeNames={attack:"Attacco",save:"Tiro salvezza",damage:"Danni",heal:"Cura",utility:"Utilità"};

export function compileNativeAbilityProposal(input) {
 schemaValue(input,NATIVE_ABILITY_SCHEMA);
 if(!input.activities.length||input.activities.length>8)throw new Error("La proposta deve contenere da 1 a 8 attività.");
 const byKey=new Map(input.activities.map((activity,index)=>[activity.key,`KhzAiAct${String(index+1).padStart(8,"0")}`]));
 if(byKey.size!==input.activities.length||input.activities.some(a=>!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(a.key)))throw new Error("Le attività devono avere riferimenti distinti.");
 const activities={},rules={version:1,activities:{}};
 for(const source of input.activities) {
  const id=byKey.get(source.key),activity=nativeActivityTemplate(source.type,source.name||typeNames[source.type]);activity._id=id;
  activity.activation={...source.activation,override:true};
  activity.range={...source.range,value:String(source.range.value),override:true};
  activity.target={affects:{count:String(source.target.count),type:source.target.type,choice:false},template:{type:source.target.area,size:source.target.area?String(source.target.size):"",units:source.range.units==="m"?"m":"ft"},prompt:true,override:true};
  if(input.uses&&source.activation.type)activity.consumption.targets=[{type:"itemUses",value:"1",target:"",scaling:{mode:""}}];
  if(source.type==="attack")activity.attack={ability:"",bonus:String(source.attack.bonus),flat:true,type:{value:source.attack.kind,classification:source.attack.classification},critical:{threshold:null}};
  if(["attack","save","damage"].includes(source.type))activity.damage={...(activity.damage||{}),includeBase:false,parts:source.damage.map(part),onSave:source.save.onSave,critical:{allow:source.type==="attack",bonus:""}};
  else if(source.damage.length)throw new Error("I danni richiedono un’attività di attacco, TS o danno.");
  if(source.type==="save")activity.save={ability:[source.save.ability],dc:{calculation:"",formula:String(source.save.dc)}};
  if(source.type==="heal")activity.healing=part({formula:source.healing.formula,type:source.healing.type});
  else if(source.healing.formula)throw new Error("La cura diretta richiede un’attività Cura.");
  if(source.rules.healing||source.rules.conditions.length)rules.activities[id]=clone(source.rules);
  if(source.next) {
   if(source.type!=="attack"||!byKey.has(source.next)||source.next===source.key)throw new Error("Il seguito automatico richiede un attacco e un’attività distinta.");
   activity.midiProperties={triggeredActivityId:byKey.get(source.next),triggeredActivityTargets:"hitTargets",triggeredActivityRollAs:"self",triggeredActivityConsume:false,triggeredActivityConfigure:false};
  }
  activities[id]=activity;
 }
 for(const activity of Object.values(activities))if(activity.midiProperties?.triggeredActivityId) {
  const next=activities[activity.midiProperties.triggeredActivityId];next.activation={type:"",value:0,override:true};next.consumption.targets=[];if(next.damage)next.damage.critical={allow:false,bonus:""};
 }
 const item={name:input.name,type:"feat",effects:[],system:{type:{value:"monster",subtype:""},description:{value:input.flavor?`<p>${escape(input.flavor)}</p>`:""},uses:{max:input.uses?String(input.uses):"",spent:0,recovery:input.uses?[{period:input.recovery,type:"recoverAll"}]:[]},activities},flags:{"khuzoe-automations":{npcRules:rules}}};
 const draft={version:1,item,balance:input.balance,assumptions:input.assumptions,unsupported:input.unsupported,iconPrompt:input.iconPrompt};
 return validateNativeAbilityDraft(draft);
}

function validatePart(value,healing=false) {
 keys(value,["number","denomination","bonus","types","custom","scaling"],healing?"Cura":"Danni");
 if(!Array.isArray(value.types)||!value.types.length||value.types.some(type=>!(healing?["healing","temphp"]:damageTypes).includes(type)))throw new Error("Tipo di danno o cura non valido.");
 if(value.custom?.enabled)formula(value.custom.formula,healing?"Cura":"Danni");
 else {range(value.number,1,40,"Numero di dadi");if(!Number.isInteger(value.number)||![4,6,8,10,12,20].includes(value.denomination))throw new Error("Dado non valido.");if(value.bonus!==""&&value.bonus!==undefined)range(value.bonus,-99,99,"Bonus ai danni");}
 if(value.custom)keys(value.custom,["enabled","formula"],"Formula personalizzata");
 if(value.scaling){keys(value.scaling,["mode","number","formula"],"Incremento");if(value.scaling.mode||value.scaling.formula)throw new Error("Gli incrementi automatici vanno configurati dopo la creazione.");}
}
export function validateNativeAbilityItem(item) {
 nativeValidateValue(item);keys(item,["name","type","system","flags","effects"],"Capacità");text(item.name,"Nome",180);if(!item.name.trim()||item.type!=="feat")throw new Error("Nome o tipo di capacità non valido.");
 if(!Array.isArray(item.effects)||item.effects.length)throw new Error("Per i nuovi effetti usa le condizioni dell’attività.");
 const s=item.system;keys(s,["type","description","uses","activities"],"Capacità");
 keys(s.type,["value","subtype"],"Tipo");if(s.type.value!=="monster"||s.type.subtype!=="")throw new Error("Tipo di capacità non supportato.");
 keys(s.description,["value"],"Descrizione");text(s.description.value,"Descrizione",16000);
 if(/<\s*\/?(?:script|style|iframe|object|embed|link|meta)\b|\bon\w+\s*=|javascript:|data:|@(?:Macro|UUID|Embed)\[/i.test(s.description.value))throw new Error("La descrizione contiene elementi non supportati.");
 keys(s.uses,["max","spent","recovery"],"Utilizzi");if(s.uses.max!=="")range(s.uses.max,1,20,"Utilizzi");if(s.uses.spent!==0)throw new Error("Una nuova capacità parte con tutti gli utilizzi disponibili.");
 if(!Array.isArray(s.uses.recovery)||s.uses.recovery.length>1||s.uses.recovery.some(entry=>{keys(entry,["period","type"],"Recupero");return !["day","lr","sr"].includes(entry.period)||entry.type!=="recoverAll";}))throw new Error("Recupero utilizzi non valido.");
 keys(item.flags,["khuzoe-automations"],"Automazioni");keys(item.flags["khuzoe-automations"],["npcRules"],"Automazioni");
 const r=item.flags["khuzoe-automations"].npcRules;keys(r,["version","activities"],"Effetti");if(r.version!==1)throw new Error("Versione effetti non supportata.");
 keys(s.activities,Object.keys(s.activities||{}),"Attività");const entries=Object.entries(s.activities);if(!entries.length||entries.length>8)throw new Error("Inserisci da 1 a 8 attività.");
 for(const [id,a]of entries) {
  keys(a,["_id","type","name","activation","consumption","description","duration","effects","range","target","uses","attack","save","damage","healing","roll","midiProperties"],"Attività");
  if(!/^[A-Za-z0-9]{16}$/.test(id)||a._id!==id||!types.includes(a.type))throw new Error("Identità o tipo dell’attività non validi.");text(a.name,"Nome attività",180);
  if([a.activation,a.range,a.target,a.duration].some(value=>value?.override!==true))throw new Error("La proposta deve usare le impostazioni esplicite dell’attività.");
  keys(a.activation,["type","value","override","condition"],"Attivazione");if(!activations.includes(a.activation.type))throw new Error("Attivazione non supportata.");range(a.activation.value,0,5,"Costo azione");
  keys(a.range,["value","units","override","special"],"Distanza");if(!["ft","m","self","touch"].includes(a.range.units))throw new Error("Unità non supportata.");range(a.range.value,0,600,"Portata");
  keys(a.target,["affects","template","prompt","override"],"Bersagli");keys(a.target.affects,["count","type","choice","special"],"Bersagli");range(a.target.affects.count,1,99,"Numero bersagli");if(!["creature","ally","enemy","self"].includes(a.target.affects.type))throw new Error("Bersagli non supportati.");
  keys(a.target.template,["type","size","width","height","units","contiguous"],"Area");if(![undefined,"","cone","cube","cylinder","line","radius","sphere"].includes(a.target.template.type))throw new Error("Area non supportata.");for(const key of ["size","width","height"])if(a.target.template[key]!==undefined&&a.target.template[key]!=="")range(a.target.template[key],0,600,"Area");if(a.target.template.type)range(a.target.template.size,1,600,"Dimensione dell’area");
  keys(a.description,["chatFlavor"],"Testo in chat");text(a.description.chatFlavor,"Testo in chat",2000);keys(a.duration,["units","override"],"Durata");if(a.duration.units!=="inst")throw new Error("Usa le condizioni per impostare la durata degli effetti.");
  if(!Array.isArray(a.effects)||a.effects.length)throw new Error("Usa le condizioni per collegare effetti alla nuova attività.");
  keys(a.uses,["spent","max","recovery"],"Utilizzi attività");if(a.uses.spent!==0||a.uses.max!==""||!Array.isArray(a.uses.recovery)||a.uses.recovery.length)throw new Error("Imposta gli utilizzi sulla capacità.");
  keys(a.consumption,["targets","scaling","spellSlot"],"Consumo");if(a.consumption.spellSlot||a.consumption.scaling?.allowed)throw new Error("Consumo non supportato.");keys(a.consumption.scaling,["allowed"],"Consumo");
  if(!Array.isArray(a.consumption.targets)||a.consumption.targets.length>1)throw new Error("Consumo non valido.");
  for(const target of a.consumption.targets){keys(target,["type","value","target","scaling"],"Consumo");if(target.type!=="itemUses"||target.target!==""||Number(target.value)!==1||!s.uses.max)throw new Error("La capacità può consumare un proprio utilizzo.");keys(target.scaling,["mode"],"Consumo");if(target.scaling.mode)throw new Error("Consumo non supportato.");}
  if(a.type==="attack"){keys(a.attack,["ability","bonus","flat","type","critical"],"Attacco");if(a.attack.flat!==true||a.attack.ability)throw new Error("Usa il bonus finale per colpire.");range(a.attack.bonus,-10,40,"Bonus attacco");keys(a.attack.type,["value","classification"],"Attacco");if(!["melee","ranged"].includes(a.attack.type.value)||!["weapon","spell","unarmed"].includes(a.attack.type.classification))throw new Error("Attacco non valido.");keys(a.attack.critical,["threshold"],"Critico");if(a.attack.critical.threshold!==null)range(a.attack.critical.threshold,1,20,"Critico");}else if(a.attack)throw new Error("Attacco su un’attività non compatibile.");
  if(a.type==="save"){keys(a.save,["ability","dc"],"TS");if(!Array.isArray(a.save.ability)||!a.save.ability.length||a.save.ability.some(value=>!abilities.includes(value)))throw new Error("Caratteristica del TS non valida.");keys(a.save.dc,["calculation","formula"],"CD");if(a.save.dc.calculation)throw new Error("Usa una CD fissa nella proposta.");range(a.save.dc.formula,1,40,"CD");}else if(a.save)throw new Error("TS su un’attività non compatibile.");
  if(["attack","save","damage"].includes(a.type)){keys(a.damage,["includeBase","parts","onSave","critical"],"Danni");if(a.damage.includeBase||!Array.isArray(a.damage.parts)||a.damage.parts.length>12)throw new Error("Danni non validi.");for(const value of a.damage.parts)validatePart(value);if(a.damage.onSave!==undefined&&!["none","half","full"].includes(a.damage.onSave))throw new Error("Danno con TS riuscito non valido.");if(a.damage.critical){keys(a.damage.critical,["allow","bonus"],"Critico");if(a.damage.critical.bonus)formula(a.damage.critical.bonus,"Bonus critico");}if(a.type==="damage"&&!a.damage.parts.length)throw new Error("Mancano i danni dell’attività.");}else if(a.damage)throw new Error("Danni su un’attività non compatibile.");
  if(a.type==="heal")validatePart(a.healing,true);else if(a.healing)throw new Error("Cura su un’attività non compatibile.");
  if(a.roll){keys(a.roll,["prompt","visible","name","formula"],"Tiro");if(a.roll.formula)throw new Error("Tiri aggiuntivi non supportati dalla proposta.");}
  if(a.midiProperties){keys(a.midiProperties,["triggeredActivityId","triggeredActivityTargets","triggeredActivityRollAs","triggeredActivityConsume","triggeredActivityConfigure"],"Attività successiva");const m=a.midiProperties;if(a.type!=="attack"||!Object.hasOwn(s.activities,m.triggeredActivityId)||id===m.triggeredActivityId||m.triggeredActivityTargets!=="hitTargets"||m.triggeredActivityRollAs!=="self"||m.triggeredActivityConsume!==false||m.triggeredActivityConfigure!==false)throw new Error("Collegamento delle attività non valido.");const next=s.activities[m.triggeredActivityId];if(next.activation.type||next.activation.value||next.consumption.targets.length||next.damage?.critical?.allow)throw new Error("L’attività successiva non deve consumare un’altra azione o utilizzo, né aggiungere un critico.");}
 }
 keys(r.activities,Object.keys(s.activities),"Effetti delle attività");
 for(const [id,rule]of Object.entries(r.activities)){keys(rule,["healing","healingTypes","conditions","rounds","expiry"],"Effetto");if(!Array.isArray(rule.healingTypes??[])||(rule.healingTypes??[]).some(type=>!damageTypes.includes(type))||![0,0.5,1].includes(rule.healing)||!Array.isArray(rule.conditions)||rule.conditions.some(value=>!conditions.includes(value))||!Number.isInteger(rule.rounds)||rule.rounds<0||rule.rounds>100||!["turnStart","turnEnd"].includes(rule.expiry))throw new Error("Effetto dell’attività non valido.");if(rule.healing&&(!["attack","save","damage"].includes(s.activities[id].type)||!s.activities[id].damage?.parts.length))throw new Error("La cura dai danni richiede danni effettivi.");if(rule.conditions.length&&s.activities[id].type==="heal")throw new Error("Condizioni non supportate per una cura diretta.");}
 for(const [id]of entries){const seen=new Set([id]);let next=s.activities[id].midiProperties?.triggeredActivityId;while(next){if(seen.has(next))throw new Error("Le attività contengono un collegamento circolare.");seen.add(next);next=s.activities[next].midiProperties?.triggeredActivityId;}}
 if(new TextEncoder().encode(JSON.stringify(item)).length>96000)throw new Error("Capacità troppo estesa.");
 return clone(item);
}
export function validateNativeAbilityDraft(input) {
 keys(input,["version","item","balance","assumptions","unsupported","iconPrompt"],"Proposta");if(input.version!==1)throw new Error("Versione della proposta non supportata.");
 const item=validateNativeAbilityItem(input.item);for(const key of ["balance","iconPrompt"])text(input[key],key,4000);
 for(const key of ["assumptions","unsupported"]){if(!Array.isArray(input[key])||input[key].length>12)throw new Error("Elenco non valido.");for(const value of input[key])text(value,key,2000);}
 return {...clone(input),item};
}
export function nativeAbilitySummary(draft) {
 const item=draft.item,lines=[];
 const labels={acid:"acido",bludgeoning:"contundenti",cold:"da freddo",fire:"da fuoco",force:"da forza",lightning:"da fulmine",necrotic:"necrotici",piercing:"perforanti",poison:"da veleno",psychic:"psichici",radiant:"radiosi",slashing:"taglienti",thunder:"da tuono",str:"Forza",dex:"Destrezza",con:"Costituzione",int:"Intelligenza",wis:"Saggezza",cha:"Carisma",blinded:"Accecato",charmed:"Affascinato",deafened:"Assordato",frightened:"Spaventato",grappled:"Afferrato",incapacitated:"Incapacitato",invisible:"Invisibile",paralyzed:"Paralizzato",petrified:"Pietrificato",poisoned:"Avvelenato",prone:"Prono",restrained:"Trattenuto",stunned:"Stordito",unconscious:"Privo di sensi",action:"Azione",bonus:"Azione bonus",reaction:"Reazione",legendary:"Azione leggendaria",lair:"Azione di tana",special:"Speciale"};
 const expression=value=>value.custom?.enabled?value.custom.formula:`${value.number}d${value.denomination}${value.bonus?`${String(value.bonus).startsWith("-")?"":"+"}${value.bonus}`:""}`;
 if(item.system.uses.max)lines.push(`${item.system.uses.max} utilizzi · ${{day:"ogni giorno",lr:"riposo lungo",sr:"riposo breve"}[item.system.uses.recovery[0]?.period]||"recupero da impostare"}.`);
 for(const activity of Object.values(item.system.activities)) {
  const parts=activity.damage?.parts?.map(value=>`${expression(value)} ${value.types.map(type=>labels[type]||type).join(", ")}`).join(" + ");
  lines.push(`${activity.name||typeNames[activity.type]}${activity.activation.type?` · ${labels[activity.activation.type]||activity.activation.type}`:""} · ${typeNames[activity.type]}${activity.type==="attack"?` ${activity.attack.type.classification==="spell"?"con incantesimo · ":"· "}${Number(activity.attack.bonus)>=0?"+":""}${activity.attack.bonus} per colpire`:activity.type==="save"?` ${activity.save.ability.map(value=>labels[value]||value).join("/")} CD ${activity.save.dc.formula}`:""}${parts?` · ${parts}`:""}${activity.healing?` · ${expression(activity.healing)} PF${activity.healing.types.includes("temphp")?" temporanei":""}`:""}.`);
  if(activity.midiProperties?.triggeredActivityId)lines.push(`Dopo un colpo riuscito attiva ${item.system.activities[activity.midiProperties.triggeredActivityId]?.name||"l’attività successiva"} sui bersagli colpiti.`);
  const rule=item.flags["khuzoe-automations"].npcRules.activities[activity._id];if(rule?.healing)lines.push(`Recupera il ${rule.healing*100}% dei danni effettivamente inflitti da ${activity.name}.`);if(rule?.conditions.length)lines.push(`${activity.type==="save"?"Con TS fallito: ":activity.type==="attack"?"Se colpisce: ":""}${rule.conditions.map(value=>labels[value]||value).join(", ")} · ${rule.rounds?`${rule.rounds} round, ${rule.expiry==="turnStart"?"inizio":"fine"} del turno`:"fino alla rimozione"}.`);
 }
 return lines;
}
