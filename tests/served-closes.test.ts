/**
 * D-097: the order's status follows the floor. A station's first ready line moves a pending order to preparing; the last
 * line handed over closes it when nothing is owed, and confirming the money closes one whose food was already handed over.
 */
import { describe, expect, test } from "vitest";
import { type Config, loadConfig } from "../src/core/config.ts";
import {
  closeIfHandedOver,
  createOrder,
  customerEdit,
  isServed,
  markReady,
  markServed,
  type Order,
  OrderError,
  undoStatus,
  unmarkReady,
} from "../src/core/orders.ts";
import { confirmPayment } from "../src/core/payments.ts";
import { customerView } from "../src/core/views.ts";

const config: Config = loadConfig({
  business: { name: "Business", currency: "INR", timeZone: "Asia/Kolkata" },
  catalog: {
    categories: [
      { id: "hot", name: "Hot", items: [{ id: "chai", name: "Chai", price: 3000 }] },
      { id: "food", name: "Food", items: [{ id: "momos", name: "Momos", price: 8000 }] },
    ],
  },
  stations: [
    { id: "tea", name: "Tea", categories: ["hot"], speak: true, print: null },
    { id: "kitchen", name: "Kitchen", categories: ["food"], speak: true, print: null },
  ],
});

const t0 = Date.UTC(2026, 10, 26, 12, 0);
const order = (): Order =>
  createOrder(config, {
    id: "o1",
    token: "26-001",
    now: t0,
    lines: [
      { itemId: "chai", qty: 1 },
      { itemId: "momos", qty: 1 },
    ],
  });
const paid = (o: Order): Order => ({
  ...o,
  payment: confirmPayment(o.payment, { by: "counter", method: "upi", amountMinor: 11000, now: t0 + 1 }),
});
const handOver = (o: Order, at: number): Order => markServed(markServed(o, 0, at), 1, at);

describe("a station starting an order", () => {
  test("its first ready line moves a pending order to preparing, once, with the time in the history", () => {
    const o = markReady(order(), "tea", [0], t0 + 60_000);
    expect(o.status).toBe("preparing");
    expect(o.history.at(-1)).toEqual({ from: "pending", to: "preparing", at: t0 + 60_000 });
    const both = markReady(o, "kitchen", [1], t0 + 120_000);
    expect(both.status).toBe("preparing");
    expect(both.history).toHaveLength(1);
  });

  test("taking a ready line back, or a call without a time, leaves the status alone", () => {
    expect(markReady(order(), "tea", [0]).status).toBe("pending");
    const o = markReady(order(), "tea", [0], t0 + 1);
    expect(unmarkReady(o, "tea", [0], t0 + 2).status).toBe("preparing");
  });
});

describe("the last line handed over", () => {
  test("closes a paid order", () => {
    const o = handOver(markReady(paid(order()), "tea", [0], t0 + 10), t0 + 500);
    expect(isServed(o)).toBe(true);
    expect(o.status).toBe("completed");
    expect(o.history.at(-1)).toEqual({ from: "preparing", to: "completed", at: t0 + 500 });
  });

  test("closes an order on an open room bill: the money is owed at checkout, not at the counter", () => {
    const onRoom: Order = { ...order(), spot: "Room 4", roomBill: { room: "rooms-4" } };
    expect(handOver(onRoom, t0 + 500).status).toBe("completed");
  });

  test("leaves an unpaid order open for the counter, and confirming the money then closes it", () => {
    const o = handOver(order(), t0 + 500);
    expect(isServed(o)).toBe(true);
    expect(o.status).toBe("pending");
    expect(closeIfHandedOver(paid(o), t0 + 600).status).toBe("completed");
  });

  test("one line handed over is not the whole order", () => {
    expect(markServed(paid(order()), 0, t0 + 500).status).toBe("pending");
    expect(isServed(markServed(order(), 0, t0))).toBe(false);
  });

  test("closing is idempotent: a completed order comes back as it was", () => {
    const o = handOver(paid(order()), t0 + 500);
    expect(closeIfHandedOver(o, t0 + 900)).toBe(o);
  });

  test("the guest's view says served, so the phone can say so", () => {
    expect(customerView(handOver(paid(order()), t0 + 500)).served).toBe(true);
    expect(customerView(markServed(order(), 0, t0)).served).toBe(false);
  });
});

test("an undo back to pending doesn't hand the guest food the kitchen already made", () => {
  const started = markReady(order(), "tea", [0], t0 + 1000);
  const undone = undoStatus(started, t0 + 2000);
  expect(undone.status).toBe("pending");
  let code = "";
  try {
    customerEdit(config, undone, [{ itemId: "momos", qty: 2 }], t0 + 3000);
  } catch (e) {
    code = e instanceof OrderError ? e.code : String(e);
  }
  expect(code).toBe("not_pending");
});
