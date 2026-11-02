import {MODULE_ID,contextKey} from './model.mjs';
const WORKER='https://sigillo-api.khuzoe.workers.dev';
export class TilesClient {
  get bridge(){return game.modules.get('cripta-wiki-sync')?.api?.calendar;}
  get context(){
    const context=this.bridge?.getContext()||{};
    return {...context,worldId:game.world?.id,sceneId:canvas.scene?.id,levelId:canvas.level?.id||canvas.scene?._view};
  }
  identity(){const c=this.context;return `${contextKey(c)}:${c.identityVersion}`;}
  assert(origin){if(this.identity()!==origin)throw new Error('Mondo, scena, livello o account sono cambiati. Riapri Tiles Creator nella scena originale.');}
  async login(){if(!this.bridge)throw new Error('Attiva Khuzoe Wiki Sync.');await this.bridge.login();}
  async request(action='',body,jobId){
    const c=this.context,origin=this.identity();
    if(!game.user.isGM)throw new Error('Tiles Creator è riservato al GM.');
    if(!c.campaignId||!c.sceneId||!c.levelId)throw new Error('Apri una scena e seleziona la campagna in Wiki Sync.');
    if(!c.authenticated)throw new Error('Accedi alla wiki con il tuo account DM.');
    if(body!==undefined&&!c.remoteWrites)throw new Error('Wiki Sync è in modalità sola lettura. Abilita le scritture per generare un tile.');
    const context={campaignId:c.campaignId,worldId:c.worldId,sceneId:c.sceneId,levelId:c.levelId};
    const url=new URL(`${WORKER}/api/tiles/generations${action?`/${encodeURIComponent(jobId)}/${action}`:''}`);
    Object.entries(context).forEach(([key,value])=>url.searchParams.set(key,value));
    const token=String(game.settings.get('cripta-wiki-sync','discordToken')||'').trim();
    const response=await fetch(url,{method:body===undefined?'GET':'POST',cache:'no-store',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify({...body,context})})});
    this.assert(origin);
    if(!response.ok){const result=await response.json().catch(()=>({}));throw Object.assign(new Error(result.error||(response.status===404?'Pubblica il Worker aggiornato per attivare Tiles Creator.':`Servizio non disponibile (${response.status}).`)),{status:response.status});}
    if(action==='preview'||action==='source'||/^reference-/.test(action))return response.blob();
    const result=await response.json();if(result.campaignId&&result.campaignId!==c.campaignId)throw new Error('Il risultato appartiene a un’altra campagna.');
    return result;
  }
  pendingKey(){return `${MODULE_ID}:pending:${game.user.id}:${this.identity()}`;}
}
