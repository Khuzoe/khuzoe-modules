// Shared by Wiki Sync and the Worker. This is an archival JSON export, never
// an instruction to update an Actor or import a document into Foundry.
export const NPC_NATIVE_SNAPSHOT_VERSION = 1;
export const NPC_NATIVE_SNAPSHOT_CAMPAIGN = "cripta-di-sangue";
export const NPC_NATIVE_SNAPSHOT_CAMPAIGNS = Object.freeze(['cripta-di-sangue','mago-folle','oltre-il-velo']);
export const NPC_NATIVE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export function npcNativeSnapshotEnabled(campaignId, actor) {
  return NPC_NATIVE_SNAPSHOT_CAMPAIGNS.includes(campaignId) && actor?.type === "npc" && !actor?.isToken;
}

// Read-only bootstrap: include only Actors already registered on the site.
// It never imports an Actor or turns every creature in a world into a wiki NPC.
export function npcNativeBackfillCandidates(actors,{campaignId,worldId,state={},known=[]}={}){
  const normalize=value=>String(value||'').trim().toLowerCase(),world=normalize(worldId);
  const remote=new Set((Array.isArray(known)?known:[]).filter(entry=>normalize(entry?.worldId)===world).flatMap(entry=>[entry.actorId,entry.foundryActorId].map(normalize)).filter(Boolean));
  return Array.from(actors||[]).filter(actor=>npcNativeSnapshotEnabled(campaignId,actor)&&(Number(state[actor.id]?.revision||0)>0||remote.has(normalize(actor.id))));
}

export function npcNativeSnapshotContent(snapshot) {
  return { schemaVersion: snapshot.schemaVersion, identity: snapshot.identity, versions: snapshot.versions, actor: snapshot.actor };
}

// Foundry can be served over plain HTTP on a LAN, where SubtleCrypto is not
// available. The fallback hashes the same UTF-8 bytes without network requests.
function portableSha256(bytes) {
  const constants = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer), words = new Uint32Array(64);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = (words[i - 16] + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + words[i - 7] + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,k].forEach((value,i) => { h[i] = (h[i] + value) >>> 0; });
  }
  return Array.from(h, value => value.toString(16).padStart(8,"0")).join("");
}

export async function npcNativeSnapshotHash(snapshot, { subtle = globalThis.crypto?.subtle } = {}) {
  const canonical = JSON.stringify(npcNativeSnapshotContent(snapshot), (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return value;
  });
  const bytes = new TextEncoder().encode(canonical);
  if (!subtle) return portableSha256(bytes);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export async function captureNpcNativeSnapshot(actor, context) {
  if (!npcNativeSnapshotEnabled(context.campaignId, actor)) return null;
  let source;
  if (typeof actor.toJSON === "function") source = actor.toJSON();
  else if (typeof actor.toObject === "function") source = actor.toObject(true);
  else source = actor._source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("JSON nativo dell’NPC non disponibile.");
  // Match a native JSON export, including all flags, embedded documents, empty
  // values and _stats. Do not compact, clean, migrate or truncate the source.
  const nativeActor = JSON.parse(JSON.stringify(source));
  if (nativeActor._id !== actor.id || nativeActor.type !== "npc") throw new Error("Identità del JSON nativo NPC non coerente.");
  const snapshot = {
    schemaVersion: NPC_NATIVE_SNAPSHOT_VERSION,
    identity: { campaignId: context.campaignId, worldId: context.worldId, foundryActorId: String(actor.id), actorUuid: String(actor.uuid || `Actor.${actor.id}`) },
    versions: {
      ...(context.nativeEditor ? {nativeEditor: context.nativeEditor} : {}),
      ...(context.nativeAbilityCreate ? {nativeAbilityCreate: context.nativeAbilityCreate} : {}),
      ...(context.nativeSheetEditor ? {nativeSheetEditor: context.nativeSheetEditor} : {}),
      ...(context.nativeAbilityEdit ? {nativeAbilityEdit: context.nativeAbilityEdit} : {}),
      ...(context.npcRulesHealingTypes ? {npcRulesHealingTypes: context.npcRulesHealingTypes} : {}),
      foundry: { generation: Number(context.foundry?.generation || 14), version: String(context.foundry?.version || "") },
      system: { id: String(context.system?.id || ""), version: String(context.system?.version || "") },
      wikiSync: String(context.wikiSync || ""),
      modules: (context.modules || []).filter(module => module.active).map(module => ({ id: String(module.id), version: String(module.version || "") }))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    },
    actor: nativeActor,
  };
  snapshot.hash = await npcNativeSnapshotHash(snapshot);
  snapshot.capturedAt = new Date().toISOString();
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > NPC_NATIVE_SNAPSHOT_MAX_BYTES) {
    throw Object.assign(new Error("Il JSON completo dell’NPC supera 8 MB. Nessun dato è stato troncato."), { code: "NPC_SNAPSHOT_TOO_LARGE", hash: snapshot.hash });
  }
  return snapshot;
}
