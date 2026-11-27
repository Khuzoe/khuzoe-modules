import { reducedAttackGroup } from "./roll-groups.mjs";
import { missedAttack } from "./attack-retry.mjs";
import { pendingRoll } from "./roll-presentation.mjs";

const scope = "khuzoe-hud";
const localize = key => game.i18n.localize(`KHUZOE_HUD.${key}`);
const data = message => message?.flags?.[scope] ?? {};
const midi = message => message?.flags?.["midi-qol"] ?? {};
const nativeType = message => message?.flags?.dnd5e?.roll?.type ?? message?.rolls?.[0]?.options?.rollType;
const isSave = type => ["save", "death", "concentration"].includes(type);
const queues = new Map();
const queuedPublications = new Map();
const delayedPublications = new WeakMap();
const applications = new WeakMap();
const markupCache = new WeakMap();
const childDamageRolls = new WeakMap();
const publishedIds = new Set();
let historyIndexed = false;
const concealedHeader = '[hidden], [aria-hidden="true"], [data-concealed], .gm-only, .secret:not(.revealed), .hidden, [style*="display: none"], [style*="display:none"]';
let getSharedCover;
const pendingCovers = new WeakMap();

function isPrivate(message) {
  return message?.whisper?.length > 0 && message.whisper.every(id => game.users.get(id)?.isGM);
}

function isAction(message) {
  if (!isPrivate(message) || midi(message).undoDamage || data(message).reduced) return false;
  const type = nativeType(message);
  return type === "attack" || isSave(type) || !!midi(message).attackRoll
    || ["attack", "save"].includes(message.getAssociatedActivity?.()?.type);
}

function canPublish(message) {
  if (!game.user.isGM || !message?.isContentVisible || !isPrivate(message)) return false;
  const primary = game.users.activeGM;
  const writer = primary && message.whisper.includes(primary.id) ? primary
    : game.users.find(user => user.active && user.isGM && message.whisper.includes(user.id));
  return writer?.id === game.user.id;
}

function messageByRef(ref) {
  if (typeof ref !== "string") return;
  const id = ref.startsWith("ChatMessage.") ? ref.slice(12) : ref;
  return game.messages.get(id);
}

function parentOf(message) {
  const ref = data(message).rollParent ?? message?.flags?.dnd5e?.originatingMessage ?? message?.rolls?.[0]?.options?.midiOptions?.itemCardUuid;
  const parent = messageByRef(ref);
  return parent !== message && isAction(parent) ? parent : undefined;
}

function speakerOf(message) {
  const speaker = message.speaker ?? {};
  return game.scenes.get(speaker.scene)?.tokens.get(speaker.token) ?? message.getAssociatedActor?.();
}

function resolve(uuid) {
  return typeof uuid === "string" && /^(Scene\.[^.]+\.Token\.[^.]+|Actor\.[^.]+)(\.Actor\.[^.]+)?$/.test(uuid)
    ? fromUuidSync(uuid, { strict: false }) : undefined;
}

function media(path) {
  if (typeof path !== "string" || !path || path.includes("*")) return null;
  try {
    const url = new URL(path, document.baseURI);
    return ["http:", "https:"].includes(url.protocol) ? path : null;
  } catch { return null; }
}

function identity(doc, name, img) {
  const token = doc?.documentName === "Token" ? doc : doc?.token;
  return {
    name: name || (token && globalThis.MidiQOL?.getTokenPlayerName?.(token)) || token?.name || doc?.name || localize("Target"),
    img: media(token?.texture?.src ?? img ?? doc?.prototypeToken?.texture?.src ?? doc?.img)
  };
}

function iconOf(source, nativeIcon) {
  const item = source.getAssociatedItem?.();
  if (item?.system?.identified === false) return media(item.system.unidentified?.img);
  const activity = source.getAssociatedActivity?.();
  return media(activity?._source?.img || nativeIcon || item?.img || activity?.img);
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

function nativeAttack(message) {
  const m = midi(message);
  const roll = m.attackRoll ?? (nativeType(message) === "attack" ? message.rolls?.[0] : undefined);
  if (num(roll?.total) === null) return null;
  const total = m.attackRoll && Number.isFinite(m.attackTotal) && m.attackTotal !== -100 ? m.attackTotal : roll.total;
  return { total, critical: (m.isCritical ?? roll.isCritical) === true };
}

const damageParts = [
  ["defaultDamage", "damageRolls", "damageTotal"],
  ["otherDamage", "otherDamageRolls", "otherDamageTotal"],
  ["bonusDamage", "bonusDamageRolls", "bonusDamageTotal"]
];

// Midi can publish the same dice in message.rolls and in flags. Take each
// damage category from one representation only. An unrolled attack has no total.
function damageByType(message) {
  const m = midi(message);
  const rolls = message.rolls ?? [];
  const totals = new Map();
  for (const [type, rollField, totalField] of damageParts) {
    let parts = rolls.filter(r => r.options?.["midi-qol"]?.rollType === type);
    if (!parts.length && Array.isArray(m[rollField])) parts = m[rollField];
    if (parts.length && parts.every(r => Number.isFinite(r?.total))) {
      totals.set(type, parts.reduce((sum, r) => sum + r.total, 0));
    } else if (Number.isFinite(m[totalField]) && (m[totalField] !== 0 || parts.length)) totals.set(type, m[totalField]);
  }
  if (!totals.size && nativeType(message) === "damage" && rolls.length && rolls.every(r => Number.isFinite(r.total))) {
    totals.set("defaultDamage", rolls.reduce((sum, r) => sum + r.total, 0));
  }
  return totals;
}

function indexChildDamage(parent, message) {
  let children = childDamageRolls.get(parent);
  const parts = damageByType(message);
  if (!parts.size) return children?.delete(message.id);
  const previous = children?.get(message.id);
  if (previous?.size === parts.size && [...parts].every(([type, value]) => previous.get(type) === value)) return false;
  if (!children) childDamageRolls.set(parent, children = new Map());
  children.set(message.id, parts);
  return true;
}

function attackDamageFields(source) {
  const merged = damageByType(source);
  const totals = [...merged.values()];
  for (const parts of childDamageRolls.get(source)?.values() ?? []) {
    for (const [type, value] of parts) if (!merged.has(type)) totals.push(value);
  }
  return { rolledDamage: totals.length ? totals.reduce((sum, n) => sum + n, 0) : null, missed: missedAttack(source) };
}

// Extract only the direct numeric text. Midi nests formulas, dice and GM
// attribution inside the very same total element.
function saveRows(template, sceneId) {
  const rows = [];
  for (const el of template?.querySelectorAll(".midi-qol-saves-display li.midi-qol-save-class[data-id]") ?? []) {
    const total = el.querySelector(".midi-qol-save-total");
    const text = Array.from(total?.childNodes ?? []).filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
    const uuid = el.querySelector(".midi-qol-save-name")?.dataset.uuid ?? (sceneId && `Scene.${sceneId}.Token.${el.dataset.id}`);
    if (!uuid) continue;
    rows.push({ uuid, name: el.querySelector(".midi-qol-playerTokenName")?.textContent.trim(),
      img: el.querySelector("img")?.getAttribute("src"), save: /^[-+]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null,
      passed: el.classList.contains("success") ? true : el.classList.contains("failure") ? false : null });
  }
  return rows;
}

function pool(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? [...value] : null;
}

function publishedMarkup(source) {
  const cached = markupCache.get(source);
  if (cached && cached.content === source.content) return cached;
  const result = { content: source.content, icon: null, title: null, rows: [], placedTargets: [] };
  if (source.content?.includes("card-header") || source.content?.includes("midi-qol-saves-display")) {
    const el = document.createElement("template");
    el.innerHTML = source.content;
    const icon = el.content.querySelector(".card-header .summary img.gold-icon");
    if (icon && !icon.closest(concealedHeader)) {
      result.icon = icon.getAttribute("src");
    }
    const title = el.content.querySelector(".chat-card > .card-header > .summary .name-stacked > .title");
    if (title && !title.closest(concealedHeader) && !title.querySelector(concealedHeader)) result.title = title.textContent.trim() || null;
    result.rows = saveRows(el.content, source.speaker?.scene);
    if (source.speaker?.scene) {
      for (const target of el.content.querySelectorAll(".midi-qol-hits-display .targets-tray li.target[data-id]")) {
        if (target.dataset.id) result.placedTargets.push(`Scene.${source.speaker.scene}.Token.${target.dataset.id}`);
      }
    }
  }
  markupCache.set(source, result);
  return result;
}

function nativeSave(message) {
  const roll = message.rolls?.[0];
  if (!isSave(nativeType(message)) || !Number.isFinite(roll?.total)) return;
  const result = { save: roll.total };
  if (Number.isFinite(roll.options?.target) && typeof roll.isSuccess === "boolean") result.passed = roll.isSuccess;
  return result;
}

function presentation(source, speaker, markup) {
  const item = source.getAssociatedItem?.();
  const title = markup.title && item?.system?.identified === false ? item.system.unidentified?.name || null : markup.title;
  const id = speaker?.actorId ?? speaker?.actor?.id ?? speaker?.id ?? source.speaker?.actor;
  const actor = id && game.actors?.get(id);
  return { title, actor: ["npc", "character"].includes(actor?.type) ? actor : null };
}

function buildSummary(source) {
  const m = midi(source), state = data(source), markup = publishedMarkup(source);
  const speaker = resolve(m.attackingTokenUuid) ?? speakerOf(source);
  const rows = new Map();
  function put(uuid, values = {}) {
    if (!uuid) return;
    const previous = rows.get(uuid) ?? {};
    rows.set(uuid, { ...previous, ...values, name: values.name || previous.name, img: values.img || previous.img });
  }
  for (const t of m.targets ?? []) put(t.uuid);
  for (const uuid of m.targetUuids ?? []) put(uuid);
  for (const row of markup.rows) put(row.uuid, row);
  for (const row of Object.values(state.outcomes ?? {})) {
    // Midi's player-facing alias takes precedence over a damage event's token name.
    put(row.uuid, { ...row, name: rows.get(row.uuid)?.name || row.name });
  }
  const selfSave = nativeSave(source);
  if (selfSave) put(speaker?.uuid ?? "self", selfSave);
  // Native descriptors frequently use actor UUIDs where Midi uses placed tokens.
  const actorTokens = new Map();
  for (const uuid of rows.keys()) {
    const actor = resolve(uuid)?.actor;
    if (actor) actorTokens.set(actor.uuid, actorTokens.has(actor.uuid) ? null : uuid);
  }
  for (const [actor, token] of actorTokens) {
    if (!token || !rows.has(actor)) continue;
    rows.set(token, { ...rows.get(actor), ...rows.get(token) });
    rows.delete(actor);
  }
  for (const t of source.flags?.dnd5e?.targets ?? []) {
    if (!actorTokens.has(t.uuid) && !rows.has(t.uuid)) put(t.uuid, { name: resolve(t.uuid) ? undefined : t.name, img: t.img });
  }
  const targets = [];
  for (const [uuid, row] of rows) {
    targets.push({ ...identity(resolve(uuid), row.name, row.img), save: num(row.save),
      passed: typeof row.passed === "boolean" ? row.passed : null, hp: pool(row.hp), temp: pool(row.temp) });
  }
  const attack = nativeAttack(source) ?? (Number.isFinite(state.childAttack?.total)
    ? { total: state.childAttack.total, critical: state.childAttack.critical === true } : null);
  const saves = isSave(nativeType(source)) || source.getAssociatedActivity?.()?.type === "save"
    || targets.some(row => row.save !== null || row.passed !== null);
  if (!attack && !saves && !targets.some(row => row.hp || row.temp)) return;
  const author = identity(speaker);
  const { title, actor } = presentation(source, speaker, markup);
  if (actor) {
    author.wikiActorId = actor.id;
    author.wikiActorType = actor.type;
  }
  return { speaker: author, title, icon: iconOf(source, markup.icon), attack,
    ...(attack && { attackGroup: reducedAttackGroup(source, markup.placedTargets), ...attackDamageFields(source) }), saves, targets };
}

function schedule(source, work) {
  const id = source.id;
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(() => work(game.messages.get(id))).catch(error => console.error("Khuzoe HUD | Reduced card", error));
  queues.set(id, next);
  next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
  return next;
}

// A burst of Midi updates can arrive while an earlier write is in flight.
// Read the latest state once per queued burst, then allow updates during that read/write to queue another pass.
function requestPublication(source) {
  const waiting = queuedPublications.get(source.id);
  if (waiting) return waiting;
  const next = schedule(source, current => {
    queuedPublications.delete(source.id);
    return publish(current);
  });
  queuedPublications.set(source.id, next);
  return next;
}

async function publish(source) {
  if (!canPublish(source) || !isAction(source)) return;
  // Leave the player's last published summary in place during the GM's roll.
  // Do not hold the publication queue: withdrawal and deletion still run.
  const delay = pendingRoll(source);
  if (delay) {
    if (delayedPublications.get(source) !== delay) {
      delayedPublications.set(source, delay);
      delay.then(() => {
        if (delayedPublications.get(source) !== delay) return;
        delayedPublications.delete(source);
        if (game.messages.get(source.id) === source) requestPublication(source);
      });
    }
    return;
  }
  const summary = buildSummary(source);
  if (!summary) return;
  let id = data(source).reducedId;
  if (!id) {
    id = foundry.utils.randomID();
    await source.setFlag(scope, "reducedId", id);
    if (!canPublish(source) || !game.messages.has(source.id)) return;
  }
  let copy = game.messages.get(id);
  if (copy) {
    if (data(copy).reducedFrom !== source.id || !copy.author?.isGM) return;
    if (JSON.stringify(data(copy).reduced) !== JSON.stringify(summary)) {
      await copy.update({ [`flags.${scope}.reduced`]: summary, "speaker.alias": summary.speaker.name });
    }
  } else {
    copy = await ChatMessage.create({ _id: id, style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      speaker: { alias: summary.speaker.name, actor: null, token: null, scene: null },
      content: localize(summary.attack ? "AttackTotal" : "Save"), rolls: [], whisper: [], blind: false, sound: null,
      flags: { [scope]: { reducedFrom: source.id, reduced: summary } }
    }, { keepId: true, messageMode: "public" });
  }
  if (copy) shareCover(source, copy);
}

// Only publish the illustration on the linked public message. A slow wiki request
// must not hold up the attack or subsequent HP updates.
function shareCover(source, copy) {
  const actorId = data(copy).reduced?.speaker.wikiActorId;
  const actor = actorId && game.actors?.get(actorId);
  if (!actor || !getSharedCover || data(copy).cover?.actorId === actorId || pendingCovers.get(copy) === actorId) return;
  pendingCovers.set(copy, actorId);
  Promise.resolve().then(() => getSharedCover(actor)).then(image => {
    if (!image || !canPublish(source) || game.messages.get(copy.id) !== copy || data(source).reducedId !== copy.id
      || data(copy).reducedFrom !== source.id || data(copy).reduced?.speaker.wikiActorId !== actorId) return;
    return copy.setFlag(scope, "cover", { actorId, image });
  }).catch(error => console.warn("Khuzoe HUD | Chat banner", error)).finally(() => {
    if (pendingCovers.get(copy) === actorId) pendingCovers.delete(copy);
  });
}

async function refreshPublishedCards() {
  if (!game.user.isGM) return;
  if (!historyIndexed) {
    for (const doc of game.messages.values()) {
      if (data(doc).reduced) { publishedIds.add(doc.id); continue; }
      if (midi(doc).undoDamage) continue;
      const parent = parentOf(doc);
      if (parent?.isContentVisible && doc.isContentVisible) indexChildDamage(parent, doc);
    }
    historyIndexed = true;
  }
  for (const id of publishedIds) {
    const copy = game.messages.get(id);
    const { reduced, reducedFrom } = data(copy);
    if (!reduced || !copy.author?.isGM) continue;
    const source = game.messages.get(reducedFrom);
    if (!canPublish(source) || data(source).reducedId !== copy.id) continue;
    if (!Object.hasOwn(reduced, "title") || !reduced.speaker.wikiActorType
      || (reduced.attack && (!Object.hasOwn(reduced, "attackGroup") || !Object.hasOwn(reduced, "rolledDamage")))) {
      await schedule(source, async current => {
        if (!canPublish(current) || data(current).reducedId !== copy.id || game.messages.get(copy.id) !== copy) return;
        const speaker = resolve(midi(current).attackingTokenUuid) ?? speakerOf(current);
        const markup = publishedMarkup(current);
        const { title, actor } = presentation(current, speaker, markup);
        const changes = {};
        if (reduced.attack && !Object.hasOwn(reduced, "rolledDamage")) {
          const fields = attackDamageFields(current);
          changes[`flags.${scope}.reduced.rolledDamage`] = fields.rolledDamage;
          changes[`flags.${scope}.reduced.missed`] = fields.missed;
        }
        if (reduced.attack && !Object.hasOwn(reduced, "attackGroup")) changes[`flags.${scope}.reduced.attackGroup`] = reducedAttackGroup(current, markup.placedTargets);
        if (reduced.title !== title) changes[`flags.${scope}.reduced.title`] = title;
        if (actor && actor.id !== reduced.speaker.wikiActorId) changes[`flags.${scope}.reduced.speaker.wikiActorId`] = actor.id;
        if (actor && actor.type !== reduced.speaker.wikiActorType) changes[`flags.${scope}.reduced.speaker.wikiActorType`] = actor.type;
        if (Object.keys(changes).length) await copy.update(changes);
      });
    }
    shareCover(source, copy);
  }
}

function key(uuid) { return uuid.replaceAll(".", "_"); }

async function removeCopy(source) {
  const id = data(source).reducedId;
  const copy = id && game.messages.get(id);
  if (copy && copy.author?.isGM && data(copy).reducedFrom === source.id) await copy.delete();
}

function onMessage(message) {
  if (!game.user.isGM) return;
  if (data(message).reduced) { publishedIds.add(message.id); return; }
  publishedIds.delete(message.id);
  if (midi(message).undoDamage) return;
  if (data(message).reducedId && !isPrivate(message)) {
    if (game.users.activeGM?.id === game.user.id) return schedule(message, current => current && !isPrivate(current) && removeCopy(current));
    return;
  }
  const parent = parentOf(message);
  if (parent) {
    if (!message.isContentVisible) {
      if (childDamageRolls.get(parent)?.delete(message.id) && canPublish(parent)) return requestPublication(parent);
      return;
    }
    const damageChanged = indexChildDamage(parent, message);
    if (!canPublish(parent)) return;
    const attack = nativeAttack(message);
    const save = nativeSave(message);
    const doc = save && speakerOf(message);
    if (damageChanged && !attack && !doc) return requestPublication(parent);
    if (attack || damageChanged || (doc && save)) return schedule(parent, async current => {
      if (!canPublish(current)) return;
      if (attack) {
        const prev = data(current).childAttack;
        if (prev?.total !== attack.total || prev.critical !== attack.critical) await current.setFlag(scope, "childAttack", attack);
      } else if (doc && save) {
        const prev = data(current).outcomes?.[key(doc.uuid)];
        if (prev?.save !== save.save || (save.passed !== undefined && prev.passed !== save.passed)) {
          await current.update({ [`flags.${scope}.outcomes.${key(doc.uuid)}`]: { uuid: doc.uuid, ...save } });
        }
      }
      if (damageChanged) await publish(current);
    });
    return;
  }
  if (canPublish(message) && isAction(message)) return requestPublication(message);
}

function damageSource(options) {
  const ref = options?.khuzoeReducedSource ?? options?.originatingMessage ?? options?.origin;
  const doc = typeof ref === "string" ? messageByRef(ref) : ref;
  return parentOf(doc) ?? (isAction(doc) ? doc : undefined);
}

export function registerReducedCards(sharedCover) {
  getSharedCover = sharedCover;
  Hooks.on("ready", () => queueMicrotask(refreshPublishedCards));
  Hooks.on("khuzoeWikiSync.authChanged", () => queueMicrotask(refreshPublishedCards));
  Hooks.on("createChatMessage", onMessage);
  Hooks.on("updateChatMessage", onMessage);
  Hooks.on("deleteChatMessage", message => {
    publishedIds.delete(message.id);
    if (data(message).reducedId && canPublish(message)) return schedule(message, () => removeCopy(message));
    const parent = parentOf(message);
    if (childDamageRolls.get(parent)?.delete(message.id) && canPublish(parent)) return requestPublication(parent);
  });
  Hooks.on("dnd5e.preRollSavingThrow", (config, _dialog, message) => {
    const card = config.event?.target?.closest?.(".chat-message[data-message-id]");
    const ref = config.midiOptions?.itemCardUuid ?? card?.dataset.messageId;
    const source = messageByRef(ref);
    if (ref && (!source || isPrivate(source))) foundry.utils.setProperty(message, `data.flags.${scope}.rollParent`, ref);
  });
  Hooks.on("midi-qol.postCheckSaves", workflow => {
    const source = workflow.chatCard ?? messageByRef(workflow.itemCardUuid);
    if (!game.user.isGM || !isAction(source) || !source.isContentVisible) return;
    const changes = {};
    for (const row of workflow.saveDisplayData ?? []) {
      const uuid = row.target?.document?.uuid;
      if (!uuid) continue;
      const path = `flags.${scope}.outcomes.${key(uuid)}`;
      changes[`${path}.uuid`] = uuid;
      changes[`${path}.name`] = row.playerName || identity(row.target.document).name;
      changes[`${path}.save`] = /^[-+]?\d+(?:\.\d+)?$/.test(row.rollTotal) ? Number(row.rollTotal) : null;
      changes[`${path}.passed`] = row.saveClass === "success" ? true : row.saveClass === "failure" ? false : null;
    }
    if (Object.keys(changes).length) return source.update(changes);
  });
  Hooks.on("preCreateChatMessage", message => {
    if (!midi(message).playerDamageCard) return;
    const source = messageByRef(data(message).sourceMessageId ?? message.flags?.dnd5e?.originatingMessage
      ?? midi(message).undoDamage?.[0]?.calcDamageOptions?.khuzoeReducedSource);
    // Midi's player receipt itself contains the full undoDamage breakdown.
    if (data(message).reducedReceipt || isAction(source) || parentOf(source)) return false;
  });
  Hooks.on("midi-qol.preTargetDamageApplication", (token, { workflow, damageItem }) => {
    const source = workflow?.chatCard ?? messageByRef(workflow?.itemCardId ?? workflow?.itemCardUuid);
    if (!isAction(source) || !damageItem) return;
    workflow.flagTags ??= {};
    workflow.flagTags[scope] ??= {};
    workflow.flagTags[scope].reducedReceipt = true;
    // Midi's multiplier button uses updateOptions alone. Automatic application,
    // Apply and Reverse also forward calcDamageOptions.
    for (const options of [damageItem.calcDamageOptions ??= {}, damageItem.updateOptions ??= {}]) {
      options.khuzoeReducedSource = source.id;
      options.khuzoeReducedTarget = token.document.uuid;
    }
  });
  Hooks.on("dnd5e.preApplyDamage", (actor, _amount, _updates, options) => {
    if (!game.user.isGM || !options) return;
    const source = damageSource(options);
    if (!source?.isContentVisible) return;
    const target = resolve(options.khuzoeReducedTarget ?? options.midi?.targetUuid);
    const doc = target?.actor?.uuid === actor.uuid ? target : actor.token ?? actor;
    const hp = actor.system.attributes.hp;
    let batch = applications.get(options);
    if (!batch) applications.set(options, batch = new Map());
    batch.set(actor.uuid, { source, uuid: doc.uuid, ...identity(doc), before: hp.value, temp: hp.temp ?? 0 });
  });
  Hooks.on("dnd5e.applyDamage", (actor, _amount, options) => {
    const batch = applications.get(options);
    const app = batch?.get(actor.uuid);
    if (!app) return;
    batch.delete(actor.uuid);
    if (!batch.size) applications.delete(options);
    const hp = actor.system.attributes.hp;
    const after = num(hp.value), temp = num(hp.temp ?? 0);
    if (after === null) return;
    return schedule(app.source, async source => {
      if (!isAction(source) || !source.isContentVisible) return;
      const k = key(app.uuid), previous = data(source).outcomes?.[k];
      const first = previous?.hp?.[1] === app.before ? previous.hp[0] : app.before;
      const firstTemp = previous?.temp?.[1] === app.temp ? previous.temp[0] : app.temp;
      await source.update({ [`flags.${scope}.outcomes.${k}`]: { uuid: app.uuid, name: previous?.name || app.name, img: app.img, hp: [first, after],
        temp: firstTemp !== temp && temp !== null ? [firstTemp, temp] : null } });
    });
  });
}
