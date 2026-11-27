const hidden = '[hidden], [aria-hidden="true"], [data-concealed], .secret-roll, .secret:not(.revealed), [style*="display: none"], [style*="display:none"]';
const visibility = ["class", "style", "hidden", "aria-hidden", "data-concealed"];

function mayShowDie(message, roll) {
  if (!message?.isContentVisible || roll.closest(hidden)) return false;
  if (game.user.isGM || !message.author?.isGM || !game.modules.get("midi-qol")?.active) return true;
  const type = message.flags?.dnd5e?.roll?.type;
  const attack = type === "attack" || roll.closest(".midi-attack-roll, .midi-qol-attack-roll");
  const damage = type === "damage" || roll.matches(".midi-damage-roll, .midi-other-damage-roll, .midi-bonus-damage-roll")
    || roll.closest(".midi-qol-damage-roll, .midi-qol-other-damage-roll, .midi-qol-bonus-damage-roll");
  if (!attack && !damage) return true;
  const settings = globalThis.MidiQOL?.configSettings?.();
  return !!settings && (settings[attack ? "gmAttackDisplay" : "gmDamageDisplay"] ?? "full") === "full";
}

// Only nearby rolls watch Midi for changes. Re-read the current viewer's dice
// when returning to a roll that may have changed while off screen.
let nearChat;
function updateNearbyDice(entries) {
  for (const { target, isIntersecting } of entries) {
    const die = target.querySelector(":scope > khhud-kept-die");
    if (!die?.isConnected) continue;
    if (isIntersecting) die.activate();
    else die.suspend();
  }
}

class KeptDie extends HTMLElement {
  connectedCallback() {
    this.total = this.parentElement;
    this.removeAttribute("data-value");
    this.removeAttribute("data-shape");
    this.removeAttribute("aria-label");
    nearChat.observe(this.total);
  }

  disconnectedCallback() {
    nearChat.unobserve(this.total);
    this.suspend();
  }

  suspend() {
    this.observer?.disconnect();
    this.observer = null;
    this.removeAttribute("data-value");
    this.removeAttribute("data-shape");
    this.removeAttribute("aria-label");
  }

  activate() {
    if (this.observer) return;
    const roll = this.total.closest(".dice-roll");
    if (!roll) return;
    const entry = roll.closest(".chat-message");
    const message = this.message ?? (entry?.dataset.messageId && game.messages.get(entry.dataset.messageId));
    const refresh = () => {
      let best;
      let shape;
      const numericTotal = Array.from(this.total.childNodes).some(child => child.nodeType === Node.TEXT_NODE
        && /^[+−-]?\d+(?:[.,]\d+)?$/.test(child.textContent.trim()));
      if (numericTotal && mayShowDie(message, roll)) {
        // Separate modifiers (e.g. Bless) and extra damage terms stay in the
        // breakdown. Foundry identifies discarded and rerolled faces itself.
        const list = roll.querySelector(".dice-tooltip .dice-rolls:has(> .roll)");
        const tooltip = list?.closest(".dice-tooltip");
        if (list && !list.closest(hidden) && tooltip.style.height !== "0px"
          && tooltip.style.maxHeight !== "0px" && list.checkVisibility({visibilityProperty: true, opacityProperty: true})) {
          for (const die of list.children) {
            if (!die.matches(".roll:not(.discarded, .rerolled)") || die.closest(hidden)) continue;
            const sides = [...die.classList].find(cls => /^d\d+$/.test(cls));
            const value = die.textContent.trim();
            if (!sides || !/^\d+$/.test(value) || !die.checkVisibility({visibilityProperty: true, opacityProperty: true})) continue;
            if (best === undefined || +value < best) { best = +value; shape = sides; }
          }
        }
      }
      if (best === undefined) {
        this.removeAttribute("data-value");
        this.removeAttribute("data-shape");
        this.removeAttribute("aria-label");
      } else if (this.dataset.shape !== shape || this.dataset.value !== String(best)) {
        this.dataset.shape = shape;
        this.dataset.value = best;
        this.setAttribute("role", "img");
        this.setAttribute("aria-label", `${shape} · ${best}`);
      }
    };
    refresh();
    this.observer = new MutationObserver(refresh);
    this.observer.observe(roll, {childList: true, subtree: true, characterData: true, attributeFilter: visibility});
    // Also respect a concealment applied to a containing Midi section.
    for (let parent = roll.parentElement; parent && entry?.contains(parent); parent = parent.parentElement) {
      this.observer.observe(parent, {attributeFilter: visibility});
    }
  }
}

export function registerRollSummary() {
  nearChat = new IntersectionObserver(updateNearbyDice, { rootMargin: "180px", scrollMargin: "180px" });
  customElements.define("khhud-kept-die", KeptDie);
}

export function prepareRollSummary(roll, message) {
  // Older Midi receipts could embed the reason as plain HTML, without an
  // attribution class. Leave formulas, dice and numeric modifiers intact.
  for (const part of roll.querySelectorAll(".dice-tooltip > .tooltip-part:not(.midi-attribution, .constant, :has(.dice, .dice-rolls, .dice-formula))")) {
    if (!part.hidden && /^(ADV|DIS|DISADV|NOADV|NODIS|CRIT|NOCRIT|FUMBLE|NOFUMBLE|VANTAGGIO|SVANTAGGIO)\s*:/i.test(part.textContent.trim())) part.hidden = true;
  }
  const total = roll.querySelector(":scope > .dice-result > .dice-total");
  if (!total || total.querySelector(":scope > khhud-kept-die") || !mayShowDie(message, roll)
    || !roll.querySelector(".dice-tooltip .dice-rolls > .roll")) return;
  const badge = document.createElement("khhud-kept-die");
  badge.message = message;
  total.insertBefore(badge, total.firstElementChild);
}
