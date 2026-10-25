// Transformation copies are runtime documents, never independent wiki entries.
// Detect older copies too: the explicit opt-out was added after Shapechange 0.27.1.
export function isTemporaryWikiActor(actor) {
    if (!actor) return false;
    const flags = actor.flags || {};
    return flags["cripta-wiki-sync"]?.excludeFromSync === true
        || actor.isPolymorphed === true
        || flags.dnd5e?.isPolymorphed === true
        || Boolean(flags["khuzoe-automations"]?.shapechange?.operation);
}
