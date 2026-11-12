/** The Worker and its Durable Object, run for real in workerd (Miniflare): routing, sign-in, retention, demo mode. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { demoMode } from "../src/demo/mode.ts";
import { hashPin } from "../src/server/auth.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import {
  COMPATIBILITY_DATE,
  DEMO_WORKER_FIRST,
  type RunningWorker,
  startWorker,
  tempDir,
  WORKER_FIRST,
} from "./support/worker.ts";

vi.setConfig({ testTimeout: 90_000 });
const ITEM = "house-special-chai";
const OWNER_PIN = "908172";
const running: RunningWorker[] = [];
async function start(opts: Parameters<typeof startWorker>[0] = {}): Promise<RunningWorker> {
  const w = await startWorker(opts);
  running.push(w);
  return w;
}
afterAll(async () => {
  for (const w of running) await w.stop();
});

let real: Promise<RunningWorker> | undefined;
/** One real install and one demo install shared by the tests that only read or add to them, since each boot costs seconds. */
const realWorker = () => {
  real ??= realEnv().then((env) => start({ env }));
  return real;
};
let demo: Promise<RunningWorker> | undefined;
const demoWorker = () => {
  demo ??= start({ env: { DEMO: "1" } });
  return demo;
};

async function post(base: string, path: string, body: unknown, cookie?: string, method = "POST") {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function realEnv(): Promise<Record<string, string>> {
  return { OWNER_PIN_HASH: await hashPin(OWNER_PIN, TEST_PIN_COST) };
}

describe("the showcase page", () => {
  const paths = ["/showcase", "/showcase.html", "/showcase.css", "/showcase/storefront.png"];

  test("a demo serves it by default, with the strict policy", async () => {
    const d = await demoWorker();
    const page = await fetch(`${d.base}/showcase`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("ibow showcase");
    for (const path of paths) expect((await fetch(d.base + path)).status, path).toBe(200);
  });

  test("a real install serves it only with showcase: true in business.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-showcase-"));
    try {
      const sample = join(import.meta.dirname, "..", "samples", "tea-house");
      const business = JSON.parse(readFileSync(join(sample, "business.json"), "utf8")) as Record<string, unknown>;
      for (const f of ["catalog.json", "stations.json"]) writeFileSync(join(dir, f), readFileSync(join(sample, f)));
      writeFileSync(join(dir, "business.json"), JSON.stringify({ ...business, showcase: true }));
      const on = await start({ dir, env: await realEnv() });
      const page = await fetch(`${on.base}/showcase`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
      for (const path of paths) expect((await fetch(on.base + path)).status, path).toBe(200);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("a real install", () => {
  test("serves the client with its headers, the manifest by business name, and the API from the Durable Object", async () => {
    const w = await realWorker();
    const home = await fetch(`${w.base}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<html");
    const staff = await fetch(`${w.base}/staff`);
    expect(staff.status).toBe(200);
    // The ibow showcase is off on a real install unless business.json opts in (D-055).
    for (const path of ["/showcase", "/showcase.html", "/showcase.css", "/showcase/storefront.png"]) {
      expect((await fetch(`${w.base}${path}`)).status, path).toBe(404);
    }
    const owner = await fetch(`${w.base}/owner`);
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await owner.text()).not.toContain("owner-ai.js");
    expect((await fetch(`${w.base}/owner-ai.js`)).status).toBe(404);
    const manifest = (await (await fetch(`${w.base}/manifest.webmanifest`)).json()) as { name: string };
    expect(manifest.name).toBe("The Tea House");
    const catalog = await fetch(`${w.base}/api/catalog`);
    expect(catalog.status).toBe(200);
    expect(((await catalog.json()) as { business: { name: string } }).business.name).toBe("The Tea House");
  });

  test("owner sign-in (PBKDF2 through WebCrypto) works, a wrong PIN does not, and sessions persist in the object", async () => {
    const w = await realWorker();
    expect((await post(w.base, "/api/login", { user: "owner", pin: "000000" })).res.status).toBe(401);
    const ok = await post(w.base, "/api/login", { user: "owner", pin: OWNER_PIN });
    expect(ok.res.status).toBe(200);
    const made = await post(w.base, "/api/staff/counter-1", { name: "Counter", pin: "1357" }, ok.cookie, "PUT");
    expect(made.res.status).toBe(200);
    expect((await post(w.base, "/api/login", { user: "counter-1", pin: "1357" })).res.status).toBe(200);
  });

  test("no request path does more than one PIN derivation (a free-plan request has 10 ms of CPU)", async () => {
    const w = await start({ env: await realEnv() });
    const derivations = async () =>
      ((await (await w.internal("/__stats")).json()) as { pinDerivations: number }).pinDerivations;
    expect(await derivations()).toBe(0); // booting checks the hash's shape and derives nothing
    await fetch(`${w.base}/api/catalog`);
    expect(await derivations()).toBe(0);
    await post(w.base, "/api/login", { user: "owner", pin: OWNER_PIN });
    expect(await derivations()).toBe(1);
    await post(w.base, "/api/login", { user: "owner", pin: "000000" });
    expect(await derivations()).toBe(2);
    await post(w.base, "/api/login", { user: "nobody", pin: "123456" }); // an unknown id costs one, the dummy hash
    expect(await derivations()).toBe(3);
    await post(w.base, "/api/login", { user: "owner", pin: "abc" }); // a malformed PIN is checked against the dummy
    expect(await derivations()).toBe(4);
  });

  test("a staff PIN is hashed once when the owner sets it", async () => {
    const w = await start({ env: await realEnv() });
    const owner = (await post(w.base, "/api/login", { user: "owner", pin: OWNER_PIN })).cookie as string;
    const before = ((await (await w.internal("/__stats")).json()) as { pinDerivations: number }).pinDerivations;
    await post(w.base, "/api/staff/counter-9", { name: "Counter", pin: "1357" }, owner, "PUT");
    const after = ((await (await w.internal("/__stats")).json()) as { pinDerivations: number }).pinDerivations;
    expect(after - before).toBe(1);
  });

  test("an old scrypt OWNER_PIN_HASH is refused at boot, telling the owner to re-run hash-pin", async () => {
    const old = ["scrypt", "1024", "8", "1", "s".repeat(22), "k".repeat(43)].join("$");
    const w = await start({ env: { OWNER_PIN_HASH: old } });
    const res = await fetch(`${w.base}/api/catalog`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("re-run npm run hash-pin");
  });

  test("never answers with a PIN: the demo route says false, and no PIN anywhere in what it serves", async () => {
    const w = await realWorker();
    expect(await (await fetch(`${w.base}/api/demo`)).json()).toEqual({ demo: false });
    for (const path of ["/", "/staff", "/owner", "/api/catalog"]) {
      const text = await (await fetch(w.base + path)).text();
      expect(text, path).not.toMatch(/Demo PIN|demo PIN|"pin"/);
    }
  });

  test("refuses to start without the owner PIN hash, saying what to run", async () => {
    const w = await start({ env: {} });
    const res = await fetch(`${w.base}/api/catalog`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("wrangler secret put OWNER_PIN_HASH");
  });

  test("retention clears names on the object's schedule, and an alarm is set", async () => {
    const w = await realWorker();
    const owner = (await post(w.base, "/api/login", { user: "owner", pin: OWNER_PIN })).cookie as string;
    const made = await post(w.base, "/api/orders", {
      clientKey: "retention-order-0001",
      customerName: "Asha",
      lines: [{ itemId: ITEM, size: "M", qty: 1 }],
    });
    expect(made.res.status).toBe(201);
    const before = await (await fetch(`${w.base}/api/owner/orders`, { headers: { cookie: owner } })).text();
    expect(before).toContain("Asha");
    const stats = (await (await w.internal("/__stats")).json()) as { alarm: number | null };
    expect(stats.alarm).toBeGreaterThan(Date.now());
    const cleared = (await (await w.internal(`/__retention?now=${Date.now() + 31 * 86_400_000}`)).json()) as {
      orders: number;
    };
    expect(cleared.orders).toBe(1);
    const after = await (await fetch(`${w.base}/api/owner/orders`, { headers: { cookie: owner } })).text();
    expect(after).not.toContain("Asha");
  });
});

describe("demo mode", () => {
  test("a demo install shows throwaway PINs that sign in to every role", async () => {
    const w = await demoWorker();
    const demo = await fetch(`${w.base}/api/demo`);
    expect(demo.status).toBe(200);
    const d = (await demo.json()) as { staff: { id: string; pin: string }[]; owner: { pin: string } };
    for (const s of d.staff)
      expect((await post(w.base, "/api/login", { user: s.id, pin: s.pin })).res.status).toBe(200);
    expect((await post(w.base, "/api/login", { user: "owner", pin: d.owner.pin })).res.status).toBe(200);
    expect((await post(w.base, "/api/login", { user: "owner", pin: "000000" })).res.status).toBe(401);
  });

  test("the PINs are made per seed and stay the same across restarts", async () => {
    const dir = tempDir();
    try {
      const first = await startWorker({ env: { DEMO: "1" }, persist: dir.path });
      const a = await (await fetch(`${first.base}/api/demo`)).text();
      await first.stop();
      const again = await startWorker({ env: { DEMO: "1" }, persist: dir.path });
      running.push(again);
      expect(await (await fetch(`${again.base}/api/demo`)).text()).toBe(a);
      const other = await start({ env: { DEMO: "1" } });
      expect(await (await fetch(`${other.base}/api/demo`)).text()).not.toBe(a);
    } finally {
      dir.remove();
    }
  });

  test("DEMO=1 on a real install's data refuses to start or serve, and a demo's data refuses to run as real", async () => {
    const dir = tempDir();
    try {
      const real = await startWorker({ env: await realEnv(), persist: dir.path });
      const made = await post(real.base, "/api/orders", {
        clientKey: "real-order-0000001",
        lines: [{ itemId: ITEM, size: "M", qty: 1 }],
      });
      expect(made.res.status).toBe(201);
      await real.stop();

      const wrongly = await startWorker({ env: { DEMO: "1" }, persist: dir.path });
      running.push(wrongly);
      for (const path of ["/api/catalog", "/api/demo"]) {
        const res = await fetch(wrongly.base + path);
        expect(res.status, path).toBe(503);
        expect(((await res.json()) as { message: string }).message).toContain("DEMO=1 is set but this database");
      }
      await wrongly.stop();
    } finally {
      dir.remove();
    }
    const demoDir = tempDir();
    try {
      const demo = await startWorker({ env: { DEMO: "1" }, persist: demoDir.path });
      expect((await fetch(`${demo.base}/api/demo`)).status).toBe(200);
      await demo.stop();
      const asReal = await startWorker({ env: await realEnv(), persist: demoDir.path });
      running.push(asReal);
      const res = await fetch(`${asReal.base}/api/catalog`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { message: string }).message).toContain("seeded as a demo");
      expect((await fetch(`${asReal.base}/api/demo`)).status).toBe(503);
    } finally {
      demoDir.remove();
    }
  });
});

describe("demo safety on Workers", () => {
  test("DEMO=1 on a real config (not the demo bundle) never seeds or shows a PIN, even on an empty database", async () => {
    const w = await start({
      env: { DEMO: "1", OWNER_PIN_HASH: await hashPin(OWNER_PIN, TEST_PIN_COST) },
      demoBundle: false,
    });
    for (const path of ["/api/catalog", "/api/demo"]) {
      const res = await fetch(w.base + path);
      expect(res.status, path).toBe(503);
      const text = await res.text();
      expect(text).toContain("not the demo bundle");
      expect(text).not.toMatch(/"pin"/);
    }
  });

  test("the demo bundle without DEMO=1 refuses too", async () => {
    const w = await start({ env: { OWNER_PIN_HASH: await hashPin(OWNER_PIN, TEST_PIN_COST) }, demoBundle: true });
    const res = await fetch(`${w.base}/api/catalog`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("demo bundle is deployed but DEMO=1 is not set");
  });

  test("a demo seeds itself in small steps for about 200 orders and a few thousand rows, and ignores AI_*", async () => {
    const w = await start({ env: { DEMO: "1", AI_BASE_URL: "http://127.0.0.1:9/v1", AI_MODEL: "x", AI_API_KEY: "k" } });
    const stats = (await (await w.internal("/__stats")).json()) as { rowsWritten: number };
    console.log(`demo seed: ${stats.rowsWritten} rows written (free plan: 100000 a day per account)`);
    expect(stats.rowsWritten).toBeLessThan(10_000);
    expect(stats.rowsWritten).toBeGreaterThan(1000);
    const pins = (await (await fetch(`${w.base}/api/demo`)).json()) as { owner: { pin: string } };
    const owner = (await post(w.base, "/api/login", { user: "owner", pin: pins.owner.pin })).cookie as string;
    const asked = await post(w.base, "/api/owner/ask", { question: "How many orders?" }, owner);
    expect(asked.res.status).toBe(404);
    expect((await fetch(`${w.base}/owner-ai.js`)).status).toBe(404);
    expect(await (await fetch(`${w.base}/owner`)).text()).not.toContain("owner-ai.js");
  });
});

describe("the Demo label", () => {
  test("every customer page of a demo carries it, and a real install's never does", async () => {
    const d = await demoWorker();
    for (const path of ["/", "/?kiosk=1", "/index.html"]) {
      const res = await fetch(d.base + path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('role="note"');
      expect(html, path).toContain("<strong>Demo</strong>");
      expect(html, path).toContain("/app.js");
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    }
    const real = await realWorker();
    for (const path of ["/", "/?kiosk=1"]) {
      const html = await (await fetch(real.base + path)).text();
      expect(html, path).not.toMatch(/Demo|role="note"/);
    }
  });
});

describe("demoMode", () => {
  test("decides from the setting, the mark and whether anything is stored", () => {
    expect(demoMode(undefined, false, true, false)).toBe("real");
    expect(demoMode("", false, false, false)).toBe("real");
    expect(demoMode("1", false, true, true)).toBe("seed");
    expect(demoMode("1", true, false, true)).toBe("demo");
    expect(() => demoMode("1", false, false, true)).toThrow(/not a demo's/);
    expect(() => demoMode(undefined, true, false, false)).toThrow(/seeded as a demo/);
    expect(() => demoMode("true", false, true, true)).toThrow(/expected DEMO to be 1/);
    // An empty real database with DEMO=1 must not become a public demo: the bundle has to be the demo's.
    expect(() => demoMode("1", false, true, false)).toThrow(/not the demo bundle/);
    expect(() => demoMode(undefined, false, true, true)).toThrow(/demo bundle is deployed but DEMO=1 is not set/);
  });
});

describe("static files", () => {
  test("carry the headers the Node server sends, from the assets _headers file", async () => {
    const w = await realWorker();
    for (const path of ["/", "/staff", "/app.js"]) {
      const res = await fetch(w.base + path);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("x-ibow-build"), path).toMatch(/^[0-9a-f]{12}$/);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
    expect((await fetch(`${w.base}/`)).headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetch(`${w.base}/staff`)).headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  test("wrangler.toml and wrangler.demo.toml run the Worker first for exactly the paths the tests assume", () => {
    for (const file of ["wrangler.toml", "wrangler.demo.toml"]) {
      const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
      const m = /run_worker_first = (\[[^\]]*\])/.exec(text);
      expect(JSON.parse(m?.[1] ?? "[]"), file).toEqual(file === "wrangler.toml" ? WORKER_FIRST : DEMO_WORKER_FIRST);
      expect(text, file).toContain('compatibility_flags = ["nodejs_compat"]');
      expect(text, file).toContain(`compatibility_date = "${COMPATIBILITY_DATE}"`);
    }
  });
});
