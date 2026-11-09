import { DEFAULT_CAMPAIGN_ID, DEFAULT_SITE_BASE_URL, DISCORD_WORKER_URL, MODULE_ID, SETTINGS } from "../constants.js";
import { BaseShadowApp } from "../apps/base-shadow-app.js";
import { renderEmbeddedBrowserShell } from "../renderers.js";
import { canPullFromWorker } from "./sync-policy.js";
import { policyFetch } from "./worker-gateway.js";

const REQUEST_FLAG = "cityMapImport";
const validWorld = /^[a-z0-9_-]{1,96}$/i;
const validJob = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function context() {
    return {
        campaign: game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || DEFAULT_CAMPAIGN_ID,
        world: game.world.id,
        token: game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "",
    };
}

function assertCanImport(expected) {
    const current = context();
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id || !canPullFromWorker()) {
        throw new Error("La creazione richiede il GM attivo e una modalità Wiki Sync che consenta sito → Foundry.");
    }
    if (!current.token || !game.user.can("FILES_UPLOAD")) {
        throw new Error("Accedi alla wiki con l’account DM e verifica i permessi di caricamento in Foundry.");
    }
    if (!validWorld.test(current.world) || Object.keys(current).some(key => current[key] !== expected[key])) {
        throw new Error("Mondo, campagna o account cambiati. Riapri le richieste di importazione.");
    }
}

function cityPage(sceneId = "") {
    const base = game.settings.get(MODULE_ID, SETTINGS.SITE_BASE_URL) || DEFAULT_SITE_BASE_URL;
    const url = new URL(base.replace(/\/+$/, "") + "/pages/city-map.html");
    const { campaign, world } = context();
    url.searchParams.set("campaign", campaign);
    url.searchParams.set("embed", "1");
    if (sceneId) url.searchParams.set("da-scena", world + "/" + sceneId);
    return url.toString();
}

class CityMapApp extends BaseShadowApp {
    static DEFAULT_OPTIONS = {
        id: "cripta-city-map",
        classes: ["cripta-wiki-shell", "cripta-iframe-window"],
        position: { width: 1120, height: 820 },
    };

    get title() { return "Mappa città"; }
    async buildHtml() { return renderEmbeddedBrowserShell({ iframeUrl: this.url }); }
}

let app, importDialog;
function openMap(sceneId) {
    app ??= new CityMapApp();
    app.url = cityPage(sceneId);
    app.currentIframeUrl = "";
    app.render({ force: true });
}

async function request(expected, suffix = "", body) {
    const url = new URL(DISCORD_WORKER_URL + "/api/city-maps/scene-imports" + suffix);
    url.searchParams.set("campaign", expected.campaign);
    url.searchParams.set("world", expected.world);
    const response = await policyFetch(url, {
        method: body ? "POST" : "GET",
        headers: {
            Authorization: "Bearer " + expected.token,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Richiesta alla wiki non riuscita.");
    }
    return response;
}

async function uploadBackground(expected, job) {
    const response = await request(expected, "/" + job.id + "/image");
    const image = await response.blob();
    if (image.type !== "image/webp" || !image.size || image.size > 4 * 1024 * 1024) {
        throw new Error("Sfondo non valido.");
    }
    assertCanImport(expected);
    const picker = foundry.applications.apps.FilePicker.implementation;
    const folder = "khuzoe-city-maps/" + expected.world;
    for (const path of ["khuzoe-city-maps", folder]) {
        assertCanImport(expected);
        try { await picker.browse("data", path); }
        catch {
            assertCanImport(expected);
            try { await picker.createDirectory("data", path, { notify: false }); }
            catch { await picker.browse("data", path); }
        }
    }
    assertCanImport(expected);
    const filename = job.id + ".webp";
    const file = new File([image], filename, { type: "image/webp" });
    const upload = await picker.upload("data", folder, file, {}, { notify: false });
    if (upload?.path !== folder + "/" + filename) throw new Error("Impossibile salvare lo sfondo nella cartella prevista.");
    return upload.path;
}

export async function createCityScene(expected, job) {
    assertCanImport(expected);
    if (!validJob.test(job.id) || job.sceneId !== job.id.replaceAll("-", "").slice(0, 16)
        || typeof job.title !== "string" || !job.title.trim() || job.title.length > 120
        || ![job.width, job.height].every(size => Number.isInteger(size) && size > 0 && size <= 3072)) {
        throw new Error("Richiesta scena non valida.");
    }
    const verify = scene => {
        const link = scene?.getFlag(MODULE_ID, REQUEST_FLAG);
        return link?.id === job.id && link?.campaign === expected.campaign && scene.id === job.sceneId;
    };
    let scene = game.scenes.get(job.sceneId);
    if (scene && !verify(scene)) throw new Error("Identificativo occupato da una scena estranea alla richiesta.");
    if (!scene) {
        const path = await uploadBackground(expected, job);
        assertCanImport(expected);
        const Scene = foundry.documents.Scene;
        const levelId = Scene.metadata.defaultLevelId;
        const data = {
            _id: job.sceneId,
            name: job.title,
            width: job.width,
            height: job.height,
            padding: 0,
            active: false,
            navigation: false,
            tokenVision: false,
            grid: { type: CONST.GRID_TYPES.GRIDLESS },
            fog: { mode: CONST.FOG_EXPLORATION_MODES.DISABLED },
            initialLevel: levelId,
            levels: [{ _id: levelId, name: "Città", background: { src: path } }],
            flags: { [MODULE_ID]: { [REQUEST_FLAG]: { id: job.id, campaign: expected.campaign } } },
        };
        try { scene = game.scenes.get(job.sceneId) || await Scene.create(data, { keepId: true }); }
        catch (error) {
            scene = game.scenes.get(job.sceneId);
            if (!scene) throw error;
        }
    }
    if (!verify(scene)) throw new Error("Creazione della scena non verificata.");
    assertCanImport(expected);
    await request(expected, "/" + job.id + "/complete", { sceneId: scene.id });
    return scene;
}

async function openImports() {
    if (importDialog?.open) return;
    const expected = context();
    const dialog = document.createElement("dialog");
    importDialog = dialog;
    dialog.style.cssText = "width:min(520px,95vw);max-height:80vh;overflow:auto;padding:1rem";
    dialog.innerHTML = '<h2>Importa scene dal sito</h2><p data-world></p><p role="status"></p>'
        + '<div data-jobs></div><button type="button" data-close>Chiudi</button>';
    const status = dialog.querySelector("[role=status]");
    dialog.querySelector("[data-world]").textContent = "Mondo Foundry: " + expected.world;
    const close = dialog.querySelector("[data-close]");
    let busy = false;
    close.addEventListener("click", () => { if (!busy) dialog.close(); });
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    dialog.addEventListener("close", () => { dialog.remove(); importDialog = null; }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    try {
        assertCanImport(expected);
        status.textContent = "Caricamento delle richieste…";
        const { jobs } = await (await request(expected)).json();
        status.textContent = jobs.length ? "Scegli quale scena creare. La scena non viene attivata." : "Nessuna richiesta per questo mondo.";
        const list = dialog.querySelector("[data-jobs]");
        for (const job of jobs) {
            const row = document.createElement("p");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Conferma creazione · " + job.title;
            row.append(button);
            list.append(row);
            button.addEventListener("click", async () => {
                if (busy) return;
                busy = true;
                button.disabled = close.disabled = true;
                status.textContent = "Creazione della scena…";
                try {
                    await createCityScene(expected, job);
                    row.remove();
                    status.textContent = "Scena creata e collegata alla mappa della città.";
                } catch (error) {
                    status.textContent = error.message + " Puoi ripetere la conferma per completare il collegamento.";
                } finally {
                    busy = false;
                    button.disabled = close.disabled = false;
                }
            });
        }
    } catch (error) { status.textContent = error.message; }
}

if (globalThis.Hooks) {
    Hooks.on("getSceneControlButtons", controls => {
        const tokens = controls?.tokens || controls?.token;
        if (!tokens?.tools) return;
        const add = (name, title, icon, visible, onChange) => {
            tokens.tools[name] = { name, title, icon, visible, order: Object.keys(tokens.tools).length, button: true, onChange };
        };
        add("cripta-city-maps", "Mappe della campagna", "fa-solid fa-map", true, () => openMap(canvas.scene?.id));
        add("cripta-city-imports", "Wiki Sync · Importa scene dal sito", "fa-solid fa-file-import", game.user?.isGM === true, () => void openImports());
    });
    Hooks.on("getSceneContextOptions", (_navigation, options) => {
        options.push({
            label: "Apri mappa città",
            icon: "fa-solid fa-map-location-dot",
            visible: entry => Boolean(entry.dataset.sceneId && !entry.dataset.levelId),
            onClick: (_event, entry) => openMap(entry.dataset.sceneId),
        });
    });
}
