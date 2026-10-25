import {RELEASE_VERSION} from "./release.mjs";
import {adjustAppliedDamage, appliedDamageAmount} from "./damage-adjustment.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {runSyntheticActivityData} from "./activity-compat.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const MODULE_TITLE = "Khuzoe Automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const PACK = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item";

export const DAMAGE_BOND_IDS = Object.freeze({
  always: "damage-bond",
  oncePerTurn: "damage-bond-once-per-turn"
});

export const DAMAGE_BOND_ACTIVITY_IDS = Object.freeze({
  configure: "KhzDmgBondCfg001",
  transfer: "KhzDmgBondDmg001",
  runtimeTransfer: "KhzDmgBondRoll01"
});

const DAMAGE_BOND_DOCUMENTS = Object.freeze([
  [
    DAMAGE_BOND_IDS.always,
    "KhzDmgBondAlways",
    "Configura uno o più alleati collegati. Ogni volta che subisci danni puoi scegliere un singolo alleato e trasferirgli metà del danno finale."
  ],
  [
    DAMAGE_BOND_IDS.oncePerTurn,
    "KhzDmgBondTurn01",
    "Come Legame del Danno, ma il trasferimento può riuscire una sola volta per turno, condividendo il limite tra tutti gli alleati collegati."
  ]
]);

export const DAMAGE_BOND_IDENTIFIERS = new Set(DAMAGE_BOND_DOCUMENTS.map(([identifier]) => identifier));

export const DAMAGE_BOND_AUTOMATIONS = DAMAGE_BOND_DOCUMENTS.map(([identifier, id, notes]) => Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier,
  version: VERSION,
  uuid: `${PACK}.${id}`,
  type: "feat",
  notes
}));

const TRANSFER_IGNORE_TRAITS = Object.freeze(["idi", "idr", "idv", "ida", "idm"]);
const processedWorkflowFallback = new WeakMap();
const queuedTransferFallback = new WeakMap();

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

function itemActivity(item, id) {
  return item?.system?.activities?.get?.(id)
    ?? values(item?.system?.activities).find(activity => activity?.id === id || activity?._id === id);
}

function ownerUserId(document) {
  return globalThis.cat?.utils?.queryUtils?.firstOwner?.(document, true) ?? game.user.id;
}

function escapeHtml(value) {
  if (!globalThis.document?.createElement) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function sameActor(left, right) {
  if (!left || !right) return false;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return Boolean(left.id && right.id && left.id === right.id);
}

function actorIsDead(actor) {
  return values(actor?.statuses).some(status => String(status) === "dead");
}

function currentSceneId() {
  return globalThis.canvas?.scene?.id ?? null;
}

function isOnCurrentScene(token) {
  token = tokenDocument(token);
  const sceneId = currentSceneId();
  if (!token || !sceneId) return Boolean(token);
  return (token.parent?.id ?? token.scene?.id ?? token.sceneId) === sceneId;
}

function activeTokenDocuments(actor) {
  const active = values(actor?.getActiveTokens?.(false, true)).map(tokenDocument).filter(Boolean);
  if (active.length) return active.filter(isOnCurrentScene);
  return values(globalThis.canvas?.tokens?.placeables)
    .map(tokenDocument)
    .filter(token => token?.actor && sameActor(token.actor, actor));
}

function sceneTokenDocuments() {
  const placeables = values(globalThis.canvas?.tokens?.placeables).map(tokenDocument).filter(Boolean);
  if (placeables.length) return placeables;
  return values(globalThis.canvas?.scene?.tokens).map(tokenDocument).filter(Boolean);
}

function sourceTokenForActor(actor) {
  return activeTokenDocuments(actor)[0] ?? tokenDocument(actor?.token);
}

function tokensAreAllies(source, candidate) {
  source = tokenDocument(source);
  candidate = tokenDocument(candidate);
  if (!source || !candidate) return true;
  try {
    return globalThis.cat?.utils?.tokenUtils?.isAlly?.(source, candidate)
      ?? (Number(source.disposition ?? 0) !== 0 && source.disposition === candidate.disposition);
  } catch (_error) {
    return Number(source.disposition ?? 0) !== 0 && source.disposition === candidate.disposition;
  }
}

function damageBondState(item) {
  const state = item?.flags?.[MODULE_ID]?.damageBond;
  return {
    links: Array.isArray(state?.links) ? state.links : [],
    stamps: Array.isArray(state?.stamps) ? state.stamps : []
  };
}

function damageBondMode(item) {
  return identifier(item) === DAMAGE_BOND_IDS.oncePerTurn ? "oncePerTurn" : "always";
}

function workflowProcessedSet(workflow) {
  if (!workflow || (typeof workflow !== "object" && typeof workflow !== "function")) return null;
  try {
    workflow.khuzoeDamageBondProcessed ??= new Set();
    return workflow.khuzoeDamageBondProcessed;
  } catch (_error) {
    let processed = processedWorkflowFallback.get(workflow);
    if (!processed) {
      processed = new Set();
      processedWorkflowFallback.set(workflow, processed);
    }
    return processed;
  }
}

function workflowTransferQueue(workflow, {create = false} = {}) {
  if (!workflow || (typeof workflow !== "object" && typeof workflow !== "function")) return null;
  try {
    if (create) workflow.khuzoeDamageBondTransfers ??= [];
    return workflow.khuzoeDamageBondTransfers ?? null;
  } catch (_error) {
    let queue = queuedTransferFallback.get(workflow);
    if (!queue && create) {
      queue = [];
      queuedTransferFallback.set(workflow, queue);
    }
    return queue ?? null;
  }
}

function transferredWorkflow(workflow) {
  const activityId = workflow?.activity?.id ?? workflow?.activity?._id;
  return workflow?.workflowOptions?.khuzoeUnreducible || activityId === DAMAGE_BOND_ACTIVITY_IDS.transfer
    || activityId === DAMAGE_BOND_ACTIVITY_IDS.runtimeTransfer
    || workflow?.activity?.midiProperties?.identifier === "khuzoe-damage-bond-transfer"
    || Boolean(workflow?.workflowOptions?.khuzoeDamageTransfer)
    || Boolean(workflow?.options?.workflowOptions?.khuzoeDamageTransfer);
}

export function calculateDamageBondShare(ditem) {
  const incoming = appliedDamageAmount(ditem);
  const transferred = Math.floor(incoming / 2);
  return {incoming, transferred, retained: incoming - transferred};
}

async function documentFromUuid(uuid) {
  if (!uuid) return null;
  try {
    return await globalThis.fromUuid?.(uuid) ?? globalThis.fromUuidSync?.(uuid) ?? null;
  } catch (_error) {
    return null;
  }
}

async function resolveLink(link) {
  const actor = await documentFromUuid(link?.actorUuid);
  if (!actor || actorIsDead(actor)) return null;

  let token = tokenDocument(await documentFromUuid(link?.tokenUuid));
  if (!token?.actor || !sameActor(token.actor, actor) || !isOnCurrentScene(token)) {
    token = activeTokenDocuments(actor)[0] ?? null;
  }
  if (!token?.uuid) return null;

  return {
    actor,
    actorUuid: actor.uuid,
    token,
    tokenUuid: token.uuid,
    name: token.name ?? actor.name ?? link.name ?? "Alleato",
    img: token.texture?.src ?? actor.img ?? link.img ?? "icons/svg/mystery-man.svg"
  };
}

async function availableRecipients(item, protectedActor) {
  const resolved = await Promise.all(damageBondState(item).links.map(resolveLink));
  const unique = new Map();
  for (const recipient of resolved) {
    if (!recipient || sameActor(recipient.actor, protectedActor) || unique.has(recipient.actorUuid)) continue;
    unique.set(recipient.actorUuid, recipient);
  }
  return Array.from(unique.values());
}

function combatContext(token) {
  const document = tokenDocument(token);
  return {
    tokenId: document?.id ?? document?.actor?.id ?? "actor",
    data: document && globalThis.cat?.utils?.tokenUtils?.getCombatData
      ? globalThis.cat.utils.tokenUtils.getCombatData(document)
      : {inCombat: false}
  };
}

function oncePerTurnAlreadyUsed(item, context) {
  if (damageBondMode(item) !== "oncePerTurn" || !context.data?.inCombat) return false;
  return globalThis.cat.utils.combatUtils.isStampedThisTurn(
    damageBondState(item).stamps,
    context.tokenId,
    context.data
  );
}

async function stampOncePerTurn(item, context) {
  if (damageBondMode(item) !== "oncePerTurn" || !context.data?.inCombat) return;
  const updated = globalThis.cat.utils.combatUtils.addTurnStamp(
    damageBondState(item).stamps,
    context.tokenId,
    context.data
  );
  await updateDocumentSafely(item, {
    [`flags.${MODULE_ID}.damageBond.stamps`]: updated
  });
}

async function chooseRecipient(item, protectedActor, recipients, damage) {
  const userId = ownerUserId(protectedActor);
  const message = `<p><strong>${escapeHtml(protectedActor.name)}</strong> sta per subire <strong>${damage.incoming}</strong> danni.</p>`
    + `<p>Trasferire <strong>${damage.transferred}</strong> danni a un alleato collegato?</p>`;

  if (recipients.length === 1) {
    const recipient = recipients[0];
    const confirmed = await globalThis.cat.utils.dialogUtils.confirm(
      item.name,
      `${message}<p>Alleato: <strong>${escapeHtml(recipient.name)}</strong>.</p>`,
      {userId}
    );
    return confirmed ? recipient : null;
  }

  const buttons = recipients.map(recipient => [
    recipient.name,
    recipient.actorUuid,
    {image: recipient.img}
  ]);
  buttons.push(["Non trasferire", false, {image: "icons/svg/cancel.svg"}]);
  const selected = await globalThis.cat.utils.dialogUtils.buttonDialog(
    item.name,
    message,
    buttons,
    {displayAsRows: true, userId}
  );
  return recipients.find(recipient => recipient.actorUuid === selected) ?? null;
}

async function applyTransferredDamage(item, sourceActor, recipient, amount, {kind = "transfer"} = {}) {
  const activity = itemActivity(item, DAMAGE_BOND_ACTIVITY_IDS.transfer);
  if (!activity || amount <= 0) return false;

  const activityData = globalThis.cat.utils.activityUtils.getDamageModifiedActivityData(
    activity,
    String(amount),
    {types: ["force"]}
  );
  // In dnd5e v14 an activity listed as a rider has canUse=false. CAT builds the
  // synthetic activity by cloning the parent item, including its rider list, so
  // reusing the embedded activity ID makes Foundry reject the roll. A runtime-only
  // ID keeps the technical activity hidden in the real item while making its clone
  // independently usable by Midi-QOL.
  activityData._id = DAMAGE_BOND_ACTIVITY_IDS.runtimeTransfer;
  delete activityData.id;
  const retained = kind === "retained";
  const restored = kind === "restored";
  activityData.name = retained
    ? `${item.name}: quota trattenuta`
    : restored
      ? `${item.name}: quota non trasferita`
      : `${item.name}: ${sourceActor.name} → ${recipient.name}`;
  activityData.description ??= {};
  activityData.description.chatFlavor = retained
    ? `<strong>${escapeHtml(recipient.name)}</strong> riceve ${amount} danni trattenuti dal legame.`
    : restored
      ? `<strong>${escapeHtml(recipient.name)}</strong> riceve ${amount} danni che non è stato possibile trasferire.`
      : `<strong>${escapeHtml(recipient.name)}</strong> riceve ${amount} danni trasferiti da <strong>${escapeHtml(sourceActor.name)}</strong>.`;
  activityData.midiProperties = {
    ...(activityData.midiProperties ?? {}),
    identifier: "khuzoe-damage-bond-transfer",
    automationOnly: true,
    confirmTargets: "never",
    forceDamageDialog: "never",
    ignoreTraits: Array.from(TRANSFER_IGNORE_TRAITS)
  };
  activityData.flags ??= {};
  activityData.flags.cat = {...(activityData.flags.cat ?? {}), hidden: true};
  activityData.flags[MODULE_ID] = {damageTransfer: true};

  const result = await runSyntheticActivityData(
    activityData,
    item,
    [recipient.token],
    {
      consumeUsage: false,
      consumeResources: false,
      spellSlot: false,
      userId: ownerUserId(sourceActor),
      options: {workflowOptions: {khuzoeDamageTransfer: true}}
    }
  );
  return Boolean(result && !result.aborted);
}

async function restoreTransferredShare(entry) {
  try {
    return await applyProtectedDamage(entry, entry.amount, {kind: "restored"});
  } catch (error) {
    console.error(`${MODULE_TITLE} | Ripristino della quota sul bersaglio originale non riuscito.`, error);
    return false;
  }
}

async function applyProtectedDamage(entry, amount, {kind = "restored"} = {}) {
  if (amount <= 0) return true;
  return applyTransferredDamage(entry.item, entry.protectedActor, {
    actor: entry.protectedActor, token: entry.protectedToken, name: entry.protectedToken?.name ?? entry.protectedActor.name
  }, amount, {kind});
}

export async function resolveQueuedDamageBonds({workflow, document, item} = {}) {
  item = document?.documentName === "Item" ? document : item;
  if (!workflow || transferredWorkflow(workflow)) return;

  const queue = workflowTransferQueue(workflow);
  if (!queue?.length) return;
  const entries = queue.filter(entry => entry.status === "pending"
    && (!item || entry.itemUuid === item.uuid || entry.itemId === item.id));

  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    entry.status = "processing";
    try {
      const applied = await applyTransferredDamage(
        entry.item,
        entry.protectedActor,
        entry.recipient,
        entry.amount
      );
      if (applied) {
        entry.status = "applied";
        continue;
      }
    } catch (error) {
      console.error(`${MODULE_TITLE} | Trasferimento differito del danno non riuscito.`, error);
    }

    const restored = await restoreTransferredShare(entry);
    entry.status = restored ? "restored" : "failed";
    if (restored) {
      if (damageBondMode(entry.item) === "oncePerTurn") await updateDocumentSafely(entry.item, {[`flags.${MODULE_ID}.damageBond.stamps`]: entry.previousStamps});
      ui.notifications.warn(`${entry.item.name}: trasferimento non riuscito; la quota è stata applicata al bersaglio originale.`);
    } else {
      ui.notifications.error(`${entry.item.name}: non è stato possibile applicare la quota trasferita. Controlla la console.`);
    }
  }
}

export function useDamageBond(context = {}) {
  const item = context.document?.documentName === "Item" ? context.document : context.item ?? context.document;
  return withDocumentLock(item, "damage-bond", () => useDamageBondLocked(context));
}

async function useDamageBondLocked({workflow, targetToken, sourceToken, ditem, document, item} = {}) {
  item = document?.documentName === "Item" ? document : item ?? document;
  const protectedActor = item?.actor ?? tokenDocument(targetToken)?.actor;
  const protectedToken = tokenDocument(targetToken) ?? sourceTokenForActor(protectedActor);
  if (!item || !protectedActor || !ditem || transferredWorkflow(workflow)) return false;

  const damage = calculateDamageBondShare(ditem);
  if (damage.transferred <= 0) return false;

  const context = combatContext(protectedToken);
  if (oncePerTurnAlreadyUsed(item, context)) return false;

  const workflowKey = `${item.id ?? item.uuid ?? identifier(item)}:${protectedToken?.uuid ?? protectedActor.uuid}`;
  const processed = workflowProcessedSet(workflow);
  if (processed?.has(workflowKey)) return false;
  processed?.add(workflowKey);

  const previousDamage = Object.fromEntries(["hpDamage", "tempDamage", "newHP", "newTempHP", "damageDetail", "rawDamageDetail"]
    .filter(key => Object.hasOwn(ditem, key)).map(key => [key, structuredClone(ditem[key])]));
  const previousStamps = structuredClone(damageBondState(item).stamps);
  let stamped = false;
  try {
    const recipients = await availableRecipients(item, protectedActor);
    if (!recipients.length) return false;
    const recipient = await chooseRecipient(item, protectedActor, recipients, damage);
    if (!recipient) return false;

    // Reserve the turn before yielding. Only the transferred share is deferred.
    if (oncePerTurnAlreadyUsed(item, context)) return false;
    await stampOncePerTurn(item, context);
    stamped = true;
    const entry = {
      status: "pending",
      item,
      itemId: item.id,
      itemUuid: item.uuid,
      protectedActor,
      protectedToken,
      recipient,
      amount: damage.transferred,
      incoming: damage.incoming,
      retained: damage.retained,
      context, previousStamps
    };
    // Keep the retained share in its original typed workflow, including Death Ward.
    adjustAppliedDamage(ditem, -damage.transferred);
    workflowTransferQueue(workflow, {create: true}).push(entry);
    return;
  } catch (error) {
    Object.assign(ditem, previousDamage);
    if (stamped) await updateDocumentSafely(item, {[`flags.${MODULE_ID}.damageBond.stamps`]: previousStamps});
    console.error(`${MODULE_TITLE} | Trasferimento del danno non riuscito.`, error);
    ui.notifications.warn(`${item.name}: trasferimento non riuscito; il danno originale non è stato modificato.`);
    return false;
  }
}

function currentLinkCandidates(item) {
  const actor = item?.actor;
  const sourceToken = sourceTokenForActor(actor);
  const candidates = new Map();
  for (const token of sceneTokenDocuments()) {
    if (!token?.actor || sameActor(token.actor, actor) || !tokensAreAllies(sourceToken, token)) continue;
    if (!candidates.has(token.actor.uuid)) {
      candidates.set(token.actor.uuid, {
        actor: token.actor,
        actorUuid: token.actor.uuid,
        tokenUuid: token.uuid,
        name: token.name ?? token.actor.name,
        img: token.texture?.src ?? token.actor.img ?? "icons/svg/mystery-man.svg",
        available: true
      });
    }
  }
  return candidates;
}

async function allLinkCandidates(item) {
  const candidates = currentLinkCandidates(item);
  for (const link of damageBondState(item).links) {
    if (candidates.has(link.actorUuid)) continue;
    const actor = await documentFromUuid(link.actorUuid);
    candidates.set(link.actorUuid, {
      actor,
      actorUuid: link.actorUuid,
      tokenUuid: link.tokenUuid ?? "",
      name: actor?.name ?? link.name ?? "Alleato non disponibile",
      img: actor?.img ?? link.img ?? "icons/svg/mystery-man.svg",
      available: false
    });
  }
  return Array.from(candidates.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function updateDamageBondLinks(item, links) {
  await updateDocumentSafely(item, {
    [`flags.${MODULE_ID}.damageBond.links`]: links
  });
}

export async function openDamageBondConfig(item) {
  if (!item?.actor || !DAMAGE_BOND_IDENTIFIERS.has(identifier(item))) return null;
  if (!item.actor.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`${item.name}: non hai il permesso di configurare questo attore.`);
    return null;
  }

  const candidates = await allLinkCandidates(item);
  const selected = new Set(damageBondState(item).links.map(link => link.actorUuid));
  const rows = candidates.length
    ? candidates.map(candidate => `
        <label style="display:grid;grid-template-columns:auto 36px 1fr auto;align-items:center;gap:.6rem;padding:.35rem .2rem;">
          <input type="checkbox" name="links" value="${escapeHtml(candidate.actorUuid)}" ${selected.has(candidate.actorUuid) ? "checked" : ""}>
          <img src="${escapeHtml(candidate.img)}" alt="" width="36" height="36" style="border:0;border-radius:50%;object-fit:cover;">
          <span>${escapeHtml(candidate.name)}</span>
          ${candidate.available ? "" : '<small style="opacity:.7">fuori scena</small>'}
        </label>`).join("")
    : "<p>Nessun alleato disponibile sulla scena. Puoi riaprire questa configurazione dopo aver posizionato i token.</p>";

  const chosen = await foundry.applications.api.DialogV2.prompt({
    window: {title: `${item.name} — alleati collegati`},
    content: `
      <p>Scegli gli alleati che possono ricevere metà dei danni di <strong>${escapeHtml(item.actor.name)}</strong>.</p>
      <p>Ogni volta verrà selezionato un solo alleato. La configurazione non impone distanza dopo la creazione del legame.</p>
      <fieldset style="max-height:420px;overflow:auto;">${rows}</fieldset>`,
    ok: {
      label: "Salva legami",
      icon: "fa-solid fa-link",
      callback: (_event, button) => new FormData(button.form).getAll("links").map(String)
    },
    close: () => null
  });
  if (!chosen) return null;

  const byActorUuid = new Map(candidates.map(candidate => [candidate.actorUuid, candidate]));
  const links = chosen.map(actorUuid => {
    const candidate = byActorUuid.get(actorUuid);
    return {
      actorUuid,
      tokenUuid: candidate?.tokenUuid ?? "",
      name: candidate?.name ?? "Alleato",
      img: candidate?.img ?? "icons/svg/mystery-man.svg"
    };
  });
  await updateDamageBondLinks(item, links);
  ui.notifications.info(`${item.name}: ${links.length} ${links.length === 1 ? "alleato collegato" : "alleati collegati"}.`);
  return links;
}

async function configureDamageBondFromRoll({workflow, document, item} = {}) {
  item = document?.documentName === "Item" ? document : item ?? workflow?.item;
  if (!item || workflow?.activity?.id !== DAMAGE_BOND_ACTIVITY_IDS.configure) return;
  await openDamageBondConfig(item);
  return true;
}

export function prepareDamageBondItemUpdate(item, changes) {
  const updatedIdentifier = identifier({
    name: item?.name,
    system: {identifier: changes?.system?.identifier ?? item?.system?.identifier}
  });
  if (!DAMAGE_BOND_IDENTIFIERS.has(updatedIdentifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;

  const current = item?.flags?.[MODULE_ID]?.damageBond;
  if (!current) return;
  changes.flags ??= {};
  changes.flags[MODULE_ID] ??= {};
  changes.flags[MODULE_ID].damageBond = structuredClone(current);
}

function findDamageBondItems(actor) {
  return values(actor?.items).filter(item => DAMAGE_BOND_IDENTIFIERS.has(identifier(item)));
}

export function enhanceDamageBondMedkit(app, section) {
  const actor = app?.document ?? app?.actor ?? app?.object;
  if (!section || actor?.documentName !== "Actor" || (!actor.isOwner && !game.user?.isGM)) return;
  if (section.querySelector('[data-khuzoe-action="damage-bond-config"]')) return;
  const items = findDamageBondItems(actor);
  if (!items.length) return;

  const row = document.createElement("div");
  row.className = "khz-damage-bond-medkit-row";
  row.style.display = "flex";
  row.style.gap = ".5rem";

  let select = null;
  if (items.length > 1) {
    select = document.createElement("select");
    select.dataset.khuzoeDamageBondItem = "";
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    row.append(select);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.khuzoeAction = "damage-bond-config";
  button.dataset.tooltip = "Configura gli alleati collegati a questa capacità";
  button.innerHTML = '<i class="fa-solid fa-link"></i> Configura legami';
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const item = select ? actor.items.get(select.value) : items[0];
    if (!item) return ui.notifications.warn("Capacità di legame non disponibile.");
    void openDamageBondConfig(item);
  });
  row.append(button);
  section.append(row);
}

export function registerDamageBond(api) {
  const macros = [];
  for (const automation of DAMAGE_BOND_AUTOMATIONS) {
    macros.push(api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: automation.identifier,
      roll: [
        {pass: "itemPreItemRoll", macro: configureDamageBondFromRoll, priority: 10},
        {pass: "targetDamageFlatReductions", macro: useDamageBond, priority: 10}
      ]
    }));
  }
  return {macros, automations: DAMAGE_BOND_AUTOMATIONS.map(data => api.registerAutomation(data))};
}
