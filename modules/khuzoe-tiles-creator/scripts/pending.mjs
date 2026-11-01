// Browser-local recovery only. No credentials, world settings or wiki data.
export class PendingDrafts{
  memory=new Map();
  async db(){return new Promise((resolve,reject)=>{const request=indexedDB.open('khuzoe-tiles-creator',1);request.onupgradeneeded=()=>request.result.createObjectStore('pending');request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});}
  async run(mode,key,value){
    const db=await this.db();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('pending',mode),store=tx.objectStore('pending');let result;const request=mode==='readonly'?store.get(key):value===undefined?store.delete(key):store.put(value,key);request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async get(key){try{return await this.run('readonly',key);}catch{return this.memory.get(key);}}
  async put(key,value){this.memory.set(key,value);try{await this.run('readwrite',key,value);return true;}catch{return false;}}
  async delete(key){this.memory.delete(key);try{await this.run('readwrite',key);}catch{}}
}
