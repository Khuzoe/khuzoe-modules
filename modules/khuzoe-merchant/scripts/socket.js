import {
  MAX_PURCHASE_QUANTITY,
  MODULE_ID,
  SOCKET_NAME
} from "./constants.js";
import { planDeduction } from "./currency-v2.js";
import { isWithinDistance } from "./distance.js";
import {
  canonicalActor,
  clampInteger,
  duplicate,
  escapeHTML,
  getMerchant,
  isActorOwner,
  localize,
  logError,
  primaryGM
} from "./utils.js";
import { enqueueAuthoritativeRequest, requestTrackedOperation } from "./transaction-coordinator.js";
import { applyItemBundle, prepareStoredItemBundle, rollbackAppliedItems } from "./item-transfer.js";
import { getAuthoritativeMerchant, saveAuthoritativeMerchant } from "./container-store.js";
import { isInventoryToken } from "./map-object.js";

function response(request, result) {
  if (!request.local) {
    game.socket.emit(SOCKET_NAME, {
      type: "purchase-response",
      requestId: request.requestId,
      targetUserId: request.userId,
      ...result
    });
  }
  return result;
}

function fail(request, errorKey, errorData = {}) {
  return response(request, { ok: false, errorKey, errorData });
}

function documentsForRequest(request) {
  const scene = game.scenes.get(request.sceneId);
  const merchantToken = scene?.tokens.get(request.merchantTokenId);
  const buyerToken = scene?.tokens.get(request.buyerTokenId);
  return {
    scene,
    merchantToken,
    buyerToken,
    merchantActor: canonicalActor(merchantToken?.actor),
    buyerActor: buyerToken?.actor ?? null
  };
}

async function sourceDataForPurchase(entry, quantity) {
  const bundle = await prepareStoredItemBundle(entry, quantity, {
    moduleFlag: "purchased",
    flagData: { sourceUuid: entry.sourceUuid || null }
  });
  if (!bundle?.length || bundle.some((data) => !data || typeof data !== "object" || !data.name || !data.type)) {
    throw new Error("L'Oggetto originale non e piu disponibile e la copia salvata non e valida.");
  }
  return bundle;
}

async function createReceipt({ buyerUser, buyerActor, merchantActor, entry, quantity, totalLabel }) {
  if (!game.settings.get(MODULE_ID, "chatReceipts")) return;
  const content = `
    <div class="km-chat-receipt">
      <strong>${escapeHTML(localize("KM.Receipt.Title"))}</strong>
      <p>${escapeHTML(localize("KM.Receipt.Body", {
        buyer: buyerActor.name,
        quantity,
        item: entry.name,
        merchant: merchantActor.name,
        price: totalLabel
      }))}</p>
    </div>`;
  const gmIds = game.users.filter((user) => user.isGM).map((user) => user.id);
  const whisper = [...new Set([buyerUser.id, ...gmIds])];
  await ChatMessage.create({
    speaker: { alias: merchantActor.name },
    content,
    whisper
  });
}

async function rollbackTransaction(buyerActor, deduction, itemTransaction) {
  const errors = [];
  await rollbackAppliedItems(buyerActor, itemTransaction, { khuzoeMerchantRollback: true });
  try {
    await buyerActor.update(deduction.rollback, { khuzoeMerchantRollback: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) logError("A purchase rollback was incomplete", errors);
}

async function processPurchase(request, senderUserId) {
  const electedGM = primaryGM();
  if (!game.user.isGM || electedGM?.id !== game.user.id) return;

  if (!senderUserId || request.userId !== senderUserId) return;
  const buyerUser = game.users.get(senderUserId);
  if (!buyerUser?.active) return fail(request, "KM.Errors.UserUnavailable");
  if (buyerUser.viewedScene !== request.sceneId) return fail(request, "KM.Errors.SceneUnavailable");

  const { scene, merchantToken, buyerToken, merchantActor, buyerActor } = documentsForRequest(request);
  if (!scene || !merchantToken || !buyerToken || !merchantActor || !buyerActor) {
    return fail(request, "KM.Errors.TokenUnavailable");
  }
  if (merchantToken.id === buyerToken.id || !isInventoryToken(buyerToken)) return fail(request, "KM.Errors.InvalidBuyer");
  if (merchantToken.hidden && !buyerUser.isGM) return fail(request, "KM.Errors.TokenUnavailable");
  if (!isActorOwner(buyerActor, buyerUser)) return fail(request, "KM.Errors.NotOwner");

  const merchant = await getAuthoritativeMerchant(merchantActor);
  if (!merchant.enabled) return fail(request, "KM.Errors.NotMerchant");
  if (!isWithinDistance(buyerToken, merchantToken, merchant.distance)) {
    return fail(request, "KM.Errors.OutOfRange", { distance: merchant.distance, unit: scene.grid.units || "" });
  }

  const quantity = clampInteger(request.quantity, 1, MAX_PURCHASE_QUANTITY);
  if (quantity !== Number(request.quantity)) return fail(request, "KM.Errors.InvalidQuantity");
  const entry = merchant.inventory.find((item) => item.id === request.itemId);
  if (!entry) return fail(request, "KM.Errors.ItemUnavailable");

  let stock = null;
  if (entry.stock !== null && entry.stock !== undefined) {
    stock = Number(entry.stock);
    if (!Number.isSafeInteger(stock) || stock < 0) return fail(request, "KM.Errors.ItemUnavailable");
    if (stock < quantity) return fail(request, "KM.Errors.NotEnoughStock");
  }

  const deduction = planDeduction(buyerActor, entry, quantity);
  if (!deduction.sufficient) {
    return fail(request, "KM.Errors.NotEnoughMoney", { price: deduction.totalLabel, balance: deduction.balanceLabel });
  }

  let itemTransaction = { createdIds: [], updatedStacks: [] };
  try {
    const createData = await sourceDataForPurchase(entry, quantity);
    await buyerActor.update(deduction.update, { khuzoeMerchantPurchase: true });
    try {
      itemTransaction = await applyItemBundle(buyerActor, createData, { khuzoeMerchantPurchase: true });

      if (stock !== null) {
        const updatedMerchant = duplicate(merchant);
        updatedMerchant.schemaVersion = 2;
        updatedMerchant.revision = merchant.revision + 1;
        const updatedEntry = updatedMerchant.inventory.find((item) => item.id === entry.id);
        updatedEntry.stock = stock - quantity;
        await saveAuthoritativeMerchant(merchantActor, updatedMerchant);
      }
    } catch (error) {
      await rollbackTransaction(buyerActor, deduction, itemTransaction);
      throw error;
    }
  } catch (error) {
    logError("Transazione di acquisto non riuscita", error);
    return fail(request, "KM.Errors.Transaction");
  }

  try {
    await createReceipt({ buyerUser, buyerActor, merchantActor, entry, quantity, totalLabel: deduction.totalLabel });
  } catch (error) {
    logError("The purchase succeeded but its chat receipt could not be created", error);
  }

  return response(request, {
    ok: true,
    itemName: entry.name,
    quantity,
    totalLabel: deduction.totalLabel,
    newBalanceLabel: deduction.newBalanceLabel
  });
}

function handleSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object") return;
  if (message.type === "purchase-request") {
    if (!senderUserId || message.userId !== senderUserId) return;
    const gm = primaryGM();
    if (!game.user?.isGM || gm?.id !== game.user.id) return;
    void enqueueAuthoritativeRequest({
      request: message,
      senderUserId,
      execute: () => processPurchase(message, senderUserId),
      replay: (result) => response(message, result),
      label: "purchase request",
      failureResult: { ok: false, errorKey: "KM.Errors.Transaction", errorData: {} }
    });
  }
}

export function initializeSocket() {
  game.socket.on(SOCKET_NAME, handleSocketMessage);
}

export function requestPurchase({ merchantToken, buyerToken, itemId, quantity }) {
  const requestId = foundry.utils.randomID(20);
  const payload = {
    type: "purchase-request",
    requestId,
    userId: game.user.id,
    sceneId: merchantToken.document.parent.id,
    merchantTokenId: merchantToken.id,
    buyerTokenId: buyerToken.id,
    itemId,
    quantity: Number(quantity)
  };

  const gm = primaryGM();
  if (!gm) return Promise.resolve({ ok: false, errorKey: "KM.Errors.NoGM", errorData: {} });
  if (gm.id === game.user.id) {
    payload.local = true;
    return enqueueAuthoritativeRequest({
      request: payload,
      senderUserId: game.user.id,
      execute: () => processPurchase(payload, game.user.id),
      label: "local purchase request",
      failureResult: { ok: false, errorKey: "KM.Errors.Transaction", errorData: {} }
    });
  }
  return requestTrackedOperation(payload, { errorKey: "KM.Errors.Transaction" });
}
