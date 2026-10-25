import test from "node:test";
import assert from "node:assert/strict";
import { ClockWidget, clampClockPosition } from "../scripts/clock-widget.mjs";

function fixture() {
  const advances = [], positions = [], errors = [];
  const controller = { isGM: true, linked: true, writable: true, context: { localPullWrites: true }, binding: {}, async advance(amount, unit) { advances.push({ amount, unit }); } };
  const widget = new ClockWidget(controller, { open() {}, readPosition: () => ({}), savePosition: value => positions.push(value), report: error => errors.push(error), document: {}, window: { innerWidth: 1000, innerHeight: 700, removeEventListener() {} } });
  // DOM integration and pointer capture are exercised in widget-preview.mjs.
  widget.update = () => {};
  widget.root = { style: {}, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 254, height: 132 }) };
  let capture = null;
  widget.grip = { focus() {}, setPointerCapture(id) { capture = id; }, hasPointerCapture: id => capture === id, releasePointerCapture() { capture = null; } };
  widget.place({ left: 100, top: 100 });
  const pointer = (x, y, id = 1) => ({ pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  return { widget, controller, advances, positions, errors, pointer };
}

test("all four shortcuts use the existing native calendar command, including negative steps", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await f.widget.advance(i);
  assert.deepEqual(f.advances, [{ amount: -1, unit: "hour" }, { amount: -15, unit: "minute" }, { amount: 15, unit: "minute" }, { amount: 1, unit: "hour" }]);
});

test("readers, unlinked clocks, pull-disabled accounts and unresolved writes cannot advance", async () => {
  for (const override of [{ isGM: false }, { linked: false }, { writable: false }, { context: { localPullWrites: false } }, { conflict: "Conflict" }, { binding: { pending: {} } }, { binding: { incoming: {} } }, { busy: true }]) {
    const f = fixture(); Object.assign(f.controller, override);
    await f.widget.advance(2); assert.equal(f.advances.length, 0);
  }
});

test("repeated clicks during a save do not queue unintended time steps", async () => {
  const f = fixture(); let release;
  f.controller.advance = async (...args) => { f.advances.push(args); await new Promise(resolve => { release = resolve; }); };
  const first = f.widget.advance(2);
  await f.widget.advance(2); await f.widget.advance(3);
  assert.equal(f.advances.length, 1);
  release(); await first; assert.equal(f.widget.advancing, false);
});

test("failed commands restore controls and expose the error", async () => {
  const f = fixture(); f.controller.advance = async () => { throw new Error("Permission changed"); };
  await f.widget.advance(2);
  assert.equal(f.errors[0].message, "Permission changed"); assert.equal(f.widget.advancing, false);
});

test("dragging saves once on release and never changes the calendar", async () => {
  const f = fixture();
  f.widget.startDrag(f.pointer(110, 110));
  f.widget.moveDrag(f.pointer(210, 230));
  f.widget.moveDrag(f.pointer(280, 250));
  assert.equal(f.positions.length, 0);
  f.widget.endDrag(f.pointer(280, 250)); await f.widget.saveQueue;
  assert.deepEqual(f.positions, [{ left: 270, top: 240 }]); assert.equal(f.advances.length, 0);
});

test("cancellation, pointer mismatches and a simple grip click never save a move", async () => {
  const f = fixture();
  f.widget.startDrag(f.pointer(110, 110));
  f.widget.moveDrag(f.pointer(400, 400, 2));
  assert.deepEqual(f.widget.position, { left: 100, top: 100 });
  f.widget.moveDrag(f.pointer(400, 400)); f.widget.endDrag(f.pointer(400, 400), true);
  assert.deepEqual(f.widget.position, { left: 100, top: 100 });
  f.widget.startDrag(f.pointer(110, 110)); f.widget.endDrag(f.pointer(110, 110));
  await f.widget.saveQueue; assert.equal(f.positions.length, 0);
});

test("positions stay reachable after a smaller viewport and keyboard moves persist", async () => {
  assert.deepEqual(clampClockPosition({ left: 1900, top: 1000 }, { width: 254, height: 132 }, { width: 400, height: 300 }), { left: 138, top: 160 });
  assert.deepEqual(clampClockPosition({ left: -100, top: -50 }, { width: 254, height: 132 }, { width: 400, height: 300 }), { left: 8, top: 8 });
  const f = fixture();
  f.widget.onKey({ key: "ArrowRight", shiftKey: true, preventDefault() {}, stopPropagation() {} }); await f.widget.saveQueue;
  assert.deepEqual(f.positions, [{ left: 150, top: 100 }]);
  assert.equal(f.advances.length, 0);
});
