const MODULE_ID = "khuzoe-automations";
const SELECTOR = '[data-khuzoe-action="sheet-automations"]';

export function automationStatus(actor, {getSupportedAutomation, isCurrent}) {
  const counts = {total: 0, missing: 0, outdated: 0, current: 0};
  for (const item of actor?.items?.values?.() ?? actor?.items ?? []) {
    const automation = getSupportedAutomation(item);
    if (!automation) continue;
    counts.total++;
    if (item.flags?.cat?.automation?.source !== MODULE_ID) counts.missing++;
    else if (!isCurrent(item, automation)) counts.outdated++;
    else counts.current++;
  }
  const state = !counts.total ? "empty" : counts.missing ? "missing" : counts.outdated ? "outdated" : "current";
  const details = [
    counts.missing ? `${counts.missing} da applicare` : "",
    counts.outdated ? `${counts.outdated} da aggiornare` : "",
    counts.current ? `${counts.current} aggiornate` : ""
  ].filter(Boolean).join(" · ");
  return {...counts, state, label: `Khuzoe Automations — ${details || "nessuna capacità supportata"}`};
}

function isActorSheet(app) {
  const classes = [
    globalThis.foundry?.applications?.sheets?.ActorSheetV2,
    globalThis.foundry?.appv1?.sheets?.ActorSheet
  ];
  return classes.some(cls => typeof cls === "function" && app instanceof cls);
}

export function createAutomationToolbar({getSupportedAutomation, isCurrent, canManage, applyAll}) {
  const sheets = new Map();
  const busyActors = new Set();
  const actorKey = actor => actor.uuid ?? actor;
  const actorOf = app => app.actor ?? app.document ?? app.object;

  function paint(app, button) {
    const actor = actorOf(app);
    const status = automationStatus(actor, {getSupportedAutomation, isCurrent});
    const busy = busyActors.has(actorKey(actor));
    const permitted = canManage(actor);
    const label = busy ? "Khuzoe Automations — applicazione in corso…"
      : status.label + (!permitted ? ". Serve il proprietario del personaggio o il GM."
        : status.missing || status.outdated ? ". Clicca per applicare o aggiornare." : "");
    button.dataset.khuzoeState = status.state;
    button.dataset.tooltip = label;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-busy", String(busy));
    button.disabled = busy || !permitted || !status.total;
    button.querySelector(".khz-automation-symbol").className = busy
      ? "khz-automation-symbol fa-solid fa-spinner fa-spin"
      : "khz-automation-symbol fa-solid fa-wand-magic-sparkles";
    button.querySelector(".khz-automation-status").textContent = {
      empty: "–", missing: "!", outdated: "↑", current: "✓"
    }[status.state];
  }

  function refresh(actor) {
    if (!actor) return;
    for (const [app, button] of sheets) {
      if (!button.isConnected) { sheets.delete(app); continue; }
      if (actorKey(actorOf(app)) === actorKey(actor)) paint(app, button);
    }
  }

  function render(app, html) {
    if (!isActorSheet(app)) return;
    const actor = actorOf(app);
    if (actor?.documentName !== "Actor") return;
    const element = app.element;
    const root = element?.querySelector ? element : element?.[0] ?? html?.[0] ?? html;
    const header = root?.querySelector?.(".window-header");
    if (!header) return;
    let button = header.querySelector(SELECTOR);
    if (!button) {
      button = header.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "header-control khz-automation-control";
      button.dataset.khuzoeAction = "sheet-automations";
      button.innerHTML = '<i class="khz-automation-symbol fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>'
        + '<span class="khz-automation-status" aria-hidden="true"></span>';
      // Direct header child: D&D5e moves registered header controls into its
      // ellipsis menu. This shortcut remains visible without altering that menu.
      const controls = header.querySelector('[data-action="toggleControls"], [data-action="close"], .close');
      header.insertBefore(button, controls);
      for (const event of ["pointerdown", "mousedown", "dblclick"]) {
        button.addEventListener(event, e => e.stopPropagation());
      }
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const currentActor = actorOf(app);
        const key = actorKey(currentActor);
        if (busyActors.has(key) || !canManage(currentActor)) return;
        busyActors.add(key);
        refresh(currentActor);
        try {
          await applyAll(currentActor, app, button);
        } catch (error) {
          console.error("Khuzoe Automations | Applicazione dalla scheda non riuscita.", error);
          globalThis.ui?.notifications?.error("Khuzoe Automations: applicazione non riuscita. Controlla la console.");
        } finally {
          busyActors.delete(key);
          refresh(currentActor);
        }
      });
    }
    sheets.set(app, button);
    paint(app, button);
  }

  return {render, refresh, close: app => sheets.delete(app)};
}
