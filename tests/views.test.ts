import { expect, test } from "vitest";
import { createOrder, EDIT_WINDOW_MS, markReady } from "../src/core/orders.ts";
import { confirmPayment } from "../src/core/payments.ts";
import { customerView, staffView, stationView, viewFor } from "../src/core/views.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const order = createOrder(config, {
  id: "o1",
  token: "26-001",
  now: t0,
  customerName: "Asha",
  lines: [
    { itemId: "house-special-chai", size: "M", qty: 2 },
    { itemId: "veg-momos-sf", qty: 1 },
    { itemId: "house-special-chai", size: "S", qty: 1 },
  ],
});

test("a station sees only its own lines, each with its index in the whole order", () => {
  const tea = stationView(order, "tea");
  expect(tea.lines.map((l) => [l.index, l.itemId, l.stationId])).toEqual([
    [0, "house-special-chai", "tea"],
    [2, "house-special-chai", "tea"],
  ]);
  expect(stationView(order, "kitchen").lines.map((l) => l.index)).toEqual([1]);
  expect(Object.keys(tea)).not.toContain("payment");
  expect(viewFor({ kind: "station", stationId: "kitchen" }, order)).toEqual(stationView(order, "kitchen"));
});

test("a customer sees totals, the edit window and the payment state, but no staff details", () => {
  const paid = {
    ...order,
    payment: confirmPayment(order.payment, { by: "counter-1", method: "cash", amountMinor: 13000, now: t0 }),
  };
  expect(customerView(order).editableUntil).toBe(t0 + EDIT_WINDOW_MS);
  const view = customerView(paid);
  expect(view.payment).toEqual({ state: "confirmed", method: "cash", amountMinor: 13000 });
  expect(view.editableUntil).toBeUndefined();
  expect(view.totalMinor).toBe(2 * 3000 + 6000 + 2000);
  expect(view.outstandingMinor).toBe(1000);
  expect(JSON.stringify(view)).not.toContain("counter-1");
  expect(JSON.stringify(view)).not.toContain("stationId");
});

test("a customer sees when every line is ready, without seeing stations", () => {
  expect(customerView(order).ready).toBe(false);
  const tea = markReady(order, "tea", [0, 2]);
  expect(customerView(tea).ready).toBe(false);
  expect(customerView(tea).lines.map((l) => l.ready)).toEqual([true, false, true]);
  expect(customerView(markReady(tea, "kitchen", [1])).ready).toBe(true);
  expect(stationView(tea, "tea").lines.map((l) => l.ready)).toEqual([true, true]);
});

test("counter and owner see the whole order with its totals", () => {
  expect(staffView(order)).toMatchObject({ ...order, totalMinor: 14000, outstandingMinor: 14000 });
  expect(viewFor({ kind: "owner" }, order)).toEqual(staffView(order));
});
