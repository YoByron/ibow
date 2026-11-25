import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import { CARRY_SQL, type Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("garden-cafe");
const t0 = Date.UTC(2026, 11, 1, 12, 0);
const PIN = "908172";
let hash = "";
let now = t0;
let store: Store;
let http: ReturnType<typeof createApp>["http"];

beforeAll(async () => {
  hash = await hashPin(PIN, TEST_PIN_COST);
});

afterEach(() => store.close());

function boot(): void {
  now = t0;
  store = openStore(":memory:");
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
const place = (lines: unknown, spot?: string) =>
  call("POST", "/api/orders", {
    clientKey: `garden-client-key-${++n}-abcdef`,
    lines,
    ...(spot === undefined ? {} : { spot }),
  });

async function owner(): Promise<string> {
  const r = await call("POST", "/api/login", { user: "owner", pin: PIN });
  return r.cookie as string;
}

describe("extras, notes and spots over the API", () => {
  test("the catalog hands the storefront its extras library and its zones", async () => {
    boot();
    const r = await call("GET", "/api/catalog");
    expect(r.body.extras.map((g: { id: string }) => g.id)).toContain("milk");
    expect(r.body.zones[0]).toMatchObject({ id: "garden", name: "Garden" });
    expect(r.body.zones[0].spots[3]).toEqual({ id: "garden-t4", label: "Garden T4" });
  });

  test("an order keeps its extras, note and spot through the store and every view", async () => {
    boot();
    const r = await place(
      [
        { itemId: "latte", size: "Large", qty: 1, extras: ["oat-milk", "extra-shot"], note: "extra hot" },
        { itemId: "carrot-cake", qty: 1 },
      ],
      "garden-t4",
    );
    expect(r.status).toBe(201);
    expect(r.body.order.spot).toBe("Garden T4");
    expect(r.body.order.lines[0]).toMatchObject({ unitMinor: 580, note: "extra hot" });
    expect(r.body.order.lines[0].extras.map((e: { id: string }) => e.id)).toEqual(["extra-shot", "oat-milk"]);
    const cookie = await owner();
    const staff = await call("GET", `/api/orders/${r.body.order.id}`, undefined, cookie);
    expect(staff.body.order.spot).toBe("Garden T4");
    expect(staff.body.order.lines[0].extras).toHaveLength(2);
    const bar = await call("GET", "/api/stations/bar/orders", undefined, cookie);
    expect(bar.body.orders[0].spot).toBe("Garden T4");
    expect(bar.body.orders[0].lines).toHaveLength(1);
    expect(bar.body.orders[0].lines[0].note).toBe("extra hot");
    const own = await call("GET", `/api/orders/${r.body.order.id}`, undefined, undefined, r.body.key);
    expect(own.body.order.lines[0].extras).toHaveLength(2);
  });

  test("bad extras, a long note and an unknown spot are 400s that say what was expected", async () => {
    boot();
    const extras = await place([{ itemId: "carrot-cake", qty: 1, extras: ["honey"] }]);
    expect(extras.status).toBe(400);
    expect(extras.body.error).toBe("bad_extras");
    const note = await place([{ itemId: "burrito", qty: 1, note: "n".repeat(81) }]);
    expect(note.status).toBe(400);
    expect(note.body.error).toBe("bad_note");
    const spot = await place([{ itemId: "carrot-cake", qty: 1 }], "the-moon");
    expect(spot.status).toBe(400);
    expect(spot.body.message).toMatch(/bad_spot: expected a spot id from spots\.json/);
  });

  test("a station marking ready and staff handing over stamp the times", async () => {
    boot();
    const r = await place([{ itemId: "latte", size: "Regular", qty: 1 }]);
    const cookie = await owner();
    now = t0 + 60_000;
    await call("POST", "/api/stations/bar/ready", { lines: [{ orderId: r.body.order.id, index: 0 }] }, cookie);
    now = t0 + 5 * 60_000;
    const served = await call("POST", `/api/orders/${r.body.order.id}/lines/0/served`, {}, cookie);
    expect(served.body.order.lines[0]).toMatchObject({ readyAt: t0 + 60_000, servedAt: t0 + 5 * 60_000 });
    expect(store.getOrder(r.body.order.id)?.order.lines[0]).toMatchObject({ readyAt: t0 + 60_000 });
  });
});

describe("ready to delivered on the owner's dashboard", () => {
  test("insights carry the day's average and longest wait once lines were handed over", async () => {
    boot();
    const cookie = await owner();
    const none = await call("GET", "/api/owner/insights", undefined, cookie);
    expect(none.body.carry).toBeUndefined();
    const r = await place([{ itemId: "latte", size: "Regular", qty: 1 }]);
    now = t0 + 60_000;
    await call("POST", "/api/stations/bar/ready", { lines: [{ orderId: r.body.order.id, index: 0 }] }, cookie);
    now = t0 + 4 * 60_000;
    await call("POST", `/api/orders/${r.body.order.id}/lines/0/served`, {}, cookie);
    const got = await call("GET", "/api/owner/insights", undefined, cookie);
    expect(got.body.carry).toEqual({ lines: 1, averageMs: 3 * 60_000, maxMs: 3 * 60_000 });
  });

  test("the query searches by day and never scans a table that grows with history", () => {
    boot();
    const dir = mkdtempSync(join(tmpdir(), "ibow-carry-"));
    try {
      const path = join(dir, "ibow.db");
      openStore(path).close();
      const raw = new DatabaseSync(path);
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${CARRY_SQL}`)
        .all("2026-12-01")
        .map((r) => String(r.detail));
      raw.close();
      expect(plan.filter((d) => /^SCAN (orders|order_lines|o|l)\b/.test(d))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the last-order time", () => {
  test("turns customers away after it, naming when the shop opens, while staff can still key an order in", async () => {
    boot();
    now = Date.UTC(2026, 11, 1, 18, 45);
    const turned = await place([{ itemId: "carrot-cake", qty: 1 }]);
    expect(turned.status).toBe(409);
    expect(turned.body.error).toBe("closed");
    expect(turned.body.message).toMatch(/last-order time 18:30.*we open at 09:00/);
    const cookie = await owner();
    const keyed = await call(
      "POST",
      "/api/orders",
      { clientKey: "staff-key-after-last-order-1", lines: [{ itemId: "carrot-cake", qty: 1 }] },
      cookie,
    );
    expect(keyed.status).toBe(201);
    now = Date.UTC(2026, 11, 2, 9, 0);
    expect((await place([{ itemId: "carrot-cake", qty: 1 }])).status).toBe(201);
  });
});

describe("a daily count per item", () => {
  const cake = (qty: number) => place([{ itemId: "carrot-cake", qty }]);

  test("counts down with each order, refuses what is not left, and sells out at zero", async () => {
    boot();
    const cookie = await owner();
    const set = await call("PUT", "/api/owner/items/carrot-cake", { count: 3 }, cookie);
    expect(set.body).toMatchObject({ itemId: "carrot-cake", count: 3, available: true });
    expect((await call("GET", "/api/catalog")).body.left).toEqual({ "carrot-cake": 3 });
    expect((await cake(2)).status).toBe(201);
    const over = await cake(2);
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("sold_out");
    expect(over.body.message).toMatch(/at most 1 of carrot-cake left today/);
    expect((await cake(1)).status).toBe(201);
    const gone = await cake(1);
    expect(gone.body.error).toBe("unavailable_item");
    const catalog = (await call("GET", "/api/catalog")).body;
    const item = catalog.categories
      .flatMap((c: { items: { id: string; available?: boolean }[] }) => c.items)
      .find((i: { id: string }) => i.id === "carrot-cake");
    expect(item.available).toBe(false);
  });

  test("a customer's edit gives units back or takes more, and a new day or a cleared count lifts the limit", async () => {
    boot();
    const cookie = await owner();
    await call("PUT", "/api/owner/items/carrot-cake", { count: 2 }, cookie);
    const r = await cake(2);
    const edit = (qty: number) =>
      call(
        "PUT",
        `/api/orders/${r.body.order.id}/lines`,
        { lines: [{ itemId: "carrot-cake", qty }] },
        undefined,
        r.body.key,
      );
    expect((await edit(1)).status).toBe(200);
    expect((await call("GET", "/api/catalog")).body.left).toEqual({ "carrot-cake": 1 });
    expect((await edit(3)).body.error).toBe("sold_out");
    now = t0 + 24 * 3_600_000;
    expect((await call("GET", "/api/catalog")).body.left).toBeUndefined();
    expect((await cake(5)).status).toBe(201);
    await call("PUT", "/api/owner/items/carrot-cake", { count: 1 }, cookie);
    await call("PUT", "/api/owner/items/carrot-cake", { count: null }, cookie);
    expect((await cake(5)).status).toBe(201);
  });

  test("a bad count is a 400", async () => {
    boot();
    const cookie = await owner();
    expect((await call("PUT", "/api/owner/items/carrot-cake", { count: -1 }, cookie)).status).toBe(400);
    expect((await call("PUT", "/api/owner/items/carrot-cake", {}, cookie)).status).toBe(400);
  });
});

describe("card and refunds over the API", () => {
  const pay = (id: string, cookie: string, method: string, amountMinor: number) =>
    call("POST", `/api/orders/${id}/confirm`, { method, amountMinor }, cookie);

  test("card is a method only where the business takes it; the tea house has no terminal", async () => {
    boot();
    const cookie = await owner();
    const r = await place([{ itemId: "carrot-cake", qty: 1 }]);
    const total = r.body.order.totalMinor;
    expect((await call("GET", "/api/catalog")).body.payments.card).toBe(true);
    const ok = await pay(r.body.order.id, cookie, "card", total);
    expect(ok.status).toBe(200);
    expect(ok.body.order.payment).toMatchObject({ state: "confirmed", method: "card", by: "owner" });
    const bad = await call(
      "POST",
      `/api/orders/${r.body.order.id}/confirm`,
      { method: "cheque", amountMinor: 1 },
      cookie,
    );
    expect(bad.status).toBe(400);
  });

  test("a refund records amount, method, who and when; it shows in the owner's totals and the export", async () => {
    boot();
    const cookie = await owner();
    const r = await place([{ itemId: "carrot-cake", qty: 2 }]);
    const id = r.body.order.id as string;
    const total = r.body.order.totalMinor as number;
    // Ordered is not Received: nothing can be refunded before a person confirmed money.
    const early = await call("POST", `/api/orders/${id}/refund`, { method: "card", amountMinor: 100 }, cookie);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("bad_state");
    await pay(id, cookie, "card", total);
    const back = await call("POST", `/api/orders/${id}/refund`, { method: "card", amountMinor: 150 }, cookie);
    expect(back.status).toBe(200);
    expect(back.body.order.payment.refunds).toEqual([{ method: "card", amountMinor: 150, at: t0, by: "owner" }]);
    const over = await call("POST", `/api/orders/${id}/refund`, { method: "card", amountMinor: total }, cookie);
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("over_refund");
    const wrong = await call("POST", `/api/orders/${id}/refund`, { method: "cash", amountMinor: 1 }, cookie);
    expect(wrong.body.error).toBe("over_refund");
    const stats = store.dayStats("2026-12-01", config.business.timeZone);
    expect(stats.orderedMinor).toBe(total);
    expect(stats.receivedMinor).toBe(total - 150);
    expect(stats.receivedCardMinor).toBe(total - 150);
    const insights = await call("GET", "/api/owner/insights", undefined, cookie);
    expect(insights.body.report.totals.receivedCardMinor).toBe(total - 150);
    const exported = await call("GET", "/api/owner/export?from=2026-12-01&to=2026-12-01", undefined, cookie);
    expect(exported.body.tables.payment_refunds).toHaveLength(1);
    expect(exported.body.tables.payment_refunds[0]).toMatchObject({
      amount_minor: 150,
      method: "card",
      by_staff: "owner",
    });
    // Nobody signed out may refund.
    expect((await call("POST", `/api/orders/${id}/refund`, { method: "card", amountMinor: 1 })).status).toBe(401);
  });
});
