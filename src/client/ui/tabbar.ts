import { h } from "../dom.ts";

export interface Tab {
  id: string;
  label: string;
  icon: Node;
  href: string;
  badge?: number;
}

/** A fixed bottom bar of links; the current one is `aria-current="page"`. */
export function tabBar(tabs: readonly Tab[], current: string, label: string): HTMLElement {
  return h(
    "nav",
    { class: "tabs", "aria-label": label },
    h(
      "div",
      { class: "tabs-in" },
      ...tabs.map((t) =>
        h(
          "a",
          {
            class: "tab",
            href: t.href,
            "aria-current": t.id === current ? "page" : undefined,
            "data-testid": `tab-${t.id}`,
          },
          t.icon,
          t.label,
          t.badge ? h("span", { class: "bd num" }, t.badge) : null,
        ),
      ),
    ),
  );
}
