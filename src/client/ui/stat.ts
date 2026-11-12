import { type Child, h } from "../dom.ts";

/** A figure with its label and a line under it. `tone` colours the number only. */
export function stat(o: {
  label: string;
  value: Child;
  sub?: Child;
  tone?: "accent" | "ok" | "warn";
  icon?: Node;
  testid?: string;
}): HTMLElement {
  return h(
    "div",
    { class: `stat${o.tone ? ` ${o.tone}` : ""}`, "data-testid": o.testid },
    h("div", { class: "lb" }, o.icon, o.label),
    h("div", { class: "v" }, o.value),
    o.sub !== undefined && h("div", { class: "s" }, o.sub),
  );
}
