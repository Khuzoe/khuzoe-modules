import assert from "node:assert/strict";
import {
  installCatDamageWorkflowGuards,
  setDocumentFlagSafely,
  updateDocumentSafely
} from "../scripts/cat-compat.mjs";

function createHooks() {
  let id = 10;
  const events = {};
  return {
    events,
    on(hook, fn, {once = false} = {}) {
      const entry = {hook, id: id++, fn, once};
      (events[hook] ??= []).push(entry);
      return entry.id;
    },
    off(hook, entryId) {
      const entries = events[hook] ?? [];
      const index = entries.findIndex(entry => entry.id === entryId);
      if (index >= 0) entries.splice(index, 1);
    }
  };
}

const hooks = createHooks();
const logs = [];
const notices = [];

const unrelated = async function unrelatedHook() {
  return "unrelated";
};
const Jt = async function Jt() {
  throw new TypeError("CAT trigger collection failed");
};
const Xt = async function Xt() {
  return "cat-ok";
};

hooks.on("midi-qol.preTargetDamageApplication", unrelated);
hooks.on("midi-qol.preTargetDamageApplication", Jt);
hooks.on("midi-qol.premades.preDamageRollComplete", Xt);

const installed = installCatDamageWorkflowGuards({
  hooks,
  logger: {error: (...args) => logs.push(args)},
  notifications: {warn: message => notices.push(message)},
  isGm: true
});

assert.equal(installed, 2);
assert.equal(hooks.events["midi-qol.preTargetDamageApplication"].length, 2);
assert.equal(hooks.events["midi-qol.preTargetDamageApplication"].some(entry => entry.fn === unrelated), true);

const guardedTarget = hooks.events["midi-qol.preTargetDamageApplication"].find(entry => entry.fn !== unrelated).fn;
assert.equal(await guardedTarget(), undefined);
assert.equal(logs.length, 1);
assert.equal(notices.length, 1);

const guardedRoll = hooks.events["midi-qol.premades.preDamageRollComplete"][0].fn;
assert.equal(await guardedRoll(), "cat-ok");

assert.equal(installCatDamageWorkflowGuards({hooks}), 0, "l'installazione deve essere idempotente");

const directUpdates = [];
globalThis.game = {user: {id: "User.Owner01", isGM: false}};
globalThis.cat = {
  utils: {
    queryUtils: {
      hasPermission: () => true,
      gmUser: () => ({id: "User.GM01", query: () => {}})
    },
    documentUtils: {
      update() { throw new Error("Il fallback CAT non deve essere usato per un documento posseduto"); }
    }
  }
};
const ownedDocument = {
  uuid: "Actor.Owner01",
  async update(updates, options) {
    directUpdates.push({updates, options});
    return this;
  }
};
await updateDocumentSafely(ownedDocument, {name: "Diretto"}, {test: true});
assert.deepEqual(directUpdates, [{updates: {name: "Diretto"}, options: {test: true}}]);

const remoteQueries = [];
const gmUser = {id: "User.GM01", query() {}};
globalThis.cat.utils.queryUtils.hasPermission = () => false;
globalThis.cat.utils.queryUtils.gmUser = () => gmUser;
globalThis.cat.utils.queryUtils.query = async (...args) => {
  remoteQueries.push(args);
  return "Actor.Remote01";
};
globalThis.fromUuid = async uuid => ({uuid});
const remoteDocument = {uuid: "Actor.Remote01", update() { throw new Error("Update locale non autorizzato"); }};
assert.deepEqual(await updateDocumentSafely(remoteDocument, {name: "Remoto"}), {uuid: "Actor.Remote01"});
assert.equal(remoteQueries[0][0], "update");
assert.equal(remoteQueries[0][1], gmUser, "La query remota deve ricevere l'oggetto User, non gmID()");
assert.deepEqual(remoteQueries[0][2].updates, {name: "Remoto"});

await setDocumentFlagSafely(remoteDocument, "khuzoe-automations", "audit.flag", true);
assert.deepEqual(remoteQueries[1][2].updates, {"flags.khuzoe-automations.audit.flag": true});

console.log("CAT damage compatibility guard tests passed.");
