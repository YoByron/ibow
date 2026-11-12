import { describe, expect, test } from "vitest";
import {
  addDays,
  compareWithYesterday,
  dailyReport,
  dayTotals,
  hourly,
  localTime,
  peakHour,
  popularItems,
  prepForecast,
  type Sale,
  saleOf,
  summarize,
} from "../src/core/insights.ts";
import { createOrder, type LineRequest, type Order } from "../src/core/orders.ts";
import { claimPayment, confirmPayment } from "../src/core/payments.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const tz = config.business.timeZone; // Asia/Kolkata, UTC+5:30
/** An instant at a business-local (IST) clock time on 2026-11-26. */
const ist = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m) - 330 * 60_000;
let seq = 0;
function placed(at: number, lines: LineRequest[]): Order {
  seq++;
  return createOrder(config, { id: `o${seq}`, token: `xx-${seq}`, now: at, lines });
}
/** An order as insights read it, unpaid. */
function order(at: number, lines: LineRequest[]): Sale {
  return saleOf(placed(at, lines));
}
// Prices in the tea-house catalog (paise).
const chaiM = { itemId: "house-special-chai", size: "M", qty: 1 };
const water = { itemId: "masala-soda", qty: 1 };

describe("insights", () => {
  test("local time and calendar days follow the business zone, not UTC", () => {
    // 20:00 UTC on the 25th is 01:30 on the 26th in Kolkata.
    expect(localTime(Date.UTC(2026, 10, 25, 20, 0), tz)).toEqual({ day: "2026-11-26", hour: 1, minute: 30 });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("hourly buckets, totals and the peak hour", () => {
    const orders = [
      order(ist(26, 17, 5), [{ ...chaiM, qty: 2 }]),
      order(ist(26, 17, 59), [water]),
      order(ist(26, 18, 0), [chaiM, water]),
      order(ist(25, 17, 0), [chaiM]), // yesterday: not in today's buckets
    ];
    const buckets = hourly(orders, "2026-11-26", tz);
    expect(buckets).toHaveLength(24);
    const unit = (o: Sale) => o.lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
    expect(buckets[17]).toEqual({
      hour: 17,
      orders: 2,
      items: 3,
      orderedMinor: unit(orders[0] as Sale) + unit(orders[1] as Sale),
    });
    expect(buckets[18]?.orders).toBe(1);
    expect(buckets.reduce((n, b) => n + b.orders, 0)).toBe(3);
    expect(peakHour(buckets)?.hour).toBe(17);
    expect(peakHour(hourly([], "2026-11-26", tz))).toBeNull();
    // A tie goes to the earlier hour.
    const tie = hourly([order(ist(26, 9), [water]), order(ist(26, 8), [water])], "2026-11-26", tz);
    expect(peakHour(tie)?.hour).toBe(8);
    expect(dayTotals([], "2026-11-26", tz)).toEqual({
      orders: 0,
      items: 0,
      orderedMinor: 0,
      averageMinor: 0,
      receivedMinor: 0,
      receivedCashMinor: 0,
      receivedUpiMinor: 0,
      awaitingOrders: 0,
      awaitingMinor: 0,
    });
  });

  test("ordered, received and awaiting are kept apart: a claim is not money, a confirmation counts on its day", () => {
    const confirm = (o: Order, amountMinor: number, at: number): Order => ({
      ...o,
      payment: confirmPayment(o.payment, { by: "c1", method: "cash", amountMinor, now: at }),
    });
    // Chai M 3000, soda 3000 (paise).
    const cash = confirm(placed(ist(26, 10), [chaiM]), 3000, ist(26, 10, 1)); // paid in full
    const claimed = placed(ist(26, 11), [water]);
    const claim = {
      ...claimed,
      payment: claimPayment(claimed.payment, { method: "upi", amountMinor: 3000, now: ist(26, 11) }),
    };
    const unpaid = placed(ist(26, 12), [chaiM, water]); // 6000 owed
    // Placed yesterday at 23:50, confirmed today at 00:05: received today, ordered yesterday.
    const late = confirm(placed(ist(25, 23, 50), [water]), 3000, ist(26, 0, 5));
    // A top-up after added lines: 3000 then 3000 more, both today.
    const base = confirm(placed(ist(26, 13), [chaiM]), 3000, ist(26, 13, 1));
    const added = { ...base, lines: [...base.lines, ...placed(ist(26, 13), [water]).lines] };
    const topped: Order = {
      ...added,
      payment: {
        ...(added.payment as Extract<Order["payment"], { state: "confirmed" }>),
        amountMinor: 6000,
        topUps: [{ method: "cash", amountMinor: 3000, at: ist(26, 14), by: "c1" }],
      },
    };
    expect(saleOf(topped).received).toEqual([
      { amountMinor: 3000, at: ist(26, 13, 1), method: "cash" },
      { amountMinor: 3000, at: ist(26, 14), method: "cash" },
    ]);
    expect(saleOf(claim).received).toEqual([]);
    const sales = [cash, claim, unpaid, late, topped].map(saleOf);
    expect(dayTotals(sales, "2026-11-26", tz)).toMatchObject({
      orders: 4,
      items: 6,
      orderedMinor: 3000 + 3000 + 6000 + 6000,
      averageMinor: 4500,
      receivedMinor: 3000 + 3000 + 6000, // cash, the late one, the topped-up one; never the claim
      receivedCashMinor: 3000 + 3000 + 6000,
      receivedUpiMinor: 0,
      awaitingOrders: 2,
      awaitingMinor: 3000 + 6000,
    });
    // Up to 10:00 only the late confirmation had come in.
    expect(dayTotals(sales, "2026-11-26", tz, 10 * 60).receivedMinor).toBe(3000);
    expect(dayTotals(sales, "2026-11-25", tz)).toMatchObject({ orders: 1, orderedMinor: 3000, receivedMinor: 0 });
  });

  test("the day's received money splits into cash and UPI by how each part was confirmed; no method counts in neither", () => {
    const at = ist(26, 10);
    const sale = (received: Sale["received"]): Sale => ({ createdAt: at, lines: [], received });
    const sales = [
      sale([{ amountMinor: 5000, at, method: "cash" }]),
      sale([
        { amountMinor: 7000, at, method: "upi" },
        { amountMinor: 1000, at, method: "cash" },
      ]),
      sale([{ amountMinor: 900, at }]),
    ];
    expect(dayTotals(sales, "2026-11-26", tz)).toMatchObject({
      receivedMinor: 13_900,
      receivedCashMinor: 6000,
      receivedUpiMinor: 7000,
    });
  });

  test("popular items by units and by sales, sizes together", () => {
    const priceOf = (id: string, size?: string) => {
      const item = config.items.get(id)?.item;
      return (size ? item?.variants?.find((v) => v.size === size)?.price : item?.price) as number;
    };
    const orders = [
      order(ist(26, 10), [{ itemId: "masala-soda", qty: 5 }]),
      order(ist(26, 11), [
        { itemId: "house-special-chai", size: "M", qty: 2 },
        { itemId: "house-special-chai", size: "L", qty: 1 },
      ]),
    ];
    const { byQty, byValue } = popularItems(orders);
    expect(byQty.map((s) => [s.itemId, s.qty])).toEqual([
      ["masala-soda", 5],
      ["house-special-chai", 3],
    ]);
    const chaiSales = 2 * priceOf("house-special-chai", "M") + priceOf("house-special-chai", "L");
    expect(byValue.find((s) => s.itemId === "house-special-chai")?.orderedMinor).toBe(chaiSales);
    expect(byValue[0]?.orderedMinor).toBe(Math.max(chaiSales, 5 * priceOf("masala-soda")));
  });

  test("today against yesterday by the same clock time", () => {
    const orders = [
      order(ist(25, 9), [water]),
      order(ist(25, 10), [water]),
      order(ist(25, 20), [water]), // after now's clock time: only in yesterday's whole day
      order(ist(26, 9), [water]),
      order(ist(26, 9, 30), [water]),
      order(ist(26, 10), [water]),
    ];
    const c = compareWithYesterday(orders, ist(26, 12), tz);
    expect(c.today.orders).toBe(3);
    expect(c.yesterdaySoFar.orders).toBe(2);
    expect(c.yesterday.orders).toBe(3);
    expect(c.ordersChangePct).toBe(50);
    expect(compareWithYesterday(orders.slice(3), ist(26, 12), tz).ordersChangePct).toBeNull();
  });

  test("prep forecast: the same weekday over four weeks, days with orders only, rounded up", () => {
    // Tomorrow is Friday 27 Nov; same weekdays 20, 13, 6 Nov and 30 Oct. 13 Nov had no orders (closed).
    const orders = [
      order(ist(20, 17), [{ ...chaiM, qty: 4 }]),
      order(ist(20, 18), [water]),
      order(ist(6, 17), [{ ...chaiM, qty: 3 }]),
      order(Date.UTC(2026, 9, 30, 12), [{ ...chaiM, qty: 2 }]),
      order(Date.UTC(2026, 9, 23, 12), [{ ...chaiM, qty: 50 }]), // five weeks back: outside the window
      order(ist(26, 17), [{ ...chaiM, qty: 9 }]), // today, a Thursday: not the same weekday
    ];
    const f = prepForecast(orders, ist(26, 21), tz);
    expect(f.day).toBe("2026-11-27");
    expect(f.basis).toBe("same-weekday");
    expect(f.basisDays).toEqual(["2026-10-30", "2026-11-06", "2026-11-20"]);
    // Chai M: (4 + 3 + 2) / 3 = 3. Water: 1 / 3, rounded up to 1. Orders: 4 / 3, rounded up to 2.
    expect(f.lines).toEqual([
      { itemId: "house-special-chai", name: "House Special Chai", size: "M", qty: 3 },
      { itemId: "masala-soda", name: "Masala Soda", qty: 1 },
    ]);
    expect(f.orders).toBe(2);
  });

  test("prep forecast falls back to the last 7 days with orders, then to none", () => {
    const orders = [order(ist(26, 17), [{ ...chaiM, qty: 5 }]), order(ist(24, 17), [{ ...chaiM, qty: 2 }])];
    const f = prepForecast(orders, ist(26, 21), tz);
    expect(f.basis).toBe("recent");
    expect(f.basisDays).toEqual(["2026-11-24", "2026-11-26"]);
    expect(f.lines[0]?.qty).toBe(4); // (5 + 2) / 2 = 3.5, rounded up
    expect(prepForecast([], ist(26, 21), tz)).toEqual({
      day: "2026-11-27",
      basis: "none",
      basisDays: [],
      orders: 0,
      lines: [],
    });
  });

  test("the summary states rule-based facts: orders, trend, peak, top items, forecast", () => {
    const orders = [
      order(ist(25, 9), [water]),
      order(ist(26, 9), [{ itemId: "masala-soda", qty: 6 }]),
      order(ist(26, 9, 10), [chaiM]),
      order(ist(26, 17), [{ itemId: "loaded-fries", qty: 2 }]),
    ];
    const r = dailyReport(orders, ist(26, 20), tz);
    const kinds = r.summary.map((f) => f.kind);
    expect(kinds).toEqual(["orders", "trend", "peak", "top", "topValue", "forecast"]);
    expect(r.summary[1]).toMatchObject({ kind: "trend", direction: "up", ordersChangePct: 200 });
    expect(r.summary[2]).toEqual({ kind: "peak", hour: 9, orders: 2 });
    expect(r.summary[3]).toEqual({ kind: "top", name: "Masala Soda", qty: 6 });
    const flat = summarize({ ...r, comparison: { ...r.comparison, ordersChangePct: 5 } });
    expect(flat[1]).toMatchObject({ direction: "flat" });
    expect(dailyReport([], ist(26, 20), tz).summary).toEqual([{ kind: "none" }]);
  });
});
