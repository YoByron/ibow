/** Payment states, and the UPI adapter's intent link. Nothing becomes `confirmed` without a named staff member. */

import { majorAmount } from "./money.ts";

export type PaymentMethod = "upi" | "cash" | "card";

export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "upi", "card"];

/** Money a staff member handed back for an order already paid. Ordered is unchanged; Received falls by `amountMinor`. */
export interface Refund {
  method: PaymentMethod;
  amountMinor: number;
  at: number;
  by: string;
}

/** An extra amount staff took after the first confirmation, for lines added to an order already paid. */
export interface TopUp {
  method: PaymentMethod;
  amountMinor: number;
  at: number;
  by: string;
}

export type Payment =
  | { state: "unpaid" }
  /** The customer says they paid; staff have not checked yet. */
  | { state: "claimed"; method: PaymentMethod; amountMinor: number; at: number }
  /**
   * Staff confirmed `amountMinor` arrived, top-ups included; `method`, `at` and `by` are those of the first
   * confirmation. Compare it with the order total: items can be added after payment.
   */
  | {
      state: "confirmed";
      method: PaymentMethod;
      amountMinor: number;
      at: number;
      by: string;
      topUps?: readonly TopUp[];
      /** Money handed back. `amountMinor` stays what was received; what is kept is `amountMinor` less the refunds. */
      refunds?: readonly Refund[];
    };

export const UNPAID: Payment = Object.freeze({ state: "unpaid" });

export type PaymentErrorCode =
  | "bad_amount"
  | "over_refund"
  | "bad_state"
  | "no_staff"
  | "bad_vpa"
  | "unsupported_currency";

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  constructor(code: PaymentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PaymentError";
    this.code = code;
  }
}

const VPA = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;

function checkAmount(fn: string, amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PaymentError(
      "bad_amount",
      `${fn}: expected a positive integer amount in minor units, found ${amountMinor}`,
    );
  }
}

export interface UpiIntentInput {
  vpa: string;
  payeeName: string;
  amountMinor: number;
  currency: string;
  token: string;
}

/**
 * The UPI adapter: `upi://pay?pa=<vpa>&pn=<payee>&am=<rupees>&cu=INR&tn=Token%20<token>`, the format the live app
 * used. UPI settles only in rupees, so any other currency is refused rather than converted.
 */
export function upiIntent({ vpa, payeeName, amountMinor, currency, token }: UpiIntentInput): string {
  if (currency !== "INR") {
    throw new PaymentError(
      "unsupported_currency",
      `upiIntent: expected currency "INR", found ${JSON.stringify(currency)}`,
    );
  }
  if (!VPA.test(vpa)) {
    throw new PaymentError("bad_vpa", `upiIntent: expected a UPI ID like name@bank, found ${JSON.stringify(vpa)}`);
  }
  checkAmount("upiIntent", amountMinor);
  const pn = encodeURIComponent(payeeName);
  const tn = encodeURIComponent(`Token ${token}`);
  return `upi://pay?pa=${vpa}&pn=${pn}&am=${majorAmount(amountMinor, currency)}&cu=INR&tn=${tn}`;
}

/** The customer says they paid `amountMinor`. */
export function claimPayment(
  payment: Payment,
  { method, amountMinor, now }: { method: PaymentMethod; amountMinor: number; now: number },
): Payment {
  if (payment.state !== "unpaid") {
    throw new PaymentError("bad_state", `claimPayment: expected an unpaid payment, found ${payment.state}`);
  }
  checkAmount("claimPayment", amountMinor);
  return { state: "claimed", method, amountMinor, at: now };
}

/** A staff member confirms `amountMinor` arrived (a claimed UPI payment, or cash handed over at the counter). */
export function confirmPayment(
  payment: Payment,
  { by, method, amountMinor, now }: { by: string; method: PaymentMethod; amountMinor: number; now: number },
): Payment {
  if (by.trim() === "") throw new PaymentError("no_staff", "confirmPayment: expected a staff id, found an empty one");
  if (payment.state === "confirmed") {
    throw new PaymentError("bad_state", "confirmPayment: expected an unpaid or claimed payment, found confirmed");
  }
  checkAmount("confirmPayment", amountMinor);
  return { state: "confirmed", method, amountMinor, at: now, by };
}

/**
 * A staff member confirms an extra `amountMinor` arrived on a payment already confirmed: the difference left by lines
 * added after payment (D-007). Only a staff action calls this; nothing flips an order to paid by itself.
 */
export function topUpPayment(
  payment: Payment,
  { by, method, amountMinor, now }: { by: string; method: PaymentMethod; amountMinor: number; now: number },
): Payment {
  if (by.trim() === "") throw new PaymentError("no_staff", "topUpPayment: expected a staff id, found an empty one");
  if (payment.state !== "confirmed") {
    throw new PaymentError("bad_state", `topUpPayment: expected a confirmed payment, found ${payment.state}`);
  }
  checkAmount("topUpPayment", amountMinor);
  const total = payment.amountMinor + amountMinor;
  if (!Number.isSafeInteger(total)) {
    throw new PaymentError(
      "bad_amount",
      `topUpPayment: expected a total up to ${Number.MAX_SAFE_INTEGER}, found ${total}`,
    );
  }
  const topUps = [...(payment.topUps ?? []), { method, amountMinor, at: now, by }];
  return { ...payment, amountMinor: total, topUps };
}

/** What one method took in on a confirmed payment: the confirmation and each top-up, before refunds. */
function receivedBy(payment: Extract<Payment, { state: "confirmed" }>, method: PaymentMethod): number {
  const topUps = payment.topUps ?? [];
  const base = payment.amountMinor - topUps.reduce((n, t) => n + t.amountMinor, 0);
  const extra = topUps.filter((t) => t.method === method).reduce((n, t) => n + t.amountMinor, 0);
  return (payment.method === method ? base : 0) + extra;
}

/** What a payment still holds: received less refunded. Zero unless a person confirmed it. */
export function keptMinor(payment: Payment): number {
  if (payment.state !== "confirmed") return 0;
  return payment.amountMinor - (payment.refunds ?? []).reduce((n, r) => n + r.amountMinor, 0);
}

/**
 * A staff member records money handed back: how much, by which method, who and when. Only money a person confirmed can
 * be refunded, and no method gives back more than it took in. Whether this person may is the caller's check
 * (`src/core/levels.ts`); Ordered stays as it was and only Received falls.
 */
export function refundPayment(
  payment: Payment,
  { by, method, amountMinor, now }: { by: string; method: PaymentMethod; amountMinor: number; now: number },
): Payment {
  if (by.trim() === "") throw new PaymentError("no_staff", "refundPayment: expected a staff id, found an empty one");
  if (payment.state !== "confirmed") {
    throw new PaymentError("bad_state", `refundPayment: expected a confirmed payment, found ${payment.state}`);
  }
  checkAmount("refundPayment", amountMinor);
  const refunds = payment.refunds ?? [];
  const back = refunds.filter((r) => r.method === method).reduce((n, r) => n + r.amountMinor, 0);
  const left = receivedBy(payment, method) - back;
  if (amountMinor > left) {
    throw new PaymentError(
      "over_refund",
      `refundPayment: expected at most ${left} minor units back by ${method}, found ${amountMinor}`,
    );
  }
  return { ...payment, refunds: [...refunds, { method, amountMinor, at: now, by }] };
}
