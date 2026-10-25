import { MODULE_ID, SETTINGS } from "../constants.js";
import { HandlebarsApplicationV2 } from "../foundry-compat.js";
import { wikiDataService } from "../services/wiki-data-service.js";
import { renderLoadErrorShell } from "../renderers.js";

export class BaseShadowApp extends HandlebarsApplicationV2 {
    constructor(options = {}) {
        super(options);
        this.currentIframeUrl = "";
        this._frameMessageHandler = null;
        this._frameLoadHandler = null;
        this._boundFrame = null;
        this._lastFrameAuth = null;
    }

    static DEFAULT_OPTIONS = {
        classes: ["cripta-wiki-app-v14"],
        position: { width: 1200, height: 820 },
        window: { icon: "fa-solid fa-book-skull", resizable: true }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/app-shell.hbs` }
    };

    async _onRender(context, options) {
        await super._onRender(context, options);
        await this.renderShadowRoot();
    }

    withAuthToken(url, _token) {
        // Authentication is delivered after iframe load using an origin-bound
        // postMessage. Keeping JWTs out of URLs prevents history/referrer leaks.
        return url;
    }

    _getHeaderControls() {
        const controls = super._getHeaderControls();
        controls.unshift({
            action: "cripta-refresh-frame",
            label: "Ricarica",
            icon: "fa-solid fa-rotate-right",
            onClick: () => this.refreshEmbeddedFrame()
        });
        return controls;
    }

    async _onClose(options) {
        this.unbindFrameMessageHandler();
        return super._onClose(options);
    }

    refreshEmbeddedFrame() {
        const frame = this.getEmbeddedFrame();
        const token = game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "";
        const currentUrl = this.currentIframeUrl || frame?.getAttribute("src") || "";

        if (frame && currentUrl) {
            frame.src = this.withAuthToken(currentUrl, token);
            return;
        }

        this.renderShadowRoot();
    }

    sendAuthToken(token) {
        if (!token) return;
        const frame = this.getEmbeddedFrame();
        const targetOrigin = this.getFrameOrigin(frame);
        if (!targetOrigin || !frame?.contentWindow) return;
        // The initial about:blank document inherits Foundry's origin while src
        // already points to the wiki. Wait until navigation has actually begun.
        try {
            const href = frame.contentWindow.location.href;
            if (!href || href === "about:blank" || new URL(href).origin !== targetOrigin) return;
            if (frame.contentDocument?.readyState !== "complete") return;
        } catch (error) {
            // The loaded remote document is correctly protected by same-origin
            // policy. postMessage still requires the exact configured origin.
            if (error?.name !== "SecurityError") return;
        }
        if (this._lastFrameAuth?.frame === frame && this._lastFrameAuth.origin === targetOrigin
            && this._lastFrameAuth.token === token) return;
        frame?.contentWindow?.postMessage({
            type: "cripta-auth-token",
            token
        }, targetOrigin);
        this._lastFrameAuth = { frame, origin: targetOrigin, token };
    }

    getEmbeddedFrame() {
        const host = this.element?.querySelector?.(".cripta-app-host");
        return host?.shadowRoot?.querySelector(".cw-direct-frame") || null;
    }

    async renderShadowRoot() {
        const host = this.element?.querySelector?.(".cripta-app-host");
        if (!host) return;

        const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
        this.unbindFrameMessageHandler();
        shadow.innerHTML = "";

        const cssLinks = [
            wikiDataService.getCssUrl(),
            `modules/${MODULE_ID}/styles/module-content.css`,
            "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css",
            "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&family=Montserrat:wght@400;600&display=swap"
        ];

        cssLinks.forEach(href => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            shadow.appendChild(link);
        });

        const container = document.createElement("div");
        container.className = "cripta-shadow-root";
        shadow.appendChild(container);

        try {
            container.innerHTML = await this.buildHtml();
            await this.activateShadowListeners(shadow, container);
            this.bindFrameMessageHandler();
        } catch (error) {
            console.error(`${MODULE_ID} render error`, error);
            container.innerHTML = renderLoadErrorShell(error);
        }
    }

    bindFrameMessageHandler() {
        this.unbindFrameMessageHandler();
        const frame = this.getEmbeddedFrame();
        if (!frame?.contentWindow) return;
        this._boundFrame = frame;

        const targetOrigin = this.getFrameOrigin(frame);
        this._frameLoadHandler = () => {
            const token = String(game.settings.get(MODULE_ID, SETTINGS.DISCORD_TOKEN) || "").trim();
            if (token) this.sendAuthToken(token);
        };
        frame.addEventListener("load", this._frameLoadHandler);

        this._frameMessageHandler = (event) => {
            if (event.source !== frame.contentWindow) return;
            if (!targetOrigin || event.origin !== targetOrigin) return;
            const data = event.data || {};
            if (data.type === "cripta-embed-ready") {
                // A ready message also covers pages whose async startup had not
                // installed its auth listener when the load event fired.
                this._lastFrameAuth = null;
                this._frameLoadHandler();
                return;
            }
            if (data.type !== "cripta-spa-navigate" || !data.url) return;
            try {
                const nextUrl = new URL(String(data.url), frame.src);
                if (nextUrl.origin !== targetOrigin) return;
                this.currentIframeUrl = nextUrl.toString();
            } catch (_) {
                return;
            }
        };
        window.addEventListener("message", this._frameMessageHandler);

        this._frameLoadHandler();
    }

    unbindFrameMessageHandler() {
        const frame = this._boundFrame;
        if (this._frameLoadHandler) frame?.removeEventListener?.("load", this._frameLoadHandler);
        this._frameLoadHandler = null;
        this._boundFrame = null;
        this._lastFrameAuth = null;
        if (!this._frameMessageHandler) return;
        window.removeEventListener("message", this._frameMessageHandler);
        this._frameMessageHandler = null;
    }

    getFrameOrigin(frame = this.getEmbeddedFrame()) {
        try {
            return new URL(frame?.src || this.currentIframeUrl || wikiDataService.getBaseUrl()).origin;
        } catch (_) {
            return "";
        }
    }

    async buildHtml() {
        return "";
    }

    async activateShadowListeners(_shadow, _container) {}
}
