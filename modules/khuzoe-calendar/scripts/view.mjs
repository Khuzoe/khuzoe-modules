import { KINDS, VISIBILITIES, esc, dateKey, weekday, formatDate, formatTime, eventsForDate } from "./calendar-math.mjs";
import { compatibilityNotices } from "./native-calendar.mjs";

export const button = (action, label, icon, attrs = "") => `<button type="button" data-action="${action}" ${attrs}>${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i>` : ""}<span>${esc(label)}</span></button>`;
export function renderCalendar(controller, view) {
  const data = controller.data, def = controller.definition, clock = controller.clock;
  const toolbar = `<nav class="kc-tools" aria-label="Strumenti calendario">${button("refresh", "Aggiorna", "fa-rotate")}${button("login", "Account wiki", "fa-user")}${button("wiki", "Apri wiki", "fa-arrow-up-right-from-square")}</nav>`;
  const notice = [controller.error, controller.compatibilityWarning].filter(Boolean).map(message => `<p class="kc-notice" role="status">${esc(message)}</p>`).join("");
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
  const canControl = controller.canControlClock;
  const steps = canControl ? (def.timeSystem.quickSteps || []).map(step => button("advance", `${step.amount > 0 ? "+" : ""}${step.amount} ${ { minute: "min", hour: "h", day: "g" }[step.unit] || step.unit}`, "", `data-unit="${esc(step.unit)}" data-amount="${step.amount}" ${controller.busy || controller.conflict ? "disabled" : ""}`)).join("") : "";
  return `${toolbar}${notice}${compatibilityNotices(def).map(item => `<p class="kc-note">${esc(item.text)}</p>`).join("")}
    <header class="kc-clock"><div><span class="kc-eyebrow">${esc(def.name)}</span><h2>${esc(formatDate(def, clock.date))}</h2><p>${esc(def.weekdays[weekday(def, clock.date)]?.name || "")}</p></div><div class="kc-clock-time"><strong class="kc-current-time">${esc(formatTime(clock.time))}</strong><span>Ora della campagna</span></div></header>
    <div class="kc-clock-actions">${canControl ? button("clock", "Modifica data e ora", "fa-pen", !controller.data || !controller.writable || controller.busy ? "disabled" : "") : ""}${canControl ? `<details class="kc-details" data-expand="timeExpanded" ${view.timeExpanded ? "open" : ""}><summary>Fai passare tempo</summary><p class="kc-note">Modifica l'ora della campagna e le scadenze degli effetti.</p><div class="kc-time-actions">${steps}</div></details>` : ""}</div>
    ${controller.linked ? `<details class="kc-details kc-connection" data-expand="connectionExpanded" ${view.connectionExpanded ? "open" : ""}><summary>Collegato a Foundry · sincronizzazione ogni 15 minuti</summary><p class="kc-note">Le modifiche manuali vengono inviate subito. Gli avanzamenti del gioco vengono raccolti ogni 15 minuti. Usa Aggiorna per allineare subito.</p>${controller.isGM ? button("unlink", "Scollega calendario", "fa-link-slash") : ""}</details>` : `<section class="kc-connection"><div><strong>Stai consultando il calendario della wiki</strong><p class="kc-note">${controller.isGM ? "Collegalo una sola volta per modificare la data anche da Foundry." : "Il GM può collegarlo all'orologio del mondo."}</p></div>${controller.isGM ? button("link", "Collega calendario a Foundry", "fa-link", controller.busy || !controller.writable ? "disabled" : "") : ""}</section>`}
    ${controller.linked && !controller.context.authenticated ? '<p class="kc-note">Accedi alla wiki per vedere gli eventi riservati alla tua campagna.</p>' : ""}
    ${controller.binding.pending && !controller.conflict ? '<p class="kc-notice">Aggiornamento del tempo in attesa di conferma dalla wiki. Verrà ritentato automaticamente.</p>' : ""}
    ${controller.conflict ? `<div class="kc-conflict" role="alert"><p>${esc(controller.conflict)}</p>${controller.isGM ? button("keepWiki", "Mantieni data wiki", "fa-cloud") + button("keepFoundry", "Mantieni data Foundry", "fa-dice-d20") : ""}</div>` : ""}
    <div class="kc-navigation">${button("previous", "", "fa-chevron-left", 'aria-label="Mese precedente"')}<label class="kc-browse-label">Mese<select data-browse-month aria-label="Mese da consultare">${def.months.map(item => `<option value="${esc(item.id)}" ${item.id === month.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label class="kc-browse-label">Anno<input data-browse-year aria-label="Anno da consultare" type="number" required min="-99999999" max="99999999" value="${view.year}"></label>${button("next", "", "fa-chevron-right", 'aria-label="Mese successivo"')}${button("today", "Data attuale", "fa-location-crosshairs")}</div>
    <p class="kc-note">Seleziona un giorno per leggere o aggiungere eventi. Sfogliare il calendario non cambia la data della campagna.</p>
    <div class="kc-layout"><section class="kc-month" aria-label="Mese" style="--kc-weekdays:${def.weekdays.length}"><div class="kc-week">${def.weekdays.map(day => `<span title="${esc(day.name)}">${esc(day.short || day.name)}</span>`).join("")}</div><div class="kc-grid">${days.join("")}</div></section><aside class="kc-agenda"><span class="kc-eyebrow">Agenda</span><h3>${esc(formatDate(def, selected))}</h3>${controller.canNote ? button("new", controller.writable ? "Aggiungi evento" : "Aggiungi nota", "fa-plus", 'class="kc-primary kc-add-event"') : ""}${entries.length ? entries.map(row).join("") : '<p class="kc-empty-day">Nessun evento per questo giorno.</p>'}</aside></div>`;
}

export function dateFields(def, prefix, moment, includeTime = true) {
  const { date, time } = moment;
  return `<div class="kc-date-fields"><label>Giorno<input name="${prefix}Day" type="number" min="1" max="9999" value="${date.day}" required></label><label>Mese<select name="${prefix}Month">${def.months.map(month => `<option value="${esc(month.id)}" ${date.monthId === month.id ? "selected" : ""}>${esc(month.name)}</option>`).join("")}</select></label><label>Anno<input name="${prefix}Year" type="number" min="-99999999" max="99999999" value="${date.year}" required></label></div>${includeTime ? `<div class="kc-time-fields"><label>Ora<input name="${prefix}Hour" type="number" min="0" max="${def.timeSystem.hoursPerDay - 1}" value="${time?.hour ?? 0}" required></label><label>Minuti<input name="${prefix}Minute" type="number" min="0" max="${def.timeSystem.minutesPerHour - 1}" value="${time?.minute ?? 0}" required></label><input name="${prefix}Second" type="hidden" value="${time?.second ?? 0}"></div>` : ""}`;
}

export function renderEventEditor(controller, event) {
  const def = controller.data.calendar.definition;
  const editable = event.revision ? event.canEdit : controller.canNote;
  const select = (name, label, choices, value) => `<label>${label}<select name="${name}">${Object.entries(choices).map(([id, name]) => `<option value="${id}" ${id === value ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>`;
  if (!editable) return `<article class="kc-event-detail"><span class="kc-eyebrow">${esc(KINDS[event.kind])} · ${esc(VISIBILITIES[event.visibility])}</span><h2>${esc(event.title)}</h2><p>${esc(formatDate(def, event.start.date))}${event.allDay ? " · Tutto il giorno" : ` · ${esc(formatTime(event.start.time))}`}${event.end ? ` → ${esc(formatDate(def, event.end.date))}${event.allDay ? "" : ` · ${esc(formatTime(event.end.time))}`}` : ""}</p><div class="kc-description">${esc(event.description)}</div>${event.tags?.length ? `<p>${event.tags.map(esc).join(" · ")}</p>` : ""}</article>`;
  return `<div class="kc-form-error" role="alert" hidden></div><label>Titolo<input name="title" value="${esc(event.title)}" maxlength="240" placeholder="Cosa accade?" required autofocus></label>
    ${select("visibility", "Chi può leggerlo", controller.writable ? VISIBILITIES : { owner: "Personale", players: "Giocatori" }, event.visibility)}
    <p class="kc-note">Personale: tu e i DM. Giocatori: il gruppo. Solo DM: i gestori della campagna.</p>
    <label class="kc-check"><input type="checkbox" name="allDay" ${event.allDay ? "checked" : ""}> Tutto il giorno</label>
    <fieldset class="kc-moment"><legend>Inizio</legend>${dateFields(def, "start", event.start)}</fieldset>
    <label class="kc-check"><input type="checkbox" name="hasEnd" ${event.end ? "checked" : ""}> Aggiungi una fine</label>
    <fieldset class="kc-moment kc-end"><legend>Fine</legend>${dateFields(def, "end", event.end || event.start)}</fieldset>
    <label>Descrizione<textarea name="description" rows="4" maxlength="12000" placeholder="Dettagli, appunti, indizi…">${esc(event.description)}</textarea></label>
    <details class="kc-details"><summary>Altri dettagli</summary>${select("kind", "Tipo", controller.writable ? KINDS : { note: "Nota" }, event.kind)}<div class="kc-form-row">${select("status", "Stato", { scheduled: "In programma", completed: "Completato", cancelled: "Annullato" }, event.status)}<label>Tag, separati da virgola<input name="tags" value="${esc((event.tags || []).join(", "))}"></label></div><p class="kc-note">Tipo e tag servono a organizzare gli eventi. Non inviano avvisi automatici.</p></details>
    <footer class="kc-form-actions">${event.revision ? button("archive", "Archivia", "fa-box-archive") : ""}<button type="submit" class="kc-primary"><i class="fa-solid fa-check"></i> Salva sulla wiki</button></footer>`;
}
