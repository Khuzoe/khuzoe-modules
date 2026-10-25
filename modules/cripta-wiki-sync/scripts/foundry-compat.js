/** Native Foundry V14 application boundary. */

export const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
export const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;
export const HandlebarsApplicationV2 = HandlebarsApplicationMixin(ApplicationV2);

function normalizeDialogContent(content) {
    const html = String(content || "");
    if (!/^\s*<form\b/i.test(html) || !/<\/form>\s*$/i.test(html)) return html;
    return html
        .replace(/^(\s*)<form\b([^>]*)>/i, "$1<div$2>")
        .replace(/<\/form>(\s*)$/i, "</div>$1");
}

function legacyDialogHtml(dialog) {
    const element = dialog?.element || null;
    const jquery = globalThis.jQuery || globalThis.$;
    return typeof jquery === "function" ? jquery(element) : element;
}

function normalizeDialogIcon(icon) {
    const value = String(icon || "").trim();
    if (!value.includes("<")) return value;
    return value.match(/class=["']([^"']+)["']/i)?.[1] || "";
}

function dialogPosition(options = {}) {
    const position = {};
    if (options.width !== undefined) position.width = options.width;
    if (options.height !== undefined) position.height = options.height;
    return position;
}

/** Render a native V14 dialog while preserving the module's existing callback contract. */
export function renderDialog(data = {}, options = {}) {
    const buttons = Object.entries(data.buttons || {})
        .filter(([, button]) => button?.condition !== false)
        .map(([action, button]) => ({
            action,
            label: button.label || action,
            icon: normalizeDialogIcon(button.icon),
            class: button.cssClass || "",
            default: data.default === action,
            callback: async (event, _button, dialog) => button.callback?.(legacyDialogHtml(dialog), event)
        }));
    const applicationOptions = {
        classes: options.classes || [],
        window: { title: data.title || "Dialogo", resizable: options.resizable === true },
        position: dialogPosition(options),
        content: normalizeDialogContent(data.content),
        buttons,
        modal: options.modal === true
    };
    if (options.id) applicationOptions.id = options.id;
    const dialog = new DialogV2(applicationOptions);
    if (typeof data.render === "function") {
        dialog.addEventListener("render", () => data.render(legacyDialogHtml(dialog)));
    }
    if (typeof data.close === "function") {
        dialog.addEventListener("close", () => data.close(legacyDialogHtml(dialog)), { once: true });
    }
    dialog.render({ force: true });
    return dialog;
}

/** Native V14 confirmation dialog with the former boolean return behavior. */
export function confirmDialog({ title, content, yes, no, render, defaultYes = true, rejectClose = false, options = {} } = {}) {
    return DialogV2.confirm({
        window: { title: title || "Conferma" },
        classes: options.classes || [],
        position: dialogPosition(options),
        content: normalizeDialogContent(content),
        modal: true,
        rejectClose,
        yes: {
            default: defaultYes,
            callback: async (_event, _button, dialog) => {
                await yes?.(legacyDialogHtml(dialog));
                return true;
            }
        },
        no: {
            default: !defaultYes,
            callback: async (_event, _button, dialog) => {
                await no?.(legacyDialogHtml(dialog));
                return false;
            }
        },
        render: typeof render === "function" ? (_event, dialog) => render(legacyDialogHtml(dialog)) : undefined
    });
}

export function openApplications() {
    const applications = new Set(Object.values(globalThis.ui?.windows || {}));
    const instances = globalThis.foundry?.applications?.instances;
    if (instances?.values) {
        for (const application of instances.values()) applications.add(application);
    }
    return applications;
}

export function renderApplication(application, { force = false } = {}) {
    if (!application?.render) return null;
    if (ApplicationV2 && application instanceof ApplicationV2) return application.render({ force });
    return application.render(force);
}

export function rerenderApplication(application) {
    return renderApplication(application, { force: false });
}
