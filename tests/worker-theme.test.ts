/**
 * The look on Workers (D-052): the config's theme, strings and images are bundled like the business, `/theme.css` and
 * `/api/theme` come from the Durable Object, the owner's Appearance is saved in it, and the policy names the image hosts.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { hashPin } from "../src/server/auth.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { type RunningWorker, startWorker } from "./support/worker.ts";

vi.setConfig({ testTimeout: 90_000 });
const OWNER_PIN = "908172";
const running: RunningWorker[] = [];
const dirs: string[] = [];
async function start(opts: Parameters<typeof startWorker>[0]): Promise<RunningWorker> {
  const w = await startWorker({ env: { OWNER_PIN_HASH: await hashPin(OWNER_PIN, TEST_PIN_COST) }, ...opts });
  running.push(w);
  return w;
}
afterAll(async () => {
  for (const w of running) await w.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const samples = fileURLToPath(new URL("../samples/", import.meta.url));
async function signIn(base: string, user: string, pin: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, pin }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") as string).split(";")[0] as string;
}
const put = (base: string, cookie: string, body: unknown) =>
  fetch(`${base}/api/owner/theme`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

let desk: Promise<RunningWorker> | undefined;
/** The service desk sample: a theme, its own words and a logo file, none of which a Worker can read from disk. */
const deskWorker = () => {
  desk ??= start({ dir: join(samples, "service-desk") });
  return desk;
};

describe("the look on a Worker", () => {
  test("loads the config's theme, its words and its logo through the bundle", async () => {
    const w = await deskWorker();
    const css = await fetch(`${w.base}/theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("#1d5fd1");
    const theme = (await (await fetch(`${w.base}/api/theme`)).json()) as {
      strings: { en?: { placeOrder?: string } };
      logo?: { image: string };
      features: { favourites: boolean };
    };
    expect(theme.strings.en?.placeOrder).toBe("Submit request");
    expect(theme.logo?.image).toBe("logo.svg");
    expect(theme.features.favourites).toBe(false);
    const logo = await fetch(`${w.base}/media/logo.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect((await fetch(`${w.base}/media/nothing.png`)).status).toBe(404);
  });

  test("/theme.css carries the client build id, so the service worker caches it with its own build", async () => {
    const w = await deskWorker();
    const css = await fetch(`${w.base}/theme.css`);
    const build = (await (await fetch(`${w.base}/build.txt`)).text()).trim();
    expect(css.headers.get("x-ibow-build")).toBe(build);
    const etag = css.headers.get("etag") as string;
    const again = await fetch(`${w.base}/theme.css`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  test("the owner's Appearance saves in the object, reaches /theme.css, /api/theme and the manifest, and resets", async () => {
    const w = await deskWorker();
    const cookie = await signIn(w.base, "owner", OWNER_PIN);
    expect((await fetch(`${w.base}/api/owner/theme`)).status).toBe(401);
    const before = (await (await fetch(`${w.base}/api/theme`)).json()) as { version: string };
    const saved = await put(w.base, cookie, { colors: { header: "#7a1d1d" } });
    expect(saved.status).toBe(200);
    const state = (await saved.json()) as { overridden: boolean; version: string };
    expect(state.overridden).toBe(true);
    expect(state.version).not.toBe(before.version);
    expect(await (await fetch(`${w.base}/theme.css`)).text()).toContain("#7a1d1d");
    expect(((await (await fetch(`${w.base}/api/theme`)).json()) as { version: string }).version).toBe(state.version);
    const manifest = (await (await fetch(`${w.base}/manifest.webmanifest`)).json()) as { theme_color: string };
    expect(manifest.theme_color).toBe("#7a1d1d");
    expect((await put(w.base, cookie, { font: "comic" })).status).toBe(400);
    const reset = await fetch(`${w.base}/api/owner/theme`, { method: "DELETE", headers: { cookie } });
    expect(((await reset.json()) as { overridden: boolean }).overridden).toBe(false);
    expect(await (await fetch(`${w.base}/theme.css`)).text()).not.toContain("#7a1d1d");
    const after = (await (await fetch(`${w.base}/manifest.webmanifest`)).json()) as { theme_color: string };
    expect(after.theme_color).toBe("#0b2a5b");
  });

  test("the policy of the owner's page and of the static pages admits the config's https image hosts, and no other", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-look-cfg-"));
    dirs.push(dir);
    cpSync(join(samples, "tea-house"), dir, { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ logo: "https://img.example.com/logo.png" }));
    const w = await start({ dir });
    const owner = await fetch(`${w.base}/owner`);
    expect(owner.headers.get("content-security-policy")).toContain("img-src 'self' data: https://img.example.com;");
    const store = await fetch(`${w.base}/`);
    expect(store.headers.get("content-security-policy")).toContain("img-src 'self' data: https://img.example.com;");
    const plain = (await deskWorker()).base;
    expect((await fetch(`${plain}/owner`)).headers.get("content-security-policy")).toContain("img-src 'self' data:;");
  });
});

describe("the storefront figures on the Durable Object's SQL", () => {
  test("cost a bounded number of rows: nothing on a read, a few thousand on a save, against a 300-order day", async () => {
    const w = await start({ env: { DEMO: "1" } });
    const demo = (await (await fetch(`${w.base}/api/demo`)).json()) as { owner: { pin: string } };
    const cookie = await signIn(w.base, "owner", demo.owner.pin);
    const rows = async () => ((await (await w.internal("/__stats")).json()) as { rowsRead: number }).rowsRead;
    const first = await fetch(`${w.base}/api/theme`);
    expect(first.status).toBe(200);
    const read = await rows();
    for (let i = 0; i < 5; i++) await fetch(`${w.base}/api/theme`);
    expect(await rows(), "reads come from the cache").toBe(read);
    const saved = await put(w.base, cookie, { colors: { accent: "#ffb020" } });
    expect(saved.status).toBe(200);
    const cost = (await rows()) - read;
    expect(cost, "a save recomputes the two figures").toBeGreaterThan(0);
    expect(cost, "and stays far under the free plan's 5 million reads a day").toBeLessThan(20_000);
  });
});
