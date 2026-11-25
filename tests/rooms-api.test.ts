import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { roomKeys } from "../src/server/room-keys.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { sampleRaw } from "./support/samples.ts";

const raw = sampleRaw("garden-cafe");
const withRooms = loadConfig(raw);
/** The same cafe without its rooms: a business that lets none. */
const noRooms = loadConfig({ ...raw, spots: (raw.spots as { kind?: string }[]).filter((z) => z.kind !== "room") });
const t0 = Date.UTC(2026, 11, 1, 11, 0); // 11:00 in Lisbon, open
const PIN = "908172";
const STAFF_PIN = "246810";
let hash = "";
let staffHash = "";
let now = t0;
let store: Store;
let http: ReturnType<typeof createApp>["http"];

beforeAll(async () => {
  [hash, staffHash] = await Promise.all([hashPin(PIN, TEST_PIN_COST), hashPin(STAFF_PIN, TEST_PIN_COST)]);
});
afterEach(() => store.close());

function boot(config = withRooms): void {
  now = t0;
  store = openStore(":memory:");
  store.putStaff({ id: "desk", name: "Desk", pinHash: staffHash, role: "counter" });
  store.putStaff({ id: "grill", name: "Grill", pinHash: staffHash, role: "station" });
  http = createApp({ config, store, ownerPinHash: hash, now: () => now }).http;
}

async function call(method: string, path: string, body?: unknown, cookie?: string, key?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (key) headers["x-order-key"] = key;
  const res = await http.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = (await res.json()) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

let n = 0;
/** A guest's order; on the room bill it carries the key from that room's QR unless `roomKey` says otherwise. */
const place = (spot: string | undefined, pay?: string, roomKey: string | null = roomKeys(store).keyFor(spot ?? "")) =>
  call("POST", "/api/orders", {
    clientKey: `room-client-key-${++n}-abcdef`,
    lines: [{ itemId: "espresso", qty: 2 }],
    ...(spot === undefined ? {} : { spot }),
    ...(pay === undefined ? {} : { pay }),
    ...(pay === "room" && roomKey !== null ? { roomKey } : {}),
  });
const login = async (user: string, pin = STAFF_PIN) =>
  (await call("POST", "/api/login", { user, pin })).cookie as string;
const received = async (owner: string) => (await call("GET", "/api/owner/insights", undefined, owner)).body;

describe("room bill over HTTP (D-082)", () => {
  test("the catalog says which zone is rooms; a guest in a room orders onto the room bill", async () => {
    boot();
    const cat = await call("GET", "/api/catalog");
    expect(cat.body.zones.find((z: { id: string }) => z.id === "rooms").kind).toBe("room");
    const r = await place("rooms-3", "room");
    expect(r.status).toBe(201);
    expect(r.body.order.roomBill).toBe("open");
    expect(r.body.order.payment).toEqual({ state: "unpaid" });
    expect(r.body.order.spot).toBe("Room 3");
  });

  test("the room bill is refused from a table, or without a spot, or with no room zone at all", async () => {
    boot();
    expect((await place("garden-t1", "room")).body.error).toBe("bad_room");
    expect((await place(undefined, "room")).status).toBe(400);
    expect((await place("rooms-1", "card")).body.error).toBe("bad_input");
    store.close();
    boot(noRooms);
    expect((await place("garden-t1", "room")).status).toBe(400);
  });

  test("the counter can't take a room-bill order's money, nor the guest claim it; it waits for checkout", async () => {
    boot();
    const r = await place("rooms-2", "room");
    const desk = await login("desk");
    const c = await call("POST", `/api/orders/${r.body.order.id}/confirm`, { method: "cash", amountMinor: 1 }, desk);
    expect([c.status, c.body.error]).toEqual([409, "room_bill"]);
    const cl = await call("POST", `/api/orders/${r.body.order.id}/claim`, { method: "upi" }, undefined, r.body.key);
    expect([cl.status, cl.body.error]).toEqual([409, "room_bill"]);
  });

  test("received moves only when staff settle; the settle covers exactly the open orders and is audited", async () => {
    boot();
    const owner = await login("owner", PIN);
    const a = await place("rooms-4", "room");
    now += 60_000;
    const b = await place("rooms-4", "room");
    const elsewhere = await place("rooms-5", "room");
    const cafe = await place("rooms-4"); // a café guest at the same spot, paying at the counter
    const each = a.body.order.totalMinor as number;

    const before = await received(owner);
    // Only the café guest awaits a confirm: the three room-bill orders are owed at checkout, under Open room bills.
    expect(before.report.totals).toMatchObject({
      orders: 4,
      orderedMinor: 4 * each,
      receivedMinor: 0,
      awaitingOrders: 1,
      awaitingMinor: each,
    });
    expect(before.rooms).toEqual({ open: 3, totalMinor: 3 * each });

    const desk = await login("desk");
    const list = await call("GET", "/api/rooms", undefined, desk);
    expect(list.status).toBe(200);
    expect(list.body.rooms.map((r: { room: string; totalMinor: number }) => [r.room, r.totalMinor])).toEqual([
      ["rooms-4", 2 * each],
      ["rooms-5", each],
    ]);

    // Staff read 2 × each; an order arriving in between makes that stale, and nothing is settled.
    now += 60_000;
    const late = await place("rooms-4", "room");
    const stale = await call("POST", "/api/rooms/rooms-4/settle", { method: "card", amountMinor: 2 * each }, desk);
    expect([stale.status, stale.body.error]).toEqual([409, "room_changed"]);
    expect((await received(owner)).report.totals.receivedMinor).toBe(0);

    now += 60_000;
    const ok = await call("POST", "/api/rooms/rooms-4/settle", { method: "card", amountMinor: 3 * each }, desk);
    expect(ok.status).toBe(200);
    expect(ok.body.settlement).toMatchObject({
      room: "rooms-4",
      label: "Room 4",
      by: "desk",
      level: "staff",
      method: "card",
      amountMinor: 3 * each,
      at: now,
    });
    expect(ok.body.settlement.orderIds.sort()).toEqual([a.body.order.id, b.body.order.id, late.body.order.id].sort());

    const after = await received(owner);
    expect(after.report.totals).toMatchObject({ orderedMinor: 5 * each, receivedMinor: 3 * each });
    expect(after.rooms).toEqual({ open: 1, totalMinor: each });
    // The café guest's order and the other room are untouched.
    const cafeNow = await call("GET", `/api/orders/${cafe.body.order.id}`, undefined, desk);
    expect(cafeNow.body.order.payment.state).toBe("unpaid");
    const guest = await call("GET", `/api/orders/${a.body.order.id}`, undefined, undefined, a.body.key);
    expect(guest.body.order.roomBill).toBe("settled");
    expect(guest.body.order.outstandingMinor).toBe(0);

    const again = await call("POST", "/api/rooms/rooms-4/settle", { method: "cash", amountMinor: 0 }, desk);
    expect([again.status, again.body.error]).toEqual([409, "nothing_to_settle"]);
    const audit = await call("GET", "/api/rooms", undefined, desk);
    expect(audit.body.settlements).toHaveLength(1);
    expect(audit.body.settlements[0]).toMatchObject({ by: "desk", method: "card", amountMinor: 3 * each });
    expect(elsewhere.body.order.roomBill).toBe("open");
  });

  test("who may settle: counter staff, a manager and the owner; never station staff or a guest", async () => {
    boot();
    await place("rooms-1", "room");
    expect((await call("GET", "/api/rooms")).status).toBe(401);
    expect((await call("POST", "/api/rooms/rooms-1/settle", { method: "cash", amountMinor: 1 })).status).toBe(401);
    const grill = await login("grill");
    expect((await call("GET", "/api/rooms", undefined, grill)).status).toBe(403);
    expect(
      (await call("POST", "/api/rooms/nowhere/settle", { method: "cash", amountMinor: 1 }, await login("desk"))).body
        .error,
    ).toBe("bad_room");
  });

  test("without a room zone the owner's figures carry no rooms and the Rooms route says so", async () => {
    boot(noRooms);
    const owner = await login("owner", PIN);
    expect((await received(owner)).rooms).toBeUndefined();
    expect((await call("GET", "/api/rooms", undefined, owner)).body).toEqual({ rooms: [], settlements: [], moves: [] });
  });
});

describe("only the QR in a room can charge it (D-082)", () => {
  test("without the room's key, or with a wrong or another room's key, the room bill is refused with a 403", async () => {
    boot();
    // A key of the right length in characters but not in bytes ("é" is two) must be a 403, not a 500.
    for (const key of [null, "x".repeat(22), roomKeys(store).keyFor("rooms-4"), "short", "é".repeat(22)]) {
      const r = await place("rooms-3", "room", key);
      expect([r.status, r.body.error]).toEqual([403, "room_key"]);
      expect(r.body.message).toContain("Room 3");
    }
    expect(store.openRoomOrders()).toEqual([]);
    // The same guest can still order and pay the usual way.
    const plain = await place("rooms-3");
    expect([plain.status, plain.body.order.roomBill]).toEqual([201, undefined]);
    expect((await place("rooms-3", "room")).status).toBe(201);
  });

  test("the key is the same on every read, differs per room and per install, and the owner reads it for the QR", async () => {
    boot();
    const owner = await login("owner", PIN);
    const keys = (await call("GET", "/api/rooms/keys", undefined, owner)).body.keys;
    expect(Object.keys(keys)).toEqual(["rooms-1", "rooms-2", "rooms-3", "rooms-4", "rooms-5", "rooms-6"]);
    expect(new Set(Object.values(keys)).size).toBe(6);
    expect(keys["rooms-2"]).toBe(roomKeys(store).keyFor("rooms-2"));
    expect(keys["rooms-2"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await call("GET", "/api/rooms/keys", undefined, await login("desk"))).status).toBe(403);
    const first = keys["rooms-2"];
    store.close();
    boot();
    expect(roomKeys(store).keyFor("rooms-2")).not.toBe(first);
  });

  test("the owner's New QR for one room stops its old key at once; other rooms keep theirs", async () => {
    boot();
    const owner = await login("owner", PIN);
    const before = (await call("GET", "/api/rooms/keys", undefined, owner)).body.keys;
    const r = await call("POST", "/api/rooms/rooms-2/new-key", {}, owner);
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.body.key).not.toBe(before["rooms-2"]);
    const after = (await call("GET", "/api/rooms/keys", undefined, owner)).body.keys;
    expect(after).toEqual({ ...before, "rooms-2": r.body.key });
    const old = await place("rooms-2", "room", before["rooms-2"]);
    expect([old.status, old.body.error]).toEqual([403, "room_key"]);
    expect((await place("rooms-2", "room", r.body.key)).status).toBe(201);
    expect((await place("rooms-3", "room", before["rooms-3"])).status).toBe(201);
    // Again: each press makes a new key; only the owner's level may press it, and only for a room.
    expect((await call("POST", "/api/rooms/rooms-2/new-key", {}, owner)).body.key).not.toBe(r.body.key);
    expect((await call("POST", "/api/rooms/rooms-2/new-key", {}, await login("desk"))).status).toBe(403);
    expect((await call("POST", "/api/rooms/table-1/new-key", {}, owner)).body.error).toBe("bad_room");
  });

  test("counter staff may key a room's order in without the QR; station staff may not", async () => {
    boot();
    const order = (key: string) => ({
      clientKey: `room-client-key-${key}-abcdef`,
      lines: [{ itemId: "espresso", qty: 1 }],
      spot: "rooms-1",
      pay: "room",
    });
    const r = await call("POST", "/api/orders", order("desk"), await login("desk"));
    expect([r.status, r.body.order.roomBill]).toEqual([201, "open"]);
    const g = await call("POST", "/api/orders", order("grill"), await login("grill"));
    expect(g.status).toBe(403);
  });

  test("a demo answers each room's key at /api/demo, so an unkeyed room link works there; a real install never does", async () => {
    now = t0;
    store = openStore(":memory:");
    const pins = { owner: "1111", counter: "2222", station: "3333", manager: "4444", admin: "5555" };
    http = createApp({ config: withRooms, store, ownerPinHash: hash, now: () => now, demo: { pins } }).http;
    const demo = (await call("GET", "/api/demo")).body;
    expect(demo.roomKeys["rooms-1"]).toBe(roomKeys(store).keyFor("rooms-1"));
    store.close();
    boot();
    expect((await call("GET", "/api/demo")).body).toEqual({ demo: false });
  });
});

describe("a wrong order leaves the room bill (D-082)", () => {
  test("staff move it off, audited; it is then paid at the counter like any other order", async () => {
    boot();
    const a = await place("rooms-2", "room");
    const b = await place("rooms-2", "room");
    const each = a.body.order.totalMinor as number;
    const desk = await login("desk");
    now += 60_000;
    const moved = await call("POST", `/api/orders/${a.body.order.id}/off-room`, { reason: "Wrong room" }, desk);
    expect(moved.status).toBe(200);
    expect(moved.body.order.roomBill).toBeUndefined();
    expect(moved.body.move).toMatchObject({
      orderId: a.body.order.id,
      room: "rooms-2",
      by: "desk",
      level: "staff",
      reason: "Wrong room",
      at: now,
    });
    // The room's bill now holds only the other order, and the moved one is paid at the counter.
    const rooms = (await call("GET", "/api/rooms", undefined, desk)).body;
    expect(rooms.rooms).toEqual([expect.objectContaining({ room: "rooms-2", totalMinor: each })]);
    expect(rooms.moves).toEqual([expect.objectContaining({ label: "Room 2", reason: "Wrong room" })]);
    const paid = await call(
      "POST",
      `/api/orders/${a.body.order.id}/confirm`,
      { method: "cash", amountMinor: each },
      desk,
    );
    expect(paid.status).toBe(200);
    const guest = await call("GET", `/api/orders/${a.body.order.id}`, undefined, undefined, a.body.key);
    expect(guest.body.order.roomBill).toBeUndefined();
    // Read back from the database, it is no longer a room order.
    expect(store.getOrder(a.body.order.id)?.order.roomBill).toBeUndefined();
    expect(store.openRoomOrders().map((o) => o.id)).toEqual([b.body.order.id]);
  });

  test("only an order open on a room bill can move, a reason is optional, and guests and station staff may not", async () => {
    boot();
    const a = await place("rooms-1", "room");
    const plain = await place("garden-t1");
    const desk = await login("desk");
    expect((await call("POST", `/api/orders/${a.body.order.id}/off-room`, {})).status).toBe(401);
    expect((await call("POST", `/api/orders/${a.body.order.id}/off-room`, {}, await login("grill"))).status).toBe(403);
    const none = await call("POST", `/api/orders/${plain.body.order.id}/off-room`, {}, desk);
    expect([none.status, none.body.error]).toEqual([409, "not_on_room_bill"]);
    const ok = await call("POST", `/api/orders/${a.body.order.id}/off-room`, undefined, desk);
    expect(ok.status).toBe(200);
    expect(ok.body.move.reason).toBeUndefined();
    const again = await call("POST", `/api/orders/${a.body.order.id}/off-room`, {}, desk);
    expect(again.body.error).toBe("not_on_room_bill");
    expect((await call("POST", "/api/orders/nope/off-room", {}, desk)).status).toBe(404);
  });
});
