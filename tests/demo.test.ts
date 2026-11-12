/**
 * M6 demo mode: a seeded sample on a database marked as a demo's. The demo refuses any database it didn't make, and
 * its seed gives the owner's dashboard real numbers (today, yesterday, a forecast) and the staff screens open orders.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { aiEnv, clientBuildSkipped, prepareDemo } from "../scripts/demo.ts";
import { dailyReport } from "../src/core/insights.ts";
import { dayKey } from "../src/core/tokens.ts";
import { type DemoRush, seedDemo } from "../src/demo/seed.ts";
import { databaseKind, openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { loadSample, readSample } from "./support/samples.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const DAY = 86_400_000;
// A Wednesday evening in India, 19:10 IST.
const NOW = Date.UTC(2026, 10, 25, 13, 40);
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ibow-demo-test-"));
  dirs.push(d);
  return d;
}

describe("databaseKind", () => {
  test("tells a missing file, a demo database and a real install's database apart", () => {
    const dir = tempDir();
    const path = join(dir, "ibow.db");
    expect(databaseKind(path)).toBe("missing");
    const real = openStore(path);
    real.close();
    expect(databaseKind(path)).toBe("install");
    const demoPath = join(dir, "demo.db");
    const demo = openStore(demoPath);
    demo.markDemo();
    demo.close();
    expect(databaseKind(demoPath)).toBe("demo");
  });

  test("anything that isn't an ibow demo database counts as an install", () => {
    const path = join(tempDir(), "ibow.db");
    writeFileSync(path, "not a database");
    expect(databaseKind(path)).toBe("install");
  });
});

describe("seedDemo", { timeout: 120_000 }, () => {
  const config = loadSample("tea-house");
  const zone = config.business.timeZone;
  const rush = readSample("tea-house", "rush.json") as DemoRush;
  const hourOf = (at: number) =>
    Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(at));

  function seeded(now = NOW, upi = true): { store: Store; result: ReturnType<typeof seedDemo> } {
    const store = openStore(":memory:");
    stores.push(store);
    return { store, result: seedDemo(store, { config, rush, now, upi }) };
  }

  test("fills the 7 days before today in full and today up to now, with every token unique per day", () => {
    const { store, result } = seeded();
    expect(result.days).toBe(8);
    let total = 0;
    for (let k = 0; k <= 7; k++) {
      const orders = store.ordersOnDay(dayKey(NOW - k * DAY, zone));
      expect(orders.length, `day -${k}`).toBeGreaterThan(100);
      expect(new Set(orders.map((o) => o.token)).size).toBe(orders.length);
      total += orders.length;
    }
    expect(result.orders).toBe(total);
    expect(store.ordersOnDay(dayKey(NOW + DAY, zone))).toHaveLength(0);
    expect(store.salesSince(0).every((s) => s.createdAt <= NOW)).toBe(true);
  });

  test("a day has a morning, a lunch and an evening peak inside opening hours, quieter between", () => {
    const { store } = seeded();
    const byHour = new Array<number>(24).fill(0);
    for (let k = 1; k <= 7; k++) {
      for (const o of store.ordersOnDay(dayKey(NOW - k * DAY, zone))) {
        const h = hourOf(o.createdAt);
        byHour[h] = (byHour[h] as number) + 1;
      }
    }
    const at = (h: number) => byHour[h] as number;
    expect(byHour.slice(0, 7).every((n) => n === 0)).toBe(true);
    expect(byHour.slice(22).every((n) => n === 0)).toBe(true);
    expect(at(9)).toBeGreaterThan(2 * at(7));
    expect(at(13)).toBeGreaterThan(2 * at(15));
    expect(at(19)).toBeGreaterThan(2 * at(16));
    expect(at(10)).toBeLessThan(at(9));
    expect(at(15)).toBeLessThan(at(13));
  });

  test("today stops at now, so yesterday by now is less than yesterday's whole day", () => {
    const { store } = seeded();
    const report = dailyReport(store.salesSince(NOW - 29 * DAY), NOW, zone);
    expect(report.totals.orders).toBeGreaterThan(100);
    expect(report.totals.receivedMinor).toBeGreaterThan(0);
    expect(report.comparison.yesterdaySoFar.orders).toBeGreaterThan(100);
    expect(report.comparison.yesterdaySoFar.orders).toBeLessThan(report.comparison.yesterday.orders);
    expect(report.peak).not.toBeNull();
    expect(report.forecast.basis).toBe("same-weekday");
    expect(report.forecast.lines.length).toBeGreaterThan(0);
  });

  test("leaves today's last half hour of orders open (up to 12); every older one is completed and paid", () => {
    const { store, result } = seeded();
    const open = store.openOrders();
    expect(open.length).toBe(result.open);
    expect(open.length).toBeGreaterThanOrEqual(8);
    expect(open.length).toBeLessThanOrEqual(12);
    expect(open.every((o) => o.createdAt > NOW - 30 * 60_000)).toBe(true);
    expect(open.some((o) => o.status === "pending")).toBe(true);
    expect(open.some((o) => o.status === "preparing")).toBe(true);
    expect(open.some((o) => o.payment.state === "claimed")).toBe(true);
    const done = store.ordersOnDay(dayKey(NOW - DAY, zone));
    expect(done.every((o) => o.status === "completed" && o.payment.state === "confirmed")).toBe(true);
  });

  test("started just after local midnight: today is empty and closed, yesterday is whole", () => {
    // 00:05 IST on 26 November.
    const midnight = Date.UTC(2026, 10, 25, 18, 35);
    const { store, result } = seeded(midnight);
    expect(store.ordersOnDay(dayKey(midnight, zone))).toHaveLength(0);
    expect(result.open).toBe(0);
    expect(store.openOrders()).toHaveLength(0);
    const report = dailyReport(store.salesSince(midnight - 29 * DAY), midnight, zone);
    expect(report.totals.orders).toBe(0);
    expect(report.comparison.yesterday.orders).toBeGreaterThan(100);
    expect(report.forecast.lines.length).toBeGreaterThan(0);
    expect(store.salesSince(0).every((s) => s.createdAt <= midnight)).toBe(true);
  });

  test("names some customers more than once, so repeat badges show, and leaves some reviews", () => {
    const { store } = seeded();
    const names = store.namedOrdersSince(0).map((n) => n.name);
    expect(names.length).toBeGreaterThan(50);
    expect(new Set(names).size).toBeLessThan(names.length);
    const reviews = store.recentReviews(50);
    expect(reviews.length).toBeGreaterThan(5);
    expect(reviews.every((r) => r.rating >= 1 && r.rating <= 5 && r.at <= NOW)).toBe(true);
  });

  test("is the same for the same clock and seed", () => {
    const a = seeded();
    const b = seeded();
    expect(b.result).toEqual(a.result);
    expect(b.store.salesSince(0)).toEqual(a.store.salesSince(0));
  });

  test("pays by cash only when UPI isn't offered", () => {
    const { store } = seeded(NOW, false);
    const all = store.ordersOnDay(dayKey(NOW, zone));
    expect(all.every((o) => o.payment.state === "unpaid" || o.payment.method === "cash")).toBe(true);
  });
});

describe("prepareDemo", { timeout: 120_000 }, () => {
  test("seeds a new demo database and marks it", async () => {
    const dir = tempDir();
    const result = await prepareDemo({ sample: "tea-house", dataDir: dir, now: NOW });
    expect(databaseKind(join(dir, "ibow.db"))).toBe("demo");
    expect(result.orders).toBeGreaterThan(800);
    expect(result.pins.owner).toMatch(/^\d{6}$/);
    expect(result.pins.counter).toMatch(/^\d{4}$/);
    expect(result.pins.station).toMatch(/^\d{4}$/);
    expect(result.ownerPinHash).toMatch(/^pbkdf2-sha256\$/);
    const store = openStore(join(dir, "ibow.db"));
    stores.push(store);
    expect(store.listStaff().map((s) => [s.id, s.role])).toEqual([
      ["counter", "counter"],
      ["station", "station"],
    ]);
  });

  test("reseeds its own demo database with fresh PINs", async () => {
    const dir = tempDir();
    const first = await prepareDemo({ sample: "tea-house", dataDir: dir, now: NOW });
    const second = await prepareDemo({ sample: "tea-house", dataDir: dir, now: NOW + DAY });
    expect(second.orders).toBeGreaterThan(800);
    expect(second.ownerPinHash).not.toBe(first.ownerPinHash);
  });

  test("refuses a real install's database and leaves it untouched", async () => {
    const dir = tempDir();
    const path = join(dir, "ibow.db");
    openStore(path).close();
    const before = readFileSync(path);
    await expect(prepareDemo({ sample: "tea-house", dataDir: dir, now: NOW })).rejects.toThrow(
      /expected no database or a demo database .* found a database that is not a demo/,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  test("refuses an unknown sample", async () => {
    await expect(prepareDemo({ sample: "nope", dataDir: tempDir(), now: NOW })).rejects.toThrow(/expected one of/);
  });
});

test("npm run demo exits with an error, before building or serving, on a real install's data directory", () => {
  const dir = tempDir();
  openStore(join(dir, "ibow.db")).close();
  const run = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "scripts/demo.ts"), "--data", dir],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("not a demo");
  expect(run.stdout).not.toContain("http://");
});

test("npm run demo on a busy port says so in one line and suggests --port", async () => {
  const { createServer } = await import("node:net");
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const port = (busy.address() as { port: number }).port;
  try {
    const run = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(root, "scripts/demo.ts"), "--port", String(port)],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status).toBe(1);
    const lines = run.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`port ${port}`);
    expect(lines[0]).toContain("--port");
  } finally {
    busy.close();
  }
});

test("the demo passes the AI_ settings through from its own environment, and nothing else of it", () => {
  expect(
    aiEnv({
      AI_BASE_URL: "http://127.0.0.1:11434/v1",
      AI_MODEL: "llama3.2",
      AI_API_KEY: "",
      AI_TIMEOUT_SECONDS: "120",
      OWNER_PIN_HASH: "not-for-the-demo",
      AIRPORT: "no",
    }),
  ).toEqual({ AI_BASE_URL: "http://127.0.0.1:11434/v1", AI_MODEL: "llama3.2", AI_TIMEOUT_SECONDS: "120" });
  expect(aiEnv({})).toEqual({});
});

describe("skipping the client build", () => {
  test("only IBOW_SKIP_BUILD=1 with a built client skips it", () => {
    const dir = tempDir();
    expect(clientBuildSkipped({ IBOW_SKIP_BUILD: "1" }, dir)).toBe(false);
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    expect(clientBuildSkipped({ IBOW_SKIP_BUILD: "1" }, dir)).toBe(true);
    expect(clientBuildSkipped({}, dir)).toBe(false);
    expect(clientBuildSkipped({ IBOW_SKIP_BUILD: "0" }, dir)).toBe(false);
  });
});
