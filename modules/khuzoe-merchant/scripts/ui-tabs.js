export function resolveInterfaceRoot(html) {
  if (!html) return null;
  // ApplicationV2 uses a real HTMLFormElement as its root. Forms are array-like,
  // so checking html[0] first incorrectly resolves to their first input.
  if (typeof html.querySelectorAll === "function") return html;
  return html[0] || null;
}

export function activateInterfaceTabs(html, activeTab, onChange = () => {}) {
  const root = resolveInterfaceRoot(html);
  if (!root) return;
  const buttons = [...root.querySelectorAll("[data-km-tab]")];
  const panels = [...root.querySelectorAll("[data-km-panel]")];
  if (!buttons.length || !panels.length) return;

  const available = new Set(buttons.map((button) => button.dataset.kmTab));
  let selected = available.has(activeTab) ? activeTab : buttons[0].dataset.kmTab;

  const select = (tab, { focus = false, notify = true } = {}) => {
    if (!available.has(tab)) return;
    selected = tab;
    for (const button of buttons) {
      const current = button.dataset.kmTab === tab;
      button.classList.toggle("is-active", current);
      button.setAttribute("aria-selected", String(current));
      button.tabIndex = current ? 0 : -1;
      if (current && focus) button.focus();
    }
    for (const panel of panels) {
      const current = panel.dataset.kmPanel === tab;
      panel.hidden = !current;
      panel.classList.toggle("is-active", current);
    }
    if (notify) onChange(tab);
  };

  for (const button of buttons) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      select(button.dataset.kmTab);
    });
    button.addEventListener("keydown", (event) => {
      if (!new Set(["ArrowLeft", "ArrowRight", "Home", "End"]).has(event.key)) return;
      event.preventDefault();
      const currentIndex = buttons.findIndex((candidate) => candidate.dataset.kmTab === selected);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[nextIndex].dataset.kmTab, { focus: true });
    });
  }
  select(selected, { notify: false });
}
