import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterAll, describe, expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";
import { loadClient, registerClient } from "../src/server/static.ts";
import { openStore } from "../src/store/node.ts";
import { loadSample } from "./support/samples.ts";

const dir = mkdtempSync(join(tmpdir(), "ibow-static-"));
writeFileSync(join(dir, "index.html"), '<!doctype html><meta name="theme-color" content="#1e3d1a"><title>ibow</title>');
writeFileSync(join(dir, "app.js"), `console.log(${JSON.stringify("x".repeat(2000))});`);
writeFileSync(join(dir, "sw.js"), "self.addEventListener('fetch', () => {});");
writeFileSync(join(dir, "build.txt"), "abc123def456\n");
writeFileSync(join(dir, "staff.html"), "<!doctype html><title>Staff</title>");
writeFileSync(
  join(dir, "owner.html"),
  '<!doctype html><html><head><title>Owner</title><script src="/owner.js" defer></script></head><body></body></html>',
);
writeFileSync(join(dir, "showcase.html"), "<!doctype html><title>ibow showcase</title>");
writeFileSync(join(dir, "showcase.css"), "body{}");
writeFileSync(join(dir, "owner-ai.js"), "console.log('analyst');");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function app(ai = false): Hono {
  const http = new Hono();
  registerClient(http, loadClient(dir), { name: "The Tea House", ai });
  http.get("/api/catalog", (c) => c.json({ ok: true }));
  return http;
}

describe("the theme colour", () => {
  test("the page meta and the manifest follow the look in force, read per request", async () => {
    let colour = "#1e3d1a";
    const http = new Hono();
    registerClient(http, loadClient(dir), { name: "The Tea House", themeColor: () => colour });
    expect(await (await http.request("/")).text()).toContain('content="#1e3d1a"');
    colour = "#0b2a5b";
    expect(await (await http.request("/")).text()).toContain('content="#0b2a5b"');
    expect(await (await http.request("/manifest.webmanifest")).json()).toMatchObject({ theme_color: "#0b2a5b" });
  });
});

describe("the static client", () => {
  test("serves the staff page at /staff", async () => {
    const res = await app().request("/staff");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("<title>Staff</title>");
  });

  test("the showcase is a 404 unless the install turns it on (D-055)", async () => {
    for (const path of ["/showcase", "/showcase.html", "/showcase.css", "/showcase/a.png"])
      expect((await app().request(path)).status, path).toBe(404);
  });

  test("serves the showcase at /showcase with the strict policy when turned on", async () => {
    const http = new Hono();
    registerClient(http, loadClient(dir), { name: "The Tea House", showcase: true });
    const res = await http.request("/showcase");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(await res.text()).toContain("ibow showcase");
    expect((await http.request("/showcase.css")).status).toBe(200);
  });

  test("serves the owner's dashboard at /owner with the same policy", async () => {
    const res = await app().request("/owner");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("<title>Owner</title>");
  });

  test("serves the storefront at / with a strict content security policy", async () => {
    const res = await app().request("/?kiosk=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("<title>ibow</title>");
  });

  test("serves built files with their types, gzipped when asked, and revalidates by ETag", async () => {
    const http = app();
    const js = await http.request("/app.js", { headers: { "accept-encoding": "gzip, br" } });
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("content-encoding")).toBe("gzip");
    expect(js.headers.get("vary")).toBe("Accept-Encoding");
    expect(gunzipSync(Buffer.from(await js.arrayBuffer())).toString()).toContain("console.log");
    const etag = js.headers.get("etag") as string;
    expect((await http.request("/app.js", { headers: { "if-none-match": etag } })).status).toBe(304);
    const manifest = await http.request("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(await manifest.json()).toMatchObject({
      name: "The Tea House",
      short_name: "The Tea House",
      start_url: "/",
      display: "standalone",
      icons: expect.arrayContaining([expect.objectContaining({ sizes: "512x512", purpose: "maskable" })]),
    });
    expect((await http.request("/sw.js")).headers.get("cache-control")).toBe("no-cache");
    // Every file says which build it belongs to, so the service worker never mixes two builds.
    expect(js.headers.get("x-ibow-build")).toBe("abc123def456");
    expect(manifest.headers.get("x-ibow-build")).toBe("abc123def456");
  });

  test("leaves the API alone and refuses anything that isn't a built file", async () => {
    const http = app();
    expect(await (await http.request("/api/catalog")).json()).toEqual({ ok: true });
    expect((await http.request("/../package.json")).status).toBe(404);
    expect((await http.request("/nope.js")).status).toBe(404);
  });

  test("with AI off the analyst's script is neither linked nor served (M7)", async () => {
    const http = app();
    const owner = await (await http.request("/owner")).text();
    expect(owner).not.toContain("owner-ai");
    expect((await http.request("/owner-ai.js")).status).toBe(404);
  });

  test("with AI on the owner's page loads the analyst's script, from this server only", async () => {
    const http = app(true);
    const res = await http.request("/owner");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const owner = await res.text();
    expect(owner).toContain('<script src="/owner-ai.js" defer></script></head>');
    expect(owner).toContain('<script src="/owner.js" defer></script>');
    expect((await http.request("/owner-ai.js")).status).toBe(200);
    expect(await (await http.request("/")).text()).not.toContain("owner-ai");
  });

  test("fails loudly when the client hasn't been built", () => {
    expect(() => loadClient(join(dir, "missing"))).toThrow(/npm run build/);
  });
});

describe("the showcase through createApp (Node)", () => {
  const status = async (opts: { demo?: boolean; showcase?: boolean }) => {
    const base = loadSample("tea-house");
    const config = { ...base, business: { ...base.business, ...(opts.showcase ? { showcase: true } : {}) } };
    const http = createApp({
      config,
      store: openStore(":memory:"),
      ownerPinHash: "unused",
      client: loadClient(dir),
      ...(opts.demo ? { demo: { pins: { owner: "111111", counter: "1111", station: "2222" } } } : {}),
    }).http;
    return (await http.request("/showcase")).status;
  };

  test("a real install answers 404, a demo 200, and showcase: true in business.json turns it on", async () => {
    expect(await status({})).toBe(404);
    expect(await status({ demo: true })).toBe(200);
    expect(await status({ showcase: true })).toBe(200);
  });
});
