// Keep only the CSS strings for common assets. The browser owns the image bytes.
const cssImages = new Map();

export function cssImageUrl(href) {
  if (!href) return "";
  const cached = cssImages.get(href);
  if (cached) return cached;
  const value = `url("${CSS.escape(href)}")`;
  // In particular, do not retain base64 video thumbnails or temporary blob URLs.
  if (href.length <= 4096 && /^https?:\/\//.test(href)) {
    if (cssImages.size >= 256) cssImages.delete(cssImages.keys().next().value);
    cssImages.set(href, value);
  }
  return value;
}
