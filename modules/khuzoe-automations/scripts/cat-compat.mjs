const MODULE_TITLE = "Khuzoe Automations";
const GUARDED_HOOK = Symbol.for("khuzoe-automations.cat-damage-hook-guard");

const CAT_DAMAGE_HOOKS = Object.freeze([
  {
    hook: "midi-qol.premades.preDamageRollComplete",
    functionNames: new Set(["Xt"]),
    signatures: ["WorkflowEvent", "damageRollComplete"]
  },
  {
    hook: "midi-qol.preTargetDamageApplication",
    functionNames: new Set(["Jt"]),
    signatures: ["TokenDamageWorkflowEvent", "damageFlatReductions"]
  }
]);

const warnedHooks = new Set();

/**
 * CAT 0.0.7 invia per errore gmID() (una stringa) a query() quando aggiorna
 * un documento che l'utente corrente non possiede. query() si aspetta invece
 * l'oggetto User e termina con "t.query is not a function". Questa funzione
 * conserva il percorso locale veloce e usa gmUser() soltanto quando serve il
 * GM remoto.
 */
export async function updateDocumentSafely(document, updates, options = {}) {
  if (!document) return null;
  const queryUtils = globalThis.cat?.utils?.queryUtils;
  const user = globalThis.game?.user;
  let hasPermission = Boolean(document.isOwner || user?.isGM);
  if (typeof queryUtils?.hasPermission === "function" && user?.id) {
    hasPermission = Boolean(queryUtils.hasPermission(document, user.id));
  }

  if (hasPermission && typeof document.update === "function") {
    return document.update(updates, options);
  }

  const gm = queryUtils?.gmUser?.();
  if (gm?.query && typeof queryUtils?.query === "function" && document.uuid) {
    const uuid = await queryUtils.query("update", gm, {
      uuid: document.uuid,
      updates,
      options
    });
    if (uuid && typeof globalThis.fromUuid === "function") return globalThis.fromUuid(uuid);
    return document;
  }

  return globalThis.cat?.utils?.documentUtils?.update?.(document, updates, options)
    ?? document.update?.(updates, options);
}

export function setDocumentFlagSafely(document, scope, key, value, options = {}) {
  return updateDocumentSafely(document, {[`flags.${scope}.${key}`]: value}, options);
}

function isCatDamageHook(fn, definition) {
  if (typeof fn !== "function" || fn[GUARDED_HOOK]) return false;
  if (definition.functionNames.has(fn.name)) return true;

  let source = "";
  try {
    source = Function.prototype.toString.call(fn);
  } catch (_error) {
    return false;
  }
  return definition.signatures.every(signature => source.includes(signature));
}

function reportIsolatedCatError(hook, error, {logger, notifications, isGm}) {
  logger.error(
    `${MODULE_TITLE} | Errore interno CAT isolato durante ${hook}; il workflow base di Midi-QOL prosegue.`,
    error
  );

  if (!isGm || warnedHooks.has(hook)) return;
  warnedHooks.add(hook);
  notifications?.warn?.(
    `${MODULE_TITLE}: CAT ha generato un errore durante il danno. `
    + "Il danno base prosegue; controlla la console per l'automazione saltata."
  );
}

/**
 * CAT 0.0.7 esegue la raccolta dei trigger dentro due hook asincroni di
 * Midi-QOL. Gli errori delle singole macro vengono già isolati da CAT, mentre
 * un errore infrastrutturale nella raccolta dei trigger esce dall'hook e
 * interrompe l'intero workflow prima dell'aggiornamento dei PF.
 *
 * Conserviamo integralmente il callback CAT e ne proteggiamo soltanto il
 * confine con Midi-QOL: in caso di errore l'automazione coinvolta viene saltata
 * per quel singolo tiro, ma il danno base può essere applicato normalmente.
 */
export function installCatDamageWorkflowGuards({
  hooks = globalThis.Hooks,
  logger = globalThis.console,
  notifications = globalThis.ui?.notifications,
  isGm = Boolean(globalThis.game?.user?.isGM)
} = {}) {
  if (!hooks?.events || typeof hooks.on !== "function" || typeof hooks.off !== "function") return 0;

  let installed = 0;
  for (const definition of CAT_DAMAGE_HOOKS) {
    const entries = [...(hooks.events[definition.hook] ?? [])];
    for (const entry of entries) {
      const original = entry?.fn;
      if (!isCatDamageHook(original, definition)) continue;

      const guarded = async function khuzoeCatDamageGuard(...args) {
        try {
          return await original.apply(this, args);
        } catch (error) {
          reportIsolatedCatError(definition.hook, error, {logger, notifications, isGm});
          return undefined;
        }
      };
      Object.defineProperty(guarded, GUARDED_HOOK, {value: true});

      hooks.off(definition.hook, entry.id);
      hooks.on(definition.hook, guarded, {once: Boolean(entry.once)});
      installed += 1;
    }
  }
  return installed;
}

export function scheduleCatDamageWorkflowGuards(options = {}) {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const delays = options.delays ?? [0, 250, 1000];
  if (typeof schedule !== "function") return;
  for (const delay of delays) {
    schedule(() => installCatDamageWorkflowGuards(options), delay);
  }
}
