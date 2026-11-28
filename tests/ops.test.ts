/**
 * Operations switches (D-101): the manager and the owner flip them from the links hub, audited like the other flags.
 * `ops.upi` takes UPI out of the guest's hands; `ops.counterFirst` keeps an unpaid order off every station until the
 * counter confirms the payment, while a room-bill order goes straight through.
 */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { OPS_FLAGS } from "../src/core/flags.ts";
import { can } from "../src/core/levels.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { roomKeys } from "../src/server/room-keys.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const teaHouse = loadSample("tea-house");
const UPI = { vpa: "teahouse@example", payeeName: "The Tea House" };
const t0 = Date.UTC(2026, 11, 1, 11, 0); // 11:00 in Lisbon and 16:30 in Kolkata: both open
const PINS = { owner: "908172", admin: "445566", manager: "3344", staff: "5566" };
let hashes: Record<string, string> = {};
let store: Store;
let http: ReturnType<typeof createApp>["http"];
let now = t0;

beforeAll(async () => {
  const [owner, admin, manager, staff] = await Promise.all(
    [PINS.owner, PINS.admin, PINS.manager, PINS.staff].map((p) => hashPin(p, TEST_PIN_COST)),
  );
  hashes = { owner, admin, manager, staff } as Record<string, string>;
});
afterEach(() => (store as Store | undefined)?.close());

function boot(config = cafe, withUpi = false): void {
  now = t0;
  store = openStore(":memory:");
  store.putStaff({ id: "mgr", name: "Manager", pinHash: hashes.manager as string, role: "manager" });
  store.putStaff({ id: "till", name: "Till", pinHash: hashes.staff as string, role: "counter" });
  http = createApp({
    config,
    store,
    ownerPinHash: hashes.owner as string,
    adminPinHash: hashes.admin as string,
    now: () => now,
    ...(withUpi ? { payments: { upi: UPI } } : {}),
  }).http;
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
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const login = async (user: string, pin: string) => (await call("POST", "/api/login", { user, pin })).cookie as string;

let n = 0;
async function place(spot?: string, pay?: "room", item = "espresso", size?: string) {
  const r = await call("POST", "/api/orders", {
    clientKey: `ops-client-key-${++n}-abcdef`,
    lines: [{ itemId: item, qty: 1, ...(size === undefined ? {} : { size }) }],
    ...(spot === undefined ? {} : { spot }),
    ...(pay === "room" && spot !== undefined ? { pay, roomKey: roomKeys(store).keyFor(spot) } : {}),
  });
  expect(r.status).toBe(201);
  return r.body as { order: { id: string; token: string; totalMinor: number; paysFirst?: true }; key: string };
}
const stationIds = async (cookie: string, station = "bar") =>
  ((await call("GET", `/api/stations/${station}/orders`, undefined, cookie)).body.orders as { id: string }[]).map(
    (o) => o.id,
  );
const polledIds = async (cookie: string, station = "bar") =>
  (
    (await call("GET", `/api/poll/station/${station}?after=0`, undefined, cookie)).body.events as {
      order: { id: string };
    }[]
  ).map((e) => e.order.id);

describe("the definitions and who flips them", () => {
  test("four switches, each one line, with the defaults the plan names; manager and owner hold them", () => {
    expect(OPS_FLAGS.map((f) => [f.key, f.scope, f.kind])).toEqual([
      ["ops.upi", "ops", "boolean"],
      ["ops.counterFirst", "ops", "boolean"],
      ["ops.messages", "ops", "boolean"],
      ["ops.sections", "ops", "boolean"],
    ]);
    expect(can("manager", "flags.ops")).toBe(true);
    expect(can("owner", "flags.ops")).toBe(true);
    expect(can("staff", "flags.ops")).toBe(false);
    expect(can("admin", "flags.ops")).toBe(false);
  });

  test("the manager sees and flips them, audited; staff and the admin may not", async () => {
    boot();
    const manager = await login("mgr", PINS.manager);
    const listed = (await call("GET", "/api/flags", undefined, manager)).body.flags as {
      key: string;
      value: unknown;
    }[];
    expect(Object.fromEntries(listed.map((f) => [f.key, f.value]))).toEqual({
      "ops.upi": true,
      "ops.counterFirst": false,
      "ops.messages": true,
      "ops.sections": true,
    });
    now += 60_000;
    expect((await call("PUT", "/api/flags/ops.counterFirst", { value: true }, manager)).body).toEqual({
      key: "ops.counterFirst",
      value: true,
    });
    const audit = (await call("GET", "/api/flags", undefined, manager)).body.audit;
    expect(audit[0]).toMatchObject({ by: "mgr", level: "manager", key: "ops.counterFirst", from: false, to: true });
    const owner = await login("owner", PINS.owner);
    const ownerKeys = ((await call("GET", "/api/flags", undefined, owner)).body.flags as { key: string }[]).map(
      (f) => f.key,
    );
    expect(ownerKeys).toEqual(expect.arrayContaining(["features.veg", "ops.upi", "ops.counterFirst"]));
    const staff = await login("till", PINS.staff);
    expect((await call("PUT", "/api/flags/ops.upi", { value: false }, staff)).status).toBe(403);
    const admin = await login("admin", PINS.admin);
    expect((await call("PUT", "/api/flags/ops.upi", { value: false }, admin)).status).toBe(403);
    expect((await call("PUT", "/api/flags/ops.upi", { value: "no" }, manager)).body.error).toBe("bad_flag_value");
  });
});

describe("ops.upi", () => {
  test("off, the catalog offers no UPI and the order's UPI link is refused; on, both are back", async () => {
    boot(teaHouse, true);
    const manager = await login("mgr", PINS.manager);
    const { order, key } = await place(undefined, undefined, "house-special-chai", "M");
    expect((await call("GET", "/api/catalog")).body.payments.upi).toBe(true);
    expect((await call("GET", `/api/orders/${order.id}/upi`, undefined, undefined, key)).status).toBe(200);
    await call("PUT", "/api/flags/ops.upi", { value: false }, manager);
    expect((await call("GET", "/api/catalog")).body.payments.upi).toBe(false);
    const refused = await call("GET", `/api/orders/${order.id}/upi`, undefined, undefined, key);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("upi_off");
    expect(refused.body.message).toMatch(/expected UPI switched on.*found it switched off/);
    await call("PUT", "/api/flags/ops.upi", { value: true }, manager);
    expect((await call("GET", `/api/orders/${order.id}/upi`, undefined, undefined, key)).status).toBe(200);
  });

  test("off, a guest's claim to have paid by UPI is refused too; a claim of another method still stands", async () => {
    boot(teaHouse, true);
    const manager = await login("mgr", PINS.manager);
    const { order, key } = await place(undefined, undefined, "house-special-chai", "M");
    await call("PUT", "/api/flags/ops.upi", { value: false }, manager);
    for (const body of [{}, { method: "upi" }]) {
      const refused = await call("POST", `/api/orders/${order.id}/claim`, body, undefined, key);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("upi_off");
    }
    expect((await call("GET", `/api/orders/${order.id}`, undefined, undefined, key)).body.order.payment.state).toBe(
      "unpaid",
    );
    await call("PUT", "/api/flags/ops.upi", { value: true }, manager);
    expect((await call("POST", `/api/orders/${order.id}/claim`, {}, undefined, key)).status).toBe(200);
  });

  test("where no UPI is set up, switching it on changes nothing", async () => {
    boot(teaHouse, false);
    expect((await call("GET", "/api/catalog")).body.payments.upi).toBe(false);
  });
});

describe("ops.counterFirst", () => {
  test("off by default: an unpaid order reaches the station at once, and the catalog says nothing", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const { order } = await place("garden-t4");
    expect(order.paysFirst).toBeUndefined();
    expect(await stationIds(owner)).toEqual([order.id]);
    expect((await call("GET", "/api/catalog")).body.payments.counterFirst).toBeUndefined();
  });

  test("on, an unpaid order is on the counter and on no station until the counter confirms it", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const till = await login("till", PINS.staff);
    await call("PUT", "/api/flags/ops.counterFirst", { value: true }, owner);
    expect((await call("GET", "/api/catalog")).body.payments.counterFirst).toBe(true);
    const { order } = await place("garden-t4");
    expect(order.paysFirst).toBe(true);
    expect(await stationIds(owner)).toEqual([]);
    expect(await polledIds(owner)).toEqual([]);
    const counter = (await call("GET", "/api/orders", undefined, till)).body.orders as { id: string }[];
    expect(counter.map((o) => o.id)).toEqual([order.id]);
    const paid = await call(
      "POST",
      `/api/orders/${order.id}/confirm`,
      { method: "cash", amountMinor: order.totalMinor },
      till,
    );
    expect(paid.status).toBe(200);
    expect(await stationIds(owner)).toEqual([order.id]);
    // The confirmation is the station's first event of the order: the stream and the poll bring it in.
    const events = (await call("GET", "/api/poll/station/bar?after=0", undefined, owner)).body.events as {
      type: string;
      order: { id: string; lines: unknown[] };
    }[];
    expect(events.map((e) => [e.type, e.order.id])).toEqual([["order.updated", order.id]]);
    expect(events[0]?.order.lines).toHaveLength(1);
  });

  test("a claimed payment still waits for the counter", async () => {
    // UPI set up (the tea house takes INR), since a claim is of a UPI payment.
    boot(teaHouse, true);
    const owner = await login("owner", PINS.owner);
    await call("PUT", "/api/flags/ops.counterFirst", { value: true }, owner);
    const { order, key } = await place(undefined, undefined, "house-special-chai", "M");
    expect((await call("POST", `/api/orders/${order.id}/claim`, {}, undefined, key)).status).toBe(200);
    expect(await stationIds(owner, "tea")).toEqual([]);
    expect(await polledIds(owner, "tea")).toEqual([]);
  });

  test("a station can't mark ready what is not on it yet: 409, and nothing changes", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    await call("PUT", "/api/flags/ops.counterFirst", { value: true }, owner);
    const { order } = await place("garden-t4");
    const early = await call("POST", "/api/stations/bar/ready", { lines: [{ orderId: order.id, index: 0 }] }, owner);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("awaiting_payment");
    expect(early.body.message).toMatch(/confirmed/);
    await call("POST", `/api/orders/${order.id}/confirm`, { method: "cash", amountMinor: order.totalMinor }, owner);
    expect(
      (await call("POST", "/api/stations/bar/ready", { lines: [{ orderId: order.id, index: 0 }] }, owner)).status,
    ).toBe(200);
  });

  test("a room-bill order goes straight through", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    await call("PUT", "/api/flags/ops.counterFirst", { value: true }, owner);
    const { order } = await place("rooms-1", "room");
    expect(order.paysFirst).toBeUndefined();
    expect(await stationIds(owner)).toEqual([order.id]);
    expect(await polledIds(owner)).toEqual([order.id]);
  });

  test("flipping the switch leaves orders already taken as they were, either way", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const before = (await place("garden-t4")).order;
    await call("PUT", "/api/flags/ops.counterFirst", { value: true }, owner);
    const during = (await place("garden-t5")).order;
    expect(await stationIds(owner)).toEqual([before.id]);
    await call("PUT", "/api/flags/ops.counterFirst", { value: false }, owner);
    // Switched off again, the order taken under it still waits for its payment.
    expect(await stationIds(owner)).toEqual([before.id]);
    expect(await polledIds(owner)).toEqual([before.id]);
    expect(during.paysFirst).toBe(true);
  });
});

describe("a kitchen without a screen", () => {
  test("the runner hands over a line no station ever marked ready", async () => {
    boot();
    const till = await login("till", PINS.staff);
    const { order } = await place("garden-t4");
    const served = await call("POST", `/api/orders/${order.id}/lines/0/served`, undefined, till);
    expect(served.status).toBe(200);
    expect(served.body.order.lines[0]).toMatchObject({ served: true, ready: false });
  });
});
