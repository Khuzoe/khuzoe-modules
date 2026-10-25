import { FLAGS, MODULE_ID, SETTINGS } from "../constants.js";

function clone(value) {
    return foundry.utils.deepClone(value);
}

function getSetting(key) {
    return clone(game.settings.get(MODULE_ID, key));
}

async function setSetting(key, value) {
    return game.settings.set(MODULE_ID, key, value);
}

function ensureNoteEntry(state, entityKey) {
    const next = state && typeof state === "object" ? state : {};
    if (!next[entityKey]) {
        next[entityKey] = {
            shared: "",
            gm: "",
            updatedAt: null,
            updatedBy: null
        };
    }
    return next[entityKey];
}

export const wikiStore = {
    getSharedNotesState() {
        return getSetting(SETTINGS.SHARED_NOTES) || {};
    },

    async saveSharedNote(entityKey, field, text) {
        const state = this.getSharedNotesState();
        const entry = ensureNoteEntry(state, entityKey);
        entry[field] = text;
        entry.updatedAt = new Date().toISOString();
        entry.updatedBy = game.user?.id ?? null;
        await setSetting(SETTINGS.SHARED_NOTES, state);
        return entry;
    },

    getPersonalNotesState() {
        return getSetting(SETTINGS.PERSONAL_NOTES) || {};
    },

    async savePersonalNote(entityKey, text) {
        const state = this.getPersonalNotesState();
        state[entityKey] = {
            text,
            updatedAt: new Date().toISOString()
        };
        await setSetting(SETTINGS.PERSONAL_NOTES, state);
        return state[entityKey];
    },

    getDraftEntries() {
        const raw = getSetting(SETTINGS.DRAFTS) || {};
        return raw.entries || {};
    },

    async saveDraftEntries(entries) {
        await setSetting(SETTINGS.DRAFTS, { entries });
    },

    getDocumentLink(document) {
        return document?.getFlag?.(MODULE_ID, FLAGS.LINK) || null;
    },

    async setDocumentLink(document, link) {
        if (!document?.setFlag) return null;
        await document.setFlag(MODULE_ID, FLAGS.LINK, link);
        return link;
    },

    async createDraftForDocument(document, draft) {
        const entries = this.getDraftEntries();
        entries[draft.id] = draft;
        await this.saveDraftEntries(entries);
        if (document?.setFlag) {
            await this.setDocumentLink(document, {
                source: "draft",
                section: draft.section,
                id: draft.id
            });
        }
        return draft;
    }
};
