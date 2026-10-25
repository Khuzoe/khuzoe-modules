import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { patchObjectTokenDocument, patchObjectTokenPlaceable } from "../scripts/ground-loot-integration.js";

const MODULE = "khuzoe-merchant";
const barPath = "CONFIG.Token.documentClass.prototype.getBarAttribute";
const targetPath = "CONFIG.Token.objectClass.prototype.setTarget";
// Use the actual installed Bar Brawl callback, including its argument conversion.
const barBrawlFile = new URL("../../barbrawl/module/rendering.js", import.meta.url);
const barBrawlSource = fs.existsSync(barBrawlFile) ? fs.readFileSync(barBrawlFile, "utf8") : null;
const barBrawlCallback = barBrawlSource?.match(/function \(wrapped, barId, \{ alternative \} = \{\}\) \{[\s\S]*?\n\s*\}, "MIXED"/)?.[0]
  .replace(/, "MIXED"$/, "");
if (barBrawlSource) assert.ok(barBrawlCallback, "Review the integration test if Bar Brawl changes its callback");

function harness() {
  const calls = [], registrations = [], targets = new Map();
  class TokenDocument {
    constructor(kind = null) {
      this.flags = kind ? { [MODULE]: { [kind]: { name: "Loot" } } } : {};
      this.bar1 = { attribute: "attributes.hp" };
      this.result = { value: 17, max: 23, editable: true };
    }
    getFlag(module, key) { return this.flags[module]?.[key]; }
    getBarAttribute(...args) { calls.push({ token: this, args }); if (this.error) throw this.error; return this.result; }
  }
  class Token {
    constructor(document) { this.document = document; }
    setTarget(targeted, options) { calls.push({ token: this, args: [targeted, options] }); this.targeted = targeted; return this; }
  }
  globalThis.CONFIG = { Token: { documentClass: TokenDocument, objectClass: Token } };
  // Model libWrapper's documented ordering and reject the exact direct assignment
  // that caused the original warning. These are in-memory objects, never Foundry.
  globalThis.libWrapper = {
    register(module, path, fn, type) {
      const parts = path.split(".");
      const name = parts.pop();
      const object = parts.reduce((value, part) => value[part], globalThis);
      let target = targets.get(path);
      if (!target) {
        target = { original: object[name], wrappers: [] };
        targets.set(path, target);
        Object.defineProperty(object, name, {
          configurable: true,
          set() { throw new Error("Detected non-libWrapper wrapping"); },
          get() {
            return function (...args) {
              const wrappers = target.wrappers.slice().sort((a, b) => Number(b.type === "WRAPPER") - Number(a.type === "WRAPPER"));
              const invoke = (index, parameters) => {
                const wrapper = wrappers[index];
                if (!wrapper) return target.original.apply(this, parameters);
                let continued = false;
                const result = wrapper.fn.call(this, (...next) => { continued = true; return invoke(index + 1, next); }, ...parameters);
                if (wrapper.type === "WRAPPER") assert.equal(continued, true, "WRAPPER must always continue the chain");
                return result;
              };
              return invoke(0, args);
            };
          }
        });
      }
      assert.ok(!target.wrappers.some(wrapper => wrapper.module === module), "no duplicate module registration");
      const wrapper = { module, path, fn, type };
      target.wrappers.push(wrapper); registrations.push(wrapper);
    }
  };
  const registerBarBrawl = () => libWrapper.register("barbrawl", barPath,
    vm.runInNewContext(`(${barBrawlCallback})`, { getBar: (token, barId) => token[barId] }), "MIXED");
  return { TokenDocument, Token, calls, registrations, registerBarBrawl };
}

for (const order of ["before", "after"]) test(`Merchant composes with actual Bar Brawl callback registered ${order}`, { skip: !barBrawlSource }, () => {
  const h = harness();
  if (order === "before") h.registerBarBrawl();
  patchObjectTokenDocument(h.TokenDocument);
  if (order === "after") h.registerBarBrawl();
  const registration = h.registrations.find(value => value.module === MODULE);
  assert.equal(registration.path, barPath); assert.equal(registration.type, "WRAPPER");
  const creature = new h.TokenDocument();
  assert.equal(creature.getBarAttribute("bar1"), creature.result);
  assert.equal(h.calls[0].token, creature);
  assert.equal(h.calls[0].args[0], null);
  assert.equal(h.calls[0].args[1].alternative, "attributes.hp");
  assert.equal(creature.getBarAttribute(null, { alternative: "resources.secondary" }), creature.result);
  assert.equal(h.calls.at(-1).args[1].alternative, "resources.secondary");
  assert.equal(creature.getBarAttribute("unknown"), null);
  for (const kind of ["groundLoot", "container"]) {
    const loot = new h.TokenDocument(kind), before = JSON.stringify(loot);
    const count = h.calls.length;
    assert.equal(loot.getBarAttribute("bar1"), null);
    assert.equal(h.calls.length, count + 1, "loot also continues the provider chain");
    assert.equal(JSON.stringify(loot), before, "stored token/Actor data are unchanged");
  }
});

test("init/ready/canvasReady calls register each configured method only once", () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    patchObjectTokenDocument(h.TokenDocument);
    patchObjectTokenPlaceable(h.Token);
  }
  assert.equal(h.registrations.filter(value => value.module === MODULE).length, 2);
  assert.equal(new h.TokenDocument().getBarAttribute("bar1").value, 17);
  assert.equal(h.calls.length, 1);
});

test("bar wrapper preserves arguments, exact return value, context and errors", () => {
  const h = harness(); patchObjectTokenDocument(h.TokenDocument);
  const creature = new h.TokenDocument(), options = { alternative: "attributes.hp" };
  assert.equal(creature.getBarAttribute(null, options), creature.result);
  assert.equal(h.calls[0].token, creature); assert.equal(h.calls[0].args[1], options);
  creature.error = new Error("Provider error");
  assert.throws(() => creature.getBarAttribute("bar1"), error => error === creature.error);
});

test("targeting uses MIXED: creatures proceed, loot is blocked, deselection proceeds", () => {
  const h = harness(); patchObjectTokenPlaceable(h.Token);
  assert.equal(h.registrations[0].path, targetPath); assert.equal(h.registrations[0].type, "MIXED");
  const options = { releaseOthers: false };
  const creature = new h.Token(new h.TokenDocument());
  assert.equal(creature.setTarget(true, options), creature);
  assert.equal(h.calls[0].args[1], options);
  for (const kind of ["groundLoot", "container"]) {
    const loot = new h.Token(new h.TokenDocument(kind)), before = h.calls.length;
    assert.equal(loot.setTarget(true, options), undefined);
    assert.equal(h.calls.length, before);
    assert.equal(loot.setTarget(false, options), loot);
    assert.equal(loot.targeted, false);
  }
});

test("optional libWrapper absence keeps the standalone behavior without duplicate patches", () => {
  const h = harness(); delete globalThis.libWrapper;
  patchObjectTokenDocument(h.TokenDocument); patchObjectTokenPlaceable(h.Token);
  const barMethod = h.TokenDocument.prototype.getBarAttribute, targetMethod = h.Token.prototype.setTarget;
  patchObjectTokenDocument(h.TokenDocument); patchObjectTokenPlaceable(h.Token);
  assert.equal(h.TokenDocument.prototype.getBarAttribute, barMethod);
  assert.equal(h.Token.prototype.setTarget, targetMethod);
  assert.equal(new h.TokenDocument().getBarAttribute("bar1").value, 17);
  assert.equal(new h.TokenDocument("groundLoot").getBarAttribute("bar1"), null);
});

test("a failed libWrapper registration never falls back to direct replacement and can be retried", () => {
  const h = harness(), api = globalThis.libWrapper;
  const original = h.TokenDocument.prototype.getBarAttribute;
  globalThis.libWrapper = { register() { throw new Error("Not ready"); } };
  assert.throws(() => patchObjectTokenDocument(h.TokenDocument), /Not ready/);
  assert.equal(h.TokenDocument.prototype.getBarAttribute, original);
  globalThis.libWrapper = api;
  patchObjectTokenDocument(h.TokenDocument);
  assert.equal(h.registrations.length, 1);
});

test("unavailable Token methods can be initialized later", () => {
  const h = harness();
  patchObjectTokenDocument(null); patchObjectTokenPlaceable(undefined);
  assert.equal(h.registrations.length, 0);
  patchObjectTokenDocument(h.TokenDocument);
  assert.equal(h.registrations.length, 1);
});
