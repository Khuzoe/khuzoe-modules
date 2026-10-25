import { MODULE_ID, SETTINGS } from "../constants.js";
import { BaseShadowApp } from "./base-shadow-app.js";
import { renderEmbeddedEntityShell, renderEntityShell } from "../renderers.js";
import { wikiDataService } from "../services/wiki-data-service.js";

export class CriptaWikiEntityApp extends BaseShadowApp {
    constructor(options = {}) {
        const { section, entityId, document, anchor, ...applicationOptions } = options;
        super(applicationOptions);
        this.section = section || null;
        this.entityId = entityId || null;
        this.document = document || null;
        this.anchor = anchor || "";
        this.match = null;
    }

    static DEFAULT_OPTIONS = {
        id: "cripta-wiki-entity",
        classes: ["cripta-wiki-entity", "cripta-iframe-window"],
        position: { width: 1320, height: 920 }
    };

    get title() {
        return "Scheda Wiki";
    }

    async resolveMatch() {
        if (this.document) {
            this.match = await wikiDataService.matchDocument(this.document);
            return this.match;
        }

        await wikiDataService.load();

        if (this.section && this.entityId) {
            const entity = wikiDataService.getEntityByReference(this.section, this.entityId);
            this.match = {
                source: "wiki",
                section: this.section,
                id: this.entityId,
                entity,
                document: null,
                key: `wiki:${this.section}:${this.entityId}`
            };
            return this.match;
        }

        this.match = {
            source: "unmatched",
            section: null,
            id: null,
            entity: null,
            document: this.document,
            key: "doc:unknown"
        };
        return this.match;
    }

    async buildHtml() {
        const match = await this.resolveMatch();
        const iframeUrl = match?.entity ? this.withAnchor(wikiDataService.getEntityUrl(match)) : null;
        if (iframeUrl) {
            const token = game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "";
            return renderEmbeddedEntityShell({
                match,
                iframeUrl: this.withAuthToken(iframeUrl, token)
            });
        }
        return renderEntityShell({
            match,
            canCreateDraft: !!this.document && game.user?.isGM && !match?.npcLinkReason && match?.source !== "draft"
        });
    }

    withAnchor(url) {
        if (!url || !this.anchor) return url;
        try {
            const target = new URL(url);
            target.hash = String(this.anchor).replace(/^#/, "");
            return target.toString();
        } catch (_) {
            return `${url}#${String(this.anchor).replace(/^#/, "")}`;
        }
    }

    async activateShadowListeners(_shadow, container) {
        const draftButton = container.querySelector("[data-create-draft]");
        if (draftButton) {
            draftButton.addEventListener("click", async () => {
                if (!this.document || !game.user?.isGM) return;
                const draft = await wikiDataService.createDraftFromDocument(this.document);
                ui.notifications.info(`Bozza creata: ${draft.name}`);
                await this.renderShadowRoot();
            });
        }
    }
}
