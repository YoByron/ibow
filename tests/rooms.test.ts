import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, parseSpots } from "../src/core/config.ts";
import { createOrder, type Order, OrderError, orderTotal, outstandingMinor } from "../src/core/orders.ts";
import { confirmPayment, keptMinor } from "../src/core/payments.ts";
import { isRoom, leaveRoomBill, onOpenRoomBill, openRoomOrders, roomBills, settleRoom } from "../src/core/rooms.ts";
import { sampleRaw } from "./support/samples.ts";

const raw = sampleRaw("garden-cafe");
const config = loadConfig({
  ...raw,
  spots: [...(raw.spots as unknown[]), { id: "suite", name: "Suite", kind: "room", count: 3 }],
});
const t0 = Date.UTC(2026, 11, 1, 10, 0);
let n = 0;
const order = (spotId: string, pay?: "room"): Order =>
  createOrder(config, {
    id: `o${++n}`,
    token: `01-${String(n).padStart(3, "0")}`,
    now: t0 + n * 60_000,
    lines: [{ itemId: "espresso", qty: 2 }],
    spotId,
    ...(pay ? { pay } : {}),
  });

describe("room zones (spots.json kind room)", () => {
  test("a zone may be kind room; its spots are rooms, a table zone's are not", () => {
    const zones = parseSpots([
      { id: "rooms", name: "Room", kind: "room", count: 2 },
      { id: "garden", name: "Garden", count: 1 },
    ]);
    expect(zones[0]).toMatchObject({ kind: "room", spots: [{ id: "rooms-1", label: "Room 1" }, { id: "rooms-2" }] });
    expect(zones[1]?.kind).toBeUndefined();
    expect(isRoom(config, "suite-2")).toBe(true);
    expect(isRoom(config, "garden-t1")).toBe(false);
    expect(isRoom(config, "nowhere")).toBe(false);
  });

  test("an unknown kind is refused with the field", () => {
    expect(() => parseSpots([{ id: "x", name: "X", kind: "cabin", count: 1 }])).toThrow(ConfigError);
    expect(() => parseSpots([{ id: "x", name: "X", kind: "cabin", count: 1 }])).toThrow(/\[0\]\.kind/);
  });
});

describe("the room bill", () => {
  test("an order put on the room bill stays unpaid and is never received", () => {
    const o = order("suite-1", "room");
    expect(o.roomBill).toEqual({ room: "suite-1" });
    expect(o.payment.state).toBe("unpaid");
    expect(keptMinor(o.payment)).toBe(0);
    expect(outstandingMinor(o)).toBe(orderTotal(o));
    expect(onOpenRoomBill(o)).toBe(true);
  });

  test("only a room's spot can take the room bill", () => {
    expect(() => order("garden-t1", "room")).toThrow(OrderError);
    expect(() => order("garden-t1", "room")).toThrow(/bad_room/);
    expect(() =>
      createOrder(config, { id: "x", token: "01-999", now: t0, lines: [{ itemId: "espresso", qty: 1 }], pay: "room" }),
    ).toThrow(/bad_room/);
  });

  test("a room spot without the room bill is an ordinary order (a cafe guest who isn't staying)", () => {
    const o = order("suite-1");
    expect(o.roomBill).toBeUndefined();
    expect(onOpenRoomBill(o)).toBe(false);
  });

  test("settling covers exactly the room's open orders, in one payment split per order", () => {
    const a = order("suite-1", "room");
    const b = order("suite-1", "room");
    const other = order("suite-2", "room");
    const plain = order("suite-1");
    const total = orderTotal(a) + orderTotal(b);
    expect(openRoomOrders([a, b, other, plain], "suite-1").map((o) => o.id)).toEqual([a.id, b.id]);
    const at = t0 + 3 * 3_600_000;
    const settled = settleRoom([a, b, other, plain], {
      room: "suite-1",
      settlement: 7,
      by: "counter",
      method: "card",
      amountMinor: total,
      now: at,
    });
    expect(settled.map((o) => o.id)).toEqual([a.id, b.id]);
    for (const o of settled) {
      expect(o.payment).toEqual({ state: "confirmed", method: "card", amountMinor: orderTotal(o), at, by: "counter" });
      expect(o.roomBill).toEqual({ room: "suite-1", settlement: 7 });
      expect(onOpenRoomBill(o)).toBe(false);
      expect(outstandingMinor(o)).toBe(0);
    }
    expect(settled.reduce((s, o) => s + keptMinor(o.payment), 0)).toBe(total);
    // Nothing is left open on that room; the other room is untouched.
    expect(openRoomOrders([...settled, other, plain], "suite-1")).toEqual([]);
    expect(openRoomOrders([...settled, other, plain], "suite-2")).toEqual([other]);
  });

  test("settling refuses an amount other than what is open (an order arrived after staff read the total)", () => {
    const a = order("suite-3", "room");
    const err = (() => {
      try {
        settleRoom([a], { room: "suite-3", settlement: 1, by: "c", method: "cash", amountMinor: 1, now: t0 });
      } catch (e) {
        return e as OrderError;
      }
    })();
    expect(err?.code).toBe("room_changed");
    expect(err?.message).toContain(String(orderTotal(a)));
  });

  test("settling a room with nothing open, or without a person, is refused", () => {
    expect(() =>
      settleRoom([], { room: "suite-1", settlement: 1, by: "c", method: "cash", amountMinor: 0, now: t0 }),
    ).toThrow(/nothing_to_settle/);
    const a = order("suite-1", "room");
    expect(() =>
      settleRoom([a], { room: "suite-1", settlement: 1, by: " ", method: "cash", amountMinor: orderTotal(a), now: t0 }),
    ).toThrow(/no_staff/);
  });

  test("lines added before checkout are on the bill; an order paid some other way is not", () => {
    const a = order("suite-2", "room");
    const paidElsewhere = {
      ...order("suite-2", "room"),
    };
    const confirmed = {
      ...paidElsewhere,
      payment: confirmPayment(paidElsewhere.payment, {
        by: "x",
        method: "cash",
        amountMinor: orderTotal(paidElsewhere),
        now: t0,
      }),
    };
    expect(openRoomOrders([a, confirmed], "suite-2")).toEqual([a]);
  });

  test("the rooms list: each room with open orders, its label, orders and total, rooms in config order", () => {
    const a = order("suite-2", "room");
    const b = order("suite-1", "room");
    const c = order("suite-2", "room");
    const bills = roomBills(config, [a, b, c, order("suite-3")]);
    expect(bills.map((r) => [r.room, r.label, r.orders.length, r.totalMinor])).toEqual([
      ["suite-1", "Suite 1", 1, orderTotal(b)],
      ["suite-2", "Suite 2", 2, orderTotal(a) + orderTotal(c)],
    ]);
    expect(bills[1]?.orders.map((o) => o.token)).toEqual([a.token, c.token]);
  });
});

describe("leaving a room bill", () => {
  test("an open room-bill order becomes an ordinary unpaid order; a settled or plain one can't move", () => {
    const a = order("suite-1", "room");
    const moved = leaveRoomBill(a);
    expect(moved.roomBill).toBeUndefined();
    expect(moved.payment.state).toBe("unpaid");
    expect(onOpenRoomBill(moved)).toBe(false);
    expect(() => leaveRoomBill(moved)).toThrow(/not_on_room_bill/);
    const b = order("suite-2", "room");
    const [settled] = settleRoom([b], {
      room: "suite-2",
      settlement: 1,
      by: "c",
      method: "cash",
      amountMinor: orderTotal(b),
      now: t0,
    });
    expect(() => leaveRoomBill(settled as Order)).toThrow(/not_on_room_bill/);
  });
});
