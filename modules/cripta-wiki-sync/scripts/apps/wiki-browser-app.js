import { MODULE_ID, SECTIONS, SETTINGS } from "../constants.js";
import { BaseShadowApp } from "./base-shadow-app.js";
import { renderEmbeddedBrowserShell } from "../renderers.js";
import { wikiDataService } from "../services/wiki-data-service.js";

export class CriptaWikiBrowserApp extends BaseShadowApp {
    constructor(options = {}) {
        const { section, ...applicationOptions } = options;
        super(applicationOptions);
        this.activeSection = section || SECTIONS.HOME;
    }

    static DEFAULT_OPTIONS = {
        id: "cripta-wiki-browser",
        classes: ["cripta-wiki-shell", "cripta-iframe-window"],
        position: { width: 1500, height: 940 }
    };

    get title() {
        return "Khuzoe Wiki Sync";
    }

    async buildHtml() {
        const token = game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "";
        return renderEmbeddedBrowserShell({
            iframeUrl: this.withAuthToken(wikiDataService.getWikiPageUrl(this.activeSection), token)
        });
    }

    async activateShadowListeners(_shadow, _container) {}
}
