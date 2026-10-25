import { calendarConfig, clone, units } from "./calendar-math.mjs";

// Absolute dates use an epoch offset. Elapsed time remains unchanged, so linking
// a calendar never advances core.time or rebases existing ActiveEffects.
export function createCalendarClass(Base, offset = 0) {
  return class KhuzoeCalendarData extends Base {
    static khuzoeCalendar = true;
    timeToComponents(time = 0) {
      const result = super.timeToComponents(time + offset);
      result.dayOfWeek = ((result.dayOfWeek % this.days.values.length) + this.days.values.length) % this.days.values.length;
      return result;
    }
    componentsToTime(components) { return super.componentsToTime(components) - offset; }
    elapsedSeconds(components) { return super.componentsToTime(components); }
    componentsToUnit(components, unit, { roundFn = "ceil" } = {}) {
      if (unit === "second") return this.elapsedSeconds(components);
      const factors = { second: 1, minute: this.days.secondsPerMinute, hour: this.days.secondsPerMinute * this.days.minutesPerHour, day: this.days.secondsPerMinute * this.days.minutesPerHour * this.days.hoursPerDay };
      factors.year = factors.day * this.days.daysPerYear;
      if (!factors[unit] || !["ceil", "floor", "round", "trunc"].includes(roundFn)) throw new Error("Unità temporale non valida.");
      return Math[roundFn](this.elapsedSeconds(components) / factors[unit]);
    }
    add(start, delta) {
      const time = typeof start === "number" ? start : this.componentsToTime(start);
      return this.timeToComponents(time + (typeof delta === "number" ? delta : this.elapsedSeconds(delta)));
    }
    difference(end, start = game.time.worldTime) {
      const from = typeof start === "number" ? start : this.componentsToTime(start);
      const to = typeof end === "number" ? end : this.componentsToTime(end);
      return super.timeToComponents(to - from);
    }
    format(time = game.time.worldTime, formatter = "timestamp", options = {}) {
      // Core passes durations as seconds to formatDuration/formatAgo.
      if (typeof time === "number" && (["duration", "formatDuration", "ago", "formatAgo"].includes(formatter) || formatter === this.constructor.formatDuration || formatter === this.constructor.formatAgo)) return super.format(super.timeToComponents(time), formatter, options);
      return super.format(time, formatter, options);
    }
  };
}

export class NativeCalendarBridge {
  constructor() { this.original = null; this.signature = ""; }
  install(binding) {
    if (!binding?.enabled) return this.restore();
    const signature = JSON.stringify([binding.definition, binding.offset]);
    if (signature === this.signature && CONFIG.time.worldCalendarClass?.khuzoeCalendar) return;
    if (!this.original) this.original = { config: clone(CONFIG.time.worldCalendarConfig), Class: CONFIG.time.worldCalendarClass, advance: game.time.advance };
    CONFIG.time.worldCalendarConfig = calendarConfig(binding.definition);
    CONFIG.time.worldCalendarClass = createCalendarClass(this.original.Class, binding.offset);
    if (!this.advance) {
      const original = this.original.advance;
      this.advance = function(delta, options) {
        return original.call(this, typeof delta === "number" ? delta : this.calendar.elapsedSeconds(delta), options);
      };
      game.time.advance = this.advance;
    }
    game.time.initializeCalendar();
    this.signature = signature;
    Hooks.callAll("khuzoe-calendar.calendarChanged", game.time.calendar);
    globalThis.dnd5e?.ui?.calendar?.render?.();
  }
  restore() {
    if (!this.original) return;
    if (CONFIG.time.worldCalendarClass?.khuzoeCalendar) {
      CONFIG.time.worldCalendarClass = this.original.Class;
      CONFIG.time.worldCalendarConfig = this.original.config;
      game.time.initializeCalendar();
    }
    if (game.time.advance === this.advance) game.time.advance = this.original.advance;
    this.original = null; this.advance = null; this.signature = "";
  }
}

export function compatibilityNotices(definition, modules = game.modules) {
  const active = (id) => modules.get(id)?.active;
  const notices = [];
  for (const id of ["foundryvtt-simple-calendar", "foundryvtt-simple-calendar-reborn", "calendaria", "simple-timekeeping", "seasons-and-stars"]) if (active(id)) notices.push({ blocking: true, text: `${modules.get(id).title || id} è attivo: scegli un solo gestore del calendario prima di collegare l'orologio.` });
  if (units(definition).day !== 86400) {
    const names = ["smalltime", "khuzoe-merchant", "monks-active-tiles", "monks-enhanced-journal"].filter(active).map((id) => modules.get(id).title || id);
    if (names.length) notices.push({ blocking: false, text: `Il giorno ha una durata personalizzata. Verifica le funzioni giornaliere di: ${names.join(", ")}.` });
  }
  return notices;
}
