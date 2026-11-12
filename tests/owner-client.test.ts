import { describe, expect, test } from "vitest";
import {
  axisTicks,
  chartBars,
  dayLabel,
  hourLabel,
  orderEventAction,
  paymentBadge,
  returningText,
  summaryText,
} from "../src/client/owner-view.ts";
import { hourly, type SummaryFact } from "../src/core/insights.ts";

const fmt = {
  money: (minor: number) => `¤${minor / 100}`,
  hour: (h: number) => `${h}h`,
  day: (d: string) => d,
};

describe("owner dashboard helpers", () => {
  test("hours and days are written by Intl in the reader's locale", () => {
    expect(hourLabel(17, "en-US")).toBe("5 PM");
    expect(hourLabel(17, "en-GB")).toBe("17");
    expect(dayLabel("2026-11-27", "en-US")).toBe("Fri, Nov 27");
  });

  test("each summary fact becomes one sentence, amounts through the formatter", () => {
    const facts: SummaryFact[] = [
      {
        kind: "orders",
        orders: 300,
        orderedMinor: 7_168_000,
        receivedMinor: 5_000_000,
        awaitingOrders: 12,
        awaitingMinor: 2_168_000,
      },
      { kind: "orders", orders: 1, orderedMinor: 3000, receivedMinor: 3000, awaitingOrders: 0, awaitingMinor: 0 },
      { kind: "trend", direction: "down", ordersChangePct: -25, receivedChangePct: -20 },
      { kind: "trend", direction: "flat", ordersChangePct: 4, receivedChangePct: null },
      { kind: "peak", hour: 18, orders: 153 },
      {
        kind: "forecast",
        day: "2026-11-27",
        orders: 225,
        lines: [{ itemId: "c", name: "Chai", size: "M", qty: 40 }],
        basis: "recent",
      },
    ];
    expect(facts.map((f) => summaryText(f, fmt))).toEqual([
      "300 orders so far, worth ¤71680. Received (confirmed by staff): ¤50000. 12 orders, ¤21680, still awaiting payment confirmation.",
      "1 order so far, worth ¤30. Received (confirmed by staff): ¤30.",
      "Quieter than yesterday by this time: orders down 25%. Money received: -20% against yesterday by this time.",
      "About the same as yesterday by this time (+4%).",
      "The busiest hour was 18h, with 153 orders.",
      "Prep for 2026-11-27: about 225 orders; most needed 40 × Chai M. (from the last few days; not enough same-weekday history yet)",
    ]);
  });

  test("the chart spans the first to the last busy hour, scaled to the busiest", () => {
    const buckets = hourly([], "2026-11-26", "UTC").map((b) =>
      b.hour === 17 ? { ...b, orders: 147 } : b.hour === 18 ? { ...b, orders: 153 } : b,
    );
    const bars = chartBars(buckets, 320, 120);
    expect(bars.map((b) => b.hour)).toEqual([17, 18]);
    expect(bars[1]).toMatchObject({ x: 160, y: 0, height: 120, width: 159 });
    expect(bars[0]?.height).toBeCloseTo((147 / 153) * 120);
    expect(chartBars(hourly([], "2026-11-26", "UTC"), 240, 100)).toHaveLength(24);
  });

  test("a returning badge only from one earlier visit day on", () => {
    expect(returningText(undefined)).toBeUndefined();
    expect(returningText(0)).toBeUndefined();
    expect(returningText(1)).toBe("Returning · 1 earlier visit");
    expect(returningText(3)).toBe("Returning · 3 earlier visits");
  });

  test("an order card says not paid, claimed (not checked) or paid, and what is still due", () => {
    const money = (m: number) => `¤${m / 100}`;
    expect(paymentBadge({ payment: { state: "unpaid" }, outstandingMinor: 6000 }, money)).toEqual({
      kind: "unpaid",
      text: "Not paid",
    });
    expect(
      paymentBadge(
        { payment: { state: "claimed", method: "upi", amountMinor: 6000, at: 1 }, outstandingMinor: 6000 },
        money,
      ),
    ).toEqual({ kind: "claimed", text: "Customer says paid ¤60 (not confirmed)" });
    expect(
      paymentBadge(
        { payment: { state: "confirmed", method: "cash", amountMinor: 6000, at: 1, by: "c1" }, outstandingMinor: 0 },
        money,
      ),
    ).toEqual({ kind: "paid", text: "Paid ¤60" });
    expect(
      paymentBadge(
        { payment: { state: "confirmed", method: "cash", amountMinor: 6000, at: 1, by: "c1" }, outstandingMinor: 3000 },
        money,
      ),
    ).toEqual({ kind: "due", text: "Paid ¤60 · due ¤30" });
  });

  test("the order tabs follow the business day: a later day's order reloads them, an earlier one is ignored", () => {
    expect(orderEventAction("2026-11-26", "2026-11-26")).toBe("apply");
    expect(orderEventAction("2026-11-26", "2026-11-27")).toBe("reload");
    expect(orderEventAction("2026-11-26", "2026-11-25")).toBe("ignore");
  });
});

test("the item that brought in the most is called the top item by revenue", () => {
  const fact: SummaryFact = { kind: "topValue", name: "Cold Rose Tea", orderedMinor: 498_000 };
  expect(summaryText(fact, fmt)).toBe("Top item by revenue: Cold Rose Tea, ¤4980.");
});

describe("chart axis", () => {
  test("round marks from zero up to the first at or above the tallest bar", () => {
    expect(axisTicks(58)).toEqual([0, 20, 40, 60]);
    expect(axisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(axisTicks(1)).toEqual([0, 1]);
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(150)).toEqual([0, 50, 100, 150]);
    for (const m of [1, 2, 7, 13, 58, 99, 240, 1000]) {
      const ticks = axisTicks(m);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1) as number).toBeGreaterThanOrEqual(m);
      expect(ticks.length).toBeLessThanOrEqual(8);
    }
  });
});
