import { describe, expect, test } from "vitest";
import { type Config, loadConfig } from "../src/core/config.ts";
import {
  addLines,
  advanceStatus,
  createOrder,
  customerEdit,
  EDIT_WINDOW_MS,
  isReady,
  markReady,
  markServed,
  OrderError,
  orderTotal,
  outstandingMinor,
  topUp,
  UNDO_WINDOW_MS,
  undoStatus,
  unmarkReady,
} from "../src/core/orders.ts";
import { claimPayment, confirmPayment, topUpPayment } from "../src/core/payments.ts";

const config: Config = loadConfig({
  business: { name: "Business", currency: "INR", timeZone: "Asia/Kolkata" },
  catalog: {
    categories: [
      {
        id: "hot",
        name: "Hot",
        items: [
          {
            id: "chai",
            name: "Chai",
            variants: [
              { size: "S", price: 2000 },
              { size: "M", price: 3000 },
            ],
          },
        ],
      },
      {
        id: "food",
        name: "Food",
        items: [
          { id: "momos", name: "Momos", price: 8050 },
          { id: "pasta", name: "Pasta", price: 12000, available: false },
        ],
      },
    ],
  },
  stations: [
    { id: "tea", name: "Tea", categories: ["hot"], speak: true, print: null },
    { id: "kitchen", name: "Kitchen", categories: ["food"], speak: true, print: "ticket-80mm" },
  ],
});

const t0 = Date.UTC(2026, 10, 26, 12, 0);

function order() {
  return createOrder(config, {
    id: "o1",
    token: "26-001",
    now: t0,
    lines: [
      { itemId: "chai", size: "M", qty: 2 },
      { itemId: "momos", qty: 1 },
    ],
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrderError) return e.code;
    throw e;
  }
  throw new Error("expected an OrderError");
}

describe("create", () => {
  test("prices lines in minor units, in the business currency, and routes each to its station", () => {
    const o = order();
    expect(o.status).toBe("pending");
    expect(o.currency).toBe("INR");
    expect(o.payment).toEqual({ state: "unpaid" });
    expect(o.lines).toEqual([
      {
        itemId: "chai",
        name: "Chai",
        size: "M",
        qty: 2,
        unitMinor: 3000,
        stationId: "tea",
        served: false,
        ready: false,
      },
      { itemId: "momos", name: "Momos", qty: 1, unitMinor: 8050, stationId: "kitchen", served: false, ready: false },
    ]);
    expect(orderTotal(o)).toBe(14050);
  });

  test("keeps an optional customer name, trimmed", () => {
    const o = createOrder(config, {
      id: "o",
      token: "t",
      now: t0,
      customerName: "  Asha ",
      lines: [{ itemId: "momos", qty: 1 }],
    });
    expect(o.customerName).toBe("Asha");
  });

  test("rejects bad lines loudly", () => {
    const make = (lines: Parameters<typeof createOrder>[1]["lines"]) =>
      codeOf(() => createOrder(config, { id: "o", token: "t", now: t0, lines }));
    expect(make([])).toBe("empty_order");
    expect(make([{ itemId: "nope", qty: 1 }])).toBe("unknown_item");
    expect(make([{ itemId: "pasta", qty: 1 }])).toBe("unavailable_item");
    expect(make([{ itemId: "chai", qty: 1 }])).toBe("bad_size");
    expect(make([{ itemId: "chai", size: "XL", qty: 1 }])).toBe("bad_size");
    expect(make([{ itemId: "momos", size: "M", qty: 1 }])).toBe("bad_size");
    expect(make([{ itemId: "momos", qty: 0 }])).toBe("bad_quantity");
    expect(make([{ itemId: "momos", qty: 1.5 }])).toBe("bad_quantity");
  });

  test("caps the quantity per line at the business's maxQtyPerLine (99 by default)", () => {
    const make = (qty: number) =>
      codeOf(() => createOrder(config, { id: "o", token: "t", now: t0, lines: [{ itemId: "momos", qty }] }));
    expect(config.business.maxQtyPerLine).toBe(99);
    expect(
      createOrder(config, { id: "o", token: "t", now: t0, lines: [{ itemId: "momos", qty: 99 }] }).lines[0]?.qty,
    ).toBe(99);
    expect(make(100)).toBe("bad_quantity");
    expect(make(Number.MAX_SAFE_INTEGER)).toBe("bad_quantity");
  });

  test("refuses an order whose total would not be a safe integer", () => {
    const pricey = loadConfig({
      business: { name: "B", currency: "INR", timeZone: "Asia/Kolkata" },
      catalog: { categories: [{ id: "a", name: "A", items: [{ id: "x", name: "X", price: 2 ** 52 }] }] },
      stations: [{ id: "s", name: "S", categories: ["a"], speak: false, print: null }],
    });
    const one = createOrder(pricey, { id: "o", token: "t", now: t0, lines: [{ itemId: "x", qty: 1 }] });
    expect(codeOf(() => createOrder(pricey, { id: "o", token: "t", now: t0, lines: [{ itemId: "x", qty: 2 }] }))).toBe(
      "total_too_large",
    );
    expect(codeOf(() => addLines(pricey, one, [{ itemId: "x", qty: 1 }]))).toBe("total_too_large");
    expect(
      codeOf(() =>
        customerEdit(
          pricey,
          one,
          [
            { itemId: "x", qty: 1 },
            { itemId: "x", qty: 1 },
          ],
          t0,
        ),
      ),
    ).toBe("total_too_large");
  });
});

describe("status machine", () => {
  test("moves pending, preparing, completed and no further", () => {
    const preparing = advanceStatus(order(), t0 + 1000);
    expect(preparing.status).toBe("preparing");
    const completed = advanceStatus(preparing, t0 + 2000);
    expect(completed.status).toBe("completed");
    expect(codeOf(() => advanceStatus(completed, t0 + 3000))).toBe("bad_transition");
  });

  test("undo reverts the last change within 5 minutes", () => {
    const changedAt = t0 + 1000;
    const preparing = advanceStatus(order(), changedAt);
    const undone = undoStatus(preparing, changedAt + UNDO_WINDOW_MS);
    expect(undone.status).toBe("pending");
    expect(undone.history).toEqual([]);
  });

  test("undo is refused after 5 minutes, and when there is nothing to undo", () => {
    const changedAt = t0 + 1000;
    const preparing = advanceStatus(order(), changedAt);
    expect(codeOf(() => undoStatus(preparing, changedAt + UNDO_WINDOW_MS + 1))).toBe("undo_expired");
    expect(codeOf(() => undoStatus(order(), t0))).toBe("nothing_to_undo");
  });

  test("undo steps back one change at a time", () => {
    const completed = advanceStatus(advanceStatus(order(), t0 + 1000), t0 + 2000);
    const back1 = undoStatus(completed, t0 + 3000);
    expect(back1.status).toBe("preparing");
    expect(undoStatus(back1, t0 + 4000).status).toBe("pending");
  });
});

describe("customer edit", () => {
  test("allowed for 2 minutes while pending; re-prices the order", () => {
    const edited = customerEdit(config, order(), [{ itemId: "chai", size: "S", qty: 3 }], t0 + EDIT_WINDOW_MS);
    expect(edited.lines).toHaveLength(1);
    expect(orderTotal(edited)).toBe(6000);
    expect(edited.createdAt).toBe(t0);
  });

  test("refused after 2 minutes or once preparing", () => {
    const lines = [{ itemId: "momos", qty: 1 }];
    expect(codeOf(() => customerEdit(config, order(), lines, t0 + EDIT_WINDOW_MS + 1))).toBe("edit_expired");
    expect(codeOf(() => customerEdit(config, advanceStatus(order(), t0 + 1), lines, t0 + 2))).toBe("not_pending");
  });
});

describe("payment and edits", () => {
  const extra = [{ itemId: "momos", qty: 2 }];

  test("an unpaid order can be edited, and owes its full total", () => {
    const edited = customerEdit(config, order(), extra, t0 + 1000);
    expect(outstandingMinor(edited)).toBe(16100);
  });

  test("a customer edit is refused once payment is claimed or confirmed", () => {
    const o = order();
    const claimed = { ...o, payment: claimPayment(o.payment, { method: "upi", amountMinor: orderTotal(o), now: t0 }) };
    expect(codeOf(() => customerEdit(config, claimed, extra, t0 + 1000))).toBe("already_paid");
    const confirmed = {
      ...o,
      payment: confirmPayment(o.payment, { by: "counter-1", method: "cash", amountMinor: orderTotal(o), now: t0 }),
    };
    expect(codeOf(() => customerEdit(config, confirmed, extra, t0 + 1000))).toBe("already_paid");
  });

  test("a claim does not count as paid; only a confirmed amount does", () => {
    const o = order();
    const claimed = { ...o, payment: claimPayment(o.payment, { method: "upi", amountMinor: orderTotal(o), now: t0 }) };
    expect(outstandingMinor(claimed)).toBe(14050);
    const confirmed = {
      ...claimed,
      payment: confirmPayment(claimed.payment, { by: "counter-1", method: "upi", amountMinor: 14050, now: t0 }),
    };
    expect(outstandingMinor(confirmed)).toBe(0);
  });

  test("staff adding to a confirmed order leaves the extra outstanding and the payment untouched", () => {
    const o = order();
    const confirmed = {
      ...o,
      payment: confirmPayment(o.payment, { by: "counter-1", method: "cash", amountMinor: 14050, now: t0 }),
    };
    const added = addLines(config, confirmed, extra);
    expect(added.lines).toHaveLength(3);
    expect(added.payment).toBe(confirmed.payment);
    expect(outstandingMinor(added)).toBe(16100);
    const topped = {
      ...added,
      payment: topUpPayment(added.payment, { by: "counter-1", method: "cash", amountMinor: 16100, now: t0 + 1 }),
    };
    expect(outstandingMinor(topped)).toBe(0);
  });

  test("a top-up takes at most what is still owed", () => {
    const o = order();
    const confirmed = {
      ...o,
      payment: confirmPayment(o.payment, { by: "counter-1", method: "cash", amountMinor: 14050, now: t0 }),
    };
    const added = addLines(config, confirmed, extra);
    const by = { by: "counter-1", method: "cash" as const, now: t0 + 1 };
    expect(codeOf(() => topUp(added, { ...by, amountMinor: 16101 }))).toBe("overpay");
    expect(codeOf(() => topUp(confirmed, { ...by, amountMinor: 1 }))).toBe("overpay");
    expect(outstandingMinor(topUp(added, { ...by, amountMinor: 6100 }))).toBe(10000);
    expect(outstandingMinor(topUp(added, { ...by, amountMinor: 16100 }))).toBe(0);
  });

  test("staff cannot add to a completed order", () => {
    const completed = advanceStatus(advanceStatus(order(), t0), t0);
    expect(codeOf(() => addLines(config, completed, extra))).toBe("bad_transition");
  });
});

describe("per-item served", () => {
  test("marks one line served at a time", () => {
    const o = markServed(order(), 1);
    expect(o.lines.map((l) => l.served)).toEqual([false, true]);
    expect(codeOf(() => markServed(o, 1))).toBe("already_served");
    expect(codeOf(() => markServed(o, 2))).toBe("no_such_line");
  });
});

describe("ready at a station", () => {
  test("a station marks its own lines ready; the order is ready once every line is ready or served", () => {
    const o = order();
    expect(isReady(o)).toBe(false);
    const tea = markReady(o, "tea", [0]);
    expect(tea.lines.map((l) => l.ready)).toEqual([true, false]);
    expect(isReady(tea)).toBe(false);
    expect(isReady(markReady(tea, "kitchen", [1]))).toBe(true);
    expect(isReady(markServed(tea, 1))).toBe(true);
    expect(o.lines.map((l) => l.ready)).toEqual([false, false]);
  });

  test("refuses another station's line or an unknown one", () => {
    expect(codeOf(() => markReady(order(), "tea", [1]))).toBe("wrong_station");
    expect(codeOf(() => markReady(order(), "tea", [5]))).toBe("no_such_line");
    expect(codeOf(() => markReady(order(), "tea", [-1]))).toBe("no_such_line");
  });

  test("a line already ready or served, or a completed order, is left as it is", () => {
    const tea = markReady(order(), "tea", [0]);
    expect(markReady(tea, "tea", [0])).toBe(tea);
    const served = markServed(order(), 1);
    expect(markReady(served, "kitchen", [1])).toBe(served);
    const done = advanceStatus(advanceStatus(order(), t0), t0);
    expect(markReady(done, "tea", [0])).toBe(done);
  });

  test("a station takes back its own ready lines; served lines and completed orders stay as they are", () => {
    const ready = markReady(markReady(order(), "tea", [0]), "kitchen", [1]);
    const back = unmarkReady(ready, "tea", [0]);
    expect(back.lines.map((l) => l.ready)).toEqual([false, true]);
    expect(isReady(back)).toBe(false);
    expect(unmarkReady(back, "tea", [0])).toBe(back);
    expect(codeOf(() => unmarkReady(ready, "tea", [1]))).toBe("wrong_station");
    expect(codeOf(() => unmarkReady(ready, "tea", [7]))).toBe("no_such_line");
    const served = markServed(ready, 0);
    expect(unmarkReady(served, "tea", [0])).toBe(served);
    const done = advanceStatus(advanceStatus(ready, t0), t0);
    expect(unmarkReady(done, "tea", [0])).toBe(done);
  });

  test("lines staff add later are not ready, so the order is not either", () => {
    const ready = markReady(markReady(order(), "tea", [0]), "kitchen", [1]);
    expect(isReady(addLines(config, ready, [{ itemId: "chai", size: "S", qty: 1 }]))).toBe(false);
  });
});

test("an OrderError message says what was expected and what was found", () => {
  const preparing = advanceStatus(order(), t0 + 1000);
  expect(() => undoStatus(preparing, t0 + 1000 + UNDO_WINDOW_MS + 1)).toThrow(
    "expected an undo within 300000 ms of the change, found 300001 ms",
  );
});
