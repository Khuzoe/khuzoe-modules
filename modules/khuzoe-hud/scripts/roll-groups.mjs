import { cssImageUrl } from "./artwork.mjs";

const checks = new Set(["ability", "check", "skill", "tool"]);
const hidden = '[hidden], [aria-hidden="true"], [data-concealed], .hidden, .secret:not(.revealed), .secret-roll, [style*="display: none"], [style*="display:none"]';

function rollType(message) {
  return message?.flags?.dnd5e?.roll?.type ?? message?.rolls?.[0]?.options?.rollType;
}

function speakerKey(message, check) {
  const { scene, token, actor } = message.speaker ?? {};
  if (scene && token) {
    if (!check || !actor || game.scenes?.get(scene)?.tokens?.get(token)?.actorLink === false) return `Scene.${scene}.Token.${token}`;
  }
  const midi = message.flags?.["midi-qol"];
  return actor ? `Actor.${actor}` : midi?.attackingTokenUuid || midi?.sourceActorUuid;
}

function targetSet(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const ids = entries.map(entry => typeof entry === "string" ? entry : entry?.uuid);
  if (ids.some(id => !id)) return;
  return [...new Set(ids.map(id => id.replace(/^(Scene\.[^.]+\.Token\.[^.]+)\.Actor\.[^.]+$/, "$1")))].sort();
}

function recordedTargets(message) {
  const midi = message.flags?.["midi-qol"];
  return targetSet(midi?.targets) ?? targetSet(midi?.targetUuids) ?? targetSet(message.flags?.dnd5e?.targets);
}

function audience(message) {
  const recipients = [...(message.whisper ?? [])].sort();
  // The author is also an implicit recipient of a whisper.
  return [!!message.blind, recipients, message.blind || recipients.length ? message.author?.id : null];
}

// A public copy can compare two attacks without publishing any token UUIDs.
export function reducedAttackGroup(message, placedTargets) {
  const actor = speakerKey(message, false);
  const recorded = recordedTargets(message);
  const placed = targetSet(placedTargets);
  const hasTokens = recorded?.every(id => id.startsWith("Scene."));
  if (!hasTokens && recorded && placed && placed.length < recorded.length) return null;
  const targets = hasTokens ? recorded : placed ?? recorded;
  if (!actor || !targets) return null;
  return opaqueKey(JSON.stringify([actor, targets, audience(message)]));
}

export function opaqueKey(value) {
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 1099511628211n);
  return hash.toString(36);
}

export function rollGroupKey(message, element) {
  if (!message?.isContentVisible || message.visible === false || element.matches(hidden)) return;
  const flags = message.flags ?? {};
  const reduced = flags["khuzoe-hud"]?.reduced;
  const viewers = audience(message);
  if (reduced) {
    if (message.author?.isGM && reduced.attack && reduced.attackGroup) return JSON.stringify(["reduced", viewers, reduced.attackGroup]);
    return;
  }
  const type = rollType(message);
  const check = checks.has(type);
  const midi = flags["midi-qol"];
  if (!check && type !== "attack" && flags.dnd5e?.activity?.type !== "attack" && !midi?.attackRoll) return;
  const actor = speakerKey(message, check);
  if (!actor || midi?.undoDamage) return;
  if (check) return JSON.stringify(["check", viewers, actor]);
  const recorded = recordedTargets(message);
  if (game.user.isGM && recorded?.every(id => id.startsWith("Scene."))) return JSON.stringify(["attack", viewers, actor, recorded]);
  const rows = [...element.querySelectorAll(".targets-tray li.target[data-id], .targets-tray li.target[data-uuid]")];
  if (rows.some(row => row.closest(game.user.isGM ? hidden : `${hidden}, .gm-only`))) return;
  const ids = rows.map(row => row.dataset.id && message.speaker?.scene
    ? `Scene.${message.speaker.scene}.Token.${row.dataset.id}` : row.dataset.uuid);
  const targets = targetSet(ids) ?? (game.user.isGM ? recorded : null);
  if (targets && (!recorded || targets.length >= recorded.length)) return JSON.stringify(["attack", viewers, actor, targets]);
}

const attackButton = '.card-buttons button[data-action="rollAttack"]';
const damageButton = '.card-buttons button[data-action="rollDamage"]';
const attackTargets = ".midi-qol-hits-display li.target, .targets-tray li.target[data-miss], .khhud-public-tray li.khhud-public-target";

function attackParts(message, el) {
  const flags = message.flags ?? {};
  const reduced = flags["khuzoe-hud"]?.reduced;
  const activity = flags.dnd5e?.activity;
  const item = flags.dnd5e?.item;
  const itemId = item?.uuid || item?.id;
  const identity = reduced
    ? reduced.title && JSON.stringify([reduced.title, reduced.icon])
    : activity?.uuid || flags["midi-qol"]?.activityUuid || (itemId && activity?.id && JSON.stringify([itemId, activity.id]))
      || message.getAssociatedActivity?.()?.uuid;
  const concealed = game.user.isGM ? hidden : `${hidden}, .gm-only`;
  const visible = node => node && !node.closest(concealed);
  const rows = [...el.querySelectorAll(attackTargets)];
  const ids = rows.map(row => row.dataset.id || row.dataset.uuid || row.querySelector(".name")?.textContent);
  return { identity, attack: visible(el.querySelector(attackButton)), damage: visible(el.querySelector(damageButton)),
    targets: rows.length && rows.every(visible) && ids.every(Boolean) ? JSON.stringify(ids.sort()) : null };
}

export function clearAttackPresentation(el) {
  el.removeAttribute("data-khhud-attack-series");
  el.removeAttribute("data-khhud-superseded");
  el.removeAttribute("data-khhud-series-light");
  el.removeAttribute("data-khhud-series-crop");
  el.removeAttribute("data-khhud-repeat-ability");
  el.style.removeProperty("--khhud-series-art");
  el.style.removeProperty("--khhud-series-fill");
}

// Keep every control attached to its own ChatMessage and show the latest copy
// of each repeated action and target tray within a run of the same activity.
export function rollGroups(log, attached, onAttackTail) {
  const keys = new WeakMap();
  const parts = new WeakMap();
  function transparent(el) {
    return attached.has(el) || el.matches(".dsn-hide, .khhud-reduced-duplicate, [hidden], .hidden, [aria-hidden='true'], [style*='display: none'], [style*='display:none']");
  }
  function neighbor(el, direction) {
    let other = el?.[direction];
    while (other && transparent(other)) other = other[direction];
    return other;
  }
  function key(el) {
    if (!el || !el.dataset.messageId) return;
    if (!keys.has(el)) keys.set(el, rollGroupKey(game.messages.get(el.dataset.messageId), el));
    return keys.get(el);
  }
  return function update(changes) {
    const rows = new Set();
    const attacks = new Set();
    for (const el of changes) {
      if (el?.nodeType !== 1 || el.parentElement !== log) continue;
      keys.delete(el);
      parts.delete(el);
      rows.add(el);
      if (attached.has(el)) rows.add(attached.get(el));
      rows.add(neighbor(el, "previousElementSibling"));
      rows.add(neighbor(el, "nextElementSibling"));
    }
    for (const el of rows) {
      if (!el?.dataset.messageId || attached.has(el)) continue;
      const own = !transparent(el) && key(el);
      const before = !!own && key(neighbor(el, "previousElementSibling")) === own;
      const after = !!own && key(neighbor(el, "nextElementSibling")) === own;
      const message = game.messages.get(el.dataset.messageId);
      const check = checks.has(rollType(message));
      const kind = before && (check ? "check" : "attack");
      if (!check && (before || after)) attacks.add(el);
      else {
        onAttackTail(el, null);
        if (el.hasAttribute("data-khhud-attack-series")) clearAttackPresentation(el);
      }
      if (!kind) el.removeAttribute("data-khhud-roll-follow");
      else if (el.dataset.khhudRollFollow !== kind) el.dataset.khhudRollFollow = kind;
      el.toggleAttribute("data-khhud-roll-next", after);
    }
    for (const member of attacks) {
      const group = key(member);
      let first = member;
      let previous = neighbor(first, "previousElementSibling");
      while (key(previous) === group) {
        first = previous;
        previous = neighbor(first, "previousElementSibling");
      }
      const texture = first.querySelector(":scope > .message-content > .khhud-banner-texture[data-khhud-foot]");
      const fill = texture?.dataset.khhudFoot || getComputedStyle(first).getPropertyValue("--khhud-leaf").trim();
      const image = texture?.firstElementChild?.getAttribute("src");
      const art = cssImageUrl(image);
      const members = [];
      let previousActivity;
      for (let el = first; el && key(el) === group; el = neighbor(el, "nextElementSibling")) {
        attacks.delete(el);
        el.toggleAttribute("data-khhud-attack-series", true);
        if (!parts.has(el)) parts.set(el, attackParts(game.messages.get(el.dataset.messageId), el));
        const activity = parts.get(el).identity;
        el.toggleAttribute("data-khhud-repeat-ability", !!activity && previousActivity === activity);
        previousActivity = activity;
        if (art) {
          const direction = members.length % 2 ? "up" : "down";
          if (el.dataset.khhudSeriesCrop !== direction) el.dataset.khhudSeriesCrop = direction;
        } else el.removeAttribute("data-khhud-series-crop");
        members.push(el);
        if (el.style.getPropertyValue("--khhud-series-art") !== art) el.style.setProperty("--khhud-series-art", art);
        if (el.style.getPropertyValue("--khhud-series-fill") !== fill) el.style.setProperty("--khhud-series-fill", fill);
        el.toggleAttribute("data-khhud-series-light", !!texture?.hasAttribute("data-khhud-light-body"));
      }
      let identity;
      const seen = new Set();
      const tail = members.at(-1);
      for (const el of members.reverse()) {
        onAttackTail(el, tail);
        const current = parts.get(el);
        if (!current.identity || current.identity !== identity) seen.clear();
        identity = current.identity;
        const superseded = [];
        for (const name of ["attack", "damage", "targets"]) {
          if (!current[name]) continue;
          const id = name === "targets" ? current.targets : name;
          if (seen.has(id)) superseded.push(name);
          seen.add(id);
        }
        const value = superseded.join(" ");
        if (!value) el.removeAttribute("data-khhud-superseded");
        else if (el.dataset.khhudSuperseded !== value) el.dataset.khhudSuperseded = value;
      }
    }
  };
}
