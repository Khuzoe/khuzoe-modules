import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import * as spells from "../scripts/spells-2014.mjs";

const template = JSON.parse(await readFile(new URL("../packData/khuzoe-spells-2014/Shield_KhzShieldSpell01.json", import.meta.url), "utf8")).effects[0];
const core = await readFile(new URL("../../../../App/resources/app/client/documents/active-effect.mjs", import.meta.url), "utf8");
const constants = await readFile(new URL("../../../../App/resources/app/common/constants.mjs", import.meta.url), "utf8");
const dae = await readFile(new URL("../../dae/module/specialDurations.js", import.meta.url), "utf8");
const events = JSON.parse(constants.match(/ACTIVE_EFFECT_EXPIRY_EVENTS = Object\.freeze\((\[[\s\S]*?\])\)/)[1]);
function coreMethod(name, args) {
  const body = core.match(new RegExp(`^  ${name}\\([^\\n]*\\) \\{([\\s\\S]*?)^  \\}`, "m"))?.[1];
  assert.ok(body, `Installed Foundry method ${name} exists`);
  return new Function("CORE_EXPIRY_EVENTS", "_loc", `return function(${args}) {${body}}`)(events, () => "duration");
}
const prepareCombatDuration = coreMethod("_prepareCombatBasedDuration", "duration, context");
const isExpiryEvent = coreMethod("isExpiryEvent", "event, context");
// Run DAE's real legacy migration in both hook orders. Its _preCreate wrapper
// runs before these hooks, so it cannot convert a sourceStart produced here.
const migrationStart = dae.indexOf("export function getDeprecatedSpecialDurMap()");
const migrationEnd = dae.indexOf("// ---- Combat End expiry", migrationStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart);
const migrate = new Function("daeManagesTurnExpiry", "debugEnabled", "warn",
  dae.slice(migrationStart, migrationEnd).replace("export function", "function") + "\nreturn migrateDeprecatedSpecialDurations;")(true, 0, () => {});

globalThis.CONFIG = {time: {turnTime: 0, roundTime: 6}};
globalThis.game = {time: {worldTime: 100}, i18n: {pluralRules: new Intl.PluralRules("en")}};
const caster = {id: "caster", uuid: "Actor.caster", documentName: "Actor", inCombat: true};
function makeEffect(parent = caster) {
  const source = structuredClone(template);
  const combat = game.combat;
  source.start = {time: game.time.worldTime, combat: combat?.id, combatant: combat?.combatant?.id,
    round: combat?.round, turn: combat?.turn};
  return {
    parent, actor: parent, _source: source,
    get flags() { return source.flags; },
    get duration() { return source.duration; },
    get start() { return {...source.start, combat: game.combats.get(source.start.combat)}; },
    updateSource(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const keys = path.split("."), last = keys.pop();
        keys.reduce((target, key) => target[key] ??= {}, source)[last] = structuredClone(value);
      }
    }
  };
}
let cases = 0;
for (const daeFirst of [false, true]) for (let casterTurn = 0; casterTurn < 3; casterTurn++) {
  for (let castTurn = 0; castTurn < 3; castTurn++) {
    const turns = Array.from({length: 3}, (_, turn) => ({id: `c${turn}`, turnNumber: turn, initiative: 20 - turn,
      actor: turn === casterTurn ? caster : {id: `enemy${turn}`}}));
    const combat = {id: "combat", started: true, round: 4, turn: castTurn, turns,
      combatants: new Map(turns.map(c => [c.id, c])),
      get combatant() { return this.turns[this.turn]; },
      getCombatantsByActor(actor) { return this.turns.filter(c => c.actor === actor); }};
    game.combat = combat;
    game.combats = new Map([[combat.id, combat]]);
    const effect = makeEffect();
    if (daeFirst) migrate(effect);
    spells.prepareShieldEffectExpiry(effect);
    if (!daeFirst) migrate(effect);
    assert.equal(effect.duration.expiry, "turnStart", "Shield must use an event actually emitted by Foundry");
    assert.equal(effect.start.combatant, turns[casterTurn].id, "A reaction belongs to the caster's next turn");
    assert.equal(effect.flags.dae.expiryMode, "delete");
    assert.ok(!effect.flags.dae.specialDuration.includes("turnStartSource"));
    assert.equal(prepareCombatDuration.call(effect, {...effect.duration}, {}).remaining, 1);
    for (let elapsed = 1; elapsed <= 3; elapsed++) {
      combat.turn = (castTurn + elapsed) % 3;
      combat.round = 4 + Math.floor((castTurn + elapsed) / 3);
      const duration = prepareCombatDuration.call(effect, {...effect.duration}, {});
      const expires = isExpiryEvent.call(effect, "turnStart", {combat}) && duration.remaining <= 0;
      assert.equal(expires, combat.turn === casterTurn, "Shield survives other turns and ends at the caster's next start");
      assert.equal(isExpiryEvent.call(effect, "turnEnd", {combat}), false);
      if (expires) break;
    }
    cases++;
  }
}

game.combat = null;
game.combats = new Map();
caster.inCombat = false;
const outsideCombat = makeEffect();
spells.prepareShieldEffectExpiry(outsideCombat);
migrate(outsideCombat);
assert.equal(outsideCombat.duration.units, "seconds");
assert.equal(outsideCombat.duration.value, 6);
assert.equal(isExpiryEvent.call(outsideCombat, "updateWorldTime", {}), true);

for (const effect of [makeEffect({documentName: "Item"}), makeEffect()]) {
  if (effect.parent === caster) effect.flags.cat.identifier = "foreign-shield";
  const before = structuredClone(effect._source);
  spells.prepareShieldEffectExpiry(effect);
  assert.deepEqual(effect._source, before, "Other effects and compendium templates stay unchanged");
}
console.log(`Shield expiry: ${cases} native Foundry turn/DAE hook-order cases, real caster, outside combat and scope OK`);
