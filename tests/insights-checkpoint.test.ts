/**
 * M5 checkpoint: insights over the sample rushes match numbers computed by hand. The expected values are worked out
 * here from the raw rush and catalog files with plain arithmetic (a fixed UTC offset, a price table, tallies), not with
 * any of the code under test, and the headline numbers are also pinned as literals.
 */

import { describe, expect, test } from "vitest";
import { dailyReport, type Sale, saleOf } from "../src/core/insights.ts";
import { createOrder, type Order } from "../src/core/orders.ts";
import { claimPayment, confirmPayment } from "../src/core/payments.ts";
import type { Rush } from "./support/rush.ts";
import { loadSample, readSample } from "./support/samples.ts";

const DAY = 86_400_000;

interface RawCatalog {
  categories: { items: { id: string; name: string; price?: number; variants?: { size: string; price: number }[] }[] }[];
}

/** Price table and names from the raw catalog file. */
function prices(sample: string): { price: Map<string, number>; name: Map<string, string> } {
  const price = new Map<string, number>();
  const name = new Map<string, string>();
  for (const c of (readSample(sample, "catalog.json") as RawCatalog).categories) {
    for (const i of c.items) {
      name.set(i.id, i.name);
      if (i.variants) for (const v of i.variants) price.set(`${i.id}|${v.size}`, v.price);
      else price.set(`${i.id}|`, i.price as number);
    }
  }
  return { price, name };
}

type Pay = "confirmed" | "claimed" | "unpaid";
/** Staff confirm this long after an order is placed. */
const CONFIRM_AFTER = 30_000;

/**
 * The rush orders through the real order and payment rules, optionally moved by whole days. `pay` says what happened
 * to each order's money: confirmed in full by staff `CONFIRM_AFTER` later, claimed by the customer only, or nothing.
 */
function ordersOf(
  sample: string,
  rush: Rush,
  shiftDays = 0,
  keep: (i: number) => boolean = () => true,
  pay: (i: number) => Pay = () => "unpaid",
): Sale[] {
  const config = loadSample(sample);
  return rush.orders.flatMap((o, i) => {
    if (!keep(i)) return [];
    const at = o.at + shiftDays * DAY;
    let order: Order = createOrder(config, {
      id: `${sample}-${shiftDays}-${i}`,
      token: `t-${i}`,
      now: at,
      lines: o.lines,
    });
    const total = order.lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
    if (pay(i) === "confirmed") {
      const payment = confirmPayment(order.payment, {
        by: "c1",
        method: "cash",
        amountMinor: total,
        now: at + CONFIRM_AFTER,
      });
      order = { ...order, payment };
    } else if (pay(i) === "claimed") {
      order = { ...order, payment: claimPayment(order.payment, { method: "upi", amountMinor: total, now: at }) };
    }
    return [saleOf(order)];
  });
}

/** Hand tally: hours at a fixed offset (none of these zones has DST in late November), units and sales per item. */
function tally(sample: string, rush: Rush, offsetMin: number) {
  const { price } = prices(sample);
  const hours = new Array<number>(24).fill(0);
  const qty = new Map<string, number>();
  const sales = new Map<string, number>();
  let total = 0;
  let items = 0;
  for (const o of rush.orders) {
    const hour = new Date(o.at + offsetMin * 60_000).getUTCHours();
    hours[hour] = (hours[hour] as number) + 1;
    for (const l of o.lines) {
      const p = price.get(`${l.itemId}|${l.size ?? ""}`) as number;
      total += p * l.qty;
      items += l.qty;
      qty.set(l.itemId, (qty.get(l.itemId) ?? 0) + l.qty);
      sales.set(l.itemId, (sales.get(l.itemId) ?? 0) + p * l.qty);
    }
  }
  return { hours, qty, sales, total, items };
}

const CASES = [
  // sample, zone offset in minutes, hand-pinned: sales, units, peak hour and its orders, top by units, top by sales
  {
    sample: "tea-house",
    offset: 330,
    currency: "INR",
    pinned: {
      orders: 300,
      sales: 7_168_000,
      items: 1217,
      peak: [18, 153],
      topQty: "hot-coffee",
      topSales: "cold-rose-tea",
    },
  },
  {
    sample: "service-desk",
    offset: 240,
    currency: "AED",
    // 13:00 and 15:00 both have 11 tickets: the earlier hour wins.
    pinned: {
      orders: 60,
      sales: 2_699_750,
      items: 218,
      peak: [13, 11],
      topQty: "screen-guard-fitting",
      topSales: "screen-replacement",
    },
  },
  {
    sample: "coffee-cart",
    offset: -300,
    currency: "USD",
    pinned: { orders: 80, sales: 131_750, items: 330, peak: [8, 51], topQty: "cappuccino", topSales: "cappuccino" },
  },
] as const;

describe("M5 checkpoint: insights over the sample rushes", () => {
  for (const { sample, offset, currency, pinned } of CASES) {
    test(`${sample} (${currency}): hourly chart, peak, popular items and totals`, () => {
      const rush = readSample(sample, "rush.json") as Rush;
      const config = loadSample(sample);
      expect(config.business.currency).toBe(currency);
      const end = rush.start + rush.durationMs;
      const r = dailyReport(ordersOf(sample, rush), end, config.business.timeZone);
      const hand = tally(sample, rush, offset);

      expect(r.hourly.map((b) => b.orders)).toEqual(hand.hours);
      // Nothing confirmed: everything ordered is awaiting, nothing is received.
      expect(r.totals).toEqual({
        orders: rush.orders.length,
        items: hand.items,
        orderedMinor: hand.total,
        averageMinor: Math.round(hand.total / rush.orders.length),
        receivedMinor: 0,
        receivedCashMinor: 0,
        receivedUpiMinor: 0,
        awaitingOrders: rush.orders.length,
        awaitingMinor: hand.total,
      });
      const maxOrders = Math.max(...hand.hours);
      expect(r.peak?.hour).toBe(hand.hours.indexOf(maxOrders));
      for (const s of r.popular.byQty) {
        expect(s.qty).toBe(hand.qty.get(s.itemId));
        expect(s.orderedMinor).toBe(hand.sales.get(s.itemId));
      }
      expect(r.popular.byQty).toHaveLength(hand.qty.size);
      expect(r.popular.byQty[0]?.qty).toBe(Math.max(...hand.qty.values()));
      expect(r.popular.byValue[0]?.orderedMinor).toBe(Math.max(...hand.sales.values()));

      expect([r.totals.orders, r.totals.orderedMinor, r.totals.items]).toEqual([
        pinned.orders,
        pinned.sales,
        pinned.items,
      ]);
      expect([r.peak?.hour, r.peak?.orders]).toEqual(pinned.peak);
      expect(r.popular.byQty[0]?.itemId).toBe(pinned.topQty);
      expect(r.popular.byValue[0]?.itemId).toBe(pinned.topSales);
    });
  }

  test("tea-house: received vs ordered on a staged payment mix, vs yesterday, and tomorrow's prep forecast", () => {
    const sample = "tea-house";
    const rush = readSample(sample, "rush.json") as Rush;
    const { timeZone } = loadSample(sample).business;
    const end = rush.start + rush.durationMs; // 19:00 IST on Thursday 26 November
    const odd = (i: number) => i % 2 === 1;
    const firstHalf = (i: number) => i < 150;
    // Today: every third order confirmed by staff, the next claimed by the customer only, the next never paid.
    const todayPay = (i: number): Pay => (["confirmed", "claimed", "unpaid"] as const)[i % 3] as Pay;
    const orders = [
      ...ordersOf(sample, rush, 0, () => true, todayPay),
      ...ordersOf(sample, rush, -1, odd, () => "confirmed"), // yesterday: every other order, all confirmed
      ...ordersOf(sample, rush, -6), // Friday 20 November: the same weekday as tomorrow
      ...ordersOf(sample, rush, -13, firstHalf), // Friday 13 November
    ];
    const r = dailyReport(orders, end, timeZone);

    // By hand: each rush order's value from the price table, split by what happened to its money.
    const { price } = prices(sample);
    const value = (o: Rush["orders"][number]) =>
      o.lines.reduce((n, l) => n + (price.get(`${l.itemId}|${l.size ?? ""}`) as number) * l.qty, 0);
    let received = 0;
    let awaiting = 0;
    let awaitingCount = 0;
    let oddValue = 0;
    let oddReceivedByNow = 0;
    const IST = 330 * 60_000;
    const endMinute = Math.floor(((end + IST) % DAY) / 60_000);
    rush.orders.forEach((o, i) => {
      if (i % 3 === 0) received += value(o);
      else {
        awaiting += value(o);
        awaitingCount++;
      }
      if (odd(i)) {
        oddValue += value(o);
        const confirmedMinute = Math.floor(((o.at + CONFIRM_AFTER + IST) % DAY) / 60_000);
        if (confirmedMinute <= endMinute) oddReceivedByNow += value(o);
      }
    });
    expect(received + awaiting).toBe(7_168_000);
    expect(r.totals).toMatchObject({
      orders: 300,
      orderedMinor: 7_168_000,
      receivedMinor: received,
      awaitingOrders: awaitingCount,
      awaitingMinor: awaiting,
    });
    expect(awaitingCount).toBe(200);
    expect(r.comparison.today.orders).toBe(300);
    expect(r.comparison.yesterdaySoFar.orders).toBe(150);
    expect(r.comparison.ordersChangePct).toBe(100);
    expect(r.comparison.yesterday).toMatchObject({
      orderedMinor: oddValue,
      receivedMinor: oddValue,
      awaitingOrders: 0,
    });
    expect(r.comparison.yesterdaySoFar.receivedMinor).toBe(oddReceivedByNow);
    expect(r.comparison.receivedChangePct).toBe(Math.round(((received - oddReceivedByNow) / oddReceivedByNow) * 100));
    expect(r.summary[0]).toEqual({
      kind: "orders",
      orders: 300,
      orderedMinor: 7_168_000,
      receivedMinor: received,
      awaitingOrders: 200,
      awaitingMinor: awaiting,
    });

    // Forecast by hand: per item and size, (units on the 20th + units on the 13th) / 2, rounded up.
    const sum = new Map<string, number>();
    rush.orders.forEach((o, i) => {
      for (const l of o.lines) {
        const key = `${l.itemId}|${l.size ?? ""}`;
        sum.set(key, (sum.get(key) ?? 0) + l.qty * (firstHalf(i) ? 2 : 1));
      }
    });
    expect(r.forecast.day).toBe("2026-11-27");
    expect(r.forecast.basis).toBe("same-weekday");
    expect(r.forecast.basisDays).toEqual(["2026-11-13", "2026-11-20"]);
    expect(r.forecast.orders).toBe(Math.ceil((300 + 150) / 2));
    expect(r.forecast.lines).toHaveLength(sum.size);
    for (const l of r.forecast.lines) {
      expect(l.qty).toBe(Math.ceil((sum.get(`${l.itemId}|${l.size ?? ""}`) as number) / 2));
    }
    expect(r.summary.map((f) => f.kind)).toEqual(["orders", "trend", "peak", "top", "topValue", "forecast"]);
  });
});
