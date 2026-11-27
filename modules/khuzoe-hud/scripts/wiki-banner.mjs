const moduleId = "khuzoe-hud";
const wikiId = "cripta-wiki-sync";
const channel = `module.${moduleId}`;
const folder = `modules/${moduleId}/storage`;
const cache = new Map();
const lookups = new Map();
const verifiedBanners = new Map();
const cornerStyles = new Map();
const cornerWidth = .30;
const cornerHeight = .20;
const waiting = [];
let running = 0;

// When scrolling through a page of history, only nearby banners enter this queue.
async function limited(task) {
  if (running >= 3) await new Promise(resolve => waiting.push(resolve));
  else running++;
  try { return await task(); }
  finally { if (waiting.length) waiting.shift()(); else running--; }
}

function context(actor) {
  const wiki = game.modules.get(wikiId);
  if (!wiki?.active || !wiki.api?.getActorCardUrl) return;
  const session = wiki.api.calendar.getContext();
  const id = actor?.token?.actorId || actor?.id;
  if (!session.authenticated || !id || actor.pack) return;
  const campaign = wiki.api.wikiDataService.getCampaignId();
  return { api: wiki.api, campaign, id, key: JSON.stringify([game.user.id, session.identityVersion, campaign, game.world.id, id]) };
}

function filename(ctx, url) {
  // Stable on HTTP Foundry installations too. Include the complete media URL
  // (and its revision) so replacing a wiki card never overwrites an in-use image.
  let hash = 2166136261;
  for (const char of JSON.stringify([ctx.campaign, game.world.id, ctx.id, url])) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `wiki-card-${ctx.id.replace(/[^a-zA-Z0-9_-]/g, "")}-${(hash >>> 0).toString(16)}.webp`;
}

function lookup(actor, ctx) {
  const previous = lookups.get(ctx.key);
  if (previous && previous.until > Date.now()) return previous.promise;
  const entry = { until: Infinity };
  entry.promise = ctx.api.getActorCardUrl(actor).then(url => {
    entry.until = Date.now() + (url ? 30 : 5) * 60000;
    return url;
  }).catch(() => { entry.until = Date.now() + 60000; return null; });
  lookups.set(ctx.key, entry);
  if (lookups.size > 512) lookups.delete(lookups.keys().next().value);
  return entry.promise;
}

async function saveBanner(remote, name, current) {
  const response = await fetch(remote, { credentials: "omit", signal: AbortSignal.timeout(15000) });
  if (!response.ok) return;
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  try {
    const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally { bitmap.close(); }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .88));
  if (!blob || !current()) return;
  const file = new File([blob], name, { type: "image/webp" });
  const picker = CONFIG.ux.FilePicker;
  const result = await picker.uploadPersistent(moduleId, "", file, {}, { notify: false });
  return Boolean(result?.path);
}

async function decode(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  // Foundry disk routes are root-relative. Bound their probe so a stalled
  // local server cannot prevent the existing remote fallback from running.
  const timer = url.startsWith("/") ? setTimeout(() => image.removeAttribute("src"), 15000) : undefined;
  try {
    await image.decode();
    return url;
  } finally { clearTimeout(timer); }
}

// The actor lookup authorizes the URL. Both the actor card and a published
// cover can then reuse the same successful image check (including one in flight).
function verifyBanner(url) {
  const cached = verifiedBanners.get(url);
  if (cached && cached.until > Date.now()) return cached.request;
  const request = decode(url).catch(error => {
    if (verifiedBanners.get(url)?.request === request) verifiedBanners.delete(url);
    throw error;
  });
  if (!cached && verifiedBanners.size >= 256) verifiedBanners.delete(verifiedBanners.keys().next().value);
  verifiedBanners.set(url, { request, until: Date.now() + 30 * 60000 });
  return request;
}

export function wikiBanner(actor) {
  const ctx = context(actor);
  if (!ctx) return Promise.resolve(null);
  const cached = cache.get(ctx.key);
  if (cached && cached.until > Date.now()) return cached.promise;
  const entry = { until: Infinity };
  const current = () => context(actor)?.key === ctx.key;
  entry.promise = limited(async () => {
    if (!current()) return null;
    // Always check the current player's wiki access before trying the disk copy.
    const remote = await lookup(actor, ctx);
    if (!remote || !current()) return null;
    const name = filename(ctx, remote);
    const local = foundry.utils.getRoute(`${folder}/${name}`);
    const localImage = await verifyBanner(local).catch(() => null);
    if (localImage) return current() ? localImage : null;
    if (!current()) return null;
    if (game.user.isGM || game.user.can("FILES_UPLOAD")) {
      if (await saveBanner(remote, name, current).catch(() => false)) {
        const ready = await verifyBanner(local).catch(() => null);
        if (ready) return current() ? ready : null;
      }
    } else if (game.users.activeGM) {
      game.socket.emit(channel, { action: "cacheWikiBanner", actorId: ctx.id, campaign: ctx.campaign, name });
    }
    const ready = await verifyBanner(remote);
    entry.remote = true;
    return current() ? ready : null;
  }).then(url => {
    entry.until = Date.now() + (url && !entry.remote ? 30 * 60000 : 5 * 60000);
    return url;
  }).catch(() => { entry.until = Date.now() + 60000; return null; });
  cache.set(ctx.key, entry);
  if (cache.size > 512) for (const [key, value] of cache) {
    if (value.until !== Infinity && key !== ctx.key) { cache.delete(key); break; }
  }
  return entry.promise;
}

// The GM shares the cover image with the public chat card. Prefer the Foundry
// copy. The only remote fallback is Wiki Sync's plain media route with a revision.
const coverFile = /^wiki-card-[a-zA-Z0-9_-]+-[a-f0-9]{1,8}\.webp$/;
function sharedCoverUrl(ref) {
  if (typeof ref !== "string") return;
  if (coverFile.test(ref)) return foundry.utils.getRoute(`${folder}/${ref}`);
  const url = URL.parse(ref);
  if (url?.origin === "https://sigillo-api.khuzoe.workers.dev" && url.pathname.startsWith("/media/campaigns/")
    && !url.username && !url.password && !url.hash && [...url.searchParams.keys()].every(key => key === "rev")) return url.href;
}

export async function sharedWikiCover(actor) {
  const image = await wikiBanner(actor);
  if (!image) return;
  const file = image.split("/").at(-1);
  if (coverFile.test(file) && sharedCoverUrl(file) === image) return file;
  return sharedCoverUrl(image);
}

const nearby = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const marker = target.querySelector(":scope > khhud-wiki-banner");
    if (isIntersecting && marker) marker.refresh();
  }
}, { rootMargin: "140px", scrollMargin: "140px" });

function needsLightInk(r, g, b) {
  function linearChannel(channel) {
    const srgb = channel / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  }
  return .2126 * linearChannel(r) + .7152 * linearChannel(g) + .0722 * linearChannel(b) < .20;
}

// Read only the source rectangle used by the CSS crop, once per banner.
function sampleCornerStyle(image) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 12;
  const ctx = canvas.getContext("2d");
  // Transparent regions are displayed over the banner's dark binding.
  ctx.fillStyle = "#191a24";
  ctx.fillRect(0, 0, 12, 12);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, image.naturalWidth * cornerWidth, image.naturalHeight * cornerHeight, 0, 0, 12, 12);
  const pixels = ctx.getImageData(0, 0, 12, 12).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (needsLightInk(pixels[i], pixels[i + 1], pixels[i + 2])) dark++;
  }
  const fraction = dark / (pixels.length / 4);
  const edge = [0, 1, 2].map(channel => {
    let sum = 0;
    for (let i = pixels.length - canvas.width * 4 + channel; i < pixels.length; i += 4) sum += pixels[i];
    return Math.round(sum / canvas.width);
  });
  return { lightBody: fraction >= .5, outline: fraction > .10 && fraction < .90,
    foot: `rgb(${edge.join(" ")})` };
}

function styleCorner(texture, image) {
  const src = image.currentSrc || image.src;
  let style = cornerStyles.get(src);
  if (!style) {
    try {
      style = sampleCornerStyle(image);
    } catch {
      // The image can still be displayed. Outline the text when its pixels cannot be read.
      style = { lightBody: true, outline: true, foot: "#191a24" };
    }
    if (cornerStyles.size >= 256) cornerStyles.delete(cornerStyles.keys().next().value);
    cornerStyles.set(src, style);
  }
  texture.toggleAttribute("data-khhud-light-body", style.lightBody);
  texture.toggleAttribute("data-khhud-outline-body", style.outline);
  texture.firstElementChild.style.objectViewBox = `inset(0 ${(1 - cornerWidth) * 100}% ${(1 - cornerHeight) * 100}% 0)`;
  if (texture.firstElementChild.getAttribute("src") !== src || texture.dataset.khhudFoot !== style.foot) {
    texture.firstElementChild.src = src;
    texture.dataset.khhudFoot = style.foot;
    texture.dispatchEvent(new Event("khhud-roll-surface-changed", { bubbles: true }));
  }
}

class WikiBanner extends HTMLElement {
  connectedCallback() {
    this.host = this.parentElement;
    nearby.observe(this.host);
  }
  disconnectedCallback() {
    nearby.unobserve(this.host);
    this.reset();
  }
  reset() {
    this.request = null;
    this.sharedRequest = null;
    this.host.removeAttribute("data-khhud-wiki");
    this.cover?.remove();
    this.cover = null;
    const message = this.texture?.closest(".chat-message");
    this.texture?.remove();
    this.texture = null;
    message?.dispatchEvent(new Event("khhud-roll-surface-changed", { bubbles: true }));
  }
  async refresh() {
    if (!this.allowed() || !this.isConnected) return this.reset();
    const request = this.sharedCover
      ? (this.sharedRequest ??= verifyBanner(this.sharedCover).catch(() => this.actor && wikiBanner(this.actor)))
      : wikiBanner(this.actor);
    if (this.request === request) return;
    this.request = request;
    const url = await request;
    if (this.request !== request || !this.isConnected || !this.allowed()) return;
    if (!url) return this.reset();
    const message = this.host.closest(".chat-message");
    const header = message?.querySelector(":scope > .message-header");
    if (!header || (this.host === message && message.querySelector(".khhud-banner"))) return this.reset();
    if (!this.cover?.isConnected) {
      header.querySelector(":scope > .khhud-wiki-cover")?.remove();
      this.cover = document.createElement("span");
      this.cover.className = "khhud-wiki-cover";
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.addEventListener("load", () => {
        if (image !== this.cover?.firstElementChild || !this.allowed() || !image.naturalHeight) return;
        message.style.setProperty("--khhud-cover-ratio", String(image.naturalWidth / image.naturalHeight));
        const content = this.host.closest(".message-content");
        if (!content || !this.host.querySelector(":scope > .khhud-ability-image")) return;
        if (!this.texture) {
          this.texture = document.createElement("span");
          this.texture.className = "khhud-banner-texture";
          this.texture.setAttribute("aria-hidden", "true");
          const crop = new Image();
          crop.alt = "";
          crop.decoding = "async";
          this.texture.append(crop);
          content.append(this.texture);
        }
        styleCorner(this.texture, image);
      });
      this.cover.append(image);
      if (this.authorName) {
        const author = document.createElement("span");
        author.textContent = this.authorName;
        this.cover.append(author);
      }
      header.prepend(this.cover);
    }
    this.cover.firstElementChild.src = url;
    this.host.setAttribute("data-khhud-wiki", "");
  }
}
customElements.define("khhud-wiki-banner", WikiBanner);

export function attachWikiBanner(host, actor, message, allowed, cover) {
  const sharedCover = sharedCoverUrl(cover);
  if ((!sharedCover && (!["character", "npc"].includes(actor?.type) || !game.modules.get(wikiId)?.active))
    || host.querySelector(":scope > khhud-wiki-banner")) return;
  const marker = document.createElement("khhud-wiki-banner");
  marker.setAttribute("aria-hidden", "true");
  marker.actor = actor;
  marker.sharedCover = sharedCover;
  marker.authorName = message.author?.name;
  marker.allowed = () => message.isContentVisible && (!allowed || allowed());
  host.append(marker);
}

export function wikiActorForSummary(speaker) {
  if (!speaker || !game.modules.get(wikiId)?.active) return;
  if (speaker.wikiActorId) return game.actors.get(speaker.wikiActorId)
    ?? { id: speaker.wikiActorId, type: speaker.wikiActorType ?? "npc" };
  // Old public summaries carry only a display name and a published token image.
  // Match the Actor ID embedded in that token, including when its revision changed.
  if (typeof speaker.name !== "string" || typeof speaker.img !== "string") return;
  const actor = game.actors.getName(speaker.name);
  const token = URL.parse(speaker.img, document.baseURI);
  const prototype = URL.parse(actor?.prototypeToken?.texture?.src ?? "", document.baseURI);
  const match = token?.pathname.match(/\/managed-actors\/([^/]+)\/([^/]+)\/base\/[^/]+$/);
  if (match?.[1] !== game.world.id.toLowerCase()) return;
  if (actor && token.origin === prototype?.origin && match[2] === actor.id.toLowerCase()) return actor;
  // Wiki Sync accepts an actor identity and checks it with the viewer's own login.
  if (sharedCoverUrl(speaker.img) && /^[a-z0-9]{16}$/.test(match[2])) return { id: match[2], type: "npc" };
}

function refreshSession() {
  cache.clear();
  lookups.clear();
  verifiedBanners.clear();
  for (const marker of document.querySelectorAll("khhud-wiki-banner")) {
    marker.reset();
    nearby.unobserve(marker.host);
    nearby.observe(marker.host);
  }
}

Hooks.on("khuzoeWikiSync.authChanged", refreshSession);
// Wiki Sync registers its API on ready. History can already be in view at that point.
Hooks.once("ready", () => queueMicrotask(refreshSession));
Hooks.on("updateSetting", setting => { if (setting.key === `${wikiId}.campaignId`) refreshSession(); });
Hooks.once("ready", () => game.socket.on(channel, async packet => {
  if (game.user.id !== game.users.activeGM?.id || packet?.action !== "cacheWikiBanner" || typeof packet.actorId !== "string" || typeof packet.name !== "string") return;
  const actor = game.actors.get(packet.actorId);
  const ctx = actor && context(actor);
  if (!ctx || ctx.campaign !== packet.campaign) return;
  const remote = await limited(() => lookup(actor, ctx));
  if (remote && context(actor)?.key === ctx.key && filename(ctx, remote) === packet.name) await wikiBanner(actor);
}));
