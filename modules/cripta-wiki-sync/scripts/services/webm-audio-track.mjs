// Walk EBML element boundaries so bytes in an encoded video frame cannot be
// mistaken for an audio track. Streamed WebM files can omit the Segment size.
function* ebmlElements(bytes, start, end) {
  let pos = start;
  function integer(isId) {
    const first = bytes[pos++];
    if (!first) return NaN;
    const length = Math.clz32(first << 24) + 1;
    if ((isId && length > 4) || pos + length - 1 > end) return NaN;
    const marker = 1 << (8 - length);
    let value = isId ? first : first - marker;
    let unknown = !isId && value === marker - 1;
    for (let i = 1; i < length; i++) {
      const byte = bytes[pos++];
      value = value * 256 + byte;
      unknown &&= byte === 255;
    }
    return unknown ? Infinity : value;
  }
  while (pos < end) {
    const id = integer(true), size = integer(false);
    const limit = size === Infinity && id === 0x18538067 ? end : pos + size;
    if (!Number.isFinite(id) || !Number.isSafeInteger(limit) || limit > end) return;
    yield {id, start:pos, end:limit};
    pos = limit;
  }
}

export function webmAudioTrack(bytes) {
  const roots = ebmlElements(bytes, 0, bytes.length);
  const header = roots.next().value;
  if (header?.id !== 0x1a45dfa3 || header.end > 4096) return null;
  const children = element => ebmlElements(bytes, element.start, element.end);
  const webm = Array.from(children(header)).some(field => field.id === 0x4282 && field.end - field.start === 4
    && String.fromCharCode(...bytes.subarray(field.start, field.end)) === 'webm');
  if (!webm) return null;
  for (const segment of roots) {
    if (segment.id !== 0x18538067) continue;
    for (const tracks of children(segment)) {
      if (tracks.id !== 0x1654ae6b) continue;
      for (const entry of children(tracks)) {
        if (entry.id !== 0xae) continue;
        for (const field of children(entry)) {
          // TrackType is an unsigned integer; 2 denotes audio.
          if (field.id === 0x83 && field.end > field.start && field.end - field.start <= 8 &&
              bytes[field.end - 1] === 2 && bytes.subarray(field.start, field.end - 1).every(byte => byte === 0)) return true;
        }
      }
      return false;
    }
  }
  return false;
}
