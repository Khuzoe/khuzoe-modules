export const MODULE_ID = "khuzoe-calendar";
export const KINDS = { event: "Evento", note: "Nota", holiday: "Ricorrenza", deadline: "Scadenza", mission: "Missione", travel: "Viaggio", session: "Sessione", reminder: "Promemoria" };
export const VISIBILITIES = { public: "Pubblico", players: "Giocatori", dm: "Solo DM", owner: "Personale" };
export const clone = (value) => structuredClone(value);
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
export const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

export function validateDefinition(definition) {
  if (!definition || !Array.isArray(definition.months) || !definition.months.length || !Array.isArray(definition.weekdays) || !definition.weekdays.length) throw new Error("La wiki non ha restituito un calendario valido.");
  const ids = new Set();
  for (const month of definition.months) {
    if (!month.id || ids.has(month.id) || !Number.isInteger(month.days) || month.days < 1 || month.days > 9999) throw new Error("Configurazione dei mesi non valida.");
    ids.add(month.id);
  }
  for (const value of [definition.timeSystem?.hoursPerDay, definition.timeSystem?.minutesPerHour]) if (!Number.isInteger(value) || value < 1 || value > 9999) throw new Error("Durata del giorno non valida.");
  return definition;
}

export function units(definition) {
  const minute = 60;
  const hour = minute * definition.timeSystem.minutesPerHour;
  const day = hour * definition.timeSystem.hoursPerDay;
  const yearDays = definition.months.reduce((sum, month) => sum + month.days, 0);
  return { minute, hour, day, yearDays, year: yearDays * day };
}

export function clockSeconds(definition, clock) {
  validateDefinition(definition);
  const { date } = clock || {};
  const time = clock?.time || {};
  const index = definition.months.findIndex((month) => month.id === date?.monthId);
  if (index < 0 || !Number.isSafeInteger(date?.year) || !Number.isInteger(date?.day) || date.day < 1 || date.day > definition.months[index].days) throw new Error("Data non valida per questo calendario.");
  const u = units(definition);
  const hour = Number(time.hour ?? 0), minute = Number(time.minute ?? 0), second = Number(time.second ?? 0);
  if (![hour, minute, second].every(Number.isInteger) || hour < 0 || hour >= definition.timeSystem.hoursPerDay || minute < 0 || minute >= definition.timeSystem.minutesPerHour || second < 0 || second >= 60) throw new Error("Ora non valida per questo calendario.");
  const days = date.year * u.yearDays + definition.months.slice(0, index).reduce((sum, month) => sum + month.days, 0) + date.day - 1;
  const result = days * u.day + hour * u.hour + minute * 60 + second;
  if (!Number.isSafeInteger(result)) throw new Error("La data supera la precisione temporale supportata.");
  return result;
}

export function secondsClock(definition, seconds) {
  const u = units(definition);
  if (!Number.isSafeInteger(seconds)) throw new Error("Tempo non valido.");
  const year = Math.floor(seconds / u.year);
  let remainder = mod(seconds, u.year);
  let day = Math.floor(remainder / u.day);
  let month = definition.months[0];
  for (const candidate of definition.months) { month = candidate; if (day < candidate.days) break; day -= candidate.days; }
  remainder = mod(remainder, u.day);
  return { date: { year, monthId: month.id, day: day + 1 }, time: { hour: Math.floor(remainder / u.hour), minute: Math.floor(mod(remainder, u.hour) / 60), second: mod(remainder, 60) } };
}

export function shiftDate(definition, date, days) { return secondsClock(definition, clockSeconds(definition, { date }) + days * units(definition).day).date; }
export function dateKey(date) { return `${date.year}/${date.monthId}/${date.day}`; }
export function weekday(definition, date) { return mod(Math.floor(clockSeconds(definition, { date }) / units(definition).day) + (definition.firstWeekdayIndex || 0), definition.weekdays.length); }
export function formatDate(definition, date) { return `${date.day} ${definition.months.find((month) => month.id === date.monthId)?.name || date.monthId} ${date.year}${definition.epochName ? ` ${definition.epochName}` : ""}`; }
export function formatTime(time, seconds = false) { return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}${seconds ? `:${String(time.second ?? 0).padStart(2, "0")}` : ""}`; }
export function eventsForDate(events, definition, date) {
  const start = clockSeconds(definition, { date }), end = start + units(definition).day;
  return events.filter((event) => {
    if (event.status === "archived") return false;
    try {
      const from = clockSeconds(definition, event.allDay ? { date: event.start.date } : event.start);
      const to = event.end ? clockSeconds(definition, event.allDay ? { date: event.end.date } : event.end) : from;
      return from < end && (event.allDay ? to + units(definition).day > start : to === from ? to >= start : to > start);
    } catch (_) { return false; } // A remote definition can change during a conflict.
  }).sort((a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || clockSeconds(definition, a.start) - clockSeconds(definition, b.start) || a.title.localeCompare(b.title, "it"));
}

export function calendarConfig(definition) {
  validateDefinition(definition);
  return {
    name: definition.name, description: definition.epochName || "",
    years: { yearZero: 0, firstWeekday: definition.firstWeekdayIndex || 0, leapYear: null },
    months: { values: definition.months.map((month, index) => ({ name: month.name, abbreviation: month.name.slice(0, 3), ordinal: index + 1, days: month.days, leapDays: null })) },
    days: { values: definition.weekdays.map((day, index) => ({ name: day.name, abbreviation: day.short || day.name.slice(0, 3), ordinal: index + 1 })), daysPerYear: units(definition).yearDays, hoursPerDay: definition.timeSystem.hoursPerDay, minutesPerHour: definition.timeSystem.minutesPerHour, secondsPerMinute: 60 },
    seasons: { values: [] }
  };
}
