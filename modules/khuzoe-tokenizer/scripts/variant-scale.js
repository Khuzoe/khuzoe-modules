/** Decimal entry shared by variant forms and external integrations. */
export function parseDecimal(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return NaN;
  return Number(text.replace(",", "."));
}

/** null inherits the base; NaN is invalid input, never silently saved as 1. */
export function parseVariantScale(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const scale = parseDecimal(value);
  return scale >= 0.01 && scale <= 10 ? scale : NaN;
}

export function variantTexture(baseTexture = {}, variant = {}) {
  const texture = { ...baseTexture, src: variant.src };
  const scale = parseVariantScale(variant.scale);
  if (scale != null && Number.isFinite(scale)) {
    // Foundry encodes mirroring in the sign of each axis. Scale is absolute.
    texture.scaleX = (Number(baseTexture.scaleX) < 0 ? -1 : 1) * scale;
    texture.scaleY = (Number(baseTexture.scaleY) < 0 ? -1 : 1) * scale;
  }
  return texture;
}
