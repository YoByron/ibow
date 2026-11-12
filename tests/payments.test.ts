import { describe, expect, test } from "vitest";
import { claimPayment, confirmPayment, PaymentError, topUpPayment, UNPAID, upiIntent } from "../src/core/payments.ts";

const now = Date.UTC(2026, 10, 26, 12, 0);

describe("UPI intent", () => {
  test("matches the live app's format, with VPA and payee from config", () => {
    expect(
      upiIntent({
        vpa: "business.name@example",
        payeeName: "The Tea House",
        amountMinor: 9000,
        currency: "INR",
        token: "26-001",
      }),
    ).toBe("upi://pay?pa=business.name@example&pn=The%20Tea%20House&am=90&cu=INR&tn=Token%2026-001");
  });

  test("is one payment adapter, for INR only", () => {
    let error: unknown;
    try {
      upiIntent({ vpa: "a1@example", payeeName: "S", amountMinor: 1500, currency: "AED", token: "01-001" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PaymentError);
    expect((error as PaymentError).code).toBe("unsupported_currency");
    expect((error as PaymentError).message).toBe(
      'unsupported_currency: upiIntent: expected currency "INR", found "AED"',
    );
  });

  test("encodes the payee name", () => {
    expect(
      upiIntent({ vpa: "a1@example", payeeName: "Tea & Co", amountMinor: 100, currency: "INR", token: "01-002" }),
    ).toContain("pn=Tea%20%26%20Co");
  });

  test("rejects a malformed VPA or amount", () => {
    expect(() =>
      upiIntent({ vpa: "not-a-vpa", payeeName: "S", amountMinor: 100, currency: "INR", token: "01-001" }),
    ).toThrow('expected a UPI ID like name@bank, found "not-a-vpa"');
    expect(() =>
      upiIntent({ vpa: "a1@example", payeeName: "S", amountMinor: 0, currency: "INR", token: "01-001" }),
    ).toThrow("positive integer amount in minor units");
  });
});

describe("payment states", () => {
  test("a customer claim is not a confirmation, and records the amount claimed", () => {
    const claimed = claimPayment(UNPAID, { method: "upi", amountMinor: 9000, now });
    expect(claimed).toEqual({ state: "claimed", method: "upi", amountMinor: 9000, at: now });
  });

  test("confirming needs a staff member and records the amount confirmed", () => {
    const claimed = claimPayment(UNPAID, { method: "upi", amountMinor: 9000, now });
    expect(() => confirmPayment(claimed, { by: "", method: "upi", amountMinor: 9000, now })).toThrow(
      "expected a staff id",
    );
    expect(confirmPayment(claimed, { by: "counter-1", method: "upi", amountMinor: 9000, now: now + 1 })).toEqual({
      state: "confirmed",
      method: "upi",
      amountMinor: 9000,
      at: now + 1,
      by: "counter-1",
    });
  });

  test("cash at the counter is confirmed directly from unpaid", () => {
    expect(confirmPayment(UNPAID, { by: "counter-1", method: "cash", amountMinor: 3000, now }).state).toBe("confirmed");
  });

  test("amounts must be positive integer minor units", () => {
    expect(() => claimPayment(UNPAID, { method: "upi", amountMinor: 0, now })).toThrow(
      "positive integer amount in minor units",
    );
    expect(() => confirmPayment(UNPAID, { by: "c", method: "cash", amountMinor: 10.5, now })).toThrow(
      "positive integer amount in minor units",
    );
  });

  test("a top-up on a confirmed payment records who took the extra amount, how and when, and adds it", () => {
    const confirmed = confirmPayment(UNPAID, { by: "counter-1", method: "cash", amountMinor: 3000, now });
    const topped = topUpPayment(confirmed, { by: "counter-2", method: "upi", amountMinor: 2000, now: now + 5 });
    expect(topped).toEqual({
      state: "confirmed",
      method: "cash",
      amountMinor: 5000,
      at: now,
      by: "counter-1",
      topUps: [{ method: "upi", amountMinor: 2000, at: now + 5, by: "counter-2" }],
    });
    const again = topUpPayment(topped, { by: "counter-1", method: "cash", amountMinor: 500, now: now + 9 });
    expect(again.state === "confirmed" && again.topUps?.map((t) => t.amountMinor)).toEqual([2000, 500]);
    expect(again.state === "confirmed" && again.amountMinor).toBe(5500);
  });

  test("a top-up needs a confirmed payment, a staff member and a positive amount", () => {
    const claimed = claimPayment(UNPAID, { method: "upi", amountMinor: 3000, now });
    expect(() => topUpPayment(UNPAID, { by: "c", method: "cash", amountMinor: 100, now })).toThrow(
      "topUpPayment: expected a confirmed payment, found unpaid",
    );
    expect(() => topUpPayment(claimed, { by: "c", method: "cash", amountMinor: 100, now })).toThrow("found claimed");
    const confirmed = confirmPayment(UNPAID, { by: "counter-1", method: "cash", amountMinor: 3000, now });
    expect(() => topUpPayment(confirmed, { by: " ", method: "cash", amountMinor: 100, now })).toThrow(
      "expected a staff id",
    );
    expect(() => topUpPayment(confirmed, { by: "c", method: "cash", amountMinor: 0, now })).toThrow(
      "positive integer amount in minor units",
    );
    expect(() =>
      topUpPayment(confirmed, { by: "c", method: "cash", amountMinor: Number.MAX_SAFE_INTEGER, now }),
    ).toThrow("bad_amount");
  });

  test("cannot claim or confirm twice", () => {
    const confirmed = confirmPayment(UNPAID, { by: "counter-1", method: "cash", amountMinor: 3000, now });
    expect(() => confirmPayment(confirmed, { by: "counter-1", method: "cash", amountMinor: 3000, now })).toThrow(
      "expected an unpaid or claimed payment, found confirmed",
    );
    const claimed = claimPayment(UNPAID, { method: "upi", amountMinor: 3000, now });
    expect(() => claimPayment(claimed, { method: "upi", amountMinor: 3000, now })).toThrow(
      "expected an unpaid payment, found claimed",
    );
  });
});
