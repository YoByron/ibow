import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type BuiltFile, buildClient, stampAssets } from "../scripts/build-client.ts";
import { DEFAULT_THEME, themeCss } from "../src/core/theme.ts";

const out = mkdtempSync(join(tmpdir(), "ibow-build-"));
let files: BuiltFile[] = [];
beforeAll(async () => {
  files = await buildClient(out);
}, 90_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const gzip = (names: string[]) => files.filter((f) => names.includes(f.name)).reduce((n, f) => n + f.gzipBytes, 0);
const precache = (worker: string) => {
  const m = /\["\/[^\]]*\]/.exec(readFileSync(join(out, worker), "utf8"));
  return JSON.parse(m?.[0] ?? "[]") as string[];
};

describe("client build", () => {
  test("every page names its scripts and sheets with the build, so a cache in front can't mix two builds", () => {
    const build = readFileSync(join(out, "build.txt"), "utf8").trim();
    for (const page of ["index.html", "staff.html", "owner.html", "admin.html"]) {
      const html = readFileSync(join(out, page), "utf8");
      const refs = [...html.matchAll(/\s(?:href|src)="(\/[^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1] as string);
      expect(refs.length, page).toBeGreaterThan(2);
      for (const ref of refs) expect(ref.endsWith(`?b=${build}`), `${page}: ${ref}`).toBe(true);
    }
    expect(stampAssets('<link href="/a.css"><script src="/x.js?v=1"></script>', "abc")).toBe(
      '<link href="/a.css?b=abc"><script src="/x.js?v=1"></script>',
    );
  });

  test("the storefront's first load stays under 60 KB gzip, fonts and images apart: no staff code or strings in it", () => {
    const sheet = gzipSync(themeCss(DEFAULT_THEME), { level: 9 }).length;
    expect(gzip(["index.html", "app.js", "style.css", "store.css"]) + sheet).toBeLessThanOrEqual(60 * 1024);
    const app = readFileSync(join(out, "app.js"), "utf8");
    expect(app).not.toContain("Undo ready");
    expect(app).not.toContain("Cash handed over");
    expect(app).not.toContain("Prep for");
    expect(app).not.toContain("/api/owner");
  });

  test("the components are styled only through tokens: no brand colour in the shared stylesheet", () => {
    const css = readFileSync(join(out, "style.css"), "utf8");
    // Black and white, with or without alpha, are neutral; any other literal would be a brand colour.
    const neutral = (c: string) => {
      const h = c.slice(1);
      return /^(0+|f+)$/i.test(h.length <= 4 ? h.slice(0, 3) : h.slice(0, 6));
    };
    const literals = (css.match(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g) ?? []).filter((c) => !neutral(c));
    expect(literals).toEqual([]);
  });

  test("icons and typefaces are self-hosted in the build", () => {
    const names = files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["assets/fonts/inter.woff2", "assets/fonts/lora.woff2", "assets/fonts/fraunces.woff2"]),
    );
  });

  test("the owner's dashboard is its own bundle, in no service worker", () => {
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["owner.html", "owner.js", "owner.css"]));
    const owner = readFileSync(join(out, "owner.js"), "utf8");
    expect(owner).toContain("/api/owner/insights");
    expect(readFileSync(join(out, "staff.js"), "utf8")).not.toContain("/api/owner");
    for (const worker of ["sw.js", "staff-sw.js"])
      expect(precache(worker).some((p) => p.startsWith("/owner"))).toBe(false);
  });

  test("the links hub is its own page and bundle, with no service worker and no other page's code (D-074)", () => {
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["admin.html", "admin.js", "admin.css"]));
    const admin = readFileSync(join(out, "admin.js"), "utf8");
    expect(admin).toContain("/api/hub");
    expect(admin).toContain("/api/admin/health");
    expect(admin).not.toContain("/api/owner");
    for (const name of ["app.js", "staff.js", "owner.js"]) {
      expect(readFileSync(join(out, name), "utf8"), name).not.toContain("/api/admin/health");
    }
    for (const worker of ["sw.js", "staff-sw.js"])
      expect(precache(worker).some((p) => p.startsWith("/admin"))).toBe(false);
    expect(readFileSync(join(out, "_headers"), "utf8")).toContain("/admin\n  Content-Security-Policy");
  });

  test("the AI analyst is its own bundle: no other page, worker or stylesheet carries it (M7, D-028)", () => {
    const analyst = readFileSync(join(out, "owner-ai.js"), "utf8");
    expect(analyst).toContain("/api/owner/ask");
    for (const name of ["app.js", "staff.js", "owner.js", "sw.js", "staff-sw.js", "owner.html", "index.html"]) {
      const text = readFileSync(join(out, name), "utf8");
      expect(text, name).not.toContain("/api/owner/ask");
      expect(text, name).not.toContain("owner-ai");
      expect(text, name).not.toContain("Ask the analyst");
    }
    for (const worker of ["sw.js", "staff-sw.js"]) expect(precache(worker)).not.toContain("/owner-ai.js");
  });

  test("the showcase is static: no script, no inline style, no external request, every picture built", () => {
    const html = readFileSync(join(out, "showcase.html"), "utf8");
    expect(html).not.toMatch(/<script|<style|\sstyle=|\son\w+=|<iframe|<form/i);
    // Loaded resources are always our own; only plain links may leave, as https (or as a placeholder before set-links).
    const loaded = [...html.matchAll(/<(?:img|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    for (const ref of loaded.filter((r) => !r.startsWith("https://") && !r.startsWith("{{"))) {
      expect(ref.startsWith("/"), ref).toBe(true);
    }
    expect(html).not.toMatch(/<(?:img|script|iframe|source|video|audio)\b[^>]*\ssrc="(?!\/)/);
    const sources = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    for (const ref of sources) {
      expect(ref.startsWith("/") || ref.startsWith("https://") || /^\{\{[A-Z_]+_URL\}\}$/.test(ref), ref).toBe(true);
      const path = ref.split("?")[0] as string;
      if (path.startsWith("/") && path !== "/theme.css")
        expect(
          files.map((f) => `/${f.name}`),
          ref,
        ).toContain(path);
    }
    expect(html).toContain("No warranty");
    // It is not part of the storefront's first load.
    expect(precache("sw.js").some((p) => p.includes("showcase"))).toBe(false);
  });

  test("each page's service worker precaches only that page's files", () => {
    const store = precache("sw.js");
    expect(store).toContain("/app.js");
    expect(store.some((p) => p.startsWith("/staff"))).toBe(false);
    const staff = precache("staff-sw.js");
    expect(staff).toEqual(expect.arrayContaining(["/staff", "/staff.js", "/style.css"]));
    expect(staff).not.toContain("/app.js");
  });
});
