/** What each audience may see of an order. A station sees only its own lines; a customer sees no staff details. */

import { messagesUntil, type OrderMessage } from "./messages.ts";
import {
  EDIT_WINDOW_MS,
  isReady,
  isServed,
  type LineExtra,
  type Order,
  type OrderLine,
  type OrderStatus,
  orderTotal,
  outstandingMinor,
} from "./orders.ts";
import type { PaymentMethod } from "./payments.ts";

export type Audience =
  | { kind: "customer"; orderId: string }
  | { kind: "counter" }
  | { kind: "owner" }
  | { kind: "station"; stationId: string };

export interface StaffOrderView extends Order {
  totalMinor: number;
  outstandingMinor: number;
}

export interface CustomerOrderView {
  id: string;
  token: string;
  createdAt: number;
  currency: string;
  customerName?: string;
  spot?: string;
  /** On the room bill: `open` until the room is settled at checkout, then `settled` (D-082). */
  roomBill?: "open" | "settled";
  /** Taken under counter-first (D-101): the kitchen starts once the counter has confirmed the payment. */
  paysFirst?: true;
  status: OrderStatus;
  lines: {
    itemId: string;
    name: string;
    size?: string;
    extras?: LineExtra[];
    note?: string;
    qty: number;
    unitMinor: number;
    served: boolean;
    ready: boolean;
  }[];
  /** Every line is ready or served: the customer can come and collect, even before staff complete the order. */
  ready: boolean;
  /** Every line handed over: brought to the table or room, or collected (D-097). */
  served: boolean;
  totalMinor: number;
  outstandingMinor: number;
  payment: { state: "unpaid" } | { state: "claimed" | "confirmed"; method: PaymentMethod; amountMinor: number };
  /** Until when the customer may still change the order, if the rules allow it now. */
  editableUntil?: number;
  /** The thread with the runner (D-104), without who on the staff sent or received what. */
  messages?: Pick<OrderMessage, "at" | "from" | "text" | "chip">[];
  /** Once completed: until when the guest may still send a message. */
  messagesUntil?: number;
}

/** A station line keeps its index in the whole order, which is what "mark served" takes. */
export interface StationLine extends OrderLine {
  index: number;
}

export interface StationOrderView {
  id: string;
  token: string;
  createdAt: number;
  customerName?: string;
  spot?: string;
  status: OrderStatus;
  /** Only this station's lines; empty when an edit took its last line away. */
  lines: StationLine[];
}

export function staffView(order: Order): StaffOrderView {
  return { ...order, totalMinor: orderTotal(order), outstandingMinor: outstandingMinor(order) };
}

export function customerView(order: Order): CustomerOrderView {
  const p = order.payment;
  const view: CustomerOrderView = {
    id: order.id,
    token: order.token,
    createdAt: order.createdAt,
    currency: order.currency,
    status: order.status,
    lines: order.lines.map((l) => ({
      itemId: l.itemId,
      name: l.name,
      ...(l.size === undefined ? {} : { size: l.size }),
      ...(l.extras === undefined ? {} : { extras: l.extras }),
      ...(l.note === undefined ? {} : { note: l.note }),
      qty: l.qty,
      unitMinor: l.unitMinor,
      served: l.served,
      ready: l.ready,
    })),
    ready: isReady(order),
    served: isServed(order),
    totalMinor: orderTotal(order),
    outstandingMinor: outstandingMinor(order),
    payment:
      p.state === "unpaid" ? { state: "unpaid" } : { state: p.state, method: p.method, amountMinor: p.amountMinor },
  };
  if (order.customerName !== undefined) view.customerName = order.customerName;
  if (order.spot !== undefined) view.spot = order.spot;
  if (order.paysFirst === true) view.paysFirst = true;
  if (order.roomBill !== undefined) view.roomBill = order.roomBill.settlement === undefined ? "open" : "settled";
  if (order.status === "pending" && p.state === "unpaid") view.editableUntil = order.createdAt + EDIT_WINDOW_MS;
  if (order.messages !== undefined && order.messages.length > 0) {
    view.messages = order.messages.map((m) => ({
      at: m.at,
      from: m.from,
      ...(m.text === undefined ? {} : { text: m.text }),
      ...(m.chip === undefined ? {} : { chip: m.chip }),
    }));
  }
  const until = messagesUntil(order);
  if (until !== undefined) view.messagesUntil = until;
  return view;
}

export function stationView(order: Order, stationId: string): StationOrderView {
  const view: StationOrderView = {
    id: order.id,
    token: order.token,
    createdAt: order.createdAt,
    status: order.status,
    lines: order.lines.flatMap((l, index) => (l.stationId === stationId ? [{ ...l, index }] : [])),
  };
  if (order.customerName !== undefined) view.customerName = order.customerName;
  if (order.spot !== undefined) view.spot = order.spot;
  return view;
}

export function viewFor(audience: Audience, order: Order): StaffOrderView | CustomerOrderView | StationOrderView {
  switch (audience.kind) {
    case "customer":
      return customerView(order);
    case "station":
      return stationView(order, audience.stationId);
    default:
      return staffView(order);
  }
}
