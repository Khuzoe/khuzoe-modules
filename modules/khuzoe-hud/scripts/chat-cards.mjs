import { damageTypes, hpChange } from "./damage.mjs";

const tr = key => game.i18n.localize(`KHUZOE_HUD.${key}`);
const number = value => value.toLocaleString(game.i18n.lang, { maximumFractionDigits: 3 });
const signed = value => (value < 0 ? "−" : "+") + number(Math.abs(value));
const receiptRows = ".midi-qol-dmg-row[data-actor-uuid], .midi-qol-dmg-row-classic[data-actor-uuid]";
const midiRolls = ".dice-roll:is(.midi-damage-roll, .midi-other-damage-roll, .midi-bonus-damage-roll)";
const hidden = '[hidden], [aria-hidden="true"], .secret-roll, [style*="display: none"], [style*="display:none"]';
const sourceSummary = ".chat-card > .card-header > header.summary";

function node(tag, cls, text) {
  const element = document.createElement(tag);
  element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}

function damageBadge(label, icon, amount, reasons = [], color, before) {
  const badge = node("span", "khhud-badge");
  const accent = color?.css ?? color;
  if (typeof accent === "string" && CSS.supports("color", accent)) badge.style.setProperty("--khhud-type-color", accent);
  if (icon) {
    const image = node("img", "khhud-type-icon");
    image.src = icon;
    image.alt = "";
    const emblem = node("span", "khhud-emblem");
    emblem.append(image);
    badge.append(emblem);
  }
  const description = node("span", "khhud-type");
  description.append(node("span", "khhud-type-name", label));
  if (reasons.length) description.append(node("span", "khhud-reasons", reasons.join(" · ")));
  const value = node("span", "khhud-value");
  if (before !== undefined) value.append(node("span", "khhud-before", `${before} → `));
  value.append(node("strong", "khhud-amount", amount));
  badge.append(description, value);
  return badge;
}

function sourceArtwork(message, summary) {
  const title = summary?.querySelector(".name-stacked > .title");
  if (!title || title.closest(hidden) || title.closest(".secret:not(.revealed)")
    || title.querySelector(`${hidden}, .secret:not(.revealed)`)) return;
  if (!game.user.isGM && title.closest("[data-concealed]")) return;
  const name = title.textContent.trim();
  if (!name) return;
  const image = summary.querySelector("img.gold-icon");
  const nativeIcon = image && !image.closest(hidden) ? image.dataset.khhudOriginalIcon ?? image.getAttribute("src") : undefined;
  const activity = nativeIcon && message.getAssociatedActivity?.();
  // An item can have several activities, including unidentified or GM-only ones.
  const named = activity?.name && (name === activity.name || name.endsWith(`: ${activity.name}`));
  const mayUseArt = activity && (game.user.isGM || (activity.canConfigure !== false
    && activity.item?.system?.identified !== false && (activity.item?.isOwner || named)));
  return { name, nativeIcon, icon: (mayUseArt && activity._source?.img) || nativeIcon };
}

function setArtwork(image, icon, fallback) {
  image.addEventListener("error", () => {
    if (fallback && fallback !== icon) setArtwork(image, fallback);
    else image.hidden = true;
  }, { once: true });
  image.src = icon;
}

function styleRollSource(message, html, content) {
  const summary = content.querySelector(sourceSummary);
  if (!summary || summary.querySelector(".khhud-token-icon")) return;
  const skill = summary.querySelector("img.gold-icon");
  if (!summary.classList.contains("khhud-source")) {
    const art = sourceArtwork(message, summary);
    if (!art) return;
    summary.classList.add("khhud-source");
    if (art.icon !== art.nativeIcon) {
      skill.dataset.khhudOriginalIcon = art.nativeIcon;
      setArtwork(skill, art.icon, art.nativeIcon);
    }
  }
  if (!skill?.getAttribute("src") || skill.closest(hidden)) return;
  const sender = html.querySelector(".message-header .message-sender .avatar[data-uuid] > :is(img, video)");
  if (sender?.getAttribute("src") && !sender.closest(`${hidden}, .secret:not(.revealed)`)) {
    const portrait = sender.cloneNode(false);
    portrait.removeAttribute("id");
    portrait.className = "khhud-token-icon";
    portrait.title = sender.getAttribute("alt") ?? "";
    skill.before(portrait);
  }
}

async function addResultSource(message, shell) {
  const id = message.flags?.["khuzoe-hud"]?.sourceMessageId;
  const source = id && game.messages.get(id);
  if (!source?.isContentVisible || source === message || source.flags?.["midi-qol"]?.undoDamage) return;
  // Use the viewer's rendered item header, including any redactions, even for older chat history.
  const original = document.querySelector(`.chat-message[data-message-id="${CSS.escape(id)}"]`) ?? await source.renderHTML();
  if (!source.isContentVisible || !message.isContentVisible || !original) return;
  const art = sourceArtwork(source, original.querySelector(sourceSummary));
  if (!art) return;
  const header = node("header", "khhud-source");
  if (art.icon) {
    const portraits = [...shell.querySelectorAll("img.midi-qol-target-name")]
      .filter(img => img.getAttribute("src") && !img.closest(`${hidden}, .secret:not(.revealed)`));
    // Keep Midi's original portrait and event handlers in each pair.
    const slots = portraits.map(portrait => {
      const existing = portrait.closest(".khhud-target-art");
      if (existing) return existing;
      const slot = node("span", "khhud-target-art");
      portrait.before(slot);
      slot.append(portrait);
      return slot;
    });
    for (const slot of slots.length ? slots : [header]) {
      const image = node("img", "khhud-source-icon");
      image.alt = "";
      image.title = art.name;
      setArtwork(image, art.icon, art.nativeIcon);
      slot.append(image);
    }
  }
  header.append(node("strong", "khhud-source-name", art.name));
  shell.prepend(header);
}

function showRollDetails(message) {
  if (game.user.isGM || !message.author?.isGM || !game.modules.get("midi-qol")?.active) return true;
  const settings = globalThis.MidiQOL?.configSettings?.();
  return !!settings && (settings.gmDamageDisplay ?? "full") === "full";
}

function decorateRoll(roll) {
  if (roll.classList.contains("khhud-roll") || roll.closest(hidden)) return;
  const total = roll.querySelector(".dice-result > .dice-total");
  if (!total || !/^\d+(?:[.,]\d+)?$/.test(total.textContent.trim())) return;
  const chips = node("div", "khhud-types");
  const healingTypes = Object.values(CONFIG.DND5E.healingTypes ?? {});
  const types = [...Object.values(CONFIG.DND5E.damageTypes), ...healingTypes];
  let healingCount = 0;
  // Read only the typed parts the system actually rendered for this viewer.
  for (const part of roll.querySelectorAll(".dice-tooltip .tooltip-part .total")) {
    if (part.closest(hidden)) continue;
    const image = part.querySelector("img");
    const label = image?.alt || part.querySelector(".label")?.textContent.trim();
    const amount = part.querySelector(".value")?.textContent.trim();
    if (!label || !amount) continue;
    const icon = image?.getAttribute("src");
    const metadata = types.find(type => type.label === label) ?? types.find(type => icon && type.icon === icon);
    if (metadata && healingTypes.includes(metadata)) healingCount++;
    chips.append(damageBadge(label, icon ?? metadata?.icon, amount, [], metadata?.color));
  }
  if (!chips.childElementCount) return;
  let key = "Roll";
  if (healingCount) key = healingCount === chips.childElementCount ? "HealingRoll" : "MixedRoll";
  total.dataset.khhudLabel = tr(key);
  roll.classList.add("khhud-roll");
  total.after(chips);
}

function decorateRolls(message, html, content) {
  if (!message.rolls?.length || !showRollDetails(message)) return;
  const rollType = message.flags?.dnd5e?.roll?.type;
  const DamageRoll = CONFIG.Dice?.DamageRoll;
  const native = rollType === "damage" || (!rollType && !message.flags?.["midi-qol"]
    && DamageRoll && message.rolls.every(roll => roll instanceof DamageRoll));
  const selector = native ? ".dice-roll" : midiRolls;
  if (!native && !message.rolls.some(roll => ["otherDamage", "bonusDamage", "defaultDamage"]
    .includes(roll.options?.["midi-qol"]?.rollType))) return;

  content.querySelectorAll(selector).forEach(decorateRoll);
  if (content.querySelector(".khhud-roll")) styleRollSource(message, html, content);
  if (content.dataset.khhudRolls === selector) return;
  content.dataset.khhudRolls = selector;
  // Midi can finish D&D5e's asynchronous enrichment after the system render hook.
  // Observe this render only. A replacement dice roll carries its own markup and visibility.
  const observer = new MutationObserver(records => {
    if (!message.isContentVisible || html.closest(hidden) || !showRollDetails(message)) return;
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1 || added.classList.contains("khhud-types")) continue;
        if (added.matches(selector)) decorateRoll(added);
        else added.querySelectorAll(selector).forEach(decorateRoll);
      }
    }
    if (content.querySelector(".khhud-roll")) styleRollSource(message, html, content);
  });
  // D&D5e may also add the speaker portrait to the message header after the dice.
  observer.observe(html, { childList: true, subtree: true });
}

function initialState(row, content, playerCard) {
  if (!playerCard && row.dataset.hpApplied === "true") return "Applied";
  const header = content.querySelector("#midi-qol-dmg-header")?.textContent.trim();
  if (header === game.i18n.localize("midi-qol.HPNotUpdated")) return "Pending";
  // Midi 14.0.11 omits damageWasApplied from the player template context.
  // Neither its false attribute nor a missing header proves manual application.
  return "Initial";
}

function targetName(row, actor) {
  const tooltipName = row.querySelector(".midi-qol-tooltiptext b")?.textContent.trim();
  if (tooltipName) return tooltipName;
  const tooltip = row.dataset.tooltip ?? row.querySelector("[data-tooltip]")?.dataset.tooltip;
  if (tooltip) {
    const template = document.createElement("template");
    template.innerHTML = tooltip;
    const name = template.content.querySelector("b")?.textContent.trim();
    if (name) return name;
  }
  return actor?.name || tr("Target");
}

function appendBreakdown(body, entry) {
  const types = node("div", "khhud-types");
  for (const { type, rolled, result, reasons } of damageTypes(entry)) {
    const metadata = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes?.[type];
    const label = metadata?.label ?? (type === "none" ? tr("Untyped") : type);
    const amount = result === undefined ? `${tr("Rolled")} ${number(rolled)}` : number(result);
    const before = rolled !== undefined && result !== undefined && rolled !== result ? number(rolled) : undefined;
    types.append(damageBadge(label, metadata?.icon, amount, reasons.map(tr), metadata?.color, before));
  }
  if (types.childElementCount) body.append(types);
  const ward = entry.calcDamageOptions?.khuzoeArcaneWard?.absorbed;
  if (Number.isFinite(ward) && ward > 0) {
    body.append(node("span", "khhud-ward", game.i18n.format("KHUZOE_HUD.Ward", { amount: number(ward) })));
  }
}

function targetSummary(entry, name, state, showTypes, expanded) {
  const hp = hpChange(entry.oldHP, entry.newHP);
  const temp = hpChange(entry.oldTempHP, entry.newTempHP);
  if (!hp && !temp) return null;
  const card = node("details", "khhud-target");
  card.open = expanded;
  const header = node("summary", "khhud-summary");
  const heading = node("span", "khhud-heading");
  heading.append(node("strong", "khhud-name", name), node("span", "khhud-state", tr(state)));
  header.append(heading);
  const numbers = node("span", "khhud-numbers");
  if (hp?.delta) {
    numbers.append(node("strong", hp.delta < 0 ? "khhud-loss" : "khhud-gain", `${signed(hp.delta)} ${tr("HP")}`));
  } else if (hp) numbers.append(node("strong", "khhud-unchanged", tr("NoChange")));
  if (temp?.delta) numbers.append(node("span", "khhud-temp", `${signed(temp.delta)} ${tr("TempHP")}`));
  header.append(numbers, node("span", "khhud-chevron"));
  card.append(header);
  const body = node("div", "khhud-body");
  if (showTypes) appendBreakdown(body, entry);
  const pools = node("div", "khhud-pools");
  for (const [pool, label] of [[hp, "HP"], [temp, "TempHP"]]) {
    if (pool && (pool.delta || label === "HP")) pools.append(node("span", "", `${tr(label)} ${number(pool.before)} → ${number(pool.after)}`));
  }
  if (pools.childElementCount) body.append(pools);
  card.append(body);
  return card;
}

function decorateResults(message, content, midi) {
  const rows = [...content.querySelectorAll(receiptRows)];
  const shell = content.querySelector(".midi-qol-damage-card, .xmidi-qol-flex-container");
  if (!shell) return;
  shell.classList.add("khhud-results");
  for (const row of rows) {
    if (row.dataset.khhud || row.closest(hidden)) continue;
    const portrait = row.querySelector("img.midi-qol-target-name");
    const candidates = midi.undoDamage.filter(entry => entry.actorUuid?.replaceAll(".", "") === row.dataset.actorUuid);
    const entry = candidates.length === 1 ? candidates[0] : candidates.find(entry => portrait?.id && entry.targetUuid?.endsWith(`.${portrait.id}`));
    if (!entry) continue;
    const actor = globalThis.fromUuidSync(entry.actorUuid);
    if (!game.user.isGM && !actor?.isOwner) continue;
    const state = initialState(row, content, midi.playerDamageCard);
    const card = targetSummary(entry, targetName(row, actor), state, showRollDetails(message), rows.length === 1);
    if (!card) continue;
    row.dataset.khhud = "true";
    if (portrait?.getAttribute("src") && !portrait.closest(`${hidden}, .secret:not(.revealed)`)) {
      const art = node("span", "khhud-target-art");
      const tooltip = portrait.closest(".midi-qol-tooltip");
      if (row.dataset.tooltip && !portrait.hasAttribute("data-tooltip")) {
        portrait.dataset.tooltip = row.dataset.tooltip;
        row.removeAttribute("data-tooltip");
      }
      // Classic cards keep the portrait's tooltip inside the table cell.
      art.append(row.tagName === "TR" && tooltip && row.contains(tooltip) ? tooltip : portrait);
      card.querySelector("summary").prepend(art);
    }
    if (row.tagName === "TR") {
      const summaryRow = document.createElement("tr");
      const cell = summaryRow.insertCell();
      cell.colSpan = Math.max(1, row.cells.length);
      cell.append(card);
      row.before(summaryRow);
    } else row.prepend(card);
  }
  // After a native command or multiplier selection, Midi shows its own live
  // preview (including the opposite operation after Apply). Keep those nodes.
  if (shell.dataset.khhudControls) return;
  shell.dataset.khhudControls = "true";
  addResultSource(message, shell).catch(error => console.warn("Khuzoe HUD | Source card", error));
  function showNativePreview(event) {
    const control = event.target.closest("button, select");
    if (!control || !/^(?:all-(?:apply|reverse)$|apply-|reverse-|dmg-multiplier-)/.test(control.id)) return;
    const affected = control.id.startsWith("all-") ? rows : [control.closest(receiptRows)];
    for (const row of affected) if (row) row.classList.add("khhud-controls-used");
  }
  shell.addEventListener("click", showNativePreview, { capture: true });
  shell.addEventListener("change", showNativePreview, { capture: true });
}

export function renderChatCard(message, html) {
  if (!message.isContentVisible || html.closest(hidden)) return;
  const content = html.querySelector(".message-content");
  if (!content) return;
  const midi = message.flags?.["midi-qol"];
  if (Array.isArray(midi?.undoDamage)) decorateResults(message, content, midi);
  else decorateRolls(message, html, content);
}

Hooks.on("dnd5e.renderChatMessage", renderChatCard);

// Midi forwards flagTags to both result cards. Store only the originating message ID.
Hooks.on("midi-qol.preTargetDamageApplication", (_token, { workflow }) => {
  const id = workflow?.itemCardId;
  if (!id) return;
  workflow.flagTags ??= {};
  workflow.flagTags["khuzoe-hud"] ??= {};
  workflow.flagTags["khuzoe-hud"].sourceMessageId = id;
});
