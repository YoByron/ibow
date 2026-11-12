import { randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { withAvailability } from "../src/core/config.ts";
import { earlierVisits, nameKey } from "../src/core/regulars.ts";
import { type DemoRush, seedDemo } from "../src/demo/seed.ts";
import { type App, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { dailyReport as oldReport } from "./support/old-insights.ts";
import { loadSample, readSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const DAY = 86_400_000;
// 17:30 on 26 November in the tea house's zone.
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const OWNER_PIN = "908172";
let ownerPinHash = "";
let now = t0;
let store: Store | undefined;
let app: App;

beforeAll(async () => {
  ownerPinHash = await hashPin(OWNER_PIN, TEST_PIN_COST);
});

function boot(keep?: Store): void {
  const s = keep ?? openStore(":memory:");
  store = s;
  app = createApp({ config, store: s, ownerPinHash, now: () => now });
}

afterEach(() => {
  store?.close();
  store = undefined;
  now = t0;
});

// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
type Reply = { status: number; body: any; cookie?: string };

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["x-order-key"] = opts.key;
  const res = await app.http.request(path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const reply: Reply = { status: res.status, body: await res.json() };
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) reply.cookie = setCookie.split(";")[0] as string;
  return reply;
}

async function login(user: string, pin: string): Promise<string> {
  const r = await call("POST", "/api/login", { body: { user, pin } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.cookie as string;
}

let keys = 0;
async function place(lines: unknown[], customerName?: string): Promise<{ id: string; key: string }> {
  keys++;
  const r = await call("POST", "/api/orders", {
    body: { clientKey: `owner-test-key-${keys}-abcdef`, lines, ...(customerName ? { customerName } : {}) },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.order.id, key: r.body.key };
}

const chai = { itemId: "house-special-chai", size: "M", qty: 2 };
const soda = { itemId: "masala-soda", qty: 1 };

describe("availability", () => {
  test("the overlay switches items without touching the loaded config", () => {
    const off = withAvailability(
      config,
      new Map([
        ["masala-soda", false],
        ["no-such-item", true],
      ]),
    );
    expect(off.items.get("masala-soda")?.item.available).toBe(false);
    expect(config.items.get("masala-soda")?.item.available).toBeUndefined();
    expect(withAvailability(config, new Map())).toBe(config);
  });

  test("the owner switches an item off and on; the catalog and new orders follow at once and after a restart", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    const off = await call("PUT", "/api/owner/items/masala-soda", { cookie: owner, body: { available: false } });
    expect(off).toEqual({ status: 200, body: { itemId: "masala-soda", available: false } });
    const item = (body: { categories: { items: { id: string; available?: boolean }[] }[] }) =>
      body.categories.flatMap((c) => c.items).find((i) => i.id === "masala-soda");
    expect(item((await call("GET", "/api/catalog")).body)?.available).toBe(false);
    const refused = await call("POST", "/api/orders", { body: { clientKey: "refused-key-abcdefgh", lines: [soda] } });
    expect(refused).toMatchObject({ status: 400, body: { error: "unavailable_item" } });

    // A restart reads the switch back from the store.
    boot(store);
    expect(item((await call("GET", "/api/catalog")).body)?.available).toBe(false);
    const ownerAgain = await login("owner", OWNER_PIN);
    await call("PUT", "/api/owner/items/masala-soda", { cookie: ownerAgain, body: { available: true } });
    expect(item((await call("GET", "/api/catalog")).body)?.available).toBe(true);
    await place([soda]);
  });

  test("only the owner may switch, only known items, only true or false", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    await call("PUT", "/api/staff/c1", { cookie: owner, body: { name: "C", pin: "1357" } });
    const staff = await login("c1", "1357");
    const path = "/api/owner/items/masala-soda";
    expect((await call("PUT", path, { body: { available: false } })).status).toBe(401);
    expect((await call("PUT", path, { cookie: staff, body: { available: false } })).status).toBe(403);
    expect((await call("PUT", "/api/owner/items/nope", { cookie: owner, body: { available: false } })).status).toBe(
      404,
    );
    expect((await call("PUT", path, { cookie: owner, body: { available: "no" } })).status).toBe(400);
  });
});

describe("owner routes are the owner's alone", () => {
  test("staff get 403 and a customer with an order key gets 401 on every owner read", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    for (const role of ["all", "counter", "station"]) {
      await call("PUT", `/api/staff/s-${role}`, { cookie: owner, body: { name: role, pin: "1357", role } });
    }
    const customer = await place([soda], "Asha");
    for (const path of ["/api/owner/orders", "/api/owner/insights", "/api/owner/reviews"]) {
      for (const role of ["all", "counter", "station"]) {
        const staff = await login(`s-${role}`, "1357");
        const r = await call("GET", path, { cookie: staff });
        expect(r, `${role} on ${path}`).toMatchObject({ status: 403, body: { error: "forbidden" } });
      }
      const byKey = await call("GET", path, { key: customer.key });
      expect(byKey, `order key on ${path}`).toMatchObject({ status: 401, body: { error: "no_session" } });
      expect((await call("GET", path)).status).toBe(401);
      expect((await call("GET", path, { cookie: owner })).status).toBe(200);
    }
  });
});

describe("owner orders and repeat customers", () => {
  test("names match however typed, and a visit counts once a day, only before today", () => {
    expect(nameKey("  Asha   K ")).toBe(nameKey("asha k"));
    const visits = earlierVisits(
      [
        { name: "Asha", day: "2026-11-20" },
        { name: "asha", day: "2026-11-20" },
        { name: "ASHA", day: "2026-11-24" },
        { name: "Asha", day: "2026-11-26" },
        { name: "Ravi", day: "2026-11-26" },
      ],
      "2026-11-26",
    );
    expect(visits).toEqual({ asha: 2 });
  });

  test("the day's orders in every status, with earlier visits by name within retention", async () => {
    boot();
    now = t0 - 40 * DAY;
    await place([soda], "Asha"); // past retention: forgotten, not counted
    now = t0 - 3 * DAY;
    await place([soda], "Asha");
    now = t0 - 2 * DAY;
    await place([soda], "asha ");
    now = t0;
    const a = await place([chai], "Asha");
    const b = await place([soda]);
    const owner = await login("owner", OWNER_PIN);
    await call("POST", `/api/orders/${b.id}/advance`, { cookie: owner });
    await call("POST", `/api/orders/${b.id}/advance`, { cookie: owner });

    const r = await call("GET", "/api/owner/orders", { cookie: owner });
    expect(r.status).toBe(200);
    expect(r.body.day).toBe("2026-11-26");
    expect(r.body.orders.map((o: { id: string; status: string }) => [o.id, o.status])).toEqual([
      [a.id, "pending"],
      [b.id, "completed"],
    ]);
    expect(r.body.orders[0].totalMinor).toBe(6000);
    expect(r.body.regulars).toEqual({ asha: 2 });
    expect(typeof r.body.lastEventId).toBe("number");

    const past = await call("GET", "/api/owner/orders?day=2026-11-23", { cookie: owner });
    expect(past.body.orders).toHaveLength(1);
    expect((await call("GET", "/api/owner/orders?day=26-11-2026", { cookie: owner })).status).toBe(400);
    const staffList = await call("GET", "/api/owner/orders");
    expect(staffList.status).toBe(401);
  });
});

describe("owner insights and reviews", () => {
  test("today's report from the stored orders: ordered, received (confirmed, with top-ups) and awaiting", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    now = t0 - DAY;
    const old = await place([soda]); // ordered yesterday (3000), confirmed today
    now = t0;
    const a = await place([chai]); // 6000: confirmed, then 3000 added and topped up
    const b = await place([chai, soda]); // 9000: the customer claims UPI only
    expect(
      (
        await call("POST", `/api/orders/${old.id}/confirm`, {
          cookie: owner,
          body: { method: "cash", amountMinor: 3000 },
        })
      ).status,
    ).toBe(200);
    await call("POST", `/api/orders/${a.id}/confirm`, { cookie: owner, body: { method: "cash", amountMinor: 6000 } });
    await call("POST", `/api/orders/${a.id}/lines`, { cookie: owner, body: { lines: [soda] } });
    now = t0 + 60_000;
    expect(
      (await call("POST", `/api/orders/${a.id}/topup`, { cookie: owner, body: { method: "cash", amountMinor: 3000 } }))
        .status,
    ).toBe(200);
    await call("POST", `/api/orders/${b.id}/claim`, { key: b.key, body: { method: "upi" } });
    const r = await call("GET", "/api/owner/insights", { cookie: owner });
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe("INR");
    expect(r.body.timeZone).toBe("Asia/Kolkata");
    const report = r.body.report;
    expect(report.day).toBe("2026-11-26");
    expect(report.totals).toMatchObject({
      orders: 2,
      items: 6,
      orderedMinor: 18000,
      averageMinor: 9000,
      receivedMinor: 3000 + 6000 + 3000,
      awaitingOrders: 1,
      awaitingMinor: 9000,
    });
    expect(report.hourly[17].orders).toBe(2);
    expect(report.comparison.yesterday).toMatchObject({ orders: 1, receivedMinor: 0, awaitingOrders: 0 });
    expect(report.popular.byQty[0]).toEqual({
      itemId: "house-special-chai",
      name: "House Special Chai",
      qty: 4,
      orderedMinor: 12000,
    });
    expect(JSON.stringify(report)).not.toContain("customerName");
    expect((await call("GET", "/api/owner/insights")).status).toBe(401);
  });

  test("the latest reviews with their tokens and the average rating", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    const done = async (rating: number, text?: string) => {
      const o = await place([soda]);
      await call("POST", `/api/orders/${o.id}/advance`, { cookie: owner });
      await call("POST", `/api/orders/${o.id}/advance`, { cookie: owner });
      now += 60_000;
      const r = await call("POST", `/api/orders/${o.id}/review`, { key: o.key, body: { rating, text } });
      expect(r.status).toBe(201);
    };
    await done(5, "Great chai");
    await done(2);
    const r = await call("GET", "/api/owner/reviews", { cookie: owner });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.averageRating).toBe(3.5);
    expect(
      r.body.reviews.map((x: { token: string; rating: number; text?: string }) => [x.token, x.rating, x.text]),
    ).toEqual([
      ["26-002", 2, undefined],
      ["26-001", 5, "Great chai"],
    ]);
  });
});

describe("export", () => {
  test("the owner downloads every order, payment and review as JSON, with no PIN hash and no session", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    await call("PUT", "/api/staff/s-all", { cookie: owner, body: { name: "All", pin: "1357", role: "all" } });
    await place([chai], "Asha");
    const r = await call("GET", "/api/owner/export", { cookie: owner });
    expect(r.status).toBe(200);
    expect(r.body.tables.orders).toHaveLength(1);
    expect(r.body.tables.order_lines).toHaveLength(1);
    expect(r.body.tables.payments).toHaveLength(1);
    expect(r.body.tables.staff).toEqual([{ id: "s-all", name: "All", role: "all" }]);
    expect(r.body.tables.sessions).toBeUndefined();
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("pin_hash");
    expect(text).not.toContain("pbkdf2-sha256$");
    expect(r.body.schemaVersion).toBeGreaterThan(0);
  });

  test("staff and customers cannot download it", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    await call("PUT", "/api/staff/s-all", { cookie: owner, body: { name: "All", pin: "1357", role: "all" } });
    const staff = await login("s-all", "1357");
    expect((await call("GET", "/api/owner/export", { cookie: staff })).status).toBe(403);
    expect((await call("GET", "/api/owner/export")).status).toBe(401);
  });
});

describe("older PIN hashes", () => {
  test("a staff member's scrypt hash works once and is replaced by a PBKDF2 one at that sign-in", async () => {
    boot();
    const salt = randomBytes(16);
    const key = scryptSync("1357", salt, 32, { N: 1024, r: 8, p: 1 });
    store?.putStaff({
      id: "old-hand",
      name: "Old hand",
      role: "all",
      pinHash: `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`,
    });
    expect((await call("POST", "/api/login", { body: { user: "old-hand", pin: "1357" } })).status).toBe(200);
    expect(store?.getStaff("old-hand")?.pinHash).toMatch(/^pbkdf2-sha256\$/);
    expect((await call("POST", "/api/login", { body: { user: "old-hand", pin: "1357" } })).status).toBe(200);
    expect((await call("POST", "/api/login", { body: { user: "old-hand", pin: "0000" } })).status).toBe(401);
  });
});

describe("insights cache", () => {
  test("the report is recomputed only when an event changed something or the business day turned", async () => {
    boot();
    const owner = await login("owner", OWNER_PIN);
    const s = store as Store;
    let reads = 0;
    const real = s.dayStats.bind(s);
    s.dayStats = (day, tz, opts) => {
      if (opts?.full) reads++; // today's, once per report built: finished days are read once and kept
      return real(day, tz, opts);
    };
    await place([chai], "Asha");
    const first = await call("GET", "/api/owner/insights", { cookie: owner });
    expect(first.status).toBe(200);
    expect(reads).toBe(1);
    expect((await call("GET", "/api/owner/insights", { cookie: owner })).body).toEqual(first.body);
    expect(reads).toBe(1);
    now += 5 * 60_000 * 12; // an hour of an open tab polling, with nothing happening: no recompute
    for (let k = 0; k < 12; k++) await call("GET", "/api/owner/insights", { cookie: owner });
    expect(reads).toBe(1);
    await place([soda]);
    await call("GET", "/api/owner/insights", { cookie: owner });
    expect(reads).toBe(2); // a new event
    now += 24 * 3_600_000;
    const next = await login("owner", OWNER_PIN);
    await call("GET", "/api/owner/insights", { cookie: next });
    expect(reads).toBe(3); // a new business day
  });
});

describe("report cost over a long history", { timeout: 90_000 }, () => {
  /** Every number the owner sees, from the old code over the whole history, against the app's SQL path. */
  async function sameAsOld(pastDays: number, scale: number, looks: (took: number, formatted: number) => void) {
    const history = openStore(":memory:");
    const rush = readSample("tea-house", "rush.json") as DemoRush;
    seedDemo(history, { config, rush, now: t0, upi: true, pastDays, scale });
    const everything = history.salesSince(0);
    const expected = JSON.parse(JSON.stringify(oldReport(everything, t0, config.business.timeZone)));
    for (const stored of [false, true]) {
      if (stored) while (history.closeNextDay("2026-11-26", config.business.timeZone) !== undefined);
      boot(history);
      const owner = await login("owner", OWNER_PIN);
      const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
      const started = performance.now();
      const r = await call("GET", "/api/owner/insights", { cookie: owner });
      const took = performance.now() - started;
      const formatted = parts.mock.calls.length;
      parts.mockRestore();
      console.log(
        `report over ${everything.length} orders (${stored ? "stored" : "live"} day totals): ${formatted} formatToParts, ${took.toFixed(0)} ms`,
      );
      expect(r.status).toBe(200);
      expect(r.body.report, stored ? "from stored day totals" : "from live day totals").toEqual(expected);
      looks(took, formatted);
    }
    // afterEach closes the store the app was last booted on, which is this one.
    return everything.length;
  }

  test("a 15-day history gives the old numbers with a bounded number of operations", async () => {
    const total = await sameAsOld(14, 0.5, (took, formatted) => {
      // The CPU proxy: zone conversions were thousands per request before. A timing ceiling generous for a loaded machine.
      expect(formatted, "formatToParts calls").toBeLessThan(250);
      expect(took, "ms").toBeLessThan(1500);
    });
    expect(total).toBeGreaterThan(1000);
  });

  test("a new shop with 4 days of history forecasts what the old code did (the 7-day fallback)", async () => {
    await sameAsOld(3, 0.5, () => undefined);
  });

  test("finished days are totalled one per call, oldest first, once", () => {
    const history = openStore(":memory:");
    const rush = readSample("tea-house", "rush.json") as DemoRush;
    seedDemo(history, { config, rush, now: t0, upi: true, pastDays: 3, scale: 0.2 });
    const tz = config.business.timeZone;
    const closed: string[] = [];
    for (let d = history.closeNextDay("2026-11-26", tz); d !== undefined; d = history.closeNextDay("2026-11-26", tz)) {
      closed.push(d);
    }
    expect(closed).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
    const days = history.dayRecords(["2026-11-24", "2026-11-26", "2026-11-01"], tz);
    expect([...days.keys()]).toEqual(["2026-11-24", "2026-11-26"]); // an empty day is left out, today is live
    const day = days.get("2026-11-24");
    expect(day?.hourly).toHaveLength(24);
    expect(day?.hourly.reduce((n, h) => n + h.orders, 0)).toBe(day?.orders);
    expect(day?.lines.reduce((n, l) => n + l.qty, 0)).toBe(day?.items);
    history.close();
  });
});

describe("export paging", () => {
  test("a day range picks the orders of those days; the default is the last 7 days; the range is capped", async () => {
    boot();
    await place([chai], "Asha"); // t0, 26 November
    now = t0 + 10 * DAY;
    const owner = await login("owner", OWNER_PIN); // the first session ran out meanwhile
    await place([soda]);
    const day = (offset: number) => new Date(t0 + offset * DAY).toISOString().slice(0, 10);
    const first = await call("GET", `/api/owner/export?from=${day(0)}&to=${day(1)}`, { cookie: owner });
    expect(first.status).toBe(200);
    expect(first.body.tables.orders).toHaveLength(1);
    expect(first.body.tables.order_lines).toHaveLength(1);
    expect(first.body.range).toEqual({ from: day(0), to: day(1) });
    const second = await call("GET", `/api/owner/export?from=${day(10)}&to=${day(10)}`, { cookie: owner });
    expect(second.body.tables.orders).toHaveLength(1);
    const both = await call("GET", `/api/owner/export?from=${day(0)}&to=${day(10)}`, { cookie: owner });
    expect(both.body.tables.orders).toHaveLength(2);
    // The default window is today and the six days before: the first order (ten days back) is left out.
    const byDefault = await call("GET", "/api/owner/export", { cookie: owner });
    expect(byDefault.body.tables.orders).toHaveLength(1);
    expect(byDefault.body.range.to).toBe(day(10));
    const wide = await call("GET", `/api/owner/export?from=${day(-40)}&to=${day(0)}`, { cookie: owner });
    expect(wide).toMatchObject({ status: 400, body: { error: "range_too_wide" } });
    expect((await call("GET", "/api/owner/export?from=2026-13-40&to=2026-11-01", { cookie: owner })).status).toBe(400);
    expect((await call("GET", `/api/owner/export?from=${day(5)}&to=${day(1)}`, { cookie: owner })).status).toBe(400);
  });
});
