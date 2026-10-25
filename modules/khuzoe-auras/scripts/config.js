import {
  FREQUENCIES,
  MODULE_ID,
  STACKING_MODES,
  TARGET_RELATIONS,
  TEMPLATES,
  TRIGGER_PRESETS
} from "./constants.js";
import {
  createDefaultAction,
  createDefaultAura,
  normalizeAura,
  triggerToPresetKey
} from "./model.js";
import { AuraStore } from "./store.js";
import {
  bindElements,
  DialogV2,
  HandlebarsApplicationV2
} from "./foundry-compat.js";

const TRIGGER_ICONS = Object.freeze({
  sourceTurnStart: "fa-solid fa-play",
  sourceTurnEnd: "fa-solid fa-forward-step",
  affectedTurnStart: "fa-solid fa-user-clock",
  affectedTurnEnd: "fa-solid fa-hourglass-end",
  roundStart: "fa-solid fa-rotate",
  roundEnd: "fa-solid fa-flag-checkered",
  enter: "fa-solid fa-person-walking-arrow-right",
  exit: "fa-solid fa-right-from-bracket",
  manual: "fa-solid fa-hand-pointer"
});

const ACTION_ICONS = Object.freeze({
  healing: "fa-solid fa-heart-pulse",
  damage: "fa-solid fa-burst",
  temphp: "fa-solid fa-shield-heart",
  effect: "fa-solid fa-wand-magic-sparkles"
});

export class AuraConfigApplication extends HandlebarsApplicationV2 {
  #engine;
  #draftAuras;

  constructor(tokenDocument, engine, options = {}) {
    super(options);
    this.tokenDocument = tokenDocument?.document ?? tokenDocument;
    this.#engine = engine;
    this.#draftAuras = AuraStore.getAuras(this.tokenDocument);
    if (!this.#draftAuras.length) this.#draftAuras = [createDefaultAura()];
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-auras-config",
    tag: "form",
    classes: ["khuzoe-auras", "khuzoe-auras-config", "khz-application-v14"],
    position: { width: 940, height: 840 },
    window: { icon: "fa-solid fa-sun", resizable: true },
    form: { closeOnSubmit: true, handler: AuraConfigApplication._onSubmitForm },
    actions: {
      "add-aura": AuraConfigApplication._onAddAuraAction,
      "delete-aura": AuraConfigApplication._onDeleteAuraAction,
      "add-action": AuraConfigApplication._onAddActionAction,
      "delete-action": AuraConfigApplication._onDeleteActionAction,
      "activate-manual": AuraConfigApplication._onActivateManualAction
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.CONFIG }
  };

  static _onSubmitForm(_event, form) { return this.#save(form); }
  static _onAddAuraAction(event) { return this.#addAura(event); }
  static _onDeleteAuraAction(event, target) { return this.#deleteAura(event, target); }
  static _onAddActionAction(event, target) { return this.#addAction(event, target); }
  static _onDeleteActionAction(event, target) { return this.#deleteAction(event, target); }
  static _onActivateManualAction(event, target) { return this.#activateManual(event, target); }

  get title() {
    return game.i18n.format("KHZ_AURAS.Config.Title", {
      token: this.tokenDocument?.name ?? ""
    });
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const actionTypes = [
      ...this.#engine.actionTypes,
      ...this.#draftAuras.flatMap(aura => aura.actions.map(action => action.type))
    ];
    const choices = buildChoiceMaps(actionTypes, this.tokenDocument?.actor);

    return {
      ...context,
      tokenName: this.tokenDocument?.name,
      auras: this.#draftAuras.map((aura, auraIndex) => prepareAura(
        aura,
        auraIndex,
        choices
      ))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    bindElements(this.element, '[data-rerender="true"]', "change", () => {
      this.#captureDraft();
      this.render();
    });
    bindElements(this.element, "[data-live-range]", "input", event => {
      const output = event.currentTarget.closest(".khz-range-control")?.querySelector("output");
      if (!output) return;
      const scale = Number(output.dataset.scale ?? 1);
      const digits = Number(output.dataset.digits ?? 0);
      const value = Number(event.currentTarget.value ?? 0) * scale;
      output.textContent = `${value.toFixed(digits)}${output.dataset.suffix ?? ""}`;
    });
    bindElements(this.element, "[data-aura-color]", "input", event => {
      const card = event.currentTarget.closest(".khz-aura-card");
      card?.style.setProperty(
        "--khz-aura-color",
        event.currentTarget.value
      );
      const value = event.currentTarget.closest(".khz-color-control")?.querySelector("strong");
      if (value) value.textContent = event.currentTarget.value.toUpperCase();
    });
  }

  async #save(form = this.form) {
    this.#captureDraft(form);
    await AuraStore.setAuras(this.tokenDocument, this.#draftAuras);
    ui.notifications.info(game.i18n.localize("KHZ_AURAS.Config.Saved"));
  }

  #addAura(event) {
    event?.preventDefault?.();
    this.#captureDraft();
    this.#draftAuras.push(createDefaultAura({
      name: game.i18n.localize("KHZ_AURAS.Config.NewAura")
    }));
    return this.render();
  }

  async #deleteAura(event, target = event?.currentTarget) {
    event?.preventDefault?.();
    const auraIndex = Number(target?.dataset?.auraIndex);
    const aura = this.#draftAuras[auraIndex];
    if (!aura) return;

    const confirmed = await DialogV2.confirm({
      window: {
        title: game.i18n.localize("KHZ_AURAS.Config.DeleteAura"),
        icon: "fa-solid fa-trash"
      },
      content: `<p>${game.i18n.format("KHZ_AURAS.Config.DeleteConfirm", {
        name: escapeHtml(aura.name)
      })}</p>`,
      no: { default: true },
      rejectClose: false
    });
    if (!confirmed) return;

    this.#captureDraft();
    this.#draftAuras.splice(auraIndex, 1);
    return this.render();
  }

  #addAction(event, target = event?.currentTarget) {
    event?.preventDefault?.();
    this.#captureDraft();
    const aura = this.#draftAuras[Number(target?.dataset?.auraIndex)];
    aura?.actions.push(createDefaultAction());
    return this.render();
  }

  #deleteAction(event, target = event?.currentTarget) {
    event?.preventDefault?.();
    this.#captureDraft();
    const auraIndex = Number(target?.dataset?.auraIndex);
    const actionIndex = Number(target?.dataset?.actionIndex);
    const aura = this.#draftAuras[auraIndex];
    if (!aura || aura.actions.length <= 1) return;
    aura.actions.splice(actionIndex, 1);
    return this.render();
  }

  async #activateManual(event, target = event?.currentTarget) {
    event?.preventDefault?.();
    const auraIndex = Number(target?.dataset?.auraIndex);
    this.#captureDraft();
    const aura = this.#draftAuras[auraIndex];
    if (!aura) return;

    await AuraStore.setAuras(this.tokenDocument, this.#draftAuras);
    await this.#engine.activateAura(this.tokenDocument, aura.id);
  }

  #captureDraft(form = this.form) {
    if (!form) return;
    this.#draftAuras = readAurasFromForm(form);
  }
}

export function readAurasFromForm(form) {
  const expanded = {};
  const data = new FormData(form);
  for (const [name, value] of data.entries()) {
    const previous = foundry.utils.getProperty(expanded, name);
    if (previous === undefined) foundry.utils.setProperty(expanded, name, value);
    else if (Array.isArray(previous)) previous.push(value);
    else foundry.utils.setProperty(expanded, name, [previous, value]);
  }

  return Object.values(expanded.auras ?? {}).map(raw => {
    const triggers = Object.entries(raw.triggers ?? {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => ({
        ...TRIGGER_PRESETS[key],
        frequency: raw.triggerFrequency
      }))
      .filter(trigger => trigger.event && trigger.subject);

    const actions = Object.values(raw.actions ?? {}).map(action => ({
      id: action.id,
      type: action.type,
      formula: action.formula,
      damageType: action.damageType,
      rollMode: action.rollMode,
      save: {
        enabled: Boolean(action.save?.enabled),
        ability: action.save?.ability,
        dc: action.save?.dc,
        onSuccess: action.save?.onSuccess,
        immunityOnSuccess: Boolean(action.save?.immunityOnSuccess),
        failureEffects: formValueList(action.save?.failureEffects),
        effectDurationRounds: action.save?.effectDurationRounds,
        showFailureEffectIcon: Boolean(action.save?.showFailureEffectIcon)
      }
    }));

    return normalizeAura({
      id: raw.id,
      name: raw.name,
      enabled: Boolean(raw.enabled),
      visualOnly: Boolean(raw.visualOnly),
      area: {
        distance: raw.area?.distance,
        walls: Boolean(raw.area?.walls),
        elevation: Boolean(raw.area?.elevation)
      },
      targets: {
        relation: raw.targets?.relation,
        includeSource: Boolean(raw.targets?.includeSource)
      },
      source: {
        requiresConscious: Boolean(raw.source?.requiresConscious)
      },
      triggers,
      actions,
      stacking: {
        group: raw.stacking?.group,
        mode: raw.stacking?.mode,
        priority: raw.stacking?.priority
      },
      visual: {
        visible: Boolean(raw.visual?.visible),
        color: raw.visual?.color,
        opacity: raw.visual?.opacity,
        lineOpacity: raw.visual?.lineOpacity,
        lineWidth: raw.visual?.lineWidth
      }
    });
  });
}

function prepareAura(aura, auraIndex, choices) {
  const path = `auras.${auraIndex}`;
  const selectedTriggers = new Set(aura.triggers.map(triggerToPresetKey).filter(Boolean));

  return {
    ...aura,
    index: auraIndex,
    path,
    statusLabel: game.i18n.localize(aura.enabled
      ? "KHZ_AURAS.Config.StatusEnabled"
      : "KHZ_AURAS.Config.StatusDisabled"),
    targetLabel: choices.targets[aura.targets.relation] ?? aura.targets.relation,
    triggerBadge: game.i18n.format("KHZ_AURAS.Config.TriggerBadge", {
      count: aura.triggers.length
    }),
    actionBadge: game.i18n.format("KHZ_AURAS.Config.ActionBadge", {
      count: aura.actions.length
    }),
    radiusBadge: game.i18n.format("KHZ_AURAS.Config.RadiusBadge", {
      distance: aura.area.distance
    }),
    visualLabels: {
      opacity: `${Math.round(aura.visual.opacity * 100)}%`,
      lineOpacity: `${Math.round(aura.visual.lineOpacity * 100)}%`,
      lineWidth: `${Number(aura.visual.lineWidth).toFixed(2)} px`
    },
    canManual: !aura.visualOnly && selectedTriggers.has("manual"),
    triggerFrequency: aura.triggers[0]?.frequency ?? "oncePerPhase",
    triggerOptions: Object.keys(TRIGGER_PRESETS).map(key => ({
      key,
      name: `${path}.triggers.${key}`,
      label: game.i18n.localize(`KHZ_AURAS.Triggers.${key}`),
      icon: TRIGGER_ICONS[key] ?? "fa-solid fa-bolt",
      enabled: selectedTriggers.has(key)
    })),
    targetChoices: choices.targets,
    frequencyChoices: choices.frequencies,
    stackingChoices: choices.stacking,
    actions: aura.actions.map((action, actionIndex) => ({
      ...action,
      index: actionIndex,
      path: `${path}.actions.${actionIndex}`,
      numberLabel: game.i18n.format("KHZ_AURAS.Config.ActionNumber", {
        number: actionIndex + 1
      }),
      selectedTypeLabel: choices.actionTypes[action.type] ?? action.type,
      icon: ACTION_ICONS[action.type] ?? "fa-solid fa-bolt",
      canRemove: aura.actions.length > 1,
      isDamage: action.type === "damage",
      isEffect: action.type === "effect",
      hasSavingThrow: ["damage", "effect"].includes(action.type),
      typeChoices: choices.actionTypes,
      rollModeChoices: choices.rollModes,
      damageTypeChoices: choices.damageTypes,
      abilityChoices: choices.abilities,
      saveResultChoices: choices.saveResults,
      failureEffectOptions: Object.entries(choices.failureEffects).map(([value, label]) => ({
        value,
        label,
        selected: action.save.failureEffects.includes(value)
      }))
    }))
  };
}

function buildChoiceMaps(actionTypes, actor) {
  const availableActionTypes = [...new Set(actionTypes)];
  return {
    targets: localizeChoices(TARGET_RELATIONS, "KHZ_AURAS.Targets"),
    frequencies: localizeChoices(FREQUENCIES, "KHZ_AURAS.Frequencies"),
    stacking: localizeChoices(STACKING_MODES, "KHZ_AURAS.Stacking"),
    actionTypes: localizeActionChoices(availableActionTypes),
    rollModes: localizeChoices(["perTarget", "shared"], "KHZ_AURAS.RollModes"),
    saveResults: localizeChoices(["none", "half"], "KHZ_AURAS.SaveResults"),
    damageTypes: Object.fromEntries(Object.entries(CONFIG.DND5E.damageTypes).map(([key, data]) => [
      key,
      configurationLabel(data, key)
    ])),
    abilities: Object.fromEntries(Object.entries(CONFIG.DND5E.abilities).map(([key, data]) => [
      key,
      configurationLabel(data, key)
    ])),
    failureEffects: buildFailureEffectChoices(actor)
  };
}

function buildFailureEffectChoices(actor) {
  const choices = [];
  for (const [id, data] of Object.entries(CONFIG.DND5E.conditionTypes ?? {})) {
    const label = configurationLabel({ label: data.name ?? data.label }, id);
    choices.push([`status:${id}`, game.i18n.format("KHZ_AURAS.Config.ConditionChoice", { name: label })]);
  }

  for (const effect of actor?.effects ?? []) {
    if (!effect.uuid) continue;
    choices.push([
      `uuid:${effect.uuid}`,
      game.i18n.format("KHZ_AURAS.Config.ActorEffectChoice", { name: effect.name })
    ]);
  }
  for (const item of actor?.items ?? []) {
    for (const effect of item.effects ?? []) {
      if (!effect.uuid) continue;
      choices.push([
        `uuid:${effect.uuid}`,
        game.i18n.format("KHZ_AURAS.Config.ItemEffectChoice", {
          item: item.name,
          name: effect.name
        })
      ]);
    }
  }

  choices.sort((left, right) => left[1].localeCompare(right[1], game.i18n.lang));
  return Object.fromEntries(choices);
}

function formValueList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function configurationLabel(data, fallback) {
  const label = typeof data === "string" ? data : data?.label;
  return label ? game.i18n.localize(label) : fallback;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function localizeActionChoices(values) {
  return Object.fromEntries(values.map(value => {
    const key = `KHZ_AURAS.Actions.${value}`;
    const localized = game.i18n.localize(key);
    return [value, localized === key ? value : localized];
  }));
}

function localizeChoices(values, prefix) {
  return Object.fromEntries(values.map(value => [
    value,
    game.i18n.localize(`${prefix}.${value}`)
  ]));
}
