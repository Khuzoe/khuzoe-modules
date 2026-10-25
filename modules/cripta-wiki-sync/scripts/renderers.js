import { escapeHtml } from "./services/wiki-utils.js";

export function renderEmbeddedBrowserShell({ iframeUrl }) {
    return `
        <div class="cw-iframe-only">
            <iframe class="cw-direct-frame" src="${escapeHtml(iframeUrl)}" title="Cripta Wiki" referrerpolicy="origin"></iframe>
        </div>
    `;
}

export function renderEmbeddedEntityShell({ match, iframeUrl }) {
    return `
        <div class="cw-iframe-only">
            <iframe class="cw-direct-frame" src="${escapeHtml(iframeUrl)}" title="${escapeHtml(match?.entity?.name || "Scheda Wiki")}" referrerpolicy="origin"></iframe>
        </div>
    `;
}

export function renderEntityShell({ match, canCreateDraft }) {
    const title = match?.entity?.name || match?.unresolvedName || "Scheda Wiki";
    const npcMessages = {
        "not-found": "Collegamento NPC non trovato. Verifica che l'NPC sia stato sincronizzato e che il tuo account abbia accesso alla sua pagina.",
        "missing-link": "La pagina collegata a questo NPC non è stata trovata. Verifica il collegamento salvato nella wiki.",
        "ambiguous": "Sono state trovate più pagine possibili per questo NPC. Serve un collegamento univoco per aprire quella corretta.",
        "unavailable": "Impossibile verificare il collegamento NPC. Controlla la connessione e l'accesso alla wiki, poi riprova."
    };
    const message = match?.source === "draft"
        ? "Questa è una bozza locale di Foundry; non ha ancora una pagina pubblicata nella wiki."
        : (npcMessages[match?.npcLinkReason] || "Non e stata trovata una voce wiki collegata a questa entita.");
    return `
        <div style="padding: 1rem; color: #e6e0d2; background: #090909; height: 100%; box-sizing: border-box;">
            <h2 style="margin-top: 0;">${escapeHtml(title)}</h2>
            <p>${escapeHtml(message)}</p>
            ${canCreateDraft ? '<button type="button" data-create-draft>Crea bozza wiki</button>' : ''}
        </div>
    `;
}

export function renderLoadErrorShell(error) {
    const message = error?.message || String(error || "Errore sconosciuto");
    return `
        <div style="padding: 1rem; color: #e6e0d2; background: #090909; height: 100%; box-sizing: border-box;">
            <h2 style="margin-top: 0;">Impossibile caricare la wiki</h2>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}
