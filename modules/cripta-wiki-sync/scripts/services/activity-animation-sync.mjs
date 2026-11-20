import { animationPaths, managedAnimationDigest, primaryAnimationSource, MAX_ANIMATION_BYTES } from './npc-activity-animation.mjs';
import { hashNpcBytes } from './npc-native-snapshot.mjs';

function localAsset(source) {
  try {
    const parts = decodeURIComponent(source).split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\:%?#\u0000-\u001f]/.test(part))) return '';
    return parts.map(encodeURIComponent).join('/');
  } catch { return ''; }
}

function localUrl(source) {
  const path = localAsset(source);
  if (!path) return '';
  return foundry.utils.getRoute(path);
}

// A missing local asset must not block the Actor and its other activities.
async function readLocalClip(source) {
  const url = localUrl(source);
  if (!url) return null;
  const response = await fetch(url, {cache:'no-store', redirect:'error'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Lettura WebM Foundry: HTTP ${response.status}`);
  if (Number(response.headers.get('Content-Length')) > MAX_ANIMATION_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length <= MAX_ANIMATION_BYTES && bytes[0] === 0x1a && bytes[1] === 0x45 ? bytes : null;
}

export function hasNpcAnimation(actor) {
  return actor.type === 'npc' && Array.from(actor.items?.contents || actor.items || []).some(item => {
    const activities = item.system?.activities;
    if (activities?.values && Array.from(activities.values()).some(primaryAnimationSource)) return true;
    return Object.values(item._source?.system?.activities || item.toObject?.(true)?.system?.activities || {}).some(primaryAnimationSource);
  });
}

// Store a preview alongside the public Item projection. Raw activity flags keep
// their original local paths for the native editor's conflict comparisons.
export async function exportNpcAnimations(entries, context) {
  const resolved = new Map();
  for (const entry of entries) {
    for (const [key, activity] of Object.entries(entry.definition?.activities || {})) {
      const source = primaryAnimationSource(activity);
      if (!source) continue;
      if (!resolved.has(source)) {
        const bytes = await readLocalClip(source);
        let path = '';
        if (bytes) {
          const digest = await hashNpcBytes(bytes);
          path = animationPaths(context.campaign, context.world, context.actor, digest).path;
          const check = await context.request(`${context.origin}/${path}`, {method:'HEAD'});
          if (check.status === 404) {
            if (context.allowUpload) {
              const result = await context.request(context.endpoint, {method:'POST', headers:{...context.headers(), 'Content-Type':'video/webm'}, body:bytes});
              if (result.status === 415 || result.status === 413) path = '';
              else if (!result.ok || (await result.json()).digest !== digest) throw new Error(`Trasferimento WebM non confermato (HTTP ${result.status}).`);
            } else path = '';
          } else if (!check.ok) throw new Error(`Verifica WebM: HTTP ${check.status}`);
        }
        if (!path) console.warn('Wiki Sync | Anteprima WebM non disponibile:', source);
        resolved.set(source, path);
      }
      const path = resolved.get(source);
      if (path) {
        entry.media ??= {};
        entry.media.animations ??= {};
        entry.media.animations[activity._id || key] = {source, path};
      }
    }
  }
}

async function ensureDirectory(picker, directory) {
  const parent = directory.slice(0, directory.lastIndexOf('/'));
  const listing = await picker.browse('data', parent);
  if (listing.dirs.includes(directory)) return;
  try { await picker.createDirectory('data', directory); }
  catch (error) {
    if (!(await picker.browse('data', parent)).dirs.includes(directory)) throw error;
  }
}

export async function installNpcAnimations(before, next, context) {
  const installed = new Set();
  for (const [id, activity] of Object.entries(next || {})) {
    const source = primaryAnimationSource(activity);
    if (!source || source === primaryAnimationSource(before?.[id]) || installed.has(source)) continue;
    const digest = managedAnimationDigest(source, context.campaign, context.world, context.actor);
    if (!digest) continue;
    const existing = await readLocalClip(source);
    if (!existing || await hashNpcBytes(existing) !== digest) {
      const {path} = animationPaths(context.campaign, context.world, context.actor, digest);
      const response = await context.request(`${context.origin}/${path}`);
      if (!response.ok) throw new Error(`Download animazione: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_ANIMATION_BYTES || await hashNpcBytes(bytes) !== digest) throw new Error('Il video scaricato non corrisponde alla versione salvata.');
      const picker = foundry.applications.apps.FilePicker.implementation;
      const directory = source.slice(0, source.lastIndexOf('/'));
      await ensureDirectory(picker, directory.slice(0, directory.lastIndexOf('/')));
      await ensureDirectory(picker, directory);
      const file = new File([bytes], `${digest}.webm`, {type:'video/webm'});
      const saved = await picker.upload('data', directory, file, {}, {notify:false});
      const checked = saved?.path && await readLocalClip(source);
      if (!checked || await hashNpcBytes(checked) !== digest) throw new Error('Foundry non ha confermato la copia del WebM.');
    }
    installed.add(source);
  }
}
