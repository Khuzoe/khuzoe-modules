import { damageTypes, hpChange } from "./damage.mjs";
import { addTokenLayer, themeFromSpeaker } from "./message-theme.mjs";
import { watchReceiptGroups } from "./receipt-groups.mjs";
import { prepareRollSummary } from "./roll-summary.mjs";

const tr = key => game.i18n.localize(`KHUZOE_HUD.${key}`);
const number = value => value.toLocaleString(game.i18n.lang, { maximumFractionDigits: 3 });
const signed = value => (value < 0 ? "−" : "+") + number(Math.abs(value));
const receiptRows = ".midi-qol-dmg-row[data-actor-uuid], .midi-qol-dmg-row-classic[data-actor-uuid]";
const midiRolls = ".dice-roll:is(.midi-damage-roll, .midi-other-damage-roll, .midi-bonus-damage-roll)";
const hidden = '[hidden], [aria-hidden="true"], .secret-roll, [style*="display: none"], [style*="display:none"]';
const sourceSummary = ".chat-card > .card-header > header.summary";

// A card can contain several damage rolls or target breakdowns. Share one
// viewport subscription per rendered card and release it when Foundry removes it.
const damageGroups = new WeakMap();
const visibleDamage = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (damageGroups.has(target)) target.toggleAttribute("data-khhud-reflect", isIntersecting);
  }
});

class DamageTypesElement extends HTMLElement {
  connectedCallback() {
    this.card = this.closest(".chat-message");
    if (!this.card) return;
    const count = damageGroups.get(this.card) ?? 0;
    if (!count) visibleDamage.observe(this.card);
    damageGroups.set(this.card, count + 1);
  }

  disconnectedCallback() {
    if (!this.card) return;
    const count = damageGroups.get(this.card) - 1;
    if (count) damageGroups.set(this.card, count);
    else {
      visibleDamage.unobserve(this.card);
      damageGroups.delete(this.card);
      this.card.removeAttribute("data-khhud-reflect");
    }
    this.card = null;
  }
}
customElements.define("khhud-damage-types", DamageTypesElement);

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
  const nativeIcon = image && !image.closest(`${hidden}, [data-concealed], .hidden, .secret:not(.revealed)`)
    ? image.dataset.khhudOriginalIcon ?? image.getAttribute("src") : undefined;
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

function styleBanner(header, art, image) {
  header.classList.add("khhud-source", "khhud-banner");
  addTokenLayer(header, "khhud-portrait-band");
  // The action and its rolls inherit the same published art. A receipt owns only its banner.
  const surface = () => header.closest(".chat-card") ?? header;
  if (!art.icon) {
    surface().style.removeProperty("--khhud-ability-art");
    header.removeAttribute("data-khhud-ability-art");
    return;
  }
  const artwork = image ?? new Image();
  const updateArt = () => {
    const artURL = artwork.hidden ? "" : `url("${CSS.escape(artwork.src)}")`;
    const owner = surface();
    if (owner.style.getPropertyValue("--khhud-ability-art") !== artURL) owner.style.setProperty("--khhud-ability-art", artURL);
    // Keep this decorative state outside the roll observers' visibility attributes.
    header.toggleAttribute("data-khhud-ability-art", !!artURL && artwork.complete && artwork.naturalWidth > 0);
  };
  if (!image || art.icon !== art.nativeIcon) {
    if (image) image.dataset.khhudOriginalIcon = art.nativeIcon;
    setArtwork(artwork, art.icon, art.nativeIcon);
  }
  artwork.addEventListener("load", updateArt);
  artwork.addEventListener("error", updateArt);
  updateArt();
}

function styleActivitySource(message, content) {
  const summary = content.querySelector(sourceSummary);
  if (!summary || summary.classList.contains("khhud-banner")) return;
  const art = sourceArtwork(message, summary);
  if (!art) return;
  styleBanner(summary, art, summary.querySelector("img.gold-icon"));
  addTokenLayer(summary.closest(".chat-card"), "khhud-card-wash");
  summary.parentElement.classList.remove("collapsible", "collapsed");
}

function compactSaveLabels(content) {
  if (!game.i18n.has("KHUZOE_HUD.SavePromptDC", false)) return;
  for (const button of content.querySelectorAll('.card-buttons button[data-action="rollSave"][data-ability]')) {
    const ability = CONFIG.DND5E.abilities?.[button.dataset.ability]?.label;
    if (!ability) continue;
    const data = { ability, dc: button.dataset.dc };
    // Rewrite only the system's original prompts. Its two spans retain control
    // of DC visibility, including when the GM changes the challenge setting.
    for (const [selector, original, compact] of [
      [".visible-dc", "DND5E.SavingThrowDC", "SavePromptDC"],
      [".hidden-dc", "DND5E.SavePromptTitle", "SavePrompt"]
    ]) {
      const span = button.querySelector(selector);
      if (!span || span.childElementCount || span.textContent.trim() !== game.i18n.format(original, data)) continue;
      span.textContent = game.i18n.format(`KHUZOE_HUD.${compact}`, data);
    }
  }
}

function hideMaterialLabels(content) {
  for (const label of content.querySelectorAll(".supplement > strong:first-child")) {
    const text = label.textContent.trim().replace(/:$/, "");
    if (text === game.i18n.localize("DND5E.Materials") || /^(materials|materiali)$/i.test(text)) label.hidden = true;
  }
}

// Foundry constructs a page of chat history off-DOM, then prepends it in one
// operation. Resolve the source after that insertion, when its own card exists.
const visibleSources = new IntersectionObserver(entries => {
  for (const {target, isIntersecting} of entries) {
    if (!isIntersecting || !target.isConnected || target.closest(".khhud-gm-receipt")) continue;
    target.remove();
    target.render?.();
  }
}, { rootMargin: "140px" });

class ReceiptSource extends HTMLElement {
  connectedCallback() { visibleSources.observe(this); }
  disconnectedCallback() { visibleSources.unobserve(this); }
}
customElements.define("khhud-receipt-source", ReceiptSource);
const pendingSources = new WeakMap();

async function addResultSource(message, shell, html) {
  const id = message.flags?.["khuzoe-hud"]?.sourceMessageId;
  const source = id && game.messages.get(id);
  if (!message.isContentVisible || !source?.isContentVisible || source === message || source.flags?.["midi-qol"]?.undoDamage) return;
  // Use the viewer's rendered item header, including any redactions, even for older chat history.
  const selector = `.chat-message[data-message-id="${CSS.escape(id)}"]`;
  let original = (html.closest(".chat-log") ?? document).querySelector(selector);
  if (!original) {
    if (!pendingSources.has(source)) pendingSources.set(source, Promise.resolve(source.renderHTML()).finally(() => pendingSources.delete(source)));
    original = await pendingSources.get(source);
  }
  if (!source.isContentVisible || !message.isContentVisible || !original) return;
  const art = sourceArtwork(source, original.querySelector(sourceSummary));
  if (!art) return;
  const header = node("header", "khhud-source");
  styleBanner(header, art);
  header.append(node("strong", "khhud-source-name", art.name));
  shell.prepend(header);
  themeFromSpeaker(source, original, html);
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
  const chips = node("khhud-damage-types", "khhud-types");
  const inlineIcons = total.querySelectorAll(":scope > .midi-damage-type-icon[src]");
  const healingTypes = Object.values(CONFIG.DND5E.healingTypes ?? {});
  const types = Object.entries({ ...CONFIG.DND5E.damageTypes, ...CONFIG.DND5E.healingTypes });
  let healingCount = 0;
  // Read only the typed parts the system actually rendered for this viewer.
  for (const part of roll.querySelectorAll(".dice-tooltip .tooltip-part .total")) {
    if (part.closest(hidden)) continue;
    const image = part.querySelector("img");
    const label = image?.alt || part.querySelector(".label")?.textContent.trim();
    const amount = part.querySelector(".value")?.textContent.trim();
    if (!label || !amount) continue;
    const icon = image?.getAttribute("src");
    const [kind, metadata] = types.find(([, type]) => type.label === label)
      ?? types.find(([, type]) => icon && type.icon === icon) ?? [];
    if (metadata && healingTypes.includes(metadata)) healingCount++;
    const badge = damageBadge(label, icon ?? metadata?.icon, amount, [], metadata?.color);
    if (kind) badge.dataset.khhudKind = kind;
    chips.append(badge);
    for (const inline of inlineIcons) {
      if (inline.getAttribute("src") === (icon ?? metadata?.icon)
        && (!inline.ariaLabel || inline.ariaLabel === label)) inline.classList.add("khhud-repeated-type");
    }
  }
  if (!chips.childElementCount) return;
  let key = "Roll";
  if (healingCount) key = healingCount === chips.childElementCount ? "HealingRoll" : "MixedRoll";
  total.dataset.khhudLabel = tr(key);
  roll.classList.add("khhud-roll");
  total.after(chips);
}

function damageRollSelector(message) {
  if (!message.rolls?.length || !showRollDetails(message)) return;
  const rollType = message.flags?.dnd5e?.roll?.type;
  const DamageRoll = CONFIG.Dice?.DamageRoll;
  const native = rollType === "damage" || (!rollType && !message.flags?.["midi-qol"]
    && DamageRoll && message.rolls.every(roll => roll instanceof DamageRoll));
  if (native) return ".dice-roll";
  if (message.rolls.some(roll => ["otherDamage", "bonusDamage", "defaultDamage"]
    .includes(roll.options?.["midi-qol"]?.rollType))) return midiRolls;
}

// Take the accent colors from the visible breakdown. Midi can conceal or
// replace a roll independently of rendering the item header.
function themeFromRolls(message, html, content) {
  const colors = [];
  let kind;
  if (message.isContentVisible && showRollDetails(message)) {
    for (const badge of content.querySelectorAll(".khhud-roll .khhud-types > .khhud-badge")) {
      if (badge.closest(`${hidden}, [data-concealed], .secret:not(.revealed)`)
        || (badge.isConnected && !badge.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue;
      const color = badge.style.getPropertyValue("--khhud-type-color");
      kind ??= badge.dataset.khhudKind;
      if (color && !colors.includes(color)) colors.push(color);
      if (colors.length === 2 && kind) break;
    }
  }
  for (const [key, value] of [["--khhud-element", colors[0]], ["--khhud-element-end", colors[1]]]) {
    if (value !== undefined && html.style.getPropertyValue(key) !== value) html.style.setProperty(key, value);
    else if (value === undefined && html.style.getPropertyValue(key)) html.style.removeProperty(key);
  }
  if (html.dataset.khhudElement !== kind) {
    if (kind) html.dataset.khhudElement = kind;
    else delete html.dataset.khhudElement;
  }
}

// Midi publishes the target image inside its result row. A native D&D5e attack
// instead records the portrait at roll time alongside the target's actor UUID.
const nativeTarget = ".targets-tray ul.evaluation > li.target[data-uuid][data-miss]";

function addNativeTargetPortrait(row, targets) {
  if (row.querySelector("img") || row.closest(`${hidden}, [data-concealed], .secret:not(.revealed)`)) return;
  const target = targets.find(t => t.uuid === row.dataset.uuid);
  if (!target?.img) return;
  if (!game.user.isGM && !globalThis.fromUuidSync(target.uuid, { strict: false })?.testUserPermission?.(game.user, "OBSERVER")) return;
  const portrait = node("img", "khhud-target-portrait");
  portrait.alt = "";
  setArtwork(portrait, target.img);
  row.prepend(portrait);
}

const echoHost = ".dice-roll:not(.midi-results .dice-roll) > .dice-result";
function addTokenEchoes(root) {
  if (root.matches(echoHost)) addTokenLayer(root, "khhud-token-echo");
  if (root.firstElementChild) {
    for (const host of root.querySelectorAll(echoHost)) addTokenLayer(host, "khhud-token-echo");
  }
}

function decorateActivity(message, html, content) {
  addTokenEchoes(content);
  for (const roll of content.querySelectorAll(".dice-roll")) prepareRollSummary(roll, message);
  hideMaterialLabels(content);
  const selector = damageRollSelector(message);
  const targets = message.flags?.dnd5e?.targets;
  const hasTargets = Array.isArray(targets) && targets.length > 0;
  const dnd = message.flags?.dnd5e;
  const pendingItem = dnd?.roll && (dnd.item || dnd.originatingMessage);
  if (!selector && !hasTargets && !pendingItem && !content.querySelector(`${sourceSummary}, .midi-buttons, .card-buttons`)) return;
  styleActivitySource(message, content);
  compactSaveLabels(content);
  if (selector) {
    content.querySelectorAll(selector).forEach(decorateRoll);
    themeFromRolls(message, html, content);
  }
  if (hasTargets) content.querySelectorAll(nativeTarget).forEach(row => addNativeTargetPortrait(row, targets));
  if (content.dataset.khhudActivity) return;
  content.dataset.khhudActivity = "true";
  // Only watch the action body. Foundry updates the header clock independently.
  // Our order and art properties do not affect roll visibility. Keep changes
  // from Foundry and other modules, including their CSS custom properties.
  const externalStyle = () => {
    let result = "";
    for (const name of html.style) {
      if (!name.startsWith("--khhud-")) result += `${name}:${html.style.getPropertyValue(name)}!${html.style.getPropertyPriority(name)};`;
    }
    return result;
  };
  let lastStyle = selector && externalStyle();
  const observer = new MutationObserver(records => {
    if (selector && records.some(r => r.target === html && r.attributeName === "style")) {
      const current = externalStyle();
      const onlyOuterStyle = records.every(r => r.target === html && r.attributeName === "style");
      if (onlyOuterStyle && current === lastStyle) return;
      lastStyle = current;
    }
    if (!message.isContentVisible || html.closest(hidden)) {
      if (selector) themeFromRolls(message, html, content);
      return;
    }
    const inserted = records.some(record => record.type === "childList"
      && Array.from(record.addedNodes).some(el => el.nodeType === 1 && !el.matches("khhud-kept-die, .khhud-types, .khhud-token-layer")));
    if (inserted) {
      styleActivitySource(message, content);
      compactSaveLabels(content);
    }
    const showDice = selector && showRollDetails(message);
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1 || added.matches("khhud-kept-die, .khhud-types, .khhud-token-layer")) continue;
        addTokenEchoes(added);
        if (added.matches(".dice-roll")) prepareRollSummary(added, message);
        else {
          const roll = added.closest(".dice-roll");
          if (roll) prepareRollSummary(roll, message);
          added.querySelectorAll(".dice-roll").forEach(child => prepareRollSummary(child, message));
        }
        if (added.matches(".supplement")) hideMaterialLabels(added.parentElement);
        else hideMaterialLabels(added);
        if (hasTargets) {
          if (added.matches(nativeTarget)) addNativeTargetPortrait(added, targets);
          else added.querySelectorAll(nativeTarget).forEach(row => addNativeTargetPortrait(row, targets));
        }
        if (showDice) {
          if (added.matches(selector)) decorateRoll(added);
          else added.querySelectorAll(selector).forEach(decorateRoll);
        }
      }
    }
    if (selector) themeFromRolls(message, html, content);
  });
  const visibility = ["class", "style", "hidden", "aria-hidden", "data-concealed"];
  observer.observe(content, {
    childList: true,
    subtree: true,
    attributeFilter: selector ? visibility : undefined
  });
  if (selector) observer.observe(html, { attributeFilter: visibility });
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
  const types = node("khhud-damage-types", "khhud-types");
  for (const { type, rolled, result, reasons } of damageTypes(entry)) {
    const metadata = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes?.[type];
    const label = metadata?.label ?? (type === "none" ? tr("Untyped") : type);
    const amount = result === undefined ? `${tr("Rolled")} ${number(rolled)}` : number(result);
    const before = rolled !== undefined && result !== undefined && rolled !== result ? number(rolled) : undefined;
    const badge = damageBadge(label, metadata?.icon, amount, reasons.map(tr), metadata?.color, before);
    if (metadata) badge.dataset.khhudKind = type;
    types.append(badge);
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

function decorateResults(message, html, content, midi) {
  const rows = [...content.querySelectorAll(receiptRows)];
  const shell = content.querySelector(".midi-qol-damage-card, .xmidi-qol-flex-container");
  if (!shell) return;
  html.classList.add("khhud-hp-message");
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
  if (message.flags?.["khuzoe-hud"]?.sourceMessageId) {
    const render = () => addResultSource(message, shell, html).catch(error => console.warn("Khuzoe HUD | Source card", error));
    if (html.isConnected) render();
    else {
      const placeholder = document.createElement("khhud-receipt-source");
      placeholder.render = render;
      shell.prepend(placeholder);
    }
  }
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
  if (Array.isArray(midi?.undoDamage)) {
    decorateResults(message, html, content, midi);
  }
  else {
    decorateActivity(message, html, content);
    themeFromSpeaker(message, html);
  }
}

Hooks.on("renderChatMessageHTML", (_message, html) => {
  html.classList.add("khhud-message");
  // Foundry puts the viewer's message border color directly on the entry.
  const edge = html.style.borderLeftColor;
  if (html.style.getPropertyValue("--khhud-sender-color") !== edge) html.style.setProperty("--khhud-sender-color", edge);
});
Hooks.on("dnd5e.renderChatMessage", renderChatCard);
Hooks.on("renderChatLog", watchReceiptGroups);

Hooks.on("i18nInit", () => {
  for (const key of ["Hit", "Miss", "SavePassed", "SaveFailed"]) {
    document.documentElement.style.setProperty(`--khhud-label-${key}`, JSON.stringify(tr(key)));
  }
});

// Midi forwards flagTags to both result cards. Store only the originating message ID.
Hooks.on("midi-qol.preTargetDamageApplication", (_token, { workflow }) => {
  const id = workflow?.itemCardId;
  if (!id) return;
  workflow.flagTags ??= {};
  workflow.flagTags["khuzoe-hud"] ??= {};
  workflow.flagTags["khuzoe-hud"].sourceMessageId = id;
});
