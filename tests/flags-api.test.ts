/**
 * Feature flags (D-075): the owner flips the look and menu switches, the admin the system ones; every flip is audited, and
 * a flipped switch reaches what an open page reads without a reload.
 */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { checkFlag, diffFeatures, FlagError, lookFlags, SYSTEM_FLAGS } from "../src/core/flags.ts";
import { DEFAULT_THEME } from "../src/core/theme.ts";
import { type App, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const PINS = { owner: "908172", admin: "445566" };
const t0 = Date.UTC(2026, 11, 1, 12, 0);
let hashes = { owner: "", admin: "" };
let store: Store;
let app: App;
let now = t0;

beforeAll(async () => {
  hashes = { owner: await hashPin(PINS.owner, TEST_PIN_COST), admin: await hashPin(PINS.admin, TEST_PIN_COST) };
});
afterEach(() => (store as Store | undefined)?.close());

function boot(ai = false): void {
  now = t0;
  store = openStore(":memory:");
  app = createApp({
    config,
    store,
    ownerPinHash: hashes.owner,
    adminPinHash: hashes.admin,
    look: { theme: DEFAULT_THEME, strings: {}, media: new Map(), imageOrigins: [] },
    now: () => now,
    ...(ai ? { ai: { complete: async () => "{}" } } : {}),
  });
}

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await app.http.request(path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const login = async (user: string, pin: string) => (await call("POST", "/api/login", { user, pin })).cookie as string;

describe("the definitions", () => {
  test("a look flag per feature, a value is checked against what the flag takes, and the message says what was expected", () => {
    const defs = lookFlags(DEFAULT_THEME.features);
    expect(defs.map((d) => d.key)).toEqual(Object.keys(DEFAULT_THEME.features).map((k) => `features.${k}`));
    const tags = defs.find((d) => d.key === "features.tags");
    expect(checkFlag(tags as never, "off")).toBe("off");
    expect(() => checkFlag(tags as never, "sometimes")).toThrow(
      /expected one of off, catalog, auto, found "sometimes"/,
    );
    const retention = SYSTEM_FLAGS.find((d) => d.key === "retentionDays");
    expect(() => checkFlag(retention as never, 0)).toThrow(FlagError);
    expect(() => checkFlag(retention as never, 3651)).toThrow(/from 1 to 3650/);
    expect(checkFlag(retention as never, 7)).toBe(7);
  });

  test("two themes' features differ in exactly the flags that changed", () => {
    expect(diffFeatures(DEFAULT_THEME.features, { ...DEFAULT_THEME.features, cartEta: false, tags: "off" })).toEqual([
      { key: "features.tags", from: "auto", to: "off" },
      { key: "features.cartEta", from: true, to: false },
    ]);
    expect(diffFeatures(DEFAULT_THEME.features, DEFAULT_THEME.features)).toEqual([]);
  });
});

describe("who may flip what", () => {
  test("the owner holds the look flags, the admin the system ones, and neither sees the other's", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const admin = await login("admin", PINS.admin);
    const o = await call("GET", "/api/flags", undefined, owner);
    expect(o.body.flags.every((f: { scope: string }) => f.scope === "look")).toBe(true);
    const a = await call("GET", "/api/flags", undefined, admin);
    expect(a.body.flags.map((f: { key: string }) => f.key)).toEqual(["ai", "retentionDays", "showcase"]);
    expect((await call("PUT", "/api/flags/retentionDays", { value: 7 }, owner)).status).toBe(403);
    expect((await call("PUT", "/api/flags/features.veg", { value: false }, admin)).status).toBe(403);
    expect((await call("PUT", "/api/flags/features.veg", { value: false })).status).toBe(401);
    expect((await call("PUT", "/api/flags/nothing", { value: true }, owner)).body.error).toBe("no_such_flag");
    // Signed out, an unknown key is a 401 like any other: the 404 that names every switch is for signed-in people only.
    const stranger = await call("PUT", "/api/flags/nothing", { value: true });
    expect(stranger.status).toBe(401);
    expect(JSON.stringify(stranger.body)).not.toContain("retentionDays");
    const bad = await call("PUT", "/api/flags/retentionDays", { value: "soon" }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_flag_value");
  });
});

describe("a look flag flipped by the owner", () => {
  test("changes what an open storefront reads (its version and its features), and is audited", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const before = (await call("GET", "/api/theme")).body;
    expect(before.features.cartEta).toBe(true);
    now += 60_000;
    const put = await call("PUT", "/api/flags/features.cartEta", { value: false }, owner);
    expect(put.status).toBe(200);
    const after = (await call("GET", "/api/theme")).body;
    expect(after.features.cartEta).toBe(false);
    // The storefront polls the version, so the switch must move it even though no colour changed.
    expect(after.version).not.toBe(before.version);
    const audit = (await call("GET", "/api/flags", undefined, owner)).body.audit;
    expect(audit).toEqual([
      {
        id: expect.any(Number),
        at: t0 + 60_000,
        by: "owner",
        level: "owner",
        key: "features.cartEta",
        from: true,
        to: false,
      },
    ]);
    // Flipping to the value it already has is not a change, so nothing is audited.
    await call("PUT", "/api/flags/features.cartEta", { value: false }, owner);
    expect((await call("GET", "/api/flags", undefined, owner)).body.audit).toHaveLength(1);
  });

  test("the Appearance screen's saves are audited the same way, and a reset too", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    expect((await call("PUT", "/api/owner/theme", { features: { veg: false, tiles: "photos" } }, owner)).status).toBe(
      200,
    );
    expect((await call("DELETE", "/api/owner/theme", undefined, owner)).status).toBe(200);
    const audit = (await call("GET", "/api/flags", undefined, owner)).body.audit as {
      key: string;
      from: unknown;
      to: unknown;
    }[];
    const rows = audit.map((a) => `${a.key}:${a.from}>${a.to}`).sort();
    expect(rows).toEqual([
      "features.tiles:always>photos",
      "features.tiles:photos>always",
      "features.veg:false>true",
      "features.veg:true>false",
    ]);
  });
});

describe("system flags flipped by the admin", () => {
  test("retention days apply to the next pass and the owner's repeat-customer window, and are audited", async () => {
    boot();
    const admin = await login("admin", PINS.admin);
    expect(app.retentionDays()).toBe(30);
    const put = await call("PUT", "/api/flags/retentionDays", { value: 7 }, admin);
    expect(put.body).toEqual({ key: "retentionDays", value: 7 });
    expect(app.retentionDays()).toBe(7);
    const audit = (await call("GET", "/api/flags", undefined, admin)).body.audit;
    expect(audit[0]).toMatchObject({ by: "admin", level: "admin", key: "retentionDays", from: 30, to: 7 });
    // It is kept in the install: a restart reads it back.
    const again = createApp({ config, store, ownerPinHash: hashes.owner, now: () => now });
    expect(again.retentionDays()).toBe(7);
  });

  test("the AI analyst is switched off at run time, and never on where no model is set up", async () => {
    boot(true);
    const owner = await login("owner", PINS.owner);
    const admin = await login("admin", PINS.admin);
    expect((await call("GET", "/api/owner/ai", undefined, owner)).body).toEqual({ on: true });
    await call("PUT", "/api/flags/ai", { value: false }, admin);
    expect((await call("GET", "/api/owner/ai", undefined, owner)).body).toEqual({ on: false });
    const ask = await call("POST", "/api/owner/ask", { question: "How was today?" }, owner);
    expect(ask.status).toBe(409);
    expect(ask.body.error).toBe("ai_off");
    store.close();
    boot(false);
    const a2 = await login("admin", PINS.admin);
    const flags = (await call("GET", "/api/flags", undefined, a2)).body.flags;
    expect(flags.find((f: { key: string }) => f.key === "ai").note).toMatch(/No model is set up/);
  });

  test("showcase is served only while the switch is on", async () => {
    boot();
    const admin = await login("admin", PINS.admin);
    expect(app.showcaseOn()).toBe(false);
    await call("PUT", "/api/flags/showcase", { value: true }, admin);
    expect(app.showcaseOn()).toBe(true);
  });
});
