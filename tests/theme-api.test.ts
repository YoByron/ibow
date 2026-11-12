import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ConfigError } from "../src/core/config.ts";
import { DEFAULT_THEME, parseTheme } from "../src/core/theme.ts";
import { type App, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { loadLook } from "../src/server/look.ts";
import type { Look } from "../src/server/theme.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const OWNER_PIN = "908172";
let ownerPinHash = "";
let store: Store | undefined;
let app: App;
const dirs: string[] = [];

beforeAll(async () => {
  ownerPinHash = await hashPin(OWNER_PIN, TEST_PIN_COST);
});
afterEach(() => {
  store?.close();
  store = undefined;
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function boot(look: Look = { theme: DEFAULT_THEME, strings: {}, media: new Map(), imageOrigins: [] }, s?: Store) {
  store = s ?? openStore(":memory:");
  app = createApp({ config, store, ownerPinHash, look });
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: object } = {}) {
  const res = await app.http.request(path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return res;
}

async function owner(): Promise<string> {
  const r = await call("POST", "/api/login", { body: { user: "owner", pin: OWNER_PIN } });
  return (r.headers.get("set-cookie") as string).split(";")[0] as string;
}

describe("/theme.css", () => {
  test("serves the config's theme as tokens, cached by build and theme version", async () => {
    boot({ theme: parseTheme({ colors: { primary: "#1d6fd1" } }), strings: {}, media: new Map(), imageOrigins: [] });
    const res = await call("GET", "/theme.css");
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("--primary:#1d6fd1");
    const etag = res.headers.get("etag") as string;
    expect((await call("GET", "/theme.css", { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  test("an Appearance change changes the sheet and its version; a reset brings the config's theme back", async () => {
    boot();
    const cookie = await owner();
    const before = await call("GET", "/theme.css");
    const etag0 = before.headers.get("etag");
    const put = await call("PUT", "/api/owner/theme", { cookie, body: { colors: { accent: "#ff5500" } } });
    expect(put.status).toBe(200);
    const after = await call("GET", "/theme.css");
    expect(await after.text()).toContain("--accent:#ff5500");
    expect(after.headers.get("etag")).not.toBe(etag0);
    const reset = await call("DELETE", "/api/owner/theme", { cookie });
    expect(((await reset.json()) as { overridden: boolean }).overridden).toBe(false);
    expect((await call("GET", "/theme.css")).headers.get("etag")).toBe(etag0);
  });

  test("the override is kept in the store: a restarted server serves it", async () => {
    boot();
    const cookie = await owner();
    await call("PUT", "/api/owner/theme", { cookie, body: { radius: "sharp" } });
    const kept = store as Store;
    store = undefined;
    boot(undefined, kept);
    expect(await (await call("GET", "/theme.css")).text()).toContain("--r-card:2px");
  });
});

describe("the Appearance routes", () => {
  test("are the owner's alone", async () => {
    boot();
    expect((await call("GET", "/api/owner/theme")).status).toBe(401);
    expect((await call("PUT", "/api/owner/theme", { body: {} })).status).toBe(401);
    expect((await call("DELETE", "/api/owner/theme")).status).toBe(401);
    store?.putStaff({ id: "asha", name: "Asha", pinHash: await hashPin("4321", TEST_PIN_COST), role: "all" });
    const login = await call("POST", "/api/login", { body: { user: "asha", pin: "4321" } });
    const staff = (login.headers.get("set-cookie") as string).split(";")[0] as string;
    expect((await call("PUT", "/api/owner/theme", { cookie: staff, body: {} })).status).toBe(403);
  });

  test("show the config's theme, the effective one and the contrast warnings; refuse bad values with the path", async () => {
    boot();
    const cookie = await owner();
    const put = await call("PUT", "/api/owner/theme", {
      cookie,
      body: { colors: { light: { surface: "#ffffff", text: "#cccccc" } } },
    });
    const state = (await put.json()) as {
      effective: { colors: { light: { text: string } } };
      warnings: { pair: string }[];
    };
    expect(state.effective.colors.light.text).toBe("#cccccc");
    expect(state.warnings.map((w) => w.pair)).toEqual(["Text on the page, light mode"]);
    const bad = await call("PUT", "/api/owner/theme", { cookie, body: { colors: { primary: "green" } } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("colors.primary");
    const unknown = await call("PUT", "/api/owner/theme", { cookie, body: { categoryIcons: { a: "bell" } } });
    expect(unknown.status).toBe(400);
  });
});

describe("/api/theme", () => {
  test("gives the pages the toggles, the logo, the labels and a version, to anyone", async () => {
    boot({
      theme: parseTheme({ logo: "hot_beverage", features: { favourites: false } }),
      strings: { hi: { add: "जोड़ें" } },
      media: new Map(),
      imageOrigins: [],
    });
    const body = (await (await call("GET", "/api/theme")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      logo: { icon: "hot_beverage" },
      header: { style: "awning" },
      features: { favourites: false, recent: true, tags: "auto" },
      strings: { hi: { add: "जोड़ें" } },
      popular: {},
    });
    expect(body.version).toMatch(/^[0-9a-f]{10}$/);
    expect(body.etaMinutes).toBeUndefined();
  });
});

describe("loadLook", () => {
  function configDir(files: Record<string, string | Buffer>): string {
    const dir = mkdtempSync(join(tmpdir(), "ibow-look-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }
  const catalog = loadSample("tea-house").catalog;

  test("no theme file is the default look", () => {
    expect(loadLook(configDir({}), catalog).theme).toEqual(DEFAULT_THEME);
  });

  test("reads the theme, the strings per locale and the images they name; https hosts become allowed origins", () => {
    const dir = configDir({
      "theme.json": JSON.stringify({ logo: "logo.png", categoryIcons: { x: "https://img.example.com/a.png" } }),
      "strings.hi.json": JSON.stringify({ add: "जोड़ें" }),
      "logo.png": Buffer.from([1, 2, 3]),
    });
    const look = loadLook(dir, catalog);
    expect(look.strings.hi).toEqual({ add: "जोड़ें" });
    expect(look.media.get("logo.png")?.type).toBe("image/png");
    expect(look.imageOrigins).toEqual(["https://img.example.com"]);
  });

  test("fails at boot with the file and field for a bad theme, an unknown label, a lost placeholder or a missing image", () => {
    const fail = (files: Record<string, string>) => {
      try {
        loadLook(configDir(files), catalog);
      } catch (e) {
        if (e instanceof ConfigError) return e;
        throw e;
      }
      throw new Error("expected a ConfigError");
    };
    expect(fail({ "theme.json": '{"font":"comic"}' }).message).toMatch(/theme\.json: font: expected one of/);
    expect(fail({ "strings.en.json": '{"nope":"x"}' }).message).toMatch(
      /strings\.en\.json: nope: expected a known label key/,
    );
    expect(fail({ "strings.en.json": '{"payTitle":"Pay"}' }).message).toMatch(
      /payTitle: expected a text containing \{amount\}/,
    );
    expect(fail({ "theme.json": '{"logo":"gone.png"}' }).message).toMatch(/gone\.png: expected an image file/);
    expect(fail({ "strings.not_a_locale.json": "{}" }).field).toBe("");
  });

  test("the media route serves exactly the files the config named, and the policy admits only their https hosts", async () => {
    const dir = configDir({ "theme.json": '{"logo":"logo.png"}', "logo.png": Buffer.from([137, 80, 78, 71]) });
    boot(loadLook(dir, catalog));
    const ok = await call("GET", "/media/logo.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox");
    expect((await call("GET", "/media/other.png")).status).toBe(404);
    expect((await call("GET", "/media/..%2Fbusiness.json")).status).toBe(404);
  });
});
