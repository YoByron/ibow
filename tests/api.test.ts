import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EDIT_WINDOW_MS } from "../src/core/orders.ts";
import { type App, type AppDeps, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store, StoredEvent } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
// 17:30 on 26 November in the tea house's zone.
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const OWNER_PIN = "908172";
let ownerPinHash = "";
let now = t0;
let store: Store;
let app: App;
let events: StoredEvent[];

beforeAll(async () => {
  ownerPinHash = await hashPin(OWNER_PIN, TEST_PIN_COST);
});

function boot(extra: Partial<AppDeps> = {}): void {
  now = t0;
  store = openStore(":memory:");
  app = createApp({ config, store, ownerPinHash, now: () => now, ...extra });
  events = [];
  app.events.on("event", (e: StoredEvent) => events.push(e));
}

afterEach(() => store.close());

interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  body: any;
  cookie?: string;
  rawCookie?: string;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; key?: string; ip?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.ip) headers["x-test-ip"] = opts.ip;
  Object.assign(headers, opts.headers);
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["x-order-key"] = opts.key;
  const res = await app.http.request(path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const setCookie = res.headers.get("set-cookie") ?? undefined;
  const reply: Reply = { status: res.status, body: await res.json() };
  if (setCookie) {
    reply.cookie = setCookie.split(";")[0] as string;
    reply.rawCookie = setCookie;
  }
  return reply;
}

let keys = 0;
function newOrder(lines: unknown = [{ itemId: "house-special-chai", size: "M", qty: 2 }], cookie?: string) {
  keys++;
  return call("POST", "/api/orders", {
    body: { clientKey: `client-key-${keys}-abcdefgh`, lines },
    ...(cookie ? { cookie } : {}),
  });
}

async function login(user: string, pin: string): Promise<string> {
  const r = await call("POST", "/api/login", { body: { user, pin } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.cookie as string;
}

async function staffCookie(): Promise<string> {
  const owner = await login("owner", OWNER_PIN);
  expect(
    (await call("PUT", "/api/staff/counter-1", { cookie: owner, body: { name: "Counter", pin: "1357" } })).status,
  ).toBe(200);
  return login("counter-1", "1357");
}

describe("customer API", () => {
  test("serves the catalog with the business's name and currency", async () => {
    boot();
    const r = await call("GET", "/api/catalog");
    expect(r.status).toBe(200);
    expect(r.body.business).toEqual({
      name: "The Tea House",
      currency: "INR",
      timeZone: "Asia/Kolkata",
      lateMinutes: 6,
      maxQtyPerLine: 99,
      cashShortcutsMinor: [500, 1000, 2000, 3000, 4000, 5000],
      hours: { open: "07:00", close: "22:00" },
    });
    expect(r.body.payments).toEqual({ upi: false, card: false });
    expect(r.body.categories).toHaveLength(config.catalog.categories.length);
  });

  test("offers UPI only when configured, with an intent for the order's exact amount and token", async () => {
    boot({ payments: { upi: { vpa: "teahouse@example", payeeName: "The Tea House" } } });
    expect((await call("GET", "/api/catalog")).body.payments).toEqual({ upi: true, card: false });
    const { body } = await newOrder();
    const id = body.order.id as string;
    expect((await call("GET", `/api/orders/${id}/upi`)).status).toBe(401);
    const r = await call("GET", `/api/orders/${id}/upi`, { key: body.key });
    expect(r).toEqual({
      status: 200,
      body: { intent: "upi://pay?pa=teahouse@example&pn=The%20Tea%20House&am=60&cu=INR&tn=Token%2026-001" },
    });
    store.close();
    boot();
    const other = await newOrder();
    const none = await call("GET", `/api/orders/${other.body.order.id}/upi`, { key: other.body.key });
    expect(none).toMatchObject({ status: 404, body: { error: "no_upi" } });
  });

  test("refuses to offer UPI for a business that doesn't take rupees, or with a malformed UPI ID", async () => {
    const usd = loadSample("coffee-cart");
    const upi = { vpa: "cart@example", payeeName: "Cart" };
    expect(() => createApp({ config: usd, store: openStore(":memory:"), ownerPinHash, payments: { upi } })).toThrow(
      /UPI_VPA.*INR.*USD/,
    );
    const bad = { vpa: "not a vpa", payeeName: "Cart" };
    expect(() => createApp({ config, store: openStore(":memory:"), ownerPinHash, payments: { upi: bad } })).toThrow(
      /UPI_VPA/,
    );
    boot();
  });

  test("creates an order with a token and a secret key, idempotently by the client key", async () => {
    boot();
    const body = {
      clientKey: "same-key-0123456789",
      lines: [{ itemId: "veg-momos-sf", qty: 1 }],
      customerName: " Asha ",
    };
    const first = await call("POST", "/api/orders", { body });
    expect(first.status).toBe(201);
    expect(first.body.order).toMatchObject({
      token: "26-001",
      status: "pending",
      totalMinor: 6000,
      customerName: "Asha",
    });
    expect(first.body.key).toMatch(/^[\w-]{32,}$/);
    expect(first.body.lastEventId).toBe(1);
    const again = await call("POST", "/api/orders", { body });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(events.map((e) => e.id)).toEqual([1]);
  });

  test("refuses bad input with the field, what was expected and what was found", async () => {
    boot();
    const noKey = await call("POST", "/api/orders", { body: { lines: [] } });
    expect(noKey).toMatchObject({ status: 400, body: { error: "bad_input" } });
    expect(noKey.body.message).toContain("clientKey");
    const badQty = await newOrder([{ itemId: "veg-momos-sf", qty: "two" }]);
    expect(badQty.status).toBe(400);
    expect(badQty.body.message).toBe('bad_input: lines[0].qty: expected a whole number, found "two"');
    expect((await newOrder([{ itemId: "nope", qty: 1 }])).body.error).toBe("unknown_item");
    expect((await newOrder([])).body.error).toBe("empty_order");
    const huge = await newOrder([{ itemId: "veg-momos-sf", qty: Number.MAX_SAFE_INTEGER }]);
    expect(huge).toMatchObject({ status: 400, body: { error: "bad_quantity" } });
    const notJson = await app.http.request("/api/orders", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
    const big = await app.http.request("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: "big-body-key-0123456789", lines: [], pad: "x".repeat(17 * 1024) }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "too_large" });
  });

  test("the customer reads, edits and claims payment on their own order with its key only", async () => {
    boot();
    const { body } = await newOrder();
    const id = body.order.id as string;
    expect((await call("GET", `/api/orders/${id}`)).status).toBe(401);
    expect((await call("GET", `/api/orders/${id}`, { key: "wrong" })).status).toBe(404);
    expect((await call("GET", `/api/orders/${id}?key=${body.key}`)).body.order.token).toBe("26-001");

    now = t0 + EDIT_WINDOW_MS - 1;
    const edited = await call("PUT", `/api/orders/${id}/lines`, {
      key: body.key,
      body: { lines: [{ itemId: "house-special-chai", size: "L", qty: 1 }] },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.order.totalMinor).toBe(4000);

    const claimed = await call("POST", `/api/orders/${id}/claim`, { key: body.key, body: { method: "upi" } });
    expect(claimed.body.order.payment).toEqual({ state: "claimed", method: "upi", amountMinor: 4000 });
    const late = await call("PUT", `/api/orders/${id}/lines`, { key: body.key, body: { lines: [] } });
    expect(late).toMatchObject({ status: 409, body: { error: "already_paid" } });
    expect(events.map((e) => e.type)).toEqual(["order.created", "order.updated", "order.updated"]);
  });

  test("the customer reviews their order once, after it is completed", async () => {
    boot();
    const { body } = await newOrder();
    const id = body.order.id as string;
    const path = `/api/orders/${id}/review`;
    expect((await call("POST", path, { body: { rating: 5 } })).status).toBe(401);
    const early = await call("POST", path, { key: body.key, body: { rating: 5 } });
    expect(early).toMatchObject({ status: 409, body: { error: "not_completed" } });
    const staff = await staffCookie();
    for (let i = 0; i < 2; i++) await call("POST", `/api/orders/${id}/advance`, { cookie: staff });
    const bad = await call("POST", path, { key: body.key, body: { rating: 9 } });
    expect(bad).toMatchObject({ status: 400, body: { error: "bad_rating" } });
    const ok = await call("POST", path, { key: body.key, body: { rating: 4, text: " Quick " } });
    expect(ok).toEqual({ status: 201, body: { ok: true } });
    expect(store.getReview(id)).toMatchObject({ rating: 4, text: "Quick" });
    const twice = await call("POST", path, { key: body.key, body: { rating: 1 } });
    expect(twice).toMatchObject({ status: 409, body: { error: "already_reviewed" } });
  });

  test("looks a token up for today, showing only its status", async () => {
    boot();
    await newOrder();
    const r = await call("GET", "/api/tokens/26-001");
    expect(r).toEqual({ status: 200, body: { token: "26-001", status: "pending", ready: false, served: false } });
    expect((await call("GET", "/api/tokens/26-002")).status).toBe(404);
  });
});

describe("staff API", () => {
  test("staff routes need a staff session; an order key is not one", async () => {
    boot();
    const { body } = await newOrder();
    for (const [method, path] of [
      ["GET", "/api/orders"],
      ["POST", `/api/orders/${body.order.id}/advance`],
      ["POST", `/api/orders/${body.order.id}/confirm`],
      ["GET", "/api/stations/tea/orders"],
      ["GET", "/api/stations"],
      ["POST", "/api/stations/tea/ready"],
      ["POST", `/api/orders/${body.order.id}/topup`],
    ] as const) {
      const r = await call(method, path, { key: body.key, ...(method === "POST" ? { body: {} } : {}) });
      expect(r.status, path).toBe(401);
    }
    expect((await call("GET", "/api/orders", { cookie: "ibow_session=forged" })).status).toBe(401);
  });

  test("the owner adds staff; staff cannot", async () => {
    boot();
    expect((await call("POST", "/api/login", { body: { user: "owner", pin: "000000" } })).status).toBe(401);
    const staff = await staffCookie();
    expect((await call("GET", "/api/me", { cookie: staff })).body).toEqual({
      user: "counter-1",
      role: "staff",
      access: "all",
      powers: ["orders.view", "orders.run", "hub"],
      canRefund: false,
    });
    expect((await call("PUT", "/api/staff/x", { cookie: staff, body: { name: "X", pin: "1234" } })).status).toBe(403);
    const owner = await login("owner", OWNER_PIN);
    expect((await call("GET", "/api/staff", { cookie: owner })).body).toEqual({
      staff: [{ id: "counter-1", name: "Counter", role: "all" }],
    });
    expect((await call("POST", "/api/logout", { cookie: owner })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: owner })).status).toBe(401);
  });

  test("changing a user's PIN ends all of that user's sessions", async () => {
    boot();
    const staff = await staffCookie();
    const other = await login("counter-1", "1357");
    const owner = await login("owner", OWNER_PIN);
    expect(
      (await call("PUT", "/api/staff/counter-1", { cookie: owner, body: { name: "Counter", pin: "2468" } })).status,
    ).toBe(200);
    expect((await call("GET", "/api/me", { cookie: staff })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: other })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: owner })).status).toBe(200);
    await login("counter-1", "2468");
  });

  test("staff confirm payment by name, move status, undo, add lines and mark items served", async () => {
    boot();
    const staff = await staffCookie();
    const { body } = await newOrder([
      { itemId: "house-special-chai", size: "M", qty: 1 },
      { itemId: "veg-momos-sf", qty: 1 },
    ]);
    const id = body.order.id as string;
    const open = await call("GET", "/api/orders", { cookie: staff });
    expect(open.body.orders.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(open.body.lastEventId).toBe(1);

    const paid = await call("POST", `/api/orders/${id}/confirm`, {
      cookie: staff,
      body: { method: "cash", amountMinor: 9000 },
    });
    expect(paid.body.order.payment).toMatchObject({ state: "confirmed", by: "counter-1", amountMinor: 9000 });
    expect(paid.body.order.outstandingMinor).toBe(0);

    expect((await call("POST", `/api/orders/${id}/advance`, { cookie: staff })).body.order.status).toBe("preparing");
    expect((await call("POST", `/api/orders/${id}/undo`, { cookie: staff })).body.order.status).toBe("pending");
    expect((await call("POST", `/api/orders/${id}/undo`, { cookie: staff })).body.error).toBe("nothing_to_undo");

    const added = await call("POST", `/api/orders/${id}/lines`, {
      cookie: staff,
      body: { lines: [{ itemId: "salted-fries", qty: 1 }] },
    });
    expect(added.body.order.outstandingMinor).toBe(6000);
    const served = await call("POST", `/api/orders/${id}/lines/2/served`, { cookie: staff });
    expect(served.body.order.lines[2].served).toBe(true);
    expect((await call("POST", `/api/orders/${id}/lines/9/served`, { cookie: staff })).body.error).toBe("no_such_line");

    const kitchen = await call("GET", "/api/stations/kitchen/orders", { cookie: staff });
    expect(kitchen.body.orders[0].lines.map((l: { index: number }) => l.index)).toEqual([1, 2]);
    expect((await call("GET", "/api/stations/nope/orders", { cookie: staff })).status).toBe(404);
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("staff roles", () => {
  test("a station role works stations only; a counter role and the owner do everything", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    const put = (id: string, role?: string) =>
      call("PUT", `/api/staff/${id}`, { cookie: owner, body: { name: id, pin: "1357", ...(role ? { role } : {}) } });
    expect((await put("tea-1", "station")).body).toEqual({ id: "tea-1", name: "tea-1", role: "station" });
    expect((await put("counter-2", "counter")).status).toBe(200);
    expect((await put("bad-1", "chef")).body.error).toBe("bad_input");
    const station = await login("tea-1", "1357");
    const counter = await login("counter-2", "1357");
    expect((await call("GET", "/api/me", { cookie: station })).body.access).toBe("station");
    expect((await call("GET", "/api/me", { cookie: owner })).body.access).toBe("all");

    const { body } = await newOrder([{ itemId: "house-special-chai", size: "M", qty: 1 }]);
    const id = body.order.id as string;
    const counterOnly: [string, unknown][] = [
      [`/api/orders/${id}/confirm`, { method: "cash", amountMinor: 3000 }],
      [`/api/orders/${id}/topup`, { method: "cash", amountMinor: 100 }],
      [`/api/orders/${id}/lines`, { lines: [{ itemId: "salted-fries", qty: 1 }] }],
      [`/api/orders/${id}/advance`, undefined],
      [`/api/orders/${id}/undo`, undefined],
      [`/api/orders/${id}/lines/0/served`, undefined],
    ];
    for (const [path, b] of counterOnly) {
      const r = await call("POST", path, { cookie: station, ...(b === undefined ? {} : { body: b }) });
      expect(r, path).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    const lines = { lines: [{ orderId: id, index: 0 }] };
    expect((await call("GET", "/api/stations/tea/orders", { cookie: station })).status).toBe(200);
    expect((await call("POST", "/api/stations/tea/ready", { cookie: station, body: lines })).status).toBe(200);
    expect((await call("POST", "/api/stations/tea/unready", { cookie: counter, body: lines })).status).toBe(200);

    const confirm = { method: "cash", amountMinor: 3000 };
    expect((await call("POST", `/api/orders/${id}/confirm`, { cookie: counter, body: confirm })).status).toBe(200);
    expect((await call("POST", `/api/orders/${id}/advance`, { cookie: owner })).status).toBe(200);
    expect((await call("POST", `/api/orders/${id}/undo`, { cookie: counter })).status).toBe(200);
  });
});

describe("stations and top-ups", () => {
  test("staff read each station's name, view, speech, print settings and categories (its tile's icon)", async () => {
    boot({ config: loadSample("service-desk") });
    const staff = await staffCookie();
    const r = await call("GET", "/api/stations", { cookie: staff });
    expect(r.body.stations).toEqual([
      { id: "front-desk", name: "Front Desk", view: "batch", speak: true, print: null, categories: ["quick-services"] },
      { id: "workshop", name: "Workshop", view: "jobs", speak: true, print: "ticket-80mm", categories: ["repairs"] },
    ]);
  });

  test("a station marks lines of several orders ready at once; the order is ready when every line is", async () => {
    boot();
    const staff = await staffCookie();
    const a = (await newOrder([{ itemId: "house-special-chai", size: "M", qty: 2 }])).body.order.id as string;
    const b = (
      await newOrder([
        { itemId: "house-special-chai", size: "M", qty: 1 },
        { itemId: "veg-momos-sf", qty: 1 },
      ])
    ).body.order.id as string;
    const before = events.length;
    const r = await call("POST", "/api/stations/tea/ready", {
      cookie: staff,
      body: {
        lines: [
          { orderId: a, index: 0 },
          { orderId: b, index: 0 },
        ],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.orders.map((o: { id: string; lines: { ready: boolean }[] }) => [o.id, o.lines[0]?.ready])).toEqual([
      [a, true],
      [b, true],
    ]);
    expect(events.length).toBe(before + 2);
    expect((await call("GET", "/api/tokens/26-001")).body.ready).toBe(true);
    expect((await call("GET", "/api/tokens/26-002")).body.ready).toBe(false);
    // Again: nothing changes, so nothing is stored or sent.
    await call("POST", "/api/stations/tea/ready", { cookie: staff, body: { lines: [{ orderId: a, index: 0 }] } });
    expect(events.length).toBe(before + 2);
    const tea = await call("GET", "/api/stations/tea/orders", { cookie: staff });
    expect(tea.body.orders[0].lines[0].ready).toBe(true);

    const wrong = await call("POST", "/api/stations/tea/ready", {
      cookie: staff,
      body: { lines: [{ orderId: b, index: 1 }] },
    });
    expect(wrong).toMatchObject({ status: 409, body: { error: "wrong_station" } });
    const unknown = await call("POST", "/api/stations/nope/ready", { cookie: staff, body: { lines: [] } });
    expect(unknown.status).toBe(404);
    const noOrder = await call("POST", "/api/stations/tea/ready", {
      cookie: staff,
      body: { lines: [{ orderId: "nope", index: 0 }] },
    });
    expect(noOrder.status).toBe(404);
    const bad = await call("POST", "/api/stations/tea/ready", { cookie: staff, body: { lines: [{ orderId: a }] } });
    expect(bad).toMatchObject({ status: 400, body: { error: "bad_input" } });

    // One bad line in a request leaves every order in it as it was.
    const c3 = (await newOrder([{ itemId: "house-special-chai", size: "S", qty: 1 }])).body.order.id as string;
    const stored = events.length;
    const mixed = await call("POST", "/api/stations/tea/ready", {
      cookie: staff,
      body: {
        lines: [
          { orderId: c3, index: 0 },
          { orderId: b, index: 1 },
        ],
      },
    });
    expect(mixed).toMatchObject({ status: 409, body: { error: "wrong_station" } });
    expect(events.length).toBe(stored);
    expect(store.getOrder(c3)?.order.lines[0]?.ready).toBe(false);

    // A mis-tap is taken back: the order is no longer ready, for the customer too.
    const undo = await call("POST", "/api/stations/tea/unready", {
      cookie: staff,
      body: { lines: [{ orderId: a, index: 0 }] },
    });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.orders[0].lines[0].ready).toBe(false);
    expect(events.length).toBe(stored + 1);
    expect((await call("GET", "/api/tokens/26-001")).body.ready).toBe(false);
    const mixedUndo = await call("POST", "/api/stations/tea/unready", {
      cookie: staff,
      body: {
        lines: [
          { orderId: b, index: 0 },
          { orderId: b, index: 1 },
        ],
      },
    });
    expect(mixedUndo).toMatchObject({ status: 409, body: { error: "wrong_station" } });
    expect(store.getOrder(b)?.order.lines[0]?.ready).toBe(true);
    expect((await call("POST", "/api/stations/tea/unready", { body: { lines: [] } })).status).toBe(401);
  });

  test("after staff add lines to a paid order, a staff top-up brings what is owed back to 0", async () => {
    boot();
    const staff = await staffCookie();
    const { body } = await newOrder([{ itemId: "house-special-chai", size: "M", qty: 1 }]);
    const id = body.order.id as string;
    const early = await call("POST", `/api/orders/${id}/topup`, {
      cookie: staff,
      body: { method: "cash", amountMinor: 100 },
    });
    expect(early).toMatchObject({ status: 409, body: { error: "bad_state" } });
    await call("POST", `/api/orders/${id}/confirm`, { cookie: staff, body: { method: "upi", amountMinor: 3000 } });
    const added = await call("POST", `/api/orders/${id}/lines`, {
      cookie: staff,
      body: { lines: [{ itemId: "salted-fries", qty: 1 }] },
    });
    expect(added.body.order.outstandingMinor).toBe(6000);
    expect(added.body.order.payment.state).toBe("confirmed");
    const over = await call("POST", `/api/orders/${id}/topup`, {
      cookie: staff,
      body: { method: "cash", amountMinor: 6001 },
    });
    expect(over).toMatchObject({ status: 409, body: { error: "overpay" } });
    const topped = await call("POST", `/api/orders/${id}/topup`, {
      cookie: staff,
      body: { method: "cash", amountMinor: 6000 },
    });
    expect(topped.status).toBe(200);
    expect(topped.body.order.outstandingMinor).toBe(0);
    expect(topped.body.order.payment).toMatchObject({
      amountMinor: 9000,
      topUps: [{ method: "cash", amountMinor: 6000, by: "counter-1" }],
    });
    const customer = await call("GET", `/api/orders/${id}`, { key: body.key });
    expect(customer.body.order.outstandingMinor).toBe(0);
    expect(JSON.stringify(customer.body.order)).not.toContain("counter-1");
  });
});

describe("concurrent changes", () => {
  test("a slow request body can't undo a change made while it was arriving", async () => {
    boot();
    const staff = await staffCookie();
    const { body } = await newOrder([{ itemId: "veg-momos-sf", qty: 1 }]);
    const id = body.order.id as string;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ method: "cash", amountMinor: 6000 })));
        controller.close();
      },
    });
    const confirm = app.http.request(`/api/orders/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staff },
      body: slowBody,
      duplex: "half",
    } as RequestInit);
    await new Promise((r) => setImmediate(r));
    expect((await call("POST", `/api/orders/${id}/advance`, { cookie: staff })).body.order.status).toBe("preparing");
    release();
    expect((await confirm).status).toBe(200);
    const final = (await call("GET", `/api/orders/${id}`, { cookie: staff })).body.order;
    expect(final.status).toBe("preparing");
    expect(final.payment.state).toBe("confirmed");
  });
});

describe("rate limits", () => {
  test("order create is limited per client address, but not for staff", async () => {
    boot({ limits: { orderCreate: { max: 2, windowMs: 60_000 } } });
    const staff = await staffCookie();
    expect((await newOrder()).status).toBe(201);
    expect((await newOrder()).status).toBe(201);
    const third = await newOrder();
    expect(third).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect((await newOrder(undefined, staff)).status).toBe(201);
    now += 60_000;
    expect((await newOrder()).status).toBe(201);
  });

  test("PIN attempts lock out after repeated failures, even for the right PIN", async () => {
    boot({ limits: { pinFailures: { max: 3, windowMs: 15 * 60_000 } } });
    for (let i = 0; i < 3; i++) {
      expect((await call("POST", "/api/login", { body: { user: "owner", pin: "1111" } })).status).toBe(401);
    }
    expect((await call("POST", "/api/login", { body: { user: "owner", pin: OWNER_PIN } })).status).toBe(429);
    now += 15 * 60_000;
    expect((await call("POST", "/api/login", { body: { user: "owner", pin: OWNER_PIN } })).status).toBe(200);
  });

  test("parallel wrong guesses are refused before they are checked, not after", async () => {
    boot();
    const wrong = { body: { user: "owner", pin: "1111" } };
    const results = await Promise.all(Array.from({ length: 50 }, () => call("POST", "/api/login", wrong)));
    const evaluated = results.filter((r) => r.status === 401).length;
    expect(evaluated).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(50 - evaluated);
  });

  test("a user is locked out across addresses, and each lockout lasts twice as long", async () => {
    boot({ clientIp: (c) => c.req.header("x-test-ip") ?? "none" });
    const guess = (ip: number, pin = "1111") =>
      call("POST", "/api/login", { ip: `10.0.0.${ip}`, body: { user: "owner", pin } });
    for (let i = 0; i < 10; i++) expect((await guess(i)).status).toBe(401);
    expect((await guess(50)).status).toBe(429);
    expect((await guess(51, OWNER_PIN)).status).toBe(429);
    now += 15 * 60_000;
    for (let i = 0; i < 10; i++) expect((await guess(100 + i)).status).toBe(401);
    expect((await guess(150)).status).toBe(429);
    now += 15 * 60_000;
    expect((await guess(151, OWNER_PIN)).status).toBe(429);
    now += 15 * 60_000;
    expect((await guess(152, OWNER_PIN)).status).toBe(200);
  });
});

describe("behind a reverse proxy", () => {
  const order = (xff: string) =>
    call("POST", "/api/orders", {
      headers: { "x-forwarded-for": xff },
      body: { clientKey: `proxy-key-${++keys}-abcdefgh`, lines: [{ itemId: "veg-momos-sf", qty: 1 }] },
    });

  test("ignores X-Forwarded-For and X-Forwarded-Proto unless TRUST_PROXY is set", async () => {
    boot({ limits: { orderCreate: { max: 1, windowMs: 60_000 } } });
    expect((await order("10.0.0.1")).status).toBe(201);
    expect((await order("10.0.0.2")).status).toBe(429);
    const r = await call("POST", "/api/login", {
      headers: { "x-forwarded-proto": "https" },
      body: { user: "owner", pin: OWNER_PIN },
    });
    expect(r.rawCookie).not.toMatch(/Secure/i);
  });

  test("with one trusted proxy, uses the address it saw, which a client can't spoof", async () => {
    boot({ trustProxy: 1, limits: { orderCreate: { max: 1, windowMs: 60_000 } } });
    expect((await order("9.9.9.9, 10.0.0.1")).status).toBe(201);
    expect((await order("9.9.9.9, 10.0.0.2")).status).toBe(201);
    expect((await order("8.8.8.8, 10.0.0.1")).status).toBe(429);
    const r = await call("POST", "/api/login", {
      headers: { "x-forwarded-proto": "https" },
      body: { user: "owner", pin: OWNER_PIN },
    });
    expect(r.rawCookie).toMatch(/; Secure/);
  });
});

describe("healthz", () => {
  test("answers ok without a session and writes nothing", async () => {
    boot();
    const res = await app.http.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(store.lastEventId()).toBe(0);
  });
});
