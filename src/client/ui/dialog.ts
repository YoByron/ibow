/**
 * A modal dialog (M13) for every "can't do that now": closed, last order passed, sold out, offline, a failure. Built on
 * the native `<dialog>`, so focus is held inside, Escape closes it and the page behind is inert; styled by tokens.
 */

import { type Child, h } from "../dom.ts";
import { button } from "./button.ts";
import { icon } from "./icon.ts";

export interface DialogAction {
  label: string;
  kind?: "primary" | "accent" | "ghost";
  /** Runs after the dialog closes. */
  onClick?: () => void;
}

export interface DialogOptions {
  /** A name from the icon set, shown large above the title. */
  icon?: string;
  title: string;
  body?: Child;
  /** The first action is the default and takes the focus; without any, one "OK" closes it. */
  actions?: DialogAction[];
  /** Words for the default "OK". */
  ok?: string;
  testid?: string;
  /** "warn" tints the icon for a hard stop (closed, sold out); the default is calm. */
  tone?: "calm" | "warn";
}

let open: HTMLDialogElement | undefined;

/** Shows the dialog (replacing one already open) and resolves when it closes. */
export function showDialog(o: DialogOptions): Promise<void> {
  open?.close();
  const actions = o.actions && o.actions.length > 0 ? o.actions : [{ label: o.ok ?? "OK", kind: "primary" as const }];
  return new Promise((resolve) => {
    const buttons = actions.map((a) =>
      button(
        {
          kind: a.kind ?? "primary",
          onClick: () => {
            dialog.close();
            a.onClick?.();
          },
        },
        a.label,
      ),
    );
    const dialog = h(
      "dialog",
      { class: `dlg${o.tone === "warn" ? " warn" : ""}`, "aria-labelledby": "dlg-title", "data-testid": o.testid },
      h(
        "div",
        { class: "dlg-in" },
        o.icon && h("span", { class: "dlg-ic", "aria-hidden": "true" }, icon(o.icon)),
        h("h2", { id: "dlg-title" }, o.title),
        o.body !== undefined && h("div", { class: "dlg-body" }, o.body),
        h("div", { class: "dlg-acts" }, ...buttons),
      ),
    );
    // A tap on the backdrop (outside the panel) closes it, as on a phone's sheet.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (open === dialog) open = undefined;
      resolve();
    });
    document.body.append(dialog);
    open = dialog;
    dialog.showModal();
    buttons[0]?.focus();
  });
}
