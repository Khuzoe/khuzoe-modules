import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../../../../App/resources/app/common/primitives/_module.mjs';
import DataModel from '../../../../App/resources/app/common/abstract/data.mjs';
import Document from '../../../../App/resources/app/common/abstract/document.mjs';
import * as fields from '../../../../App/resources/app/common/data/fields.mjs';
import * as utils from '../../../../App/resources/app/common/utils/helpers.mjs';
import * as constants from '../../../../App/resources/app/common/constants.mjs';
import * as operators from '../../../../App/resources/app/common/data/operators.mjs';
import * as documents from '../../../../App/resources/app/common/documents/_module.mjs';
import {PrototypeToken} from '../../../../App/resources/app/common/data/data.mjs';
import BasePackage from '../../../../App/resources/app/common/packages/base-package.mjs';

// Actual v14 schema and update pipeline, operating exclusively in memory.
globalThis.CONST = constants;
globalThis.CONFIG = {Token: {movement: {}}, Actor: {}};
globalThis.game = {system: {primaryTokenAttribute: 'attributes.hp'}};
globalThis.foundry = {abstract: {DataModel, Document}, data: {fields}, utils, documents, packages: {BasePackage}};
class MemoryActor extends DataModel {
    static defineSchema() {return {prototypeToken: new fields.EmbeddedDataField(PrototypeToken)};}
}
const transport = value => JSON.parse(JSON.stringify(value), (_key, entry) =>
    entry && entry[operators.OPERATOR_IDENTIFIER] ? operators.reconstructOperator(entry) : entry);
function harness({dropFullLink = false, rejectLink = false} = {}) {
    const hooks = new Map(), warnings = [], writes = [];
    globalThis._del = new operators.ForcedDeletion();
    globalThis._replace = operators.ForcedReplacement.create;
    const environment = {MODULE_ID: 'cripta-wiki-sync', Map, Set, foundry: globalThis.foundry,
        CONST: constants, _del: globalThis._del, _replace: operators.ForcedReplacement.create,
        game: {modules: new Map([['barbrawl', {active: true}]]), scenes: []},
        console: {warn: (...args) => warnings.push(args), debug() {}},
        adjustPrototypeOverrides() {}, extendBarRenderer() {}, extendTokenHud() {}, extendTokenConfig() {}, api: {},
        Hooks: {once() {}, on: (name, callback) => hooks.set(name, callback)}};
    let code = '';
    for (const path of ['../../barbrawl/module/api.js', '../../barbrawl/module/synchronization.js', '../../barbrawl/barbrawl.js', '../scripts/services/managed-actor-sync.js']) {
        code += fs.readFileSync(new URL(path, import.meta.url), 'utf8')
            .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\n';
    }
    const ctx = new Function(...Object.keys(environment), code + '\nreturn {applyManagedActorLinkPrototypeConfiguration, managedActorLinkTokenConfigurationState, prepareManagedActorLinkBarUpdate};')(...Object.values(environment));
    const actor = new MemoryActor({prototypeToken: {actorLink: false, name: 'NPC', randomImg: true, appendNumber: true, prependAdjective: true,
        displayBars: 50, flags: {barbrawl: {resourceBars: {bar1: {id: 'bar1', attribute: 'attributes.hp', ownerVisibility: 50}}}}}});
    const server = new MemoryActor(actor.toObject());
    actor.update = async (requested, suppliedOptions) => {
        const options = {diff: true, recursive: true, ...suppliedOptions};
        let changes = MemoryActor.cleanData(requested, {migrate: true, sanitize: true, partial: true}, {creation: false, model: actor, source: actor._source});
        hooks.get('preUpdateActor')(actor, changes);
        if (rejectLink || (dropFullLink && 'name' in (changes.prototypeToken || {}))) delete changes.prototypeToken.actorLink;
        const diff = actor.updateSource(changes, {clean: true, dryRun: true, fallback: false, recursive: options.recursive});
        if (options.diff && utils.isEmpty(diff)) return actor;
        if (options.diff || options.recursive === false) changes = diff;
        writes.push(transport(changes));
        const serverDiff = server.updateSource(transport(changes), options);
        const result = MemoryActor.cleanData(transport(serverDiff), {copy: false, migrate: false, model: false, partial: true, sanitize: false}, {creation: false, model: actor, source: actor._source});
        actor.updateSource(result, {...options, clean: {copy: false, migrate: false, sanitize: false}});
        return actor;
    };
    return {ctx, actor, server, warnings, writes, hooks};
}
test('reproduces Bar Brawl displayBars resetting to NONE with the old full-model replacement', async () => {
    const h = harness();
    const update = {prototypeToken: h.ctx.prepareManagedActorLinkBarUpdate(h.actor.prototypeToken.toObject())};
    // Actual Bar Brawl behavior: remove an unchanged displayBars from updates.
    h.hooks.get('preUpdateActor')(h.actor, update);
    assert.equal(Object.hasOwn(update.prototypeToken, 'displayBars'), false);
    await h.actor.update(update, {diff: false, recursive: false});
    assert.equal(h.actor.prototypeToken.displayBars, constants.TOKEN_DISPLAY_MODES.NONE);
});
test('real v14 PrototypeToken saves Link Actor Data with a full update', () => {
    const actor = new MemoryActor({prototypeToken: {actorLink: false, name: 'NPC'}});
    const update = {prototypeToken: {...actor.prototypeToken.toObject(), actorLink: true}};
    const diff = actor.updateSource(update, {recursive: false});
    assert.equal(actor.prototypeToken.actorLink, true);
    assert.ok(diff.prototypeToken);
});
test('installed writer persists prototype link through actual cleaning, Bar Brawl and transport', async () => {
    const h = harness();
    const config = h.ctx.managedActorLinkTokenConfigurationState(h.actor.prototypeToken);
    await h.ctx.applyManagedActorLinkPrototypeConfiguration(h.actor, config, true);
    assert.equal(h.actor.prototypeToken.actorLink, true);
    assert.equal(h.server.prototypeToken.actorLink, true);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.actor.prototypeToken.displayBars, 50);
    assert.equal(h.writes.length, 1, 'the confirmation is a no-op when the full update already saved the link');
});
test('a full update that omits link state is followed by a persisted partial link update', async () => {
    const h = harness({dropFullLink: true});
    const config = h.ctx.managedActorLinkTokenConfigurationState(h.actor.prototypeToken);
    const before = transport(config);
    config.name = 'Forma selezionata';
    config.texture.src = 'npc.webp';
    await h.ctx.applyManagedActorLinkPrototypeConfiguration(h.actor, config, true);
    assert.equal(h.actor.prototypeToken.actorLink, true);
    assert.equal(h.server.prototypeToken.actorLink, true);
    assert.equal(h.actor.prototypeToken.name, 'Forma selezionata');
    assert.equal(h.actor.prototypeToken.texture.src, 'npc.webp');
    assert.equal(h.actor.prototypeToken.randomImg, true);
    assert.equal(h.actor.prototypeToken.appendNumber, true);
    assert.equal(h.actor.prototypeToken.prependAdjective, true);
    assert.deepEqual(h.actor.prototypeToken.flags, before.flags);
    assert.equal(Object.hasOwn(h.actor.prototypeToken.flags.barbrawl.resourceBars, 'bar2'), false);
    assert.equal(h.warnings.length, 0);
});
test('rollback restores false using the same persisted partial update path', async () => {
    const h = harness({dropFullLink: true});
    const config = h.ctx.managedActorLinkTokenConfigurationState(h.actor.prototypeToken);
    await h.ctx.applyManagedActorLinkPrototypeConfiguration(h.actor, config, true);
    await h.ctx.applyManagedActorLinkPrototypeConfiguration(h.actor, config, false);
    assert.equal(h.actor.prototypeToken.actorLink, false);
    assert.equal(h.server.prototypeToken.actorLink, false);
    assert.equal(h.actor.prototypeToken.randomImg, true);
    assert.equal(h.actor.prototypeToken.appendNumber, true);
    assert.equal(h.actor.prototypeToken.prependAdjective, true);
    assert.equal(h.warnings.length, 0);
});
test('rejected partial updates stop conversion with an accurate automatic-field diagnostic', async () => {
    const h = harness({rejectLink: true});
    const config = h.ctx.managedActorLinkTokenConfigurationState(h.actor.prototypeToken);
    await assert.rejects(h.ctx.applyManagedActorLinkPrototypeConfiguration(h.actor, config, true), error => {
        assert.equal(error.diagnostics[0].PercorsoTecnico, 'prototypeToken.actorLink');
        assert.equal(error.diagnostics[0].Atteso, 'Si');
        assert.equal(error.diagnostics[0].Ottenuto, 'No');
        assert.match(error.diagnostics[0].Istruzione, /Non modificarlo manualmente/);
        return true;
    });
    assert.equal(h.actor.prototypeToken.actorLink, false);
    assert.equal(h.server.prototypeToken.actorLink, false);
});
