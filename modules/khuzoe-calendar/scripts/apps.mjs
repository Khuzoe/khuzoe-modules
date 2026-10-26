import { MODULE_ID, clone, clockSeconds, esc, dateKey, formatTime } from "./calendar-math.mjs";
import { renderCalendar, renderEventEditor, dateFields } from "./view.mjs";
import { ClockWidget } from "./clock-widget.mjs";

const Base = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
const parts = { content: { template: `modules/${MODULE_ID}/templates/content.hbs` } };
const confirm = (title, content) => foundry.applications.api.DialogV2.confirm({ window: { title }, content });
const report = (error) => ui.notifications.error(error.message || String(error));
let controller;
let calendarApp;
let clockWidget;
export function configureApps(value) { clockWidget?.destroy(); clockWidget = null; controller = value; controller.isOpen = () => calendarApp?.rendered; }
export function openCalendar() {
  calendarApp ||= new CalendarWindow();
  if (calendarApp.rendered) void controller.refresh({ flushClock: false });
  calendarApp.render({ force: true });
  return calendarApp;
}
export function openWiki() {
  try {
    const url = new URL("pages/calendario.html", (controller.context.siteUrl || "https://khuzoe.github.io/sigillo-del-male/").replace(/\/?$/, "/"));
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Indirizzo wiki non valido.");
    url.searchParams.set("campaign", controller.context.campaignId);
    window.open(url.href, "_blank", "noopener,noreferrer");
  } catch (error) { report(error); }
}

export class CalendarWindow extends Base {
  static DEFAULT_OPTIONS = { id: MODULE_ID, classes: ["khuzoe-calendar"], window: { title: "Khuzoe · Calendario", icon: "fa-solid fa-calendar-days", resizable: true }, position: { width: 1000, height: 740 } };
  static PARTS = parts;
  view = {};
  constructor(...args) { super(...args); calendarApp = this; }
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Also covers direct opening from Foundry's module settings menu.
    void controller.refresh({ flushClock: false });
  }
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const clock = controller.clock;
    if (clock && (!this.view.monthId || !controller.definition.months.some(m => m.id === this.view.monthId))) this.view = { year: clock.date.year, monthId: clock.date.monthId, selected: clone(clock.date) };
    if (clock && this.view.selected) { try { clockSeconds(controller.definition, { date: this.view.selected }); } catch (_) { this.view.selected = clone(clock.date); } }
    this.clockDate = clock && dateKey(clock.date);
    return { ...context, content: renderCalendar(controller, this.view) };
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector(".kc-content").addEventListener("click", async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || target.disabled) return;
      try { await this.act(target.dataset); } catch (error) { report(error); }
    });
    this.element.querySelectorAll("details[data-expand]").forEach(panel => panel.addEventListener("toggle", () => { this.view[panel.dataset.expand] = panel.open; }));
    this.element.querySelector('[data-browse-month]')?.addEventListener("change", event => this.browse(event.target.value, this.view.year));
    this.element.querySelector('[data-browse-year]')?.addEventListener("change", event => {
      if (event.target.reportValidity()) this.browse(this.view.monthId, Number(event.target.value));
    });
  }
  browse(monthId, year) {
    if (!controller.definition.months.some(month => month.id === monthId) || !Number.isInteger(year) || Math.abs(year) > 99999999) return;
    this.view = { ...this.view, year, monthId, selected: { year, monthId, day: 1 } };
    this.render();
  }
  async act({ action, day, id, amount, unit }) {
    switch (action) {
      case "refresh": return controller.refresh();
      case "login": await controller.client?.login(); return controller.refresh();
      case "wiki": return openWiki();
      case "previous": case "next": {
        const months = controller.definition.months;
        let year = this.view.year;
        let index = months.findIndex(m => m.id === this.view.monthId) + (action === "next" ? 1 : -1);
        if (index < 0) { index = months.length - 1; year--; }
        else if (index >= months.length) { index = 0; year++; }
        return this.browse(months[index].id, year);
      }
      case "day": this.view.selected = { year: this.view.year, monthId: this.view.monthId, day: Number(day) }; break;
      case "today": this.view = { ...this.view, year: controller.clock.date.year, monthId: controller.clock.date.monthId, selected: clone(controller.clock.date) }; break;
      case "new": new EventWindow({ date: this.view.selected || controller.clock.date }).render({ force: true }); return;
      case "event": {
        const entry = controller.data.calendar.events.find(e => e.id === id);
        if (entry) new EventWindow({ event: entry }).render({ force: true });
        return;
      }
      case "link":
        if (await confirm("Collega il calendario", "<p>La data attuale della wiki diventerà la data di Foundry. Il tempo già trascorso e le scadenze degli effetti resteranno invariati.</p><p>Da questo momento gli avanzamenti saranno condivisi nei due sensi.</p>")) await controller.link();
        return;
      case "unlink":
        if (await confirm("Scollega il calendario", "<p>Foundry tornerà al suo calendario precedente. Il calendario wiki resterà disponibile. Eventuali avanzamenti ancora in attesa non saranno inviati.</p>")) await controller.unlink();
        return;
      case "advance": return controller.advance(Number(amount), unit);
      case "clock": if (controller.linked && controller.writable) new ClockWindow().render({ force: true }); return;
      case "keepWiki": case "keepFoundry": {
        const wiki = action === "keepWiki";
        if (await confirm("Risolvi le date diverse", `<p>${wiki ? "La data della wiki sostituirà quella mostrata in Foundry, senza far trascorrere tempo per gli effetti." : "La data di Foundry sostituirà quella della wiki."}</p>`)) await controller.resolve(wiki ? "wiki" : "foundry");
        return;
      }
    }
    this.render();
  }
}

export class EventWindow extends Base {
  static DEFAULT_OPTIONS = { classes: ["khuzoe-calendar", "kc-editor"], tag: "form", window: { title: "Evento del calendario", icon: "fa-solid fa-calendar-plus", resizable: true }, position: { width: 560, height: "auto" }, form: { handler: EventWindow.submit, closeOnSubmit: false } };
  static PARTS = parts;
  constructor({ event, date }) {
    super();
    this.entry = clone(event || { id: `event-${crypto.randomUUID()}`, revision: 0, title: "", description: "", kind: controller.writable ? "event" : "note", visibility: controller.writable ? "dm" : "owner", status: "scheduled", allDay: true, start: { date: clone(date), time: null }, end: null, tags: [], refs: [] });
    this.definition = clone(controller.data.calendar.definition);
    this.origin = controller.captureContext();
    this.dirty = false;
  }
  async _prepareContext(options) { return { ...await super._prepareContext(options), content: renderEventEditor(controller, this.entry) }; }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.addEventListener("input", () => { this.dirty = true; });
    const toggles = () => {
      for (const prefix of ["start", "end"]) {
        const month = this.definition.months.find(m => m.id === this.element.querySelector(`[name="${prefix}Month"]`)?.value);
        const day = this.element.querySelector(`[name="${prefix}Day"]`);
        if (day && month) day.max = month.days;
      }
      const allDay = this.element.querySelector('[name="allDay"]')?.checked;
      this.element.querySelectorAll(".kc-time-fields").forEach(e => { e.hidden = allDay; e.querySelectorAll("input").forEach(i => { i.disabled = allDay; }); });
      const end = this.element.querySelector(".kc-end");
      if (end) { end.hidden = !this.element.querySelector('[name="hasEnd"]').checked; end.querySelectorAll("input,select").forEach(i => { i.disabled = end.hidden || (allDay && i.closest(".kc-time-fields")); }); }
    };
    this.element.addEventListener("change", toggles); toggles();
    this.element.querySelector('[data-action="archive"]')?.addEventListener("click", async () => {
      if (await confirm("Archivia evento", `<p>Archiviare “${esc(this.entry.title)}”? L'evento resterà nei dati della wiki.</p>`)) {
        try { await controller.archiveEvent(this.entry, this.origin); this.dirty = false; await this.close(); } catch (error) { this.showError(error); }
      }
    });
  }
  showError(error) {
    const node = this.element.querySelector(".kc-form-error");
    if (node) { node.hidden = false; node.textContent = error.status === 409 ? "L'evento è cambiato online. Il tuo testo è ancora qui: confrontalo riaprendo l'evento prima di salvare." : error.message; node.scrollIntoView({ block: "nearest" }); }
    else report(error);
  }
  static async submit(_event, form, formData) {
    if (this.saving) return;
    this.saving = true;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      controller.assertContext(this.origin);
      if (!controller.data) throw new Error("Calendario non disponibile. Il testo è conservato: riprova quando la connessione torna disponibile.");
      if (JSON.stringify(this.definition) !== JSON.stringify(controller.data.calendar.definition)) throw new Error("La struttura del calendario è cambiata. Conserva il testo e riapri l'evento per scegliere una data valida.");
      const values = formData.object;
      const moment = (prefix) => ({ date: { year: Number(values[`${prefix}Year`]), monthId: values[`${prefix}Month`], day: Number(values[`${prefix}Day`]) }, time: values.allDay ? null : { hour: Number(values[`${prefix}Hour`]), minute: Number(values[`${prefix}Minute`]), second: Number(values[`${prefix}Second`] ?? this.entry[prefix]?.time?.second ?? 0) } });
      const entry = { ...this.entry, title: values.title.trim(), description: values.description, kind: values.kind, visibility: values.visibility, allDay: Boolean(values.allDay), status: values.status, tags: values.tags.split(",").map(t => t.trim()).filter(Boolean), start: moment("start"), end: values.hasEnd ? moment("end") : null };
      if (!entry.title) throw new Error("Inserisci un titolo.");
      const start = clockSeconds(this.definition, entry.start);
      if (entry.end && clockSeconds(this.definition, entry.end) < start) throw new Error("La fine non può precedere l'inizio.");
      const signature = JSON.stringify(entry);
      if (this.lastSignature !== signature) { this.operationId = crypto.randomUUID(); this.lastSignature = signature; }
      await controller.saveEvent(entry, this.entry.revision, this.operationId, this.definition.revision, this.origin);
      this.dirty = false; await this.close();
    } catch (error) { this.showError(error); }
    finally { this.saving = false; if (submit.isConnected) submit.disabled = false; }
  }
  async close(options = {}) {
    if (this.saving && this.dirty) return this;
    if (this.dirty && !await confirm("Chiudi senza salvare", "<p>Le modifiche non salvate a questo evento andranno perse.</p>")) return this;
    return super.close(options);
  }
}

class ClockWindow extends Base {
  static DEFAULT_OPTIONS = { classes: ["khuzoe-calendar", "kc-editor"], tag: "form", window: { title: "Imposta data e ora" }, position: { width: 490, height: "auto" }, form: { handler: ClockWindow.submit, closeOnSubmit: true } };
  static PARTS = parts;
  constructor() { super(); this.clock = clone(controller.clock); this.revision = controller.data.calendar.clock.revision; this.definition = clone(controller.definition); this.origin = controller.captureContext(); }
  async _prepareContext(options) { return { ...await super._prepareContext(options), content: `<p class="kc-note">Questa azione fa avanzare o arretrare il tempo di gioco. Influisce sulle normali scadenze degli effetti.</p>${dateFields(this.definition, "clock", this.clock)}<footer class="kc-form-actions"><button type="submit" class="kc-primary">Imposta data</button></footer>` }; }
  async _onRender(context, options) {
    await super._onRender(context, options);
    const adjust = () => { const month = this.definition.months.find(m => m.id === this.element.querySelector('[name="clockMonth"]').value); this.element.querySelector('[name="clockDay"]').max = month.days; };
    this.element.querySelector('[name="clockMonth"]').addEventListener("change", adjust); adjust();
  }
  static async submit(_event, _form, data) {
    const v = data.object;
    controller.assertContext(this.origin);
    if (JSON.stringify(this.definition) !== JSON.stringify(controller.definition)) throw new Error("La struttura del calendario è cambiata. Riapri la finestra.");
    await controller.setClock({ date: { year: Number(v.clockYear), monthId: v.clockMonth, day: Number(v.clockDay) }, time: { hour: Number(v.clockHour), minute: Number(v.clockMinute), second: Number(v.clockSecond ?? this.clock.time?.second ?? 0) } }, this.revision, this.origin);
  }
}

export function updateViews(clockOnly = false) {
  if (calendarApp?.rendered) {
    if (!clockOnly || !controller.clock || calendarApp.clockDate !== dateKey(controller.clock.date)) calendarApp.render();
    else {
      const time = calendarApp.element.querySelector(".kc-current-time");
      if (time) time.textContent = formatTime(controller.clock.time);
    }
  }
  clockWidget ||= new ClockWidget(controller, {
    open: openCalendar, report,
    readPosition: () => game.settings.get(MODULE_ID, "clockPosition"),
    savePosition: position => game.settings.set(MODULE_ID, "clockPosition", position)
  });
  clockWidget.update(game.settings.get(MODULE_ID, "showClock"));
}
