/** Compare content fingerprints before creating an application timestamp. */
export function planSiteOverrideState(previous, updates, {
    hashImage, hashDescription, now = () => new Date().toISOString()
}) {
    const next = { ...previous };
    let changed = false;
    let appliedAt;
    for (const [field, hash] of [["image", hashImage], ["description", hashDescription]]) {
        if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;
        const siteHash = hash(updates[field].siteValue);
        const appliedHash = hash(updates[field].appliedValue);
        const old = previous[field];
        if (old?.siteHash === siteHash && old?.appliedHash === appliedHash) continue;
        appliedAt ??= now();
        next[field] = { ...old, siteHash, appliedHash, appliedAt };
        changed = true;
    }
    return { changed, state: changed ? next : previous };
}

// Exclusive per-entry counts: content edits take precedence over metadata-only edits.
export function createOverrideSummary() {
    return { updated: 0, metadataUpdated: 0, unchanged: 0, skipped: 0 };
}

export function recordOverrideOutcome(summary, { contentUpdated = false, metadataUpdated = false, skipped = false } = {}) {
    const key = contentUpdated ? "updated" : metadataUpdated ? "metadataUpdated" : skipped ? "skipped" : "unchanged";
    summary[key] += 1;
}

export function formatOverrideSummary(summary) {
    return `Contenuti aggiornati: ${summary.updated}. Solo dati di sincronizzazione: ${summary.metadataUpdated}. Invariati: ${summary.unchanged}. Saltati: ${summary.skipped}.`;
}
