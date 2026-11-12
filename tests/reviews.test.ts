import { describe, expect, test } from "vitest";
import { advanceStatus, createOrder, OrderError } from "../src/core/orders.ts";
import { reviewOrder } from "../src/core/reviews.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const pending = createOrder(config, {
  id: "o1",
  token: "26-001",
  now: t0,
  lines: [{ itemId: "veg-momos-sf", qty: 1 }],
  customerName: "Asha",
});
const completed = advanceStatus(advanceStatus(pending, t0 + 1), t0 + 2);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrderError) return e.code;
    throw e;
  }
  return undefined;
}

describe("reviewOrder", () => {
  test("a completed order takes a rating of 1 to 5 and optional trimmed text, with no customer details", () => {
    expect(reviewOrder(completed, { rating: 5, text: "  Lovely chai ", now: t0 + 3 })).toEqual({
      orderId: "o1",
      rating: 5,
      text: "Lovely chai",
      at: t0 + 3,
    });
    expect(reviewOrder(completed, { rating: 1, text: "   ", now: t0 + 3 })).toEqual({
      orderId: "o1",
      rating: 1,
      at: t0 + 3,
    });
  });

  test("refuses an order that isn't completed, and a rating outside 1 to 5", () => {
    expect(code(() => reviewOrder(pending, { rating: 4, now: t0 }))).toBe("not_completed");
    for (const rating of [0, 6, 2.5, Number.NaN]) {
      expect(code(() => reviewOrder(completed, { rating, now: t0 }))).toBe("bad_rating");
    }
    expect(code(() => reviewOrder(completed, { rating: 3, text: "x".repeat(501), now: t0 }))).toBe("bad_rating");
  });
});
