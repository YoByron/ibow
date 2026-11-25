/**
 * The manager's day-to-day screen (D-072): switch an item on or off and set what is left of it today. Built from the shared
 * components and the staff styles; it holds no state of its own, each action re-reads the catalog the server holds.
 */

import type { Category } from "../core/config.ts";
import { api } from "./api.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";
import { button } from "./ui/button.ts";

interface LiveCatalog {
  categories: Category[];
  left?: Record<string, number>;
}

/** The list of items with an On/Off button and a count box each. `fail` shows an error the way the staff screens do. */
export async function managerBody(
  redraw: () => void,
  fail: (e: unknown) => void,
  error: HTMLElement,
): Promise<Child[]> {
  const live = await api<LiveCatalog>("GET", "/api/catalog");
  const put = async (itemId: string, body: { available?: boolean; count?: number | null }) => {
    error.textContent = "";
    try {
      await api("PUT", `/api/menu/items/${encodeURIComponent(itemId)}`, { body });
      redraw();
    } catch (e) {
      fail(e);
    }
  };
  return [
    error,
    ...live.categories.map((c) =>
      h(
        "section",
        { class: "mgr-cat", "data-testid": `mgr-${c.id}` },
        h("h2", {}, c.name),
        h(
          "ul",
          { class: "lines" },
          ...c.items.map((item) => {
            const on = item.available !== false;
            const left = live.left?.[item.id];
            const box = h("input", {
              type: "number",
              inputmode: "numeric",
              min: "0",
              max: "100000",
              "aria-label": t("countLabel"),
              "data-key": `count-${item.id}`,
              value: left === undefined ? "" : String(left),
              placeholder: t("countNone"),
            });
            return h(
              "li",
              { class: on ? "" : "served" },
              h("span", { class: "line-name" }, item.name),
              h("span", { class: "hint" }, left === undefined ? t("countNone") : t("countLeft", { n: String(left) })),
              button(
                {
                  kind: on ? "primary" : "ghost",
                  small: true,
                  testid: `switch-${item.id}`,
                  onClick: () => void put(item.id, { available: !on }),
                },
                on ? t("itemOn") : t("itemOff"),
              ),
              box,
              button(
                {
                  kind: "ghost",
                  small: true,
                  testid: `set-${item.id}`,
                  onClick: () => {
                    const n = box.value.trim() === "" ? null : Number(box.value);
                    void put(item.id, { count: n });
                  },
                },
                t("countSet"),
              ),
            );
          }),
        ),
      ),
    ),
  ];
}
