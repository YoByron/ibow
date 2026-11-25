/**
 * The sheet that opens when an item has sizes, extras or both: pick a size, pick extras within each group's min and max,
 * add a note, set the quantity, add. Shared by the storefront and the counter, so both price and validate the same way.
 * Built from the shared `ui/` components; the strings come from the caller's `t`.
 */

import type { CatalogItem, ExtraGroup } from "../core/config.ts";
import { extraGroupsOf, type StoreCatalog } from "./catalog.ts";
import { h, mount } from "./dom.ts";
import { button } from "./ui/button.ts";
import { badge } from "./ui/chip.ts";
import { openSheet } from "./ui/sheet.ts";
import { stepper } from "./ui/stepper.ts";

/** Whether adding an item needs the sheet: it has sizes or extras. Plain items add in one tap. */
export function needsOptions(catalog: StoreCatalog, item: CatalogItem): boolean {
  return item.variants !== undefined || extraGroupsOf(catalog, item.id).length > 0;
}

export interface Choice {
  size?: string;
  extras: string[];
  note?: string;
  qty: number;
}

export function openOptions(o: {
  catalog: StoreCatalog;
  item: CatalogItem;
  /** Formats minor units. */
  money: (minor: number) => string;
  /** The item's tile, shown in the sheet's head. */
  lead?: Node;
  /** Most units still addable (the line cap less what the cart holds). */
  room: (choice: { size?: string; extras: string[] }) => number;
  t: (key: string, vars?: Record<string, string>) => string;
  onAdd: (choice: Choice) => void;
}): void {
  const { item } = o;
  const variants = item.variants ?? [];
  const groups = extraGroupsOf(o.catalog, item.id);
  let size: string | undefined = variants[0]?.size;
  const picked = new Set<string>();
  let note = "";
  let qty = 1;
  const body = h("div", { class: "options" });
  const foot = h("div", { class: "sheet-foot" });
  const sheet = openSheet({
    title: item.name,
    ...(item.description ? { subtitle: item.description } : {}),
    ...(o.lead ? { lead: o.lead } : {}),
    label: groups.length === 0 ? o.t("sizesFor", { item: item.name }) : o.t("optionsFor", { item: item.name }),
    closeLabel: o.t("close"),
    body: [body, foot],
  });

  const countIn = (g: ExtraGroup) => g.options.filter((x) => picked.has(x.id)).length;
  const valid = () => groups.every((g) => countIn(g) >= g.min);
  const unit = () =>
    (variants.find((v) => v.size === size)?.price ?? item.price ?? 0) +
    groups.flatMap((g) => g.options.filter((x) => picked.has(x.id))).reduce((n, x) => n + x.price, 0);
  const rule = (g: ExtraGroup) =>
    g.min > 0
      ? badge(g.min === g.max ? o.t("chooseExactly", { n: String(g.min) }) : o.t("required"))
      : g.max === 1
        ? badge(o.t("optional"))
        : badge(o.t("chooseUpTo", { n: String(g.max) }));

  const paint = () => {
    const parts: (HTMLElement | null)[] = [];
    if (variants.length > 0) {
      parts.push(
        h("div", { class: "bill" }, h("span", { class: "label" }, o.t("chooseSize")), badge(o.t("required"))),
        h(
          "div",
          { role: "radiogroup", "aria-label": o.t("chooseSize") },
          ...variants.map((v) =>
            h(
              "button",
              {
                type: "button",
                class: "opt",
                role: "radio",
                "aria-checked": String(v.size === size),
                on: {
                  click: () => {
                    size = v.size;
                    draw();
                  },
                },
              },
              h("div", { class: "nm" }, h("b", {}, v.size)),
              h("span", { class: "pr num" }, o.money(v.price)),
              h("span", { class: "radio", "aria-hidden": "true" }),
            ),
          ),
        ),
      );
    }
    for (const g of groups) {
      const single = g.max === 1;
      const full = countIn(g) >= g.max;
      parts.push(
        h("div", { class: "bill" }, h("span", { class: "label" }, g.name), rule(g)),
        h(
          "div",
          { role: single ? "radiogroup" : "group", "aria-label": g.name },
          ...g.options.map((x) => {
            const on = picked.has(x.id);
            return h(
              "button",
              {
                type: "button",
                class: "opt",
                role: single ? "radio" : "checkbox",
                "aria-checked": String(on),
                disabled: !on && full && !single,
                "data-option": x.id,
                on: {
                  click: () => {
                    if (on) picked.delete(x.id);
                    else {
                      // A single choice swaps; a multiple choice stops at its max (the others are disabled).
                      if (single) for (const other of g.options) picked.delete(other.id);
                      picked.add(x.id);
                    }
                    draw();
                  },
                },
              },
              h("div", { class: "nm" }, h("b", {}, x.name)),
              h("span", { class: "pr num" }, x.price > 0 ? `+${o.money(x.price)}` : ""),
              h("span", { class: single ? "radio" : "check", "aria-hidden": "true" }),
            );
          }),
        ),
      );
    }
    mount(
      body,
      ...parts,
      h(
        "label",
        { class: "field" },
        o.t("noteLabel"),
        h("input", {
          type: "text",
          maxlength: "80",
          placeholder: o.t("notePlaceholder"),
          value: note,
          "data-testid": "option-note",
          on: {
            input: (e) => {
              note = (e.target as HTMLInputElement).value;
            },
          },
        }),
      ),
    );
    const choice = { ...(size === undefined ? {} : { size }), extras: [...picked] };
    const room = Math.max(1, o.room(choice));
    qty = Math.min(qty, room);
    mount(
      foot,
      stepper({
        qty,
        max: room,
        less: o.t("less", { item: item.name }),
        more: o.t("more", { item: item.name }),
        size: "lg",
        onChange: (q) => {
          qty = Math.max(1, q);
          draw();
        },
      }),
      button(
        {
          kind: "primary",
          testid: "sheet-add",
          disabled: !valid() || o.room(choice) < 1,
          onClick: () => {
            const text = note.trim();
            o.onAdd({ ...choice, ...(text ? { note: text } : {}), qty });
            sheet.close();
          },
        },
        o.t("addWithPrice", { price: o.money(unit() * qty) }),
      ),
    );
  };
  /** Repaints after a choice, keeping keyboard and screen-reader focus on the same control (the sheet is rebuilt). */
  const draw = () => {
    const focusables = () => [
      ...(document.querySelector(".sheet")?.querySelectorAll<HTMLElement>("button, input, textarea") ?? []),
    ];
    const at = focusables().indexOf(document.activeElement as HTMLElement);
    paint();
    if (at >= 0) focusables()[at]?.focus();
  };
  draw();
}
