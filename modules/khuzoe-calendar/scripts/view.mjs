import { KINDS, VISIBILITIES, esc, dateKey, weekday, formatDate, formatTime, eventsForDate } from "./calendar-math.mjs";

export const button = (action, label, icon, attrs = "") => `<button type="button" data-action="${action}" ${attrs}>${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i>` : ""}<span>${esc(label)}</span></button>`;
export function renderCalendar(controller, view) {
  const data = controller.data, def = controller.definition, clock = controller.clock;
  const toolbar = `<nav class="kc-tools" aria-label="Strumenti calendario">${button("refresh", "Aggiorna", "fa-rotate")}${button("login", "Account wiki", "fa-user")}${button("wiki", "Apri wiki", "fa-arrow-up-right-from-square")}</nav>`;
  const notice = controller.error ? `<p class="kc-notice" role="status">${esc(controller.error)}</p>` : "";
  if (!def || !clock) return `${toolbar}${notice}<div class="kc-empty"><i class="fa-regular fa-calendar-days"></i><h2>Il tempo della campagna</h2><p>Collega il tuo account in Wiki Sync per aprire il calendario condiviso.</p></div>`;
  const month = def.months.find(item => item.id === view.monthId) || def.months[0];
  const selected = view.selected || clock.date;
  const events = data?.calendar.events || [];
  const today = dateKey(clock.date), selectedKey = dateKey(selected);
  const leading = weekday(def, { year: view.year, monthId: month.id, day: 1 });
  const days = Array.from({ length: leading }, () => '<div class="kc-day kc-day--blank" aria-hidden="true"></div>');
  for (let day = 1; day <= month.days; day++) {
    const date = { year: view.year, monthId: month.id, day }, key = dateKey(date);
    const entries = eventsForDate(events, def, date);
    days.push(`<button type="button" class="kc-day ${today === key ? "is-today" : ""} ${selectedKey === key ? "is-selected" : ""}" data-action="day" data-day="${day}" aria-pressed="${selectedKey === key}" aria-label="${esc(formatDate(def, date))}, ${entries.length} eventi"><span class="kc-day-number">${day}</span>${entries.slice(0, 2).map(entry => `<span class="kc-day-event" title="${esc(entry.title)}">${esc(entry.title)}</span>`).join("")}${entries.length > 2 ? `<small>+${entries.length - 2} altri</small>` : ""}</button>`);
  }
  const entries = eventsForDate(events, def, selected);
  const row = (entry) => `<button type="button" class="kc-event ${entry.status === "cancelled" ? "is-cancelled" : ""}" data-action="event" data-id="${esc(entry.id)}"><span class="kc-event-type">${esc(KINDS[entry.kind] || "Evento")} · ${esc(VISIBILITIES[entry.visibility])}</span><strong>${esc(entry.title)}</strong><span>${entry.allDay ? "Tutto il giorno" : esc(formatTime(entry.start.time))}${entry.ownerName ? ` · ${esc(entry.ownerName)}` : ""}</span></button>`;
  const canControl = controller.linked && controller.writable && controller.isGM;
  const steps = canControl ? (def.timeSystem.quickSteps || []).map(step => button("advance", `${step.amount > 0 ? "+" : ""}${step.amount} ${ { minute: "min", hour: "h", day: "g" }[step.unit] || step.unit}`, "", `data-unit="${esc(step.unit)}" data-amount="${step.amount}" ${controller.busy || controller.conflict ? "disabled" : ""}`)).join("") : "";
  return `${toolbar}${notice}
    <header class="kc-clock"><div><span class="kc-eyebrow">${esc(def.name)}</span><h2>${esc(formatDate(def, clock.date))}</h2><p>${esc(def.weekdays[weekday(def, clock.date)]?.name || "")}</p></div><div class="kc-clock-time">${button("clock", formatTime(clock.time), "", !canControl ? "disabled" : "")}<span>${controller.linked ? "Collegato a Foundry" : "Calendario wiki"}</span></div></header>
    <div class="kc-time-actions">${steps}${controller.isGM ? controller.linked ? button("unlink", "Scollega", "fa-link-slash") : button("link", "Usa come calendario Foundry", "fa-link") : ""}</div>
    ${controller.linked && !controller.context.authenticated ? '<p class="kc-note">Accedi alla wiki per vedere gli eventi riservati alla tua campagna.</p>' : ""}
    ${controller.binding.pending && !controller.conflict ? '<p class="kc-notice">Aggiornamento del tempo in attesa di conferma dalla wiki. Verrà ritentato automaticamente.</p>' : ""}
    ${controller.conflict ? `<div class="kc-conflict" role="alert"><p>${esc(controller.conflict)}</p>${controller.isGM ? button("keepWiki", "Mantieni data wiki", "fa-cloud") + button("keepFoundry", "Mantieni data Foundry", "fa-dice-d20") : ""}</div>` : ""}
    <div class="kc-navigation">${button("previous", "", "fa-chevron-left", 'aria-label="Mese precedente"')}<h3>${esc(month.name)} <span>${view.year}</span></h3>${button("next", "", "fa-chevron-right", 'aria-label="Mese successivo"')}${button("today", "Oggi", "fa-location-crosshairs")}${controller.canNote ? button("new", controller.writable ? "Evento" : "Nota", "fa-plus", 'class="kc-primary"') : ""}</div>
    <div class="kc-layout"><section class="kc-month" aria-label="Mese" style="--kc-weekdays:${def.weekdays.length}"><div class="kc-week">${def.weekdays.map(day => `<span title="${esc(day.name)}">${esc(day.short || day.name)}</span>`).join("")}</div><div class="kc-grid">${days.join("")}</div></section><aside class="kc-agenda"><span class="kc-eyebrow">Agenda</span><h3>${esc(formatDate(def, selected))}</h3>${entries.length ? entries.map(row).join("") : '<p class="kc-empty-day">Nessun evento per questo giorno.</p>'}</aside></div>`;
}

export function dateFields(def, prefix, moment, includeTime = true) {
  const { date, time } = moment;
  return `<div class="kc-date-fields"><label>Giorno<input name="${prefix}Day" type="number" min="1" max="9999" value="${date.day}" required></label><label>Mese<select name="${prefix}Month">${def.months.map(month => `<option value="${esc(month.id)}" ${date.monthId === month.id ? "selected" : ""}>${esc(month.name)}</option>`).join("")}</select></label><label>Anno<input name="${prefix}Year" type="number" min="-99999999" max="99999999" value="${date.year}" required></label></div>${includeTime ? `<div class="kc-time-fields"><label>Ora<input name="${prefix}Hour" type="number" min="0" max="${def.timeSystem.hoursPerDay - 1}" value="${time?.hour ?? 0}" required></label><label>Minuti<input name="${prefix}Minute" type="number" min="0" max="${def.timeSystem.minutesPerHour - 1}" value="${time?.minute ?? 0}" required></label></div>` : ""}`;
}

export function renderEventEditor(controller, event) {
  const def = controller.data.calendar.definition;
  const editable = event.revision ? event.canEdit : controller.canNote;
  const select = (name, label, choices, value) => `<label>${label}<select name="${name}">${Object.entries(choices).map(([id, name]) => `<option value="${id}" ${id === value ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>`;
  if (!editable) return `<article class="kc-event-detail"><span class="kc-eyebrow">${esc(KINDS[event.kind])} · ${esc(VISIBILITIES[event.visibility])}</span><h2>${esc(event.title)}</h2><p>${esc(formatDate(def, event.start.date))}${event.allDay ? " · Tutto il giorno" : ` · ${esc(formatTime(event.start.time))}`}${event.end ? ` → ${esc(formatDate(def, event.end.date))}${event.allDay ? "" : ` · ${esc(formatTime(event.end.time))}`}` : ""}</p><div class="kc-description">${esc(event.description)}</div>${event.tags?.length ? `<p>${event.tags.map(esc).join(" · ")}</p>` : ""}</article>`;
  return `<div class="kc-form-error" role="alert" hidden></div><label>Titolo<input name="title" value="${esc(event.title)}" maxlength="240" placeholder="Cosa accade?" required autofocus></label>
    <div class="kc-form-row">${select("kind", "Tipo", controller.writable ? KINDS : { note: "Nota" }, event.kind)}${select("visibility", "Visibilità", controller.writable ? VISIBILITIES : { owner: "Personale", players: "Giocatori" }, event.visibility)}</div>
    <p class="kc-note">Le note personali sono visibili anche ai gestori della campagna, come sulla wiki.</p>
    <label class="kc-check"><input type="checkbox" name="allDay" ${event.allDay ? "checked" : ""}> Tutto il giorno</label>
    <fieldset class="kc-moment"><legend>Inizio</legend>${dateFields(def, "start", event.start)}</fieldset>
    <label class="kc-check"><input type="checkbox" name="hasEnd" ${event.end ? "checked" : ""}> Aggiungi una fine</label>
    <fieldset class="kc-moment kc-end"><legend>Fine</legend>${dateFields(def, "end", event.end || event.start)}</fieldset>
    <label>Descrizione<textarea name="description" rows="6" maxlength="12000" placeholder="Dettagli, appunti, indizi…">${esc(event.description)}</textarea></label>
    <div class="kc-form-row">${select("status", "Stato", { scheduled: "In programma", completed: "Completato", cancelled: "Annullato" }, event.status)}<label>Tag, separati da virgola<input name="tags" value="${esc((event.tags || []).join(", "))}"></label></div>
    <footer class="kc-form-actions">${event.revision ? button("archive", "Archivia", "fa-box-archive") : ""}<button type="submit" class="kc-primary"><i class="fa-solid fa-check"></i> Salva sulla wiki</button></footer>`;
}
