import {MODULE_ID} from './model.mjs';
import {TilesController} from './controller.mjs';
import {configureApp,openTiles,TilesCreatorWindow} from './app.mjs';
import {cancelSelection} from './capture.mjs';
const controller=new TilesController();configureApp(controller);
Hooks.once('init',()=>{
  game.settings.registerMenu(MODULE_ID,'open',{name:'Tiles Creator',label:'Apri Tiles Creator',hint:'Modifica un’area della scena con AI.',icon:'fa-solid fa-wand-magic-sparkles',type:TilesCreatorWindow,restricted:true});
  game.keybindings.register(MODULE_ID,'open',{name:'Apri Tiles Creator',editable:[{key:'KeyT',modifiers:['Shift','Alt']}],restricted:true,onDown:()=>{openTiles();return true;}});
});
Hooks.on('getSceneControlButtons',controls=>{
  const tiles=Array.isArray(controls)?controls.find(c=>c.name==='tiles'):controls.tiles;
  if(!tiles?.tools)return;
  const tool={name:MODULE_ID,title:'Modifica area con AI',icon:'fa-solid fa-wand-magic-sparkles',button:true,visible:game.user.isGM,onChange:()=>openTiles()};
  if(Array.isArray(tiles.tools))tiles.tools.push({...tool,onClick:openTiles});else tiles.tools[MODULE_ID]={...tool,order:Object.keys(tiles.tools).length};
});
Hooks.on('canvasTearDown',()=>{cancelSelection();controller.close();});
Hooks.on('khuzoeWikiSync.authChanged',()=>{controller.reset();controller.emit();});
Hooks.once('ready',()=>{game.modules.get(MODULE_ID).api=Object.freeze({open:openTiles});});
