import { DialogV2 } from "./foundry-compat.js";
import { escapeHTML, localize } from "./utils.js";

/** Read the saved bundle without creating temporary Items or Actor documents. */
export function groundLootContainerPreview(loot) {
  if (!loot || loot.kind === "currency") return null;
  const bundle = Array.isArray(loot.itemBundle) && loot.itemBundle.length ? loot.itemBundle : [loot.item];
  const root = bundle[0];
  if (bundle.length < 2 && !["container", "backpack"].includes(root?.type ?? loot.type)) return null;
  const byId = new Map(bundle.filter(Boolean).map(item => [item._id, item]));
  const rows = [];
  for (const [index, item] of bundle.entries()) {
    if (!item) continue;
    if (index > 0) {
      const raw = item.system?.quantity;
      const quantity = Number(typeof raw === "object" ? raw?.value : raw);
      rows.push({
        name: item.name || localize("KM.QuantityDialog.Something"),
        quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
        container: byId.get(item.system?.container)?.name || root?.name || loot.name || ""
      });
    }
    // D&D5e bags may also hold their own native currency.
    for (const [id, value] of Object.entries(item.system?.currency ?? {})) {
      const amount = Number(value);
      if (!(Number.isFinite(amount) && amount > 0)) continue;
      rows.push({name: `${localize("KM.Container.Currency")} (${id.toUpperCase()})`, quantity: amount,
        container: item.name || loot.name || ""});
    }
  }
  return {name: loot.label || loot.name || root?.name || "", rows, wholeBundle: bundle.length > 1};
}

export async function confirmGroundContainerPickup(preview, quantity = 1) {
  const number = value => escapeHTML(new Intl.NumberFormat(game.i18n.lang).format(value));
  const rows = preview.rows.map(row => `<li class="km-ground-preview-row">
    <span class="km-ground-preview-item"><strong>${escapeHTML(row.name)}</strong>
    <small>${escapeHTML(localize("KM.GroundLoot.InContainer", {name: row.container}))}</small></span>
    <span class="km-ground-preview-quantity">× ${number(row.quantity)}</span></li>`).join("");
  return DialogV2.confirm({
    classes: ["khuzoe-merchant", "km-application-v14", "km-ground-preview-window"],
    window: {title: localize("KM.GroundLoot.ContentsTitle"), icon: "fa-solid fa-box-open", resizable: true},
    position: {width: 480},
    content: `<section class="km-ground-preview">
      <h2>${escapeHTML(preview.name)}${quantity > 1 ? ` <small>× ${number(quantity)}</small>` : ""}</h2>
      <p>${escapeHTML(localize("KM.GroundLoot.InspectHint"))}</p>
      <h3>${escapeHTML(localize("KM.GroundLoot.Contents"))}</h3>
      ${rows ? `<ul class="km-ground-preview-list">${rows}</ul>` : `<p class="km-ground-preview-empty">${escapeHTML(localize("KM.GroundLoot.EmptyContainer"))}</p>`}
      <p class="km-ground-preview-footer">${escapeHTML(localize("KM.GroundLoot.TakeContainerHint"))}</p>
    </section>`,
    yes: {label: localize("KM.GroundLoot.Pickup"), icon: "fa-solid fa-hand"},
    no: {label: localize("KM.GroundLoot.LeaveOnGround"), icon: "fa-solid fa-xmark", default: true},
    rejectClose: false
  });
}
