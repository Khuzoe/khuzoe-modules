import { FLAGS, GROUP_MODES, MODULE_ID, TEMPLATES } from "./constants.js";
import { collectActionOptions, configurationActor, findMatchingOption } from "./action-service.js";
import { createGroup, normalizeConfig } from "./model.js";
import { createInferredMultiattackGroups } from "./multiattack-inference.js";
import { bindElements, HandlebarsApplicationV2 } from "./foundry-compat.js";

export class MonsterHudConfig extends HandlebarsApplicationV2 {
  constructor(tokenDocument, { onSave, ...options } = {}) {
    super(options);
    this.tokenDocument = tokenDocument?.document ?? tokenDocument;
    this.actor = configurationActor(this.tokenDocument);
    this.onSave = onSave;
    this.draft = normalizeConfig(this.actor?.getFlag(MODULE_ID, FLAGS.CONFIG));
    this.actionOptions = collectActionOptions(this.actor);
    const hasReplaceableDraft = !this.draft.groups.length
      || (this.draft.groups.length === 1
        && this.draft.groups[0].name === "Multiattack"
        && !this.draft.groups[0].entries.length);
    if (hasReplaceableDraft) {
      const inferred = createInferredMultiattackGroups(this.actor, this.actionOptions);
      if (inferred.length) this.draft.groups = inferred;
    }
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-monster-hud-config",
    tag: "form",
    classes: ["khuzoe-monster-hud", "khmh-config"],
    position: { width: 920, height: 780 },
    window: { icon: "fa-solid fa-dragon", resizable: true },
    form: { closeOnSubmit: true, handler: MonsterHudConfig._onSubmitForm },
    actions: {
      addGroup: MonsterHudConfig._onAddGroup,
      deleteGroup: MonsterHudConfig._onDeleteGroup
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.CONFIG }
  };

  static _onSubmitForm(_event, form) { return this._save(form); }
  static _onAddGroup(event) { return this._addGroup(event); }
  static _onDeleteGroup(event, target) { return this._deleteGroup(event, target); }

  get title() {
    return game.i18n.format("KHMH.Config.Title", { name: this.actor?.name ?? "" });
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const selectedQuickKeys = new Set(this.draft.quick
      .map(reference => findMatchingOption(this.actionOptions, reference)?.key)
      .filter(Boolean));
    const quick = this.actionOptions.map(option => ({
      ...option,
      selected: selectedQuickKeys.has(option.key)
    }));
    const groupModes = Object.fromEntries(GROUP_MODES.map(mode => [
      mode,
      game.i18n.localize(`KHMH.Config.GroupModes.${mode}`)
    ]));

    return {
      ...context,
      actor: this.actor,
      hasActions: this.actionOptions.length > 0,
      autoQuick: this.draft.autoQuick,
      quick,
      groups: this.draft.groups.map((group, index) => ({
        ...this._prepareGroupContext(group),
        index,
        fixed: group.mode === "fixed",
        groupModes
      }))
    };
  }

  _prepareGroupContext(group) {
    const entriesByKey = new Map();
    for (const entry of group.entries) {
      const option = findMatchingOption(this.actionOptions, entry.ref);
      if (option && !entriesByKey.has(option.key)) entriesByKey.set(option.key, entry);
    }
    return {
      ...group,
      actions: this.actionOptions.map(option => {
        const entry = entriesByKey.get(option.key);
        return { ...option, included: Boolean(entry), limit: entry?.limit ?? 1 };
      })
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    bindElements(this.element, '.khmh-config-group [data-field="mode"]', "change", event => {
      const card = event.currentTarget.closest(".khmh-config-group");
      if (card) card.dataset.groupMode = event.currentTarget.value;
    });
  }

  _capture(root = this.form) {
    if (!root) return;
    const byKey = new Map(this.actionOptions.map(option => [option.key, option.ref]));
    const quick = [...root.querySelectorAll(".khmh-config-quick-row")]
      .filter(row => row.querySelector('[data-field="enabled"]')?.checked)
      .map(row => byKey.get(row.dataset.actionKey))
      .filter(Boolean);

    const groups = [...root.querySelectorAll(".khmh-config-group")].map(card => ({
      id: card.dataset.groupId,
      name: card.querySelector('[data-field="name"]')?.value,
      mode: card.querySelector('[data-field="mode"]')?.value,
      capacity: card.querySelector('[data-field="capacity"]')?.value,
      entries: [...card.querySelectorAll(".khmh-config-group-action")]
        .filter(row => row.querySelector('[data-field="included"]')?.checked)
        .map(row => ({
          ref: byKey.get(row.dataset.actionKey),
          limit: row.querySelector('[data-field="limit"]')?.value
        }))
        .filter(entry => entry.ref)
    }));

    this.draft = normalizeConfig({
      autoQuick: Boolean(root.querySelector('[name="autoQuick"]')?.checked),
      quick,
      groups
    });
  }

  _addGroup(event) {
    event.preventDefault();
    this._capture();
    this.draft.groups.push(createGroup({
      name: game.i18n.localize("KHMH.Config.NewGroup")
    }));
    return this.render();
  }

  _deleteGroup(event, target) {
    event.preventDefault();
    this._capture();
    const groupId = target?.closest?.(".khmh-config-group")?.dataset.groupId;
    this.draft.groups = this.draft.groups.filter(group => group.id !== groupId);
    return this.render();
  }

  async _save(form) {
    this._capture(form);
    if (!this.actor?.update) throw new Error(game.i18n.localize("KHMH.Errors.ActorUnavailable"));
    await this.actor.update({
      [`flags.${MODULE_ID}.${FLAGS.CONFIG}`]: this.draft
    }, {
      khuzoeMonsterHud: true,
      // Prevent a UI-only flag from scheduling a character/Managed Actor upload.
      criptaWikiSyncCommand: true
    });
    ui.notifications.info(game.i18n.localize("KHMH.Config.Saved"));
    this.onSave?.(this.draft);
    Hooks.callAll("khuzoeMonsterHud.configUpdated", this.actor, this.draft);
  }
}
