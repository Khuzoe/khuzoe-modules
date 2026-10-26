import { MODULE_ID } from "./calendar-math.mjs";

export const CLOCK_SPEEDS = [0.25, 1, 5, 10, 30, 60];
export const REALTIME_TICK_MS = 1000;

// Only a live, explicitly started GM session owns the timer. Never reconstruct
// elapsed time from a persisted wall-clock timestamp after a reload/reconnect.
export class RealtimeClock {
  constructor(controller) {
    this.controller = controller;
    this.sessionId = crypto.randomUUID();
    this.reset();
  }
  get state() { return game.settings.get(MODULE_ID, "realtime") || {}; }
  get speed() { return CLOCK_SPEEDS.includes(this.state.speed) ? this.state.speed : 1; }
  get requested() {
    const c = this.controller, state = this.state;
    return Boolean(this.enabled !== false && state.running && c.linked && state.campaignId === c.context.campaignId
      && (state.driverId !== game.user.id || state.sessionId === this.sessionId)
      && game.users.get(state.driverId)?.active && state.driverId === c.coordinatorId);
  }
  get suspension() {
    const c = this.controller;
    if (this.state.driverId === game.user.id && !c.canControlClock) return "Accesso wiki da verificare";
    if (c.conflict || c.binding.pending || c.binding.incoming) return "Allineamento in corso";
    if (game.paused) return "Pausa Foundry";
    if (game.combat?.started || game.combats?.some(combat => combat.active && combat.started)) return "Combattimento";
    return "";
  }
  get status() {
    if (!this.requested) return "In pausa";
    return this.suspension || `In corso · ×${this.speed}`;
  }
  get ownsTimer() {
    return Boolean(this.started && this.requested && this.controller.leader && this.state.sessionId === this.sessionId);
  }
  reset() { this.lastTick = this.controller.now(); this.fraction = 0; }
  arm() {
    if (this.ownsTimer && this.timer == null) this.timer = this.controller.timers.setInterval(() => this.tick(), REALTIME_TICK_MS);
    if (!this.ownsTimer) { this.controller.timers.clearInterval(this.timer); this.timer = null; }
  }
  changed() { this.reset(); this.arm(); this.controller.emit(); }
  async initialize() {
    this.started = true;
    if (this.controller.leader && this.state.running) await this.set({ running: false });
    this.reset(); this.arm();
  }
  stop() { this.started = false; this.arm(); this.reset(); }
  async set({ running = this.requested, speed = this.speed } = {}) {
    const c = this.controller;
    if (!game.user.isGM) throw new Error("Solo il GM può controllare l'orologio automatico.");
    if (running && this.enabled === false) throw new Error("Usa i comandi manuali del calendario per modificare la data e l'ora.");
    if (!CLOCK_SPEEDS.includes(speed)) throw new Error("Velocità dell'orologio non valida.");
    if (speed !== this.speed && !c.leader) throw new Error("La velocità è gestita dal GM che coordina il calendario.");
    if (running) {
      c.requireLocalClockAccess();
      if (!c.leader) throw new Error("L'avvio e la velocità sono gestiti dal GM che coordina il calendario.");
      if (c.conflict || c.binding.pending || c.binding.incoming) throw new Error("Completa prima l'allineamento del calendario.");
    }
    await game.settings.set(MODULE_ID, "realtime", {
      running: Boolean(running), speed, campaignId: c.context.campaignId,
      driverId: game.user.id, sessionId: this.sessionId
    });
    this.changed();
  }
  tick() {
    const c = this.controller, now = c.now(), elapsed = now - this.lastTick;
    this.lastTick = now;
    const status = this.status;
    if (status !== this.lastStatus) { this.lastStatus = status; c.emit(true); }
    if (!this.ownsTimer || !c.canControlClock || this.suspension || c.busy || this.ticking) {
      this.fraction = 0; return;
    }
    // Sleeping laptops, frozen tabs and wall-clock corrections must not produce
    // an unexpected jump. Ordinary scheduling jitter is accounted for.
    if (elapsed <= 0 || elapsed > 5000) { this.fraction = 0; return; }
    const total = elapsed / 1000 * this.speed + this.fraction;
    const seconds = Math.floor(total);
    this.fraction = total - seconds;
    if (!seconds) return;
    const origin = c.captureContext();
    this.ticking = true;
    return c.serial(async () => {
      c.assertContext(origin);
      if (!this.ownsTimer || !c.canControlClock || this.suspension) return;
      await game.time.advance(seconds, { khuzoeCalendarAutomatic: true });
    }, { quiet: true }).catch(async error => {
      c.error = `Orologio sospeso: ${error.message}`;
      if (this.ownsTimer) await this.set({ running: false }).catch(() => { this.sessionId = crypto.randomUUID(); this.arm(); });
      c.emit();
    }).finally(() => { this.ticking = false; });
  }
}
