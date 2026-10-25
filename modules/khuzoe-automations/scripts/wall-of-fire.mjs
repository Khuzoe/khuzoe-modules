import {RELEASE_VERSION} from "./release.mjs";
import {runCompleteActivity} from "./activity-compat.mjs";
import {sceneUnitsPerFoot} from "./geometry.mjs";
import {updateDocumentSafely} from "./cat-compat.mjs";

const MODULE_ID = "khuzoe-automations";
const RULES = "2014";
const VERSION = RELEASE_VERSION;
const STATE_FLAG = "wallOfFire";
const WALL_THICKNESS_FEET = 1;
const HOT_DISTANCE_FEET = 10;
const MAX_RANGE_FEET = 120;

export const WALL_OF_FIRE_IDENTIFIER = "wall-of-fire";
export const WALL_OF_FIRE_UUID = "Compendium.khuzoe-automations.KhuzoeSpells2014.Item.KhzWallFire14001";
export const WALL_OF_FIRE_CAST_ACTIVITY_ID = "KhzWallCast14001";
export const WALL_OF_FIRE_DAMAGE_ACTIVITY_ID = "KhzWallDmg140001";
export const WALL_OF_FIRE_DAMAGE_IDENTIFIER = "khuzoe-wall-of-fire-damage";
export const WALL_OF_FIRE_WALL_REGION_IDENTIFIER = "khuzoe-wall-of-fire-wall-region";
export const WALL_OF_FIRE_HOT_REGION_IDENTIFIER = "khuzoe-wall-of-fire-hot-region";

const processingDamage = new Set();
// Retain recent completions too: a delayed CAT callback can arrive after the
// next turn has already replaced the Region's persistent stamp.
const completedDamage = new Set();

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection?.contents)) return Array.from(collection.contents);
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map || collection instanceof Set) return Array.from(collection.values());
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function tokenDocument(token) {
  return token?.document ?? token;
}

function pixelsPerFoot(scene) {
  const size = Number(scene?.grid?.size ?? 0);
  const distance = Number(scene?.grid?.distance ?? 0);
  return size > 0 && distance > 0 ? size / distance * sceneUnitsPerFoot(scene) : 1;
}

function polygon(points, hole = false) {
  return {
    type: "polygon",
    points: points.flatMap(point => [point.x, point.y]),
    hole
  };
}

/**
 * Costruisce il muro sottile e la fascia calda lunga 10 ft sul lato scelto.
 * `side` e' relativo al verso in cui il giocatore ha tracciato il segmento.
 */
export function buildLineRegionShapes({start, end, pixelsPerUnit, side = "left"}) {
  const dx = Number(end?.x ?? 0) - Number(start?.x ?? 0);
  const dy = Number(end?.y ?? 0) - Number(start?.y ?? 0);
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0) throw new Error("Il muro deve avere una lunghezza positiva.");

  const sign = side === "right" ? -1 : 1;
  const nx = sign * (-dy / length);
  const ny = sign * (dx / length);
  const wallHalf = Math.max(0.5, Number(pixelsPerUnit) * WALL_THICKNESS_FEET / 2);
  const hotDepth = Math.max(1, Number(pixelsPerUnit) * HOT_DISTANCE_FEET);
  const offset = (point, distance) => ({
    x: Number(point.x) + nx * distance,
    y: Number(point.y) + ny * distance
  });

  const wall = polygon([
    offset(start, wallHalf),
    offset(end, wallHalf),
    offset(end, -wallHalf),
    offset(start, -wallHalf)
  ]);
  const hot = polygon([
    offset(start, -wallHalf),
    offset(end, -wallHalf),
    offset(end, hotDepth + wallHalf),
    offset(start, hotDepth + wallHalf)
  ]);

  return {wall: [wall], hot: [hot]};
}

/** Costruisce l'anello di fiamme e il lato caldo interno oppure esterno. */
export function buildCircleRegionShapes({center, radiusFeet, pixelsPerUnit, facing = "inward"}) {
  const scale = Math.max(0.01, Number(pixelsPerUnit));
  const radius = Math.max(0.01, Number(radiusFeet) * scale);
  const wallHalf = Math.max(0.5, scale * WALL_THICKNESS_FEET / 2);
  const hotDepth = Math.max(1, scale * HOT_DISTANCE_FEET);
  const ellipse = (value, hole = false) => ({
    type: "ellipse",
    x: Number(center?.x ?? 0),
    y: Number(center?.y ?? 0),
    radiusX: Math.max(0.01, value),
    radiusY: Math.max(0.01, value),
    rotation: 0,
    hole
  });

  const innerWall = Math.max(0.01, radius - wallHalf);
  const wall = [ellipse(radius + wallHalf), ellipse(innerWall, true)];
  const hot = facing === "outward"
    ? [ellipse(radius + hotDepth + wallHalf), ellipse(innerWall, true)]
    : [ellipse(radius + wallHalf)];
  return {wall, hot};
}

function catReference(identifier) {
  return {source: MODULE_ID, rules: RULES, identifier};
}

function castLevel(workflow) {
  return Math.max(4, Number(
    workflow?.castData?.castLevel
      ?? workflow?.spellLevel
      ?? workflow?.activity?.item?.system?.level
      ?? workflow?.item?.system?.level
      ?? 4
  ));
}

function saveDc(workflow) {
  const activity = workflow?.activity;
  const configured = globalThis.cat?.utils?.activityUtils?.getSaveDC?.(activity);
  return Number(configured ?? workflow?.castData?.saveDC ?? workflow?.actor?.system?.attributes?.spelldc ?? 10);
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
    return !item?.id
      || sourceItem?.id === item.id
      || sourceItem?.uuid === item.uuid
      || effect.origin === item.uuid;
  });
}

async function choose(title, prompt, options) {
  const buttonDialog = globalThis.cat?.utils?.dialogUtils?.buttonDialog;
  if (typeof buttonDialog !== "function") return;
  return buttonDialog(title, prompt, options, {displayAsRows: true});
}

function drawPreviewShapes(graphics, shapes, {color, fillAlpha, lineAlpha, lineWidth}) {
  graphics.lineStyle(lineWidth, color, lineAlpha);
  graphics.beginFill(color, fillAlpha);
  for (const shape of shapes ?? []) {
    if (shape.hole) graphics.beginHole();
    if (shape.type === "polygon") {
      graphics.drawPolygon(shape.points);
    } else if (shape.type === "ellipse") {
      graphics.drawEllipse(shape.x, shape.y, shape.radiusX, shape.radiusY);
    }
    if (shape.hole) graphics.endHole();
  }
  graphics.endFill();
}

function createSidePreview(shapes) {
  const Graphics = globalThis.PIXI?.Graphics;
  const layer = globalThis.canvas?.interface;
  if (typeof Graphics !== "function" || typeof layer?.addChild !== "function") return null;

  try {
    const graphics = new Graphics();
    graphics.name = `${MODULE_ID}-wall-of-fire-side-preview`;
    graphics.eventMode = "none";
    // Prima la zona calda, poi la parete vera e propria piu' luminosa.
    drawPreviewShapes(graphics, shapes?.hot, {
      color: 0xe34717,
      fillAlpha: 0.22,
      lineAlpha: 0.9,
      lineWidth: 2
    });
    drawPreviewShapes(graphics, shapes?.wall, {
      color: 0xffd166,
      fillAlpha: 0.38,
      lineAlpha: 1,
      lineWidth: 3
    });
    layer.addChild(graphics);
    return graphics;
  } catch (error) {
    console.debug("Khuzoe Automations | Anteprima del lato di Wall of Fire non disponibile.", error);
    return null;
  }
}

function destroySidePreview(preview) {
  if (!preview) return;
  try {
    preview.parent?.removeChild?.(preview);
    preview.destroy?.({children: true});
  } catch (_error) {
    // La chiusura del canvas o del dialogo puo' averla gia' distrutta.
  }
}

async function chooseWithCanvasPreview(title, prompt, options, previews) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const canPreview = typeof DialogV2?.wait === "function"
    && typeof globalThis.PIXI?.Graphics === "function"
    && typeof globalThis.canvas?.interface?.addChild === "function";
  if (!canPreview) return choose(title, prompt, options);

  let preview;
  const clearPreview = () => {
    destroySidePreview(preview);
    preview = null;
  };
  const showPreview = value => {
    clearPreview();
    preview = createSidePreview(previews?.[value]);
  };

  try {
    return await DialogV2.wait({
      window: {title, controls: []},
      position: {width: 440},
      content: `<p>${prompt}</p><p class="hint">Passa il cursore su una scelta per vedere sul canvas la parete e la sua area calda.</p>`,
      buttons: options.map(([label, value], index) => ({
        action: String(value),
        label,
        icon: ({
          left: "fa-solid fa-arrow-left",
          right: "fa-solid fa-arrow-right",
          inward: "fa-solid fa-compress",
          outward: "fa-solid fa-expand"
        })[value] ?? (index === 0 ? "fa-solid fa-arrow-left" : "fa-solid fa-arrow-right"),
        default: index === 0
      })),
      render: (_event, dialog) => {
        for (const button of dialog.element.querySelectorAll("button[data-action]")) {
          const value = button.dataset.action;
          if (!previews?.[value]) continue;
          button.addEventListener("pointerenter", () => showPreview(value));
          button.addEventListener("pointerleave", clearPreview);
          button.addEventListener("focusin", () => showPreview(value));
          button.addEventListener("focusout", clearPreview);
        }
      },
      close: clearPreview
    });
  } finally {
    clearPreview();
  }
}

export function chooseWallSideWithPreview(title, prompt, previews) {
  return chooseWithCanvasPreview(title, prompt, [
    ["Lato sinistro", "left"],
    ["Lato destro", "right"]
  ], previews);
}

async function placeTemplate(data) {
  const TemplateClass = globalThis.CONFIG?.MeasuredTemplate?.documentClass;
  const AbilityTemplate = globalThis.game?.dnd5e?.canvas?.AbilityTemplate;
  const scene = globalThis.canvas?.scene;
  if (!TemplateClass || !AbilityTemplate || !scene) return;

  const document = new TemplateClass(data, {parent: scene});
  const preview = new AbilityTemplate(document);
  try {
    const [template] = await preview.drawPreview();
    return template;
  } catch (_error) {
    return undefined;
  }
}

async function deleteDocument(document) {
  if (!document) return;
  const remove = globalThis.cat?.utils?.documentUtils?.deleteDocument;
  if (typeof remove === "function") return remove(document);
  return document.delete?.();
}

function templateRay(template, distanceFeet) {
  const ray = template?.object?.ray;
  if (ray?.A && ray?.B) return {start: ray.A, end: ray.B};

  const start = {x: Number(template?.x ?? 0), y: Number(template?.y ?? 0)};
  const angle = Number(template?.direction ?? 0) * Math.PI / 180;
  const length = Number(distanceFeet) * pixelsPerFoot(template?.parent);
  return {
    start,
    end: {x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length}
  };
}

function templateWithinRange(template, token, maximum = MAX_RANGE_FEET) {
  const center = tokenDocument(token)?.object?.center ?? token?.center;
  if (!center || !template) return true;
  const distance = Math.hypot(Number(template.x) - center.x, Number(template.y) - center.y)
    / pixelsPerFoot(template.parent);
  return distance <= maximum + 0.01;
}

async function createRegion(scene, data) {
  const create = globalThis.cat?.utils?.documentUtils?.createEmbeddedDocuments;
  if (typeof create === "function") {
    const result = await create(scene, "Region", [data]);
    return values(result)[0];
  }
  return (await scene?.createEmbeddedDocuments?.("Region", [data]))?.[0];
}

function regionState({kind, originItemUuid, castId, castLevel: level, saveDC, controllerRegionUuid}) {
  return {
    kind,
    originItemUuid,
    castId,
    castLevel: level,
    saveDC,
    controllerRegionUuid: controllerRegionUuid ?? ""
  };
}

function regionData({name, color, shapes, elevation, identifier, macroType, macroIdentifier, state, obscured = false}) {
  return {
    name,
    color,
    shapes,
    elevation,
    behaviors: [],
    visibility: 2,
    locked: false,
    flags: {
      cat: {
        identifier,
        castData: {
          castLevel: state.castLevel,
          baseLevel: 4,
          saveDC: state.saveDC,
          school: "evo"
        },
        ...(obscured ? {visibility: {obscured: true}} : {}),
        macros: {[macroType]: [catReference(macroIdentifier)]}
      },
      [MODULE_ID]: {[STATE_FLAG]: state}
    }
  };
}

async function linkRegionsToConcentration(actor, item, regions) {
  const effect = concentrationEffect(actor, item);
  if (!effect || !regions.length) return false;

  const makeDependent = globalThis.cat?.utils?.documentUtils?.makeDependent;
  if (typeof makeDependent === "function") {
    await makeDependent(effect, regions);
    return true;
  }

  const addConcentrationDependent = globalThis.MidiQOL?.addConcentrationDependent;
  if (typeof addConcentrationDependent === "function") {
    for (const region of regions) await addConcentrationDependent(actor, region, item);
    return true;
  }

  for (const region of regions) {
    await updateDocumentSafely(region, {"flags.dnd5e.dependentOn": effect.uuid});
  }
  return true;
}

async function resolveRegions(uuids) {
  const regions = [];
  for (const uuid of uuids ?? []) {
    const region = await globalThis.fromUuid?.(uuid);
    if (region) regions.push(region);
  }
  return regions;
}

function updateWorkflowTargets(workflow, tokens) {
  const update = globalThis.cat?.utils?.workflowUtils?.updateTargets;
  if (typeof update === "function") return update(workflow, tokens);
  const ids = tokens.map(token => tokenDocument(token)?.id).filter(Boolean);
  return globalThis.game?.user?.updateTokenTargets?.(ids);
}

function playWallAnimation({shape, wallRegion, line, center, diameter, gridDistance}) {
  const Sequence = globalThis.Sequence;
  const database = globalThis.Sequencer?.Database;
  if (typeof Sequence !== "function" || !database) return;
  const path = shape === "circle"
    ? "jb2a.wall_of_fire.500x100.yellow"
    : "jb2a.wall_of_fire.300x100.yellow";

  try {
    if (!database.getEntry?.(path)) return;
    const sequence = new Sequence().effect().file(path);
    if (shape === "circle") {
      sequence
        .atLocation(center)
        .sizeInGridUnits(Number(diameter) / Math.max(1, Number(gridDistance)))
        .persist()
        .tieToDocuments(wallRegion)
        .fadeIn(300)
        .fadeOut(300)
        .aboveInterface();
    } else {
      sequence
        .atLocation(line.start)
        .stretchTo(line.end)
        .persist()
        .tieToDocuments(wallRegion)
        .fadeIn(300)
        .fadeOut(300)
        .aboveInterface();
    }
    const result = sequence.play();
    void result?.catch?.(error => {
      console.debug("Khuzoe Automations | Riproduzione JB2A di Wall of Fire non riuscita.", error);
    });
  } catch (error) {
    console.debug("Khuzoe Automations | Animazione JB2A di Wall of Fire non disponibile.", error);
  }
}

function abortWorkflow(workflow, message) {
  if (workflow) workflow.aborted = true;
  if (message) globalThis.ui?.notifications?.warn?.(message);
  return false;
}

export async function placeWallOfFire({workflow, activity, actor, item, token} = {}) {
  if (!workflow || activity?.id !== WALL_OF_FIRE_CAST_ACTIVITY_ID) return false;
  actor ??= workflow.actor;
  item ??= workflow.item;
  token ??= workflow.token;
  const scene = tokenDocument(token)?.parent ?? globalThis.canvas?.scene;
  if (!actor || !item || !token || !scene) return false;

  const shape = await choose(item.name, "Scegli la forma del Muro di Fuoco.", [
    ["Muro lineare", "line"],
    ["Anello", "circle"]
  ]);
  if (!shape) return abortWorkflow(workflow);

  let template;
  let shapes;
  let length;
  let diameter;
  let animationGeometry;
  const createdRegions = [];
  try {
    if (shape === "line") {
      length = Number(await choose(item.name, "Scegli la lunghezza del muro (massimo 60 ft).", [
        60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5
      ].map(value => [`${value} ft`, value])));
      if (!length) return abortWorkflow(workflow);
      template = await placeTemplate({
        user: globalThis.game?.user?.id,
        t: "ray",
        distance: length,
        direction: 0,
        angle: 0,
        width: 5,
        fillColor: globalThis.game?.user?.color ?? "#ff6a00"
      });
      if (!template) return abortWorkflow(workflow);
      if (!templateWithinRange(template, token)) {
        await deleteDocument(template);
        return abortWorkflow(workflow, `${item.name}: il punto iniziale deve trovarsi entro ${MAX_RANGE_FEET} ft.`);
      }
      const ray = templateRay(template, length);
      const linePreview = {
        left: buildLineRegionShapes({
          ...ray,
          pixelsPerUnit: pixelsPerFoot(scene),
          side: "left"
        }),
        right: buildLineRegionShapes({
          ...ray,
          pixelsPerUnit: pixelsPerFoot(scene),
          side: "right"
        })
      };
      const side = await chooseWallSideWithPreview(
        item.name,
        "Scegli il lato caldo guardando dal punto iniziale verso la fine del muro.",
        linePreview
      );
      if (!side) {
        await deleteDocument(template);
        return abortWorkflow(workflow);
      }
      animationGeometry = {line: ray};
      shapes = linePreview[side];
    } else {
      diameter = Number(await choose(item.name, "Scegli il diametro dell'anello (massimo 20 ft).", [
        ["20 ft", 20], ["15 ft", 15], ["10 ft", 10], ["5 ft", 5]
      ]));
      if (!diameter) return abortWorkflow(workflow);
      template = await placeTemplate({
        user: globalThis.game?.user?.id,
        t: "circle",
        distance: diameter / 2,
        direction: 0,
        angle: 0,
        width: 0,
        fillColor: globalThis.game?.user?.color ?? "#ff6a00"
      });
      if (!template) return abortWorkflow(workflow);
      if (!templateWithinRange(template, token)) {
        await deleteDocument(template);
        return abortWorkflow(workflow, `${item.name}: il centro dell'anello deve trovarsi entro ${MAX_RANGE_FEET} ft.`);
      }
      const center = {x: Number(template.x), y: Number(template.y)};
      const circlePreview = {
        inward: buildCircleRegionShapes({
          center,
          radiusFeet: diameter / 2,
          pixelsPerUnit: pixelsPerFoot(scene),
          facing: "inward"
        }),
        outward: buildCircleRegionShapes({
          center,
          radiusFeet: diameter / 2,
          pixelsPerUnit: pixelsPerFoot(scene),
          facing: "outward"
        })
      };
      const facing = await chooseWithCanvasPreview(item.name, "Scegli il lato caldo dell'anello.", [
        ["Verso l'interno", "inward"],
        ["Verso l'esterno", "outward"]
      ], circlePreview);
      if (!facing) {
        await deleteDocument(template);
        return abortWorkflow(workflow);
      }
      shapes = circlePreview[facing];
      animationGeometry = {center};
    }

    const height = Number(await choose(item.name, "Scegli l'altezza del muro (massimo 20 ft).", [
      ["20 ft", 20], ["15 ft", 15], ["10 ft", 10], ["5 ft", 5]
    ]));
    if (!height) {
      await deleteDocument(template);
      return abortWorkflow(workflow);
    }

    const level = castLevel(workflow);
    const dc = saveDc(workflow);
    const castId = globalThis.foundry?.utils?.randomID?.(16)
      ?? `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const elevationBottom = Number(tokenDocument(token)?.elevation ?? 0);
    const elevation = {bottom: elevationBottom, top: elevationBottom + height};
    const wallState = regionState({
      kind: "wall",
      originItemUuid: item.uuid,
      castId,
      castLevel: level,
      saveDC: dc
    });
    const wallRegion = await createRegion(scene, regionData({
      name: `${item.name} — fiamme`,
      color: "#ff6a00",
      shapes: shapes.wall,
      elevation,
      identifier: `${WALL_OF_FIRE_IDENTIFIER}-wall-${castId}`,
      macroType: "region",
      macroIdentifier: WALL_OF_FIRE_WALL_REGION_IDENTIFIER,
      state: wallState,
      obscured: true
    }));
    if (!wallRegion) throw new Error("Creazione della Regione del muro non riuscita.");
    createdRegions.push(wallRegion);

    const hotState = regionState({
      kind: "hot",
      originItemUuid: item.uuid,
      castId,
      castLevel: level,
      saveDC: dc,
      controllerRegionUuid: wallRegion.uuid
    });
    const hotRegion = await createRegion(scene, regionData({
      name: `${item.name} — lato caldo`,
      color: "#b73d00",
      shapes: shapes.hot,
      elevation,
      identifier: `${WALL_OF_FIRE_IDENTIFIER}-hot-${castId}`,
      macroType: "combat",
      macroIdentifier: WALL_OF_FIRE_HOT_REGION_IDENTIFIER,
      state: hotState
    }));
    if (!hotRegion) throw new Error("Creazione della Regione del lato caldo non riuscita.");
    createdRegions.push(hotRegion);

    await deleteDocument(template);
    template = undefined;
    const regions = [wallRegion, hotRegion];
    workflow[`${MODULE_ID}.wallOfFireRegions`] = regions.map(region => region.uuid);
    workflow[`${MODULE_ID}.wallOfFireLinked`] = await linkRegionsToConcentration(actor, item, regions);

    // La Regione sottile rappresenta l'area effettiva del muro: soltanto le
    // creature che vi si trovano al lancio effettuano il TS iniziale.
    await new Promise(resolve => globalThis.setTimeout(resolve, 50));
    await updateWorkflowTargets(workflow, values(wallRegion.tokens));
    playWallAnimation({
      shape,
      wallRegion,
      ...animationGeometry,
      diameter,
      gridDistance: scene.grid?.distance
    });
    // Nei passaggi preamble CAT considera un risultato truthy come richiesta
    // di interrompere il workflow. La creazione e' riuscita: lasciamo quindi
    // proseguire normalmente TS, danno iniziale e concentrazione.
    return false;
  } catch (error) {
    await deleteDocument(template);
    for (const region of createdRegions.toReversed()) {
      try {
        await deleteDocument(region);
      } catch (_cleanupError) {
        // Il documento puo' essere gia' stato rimosso insieme a un dipendente.
      }
    }
    console.error("Khuzoe Automations | Creazione di Wall of Fire non riuscita.", error);
    return abortWorkflow(workflow, `${item.name}: non è stato possibile creare il muro. Controlla la console.`);
  }
}

export async function linkWallOfFireConcentration({workflow, activity, actor, item} = {}) {
  if (!workflow || activity?.id !== WALL_OF_FIRE_CAST_ACTIVITY_ID) return false;
  if (workflow[`${MODULE_ID}.wallOfFireLinked`]) return true;
  actor ??= workflow.actor;
  item ??= workflow.item;
  const uuids = workflow[`${MODULE_ID}.wallOfFireRegions`] ?? [];
  if (!actor || !item || !uuids.length) return false;
  const linked = await linkRegionsToConcentration(actor, item, await resolveRegions(uuids));
  workflow[`${MODULE_ID}.wallOfFireLinked`] = linked;
  return linked;
}

function wallState(region) {
  return region?.flags?.[MODULE_ID]?.[STATE_FLAG];
}

function currentTurnKey(combat = globalThis.game?.combat, state = combat?.current) {
  if (!combat?.started || !combat?.isActive) return;
  return `${combat.id}:${state?.round ?? combat.round ?? 0}:${state?.turn ?? combat.turn ?? 0}`;
}

function damageExecutor() {
  if (!globalThis.game?.user?.isGM) return false;
  // CAT may use Midi's preferred GM instead of Foundry's active GM. Both
  // dispatch paths must run on that same client to share the in-flight lock.
  const isTheGM = globalThis.cat?.utils?.queryUtils?.isTheGM;
  if (typeof isTheGM === "function") return isTheGM();
  const activeGM = globalThis.game?.users?.activeGM;
  return !activeGM || activeGM.id === globalThis.game.user.id;
}

async function controllerRegion(region) {
  const uuid = wallState(region)?.controllerRegionUuid;
  return uuid ? (await globalThis.fromUuid?.(uuid) ?? region) : region;
}

function damageActivity(item) {
  const activities = item?.system?.activities;
  return activities?.get?.(WALL_OF_FIRE_DAMAGE_ACTIVITY_ID)
    ?? values(activities).find(activity => activity?.id === WALL_OF_FIRE_DAMAGE_ACTIVITY_ID
      || activity?.identifier === WALL_OF_FIRE_DAMAGE_IDENTIFIER
      || activity?.midiProperties?.identifier === WALL_OF_FIRE_DAMAGE_IDENTIFIER);
}

async function useWallOfFireDamage(region, target, phase = "entry", turn = currentTurnKey()) {
  const token = tokenDocument(target);
  const state = wallState(region);
  if (!region || !token || !state?.originItemUuid) return false;

  const item = await globalThis.fromUuid?.(state.originItemUuid);
  const activity = damageActivity(item);
  const complete = runCompleteActivity;
  if (!item || !activity || typeof complete !== "function") return false;

  const controller = await controllerRegion(region);
  const turnKey = turn ? `${turn}:${phase}` : undefined;
  const lockKey = `${controller?.uuid ?? region.uuid}:${turnKey ?? "free"}:${token.id}`;
  if (processingDamage.has(lockKey) || (turnKey && completedDamage.has(lockKey))) return false;
  const stamp = controller?.flags?.[MODULE_ID]?.[STATE_FLAG]?.stamps?.[phase];
  if (turnKey && stamp?.turnKey === turnKey && values(stamp.tokenIds).includes(token.id)) return false;

  processingDamage.add(lockKey);
  try {
    const result = await complete(activity, [token], {
      atLevel: Math.max(4, Number(state.castLevel ?? 4)),
      fast: true,
      autoDamage: true,
      options: {workflowOptions: {autoRollDamage: "always"}}
    });
    if (!result || result.aborted) return false;
    if (turnKey) {
      completedDamage.add(lockKey);
      if (completedDamage.size > 256) completedDamage.delete(completedDamage.values().next().value);
    }
    if (turnKey && controller) {
      const current = controller.flags?.[MODULE_ID]?.[STATE_FLAG]?.stamps?.[phase];
      const tokenIds = current?.turnKey === turnKey ? values(current.tokenIds) : [];
      if (!tokenIds.includes(token.id)) tokenIds.push(token.id);
      await updateDocumentSafely(controller, {
        [`flags.${MODULE_ID}.${STATE_FLAG}.stamps.${phase}`]: {turnKey, tokenIds}
      });
    }
    return true;
  } finally {
    processingDamage.delete(lockKey);
  }
}

export async function damageWallOfFireOnMovement({document, tokens} = {}) {
  if (!document || wallState(document)?.kind !== "wall") return false;
  let applied = false;
  for (const token of values(tokens)) {
    applied = await useWallOfFireDamage(document, token) || applied;
  }
  return applied;
}

export function damageWallOfFireAtTurnEnd({document, token, combat = globalThis.game?.combat, round, turn} = {}) {
  if (!damageExecutor() || !document || wallState(document)?.kind !== "hot") return false;
  // CAT supplies the round/turn that ended, whereas game.combat already points
  // at the next turn. Capture the former before starting any asynchronous work.
  const ended = {round: round ?? combat?.previous?.round, turn: turn ?? combat?.previous?.turn};
  return useWallOfFireDamage(document, token, "end", currentTurnKey(combat, ended));
}

export async function triggerWallOfFireTurnEnd(combat, prior = combat?.previous, current = combat?.current) {
  if (!damageExecutor() || !combat?.started || !combat.isActive) return false;
  if (!(prior?.round > 0) || !Number.isInteger(prior.turn) || prior.turn < 0) return false;
  if (!(current?.round > prior.round || (current?.round === prior.round && current?.turn > prior.turn))) return false;
  const token = tokenDocument(combat.combatants?.get?.(prior.combatantId)?.token);
  if (!token?.actor || (combat.scene && token.parent?.id !== combat.scene.id)) return false;
  // Foundry's Region membership includes the selected side, shape and height.
  // Snapshot before the first await; do not target the combatant starting now.
  const regions = values(token.regions).filter(region => wallState(region)?.kind === "hot");
  const context = {token, combat, round: prior.round, turn: prior.turn};
  let applied = false;
  for (const document of regions) {
    try {
      applied = await damageWallOfFireAtTurnEnd({document, ...context}) || applied;
    } catch (error) {
      console.error("Khuzoe Automations | Wall of Fire: danno di fine turno non riuscito.", {region: document.uuid, token: token.uuid}, error);
    }
  }
  return applied;
}

export function registerWallOfFireCombatHooks(hooks = globalThis.Hooks) {
  hooks.on("combatTurnChange", (combat, prior, current) => {
    void triggerWallOfFireTurnEnd(combat, prior, current);
  });
  // This hook still fires if core/other-module turn events fail before the
  // later combatTurnChange hook or CAT's Region macro. Shared stamps deduplicate.
  hooks.on("updateCombat", (combat, changes, options) => {
    if (options?.turnEvents === false) return;
    if (!["round", "turn"].some(field => Object.hasOwn(changes ?? {}, field))) return;
    void triggerWallOfFireTurnEnd(combat);
  });
}

export function prepareWallOfFireItemUpdate(item, changes) {
  const identifier = changes?.system?.identifier ?? item?.system?.identifier;
  if (identifier !== WALL_OF_FIRE_IDENTIFIER) return;
  if (changes?.flags?.cat?.automation?.source !== MODULE_ID) return;
  if (item?.img) changes.img = item.img;
}

export const WALL_OF_FIRE_AUTOMATION = Object.freeze({
  source: MODULE_ID,
  rules: RULES,
  identifier: WALL_OF_FIRE_IDENTIFIER,
  version: VERSION,
  uuid: WALL_OF_FIRE_UUID,
  type: "spell",
  notes: "Crea un muro lineare o ad anello collegato alla concentrazione. Gestisce lato caldo, altezza, opacità, TS iniziale e 5d8 da fuoco al primo ingresso/attraversamento e alla fine del turno, con contatori distinti e scalabilità da slot superiore."
});

export function registerWallOfFire(api) {
  const macros = [
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WALL_OF_FIRE_IDENTIFIER,
      roll: [
        {pass: "itemPreambleComplete", macro: placeWallOfFire, priority: 40},
        {pass: "itemRollFinished", macro: linkWallOfFireConcentration, priority: 90}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WALL_OF_FIRE_WALL_REGION_IDENTIFIER,
      region: [
        {pass: "enter", macro: damageWallOfFireOnMovement, priority: 50},
        {pass: "passedThrough", macro: damageWallOfFireOnMovement, priority: 50}
      ]
    }),
    api.registerFnMacro({
      source: MODULE_ID,
      rules: RULES,
      identifier: WALL_OF_FIRE_HOT_REGION_IDENTIFIER,
      combat: [
        {pass: "regionTurnEnd", macro: damageWallOfFireAtTurnEnd, priority: 50}
      ]
    })
  ];
  return {macros, automations: [api.registerAutomation(WALL_OF_FIRE_AUTOMATION)]};
}
