/** The Node demo shows its throwaway PINs on the sign-in screens, like the Workers demo; a real install never does (D-035). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test, vi } from "vitest";
import { prepareDemo } from "../scripts/demo.ts";
import { DEMO_PINS_ENV, demoPinsFrom } from "../src/demo/pins.ts";
import { hashPin } from "../src/server/auth.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { startMain, stopMainProcesses } from "./support/main-process.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const pins = { owner: "246813", counter: "1357", station: "2468", manager: "3579", admin: "135790" };
const dirs: string[] = [];
afterAll(() => {
  stopMainProcesses();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("demoPinsFrom", () => {
  test("reads the PINs only for a demo database", () => {
    const env = { [DEMO_PINS_ENV]: JSON.stringify(pins) };
    expect(demoPinsFrom(env, true)).toEqual(pins);
    expect(demoPinsFrom(env, false)).toBeUndefined();
    expect(demoPinsFrom({}, true)).toBeUndefined();
    expect(demoPinsFrom({ [DEMO_PINS_ENV]: "not json" }, true)).toBeUndefined();
    expect(demoPinsFrom({ [DEMO_PINS_ENV]: JSON.stringify({ owner: "1" }) }, true)).toBeUndefined();
  });
});

describe("GET /api/demo on the Node server", () => {
  test("a demo database answers with the PINs and asks not to be indexed; a real install does neither whatever the environment holds", async () => {
    const demoDir = mkdtempSync(`${tmpdir()}/ibow-pins-demo-`);
    const realDir = mkdtempSync(`${tmpdir()}/ibow-pins-real-`);
    dirs.push(demoDir, realDir);
    await prepareDemo({ sample: "tea-house", dataDir: demoDir, now: Date.now() });
    const hash = await hashPin("908172", TEST_PIN_COST);
    const env = { [DEMO_PINS_ENV]: JSON.stringify(pins) };
    const demoBase = await startMain(demoDir, hash, env);
    const demoRes = await fetch(`${demoBase}/api/demo`);
    expect(demoRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const demo = await demoRes.json();
    expect(demo).toMatchObject({ demo: true, owner: { pin: pins.owner } });
    expect((await fetch(`${demoBase}/`)).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const realBase = await startMain(realDir, hash, env);
    expect((await fetch(`${realBase}/`)).headers.get("x-robots-tag")).toBeNull();
    const real = await (await fetch(`${realBase}/api/demo`)).text();
    expect(real).toBe('{"demo":false}');
    expect(real).not.toContain(pins.owner);
  });
});
