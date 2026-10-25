import { MODULE_ID, REQUEST_TIMEOUT_MS, SOCKET_NAME } from "./constants.js";
import { logError, primaryGM } from "./utils.js";

const completedRequests = new Map();
const pendingClientRequests = new Map();
const uncertainClientRequests = new Map();
const REQUEST_RETENTION_MS = 10 * 60 * 1000;
const MAX_TRACKING_MS = 2 * 60 * 1000;
const STATUS_RETRY_MS = 3000;
let authoritativeQueue = Promise.resolve();
let ledgerQueue = Promise.resolve();
let initialized = false;

function hydrateCompletedRequests() {
  let ledger = null;
  try {
    ledger = game.settings.get(MODULE_ID, "transactionLedger");
  } catch (_error) {
    ledger = null;
  }
  const cutoff = Date.now() - REQUEST_RETENTION_MS;
  for (const entry of Array.isArray(ledger?.entries) ? ledger.entries : []) {
    const completedAt = Number(entry?.completedAt) || 0;
    if (!entry?.key || completedAt < cutoff || !entry.result) continue;
    const result = foundry.utils.deepClone(entry.result);
    completedRequests.set(entry.key, {
      state: "complete",
      startedAt: completedAt,
      completedAt,
      result,
      promise: Promise.resolve(result)
    });
  }
}

async function persistCompletedRequests() {
  if (!game.user?.isGM || typeof game.settings?.set !== "function") return;
  ledgerQueue = ledgerQueue.then(async () => {
    const cutoff = Date.now() - REQUEST_RETENTION_MS;
    const entries = [...completedRequests.entries()]
      .filter(([, record]) => record.state === "complete" && record.completedAt >= cutoff)
      .sort((left, right) => right[1].completedAt - left[1].completedAt)
      .slice(0, 200)
      .map(([key, record]) => ({ key, completedAt: record.completedAt, result: record.result }));
    await game.settings.set(MODULE_ID, "transactionLedger", { entries });
  }).catch((error) => {
    logError("Unable to persist the transaction ledger", error);
  });
  await ledgerQueue;
}

function requestKey(userId, requestId) {
  return `${String(userId || "")}:${String(requestId || "")}`;
}

function clientRequestSignature(payload) {
  const comparable = { ...(payload || {}) };
  delete comparable.requestId;
  delete comparable.local;
  return JSON.stringify(comparable);
}

function pruneCompletedRequests() {
  const cutoff = Date.now() - REQUEST_RETENTION_MS;
  for (const [key, record] of completedRequests) {
    if (record.state === "complete" && record.completedAt < cutoff) completedRequests.delete(key);
  }
}

/**
 * Serialize every operation which can mutate an Actor, Item, merchant, ground drop, or container.
 * Keeping one queue prevents absolute-value wallet and quantity updates from overwriting one another.
 */
export function enqueueTransaction(task, label = "authoritative transaction") {
  const operation = authoritativeQueue.then(task);
  authoritativeQueue = operation.catch((error) => {
    logError(`Unhandled ${label} error`, error);
  });
  return operation;
}

/**
 * Execute a socket request at most once for its authenticated user and request ID.
 * Duplicate deliveries receive the original result instead of repeating the mutation.
 */
export function enqueueAuthoritativeRequest({
  request,
  senderUserId,
  execute,
  replay = null,
  label = "socket transaction",
  failureResult = { ok: false }
}) {
  pruneCompletedRequests();
  const key = requestKey(senderUserId, request?.requestId);
  const existing = completedRequests.get(key);
  if (existing) {
    if (typeof replay === "function") {
      existing.promise.then((result) => replay(result)).catch((error) => logError(`Unable to replay ${label}`, error));
    }
    return existing.promise;
  }

  const record = {
    state: "pending",
    startedAt: Date.now(),
    completedAt: 0,
    result: null,
    promise: null
  };
  const operation = enqueueTransaction(async () => {
    try {
      return await execute();
    } catch (error) {
      logError(`Unhandled ${label}`, error);
      return typeof failureResult === "function" ? failureResult(error) : failureResult;
    }
  }, label).then(async (result) => {
    record.state = "complete";
    record.completedAt = Date.now();
    record.result = result ?? failureResult;
    await persistCompletedRequests();
    return record.result;
  });
  record.promise = operation;
  completedRequests.set(key, record);
  return operation;
}

function finishClientRequest(requestId, result) {
  const pending = pendingClientRequests.get(requestId);
  if (!pending) {
    for (const record of uncertainClientRequests.values()) {
      if (record.requestId === requestId) record.result = result;
    }
    return;
  }
  clearTimeout(pending.timer);
  pendingClientRequests.delete(requestId);
  if (!result?.pending) uncertainClientRequests.delete(pending.signature);
  pending.resolve(result);
}

function scheduleStatusCheck(requestId, delay = STATUS_RETRY_MS) {
  const pending = pendingClientRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    const elapsed = Date.now() - pending.startedAt;
    if (elapsed >= MAX_TRACKING_MS) {
      uncertainClientRequests.set(pending.signature, {
        requestId,
        createdAt: Date.now(),
        result: null
      });
      finishClientRequest(requestId, {
        ok: false,
        pending: true,
        requestId,
        errorKey: "KM.Errors.Pending",
        errorData: {}
      });
      return;
    }
    const gm = primaryGM();
    if (!gm) {
      finishClientRequest(requestId, { ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
      return;
    }
    game.socket.emit(SOCKET_NAME, {
      type: "transaction-status-request",
      requestId,
      userId: game.user.id,
      targetGMId: gm.id
    });
    scheduleStatusCheck(requestId);
  }, delay);
}

function handleCoordinatorMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;

  if (message.type === "transaction-status-request") {
    const gm = primaryGM();
    if (!game.user?.isGM || gm?.id !== game.user.id || message.targetGMId !== game.user.id) return;
    if (!senderUserId || message.userId !== senderUserId) return;
    const record = completedRequests.get(requestKey(senderUserId, message.requestId));
    game.socket.emit(SOCKET_NAME, {
      type: "transaction-status-response",
      requestId: message.requestId,
      targetUserId: senderUserId,
      status: record?.state || "unknown",
      result: record?.state === "complete" ? record.result : null
    });
    return;
  }

  if (message.targetUserId !== game.user?.id || !message.requestId) return;
  const sender = game.users.get(senderUserId);
  if (!sender?.isGM) return;

  if (message.type === "transaction-status-response") {
    if (message.status === "complete" && message.result) finishClientRequest(message.requestId, message.result);
    else scheduleStatusCheck(message.requestId);
    return;
  }

  if (String(message.type || "").endsWith("-response")) finishClientRequest(message.requestId, message);
}

export function initializeTransactionCoordinator() {
  if (initialized) return;
  initialized = true;
  hydrateCompletedRequests();
  game.socket.on(SOCKET_NAME, handleCoordinatorMessage);
}

/** Emit a request and keep querying its authoritative status after the normal UI timeout. */
export function requestTrackedOperation(payload, { errorKey = "KM.Errors.Transaction" } = {}) {
  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  const cutoff = Date.now() - REQUEST_RETENTION_MS;
  for (const [key, record] of uncertainClientRequests) {
    if (record.createdAt < cutoff) uncertainClientRequests.delete(key);
  }
  const signature = clientRequestSignature(payload);
  const uncertain = uncertainClientRequests.get(signature);
  if (uncertain && Date.now() - uncertain.createdAt > REQUEST_RETENTION_MS) {
    uncertainClientRequests.delete(signature);
  }
  const retained = uncertainClientRequests.get(signature);
  if (retained?.result) {
    uncertainClientRequests.delete(signature);
    return Promise.resolve(retained.result);
  }
  const requestId = String(retained?.requestId || payload?.requestId || foundry.utils.randomID(20));
  const completePayload = { ...payload, requestId };
  return new Promise((resolve) => {
    pendingClientRequests.set(requestId, {
      resolve,
      startedAt: Date.now(),
      errorKey,
      signature,
      timer: null
    });
    if (retained) {
      game.socket.emit(SOCKET_NAME, {
        type: "transaction-status-request",
        requestId,
        userId: game.user.id,
        targetGMId: gm.id
      });
    } else {
      game.socket.emit(SOCKET_NAME, completePayload);
    }
    scheduleStatusCheck(requestId, REQUEST_TIMEOUT_MS);
  });
}

export function transactionStatus(userId, requestId) {
  const record = completedRequests.get(requestKey(userId, requestId));
  return record ? { state: record.state, result: record.result } : { state: "unknown", result: null };
}
