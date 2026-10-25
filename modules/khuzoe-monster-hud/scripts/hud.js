import {
  ABILITIES,
  FLAGS,
  MODULE_ID,
  QUICK_SKILLS,
  SETTINGS
} from "./constants.js";
import {
  actionOption,
  automaticQuickActions,
  collectActionOptions,
  configurationActor,
  resolveConfiguredActions,
  resolveReference,
  spellGroups,
  useAction
} from "./action-service.js";
import { MonsterHudConfig } from "./config-app.js";
import { normalizeConfig, referencesMatch } from "./model.js";
import {
  getTurnUsage,
  groupUsage,
  recordGroupUse,
  resetTurnUsage
} from "./turn-tracker.js";

export class MonsterHudController {
  #root = null;
  #frame = null;
  #layoutObserver = null;
  #mutationObserver = null;
  #pinnedTokenId = "";
  #collapsed = false;
  #spellsOpen = false;
  #actions = new Map();
  #groups = new Map();
  #pendingUsage = null;
  #manualPosition = null;
  #dragState = null;
  #boundDragMove = event => this.#onDragMove(event);
  #boundDragEnd = event => this.#onDragEnd(event);

  initialize() {
    this.#ensureRoot();
    this.#initializeLayoutObservers();
    globalThis.window?.addEventListener?.("resize", () => this.#applySafePosition());
    globalThis.window?.addEventListener?.("pointermove", this.#boundDragMove);
    globalThis.window?.addEventListener?.("pointerup", this.#boundDragEnd);
    globalThis.window?.addEventListener?.("pointercancel", this.#boundDragEnd);
    this.requestRender();
  }

  destroy() {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#layoutObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    globalThis.window?.removeEventListener?.("pointermove", this.#boundDragMove);
    globalThis.window?.removeEventListener?.("pointerup", this.#boundDragEnd);
    globalThis.window?.removeEventListener?.("pointercancel", this.#boundDragEnd);
    this.#root?.remove();
    this.#root = null;
  }

  requestRender() {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.render();
    });
  }

  render() {
    const root = this.#ensureRoot();
    if (!root) return;
    const tokenDocument = this.currentTokenDocument();
    const actor = tokenDocument?.actor;

    if (!this.#canDisplay(tokenDocument, actor)) {
      root.hidden = true;
      root.innerHTML = "";
      this.#actions.clear();
      this.#groups.clear();
      return;
    }

    const configActor = configurationActor(tokenDocument);
    const config = normalizeConfig(configActor?.getFlag(MODULE_ID, FLAGS.CONFIG));
    const groupRefs = config.groups.flatMap(group => group.entries.map(entry => entry.ref));
    let quickRefs = config.quick;
    if (!quickRefs.length && config.autoQuick) {
      quickRefs = automaticQuickActions(actor).filter(reference => (
        !groupRefs.some(groupReference => referencesMatch(reference, groupReference))
      ));
    }

    const quick = resolveConfiguredActions(actor, quickRefs);
    const usage = getTurnUsage(tokenDocument);
    const groups = config.groups.map(group => this.#prepareGroup(actor, group, usage)).filter(group => group.actions.length);
    const spells = spellGroups(actor);
    const legendary = this.#legendaryResources(actor);
    const failedSave = this.#recentFailedSave(tokenDocument, actor);

    this.#actions.clear();
    this.#groups = new Map(groups.map(group => [group.id, group]));
    for (const action of quick) this.#actions.set(action.uiKey ?? action.key, action);
    for (const group of groups) {
      for (const action of group.actions) this.#actions.set(action.uiKey ?? action.key, action);
    }
    for (const spellGroup of spells) {
      for (const spell of spellGroup.spells) this.#actions.set(spell.uiKey ?? spell.key, spell);
    }

    root.hidden = false;
    if (!this.#dragState) this.#manualPosition = normalizePosition(configuredSetting(SETTINGS.POSITION, {}));
    root.dataset.anchor = this.#manualPosition ? "manual" : configuredSetting(SETTINGS.ANCHOR, "center");
    root.style.setProperty("--khmh-scale", String(configuredSetting(SETTINGS.SCALE, 1)));
    root.classList.toggle("is-collapsed", this.#collapsed);
    root.classList.toggle("is-spells-open", this.#spellsOpen);
    root.innerHTML = this.#renderHud({
      tokenDocument,
      actor,
      quick,
      groups,
      spells,
      legendary,
      failedSave,
      pinned: this.#pinnedTokenId === tokenDocument.id,
      canToggleName: Boolean(game.user?.isGM),
      nameRevealed: tokenDocument.displayName === (globalThis.CONST?.TOKEN_DISPLAY_MODES?.HOVER ?? 30)
    });
    this.#applySafePosition();
    this.#observeLayout();
  }

  currentTokenDocument() {
    if (!globalThis.canvas?.ready) return null;
    if (this.#pinnedTokenId) {
      const pinned = canvas.scene?.tokens?.get?.(this.#pinnedTokenId);
      if (pinned) return pinned;
      this.#pinnedTokenId = "";
    }

    const controlled = Array.from(canvas.tokens?.controlled ?? []);
    const selected = controlled.at(-1)?.document;
    if (selected) return selected;

    if (configuredSetting(SETTINGS.FOLLOW_COMBAT, true)) {
      const combatant = game.combat?.combatant;
      if (combatant?.sceneId === canvas.scene?.id || combatant?.token?.parent?.id === canvas.scene?.id) {
        return combatant.token ?? canvas.scene?.tokens?.get?.(combatant.tokenId) ?? null;
      }
    }
    return null;
  }

  async handlePostUseActivity(activity) {
    const tokenDocument = this.currentTokenDocument();
    const actor = tokenDocument?.actor;
    if (!actor || !activity?.item) return;
    const activityActor = activity.actor ?? activity.item.actor;
    if (activityActor?.uuid !== actor.uuid && activityActor?.id !== actor.id) return;

    const used = actionOption(activity.item, activity);
    const configActor = configurationActor(tokenDocument);
    const config = normalizeConfig(configActor?.getFlag(MODULE_ID, FLAGS.CONFIG));
    let group = null;

    if (this.#pendingUsage
      && Date.now() - this.#pendingUsage.at < 30_000
      && this.#pendingUsage.itemId === activity.item.id
      && (!this.#pendingUsage.activityId || this.#pendingUsage.activityId === activity.id)) {
      group = config.groups.find(candidate => candidate.id === this.#pendingUsage.groupId) ?? null;
    }
    this.#pendingUsage = null;

    if (!group) {
      const matches = config.groups.filter(candidate => candidate.entries.some(entry => (
        referencesMatch(entry.ref, used.ref)
      )));
      if (matches.length === 1) group = matches[0];
    }
    if (!group) return;

    const configuredEntry = group.entries.find(entry => referencesMatch(entry.ref, used.ref));
    await recordGroupUse(tokenDocument, group, configuredEntry?.ref ?? used.ref);
    this.requestRender();
  }

  #ensureRoot() {
    if (this.#root?.isConnected) return this.#root;
    if (!globalThis.document?.body) return null;
    this.#root = document.createElement("aside");
    this.#root.id = "khuzoe-monster-hud";
    this.#root.hidden = true;
    this.#root.addEventListener("click", event => {
      void this.#onClick(event).catch(error => {
        console.error("Khuzoe Monster HUD | Action failed.", error);
        ui.notifications.error(game.i18n.format("KHMH.Errors.ActionFailed", { message: error.message }));
      });
    });
    this.#root.addEventListener("contextmenu", event => this.#onContextMenu(event));
    this.#root.addEventListener("pointerdown", event => this.#onDragStart(event));
    this.#root.addEventListener("dblclick", event => this.#onHeaderDoubleClick(event));
    document.body.append(this.#root);
    return this.#root;
  }

  #canDisplay(tokenDocument, actor) {
    if (!tokenDocument) return false;
    return canUserAccessHudActor(actor, game.user);
  }

  #prepareGroup(actor, group, usage) {
    const measured = groupUsage(group, usage);
    const actions = group.entries.map(entry => {
      const option = resolveReference(actor, entry.ref);
      if (!option) return null;
      const used = measured.entryUsed(entry.ref);
      const total = group.mode === "shared" ? measured.total : entry.limit;
      const exhausted = group.mode === "shared" ? measured.exhausted : used >= entry.limit;
      return {
        ...option,
        uiKey: `${option.key}:group:${group.id}`,
        groupId: group.id,
        limit: entry.limit,
        used,
        total,
        remaining: group.mode === "shared" ? measured.remaining : Math.max(0, entry.limit - used),
        groupExhausted: exhausted
      };
    }).filter(Boolean);
    return { ...group, ...measured, actions };
  }

  #renderHud(context) {
    const portrait = context.tokenDocument.texture?.src || context.actor.img || "icons/svg/mystery-man.svg";
    const body = this.#collapsed ? "" : `
      ${context.groups.map(group => this.#renderGroup(group)).join("")}
      ${this.#renderQuickActions(context.quick)}
      ${this.#renderRolls(context.actor)}
      ${this.#renderSpellDrawer(context.spells)}
    `;

    return `
      <header class="khmh-header">
        <i class="khmh-drag-handle fa-solid fa-grip-lines" data-tooltip="KHMH.HUD.Drag"></i>
        <img class="khmh-portrait" src="${escapeAttribute(portrait)}" alt="">
        <div class="khmh-identity">
          <strong>${escapeHtml(context.tokenDocument.name || context.actor.name)}</strong>
        </div>
        <div class="khmh-legendary">${this.#renderLegendary(context.legendary, context.failedSave)}</div>
        ${context.canToggleName ? `<button type="button" class="khmh-name-toggle ${context.nameRevealed ? "is-revealed" : ""}" data-action="toggleName" data-tooltip="${context.nameRevealed ? "KHMH.HUD.HideName" : "KHMH.HUD.RevealName"}" aria-label="${escapeAttribute(game.i18n.localize(context.nameRevealed ? "KHMH.HUD.HideName" : "KHMH.HUD.RevealName"))}">
          <i class="fa-solid ${context.nameRevealed ? "fa-eye-slash" : "fa-eye"}"></i>
        </button>` : ""}
        <nav class="khmh-header-actions">
          <button type="button" class="icon" data-action="pin" data-tooltip="KHMH.HUD.Pin">
            <i class="fa-solid ${context.pinned ? "fa-thumbtack-slash" : "fa-thumbtack"}"></i>
          </button>
          <button type="button" class="icon" data-action="config" data-tooltip="KHMH.HUD.Configure">
            <i class="fa-solid fa-gear"></i>
          </button>
          <button type="button" class="icon" data-action="collapse" data-tooltip="KHMH.HUD.Collapse">
            <i class="fa-solid ${this.#collapsed ? "fa-chevron-up" : "fa-chevron-down"}"></i>
          </button>
        </nav>
      </header>
      <div class="khmh-body">${body}</div>
    `;
  }

  #renderGroup(group) {
    const classes = ["khmh-multiattack"];
    if (group.exhausted) classes.push("is-exhausted");
    if (!group.active) classes.push("is-inactive");
    return `
      <section class="${classes.join(" ")}" data-group-id="${escapeAttribute(group.id)}">
        <header>
          <span><i class="fa-solid fa-layer-group"></i> ${escapeHtml(group.name)}</span>
          <span class="khmh-group-counter">${group.remaining}/${group.total}</span>
          <button type="button" class="icon" data-action="resetGroup" data-tooltip="KHMH.HUD.ResetTurn">
            <i class="fa-solid fa-rotate-left"></i>
          </button>
        </header>
        <div class="khmh-action-strip">
          ${group.actions.map(action => this.#renderAction(action)).join("")}
        </div>
      </section>
    `;
  }

  #renderQuickActions(actions) {
    if (!actions.length) return "";
    const ordinary = actions.filter(action => !action.legendary);
    const legendary = actions.filter(action => action.legendary);
    const separator = ordinary.length && legendary.length
      ? '<span class="khmh-action-separator" aria-hidden="true"></span>'
      : "";
    return `<section class="khmh-action-strip khmh-quick-actions" aria-label="${escapeHtml(localize("HUD.Quick"))}">
      ${ordinary.map(action => this.#renderAction(action)).join("")}
      ${separator}
      ${legendary.map(action => this.#renderAction(action)).join("")}
    </section>`;
  }

  #renderAction(action) {
    const exhausted = action.exhausted || action.groupExhausted || !action.canUse;
    const classes = ["khmh-action"];
    if (exhausted) classes.push("is-exhausted");
    if (action.legendary) classes.push("is-legendary");
    const badges = [];
    if (action.groupId) badges.push(`<span class="khmh-badge khmh-badge-group">${action.remaining}/${action.total}</span>`);
    if (action.cost) badges.push(`<span class="khmh-badge khmh-badge-cost">${action.cost}</span>`);
    if (action.uses.max) badges.push(`<span class="khmh-badge khmh-badge-uses">${action.uses.value}/${action.uses.max}</span>`);
    return `
      <button type="button" class="${classes.join(" ")}" data-action="useAction"
        data-action-key="${escapeAttribute(action.uiKey ?? action.key)}" data-group-id="${escapeAttribute(action.groupId || "")}"
        data-tooltip="${escapeAttribute(action.label)}">
        <img src="${escapeAttribute(action.img)}" alt="">
        <span class="khmh-action-label">${escapeHtml(action.label)}</span>
        ${badges.join("")}
      </button>
    `;
  }

  #renderRolls(actor) {
    const saves = ABILITIES.map(ability => {
      return `<button type="button" data-action="save" data-ability="${ability}" data-tooltip="${escapeAttribute(abilityLabel(ability))}">${escapeHtml(ability.toUpperCase())}</button>`;
    }).join("");
    const skills = QUICK_SKILLS.map(skill => {
      const label = CONFIG.DND5E.skills?.[skill.key]?.label ?? skill.key;
      return `<button type="button" data-action="skill" data-skill="${skill.key}" data-tooltip="${escapeAttribute(localizeMaybe(label))}"><i class="${skill.icon}"></i>${skill.short}</button>`;
    }).join("");
    const hasSpells = actor.items?.some?.(item => item.type === "spell");
    return `
      <section class="khmh-roll-strip">
        <div class="khmh-save-buttons">${saves}</div>
        <div class="khmh-skill-buttons">${skills}</div>
        ${hasSpells ? `<button type="button" class="khmh-spell-toggle" data-action="toggleSpells"><i class="fa-solid fa-wand-sparkles"></i>${escapeHtml(game.i18n.localize("KHMH.HUD.Spells"))}</button>` : ""}
      </section>
    `;
  }

  #renderSpellDrawer(groups) {
    if (!this.#spellsOpen || !groups.length) return "";
    return `<section class="khmh-spell-drawer">
      ${groups.map(group => `<div class="khmh-spell-level">
        <header><strong>${escapeHtml(group.label)}</strong>${group.slots ? `<span>${group.slots.value}/${group.slots.max}</span>` : ""}</header>
        <div>${group.spells.map(spell => this.#renderAction(spell)).join("")}</div>
      </div>`).join("")}
    </section>`;
  }

  #legendaryResources(actor) {
    const resources = actor.system?.resources ?? {};
    return ["legact", "legres"].map(key => {
      const resource = resources[key] ?? {};
      const max = Math.max(0, Number(resource.max) || 0);
      const value = Math.max(0, Number(resource.value ?? (max - Number(resource.spent ?? 0))) || 0);
      return { key, max, value };
    }).filter(resource => resource.max > 0);
  }

  #renderLegendary(resources, failedSave) {
    return resources.map(resource => {
      const labelKey = resource.key === "legact" ? "KHMH.HUD.LegendaryActions" : "KHMH.HUD.LegendaryResistances";
      const pips = Array.from({ length: resource.max }, (_, index) => {
        const number = index + 1;
        const filled = resource.value >= number;
        return `<button type="button" class="khmh-pip ${filled ? "is-filled" : ""}" data-action="resourcePip" data-resource="${resource.key}" data-index="${number}" aria-label="${escapeAttribute(game.i18n.localize(labelKey))}"></button>`;
      }).join("");
      const resist = resource.key === "legres" && failedSave && resource.value > 0
        ? `<button type="button" class="khmh-resist" data-action="resistSave" data-message-id="${failedSave.id}" data-tooltip="KHMH.HUD.ResistSave"><i class="fa-solid fa-dragon"></i></button>`
        : "";
      return `<div class="khmh-resource khmh-resource-${resource.key}" data-tooltip="${labelKey}"><span>${resource.key === "legact" ? "LA" : "LR"}</span>${pips}${resist}</div>`;
    }).join("");
  }

  #recentFailedSave(tokenDocument, actor) {
    const messages = Array.from(game.messages?.contents ?? []).toReversed().slice(0, 30);
    return messages.find(message => {
      const roll = message.flags?.dnd5e?.roll;
      if (roll?.type !== "save" || roll.forceSuccess || !message.rolls?.length) return false;
      const associated = message.getAssociatedActor?.();
      if (associated?.uuid !== actor.uuid && associated?.id !== actor.id) return false;
      if (message.speaker?.token && message.speaker.token !== tokenDocument.id) return false;
      if (message.speaker?.scene && message.speaker.scene !== tokenDocument.parent?.id) return false;
      return !message.rolls.some(candidate => candidate.isSuccess);
    }) ?? null;
  }

  async #onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || !this.#root?.contains(button)) return;
    const tokenDocument = this.currentTokenDocument();
    const actor = tokenDocument?.actor;
    if (!actor) return;

    switch (button.dataset.action) {
      case "collapse":
        this.#collapsed = !this.#collapsed;
        this.render();
        return;
      case "pin":
        this.#pinnedTokenId = this.#pinnedTokenId ? "" : tokenDocument.id;
        this.render();
        return;
      case "config":
        new MonsterHudConfig(tokenDocument, { onSave: () => this.requestRender() }).render({ force: true });
        return;
      case "toggleSpells":
        this.#spellsOpen = !this.#spellsOpen;
        this.render();
        return;
      case "toggleName":
        await this.#toggleNameVisibility(tokenDocument);
        return;
      case "resetGroup":
        await resetTurnUsage(tokenDocument);
        this.requestRender();
        return;
      case "save":
        await actor.rollSavingThrow({ ability: button.dataset.ability, event });
        return;
      case "skill":
        await actor.rollSkill({ skill: button.dataset.skill, event });
        return;
      case "resourcePip":
        await this.#setResource(actor, button.dataset.resource, Number(button.dataset.index), button.classList.contains("is-filled"));
        return;
      case "resistSave": {
        const message = game.messages?.get?.(button.dataset.messageId);
        if (message) await actor.system.resistSave(message);
        this.requestRender();
        return;
      }
      case "useAction":
        await this.#useActionButton(tokenDocument, button, event);
        return;
    }
  }

  async #useActionButton(tokenDocument, button, event) {
    const action = this.#actions.get(button.dataset.actionKey);
    if (!action) return;
    const group = button.dataset.groupId ? this.#groups.get(button.dataset.groupId) : null;
    if (group?.exhausted || action.groupExhausted) {
      ui.notifications.warn(game.i18n.localize("KHMH.Warnings.MultiattackSpent"));
    }
    if (action.exhausted || !action.canUse) {
      ui.notifications.warn(game.i18n.localize("KHMH.Warnings.ActionSpent"));
    }

    if (group) {
      this.#pendingUsage = {
        at: Date.now(),
        groupId: group.id,
        itemId: action.item.id,
        activityId: action.activity?.id ?? ""
      };
    }
    const pending = this.#pendingUsage;
    let result;
    let recordedByActivityHook = false;
    try {
      result = await useAction(action, event);
    } finally {
      recordedByActivityHook = Boolean(pending && this.#pendingUsage !== pending);
      if (this.#pendingUsage === pending) this.#pendingUsage = null;
    }
    // D&D5e emits postUseActivity synchronously before Item.use resolves. If
    // that hook consumed the pending marker it already recorded the use;
    // otherwise this covers Items without Activities.
    if (group && result && !action.hasActivities && !recordedByActivityHook) {
      await recordGroupUse(tokenDocument, group, action.ref);
    }
    this.requestRender();
  }

  async #setResource(actor, resourceKey, index, filled) {
    const resource = actor.system?.resources?.[resourceKey];
    const max = Math.max(0, Number(resource?.max) || 0);
    if (!max) return;
    const remaining = Math.max(0, Math.min(max, filled ? index - 1 : index));
    await actor.update({ [`system.resources.${resourceKey}.spent`]: max - remaining });
    this.requestRender();
  }

  async #toggleNameVisibility(tokenDocument) {
    const modes = globalThis.CONST?.TOKEN_DISPLAY_MODES;
    const hover = modes?.HOVER ?? 30;
    const ownerHover = modes?.OWNER_HOVER ?? 20;
    const displayName = tokenDocument.displayName === hover ? ownerHover : hover;
    await tokenDocument.update({ displayName }, {
      khuzoeMonsterHud: true,
      criptaWikiSyncCommand: true
    });
    this.requestRender();
  }

  #onDragStart(event) {
    if (event.button !== 0 || !event.target.closest(".khmh-header")) return;
    if (event.target.closest("button, input, select, textarea, a")) return;
    const rect = this.#root.getBoundingClientRect();
    this.#dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false
    };
    this.#root.classList.add("is-dragging");
    event.preventDefault();
  }

  #onDragMove(event) {
    const drag = this.#dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 3) return;
    drag.moved = true;
    this.#setManualPosition(drag.left + deltaX, drag.top + deltaY);
    event.preventDefault();
  }

  #onDragEnd(event) {
    const drag = this.#dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#dragState = null;
    this.#root?.classList.remove("is-dragging");
    if (!drag.moved || !this.#manualPosition) return;
    void game.settings.set(MODULE_ID, SETTINGS.POSITION, this.#manualPosition).catch(error => {
      console.error("Khuzoe Monster HUD | Failed to store HUD position.", error);
    });
  }

  #onHeaderDoubleClick(event) {
    if (!event.target.closest(".khmh-header") || event.target.closest("button, input, select, textarea, a")) return;
    this.#manualPosition = null;
    this.#root.style.removeProperty("--khmh-manual-left");
    this.#root.style.removeProperty("--khmh-manual-top");
    void game.settings.set(MODULE_ID, SETTINGS.POSITION, {}).then(() => this.requestRender());
  }

  #setManualPosition(left, top) {
    const rect = this.#root?.getBoundingClientRect();
    if (!rect) return;
    const maximumLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maximumTop = Math.max(8, window.innerHeight - rect.height - 8);
    this.#manualPosition = {
      left: Math.round(Math.max(8, Math.min(maximumLeft, left))),
      top: Math.round(Math.max(8, Math.min(maximumTop, top)))
    };
    this.#root.dataset.anchor = "manual";
    this.#root.style.setProperty("--khmh-manual-left", `${this.#manualPosition.left}px`);
    this.#root.style.setProperty("--khmh-manual-top", `${this.#manualPosition.top}px`);
  }

  #onContextMenu(event) {
    const button = event.target.closest('[data-action="useAction"]');
    if (!button) return;
    event.preventDefault();
    const action = this.#actions.get(button.dataset.actionKey);
    const sheet = action?.item?.sheet;
    if (!sheet?.render) return;
    const AppV2 = foundry.applications?.api?.ApplicationV2;
    if (AppV2 && sheet instanceof AppV2) sheet.render({ force: true });
    else sheet.render(true);
  }

  #initializeLayoutObservers() {
    const ResizeObserverClass = globalThis.ResizeObserver;
    const MutationObserverClass = globalThis.MutationObserver;
    if (typeof ResizeObserverClass === "function") this.#layoutObserver = new ResizeObserverClass(() => this.#applySafePosition());
    if (typeof MutationObserverClass === "function") {
      this.#mutationObserver = new MutationObserverClass(() => {
        this.#observeLayout();
        this.#applySafePosition();
      });
      const target = document.getElementById("interface") ?? document.body;
      this.#mutationObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    }
    this.#observeLayout();
  }

  #observeLayout() {
    if (!this.#layoutObserver) return;
    this.#layoutObserver.disconnect();
    for (const element of document.querySelectorAll("#scene-controls, #players, #sidebar, #sidebar-content, #hotbar, #khbb-root")) {
      this.#layoutObserver.observe(element);
    }
  }

  #applySafePosition() {
    const root = this.#root;
    if (!root || root.hidden) return;
    if (this.#manualPosition) {
      this.#setManualPosition(this.#manualPosition.left, this.#manualPosition.top);
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    let left = 12;
    let right = 12;
    let bottom = 12;

    for (const element of document.querySelectorAll("#scene-controls, #players")) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.left < width / 2) left = Math.max(left, rect.right + 12);
    }
    for (const element of document.querySelectorAll("#sidebar, #sidebar-content")) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.right > width / 2) right = Math.max(right, width - rect.left + 12);
    }
    for (const element of document.querySelectorAll("#hotbar, #khbb-root:not(.khbb-minimized)")) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top > height / 2) bottom = Math.max(bottom, height - rect.top + 12);
    }

    root.style.setProperty("--khmh-safe-left", `${left}px`);
    root.style.setProperty("--khmh-safe-right", `${right}px`);
    root.style.setProperty("--khmh-safe-bottom", `${bottom}px`);
  }
}

export function canUserAccessHudActor(actor, user) {
  if (!actor || !["npc", "character"].includes(actor.type)) return false;
  if (user?.isGM) return true;
  return Boolean(actor.isOwner);
}

function configuredSetting(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key) ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function abilityLabel(ability) {
  return localizeMaybe(CONFIG.DND5E.abilities?.[ability]?.label ?? ability);
}

function normalizePosition(value) {
  const left = Number(value?.left);
  const top = Number(value?.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top };
}

function localizeMaybe(value) {
  if (!value) return "";
  const localized = game.i18n.localize(value);
  return localized === value && !String(value).includes(".") ? value : localized;
}

function localize(key) {
  return game.i18n.localize(`KHMH.${key}`);
}

function isVisible(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
