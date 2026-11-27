import { clearAttackPresentation, rollGroups } from "./roll-groups.mjs";

const observedLogs = new WeakSet();
const concealed = '[hidden], [aria-hidden="true"], [data-concealed], .secret:not(.revealed), .deleting';
const historySizeFromAttribute = CSS.supports("contain-intrinsic-block-size", "auto attr(data-khhud-resting px, 0px)");
let nextPanelId = 0;

// Foundry scrolls once after the initial batch of images. Wiki covers, grouped
// rolls and a sidebar first opened from another tab can change the layout later.
function followOpeningChat(log) {
  const scroll = log.parentElement;
  const controller = new AbortController();
  const options = { signal: controller.signal, passive: true, capture: true };
  const release = () => controller.abort();
  let bottom;
  const sizes = new ResizeObserver(() => {
    if (!scroll.clientHeight) { bottom = undefined; return; }
    bottom = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (Math.abs(scroll.scrollTop - bottom) > 1) scroll.scrollTo({ top: bottom, behavior: "instant" });
  });
  sizes.observe(log);
  sizes.observe(scroll);
  controller.signal.addEventListener("abort", () => sizes.disconnect(), { once: true });
  for (const type of ["wheel", "pointerdown", "touchstart", "keydown", "focusin"]) scroll.addEventListener(type, release, options);
  // Native scrollbar drags and assistive navigation may only emit a scroll.
  scroll.addEventListener("scroll", () => {
    if (bottom !== undefined && Math.abs(scroll.scrollTop - bottom) > 1
      && scroll.clientHeight && scroll.scrollHeight - scroll.clientHeight === bottom) release();
  }, { signal: controller.signal, passive: true });
  return controller;
}

// Measure each departing card once in layout pixels. ResizeObserver preserves
// fractional heights and ignores Foundry's visual interface scale.
class ChatHistory extends HTMLElement {
  connectedCallback() {
    this.log = this.parentElement.querySelector(":scope > .chat-log");
    if (!this.log) return;
    this.sizes = new ResizeObserver(entries => {
      for (const { target, borderBoxSize, contentBoxSize } of entries) {
        if (target === this.parentElement) {
          const width = contentBoxSize[0]?.inlineSize;
          if (!width || width === this.width) continue;
          if (this.width !== undefined) {
            // Rewrap history once after a sidebar resize, rather than every drag frame.
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => {
              for (const card of this.log.querySelectorAll(":scope > [data-khhud-resting]")) {
                card.removeAttribute("data-khhud-resting");
                this.sizes.observe(card, { box: "border-box" });
              }
            }, 160);
          }
          this.width = width;
          continue;
        }
        const height = contentBoxSize[0]?.blockSize;
        if (target.parentElement !== this.log || !borderBoxSize[0]?.blockSize || height === undefined) continue;
        this.sizes.unobserve(target);
        // Store the measurement outside the visibility observers' style filter.
        // Older browsers still get the exact scroll height through the CSS variable.
        if (!historySizeFromAttribute) target.style.setProperty("--khhud-history-height", `${height}px`);
        target.setAttribute("data-khhud-resting", String(height));
      }
    });
    this.viewport = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (target.parentElement !== this.log || !target.classList.contains("khhud-message")) continue;
        if (isIntersecting) {
          this.sizes.unobserve(target);
          target.removeAttribute("data-khhud-resting");
        } else if (!target.hasAttribute("data-khhud-resting")) {
          this.sizes.observe(target, { box: "border-box" });
        }
      }
    }, { root: this.parentElement, rootMargin: "320px 0px" });
    this.sizes.observe(this.parentElement);
    for (const card of this.log.children) this.track(card);
  }

  track(card) {
    if (card.matches(".chat-message:not(.khhud-reduced-duplicate)")) this.viewport?.observe(card);
  }

  untrack(card) {
    this.viewport?.unobserve(card);
    this.sizes?.unobserve(card);
    card.removeAttribute("data-khhud-resting");
    if (!historySizeFromAttribute) card.style.removeProperty("--khhud-history-height");
  }

  disconnectedCallback() {
    this.openingScroll?.abort();
    clearTimeout(this.resizeTimer);
    this.viewport?.disconnect();
    this.sizes?.disconnect();
    this.viewport = null;
    this.sizes = null;
  }
}
customElements.define("khhud-chat-history", ChatHistory);

function visibleEntry(element) {
  return element && !element.matches(concealed) && getComputedStyle(element).display !== "none";
}

function canGroupReceipt(doc) {
  const midi = doc?.flags?.["midi-qol"];
  if (!doc?.isContentVisible || doc.visible === false || !Array.isArray(midi?.undoDamage)) return false;
  if (!game.user.isGM) return !!midi.playerDamageCard;
  return !midi.playerDamageCard && !!doc.whisper?.length && doc.whisper.every(id => game.users.get(id)?.isGM);
}

export function syncReceiptPalette(receipt, source) {
  const style = source?.style;
  const edge = style?.borderLeftColor || style?.getPropertyValue("--khhud-sender-color");
  const primary = style?.getPropertyValue("--khhud-element") || edge;
  for (const [property, value] of [
    ["--khhud-record-tone", primary], ["--khhud-record-end", style?.getPropertyValue("--khhud-element-end")],
    ["--khhud-record-edge", edge]
  ]) {
    const color = value || "";
    if (receipt.style.getPropertyValue(property) !== color) receipt.style.setProperty(property, color);
  }
}

function receiptToggle(header, expanded, gmOnly, onToggle) {
  const panel = header.parentElement.querySelector(":scope > .message-content");
  panel.id ||= `khhud-receipt-panel-${++nextPanelId}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "khhud-receipt-toggle";
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", String(expanded));
  for (const [tag, cls, label] of [
    ["i", gmOnly ? "fa-solid fa-lock" : "fa-solid fa-heart-pulse"], ["span", "khhud-receipt-title", "HPRecord"],
    ...(gmOnly ? [["small", "khhud-receipt-audience", "GMOnly"]] : []), ["i", "fa-solid fa-chevron-down"]
  ]) {
    const part = document.createElement(tag);
    part.className = cls;
    if (label) part.textContent = game.i18n.localize(`KHUZOE_HUD.${label}`);
    else part.setAttribute("aria-hidden", "true");
    button.append(part);
  }
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    onToggle(open);
  });
  header.prepend(button);
}

// Keep individual ChatMessages in chronological DOM order for Foundry's paging,
// context menu and controls. Each viewer groups only their own type of receipt.
export function watchReceiptGroups(_app, root, _context, options) {
  const log = root.querySelector(".chat-scroll > .chat-log");
  if (!log || observedLogs.has(log)) return;
  observedLogs.add(log);
  const history = document.createElement("khhud-chat-history");
  history.hidden = true;
  const byId = new Map();
  const groups = new Map();
  const origin = new WeakMap();
  const expanded = new Set();
  const attached = new Map();
  const attackTails = new WeakMap();
  const anchors = new Map();
  const ledgers = new Map();
  const changedReceipts = new Set();
  const updateRolls = rollGroups(log, attached, (el, tail) => {
    if ((attackTails.get(el) ?? null) === tail) return;
    if (tail) attackTails.set(el, tail);
    else attackTails.delete(el);
    for (const receipt of groups.get(el.dataset.messageId)?.receipts ?? []) changedReceipts.add(receipt);
  });
  log.addEventListener("khhud-roll-targets-changed", e => {
    updateRolls([e.target]);
    if (changedReceipts.size) positionLedgers(new Set(), new Set());
  });
  log.addEventListener("khhud-roll-surface-changed", e => {
    const head = e.target.closest(".chat-message");
    if (head?.hasAttribute("data-khhud-roll-next") && !head.hasAttribute("data-khhud-roll-follow")) updateRolls([head]);
  });
  const ranks = new WeakMap();
  let first = 0;
  let last = 0;

  function writeOrder(el) {
    const source = anchors.get(el);
    const rank = ranks.get(source ?? el);
    if (rank === undefined) return;
    const value = String(source ? rank + 1 : rank);
    if (el.style.getPropertyValue("--khhud-log-order") !== value) el.style.setProperty("--khhud-log-order", value);
  }

  function setPositions(added, touched) {
    const wasOrdered = log.classList.contains("khhud-reordered-log");
    log.classList.toggle("khhud-grouped-log", attached.size > 0);
    if (!attached.size) {
      if (wasOrdered) {
        log.classList.remove("khhud-reordered-log");
        for (const el of log.children) el.style.removeProperty("--khhud-log-order");
      }
      return;
    }
    if (!wasOrdered) {
      const separated = el => {
        const source = anchors.get(el);
        return source && el.previousElementSibling !== source && anchors.get(el.previousElementSibling) !== source;
      };
      const affectedPair = el => separated(el) || separated(el.nextElementSibling);
      if (![...touched].some(affectedPair) && ![...added].some(affectedPair)) return;
      log.classList.add("khhud-reordered-log");
    }
    if (wasOrdered) {
      // Appends and pages of older history touch only the new siblings.
      const tail = [];
      for (let el = log.lastElementChild; el && added.delete(el); el = el.previousElementSibling) tail.push(el);
      for (const el of tail.reverse()) { ranks.set(el, last += 2); touched.add(el); }
      const head = [];
      for (let el = log.firstElementChild; el && added.delete(el); el = el.nextElementSibling) head.push(el);
      for (const el of head.reverse()) { ranks.set(el, first -= 2); touched.add(el); }
    }
    // First pair, or a middle insertion without a previous position.
    if (!wasOrdered || added.size) {
      first = last = 0;
      for (const el of log.children) { ranks.set(el, last); last += 2; }
      for (const el of log.children) writeOrder(el);
    } else {
      for (const el of touched) {
        writeOrder(el);
        for (const receipt of ledgers.get(el) ?? []) writeOrder(receipt);
      }
    }
  }

  function setOpen(receipts, open) {
    for (const receipt of receipts) {
      const id = receipt.dataset.messageId;
      if (open) expanded.add(id);
      else expanded.delete(id);
      receipt.querySelector(".khhud-receipt-toggle").setAttribute("aria-expanded", String(open));
      receipt.toggleAttribute("data-khhud-ledger-open", open);
    }
  }

  function clearLedger(receipt) {
    for (const attr of ["data-khhud-ledger-row", "data-khhud-ledger-follow", "data-khhud-ledger-open"]) receipt.removeAttribute(attr);
    receipt.querySelector(".khhud-ledger-entry")?.remove();
  }

  function positionLedgers(added, touched) {
    if (changedReceipts.size) {
      const affected = new Set();
      for (const receipt of changedReceipts) {
        const source = attached.get(receipt);
        const tail = source && (attackTails.get(source) ?? source);
        const previous = anchors.get(receipt);
        if (previous === tail) continue;
        touched.add(receipt);
        if (previous) {
          const members = ledgers.get(previous);
          members.splice(members.indexOf(receipt), 1);
          affected.add(previous);
          receipt.classList.remove("khhud-joined-next");
        }
        if (!tail) { anchors.delete(receipt); clearLedger(receipt); continue; }
        anchors.set(receipt, tail);
        if (!ledgers.has(tail)) ledgers.set(tail, []);
        ledgers.get(tail).push(receipt);
        affected.add(tail);
      }
      changedReceipts.clear();
      for (const tail of affected) {
        const receipts = ledgers.get(tail);
        tail.classList.toggle("khhud-joined-next", !!receipts.length);
        if (!receipts.length) { ledgers.delete(tail); continue; }
        receipts.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const panels = receipts.map(el => el.querySelector(":scope > .message-content"));
        const open = receipts.some(el => expanded.has(el.dataset.messageId));
        receipts.forEach((receipt, index) => {
          receipt.classList.toggle("khhud-joined-next", index < receipts.length - 1);
          const multi = receipts.length > 1;
          receipt.toggleAttribute("data-khhud-ledger-row", multi);
          receipt.toggleAttribute("data-khhud-ledger-follow", index > 0);
          const toggle = receipt.querySelector(".khhud-receipt-toggle");
          toggle.setAttribute("aria-controls", index ? panels[index].id : panels.map(p => p.id).join(" "));
          toggle.querySelector(".khhud-receipt-title").textContent = game.i18n.localize("KHUZOE_HUD.HPRecord") + (multi ? ` (${receipts.length})` : "");
          let label = panels[index].querySelector(":scope > .khhud-ledger-entry");
          if (multi) {
            if (!label) {
              label = document.createElement("strong");
              label.className = "khhud-ledger-entry";
              panels[index].prepend(label);
            }
            label.textContent = game.i18n.format("KHUZOE_HUD.ApplicationNumber", { number: index + 1 });
          } else label?.remove();
        });
        setOpen(receipts, open);
      }
    }
    setPositions(added, touched);
  }

  function refresh(group, touched, visible = visibleEntry) {
    const source = byId.get(group.id);
    const message = source && game.messages.get(group.id);
    const usable = message?.isContentVisible && message.visible !== false && !message.flags?.["midi-qol"]?.undoDamage && visible(source)
      && !source.querySelector(".chat-card > .card-header > .summary")?.closest(concealed);
    for (const receipt of group.receipts) {
      const doc = game.messages.get(receipt.dataset.messageId);
      const header = receipt.querySelector(":scope > .message-header");
      const link = usable && canGroupReceipt(doc) && visible(receipt) && header
        && receipt.querySelector(":scope > .message-content .khhud-results");
      const button = header?.querySelector(":scope > .khhud-receipt-toggle");
      receipt.classList.toggle("khhud-grouped-receipt", !!link);
      receipt.classList.toggle("khhud-gm-receipt", !!link && game.user.isGM);
      if (link) {
        syncReceiptPalette(receipt, source);
        if (!button) receiptToggle(header, expanded.has(doc.id), game.user.isGM, open => {
          setOpen(ledgers.get(anchors.get(receipt)) ?? [receipt], open);
        });
        if (attached.get(receipt) !== source) { attached.set(receipt, source); touched.add(receipt); changedReceipts.add(receipt); }
      } else {
        button?.remove();
        if (attached.delete(receipt)) {
          changedReceipts.add(receipt);
          syncReceiptPalette(receipt);
          if (!game.user.isGM) receipt.dispatchEvent(new Event("khhud-receipt-unlinked"));
          touched.add(receipt);
        }
      }
    }
  }

  function groupFor(id) {
    if (groups.has(id)) return groups.get(id);
    const group = { id, receipts: new Set() };
    // Root visibility changes matter only for the two ends of an actual link.
    group.observer = new MutationObserver(records => {
      // Moving the seam under a roll only changes its bottom margin and corners.
      // Do not force a new computed-style read for each receipt we just positioned.
      if (records.every(record => record.attributeName === "class" &&
        withoutSeam(record.oldValue) === withoutSeam(record.target.className))) return;
      const touched = new Set();
      refresh(group, touched);
      if (touched.size) updateRolls(touched);
      positionLedgers(new Set(), touched);
    });
    groups.set(id, group);
    return group;
  }

  function withoutSeam(classes) {
    return (classes ?? "").split(/\s+/).filter(name => name && name !== "khhud-joined-next").join(" ");
  }

  function update(added, removed, replacements, boundaries = new Set()) {
    const affected = new Set();
    const touched = new Set();
    for (const el of added) boundaries.add(el);
    for (const el of removed) {
      clearAttackPresentation(el);
      el.removeAttribute("data-khhud-roll-follow");
      el.removeAttribute("data-khhud-roll-next");
      history.untrack(el);
      const id = el.dataset.messageId;
      if (!id || byId.get(id) !== el) continue;
      byId.delete(id);
      if (groups.has(id)) affected.add(groups.get(id));
      const group = origin.get(el);
      if (!group) continue;
      group.receipts.delete(el);
      origin.delete(el);
      if (attached.delete(el)) { syncReceiptPalette(el); changedReceipts.add(el); }
      el.classList.remove("khhud-grouped-receipt", "khhud-gm-receipt");
      el.querySelector(":scope > .message-header > .khhud-receipt-toggle")?.remove();
      affected.add(group);
    }
    for (const el of Array.from(added)) {
      history.track(el);
      const id = el.dataset.messageId;
      if (!id || !el.matches(".chat-message")) continue;
      byId.set(id, el);
      const previousRank = ranks.get(replacements.get(el));
      if (previousRank !== undefined) {
        ranks.set(el, previousRank);
        added.delete(el);
        touched.add(el);
      }
      if (groups.has(id)) affected.add(groups.get(id));
      const doc = game.messages.get(id);
      if (!canGroupReceipt(doc)) continue;
      const sourceId = doc.flags?.["khuzoe-hud"]?.sourceMessageId ?? doc.flags?.dnd5e?.originatingMessage;
      if (!sourceId || sourceId === id) continue;
      const group = groupFor(sourceId);
      group.receipts.add(el);
      origin.set(el, group);
      affected.add(group);
    }
    for (const el of removed) if (!byId.has(el.dataset.messageId)) expanded.delete(el.dataset.messageId);
    // Read all visibility states before writing seams, avoiding one style flush
    // per pair when Foundry mounts a whole history page.
    const visibility = new Map();
    for (const group of affected) {
      const source = byId.get(group.id);
      if (!source) continue;
      visibility.set(source, visibleEntry(source));
      for (const receipt of group.receipts) visibility.set(receipt, visibleEntry(receipt));
    }
    for (const group of affected) {
      group.observer.disconnect();
      refresh(group, touched, el => visibility.get(el));
      if (!group.receipts.size) { groups.delete(group.id); continue; }
      const source = byId.get(group.id);
      if (!source) continue;
      const options = { attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-concealed"], attributeOldValue: true };
      group.observer.observe(source, options);
      for (const receipt of group.receipts) group.observer.observe(receipt, options);
    }
    for (const el of touched) boundaries.add(el);
    updateRolls(boundaries);
    positionLedgers(added, touched);
  }

  const observer = new MutationObserver(records => {
    const added = new Set();
    const removed = new Set();
    const replacements = new Map();
    const boundaries = new Set();
    for (const record of records) {
      if (record.removedNodes.length) {
        boundaries.add(record.previousSibling?.nodeType === 3 ? record.previousSibling.previousElementSibling : record.previousSibling);
        boundaries.add(record.nextSibling?.nodeType === 3 ? record.nextSibling.nextElementSibling : record.nextSibling);
      }
      for (const el of record.removedNodes) if (el.nodeType === 1) removed.add(el);
      for (const el of record.addedNodes) if (el.nodeType === 1 && el.parentElement === log) added.add(el);
      if (record.removedNodes.length === 1 && record.addedNodes.length === 1) {
        const [old] = record.removedNodes;
        const [el] = record.addedNodes;
        if (old.dataset?.messageId && old.dataset.messageId === el.dataset?.messageId) {
          replacements.set(el, replacements.get(old) ?? old);
        }
      }
    }
    update(added, removed, replacements, boundaries);
  });
  observer.observe(log, { childList: true });
  update(new Set(log.children), new Set(), new Map());
  log.after(history);
  if (options?.isFirstRender) history.openingScroll = followOpeningChat(log);
}
