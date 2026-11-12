/** Order model, status machine and edit windows. Pure: time is passed in, orders are never mutated. */

import { type Config, stationFor } from "./config.ts";
import { type Payment, type PaymentMethod, topUpPayment, UNPAID } from "./payments.ts";

export type OrderStatus = "pending" | "preparing" | "completed";

export const UNDO_WINDOW_MS = 5 * 60_000;
export const EDIT_WINDOW_MS = 2 * 60_000;

export interface LineRequest {
  itemId: string;
  size?: string;
  qty: number;
}

export interface OrderLine {
  itemId: string;
  name: string;
  size?: string;
  qty: number;
  /** Price of one unit in integer minor units, fixed when the line was added. */
  unitMinor: number;
  stationId: string;
  served: boolean;
  /** The station has it ready to hand over; serving it is still the counter's step. */
  ready: boolean;
}

export interface StatusChange {
  from: OrderStatus;
  to: OrderStatus;
  at: number;
}

export interface Order {
  id: string;
  token: string;
  createdAt: number;
  /** ISO 4217 code of every amount on the order, taken from the business when it was created. */
  currency: string;
  customerName?: string;
  lines: readonly OrderLine[];
  status: OrderStatus;
  /** Status changes still on the undo stack, oldest first. */
  history: readonly StatusChange[];
  payment: Payment;
}

export type OrderErrorCode =
  | "empty_order"
  | "unknown_item"
  | "unavailable_item"
  | "bad_size"
  | "bad_quantity"
  | "bad_transition"
  | "nothing_to_undo"
  | "undo_expired"
  | "not_pending"
  | "edit_expired"
  | "no_such_line"
  | "already_served"
  | "wrong_station"
  | "overpay"
  | "already_paid"
  | "total_too_large"
  | "not_completed"
  | "bad_rating";

export class OrderError extends Error {
  readonly code: OrderErrorCode;
  constructor(code: OrderErrorCode, expected: string, found: string) {
    super(`${code}: expected ${expected}, found ${found}`);
    this.name = "OrderError";
    this.code = code;
  }
}

const NEXT: Record<OrderStatus, OrderStatus | null> = { pending: "preparing", preparing: "completed", completed: null };

function priceLines(config: Config, requests: readonly LineRequest[]): OrderLine[] {
  if (requests.length === 0) throw new OrderError("empty_order", "at least one line", "none");
  return requests.map((req, i) => {
    const entry = config.items.get(req.itemId);
    if (entry === undefined)
      throw new OrderError("unknown_item", "an item id from the catalog", `${JSON.stringify(req.itemId)} at line ${i}`);
    const { item } = entry;
    if (item.available === false) throw new OrderError("unavailable_item", "an available item", `${item.id} is off`);
    const max = config.business.maxQtyPerLine;
    if (!Number.isSafeInteger(req.qty) || req.qty < 1 || req.qty > max) {
      throw new OrderError("bad_quantity", `a whole quantity from 1 to ${max}`, `${req.qty} for ${item.id}`);
    }
    let size: string | undefined;
    let unitMinor: number;
    if (item.variants === undefined) {
      if (req.size !== undefined) throw new OrderError("bad_size", `no size for ${item.id}`, JSON.stringify(req.size));
      unitMinor = item.price ?? 0;
    } else {
      const variant = item.variants.find((v) => v.size === req.size);
      if (variant === undefined) {
        const sizes = item.variants.map((v) => v.size).join(", ");
        throw new OrderError("bad_size", `one of ${sizes} for ${item.id}`, JSON.stringify(req.size ?? null));
      }
      size = variant.size;
      unitMinor = variant.price;
    }
    const stationId = stationFor(config, item.id).id;
    return {
      itemId: item.id,
      name: item.name,
      ...(size === undefined ? {} : { size }),
      qty: req.qty,
      unitMinor,
      stationId,
      served: false,
      ready: false,
    };
  });
}

/** Every total must stay a safe integer, or sums and comparisons with it silently go wrong. */
function checkedTotal(order: Order): Order {
  let sum = 0;
  for (const l of order.lines) {
    sum += l.unitMinor * l.qty;
    if (!Number.isSafeInteger(sum)) {
      throw new OrderError("total_too_large", `a total up to ${Number.MAX_SAFE_INTEGER} minor units`, String(sum));
    }
  }
  return order;
}

export function createOrder(
  config: Config,
  input: { id: string; token: string; now: number; lines: readonly LineRequest[]; customerName?: string },
): Order {
  const order: Order = {
    id: input.id,
    token: input.token,
    createdAt: input.now,
    currency: config.business.currency,
    lines: priceLines(config, input.lines),
    status: "pending",
    history: [],
    payment: UNPAID,
  };
  const name = input.customerName?.trim();
  if (name) order.customerName = name;
  return checkedTotal(order);
}

/** Total in integer minor units of `order.currency`. */
export function orderTotal(order: Order): number {
  return order.lines.reduce((sum, l) => sum + l.unitMinor * l.qty, 0);
}

/** pending → preparing → completed. */
export function advanceStatus(order: Order, now: number): Order {
  const to = NEXT[order.status];
  if (to === null) throw new OrderError("bad_transition", "a pending or preparing order", order.status);
  return { ...order, status: to, history: [...order.history, { from: order.status, to, at: now }] };
}

/** Reverts the latest status change if it happened within the undo window. */
export function undoStatus(order: Order, now: number): Order {
  const last = order.history.at(-1);
  if (last === undefined) throw new OrderError("nothing_to_undo", "a status change to undo", "none");
  const elapsed = now - last.at;
  if (elapsed > UNDO_WINDOW_MS) {
    throw new OrderError("undo_expired", `an undo within ${UNDO_WINDOW_MS} ms of the change`, `${elapsed} ms`);
  }
  return { ...order, status: last.from, history: order.history.slice(0, -1) };
}

/** The customer replaces their lines: only while pending and within the edit window from creation. */
export function customerEdit(config: Config, order: Order, lines: readonly LineRequest[], now: number): Order {
  if (order.status !== "pending") throw new OrderError("not_pending", "a pending order", order.status);
  if (order.payment.state !== "unpaid") {
    throw new OrderError("already_paid", "an unpaid order", `payment ${order.payment.state}`);
  }
  const elapsed = now - order.createdAt;
  if (elapsed > EDIT_WINDOW_MS) {
    throw new OrderError("edit_expired", `an edit within ${EDIT_WINDOW_MS} ms of ordering`, `${elapsed} ms`);
  }
  return checkedTotal({ ...order, lines: priceLines(config, lines) });
}

/** Staff add lines to an open order. Payment is left as it is; the extra shows in `outstandingMinor`. */
export function addLines(config: Config, order: Order, lines: readonly LineRequest[]): Order {
  if (order.status === "completed")
    throw new OrderError("bad_transition", "a pending or preparing order", order.status);
  return checkedTotal({ ...order, lines: [...order.lines, ...priceLines(config, lines)] });
}

/**
 * What the customer still owes, in minor units: the total minus the amount staff confirmed. A claim counts for nothing.
 * The only correct answer to "is this order paid?" is `outstandingMinor(order) <= 0`.
 */
export function outstandingMinor(order: Order): number {
  const confirmed = order.payment.state === "confirmed" ? order.payment.amountMinor : 0;
  return orderTotal(order) - confirmed;
}

/**
 * A station marks some of its own lines ready. Lines already ready or served, and every line of a completed order,
 * are left as they are, so a station screen that is a moment behind can't fail on them; the same order comes back
 * when nothing changed.
 */
export function markReady(order: Order, stationId: string, lineIndexes: readonly number[]): Order {
  return setReady(order, stationId, lineIndexes, true);
}

/**
 * A station takes back lines it marked ready by mistake, so the customer is no longer told to collect. Served lines
 * and completed orders are left as they are; the same order comes back when nothing changed.
 */
export function unmarkReady(order: Order, stationId: string, lineIndexes: readonly number[]): Order {
  return setReady(order, stationId, lineIndexes, false);
}

function setReady(order: Order, stationId: string, lineIndexes: readonly number[], ready: boolean): Order {
  const marks = new Set<number>();
  for (const i of lineIndexes) {
    const line = Number.isInteger(i) ? order.lines[i] : undefined;
    if (line === undefined) {
      throw new OrderError("no_such_line", `a line index below ${order.lines.length}`, String(i));
    }
    if (line.stationId !== stationId) {
      throw new OrderError("wrong_station", `a line of station ${stationId}`, `line ${i} of station ${line.stationId}`);
    }
    if (line.ready !== ready && !line.served && order.status !== "completed") marks.add(i);
  }
  if (marks.size === 0) return order;
  return { ...order, lines: order.lines.map((l, i) => (marks.has(i) ? { ...l, ready } : l)) };
}

/** Every line is ready or already served: the customer can collect. */
export function isReady(order: Order): boolean {
  return order.lines.every((l) => l.ready || l.served);
}

/**
 * A staff member confirms an extra amount on a paid order whose added lines left something owed. More than is owed is
 * refused: a top-up records money for the order, not change handed back.
 */
export function topUp(
  order: Order,
  input: { by: string; method: PaymentMethod; amountMinor: number; now: number },
): Order {
  const due = outstandingMinor(order);
  if (input.amountMinor > due) {
    throw new OrderError("overpay", `a top-up up to the ${due} minor units still owed`, String(input.amountMinor));
  }
  return { ...order, payment: topUpPayment(order.payment, input) };
}

/** Staff hand over one line. */
export function markServed(order: Order, lineIndex: number): Order {
  const line = order.lines[lineIndex];
  if (line === undefined) {
    throw new OrderError("no_such_line", `a line index below ${order.lines.length}`, String(lineIndex));
  }
  if (line.served) throw new OrderError("already_served", "an unserved line", `line ${lineIndex} served`);
  return { ...order, lines: order.lines.map((l, i) => (i === lineIndex ? { ...l, served: true } : l)) };
}
