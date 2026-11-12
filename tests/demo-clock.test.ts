/** A demo's fixed clock (D-054): honoured by a demo database, ignored by a real install, for any value. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { prepareDemo } from "../scripts/demo.ts";
import { localTime } from "../src/core/insights.ts";
import { DEMO_NOW_ENV, instantOn, serverClock } from "../src/demo/clock.ts";
import { hashPin } from "../src/server/auth.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { startMain, stopMainProcesses } from "./support/main-process.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const FIXED = Date.UTC(2026, 5, 15, 13, 0, 0);

describe("serverClock", () => {
  test("a demo database stands at the fixed instant", () => {
    const clock = serverClock({ [DEMO_NOW_ENV]: String(FIXED) }, true);
    expect(clock.now()).toBe(FIXED);
    expect(clock.ignored).toBe(false);
  });

  test("a real install ignores it, whatever it holds, and says so", () => {
    for (const value of [String(FIXED), "0", "garbage", "-5"]) {
      const before = Date.now();
      const clock = serverClock({ [DEMO_NOW_ENV]: value }, false);
      expect(clock.now(), value).toBeGreaterThanOrEqual(before);
      expect(clock.ignored, value).toBe(true);
    }
  });

  test("unset or empty is the real clock, and a demo refuses a value that is not a time", () => {
    expect(serverClock({}, true).now()).toBeGreaterThan(FIXED);
    expect(serverClock({ [DEMO_NOW_ENV]: "" }, true).ignored).toBe(false);
    expect(() => serverClock({ [DEMO_NOW_ENV]: "6:30 PM" }, true)).toThrow(/expected IBOW_DEMO_NOW to be a time/);
  });
});

const dirs: string[] = [];
afterAll(() => {
  stopMainProcesses();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** The order time the server at `dataDir` stamps, with `IBOW_DEMO_NOW` in its environment. */
async function orderTimeOn(dataDir: string, ownerPinHash: string): Promise<number> {
  const base = await startMain(dataDir, ownerPinHash, { [DEMO_NOW_ENV]: String(FIXED) });
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientKey: "clock-test-order-0001",
      lines: [{ itemId: "house-special-chai", size: "M", qty: 1 }],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { order: { createdAt: number } }).order.createdAt;
}

describe("the server process", () => {
  test("the demo's server runs at the fixed time and a real install's server ignores the same setting", async () => {
    const demoDir = mkdtempSync(join(tmpdir(), "ibow-clock-demo-"));
    const realDir = mkdtempSync(join(tmpdir(), "ibow-clock-real-"));
    dirs.push(demoDir, realDir);
    await prepareDemo({ sample: "tea-house", dataDir: demoDir, now: FIXED });
    const hash = await hashPin("908172", TEST_PIN_COST);
    expect(await orderTimeOn(demoDir, hash)).toBe(FIXED);
    const before = Date.now();
    const real = await orderTimeOn(realDir, hash);
    expect(real).toBeGreaterThanOrEqual(before);
    expect(real).not.toBe(FIXED);
  });
});

describe("instantOn", () => {
  const at = Date.parse("2026-11-11T12:00:00Z");
  test("is 18:30 on the current business day of the zone, east or west of UTC", () => {
    for (const zone of ["Asia/Kolkata", "Pacific/Auckland", "America/New_York", "Pacific/Honolulu", "Asia/Dubai"]) {
      const want = localTime(at, zone).day;
      const t = localTime(instantOn(zone, at, 18, 30), zone);
      expect(t, zone).toEqual({ day: want, hour: 18, minute: 30 });
    }
  });
  test("follows the zone's own day when it has already turned over", () => {
    // 22:00 UTC on the 11th is already the 12th in Auckland and still the 11th in Honolulu.
    const late = Date.parse("2026-11-11T22:00:00Z");
    expect(localTime(instantOn("Pacific/Auckland", late, 18, 30), "Pacific/Auckland").day).toBe("2026-11-12");
    expect(localTime(instantOn("Pacific/Honolulu", late, 18, 30), "Pacific/Honolulu").day).toBe("2026-11-11");
  });
});
