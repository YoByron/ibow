import { type Child, h } from "../dom.ts";

/** A pill in a rail: a toggle button (`aria-pressed`) or a link (`aria-current`). */
export function pill(opts: {
  label: Child;
  icon?: Node | undefined;
  selected?: boolean;
  href?: string;
  onClick?: () => void;
  testid?: string;
}): HTMLElement {
  const cls = `pill${opts.icon ? " has-icon" : ""}`;
  if (opts.href !== undefined) {
    return h(
      "a",
      { class: cls, href: opts.href, "aria-current": opts.selected ? "page" : undefined, "data-testid": opts.testid },
      opts.icon,
      opts.label,
    );
  }
  return h(
    "button",
    {
      type: "button",
      class: cls,
      "aria-pressed": String(opts.selected ?? false),
      "data-testid": opts.testid,
      on: opts.onClick ? { click: opts.onClick } : {},
    },
    opts.icon,
    opts.label,
  );
}

/** A small label: a status, a count, a marker. */
export function badge(text: Child, tone: "ok" | "warn" | "accent" | "gray" | "err" = "gray"): HTMLElement {
  return h("span", { class: tone === "gray" ? "chip" : `chip ${tone}` }, text);
}
