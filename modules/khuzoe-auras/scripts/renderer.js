import { MODULE_ID, SETTINGS } from "./constants.js";
import { auraRadiusPixels } from "./distance.js";
import { AuraStore } from "./store.js";
import { isSourceOperational } from "./targeting.js";

export class AuraRenderer {
  #container = null;
  #frame = null;
  #visualProviders = new Map();

  registerVisualProvider(id, provider) {
    if (!id || typeof provider !== "function") return false;
    this.#visualProviders.set(String(id), provider);
    this.requestRefresh();
    return true;
  }

  requestRefresh() {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.refresh();
    });
  }

  refresh() {
    this.clear();
    if (!canvas?.ready || !canvas.scene) return;
    if (!game.settings.get(MODULE_ID, SETTINGS.SHOW_VISUALS)) return;

    this.#container = new PIXI.Container();
    this.#container.name = `${MODULE_ID}-visuals`;
    this.#container.eventMode = "none";
    canvas.interface.addChildAt(this.#container, 0);

    for (const token of canvas.tokens?.placeables ?? []) {
      if (!token.isVisible) continue;

      for (const aura of this.#getVisualAuras(token.document)) {
        if (!aura.visual.visible || !isSourceOperational(token.document, aura)) continue;
        this.#container.addChild(drawAura(token, aura));
      }
    }
  }

  #getVisualAuras(tokenDocument) {
    const auras = [...AuraStore.getAuras(tokenDocument)];
    for (const [id, provider] of this.#visualProviders) {
      try {
        const provided = provider(tokenDocument);
        if (Array.isArray(provided)) auras.push(...provided.filter(Boolean));
        else if (provided) auras.push(provided);
      } catch (error) {
        console.error(`Khuzoe Auras | Visual provider ${id} failed.`, error);
      }
    }
    return auras;
  }

  clear() {
    if (this.#frame) {
      cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    if (!this.#container) return;
    this.#container.destroy({ children: true });
    this.#container = null;
  }
}

function drawAura(token, aura) {
  const graphics = new PIXI.Graphics();
  const color = Number.parseInt(aura.visual.color.slice(1), 16);
  const radius = auraRadiusPixels(token, aura, canvas.scene);

  graphics.name = `${MODULE_ID}-${token.id}-${aura.id}`;
  graphics.eventMode = "none";
  graphics.lineStyle(
    Number(aura.visual.lineWidth ?? 2),
    color,
    Number(aura.visual.lineOpacity ?? 0.85)
  );
  graphics.beginFill(color, Number(aura.visual.opacity ?? 0.12));
  graphics.drawCircle(token.center.x, token.center.y, radius);
  graphics.endFill();

  return graphics;
}
