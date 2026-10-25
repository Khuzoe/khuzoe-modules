import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clockSeconds, secondsClock, units, calendarConfig, eventsForDate } from "../scripts/calendar-math.mjs";
import { createCalendarClass, NativeCalendarBridge } from "../scripts/native-calendar.mjs";
import { CalendarController } from "../scripts/controller.mjs";
import { renderCalendar, renderEventEditor } from "../scripts/view.mjs";

const def = { revision: 1, name: "Mondo lungo", epochName: "ER", firstWeekdayIndex: 2,
  months: [{ id: "a", name: "Alba", days: 4 }, { id: "b", name: "Bruma", days: 3 }],
  weekdays: ["Uno", "Due", "Tre"].map(name => ({ name, short: name })), timeSystem: { hoursPerDay: 40, minutesPerHour: 60, quickSteps: [{ unit: "hour", amount: 1 }] } };
const initialClock = { revision: 1, date: { year: 124, monthId: "b", day: 3 }, time: { hour: 39, minute: 59, second: 57 } };

// Exercise the installed v14 calendar implementation without booting Foundry or
// loading any world. Only its data-model constructor/imports are replaced.
const corePath = new URL("../../../../App/resources/app/client/data/calendar.mjs", import.meta.url);
const source = (await readFile(corePath, "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export default class CalendarData extends DataModel", "export default class CalendarData extends DataModel");
const prelude = `const iterateEntries=Object.entries; class DataModel { constructor(data) { Object.assign(this, structuredClone(data)); this.days.daysPerLeapYear=this.days.daysPerYear; } }\n`;
const { default: CoreCalendar } = await import("data:text/javascript;base64," + Buffer.from(prelude + source).toString("base64"));

test("custom 40-hour days, negative years and second rollovers round-trip", () => {
  const start = clockSeconds(def, initialClock);
  assert.deepEqual(secondsClock(def, start + 6), { date: { year: 125, monthId: "a", day: 1 }, time: { hour: 0, minute: 0, second: 3 } });
  for (let time = -units(def).year * 3; time < units(def).year * 3; time += 13771) assert.equal(clockSeconds(def, secondsClock(def, time)), time);
  assert.throws(() => clockSeconds(def, { date: initialClock.date, time: { hour: 40, minute: 0 } }));
});
test("all-day and midnight-ending events have correct overlap", () => {
  const date = { year: 1, monthId: "a", day: 2 };
  const entries = [
    { id: "all", title: "All day", allDay: true, start: { date, time: { hour: 23 } } },
    { id: "previous", title: "Ends at midnight", allDay: false, start: { date: { ...date, day: 1 }, time: { hour: 39 } }, end: { date, time: { hour: 0 } } },
    { id: "instant", title: "Midnight", allDay: false, start: { date, time: { hour: 0 } } }
  ];
  assert.deepEqual(eventsForDate(entries, def, date).map(e => e.id), ["all", "instant"]);
  assert.equal(eventsForDate(entries, def, { ...date, day: 3 }).length, 0);
});
test("native epoch mapping keeps absolute dates and duration calculations separate", () => {
  globalThis.game = { time: { worldTime: 700 } };
  const offset = clockSeconds(def, initialClock) - 700;
  const Native = createCalendarClass(CoreCalendar, offset), calendar = new Native(calendarConfig(def));
  const current = calendar.timeToComponents(700);
  assert.equal(current.year, 124); assert.equal(current.month, 1); assert.equal(current.dayOfMonth, 2);
  assert.equal(calendar.componentsToTime(current), 700);
  assert.equal(calendar.elapsedSeconds({ day: 1 }), 144000);
  assert.equal(calendar.componentsToUnit({ day: 1 }, "hour"), 40);
  assert.equal(calendar.componentsToUnit({ second: 0.5 }, "second"), 0.5);
  assert.equal(calendar.componentsToTime(calendar.add(current, { second: 6 })), 706);
  assert.equal(calendar.difference(706, 700).second, 6);
  assert.equal(calendar.difference(706, 700).year, 0);
  const negative = createCalendarClass(CoreCalendar, -1);
  assert.ok(new negative(calendarConfig(def)).timeToComponents(0).dayOfWeek >= 0);
});

class FakeTimers {
  now = 0; next = 0; jobs = new Map();
  setTimeout(fn, delay) { const id = ++this.next; this.jobs.set(id, { fn, at: this.now + delay }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  setInterval(fn, delay) { const id = this.setTimeout(fn, delay); this.jobs.get(id).interval = delay; return id; }
  clearInterval(id) { this.clearTimeout(id); }
  async advance(ms) {
    const until = this.now + ms;
    let steps = 0;
    for (;;) {
      const entry = [...this.jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      assert.ok(++steps < 1000, "timers must not spin without a delay");
      const [id, job] = entry; this.now = job.at;
      if (job.interval) job.at += job.interval; else this.jobs.delete(id);
      await job.fn();
    }
    this.now = until;
  }
}

function fixture() {
  let binding = { enabled: false };
  let remote = { ok: true, campaignId: "test", source: "kv", version: 1, capabilities: { seconds: true, coordinatedWrites: true, idempotency: true },
    permissions: { canEdit: true, canCreateNote: true }, calendar: { definition: structuredClone(def), clock: structuredClone(initialClock), events: [] } };
  const receipts = new Map(), writes = [], timeWrites = [], reads = [], hints = [];
  const timers = new FakeTimers();
  const context = { campaignId: "test", authenticated: true, localPullWrites: true, remoteWrites: true, identityVersion: 1 };
  let failAfterSave = false, offline = false, readGate;
  let controller;
  globalThis.Hooks = { callAll() {} };
  globalThis.CONFIG = { time: { worldCalendarConfig: calendarConfig(def), worldCalendarClass: CoreCalendar, formatters: {} } };
  const gm = { id: "gm", isGM: true, active: true };
  globalThis.game = { ready: true, user: gm, users: Object.assign(new Map([["gm", gm]]), { activeGM: gm }),
    modules: new Map(), socket: { emit: (...args) => hints.push(args) }, settings: { get: () => structuredClone(binding), set: async (_scope, key, value) => { assert.equal(key, "binding"); binding = structuredClone(value); return value; } },
    time: { worldTime: 700, initializeCalendar() { this.calendar = new CONFIG.time.worldCalendarClass(CONFIG.time.worldCalendarConfig); },
      async set(value, options) { const old = this.worldTime; this.worldTime = typeof value === "number" ? value : this.calendar.componentsToTime(value); timeWrites.push({ value: this.worldTime, options }); controller?.onWorldTime(this.worldTime, this.worldTime - old, options); },
      async advance(delta, options) { return this.set(this.worldTime + (typeof delta === "number" ? delta : this.calendar.componentsToTime(delta)), options); } } };
  game.time.initializeCalendar();
  game.modules.set("cripta-wiki-sync", { api: { calendar: { getContext: () => context, request: async (path = "", body) => {
    if (!path) {
      reads.push(timers.now);
      if (offline) throw new Error("Offline");
      const identity = context.identityVersion;
      const result = structuredClone(remote);
      if (readGate) { const gate = readGate; readGate = null; await gate; }
      if (identity !== context.identityVersion) throw new Error("Account changed during request");
      return result;
    }
    writes.push({ path, body: structuredClone(body) });
    if (path === "events/upsert") { remote.calendar.events.push(structuredClone(body.event)); remote.version++; return structuredClone(remote); }
    assert.equal(path, "clock");
    if (receipts.has(body.operationId)) return { ...structuredClone(remote), replayed: true };
    if (body.expectedRevision !== remote.calendar.clock.revision) throw Object.assign(new Error("Conflict"), { status: 409 });
    remote.calendar.clock = { ...structuredClone(body.clock), revision: remote.calendar.clock.revision + 1 };
    remote.version++; receipts.set(body.operationId, true);
    if (failAfterSave) { failAfterSave = false; throw new Error("Connection lost after commit"); }
    return structuredClone(remote);
  } } } });
  controller = new CalendarController(timers, () => timers.now);
  return { controller, context, writes, timeWrites, remote, reads, hints, timers, get binding() { return binding; }, offline: value => { offline = value; }, gateRead: promise => { readGate = promise; }, loseResponse: () => { failAfterSave = true; }, moveRemote: (delta) => { remote.calendar.clock = { ...secondsClock(def, clockSeconds(def, remote.calendar.clock) + delta), revision: remote.calendar.clock.revision + 1 }; remote.version++; } };
}

test("first link and provider restore never write core time or effects", async () => {
  const f = fixture(); await f.controller.link();
  assert.equal(f.timeWrites.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(game.time.calendar.timeToComponents(700).year, 124);
  await game.time.advance({ second: 6 });
  assert.equal(game.time.worldTime, 706);
  await f.controller.unlink();
  assert.equal(game.time.worldTime, 706); assert.equal(CONFIG.time.worldCalendarClass, CoreCalendar);
});
test("native rounds publish once and remote steps advance native time once", async () => {
  const f = fixture(); await f.controller.link();
  await game.time.advance(6); await f.controller.refresh();
  assert.equal(f.writes.length, 1); assert.equal(f.remote.calendar.clock.time.second, 3);
  await f.controller.refresh(); assert.equal(f.writes.length, 1);
  f.moveRemote(3600); await f.controller.refresh();
  assert.equal(game.time.worldTime, 4306); assert.equal(f.writes.length, 1);
  await f.controller.refresh(); assert.equal(game.time.worldTime, 4306);
});
test("lost POST response retries same id without duplicating elapsed time", async () => {
  const f = fixture(); await f.controller.link();
  await game.time.advance(6); f.loseResponse(); await f.controller.refresh();
  assert.ok(f.binding.pending); const id = f.binding.pending.body.operationId;
  await game.time.advance(6); await f.controller.refresh();
  assert.equal(f.writes[1].body.operationId, id);
  assert.equal(f.binding.pending, null); assert.equal(game.time.worldTime, 712);
  assert.equal(clockSeconds(def, f.remote.calendar.clock), clockSeconds(def, initialClock) + 12);
});
test("simultaneous changes pause; wiki correction preserves elapsed effect time", async () => {
  const f = fixture(); await f.controller.link();
  await game.time.advance(6); f.moveRemote(60); await f.controller.refresh();
  assert.ok(f.controller.conflict); assert.equal(f.writes.length, 0); assert.equal(game.time.worldTime, 706);
  await f.controller.resolve("wiki"); assert.equal(f.controller.conflict, ""); assert.equal(game.time.worldTime, 706);
  assert.equal(clockSeconds(def, f.controller.clock), clockSeconds(def, f.remote.calendar.clock));
});
test("keep Foundry publishes even when its clock equals the previous acknowledgement", async () => {
  const f = fixture(); await f.controller.link();
  f.moveRemote(60); f.controller.conflict = "test";
  await f.controller.resolve("foundry"); await f.controller.refresh();
  assert.equal(game.time.worldTime, 700); assert.equal(clockSeconds(def, f.remote.calendar.clock), clockSeconds(def, initialClock));
});
test("non-leader and wiki readers cannot coordinate writes", async () => {
  const f = fixture(); await f.controller.link();
  game.user = { id: "other", isGM: true };
  await game.time.advance(6); await f.controller.refresh(); assert.equal(f.writes.length, 0);
  game.user = game.users.get("gm"); f.remote.permissions.canEdit = false;
  await f.controller.refresh(); assert.equal(f.writes.length, 0);
  await assert.rejects(f.controller.advance(1, "hour"), /account wiki/);
});
test("changing calendar structure with unsent time stops instead of overwriting", async () => {
  const f = fixture(); await f.controller.link();
  await game.time.advance(6); f.remote.calendar.definition.months[0].days = 5;
  await f.controller.refresh(); assert.ok(f.controller.conflict); assert.equal(f.writes.length, 0);
});
test("older backend blocks native link, while public calendar remains readable", async () => {
  const f = fixture(); f.remote.capabilities = {};
  await f.controller.refresh(); assert.ok(f.controller.data);
  await assert.rejects(f.controller.link(), /Worker/); assert.equal(f.binding.enabled, false);
});
test("event titles/descriptions are escaped, and all-day editor renders", async () => {
  const f = fixture(); await f.controller.refresh();
  const entry = { id: "x", title: '<img src=x onerror="alert(1)">', description: "<script>bad()</script>", canEdit: true, revision: 1, kind: "note", visibility: "owner", allDay: true, start: { date: initialClock.date, time: null }, tags: [] };
  f.controller.data.calendar.events.push(entry);
  const html = renderCalendar(f.controller, { year: initialClock.date.year, monthId: "b", selected: initialClock.date });
  assert.ok(!html.includes("<img")); assert.match(html, /&lt;img/);
  assert.ok(!renderEventEditor(f.controller, entry).includes("<script>"));
});

test("one GM polls once per minute; players do not poll even with their calendar open", async () => {
  const f = fixture(); await f.controller.link(); await f.controller.start();
  f.reads.length = 0;
  await f.timers.advance(4 * 60 * 60 * 1000);
  assert.equal(f.reads.length, 240); assert.equal(f.writes.length, 0);
  game.user = { id: "player", isGM: false, active: true }; game.users.set("player", game.user);
  f.controller.isOpen = () => true;
  f.reads.length = 0;
  await f.timers.advance(4 * 60 * 60 * 1000);
  assert.equal(f.reads.length, 0);
  f.controller.stop();
  const player = new CalendarController(f.timers, () => f.timers.now);
  await player.start(); assert.equal(f.reads.length, 0, "closed player window has no startup GET"); player.stop();
});

test("continuous native ticks batch every 30 seconds without losing second precision", async () => {
  const f = fixture(); await f.controller.link(); await f.controller.start();
  for (let i = 0; i < 60; i++) {
    await game.time.advance(6);
    await f.timers.advance(1000);
    if (i < 29) assert.equal(f.writes.length, 0);
  }
  assert.equal(f.writes.length, 2);
  assert.equal(clockSeconds(def, f.remote.calendar.clock), clockSeconds(def, initialClock) + 360);
  await f.timers.advance(5 * 60000);
  assert.equal(f.writes.length, 2, "idle time does not produce new writes");
  f.controller.stop();
});

test("poll intervals account for request latency without skipping the next minute", async () => {
  const f = fixture(); await f.controller.link();
  await f.timers.advance(60000);
  let release;
  f.gateRead(new Promise(resolve => { release = resolve; }));
  const reading = f.controller.poll();
  await Promise.resolve(); await Promise.resolve();
  await f.timers.advance(200); release(); await reading;
  await f.timers.advance(59800); await f.controller.poll();
  assert.deepEqual(f.reads, [0, 60000, 120000]);
});

test("explicit clock commands and personal notes save immediately, with content-free hints", async () => {
  const f = fixture(); await f.controller.link();
  await f.controller.advance(1, "hour");
  assert.equal(f.writes.length, 1); assert.equal(f.timers.now, 0);
  const event = { id: "private", title: "Secret", visibility: "owner", description: "Hidden" };
  await f.controller.saveEvent(event);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.hints[0], ["module.khuzoe-calendar", { type: "changed", campaignId: "test", senderId: "gm" }]);
  await f.timers.advance(60000); assert.equal(f.writes.length, 2);
});

test("secondary GM clock commands tell the leader to flush immediately", async () => {
  const f = fixture(); await f.controller.link();
  // This hook is what all clients receive after another GM's native time update.
  await game.time.advance(6, { khuzoeCalendarImmediate: true });
  await f.timers.advance(0);
  assert.equal(f.writes.length, 1);
});

test("closed windows ignore hint traffic; open windows coalesce it without losing an in-flight update", async () => {
  const f = fixture(); await f.controller.link();
  game.users.set("player", { id: "player", active: true });
  const hint = { type: "changed", campaignId: "test", senderId: "player" };
  f.controller.isOpen = () => false;
  for (let i = 0; i < 10; i++) f.controller.onRemoteChanged(hint);
  await f.timers.advance(60000); assert.equal(f.reads.length, 1);
  f.controller.isOpen = () => true;
  for (let i = 0; i < 10; i++) f.controller.onRemoteChanged(hint);
  await f.timers.advance(0); assert.equal(f.reads.length, 2);
  let release;
  f.gateRead(new Promise(resolve => { release = resolve; }));
  const refreshing = f.controller.refresh({ flushClock: false });
  await Promise.resolve(); await Promise.resolve();
  f.remote.calendar.events.push({ id: "later", title: "A later event" });
  f.controller.onRemoteChanged(hint);
  release(); await refreshing;
  assert.equal(f.controller.data.calendar.events.length, 0, "in-flight response was captured before the new event");
  await f.timers.advance(5000);
  assert.equal(f.controller.data.calendar.events.length, 1);
  assert.equal(f.reads.length, 4);
});

test("offline retries back off and preserve pending native progress", async () => {
  const f = fixture(); await f.controller.link(); await f.controller.start();
  f.reads.length = 0; f.offline(true);
  await game.time.advance(6);
  await f.timers.advance(29 * 1000); assert.equal(f.reads.length, 0);
  await f.timers.advance(271 * 1000);
  assert.deepEqual(f.reads, [30000, 90000, 210000]);
  assert.equal(f.writes.length, 0);
  f.offline(false);
  await f.controller.refresh();
  assert.equal(f.writes.length, 1);
  assert.equal(clockSeconds(def, f.remote.calendar.clock), clockSeconds(def, initialClock) + 6);
  f.controller.stop();
});

test("permission loss and ordinary user updates cannot trigger polling storms", async () => {
  const f = fixture(); await f.controller.link(); await f.controller.start();
  f.remote.permissions.canEdit = false;
  await game.time.advance(6);
  await f.timers.advance(30000);
  const reads = f.reads.length;
  for (let i = 0; i < 20; i++) f.controller.onUsersChanged();
  await f.timers.advance(30000);
  assert.equal(f.reads.length, reads);
  assert.equal(f.writes.length, 0); f.controller.stop();
});

test("a player retries a failed change notification without enabling polling", async () => {
  const f = fixture(); await f.controller.link();
  game.user = { id: "player", active: true, isGM: false }; game.users.set("player", game.user);
  f.controller.isOpen = () => true;
  f.offline(true);
  f.controller.onRemoteChanged({ type: "changed", campaignId: "test", senderId: "gm" });
  await f.timers.advance(5000);
  assert.equal(f.controller.hintPending, true); assert.equal(f.reads.length, 2);
  f.offline(false); f.remote.calendar.events.push({ id: "reconnected" });
  await f.timers.advance(60000);
  assert.equal(f.controller.data.calendar.events[0].id, "reconnected");
  assert.equal(f.controller.hintPending, false); assert.equal(f.reads.length, 3);
  await f.timers.advance(600000); assert.equal(f.reads.length, 3);
});

test("changing account during a read discards the old response and loads the new one", async () => {
  const f = fixture();
  game.user = { id: "player", active: true, isGM: false }; game.users.set("player", game.user);
  f.controller.isOpen = () => true;
  let release;
  f.gateRead(new Promise(resolve => { release = resolve; }));
  const old = f.controller.refresh({ flushClock: false });
  await Promise.resolve(); await Promise.resolve();
  f.context.identityVersion++;
  f.remote.permissions.canEdit = false;
  const next = f.controller.onContextChanged();
  release(); await old; await next;
  assert.equal(f.reads.length, 2); assert.equal(f.controller.data.permissions.canEdit, false);
  assert.equal(f.controller.error, "");
});

test("a replacement GM can read the calendar while a previous GM's write is unresolved", async () => {
  const f = fixture(); await f.controller.link();
  await game.time.advance(6); f.loseResponse(); await f.controller.refresh();
  assert.ok(f.binding.pending);
  game.users.get("gm").active = false;
  game.user = { id: "replacement", active: true, isGM: true }; game.users.set("replacement", game.user); game.users.activeGM = game.user;
  const replacement = new CalendarController(f.timers, () => f.timers.now);
  await replacement.start();
  assert.ok(replacement.conflict); assert.ok(replacement.data);
  assert.equal(f.writes.length, 1, "a new GM does not silently claim an uncertain write");
  replacement.stop(); f.controller.stop();
});

test("opening from module settings or reopening the window loads once, even for a player", async () => {
  const f = fixture();
  game.user = { id: "player", active: true, isGM: false }; game.users.set("player", game.user);
  // Minimal application lifecycle; controller, view and all opening paths are real.
  class Application {
    rendered = false;
    async _onFirstRender() {}
    async render() { const first = !this.rendered; this.rendered = true; if (first) await this._onFirstRender({}, { isFirstRender: true }); return this; }
  }
  globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: Base => Base } } };
  const apps = await import("../scripts/apps.mjs");
  apps.configureApps(f.controller);
  await f.controller.start(); assert.equal(f.reads.length, 0);
  const window = new apps.CalendarWindow();
  await window.render(); await f.controller.refreshing;
  assert.equal(f.reads.length, 1);
  await window.render(); assert.equal(f.reads.length, 1, "ordinary redraws do not read again");
  window.rendered = false;
  apps.openCalendar();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await f.controller.refreshing;
  assert.equal(f.reads.length, 2);
  f.controller.stop();
});
