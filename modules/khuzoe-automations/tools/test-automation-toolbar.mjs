import assert from "node:assert/strict";
import {automationStatus} from "../scripts/automation-toolbar.mjs";
import {RELEASE_VERSION} from "../scripts/release.mjs";

const source = "khuzoe-automations";
const compare = (expected, actual) => expected.localeCompare(actual, undefined, {numeric: true}) > 0;
const isCurrent = (item, automation) => item.flags?.cat?.automation?.source === source
  && !!item.flags.cat.automation.version && !compare(automation.version, item.flags.cat.automation.version);
const getSupportedAutomation = item => item.system?.identifier === "bless" ? {version: RELEASE_VERSION} : null;
const status = items => automationStatus({items}, {getSupportedAutomation, isCurrent});
function item(id, version, provider = source) {
  return {id, type: "spell", name: `Bless ${id}`, system: {identifier: "bless", source: {rules: "2014"}},
    flags: version === undefined ? {} : {cat: {automation: {source: provider, version}}}};
}
assert.equal(status([]).state, "empty");
assert.equal(status([{system: {identifier: "unsupported"}}]).state, "empty");
assert.equal(status([item("a")]).state, "missing");
assert.equal(status([item("a", RELEASE_VERSION, "other")]).state, "missing");
assert.equal(status([item("a", "0.1.0")]).state, "outdated");
assert.equal(status([item("a", "")]).state, "outdated");
assert.equal(status([item("a", RELEASE_VERSION)]).state, "current");
assert.equal(status([item("a", "99.0.0")]).state, "current", "Do not propose a downgrade");
const mixed = status([item("a"), item("b", "0.1.0"), item("c", RELEASE_VERSION)]);
assert.deepEqual([mixed.state, mixed.total, mixed.missing, mixed.outdated, mixed.current], ["missing", 3, 1, 1, 1]);
assert.match(mixed.label, /1 da applicare.*1 da aggiornare.*1 aggiornate/);

// Use the same batch operation called by Medkit and the new sheet shortcut.
globalThis.Hooks = {once() {}, on() {}};
globalThis.game = {user: {isGM: false}, packs: new Map([["khuzoe-automations.KhuzoeSpells2014", {}]])};
const notices = [];
globalThis.ui = {notifications: Object.fromEntries(["warn", "error", "info"].map(type => [type, message => notices.push({type, message})]))};
let confirm = async () => true, confirmations = 0;
globalThis.foundry = {utils: {isNewerVersion: compare}, applications: {api: {DialogV2: {confirm: args => { confirmations++; return confirm(args); }}}}};
globalThis.document = {createElement: () => ({set textContent(value) { this.innerHTML = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }})};
globalThis.fromUuid = async () => ({});
let updates = [], update = async target => { target.flags = {cat: {automation: {source, version: RELEASE_VERSION}}}; };
globalThis.cat = {utils: {automationUtils: {updateItem: async (target, options) => {
  assert.equal(options.source, source); updates.push(target.id); await update(target);
}}}};
const {applyAllKhuzoeAutomations} = await import("../scripts/main.mjs");
const actor = {uuid: "Actor.test", name: "<Bard>", isOwner: false, items: [item("a"), item("b", "0.1.0"), item("c", RELEASE_VERSION)]};
actor.items.get = id => actor.items.find(entry => entry.id === id);
const app = {render() {}};
const button = {disabled: false, innerHTML: "Khuzoe", dataset: {}};
await applyAllKhuzoeAutomations(actor, app, button);
assert.equal(confirmations, 0, "Read-only sheets cannot start an update");
actor.isOwner = true;
confirm = async args => { assert.match(args.content, /&lt;Bard&gt;/); return false; };
await applyAllKhuzoeAutomations(actor, app, button);
assert.deepEqual(updates, [], "Closing the confirmation makes no changes");

let resolveConfirmation;
confirm = () => new Promise(resolve => { resolveConfirmation = resolve; });
const before = confirmations;
const first = applyAllKhuzoeAutomations(actor, app, button);
const duplicate = applyAllKhuzoeAutomations(actor, app, {...button});
assert.equal(confirmations, before + 1, "Sheet and Medkit share one in-flight application per actor");
resolveConfirmation(true);
await Promise.all([first, duplicate]);
assert.deepEqual(updates, ["a", "b"], "Only missing or outdated entries are applied, once each");
assert.equal(status(actor.items).state, "current");
assert.equal(button.disabled, false);

actor.items[0].flags.cat.automation.version = "0.1.0";
update = async () => {}; // CAT returned without updating the item version.
confirm = async () => true;
await applyAllKhuzoeAutomations(actor, app, button);
assert.equal(status(actor.items).state, "outdated");
assert.match(notices.at(-1).message, /1 non riuscite/, "A stale version is not reported as a successful update");

const previousUpdates = updates.length;
confirm = async () => { actor.isOwner = false; return true; };
await applyAllKhuzoeAutomations(actor, app, button);
assert.equal(updates.length, previousUpdates, "Permissions are rechecked after confirmation");
console.log("Automation toolbar: states, mixed coverage, versions, permissions, cancellation, shared application and failed update reporting OK");
