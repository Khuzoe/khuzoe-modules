// Standalone browser fixture: real widget and calendar math, fictional data.
// No Foundry connection, token, world settings or remote calendar endpoints.
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const math = dataUrl(await readFile(new URL("../scripts/calendar-math.mjs", import.meta.url), "utf8"));
const realtime = dataUrl((await readFile(new URL("../scripts/realtime-clock.mjs", import.meta.url), "utf8")).replace('"./calendar-math.mjs"', JSON.stringify(math)));
const widget = dataUrl((await readFile(new URL("../scripts/clock-widget.mjs", import.meta.url), "utf8")).replace('"./calendar-math.mjs"', JSON.stringify(math)).replace('"./realtime-clock.mjs"', JSON.stringify(realtime)));
const css = await readFile(new URL("../styles/calendar.css", import.meta.url), "utf8");
const html = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Khuzoe Calendar · prova widget</title><style>
body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% 20%,#303643,#11131a);color:#eee9dc;font:14px system-ui}main{position:relative;margin:35px;max-width:440px}h1{font-size:23px}p{color:#b6b6c0;line-height:1.6}main button{font:inherit;color:#eee9dc;background:#292d39;border:1px solid #ffffff25;border-radius:6px;padding:8px 12px;margin:0 8px 8px 0}output{display:block;margin-top:15px;font-size:12px;line-height:1.8;color:#d6b573}body:after{content:'SCENA DI PROVA';position:fixed;right:30px;bottom:30px;letter-spacing:.3em;font-size:12px;color:#ffffff30}${css}</style>
<main><h1>Orologio della campagna</h1><p>Anteprima locale con dati fittizi. Trascina la maniglia, prova i comandi e ricarica per verificare la posizione.</p><button id="role">Passa a giocatore</button><button id="conflict">Simula conflitto</button><button id="visibility">Nascondi widget</button><button id="resize">Prova finestra stretta</button><output id="result"></output></main>
<script type="module">
import {ClockWidget} from ${JSON.stringify(widget)};
import {clockSeconds,secondsClock,units} from ${JSON.stringify(math)};
const definition={name:'Harptos',epochName:'DR',months:[{id:'a',name:'Alturiak',days:30}],weekdays:[{name:'Primo'}],timeSystem:{hoursPerDay:40,minutesPerHour:60}};
let opens=0,advances=0,saves=0,shown=true;
const controller={isGM:true,linked:true,writable:true,canControlClock:true,leader:true,realtime:{requested:false,speed:1,status:"In pausa"},async controlRealtime({running=this.realtime.requested,speed=this.realtime.speed}){this.realtime={requested:running,speed,status:running?"In corso · ×"+speed:"In pausa"};},context:{localPullWrites:true},binding:{},definition,clock:{date:{year:1492,monthId:'a',day:12},time:{hour:19,minute:30,second:3}},async advance(amount,unit){advances++;this.clock=secondsClock(definition,clockSeconds(definition,this.clock)+amount*units(definition)[unit]);status();}};
const key='khuzoe-calendar-widget-fictional-preview';
const clock=new ClockWidget(controller,{open(){opens++;status();},readPosition:()=>JSON.parse(localStorage.getItem(key)||'{}'),savePosition(position){localStorage.setItem(key,JSON.stringify(position));saves++;status();},report(error){document.getElementById('result').textContent=error.message;}});
function status(){document.getElementById('result').textContent='Aperture: '+opens+' · Comandi: '+advances+' · Spostamenti salvati: '+saves+' · Secondi: '+controller.clock.time.second+' · Posizione: '+(localStorage.getItem(key)||'predefinita');}
document.getElementById('role').onclick=e=>{controller.isGM=!controller.isGM;e.target.textContent=controller.isGM?'Passa a giocatore':'Passa a GM';clock.update(shown);};
document.getElementById('conflict').onclick=e=>{controller.conflict=controller.conflict?'':'Conflitto di prova';e.target.textContent=controller.conflict?'Risolvi conflitto':'Simula conflitto';clock.update(shown);};
document.getElementById('visibility').onclick=e=>{shown=!shown;e.target.textContent=shown?'Nascondi widget':'Mostra widget';clock.update(shown);};
document.getElementById('resize').onclick=()=>{document.getElementById('khuzoe-calendar-clock').style.maxWidth='220px';clock.update(shown);};
let fraction=0; setInterval(()=>{if(controller.realtime.requested&&!controller.conflict){fraction+=controller.realtime.speed;const delta=Math.floor(fraction);fraction-=delta;controller.clock=secondsClock(definition,clockSeconds(definition,controller.clock)+delta);clock.update(shown);}},1000);
clock.update();status();
</script></html>`;
if (process.argv[2] === "--serve") {
  createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); }).listen(8859, "127.0.0.1", () => console.log("Fictional widget preview: http://127.0.0.1:8859/"));
} else {
  if (!process.argv[2]) throw new Error("Pass the destination HTML path or --serve.");
  await writeFile(process.argv[2], html);
}
