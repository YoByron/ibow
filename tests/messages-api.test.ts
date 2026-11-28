/**
 * Guest messages over HTTP (D-104): the guest writes on their own order with its key, the message goes to the runner of
 * the spot's section (or to everyone when the section has nobody) on the existing streams, the runner replies, and the
 * guest reads the reply on their order's own stream. Limits, the switch and the closed window answer with clear errors.
 */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { GUEST_GAP_MS, MAX_GUEST_MESSAGES } from "../src/core/messages.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";
import { openSse, type SseStream } from "./support/sse.ts";

const cafe = loadSample("garden-cafe");
const t0 = Date.UTC(2026, 11, 1, 11, 0); // 11:00 in Lisbon: open
const PINS = { owner: "908172", runner: "1122", station: "7788" };
let hashes: Record<string, string> = {};
let store: Store;
let http: ReturnType<typeof createApp>["http"];
let now = t0;

beforeAll(async () => {
  const entries = await Promise.all(
    Object.entries(PINS).map(async ([k, p]) => [k, await hashPin(p, TEST_PIN_COST)] as const),
  );
  hashes = Object.fromEntries(entries);
});
const streams: SseStream[] = [];
afterEach(async () => {
  for (const x of streams.splice(0)) await x.close();
  (store as Store | undefined)?.close();
});

/** A staff phone with its live feed open. */
async function online(cookie: string): Promise<SseStream> {
  const x = await openSse(http.request("/api/stream/counter", { headers: { cookie } }));
  streams.push(x);
  expect(x.status).toBe(200);
  return x;
}

function boot(): void {
  now = t0;
  store = openStore(":memory:");
  store.putStaff({ id: "asha", name: "Asha", pinHash: hashes.runner as string, role: "counter" });
  store.putStaff({ id: "barista", name: "Barista", pinHash: hashes.station as string, role: "station" });
  http = createApp({ config: cafe, store, ownerPinHash: hashes.owner as string, now: () => now }).http;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["x-order-key"] = opts.key;
  const res = await http.request(path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body: json, headers: res.headers, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const login = async (user: string, pin: string) =>
  (await call("POST", "/api/login", { body: { user, pin } })).cookie as string;

let n = 0;
async function place(spot?: string): Promise<{ id: string; key: string }> {
  const r = await call("POST", "/api/orders", {
    body: {
      clientKey: `messages-key-${++n}-abcdefgh`,
      lines: [{ itemId: "carrot-cake", qty: 1 }],
      ...(spot === undefined ? {} : { spot }),
    },
  });
  expect(r.status).toBe(201);
  return { id: r.body.order.id, key: r.body.key };
}

const send = (o: { id: string; key: string }, body: unknown) =>
  call("POST", `/api/orders/${o.id}/messages`, { body, key: o.key });

describe("guest messages over HTTP (D-104)", () => {
  test("a guest's message reaches the section's runner on the counter feed; the reply reaches the guest's own feed", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    expect((await call("PUT", "/api/sections/garden/runner", { body: { user: "asha" }, cookie: owner })).status).toBe(
      200,
    );
    const o = await place("garden-t4");
    const after = (await call("GET", "/api/orders", { cookie: owner })).body.lastEventId as number;
    const asha = await login("asha", PINS.runner);
    await online(asha);
    const sent = await send(o, { chip: "water" });
    expect(sent.status).toBe(201);
    expect(sent.body.order.messages).toEqual([{ at: t0, from: "guest", chip: "water" }]);

    const feed = await call("GET", `/api/poll/counter?after=${after}`, { cookie: asha });
    const seen = feed.body.events.at(-1).order;
    expect(seen.messages).toEqual([{ at: t0, from: "guest", chip: "water", to: "asha" }]);

    now += 4000;
    const reply = await call("POST", `/api/orders/${o.id}/reply`, { body: { chip: "coming" }, cookie: asha });
    expect(reply.status).toBe(201);
    expect(reply.body.order.messages.at(-1)).toEqual({ at: now, from: "staff", chip: "coming", by: "asha" });

    const mine = await call("GET", `/api/poll/order/${o.id}?after=${after}`, { key: o.key });
    const last = mine.body.events.at(-1).order;
    expect(last.messages).toEqual([
      { at: t0, from: "guest", chip: "water" },
      { at: now, from: "staff", chip: "coming" },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain("asha");
  });

  test("a runner whose phone has no live feed open gets nobody's message alone: it goes to everyone", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    await call("PUT", "/api/sections/garden/runner", { body: { user: "asha" }, cookie: owner });
    const o = await place("garden-t8");
    expect((await send(o, { chip: "water" })).status).toBe(201);
    const asha = await login("asha", PINS.runner);
    const feed = await online(asha);
    now += 10_000;
    await send(o, { chip: "help" });
    const thread = (await call("GET", `/api/orders/${o.id}`, { cookie: owner })).body.order.messages as {
      to?: string;
    }[];
    expect(thread.map((m) => m.to)).toEqual([undefined, "asha"]);
    // Her phone closed again: back to everyone.
    await feed.close();
    await expect
      .poll(async () => {
        now += 10_000;
        const r = await send(o, { chip: "more" });
        return r.body.order === undefined ? "refused" : "sent";
      })
      .toBe("sent");
    const last = (await call("GET", `/api/orders/${o.id}`, { cookie: owner })).body.order.messages.at(-1);
    expect(last.to).toBeUndefined();
  });

  test("a section with nobody sends to everyone; an order without a spot too", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const terrace = await place("terrace-1");
    await send(terrace, { text: "Is the kitchen still open?" });
    const walkIn = await place();
    await send(walkIn, { chip: "help" });
    const open = (await call("GET", "/api/orders", { cookie: owner })).body.orders as {
      id: string;
      messages?: { to?: string }[];
    }[];
    for (const id of [terrace.id, walkIn.id]) {
      const thread = open.find((x) => x.id === id)?.messages;
      expect(thread).toHaveLength(1);
      expect(thread?.[0]?.to).toBeUndefined();
    }
  });

  test("the guest needs the order's key; a reply needs a staff session; a station's staff may reply", async () => {
    boot();
    const o = await place("garden-t1");
    expect((await call("POST", `/api/orders/${o.id}/messages`, { body: { chip: "water" } })).status).toBe(401);
    expect((await send({ id: o.id, key: "wrong-key" }, { chip: "water" })).status).toBe(404);
    expect((await call("POST", `/api/orders/${o.id}/reply`, { body: { chip: "coming" } })).status).toBe(401);
    const barista = await login("barista", PINS.station);
    expect(
      (await call("POST", `/api/orders/${o.id}/reply`, { body: { chip: "coming" }, cookie: barista })).status,
    ).toBe(201);
  });

  test("text up to 200 characters, one message per 10 seconds, at most 20 from the guest", async () => {
    boot();
    const o = await place("garden-t2");
    const long = await send(o, { text: "x".repeat(201) });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("bad_message");
    expect((await send(o, { chip: "pizza" })).body.error).toBe("bad_message");
    expect((await send(o, { chip: "water" })).status).toBe(201);
    now += 3000;
    const soon = await send(o, { chip: "water" });
    expect(soon.status).toBe(429);
    expect(soon.body.error).toBe("too_soon");
    expect(soon.headers.get("retry-after")).toBe("7");
    for (let i = 1; i < MAX_GUEST_MESSAGES; i++) {
      now += GUEST_GAP_MS;
      expect((await send(o, { text: `ask ${i}` })).status).toBe(201);
    }
    now += GUEST_GAP_MS;
    const many = await send(o, { chip: "water" });
    expect(many.status).toBe(409);
    expect(many.body.error).toBe("too_many_messages");
  });

  test("a completed order whose guest waits for an answer is in a fresh staff snapshot until answered or past the window", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const o = await place("garden-t6");
    const quiet = await place("garden-t7");
    for (const x of [o, quiet]) {
      const total = (await call("GET", `/api/orders/${x.id}`, { cookie: owner })).body.order.totalMinor as number;
      await call("POST", `/api/orders/${x.id}/confirm`, {
        body: { method: "cash", amountMinor: total },
        cookie: owner,
      });
      await call("POST", `/api/orders/${x.id}/lines/0/served`, { body: {}, cookie: owner });
    }
    const snapshot = async () =>
      (
        (await call("GET", "/api/orders", { cookie: owner })).body.orders as {
          id: string;
          status: string;
          messages?: { from: string }[];
        }[]
      ).filter((x) => x.id === o.id || x.id === quiet.id);
    expect(await snapshot()).toEqual([]);
    now += 5 * 60_000;
    expect((await send(o, { chip: "bill" })).status).toBe(201);
    const listed = await snapshot();
    expect(listed.map((x) => [x.id, x.status, x.messages?.at(-1)?.from])).toEqual([[o.id, "completed", "guest"]]);
    // Answered, it leaves the snapshot.
    await call("POST", `/api/orders/${o.id}/reply`, { body: { chip: "coming" }, cookie: owner });
    expect(await snapshot()).toEqual([]);
    // Asked again, then left past the window: gone too.
    now += 10_000;
    await send(o, { chip: "help" });
    expect(await snapshot()).toHaveLength(1);
    now += 30 * 60_000;
    expect(await snapshot()).toEqual([]);
  });

  test("a completed order refuses a message 30 minutes after it closed, with the reason", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const o = await place("garden-t3");
    const total = (await call("GET", `/api/orders/${o.id}`, { cookie: owner })).body.order.totalMinor as number;
    await call("POST", `/api/orders/${o.id}/confirm`, { body: { method: "cash", amountMinor: total }, cookie: owner });
    await call("POST", `/api/orders/${o.id}/lines/0/served`, { body: {}, cookie: owner });
    const done = (await call("GET", `/api/orders/${o.id}`, { key: o.key })).body.order;
    expect(done.status).toBe("completed");
    expect(done.messagesUntil).toBe(t0 + 30 * 60_000);
    now += 10 * 60_000;
    expect((await send(o, { chip: "bill" })).status).toBe(201);
    now += 21 * 60_000;
    const late = await send(o, { chip: "bill" });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("messages_closed");
    expect(late.body.message).toMatch(/30 minutes/);
  });

  test("with ops.messages off a guest can't send, and the catalog says so", async () => {
    boot();
    expect((await call("GET", "/api/catalog")).body.messages).toBe(true);
    const owner = await login("owner", PINS.owner);
    expect((await call("PUT", "/api/flags/ops.messages", { body: { value: false }, cookie: owner })).status).toBe(200);
    expect((await call("GET", "/api/catalog")).body.messages).toBeUndefined();
    const o = await place("garden-t5");
    const off = await send(o, { chip: "water" });
    expect(off.status).toBe(403);
    expect(off.body.error).toBe("messages_off");
  });
});
