// These are the NPC sheet illustrations shipped with D&D5e 5.3.
const illustrations = new Set([
  "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey",
  "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"
]);

function isPublished(media) {
  return !media.closest('[hidden], [aria-hidden="true"], [data-concealed], .secret:not(.revealed), [style*="display: none"], [style*="display:none"]')
    && (!media.isConnected || media.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
}

const pendingThumbnails = new Map();

export function addTokenLayer(parent, className) {
  if (parent.querySelector(`:scope > .${className}`)) return;
  const layer = document.createElement("span");
  layer.className = `khhud-token-layer ${className}`;
  layer.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.alt = "";
  layer.append(image);
  parent.append(layer);
}

function sameImage(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const url = URL.parse(a, document.baseURI);
  return !!url && url.href === URL.parse(b, document.baseURI)?.href;
}

function tokenArtwork(token, published) {
  const texture = token?.texture?.src;
  const subject = token?.ring?.enabled && token.ring.subject?.texture;
  // Only substitute a prototype's subject when it belongs to the published token.
  if (subject && !subject.includes("*") && !sameImage(subject, texture)
    && (!published || (!token.randomImg && sameImage(published, texture)))) {
    return { src: subject, separateSubject: true };
  }
  if (published) return { src: published, separateSubject: false };
  if (texture && !texture.includes("*") && !(token.randomImg && texture.includes("{"))) {
    return { src: texture, separateSubject: false };
  }
}

function speakerTokenImage(message, actor, published, canSeeActor) {
  const { scene, token } = message.speaker ?? {};
  const placed = scene && token && game.scenes.get(scene)?.tokens.get(token);
  if (placed && (game.user.isGM || (!placed.hidden && !placed.isSecret && (placed.isOwner || placed.object?.isVisible)))
    && placed.actor?.uuid === actor.uuid) {
    const artwork = tokenArtwork(placed);
    if (artwork) return artwork;
  }
  return tokenArtwork(canSeeActor ? actor.prototypeToken : undefined, published);
}

export function themeFromSpeaker(message, original, destination = original) {
  if (!message.isContentVisible || message.style === CONST.CHAT_MESSAGE_STYLES.OOC) return;
  const actor = message.getAssociatedActor?.();
  if (!["npc", "character"].includes(actor?.type)) return;
  const senderSelector = ":scope > .message-header .message-sender";

  function apply() {
    const sender = original.querySelector(senderSelector);
    const avatar = sender?.querySelector(".avatar[data-uuid]");
    const media = avatar?.querySelector("img, video");
    if (!media) return false;
    if (media.tagName === "VIDEO" && media.autoplay && sender.querySelector(".name-stacked > .title")) {
      media.autoplay = false;
      media.pause();
    }
    if (!message.isContentVisible || avatar.dataset.uuid !== actor.uuid || !isPublished(media)) {
      destination.style.removeProperty("--khhud-speaker-art");
      destination.style.removeProperty("--khhud-family-art");
      destination.classList.remove("khhud-has-portrait", "khhud-token-subject");
      return true;
    }

    const canSeeActor = () => game.user.isGM || actor.testUserPermission?.(game.user, "OBSERVER");
    const publishedToken = () => avatar.classList.contains("token") ? media.currentSrc || media.src : undefined;
    const tokenImage = () => speakerTokenImage(message, actor, publishedToken(), canSeeActor());
    const { src, separateSubject } = tokenImage() ?? {};
    const setTokenImage = (url, useSubject) => {
      // Token textures are relative to the Foundry page, even when used by an external stylesheet.
      const href = url && URL.parse(url, document.baseURI)?.href;
      const art = href ? `url("${CSS.escape(href)}")` : "";
      if (destination.style.getPropertyValue("--khhud-speaker-art") !== art) destination.style.setProperty("--khhud-speaker-art", art);
      destination.classList.toggle("khhud-has-portrait", !!href);
      destination.classList.toggle("khhud-token-subject", !!href && !!useSubject);
      if (href && !destination.querySelector(".khhud-banner")) {
        addTokenLayer(destination, "khhud-token-backdrop");
      }
    };
    const publishedVideo = media.tagName === "VIDEO" && src && src === publishedToken();
    const video = src && (publishedVideo || foundry.helpers.media.VideoHelper.hasVideoExtension(src));
    const image = video ? (publishedVideo && media.poster) || game.video?.thumbs.get(src) : src;
    setTokenImage(image, separateSubject);
    if (!image && video && game.video) {
      if (!pendingThumbnails.has(src)) {
        const request = game.video.createThumbnail(src, { width: 240, height: 180 });
        pendingThumbnails.set(src, request);
        const release = () => pendingThumbnails.delete(src);
        request.then(release, release);
      }
      pendingThumbnails.get(src).then(thumb => {
        const current = avatar.querySelector("img, video");
        if (!thumb || thumb === "icons/svg/video.svg" || !message.isContentVisible || original.querySelector(senderSelector) !== sender
          || !sender.contains(avatar) || avatar.dataset.uuid !== actor.uuid || current !== media || !isPublished(current)) return;
        const selected = tokenImage();
        if (selected?.src === src) setTokenImage(thumb, selected.separateSubject);
      }).catch(() => {}); // Keep the normal message background if this media cannot be sampled.
    }
    if (actor.type === "npc" && canSeeActor()) {
      const family = actor.system.details?.type?.value;
      if (illustrations.has(family)) {
        const path = new URL(`systems/dnd5e/ui/official/npcs/${family}.webp`, document.baseURI);
        destination.style.setProperty("--khhud-family-art", `url("${CSS.escape(path.href)}")`);
      }
    }
    return true;
  }

  // Midi may return from the D&D5e hook before the system inserts the sender's avatar.
  if (!apply()) {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      if (!apply()) watchHeader();
    });
    function watchHeader() {
      const header = original.querySelector(senderSelector) ?? original.querySelector(":scope > .message-header");
      observer.observe(header ?? original, { childList: true, subtree: !!header });
    }
    watchHeader();
  }
}
