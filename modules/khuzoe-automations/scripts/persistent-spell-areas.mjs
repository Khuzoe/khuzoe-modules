import {runSyntheticActivityData} from "./activity-compat.mjs";
import {sceneUnitsPerFoot} from "./geometry.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";
import {withDocumentLock} from "./operation-locks.mjs";
import {combatTurnKey} from "./combat-events.mjs";

const MODULE = "khuzoe-automations";
const HANDLER = "khuzoe-persistent-area";
const TYPE = `${MODULE}.terrain`;
const ref = {source: MODULE, rules: "2014", identifier: HANDLER};
const values = collection => Array.from(collection?.values?.() ?? collection ?? []);
const state = region => region?.flags?.[MODULE]?.spellArea;
const doc = token => token?.document ?? token;
const feetPixels = scene => Number(scene.grid.size) * sceneUnitsPerFoot(scene) / Number(scene.grid.distance);

/** A terrain cost applies to the segment inside the area, not to the actor's speed. */
export function registerSpellTerrainType() {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType;
  if (!Base || !globalThis.CONFIG?.RegionBehavior) return;
  class SpellTerrain extends Base {
    /** Foundry initializes this schema at startup; spell state lives on the Region flags. */
    static defineSchema() {
      return {};
    }

    _getTerrainEffects(token, segment) {
      const region = this.behavior.parent;
      const area = state(region);
      if (!area || ["fly", "burrow", "teleport", "catForce"].includes(segment.action)) return [];
      const target = doc(token);
      const source = region.parent.tokens.get(area.sourceTokenId);
      if (area.mobile && target?.uuid === source?.uuid) return [];
      if (area.enemiesOnly && (!source || !cat.utils.tokenUtils.isEnemy(source, target))) return [];
      return [{name: "difficulty", difficulty: 2}];
    }
  }
  CONFIG.RegionBehavior.dataModels[TYPE] = SpellTerrain;
  CONFIG.RegionBehavior.typeLabels ??= {};
  CONFIG.RegionBehavior.typeLabels[TYPE] = "Terreno difficile (Khuzoe)";
}

function circle(token, radius) {
  const ppf = feetPixels(token.parent), grid = Number(token.parent.grid.size);
  return {type: "ellipse", x: token.x + token.width * grid / 2, y: token.y + token.height * grid / 2,
    radiusX: radius * ppf, radiusY: radius * ppf, rotation: 0, hole: false};
}

export async function createSpellArea(workflow, item, {rule, controller, radius, mobile = false, enemiesOnly = false, seconds = 60} = {}) {
  const source = doc(workflow.token);
  if (!source?.parent) return;
  const scene = source.parent;
  let shape, placedRegion;
  if (mobile || rule === "earth-tremor") shape = circle(source, radius);
  else {
    const template = (workflow.templateUuid ? await fromUuid(workflow.templateUuid) : null)
      ?? workflow.template?.document ?? workflow.template;
    if (!template) { ui.notifications.warn(`${item.name}: area non disponibile; disegna il terreno con lo strumento Regioni.`); return; }
    if (template.documentName === "Region" || template.constructor?.documentName === "Region") {
      placedRegion = template;
    } else {
    const ppf = feetPixels(scene);
    if (rule === "grease") {
      const angle = Number(template.direction ?? 0) * Math.PI / 180;
      const distance = template.distance == null ? 10 * Math.SQRT2 * ppf
        : Number(template.distance) * Number(scene.grid.size) / Number(scene.grid.distance);
      const side = distance / Math.SQRT2;
      shape = {type: "rectangle", x: template.x + Math.cos(angle) * distance / 2 - side / 2,
        y: template.y + Math.sin(angle) * distance / 2 - side / 2,
        width: side, height: side, rotation: Number(template.direction ?? 0) - 45, hole: false};
    } else shape = {type: "ellipse", x: template.x, y: template.y, radiusX: radius * ppf, radiusY: radius * ppf, rotation: 0, hole: false};
    }
  }
  if (!controller) {
    [controller] = await cat.utils.effectUtils.createEffects(item.actor, [{name: `${item.name}: terreno`, img: item.img,
      origin: item.uuid, type: "base", system: {changes: []},
      duration: {value: seconds || null, units: "seconds", expiry: "sourceStart", expired: false},
      flags: {dae: {stackable: "multi", expiryMode: "delete", specialDuration: []}}
    }], {rules: "2014"});
  }
  if (!controller) return;
  const area = {rule, radius, mobile, enemiesOnly, sourceTokenId: source.id,
    itemUuid: item.uuid, activityId: workflow.activity?.id,
    saveDC: Number(workflow.castData?.saveDC ?? cat.utils.activityUtils?.getSaveDC?.(workflow.activity)
      ?? workflow.activity?.save?.dc?.value ?? item.actor?.system?.attributes?.spell?.dc ?? 10)};
  const behavior = {name: "Terreno difficile", type: TYPE, system: {}};
  let region = placedRegion;
  if (region) {
    // D&D5e v5 can supply a Region instead of a MeasuredTemplate. Reuse its
    // actual shape; a second Region would duplicate Grease saves and terrain.
    const legacyIds = new Set(values(workflow.activity?.flags?.cat?.placed?.region?.activities).map(entry => entry.id));
    const activities = values(region.flags?.cat?.activities).filter(entry =>
      rule !== "grease" || !legacyIds.has(entry.uuid?.split(".").at(-1)));
    const regionRefs = values(region.flags?.cat?.macros?.region).filter(entry => entry.source !== MODULE || entry.identifier !== HANDLER);
    const combatRefs = values(region.flags?.cat?.macros?.combat).filter(entry => entry.source !== MODULE || entry.identifier !== HANDLER);
    await updateDocumentSafely(region, {
      [`flags.${MODULE}.spellArea`]: area,
      "flags.cat.activities": activities,
      "flags.cat.macros.region": [...regionRefs, ref], "flags.cat.macros.combat": [...combatRefs, ref]
    });
    if (!values(region.behaviors).some(entry => entry.type === TYPE)) {
      await cat.utils.documentUtils.createEmbeddedDocuments(region, "RegionBehavior", [behavior]);
    }
  } else [region] = await cat.utils.documentUtils.createEmbeddedDocuments(scene, "Region", [{
    name: `${item.name}: terreno difficile`, shapes: [shape], color: "#8b9e69", visibility: 2,
    elevation: {bottom: Number(source.elevation ?? 0), top: Number(source.elevation ?? 0) + 0.1},
    behaviors: [behavior],
    flags: {
      cat: {identifier: HANDLER, macros: {region: [ref], combat: [ref]}},
      [MODULE]: {spellArea: area}
    }
  }]);
  if (region) await cat.utils.documentUtils.makeDependent(controller, [region]);
  return region;
}

export async function moveSpellAreas(token) {
  if (!token?.parent || !game.user.isGM) return;
  for (const region of values(token.parent.regions)) {
    const area = state(region);
    if (!area?.mobile || area.sourceTokenId !== token.id) continue;
    await updateDocumentSafely(region, {shapes: [circle(token, area.radius)],
      elevation: {bottom: Number(token.elevation ?? 0), top: Number(token.elevation ?? 0) + 0.1}});
  }
}

async function greaseSave(region, token, pass, context = {}) {
  token = doc(token);
  const area = state(region);
  if (area?.rule !== "grease" || !token?.actor) return;
  return withDocumentLock(region, `grease:${token.uuid}`, async () => {
    const turn = combatTurnKey(context);
    const key = `${token.id}:${pass}`;
    const stamps = region.flags?.[MODULE]?.areaStamps ?? {};
    // Grease requires a save on every entry, not merely the first one per turn.
    if (pass === "end" && turn && stamps[key] === turn) return;
    const item = await fromUuid(area.itemUuid);
    if (!item) return;
    const result = await runSyntheticActivityData({
      _id: "KhzGreaseRepeat1", type: "save", name: `${item.name}: equilibrio`,
      activation: {type: "special", override: true}, consumption: {targets: [], spellSlot: false},
      duration: {units: "inst", override: true}, range: {units: "any", override: true},
      target: {override: true, prompt: false, affects: {type: "creature", count: "1"}, template: {}},
      save: {ability: ["dex"], dc: {calculation: "", formula: String(area.saveDC)}},
      damage: {parts: [], onSave: "none"}, effects: [], midiProperties: {automationOnly: true}
    }, item, [token]);
    if (!result || result.aborted) return false;
    if (values(result?.failedSaves).some(target => doc(target)?.uuid === token.uuid)) {
      await cat.utils.actorUtils.applyConditions(token.actor, ["prone"]);
    }
    if (pass === "end" && turn) await updateDocumentSafely(region, {[`flags.${MODULE}.areaStamps`]: {
      ...Object.fromEntries(Object.entries(region.flags?.[MODULE]?.areaStamps ?? {}).filter(([, stamp]) => stamp === turn)), [key]: turn
    }});
    return true;
  });
}

export function registerPersistentSpellAreas(api) {
  return api.registerFnMacro({source: MODULE, rules: "2014", identifier: HANDLER,
    region: [{pass: "enter", macro: async ({document, tokens}) => {
      for (const token of values(tokens)) await greaseSave(document, token, "enter");
    }, priority: 50}, {pass: "passedThrough", macro: async ({document, tokens}) => {
      for (const token of values(tokens)) await greaseSave(document, token, "enter");
    }, priority: 50}],
    combat: [{pass: "regionTurnEnd", macro: context => greaseSave(context.document, context.token, "end", context), priority: 50}]
  });
}
