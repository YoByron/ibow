/** Card and refunds (D-071): recorded by a person, netted in every total, and Ordered stays Ordered. */

import { describe, expect, test } from "vitest";
import { dayTotals, saleOf, statsFromSales } from "../src/core/insights.ts";
import { createOrder, outstandingMinor } from "../src/core/orders.ts";
import {
  claimPayment,
  confirmPayment,
  keptMinor,
  type PaymentError,
  refundPayment,
  topUpPayment,
  UNPAID,
} from "../src/core/payments.ts";
import { openStore } from "../src/store/node.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const tz = config.business.timeZone;
const at = Date.UTC(2026, 10, 26, 7, 0);
const HOUR = 3_600_000;

function paid(method: "cash" | "upi" | "card" = "card") {
  const order = createOrder(config, { id: "o1", token: "26-001", now: at, lines: [{ itemId: "masala-soda", qty: 2 }] });
  const total = order.lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
  return {
    order,
    total,
    payment: confirmPayment(UNPAID, { by: "counter", method, amountMinor: total, now: at + 1000 }),
  };
}

describe("refundPayment", () => {
  test("records amount, method, who and when, and leaves what was received as it was", () => {
    const { payment, total } = paid("card");
    const back = refundPayment(payment, { by: "manager-1", method: "card", amountMinor: 500, now: at + 5000 });
    expect(back.state === "confirmed" && back.refunds).toEqual([
      { method: "card", amountMinor: 500, at: at + 5000, by: "manager-1" },
    ]);
    expect(back.state === "confirmed" && back.amountMinor).toBe(total);
    expect(keptMinor(back)).toBe(total - 500);
  });

  test("only confirmed money, only a positive amount, never more than that method took in", () => {
    const { payment, total } = paid("cash");
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as PaymentError).code;
      }
      return "none";
    };
    expect(err(() => refundPayment(UNPAID, { by: "a", method: "cash", amountMinor: 1, now: at }))).toBe("bad_state");
    const claimed = claimPayment(UNPAID, { method: "upi", amountMinor: 100, now: at });
    expect(err(() => refundPayment(claimed, { by: "a", method: "upi", amountMinor: 1, now: at }))).toBe("bad_state");
    expect(err(() => refundPayment(payment, { by: "a", method: "cash", amountMinor: 0, now: at }))).toBe("bad_amount");
    expect(err(() => refundPayment(payment, { by: " ", method: "cash", amountMinor: 1, now: at }))).toBe("no_staff");
    expect(err(() => refundPayment(payment, { by: "a", method: "card", amountMinor: 1, now: at }))).toBe("over_refund");
    const half = refundPayment(payment, { by: "a", method: "cash", amountMinor: total - 100, now: at });
    expect(err(() => refundPayment(half, { by: "a", method: "cash", amountMinor: 101, now: at }))).toBe("over_refund");
    expect(keptMinor(refundPayment(half, { by: "a", method: "cash", amountMinor: 100, now: at }))).toBe(0);
  });

  test("a top-up taken by card can be given back by card", () => {
    const { payment } = paid("cash");
    const topped = topUpPayment(payment, { by: "c", method: "card", amountMinor: 300, now: at + 2000 });
    expect(keptMinor(refundPayment(topped, { by: "m", method: "card", amountMinor: 300, now: at + 3000 }))).toBe(
      keptMinor(topped) - 300,
    );
  });
});

describe("totals net refunds", () => {
  test("the in-memory report and the SQL report agree: received, and the cash, UPI and card split", () => {
    const store = openStore(":memory:");
    store.useTimeZone(tz);
    const { order, total, payment } = paid("card");
    store.createOrder({
      id: "o1",
      secret: "s",
      clientKey: "refund-key-xxxxxxxx",
      now: at,
      timeZone: tz,
      build: () => order,
    });
    const refunded = {
      ...order,
      payment: refundPayment(payment, { by: "m", method: "card", amountMinor: 300, now: at + HOUR }),
    };
    store.saveOrder(refunded, "order.updated", at + HOUR);
    const day = "2026-11-26";
    const sql = store.dayStats(day, tz);
    const mem = statsFromSales([saleOf(refunded)], day, tz);
    expect(sql.receivedMinor).toBe(total - 300);
    expect(sql.receivedCardMinor).toBe(total - 300);
    expect(sql.receivedCashMinor).toBe(0);
    expect(sql.orderedMinor).toBe(total);
    for (const k of [
      "receivedMinor",
      "receivedCardMinor",
      "receivedCashMinor",
      "receivedUpiMinor",
      "awaitingMinor",
    ] as const) {
      expect(mem[k], k).toBe(sql[k]);
    }
    expect(dayTotals([saleOf(refunded)], day, tz).receivedCardMinor).toBe(total - 300);
    // The record read back by a later request has the refund, and a day record frozen from it nets it too.
    expect(store.getOrder("o1")?.order.payment).toEqual(refunded.payment);
    const record = store.closeDay(day, tz);
    expect(record?.minutes.reduce((n, m) => n + m.receivedCardMinor, 0)).toBe(total - 300);
    // A refund is its own day's money: handed back the next day, it falls on that day, not on the sale's.
    const next = {
      ...order,
      payment: refundPayment(refunded.payment, { by: "m", method: "card", amountMinor: 100, now: at + 24 * HOUR }),
    };
    store.saveOrder(next, "order.updated", at + 24 * HOUR);
    expect(store.dayStats(day, tz).receivedMinor).toBe(total - 300);
    expect(store.dayStats("2026-11-27", tz).receivedMinor).toBe(-100);
    expect(store.salesSince(0)[0]?.received.reduce((n, r) => n + r.amountMinor, 0)).toBe(total - 400);
    expect(store.exportData(day, "2026-11-27").payment_refunds).toHaveLength(2);
    store.close();
  });

  test("a refunded order is not awaiting money", () => {
    const { order, payment } = paid("cash");
    const refunded = {
      ...order,
      payment: refundPayment(payment, { by: "m", method: "cash", amountMinor: 200, now: at + 9 }),
    };
    expect(outstandingMinor(refunded)).toBe(0);
    expect(dayTotals([saleOf(refunded)], "2026-11-26", tz).awaitingOrders).toBe(0);
  });
});
