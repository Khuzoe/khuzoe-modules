import { MODULE_ID, clone, clockSeconds, secondsClock, validateDefinition, units } from "./calendar-math.mjs";
import { NativeCalendarBridge, compatibilityNotices } from "./native-calendar.mjs";

export const POLL_MS = 60000, CLOCK_BATCH_MS = 30000, MAX_RETRY_MS = 300000;

export class CalendarController {
  constructor(timers = globalThis, now = () => Date.now()) {
    this.data = null; this.error = ""; this.conflict = ""; this.busy = false;
    this.bridge = new NativeCalendarBridge(); this.queue = Promise.resolve();
    this.timers = timers; this.now = now; this.lastReadAt = -Infinity;
    this.retryAfter = 0; this.failures = 0; this.dirtySince = null;
  }
  get client() { return game.modules.get("cripta-wiki-sync")?.api?.calendar; }
  get context() { return this.client?.getContext() || {}; }
  get binding() { return game.settings.get(MODULE_ID, "binding") || {}; }
  get linked() { return this.binding.enabled && this.binding.campaignId === this.context.campaignId; }
  get leader() {
    const owner = game.users.get(this.binding.ownerId);
    return game.user.isGM && (owner?.active && owner.isGM ? owner.id : game.users.activeGM?.id) === game.user.id;
  }
  get writable() { return Boolean(this.context.remoteWrites && this.data?.permissions?.canEdit); }
  get isGM() { return Boolean(game.user.isGM); }
  get canNote() { return Boolean(this.context.remoteWrites && this.data?.permissions?.canCreateNote); }
  get clock() {
    if (this.linked) return secondsClock(this.binding.definition, Math.floor(game.time.worldTime + this.binding.offset));
    return this.data?.calendar.clock;
  }
  get definition() { return this.linked ? this.binding.definition : this.data?.calendar.definition; }
  emit() { Hooks.callAll(`${MODULE_ID}.change`, this); }
  serial(action) {
    const run = this.queue.then(async () => { this.busy = true; this.emit(); try { return await action(); } finally { this.busy = false; this.emit(); } });
    this.queue = run.catch(() => {});
    return run;
  }
  consume(payload) {
    validateDefinition(payload.calendar.definition);
    clockSeconds(payload.calendar.definition, payload.calendar.clock);
    this.data = payload; this.error = "";
    // Count the interval from the request start: network latency must not make
    // a one-minute interval skip every other tick and become two minutes.
    this.lastReadAt = this.responseStartedAt ?? this.now();
    this.retryAfter = 0; this.failures = 0;
  }
  async request(path = "", body) {
    if (!this.client) throw new Error("Aggiorna Khuzoe Wiki Sync: manca il collegamento al calendario.");
    const campaign = this.context.campaignId;
    const startedAt = this.now();
    const result = await this.client.request(path, body);
    if (this.context.campaignId !== campaign) throw new Error("La campagna è cambiata. Riapri il calendario.");
    this.responseStartedAt = startedAt;
    return result;
  }
  applyBinding() {
    const binding = this.binding;
    if (binding.enabled && binding.campaignId === this.context.campaignId && this.context.localPullWrites) {
      const blocking = compatibilityNotices(binding.definition).find(item => item.blocking);
      if (blocking) { this.error = blocking.text; this.bridge.restore(); }
      else this.bridge.install(binding);
    } else this.bridge.restore();
    this.emit();
  }
  async saveBinding(value) { await game.settings.set(MODULE_ID, "binding", value); this.applyBinding(); }
  async start() {
    this.applyBinding();
    this.wasLeader = Boolean(this.linked && this.leader);
    if (this.wasLeader || this.isOpen?.()) await this.refresh({ flushClock: false });
    this.timers.clearInterval(this.timer);
    this.timer = this.timers.setInterval(() => this.poll(), POLL_MS);
  }
  stop() {
    this.timers.clearInterval(this.timer);
    this.timers.clearTimeout(this.clockTimer);
    this.timers.clearTimeout(this.hintTimer);
  }
  poll() {
    if (!this.leader || (!this.linked && !this.isOpen?.()) || this.now() - this.lastReadAt < POLL_MS) return;
    return this.refresh({ flushClock: false, background: true });
  }
  onUsersChanged() {
    const leader = Boolean(this.linked && this.leader);
    const elected = leader && !this.wasLeader;
    this.wasLeader = leader;
    this.scheduleClock();
    if (elected) void this.refresh({ flushClock: false, background: true });
  }
  onContextChanged() {
    this.data = null; this.lastReadAt = -Infinity; this.retryAfter = 0;
    this.applyBinding(); this.scheduleClock();
    const reload = () => {
      if ((this.linked && this.leader) || this.isOpen?.()) return this.refresh({ flushClock: false });
    };
    // An old-account request may be in flight; read with the new identity after it.
    return this.refreshing ? this.refreshing.then(reload) : reload();
  }
  get localTimeChanged() {
    return this.linked && Math.floor(game.time.worldTime + this.binding.offset) !== this.binding.ackSeconds;
  }
  scheduleClock(immediate = false) {
    if (!this.linked || !this.leader || !this.context.remoteWrites || !this.context.localPullWrites || (this.data && !this.writable) || this.conflict || !this.localTimeChanged) {
      this.timers.clearTimeout(this.clockTimer); this.clockTimer = null; this.dirtySince = null; return;
    }
    this.dirtySince ??= this.now();
    if (this.clockTimer != null && !immediate) return;
    this.timers.clearTimeout(this.clockTimer);
    const due = immediate ? this.now() : Math.max(this.dirtySince + CLOCK_BATCH_MS, this.retryAfter);
    this.clockTimer = this.timers.setTimeout(() => {
      this.clockTimer = null;
      return this.refresh({ flushClock: immediate, background: !immediate });
    }, Math.max(0, due - this.now()));
  }
  announceChange() {
    // Hints contain no events, notes, identities from the wiki or credentials.
    game.socket?.emit(`module.${MODULE_ID}`, { type: "changed", campaignId: this.context.campaignId, senderId: game.user.id });
  }
  onRemoteChanged(message) {
    if (message?.type !== "changed" || message.campaignId !== this.context.campaignId || message.senderId === game.user.id || !game.users.get(message.senderId)?.active) return;
    this.hintPending = true;
    this.scheduleHint();
  }
  scheduleHint() {
    if (!this.hintPending || !this.isOpen?.() || globalThis.document?.hidden || this.hintTimer != null) return;
    this.hintTimer = this.timers.setTimeout(async () => {
      this.hintTimer = null;
      if (!this.hintPending || !this.isOpen?.() || globalThis.document?.hidden) return;
      // A hint received during a GET must trigger a later read, not join the old one.
      if (this.refreshing) { await this.refreshing; this.scheduleHint(); return; }
      this.hintPending = false;
      await this.refresh({ flushClock: false, background: true });
      if (this.error) this.hintPending = true;
      this.scheduleHint();
    }, Math.max(0, this.lastReadAt + 5000 - this.now(), this.retryAfter - this.now()));
  }
  refresh({ flushClock = true, background = false } = {}) {
    if (background && this.now() < this.retryAfter) return Promise.resolve();
    if (this.refreshing) return this.refreshing.then(() => {
      if (flushClock && !this.error && !this.conflict && this.leader && this.localTimeChanged) return this.refresh();
    });
    this.refreshing = this.serial(async () => {
      try {
        const contextKey = JSON.stringify([this.context.campaignId, this.context.authenticated, this.context.identityVersion]);
        if (contextKey !== this.contextKey) { this.data = null; this.contextKey = contextKey; this.applyBinding(); }
        const previous = this.data && JSON.stringify([this.data.calendar.definition, this.data.calendar.events]);
        this.hintPending = false;
        // A lost POST response is retried with its original id and revision.
        const recovered = this.linked && this.leader && this.binding.pending && this.context.remoteWrites && !this.conflict && await this.finishPending();
        if (!recovered) this.consume(await this.request());
        await this.reconcile(flushClock);
        if (this.leader && previous && previous !== JSON.stringify([this.data.calendar.definition, this.data.calendar.events])) this.announceChange();
      } catch (error) {
        this.error = error.message;
        this.retryAfter = this.now() + Math.min(MAX_RETRY_MS, POLL_MS * 2 ** Math.min(this.failures++, 3));
        if ([401, 403].includes(error.status)) this.data = null;
      }
    }).finally(() => { this.refreshing = null; this.scheduleClock(); });
    return this.refreshing;
  }
  requireClockAccess() {
    if (!game.user.isGM || !this.writable) throw new Error("Servono un GM Foundry e un account wiki autorizzato a modificare questa campagna.");
    if (!this.context.localPullWrites) throw new Error("Imposta Wiki Sync in modalità Bidirezionale per collegare l'orologio.");
    const caps = this.data?.capabilities;
    if (!caps?.seconds || !caps.coordinatedWrites || !caps.idempotency) throw new Error("Pubblica l'aggiornamento del Worker calendario prima di collegare l'orologio. La lettura e gli eventi sono già disponibili.");
    const blocking = compatibilityNotices(this.data.calendar.definition).find(item => item.blocking);
    if (blocking) throw new Error(blocking.text);
  }
  link() {
    return this.serial(async () => {
      this.consume(await this.request()); this.requireClockAccess();
      if (this.binding.enabled) throw new Error("Il calendario è già collegato. Usa le opzioni di riallineamento se necessario.");
      if (this.data.source === "default") throw new Error("Configura e salva prima il calendario della campagna sulla wiki.");
      const seconds = clockSeconds(this.data.calendar.definition, this.data.calendar.clock);
      await this.saveBinding({ enabled: true, campaignId: this.context.campaignId, ownerId: game.user.id,
        definition: clone(this.data.calendar.definition), offset: seconds - game.time.worldTime,
        ackSeconds: seconds, ackWorldTime: game.time.worldTime, ackRevision: this.data.calendar.clock.revision });
      this.conflict = "";
    });
  }
  unlink() {
    return this.serial(async () => {
      if (!game.user.isGM) throw new Error("Solo il GM può scollegare il calendario.");
      await this.saveBinding({ enabled: false }); this.conflict = "";
    });
  }
  async reconcile(flushClock = true) {
    if (!this.linked || !this.leader || !this.writable || !this.context.localPullWrites || this.conflict) return;
    this.requireClockAccess();
    let binding = this.binding;
    if (binding.incoming) {
      const { from, to, seconds, revision } = binding.incoming;
      if (game.time.worldTime === from) await game.time.set(to, { khuzoeCalendarRemote: true });
      else if (game.time.worldTime !== to) { this.conflict = "Il tempo è cambiato durante un aggiornamento dalla wiki. Scegli quale data mantenere."; return; }
      await this.saveBinding({ ...binding, ackWorldTime: to, ackSeconds: seconds, ackRevision: revision, incoming: null });
      binding = this.binding;
    }
    const remote = this.data.calendar;
    const remoteSeconds = clockSeconds(remote.definition, remote.clock);
    const localDelta = game.time.worldTime - binding.ackWorldTime;
    if (JSON.stringify(remote.definition) !== JSON.stringify(binding.definition)) {
      if (localDelta || binding.pending) { this.conflict = "La struttura del calendario è cambiata sulla wiki mentre il tempo avanzava in Foundry."; return; }
      // A new definition changes the meaning of dates, not elapsed effect time.
      await this.saveBinding({ ...binding, definition: clone(remote.definition), offset: remoteSeconds - game.time.worldTime,
        ackSeconds: remoteSeconds, ackWorldTime: game.time.worldTime, ackRevision: remote.clock.revision });
      return;
    }
    if (remote.clock.revision !== binding.ackRevision) {
      if (localDelta && remoteSeconds !== binding.ackSeconds) { this.conflict = "La data è cambiata sia in Foundry sia sulla wiki. Scegli quale mantenere."; return; }
      if (!localDelta && remoteSeconds !== binding.ackSeconds) {
        const incoming = { from: game.time.worldTime, to: game.time.worldTime + remoteSeconds - binding.ackSeconds, seconds: remoteSeconds, revision: remote.clock.revision };
        await this.saveBinding({ ...binding, incoming });
        if (game.time.worldTime !== incoming.from) { this.conflict = "Il tempo è cambiato durante l'allineamento. Scegli quale data mantenere."; return; }
        await game.time.set(incoming.to, { khuzoeCalendarRemote: true });
        await this.saveBinding({ ...this.binding, incoming: null, ackWorldTime: incoming.to, ackSeconds: remoteSeconds, ackRevision: remote.clock.revision });
      } else await this.saveBinding({ ...binding, ackRevision: remote.clock.revision });
    }
    if (this.localTimeChanged && (flushClock || (this.dirtySince !== null && this.now() - this.dirtySince >= CLOCK_BATCH_MS))) await this.publishLocal();
  }
  async publishLocal(force = false) {
    const binding = this.binding;
    if (binding.pending) return this.finishPending();
    const worldTime = game.time.worldTime;
    const seconds = Math.floor(worldTime + binding.offset);
    if (!force && seconds === binding.ackSeconds) return;
    const pending = { worldTime, seconds, accountOwnerId: game.user.id, body: { operationId: crypto.randomUUID(),
      expectedRevision: this.data.calendar.clock.revision, clock: secondsClock(binding.definition, seconds) } };
    await this.saveBinding({ ...binding, pending });
    await this.finishPending();
  }
  async finishPending() {
    const binding = this.binding, pending = binding.pending;
    if (!pending) return;
    if (pending.accountOwnerId !== game.user.id) { this.conflict = "Un altro GM ha lasciato un aggiornamento in sospeso. Ricollegati con quel GM oppure scegli quale data mantenere."; return; }
    try {
      const result = await this.request("clock", pending.body);
      this.consume(result);
      if (JSON.stringify(result.calendar.definition) !== JSON.stringify(binding.definition) || clockSeconds(binding.definition, result.calendar.clock) !== pending.seconds) {
        this.conflict = "L'aggiornamento è arrivato alla wiki, ma il calendario è cambiato di nuovo. Scegli quale data mantenere."; return true;
      }
      await this.saveBinding({ ...binding, pending: null, ackSeconds: pending.seconds, ackWorldTime: pending.worldTime, ackRevision: result.calendar.clock.revision });
      this.dirtySince = null;
      this.timers.clearTimeout(this.clockTimer); this.clockTimer = null;
      return true;
    } catch (error) {
      if (error.status === 409) this.conflict = "Il calendario online è stato modificato nel frattempo. Scegli quale data mantenere.";
      throw error;
    }
  }
  onWorldTime(_time, _delta, options = {}) {
    this.emit();
    if (!this.linked || !this.leader || options.khuzoeCalendarRemote) return;
    this.scheduleClock(Boolean(options.khuzoeCalendarImmediate));
  }
  resolve(which) {
    return this.serial(async () => {
      this.consume(await this.request()); this.requireClockAccess();
      const binding = this.binding;
      if (!this.linked) throw new Error("Collega prima il calendario.");
      if (which === "wiki") {
        const seconds = clockSeconds(this.data.calendar.definition, this.data.calendar.clock);
        // Explicit correction: relabel the current instant, never expire effects.
        await this.saveBinding({ ...binding, ownerId: game.user.id, definition: clone(this.data.calendar.definition),
          offset: seconds - game.time.worldTime, ackWorldTime: game.time.worldTime, ackSeconds: seconds,
          ackRevision: this.data.calendar.clock.revision, pending: null, incoming: null });
      } else {
        if (JSON.stringify(binding.definition) !== JSON.stringify(this.data.calendar.definition)) throw new Error("I calendari hanno strutture diverse. Mantieni la data della wiki e poi imposta quella desiderata.");
        await this.saveBinding({ ...binding, ownerId: game.user.id, pending: null, incoming: null });
        await this.publishLocal(true);
      }
      if (!this.binding.pending) { this.conflict = ""; this.error = ""; }
    });
  }
  advance(amount, unit) {
    return this.serial(async () => {
      this.requireClockAccess();
      if (!this.linked || this.conflict || this.binding.pending || this.binding.incoming) throw new Error("Completa prima il collegamento o risolvi l'aggiornamento in sospeso.");
      const factor = units(this.binding.definition)[unit];
      if (!factor || !Number.isSafeInteger(amount * factor)) throw new Error("Avanzamento non valido.");
      await game.time.advance(amount * factor, { khuzoeCalendarImmediate: true });
    }).then(() => this.leader ? this.refresh() : undefined);
  }
  setClock(clock, expectedRevision) {
    return this.serial(async () => {
      this.requireClockAccess();
      if (!this.linked || this.conflict || this.binding.pending || this.binding.incoming) throw new Error("Completa prima l'allineamento dell'orologio.");
      this.consume(await this.request());
      if (this.data.calendar.clock.revision !== expectedRevision) throw new Error("La data è cambiata mentre la modificavi. Riapri l'editor prima di confermare.");
      if (this.binding.ackRevision !== expectedRevision) throw new Error("Attendi l'allineamento con la wiki e riapri la finestra.");
      const target = clockSeconds(this.binding.definition, clock) - this.binding.offset;
      await game.time.set(target, { khuzoeCalendarImmediate: true });
    }).then(() => this.leader ? this.refresh() : undefined);
  }
  saveEvent(event, expectedRevision = 0, operationId = crypto.randomUUID(), expectedDefinitionRevision = this.data.calendar.definition.revision) {
    return this.serial(async () => {
      const result = await this.request("events/upsert", { event, expectedRevision, operationId, expectedDefinitionRevision });
      this.consume(result); this.announceChange(); return result;
    });
  }
  archiveEvent(event) {
    return this.serial(async () => {
      this.consume(await this.request("events/archive", { eventId: event.id, expectedRevision: event.revision, operationId: crypto.randomUUID() }));
      this.announceChange();
    });
  }
}
