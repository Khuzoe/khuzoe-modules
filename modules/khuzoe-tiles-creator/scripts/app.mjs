import {MODULE_ID} from './model.mjs';
import {renderTiles} from './view.mjs';
const Base=foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
let controller,windowInstance;
export function configureApp(value){controller=value;}
export function openTiles(){
  if(!game.user.isGM)return ui.notifications.warn('Tiles Creator è riservato al GM.');
  if(!canvas.ready)return ui.notifications.warn('Apri una scena.');
  windowInstance ||= new TilesCreatorWindow();windowInstance.render({force:true});void controller.open();return windowInstance;
}
export class TilesCreatorWindow extends Base{
  static DEFAULT_OPTIONS={id:MODULE_ID,classes:['khuzoe-tiles-creator'],window:{title:'Khuzoe · Tiles Creator',icon:'fa-solid fa-wand-magic-sparkles',resizable:true},position:{width:1000,height:780}};
  static PARTS={content:{template:`modules/${MODULE_ID}/templates/content.hbs`}};
  constructor(...args){super(...args);windowInstance=this;controller.onChange=()=>{if(this.rendered&&!controller.selecting)this.render();};controller.onSelecting=()=>this.minimize();controller.onSelected=async()=>{this.render({force:true});await this.maximize();};}
  async _prepareContext(options){return {...await super._prepareContext(options),content:renderTiles(controller)};}
  async _onFirstRender(context,options){await super._onFirstRender(context,options);void controller.open();}
  readForm(){
    const root=this.element;if(!root)return;
    if(!controller.busy&&!controller.job&&!controller.pending){const details=root.querySelector('[name=details]');if(details)controller.details=details.value;for(const key of ['quality','resolution']){const field=root.querySelector(`[name=${key}]`);if(field)controller.settings[key]=field.value;}}
    const feather=root.querySelector('[name=feather]');if(feather&&!feather.disabled)controller.settings.feather=Number(feather.value);
    if(!controller.busy&&!controller.job&&!controller.pending)for(const field of root.querySelectorAll('[data-reference-note]')){const reference=controller.references[Number(field.dataset.referenceNote)];if(reference)reference.note=field.value;}
  }
  async _onRender(context,options){
    await super._onRender(context,options);const root=this.element;
    root.querySelector('[name=details]')?.addEventListener('input',event=>{controller.details=event.target.value;controller.deferDraftSave();});
    root.querySelectorAll('[data-reference-note]').forEach(field=>field.addEventListener('input',()=>{this.readForm();controller.deferDraftSave();}));
    root.querySelector('[data-reference-files]')?.addEventListener('change',event=>{const files=Array.from(event.target.files);event.target.value='';this.readForm();void controller.addReferenceFiles(files);});
    root.querySelectorAll('select').forEach(field=>field.addEventListener('change',async()=>{this.readForm();if(field.name==='resolution')return void controller.recapture();controller.deferDraftSave();if(field.name==='feather'){try{await controller.compose();controller.emit();}catch(error){controller.error=error.message;controller.emit();}}}));
    root.querySelector('.ktc-content').addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;this.readForm();const action=button.dataset.action;if(action==='enlarge')return this.enlarge(button.dataset.src);if(action==='login')return controller.act(async()=>{await controller.client.login();await controller.open();});if(action==='refresh')return void controller.load();if(action==='referenceFiles')return root.querySelector('[data-reference-files]')?.click();if(action==='removeReference')return void controller.removeReference(Number(button.dataset.index));const method={select:'select',generate:'generate',stop:'stop',place:'place',refine:'refine',cancelRefinement:'cancelRefinement',erase:'erase',captureReference:'captureReference'}[action];if(method)void controller[method]();});
    if(controller.focusRequest&&!controller.busy&&!controller.job){controller.focusRequest=false;root.querySelector('[name=details]')?.focus();}
  }
  enlarge(src){
    const dialog=document.createElement('dialog');dialog.className='ktc-lightbox';const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label','Chiudi anteprima');const img=document.createElement('img');img.src=src;img.alt='Anteprima ingrandita';dialog.append(close,img);document.body.append(dialog);close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>dialog.remove());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});dialog.showModal();
  }
  async close(options){controller.close();return super.close(options);}
}
