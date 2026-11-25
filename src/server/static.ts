/**
 * The built client (`dist/client`, from `npm run build`), read into memory at boot and served with a strict content
 * security policy. Only files that were in the directory at boot can be served, so no request path reaches the disk.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Env, Hono } from "hono";
import {
  ANALYST_SCRIPT,
  contentSecurityPolicy,
  DEFAULT_THEME_COLOR,
  fileHeaders,
  manifest,
  withAnalystScript,
} from "./page.ts";

export { contentSecurityPolicy, manifest };

interface ClientFile {
  body: Buffer;
  gzip: Buffer | undefined;
  type: string;
  etag: string;
}

export interface ClientFiles {
  files: ReadonlyMap<string, ClientFile>;
  /** The build id from `build.txt`, sent as `X-Ibow-Build` so the service worker caches one build only. */
  build: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};
/** Short paths of the pages: the storefront, the staff screens (counter and stations) and the owner's dashboard. */
const PAGES: Readonly<Record<string, string>> = {
  "/": "/index.html",
  "/staff": "/staff.html",
  "/owner": "/owner.html",
  "/admin": "/admin.html",
  "/showcase": "/showcase.html",
};
const COMPRESS = new Set([".html", ".js", ".css", ".webmanifest", ".svg"]);

/** The file operations loadClient uses; a test replaces them to make a file vanish mid-walk. */
export interface ClientFs {
  readdirSync: typeof readdirSync;
  statSync: typeof statSync;
  readFileSync: typeof readFileSync;
}
const REAL_FS: ClientFs = { readdirSync, statSync, readFileSync };

/**
 * Reads the built client into memory. A build swaps its folder in whole, but a reader that began just before the swap can
 * still find a file gone between listing it and reading it; that is retried once from the start, and if it persists the
 * error says what vanished.
 */
export function loadClient(dir: string, fs: ClientFs = REAL_FS): ClientFiles {
  try {
    return readClient(dir, fs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    return readClient(dir, fs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw new Error(
      `ibow: expected a complete client build in ${dir}, found a file vanishing while it was read twice (${(e as Error).message}); a build may be running, wait for it and run npm run build if it is not`,
    );
  }
}

function readClient(dir: string, fs: ClientFs): ClientFiles {
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`ibow: expected the built client in ${dir}, found no index.html; run npm run build`);
  }
  let build: string;
  try {
    build = fs.readFileSync(join(dir, "build.txt"), "utf8").trim();
  } catch {
    throw new Error(`ibow: expected ${join(dir, "build.txt")} from the client build, found none; run npm run build`);
  }
  const files = new Map<string, ClientFile>();
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(join(dir, rel))) {
      const path = join(dir, rel, name);
      if (fs.statSync(path).isDirectory()) {
        walk(rel === "" ? name : `${rel}/${name}`);
        continue;
      }
      const type = TYPES[extname(name)];
      if (type === undefined) continue;
      const body = fs.readFileSync(path);
      const file = asFile(body, type);
      if (COMPRESS.has(extname(name)) && body.length > 1024) file.gzip = gzipSync(body, { level: 9 });
      files.set(`/${rel === "" ? "" : `${rel}/`}${name}`, file);
    }
  };
  walk("");
  return { files, build };
}

function asFile(body: Buffer, type: string): ClientFile {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 16)}"`;
  return { body, gzip: undefined, type, etag };
}

/** The owner's page with the analyst's script added after its own. */
function withAnalyst(page: ClientFile): ClientFile {
  const body = Buffer.from(withAnalystScript(page.body.toString("utf8")));
  const file = asFile(body, page.type);
  if (body.length > 1024) file.gzip = gzipSync(body, { level: 9 });
  return file;
}

const isShowcase = (path: string): boolean =>
  path === "/showcase.html" || path === "/showcase.css" || path.startsWith("/showcase/");

export function registerClient<E extends Env>(
  http: Hono<E>,
  client: ClientFiles,
  opts: {
    name: string;
    ai?: boolean;
    imageOrigins?: readonly string[];
    /** The header colour of the look in force, read per request so the owner's Appearance reaches the meta tag and the manifest. */
    themeColor?: () => string;
    /** Whether `/showcase` and its files are served now (a demo, `showcase: true` in business.json, or the admin's switch); otherwise 404 (D-055, D-075). */
    showcase?: () => boolean;
  },
): void {
  const all = new Map(client.files);
  const csp = contentSecurityPolicy(opts.imageOrigins);
  const color = opts.themeColor ?? (() => DEFAULT_THEME_COLOR);
  const dynamic = new Map<string, ClientFile>();
  /** A page or the manifest with the current theme colour in it, built once per colour. */
  const themed = (path: string, file: ClientFile): ClientFile => {
    const c = color();
    const key = `${path}|${c}`;
    let out = dynamic.get(key);
    if (out === undefined) {
      if (dynamic.size > 64) dynamic.clear();
      const text =
        path === "/manifest.webmanifest"
          ? manifest(opts.name, c)
          : file.body.toString("utf8").replace(/(<meta name="theme-color" content=")[^"]*"/, `$1${c}"`);
      out = asFile(Buffer.from(text), file.type);
      if (out.body.length > 1024) out.gzip = gzipSync(out.body, { level: 9 });
      dynamic.set(key, out);
    }
    return out;
  };
  all.set("/manifest.webmanifest", asFile(Buffer.from(manifest(opts.name)), TYPES[".webmanifest"] as string));
  const owner = all.get("/owner.html");
  if (opts.ai) {
    if (owner === undefined || !all.has(ANALYST_SCRIPT)) {
      throw new Error(`ibow: AI is on but the client build has no owner.html or ${ANALYST_SCRIPT}; run npm run build`);
    }
    all.set("/owner.html", withAnalyst(owner));
  } else all.delete(ANALYST_SCRIPT);
  http.get("*", async (c, next) => {
    const path = PAGES[c.req.path] ?? c.req.path;
    const base = all.get(path);
    if (base === undefined || path.startsWith("/api/")) return next();
    if (isShowcase(path) && !(opts.showcase?.() ?? false)) return next();
    const file = base.type.startsWith("text/html") || path === "/manifest.webmanifest" ? themed(path, base) : base;
    const headers: Record<string, string> = {
      "content-type": file.type,
      etag: file.etag,
      ...fileHeaders(client.build),
    };
    if (file.type.startsWith("text/html")) headers["content-security-policy"] = csp;
    if (file.gzip) headers.vary = "Accept-Encoding";
    if (c.req.header("if-none-match") === file.etag) return c.body(null, 304, headers);
    if (file.gzip && /\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) {
      headers["content-encoding"] = "gzip";
      return c.body(new Uint8Array(file.gzip), 200, headers);
    }
    return c.body(new Uint8Array(file.body), 200, headers);
  });
}
