import { damageTypes, hpChange } from "./damage.mjs";
import { cssImageUrl } from "./artwork.mjs";
import { bindReceiptReversal, syncReceiptState } from "./receipt-reversal.mjs";
import { addTokenLayer, themeFromSpeaker } from "./message-theme.mjs";
import { syncReceiptPalette, watchReceiptGroups } from "./receipt-groups.mjs";
import { prepareRollSummary } from "./roll-summary.mjs";
import { registerReducedCards } from "./reduced-cards.mjs";
import { registerAttackRetries } from "./attack-retry.mjs";
import { attachWikiBanner, sharedWikiCover, wikiActorForSummary } from "./wiki-banner.mjs";

const tr = key => game.i18n.localize(`KHUZOE_HUD.${key}`);
const number = value => value.toLocaleString(game.i18n.lang, { maximumFractionDigits: 3 });
const signed = value => (value < 0 ? "−" : "+") + number(Math.abs(value));
const receiptRows = ".midi-qol-dmg-row[data-actor-uuid], .midi-qol-dmg-row-classic[data-actor-uuid]";
const midiRolls = ".dice-roll:is(.midi-damage-roll, .midi-other-damage-roll, .midi-bonus-damage-roll)";
const hidden = '[hidden], [aria-hidden="true"], .secret-roll, [style*="display: none"], [style*="display:none"]';
const sourceSummary = ".chat-card > .card-header > header.summary";
const concealedArt = `${hidden}, [data-concealed], .hidden, .secret:not(.revealed), .gm-only`;

// A card can contain several damage rolls or target breakdowns. Share one
// viewport subscription per rendered card and release it when Foundry removes it.
const damageGroups = new WeakMap();
const reflectionLifetime = 60_000;
const visibleDamage = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const group = damageGroups.get(target);
    if (!group) continue;
    clearTimeout(group.timer);
    const remaining = group.expires - Date.now();
    const reflect = isIntersecting && remaining > 0;
    target.toggleAttribute("data-khhud-reflect", reflect);
    if (reflect) group.timer = setTimeout(() => {
      target.removeAttribute("data-khhud-reflect");
      visibleDamage.unobserve(target);
    }, remaining);
    else if (remaining <= 0) visibleDamage.unobserve(target);
  }
});

class DamageTypesElement extends HTMLElement {
  connectedCallback() {
    this.card = this.closest(".chat-message");
    if (!this.card) return;
    let group = damageGroups.get(this.card);
    if (!group) {
      const timestamp = game.messages.get(this.card.dataset.messageId)?.timestamp;
      const now = Date.now();
      const expires = (Number.isFinite(timestamp) ? Math.min(timestamp, now) : now) + reflectionLifetime;
      damageGroups.set(this.card, group = { count: 0, expires, timer: null });
      if (expires > now) visibleDamage.observe(this.card);
    }
    group.count++;
  }

  disconnectedCallback() {
    if (!this.card) return;
    const group = damageGroups.get(this.card);
    if (--group.count === 0) {
      clearTimeout(group.timer);
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

// Keep the published textContent intact for activity matching and receipt artwork.
function omitAbilityNotes(label) {
  const text = label?.firstChild;
  if (text?.nodeType !== Node.TEXT_NODE || text.nextSibling || !text.data.includes("(")) return;
  const name = text.data;
  const parts = document.createDocumentFragment();
  let depth = 0, start = 0, end = 0;
  for (const match of name.matchAll(/[()]/g)) {
    if (match[0] === "(") {
      if (depth === 0) start = match.index;
      depth++;
    } else if (depth && --depth === 0) {
      const after = match.index + 1;
      if (after === name.length || /[\s.,:;!?]/u.test(name[after])) {
        while (start > end && /\s/u.test(name[start - 1])) start--;
      }
      parts.append(name.slice(end, start), node("span", "khhud-ability-note", name.slice(start, after)));
      end = after;
    }
  }
  if (end) {
    parts.append(name.slice(end));
    label.replaceChildren(parts);
  }
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

function sourceArtwork(message, summary, forPlayerReceipt = false) {
  const title = summary?.querySelector(".name-stacked > .title");
  if (!title || title.closest(hidden) || title.closest(".secret:not(.revealed)")
    || title.querySelector(`${hidden}, .secret:not(.revealed)`)) return;
  const gmView = game.user.isGM && !forPlayerReceipt;
  if (!gmView && (title.closest(concealedArt) || title.querySelector(concealedArt))) return;
  const name = title.textContent.trim();
  if (!name) return;
  const image = summary.querySelector("img.gold-icon");
  const nativeIcon = image && !image.closest(concealedArt)
    ? image.dataset.khhudOriginalIcon ?? image.getAttribute("src") : undefined;
  const activity = nativeIcon && message.getAssociatedActivity?.();
  // An item can have several activities, including unidentified or GM-only ones.
  const named = activity?.name && (name === activity.name || name.endsWith(`: ${activity.name}`));
  const mayUseArt = activity && (gmView || (activity.canConfigure !== false
    && activity.item?.system?.identified !== false && (named || (!forPlayerReceipt && activity.item?.isOwner))));
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
  omitAbilityNotes(header.querySelector(".name-stacked > .title, .khhud-source-name"));
  addTokenLayer(header, "khhud-portrait-band");
  // The action and its rolls inherit the same published art. A receipt owns only its banner.
  const surface = () => header.closest(".chat-card") ?? header;
  if (!art.icon) {
    surface().style.removeProperty("--khhud-ability-art");
    header.removeAttribute("data-khhud-ability-art");
    return;
  }
  const artwork = image ?? new Image();
  artwork.classList.add("khhud-ability-image");
  if (!image) {
    artwork.alt = "";
    header.prepend(artwork);
  }
  const updateArt = () => {
    const artURL = artwork.hidden ? "" : cssImageUrl(artwork.src);
    const owner = surface();
    if (owner.style.getPropertyValue("--khhud-ability-art") !== artURL) owner.style.setProperty("--khhud-ability-art", artURL);
    // Keep this decorative state outside the roll observers' visibility attributes.
    header.toggleAttribute("data-khhud-ability-art", !!artURL && artwork.complete && artwork.naturalWidth > 0);
    if (artwork.naturalHeight) header.style.setProperty("--khhud-icon-ratio", String(artwork.naturalWidth / artwork.naturalHeight));
  };
  if (!image || art.icon !== art.nativeIcon) {
    if (image) image.dataset.khhudOriginalIcon = art.nativeIcon;
    setArtwork(artwork, art.icon, art.nativeIcon);
  }
  artwork.addEventListener("load", updateArt);
  artwork.addEventListener("error", updateArt);
  updateArt();
  return artwork;
}

function styleActivitySource(message, content) {
  const summary = content.querySelector(sourceSummary);
  if (!summary || summary.classList.contains("khhud-banner")) return;
  const art = sourceArtwork(message, summary);
  if (!art) return;
  styleBanner(summary, art, summary.querySelector("img.gold-icon"));
  attachWikiBanner(summary, message.getAssociatedActor?.(), message, () => !summary.closest(concealedArt));
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

// Foundry constructs a page of chat history off-DOM, then prepends it in one
// operation. Resolve the source after that insertion, when its own card exists.
const visibleSources = new IntersectionObserver(entries => {
  for (const {target, isIntersecting} of entries) {
    if (!isIntersecting || !target.isConnected || target.closest(".khhud-grouped-receipt")) continue;
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

function receiptSourceId(message) {
  return message.flags?.["khuzoe-hud"]?.sourceMessageId ?? message.flags?.dnd5e?.originatingMessage;
}

// Midi creates the player receipt on the GM client. Publish only the image
// intended for that card, independently of access to the underlying roll.
function publishReceiptIcon(message) {
  if (!message.flags?.["midi-qol"]?.playerDamageCard || !game.user.isGM) return;
  const id = receiptSourceId(message);
  const source = id && game.messages.get(id);
  if (!source?.isContentVisible || source.blind || source.flags?.["midi-qol"]?.undoDamage || !source.content) return;
  const item = source.getAssociatedItem?.();
  if (!item || item.system?.identified === false) return;
  const template = document.createElement("template");
  template.innerHTML = source.content;
  const art = sourceArtwork(source, template.content.querySelector(sourceSummary), true);
  if (art?.icon) message.updateSource({ "flags.khuzoe-hud.receiptIcon": art.icon });
}

function receiptBanner(shell, art) {
  const header = node("header", "khhud-source");
  header.append(node("strong", "khhud-source-name", art.name));
  const artwork = styleBanner(header, art);
  shell.prepend(header);
  return { header, artwork };
}

function showPlayerReceiptIcon(message, shell, html, icon) {
  if (!message.flags?.["midi-qol"]?.playerDamageCard || !message.isContentVisible) return;
  themeFromSpeaker(message, html);
  const name = tr("HPRecord");
  const decorate = header => attachWikiBanner(header, message.speaker?.actor && message.getAssociatedActor?.(), message);
  function showDamageIcon() {
    if (!message.isContentVisible || !showRollDetails(message)) return;
    const published = Array.from(shell.querySelectorAll(".khhud-badge .khhud-type-icon[src]"))
      .find(el => !el.closest(concealedArt) && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    if (!published) return;
    const type = published.closest(".khhud-badge").querySelector(".khhud-type-name").textContent;
    const { header, artwork } = receiptBanner(shell, { name, icon: published.src });
    decorate(header);
    header.classList.add("khhud-damage-symbol");
    header.title = game.i18n.format("KHUZOE_HUD.DamageTypeIcon", { type });
    artwork.addEventListener("error", () => header.remove(), { once: true });
  }
  if (icon) {
    const { header, artwork } = receiptBanner(shell, { name, icon });
    decorate(header);
    header.title = tr("AbilityIcon");
    artwork.addEventListener("error", () => {
      header.remove();
      showDamageIcon();
    }, { once: true });
  } else showDamageIcon();
}

async function addResultSource(message, shell, html) {
  const id = receiptSourceId(message);
  const source = id && game.messages.get(id);
  if (!message.isContentVisible) return;
  if (message.flags?.["midi-qol"]?.playerDamageCard && showRollDetails(message)) {
    // Use only damage colours already disclosed in this viewer's receipt.
    const colors = new Set();
    for (const badge of shell.querySelectorAll(".khhud-badge")) {
      if (badge.closest(concealedArt) || !badge.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const color = badge.style.getPropertyValue("--khhud-type-color");
      if (color) colors.add(color);
      if (colors.size === 2) break;
    }
    const [primary, secondary] = colors;
    if (primary) html.style.setProperty("--khhud-receipt-tone", primary);
    if (secondary) html.style.setProperty("--khhud-receipt-end", secondary);
  }
  if (!source?.isContentVisible || source.visible === false || source === message || source.flags?.["midi-qol"]?.undoDamage) {
    const icon = !source?.blind && message.flags?.["khuzoe-hud"]?.receiptIcon;
    return showPlayerReceiptIcon(message, shell, html, icon);
  }
  // Use the viewer's rendered item header, including any redactions, even for older chat history.
  const selector = `.chat-message[data-message-id="${CSS.escape(id)}"]`;
  let original = (html.closest(".chat-log") ?? document).querySelector(selector);
  if (!original) {
    if (!pendingSources.has(source)) pendingSources.set(source, Promise.resolve(source.renderHTML()).finally(() => pendingSources.delete(source)));
    try {
      original = await pendingSources.get(source);
    } catch {
      return showPlayerReceiptIcon(message, shell, html);
    }
  }
  if (!message.isContentVisible || html.classList.contains("khhud-grouped-receipt") || shell.querySelector(":scope > .khhud-source")) return;
  if (source !== game.messages.get(id) || !source.isContentVisible || source.visible === false || !original) {
    return showPlayerReceiptIcon(message, shell, html, !source.blind && message.flags?.["khuzoe-hud"]?.receiptIcon);
  }
  const art = sourceArtwork(source, original.querySelector(sourceSummary));
  if (!art) return showPlayerReceiptIcon(message, shell, html);
  const { header } = receiptBanner(shell, art);
  attachWikiBanner(header, source.getAssociatedActor?.(), message, () => source.isContentVisible);
  if (message.flags?.["midi-qol"]?.playerDamageCard) syncReceiptPalette(html, original);
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
  const inlineIcons = total.querySelectorAll(":scope > .midi-damage-type-icon[src]");
  const healingTypes = Object.values(CONFIG.DND5E.healingTypes ?? {});
  const types = Object.entries({ ...CONFIG.DND5E.damageTypes, ...CONFIG.DND5E.healingTypes });
  let typeCount = 0;
  let healingCount = 0;
  // Style the published subtotals in their own disclosure, alongside the dice that produced them.
  for (const part of roll.querySelectorAll(".dice-tooltip .tooltip-part .total")) {
    if (part.closest(concealedArt) || part.querySelector(concealedArt)) continue;
    const image = part.querySelector("img");
    const nativeLabel = part.querySelector(".label");
    const label = image?.alt || nativeLabel?.textContent.trim();
    const value = part.querySelector(".value");
    if (!label || !value?.textContent.trim()) continue;
    const icon = image?.getAttribute("src");
    const [kind, metadata] = types.find(([, type]) => type.label === label)
      ?? types.find(([, type]) => icon && type.icon === icon) ?? [];
    if (metadata && healingTypes.includes(metadata)) healingCount++;
    const badge = node("khhud-damage-types", "khhud-types khhud-badge khhud-roll-type");
    const color = metadata?.color?.css ?? metadata?.color;
    if (typeof color === "string" && CSS.supports("color", color)) badge.style.setProperty("--khhud-type-color", color);
    if (kind) badge.dataset.khhudKind = kind;
    part.before(badge);
    badge.append(part);
    if (!nativeLabel) value.before(node("span", "label", label));
    else if (!nativeLabel.childElementCount && nativeLabel.textContent !== label) nativeLabel.textContent = label;
    typeCount++;
    for (const inline of inlineIcons) {
      if (inline.getAttribute("src") === (icon ?? metadata?.icon)
        && (!inline.ariaLabel || inline.ariaLabel === label)) inline.classList.add("khhud-repeated-type");
    }
  }
  if (!typeCount) return;
  let key = "Roll";
  if (healingCount) key = healingCount === typeCount ? "HealingRoll" : "MixedRoll";
  total.dataset.khhudLabel = tr(key);
  roll.classList.add("khhud-roll");
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
    for (const badge of content.querySelectorAll(".khhud-roll .khhud-roll-type")) {
      const part = badge.firstElementChild;
      if (!part || part.closest(concealedArt) || part.querySelector(concealedArt)
        || (part.isConnected && !part.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue;
      const color = badge.style.getPropertyValue("--khhud-type-color");
      kind ??= badge.dataset.khhudKind;
      if (color && !colors.includes(color)) colors.push(color);
      if (colors.length === 2 && kind) break;
    }
  }
  let paletteChanged = false;
  for (const [key, value] of [["--khhud-element", colors[0]], ["--khhud-element-end", colors[1]]]) {
    if (html.style.getPropertyValue(key) === (value ?? "")) continue;
    html.style.setProperty(key, value ?? "");
    paletteChanged = true;
  }
  if (paletteChanged && html.hasAttribute("data-khhud-roll-next") && !html.hasAttribute("data-khhud-roll-follow"))
    html.dispatchEvent(new Event("khhud-roll-surface-changed", { bubbles: true }));
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
  if (content.firstElementChild?.matches(".turn-card, .rest-card")) {
    for (const label of content.querySelectorAll(".activities .activity .name-stacked > :is(.title, .subtitle)")) omitAbilityNotes(label);
  }
  addTokenEchoes(content);
  for (const roll of content.querySelectorAll(".dice-roll")) prepareRollSummary(roll, message);
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
  const attack = dnd?.activity?.type === "attack" || dnd?.roll?.type === "attack" || message.flags?.["midi-qol"]?.attackRoll;
  let lastStyle = (selector || attack) && externalStyle();
  const targetNodes = ".midi-qol-hits-display, .targets-tray, li.target, .card-buttons, .midi-qol-attack-buttons, .midi-qol-damage-buttons, button[data-action]";
  const observer = new MutationObserver(records => {
    if ((selector || attack) && records.some(r => r.target === html && r.attributeName === "style")) {
      const current = externalStyle();
      const onlyOuterStyle = records.every(r => r.target === html && r.attributeName === "style");
      if (onlyOuterStyle && current === lastStyle) return;
      lastStyle = current;
    }
    if (attack && html.isConnected && records.some(record => {
      if (record.type === "attributes") return record.target === html || record.target.matches(targetNodes);
      return [...record.addedNodes, ...record.removedNodes].some(el => el.nodeType === 1
        && (el.matches(targetNodes) || el.querySelector(targetNodes)));
    })) html.dispatchEvent(new Event("khhud-roll-targets-changed", { bubbles: true }));
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
    attributeFilter: selector || attack ? visibility : undefined
  });
  if (selector || attack) observer.observe(html, { attributeFilter: visibility });
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
  html.classList.toggle("khhud-player-receipt", !!midi.playerDamageCard);
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
    bindReceiptReversal(message, row, entry, midi.undoDamage.indexOf(entry), state);
  }
  // After a native command or multiplier selection, Midi shows its own live
  // preview (including the opposite operation after Apply). Keep those nodes.
  if (shell.dataset.khhudControls) return;
  shell.dataset.khhudControls = "true";
  if (receiptSourceId(message) || midi.playerDamageCard) {
    const render = () => addResultSource(message, shell, html).catch(error => console.warn("Khuzoe HUD | Source card", error));
    const defer = () => {
      if (shell.querySelector(":scope > khhud-receipt-source")) return;
      const placeholder = document.createElement("khhud-receipt-source");
      placeholder.render = render;
      shell.prepend(placeholder);
    };
    defer();
    if (midi.playerDamageCard) html.addEventListener("khhud-receipt-unlinked", () => {
      // The source may have been withdrawn, redacted, or paged out of this log.
      shell.querySelector(":scope > .khhud-source")?.remove();
      html.classList.remove("khhud-has-portrait", "khhud-token-subject");
      for (const key of ["--khhud-speaker-art", "--khhud-family-art", "--khhud-receipt-tone", "--khhud-receipt-end"]) html.style.removeProperty(key);
      defer();
    });
  }
  function showNativePreview(event) {
    const control = event.target.closest("button, select");
    if (!control || !/^(?:all-(?:apply|reverse)$|apply-|reverse-|dmg-multiplier-)/.test(control.id)) return;
    if (event.type === "click" && control.id.startsWith("all-") && html.matches(".khhud-grouped-receipt, .khhud-managed-reversal")) {
      event.stopImmediatePropagation();
      event.preventDefault();
      for (const row of rows) row.querySelector(`button[id^="${control.id.slice(4)}-"]`)?.click();
      return;
    }
    const affected = control.id.startsWith("all-") ? rows : [control.closest(receiptRows)];
    for (const row of affected) if (row) row.classList.add("khhud-controls-used");
  }
  shell.addEventListener("click", showNativePreview, { capture: true });
  shell.addEventListener("change", showNativePreview, { capture: true });
}

// A reduced card already contains the HP changes the GM published for each target.
// Keep separate targets and HP pools distinct, including reversals and temporary HP.
function publicDamage(reduced) {
  const { targets, attack, rolledDamage, missed } = reduced;
  const applied = targets.filter(target => target.hp || target.temp);
  const hasRoll = Number.isFinite(rolledDamage);
  const showRoll = attack && (hasRoll || !applied.length);
  let rollHeading;
  let rollLine;
  if (showRoll) {
    rollHeading = node("span", "khhud-public-label", tr(!hasRoll && missed ? "AppliedDamage" : "Roll"));
    rollLine = node("span", "khhud-public-result");
    rollLine.append(node("strong", "", hasRoll ? number(rolledDamage) : missed ? number(0) : "—"));
  }
  if (!applied.length) {
    if (!showRoll) return;
    const column = node("div", "khhud-public-damage");
    column.append(rollHeading, rollLine);
    return column;
  }
  const changes = applied.map(target => {
    const pools = [[target.hp, "HP"], [target.temp, "TempHP"]].filter(([pair]) => pair);
    const deltas = pools.map(([[before, after]]) => after - before);
    const loss = deltas.reduce((sum, n) => sum + Math.max(-n, 0), 0);
    const gain = deltas.reduce((sum, n) => sum + Math.max(n, 0), 0);
    return { name: target.name, pools, loss, gain };
  });
  const mixed = changes.some(change => change.gain > 0);
  const disclosure = node("details", "khhud-public-damage");
  const summary = node("summary", "");
  const breakdown = node("div", "khhud-public-breakdown");
  const appliedLabel = node("span", "khhud-public-label", tr(mixed ? "HPChange" : "AppliedDamage"));
  if (showRoll) {
    summary.append(rollHeading, rollLine);
    breakdown.append(appliedLabel);
  } else summary.append(appliedLabel);
  for (const { name, pools, loss, gain } of changes) {
    const line = node("span", "khhud-public-result");
    if (targets.length > 1) line.append(node("span", "khhud-public-target-name", name));
    if (loss || !gain) line.append(node("strong", "", mixed && loss ? signed(-loss) : number(loss)));
    if (gain) line.append(node("strong", "khhud-gain", signed(gain)));
    (showRoll ? breakdown : summary).append(line);
    const group = node("div", "khhud-public-pools");
    if (targets.length > 1) group.append(node("b", "", name));
    for (const [[before, after], label] of pools) {
      group.append(node("span", "", `${tr(label)} ${number(before)} → ${number(after)}`));
    }
    breakdown.append(group);
  }
  disclosure.append(summary, breakdown);
  return disclosure;
}

function publicTargets(reduced) {
  const tray = node("details", "khhud-public-tray");
  tray.open = true;
  tray.append(node("summary", "khhud-public-label", tr("Targets")));
  const list = node("ul", "evaluation wrapper");
  for (const target of reduced.targets) {
    const row = node("li", "target khhud-public-target");
    if (target.img) {
      const portrait = node("img", "");
      portrait.loading = "lazy";
      portrait.alt = "";
      setArtwork(portrait, target.img);
      row.append(portrait);
    }
    row.append(node("span", "name", target.name));
    if (reduced.saves && Number.isFinite(target.save)) {
      const result = node("strong", "khhud-public-save", number(target.save));
      result.setAttribute("aria-label", `${tr("ShortSave")} ${number(target.save)}`);
      row.append(result);
    }
    if (typeof target.passed === "boolean") {
      row.classList.add(target.passed ? "success" : "failure");
      row.append(node("span", "khhud-public-outcome", tr(target.passed ? "SavePassed" : "SaveFailed")));
    }
    list.append(row);
  }
  tray.append(list);
  return tray;
}

function renderReduced(message, html, content, reduced) {
  const original = game.user.isGM && game.messages.get(message.flags["khuzoe-hud"].reducedFrom);
  if (original?.isContentVisible) {
    html.classList.add("khhud-reduced-duplicate");
    return;
  }
  const card = node("div", "chat-card khhud-reduced-card");
  const description = node("div", "description card-header");
  const header = node("header", "summary");
  const title = reduced.title || tr(reduced.attack ? "AttackTotal" : "Save");
  header.append(node("strong", "khhud-source-name", title));
  description.append(header);
  card.append(description);
  content.replaceChildren(card);
  let image;
  if (reduced.icon) {
    image = node("img", "gold-icon");
    image.alt = "";
    image.src = reduced.icon;
    header.prepend(image);
  }
  styleBanner(header, { icon: reduced.icon, nativeIcon: reduced.icon }, image);
  const wikiActor = wikiActorForSummary(reduced.speaker);
  const cover = message.flags["khuzoe-hud"].cover;
  attachWikiBanner(header, wikiActor, message, undefined, cover?.actorId === reduced.speaker?.wikiActorId ? cover?.image : undefined);
  addTokenLayer(card, "khhud-card-wash");
  if (reduced.speaker?.img) {
    const url = URL.parse(reduced.speaker.img, document.baseURI);
    if (url) {
      html.style.setProperty("--khhud-speaker-art", cssImageUrl(url.href));
      html.classList.add("khhud-has-portrait");
    }
  }
  if (reduced.saves && !reduced.icon) {
    const avatar = wikiActor?.testUserPermission?.(game.user, "OBSERVER") && wikiActor.img;
    const src = avatar || reduced.speaker?.img;
    if (src && !html.querySelector(":scope > .khhud-roll-avatar")) {
      const portrait = node("img", "khhud-roll-avatar");
      portrait.alt = "";
      portrait.loading = "lazy";
      setArtwork(portrait, src, reduced.speaker?.img);
      html.append(portrait);
    }
  }
  const results = node("div", "khhud-public-results");
  if (reduced.attack) {
    const result = node("div", "khhud-public-attack");
    const line = node("span", "khhud-public-result");
    line.append(node("strong", "", number(reduced.attack.total)));
    if (reduced.attack.critical) line.append(node("span", "khhud-public-crit", tr("CriticalHit")));
    result.append(node("span", "khhud-public-label", tr("AttackTotal")), line);
    results.append(result);
  }
  const damage = publicDamage(reduced);
  if (damage) results.append(damage);
  if (results.childElementCount) card.append(results);
  if (reduced.targets.length) card.append(publicTargets(reduced));
}

export function renderChatCard(message, html) {
  if (!message.isContentVisible || html.closest(hidden)) return;
  const content = html.querySelector(".message-content");
  if (!content) return;
  const reduced = message.flags?.["khuzoe-hud"]?.reduced;
  if (reduced && message.author?.isGM) return renderReduced(message, html, content, reduced);
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
  // Foundry may render a generic blind-roll placeholder as well as the public summary.
  if (!_message.isContentVisible && _message.flags?.["khuzoe-hud"]?.reducedId) html.classList.add("khhud-reduced-duplicate");
  // Foundry puts the viewer's message border color directly on the entry.
  const edge = html.style.borderLeftColor;
  if (html.style.getPropertyValue("--khhud-sender-color") !== edge) html.style.setProperty("--khhud-sender-color", edge);
});
Hooks.on("dnd5e.renderChatMessage", renderChatCard);
Hooks.on("updateActor", syncReceiptState);
Hooks.on("renderChatLog", watchReceiptGroups);
registerReducedCards(sharedWikiCover);
registerAttackRetries();
Hooks.on("preCreateChatMessage", publishReceiptIcon);

Hooks.on("i18nInit", () => {
  for (const key of ["Hit", "Miss", "SavePassed", "SaveFailed"]) {
    document.documentElement.style.setProperty(`--khhud-label-${key}`, JSON.stringify(tr(key)));
  }
});

// Midi forwards flagTags to both result cards. Store only the originating message ID.
Hooks.on("midi-qol.preTargetDamageApplication", (_token, { workflow }) => {
  const id = workflow?.itemCardId ?? /^ChatMessage\.([^.]+)$/.exec(workflow?.itemCardUuid)?.[1];
  if (!id) return;
  workflow.flagTags ??= {};
  workflow.flagTags["khuzoe-hud"] ??= {};
  workflow.flagTags["khuzoe-hud"].sourceMessageId = id;
});
