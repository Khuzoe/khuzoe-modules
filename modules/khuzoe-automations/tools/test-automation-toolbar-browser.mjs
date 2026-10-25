import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile, mkdir} from "node:fs/promises";
import {createServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";

// Optional visual/integration check: uses Playwright from the developer runtime.
// Serves only module UI assets and Foundry's public styles. No world connection.
const {chromium} = createRequire(import.meta.url)("playwright");
const data = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const publicDir = path.resolve(data, "../App/resources/app/public");
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/") { response.writeHead(200, {"Content-Type": "text/html"}).end("<!doctype html><html><body></body></html>"); return; }
    const prefix = ["/modules/khuzoe-automations/scripts/", "/modules/khuzoe-automations/styles/", "/systems/dnd5e/", "/css/", "/fonts/"].find(p => pathname.startsWith(p));
    if (!prefix) { response.writeHead(404).end(); return; }
    const root = prefix === "/css/" || prefix === "/fonts/" ? publicDir : data;
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const mime = {".css": "text/css", ".mjs": "text/javascript", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml"}[path.extname(filename)] ?? "application/octet-stream";
    response.writeHead(200, {"Content-Type": mime}).end(await readFile(filename));
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, channel: process.env.KHUZOE_TEST_BROWSER_CHANNEL,
    chromiumSandbox: true, ignoreDefaultArgs: ["--unsafely-disable-devtools-self-xss-warnings"]});
  const page = await browser.newPage({viewport: {width: 1100, height: 640}});
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.setContent(`<!doctype html><html><head><base href="${base}/">
    <link rel="stylesheet" href="css/foundry2.css">
    <link rel="stylesheet" href="fonts/fontawesome/css/all.min.css">
    <link rel="stylesheet" href="systems/dnd5e/dnd5e.css">
    <link rel="stylesheet" href="modules/khuzoe-automations/styles/wild-shape.css">
    <style>body{padding:40px;background:#171c26;overflow:auto}main{display:grid;gap:22px}
    .preview.application{position:relative;width:960px;box-shadow:none}.preview .window-header{min-height:38px}
    .preview .window-title{font-size:16px}.preview .window-content{padding:12px;font-size:14px}</style>
    </head><body class="theme-dark"><main></main></body></html>`);
  await page.evaluate(async () => {
    const {createAutomationToolbar} = await import("/modules/khuzoe-automations/scripts/automation-toolbar.mjs");
    class ActorSheetV2 { constructor(actor, element) { Object.assign(this, {actor, document: actor, element}); } }
    window.foundry = {applications: {sheets: {ActorSheetV2}}};
    window.calls = 0;
    window.apps = [];
    window.toolbar = createAutomationToolbar({
      getSupportedAutomation: item => item.supported ? {version: "2"} : null,
      isCurrent: item => item.flags?.cat?.automation?.version === "2",
      canManage: actor => actor.isOwner,
      applyAll: actor => { window.calls++; return new Promise(resolve => { window.finishApplication = () => {
        actor.items.forEach(item => { if (item.supported) item.flags = {cat: {automation: {source: "khuzoe-automations", version: "2"}}}; });
        window.toolbar.refresh(actor); resolve();
      }; }); }
    });
    const item = version => ({supported: true, flags: version ? {cat: {automation: {source: "khuzoe-automations", version}}} : {}});
    for (const [name, items, isOwner] of [
      ["Na’Niss — automazioni da applicare", [item(), item("1"), item("2")], true],
      ["Lila Devaren — aggiornamenti disponibili", [item("1")], true],
      ["Sir Elric — aggiornato", [item("2")], true],
      ["Nuovo personaggio — nessuna capacità supportata", [], true],
      ["Scheda in sola lettura", [item()], false]
    ]) {
      const element = document.createElement("section");
      element.className = "preview application dnd5e2";
      element.innerHTML = `<header class="window-header"><i class="window-icon fa-solid fa-user" inert></i><h1 class="window-title"></h1>
        <button class="header-control icon fa-solid fa-ellipsis-vertical" data-action="toggleControls" aria-label="Altre opzioni"></button>
        <button class="header-control icon fa-solid fa-xmark" data-action="close" aria-label="Chiudi"></button></header>
        <section class="window-content">Stato delle automazioni Khuzoe sulla scheda</section>`;
      element.querySelector("h1").textContent = name;
      document.querySelector("main").append(element);
      const actor = {documentName: "Actor", uuid: `Actor.${window.apps.length}`, name, items, isOwner};
      const app = new ActorSheetV2(actor, element);
      window.apps.push(app);
      window.toolbar.render(app);
      window.toolbar.render(app);
    }
  });
  const buttons = page.locator('[data-khuzoe-action="sheet-automations"]');
  assert.equal(await buttons.count(), 5, "Rerenders do not duplicate the shortcut");
  assert.deepEqual(await buttons.evaluateAll(elements => elements.map(e => e.dataset.khuzoeState)), ["missing", "outdated", "current", "empty", "missing"]);
  assert.equal(await buttons.nth(3).isDisabled(), true);
  assert.equal(await buttons.nth(4).isDisabled(), true);
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await buttons.evaluateAll(elements => elements.slice(0, 3).map(e => getComputedStyle(e).color)), ["rgb(255, 116, 116)", "rgb(255, 209, 102)", "rgb(114, 223, 160)"]);
  assert.equal(await buttons.evaluateAll(elements => elements.every(e => e.parentElement.matches(".window-header") && e.nextElementSibling.dataset.action === "toggleControls")), true);
  const output = new URL("../.maintenance/toolbar-verification/", import.meta.url);
  await mkdir(output, {recursive: true});
  await page.screenshot({path: fileURLToPath(new URL("actor-headers.png", output))});
  await buttons.first().click();
  assert.equal(await buttons.first().getAttribute("aria-busy"), "true");
  await buttons.first().evaluate(element => element.dispatchEvent(new MouseEvent("click", {bubbles: true})));
  assert.equal(await page.evaluate(() => window.calls), 1, "Even duplicate dispatched clicks cannot start a second application");
  await page.evaluate(() => window.finishApplication());
  await page.waitForFunction(() => document.querySelector('[data-khuzoe-action="sheet-automations"]').getAttribute("aria-busy") === "false");
  assert.equal(await buttons.first().getAttribute("data-khuzoe-state"), "current");
  await page.evaluate(() => {
    window.apps[0].actor.items.push({supported: true});
    window.toolbar.refresh(window.apps[0].actor);
  });
  assert.equal(await buttons.first().getAttribute("data-khuzoe-state"), "missing", "Item changes refresh the existing header");
  assert.equal(await buttons.count(), 5);
  console.log("Browser toolbar: native Foundry/D&D5e styles, visible header placement, colors, rerenders, live refresh, permissions and duplicate clicks OK");
  console.log(fileURLToPath(new URL("actor-headers.png", output)));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
