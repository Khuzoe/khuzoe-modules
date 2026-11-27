import { attachWikiBanner } from "./wiki-banner.mjs";
import { cssImageUrl } from "./artwork.mjs";

// These are the NPC sheet illustrations shipped with D&D5e 5.3.
const illustrations = new Set([
  "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey",
  "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"
]);

function isPublished(media) {
  return !media.closest('[hidden], [aria-hidden="true"], [data-concealed], .hidden, .secret-roll, .secret:not(.revealed), [style*="display: none"], [style*="display:none"]')
    && (game.user.isGM || !media.closest(".gm-only"))
    && (!media.isConnected || media.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
}

const pendingThumbnails = new Map();
const portraitRolls = new Set(["ability", "check", "skill", "tool", "save", "death", "concentration"]);

// Both the token and the portrait use stills, including when the actor uses video art.
function stillArtwork(src, media) {
  if (!src) return;
  const publishedVideo = media.tagName === "VIDEO" && sameImage(src, media.currentSrc || media.src);
  if (!publishedVideo && !foundry.helpers.media.VideoHelper.hasVideoExtension(src)) return src;
  const still = (publishedVideo && media.poster) || game.video?.thumbs.get(src);
  if (still || !game.video) return still;
  if (!pendingThumbnails.has(src)) {
    const request = game.video.createThumbnail(src, { width: 240, height: 180 });
    pendingThumbnails.set(src, request);
    const release = () => pendingThumbnails.delete(src);
    request.then(release, release);
  }
  return pendingThumbnails.get(src);
}

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
  const rollType = message.flags?.dnd5e?.roll?.type ?? message.rolls?.[0]?.options?.rollType;
  const useRollPortrait = destination === original && portraitRolls.has(rollType)
    && !message.flags?.["midi-qol"]?.undoDamage;

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
      destination.querySelector(":scope > .khhud-roll-avatar")?.remove();
      return true;
    }

    const canSeeActor = () => game.user.isGM || actor.testUserPermission?.(game.user, "OBSERVER");
    const stillPublished = () => message.isContentVisible && original.querySelector(senderSelector) === sender
      && sender.contains(avatar) && avatar.dataset.uuid === actor.uuid && avatar.querySelector("img, video") === media && isPublished(media);
    if (useRollPortrait) {
      if (!destination.querySelector(".khhud-banner")) attachWikiBanner(destination, actor, message, stillPublished);
      const portraitSrc = () => {
        if (avatar.classList.contains("token")) return canSeeActor() && actor.img;
        const published = media.currentSrc || media.src;
        if (sameImage(published, message.author?.avatar) && !sameImage(published, actor.img)) return;
        return published;
      };
      const src = portraitSrc();
      const showPortrait = url => {
        let portrait = destination.querySelector(":scope > .khhud-roll-avatar");
        if (!url || url === "icons/svg/video.svg") return portrait?.remove();
        if (!portrait) {
          portrait = document.createElement("img");
          portrait.className = "khhud-roll-avatar";
          portrait.alt = "";
          portrait.loading = "lazy";
          portrait.decoding = "async";
          portrait.addEventListener("error", () => portrait.remove(), { once: true });
          destination.append(portrait);
        }
        if (portrait.getAttribute("src") !== url) portrait.src = url;
      };
      const still = stillArtwork(src, media);
      if (still instanceof Promise) still.then(thumb => {
        if (stillPublished() && src === portraitSrc()) showPortrait(thumb);
      }).catch(() => {});
      else showPortrait(still);
    }
    const publishedToken = () => avatar.classList.contains("token") ? media.currentSrc || media.src : undefined;
    const tokenImage = () => speakerTokenImage(message, actor, publishedToken(), canSeeActor());
    const { src, separateSubject } = tokenImage() ?? {};
    const setTokenImage = (url, useSubject) => {
      // Token textures are relative to the Foundry page, even when used by an external stylesheet.
      const href = url && URL.parse(url, document.baseURI)?.href;
      const art = cssImageUrl(href);
      if (destination.style.getPropertyValue("--khhud-speaker-art") !== art) destination.style.setProperty("--khhud-speaker-art", art);
      destination.classList.toggle("khhud-has-portrait", !!href);
      destination.classList.toggle("khhud-token-subject", !!href && !!useSubject);
      if (href && !destination.querySelector(".khhud-banner")) {
        addTokenLayer(destination, "khhud-token-backdrop");
      }
    };
    const image = stillArtwork(src, media);
    if (image instanceof Promise) {
      setTokenImage(undefined, false);
      image.then(thumb => {
        if (!thumb || thumb === "icons/svg/video.svg" || !stillPublished()) return;
        const selected = tokenImage();
        if (selected?.src === src) setTokenImage(thumb, selected.separateSubject);
      }).catch(() => {}); // Keep the normal message background if this media cannot be sampled.
    } else setTokenImage(image, separateSubject);
    if (actor.type === "npc" && canSeeActor()) {
      const family = actor.system.details?.type?.value;
      if (illustrations.has(family)) {
        const path = new URL(`systems/dnd5e/ui/official/npcs/${family}.webp`, document.baseURI);
      destination.style.setProperty("--khhud-family-art", cssImageUrl(path.href));
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
