import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/khuzoe-boss-bar.js", import.meta.url), "utf8");
function element(id, rect, navigation = false) {
  const values = new Set();
  return {id, rect, style:{setProperty(k,v){this[k]=v;},removeProperty(k){delete this[k];}},
    dataset:{}, classList:{add:v=>values.add(v),remove:(...items)=>items.forEach(v=>values.delete(v)),
      contains:v=>values.has(v),toggle(v,enabled){enabled ? values.add(v) : values.delete(v);}},
    closest:selector => navigation && selector === "#scene-navigation" ? {} : null,
    getBoundingClientRect(){return {...this.rect};},querySelector(){return null;}};
}

function fixture(anchor = "top") {
  const selectors = new Map(), frames = [], observations = [];
  const rect = (left,top,width,height) => ({left,top,width,height,right:left+width,bottom:top+height});
  const root = element("khbb-root", rect(0,10,1000,66));
  root.getBoundingClientRect = function() {
    const width = this.classList.contains("khbb-minimized") ? 38 : Number.parseFloat(this.style.width) || 1000;
    const height = this.classList.contains("khbb-minimized") ? 38 : 66;
    const left = Number.parseFloat(this.style.left) || 0;
    const top = this.style.top === "auto" ? 800 - (Number.parseFloat(this.style.bottom) || 0) - height : Number.parseFloat(this.style.top) || 10;
    return rect(left,top,width,height);
  };
  const shell = element("interface",rect(0,0,1200,800));
  const state = {version:1,entries:[{id:"boss",name:"Boss",pct:1}],updatedAt:1};
  const observer = class {constructor(callback){this.callback=callback;}disconnect(){}observe(target){observations.push(target.id);}};
  const context = vm.createContext({console, canvas:{}, document:{
    getElementById:id => id === "khbb-root" ? root : id === "interface" ? shell : null,
    querySelectorAll:query => [...new Set(query.split(",").flatMap(s=>selectors.get(s.trim()) || []))]
  },game:{user:{id:"gm",isGM:true},i18n:{localize:k=>k},settings:{get:(_id,key)=>key === "screenAnchor" ? anchor : state,async set(){}}},
    Hooks:{once(){},on(){}},ResizeObserver:observer,MutationObserver:observer,
    window:{innerWidth:1200,innerHeight:800, getComputedStyle:e=>({display:"block",visibility:e.visibility||"visible",opacity:"1",minHeight:"66px"}),
      requestAnimationFrame:fn=>(frames.push(fn),frames.length),setTimeout:()=>1,clearTimeout(){},removeEventListener(){}}
  });
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  return {root,context,run,selectors,observations,frames,rect,add(selector,id,left,top,width,height,nav=false){
    const node=element(id,rect(left,top,width,height),nav);selectors.set(selector,[...(selectors.get(selector)||[]),node]);return node;
  }};
}

test("startup notifications cannot push an automatically anchored bar into the middle", () => {
  const f=fixture();
  for(let i=0;i<5;i++)f.add("#notifications > *","notification"+i,240,80+i*118,720,110);
  f.run("applyRootPosition()");
  assert.equal(f.root.style.top,"10px");
  assert.equal(f.root.style.bottom,"auto");
});

test("V14 vertical navigation is reserved horizontally rather than below its full-height menus", () => {
  const f=fixture();
  f.add("#scene-controls","controls",16,16,72,360);
  f.add("#scene-navigation > *","active-menu",104,16,200,480,true);
  for(let i=0;i<8;i++)f.add("#scene-navigation .scene","scene"+i,104,16+i*42,200,34,true);
  f.add("#sidebar","sidebar",900,0,300,800);
  f.run("applyRootPosition()");
  assert.equal(f.root.style.top,"10px");assert.equal(f.root.style.left,"318px");assert.equal(f.root.style.width,"568px");
  for(const node of f.selectors.get("#scene-navigation .scene"))node.visibility="hidden";
  f.run("applyRootPosition()");assert.equal(f.root.style.left,"102px");
});

test("legacy horizontal navigation still has room, but full-height containers do not", () => {
  const f=fixture();const navigation=f.add("#navigation","navigation",100,8,700,36);
  f.run("applyRootPosition()");assert.equal(f.root.style.top,"54px");
  navigation.rect=f.rect(100,8,700,780);
  f.run("applyRootPosition()");assert.equal(f.root.style.top,"10px");
});

test("bottom anchoring avoids the hotbar without following temporary notifications", () => {
  const f=fixture("bottom");f.add("#hotbar","hotbar",300,710,600,80);
  f.add("#notifications > *","notification",240,400,720,300);
  f.run("applyRootPosition()");assert.equal(f.root.style.top,"auto");assert.equal(f.root.style.bottom,"100px");
});

test("layout tracking follows the V14 navigation when it expands or is replaced", () => {
  const f=fixture();f.add("#scene-navigation","scene-navigation",104,16,230,750,true);
  f.run("initializeLayoutTracking()");
  assert.ok(f.observations.includes("scene-navigation"));
  f.run("scheduleLayoutRefresh()");f.frames.shift()();assert.equal(f.root.style.top,"10px");
});

test("hide and restore do not convert an automatic layout into a manual position", async () => {
  const f=fixture();f.run("renderBossBars=()=>{};");
  await f.run("hideBars()");
  assert.equal(f.run("manualPosition"),null);assert.equal(f.run("manualSize"),null);
});

test("clicks on drag or resize handles preserve automatic placement until there is an actual movement", async () => {
  const f=fixture();
  f.run("dragState={pointerId:1,moved:false};");await f.run("onDragEnd({pointerId:1})");
  assert.equal(f.run("manualPosition"),null);
  f.root.classList.add("khbb-minimized");
  f.run("dragState={pointerId:1,moved:false};");await f.run("onDragEnd({pointerId:1})");
  assert.equal(f.run("minimizedPosition"),null);
  f.root.classList.remove("khbb-minimized");
  f.run("resizeState={pointerId:1,moved:false};onResizeEnd({pointerId:1});");
  assert.equal(f.run("manualSize"),null);assert.equal(f.run("manualBarHeight"),null);
});

test("deliberate manual placement remains stable after layout updates and hiding", async () => {
  const f=fixture();f.root.style.top="280px";
  f.run("dragState={pointerId:1,moved:true};");await f.run("onDragEnd({pointerId:1})");
  assert.equal(f.run("manualPosition.y"),280);
  f.run("renderBossBars=()=>{};");await f.run("hideBars()");
  f.run("applyRootPosition()");assert.equal(f.root.style.top,"280px");
});
