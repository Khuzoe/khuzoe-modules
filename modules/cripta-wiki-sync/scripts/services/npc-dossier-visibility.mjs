// Activation-only link: HOVER publishes the dossier; a public dossier enables
// HOVER. Other display modes never publish or change wiki/statblock permissions.
export const NPC_VISIBILITY_SETTING = "npcDossierVisibilitySync";
// Foundry mutates operation options (including parentUuid). Use a fresh copy
// for every write so a scene context cannot leak into the next world Actor.
const INTERNAL = Object.freeze({ criptaWikiSyncCommand: true, criptaNpcDossierVisibility: true });

function changedValue(changes, path) {
  if (Object.hasOwn(changes, path)) return changes[path];
  let value = changes;
  for (const key of path.split(".")) {
    if (!value || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export class NpcDossierVisibilitySync {
  constructor({ game, campaignId, canPush, canPull, isManaged, readState, writeState, request, report, timers = globalThis }) {
    Object.assign(this, { game, campaignId, canPush, canPull, isManaged, readState, writeState, request, report, timers });
    this.queue = Promise.resolve(); this.pendingTimers = new Map(); this.failures = new Map();
  }
  get hover() { return globalThis.CONST?.TOKEN_DISPLAY_MODES?.HOVER ?? 30; }
  identity(actor) {
    const campaignId = this.campaignId(), worldId = this.game.world.id, actorId = actor.id;
    return { campaignId, worldId, actorId, key: `${campaignId}:${worldId}:${actorId}` };
  }
  eligible(actor) { return actor?.type === "npc" && !actor.isToken && !actor.pack && this.game.actors.get(actor.id) === actor && this.isManaged(actor); }
  run(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(error => this.report(error));
    return this.queue;
  }
  onActorUpdate(actor, changes = {}, options, userId) {
    return this.onChange(actor, changedValue(changes, "prototypeToken.displayName"), { kind: "prototype" }, options, userId);
  }
  onTokenUpdate(token, changes = {}, options, userId) {
    return this.onChange(this.game.actors.get(token.actorId), changedValue(changes, "displayName"), { kind: "token", sceneId: token.parent?.id, tokenId: token.id }, options, userId);
  }
  onChange(actor, value, source, options = {}, userId) {
    if (value === undefined || options.criptaWikiSyncCommand || options.khuzoeTokenizerSave
      || !this.game.users.get(userId)?.isGM || !this.eligible(actor) || !this.canPush(actor)) return Promise.resolve(false);
    const identity = this.identity(actor);
    return this.run(async () => {
      if (!this.canPush(actor) || !this.eligible(actor) || this.identity(actor).key !== identity.key) return;
      const state = this.readState();
      const pending = { ...(state.pending || {}) };
      if (Number(value) === this.hover && this.sourceMode(actor, source) === this.hover) {
        // Preserve the receipt/base revision for repeated hooks of the same edit.
        let changed = false;
        if (!pending[identity.key] || this.sourceMode(actor, pending[identity.key].source) !== this.hover) {
          const revision = state.applied?.[identity.key]?.revision;
          pending[identity.key] = { ...identity, id: crypto.randomUUID(), source,
            ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}) };
          changed = true;
        }
        if (changed || !state.initialHoverChecked?.[identity.key]) await this.writeState({ ...state, pending,
          initialHoverChecked: { ...state.initialHoverChecked, [identity.key]: true } });
        this.schedule(identity.key, 350);
      } else if (pending[identity.key] && this.sourceMode(actor, pending[identity.key].source) !== this.hover) {
        delete pending[identity.key]; await this.writeState({ ...state, pending });
        this.timers.clearTimeout(this.pendingTimers.get(identity.key)); this.pendingTimers.delete(identity.key);
      }
    });
  }
  sourceMode(actor, source) {
    if (source.kind === "prototype") return Number(actor.prototypeToken?.displayName);
    const token = this.game.scenes.get(source.sceneId)?.tokens.get(source.tokenId);
    return token?.actorId === actor.id ? Number(token.displayName) : undefined;
  }
  existingHoverSource(actor) {
    if (Number(actor.prototypeToken?.displayName) === this.hover) return { kind: "prototype" };
    for (const scene of this.game.scenes) {
      const token = Array.from(scene.tokens).find(token => token.actorId === actor.id && Number(token.displayName) === this.hover);
      if (token) return { kind: "token", sceneId: scene.id, tokenId: token.id };
    }
    return null;
  }
  hasPending(actor) { return Boolean(this.readState().pending?.[this.identity(actor).key]); }
  async initializeHover(actor, profile) {
    if (!this.eligible(actor) || !this.canPull(actor) || (profile && (!profile.visibility || !Number.isInteger(profile.revision)))) return;
    const identity = this.identity(actor), state = this.readState();
    if (state.initialHoverChecked?.[identity.key] || (profile && (state.applied?.[identity.key]?.revision ?? -1) > profile.revision)) return;
    const isPublic = profile?.visibility.state === "public";
    // Reading public visibility already establishes the wiki → Foundry link.
    // A private dossier must wait until pushes are permitted before checking.
    if (!isPublic && !this.canPush(actor)) return;
    const source = !isPublic && !state.pending?.[identity.key] ? this.existingHoverSource(actor) : null;
    const pending = { ...state.pending };
    const revision = profile?.revision ?? state.applied?.[identity.key]?.revision;
    if (source) pending[identity.key] = { ...identity, id: crypto.randomUUID(), source,
      ...(Number.isInteger(revision) ? { expectedRevision: revision } : {}) };
    // The one-time receipt and durable job are saved together. Subsequent wiki
    // edits to DM visibility must not be undone by this startup reconciliation.
    await this.writeState({ ...state, pending, initialHoverChecked: { ...state.initialHoverChecked, [identity.key]: true } });
    if (source) this.schedule(identity.key, 500);
  }
  schedule(key, delay) {
    if (this.pendingTimers.has(key)) return;
    this.pendingTimers.set(key, this.timers.setTimeout(() => {
      this.pendingTimers.delete(key);
      return this.run(() => this.flush(key));
    }, delay));
  }
  resume() {
    for (const [key, job] of Object.entries(this.readState().pending || {})) {
      const actor = this.game.actors.get(job.actorId);
      if (job.campaignId === this.campaignId() && job.worldId === this.game.world.id && this.canPush(actor)) this.schedule(key, 500);
    }
  }
  valid(job, actor) {
    return job.campaignId === this.campaignId() && job.worldId === this.game.world.id && this.eligible(actor) && this.canPush(actor)
      && this.readState().pending?.[job.key]?.id === job.id && this.sourceMode(actor, job.source) === this.hover;
  }
  async discardCancelled(job, actor) {
    if (job.campaignId === this.campaignId() && job.worldId === this.game.world.id && this.canPush(actor)
      && (!this.eligible(actor) || this.sourceMode(actor, job.source) !== this.hover)) await this.clear(job);
  }
  async clear(job) {
    const state = this.readState();
    if (state.pending?.[job.key]?.id !== job.id) return;
    const pending = { ...state.pending }; delete pending[job.key];
    await this.writeState({ ...state, pending, initialHoverChecked: { ...state.initialHoverChecked, [job.key]: true } }); this.failures.delete(job.key);
    this.timers.clearTimeout(this.pendingTimers.get(job.key)); this.pendingTimers.delete(job.key);
  }
  async flush(key) {
    let job = this.readState().pending?.[key];
    if (!job) return;
    const actor = this.game.actors.get(job.actorId);
    if (!this.valid(job, actor)) return this.discardCancelled(job, actor);
    try {
      let profile = await this.request(job);
      if (!this.valid(job, actor)) return this.discardCancelled(job, actor);
      if (profile.visibility?.state !== "public") {
        // Persist the revision before sending. A lost response followed by a
        // wiki edit must not republish a dossier that the DM made private again.
        if (job.expectedRevision !== undefined && job.expectedRevision !== profile.revision) {
          throw Object.assign(new Error("Il dossier è cambiato sulla wiki. Scegli la visibilità dal sito prima di riprovare."), { status: 409 });
        }
        if (job.expectedRevision === undefined) {
          job = { ...job, expectedRevision: Number(profile.revision || 0) };
          const state = this.readState(); await this.writeState({ ...state, pending: { ...state.pending, [key]: job } });
        }
        if (!this.valid(job, actor)) return this.discardCancelled(job, actor);
        profile = await this.request(job, { expectedRevision: job.expectedRevision, data: { visibility: { state: "public" } } });
        if (profile.visibility?.state !== "public") throw new Error("Il Worker non ha confermato la visibilità pubblica del dossier.");
      }
      if (!this.valid(job, actor)) return this.discardCancelled(job, actor);
      // Reuse the ordinary wiki → Foundry path, without generating a return edit.
      await this.applyProfile(actor, profile, { fromPublish: true });
      await this.clear(job);
    } catch (error) {
      if ([400, 401, 403, 404, 409].includes(error.status)) {
        await this.clear(job); this.report(error); return;
      }
      const attempts = this.failures.get(key) || 0; this.failures.set(key, attempts + 1);
      this.schedule(key, Math.min(300000, 60000 * 2 ** Math.min(attempts, 3)));
      if (!attempts) this.report(error);
    }
  }
  pull(actor, profile) {
    const key = this.identity(actor).key;
    return this.run(async () => {
      if (this.identity(actor).key !== key) return false;
      await this.initializeHover(actor, profile);
      if (this.identity(actor).key !== key) return false;
      return this.applyProfile(actor, profile);
    });
  }
  async applyProfile(actor, profile, { fromPublish = false } = {}) {
    if (!this.eligible(actor) || !this.canPull(actor) || !profile?.visibility || !Number.isInteger(profile.revision)) return false;
    const identity = this.identity(actor);
    const pending = this.readState().pending?.[identity.key];
    if (pending) await this.discardCancelled(pending, actor);
    const state = this.readState(), previous = state.applied?.[identity.key];
    if (!fromPublish && state.pending?.[identity.key]) return false;
    if (previous && profile.revision < previous.revision) return false;
    const visibility = profile.visibility.state === "public" ? "public" : "dm";
    const changed = visibility === "public" && (fromPublish || previous?.visibility !== "public" || !previous?.applied);
    if (changed) await this.applyHover(actor, identity);
    if (!this.canPull(actor) || this.identity(actor).key !== identity.key) return false;
    const next = { revision: profile.revision, visibility, applied: visibility === "public" };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      const fresh = this.readState();
      await this.writeState({ ...fresh, applied: { ...fresh.applied, [identity.key]: next } });
    }
    return changed;
  }
  async applyHover(actor, identity) {
    const active = () => this.canPull(actor) && this.identity(actor).key === identity.key;
    if (!active()) return;
    if (Number(actor.prototypeToken?.displayName) !== this.hover) {
      await actor.update({ "prototypeToken.displayName": this.hover }, { ...INTERNAL });
      if (Number(actor.prototypeToken?.displayName) !== this.hover) throw new Error("Foundry non ha confermato la visibilità del nome del token predefinito.");
    }
    for (const scene of this.game.scenes) {
      if (!active()) return;
      const updates = Array.from(scene.tokens).filter(token => token.actorId === actor.id && Number(token.displayName) !== this.hover)
        .map(token => ({ _id: token.id, displayName: this.hover }));
      if (!updates.length) continue;
      await scene.updateEmbeddedDocuments("Token", updates, { ...INTERNAL });
      if (updates.some(update => Number(scene.tokens.get(update._id)?.displayName) !== this.hover)) throw new Error("Foundry non ha confermato la visibilità del nome di alcuni token nella scena.");
    }
  }
}
