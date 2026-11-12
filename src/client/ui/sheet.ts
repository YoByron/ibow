import { type Child, h } from "../dom.ts";

export interface Sheet {
  close(): void;
  readonly el: HTMLElement;
}

/**
 * A bottom sheet over a scrim: a dialog that closes on Escape, a tap on the scrim or its own close button, and hands
 * focus back to where it was. `body` is built by the caller; nothing here parses HTML.
 */
export function openSheet(opts: {
  title: string;
  subtitle?: string;
  lead?: Node;
  label: string;
  closeLabel: string;
  body: Child[];
  onClose?: () => void;
}): Sheet {
  const previous = document.activeElement as HTMLElement | null;
  const scrim = h("div", { class: "scrim" });
  const closeBtn = h(
    "button",
    { type: "button", class: "xbtn", "aria-label": opts.closeLabel, on: { click: () => close() } },
    "×",
  );
  const el = h(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": opts.label },
    h("div", { class: "grab" }),
    h(
      "div",
      { class: "sheet-head" },
      opts.lead,
      h("div", { class: "tt" }, h("h2", {}, opts.title), opts.subtitle && h("p", {}, opts.subtitle)),
      closeBtn,
    ),
    ...opts.body,
  );
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    scrim.remove();
    el.remove();
    previous?.focus?.();
    opts.onClose?.();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(scrim, el);
  closeBtn.focus();
  return { close, el };
}
