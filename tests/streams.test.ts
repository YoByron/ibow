import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { type App, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";
import { openSse, parsed, type SseStream } from "./support/sse.ts";

const config = loadSample("tea-house");
const t0 = Date.UTC(2026, 10, 26, 12, 0);
let now = t0;
let ownerPinHash = "";
let store: Store;
let app: App;
let owner = "";
let staff = "";
const open: SseStream[] = [];

beforeAll(async () => {
  ownerPinHash = await hashPin("908172", TEST_PIN_COST);
});

async function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.http.request(path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, body: await res.json() };
}

async function boot(): Promise<void> {
  store = openStore(":memory:");
  now = t0;
  app = createApp({ config, store, ownerPinHash, now: () => now, heartbeatMs: 20 });
  const o = await json("POST", "/api/login", { user: "owner", pin: "908172" });
  owner = (o.res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  await json("PUT", "/api/staff/kitchen-1", { name: "Kitchen", pin: "2468" }, { cookie: owner });
  const s = await json("POST", "/api/login", { user: "kitchen-1", pin: "2468" });
  staff = (s.res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  store.close();
});

async function stream(path: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const s = await openSse(app.http.request(path, { headers }));
  open.push(s);
  return s;
}

let n = 0;
async function order(lines: unknown[]) {
  n++;
  return (await json("POST", "/api/orders", { clientKey: `stream-test-key-${n}-0000`, lines })).body;
}

const chai = { itemId: "house-special-chai", size: "M", qty: 1 };
const momos = { itemId: "veg-momos-sf", qty: 1 };

describe("SSE streams", () => {
  test("each station hears only of orders with its lines, and sees only those lines", async () => {
    await boot();
    const tea = await stream("/api/stream/station/tea", { cookie: staff });
    const kitchen = await stream("/api/stream/station/kitchen", { cookie: staff });
    const counter = await stream("/api/stream/counter", { cookie: staff });
    expect(tea.status).toBe(200);
    const a = await order([chai]);
    const b = await order([momos, chai]);
    await order([momos]);
    await counter.until((m) => m.length === 3);
    await tea.until((m) => m.length === 2);
    await kitchen.until((m) => m.length === 2);
    const teaEvents = parsed(tea.messages);
    expect(teaEvents.map((e) => e.order.id)).toEqual([a.order.id, b.order.id]);
    expect(teaEvents.flatMap((e) => e.order.lines.map((l: { stationId: string }) => l.stationId))).toEqual([
      "tea",
      "tea",
    ]);
    expect(teaEvents[1].order.lines[0].index).toBe(1);
    expect(
      parsed(kitchen.messages).every((e) =>
        e.order.lines.every((l: { stationId: string }) => l.stationId === "kitchen"),
      ),
    ).toBe(true);
    expect(tea.messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(parsed(counter.messages)[0]).toMatchObject({ id: 1, type: "order.created", at: t0 });
  });

  test("a station hears of an edit that removed its last line, with no lines left", async () => {
    await boot();
    const kitchen = await stream("/api/stream/station/kitchen", { cookie: staff });
    const created = await order([chai, momos]);
    await json("PUT", `/api/orders/${created.order.id}/lines`, { lines: [chai] }, { "x-order-key": created.key });
    await kitchen.until((m) => m.length === 2);
    expect(parsed(kitchen.messages)[1].order.lines).toEqual([]);
  });

  test("a customer's stream carries only their order, by its key", async () => {
    await boot();
    const mine = await order([chai]);
    const other = await order([chai]);
    expect((await stream(`/api/stream/order/${mine.order.id}?key=wrong`)).status).toBe(404);
    const s = await stream(`/api/stream/order/${mine.order.id}?key=${mine.key}&after=${mine.lastEventId}`);
    await json("POST", `/api/orders/${other.order.id}/advance`, undefined, { cookie: staff });
    await json("POST", `/api/orders/${mine.order.id}/advance`, undefined, { cookie: staff });
    await s.until((m) => m.length === 1);
    const [event] = parsed(s.messages);
    expect(event).toMatchObject({ type: "order.status", order: { id: mine.order.id, status: "preparing" } });
    expect(JSON.stringify(event)).not.toContain("stationId");
  });

  test("streams need the right session", async () => {
    await boot();
    expect((await stream("/api/stream/counter")).status).toBe(401);
    expect((await stream("/api/stream/owner", { cookie: staff })).status).toBe(403);
    expect((await stream("/api/stream/owner", { cookie: owner })).status).toBe(200);
    expect((await stream("/api/stream/station/nope", { cookie: staff })).status).toBe(404);
    expect((await stream("/api/stream/counter?after=-1", { cookie: staff })).status).toBe(400);
  });

  test("Last-Event-ID replays every missed event once, in order, then continues live", async () => {
    await boot();
    const first = await stream("/api/stream/station/tea", { cookie: staff });
    await order([chai]);
    await first.until((m) => m.length === 1);
    await first.close();
    for (let i = 0; i < 5; i++) await order(i % 2 === 0 ? [chai] : [momos]);
    const again = await stream("/api/stream/station/tea", { cookie: staff, "last-event-id": "1" });
    await again.until((m) => m.length === 3);
    await order([chai]);
    await again.until((m) => m.length === 4);
    expect(again.messages.map((m) => m.id)).toEqual(["2", "4", "6", "7"]);
  });

  test("the polling fallback returns the same filtered events and where to resume", async () => {
    await boot();
    await order([chai]);
    await order([momos]);
    await order([chai]);
    const tea = await json("GET", "/api/poll/station/tea?after=0", undefined, { cookie: staff });
    expect(tea.body.events.map((e: { id: number }) => e.id)).toEqual([1, 3]);
    expect(tea.body.lastEventId).toBe(3);
    const none = await json("GET", "/api/poll/station/tea?after=3", undefined, { cookie: staff });
    expect(none.body).toEqual({ events: [], lastEventId: 3 });
    const kitchen = await json("GET", "/api/poll/station/kitchen?after=2", undefined, { cookie: staff });
    expect(kitchen.body).toEqual({ events: [], lastEventId: 3 });
    expect((await json("GET", "/api/poll/counter?after=0")).res.status).toBe(401);
  });

  test("open streams are capped per order key and per session", async () => {
    await boot();
    const mine = await order([chai]);
    const path = `/api/stream/order/${mine.order.id}?key=${mine.key}`;
    const streams = [];
    for (let i = 0; i < 3; i++) streams.push(await stream(path));
    expect(streams.map((s) => s.status)).toEqual([200, 200, 200]);
    expect((await stream(path)).status).toBe(429);
    await streams[0]?.close();
    let reopened = 0;
    for (let i = 0; i < 50 && reopened !== 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const s = await stream(path);
      reopened = s.status;
    }
    expect(reopened).toBe(200);

    for (let i = 0; i < 5; i++) expect((await stream("/api/stream/counter", { cookie: staff })).status).toBe(200);
    expect((await stream("/api/stream/station/tea", { cookie: staff })).status).toBe(429);
    expect((await stream("/api/stream/counter", { cookie: owner })).status).toBe(200);
  });

  test("a stream closes once its session is logged out", async () => {
    await boot();
    const s = await stream("/api/stream/counter", { cookie: staff });
    await json("POST", "/api/logout", undefined, { cookie: staff });
    await within(s.ended, 2000, "the stream to end after logout");
  });

  test("a stream closes once its session expires", async () => {
    await boot();
    const s = await stream("/api/stream/station/tea", { cookie: staff });
    now = t0 + 13 * 60 * 60_000;
    await within(s.ended, 2000, "the stream to end after expiry");
  });
});

function within(p: Promise<void>, ms: number, what: string): Promise<void> {
  return Promise.race([
    p,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`expected ${what} within ${ms} ms`)), ms)),
  ]);
}

describe("replay after the log was pruned", () => {
  test("polling from before the oldest kept event says reset; polling from inside the window does not", async () => {
    await boot();
    await order([{ itemId: "masala-soda", qty: 1 }]);
    await order([{ itemId: "masala-soda", qty: 1 }]);
    store.pruneEvents(now + 1); // the whole log is older than this
    await order([{ itemId: "masala-soda", qty: 1 }]);
    const stale = await json("GET", "/api/poll/counter?after=0", undefined, { cookie: staff });
    expect(stale.body.reset).toBe(true);
    expect(stale.body.lastEventId).toBe(3);
    const fresh = await json("GET", "/api/poll/counter?after=2", undefined, { cookie: staff });
    expect(fresh.body.reset).toBeUndefined();
    expect(fresh.body.events.map((e: { id: number }) => e.id)).toEqual([3]);
    const current = await json("GET", "/api/poll/counter?after=3", undefined, { cookie: staff });
    expect(current.body.reset).toBeUndefined();
  });

  test("a stream resumed from before the oldest kept event gets a reset event, then follows live", async () => {
    await boot();
    await order([{ itemId: "masala-soda", qty: 1 }]);
    store.pruneEvents(now + 1);
    await order([{ itemId: "masala-soda", qty: 1 }]);
    const s = await stream("/api/stream/counter", { cookie: staff, "last-event-id": "0" });
    await s.until((m) => m.length >= 1);
    expect(s.messages[0]?.event).toBe("reset");
  });
});
