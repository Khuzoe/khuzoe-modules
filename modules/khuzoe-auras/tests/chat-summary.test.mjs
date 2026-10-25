import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildChatSummary } from "../scripts/chat-summary.js";

const italian = JSON.parse(await readFile(new URL("../lang/it.json", import.meta.url), "utf8"));
function setup(t) {
  const previous = { game: globalThis.game, CONFIG: globalThis.CONFIG };
  t.after(() => Object.assign(globalThis, previous));
  const localize = key => key.split(".").reduce((value, part) => value?.[part], italian) ?? key;
  globalThis.game = { i18n: {
    localize, format: (key, values) => localize(key).replace(/\{(\w+)\}/g, (_match, name) => values[name])
  } };
  globalThis.CONFIG = { DND5E: {
    abilities: { wis: { label: "Saggezza" } }, damageTypes: { fire: { label: "fuoco" } }
  } };
}

const base = { sourceId: "source", sourceName: "Portatore", auraId: "aura", auraName: "Aura ardente",
  targetName: "Valdor", event: "turnStart", triggerSubject: "affected", status: "applied" };

test("chat distinguishes effective damage and healing from rolls, and reports the actual temp HP pool", t => {
  setup(t);
  const { rows } = buildChatSummary([
    { ...base, actionType: "damage", damageType: "fire", applied: 4, total: 8, roll: {},
      save: { ability: "wis", total: 14, dc: 12, success: true } },
    { ...base, actionType: "healing", applied: 2, total: 8, roll: {} },
    { ...base, actionType: "temphp", applied: 3, total: 6, tempAfter: 6 },
    { ...base, actionType: "temphp", applied: 0, total: 2, tempAfter: 6 },
    { ...base, actionType: "damage", applied: 0, total: 8 }
  ]);
  assert.equal(rows[0].outcome, "Subisce 4 danni da fuoco");
  assert.equal(rows[0].rollLabel, "Tiro: 8");
  assert.equal(rows[0].saveLabel, "TS Saggezza: 14 · CD 12");
  assert.equal(rows[0].saveOutcome, "superato");
  assert.equal(rows[1].outcome, "Recupera 2 PF");
  assert.equal(rows[2].outcome, "PF temporanei: 6");
  assert.equal(rows[3].outcome, "Mantiene 6 PF temporanei");
  assert.equal(rows[4].outcome, "Nessun danno effettivo");
});

test("chat groups recipients by source and aura, distinguishing source and affected turns", t => {
  setup(t);
  const summary = buildChatSummary([
    { ...base, actionType: "healing", applied: 1 },
    { ...base, actionType: "healing", targetName: "Secondo", applied: 2 },
    { ...base, actionType: "healing", sourceId: "other", sourceName: "Altro", applied: 2 },
    { ...base, actionType: "healing", triggerSubject: "source", applied: 3 }
  ]);
  assert.equal(summary.groups.length, 3);
  assert.equal(summary.groups[0].rows.length, 2);
  assert.equal(summary.groups[1].sourceName, "Altro");
  assert.notEqual(summary.groups[0].eventLabel, summary.groups[2].eventLabel);
});

test("chat explains every effect outcome instead of hiding immunity, duplicates, and errors", t => {
  setup(t);
  const effects = [
    { name: "A", applied: true }, { name: "B", applied: true, refreshed: true },
    { name: "C", immune: true }, { name: "D", existing: true },
    { name: "E", missing: true }, { name: "F", error: "Write failed" }
  ];
  const snapshot = structuredClone(effects);
  const row = buildChatSummary([{ ...base, actionType: "effect", applied: 2, effects }]).rows[0];
  assert.deepEqual(row.effects.map(effect => effect.label), [
    "applicato", "durata rinnovata", "bersaglio immune", "già attivo", "effetto non trovato", "applicazione fallita"
  ]);
  assert.equal(row.effects[4].failed, true);
  assert.equal(row.effects[5].error, "Write failed");
  assert.deepEqual(effects, snapshot);
});
