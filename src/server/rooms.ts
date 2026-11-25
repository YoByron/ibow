/**
 * Rooms over HTTP (D-082, D-083): `GET /api/rooms` lists each room with open room-bill orders and the latest settlements,
 * and `POST /api/rooms/:room/settle` takes one payment at checkout covering exactly those orders. The rules are
 * `src/core/rooms.ts`; who may is the counter's own power (`orders.run`, which station-only staff are refused).
 */

import type { EventEmitter } from "node:events";
import type { Context, Hono } from "hono";
import { type Config, isRoom } from "../core/config.ts";
import type { Power } from "../core/levels.ts";
import { OrderError } from "../core/orders.ts";
import type { PaymentMethod } from "../core/payments.ts";
import { leaveRoomBill, roomBills, settleRoom } from "../core/rooms.ts";
import { staffView } from "../core/views.ts";
import type { Session, Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";
import { roomKeys } from "./room-keys.ts";

/** How many settlements the Rooms screen shows: the day's checkouts, with room to spare. */
const SETTLEMENTS_SHOWN = 20;

export interface RoomsDeps {
  config: Config;
  store: Store;
  now: () => number;
  requirePower: (c: Context<Env>, power: Power) => Session;
  events: EventEmitter;
  checkMethod: (method: PaymentMethod) => void;
}

export function registerRooms(http: Hono<Env>, deps: RoomsDeps): void {
  const { config, store, now, requirePower } = deps;

  // The keyed address of each room's QR, for the owner's Spots page and its print (D-082).
  http.get("/api/rooms/keys", (c) => {
    requirePower(c, "look.edit");
    const keys = roomKeys(store);
    const rooms = config.zones.filter((z) => z.kind === "room").flatMap((z) => z.spots.map((s) => s.id));
    return c.json({ keys: Object.fromEntries(rooms.map((r) => [r, keys.keyFor(r)])) });
  });

  // "New QR": the room's old key stops working at once (a guest who checked out kept a photo of the QR). One row written.
  http.post("/api/rooms/:room/new-key", (c) => {
    requirePower(c, "look.edit");
    const room = c.req.param("room");
    if (!isRoom(config, room)) {
      throw new OrderError("bad_room", "a room's spot id from spots.json", JSON.stringify(room));
    }
    return c.json({ key: roomKeys(store).rotate(room) });
  });

  http.get("/api/rooms", (c) => {
    requirePower(c, "orders.run");
    return c.json({
      rooms: roomBills(config, store.openRoomOrders()),
      settlements: store.roomSettlements(SETTLEMENTS_SHOWN),
      moves: store
        .roomBillMoves(SETTLEMENTS_SHOWN)
        .map((m) => ({ ...m, label: config.spots.get(m.room)?.label ?? m.room })),
    });
  });

  http.post("/api/rooms/:room/settle", async (c) => {
    const session = requirePower(c, "orders.run");
    const room = c.req.param("room");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const b = input.object(raw);
    const method = input.method(b.method, "method");
    deps.checkMethod(method);
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    if (!isRoom(config, room)) {
      throw new OrderError("bad_room", "a room's spot id from spots.json", JSON.stringify(room));
    }
    const label = config.spots.get(room)?.label ?? room;
    const at = now();
    // Read and written with no await between, so no order can slip in between the check and the payment.
    const open = store.openRoomOrders();
    const { settlement, events } = store.settleRoom(
      { room, label, at, by: session.user, level: session.role, method, amountMinor },
      (id) => settleRoom(open, { room, settlement: id, by: session.user, method, amountMinor, now: at }),
    );
    for (const e of events) deps.events.emit("event", e);
    return c.json({ settlement });
  });

  /** A wrong order leaves the room bill (D-082): audited, and from then on paid like any other order. */
  http.post("/api/orders/:id/off-room", async (c) => {
    const session = requirePower(c, "orders.run");
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      // no body: no reason given
    }
    const b = input.object(raw);
    const reason = b.reason === undefined || b.reason === "" ? undefined : input.text(b.reason, "reason", 120);
    const found = store.getOrder(c.req.param("id"));
    if (found === undefined)
      throw new ApiError(404, "no_such_order", `expected a known order id, found ${c.req.param("id")}`);
    const room = found.order.roomBill?.room ?? "";
    const moved = leaveRoomBill(found.order);
    const { move, event } = store.moveOffRoomBill(moved, {
      orderId: moved.id,
      room,
      at: now(),
      by: session.user,
      level: session.role,
      ...(reason === undefined ? {} : { reason }),
    });
    deps.events.emit("event", event);
    return c.json({ order: staffView(moved), move });
  });
}
