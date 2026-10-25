const MODULE_ID = "khuzoe-address-sender";
const UI_ID = "khuzoe-address-sender-actions";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "discordWebhook", {
    name: "KHAS.Settings.Webhook.Name",
    hint: "KHAS.Settings.Webhook.Hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "lastSentAddress", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "lastSentWebhook", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "customPort", {
    name: "KHAS.Settings.Port.Name",
    hint: "KHAS.Settings.Port.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 65535, step: 1 }
  });
});

// Settings is an ApplicationV2 in Foundry V14. Its render hook receives a
// native HTMLElement instead of the jQuery wrapper used by the V12 module.
Hooks.on("renderSettings", (application, html) => {
  if (!game.user?.isGM) return;
  injectButtons(applicationElement(application, html));
});

Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;

  const settings = ui.sidebar?.tabs?.settings;
  if (settings?.rendered) injectButtons(applicationElement(settings, settings.element));

  try {
    await autoSendIfChanged();
  } catch (error) {
    console.warn(`[${MODULE_ID}] Invio automatico ignorato: impossibile determinare l'indirizzo pubblico.`, error);
  }
});

async function getServerAddress() {
  const customPort = Number(game.settings.get(MODULE_ID, "customPort"));
  const browserPort = Number(window.location.port);
  const defaultPort = window.location.protocol === "https:" ? 443 : 30000;
  const port = validPort(customPort) && customPort > 0
    ? customPort
    : (validPort(browserPort) && browserPort > 0 ? browserPort : defaultPort);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch("https://api.ipify.org", {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Servizio IP: HTTP ${response.status}`);

    const ip = (await response.text()).trim();
    if (!isIpv4(ip)) throw new Error("Il servizio IP ha restituito un indirizzo non valido.");
    return `${ip}:${port}`;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function postAddressToDiscord(address, webhook) {
  if (!webhook) {
    ui.notifications.warn(localize("Notifications.MissingWebhook", "Configura prima il webhook Discord nelle impostazioni del modulo."));
    return false;
  }

  const content = `Link di accesso: http://${address}/`;

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!response.ok) throw new Error(`Discord webhook: HTTP ${response.status}`);

    ui.notifications.info(localize("Notifications.Sent", "Indirizzo inviato su Discord!"));
    return true;
  } catch (error) {
    console.error(`[${MODULE_ID}] Invio al webhook Discord fallito.`, error);
    ui.notifications.error(localize("Notifications.SendFailed", "Invio a Discord fallito. Controlla il webhook e riprova."));
    return false;
  }
}

async function autoSendIfChanged() {
  const webhook = String(game.settings.get(MODULE_ID, "discordWebhook") ?? "").trim();
  if (!webhook) return;

  const address = await getServerAddress();
  const lastAddress = game.settings.get(MODULE_ID, "lastSentAddress");
  const lastWebhook = game.settings.get(MODULE_ID, "lastSentWebhook");
  if (address === lastAddress && webhook === lastWebhook) return;

  if (await postAddressToDiscord(address, webhook)) await rememberSuccessfulSend(address, webhook);
}

function injectButtons(root) {
  if (!root?.querySelector || root.querySelector(`#${UI_ID}`)) return;

  const group = document.createElement("section");
  group.id = UI_ID;
  group.className = "khas-address-card";
  group.setAttribute("aria-label", localize("UI.Title", "Indirizzo server"));
  group.innerHTML = `
    <div class="khas-address-heading">
      <i class="fa-solid fa-globe" aria-hidden="true"></i>
      <span>${escapeHtml(localize("UI.Title", "Indirizzo server"))}</span>
    </div>
    <div class="khas-address-actions">
      <button type="button" data-khas-action="copy" data-tooltip="${escapeHtml(localize("UI.Copy", "Copia indirizzo"))}">
        <i class="fa-solid fa-copy" aria-hidden="true"></i>
        <span>${escapeHtml(localize("UI.Copy", "Copia"))}</span>
      </button>
      <button type="button" data-khas-action="send" data-tooltip="${escapeHtml(localize("UI.Send", "Invia su Discord"))}">
        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
        <span>${escapeHtml(localize("UI.Send", "Invia"))}</span>
      </button>
    </div>
  `;

  group.addEventListener("click", onAddressAction);
  const target = root.querySelector(".settings-sidebar") ?? root;
  target.append(group);
}

async function onAddressAction(event) {
  const button = event.target.closest("[data-khas-action]");
  if (!button || button.disabled) return;

  setButtonBusy(button, true);
  try {
    const address = await getServerAddress();
    if (button.dataset.khasAction === "copy") {
      await copyText(address);
      ui.notifications.info(localize("Notifications.Copied", "Indirizzo copiato negli appunti!"));
      return;
    }

    const webhook = String(game.settings.get(MODULE_ID, "discordWebhook") ?? "").trim();
    if (await postAddressToDiscord(address, webhook)) await rememberSuccessfulSend(address, webhook);
  } catch (error) {
    console.error(`[${MODULE_ID}] Impossibile determinare l'indirizzo pubblico.`, error);
    ui.notifications.error(localize("Notifications.AddressFailed", "Impossibile recuperare l'indirizzo IP pubblico. Riprova tra poco."));
  } finally {
    setButtonBusy(button, false);
  }
}

async function rememberSuccessfulSend(address, webhook) {
  await Promise.all([
    game.settings.set(MODULE_ID, "lastSentAddress", address),
    game.settings.set(MODULE_ID, "lastSentWebhook", webhook)
  ]);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch (_error) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Copia negli appunti non riuscita.");
  }
}

function setButtonBusy(button, busy) {
  button.disabled = busy;
  button.toggleAttribute("aria-busy", busy);
  button.querySelector("i")?.classList.toggle("fa-spin", busy);
}

function applicationElement(application, html) {
  const candidates = [html, html?.[0], application?.element, application?.element?.[0]];
  return candidates.find(candidate => typeof candidate?.querySelector === "function") ?? null;
}

function validPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

function isIpv4(value) {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function localize(key, fallback) {
  const translationKey = `KHAS.${key}`;
  const translated = game.i18n?.localize?.(translationKey);
  return translated && translated !== translationKey ? translated : fallback;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}
