const observedLogs = new WeakSet();
const concealed = '[hidden], [aria-hidden="true"], [data-concealed], .secret:not(.revealed), .deleting';
let nextPanelId = 0;

function visibleEntry(element) {
  return element && !element.matches(concealed) && getComputedStyle(element).display !== "none";
}

function syncReceiptPalette(receipt, source) {
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

function receiptToggle(header, expanded, onToggle) {
  const panel = header.parentElement.querySelector(":scope > .message-content");
  panel.id ||= `khhud-receipt-panel-${++nextPanelId}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "khhud-receipt-toggle";
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", String(expanded));
  for (const [tag, cls, label] of [
    ["i", "fa-solid fa-lock"], ["span", "khhud-receipt-title", "HPRecord"],
    ["small", "khhud-receipt-audience", "GMOnly"], ["i", "fa-solid fa-chevron-down"]
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
// context menu and controls. Only the visual position of a GM receipt changes.
export function watchReceiptGroups(_app, root) {
  if (!game.user.isGM) return;
  const log = root.querySelector(".chat-scroll > .chat-log");
  if (!log || observedLogs.has(log)) return;
  observedLogs.add(log);
  const byId = new Map();
  const groups = new Map();
  const origin = new WeakMap();
  const expanded = new Set();
  const attached = new Map();
  const ranks = new WeakMap();
  let first = 0;
  let last = 0;

  function writeOrder(el) {
    const source = attached.get(el);
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
        const source = attached.get(el);
        return source && el.previousElementSibling !== source && attached.get(el.previousElementSibling) !== source;
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
        const group = groups.get(el.dataset.messageId);
        if (group) for (const receipt of group.receipts) if (attached.has(receipt)) writeOrder(receipt);
      }
    }
  }

  function refresh(group, touched, visible = visibleEntry) {
    const source = byId.get(group.id);
    const message = source && game.messages.get(group.id);
    const usable = message?.isContentVisible && !message.flags?.["midi-qol"]?.undoDamage && visible(source)
      && !source.querySelector(".chat-card > .card-header > .summary")?.closest(concealed);
    const joined = [];
    for (const receipt of group.receipts) {
      const doc = game.messages.get(receipt.dataset.messageId);
      const header = receipt.querySelector(":scope > .message-header");
      const link = usable && game.user.isGM && doc?.isContentVisible && doc.whisper?.length
        && doc.whisper.every(id => game.users.get(id)?.isGM) && visible(receipt) && header
        && receipt.querySelector(":scope > .message-content .khhud-results");
      const button = header?.querySelector(":scope > .khhud-receipt-toggle");
      receipt.classList.toggle("khhud-gm-receipt", !!link);
      if (link) {
        joined.push(receipt);
        syncReceiptPalette(receipt, source);
        if (!button) receiptToggle(header, expanded.has(doc.id), open => {
          if (open) expanded.add(doc.id);
          else expanded.delete(doc.id);
        });
        if (attached.get(receipt) !== source) { attached.set(receipt, source); touched.add(receipt); }
      } else {
        button?.remove();
        if (attached.delete(receipt)) {
          syncReceiptPalette(receipt);
          touched.add(receipt);
        }
      }
    }
    joined.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const seams = new Set(joined.length ? [source, ...joined.slice(0, -1)] : []);
    for (const el of group.seams) if (!seams.has(el)) el.classList.remove("khhud-joined-next");
    for (const el of seams) if (!group.seams.has(el)) el.classList.add("khhud-joined-next");
    group.seams = seams;
  }

  function groupFor(id) {
    if (groups.has(id)) return groups.get(id);
    const group = { id, receipts: new Set(), seams: new Set() };
    // Root visibility changes matter only for the two ends of an actual link.
    group.observer = new MutationObserver(() => {
      const touched = new Set();
      refresh(group, touched);
      setPositions(new Set(), touched);
    });
    groups.set(id, group);
    return group;
  }

  function update(added, removed, replacements) {
    const affected = new Set();
    const touched = new Set();
    for (const el of removed) {
      const id = el.dataset.messageId;
      if (!id || byId.get(id) !== el) continue;
      byId.delete(id);
      if (groups.has(id)) affected.add(groups.get(id));
      const group = origin.get(el);
      if (!group) continue;
      group.receipts.delete(el);
      origin.delete(el);
      if (attached.delete(el)) syncReceiptPalette(el);
      el.classList.remove("khhud-gm-receipt");
      el.querySelector(":scope > .message-header > .khhud-receipt-toggle")?.remove();
      affected.add(group);
    }
    for (const el of Array.from(added)) {
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
      if (!doc?.isContentVisible || !doc.whisper?.length) continue;
      const sourceId = doc.flags?.["khuzoe-hud"]?.sourceMessageId;
      const midi = doc.flags?.["midi-qol"];
      if (!sourceId || sourceId === id || !Array.isArray(midi?.undoDamage) || midi.playerDamageCard) continue;
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
      const options = { attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-concealed"] };
      group.observer.observe(source, options);
      for (const receipt of group.receipts) group.observer.observe(receipt, options);
    }
    setPositions(added, touched);
  }

  const observer = new MutationObserver(records => {
    const added = new Set();
    const removed = new Set();
    const replacements = new Map();
    for (const record of records) {
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
    update(added, removed, replacements);
  });
  observer.observe(log, { childList: true });
  update(new Set(log.children), new Set(), new Map());
}
