/**
 * Runs the real Worker and its Durable Object in workerd through Miniflare, on a bundle built the way wrangler builds
 * it (esbuild, the `ibow-*` aliases at a sample), with the built client as the assets binding. No Cloudflare account,
 * no network: everything is local (D-034).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { buildClient } from "../../scripts/build-client.ts";
import { lookBundleOf } from "../../scripts/bundle-look.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** The newest compatibility date the pinned workerd supports; wrangler.toml uses the same one. */
export const COMPATIBILITY_DATE = "2026-08-06";
/** The paths that run the Worker before the assets; wrangler.toml's `run_worker_first` must list the same. */
export const WORKER_FIRST = [
  "/api/*",
  "/theme.css",
  "/media/*",
  "/manifest.webmanifest",
  "/owner",
  "/owner-ai.js",
  "/showcase*",
];
/** A demo also runs the Worker for the storefront page, to add its "Demo" label. */
export const DEMO_WORKER_FIRST = ["/", ...WORKER_FIRST];

const clients = new Map<string, string>();
/** The built client, once per test file and set of image hosts. */
async function clientDir(imageOrigins: readonly string[]): Promise<string> {
  const key = imageOrigins.join(" ");
  let dir = clients.get(key);
  if (dir === undefined) {
    dir = mkdtempSync(join(tmpdir(), "ibow-client-"));
    clients.set(key, dir);
    const log = console.log;
    console.log = () => {};
    try {
      await buildClient(dir, { imageOrigins });
    } finally {
      console.log = log;
    }
  }
  return dir;
}

const bundles = new Map<string, Promise<string>>();
/** The Worker bundled for one config folder, with the demo's rush as `ibow-rush` when `demo` is set. */
function bundle(dir: string, demo: boolean): Promise<string> {
  const key = `${dir}:${demo}`;
  let cached = bundles.get(key);
  if (cached === undefined) {
    const look = join(mkdtempSync(join(tmpdir(), "ibow-look-")), "look.json");
    writeFileSync(look, JSON.stringify(lookBundleOf(dir)));
    cached = build({
      entryPoints: [join(root, "src/worker/index.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["node:*", "cloudflare:*"],
      alias: {
        "ibow-business": join(dir, "business.json"),
        "ibow-catalog": join(dir, "catalog.json"),
        "ibow-stations": join(dir, "stations.json"),
        "ibow-spots": existsSync(join(dir, "spots.json"))
          ? join(dir, "spots.json")
          : join(root, "src/worker/no-spots.json"),
        "ibow-look": look,
        "ibow-rush": demo ? join(dir, "rush.json") : join(root, "src/worker/no-rush.json"),
        "ibow-demo-bundle": join(root, demo ? "src/worker/demo-bundle.json" : "src/worker/no-demo-bundle.json"),
      },
      logLevel: "silent",
    }).then((r) => (r.outputFiles[0] as { text: string }).text);
    bundles.set(key, cached);
  }
  return cached;
}

export interface WorkerOptions {
  sample?: string;
  /** A config folder to run instead of `samples/<sample>`, for a look the samples don't have. */
  dir?: string;
  /** Vars and secrets: `DEMO`, `OWNER_PIN_HASH`, `UPI_VPA`, `AI_*`. */
  env?: Record<string, string>;
  /** A directory to keep the Durable Object's storage in, to restart over the same data. */
  persist?: string;
  /** Bundle the demo's rush and marker; default: when `DEMO` is 1. Set it apart from `DEMO` to test a mismatch. */
  demoBundle?: boolean;
}

export interface RunningWorker {
  /** `http://127.0.0.1:<port>`, a real socket, so streams and many requests in flight behave as in production. */
  base: string;
  /** The Durable Object's internal paths (`/__stats`, `/__retention`), which no client can reach. */
  internal(path: string): Promise<Response>;
  stop(): Promise<void>;
}

export async function startWorker(opts: WorkerOptions = {}): Promise<RunningWorker> {
  const dir = opts.dir ?? join(root, "samples", opts.sample ?? "tea-house");
  const imageOrigins = lookBundleOf(dir).imageOrigins;
  const demo = opts.demoBundle ?? opts.env?.DEMO === "1";
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundle(dir, demo) }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    bindings: opts.env ?? {},
    durableObjects: { INSTALL: { className: "Install", useSQLite: true } },
    ...(opts.persist === undefined ? { durableObjectsPersist: false } : { durableObjectsPersist: opts.persist }),
    assets: {
      directory: await clientDir(imageOrigins),
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        static_routing: { user_worker: demo ? DEMO_WORKER_FIRST : WORKER_FIRST },
      },
      assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
    },
    host: "127.0.0.1",
    port: 0,
    verbose: false,
  });
  const url = await mf.ready;
  const base = `http://127.0.0.1:${url.port}`;
  let stopped = false;
  const ns = (await mf.getDurableObjectNamespace("INSTALL")) as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(url: string): Promise<Response> };
  };
  if (opts.env?.DEMO === "1" && demo) await untilPrepared(base);
  return {
    base,
    internal: (path) => ns.get(ns.idFromName("install")).fetch(`http://install${path}`),
    stop: async () => {
      if (!stopped) await mf.dispose();
      stopped = true;
    },
  };
}

export function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "ibow-worker-"));
  return {
    path, // workerd may still hold its files for a moment on Windows; a leftover temp directory is harmless.
    remove: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** A demo seeds itself over several alarms and answers 503 "preparing" until done; waits for that (up to a minute). */
async function untilPrepared(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await fetch(`${base}/api/catalog`);
    const body = (await res.json()) as { error?: string };
    if (body.error !== "preparing") return;
    if (Date.now() > deadline) throw new Error("tests: the demo was still preparing after 60 s");
    await new Promise((r) => setTimeout(r, 200));
  }
}
