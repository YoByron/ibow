import { expect, test } from "vitest";
import { createOrder, markReady, markServed } from "../src/core/orders.ts";
import { runnerOrders } from "../src/core/runner.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const MIN = 60_000;
const t0 = 1_000_000;
const lateMs = 6 * MIN;

const three = () =>
  createOrder(cafe, {
    id: "o",
    token: "01-012",
    now: t0,
    spotId: "garden-t4",
    lines: [
      { itemId: "latte", size: "Regular", qty: 1 },
      { itemId: "mango-smoothie", qty: 1 },
      { itemId: "carrot-cake", qty: 1 },
    ],
  });

test("shows the spot, what is delivered and which station the rest waits on", () => {
  let o = markReady(three(), "bar", [0], t0 + MIN);
  o = markReady(o, "cakes", [2], t0 + MIN);
  o = markServed(o, 2, t0 + 2 * MIN);
  const [r] = runnerOrders([o], t0 + 3 * MIN, lateMs);
  expect(r).toMatchObject({ spot: "Garden T4", delivered: 1, waitingOn: ["smoothies"], toCarry: 1 });
  expect(r?.late).toBeUndefined();
  expect(r?.lines.map((l) => l.state)).toEqual(["ready", "making", "delivered"]);
});

test("part delivered and the rest not following within the late time is late", () => {
  let o = markReady(three(), "cakes", [2], t0 + MIN);
  o = markServed(o, 2, t0 + 2 * MIN);
  expect(runnerOrders([o], t0 + 7 * MIN, lateMs)[0]?.late).toBeUndefined();
  expect(runnerOrders([o], t0 + 9 * MIN, lateMs)[0]?.late).toBe("part-delivered");
});

test("a line standing ready too long is late, and late orders come first", () => {
  const cold = markReady(three(), "bar", [0], t0 + MIN);
  const fresh = { ...three(), id: "p", token: "01-013", createdAt: t0 - 5 * MIN };
  const rows = runnerOrders([fresh, cold], t0 + 8 * MIN, lateMs);
  expect(rows.map((r) => [r.token, r.late])).toEqual([
    ["01-012", "ready-waiting"],
    ["01-013", undefined],
  ]);
});

test("completed orders are not listed", () => {
  expect(runnerOrders([{ ...three(), status: "completed" }], t0, lateMs)).toEqual([]);
});

test("an order with every line delivered has nothing left to carry", () => {
  let o = three();
  for (const i of [0, 1, 2]) o = markServed(markReady(o, o.lines[i]?.stationId ?? "", [i], t0), i, t0);
  expect(runnerOrders([o], t0, lateMs)).toEqual([]);
});
