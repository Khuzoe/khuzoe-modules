import { escapeHTML, localize } from "./utils.js";
import { DialogV2 } from "./foundry-compat.js";

function precisionValue(value) {
  return Math.max(0, Math.min(4, Math.floor(Number(value) || 0)));
}

function amountAtPrecision(value, precision) {
  const number = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** precisionValue(precision);
  return Math.floor((number + Number.EPSILON) * factor) / factor;
}

function amountLabel(value, precision) {
  return new Intl.NumberFormat(game.i18n.lang, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precisionValue(precision)
  }).format(Number(value) || 0);
}

export async function promptQuantity({
  itemName = "",
  maximum = 1,
  precision = 0,
  mode = "take",
  initial = undefined
} = {}) {
  const digits = precisionValue(precision);
  const step = 1 / (10 ** digits);
  const max = amountAtPrecision(maximum, digits);
  if (!(max > 0)) return null;
  if (max <= step + Number.EPSILON) return max;

  const requestedInitial = amountAtPrecision(initial ?? step, digits);
  const startingValue = Math.min(max, Math.max(step, requestedInitial || step));
  const titleKey = mode === "deposit" ? "KM.QuantityDialog.DepositTitle" : "KM.QuantityDialog.TakeTitle";
  const introKey = mode === "deposit" ? "KM.QuantityDialog.DepositIntro" : "KM.QuantityDialog.TakeIntro";
  const actionKey = mode === "deposit" ? "KM.QuantityDialog.Deposit" : "KM.QuantityDialog.Take";
  const safeItemName = escapeHTML(itemName || localize("KM.QuantityDialog.Something"));
  const content = `
    <div class="km-quantity-dialog-form">
      <p>${localize(introKey, { item: safeItemName })}</p>
      <div class="km-quantity-dialog-available">
        <span>${localize("KM.QuantityDialog.Available")}</span>
        <strong>${amountLabel(max, digits)}</strong>
      </div>
      <label>
        <span>${localize("KM.QuantityDialog.Quantity")}</span>
        <input type="number" name="quantity" min="${step}" max="${max}" step="${step}"
          value="${startingValue}" inputmode="${digits > 0 ? "decimal" : "numeric"}" autofocus>
      </label>
    </div>`;

  const formData = await DialogV2.input({
    classes: ["khuzoe-merchant", "khuzoe-quantity-dialog-window", "km-application-v14"],
    window: { title: localize(titleKey), icon: "fa-solid fa-arrow-right-arrow-left" },
    position: { width: 380 },
    content,
    ok: { icon: "fa-solid fa-check", label: localize(actionKey) },
    rejectClose: false
  });
  if (!formData) return null;
  const amount = amountAtPrecision(formData.quantity, digits);
  return Math.min(max, Math.max(step, amount || step));
}
