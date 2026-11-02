import {MAX_REFERENCES,MAX_REFERENCE_BYTES,MAX_REFERENCE_TOTAL_BYTES,MAX_REFERENCE_EDGE,MAX_RESULT_BYTES} from './model.mjs';

export function referenceSize(width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>50000000)throw new Error('Immagine di riferimento troppo grande o non valida.');
  const scale=Math.min(1,MAX_REFERENCE_EDGE/Math.max(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
export function checkReferences(references){
  if(references.length>MAX_REFERENCES)throw new Error(`Puoi allegare fino a ${MAX_REFERENCES} reference secondarie.`);
  if(references.reduce((size,reference)=>size+reference.blob.size,0)>MAX_REFERENCE_TOTAL_BYTES)throw new Error('Le reference sono troppo pesanti insieme (massimo 6 MB dopo la preparazione). Rimuovine qualcuna.');
}
export async function prepareReference(blob,{name='Reference',kind='file'}={}){
  if(!['image/png','image/jpeg','image/webp'].includes(blob.type)||!blob.size||blob.size>MAX_RESULT_BYTES)throw new Error('Scegli un’immagine PNG, JPG o WebP fino a 12 MB.');
  let image;try{image=await createImageBitmap(blob);}catch{throw new Error('Non riesco a leggere questa immagine di riferimento.');}
  try{
    const size=referenceSize(image.width,image.height),canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
    canvas.getContext('2d').drawImage(image,0,0,size.width,size.height);
    const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.9));
    if(!output||output.type!=='image/webp'||output.size>MAX_REFERENCE_BYTES)throw new Error('Questa reference è troppo pesante dopo la preparazione (massimo 2 MB). Scegli un’immagine più semplice.');
    return {...size,name:String(name).replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,120)||'Reference',kind,note:'',blob:output};
  }finally{image.close();}
}
export const imageDataUrl=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Impossibile leggere un’immagine da inviare.'));reader.readAsDataURL(blob);});
