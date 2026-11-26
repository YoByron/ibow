/**
 * D-097 over HTTP: the kitchen's first ready moves the order to preparing and the last line handed over closes it when
 * nothing is owed, each sent as an `order.status` event; confirming or topping up the money closes one already handed
 * over; a counter screen a moment behind can't skip a step; a room order taken off its bill after it closed is reopened.
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { roomKeys } from "../src/server/room-keys.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { sampleRaw } from "./support/samples.ts";

const config = loadConfig(sampleRaw("garden-cafe"));
const t0 = Date.UTC(2026, 11, 1, 11, 0); // 11:00 in Lisbon, open
const PIN = "908172";
let hash = "";
let now = t0;
let store: Store;
let http: ReturnType<typeof createApp>["http"];
let owner = "";

beforeAll(async () => {
  hash = await hashPin(PIN, TEST_PIN_COST);
});
afterEach(() => store.close());

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await http.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = (await res.json()) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function boot(): Promise<void> {
  now = t0;
  store = openStore(":memory:");
  http = createApp({ config, store, ownerPinHash: hash, now: () => now }).http;
  owner = (await call("POST", "/api/login", { user: "owner", pin: PIN })).cookie as string;
}

let n = 0;
async function place(spot: string, pay?: "room") {
  const r = await call("POST", "/api/orders", {
    clientKey: `served-api-key-${++n}-abcdef`,
    lines: [{ itemId: "espresso", qty: 1 }],
    spot,
    ...(pay === "room" ? { pay, roomKey: roomKeys(store).keyFor(spot) } : {}),
  });
  expect(r.status).toBe(201);
  return r.body.order as { id: string; token: string; totalMinor: number };
}
const staffOrder = async (id: string) =>
  ((await call("GET", "/api/orders", undefined, owner)).body.orders as { id: string; status: string }[]).find(
    (o) => o.id === id,
  );
const lastEvent = (id: string) => store.eventsAfter(0, { orderId: id }).at(-1);
const ready = (id: string) => call("POST", "/api/stations/bar/ready", { lines: [{ orderId: id, index: 0 }] }, owner);
const serve = (id: string) => call("POST", `/api/orders/${id}/lines/0/served`, undefined, owner);

describe("the status follows the floor over HTTP (D-097)", () => {
  test("ready moves it to preparing; handed over unpaid it stays open; the payment then closes it", async () => {
    await boot();
    const o = await place("garden-t4");
    now += 60_000;
    expect((await ready(o.id)).status).toBe(200);
    expect((await staffOrder(o.id))?.status).toBe("preparing");
    expect(lastEvent(o.id)?.type).toBe("order.status");

    now += 60_000;
    const served = await serve(o.id);
    expect(served.body.order.status).toBe("preparing");
    expect((await call("GET", `/api/tokens/${o.token}`)).body).toMatchObject({ served: true, status: "preparing" });

    now += 60_000;
    const paid = await call(
      "POST",
      `/api/orders/${o.id}/confirm`,
      { method: "cash", amountMinor: o.totalMinor },
      owner,
    );
    expect(paid.body.order.status).toBe("completed");
    expect(lastEvent(o.id)?.type).toBe("order.status");
  });

  test("a paid order closes on the last hand-over, as an order.status event", async () => {
    await boot();
    const o = await place("garden-t4");
    await call("POST", `/api/orders/${o.id}/confirm`, { method: "upi", amountMinor: o.totalMinor }, owner);
    now += 60_000;
    expect((await serve(o.id)).body.order.status).toBe("completed");
    expect(lastEvent(o.id)?.type).toBe("order.status");
  });

  test("a top-up for lines added and handed over closes the order", async () => {
    await boot();
    const o = await place("garden-t4");
    await call("POST", `/api/orders/${o.id}/confirm`, { method: "cash", amountMinor: o.totalMinor }, owner);
    const added = await call("POST", `/api/orders/${o.id}/lines`, { lines: [{ itemId: "espresso", qty: 1 }] }, owner);
    expect(added.status).toBe(200);
    await serve(o.id);
    const second = await call("POST", `/api/orders/${o.id}/lines/1/served`, undefined, owner);
    expect(second.body.order.status).not.toBe("completed");
    const due = second.body.order.outstandingMinor as number;
    const topped = await call("POST", `/api/orders/${o.id}/topup`, { method: "cash", amountMinor: due }, owner);
    expect(topped.body.order.status).toBe("completed");
  });

  test("a counter screen a moment behind the kitchen changes nothing; a made-up status is refused", async () => {
    await boot();
    const o = await place("garden-t4");
    await ready(o.id);
    const stale = await call("POST", `/api/orders/${o.id}/advance?from=pending`, undefined, owner);
    expect(stale.status).toBe(200);
    expect(stale.body.order.status).toBe("preparing");
    const bad = await call("POST", `/api/orders/${o.id}/advance?from=soon`, undefined, owner);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_input");
    expect((await call("POST", `/api/orders/${o.id}/advance?from=preparing`, undefined, owner)).body.order.status).toBe(
      "completed",
    );
  });

  test("a room order closes when handed over; taken off the bill after, it owes money and is open again", async () => {
    await boot();
    const o = await place("rooms-2", "room");
    now += 60_000;
    expect((await serve(o.id)).body.order.status).toBe("completed");
    now += 60_000;
    const off = await call("POST", `/api/orders/${o.id}/off-room`, { reason: "wrong room" }, owner);
    expect(off.status).toBe(200);
    const back = await staffOrder(o.id);
    expect(back?.status).toBe("preparing");
    const paid = await call(
      "POST",
      `/api/orders/${o.id}/confirm`,
      { method: "cash", amountMinor: o.totalMinor },
      owner,
    );
    expect(paid.body.order.status).toBe("completed");
  });
});
