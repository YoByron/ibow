/**
 * The floor (D-103): every section as a block of its spots, coloured by state (`floorState` in core), with the section's
 * runner, who can be changed here. A tap on a spot opens its open orders. The screen in staff.ts keeps the orders live on
 * the counter's stream; this module only draws.
 */

import type { FloorSection, SpotState } from "../core/floor.ts";
import type { RunnerOrder } from "../core/runner.ts";
import { orderNumber } from "../core/tokens.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";
import { openSheet } from "./ui/sheet.ts";

export interface FloorContext {
  staff: readonly { id: string; name: string }[];
  rows: ReadonlyMap<string, RunnerOrder>;
  /** Gives a section to a staff member, or to nobody (`null`). */
  assign: (section: string, user: string | null) => void;
  stationName: (id: string) => string;
  lineText: (l: RunnerOrder["lines"][number]) => string;
}

export function stateText(state: SpotState): string {
  switch (state) {
    case "free":
      return t("floorFree");
    case "ordered":
      return t("floorOrdered");
    case "ready":
      return t("floorReady");
    case "late":
      return t("floorLate");
    default:
      return t("floorMessage");
  }
}

function spotSheet(label: string, orders: RunnerOrder[], ctx: FloorContext): void {
  openSheet({
    title: label,
    label,
    closeLabel: t("close"),
    body: [
      h(
        "div",
        { class: "fl-orders" },
        ...(orders.length === 0
          ? [h("p", { class: "hint" }, t("floorNoOrders"))]
          : orders.map((o) =>
              h(
                "article",
                { class: "fl-order", "data-testid": `fl-order-${o.token}` },
                h("b", {}, orderNumber(o.token)),
                o.awaitingPayment === true && h("span", { class: "chip warn" }, t("awaitingPayment")),
                h(
                  "ul",
                  { class: "lines" },
                  ...o.lines.map((l) =>
                    h(
                      "li",
                      { class: l.state === "delivered" ? "served" : "" },
                      h("span", { class: "line-name" }, ctx.lineText(l)),
                      h("span", { class: "hint" }, ctx.stationName(l.stationId), " · ", lineState(l.state)),
                    ),
                  ),
                ),
              ),
            )),
      ),
    ],
  });
}

function lineState(s: "making" | "ready" | "delivered"): string {
  return s === "making" ? t("stateMaking") : s === "ready" ? t("stateReady") : t("stateDelivered");
}

function runnerPicker(section: FloorSection, ctx: FloorContext): HTMLSelectElement {
  const select = h(
    "select",
    { "aria-label": t("floorRunnerOf", { section: section.name }), "data-testid": `fl-runner-${section.id}` },
    h("option", { value: "", selected: section.runner === undefined }, t("floorNobody")),
    ...ctx.staff.map((s) => h("option", { value: s.id, selected: s.id === section.runner }, s.name)),
  );
  select.addEventListener("change", () => ctx.assign(section.id, select.value === "" ? null : select.value));
  return select;
}

/** The blocks, one per section, in layout order. */
export function floorBlocks(floor: readonly FloorSection[], ctx: FloorContext): Child[] {
  return floor.map((section) =>
    h(
      "section",
      { class: "fl-section", "data-testid": `fl-${section.id}` },
      h("div", { class: "fl-head" }, h("h2", {}, section.name), runnerPicker(section, ctx)),
      h(
        "div",
        { class: "fl-grid" },
        ...section.spots.map((spot) =>
          h(
            "button",
            {
              type: "button",
              class: `fl-spot fl-${spot.state}`,
              "data-state": spot.state,
              "data-testid": `fl-spot-${spot.id}`,
              "aria-label": `${spot.label}, ${stateText(spot.state)}`,
              on: {
                click: () =>
                  spotSheet(
                    spot.label,
                    spot.orders.flatMap((id) => {
                      const r = ctx.rows.get(id);
                      return r === undefined ? [] : [r];
                    }),
                    ctx,
                  ),
              },
            },
            h("b", {}, spot.label.slice(section.name.length + 1) || spot.label),
            h("small", {}, stateText(spot.state)),
          ),
        ),
      ),
    ),
  );
}
