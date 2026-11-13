import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/khuzoe-boss-bar.js", import.meta.url), "utf8");
const translations = JSON.parse(readFileSync(new URL("../lang/it.json", import.meta.url), "utf8"));
function fixture() {
  let saved = null;
  let state = {entries:[], updatedAt:1};
  const context = vm.createContext({console, Hooks:{once(){}, on(){}}, canvas:{}, window:{},
    game:{user:{id:"gm",isGM:true}, actors:new Map(), scenes:new Map(),
      settings:{get:() => state, async set(_id, _key, value){saved = value; state = value;}},
      i18n:{localize:key => translations[key] ?? key}},
    ui:{notifications:{error:message => {throw Error(message);}}}
  });
  vm.runInContext(source, context);
  return {context, run:code => vm.runInContext(code, context),
    setState(value){state = value;}, saved:() => saved};
}
const npc = (name, type, traits = {}, items = []) => ({id:"actor",name,
  system:{details:{type:{value:type}},traits,attributes:{hp:{value:20,max:100}}},items});
const activity = type => ({name:"Attack",system:{activities:new Map([["a",{damage:{parts:[{types:new Set([type])}]}}]])}});

test("detects creature identities and structured modern damage without treating generic defenses as a theme", () => {
  const {context, run} = fixture();
  const cases = [
    [npc("Drago rosso", "dragon", {di:{value:new Set(["fire"])}}), "flame"],
    [npc("White Dragon", "dragon", {di:{value:["cold"]}}), "frost"],
    [npc("Il Custode", "undead", {di:{value:["poison"]}}, [activity("poison")]), "death"],
    [npc("The Watcher", "celestial"), "radiant"],
    [npc("Sentinella", "construct"), "iron"],
    [npc("Antico", "plant"), "nature"],
    [npc("Osservatore", "aberration"), "arcane"],
    [npc("Capitano", "humanoid", {dr:{value:["cold"]}}, [activity("fire")]), "neutral"],
    [npc("Tessitore", "humanoid", {}, [activity("lightning"),activity("lightning"),activity("lightning")]), "storm"]
  ];
  for (const [actor, expected] of cases) {
    context.actor = actor;
    assert.equal(run("inferActorTheme(actor)"), expected, actor.name);
  }
});

test("supports legacy damage, plain activities and balanced spell lists", () => {
  const {context, run} = fixture();
  context.actor = npc("Alchimista", "humanoid", {}, [1,2,3].map(() => ({system:{damage:{parts:[["2d6","acid"]]}}})));
  assert.equal(run("inferActorTheme(actor)"), "venom");
  context.actor.items = {a:{system:{activities:{a:{damage:{parts:[{types:["fire"]}]}}}}},
    b:activity("fire"),c:activity("fire"),d:activity("cold"),e:activity("cold"),f:activity("cold")};
  assert.equal(run("inferActorTheme(actor)"), "neutral");
  context.actor = npc("Rosa", "humanoid", {}, [{name:"Pugnale +1"}]);
  assert.equal(run("inferActorTheme(actor)"), "neutral");
});

test("world snapshot shares only allowlisted theme IDs; old entries migrate and actor data stays private", () => {
  const {context, run} = fixture();
  context.actor = npc("Drago rosso", "dragon", {}, [{name:"Private secret",system:{description:{value:"Secret biography"}}}]);
  context.token = {id:"token",actor:context.actor,parent:{id:"scene"},name:"Boss"};
  const entry = run("buildEntryFromTokenDocument(token)");
  assert.equal(entry.theme, "auto"); assert.equal(entry.autoTheme, "flame");
  assert.equal(entry.pct, .2);
  assert.doesNotMatch(JSON.stringify(entry), /Secret|Private|biography|attributes|resistance|\"max\"|\"value\"/);
  assert.equal(run("normalizeEntry({id:'old',pct:.5}).autoTheme"), "neutral");
  assert.equal(run("normalizeEntry({id:'old',pct:.5}).theme"), "auto");
  assert.equal(run("resolvedTheme({theme:'constructor',autoTheme:'__proto__'})"), "neutral");
  assert.equal(run("resolvedTheme({theme:'flame',autoTheme:'frost'})"), "flame");
});

test("GM override survives HP refreshes, re-adding a token and automatic data changes", async () => {
  const f = fixture(); const {context,run} = f;
  context.actor = npc("Drago rosso", "dragon");context.game.actors.set("actor", context.actor);
  context.entry = run("normalizeEntry({id:'scene.token',sceneId:'scene',tokenId:'token',actorId:'actor',theme:'frost',autoTheme:'flame',color:'#123456',pct:1,minions:[{id:'minion',pct:.5}]})");
  const refreshed = run("refreshEntry(entry,0)");
  assert.equal(refreshed.theme, "frost"); assert.equal(refreshed.autoTheme, "flame"); assert.equal(refreshed.pct, .2);
  context.next = {...refreshed,theme:"auto",color:null,minions:[]};
  const merged = run("mergeEntries([entry],[next])[0]");
  assert.equal(merged.theme, "frost"); assert.equal(merged.color, "#123456"); assert.equal(merged.minions.length,1);
  context.actor.name = "Drago bianco";
  assert.equal(run("refreshEntry(entry,0).autoTheme"), "frost");
  assert.ok(run("entriesChanged([entry],[refreshEntry(entry,0)])"));
});

test("GM selector saves a per-boss or per-minion override; players cannot write; reset returns to automatic", async () => {
  const f = fixture(); const {context,run} = f;
  const entry = run("normalizeEntry({id:'boss',pct:.5,autoTheme:'flame',minions:[{id:'minion',pct:.5,autoTheme:'venom'}]})");
  f.setState({entries:[entry],updatedAt:1});
  const select = {value:"frost",dataset:{khbbThemeSelect:"boss"}};
  context.event = {target:{closest:() => select}};
  context.game.user.isGM = false; await run("onRootChange(event)"); assert.equal(f.saved(),null);
  context.game.user.isGM = true; await run("onRootChange(event)");
  assert.equal(f.saved().entries[0].theme,"frost");assert.equal(f.saved().entries[0].autoTheme,"flame");
  select.dataset.khbbThemeSelect = "minion";select.value = "radiant";await run("onRootChange(event)");
  assert.equal(f.saved().entries[0].minions[0].theme,"radiant");
  select.dataset.khbbThemeSelect = "boss";select.value = "auto";await run("onRootChange(event)");
  assert.equal(f.saved().entries[0].theme,"auto");
  const previous = f.saved();select.value = 'flame" onclick="bad';await run("onRootChange(event)");assert.equal(f.saved(),previous);
});

test("player rendering needs no actor access and inherits no theme from the parent boss", () => {
  const {context, run} = fixture();context.game.user.isGM = false;
  const html = run("renderBossBar(normalizeEntry({id:'boss',name:'<script>bad()</script>',theme:'auto',autoTheme:'flame',pct:.8,minions:[{id:'minion',autoTheme:'frost',pct:.4}]}))");
  assert.match(html, /data-khbb-theme="flame"/);assert.match(html, /data-khbb-theme="frost"/);
  assert.doesNotMatch(html, /<script>|data-khbb-theme-select/);assert.match(html, /&lt;script&gt;/);
  context.game.user.isGM = true;
  assert.match(run("renderBossBar(normalizeEntry({id:'boss',autoTheme:'flame',pct:1}))"), /Automatico · Fiamma/);
  assert.notDeepEqual(run("getEntryPalette({theme:'frost'})"),run("getEntryPalette({theme:'flame'})"));
  assert.equal(run("JSON.stringify(getEntryPalette({theme:'frost',color:'#aabbcc'})) === JSON.stringify(getEntryPalette({theme:'flame',color:'#aabbcc'}))"),true);
});

test("theme updates preserve manual color and color reset restores the theme palette", async () => {
  const f = fixture();const {context,run} = f;
  f.setState({entries:[run("normalizeEntry({id:'boss',pct:.5,theme:'frost',color:'#aabbcc'})")],updatedAt:1});
  await run("updateEntryColor('boss', null)");assert.equal(f.saved().entries[0].color,null);assert.equal(f.saved().entries[0].theme,"frost");
  context.canvas.photosensitiveMode = true;
  context.root = {dataset:{}};run("syncRootEffectMode(root)");assert.equal(context.root.dataset.khbbMotion,"off");
});

test("named origins override generic families and new origins stay available to the GM", () => {
  const {context,run} = fixture();
  const cases = [
    [npc("Lich del Vuoto", "undead", {di:{value:["necrotic","poison"]}}, [activity("necrotic")]), "void"],
    [npc("Shadow Dragon", "dragon", {di:{value:["fire"]}}), "shadow"],
    [npc("Vampiro del castello", "undead", {dr:{value:["necrotic"]}}), "blood"],
    [npc("Demone abissale", "fiend", {di:{value:["fire"]}}), "abyss"],
    [npc("Osservatore", "aberration"), "arcane"],
    [npc("Cavaliere", "humanoid", {}, [{name:"Lama del vuoto"},{name:"Passo del vuoto"}]), "void"],
    [npc("Sangue del vuoto", "humanoid"), "neutral"]
  ];
  for (const [actor, theme] of cases) {
    context.actor = actor; assert.equal(run("inferActorTheme(actor)"),theme,actor.name);
  }
  const selector = run("renderThemeControl({id:'boss',theme:'shadow',autoTheme:'void'})");
  for (const name of ["Vuoto cosmico", "Ombra", "Sangue", "Abissale"]) assert.ok(selector.includes(name));
  assert.match(selector, /value="shadow" selected/);
});

test("exterior energy responds to life phases, stays bounded and goes away on defeat", () => {
  const {run} = fixture();
  const levels = [1,.75,.5,.25,.01].map(pct => run(`themeEnergy(${pct})`));
  for (let i=1;i<levels.length;i++) {
    assert.ok(levels[i].strength>levels[i-1].strength);
    assert.ok(levels[i].reach>levels[i-1].reach);
    assert.ok(levels[i].duration<levels[i-1].duration);
  }
  for (const level of levels) { assert.ok(level.strength<=.6);assert.ok(level.reach<=7);assert.ok(level.duration>=7); }
  assert.equal(run("themeEnergy(0).strength"),0);
  assert.equal(run("renderThemeExterior({id:'boss',theme:'void',pct:0})"),"");
  assert.equal(run("renderThemeExterior({id:'boss',theme:'neutral',pct:1})"),"");
  const html=run("renderThemeExterior({id:'boss',theme:'void',pct:.25})");
  assert.match(html, /data-khbb-exterior="void" aria-hidden="true"/);
  assert.equal(html,run("renderThemeExterior({id:'boss',theme:'void',pct:.25})"));
  assert.doesNotMatch(html,/NaN|Infinity|onload=|onclick=/);
});

test("external decorations leave damage tracks intact and stay scoped to each creature", () => {
  const {run} = fixture();
  const html=run("renderBossBar(normalizeEntry({id:'boss',theme:'void',pct:.7,minions:[{id:'minion',theme:'blood',pct:.2}]}))");
  assert.match(html, /<div class="khbb-content">\s*<div class="khbb-theme-exterior"/);
  assert.match(html, /data-khbb-exterior="void"/);assert.match(html, /data-khbb-exterior="blood"/);
  const track=run("renderHealthTrack(normalizeEntry({id:'boss',pct:.5}),'khbb-track')");
  assert.ok(track.trim().startsWith('<div class="khbb-track"'));
  assert.doesNotMatch(track,/khbb-theme-exterior/);
  const css=readFileSync(new URL("../styles/khuzoe-boss-bar.css",import.meta.url),"utf8");
  assert.match(css,/\[data-khbb-effects="off"\] \.khbb-theme-exterior/);
  assert.match(css,/\[data-khbb-motion="on"\][^\n]*\.khbb-edge-arcs/);
});
