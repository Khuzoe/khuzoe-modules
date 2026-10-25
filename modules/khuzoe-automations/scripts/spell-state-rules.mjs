import {runSyntheticActivityData} from "./activity-compat.mjs";
import {tokenDistanceFeet} from "./geometry.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE = "khuzoe-automations";
const values = collection => Array.from(collection?.values?.() ?? collection ?? []);
const doc = token => token?.document ?? token;
const active = effect => !effect.disabled && !effect.isSuppressed && effect.active !== false;
const state = effect => effect.flags?.[MODULE]?.expandedSpell ?? (effect.flags?.cat?.identifier === "khuzoe-death-ward" ? {identifier: "death-ward"} : {});
const hasSpell = (actor, identifiers) => values(actor?.effects).some(effect => active(effect) && identifiers.includes(state(effect).identifier));
const outlined = actor => hasSpell(actor, ["faerie-fire", "branding-smite"]);

/** Remove only the named source; retain Bless, prone, flanking and player choices. */
export function removeRollModifierSources(tracker, type, sources) {
  if (!tracker?.toJSON || !tracker.restore) return;
  const data = structuredClone(tracker.toJSON());
  const entries = data.attribution?.[type] ?? {};
  const removed = sources.filter(source => Object.hasOwn(entries, source));
  if (!removed.length) return;
  for (const source of removed) delete entries[source];
  const key = type === "ADV" ? "advantage" : "disadvantage";
  data[key].active = Boolean(Object.keys(entries).length || data[key].override);
  for (const field of ["legacyAttribution", "advReminderAttribution"]) {
    data[field] = (data[field] ?? []).filter(entry => !removed.some(source => entry === `${type}:${source}`));
  }
  tracker.restore(data);
}

function seesOutline(observer, target) {
  if (!observer?.actor || observer.actor.statuses?.has?.("blinded")) return false;
  const object = observer.object ?? observer;
  const targetObject = target?.object ?? target;
  if (!object.checkCollision || !targetObject.center) return false;
  return !object.checkCollision(targetObject.center, {type: "sight", mode: "any"});
}

function penetratesMoil(observer, target) {
  const sense = Number(observer?.actor?.system?.attributes?.senses?.ranges?.blindsight ?? 0);
  return sense > 0 && tokenDistanceFeet(observer, target) <= sense;
}

export async function applySpellSightRules(workflow) {
  const source = doc(workflow?.token), target = doc(values(workflow?.targets)[0]);
  if (!source || !target) return;
  const tracker = workflow.attackRollModifierTracker;
  if (outlined(target.actor)) {
    const removals = ["invisible foe"];
    if (seesOutline(source, target)) removals.push("Defender not detected");
    removeRollModifierSources(tracker, "DIS", removals);
    if (hasSpell(target.actor, ["faerie-fire"]) && seesOutline(source, target)) tracker?.advantage?.add(MODULE, "Faerie Fire");
  }
  if (outlined(source.actor)) {
    const removals = ["Attacker invisible"];
    if (seesOutline(target, source)) removals.push("Attacker not detected");
    removeRollModifierSources(tracker, "ADV", removals);
  }
  if (hasSpell(source.actor, ["shadow-of-moil"]) && !penetratesMoil(target, source)) tracker?.advantage?.add("khuzoe-moil", "Shadow of Moil");
  if (hasSpell(target.actor, ["shadow-of-moil"]) && !penetratesMoil(source, target)) tracker?.disadvantage?.add("khuzoe-moil", "Shadow of Moil");
  if (workflow.item?.system?.identifier === "khuzoe-shadow-blade-weapon") {
    const dim = await cat.utils.dialogUtils.confirm(workflow.item.name,
      "Il bersaglio si trova in luce fioca o oscurità?", {userId: cat.utils.queryUtils.firstOwner(workflow.actor, true)});
    if (dim) tracker?.advantage?.add("khuzoe-shadow-blade", "Shadow Blade: luce fioca/oscurità");
  }
}

export function restrictGaseousActions(activity) {
  if (activity?.item?.system?.identifier === "khuzoe-shadow-blade-weapon"
    && (!activity.item.system.equipped || Number(activity.item.system.quantity) === 0)) {
    ui.notifications.warn("Shadow Blade: richiama prima la lama con un’azione bonus.");
    return false;
  }
  if (!hasSpell(activity?.item?.actor, ["gaseous-form"])) return;
  if (activity.type === "attack" || activity.item.type === "spell") {
    ui.notifications.warn("Gaseous Form: termina la trasformazione prima di attaccare o lanciare incantesimi.");
    return false;
  }
}

export async function finishShadowBladeThrow(workflow) {
  if (workflow?.aborted || workflow?.item?.system?.identifier !== "khuzoe-shadow-blade-weapon") return;
  const mode = workflow.attackMode ?? workflow.attackRoll?.options?.attackMode ?? "";
  if (!mode.startsWith("thrown")) return;
  await updateDocumentSafely(workflow.item, {"system.equipped": false, "system.quantity": 0});
}

export async function breakCharmOnHarm(token, {workflow, damageItem} = {}) {
  const target = doc(token);
  if (!workflow || !(Number(damageItem?.hpDamage ?? 0) + Number(damageItem?.tempDamage ?? 0) > 0)) return;
  for (const effect of values(target?.actor?.effects)) {
    if (!active(effect) || state(effect).identifier !== "charm-person") continue;
    const source = await fromUuid(effect.origin);
    const caster = cat.utils.actorUtils.getFirstToken(source?.actor);
    const attacker = doc(workflow.token);
    if (attacker && caster && (attacker.actor?.uuid === source.actor?.uuid || (cat.utils.tokenUtils.isAlly?.(doc(caster), attacker) ?? (doc(caster).disposition === attacker.disposition)))) {
      await cat.utils.documentUtils.deleteDocument(effect);
    }
  }
}

const RELEASES = {"tashas-caustic-brew": "Rimuovi l’acido", "rimes-binding-ice": "Rompi il ghiaccio", "hypnotic-pattern": "Scuoti la creatura"};

export function enhanceSpellActions(app, section) {
  const actor = app?.document ?? app?.actor ?? app?.object;
  if (!actor?.isOwner || section.querySelector?.('[data-khuzoe-action="spell-release"]')) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.khuzoeAction = "spell-release";
  button.textContent = "Aiuta / termina un effetto";
  button.addEventListener("click", async event => {
    event.preventDefault();
    const source = doc(cat.utils.actorUtils.getFirstToken(actor));
    if (!source) return;
    const choices = [];
    for (const target of values(source.parent.tokens)) {
      if (!target.actor || tokenDistanceFeet(source, target) > 5) continue;
      for (const effect of values(target.actor.effects)) {
        if (!active(effect)) continue;
        const identifier = state(effect).identifier;
        if (RELEASES[identifier]) choices.push({target, effect, label: `${target.name}: ${RELEASES[identifier]}`, action: true});
        if (target.actor.uuid === actor.uuid && identifier === "shadow-blade" && state(effect).itemUuid) {
          const weapon = await fromUuid(state(effect).itemUuid);
          if (weapon) {
            const recall = !weapon.system.equipped || Number(weapon.system.quantity) === 0;
            choices.push({target, effect, weapon, recall, label: recall ? "Shadow Blade: richiama la lama (azione bonus)" : "Shadow Blade: lascia cadere la lama", action: recall ? "bonus" : false});
          }
        }
        if (target.actor.uuid === actor.uuid && ["gaseous-form", "death-ward"].includes(identifier)) {
          choices.push({target, effect, label: identifier === "death-ward" ? "Death Ward: annulla morte istantanea senza danno" : "Termina Gaseous Form", action: false});
        }
      }
    }
    if (!choices.length) return ui.notifications.info("Nessun effetto pertinente entro 5 piedi.");
    const selected = await cat.utils.dialogUtils.buttonDialog("Termina un effetto", "Scegli l’intervento da effettuare.",
      choices.map(choice => [choice.label, choice.effect.uuid]), {displayAsRows: true});
    const choice = choices.find(entry => entry.effect.uuid === selected);
    if (!choice) return;
    if (choice.action) {
      if (hasSpell(actor, ["gaseous-form"])) return ui.notifications.warn("Gaseous Form: non puoi manipolare oggetti o creature.");
      if (values(actor.statuses).some(status => ["incapacitated", "unconscious", "stunned", "paralyzed", "dead"].includes(status))) {
        return ui.notifications.warn("Questa creatura non può compiere l’azione; deve aiutarla un’altra creatura.");
      }
      const activity = {_id: "KhzReleaseAct001", name: choice.label, type: "utility",
        activation: {type: choice.action === "bonus" ? "bonus" : "action", value: 1, override: true}, consumption: {targets: [], spellSlot: false},
        duration: {units: "inst", override: true}, range: {units: "any", override: true},
        target: {override: true, prompt: false, affects: {type: "creature", count: "1"}, template: {}}, effects: []};
      const item = cat.utils.itemUtils.syntheticItem({name: choice.label, type: "feat",
        system: {identifier: "khuzoe-release-effect", activities: {[activity._id]: activity}}}, actor);
      const result = await runSyntheticActivityData(activity, item, [choice.target], {config: {consume: {action: true}}});
      if (!result || result.aborted) return;
    }
    if (choice.weapon) await updateDocumentSafely(choice.weapon, {"system.equipped": choice.recall, "system.quantity": choice.recall ? 1 : 0});
    else await cat.utils.documentUtils.deleteDocument(choice.effect);
  });
  section.append(button);
}
