import { MODULE_ID, formatDate, formatTime, esc } from "./calendar-math.mjs";

const STEPS = [
  { amount: -1, unit: "hour", label: "−1 h", title: "Indietro di un'ora" },
  { amount: -15, unit: "minute", label: "−15 m", title: "Indietro di 15 minuti" },
  { amount: 15, unit: "minute", label: "+15 m", title: "Avanti di 15 minuti" },
  { amount: 1, unit: "hour", label: "+1 h", title: "Avanti di un'ora" }
];

export function clampClockPosition(position, size, viewport) {
  const edge = 8;
  return {
    left: Math.round(Math.max(edge, Math.min(position.left, Math.max(edge, viewport.width - size.width - edge)))),
    top: Math.round(Math.max(edge, Math.min(position.top, Math.max(edge, viewport.height - size.height - edge))))
  };
}

export class ClockWidget {
  constructor(controller, { open, readPosition, savePosition, report, document = globalThis.document, window = globalThis.window }) {
    this.controller = controller;
    this.open = open; this.readPosition = readPosition; this.savePosition = savePosition; this.report = report;
    this.document = document; this.window = window;
    this.saveQueue = Promise.resolve();
    this.onResize = () => { if (!this.drag) this.place(this.position); };
  }
  get blockedReason() {
    const c = this.controller;
    if (!c.isGM) return "Solo il GM può modificare il tempo.";
    if (!c.linked) return "Apri il calendario e collegalo a Foundry.";
    if (!(c.canControlClock ?? c.writable) || !c.context.localPullWrites) return "Servono un account wiki autorizzato e Wiki Sync in modalità Bidirezionale.";
    if (c.conflict || c.binding.pending || c.binding.incoming) return "Apri il calendario per completare l'allineamento.";
    if (c.busy || this.advancing) return "Aggiornamento in corso…";
    return "";
  }
  get steps() {
    const configured = this.controller.definition?.timeSystem?.quickSteps;
    return configured?.length ? configured.filter(step => ["minute", "hour", "day"].includes(step.unit) && Number.isFinite(step.amount)).map(step => ({
      ...step, label: `${step.amount > 0 ? "+" : ""}${step.amount} ${{ minute: "m", hour: "h", day: "g" }[step.unit]}`,
      title: `${step.amount > 0 ? "+" : ""}${step.amount} ${{ minute: "minuti", hour: "ore", day: "giorni" }[step.unit]}`
    })) : STEPS;
  }
  renderSteps() {
    this.controls.innerHTML = this.steps.map((step, index) => `<button type="button" data-step="${index}" aria-label="${esc(step.title)}">${esc(step.label)}</button>`).join("");
    this.controls.querySelectorAll('[data-step]').forEach(button => button.addEventListener("click", () => this.advance(Number(button.dataset.step))));
    this.stepsSignature = JSON.stringify(this.steps);
  }
  create() {
    const root = this.document.createElement("section");
    root.id = `${MODULE_ID}-clock`;
    root.setAttribute("aria-label", "Orologio della campagna");
    root.innerHTML = `<div class="kc-hud-head">
      <button type="button" class="kc-hud-grip" title="Trascina per spostare. Puoi usare anche le frecce della tastiera." aria-label="Sposta orologio: trascina o usa le frecce della tastiera">
        <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><circle cx="3" cy="4" r="1.5"/><circle cx="9" cy="4" r="1.5"/><circle cx="3" cy="10" r="1.5"/><circle cx="9" cy="10" r="1.5"/><circle cx="3" cy="16" r="1.5"/><circle cx="9" cy="16" r="1.5"/></svg>
      </button>
      <button type="button" class="kc-hud-open" title="Apri calendario" aria-label="Apri calendario">
        <span class="kc-hud-date"></span><span class="kc-hud-time"></span><span class="kc-hud-status"></span>
      </button>
    </div><div class="kc-hud-controls" role="group" aria-label="Avanza o arretra il tempo"></div>`;
    this.root = root;
    this.grip = root.querySelector(".kc-hud-grip");
    this.controls = root.querySelector(".kc-hud-controls");
    this.date = root.querySelector(".kc-hud-date"); this.time = root.querySelector(".kc-hud-time"); this.status = root.querySelector(".kc-hud-status");
    root.querySelector(".kc-hud-open").addEventListener("click", () => this.open());
    this.renderSteps();
    this.grip.addEventListener("pointerdown", event => this.startDrag(event));
    this.grip.addEventListener("pointermove", event => this.moveDrag(event));
    this.grip.addEventListener("pointerup", event => this.endDrag(event));
    this.grip.addEventListener("pointercancel", event => this.endDrag(event, true));
    this.grip.addEventListener("lostpointercapture", event => this.endDrag(event, true));
    this.grip.addEventListener("keydown", event => this.onKey(event));
    this.document.body.append(root);
    this.window.addEventListener("resize", this.onResize);
    const saved = this.readPosition() || {};
    this.position = Number.isFinite(saved.left) && Number.isFinite(saved.top) ? saved : null;
  }
  update(show = true) {
    if (!show) { this.destroy(); return; }
    if (!this.root) this.create();
    const c = this.controller, clock = c.clock, def = c.definition;
    this.date.textContent = clock && def ? formatDate(def, clock.date) : "Calendario della campagna";
    this.date.title = this.date.textContent;
    this.time.textContent = clock && def ? formatTime(clock.time) : c.busy ? "Caricamento…" : !c.context.campaignId ? "Seleziona campagna" : "Data non disponibile";
    this.status.textContent = c.error || c.conflict ? "Da allineare" : c.busy || this.advancing ? "Aggiornamento…" : c.linked ? "Collegato a Foundry" : "Calendario wiki";
    if (!clock && c.error) this.status.textContent = "Apri per vedere il problema";
    this.status.title = c.error || c.conflict || this.status.textContent;
    this.controls.hidden = !c.isGM || !c.linked;
    if (JSON.stringify(this.steps) !== this.stepsSignature) this.renderSteps();
    const reason = this.blockedReason;
    this.root.querySelectorAll("[data-step]").forEach(button => {
      button.disabled = Boolean(reason);
      button.title = reason || this.steps[Number(button.dataset.step)]?.title;
    });
    // Preserve the drag handle and keyboard focus during world-time updates.
    if (!this.drag) this.place(this.position);
  }
  place(position) {
    if (!this.root) return;
    const size = this.root.getBoundingClientRect();
    const viewport = { width: this.window.innerWidth, height: this.window.innerHeight };
    const fallback = { left: viewport.width - size.width - (viewport.width > 800 ? 330 : 18), top: 80 };
    this.position = clampClockPosition(position || fallback, size, viewport);
    this.root.style.left = `${this.position.left}px`;
    this.root.style.top = `${this.position.top}px`;
  }
  startDrag(event) {
    if (event.button !== 0 || event.isPrimary === false || this.drag) return;
    event.preventDefault(); event.stopPropagation();
    this.grip.focus({ preventScroll: true });
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: { ...this.position }, moved: false };
    this.grip.setPointerCapture(event.pointerId);
    this.root.classList.add("is-dragging");
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
    drag.moved = true;
    this.place({ left: drag.start.left + event.clientX - drag.x, top: drag.start.top + event.clientY - drag.y });
  }
  endDrag(event, cancelled = false) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    this.root.classList.remove("is-dragging");
    if (this.grip.hasPointerCapture(drag.pointerId)) this.grip.releasePointerCapture(drag.pointerId);
    if (cancelled) this.place(drag.start);
    else { this.place(this.position); if (drag.moved) this.persist(); }
  }
  onKey(event) {
    if (event.key === "Escape" && this.drag) {
      event.preventDefault(); event.stopPropagation(); this.endDrag({ pointerId: this.drag.pointerId }, true); return;
    }
    const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!vector || this.drag) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    this.place({ left: this.position.left + vector[0] * step, top: this.position.top + vector[1] * step });
    this.persist();
  }
  persist() {
    const position = { ...this.position };
    this.saveQueue = this.saveQueue.then(() => this.savePosition(position)).catch(this.report);
  }
  async advance(index) {
    if (this.blockedReason || !this.steps[index]) return;
    this.advancing = true; this.update();
    try { await this.controller.advance(this.steps[index].amount, this.steps[index].unit); }
    catch (error) { this.report(error); }
    finally { this.advancing = false; if (this.root) this.update(); }
  }
  destroy() {
    this.window.removeEventListener("resize", this.onResize);
    if (this.drag) this.endDrag({ pointerId: this.drag.pointerId }, true);
    this.root?.remove(); this.root = null;
  }
}
