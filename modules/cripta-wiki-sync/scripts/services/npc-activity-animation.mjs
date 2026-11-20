export const MAX_ANIMATION_BYTES = 16 * 1024 * 1024;
const segment = /^[a-z0-9_-]{1,96}$/;
export const animationDigestPattern = /^[a-f0-9]{64}$/;

export function animationPaths(campaign, world, actor, digest) {
  if (![campaign, world, actor].every(value => typeof value === 'string' && segment.test(value)) || !animationDigestPattern.test(digest)) {
    throw new Error('Identità animazione non valida.');
  }
  const filename = `${digest}.webm`;
  return {
    path: `media/campaigns/${campaign}/managed-actors/${world}/${actor}/animations/${filename}`,
    localPath: `worlds/${world}/wiki-sync-animations/${actor}/${filename}`
  };
}

export function primaryAnimationSource(activity) {
  const video = activity?.flags?.autoanimations?.primary?.video;
  return video?.enableCustom && typeof video.customPath === 'string' && /\.webm$/i.test(video.customPath) ? video.customPath : '';
}

export function managedAnimationDigest(source, campaign, world, actor) {
  if (!source?.startsWith(`worlds/${world}/wiki-sync-animations/`)) return '';
  const digest = source.split('/').at(-1).replace(/\.webm$/, '');
  return animationDigestPattern.test(digest) && animationPaths(campaign, world, actor, digest).localPath === source ? digest : '';
}
