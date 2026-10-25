import {RELEASE_VERSION} from "./release.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;

export const CREATE_BONFIRE_IDENTIFIER = "create-bonfire";
export const CREATE_BONFIRE_UUID = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item.KhzBonfireAuto01";
export const CREATE_BONFIRE_CAST_ACTIVITY_ID = "KhzBonfireCast01";
export const CREATE_BONFIRE_DAMAGE_ACTIVITY_ID = "KhzBonfireDmg001";
export const CREATE_BONFIRE_DAMAGE_IDENTIFIER = "khuzoe-create-bonfire-damage";

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function isRegion(document) {
  return document?.documentName === "Region" || document?.constructor?.documentName === "Region";
}

async function resolveBonfireRegion(workflow) {
  if (isRegion(workflow?.template)) return workflow.template;
  if (isRegion(workflow?.template?.document)) return workflow.template.document;

  const uuids = new Set([
    ...values(workflow?.templateUuids),
    workflow?.templateUuid
  ].filter(Boolean));

  for (const uuid of uuids) {
    const document = await globalThis.fromUuid?.(uuid);
    if (isRegion(document)) return document;

    const region = globalThis.canvas?.scene?.regions?.get?.(document?.id ?? document?._id);
    if (isRegion(region)) return region;
  }
}

function concentrationEffect(actor, item) {
  const configuredStatus = globalThis.CONFIG?.specialStatusEffects?.CONCENTRATING;
  return values(actor?.effects).find(effect => {
    const statuses = effect?.statuses;
    const concentrating = statuses?.has?.("concentrating")
      || (configuredStatus && statuses?.has?.(configuredStatus))
      || values(statuses).includes("concentrating")
      || (configuredStatus && values(statuses).includes(configuredStatus));
    if (!concentrating) return false;

    const sourceItem = effect.flags?.dnd5e?.item;
    if (!item?.id) return true;
    return sourceItem?.id === item.id
      || sourceItem?.uuid === item.uuid
      || effect.origin === item.uuid;
  });
}

async function setConcentrationDependency(region, effect) {
  if (!region || !effect?.uuid) return false;
  if (region.flags?.dnd5e?.dependentOn === effect.uuid) return true;

  if (globalThis.cat?.utils?.documentUtils?.update || typeof region.update === "function") {
    await updateDocumentSafely(region, {"flags.dnd5e.dependentOn": effect.uuid});
    return true;
  }

  if (typeof region.setFlag === "function") {
    await region.setFlag("dnd5e", "dependentOn", effect.uuid);
    return true;
  }
  return false;
}

/**
 * Collega la Region creata dal lancio all'effetto di concentrazione nativo.
 * D&D5e elimina automaticamente i documenti con flags.dnd5e.dependentOn
 * quando la concentrazione termina; Midi-QOL fa anche l'inverso quando il GM
 * cancella manualmente la Region.
 */
export async function linkCreateBonfireConcentration({workflow, activity, actor, item} = {}) {
  if (activity?.id !== CREATE_BONFIRE_CAST_ACTIVITY_ID) return false;

  actor ??= workflow?.actor;
  item ??= workflow?.item;
  const region = await resolveBonfireRegion(workflow);
  if (!actor || !item || !region) return false;

  const effect = concentrationEffect(actor, item);
  if (!effect) {
    if (globalThis.game?.user?.isGM || actor.isOwner) {
      globalThis.ui?.notifications?.warn?.(
        `${item.name}: il falò è stato creato, ma non è stato trovato l'effetto di concentrazione da collegare.`
      );
    }
    return false;
  }

  const addConcentrationDependent = globalThis.MidiQOL?.addConcentrationDependent;
  if (typeof addConcentrationDependent === "function") {
    await addConcentrationDependent(actor, region, item);
    return true;
  }
  return setConcentrationDependency(region, effect);
}

export function prepareCreateBonfireItemUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (identifier !== CREATE_BONFIRE_IDENTIFIER) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
}

export const CREATE_BONFIRE_AUTOMATION = Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: CREATE_BONFIRE_IDENTIFIER,
  version: VERSION,
  uuid: CREATE_BONFIRE_UUID,
  type: "spell",
  notes: "Crea una Region di 1,5 m collegata alla concentrazione. Applica il TS Des e il danno da fuoco al lancio, al primo ingresso nel turno e alla fine del turno nell'area, con scalabilità automatica del trucchetto."
});

export function registerCreateBonfire(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: CREATE_BONFIRE_IDENTIFIER,
      roll: [
        {
          pass: "itemRollFinished",
          macro: linkCreateBonfireConcentration,
          priority: 90
        }
      ]
    })
  ];
  return {macros, automations: [api.registerAutomation(CREATE_BONFIRE_AUTOMATION)]};
}
