import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  addLines,
  advanceStatus,
  createOrder,
  customerEdit,
  type LineRequest,
  markReady,
  markServed,
  OrderError,
  orderTotal,
} from "../src/core/orders.ts";
import { claimPayment, confirmPayment, topUpPayment } from "../src/core/payments.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const tz = config.business.timeZone;
// 2026-11-26 17:30 in the tea house's zone (UTC+5:30).
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const dirs: string[] = [];
const stores: Store[] = [];

function fresh(path = ":memory:"): Store {
  const store = openStore(path);
  stores.push(store);
  return store;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
function create(
  store: Store,
  lines: LineRequest[] = [{ itemId: "house-special-chai", size: "M", qty: 2 }],
  now = t0,
  key?: string,
) {
  n++;
  const id = `order-${n}`;
  return store.createOrder({
    id,
    secret: `secret-${n}`,
    clientKey: key ?? `client-key-${n}`,
    now,
    timeZone: tz,
    build: (token) => createOrder(config, { id, token, now, lines }),
  });
}

describe("store", () => {
  test("migrates a new file once and keeps its data on reopen", () => {
    const path = join(tempDir(), "ibow.db");
    const a = openStore(path);
    // The theme override is migration 13 on every branch (10 to 12 belong to the cloudflare branch).
    expect(a.schemaVersion()).toBe(25);
    const { order } = create(a);
    a.close();
    const b = fresh(path);
    expect(b.getOrder(order.id)?.order).toEqual(order);
  });

  test("issues tokens from a per-day counter in the business's zone, in the same transaction as the order", () => {
    const store = fresh();
    expect(create(store).order.token).toBe("26-001");
    expect(create(store).order.token).toBe("26-002");
    // 18:30 UTC is midnight in the tea house's zone.
    expect(create(store, undefined, Date.UTC(2026, 10, 26, 18, 30)).order.token).toBe("27-001");
  });

  test("a failed create leaves no order, no event and no used token", () => {
    const store = fresh();
    expect(() => create(store, [{ itemId: "no-such-item", qty: 1 }])).toThrow(OrderError);
    expect(store.lastEventId()).toBe(0);
    expect(create(store).order.token).toBe("26-001");
  });

  test("create is idempotent by the client key", () => {
    const store = fresh();
    const first = create(store, undefined, t0, "same-client-key-1");
    const again = create(store, [{ itemId: "veg-momos-sf", qty: 9 }], t0 + 1000, "same-client-key-1");
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.order).toEqual(first.order);
    expect(again.secret).toBe(first.secret);
    expect(again.event).toBeUndefined();
    expect(store.lastEventId()).toBe(1);
    expect(create(store).order.token).toBe("26-002");
  });

  test("round-trips every part of an order through updates, each logged as an event", () => {
    const store = fresh();
    const { order, event } = create(store, [
      { itemId: "house-special-chai", size: "M", qty: 2 },
      { itemId: "veg-momos-sf", qty: 1 },
    ]);
    expect(event).toMatchObject({ id: 1, type: "order.created", orderId: order.id, stations: ["kitchen", "tea"] });
    let o = {
      ...order,
      payment: claimPayment(order.payment, { method: "upi", amountMinor: orderTotal(order), now: t0 }),
    };
    store.saveOrder(o, "order.updated", t0 + 1);
    o = advanceStatus(o, t0 + 2);
    store.saveOrder(o, "order.status", t0 + 2);
    o = markServed(o, 0);
    o = markReady(o, "kitchen", [1]);
    o = addLines(config, o, [{ itemId: "salted-fries", qty: 1 }]);
    o = {
      ...o,
      payment: confirmPayment(o.payment, { by: "counter-1", method: "upi", amountMinor: 100, now: t0 + 3 }),
    };
    o = { ...o, payment: topUpPayment(o.payment, { by: "counter-2", method: "cash", amountMinor: 50, now: t0 + 3 }) };
    const last = store.saveOrder(o, "order.updated", t0 + 3);
    expect(last.id).toBe(4);
    expect(store.getOrder(o.id)).toEqual({ order: o, secret: `secret-${n}` });
    expect(store.eventsAfter(0, {}).map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(store.eventsAfter(2, {}).map((e) => e.type)).toEqual(["order.status", "order.updated"]);
  });

  test("an event names the stations an order touched before and after, so a removed station hears of it", () => {
    const store = fresh();
    const { order } = create(store, [
      { itemId: "house-special-chai", size: "M", qty: 1 },
      { itemId: "veg-momos-sf", qty: 1 },
    ]);
    const edited = customerEdit(config, order, [{ itemId: "house-special-chai", size: "S", qty: 1 }], t0 + 1000);
    const event = store.saveOrder(edited, "order.updated", t0 + 1000);
    expect(event.stations).toEqual(["kitchen", "tea"]);
    expect(store.saveOrder(edited, "order.updated", t0 + 2000).stations).toEqual(["tea"]);
  });

  test("filters the event log by station and by order", () => {
    const store = fresh();
    const tea = create(store, [{ itemId: "house-special-chai", size: "M", qty: 1 }]).order;
    const kitchen = create(store, [{ itemId: "veg-momos-sf", qty: 1 }]).order;
    expect(store.eventsAfter(0, { stationId: "tea" }).map((e) => e.orderId)).toEqual([tea.id]);
    expect(store.eventsAfter(0, { stationId: "kitchen" }).map((e) => e.orderId)).toEqual([kitchen.id]);
    expect(store.eventsAfter(0, { orderId: kitchen.id }).map((e) => e.id)).toEqual([2]);
    expect(store.eventsAfter(0, {}, 1).map((e) => e.id)).toEqual([1]);
  });

  test("finds an order by its token for a day, and lists open orders", () => {
    const store = fresh();
    const a = create(store).order;
    const b = create(store).order;
    store.saveOrder(advanceStatus(advanceStatus(b, t0), t0), "order.status", t0);
    expect(store.findByToken("26-001", "2026-11-26")?.id).toBe(a.id);
    expect(store.findByToken("26-001", "2026-11-27")).toBeUndefined();
    expect(store.openOrders().map((o) => o.id)).toEqual([a.id]);
  });

  test("keeps staff with hashed PINs and server-side sessions", () => {
    const store = fresh();
    store.putStaff({ id: "counter-1", name: "Counter", pinHash: "hash-1", role: "counter" });
    expect(store.getStaff("counter-1")).toEqual({
      id: "counter-1",
      name: "Counter",
      pinHash: "hash-1",
      role: "counter",
    });
    expect(store.listStaff()).toEqual([{ id: "counter-1", name: "Counter", role: "counter" }]);
    store.putSession({ idHash: "h", user: "counter-1", role: "staff", expiresAt: t0 + 10 }, t0);
    expect(store.getSession("h", t0)).toEqual({ idHash: "h", user: "counter-1", role: "staff", expiresAt: t0 + 10 });
    expect(store.getSession("h", t0 + 10)).toBeUndefined();
    store.putSession({ idHash: "h2", user: "owner", role: "owner", expiresAt: t0 + 10 }, t0);
    store.deleteSession("h2");
    expect(store.getSession("h2", t0)).toBeUndefined();
  });
});

describe("reviews", () => {
  test("keeps one review per order", () => {
    const store = fresh();
    const order = createOrder(config, { id: "o1", token: "", now: t0, lines: [{ itemId: "veg-momos-sf", qty: 1 }] });
    store.createOrder({
      id: "o1",
      secret: "s",
      clientKey: "k-review-0123456789",
      now: t0,
      timeZone: tz,
      build: (token) => ({ ...order, token }),
    });
    expect(store.getReview("o1")).toBeUndefined();
    expect(store.putReview({ orderId: "o1", rating: 4, text: "Good", at: t0 })).toBe(true);
    expect(store.putReview({ orderId: "o1", rating: 1, at: t0 + 1 })).toBe(false);
    expect(store.getReview("o1")).toEqual({ orderId: "o1", rating: 4, text: "Good", at: t0 });
  });
});

describe("event log pruning", () => {
  test("pruneEvents drops events older than the cutoff, keeps newer ones and the ids that follow", () => {
    const store = openStore(":memory:");
    const config = loadSample("tea-house");
    const make = (n: number, at: number) =>
      store.createOrder({
        id: `p-${n}`,
        secret: "s",
        clientKey: `prune-key-${n}-xxxxxxxxxx`,
        now: at,
        timeZone: config.business.timeZone,
        build: (token) =>
          createOrder(config, { id: `p-${n}`, token, now: at, lines: [{ itemId: "masala-soda", qty: 1 }] }),
      });
    make(1, 1_000);
    make(2, 2_000);
    make(3, 9_000);
    expect(store.pruneEvents(5_000)).toBe(2);
    expect(store.eventsAfter(0, {}).map((e) => e.id)).toEqual([3]);
    expect(store.lastEventId()).toBe(3);
    expect(store.getOrder("p-1")).toBeDefined(); // orders stay; only the replay log is pruned
    make(4, 9_500);
    expect(store.lastEventId()).toBe(4);
    // Pruning everything keeps the high-water mark, so a client at event 4 isn't told it is ahead of the log.
    expect(store.pruneEvents(1_000_000)).toBe(2);
    expect(store.eventsAfter(0, {})).toEqual([]);
    expect(store.lastEventId()).toBe(4);
    make(5, 20_000);
    expect(store.lastEventId()).toBe(5);
    store.close();
  });
});

describe("a database from a development build", () => {
  test("one made by main before the merge (version 13, no day totals) is refused with what to do", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-old-"));
    dirs.push(dir);
    const path = join(dir, "ibow.db");
    const first = openStore(path);
    first.close();
    // What that build left: the same tables, no day_totals, the theme override as migration 13.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE day_totals");
    raw.close();
    expect(() => openStore(path)).toThrow(
      /made by a development build before 2026-11-11; delete it \(data\/ibow\.db\)/,
    );
  });
});

describe("sections and runners (D-102, D-103)", () => {
  const cafe = loadSample("garden-cafe");
  function seated(store: Store) {
    n++;
    const id = `order-${n}`;
    return store.createOrder({
      id,
      secret: `secret-${n}`,
      clientKey: `client-key-${n}`,
      now: t0,
      timeZone: cafe.business.timeZone,
      build: (token) =>
        createOrder(cafe, { id, token, now: t0, spotId: "garden-t4", lines: [{ itemId: "carrot-cake", qty: 1 }] }),
    }).order;
  }

  test("an order keeps its spot id, and a handover who made it", () => {
    const store = fresh();
    const order = seated(store);
    expect(store.getOrder(order.id)?.order.spotId).toBe("garden-t4");
    store.saveOrder(markServed(order, 0, t0 + 60_000, "asha"), "order.updated", t0 + 60_000);
    expect(store.getOrder(order.id)?.order.lines[0]?.servedBy).toBe("asha");
  });

  test("the edited layout is one row, absent until the first edit", () => {
    const store = fresh();
    expect(store.sectionsLayout()).toBeUndefined();
    store.setSectionsLayout('[{"id":"patio","name":"Patio","spots":["P1"]}]');
    store.setSectionsLayout('[{"id":"patio","name":"Patio","spots":["P1","P2"]}]');
    expect(store.sectionsLayout()).toBe('[{"id":"patio","name":"Patio","spots":["P1","P2"]}]');
  });

  test("a section's runner holds for one business day; nobody clears it", () => {
    const store = fresh();
    store.setSectionRunner("garden", "2026-11-26", "asha");
    store.setSectionRunner("terrace", "2026-11-26", "asha");
    store.setSectionRunner("other", "2026-11-25", "ravi");
    expect(store.sectionRunners("2026-11-26")).toEqual(
      new Map([
        ["garden", "asha"],
        ["terrace", "asha"],
      ]),
    );
    store.setSectionRunner("garden", "2026-11-26", undefined);
    expect([...store.sectionRunners("2026-11-26").keys()]).toEqual(["terrace"]);
  });
});
