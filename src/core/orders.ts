/** Order model, status machine and edit windows. Pure: time is passed in, orders are never mutated. */

import { type Config, type ExtraGroup, extraGroupsFor, isRoom, stationFor } from "./config.ts";
import { type Payment, type PaymentMethod, topUpPayment, UNPAID } from "./payments.ts";

export type OrderStatus = "pending" | "preparing" | "completed";

export const UNDO_WINDOW_MS = 5 * 60_000;
export const EDIT_WINDOW_MS = 2 * 60_000;

/** The longest note a line may carry ("less spicy, no onion"). */
export const NOTE_MAX = 80;

export interface LineRequest {
  itemId: string;
  size?: string;
  qty: number;
  /** Ids of the extras options picked (unique across the catalog), in any order. */
  extras?: string[];
  /** Free text for the kitchen; trimmed, at most `NOTE_MAX` characters. */
  note?: string;
}

/** An extras option as it was when the line was added: its name and price are fixed then, like the unit price. */
export interface LineExtra {
  id: string;
  name: string;
  priceMinor: number;
}

export interface OrderLine {
  itemId: string;
  name: string;
  size?: string;
  qty: number;
  /** Price of one unit in integer minor units, extras included, fixed when the line was added. */
  unitMinor: number;
  extras?: LineExtra[];
  note?: string;
  stationId: string;
  served: boolean;
  /** The station has it ready to hand over; serving it is still the counter's step. */
  ready: boolean;
  /** When the station marked it ready, and when it was handed over: their gap is the wait a ready dish spends cooling. */
  readyAt?: number;
  servedAt?: number;
}

export interface RoomBill {
  room: string;
  settlement?: number;
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
  /** Where the customer sits, as staff read it ("Garden T4"): the label of a spot in `spots.json`, fixed at ordering. */
  spot?: string;
  /**
   * On the room bill (D-082): the room's spot id, and once staff settled the room at checkout, that settlement's id. The
   * payment stays unpaid until then, so none of it is received.
   */
  roomBill?: RoomBill;
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
  | "bad_extras"
  | "bad_note"
  | "bad_spot"
  | "bad_room"
  | "room_bill"
  | "nothing_to_settle"
  | "room_changed"
  | "not_on_room_bill"
  | "sold_out"
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
    const extras = pickExtras(extraGroupsFor(config, item.id), req.extras ?? [], item.id);
    const note = cleanNote(req.note, item.id);
    return {
      itemId: item.id,
      name: item.name,
      ...(size === undefined ? {} : { size }),
      qty: req.qty,
      unitMinor: unitMinor + extras.reduce((sum, e) => sum + e.priceMinor, 0),
      ...(extras.length === 0 ? {} : { extras }),
      ...(note === undefined ? {} : { note }),
      stationId,
      served: false,
      ready: false,
    };
  });
}

/**
 * The options picked, in the catalog's order (so the same choice is always the same list), each checked against the groups
 * the item offers and each group's min and max.
 */
function pickExtras(groups: readonly ExtraGroup[], ids: readonly string[], itemId: string): LineExtra[] {
  if (ids.length === 0 && groups.every((g) => g.min === 0)) return [];
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) throw new OrderError("bad_extras", `each extra once for ${itemId}`, ids.join(", "));
  const out: LineExtra[] = [];
  for (const g of groups) {
    const picked = g.options.filter((o) => wanted.has(o.id));
    for (const o of picked) wanted.delete(o.id);
    if (picked.length < g.min || picked.length > g.max) {
      const range = g.min === g.max ? `${g.min}` : `${g.min} to ${g.max}`;
      throw new OrderError("bad_extras", `${range} of ${g.name} for ${itemId}`, `${picked.length}`);
    }
    for (const o of picked) out.push({ id: o.id, name: o.name, priceMinor: o.price });
  }
  if (wanted.size > 0) {
    throw new OrderError("bad_extras", `only options ${itemId} offers`, JSON.stringify([...wanted].join(", ")));
  }
  return out;
}

function cleanNote(raw: string | undefined, itemId: string): string | undefined {
  if (raw === undefined) return undefined;
  const note = raw.replace(/\s+/g, " ").trim();
  if (note === "") return undefined;
  if (note.length > NOTE_MAX) {
    throw new OrderError("bad_note", `a note up to ${NOTE_MAX} characters for ${itemId}`, `${note.length} characters`);
  }
  return note;
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
  input: {
    id: string;
    token: string;
    now: number;
    lines: readonly LineRequest[];
    customerName?: string;
    spotId?: string;
    /** `room`: the guest puts it on their room bill; only from a room's spot. */
    pay?: "room";
  },
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
  if (input.spotId !== undefined) {
    const spot = config.spots.get(input.spotId);
    if (spot === undefined) {
      const known = [...config.spots.keys()].slice(0, 5).join(", ") || "none set up";
      throw new OrderError("bad_spot", `a spot id from spots.json (${known})`, JSON.stringify(input.spotId));
    }
    order.spot = spot.label;
  }
  if (input.pay === "room") {
    if (input.spotId === undefined || !isRoom(config, input.spotId)) {
      throw new OrderError("bad_room", "a room's spot id for the room bill", JSON.stringify(input.spotId ?? null));
    }
    order.roomBill = { room: input.spotId };
  }
  return checkedTotal(order);
}

/** Whether the order waits on its room's checkout: on a room bill, not yet settled, not paid some other way (D-082). */
export function onOpenRoomBill(order: Pick<Order, "roomBill" | "payment">): boolean {
  return order.roomBill !== undefined && order.roomBill.settlement === undefined && order.payment.state !== "confirmed";
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
export function markReady(order: Order, stationId: string, lineIndexes: readonly number[], now?: number): Order {
  return setReady(order, stationId, lineIndexes, true, now);
}

/**
 * A station takes back lines it marked ready by mistake, so the customer is no longer told to collect. Served lines
 * and completed orders are left as they are; the same order comes back when nothing changed.
 */
export function unmarkReady(order: Order, stationId: string, lineIndexes: readonly number[], now?: number): Order {
  return setReady(order, stationId, lineIndexes, false, now);
}

function setReady(
  order: Order,
  stationId: string,
  lineIndexes: readonly number[],
  ready: boolean,
  now: number | undefined,
): Order {
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
  return {
    ...order,
    lines: order.lines.map((l, i) => {
      if (!marks.has(i)) return l;
      const { readyAt: _gone, ...rest } = l;
      return { ...rest, ready, ...(ready && now !== undefined ? { readyAt: now } : {}) };
    }),
  };
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
export function markServed(order: Order, lineIndex: number, now?: number): Order {
  const line = order.lines[lineIndex];
  if (line === undefined) {
    throw new OrderError("no_such_line", `a line index below ${order.lines.length}`, String(lineIndex));
  }
  if (line.served) throw new OrderError("already_served", "an unserved line", `line ${lineIndex} served`);
  return {
    ...order,
    lines: order.lines.map((l, i) =>
      i === lineIndex ? { ...l, served: true, ...(now === undefined ? {} : { servedAt: now }) } : l,
    ),
  };
}
