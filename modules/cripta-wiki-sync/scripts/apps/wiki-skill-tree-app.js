import { MODULE_ID, SETTINGS } from "../constants.js";
import { BaseShadowApp } from "./base-shadow-app.js";
import { renderEmbeddedBrowserShell } from "../renderers.js";
import { wikiDataService } from "../services/wiki-data-service.js";

export class CriptaWikiSkillTreeApp extends BaseShadowApp {
    constructor(options = {}) {
        const { characterId, title, treeKey, ...applicationOptions } = options;
        super(applicationOptions);
        this.characterId = characterId || "";
        this.treeKey = treeKey || "";
        this._title = title || "Albero Abilita";
    }

    static DEFAULT_OPTIONS = {
        id: "cripta-wiki-skill-tree",
        classes: ["cripta-wiki-skill-tree", "cripta-iframe-window"],
        position: { width: 1320, height: 900 }
    };

    get title() {
        return this._title;
    }

    getSkillTreeUrl() {
        const baseUrl = wikiDataService.getBaseUrl();
        const url = new URL(`${baseUrl}/pages/characters/character.html`);
        url.searchParams.set("id", this.characterId);
        url.searchParams.set("type", "player");
        url.searchParams.set("view", "skill-tree");
        url.searchParams.set("skillTreeOnly", "1");
        url.searchParams.set("embed", "1");
        url.searchParams.set("_", String(Date.now()));
        return wikiDataService.withCampaignSiteUrl(url.toString());
    }

    async buildHtml() {
        const token = game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "";
        return renderEmbeddedBrowserShell({
            iframeUrl: this.withAuthToken(this.getSkillTreeUrl(), token)
        });
    }
}
