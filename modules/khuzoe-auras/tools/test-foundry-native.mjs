// Integration checks against the installed Foundry v14 utilities and Handlebars.
// These operate only on in-memory fixtures, never on a world or its Documents.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { AuraStore } from "../scripts/store.js";
import { createDefaultAura } from "../scripts/model.js";
import { buildChatSummary } from "../scripts/chat-summary.js";

const app = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2]) + path.sep)
  : new URL("../../../../App/resources/app/", import.meta.url);
const { diffObject, mergeObject } = await import(new URL("common/utils/helpers.mjs", app));
const operators = await import(new URL("common/data/operators.mjs", app));
const Handlebars = createRequire(new URL("package.json", app))("handlebars");
globalThis.foundry = { data: { operators } };
let flags = { "other-module": { preserve: true }, "khuzoe-auras": {
  otherFlag: { preserve: true },
  auras: Object.fromEntries(["one", "two"].map(id => [id, createDefaultAura({ id })])),
  immunities: { one: ["one-target"], two: ["two-target"] }
} };
const token = {
  getFlag: (scope, key) => flags[scope]?.[key],
  async setFlag(scope, key, value) {
    // Same diff/merge operation as native ObjectField._updateDiff.
    const diff = diffObject(flags, { [scope]: { [key]: value } });
    flags = mergeObject(flags, diff, { applyOperators: true, inplace: false });
  }
};
const remaining = createDefaultAura({ id: "two", name: "Edited", actions: [{ save: { immunityOnSuccess: true } }] });
await AuraStore.setAuras(token, [remaining]);
assert.deepEqual(AuraStore.getAuras(token).map(aura => aura.id), ["two"]);
assert.deepEqual(flags["khuzoe-auras"].immunities, { two: ["two-target"] });
assert.deepEqual(flags["other-module"], { preserve: true });
assert.deepEqual(flags["khuzoe-auras"].otherFlag, { preserve: true });
await AuraStore.setAuras(token, []);
assert.deepEqual(flags["khuzoe-auras"].auras, {});
assert.deepEqual(flags["khuzoe-auras"].immunities, {});

const locale = JSON.parse(await readFile(new URL("../lang/it.json", import.meta.url), "utf8"));
const localize = key => key.split(".").reduce((value, part) => value?.[part], locale) ?? key;
globalThis.game = { i18n: { localize, format: (key, values) => localize(key).replace(/\{(\w+)\}/g, (_m, name) => values[name]) } };
globalThis.CONFIG = { DND5E: { abilities: { wis: { label: "Saggezza" } }, damageTypes: { fire: { label: "fuoco" } } } };
const data = buildChatSummary([{
  status: "applied", sourceId: "source", sourceName: "<img src=x onerror=alert(1)>",
  auraId: "aura", auraName: "Aura ardente", targetName: "Valdor",
  event: "turnStart", triggerSubject: "affected", actionType: "damage", damageType: "fire",
  total: 8, applied: 4, roll: {}, formula: "2d6", save: { ability: "wis", total: 14, dc: 12, success: true },
  effects: [{ name: "Paura", immune: true }]
}]);
const render = Handlebars.compile(await readFile(new URL("../templates/chat-summary.hbs", import.meta.url), "utf8"));
const html = render(data);
assert.ok(html.includes("Portatore:"));
assert.ok(html.includes("Subisce 4 danni da fuoco"));
assert.ok(html.includes("TS Saggezza: 14 · CD 12"));
assert.ok(html.includes("bersaglio immune"));
assert.ok(html.includes("&lt;img"));
assert.ok(!html.includes("<img"));
console.log("Native Foundry flag deletion, immunity pruning, data preservation and escaped chat rendering: passed.");
