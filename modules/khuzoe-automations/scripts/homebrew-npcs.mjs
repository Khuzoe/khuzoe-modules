import {RELEASE_VERSION} from "./release.mjs";
import {sceneUnitsPerFoot} from "./geometry.mjs";
import {adjustAppliedDamage, appliedDamageAmount, damageDealt} from "./damage-adjustment.mjs";
import {distanceInScene} from "./movement-compat.mjs";
import {grantTemporaryHP} from "./temporary-hp.mjs";
import {runSyntheticActivity} from "./activity-compat.mjs";
import {healActor} from "./healing.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {applyResolvedDamage} from "./resolved-damage.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const MODULE_TITLE = "Khuzoe Automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeNpcFeatures2014.Item";

export const NPC_IDS = Object.freeze({
  nanissAura: "naniss-p-unaura-di-energia-be",
  nanissSummon: "naniss-p-come-azione-bonus-na",
  nanissDance: "naniss-p-quando-una-creatura-a",
  nanissMultiattack: "naniss-p-naniss-effettua-tre",
  purifyingStrike: "colpo-purificante",
  spiritAura: "spirito-elementale-fatato-p-ogni-creatura-entro-1",
  spiritExplosion: "spirito-elementale-fatato-p-quando-lo-spirito-muo",
  spiritProtector: "spirito-elementale-fatato-p-quando-una-creatura-n",
  spiritMultiattack: "spirito-elementale-fatato-p-lo-spirito-effettua-d",
  energeticStrike: "colpo-energico",
  elathelMultiattack: "multiattack",
  psychicMelee: "psychic-strike-melee",
  psychicRanged: "psychic-strike-ranged",
  brainStorm: "brain-storm",
  impenetrableEgo: "impenetrable-ego",
  appeal: "appeal-to-the-fervent"
});

export const NPC_AURA_IDS = Object.freeze({
  naniss: "khz-naniss-reinvigorating",
  spirit: "khz-fey-spirit-reinvigorating"
});

const EFFECT_IDS = Object.freeze({
  brainPoison: "khuzoe-elathel-brain-storm-poison",
  danceSpent: "khuzoe-naniss-dance-spent",
  healingMaximum: "khuzoe-naniss-maximized-healing",
  psychicStun: "khuzoe-elathel-psychic-stun"
});

const DOCUMENTS = Object.freeze([
  [NPC_IDS.nanissAura, "KhzNpcNanAura001", "feat", "Crea e mantiene l'Aura Rinvigorente da 15 ft, con 1d6 cure all'inizio e alla fine del turno di ogni alleato."],
  [NPC_IDS.nanissSummon, "KhzNpcNanSumm001", "feat", "Evoca lo Spirito Elementale Fatato entro 30 ft e lo collega all'iniziativa di Na'Niss."],
  [NPC_IDS.nanissDance, "KhzNpcNanDance01", "feat", "Propone 1d10+5 come reazione ai d20 degli alleati dentro l'aura."],
  [NPC_IDS.nanissMultiattack, "KhzNpcNanMulti01", "feat", "Esegue tre Colpi Purificanti sul bersaglio selezionato."],
  [NPC_IDS.purifyingStrike, "KhzNpcNanStrike1", "weapon", "Cura un alleato dentro le aure per i danni effettivamente inflitti e gestisce la soglia di due colpi."],
  [NPC_IDS.spiritAura, "KhzNpcFeyAura001", "feat", "Crea l'Aura Rinvigorente Espansa da 15 ft; la sua cura passiva si somma a quella di Na'Niss."],
  [NPC_IDS.spiritExplosion, "KhzNpcFeyExpl001", "feat", "Alla morte cura di 4d6 tutti gli alleati che si trovano in una delle due aure."],
  [NPC_IDS.spiritProtector, "KhzNpcFeyProt001", "feat", "Propone la protezione soltanto agli alleati nell'aura; trasferisce il danno dopo la conclusione del colpo originale."],
  [NPC_IDS.spiritMultiattack, "KhzNpcFeyMulti01", "feat", "Esegue due Colpi Energici sul bersaglio selezionato."],
  [NPC_IDS.energeticStrike, "KhzNpcFeyStrike1", "weapon", "Conferisce a un alleato dentro le aure PF temporanei pari ai danni effettivamente inflitti."],
  [NPC_IDS.psychicMelee, "KhzNpcElaMelee01", "weapon", "Conta i colpi di Psychic Strike sullo stesso bersaglio e applica lo stordimento dopo il secondo fallimento su INT."],
  [NPC_IDS.psychicRanged, "KhzNpcElaRange01", "weapon", "Corregge la variante ranged a 60 ft e condivide il conteggio per lo stordimento."],
  [NPC_IDS.brainStorm, "KhzNpcElaBrain01", "feat", "Corregge il danno a 9d6 e gestisce Avvelenato con nuovo TS INT a fine turno."],
  [NPC_IDS.impenetrableEgo, "KhzNpcElaEgo0001", "feat", "Aggiunge automaticamente Carisma ai TS mentre El'Athel è cosciente e senza armatura o scudo, con vantaggio contro charme e paura."],
  [NPC_IDS.appeal, "KhzNpcElaAppeal1", "feat", "Quando El'Athel viene bersagliato, propone lo scambio con un alleato adiacente e reindirizza l'attacco."]
]);

export const HOME_BREW_NPC_IDENTIFIERS = new Set(DOCUMENTS.map(([identifier]) => identifier));

export const HOME_BREW_NPC_AUTOMATIONS = DOCUMENTS.map(([identifier, id, type, notes]) => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier,
  version: VERSION,
  uuid: `${PACK}.${id}`,
  type,
  notes
}));

const attackCounters = new Map();
const spiritTransferFallback = new WeakMap();
const danceReactionResetTasks = new WeakMap();
let missingAuraWarningShown = false;

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  if (typeof collection === "object" && !collection[Symbol.iterator]) return Object.values(collection);
  return Array.from(collection);
}

function slug(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function identifier(document) {
  return slug(document?.system?.identifier || document?.flags?.cat?.identifier || document?.name);
}

function tokenDocument(token) {
  return token?.document ?? token ?? null;
}

function sameToken(left, right) {
  left = tokenDocument(left);
  right = tokenDocument(right);
  if (!left || !right) return false;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return Boolean(left.id && right.id && left.id === right.id && left.parent?.id === right.parent?.id);
}

function targetDocuments(workflow, key = "targets") {
  return values(workflow?.[key]).map(tokenDocument).filter(token => token?.actor);
}

function actorItem(actor, itemIdentifier) {
  return values(actor?.items).find(item => identifier(item) === itemIdentifier) ?? null;
}

function itemActivity(item) {
  return item?.system?.activities?.contents?.[0]
    ?? values(item?.system?.activities)[0]
    ?? null;
}

function sourceTokenForActor(actor) {
  if (!actor) return null;
  const active = values(actor?.getActiveTokens?.(false, true)).map(tokenDocument).find(token => token?.parent?.id === globalThis.canvas?.scene?.id);
  return active ?? values(globalThis.canvas?.scene?.tokens).find(token => (
    (token?.actor?.uuid && actor?.uuid && token.actor.uuid === actor.uuid)
    || (token?.actor?.id && actor?.id && token.actor.id === actor.id)
  )) ?? null;
}

function ownerUserId(document) {
  return globalThis.cat?.utils?.queryUtils?.firstOwner?.(document, true) ?? game.user.id;
}

function escapeHtml(value) {
  if (!globalThis.document?.createElement) return String(value ?? "");
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function isConscious(actor) {
  if (!actor || Number(actor.system?.attributes?.hp?.value ?? 0) <= 0) return false;
  return !["dead", "incapacitated", "paralyzed", "stunned", "unconscious"].some(status => actor.statuses?.has?.(status));
}

function canReact(actor) {
  const marker = actor?.flags?.[MODULE_ID]?.nanissDanceReaction;
  const combat = game.combat;
  const danceReactionUsed = Boolean(combat?.started && marker?.combatId === combat.id);
  return isConscious(actor)
    && !danceReactionUsed
    && !globalThis.cat?.utils?.actorUtils?.hasUsedReaction?.(actor);
}

function isAlly(source, target) {
  source = tokenDocument(source);
  target = tokenDocument(target);
  if (!source || !target) return false;
  try {
    return globalThis.cat?.utils?.tokenUtils?.isAlly?.(source, target) ?? source.disposition === target.disposition;
  } catch (_error) {
    return source.disposition === target.disposition;
  }
}

function within(source, target, distance) {
  source = tokenDocument(source);
  target = tokenDocument(target);
  if (!source || !target || source.parent?.id !== target.parent?.id) return false;
  return Number(globalThis.cat?.utils?.tokenUtils?.getDistance?.(source, target, {wallsBlock: true}) ?? Infinity) <= distance;
}

function auraApi({notify = false} = {}) {
  const api = game.khuzoeAuras;
  if (api?.getAuraSources && api?.getEligibleTargets) return api;
  if (notify && game.user?.isGM && !missingAuraWarningShown) {
    missingAuraWarningShown = true;
    ui.notifications.warn(`${MODULE_TITLE}: attiva Khuzoe Auras per le capacità coordinate di Na'Niss e dello Spirito Elementale Fatato.`);
  }
  return null;
}

function auraSourceEntries(scene = globalThis.canvas?.scene) {
  const api = auraApi();
  if (!api || !scene) return [];
  return Object.values(NPC_AURA_IDS).flatMap(auraId => api.getAuraSources(scene, auraId));
}

function auraFamily(actor, scene) {
  if (!actor) return null;
  const explicit = actor.flags?.[MODULE_ID]?.npcSummonerUuid;
  const summon = globalThis.cat?.lib?.constants?.summons?.getSummonData?.(actor);
  if (explicit || summon?.ownerUuid) return explicit ?? summon.ownerUuid;
  if (actorItem(actor, NPC_IDS.spiritAura)) {
    const sources = new Map(values(scene?.tokens).filter(token => actorItem(token.actor, NPC_IDS.nanissAura))
      .map(token => [token.actor.uuid, token.actor]));
    if (sources.size === 1) return sources.keys().next().value;
  }
  return actor.uuid;
}

function eligibleAuraTargets(scene = globalThis.canvas?.scene, {includeInactiveSource = false, sourceActor} = {}) {
  const api = auraApi({notify: true});
  const targets = new Map();
  if (!api || !scene) return [];
  for (const {token, aura} of auraSourceEntries(scene)) {
    if (sourceActor && auraFamily(token.actor, scene) !== auraFamily(sourceActor, scene)) continue;
    const allowInactive = includeInactiveSource && token.actor?.uuid === sourceActor?.uuid;
    for (const target of api.getEligibleTargets(token, aura.id, {includeInactiveSource: allowInactive})) {
      targets.set(target.uuid ?? `${scene.id}.${target.id}`, target);
    }
  }
  return Array.from(targets.values());
}

function targetInsideAuras(target, options = {}) {
  return eligibleAuraTargets(target?.parent ?? globalThis.canvas?.scene, options).some(candidate => sameToken(candidate, target));
}

function targetInsideSpiritAura(spiritToken, target) {
  const api = auraApi({notify: true});
  if (!api?.isTargetEligible) return false;
  return Boolean(api.isTargetEligible(spiritToken, target, NPC_AURA_IDS.spirit));
}

function workflowSpiritTransferQueue(workflow, {create = false} = {}) {
  if (!workflow || (typeof workflow !== "object" && typeof workflow !== "function")) return null;
  try {
    if (create) workflow.khuzoeSpiritualProtectorTransfers ??= [];
    return workflow.khuzoeSpiritualProtectorTransfers ?? null;
  } catch (_error) {
    let queue = spiritTransferFallback.get(workflow);
    if (!queue && create) {
      queue = [];
      spiritTransferFallback.set(workflow, queue);
    }
    return queue ?? null;
  }
}

function reinvigoratingAura(id, name, color, visual = {}) {
  return {
    id,
    name,
    enabled: true,
    area: {distance: 15, walls: false, elevation: false},
    targets: {relation: "ally", includeSource: true},
    source: {requiresConscious: true},
    triggers: [
      {event: "turnStart", subject: "affected", frequency: "oncePerPhase"},
      {event: "turnEnd", subject: "affected", frequency: "oncePerPhase"}
    ],
    actions: [{
      id: `${id}-heal`,
      type: "healing",
      formula: "1d6",
      damageType: "radiant",
      rollMode: "perTarget",
      save: {enabled: false, ability: "con", dc: "0", onSuccess: "none"}
    }],
    stacking: {group: "", mode: "stack", priority: 0},
    visual: {
      visible: true,
      color,
      opacity: visual.opacity ?? 0.045,
      lineOpacity: visual.lineOpacity ?? 0.28,
      lineWidth: visual.lineWidth ?? 1.25
    }
  };
}

const AURA_DEFINITIONS = Object.freeze({
  [NPC_IDS.nanissAura]: reinvigoratingAura(
    NPC_AURA_IDS.naniss,
    "Aura Rinvigorente",
    "#58c987",
    {opacity: 0.075, lineOpacity: 0.48, lineWidth: 1.5}
  ),
  [NPC_IDS.spiritAura]: reinvigoratingAura(
    NPC_AURA_IDS.spirit,
    "Aura Rinvigorente Espansa",
    "#9be7a7",
    {opacity: 0.06, lineOpacity: 0.38, lineWidth: 1.35}
  )
});

function managedAuraMatches(current, expected) {
  return ["id", "name", "area", "targets", "source", "triggers", "actions", "stacking", "visual"]
    .every(field => JSON.stringify(current?.[field]) === JSON.stringify(expected?.[field]));
}

export async function ensureHomebrewNpcAuras(subject = globalThis.canvas?.scene) {
  if (!npcMaintenanceWriter()) return false;
  const api = auraApi({notify: true});
  if (!api) return false;
  const tokens = subject?.documentName === "Token" || subject?.actor
    ? [tokenDocument(subject)]
    : values(subject?.tokens);
  let changed = false;
  for (const token of tokens) {
    if (!token?.actor) continue;
    const auraDefinition = Object.entries(AURA_DEFINITIONS).find(([itemIdentifier]) => actorItem(token.actor, itemIdentifier));
    if (!auraDefinition) {
      const current = api.getAuras(token);
      const retained = current.filter(aura => !Object.values(NPC_AURA_IDS).includes(aura.id));
      if (retained.length !== current.length) { await api.setAuras(token, retained); changed = true; }
      continue;
    }
    const [, baseDefinition] = auraDefinition;
    const existing = api.getAura(token, baseDefinition.id);
    const definition = {...baseDefinition, area: existing?.area ?? {
      ...baseDefinition.area, distance: baseDefinition.area.distance * sceneUnitsPerFoot(token.parent)
    }};
    if (!existing) {
      await api.setAuras(token, [...api.getAuras(token), definition]);
      changed = true;
      continue;
    }
    if (managedAuraMatches(existing, definition)) continue;
    await api.setAuras(token, api.getAuras(token).map(aura => (
      aura.id === definition.id
        ? {...structuredClone(definition), enabled: aura.enabled}
        : aura
    )));
    changed = true;
  }
  return changed;
}

export async function ensureHomebrewNpcHelpers(subject = globalThis.canvas?.scene) {
  if (!npcMaintenanceWriter()) return;
  const actors = subject?.documentName === "Actor"
    ? [subject]
    : subject?.actor
      ? [subject.actor]
      : values(subject?.tokens).map(token => token.actor).filter(Boolean);
  for (const actor of new Set(actors)) {
    await reconcileImpenetrableEgo(actor);
    const dance = actorItem(actor, NPC_IDS.nanissDance);
    if (dance) {
      const updates = {};
      for (const activity of values(dance.system?.activities)) {
        if (activity.activation?.type === "special" && activity.activation?.value == null && activity.activation?.override === true) continue;
        const activityId = activity.id ?? activity._id;
        if (!activityId) continue;
        updates[`system.activities.${activityId}.activation.type`] = "special";
        updates[`system.activities.${activityId}.activation.value`] = null;
        updates[`system.activities.${activityId}.activation.override`] = true;
      }
      if (Object.keys(updates).length) await updateDocumentSafely(dance, updates);
    }

    if (!actorItem(actor, NPC_IDS.psychicMelee) || !actorItem(actor, NPC_IDS.psychicRanged)) continue;
    const multiattack = actorItem(actor, NPC_IDS.elathelMultiattack);
    if (!multiattack) continue;
    const reference = {source: MODULE_ID, rules: RULES, identifier: NPC_IDS.elathelMultiattack};
    const current = values(multiattack.flags?.cat?.macros?.roll);
    if (current.some(entry => entry.source === reference.source && entry.rules === reference.rules && entry.identifier === reference.identifier)) continue;
    await updateDocumentSafely(multiattack, {
      "flags.cat.macros.roll": [...current, reference],
      [`flags.${MODULE_ID}.npcHelper`]: {kind: "elathel-multiattack", version: VERSION}
    });
  }
}

async function refreshAuraFeature({document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item;
  const token = sourceTokenForActor(feature?.actor);
  if (token) await ensureHomebrewNpcAuras(token);
}

async function chooseAuraTarget(item, {message, candidates} = {}) {
  candidates ??= eligibleAuraTargets(globalThis.canvas?.scene, {sourceActor: item.actor});
  const filtered = candidates.filter(target => target?.actor);
  if (!filtered.length) {
    ui.notifications.warn(`${item.name}: nessun alleato idoneo dentro le aure.`);
    return null;
  }
  if (filtered.length === 1) return filtered[0];
  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    item.name,
    message,
    filtered,
    {
      type: "one",
      displayDistance: false,
      skipDeadAndUnconscious: false,
      userId: ownerUserId(item.actor)
    }
  );
  return tokenDocument(selection?.result);
}

async function createChat(item, content, actor = item?.actor) {
  try {
    await ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({actor}),
      flavor: item?.name ?? MODULE_TITLE,
      content
    });
  } catch (_error) {
    // Il messaggio è unicamente informativo.
  }
}

async function updateDocumentAsOwnerOrGM(document, updates, options = {}) {
  return updateDocumentSafely(document, updates, options);
}

async function applyHealing(item, target, amount, {maximized = false, maximizeFormula} = {}) {
  const hp = target?.actor?.system?.attributes?.hp;
  if (!amount || !hp) return 0;
  const before = Number(hp.value ?? 0);
  await healActor(target.actor, amount, {sourceItem: item, token: target, maximizeFormula});
  const after = Number(target.actor.system?.attributes?.hp?.value ?? before);
  const applied = Math.max(0, after - before);
  try {
    await createChat(item, `<p><strong>${escapeHtml(target.name)}</strong> recupera <strong>${applied}</strong> PF${maximized ? " (cura massimizzata)" : ""}.</p>`);
  } catch (error) {
    console.warn(`${MODULE_TITLE} | Cura applicata; messaggio di riepilogo non disponibile.`, error);
  }
  return applied;
}

async function applyTemporaryHitPoints(item, target, amount) {
  amount = Math.max(0, Math.floor(Number(amount ?? 0)));
  if (!amount || !target?.actor) return 0;
  const before = Number(target.actor.system?.attributes?.hp?.temp ?? 0);
  await grantTemporaryHP(target.actor, amount, item);
  const after = Number(target.actor.system?.attributes?.hp?.temp ?? before);
  await createChat(item, `<p><strong>${escapeHtml(target.name)}</strong> ottiene <strong>${Math.max(0, after - before)}</strong> PF temporanei (totale ${after}).</p>`);
  return Math.max(0, after - before);
}

function damageDone(workflow, target) {
  return damageDealt(workflow, target);
}

async function rollFormula(formula, actor) {
  const RollClass = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
  const roll = typeof RollClass?.create === "function"
    ? RollClass.create(formula, actor?.getRollData?.() ?? {})
    : new RollClass(formula, actor?.getRollData?.() ?? {});
  return roll.evaluate({allowInteractive: false});
}

async function savingThrow(target, ability, dc) {
  const rolls = await target.actor.rollSavingThrow(
    {ability},
    {configure: false, target: dc},
    {create: true}
  );
  const roll = rolls?.[0];
  if (!roll) return null;
  const total = Number(roll.total ?? 0);
  return {roll, total, success: total >= dc, margin: dc - total};
}

function macroReference(effectIdentifier) {
  return {source: MODULE_ID, rules: RULES, identifier: effectIdentifier};
}

function effectByIdentifier(actor, effectIdentifier) {
  return values(actor?.effects).find(effect => effect.flags?.cat?.identifier === effectIdentifier) ?? null;
}

async function replaceEffect(actor, data) {
  const existing = effectByIdentifier(actor, data.flags?.cat?.identifier);
  if (existing) await globalThis.cat.utils.documentUtils.deleteDocument(existing);
  return globalThis.cat.utils.effectUtils.createEffects(actor, [data], {rules: RULES});
}

function timedDuration(seconds, expiry = "turnEnd") {
  return {value: seconds, units: "seconds", expiry, expired: false};
}

async function applyPsychicStun(item, target) {
  const save = await savingThrow(target, "int", 16);
  if (!save || save.success) return;
  await replaceEffect(target.actor, {
    name: `${item.name}: Stordito`,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {changes: []},
    duration: timedDuration(6, "turnEnd"),
    statuses: ["stunned"],
    description: "<p>Stordito fino alla fine del prossimo turno di questa creatura.</p>",
    showIcon: 1,
    flags: {
      cat: {identifier: EFFECT_IDS.psychicStun},
      dae: {transfer: false, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
    }
  });
}

function turnCounterKey(actor, target, family) {
  const combat = game.combat;
  if (combat?.started) return `${family}:${actor.uuid}:${target.uuid}:${combat.id}:${combat.round}:${combat.turn}`;
  return `${family}:${actor.uuid}:${target.uuid}:world:${Math.floor(Date.now() / 30000)}`;
}

async function recordHit(actor, target, family, workflow) {
  return withDocumentLock(actor, "npc-hits", async () => {
  const key = turnCounterKey(actor, target, family);
  const stored = actor.flags?.[MODULE_ID]?.npcHits ?? {};
  const state = structuredClone(stored[key] ?? attackCounters.get(key) ?? {hits: 0, fired: false, workflows: []});
  const event = workflow?.id ?? workflow?.uuid;
  if (event && state.workflows?.includes(event)) return false;
  state.workflows ??= [];
  if (event) state.workflows.push(event);
  state.hits += 1;
  attackCounters.set(key, state);
  if (attackCounters.size > 200) attackCounters.delete(attackCounters.keys().next().value);
  const reached = state.hits >= 2 && !state.fired;
  if (reached) state.fired = true;
  const currentTurn = game.combat?.started ? `:${game.combat.id}:${game.combat.round}:${game.combat.turn}` : `:world:${Math.floor(Date.now() / 30000)}`;
  const retained = Object.fromEntries(Object.entries(stored).filter(([entry]) => entry.endsWith(currentTurn)));
  retained[key] = state;
  await updateDocumentSafely(actor, {[`flags.${MODULE_ID}.npcHits`]: retained});
  return reached;
  });
}

async function handlePsychicStrike({workflow, document, item} = {}) {
  const strike = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!strike || !workflow) return;
  const target = targetDocuments(workflow, "hitTargets")[0];
  if (!target) return;
  if (await recordHit(strike.actor, target, "elathel-psychic", workflow)) await applyPsychicStun(strike, target);
}

async function applyMaximizedHealing(item, target) {
  await replaceEffect(target.actor, {
    name: "Cure massimizzate da Na'Niss",
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {
      changes: [{key: "flags.midi-qol.grants.max.damage.heal", value: "1", priority: 20, type: "custom"}]
    },
    duration: timedDuration(60, "sourceStart"),
    statuses: [],
    description: `<p>Tutti i dadi di cura ricevuti sono massimizzati fino all'inizio del prossimo turno di Na'Niss.</p>`,
    showIcon: 1,
    flags: {
      cat: {identifier: EFFECT_IDS.healingMaximum},
      dae: {transfer: false, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
    }
  });
}

async function resolvePurifyingThreshold(item, struckTarget) {
  const save = await savingThrow(struckTarget, "con", 16);
  if (!save) {
    ui.notifications.warn(`${item.name}: il tiro salvezza su Costituzione del bersaglio non è stato completato.`);
    return;
  }
  await createChat(item, [
    `<p><strong>${escapeHtml(struckTarget.name)}</strong> è stato colpito almeno due volte nello stesso turno.</p>`,
    `<p>TS Costituzione CD 16: <strong>${save.total}</strong> — <strong>${save.success ? "superato" : "fallito"}</strong>.</p>`
  ].join(""), struckTarget.actor);
  if (save.success) return;
  const target = await chooseAuraTarget(item, {
    message: `<p><strong>${escapeHtml(struckTarget.name)}</strong> ha fallito il TS di Multiattacco. Scegli chi curare di 2d8.</p>`
  });
  if (!target) return;
  const maximized = save.margin >= 5;
  if (maximized) await applyMaximizedHealing(item, target);
  const amount = maximized ? 16 : "2d8";
  await applyHealing(item, target, amount, {maximized});
}

async function handlePurifyingStrike({workflow, document, item} = {}) {
  const strike = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!strike || !workflow) return;
  const struckTarget = targetDocuments(workflow, "hitTargets")[0];
  if (!struckTarget) return;
  const thresholdReached = await recordHit(strike.actor, struckTarget, "naniss-purifying", workflow);
  const damage = damageDone(workflow, struckTarget);
  if (damage > 0) {
    const healed = await chooseAuraTarget(strike, {
      message: `<p>Il Colpo Purificante ha inflitto <strong>${damage}</strong> danni. Scegli un alleato dentro le aure da curare.</p>`
    });
    if (healed) await applyHealing(strike, healed, damage);
  }
  if (thresholdReached) await resolvePurifyingThreshold(strike, struckTarget);
}

async function handleEnergeticStrike({workflow, document, item} = {}) {
  const strike = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!strike || !workflow) return;
  const struckTarget = targetDocuments(workflow, "hitTargets")[0];
  if (!struckTarget) return;
  const damage = damageDone(workflow, struckTarget);
  if (damage <= 0) return;
  const target = await chooseAuraTarget(strike, {
    message: `<p>Il Colpo Energico ha inflitto <strong>${damage}</strong> danni. Scegli chi riceve i PF temporanei.</p>`
  });
  if (target) await applyTemporaryHitPoints(strike, target, damage);
}

function bonusTargetToken(data) {
  return tokenDocument(data?.token)
    ?? sourceTokenForActor(data?.actor)
    ?? values(globalThis.canvas?.scene?.tokens).find(token => (
      token.actor?.uuid && data?.actor?.uuid && token.actor.uuid === data.actor.uuid
    ));
}

async function consumeEncouragingDanceReaction(sourceActor) {
  if (!canReact(sourceActor)) return false;
  const receipt = await reserveResources(sourceActor, {reaction: true});
  if (!receipt) return false;
  const combat = game.combat;
  try {
    if (combat?.started) {
    await updateDocumentSafely(sourceActor, {
      [`flags.${MODULE_ID}.nanissDanceReaction`]: {
        combatId: combat.id,
        round: Number(combat.round ?? 0)
      }
    });
    }
  } catch (error) {
    await refundResources(receipt);
    throw error;
  }
  try {
    const dance = actorItem(sourceActor, NPC_IDS.nanissDance);
    if (dance && !effectByIdentifier(sourceActor, EFFECT_IDS.danceSpent)) {
      await globalThis.cat.utils.effectUtils.createEffects(sourceActor, [{
        name: `${dance.name}: Reazione usata`,
        img: dance.img,
        origin: dance.uuid,
        type: "base",
        system: {changes: []},
        statuses: [],
        description: "<p>Na'Niss ha già usato Danza Incoraggiante e recupera la reazione all'inizio del suo prossimo turno.</p>",
        showIcon: 2,
        flags: {
          cat: {identifier: EFFECT_IDS.danceSpent},
          dae: {transfer: false, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
          [MODULE_ID]: {nanissDanceSpent: true}
        }
      }], {rules: RULES});
    }
  } catch (error) {
    // L'indicatore è solo informativo: un problema grafico non deve annullare
    // il bonus appena applicato né riaprire la reazione.
    console.warn(`${MODULE_TITLE} | Impossibile mostrare l'effetto di Danza Incoraggiante.`, error);
  }
  return true;
}

export async function resetEncouragingDanceReaction(combat, current) {
  if (!game.user?.isActiveGM || !combat || !current) return false;
  const actor = combat.combatants?.get?.(current.combatantId)?.actor
    ?? combat.scene?.tokens?.get?.(current.tokenId)?.actor;
  if (!actorItem(actor, NPC_IDS.nanissDance)) return false;

  const activeReset = danceReactionResetTasks.get(actor);
  if (activeReset) return activeReset;
  const reset = performEncouragingDanceReactionReset(actor);
  danceReactionResetTasks.set(actor, reset);
  try {
    return await reset;
  } finally {
    if (danceReactionResetTasks.get(actor) === reset) danceReactionResetTasks.delete(actor);
  }
}

async function performEncouragingDanceReactionReset(actor) {
  const marker = actor.flags?.[MODULE_ID]?.nanissDanceReaction;

  // Midi-QOL conserva una propria marcatura della reazione usata. Rimuovere
  // soltanto il flag Khuzoe lasciava quindi Danza permanentemente non valida
  // dopo il primo utilizzo. All'inizio del turno di Na'Niss vanno ripristinati
  // entrambi gli stati, come per qualunque altra reazione di D&D 5e.
  await globalThis.MidiQOL?.setReactionUsed?.(actor, false);
  const spentEffect = effectByIdentifier(actor, EFFECT_IDS.danceSpent);
  if (spentEffect) {
    try {
      await globalThis.cat.utils.documentUtils.deleteDocument(spentEffect);
    } catch (error) {
      // La cancellazione può essere già stata completata da un altro evento di
      // fine durata. In quel caso il risultato desiderato è già raggiunto.
      if (!/ActiveEffect .* does not exist/i.test(String(error?.message ?? error))) throw error;
    }
  }
  const update = {
    "flags.midi-qol.actions.reactionsUsed": 0,
    "flags.midi-qol.actions.reaction": false,
    "flags.midi-qol.actions.-=reactionCombatRound": null
  };
  if (marker) update[`flags.${MODULE_ID}.-=nanissDanceReaction`] = null;
  await updateDocumentSafely(actor, update);
  return true;
}

function provideEncouragingDanceBonus(data) {
  const item = data?.document;
  const sourceActor = item?.actor;
  const rolledToken = bonusTargetToken(data);
  if (!item || typeof data?.D20Bonus !== "function" || !rolledToken || !canReact(sourceActor)) return;
  if (!targetInsideAuras(rolledToken, {sourceActor})) return;
  const bonus = new data.D20Bonus(item, {formula: "1d10 + 5", actor: sourceActor, targetActor: data.actor});
  return bonus
    // CAT routes an ally's bonus through request(), whose default is rejection.
    // Ask the source actor's owner before the selected bonus spends a reaction.
    .withDefaultRequest()
    .withValidation(() => canReact(sourceActor))
    .withOnUse(async () => {
      const consumed = await consumeEncouragingDanceReaction(sourceActor);
      // CAT adds the roll even when onUse returns false. A second concurrent
      // selection must therefore contribute zero after losing the reservation.
      if (!consumed) bonus.roll = new bonus.rollClass("0");
      return consumed;
    })
    .initialize();
}

function selectedTargets(workflow) {
  const workflowTargets = targetDocuments(workflow);
  if (workflowTargets.length) return workflowTargets;
  return values(game.user?.targets).map(tokenDocument).filter(token => token?.actor);
}

async function executeRepeatedAttack(multiattack, workflow, attack, count) {
  const targets = selectedTargets(workflow);
  const activity = itemActivity(attack);
  if (!targets.length || !activity) {
    ui.notifications.warn(`${multiattack.name}: seleziona almeno un bersaglio prima di usare il Multiattacco.`);
    return;
  }
  for (let index = 0; index < count; index += 1) {
    let candidates = targets.filter(target => Number(target.actor?.system?.attributes?.hp?.value ?? 1) > 0);
    if (!candidates.length) candidates = selectedTargets({}).filter(target => Number(target.actor?.system?.attributes?.hp?.value ?? 1) > 0);
    if (!candidates.length) candidates = values(tokenDocument(workflow.token)?.parent?.tokens).filter(target => target.actor
      && !sameToken(target, tokenDocument(workflow.token)) && Number(target.actor.system?.attributes?.hp?.value ?? 1) > 0);
    if (!candidates.length) break;
    const selected = candidates.length === 1 ? candidates[0] : await cat.utils.dialogUtils.selectTargetDialog(
      multiattack.name, `Scegli il bersaglio dell'attacco ${index + 1} di ${count}.`, candidates,
      {type: "one", userId: ownerUserId(multiattack.actor)}
    );
    const target = tokenDocument(selected?.result ?? selected);
    if (!target?.actor) break;
    const result = await runSyntheticActivity(activity, [target], {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(multiattack.actor)
    });
    if (!result || result.aborted) break;
  }
}

async function executeNpcMultiattack({workflow, document, item} = {}) {
  const multiattack = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!multiattack || !workflow || workflow.options?.workflowOptions?.khuzoeNpcMultiattack) return;
  if (workflow.activity?.type && workflow.activity.type !== "utility") return;
  const id = identifier(multiattack);
  if (id === NPC_IDS.nanissMultiattack) {
    return executeRepeatedAttack(multiattack, workflow, actorItem(multiattack.actor, NPC_IDS.purifyingStrike), 3);
  }
  if (id === NPC_IDS.spiritMultiattack) {
    return executeRepeatedAttack(multiattack, workflow, actorItem(multiattack.actor, NPC_IDS.energeticStrike), 2);
  }
  if (id !== NPC_IDS.elathelMultiattack) return;
  const choice = await globalThis.cat.utils.dialogUtils.buttonDialog(
    multiattack.name,
    "<p>Scegli la variante di Psychic Strike da usare per i tre attacchi.</p>",
    [
      ["Melee", NPC_IDS.psychicMelee, {image: actorItem(multiattack.actor, NPC_IDS.psychicMelee)?.img}],
      ["Ranged", NPC_IDS.psychicRanged, {image: actorItem(multiattack.actor, NPC_IDS.psychicRanged)?.img}],
      ["Annulla", false, {image: "icons/svg/cancel.svg"}]
    ],
    {displayAsRows: true, userId: ownerUserId(multiattack.actor)}
  );
  if (!choice) return;
  return executeRepeatedAttack(multiattack, workflow, actorItem(multiattack.actor, choice), 3);
}

async function prepareFeySpiritSummon({workflow, document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || !workflow) return;
  const actor = feature.actor;
  const sourceUuid = feature.flags?.[MODULE_ID]?.summonSourceUuid;
  const configured = sourceUuid ? await globalThis.fromUuid?.(sourceUuid) : null;
  const possible = values(game.actors).filter(candidate => actorItem(candidate, NPC_IDS.spiritAura)
    && !globalThis.cat?.lib?.constants?.summons?.getSummonData?.(candidate));
  let sourceActor = configured ?? (possible.length === 1 ? possible[0] : null);
  if (!sourceActor && possible.length > 1) sourceActor = await cat.utils.dialogUtils.selectDocumentDialog(feature.name,
    "Scegli l’attore da usare come modello dello Spirito.", possible, {userId: ownerUserId(actor)});
  const manager = globalThis.cat?.lib?.constants?.summons;
  if (!sourceActor || !manager) {
    ui.notifications.warn(`${feature.name}: attore sorgente “Spirito Elementale Fatato” non disponibile.`);
    workflow.aborted = true;
    return true;
  }
  if (sourceActor?.documentName && sourceActor.documentName !== "Actor") { workflow.aborted = true; return true; }
  workflow.khuzoeSpiritSourceUuid = sourceActor.uuid;
  workflow.khuzoeSpiritBonusPreviouslyUsed = Boolean(globalThis.MidiQOL?.hasUsedBonusAction?.(actor));
  if (feature.flags?.[MODULE_ID]?.summonSourceUuid !== sourceActor.uuid) await updateDocumentSafely(feature, {[`flags.${MODULE_ID}.summonSourceUuid`]: sourceActor.uuid});
}

async function summonFeySpirit({workflow, document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || !workflow || workflow.aborted) return;
  const sourceActor = workflow.khuzoeSpiritSourceUuid ? await fromUuid(workflow.khuzoeSpiritSourceUuid) : null;
  if (!sourceActor) return;
  const actor = feature.actor, manager = cat.lib.constants.summons;
  const receipt = await reserveResources(actor, {item: feature});
  if (!receipt) { ui.notifications.warn(`${feature.name}: nessun utilizzo disponibile.`); return; }
  const previousSummons = [...manager.getSummonsBySource(feature)];
  let summon, placed;
  try {
  summon = await manager.createSummon(actor, sourceActor, Number(game.time?.worldTime ?? 0), {
    sourceDocument: feature,
    name: `Spirito Elementale Fatato — ${actor.name}`,
    disposition: tokenDocument(workflow.token)?.disposition,
    initiative: "follows",
    dismissAtZero: false,
    updates: {flags: {[MODULE_ID]: {npcSummonerUuid: actor.uuid}}}
  });
  placed = await summon.place(distanceInScene(30, workflow.token), {token: tokenDocument(workflow.token)});
  if (!placed) throw new Error("Posizionamento annullato.");
  } catch (error) {
    try { if (summon) await manager.deleteSummon(summon); }
    finally {
      await refundResources(receipt);
      if (workflow.khuzoeSpiritBonusPreviouslyUsed === false) await globalThis.MidiQOL?.removeBonusActionUsed?.(actor);
    }
    ui.notifications.warn(`${feature.name}: evocazione annullata; utilizzo restituito.`);
    return;
  }
  // Placement commits the new summon. Cleanup failures must not destroy it.
  for (const previous of previousSummons) {
    try { await manager.deleteSummon(previous); }
    catch (error) { console.error(error); ui.notifications.warn(`${feature.name}: rimuovi manualmente la precedente evocazione.`); }
  }
  await ensureHomebrewNpcAuras(tokenDocument(placed));
  return placed;
}

async function applyBrainStormPoison(item, target) {
  await replaceEffect(target.actor, {
    name: `${item.name}: Avvelenato`,
    img: item.img,
    origin: item.uuid,
    type: "base",
    system: {changes: []},
    duration: timedDuration(60, "turnEnd"),
    statuses: ["poisoned"],
    description: "<p>Avvelenato. Ripete il TS INT CD 16 alla fine di ogni suo turno.</p>",
    showIcon: 1,
    flags: {
      cat: {
        identifier: EFFECT_IDS.brainPoison,
        macros: {combat: [macroReference(EFFECT_IDS.brainPoison)]}
      },
      dae: {transfer: false, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"},
      [MODULE_ID]: {brainStorm: {remainingSaves: 10}}
    }
  });
}

async function finishBrainStorm({workflow, document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!feature || !workflow) return;
  for (const target of targetDocuments(workflow, "failedSaves")) await applyBrainStormPoison(feature, target);
}

async function repeatBrainStormSave({document, actor} = {}) {
  if (document?.documentName !== "ActiveEffect" || !actor) return;
  const token = sourceTokenForActor(actor) ?? {actor, name: actor.name};
  const save = await savingThrow(token, "int", 16);
  if (!save) return false;
  if (save.success) return globalThis.cat.utils.documentUtils.deleteDocument(document);
  const remaining = Math.max(0, Number(document.flags?.[MODULE_ID]?.brainStorm?.remainingSaves ?? 10) - 1);
  if (!remaining) return globalThis.cat.utils.documentUtils.deleteDocument(document);
  await updateDocumentSafely(document, {[`flags.${MODULE_ID}.brainStorm.remainingSaves`]: remaining});
}

function egoActive(actor) {
  if (!actor || Number(actor.system?.attributes?.hp?.value ?? 0) <= 0
    || ["dead", "unconscious"].some(status => actor.statuses?.has?.(status))) return false;
  return !values(actor.items).some(item => {
    if (item.type !== "equipment" || !item.system?.equipped) return false;
    const armorType = String(item.system?.type?.value ?? item.system?.armor?.type ?? "");
    return ["light", "medium", "heavy", "shield"].includes(armorType);
  });
}

function npcMaintenanceWriter() {
  const activeGM = game.users?.activeGM ?? globalThis.cat?.utils?.queryUtils?.gmUser?.();
  return Boolean(game.user.isGM && (!activeGM?.id || activeGM.id === game.user.id));
}

export async function reconcileImpenetrableEgo(actor) {
  if (!actor?.uuid || !npcMaintenanceWriter()) return;
  return withDocumentLock(actor, "ego-ac", async () => {
    const feature = actorItem(actor, NPC_IDS.impenetrableEgo);
    const effect = values(actor.effects).find(entry => entry.flags?.[MODULE_ID]?.egoArmorCorrection);
    const ac = actor._source?.system?.attributes?.ac ?? actor.system?.attributes?.ac;
    const formula = String(ac?.formula ?? "").replace(/\s+/g, "");
    const match = /^@attributes\.ac\.armor\+@attributes\.ac\.dex\+([+-]?\d+)$/.exec(formula);
    // Only reconcile the known NPC formula or an explicitly declared embedded bonus.
    const embedded = feature?.flags?.[MODULE_ID]?.embeddedEgoAcBonus ?? (match ? Number(match[1]) : null);
    const delta = feature && ac?.calc === "custom" && embedded !== null
      ? (egoActive(actor) ? Number(actor.system?.abilities?.cha?.mod ?? 0) : 0) - Number(embedded) : 0;
    if (!delta) { if (effect) await cat.utils.documentUtils.deleteDocument(effect); return; }
    const changes = [{key: "system.attributes.ac.bonus", value: String(delta), type: "add", priority: 20}];
    if (effect) {
      if (JSON.stringify(effect.system?.changes ?? effect.changes) !== JSON.stringify(changes)) await updateDocumentSafely(effect, {"system.changes": changes});
      return;
    }
    await cat.utils.effectUtils.createEffects(actor, [{name: `${feature.name}: CA`, img: feature.img,
      origin: feature.uuid, type: "base", system: {changes}, flags: {[MODULE_ID]: {egoArmorCorrection: true},
        dae: {transfer: false, stackable: "noneNameOnly", specialDuration: []}}}], {rules: RULES});
  });
}

async function impenetrableEgoSaveBonus({actor, document, roll} = {}) {
  actor ??= document?.actor;
  if (!roll || !egoActive(actor)) return;
  const charisma = Number(actor.system?.abilities?.cha?.mod ?? 0);
  if (!charisma) return;
  return globalThis.cat.utils.rollUtils.addToRoll(roll, String(charisma), {rollData: actor.getRollData()});
}

function saveContextText(config, options) {
  const uuid = foundry.utils.getProperty(config ?? {}, "cat.activityUuid");
  const activity = uuid ? fromUuidSync(uuid, {strict: false}) : null;
  const statuses = values(activity?.effects).flatMap(link => {
    const effect = activity?.item?.effects?.get?.(link?._id ?? link?.id);
    return values(effect?.statuses);
  });
  return `${activity?.name ?? ""} ${activity?.item?.name ?? ""} ${activity?.item?.system?.description?.value ?? ""} ${statuses.join(" ")} ${options?.subject?.name ?? ""}`.toLowerCase();
}

function impenetrableEgoAdvantage({actor, document, config, options} = {}) {
  actor ??= document?.actor;
  if (!egoActive(actor) || !options) return;
  if (/(charm|charmed|fright|frightened|paura|affascinat)/i.test(saveContextText(config, options))) options.advantage = true;
}

async function appealToFervent({workflow, document} = {}) {
  if (!workflow?.activity?.attack || !document?.actor || !canReact(document.actor)) return;
  const elathel = targetDocuments(workflow).find(target => (
    (target.actor?.uuid && document.actor.uuid && target.actor.uuid === document.actor.uuid)
    || (target.actor?.id && document.actor.id && target.actor.id === document.actor.id)
  ));
  if (!elathel) return;
  const attacker = tokenDocument(workflow.token);
  if (!attacker || (globalThis.MidiQOL?.canSee && !MidiQOL.canSee(elathel.object ?? elathel, attacker.object ?? attacker))) return;
  const candidates = values(elathel.parent?.tokens).filter(candidate => (
    candidate?.actor && !sameToken(candidate, elathel) && !sameToken(candidate, attacker)
    && isAlly(elathel, candidate) && isConscious(candidate.actor) && within(elathel, candidate, 5)
  ));
  if (!candidates.length) return;
  const selection = await globalThis.cat.utils.dialogUtils.selectTargetDialog(
    document.name,
    `<p><strong>${escapeHtml(elathel.name)}</strong> è bersaglio di un attacco. Scegli un alleato adiacente con cui scambiare posizione e bersaglio.</p>`,
    candidates,
    {type: "one", coverToken: elathel, userId: ownerUserId(document.actor)}
  );
  const ally = tokenDocument(selection?.result);
  if (!ally) return;
  const first = {x: elathel.x, y: elathel.y, elevation: elathel.elevation};
  const second = {x: ally.x, y: ally.y, elevation: ally.elevation};
  const receipt = await reserveResources(document.actor, {reaction: true});
  if (!receipt) return;
  try {
    // One scene update validates and commits both positions together.
    await cat.utils.documentUtils.updateEmbeddedDocuments(elathel.parent, "Token", [
      {_id: elathel.id, ...second}, {_id: ally.id, ...first}
    ], {teleport: true});
    await cat.utils.workflowUtils.updateTargets(workflow, targetDocuments(workflow).map(target => sameToken(target, elathel) ? ally : target));
  } catch (error) {
    await cat.utils.documentUtils.updateEmbeddedDocuments(elathel.parent, "Token", [{_id: elathel.id, ...first}, {_id: ally.id, ...second}], {teleport: true});
    await refundResources(receipt);
    throw error;
  }
}

function incomingDamage(ditem) {
  return appliedDamageAmount(ditem);
}

export async function useSpiritualProtector({workflow, document, ditem, targetToken} = {}) {
  if (workflow?.workflowOptions?.khuzoeDamageTransfer || workflow?.workflowOptions?.khuzoeUnreducible) return false;
  const spirit = document?.actor;
  const spiritToken = sourceTokenForActor(spirit);
  const protectedTarget = tokenDocument(targetToken);
  const amount = incomingDamage(ditem);
  if (!workflow || !spiritToken || !protectedTarget || amount <= 0 || !canReact(spirit)) return false;
  if (sameToken(spiritToken, protectedTarget)
    || !isAlly(spiritToken, protectedTarget)
    || !targetInsideSpiritAura(spiritToken, protectedTarget)) return false;
  const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
    document.name,
    `<p><strong>${escapeHtml(protectedTarget.name)}</strong> sta per subire <strong>${amount}</strong> danni. Farli subire interamente allo Spirito?</p>`,
    {userId: ownerUserId(spirit)}
  );
  if (confirmed !== true) return false;
  const receipt = await reserveResources(spirit, {reaction: true});
  if (!receipt) return false;

  // Midi-QOL può sovrascrivere gli update agli attori eseguiti durante
  // preTargetDamageApplication. Conserviamo quindi il trasferimento sullo
  // stesso workflow e lo applichiamo solo dopo RollComplete.
  try {
    if (Array.isArray(ditem.damageDetail)) adjustAppliedDamage(ditem, -amount);
    else globalThis.cat.utils.workflowUtils.negateDamageItemDamage(ditem);
  } catch (error) { await refundResources(receipt); throw error; }
  workflowSpiritTransferQueue(workflow, {create: true}).push({
    status: "pending",
    item: document,
    spirit,
    spiritToken,
    protectedTarget,
    amount,
    receipt
  });
  return true;
}

export async function resolveQueuedNpcDamageTransfers({workflow} = {}) {
  const queue = workflowSpiritTransferQueue(workflow);
  if (!queue?.length) return;

  for (const entry of queue.filter(candidate => candidate.status === "pending")) {
    if (entry.status !== "pending") continue;
    entry.status = "processing";
    let applied = false;
    try {
      applied = await applyResolvedDamage(entry.spirit, entry.amount, {sourceItem: entry.item, token: entry.spiritToken});
    } catch (error) {
      console.error(`${MODULE_TITLE} | Protettore Spirituale: trasferimento non riuscito.`, error);
    }

    if (applied) {
      entry.status = "applied";
      await createChat(entry.item, `<p>Lo Spirito subisce <strong>${entry.amount}</strong> danni al posto di <strong>${escapeHtml(entry.protectedTarget.name)}</strong>.</p>`, entry.spirit);
      continue;
    }

    let restored = false;
    try {
      restored = await applyResolvedDamage(entry.protectedTarget.actor, entry.amount, {sourceItem: entry.item, token: entry.protectedTarget});
    } catch (error) {
      console.error(`${MODULE_TITLE} | Protettore Spirituale: ripristino sul bersaglio non riuscito.`, error);
    }
    entry.status = restored ? "restored" : "failed";
    await refundResources(entry.receipt);
    if (restored) {
      ui.notifications.warn(`${entry.item.name}: trasferimento non riuscito; il danno è stato applicato al bersaglio originale.`);
    } else {
      ui.notifications.error(`${entry.item.name}: impossibile applicare il danno. Controlla la console.`);
    }
  }
}

async function radiantExplosion(item) {
  return withDocumentLock(item, "radiant-explosion", async () => {
    if (item.flags?.[MODULE_ID]?.radiantExplosion?.triggered) return;
    // Lo Spirito è già morto quando l'esplosione si risolve: non deve potersi
    // auto-curare attraverso la propria aura (o quella sovrapposta di Na'Niss).
    const targets = eligibleAuraTargets(globalThis.canvas?.scene, {includeInactiveSource: true, sourceActor: item.actor})
      .filter(target => target.actor?.uuid !== item.actor?.uuid && target.actor?.id !== item.actor?.id);
    const state = structuredClone(item.flags?.[MODULE_ID]?.radiantExplosion ?? {});
    if (!Number.isFinite(state.total)) state.total = Number((await rollFormula("4d6", item.actor)).total);
    state.completed ??= [];
    await updateDocumentSafely(item, {[`flags.${MODULE_ID}.radiantExplosion`]: state});
    for (const target of targets) {
      const key = target.actor.uuid ?? target.actor.id;
      if (state.completed.includes(key)) continue;
      await applyHealing(item, target, state.total, {maximizeFormula: "4d6"});
      state.completed.push(key);
      await updateDocumentSafely(item, {[`flags.${MODULE_ID}.radiantExplosion`]: state});
    }
    await updateDocumentSafely(item, {[`flags.${MODULE_ID}.radiantExplosion.triggered`]: true});
  });
}

async function detectRadiantExplosion({document, item} = {}) {
  const feature = document?.documentName === "Item" ? document : item;
  if (!feature?.actor || Number(feature.actor.system?.attributes?.hp?.value ?? 1) > 0) return;
  return radiantExplosion(feature);
}

export async function handleHomebrewNpcActorUpdate(actor, changes) {
  await reconcileImpenetrableEgo(actor);
  if (!foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
  const hp = Number(actor.system?.attributes?.hp?.value ?? 0);
  const explosion = actorItem(actor, NPC_IDS.spiritExplosion);
  if (explosion) {
    if (hp <= 0) await radiantExplosion(explosion);
    else if (explosion.flags?.[MODULE_ID]?.radiantExplosion) {
      await updateDocumentSafely(explosion, {[`flags.${MODULE_ID}.radiantExplosion`]: {triggered: false, total: null, completed: []}});
    }
  }
  if (hp > 0) return;
  const summonFeature = actorItem(actor, NPC_IDS.nanissSummon);
  const manager = globalThis.cat?.lib?.constants?.summons;
  if (!summonFeature || !manager) return;
  for (const summon of manager.getSummonsBySource(summonFeature)) await manager.deleteSummon(summon);
}

function preserveExistingNpcItem(item, changes) {
  const sourceCat = structuredClone(changes?.flags?.cat ?? {});
  const current = item?.toObject?.() ?? null;
  if (!current) return;
  changes.name = current.name;
  changes.img = current.img;
  changes.system = structuredClone(current.system);
  changes.effects = structuredClone(current.effects ?? []);
  changes.flags = structuredClone(current.flags ?? {});
  changes.flags.cat = sourceCat;
}

function normalizeNpcActivityData(itemIdentifier, changes) {
  const activities = values(changes?.system?.activities);
  if (itemIdentifier === NPC_IDS.nanissDance) {
    for (const activity of activities) {
      activity.activation = {
        ...(activity.activation ?? {}),
        type: "special",
        value: null,
        override: true
      };
    }
  }
  if ([NPC_IDS.psychicMelee, NPC_IDS.psychicRanged].includes(itemIdentifier)) {
    const ranged = itemIdentifier === NPC_IDS.psychicRanged;
    changes.system.range = {...(changes.system.range ?? {}), value: ranged ? 60 : 5, units: "ft"};
    for (const activity of activities) {
      activity.attack ??= {};
      activity.attack.type = {value: ranged ? "ranged" : "melee", classification: "spell"};
      activity.range = {...(activity.range ?? {}), value: String(ranged ? 60 : 5), units: "ft", override: true};
    }
  }
  if (itemIdentifier === NPC_IDS.brainStorm) {
    for (const activity of activities) {
      for (const part of values(activity.damage?.parts)) part.bonus = "";
      activity.effects = [];
    }
  }
}

export function prepareHomebrewNpcItemUpdate(item, changes) {
  const updatedIdentifier = slug(changes?.system?.identifier ?? item?.system?.identifier);
  if (!HOME_BREW_NPC_IDENTIFIERS.has(updatedIdentifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  preserveExistingNpcItem(item, changes);
  normalizeNpcActivityData(updatedIdentifier, changes);
}

function registerItemMacro(api, identifier, roll = [], extras = {}) {
  return api.registerFnMacro({source: MODULE_ID, rules: RULES, identifier, roll, ...extras});
}

export function registerHomebrewNpcs(api) {
  const macros = [
    registerItemMacro(api, NPC_IDS.nanissAura, [{pass: "itemRollFinished", macro: refreshAuraFeature, priority: 50}]),
    registerItemMacro(api, NPC_IDS.nanissSummon, [
      {pass: "itemPreItemRoll", macro: prepareFeySpiritSummon, priority: 10},
      {pass: "itemRollFinished", macro: summonFeySpirit, priority: 50}
    ]),
    registerItemMacro(api, NPC_IDS.nanissDance, [
      {pass: "sceneOptionalBonusAttack", macro: provideEncouragingDanceBonus, priority: 50, canOverlap: true}
    ], {
      save: [{pass: "sceneOptionalBonus", macro: provideEncouragingDanceBonus, priority: 50, canOverlap: true}],
      check: [{pass: "sceneOptionalBonus", macro: provideEncouragingDanceBonus, priority: 50, canOverlap: true}],
      skill: [{pass: "sceneOptionalBonus", macro: provideEncouragingDanceBonus, priority: 50, canOverlap: true}]
    }),
    registerItemMacro(api, NPC_IDS.nanissMultiattack, [{pass: "itemRollFinished", macro: executeNpcMultiattack, priority: 50}]),
    registerItemMacro(api, NPC_IDS.purifyingStrike, [{pass: "itemRollFinished", macro: handlePurifyingStrike, priority: 80}]),
    registerItemMacro(api, NPC_IDS.spiritAura, [{pass: "itemRollFinished", macro: refreshAuraFeature, priority: 50}]),
    registerItemMacro(api, NPC_IDS.spiritExplosion, [{pass: "targetDamageComplete", macro: detectRadiantExplosion, priority: 200}]),
    registerItemMacro(api, NPC_IDS.spiritProtector, [], {aura: [{
      pass: "update", priority: 50, distance: 15, dispositions: ["ally"],
      macro: ({document}) => document ? ({effectData: {
        name: "Protettore Spirituale", img: document.img, type: "base", showIcon: 0,
        system: {changes: []},
        flags: {cat: {macros: {roll: [macroReference("khuzoe-spiritual-protector-target")]}},
          [MODULE_ID]: {protectorItemUuid: document.uuid}}
      }}) : undefined
    }]}),
    registerItemMacro(api, "khuzoe-spiritual-protector-target", [{
      pass: "targetDamageFlatReductions", priority: 250,
      macro: async context => {
        const uuid = context.document?.flags?.[MODULE_ID]?.protectorItemUuid;
        if (!uuid) return;
        const feature = await fromUuid(uuid);
        if (feature) await useSpiritualProtector({...context, document: feature, targetToken: context.targetToken ?? context.sourceToken});
      }
    }]),
    registerItemMacro(api, NPC_IDS.spiritMultiattack, [{pass: "itemRollFinished", macro: executeNpcMultiattack, priority: 50}]),
    registerItemMacro(api, NPC_IDS.energeticStrike, [{pass: "itemRollFinished", macro: handleEnergeticStrike, priority: 80}]),
    registerItemMacro(api, NPC_IDS.elathelMultiattack, [{pass: "itemRollFinished", macro: executeNpcMultiattack, priority: 50}]),
    registerItemMacro(api, NPC_IDS.psychicMelee, [{pass: "itemRollFinished", macro: handlePsychicStrike, priority: 80}]),
    registerItemMacro(api, NPC_IDS.psychicRanged, [{pass: "itemRollFinished", macro: handlePsychicStrike, priority: 80}]),
    registerItemMacro(api, NPC_IDS.brainStorm, [{pass: "itemRollFinished", macro: finishBrainStorm, priority: 80}]),
    registerItemMacro(api, NPC_IDS.impenetrableEgo, [], {
      save: [
        {pass: "actorBonus", macro: impenetrableEgoSaveBonus, priority: 50},
        {pass: "actorSituational", macro: impenetrableEgoAdvantage, priority: 50}
      ]
    }),
    registerItemMacro(api, NPC_IDS.appeal, [
      {pass: "sceneAttackRollConfig", macro: appealToFervent, priority: 10, canOverlap: true}
    ]),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: EFFECT_IDS.brainPoison,
      combat: [{pass: "actorTurnEnd", macro: repeatBrainStormSave, priority: 50}]
    })
  ];
  return {macros, automations: HOME_BREW_NPC_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
