import {RELEASE_VERSION} from "./release.mjs";
import {reserveResources, refundResources} from "./resource-transactions.mjs";
import {applyResolvedDamage} from "./resolved-damage.mjs";
import {setDocumentFlagSafely} from "./cat-compat.mjs";
import {healActor} from "./healing.mjs";
import {withDocumentLock} from "./operation-locks.mjs";

const MODULE_ID = "khuzoe-automations";
const MODULE_TITLE = "Khuzoe Automations";
const RULES = "2014";
const WILD_SHAPE_VERSION = RELEASE_VERSION;
const WILD_SHAPE_UUID = "Compendium.khuzoe-automations.KhuzoeClassFeatures2014.Item.KhzWildShapeA001";
const WILD_SHAPE_ACTIVITY_ID = "KhzWildShapeU001";
export const HEALING_ACTIVITY_ID = "KhzWildShapeHeal";
const WORLD_SOURCES_SETTING = "wildShapeWorldSources";
const ACTOR_FLAG = "wildShapeConfig";
const STATE_FLAG = "wildShape";
const CONTROLLER_IDENTIFIER = "khuzoe-wild-shape-controller";
const HEALING_IDENTIFIER = "combat-wild-shape-healing";
const DEFAULT_WORLD_SOURCES = Object.freeze({
  packs: ["dnd5e.monsters"],
  folders: []
});

const ELEMENTAL_NAMES = new Set([
  "air-elemental",
  "earth-elemental",
  "fire-elemental",
  "water-elemental",
  "elementale-dell-aria",
  "elementale-della-terra",
  "elementale-del-fuoco",
  "elementale-dell-acqua"
]);

const featureAliases = Object.freeze({
  wildShape: ["wild-shape", "forma-selvatica"],
  circleForms: ["circle-forms", "forme-del-circolo"],
  combatWildShape: ["combat-wild-shape", "forma-selvatica-da-combattimento"],
  primalStrike: ["primal-strike", "colpo-primordiale"],
  elementalWildShape: ["elemental-wild-shape", "forma-selvatica-elementale"],
  beastSpells: ["beast-spells", "incantesimi-bestiali"],
  archdruid: ["archdruid", "arcidruido"]
});

const applicationApi = globalThis.foundry?.applications?.api;
const ApplicationV2 = applicationApi?.ApplicationV2 ?? class {};
const HandlebarsApplicationV2 = applicationApi?.HandlebarsApplicationMixin?.(ApplicationV2) ?? ApplicationV2;

let wildShapeSocket = null;
const revertGuards = new Set();

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection === "object" && !collection[Symbol.iterator]) return Object.values(collection);
  return Array.from(collection);
}

function slug(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function documentIdentifier(document) {
  return slug(document?.system?.identifier || document?.name);
}

function actorHasFeature(actor, key) {
  const aliases = new Set(featureAliases[key] ?? []);
  return values(actor?.items).some(item => aliases.has(documentIdentifier(item)));
}

export function getDruidLevel(actor) {
  const direct = Number(actor?.classes?.druid?.system?.levels);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  const druid = values(actor?.items).find(item =>
    item?.type === "class" && ["druid", "druido"].includes(documentIdentifier(item))
  );
  const level = Number(druid?.system?.levels ?? 0);
  return Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

export function getWildShapeLimits(actor) {
  const level = getDruidLevel(actor);
  const combatWildShape = actorHasFeature(actor, "combatWildShape");
  const elementalWildShape = actorHasFeature(actor, "elementalWildShape");
  const moon = actorHasFeature(actor, "circleForms") || combatWildShape || elementalWildShape;
  let maxCr = level >= 8 ? 1 : level >= 4 ? 0.5 : 0.25;
  if (moon) maxCr = Math.max(1, Math.floor(level / 3));
  return {
    level,
    maxCr,
    forbidSwim: level < 4,
    forbidFly: level < 8,
    moon,
    combatWildShape,
    primalStrike: level >= 6 && actorHasFeature(actor, "primalStrike"),
    elementalWildShape: level >= 10 && elementalWildShape,
    beastSpells: level >= 18 && actorHasFeature(actor, "beastSpells"),
    archdruid: level >= 20 && actorHasFeature(actor, "archdruid")
  };
}

function normalizeSources(raw, fallback = DEFAULT_WORLD_SOURCES) {
  const value = raw && typeof raw === "object" ? raw : fallback;
  return {
    packs: Array.from(new Set((Array.isArray(value.packs) ? value.packs : fallback.packs).map(String).filter(Boolean))),
    folders: Array.from(new Set((Array.isArray(value.folders) ? value.folders : fallback.folders).map(String).filter(Boolean)))
  };
}

function worldSources() {
  try {
    return normalizeSources(game.settings.get(MODULE_ID, WORLD_SOURCES_SETTING));
  } catch (_error) {
    return normalizeSources(DEFAULT_WORLD_SOURCES);
  }
}

export function resolveWildShapeSourceConfig({itemConfig, actorConfig, worldConfig = DEFAULT_WORLD_SOURCES} = {}) {
  const hasItemConfig = itemConfig && typeof itemConfig === "object";
  const hasActorConfig = actorConfig && typeof actorConfig === "object";
  const raw = hasItemConfig ? itemConfig : hasActorConfig ? actorConfig : {};
  const inherited = raw.inherit !== false;
  const selected = inherited
    ? normalizeSources(worldConfig)
    : normalizeSources(raw, {packs: [], folders: []});
  return {
    inherit: inherited,
    ...selected,
    knownOnly: Boolean(raw.knownOnly),
    knownForms: Array.from(new Set((Array.isArray(raw.knownForms) ? raw.knownForms : []).map(String).filter(Boolean))),
    scope: hasItemConfig ? "item" : hasActorConfig ? "actor" : "world"
  };
}

function storedSourceConfig(document) {
  return document?.getFlag?.(MODULE_ID, ACTOR_FLAG)
    ?? document?.flags?.[MODULE_ID]?.[ACTOR_FLAG]
    ?? null;
}

function itemSourceConfig(item, actor = item?.actor) {
  return resolveWildShapeSourceConfig({
    itemConfig: storedSourceConfig(item),
    // Compatibilità non distruttiva con le configurazioni salvate dalla v0.5.x
    // sull'attore: vengono copiate sull'abilità al primo salvataggio.
    actorConfig: storedSourceConfig(actor),
    worldConfig: worldSources()
  });
}

function folderIncludes(folder, selected) {
  for (let current = folder; current; current = current.folder ?? current.parent) {
    if (selected.has(current.id)) return true;
  }
  return false;
}

function actorTypeValue(actor) {
  const type = actor?.system?.details?.type;
  if (typeof type === "string") return slug(type);
  return slug(type?.value === "custom" ? type?.custom : type?.value ?? type?.custom);
}

function movementValue(actor, type) {
  const raw = actor?.system?.attributes?.movement?.[type] ?? actor?.system?.movement?.[type] ?? 0;
  const value = Number(typeof raw === "object" ? raw?.value : raw);
  return Number.isFinite(value) ? value : 0;
}

function formData(actor, sourceLabel = "Mondo") {
  const cr = Number(actor?.system?.details?.cr ?? 0);
  const movement = {
    walk: movementValue(actor, "walk"),
    swim: movementValue(actor, "swim"),
    fly: movementValue(actor, "fly"),
    climb: movementValue(actor, "climb"),
    burrow: movementValue(actor, "burrow")
  };
  const type = actorTypeValue(actor);
  const nameSlug = slug(actor?.name);
  return {
    uuid: actor?.uuid,
    name: actor?.name ?? "Forma senza nome",
    img: actor?.img || actor?.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg",
    cr: Number.isFinite(cr) ? cr : 0,
    size: actor?.system?.traits?.size || "med",
    type,
    movement,
    sourceLabel,
    elemental: type === "elemental" && ELEMENTAL_NAMES.has(nameSlug)
  };
}

async function collectSourceForms(actor, sources = itemSourceConfig(null, actor)) {
  const forms = new Map();
  for (const collection of sources.packs) {
    const pack = game.packs.get(collection);
    if (!pack || (pack.documentName !== "Actor" && pack.metadata?.type !== "Actor")) continue;
    try {
      const index = await pack.getIndex({fields: [
        "img",
        "type",
        "system.details.cr",
        "system.details.type",
        "system.traits.size",
        "system.attributes.movement",
        "prototypeToken.texture.src"
      ]});
      for (const document of values(index)) {
        if (document?.type !== "npc" || !document.uuid) continue;
        const data = formData(document, pack.metadata?.label ?? pack.title ?? collection);
        if (data.type !== "beast" && !data.elemental) continue;
        forms.set(document.uuid, data);
      }
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Compendio Wild Shape non leggibile: ${collection}.`, error);
    }
  }

  const selectedFolders = new Set(sources.folders);
  if (selectedFolders.size) {
    for (const document of values(game.actors)) {
      if (document?.type !== "npc" || !document.uuid || !folderIncludes(document.folder, selectedFolders)) continue;
      const data = formData(document, document.folder?.name ?? "Attori del mondo");
      if (data.type !== "beast" && !data.elemental) continue;
      forms.set(document.uuid, data);
    }
  }
  return Array.from(forms.values()).sort((left, right) =>
    left.name.localeCompare(right.name, game.i18n?.lang ?? "it", {sensitivity: "base"})
  );
}

export function isEligibleWildShapeForm(form, limits, {remainingUses = Infinity, knownOnly = false, knownForms = []} = {}) {
  if (!form?.uuid || !limits || limits.level < 2) return false;
  if (knownOnly && !new Set(knownForms).has(form.uuid)) return false;
  if (form.elemental) return limits.elementalWildShape && remainingUses >= 2;
  if (form.type !== "beast") return false;
  if (Number(form.cr ?? 0) > Number(limits.maxCr ?? 0)) return false;
  if (limits.forbidSwim && Number(form.movement?.swim ?? 0) > 0) return false;
  if (limits.forbidFly && Number(form.movement?.fly ?? 0) > 0) return false;
  return remainingUses >= 1;
}

function itemUsesRemaining(item) {
  const max = Number(item?.system?.uses?.max ?? 2);
  const spent = Number(item?.system?.uses?.spent ?? 0);
  if (!Number.isFinite(max)) return Infinity;
  return Math.max(0, max - (Number.isFinite(spent) ? spent : 0));
}

function isWildShapeAbility(item) {
  if (featureAliases.wildShape.includes(documentIdentifier(item))) return true;
  return values(item?.flags?.cat?.macros?.roll).some(macro =>
    macro?.source === MODULE_ID && macro?.identifier === "wild-shape"
  );
}

function findWildShapeItem(actor) {
  return values(actor?.items).find(isWildShapeAbility);
}

function findWildShapeItems(actor) {
  return values(actor?.items).filter(isWildShapeAbility);
}

async function listEligibleForms(actor, wildShapeItem = findWildShapeItem(actor)) {
  const limits = getWildShapeLimits(actor);
  const config = itemSourceConfig(wildShapeItem, actor);
  const remainingUses = limits.archdruid ? Infinity : itemUsesRemaining(wildShapeItem);
  const forms = await collectSourceForms(actor, config);
  return {
    limits,
    remainingUses,
    forms: forms.filter(form => isEligibleWildShapeForm(form, limits, {
      remainingUses,
      knownOnly: config.knownOnly,
      knownForms: config.knownForms
    })).map(form => ({
      ...form,
      known: config.knownForms.includes(form.uuid),
      cost: form.elemental ? 2 : 1
    }))
  };
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function actorFromUuidDocument(document) {
  if (document?.documentName === "Token") return document.actor;
  if (document?.documentName === "Actor") return document;
  return document?.actor ?? null;
}

async function resolveWildShapeItem(actor, {itemUuid = "", itemId = ""} = {}) {
  let item = null;
  if (itemUuid) {
    try { item = await fromUuid(itemUuid); }
    catch (_error) { item = null; }
  }
  if (item?.documentName === "Item") return item;
  return actor?.items?.get?.(itemId) ?? findWildShapeItem(actor);
}

async function resolveActorReference(uuid) {
  const document = await fromUuid(uuid);
  return actorFromUuidDocument(document);
}

export function getWildShapeKeepOptions(presetKeep, limits = {}) {
  const keep = new Set(presetKeep ?? []);

  // Nelle regole 2014 i PF della forma sono un bacino separato. Anche i PF
  // temporanei dell'attore originale devono restare sul documento originale:
  // se "tempHP" rimane attivo, al revert D&D5e copia invece il valore della
  // bestia (normalmente 0) e cancella quelli posseduti prima della trasformazione.
  for (const option of ["hp", "tempHP", "languages", "type", "spells"]) keep.delete(option);
  if (limits.beastSpells || limits.archdruid) keep.add("spells");
  return keep;
}

function transformationSettings(actor) {
  const TransformationSetting = globalThis.dnd5e?.dataModels?.settings?.TransformationSetting;
  if (typeof TransformationSetting !== "function") throw new Error("API di trasformazione D&D5e non disponibile.");

  const preset = CONFIG.DND5E?.transformation?.presets?.wildshape?.settings ?? {};
  const effects = new Set(preset.effects ?? []);
  const merge = new Set(preset.merge ?? []);
  const other = new Set(preset.other ?? []);

  // L'automazione applica sempre le regole 2014, anche in mondi che ospitano
  // contemporaneamente documenti con regole moderne.
  const limits = getWildShapeLimits(actor);
  const keep = getWildShapeKeepOptions(preset.keep, limits);
  const spellLists = new Set();

  return new TransformationSetting({
    effects,
    keep,
    merge,
    // La CA minima 13 + Saggezza appartiene al Circle of the Moon 2024.
    // Non deve contaminare questa automazione 2014.
    minimumAC: "",
    other,
    preset: "wildshape",
    spellLists,
    tempFormula: "",
    transformTokens: true
  });
}

function wildShapeState(actor, source, item, limits, cost) {
  return {
    active: true,
    originalActorId: actor.id,
    originalActorUuid: actor.uuid,
    sourceUuid: source.uuid,
    sourceName: source.name,
    itemId: item?.id ?? "",
    itemUuid: item?.uuid ?? "",
    druidLevel: limits.level,
    beastSpells: limits.beastSpells,
    archdruid: limits.archdruid,
    cost,
    startedAt: Date.now(),
    reverting: false
  };
}

function transformedActorFromResult(result, originalActorId) {
  const documents = Array.isArray(result) ? result : [result];
  for (const document of documents) {
    const actor = actorFromUuidDocument(document);
    if (actor?.flags?.dnd5e?.isPolymorphed) return actor;
  }
  return values(game.actors).find(actor =>
    actor?.flags?.dnd5e?.isPolymorphed
    && actor?.flags?.dnd5e?.originalActor === originalActorId
    && actor?.flags?.[MODULE_ID]?.[STATE_FLAG]?.active
  ) ?? null;
}

function controllerEffectData(item, limits, source) {
  const hours = Math.max(1, Math.floor(limits.level / 2));
  return {
    name: `Wild Shape — ${source.name}`,
    img: item?.img || source.img || "icons/creatures/mammals/wolf-howl-moon-black.webp",
    origin: item?.uuid ?? null,
    type: "base",
    description: `<p>Forma selvatica attiva. Durata massima: <strong>${hours} ore</strong>. Eliminando questo effetto torni alla forma originale.</p>`,
    duration: {
      value: hours * 3600,
      units: "seconds",
      expiry: "turnStart",
      expired: false
    },
    showIcon: 1,
    flags: {
      cat: {identifier: CONTROLLER_IDENTIFIER},
      [MODULE_ID]: {wildShapeController: true},
      dae: {stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}
    }
  };
}

function combatHealingItemData(wildShapeItem) {
  return {
    name: "Combat Wild Shape — Guarigione",
    type: "feat",
    img: wildShapeItem?.img || "icons/magic/life/heart-cross-strong-flame-green.webp",
    system: {
      description: {
        value: "<p>Come azione bonus spendi uno slot incantesimo per recuperare 1d8 punti ferita per livello dello slot.</p>",
        chat: ""
      },
      source: {custom: "Khuzoe Automations", book: "", page: "", license: "", rules: RULES},
      uses: {max: "", spent: 0, recovery: []},
      type: {value: "class", subtype: ""},
      properties: [],
      requirements: "Circle of the Moon 2",
      prerequisites: {level: 2},
      identifier: HEALING_IDENTIFIER,
      activities: {
        [HEALING_ACTIVITY_ID]: {
          _id: HEALING_ACTIVITY_ID,
          type: "utility",
          activation: {type: "bonus", value: 1, condition: "", override: true},
          consumption: {targets: [], scaling: {allowed: false, max: ""}, spellSlot: false},
          description: {chatFlavor: "Combat Wild Shape — Guarigione"},
          duration: {value: "", units: "inst", concentration: false, override: true},
          effects: [],
          range: {value: null, units: "self", special: "", override: true},
          target: {
            prompt: false,
            template: {count: "", contiguous: false, type: "", size: "", width: "", height: "", units: "ft"},
            affects: {count: "", type: "self", choice: false, special: ""},
            override: true
          },
          roll: {formula: "", name: "", prompt: false, visible: false},
          uses: {spent: 0, recovery: [], max: ""},
          sort: 0,
          name: "Guarigione",
          img: "",
          visibility: {level: {min: null, max: null}},
          flags: {}
        }
      },
      enchant: {}
    },
    effects: [],
    flags: {
      cat: {
        automation: {source: MODULE_ID, version: WILD_SHAPE_VERSION},
        macros: {roll: [{source: MODULE_ID, rules: RULES, identifier: HEALING_IDENTIFIER}]}
      },
      [MODULE_ID]: {temporaryWildShapeItem: true}
    }
  };
}

function isAttackActivity(activity) {
  return activity?.type === "attack" || String(activity?.actionType ?? "").includes("wak");
}

async function prepareTransformedActor(transformedActor, originalItem, source, limits, state) {
  if (!transformedActor) throw new Error("La forma trasformata non è stata trovata.");

  await transformedActor.update({
    [`flags.${MODULE_ID}.${STATE_FLAG}`]: state
  }, {khuzoeWildShape: true, criptaWikiSyncCommand: true});

  const itemUpdates = [];
  const retainedWildShape = transformedActor.items?.get?.(originalItem?.id) ?? findWildShapeItem(transformedActor);
  if (retainedWildShape) {
    itemUpdates.push({
      _id: retainedWildShape.id,
      [`system.activities.${WILD_SHAPE_ACTIVITY_ID}.activation.type`]: "bonus",
      [`system.activities.${WILD_SHAPE_ACTIVITY_ID}.name`]: "Ritorna alla forma originale"
    });
  }

  if (limits.primalStrike) {
    for (const item of values(transformedActor.items)) {
      if (item.id === retainedWildShape?.id || item.flags?.[MODULE_ID]?.temporaryWildShapeItem) continue;
      if (!["weapon", "feat"].includes(item.type)) continue;
      if (!values(item.system?.activities).some(isAttackActivity)) continue;
      const properties = new Set(item.system?.properties ?? []);
      properties.add("mgc");
      itemUpdates.push({
        _id: item.id,
        "system.properties": Array.from(properties),
        "flags.midiProperties.magicdam": true,
        [`flags.${MODULE_ID}.primalStrike`]: true
      });
    }
  }
  if (itemUpdates.length) {
    await transformedActor.updateEmbeddedDocuments("Item", itemUpdates, {
      khuzoeWildShape: true,
      criptaWikiSyncCommand: true
    });
  }

  if (limits.combatWildShape && !values(transformedActor.items).some(item => documentIdentifier(item) === HEALING_IDENTIFIER)) {
    await transformedActor.createEmbeddedDocuments("Item", [combatHealingItemData(originalItem)], {
      khuzoeWildShape: true,
      criptaWikiSyncCommand: true
    });
  }

  await transformedActor.createEmbeddedDocuments("ActiveEffect", [controllerEffectData(originalItem, limits, source)], {
    khuzoeWildShape: true,
    criptaWikiSyncCommand: true
  });
}

async function spendWildShapeUses(item, cost, transformedActor, limits) {
  if (!item || limits.archdruid || cost <= 0) return;
  const receipt = await reserveResources(item.actor, {item, amount: cost});
  if (!receipt) throw new Error("Utilizzi di Wild Shape insufficienti.");
  const copied = transformedActor?.items?.get?.(item.id) ?? findWildShapeItem(transformedActor);
  try { if (copied) {
    await copied.update({"system.uses.spent": Number(item.system.uses.spent)}, {
      khuzoeWildShape: true,
      criptaWikiSyncCommand: true
    });
  } } catch (error) { await refundResources(receipt); throw error; }
}

async function performWildShapeTransform({actorUuid, sourceUuid, itemUuid, itemId = ""}) {
  return withDocumentLock({uuid: actorUuid}, "wild-shape-transform", () => performWildShapeTransformLocked({actorUuid, sourceUuid, itemUuid, itemId}));
}

async function performWildShapeTransformLocked({actorUuid, sourceUuid, itemUuid, itemId = ""}) {
  const actor = await resolveActorReference(actorUuid);
  const source = await fromUuid(sourceUuid);
  const item = await resolveWildShapeItem(actor, {itemUuid, itemId});
  if (!actor || !source || !item) throw new Error("Attore, forma o capacità Wild Shape non disponibile.");
  if (actor.isPolymorphed) throw new Error("L'attore è già trasformato.");

  const available = await listEligibleForms(actor, item);
  const selected = available.forms.find(form => form.uuid === sourceUuid);
  if (!selected) throw new Error("La forma scelta non è consentita per questo druido o non appartiene alle sorgenti configurate.");
  const cost = selected.cost;
  const state = wildShapeState(actor, source, item, available.limits, cost);
  let transformedActor = null;
  try {
    const result = await actor.transformInto(source, transformationSettings(actor), {
      renderSheet: false,
      khuzoeWildShape: state
    });
    transformedActor = transformedActorFromResult(result, actor.id);
    if (!transformedActor) {
      transformedActor = values(game.actors).find(candidate =>
        candidate.flags?.dnd5e?.isPolymorphed
        && candidate.flags?.dnd5e?.originalActor === actor.id
      );
    }
    await prepareTransformedActor(transformedActor, item, source, available.limits, state);
    await spendWildShapeUses(item, cost, transformedActor, available.limits);
    return {ok: true, actorUuid: transformedActor.uuid, sourceName: source.name, cost};
  } catch (error) {
    if (transformedActor?.isPolymorphed) {
      try { await transformedActor.revertOriginalForm({renderSheet: false}); }
      catch (revertError) { console.error(`${MODULE_TITLE} | Rollback Wild Shape non riuscito.`, revertError); }
    }
    throw error;
  }
}

async function performWildShapeRevert({actorUuid, overflow = 0}) {
  const actor = await resolveActorReference(actorUuid);
  if (!actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return {ok: false};
  if (revertGuards.has(actor.uuid)) return {ok: false, pending: true};

  revertGuards.add(actor.uuid);
  try {
    await actor.update({[`flags.${MODULE_ID}.${STATE_FLAG}.reverting`]: true}, {
      khuzoeWildShape: true,
      criptaWikiSyncCommand: true
    });
    const original = await actor.revertOriginalForm({renderSheet: false});
    const originalActor = actorFromUuidDocument(original);
    const excess = Math.max(0, Math.floor(Number(overflow) || 0));
    if (originalActor && excess > 0) {
      const token = globalThis.cat.utils.actorUtils.getFirstToken(originalActor);
      const sourceItem = values(originalActor.items).find(item => item.system?.identifier === "wild-shape");
      const applied = await applyResolvedDamage(originalActor, excess, {token, sourceItem, origin: "wild-shape-overflow"});
      if (!applied) throw new Error("Wild Shape: danno eccedente non applicato; riprova dalla scheda danni.");
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({actor: originalActor}),
        content: `<p><strong>Wild Shape:</strong> ${excess} danni eccedenti applicati alla forma originale.</p>`
      });
    }
    return {ok: true, actorUuid: originalActor?.uuid ?? "", overflow: excess};
  } finally {
    revertGuards.delete(actor.uuid);
  }
}

export function wildShapeOverflowUpdate(actor, overflow) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const amount = Math.max(0, Math.floor(Number(overflow) || 0));
  const currentTemp = Math.max(0, Number(hp.temp ?? 0));
  const absorbedByTemp = Math.min(currentTemp, amount);
  const hpDamage = amount - absorbedByTemp;
  return {
    "system.attributes.hp.temp": currentTemp - absorbedByTemp,
    "system.attributes.hp.value": Math.max(0, Number(hp.value ?? 0) - hpDamage)
  };
}

async function requestAsGm(handler, payload) {
  if (game.user?.isGM) {
    if (handler === "transform") return performWildShapeTransform(payload);
    if (handler === "revert") return performWildShapeRevert(payload);
    if (handler === "forms") {
      const actor = await resolveActorReference(payload.actorUuid);
      if (!actor) throw new Error("Attore non disponibile.");
      const item = await resolveWildShapeItem(actor, payload);
      return listEligibleForms(actor, item);
    }
  }
  if (!wildShapeSocket) throw new Error("Connessione al GM non pronta. Verifica che sia presente un GM attivo.");
  const action = handler === "transform" ? "performWildShapeTransform"
    : handler === "revert" ? "performWildShapeRevert"
      : "listWildShapeForms";
  return wildShapeSocket.executeAsGM(action, payload);
}

class WildShapePicker extends HandlebarsApplicationV2 {
  #forms;
  #actorName;
  #limits;
  #resolve;
  #settled = false;

  constructor({forms, actorName, limits, resolve}, options = {}) {
    super(options);
    this.#forms = forms;
    this.#actorName = actorName;
    this.#limits = limits;
    this.#resolve = resolve;
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-wild-shape-picker",
    tag: "form",
    classes: ["khuzoe-automations", "khz-wild-shape-picker"],
    position: {width: 720, height: 720},
    window: {icon: "fa-solid fa-paw", resizable: true},
    form: {closeOnSubmit: false, handler: WildShapePicker._onSubmit},
    actions: {selectForm: WildShapePicker._onSelect}
  };

  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/wild-shape-picker.hbs`}
  };

  static _onSubmit(event) { return this.#select(event); }
  static _onSelect(event) { return this.#select(event); }

  get title() { return `Wild Shape — ${this.#actorName}`; }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      actorName: this.#actorName,
      maxCr: this.#limits.maxCr,
      forms: this.#forms.map((form, index) => ({
        ...form,
        index,
        movementLabel: Object.entries(form.movement)
          .filter(([, speed]) => Number(speed) > 0)
          .map(([type, speed]) => `${type.toUpperCase()} ${speed}`)
          .join(" · ") || "—"
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const search = this.element?.querySelector?.("[data-wild-shape-search]");
    search?.addEventListener("input", () => {
      const query = slug(search.value);
      for (const card of this.element.querySelectorAll("[data-form-card]")) {
        card.hidden = Boolean(query && !slug(card.dataset.search).includes(query));
      }
    });
  }

  async #select(event) {
    event?.preventDefault?.();
    const uuid = new FormData(this.form).get("formUuid");
    const selected = this.#forms.find(form => form.uuid === uuid);
    if (!selected) {
      ui.notifications.warn("Seleziona una forma valida.");
      return;
    }
    this.#finish(selected);
    return this.close();
  }

  #finish(result) {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(result);
  }

  async close(options = {}) {
    this.#finish(null);
    return super.close(options);
  }
}

function chooseForm(data, actorName) {
  return new Promise(resolve => {
    new WildShapePicker({...data, actorName, resolve}).render({force: true});
  });
}

async function prepareWildShapeUse({workflow, actor, item}) {
  actor ??= workflow?.actor;
  item ??= workflow?.item;
  if (!actor || !item || !workflow) return true;

  if (actor.isPolymorphed) {
    if (!actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) {
      ui.notifications.warn("L'attore è già trasformato da un altro effetto.");
      return true;
    }
    return;
  }

  const level = getDruidLevel(actor);
  if (level < 2) {
    ui.notifications.warn("Wild Shape richiede almeno 2 livelli da druido.");
    return true;
  }

  try {
    const actorReference = tokenDocument(workflow?.token)?.uuid ?? actor.uuid;
    const data = await requestAsGm("forms", {
      actorUuid: actorReference,
      itemUuid: item.uuid,
      itemId: item.id
    });
    if (!data?.forms?.length) {
      const suffix = data?.remainingUses === 0 ? " Non rimangono utilizzi disponibili." : " Controlla compendi, cartelle e forme conosciute.";
      ui.notifications.warn(`Nessuna forma valida disponibile.${suffix}`);
      return true;
    }
    const selected = await chooseForm(data, actor.name);
    if (!selected) return true;
    workflow.khuzoeWildShapeSelection = {
      actorReference,
      sourceUuid: selected.uuid,
      itemUuid: item.uuid,
      itemId: item.id
    };
  } catch (error) {
    console.error(`${MODULE_TITLE} | Preparazione Wild Shape non riuscita.`, error);
    ui.notifications.error(`Wild Shape non riuscita: ${error.message}`);
    return true;
  }
}

async function finishWildShapeUse({workflow, actor, item}) {
  actor ??= workflow?.actor;
  item ??= workflow?.item;
  if (!actor || !item) return;

  try {
    if (actor.isPolymorphed) {
      if (!actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
      await requestAsGm("revert", {actorUuid: actor.uuid});
      return;
    }

    const selection = workflow?.khuzoeWildShapeSelection;
    if (!selection?.sourceUuid) return;
    const result = await requestAsGm("transform", {
      actorUuid: selection.actorReference,
      sourceUuid: selection.sourceUuid,
      itemUuid: selection.itemUuid,
      itemId: selection.itemId
    });
    if (result?.ok) ui.notifications.info(`${actor.name} assume la forma: ${result.sourceName}.`);
  } catch (error) {
    console.error(`${MODULE_TITLE} | Wild Shape non riuscita.`, error);
    ui.notifications.error(`Wild Shape non riuscita: ${error.message}`);
  }
}

function spellSlotChoices(actor) {
  return Object.entries(actor?.system?.spells ?? {}).flatMap(([key, slot]) => {
    const level = Number(slot?.level ?? key.match(/\d+/)?.[0] ?? 0);
    const value = Number(slot?.value ?? 0);
    if (!level || value <= 0) return [];
    return [{key, level, value, label: `${key === "pact" ? "Pact Magic" : `Livello ${level}`} (${value})`}];
  }).sort((left, right) => left.level - right.level || left.key.localeCompare(right.key));
}

function originalWildShapeActor(actor) {
  const originalId = actor?.flags?.dnd5e?.originalActor;
  return originalId ? game.actors?.get?.(originalId) ?? null : null;
}

async function prepareCombatWildShapeHealing({workflow, actor, item}) {
  actor ??= workflow?.actor;
  item ??= workflow?.item;
  if (!workflow || !actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return true;
  const hp = actor.system.attributes.hp;
  if (Number(hp.value ?? 0) >= Number(hp.max ?? 0)) {
    ui.notifications.info("La forma è già al massimo dei punti ferita.");
    return true;
  }
  const slotActor = originalWildShapeActor(actor) ?? actor;
  const choices = spellSlotChoices(slotActor);
  if (!choices.length) {
    ui.notifications.warn("Nessuno slot incantesimo disponibile.");
    return true;
  }

  const options = choices.map(choice =>
    `<option value="${choice.key}">${choice.label}</option>`
  ).join("");
  const selectedKey = await foundry.applications.api.DialogV2.prompt({
    window: {title: item?.name ?? "Combat Wild Shape"},
    content: `<div class="form-group"><label>Slot da spendere</label><select name="slot">${options}</select></div>`,
    ok: {
      label: "Guarisci",
      icon: "fa-solid fa-heart",
      callback: (_event, button) => button.form.elements.slot.value
    },
    close: () => null
  });
  if (!selectedKey) return true;
  const selected = choices.find(choice => choice.key === selectedKey);
  if (!selected) return true;
  workflow.khuzoeWildShapeHealing = {key: selected.key, level: selected.level};
}

async function finishCombatWildShapeHealing({workflow, actor, item}) {
  actor ??= workflow?.actor;
  item ??= workflow?.item;
  if (!actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
  const prepared = workflow?.khuzoeWildShapeHealing;
  const originalActor = originalWildShapeActor(actor);
  if (!originalActor) throw new Error("Attore originale non disponibile: lo slot non è stato speso.");
  const selected = spellSlotChoices(originalActor).find(choice => choice.key === prepared?.key && choice.level === prepared?.level);
  if (!selected) {
    ui.notifications.warn("Lo slot selezionato non è più disponibile.");
    return;
  }

  const hp = actor.system.attributes.hp;
  let healed = 0;
  const receipt = await reserveResources(originalActor, {slot: selected.key === "pact" ? "pact" : selected.level});
  if (!receipt) return;
  try { healed = await healActor(actor, `${selected.level}d8`, {sourceItem: item}); }
  catch (error) { await refundResources(receipt); throw error; }
  // Healing has completed. A failed bookkeeping copy must not refund its slot.
  if (actor.system?.spells?.[selected.key]) await actor.update({
    [`system.spells.${selected.key}.value`]: originalActor.system.spells[selected.key].value
  }, {khuzoeWildShapeHealing: true});
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({actor}),
    content: `<p>${item.name}: ${healed} PF recuperati (slot di livello ${selected.level}).</p>`
  });
}

export function calculateWildShapeOverflow(actor, damageItem) {
  const hp = Number(actor?.system?.attributes?.hp?.value ?? 0);
  const temp = Number(actor?.system?.attributes?.hp?.temp ?? 0);
  const detail = Array.isArray(damageItem?.damageDetail) ? damageItem.damageDetail : [];
  const excluded = new Set(["temphp", "midi-none", "vitality", "maximum"]);
  const amount = detail.reduce((total, part) => {
    if (excluded.has(part?.type)) return total;
    const value = Number(part?.value ?? 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  const fallback = Number(damageItem?.totalDamage ?? damageItem?.rawTotalDamage ?? 0);
  const effective = Math.max(0, Math.floor(Array.isArray(damageItem?.damageDetail) ? amount : fallback));
  return Math.max(0, effective - Math.max(0, hp) - Math.max(0, temp));
}

async function rememberPendingOverflow(token, data) {
  const actor = tokenDocument(token)?.actor ?? token?.actor;
  if (!actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
  const overflow = calculateWildShapeOverflow(actor, data?.damageItem);
  const predictedHp = Number(data?.damageItem?.newHP ?? actor.system.attributes.hp.value);
  if (predictedHp > 0 && overflow <= 0) return;
  await setDocumentFlagSafely(actor, MODULE_ID, `${STATE_FLAG}.pendingOverflow`, {
    amount: overflow,
    workflowId: data?.workflow?.id ?? "",
    createdAt: Date.now()
  });
}

async function finishPendingOverflow(actor) {
  if (!actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
  const pending = actor.flags[MODULE_ID][STATE_FLAG].pendingOverflow;
  if (Number(actor.system?.attributes?.hp?.value ?? 0) > 0) {
    if (pending) await actor.unsetFlag(MODULE_ID, `${STATE_FLAG}.pendingOverflow`);
    return;
  }
  try {
    await requestAsGm("revert", {actorUuid: actor.uuid, overflow: Number(pending?.amount ?? 0)});
  } catch (error) {
    console.error(`${MODULE_TITLE} | Ritorno automatico da Wild Shape non riuscito.`, error);
    if (game.user?.isGM || actor.isOwner) ui.notifications.error(`Ritorno da Wild Shape non riuscito: ${error.message}`);
  }
}

function actorFromSheet(app) {
  const document = app?.document ?? app?.actor ?? app?.object;
  return document?.documentName === "Actor" ? document : document?.actor;
}

function addRevertHeaderControl(app, controls) {
  if (!Array.isArray(controls)) return;
  const actor = actorFromSheet(app);
  if (!actor?.isOwner || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
  if (controls.some(control => control.action === "khuzoeRevertWildShape")) return;
  controls.unshift({
    action: "khuzoeRevertWildShape",
    label: "Ritorna alla forma originale",
    icon: "fa-solid fa-rotate-left",
    classes: "khuzoe-wild-shape-revert",
    visible: true,
    onClick: () => requestAsGm("revert", {actorUuid: actor.uuid})
  });
}

function addSourceConfigHeaderControl(app, controls) {
  if (!Array.isArray(controls)) return;
  const item = app?.document?.documentName === "Item" ? app.document : null;
  if (!item?.actor || (!game.user?.isGM && !item.isOwner && !item.actor.isOwner) || !isWildShapeAbility(item)) return;
  if (controls.some(control => control.action === "khuzoeConfigureWildShapeSources")) return;
  controls.unshift({
    action: "khuzoeConfigureWildShapeSources",
    label: "Configura trasformazioni",
    icon: "fa-solid fa-paw",
    classes: "khuzoe-wild-shape-configure",
    visible: true,
    onClick: () => new WildShapeSourceConfig(item).render({force: true})
  });
}

function addWildShapeHeaderControls(app, controls) {
  addRevertHeaderControl(app, controls);
  addSourceConfigHeaderControl(app, controls);
}

function enforceWildShapeSpellcasting(activity) {
  const item = activity?.item;
  const actor = item?.actor;
  const state = actor?.flags?.[MODULE_ID]?.[STATE_FLAG];
  if (!state?.active || item?.type !== "spell") return;
  if (state.archdruid) return;
  if (!state.beastSpells) {
    ui.notifications.warn("Non puoi lanciare incantesimi mentre sei in Wild Shape.");
    return false;
  }
  if (item.system?.properties?.has?.("material") || values(item.system?.properties).includes("material")) {
    ui.notifications.warn("Beast Spells non consente di fornire componenti materiali in Wild Shape.");
    return false;
  }
}

function fullFolderName(folder) {
  const names = [];
  for (let current = folder; current; current = current.folder ?? current.parent) names.unshift(current.name);
  return names.join(" / ");
}

function actorPackChoices(selected) {
  return values(game.packs)
    .filter(pack => pack.documentName === "Actor" || pack.metadata?.type === "Actor")
    .map(pack => ({
      id: pack.collection,
      label: pack.metadata?.label ?? pack.title ?? pack.collection,
      package: pack.metadata?.packageName ?? pack.metadata?.packageType ?? "",
      selected: selected.has(pack.collection)
    }))
    .sort((left, right) => left.label.localeCompare(right.label, game.i18n?.lang ?? "it"));
}

function actorFolderChoices(selected) {
  return values(game.folders)
    .filter(folder => folder.type === "Actor")
    .map(folder => ({id: folder.id, label: fullFolderName(folder), selected: selected.has(folder.id)}))
    .sort((left, right) => left.label.localeCompare(right.label, game.i18n?.lang ?? "it"));
}

export class WildShapeSourceConfig extends HandlebarsApplicationV2 {
  #item;
  #actor;
  #config;

  constructor(item = null, options = {}) {
    if (item?.documentName !== "Item") {
      options = item ?? options;
      item = null;
    }
    super(options);
    this.#item = item;
    this.#actor = item?.actor ?? null;
    this.#config = item
      ? itemSourceConfig(item, this.#actor)
      : {...worldSources(), inherit: false, knownOnly: false, knownForms: [], scope: "world"};
  }

  static DEFAULT_OPTIONS = {
    id: "khuzoe-wild-shape-sources",
    tag: "form",
    classes: ["khuzoe-automations", "khz-wild-shape-sources"],
    position: {width: 760, height: 760},
    window: {icon: "fa-solid fa-paw", resizable: true},
    form: {closeOnSubmit: true, handler: WildShapeSourceConfig._onSubmit}
  };

  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/wild-shape-sources.hbs`}
  };

  static _onSubmit(_event, form) { return this.#save(form); }

  get title() {
    return this.#item ? `Wild Shape — sorgenti di ${this.#item.name}` : "Wild Shape — sorgenti del mondo";
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const selectedPacks = new Set(this.#config.packs);
    const selectedFolders = new Set(this.#config.folders);
    let knownChoices = [];
    if (this.#actor) {
      const forms = await collectSourceForms(this.#actor, this.#config);
      const known = new Set(this.#config.knownForms);
      knownChoices = forms.map(form => ({...form, selected: known.has(form.uuid)}));
    }
    return {
      ...context,
      item: this.#item ? {name: this.#item.name} : null,
      actor: this.#actor ? {name: this.#actor.name} : null,
      legacyConfig: this.#config.scope === "actor",
      inherit: this.#config.inherit,
      knownOnly: this.#config.knownOnly,
      packs: actorPackChoices(selectedPacks),
      folders: actorFolderChoices(selectedFolders),
      knownForms: knownChoices
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const inherit = this.element?.querySelector?.('[name="inherit"]');
    const updateInheritedState = () => {
      for (const fieldset of this.element?.querySelectorAll?.("[data-actor-source-overrides]") ?? []) {
        fieldset.disabled = Boolean(inherit?.checked);
      }
    };
    inherit?.addEventListener("change", updateInheritedState);
    updateInheritedState();

    const search = this.element?.querySelector?.("[data-known-form-search]");
    search?.addEventListener("input", () => {
      const query = slug(search.value);
      for (const row of this.element.querySelectorAll("[data-known-form]")) {
        row.hidden = Boolean(query && !slug(row.dataset.search).includes(query));
      }
    });
  }

  async #save(form) {
    const canConfigureItem = this.#item && (game.user?.isGM || this.#item.isOwner || this.#actor?.isOwner);
    if ((!this.#item && !game.user?.isGM) || (this.#item && !canConfigureItem)) {
      throw new Error("Non hai i permessi per configurare queste sorgenti di Wild Shape.");
    }
    const data = new FormData(form);
    const config = {
      packs: data.getAll("packs").map(String),
      folders: data.getAll("folders").map(String)
    };
    if (this.#item) {
      const itemConfig = {
        inherit: data.has("inherit"),
        ...config,
        knownOnly: data.has("knownOnly"),
        knownForms: data.getAll("knownForms").map(String)
      };
      await this.#item.setFlag(MODULE_ID, ACTOR_FLAG, itemConfig);
      ui.notifications.info(`Sorgenti Wild Shape salvate per ${this.#item.name}.`);
    } else {
      await game.settings.set(MODULE_ID, WORLD_SOURCES_SETTING, config);
      ui.notifications.info("Sorgenti Wild Shape del mondo salvate.");
    }
  }
}

export function enhanceWildShapeMedkit(app, section) {
  const actor = app?.document ?? app?.actor ?? app?.object;
  if (!section || actor?.documentName !== "Actor" || (!game.user?.isGM && !actor.isOwner)) return;
  if (section.querySelector('[data-khuzoe-action="wild-shape-sources"]')) return;
  const items = findWildShapeItems(actor);
  if (!items.length) return;

  const row = document.createElement("div");
  row.className = "khz-wild-shape-medkit-row";

  let select = null;
  if (items.length > 1) {
    select = document.createElement("select");
    select.dataset.khuzoeWildShapeItem = "";
    select.dataset.tooltip = "Scegli quale capacità di trasformazione configurare";
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    row.append(select);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.khuzoeAction = "wild-shape-sources";
  button.dataset.tooltip = "Configura compendi, cartelle e forme conosciute per la capacità selezionata";
  button.innerHTML = `<i class="fa-solid fa-paw"></i> ${items.length > 1 ? "Configura trasformazione" : "Configura Wild Shape"}`;
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const item = select ? actor.items.get(select.value) : items[0];
    if (!item) return ui.notifications.warn("Capacità di trasformazione non disponibile.");
    new WildShapeSourceConfig(item).render({force: true});
  });
  row.append(button);
  section.append(row);
}

export function prepareWildShapeItemUpdate(item, changes) {
  const identifier = slug(changes?.system?.identifier ?? item?.system?.identifier);
  if (!featureAliases.wildShape.includes(identifier)) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;

  if (changes.system?.uses && item.system?.uses) {
    const current = foundry.utils.deepClone(item.system.uses);
    if (String(current.max ?? "").trim()) changes.system.uses = current;
  }
  const sourceConfig = storedSourceConfig(item);
  if (sourceConfig) {
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${ACTOR_FLAG}`, foundry.utils.deepClone(sourceConfig));
  }
  const activity = changes.system?.activities?.[WILD_SHAPE_ACTIVITY_ID];
  if (activity?.activation) {
    activity.activation.type = actorHasFeature(item.actor, "combatWildShape") ? "bonus" : "action";
  }
}

async function reconcileWildShapeActivation(actor) {
  if (!actor || !game.user?.isGM) return;
  const type = actorHasFeature(actor, "combatWildShape") ? "bonus" : "action";
  for (const item of findWildShapeItems(actor)) {
    const activity = item.system?.activities?.get?.(WILD_SHAPE_ACTIVITY_ID)
      ?? item.system?.activities?.[WILD_SHAPE_ACTIVITY_ID];
    if (!activity || activity.activation?.type === type) continue;
    await item.update({[`system.activities.${WILD_SHAPE_ACTIVITY_ID}.activation.type`]: type}, {
      khuzoeWildShapeReconcile: true
    });
  }
}

function scheduleWildShapeActivation(actor) {
  globalThis.setTimeout(() => void reconcileWildShapeActivation(actor), 0);
}

export const WILD_SHAPE_AUTOMATION = Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: "wild-shape",
  version: WILD_SHAPE_VERSION,
  uuid: WILD_SHAPE_UUID,
  type: "feat",
  notes: "Usa la trasformazione nativa D&D5e v14, filtra le forme in base a livello e Circle of the Moon, gestisce sorgenti per mondo o per singola abilità, utilizzi, durata, ritorno e danno eccedente."
});

export function registerWildShape(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: "wild-shape",
      roll: [
        {pass: "itemPreItemRoll", macro: prepareWildShapeUse, priority: 10},
        {pass: "itemRollFinished", macro: finishWildShapeUse, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: HEALING_IDENTIFIER,
      roll: [
        {pass: "itemPreItemRoll", macro: prepareCombatWildShapeHealing, priority: 10},
        {pass: "itemRollFinished", macro: finishCombatWildShapeHealing, priority: 50}
      ]
    })
  ];
  return {macros, automations: [api.registerAutomation(WILD_SHAPE_AUTOMATION)]};
}

export function exposeWildShapeApi() {
  const module = game.modules.get(MODULE_ID);
  if (!module) return;
  module.api = {
    ...(module.api ?? {}),
    openWildShapeSources: target => {
      const item = target?.documentName === "Item" ? target
        : target?.documentName === "Actor" ? findWildShapeItems(target)[0]
          : null;
      if (!item) return ui.notifications.warn("Seleziona una capacità Wild Shape incorporata in un attore.");
      if (target?.documentName === "Actor" && findWildShapeItems(target).length > 1) {
        return ui.notifications.warn("Questo attore possiede più trasformazioni: scegli la capacità dal Medkit.");
      }
      return new WildShapeSourceConfig(item).render({force: true});
    },
    listWildShapeForms: (actor, item = null) => listEligibleForms(actor, item ?? findWildShapeItem(actor)),
    revertWildShape: actor => requestAsGm("revert", {actorUuid: actor.uuid})
  };
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, WORLD_SOURCES_SETTING, {
    name: "Sorgenti Wild Shape",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: DEFAULT_WORLD_SOURCES
  });
  game.settings.registerMenu(MODULE_ID, "wildShapeSourcesMenu", {
    name: "Wild Shape — sorgenti",
    label: "Configura sorgenti",
    hint: "Scegli i compendi e le cartelle di Attori disponibili come forme selvatiche predefinite.",
    icon: "fas fa-paw",
    type: WildShapeSourceConfig,
    restricted: true
  });
});

Hooks.once("socketlib.ready", () => {
  wildShapeSocket = globalThis.socketlib.registerModule(MODULE_ID);
  wildShapeSocket.register("listWildShapeForms", async ({actorUuid, itemUuid = "", itemId = ""}) => {
    const actor = await resolveActorReference(actorUuid);
    if (!actor) throw new Error("Attore non disponibile.");
    const item = await resolveWildShapeItem(actor, {itemUuid, itemId});
    return listEligibleForms(actor, item);
  });
  wildShapeSocket.register("performWildShapeTransform", performWildShapeTransform);
  wildShapeSocket.register("performWildShapeRevert", performWildShapeRevert);
});

Hooks.on("dnd5e.transformActorV2", (host, source, data, _settings, options = {}) => {
  const state = options.khuzoeWildShape;
  if (!state) return;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.${STATE_FLAG}`, {
    ...state,
    originalActorId: host.id,
    originalActorUuid: host.uuid,
    sourceUuid: source.uuid
  });
});

Hooks.on("midi-qol.preTargetDamageApplication", rememberPendingOverflow);
Hooks.on("dnd5e.applyDamage", actor => void finishPendingOverflow(actor));

Hooks.on("updateActor", (actor, changes, options = {}, userId = "") => {
  if (options.khuzoeWildShape || options.khuzoeWildShapeOverflow || options.khuzoeWildShapeHealing) return;
  if (!actor?.isPolymorphed || !actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.active) return;
  const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
  if (hp === undefined || Number(hp) > 0) return;
  if (userId && userId !== game.user.id) return;
  globalThis.setTimeout(() => void finishPendingOverflow(actor), 0);
});

Hooks.on("deleteActiveEffect", (effect, _options = {}, userId = "") => {
  if (!effect?.flags?.[MODULE_ID]?.wildShapeController) return;
  const actor = effect.parent;
  if (!actor?.isPolymorphed || actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.reverting) return;
  if (userId && userId !== game.user.id) return;
  void requestAsGm("revert", {actorUuid: actor.uuid}).catch(error => {
    console.error(`${MODULE_TITLE} | Ritorno da Wild Shape dopo la scadenza non riuscito.`, error);
  });
});

Hooks.on("updateActiveEffect", (effect, changes = {}, _options = {}, userId = "") => {
  if (!effect?.flags?.[MODULE_ID]?.wildShapeController) return;
  const expired = foundry.utils.getProperty(changes, "duration.expired") === true;
  const disabled = changes.disabled === true;
  if (!expired && !disabled) return;
  const actor = effect.parent;
  if (!actor?.isPolymorphed || actor.flags?.[MODULE_ID]?.[STATE_FLAG]?.reverting) return;
  if (userId && userId !== game.user.id) return;
  void requestAsGm("revert", {actorUuid: actor.uuid}).catch(error => {
    console.error(`${MODULE_TITLE} | Ritorno da Wild Shape dopo la scadenza non riuscito.`, error);
  });
});

Hooks.on("getHeaderControlsApplicationV2", addWildShapeHeaderControls);
Hooks.on("dnd5e.preUseActivity", enforceWildShapeSpellcasting);

for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, (item, _changes, options = {}) => {
    if (options.khuzoeWildShapeReconcile || options.khuzoeWildShape) return;
    const identifier = documentIdentifier(item);
    if (isWildShapeAbility(item) || featureAliases.combatWildShape.includes(identifier)) {
      scheduleWildShapeActivation(item?.actor);
    }
  });
}
