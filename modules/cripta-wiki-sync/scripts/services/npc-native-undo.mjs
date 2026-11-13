import {nativeEqual,nativeDiff,nativeEditorSource} from './npc-native-model.mjs';

const clone=structuredClone,object=v=>v&&typeof v==='object'&&!Array.isArray(v);
// Undo only the intent of a write. Fields outside before -> expected remain
// current, including updates received while this operation was in flight.
function restore(before,expected,current,path='') {
 if(nativeEqual(before,expected))return clone(current);
 if(nativeEqual(current,before))return clone(current);
 if(nativeEqual(current,expected))return before===undefined?undefined:clone(before);
 if(object(before)&&object(expected)&&object(current)){
  const result=clone(current);
  for(const key of new Set([...Object.keys(before),...Object.keys(expected)])){
   if(nativeEqual(before[key],expected[key])&&Object.hasOwn(before,key)===Object.hasOwn(expected,key))continue;
   const value=restore(before[key],expected[key],current[key],path?`${path}.${key}`:key);
   if(value===undefined)delete result[key];else result[key]=value;
  }
  return result;
 }
 if(Array.isArray(before)&&Array.isArray(expected)&&Array.isArray(current)&&[...before,...expected,...current].every(v=>object(v)&&typeof v._id==='string')){
  const result=clone(current);
  for(const id of new Set([...before,...expected].map(v=>v._id))){
   const old=before.find(v=>v._id===id),wanted=expected.find(v=>v._id===id),index=result.findIndex(v=>v._id===id),value=restore(old,wanted,index<0?undefined:result[index],`${path}.${id}`);
   if(value===undefined){if(index>=0)result.splice(index,1);}else if(index<0)result.push(value);else result[index]=value;
  }
  return result;
 }
 throw new Error(`${path||'Documento'}: valore modificato da un’altra operazione. Il ripristino lo conserva.`);
}
export function nativeUndoPatches(before,expected,current,type,permissions={}){
 const a=nativeEditorSource(before,type),b=nativeEditorSource(expected,type),now=nativeEditorSource(current,type),restored=restore(a,b,now);
 return nativeDiff(now,restored,type,{...permissions,embeddedEffects:true});
}
