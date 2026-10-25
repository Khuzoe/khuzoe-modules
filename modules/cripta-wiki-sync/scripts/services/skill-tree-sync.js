import { MODULE_ID } from "../constants.js";
import { normalizeWikiItemKey as normalize, slugify } from "./wiki-utils.js";

const clone = value => JSON.parse(JSON.stringify(value));
const values = collection => Array.isArray(collection) ? collection : Array.from(collection?.values?.() || []);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceKey = source => JSON.stringify([source.campaignId, source.characterId, source.treeKey, String(source.nodeId)]);
const flagPath = `flags.${MODULE_ID}.skillTree`;
const archivePath = `flags.${MODULE_ID}.skillTreeArchive`;
// Foundry mutates database options (including parentUuid). Never share them between writes.
const syncOptions = (extra = {}) => ({ criptaWikiSyncCommand: true, criptaSkillTreeSync: true, ...extra });

export function isArchivedSkillTree(tree) {
    if (Object.hasOwn(tree || {}, "archived")) return tree.archived === true;
    return tree?.isArchived === true || tree?.disabled === true
        || ["archived", "archiviato", "archive", "archivio"].includes(normalize(tree?.status || tree?.state || tree?.visibility));
}

export function isSharedSkillTree(tree, key = "") {
    return tree?.shared === true || tree?.campaignShared === true || tree?.global === true
        || ["campaign", "campagna", "shared", "condiviso", "global"].includes(normalize(tree?.scope || tree?.treeScope || tree?.visibility))
        || /^(campaign|campagna|shared|condiviso)(-|$)/.test(slugify(key));
}

export function isSkillTreeGroup(node) {
    return node?.group === true || ["group", "gruppo"].includes(normalize(node?.type || node?.kind || node?.nodeType));
}

export function selectSkillTreeState({ states, campaignId, treeKey, tree, characterId, candidates = [] }) {
    const shared = isSharedSkillTree(tree, treeKey);
    const key = slugify(`${campaignId}-${treeKey}-${shared ? "shared" : characterId}`);
    const exact = entry => entry.id === key || entry.key === key;
    const ids = new Set([characterId, ...candidates].map(normalize).filter(Boolean));
    const matches = states.filter(entry => {
        if (entry.campaignId && entry.campaignId !== campaignId) return false;
        if (exact(entry)) return true;
        if (normalize(entry.treeKey) !== normalize(treeKey)) return false;
        const id = entry.characterId || entry.ownerCharacterId || entry.playerId || entry.subjectId;
        if (!shared) return ids.has(normalize(id));
        return entry.shared === true || entry.campaignShared === true
            || ["campaign", "campagna", "global", "all", "tutti"].includes(normalize(id))
            || ["campaign", "campagna", "shared", "condiviso", "global"].includes(normalize(entry.scope || entry.stateScope || entry.visibility));
    });
    const time = entry => Date.parse(entry.updatedAt || "") || 0;
    matches.sort((a, b) => Number(exact(b)) - Number(exact(a)) || time(b) - time(a));
    if (!matches.length) return null;
    if (!shared) return matches[0];
    // Shared trees merge grants on the site; individual trees select one record.
    return [...matches].sort((a, b) => time(a) - time(b)).reduce((result, entry) => ({
        ...result, ...entry,
        unlocked: [...new Set([...(result.unlocked || []), ...(entry.unlocked || entry.unlockedNodeIds || [])].map(String))],
        levels: { ...result.levels, ...entry.levels }
    }), {});
}

export function unlockedSkillTreeNodes(tree, state) {
    const selected = state?.unlocked ?? state?.unlockedNodeIds;
    return new Set((selected ?? (tree.nodes || []).filter(n => n.state === "unlocked" || n.unlocked === true).map(n => n.id)).map(String));
}

export function skillNodeAtLevel(node, requestedLevel) {
    const variants = node.levels || node.upgrades || node.variants || [];
    const maxLevel = Math.max(1, variants.length);
    const level = Math.max(1, Math.min(maxLevel, Math.round(Number(requestedLevel) || 1)));
    const variant = level === 1 ? {
        title: node.baseTitle, desc: node.baseDesc, icon: node.baseIcon
    } : variants[level - 1];
    return {
        ...node,
        title: variant?.title || node.title || node.name,
        desc: variant?.desc || variant?.description || node.desc || node.description,
        icon: variant?.icon || node.icon,
        flavor: Object.hasOwn(node, "flavor") ? node.flavor : (node.baseFlavor || variants.find(v => v.flavor)?.flavor || ""),
        level, maxLevel
    };
}

function collectionPayload(payload, collection, campaignId) {
    if (!object(payload) || payload.ok !== true || payload.collection !== collection
        || payload.campaignId !== campaignId || !["kv", "d1"].includes(payload.source)
        || !Number.isSafeInteger(payload.version) || payload.version < 0 || !Array.isArray(payload.data)) {
        throw new Error(`Dati ${collection} non autorevoli o incompleti: sincronizzazione annullata.`);
    }
    return payload.data;
}

export function validateSkillTreeSnapshot(treePayload, statePayload, campaignId) {
    const rawTrees = collectionPayload(treePayload, "skill-trees", campaignId);
    const states = collectionPayload(statePayload, "skill-tree-states", campaignId);
    const trees = {};
    for (const entry of rawTrees) {
        const key = String(entry?.id || entry?.key || "");
        const tree = entry?.tree || entry;
        if (!key || Object.hasOwn(trees, key) || !object(tree) || !Array.isArray(tree.nodes)) throw new Error("Alberi mancanti, duplicati o non validi.");
        const ids = new Set();
        for (const node of tree.nodes) {
            if (!object(node) || node.id === undefined || node.id === null || !String(node.id) || ids.has(String(node.id))) throw new Error(`Nodi non validi: ${key}.`);
            ids.add(String(node.id));
            for (const field of ["levels", "upgrades", "variants"]) {
                if (node[field] !== undefined && (!Array.isArray(node[field]) || node[field].some(v => !object(v)))) throw new Error(`Livelli non validi: ${key}.`);
            }
        }
        trees[key] = { ...tree, id: key };
    }
    for (const state of states) {
        if (!object(state) || !state.treeKey || !(state.characterId || state.ownerCharacterId || state.playerId || state.subjectId || state.shared || state.campaignShared)) throw new Error("Stato albero incompleto.");
        const ids = state.unlocked ?? state.unlockedNodeIds;
        if (!Array.isArray(ids) || ids.some(id => !["string", "number"].includes(typeof id) || !String(id))
            || (state.levels !== undefined && !object(state.levels))) throw new Error(`Sblocchi non validi: ${state.treeKey}.`);
        if ((state.updatedAt && !Number.isFinite(Date.parse(state.updatedAt)))
            || Object.values(state.levels || {}).some(level => !Number.isFinite(Number(level)))) throw new Error(`Data o livelli non validi: ${state.treeKey}.`);
    }
    return { campaignId, trees, states, treeVersion: treePayload.version, stateVersion: statePayload.version };
}

export function isSkillTreeSyncLeader(game) {
    if (!game?.user?.isGM) return false;
    const leader = game.users?.activeGM || values(game.users).filter(u => u.isGM && u.active).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    return Boolean(leader && leader.id === game.user.id);
}

function itemSources(item, context) {
    const flag = item.flags?.[MODULE_ID]?.skillTree;
    if (!flag) return [];
    if (Array.isArray(flag.sources)) return flag.sources.filter(s => s.campaignId === context.campaignId && s.characterId === context.characterId && s.treeKey && s.nodeId !== undefined);
    if (!flag.treeKey || flag.nodeId === undefined) return [];
    if (flag.campaignId && flag.campaignId !== context.campaignId) return [];
    if (flag.characterId && flag.characterId !== context.characterId) return [];
    // Legacy imports can be claimed only when the original tree is still associated.
    if (!flag.campaignId && !context.associatedKeys.has(flag.treeKey)) return [];
    return [{ campaignId: context.campaignId, characterId: context.characterId, treeKey: flag.treeKey, nodeId: String(flag.nodeId) }];
}

function foreignSources(item, context) {
    return (item.flags?.[MODULE_ID]?.skillTree?.sources || []).filter(s => s.campaignId !== context.campaignId || s.characterId !== context.characterId);
}

function grantIdentity(node) {
    if (node.abilityId || node.grantKey) return `id:${node.abilityId || node.grantKey}`;
    // Equal names alone are insufficient to merge two independently authored abilities.
    const description = String(node.desc || node.description || "").trim();
    return description ? JSON.stringify([node.itemType || "feat", normalize(node.title || node.name), description]) : null;
}

function ownedUpdate(item, group, context, buildItem) {
    const chosen = [...group.grants].sort((a, b) => b.node.level - a.node.level || sourceKey(a.source).localeCompare(sourceKey(b.source)))[0];
    const generated = buildItem(chosen.node, chosen.tree, chosen.source.treeKey, chosen.node.level);
    const oldFlag = item?.flags?.[MODULE_ID]?.skillTree || {};
    const sources = [...group.grants.map(g => g.source), ...foreignSources(item || {}, context)].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
    const flag = {
        ...oldFlag, ...chosen.source, version: 2, sources, level: chosen.node.level,
        importedImage: generated.img, abilityIdentity: grantIdentity(chosen.node)
    };
    const update = { name: generated.name, "system.description.value": generated.system.description.value };
    if (!item?.img || item.img === generated.img || item.img === oldFlag.importedImage || item.img === "icons/svg/aura.svg") update.img = generated.img;
    update[flagPath] = flag;
    if (item) {
        const get = key => key.split(".").reduce((o, k) => o?.[k], item);
        for (const key of Object.keys(update)) if (same(get(key), update[key])) delete update[key];
    }
    return { generated, update, flag };
}

export function planSkillTreeActor({ actor, snapshot, entries, characterId, candidates, buildItem }) {
    const { campaignId, trees, states } = snapshot;
    const context = { campaignId, characterId, associatedKeys: new Set(entries.map(e => e.key)) };
    const plan = { actor, context, create: [], update: [], retire: [], warnings: [] };
    const previous = actor.flags?.[MODULE_ID]?.skillTreeSync;
    if (previous?.campaignId === campaignId && (previous.treeVersion > snapshot.treeVersion || previous.stateVersion > snapshot.stateVersion)) throw new Error(`Dati precedenti all’ultima sincronizzazione di ${actor.name}.`);
    const items = values(actor.items);
    const desired = [];
    for (const { key, tree } of entries) {
        if (isArchivedSkillTree(tree)) continue;
        const state = selectSkillTreeState({ states, campaignId, treeKey: key, tree, characterId, candidates });
        const unlocked = unlockedSkillTreeNodes(tree, state);
        for (const id of unlocked) if (!tree.nodes.some(n => String(n.id) === id)) throw new Error(`Sblocco senza nodo: ${key}/${id}.`);
        for (const node of tree.nodes) {
            if (!unlocked.has(String(node.id)) || isSkillTreeGroup(node)) continue;
            desired.push({ source: { campaignId, characterId, treeKey: key, nodeId: String(node.id) }, tree,
                node: skillNodeAtLevel(node, state?.levels?.[String(node.id)]) });
        }
    }
    const owned = items.filter(i => itemSources(i, context).length);
    const groups = [];
    for (const grant of desired) {
        const identity = grantIdentity(grant.node);
        const existing = owned.find(i => itemSources(i, context).some(s => sourceKey(s) === sourceKey(grant.source)))
            || (identity && owned.find(i => i.flags?.[MODULE_ID]?.skillTree?.abilityIdentity === identity));
        let group = groups.find(g => (existing && g.existing === existing) || (identity && g.identities.has(identity)));
        if (!group) { group = { grants: [], identities: new Set(), existing }; groups.push(group); }
        group.existing ||= existing;
        group.grants.push(grant);
        if (identity) group.identities.add(identity);
    }
    const retained = new Set();
    const archives = Object.values(actor.flags?.[MODULE_ID]?.skillTreeArchive || {});
    for (const group of groups) {
        const keys = new Set(group.grants.map(g => sourceKey(g.source)));
        const matches = owned.filter(i => itemSources(i, context).some(s => keys.has(sourceKey(s))));
        const item = group.existing || matches[0];
        const selected = group.grants[0];
        if (!item) {
            const collision = items.find(i => normalize(i.name) === normalize(selected.node.title || selected.node.name));
            if (collision) {
                retained.add(collision.id || collision._id);
                plan.warnings.push({ code: "unlinked-name", itemId: collision.id || collision._id, name: collision.name, treeKey: selected.source.treeKey, nodeId: selected.source.nodeId });
                continue;
            }
        }
        const archived = !item && archives.find(a => ["retired", "pending"].includes(a.status) && itemSources(a.item, context).some(s => keys.has(sourceKey(s))));
        const sourceItem = item || archived?.item;
        const { generated, update, flag } = ownedUpdate(sourceItem, group, context, buildItem);
        if (item) {
            retained.add(item.id || item._id);
            if (Object.keys(update).length) plan.update.push({ _id: item.id || item._id, ...update });
        } else {
            const data = archived ? clone(archived.item) : generated;
            if (archived && items.some(i => (i.id || i._id) === data._id)) throw new Error(`Identificatore occupato nel ripristino di ${data.name}.`);
            data.name = update.name ?? data.name;
            data.img = update.img ?? data.img;
            data.system.description.value = update["system.description.value"] ?? data.system.description.value;
            data.flags ||= {};
            data.flags[MODULE_ID] ||= {};
            data.flags[MODULE_ID].skillTree = flag;
            plan.create.push({ data, archiveId: archived?.item?._id || null });
        }
        // Duplicate owned copies may contain different macros or resource counters.
        // Preserve and report them rather than choosing one destructively.
        for (const duplicate of matches.filter(i => i !== item)) {
            retained.add(duplicate.id || duplicate._id);
            plan.warnings.push({ code: "duplicate-managed", itemId: duplicate.id || duplicate._id, name: duplicate.name });
        }
    }
    for (const item of owned) {
        if (retained.has(item.id || item._id)) continue;
        const other = foreignSources(item, context);
        if (other.length) {
            plan.update.push({ _id: item.id || item._id, [flagPath]: { ...item.flags[MODULE_ID].skillTree, ...other[0], sources: other } });
            continue;
        }
        plan.retire.push(item);
    }
    // Do not silently claim untagged historical/manual abilities from archived trees.
    for (const item of items.filter(i => !itemSources(i, context).length)) {
        const link = item.flags?.[MODULE_ID]?.skillTree;
        if (link && !link.campaignId && !link.sources && !context.associatedKeys.has(link.treeKey)) {
            plan.warnings.push({ code: "unresolved-origin", itemId: item.id || item._id, name: item.name });
            continue;
        }
        if (!entries.some(e => e.tree.nodes.some(n => normalize(n.title || n.name) === normalize(item.name)))) continue;
        if (!plan.warnings.some(w => w.itemId === (item.id || item._id))) plan.warnings.push({ code: "unlinked-item", itemId: item.id || item._id, name: item.name });
    }
    plan.syncState = { campaignId, treeVersion: snapshot.treeVersion, stateVersion: snapshot.stateVersion, warnings: plan.warnings };
    return plan;
}

export function collectSkillTreeEffects(item, actors) {
    const prefix = item.uuid || `Actor.${item.parent?.id || item.actor?.id}.Item.${item.id || item._id}`;
    const roots = new Set([prefix, ...values(item.effects).map(e => e.uuid).filter(Boolean)]);
    const effects = [...new Map(actors.flatMap(a => [
        ...values(a.effects), ...values(a.items).filter(i => i !== item).flatMap(i => values(i.effects))
    ]).filter(e => e.uuid).map(e => [e.uuid, e])).values()];
    const selected = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        for (const effect of effects) {
            if (selected.has(effect)) continue;
            const links = [effect.origin, effect.flags?.dnd5e?.dependentOn, effect.dependentOrigin?.uuid];
            if (!links.some(link => typeof link === "string" && [...roots].some(root => link === root || link.startsWith(`${root}.`)))) continue;
            selected.add(effect);
            roots.add(effect.uuid);
            changed = true;
        }
    }
    return [...selected];
}

async function checkedMutation(canWrite, task) {
    if (!canWrite()) throw new Error("Sincronizzazione interrotta: autorità GM, campagna o modalità cambiata.");
    return task();
}

export async function applySkillTreeActorPlan(plan, { canWrite, effectActors }) {
    const { actor } = plan;
    const mutate = task => checkedMutation(canWrite, task);
    for (const item of plan.retire) {
        const id = item.id || item._id;
        const effects = collectSkillTreeEffects(item, effectActors());
        const old = actor.flags?.[MODULE_ID]?.skillTreeArchive?.[id];
        const previousEffects = old?.status === "pending" ? old.effects || [] : [];
        const archive = {
            status: "pending", retiredAt: new Date().toISOString(), item: item.toObject ? item.toObject() : clone(item),
            effects: [...new Map([
                ...effects.map(e => ({ uuid: e.uuid, data: e.toObject ? e.toObject() : clone(e) })),
                ...previousEffects
            ].map(e => [e.uuid, e])).values()]
        };
        await mutate(() => actor.update({ [`${archivePath}.${id}`]: archive }, syncOptions()));
        if (!same(actor.flags?.[MODULE_ID]?.skillTreeArchive?.[id]?.item, archive.item)) {
            throw new Error(`Copia di recupero non salvata: ${item.name}.`);
        }
        for (const effect of effects) {
            // Only benefits explicitly linked to the retired source are touched.
            if (!effect.disabled) await mutate(() => effect.update({ disabled: true }, syncOptions()));
            if (!effect.disabled) throw new Error(`Impossibile disattivare l’effetto ${effect.name}.`);
        }
        await mutate(() => actor.deleteEmbeddedDocuments("Item", [id], syncOptions()));
        if (values(actor.items).some(i => (i.id || i._id) === id)) throw new Error(`Rimozione annullata: ${item.name}.`);
        await mutate(() => actor.update({ [`${archivePath}.${id}.status`]: "retired" }, syncOptions()));
    }
    for (const entry of plan.create) {
        const created = await mutate(() => actor.createEmbeddedDocuments("Item", [entry.data], syncOptions({ keepId: Boolean(entry.archiveId) })));
        if (!created?.length) throw new Error(`Creazione annullata: ${entry.data.name}.`);
        if (entry.archiveId) await mutate(() => actor.update({ [`${archivePath}.${entry.archiveId}.status`]: "restored" }, syncOptions()));
    }
    if (plan.update.length) {
        const updated = await mutate(() => actor.updateEmbeddedDocuments("Item", plan.update, syncOptions()));
        if (updated?.length !== plan.update.length) throw new Error(`Aggiornamento incompleto: ${actor.name}.`);
    }
    if (!same(actor.flags?.[MODULE_ID]?.skillTreeSync, plan.syncState)) {
        await mutate(() => actor.update({ [`flags.${MODULE_ID}.skillTreeSync`]: plan.syncState }, syncOptions()));
    }
}

export function summarizeSkillTreePlans(plans) {
    return {
        created: plans.reduce((n, p) => n + p.create.length, 0),
        updated: plans.reduce((n, p) => n + p.update.length, 0),
        retired: plans.reduce((n, p) => n + p.retire.length, 0),
        warnings: plans.flatMap(p => p.warnings.map(w => ({ actorId: p.actor.id, actor: p.actor.name, ...w }))),
        actors: plans.map(p => ({ actorId: p.actor.id, actor: p.actor.name, create: p.create.map(e => e.data.name),
            update: p.update.map(e => ({ itemId: e._id, name: e.name || values(p.actor.items).find(i => (i.id || i._id) === e._id)?.name })), retire: p.retire.map(i => i.name) }))
    };
}

export function createSkillTreeSyncQueue(run) {
    let running = null;
    let queued = false;
    return function synchronize() {
        queued = true;
        if (running) return running;
        running = (async () => {
            let result;
            do { queued = false; result = await run(); } while (queued);
            return result;
        })().finally(() => { running = null; });
        return running;
    };
}
