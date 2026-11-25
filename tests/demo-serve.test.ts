/** The demo as a long-running service: a persistent database, seeded once, the same PINs after a restart, clean stop. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { serveDemo } from "../scripts/demo-serve.ts";
import { databaseKind, openStore } from "../src/store/node.ts";

vi.setConfig({ testTimeout: 120_000 });
const dirs: string[] = [];
const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ibow-serve-"));
  dirs.push(d);
  return d;
};
async function start(dataDir: string, extra: Record<string, string> = {}) {
  const s = await serveDemo({ dataDir, port: 0, host: "127.0.0.1", env: extra, quiet: true });
  running.push(s);
  return s;
}
const demoInfo = async (base: string) => (await (await fetch(`${base}/api/demo`)).json()) as Record<string, unknown>;
const orderCount = (db: string) => {
  const s = openStore(db);
  try {
    return s.openOrders().length;
  } finally {
    s.close();
  }
};

describe("serveDemo", () => {
  test("seeds an empty data directory once; a restart keeps the data and the throwaway PINs", async () => {
    const dir = tempDir();
    const first = await start(dir);
    expect(first.seeded).toBe(true);
    expect(databaseKind(join(dir, "ibow.db"))).toBe("demo");
    const a = await demoInfo(first.base);
    expect(a.demo).toBe(true);
    const pins = JSON.stringify(a);
    // A visitor's order made while it runs must survive the restart.
    const made = await fetch(`${first.base}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientKey: "visitor-order-00001",
        lines: [{ itemId: "house-special-chai", size: "M", qty: 1 }],
      }),
    });
    expect(made.status).toBe(201);
    await first.stop();
    const before = orderCount(join(dir, "ibow.db"));

    const second = await start(dir);
    expect(second.seeded).toBe(false);
    expect(JSON.stringify(await demoInfo(second.base))).toBe(pins);
    await second.stop();
    expect(orderCount(join(dir, "ibow.db"))).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  test("serves the showcase and /healthz, with the analyst off even when AI settings are in the environment", async () => {
    const s = await start(tempDir(), { AI_BASE_URL: "http://127.0.0.1:9/v1", AI_MODEL: "x" });
    expect((await fetch(`${s.base}/showcase`)).status).toBe(200);
    const health = await fetch(`${s.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect((await fetch(`${s.base}/owner-ai.js`)).status).toBe(404);
  });

  test("stops cleanly on request: the server is gone and the data is kept", async () => {
    const dir = tempDir();
    const s = await start(dir);
    await s.stop();
    await expect(fetch(`${s.base}/healthz`)).rejects.toThrow();
    expect(existsSync(join(dir, "ibow.db"))).toBe(true);
  });

  test("refuses a real install's database and leaves it as it is", async () => {
    const dir = tempDir();
    openStore(join(dir, "ibow.db")).close();
    await expect(serveDemo({ dataDir: dir, port: 0, quiet: true })).rejects.toThrow("not a demo");
    expect(databaseKind(join(dir, "ibow.db"))).toBe("install");
  });

  test("a demo database whose PINs file is gone is seeded afresh rather than left without PINs", async () => {
    const dir = tempDir();
    const first = await start(dir);
    await first.stop();
    rmSync(join(dir, "demo-pins.json"));
    const again = await start(dir);
    expect(again.seeded).toBe(true);
    expect((await demoInfo(again.base)).demo).toBe(true);
  });

  test("the PINs file is plain JSON with the five throwaway PINs", async () => {
    const dir = tempDir();
    const s = await start(dir);
    const saved = JSON.parse(readFileSync(join(dir, "demo-pins.json"), "utf8")) as { pins: Record<string, string> };
    expect(Object.keys(saved.pins).sort()).toEqual(["admin", "counter", "manager", "owner", "station"]);
    writeFileSync(join(dir, "note"), "x");
    await s.stop();
  });
});
