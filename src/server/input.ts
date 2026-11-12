/** Request-body checks. Shape only: whether an item exists or a change is allowed is for `src/core` to say. */

import type { LineRequest } from "../core/orders.ts";
import type { PaymentMethod } from "../core/payments.ts";

/** The request is malformed: names the field, what was expected and what was found. */
export class InputError extends Error {
  readonly code = "bad_input";
  constructor(field: string, expected: string, found: unknown) {
    super(`bad_input: ${field}: expected ${expected}, found ${describe(found)}`);
    this.name = "InputError";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (Array.isArray(value)) return "an array";
  if (value === null || typeof value !== "object") return String(value);
  return "an object";
}

export function object(value: unknown, field = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InputError(field, "an object", value);
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    throw new InputError(field, `a string of 1 to ${max} characters${pattern ? ` matching ${pattern}` : ""}`, value);
  }
  return value;
}

export function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new InputError(field, "a whole number", value);
  return value;
}

export function method(value: unknown, field: string): PaymentMethod {
  if (value !== "upi" && value !== "cash") throw new InputError(field, '"upi" or "cash"', value);
  return value;
}

const MAX_LINES = 50;
/** A station's "all ready" covers every open line it has, so it may name more lines than one order holds. */
const MAX_LINE_REFS = 500;

/** Lines of possibly several orders, each by its order id and its index in that order. */
export function lineRefs(value: unknown, field = "lines"): { orderId: string; index: number }[] {
  if (!Array.isArray(value) || value.length > MAX_LINE_REFS) {
    throw new InputError(field, `an array of at most ${MAX_LINE_REFS} lines`, value);
  }
  return value.map((raw, i) => {
    const f = `${field}[${i}]`;
    const o = object(raw, f);
    return { orderId: text(o.orderId, `${f}.orderId`, 100), index: wholeNumber(o.index, `${f}.index`) };
  });
}

export function lines(value: unknown, field = "lines"): LineRequest[] {
  if (!Array.isArray(value) || value.length > MAX_LINES) {
    throw new InputError(field, `an array of at most ${MAX_LINES} lines`, value);
  }
  return value.map((raw, i) => {
    const f = `${field}[${i}]`;
    const o = object(raw, f);
    const line: LineRequest = { itemId: text(o.itemId, `${f}.itemId`, 100), qty: wholeNumber(o.qty, `${f}.qty`) };
    if (o.size !== undefined) line.size = text(o.size, `${f}.size`, 100);
    return line;
  });
}
