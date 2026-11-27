import test from "node:test";
import assert from "node:assert/strict";

test("the chat follows late roll layout after a click and resumes after scrolling back down", async () => {
  let History;
  globalThis.HTMLElement = class {};
  globalThis.CSS = { supports: () => true };
  globalThis.customElements = { define: (_name, ctor) => { History = ctor; } };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.resize = target => callback([{ target }]); }
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  const { registerChatHistory } = await import("../scripts/receipt-groups.mjs");
  registerChatHistory();

  const log = { children: [] };
  const scroll = Object.assign(new EventTarget(), {
    querySelector: () => log, clientHeight: 300, scrollHeight: 1500, scrollTop: 400,
    toggleAttribute() {}, removeAttribute() {}, scrollTo({ top }) { this.scrollTop = top; }
  });
  const history = new History();
  history.openAtBottom = true;
  history.parentElement = scroll;
  history.connectedCallback();
  const resize = () => history.sizes.resize(log);
  resize();
  assert.equal(scroll.scrollTop, 1200);
  scroll.dispatchEvent(new Event("pointerdown"));
  scroll.dispatchEvent(new Event("focusin"));
  scroll.scrollHeight += 200;
  resize();
  assert.equal(scroll.scrollTop, 1400);

  // The reader scrolls up while a result arrives. Resize may precede scroll.
  scroll.scrollTop = 1050;
  scroll.scrollHeight += 100;
  resize();
  scroll.dispatchEvent(new Event("scroll"));
  assert.equal(scroll.scrollTop, 1050);
  scroll.scrollHeight += 200;
  resize();
  assert.equal(scroll.scrollTop, 1050);

  // The jump-to-bottom button reaches the old end just as a new row appears.
  scroll.scrollTop = 1700;
  scroll.scrollHeight += 100;
  scroll.dispatchEvent(new Event("scroll"));
  resize();
  assert.equal(scroll.scrollTop, 1800);
  history.disconnectedCallback();
});
