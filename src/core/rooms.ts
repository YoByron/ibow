/**
 * The room bill (D-082). A guest ordering from a room may put the order on the room bill: it stays unpaid, so nothing of
 * it is received, until staff settle the room at checkout. A settlement is one payment, taken by a named person, that
 * covers exactly the room's open orders, all or nothing. Pure: time and the settlement's id are passed in.
 */

import type { Config } from "./config.ts";
import { type Order, OrderError, onOpenRoomBill, orderTotal, outstandingMinor } from "./orders.ts";
import { confirmPayment, PaymentError, type PaymentMethod } from "./payments.ts";

export { isRoom } from "./config.ts";
export { onOpenRoomBill } from "./orders.ts";

/** The open room-bill orders of one room (or of every room), oldest first as given. */
export function openRoomOrders(orders: readonly Order[], room?: string): Order[] {
  return orders.filter((o) => onOpenRoomBill(o) && (room === undefined || o.roomBill?.room === room));
}

export interface RoomBillSummary {
  room: string;
  label: string;
  orders: { id: string; token: string; createdAt: number; customerName?: string; totalMinor: number }[];
  totalMinor: number;
}

/** Each room with open room-bill orders, in the order `spots.json` lists the rooms; rooms with none are left out. */
export function roomBills(config: Pick<Config, "zones">, orders: readonly Order[]): RoomBillSummary[] {
  const open = openRoomOrders(orders);
  const out: RoomBillSummary[] = [];
  for (const z of config.zones) {
    if (z.kind !== "room") continue;
    for (const s of z.spots) {
      const mine = open.filter((o) => o.roomBill?.room === s.id);
      if (mine.length === 0) continue;
      out.push({
        room: s.id,
        label: s.label,
        orders: mine.map((o) => ({
          id: o.id,
          token: o.token,
          createdAt: o.createdAt,
          ...(o.customerName === undefined ? {} : { customerName: o.customerName }),
          totalMinor: outstandingMinor(o),
        })),
        totalMinor: mine.reduce((n, o) => n + outstandingMinor(o), 0),
      });
    }
  }
  return out;
}

/** Who took how much, how, when, for which room and which orders: kept for every settlement, like a refund. */
export interface RoomSettlement {
  id: number;
  room: string;
  label: string;
  at: number;
  by: string;
  level: string;
  method: PaymentMethod;
  amountMinor: number;
  orderIds: string[];
}

/**
 * Settles a room at checkout: every open room-bill order of `room` is confirmed as paid by `method`, for its own total,
 * by `by` at `now`, and marked with the settlement. `amountMinor` is the total staff were shown; if the room's open
 * total is anything else (an order came in meanwhile) nothing is settled, so the guest pays exactly what they saw.
 * Returns only the orders it changed.
 */
export function settleRoom(
  orders: readonly Order[],
  s: { room: string; settlement: number; by: string; method: PaymentMethod; amountMinor: number; now: number },
): Order[] {
  if (s.by.trim() === "") throw new PaymentError("no_staff", "settleRoom: expected a staff id, found an empty one");
  const open = openRoomOrders(orders, s.room);
  if (open.length === 0) {
    throw new OrderError("nothing_to_settle", `open room-bill orders on ${s.room}`, "none");
  }
  const total = open.reduce((n, o) => n + outstandingMinor(o), 0);
  if (total !== s.amountMinor) {
    throw new OrderError(
      "room_changed",
      `the room's open total ${total} minor units over ${open.length} orders`,
      `${s.amountMinor}; read the room again`,
    );
  }
  return open.map((o) => {
    const roomBill = { room: s.room, settlement: s.settlement };
    // A free order has nothing to take; it still leaves the bill with the rest.
    if (orderTotal(o) === 0) return { ...o, roomBill };
    const payment = confirmPayment(o.payment, {
      by: s.by,
      method: s.method,
      amountMinor: orderTotal(o),
      now: s.now,
    });
    return { ...o, roomBill, payment };
  });
}

/** Who took which order off which room's bill, when and why: kept for every move, like a settlement. */
export interface RoomBillMove {
  id: number;
  orderId: string;
  room: string;
  at: number;
  by: string;
  level: string;
  reason?: string;
}

/**
 * Takes an order off its room bill (it was put on the wrong room, or the guest pays now after all): it becomes an ordinary
 * unpaid order, paid at the counter like any other. Only an order still open on a room bill can move.
 */
export function leaveRoomBill(order: Order): Order {
  if (!onOpenRoomBill(order)) {
    throw new OrderError(
      "not_on_room_bill",
      "an order open on a room bill",
      order.roomBill === undefined ? "an order not on any room bill" : "one already settled or paid",
    );
  }
  const { roomBill: _gone, ...rest } = order;
  return rest;
}

/** The counter's own payment paths refuse an order on an open room bill: it is settled with its room, in Rooms. */
export function assertNotOnRoomBill(order: Order, what: string): void {
  if (!onOpenRoomBill(order)) return;
  throw new OrderError(
    "room_bill",
    `${what} on an order that is not on a room bill`,
    `it is on the room bill of ${order.spot ?? order.roomBill?.room}; settle it with the room in Rooms`,
  );
}
