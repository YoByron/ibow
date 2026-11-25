// Demo mode: a sample business seeded with the past week of orders, on a demo database, with throwaway PINs.
//   npm run demo                        (the tea house on a temporary database, port 3000)
//   npm run demo -- coffee-cart --port 3001 --data ./demo-data
//   npm run demo -- ../my-business/config     (any config folder with a rush.json, by path)
//   AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=llama3.2 npm run demo   (with the AI analyst)
// The demo makes and uses only a database it marked as a demo's; a real install's database is refused, untouched.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/core/config.ts";
import { DEMO_NOW_ENV } from "../src/demo/clock.ts";
import { DEMO_PINS_ENV, DEMO_VPA, type DemoPins, newDemoPins } from "../src/demo/pins.ts";
import { type DemoRush, seedDemo } from "../src/demo/seed.ts";
import { hashPin } from "../src/server/auth.ts";
import { databaseKind, openStore } from "../src/store/node.ts";
import { buildClient } from "./build-client.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const samplesDir = join(root, "samples");

export { DEMO_VPA };

/**
 * The AI analyst's settings (`AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_SECONDS`, `AI_ADAPTER`) from the
 * demo's own environment, non-empty ones only, so `AI_BASE_URL=… AI_MODEL=… npm run demo` tries the analyst. Nothing
 * else of the environment reaches the demo's server.
 */
export function aiEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("AI_") && value !== undefined && value.trim() !== "") out[name] = value;
  }
  return out;
}

export interface PreparedDemo {
  name: string;
  configDir: string;
  dbPath: string;
  orders: number;
  days: number;
  pins: DemoPins;
  ownerPinHash: string;
  adminPinHash: string;
  upi: boolean;
}

/** The bundled samples; none when the tree has no `samples/` folder (a trimmed copy that only runs a config by path). */
function samples(dir = samplesDir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "business.json")));
}

/** Whether a demo's `sample` argument is a path (it has a slash, backslash, dot or drive colon) rather than a sample's name. */
export function isConfigPath(sample: string): boolean {
  return /[\\/.:]/.test(sample);
}

/**
 * The config folder a demo runs: a bundled sample by name, or any folder holding a `business.json` (a business being
 * set up, or one a freelancer is showing to its owner), given as a path. The folder needs a `rush.json` for its history.
 * `bundled` is the samples folder, for tests.
 */
export function demoConfigDir(sample: string, bundled = samplesDir): string {
  if (isConfigPath(sample)) {
    const dir = resolve(sample);
    const missing = ["business.json", "catalog.json", "stations.json", "rush.json"].filter(
      (f) => !existsSync(join(dir, f)),
    );
    if (missing.length === 0) return dir;
    throw new Error(`demo: expected ${missing.join(", ")} in the config folder ${dir}, found them missing`);
  }
  const known = samples(bundled);
  if (known.includes(sample)) return join(bundled, sample);
  throw new Error(
    `demo: expected one of ${known.join(", ")} or a path to a config folder, found ${JSON.stringify(sample)}`,
  );
}

/**
 * Seeds the sample into `dataDir/ibow.db`: a new database, or the demo's own from an earlier run (wiped first). Any
 * other database is refused before anything is opened for writing.
 */
export async function prepareDemo(opts: { sample: string; dataDir: string; now: number }): Promise<PreparedDemo> {
  const configDir = demoConfigDir(opts.sample);
  const dbPath = join(resolve(opts.dataDir), "ibow.db");
  const kind = databaseKind(dbPath);
  if (kind === "install") {
    throw new Error(
      `demo: expected no database or a demo database at ${dbPath}, found a database that is not a demo. ` +
        "The demo never touches a real install's data; pick another --data directory, or leave it out for a temporary one.",
    );
  }
  mkdirSync(opts.dataDir, { recursive: true });
  if (kind === "demo") for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

  const read = (f: string): unknown => JSON.parse(readFileSync(join(configDir, f), "utf8"));
  const config = loadConfig({
    business: read("business.json"),
    catalog: read("catalog.json"),
    stations: read("stations.json"),
    spots: existsSync(join(configDir, "spots.json")) ? read("spots.json") : undefined,
  });
  const upi = config.business.currency === "INR";
  const pins = newDemoPins();
  const [ownerPinHash, counterHash, stationHash, managerHash, adminPinHash] = await Promise.all([
    hashPin(pins.owner),
    hashPin(pins.counter),
    hashPin(pins.station),
    hashPin(pins.manager),
    hashPin(pins.admin),
  ]);

  const store = openStore(dbPath);
  try {
    store.markDemo();
    const seeded = seedDemo(store, { config, rush: read("rush.json") as DemoRush, now: opts.now, upi });
    store.putStaff({ id: "counter", name: "Counter (demo)", pinHash: counterHash, role: "counter" });
    store.putStaff({ id: "station", name: "Stations (demo)", pinHash: stationHash, role: "station" });
    store.putStaff({ id: "manager", name: "Manager (demo)", pinHash: managerHash, role: "manager" });
    return {
      name: config.business.name,
      configDir,
      dbPath,
      orders: seeded.orders,
      days: seeded.days,
      pins,
      ownerPinHash,
      adminPinHash,
      upi,
    };
  } finally {
    store.close();
  }
}

/** Whether `port` on `host` can be listened on now. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  });
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

/**
 * Whether to skip building the client: only when `IBOW_SKIP_BUILD=1` is set and a built client is already there. The
 * browser tests build once in their global setup and set it, so several demos starting at once never rebuild (and so
 * never delete) the folder another server is reading.
 */
export function clientBuildSkipped(
  env: Readonly<Record<string, string | undefined>>,
  clientDir = join(root, "dist/client"),
): boolean {
  return env.IBOW_SKIP_BUILD === "1" && existsSync(join(clientDir, "index.html"));
}

export interface RunningDemo extends PreparedDemo {
  base: string;
  urls: { storefront: string; kiosk: string; staff: string; owner: string };
  stop(): Promise<void>;
}

/**
 * Prepares the demo, builds the client and starts the real server (`src/server/main.ts`) on it. `port` 0 picks a free
 * one. Only the settings below reach the server: never the shell's `.env`, so a real install's DATA_DIR can't leak in.
 */
export async function startDemo(opts: {
  sample?: string;
  dataDir?: string;
  port?: number;
  host?: string;
  quiet?: boolean;
  /** Stands the demo's clock still at this instant: the seeded day and the server's time (screenshots, D-054). */
  now?: number;
}): Promise<RunningDemo> {
  const host = opts.host ?? "127.0.0.1";
  // Checked first, so a busy port costs one line, not a seeded database and a client build.
  if (opts.port !== undefined && opts.port !== 0 && !(await portFree(opts.port, host))) {
    throw new Error(
      `demo: port ${opts.port} on ${host} is in use; pick another with --port <number>, or --port 0 for any free one`,
    );
  }
  const temp = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "ibow-demo-"));
  const prepared = await prepareDemo({ sample: opts.sample ?? "tea-house", dataDir, now: opts.now ?? Date.now() });
  if (clientBuildSkipped(process.env)) {
    // built already, once, by the caller
  } else if (opts.quiet) {
    const log = console.log;
    console.log = () => {};
    try {
      await buildClient();
    } finally {
      console.log = log;
    }
  } else {
    await buildClient();
  }
  const port = opts.port === undefined || opts.port === 0 ? await freePort() : opts.port;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "src/server/main.ts")],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        CONFIG_DIR: prepared.configDir,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: host,
        OWNER_PIN_HASH: prepared.ownerPinHash,
        ADMIN_PIN_HASH: prepared.adminPinHash,
        [DEMO_PINS_ENV]: JSON.stringify(prepared.pins),
        ...(prepared.upi ? { UPI_VPA: DEMO_VPA } : {}),
        ...(opts.now === undefined ? {} : { [DEMO_NOW_ENV]: String(opts.now) }),
        ...aiEnv(process.env),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  await new Promise<void>((done, fail) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.includes(" listening on ")) done();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => fail(new Error(`demo: server exited with ${code} before listening:\n${output}`)));
  });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
  const base = `http://${shown}:${port}`;
  return {
    ...prepared,
    base,
    urls: { storefront: `${base}/`, kiosk: `${base}/?kiosk=1`, staff: `${base}/staff`, owner: `${base}/owner` },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((done) => child.once("exit", done));
        child.kill();
        await exited;
      }
      if (temp) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function parseArgs(argv: string[]): { sample?: string; dataDir?: string; port?: number; host?: string } {
  const out: { sample?: string; dataDir?: string; port?: number; host?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`demo: expected a value after ${a}, found nothing`);
      return v;
    };
    if (a === "--data") out.dataDir = value();
    else if (a === "--port") out.port = Number(value());
    else if (a === "--host") out.host = value();
    else if (a.startsWith("--")) throw new Error(`demo: expected --data, --port or --host, found ${a}`);
    else out.sample = a;
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535)) {
    throw new Error(`demo: expected --port between 0 and 65535, found ${out.port}`);
  }
  return out;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const demo = await startDemo({ ...args, port: args.port ?? 3000 });
    console.log(`
ibow demo: ${demo.name} (${demo.configDir}), ${demo.orders} orders over ${demo.days} days, on a demo database
  ${demo.dbPath}

  Storefront      ${demo.urls.storefront}
  Screen ordering ${demo.urls.kiosk}
  Staff           ${demo.urls.staff}   counter: ID counter, PIN ${demo.pins.counter}   stations: ID station, PIN ${demo.pins.station}
  Owner           ${demo.urls.owner}   PIN ${demo.pins.owner}
${demo.upi ? `\n  UPI payments go to ${DEMO_VPA}, which no payment app accepts: nothing can really be paid.\n` : ""}
These PINs work for this demo only. Ctrl+C stops it${args.dataDir === undefined ? " and deletes the demo data" : ""}.`);
    const shutdown = () => {
      void demo.stop().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
