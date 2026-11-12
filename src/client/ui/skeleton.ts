import { h } from "../dom.ts";

/** Grey shapes where the menu will be, so a slow connection shows the page's shape at once. */
export function menuSkeleton(rows = 3): HTMLElement {
  const nbsp = (n: number) => " ".repeat(n);
  return h(
    "div",
    { "aria-hidden": "true" },
    ...Array.from({ length: rows }, () =>
      h(
        "div",
        { class: "sk-item" },
        h(
          "div",
          { class: "tx" },
          h("div", { class: "sk" }, nbsp(8)),
          h("div", { class: "sk" }, nbsp(20)),
          h("div", { class: "sk" }, nbsp(14)),
        ),
        h("div", { class: "sk pic" }),
      ),
    ),
  );
}
