import { type Child, h } from "../dom.ts";

export interface ButtonOptions {
  kind?: "primary" | "accent" | "ghost" | "link";
  small?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
  /** An accessible name when the visible text isn't enough. */
  label?: string;
  testid?: string;
  onClick?: (e: MouseEvent) => void;
  class?: string;
}

/** A button styled only through tokens. */
export function button(opts: ButtonOptions, ...children: Child[]): HTMLButtonElement {
  return h(
    "button",
    {
      type: opts.type ?? "button",
      class: `btn btn-${opts.kind ?? "primary"}${opts.small ? " sm" : ""}${opts.class ? ` ${opts.class}` : ""}`,
      disabled: opts.disabled,
      "aria-label": opts.label,
      "data-testid": opts.testid,
      on: opts.onClick ? { click: opts.onClick } : {},
    },
    ...children,
  );
}

/** A round button for a header: an icon and a name for screen readers. */
export function roundButton(label: string, icon: Node, onClick: () => void, accent = false): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: `rbtn${accent ? " accent" : ""}`, "aria-label": label, on: { click: onClick } },
    icon,
  );
}

/** A link that looks like a button. */
export function linkButton(href: string, kind: ButtonOptions["kind"], ...children: Child[]): HTMLAnchorElement {
  return h("a", { class: `btn btn-${kind ?? "primary"}`, href }, ...children);
}
