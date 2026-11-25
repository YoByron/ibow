// The demo as a long-running service (docs/install.md, "Your own server with Cloudflare Tunnel"):
//   node scripts/demo-serve.ts --data ~/apps/ibow/data --host 127.0.0.1 --port 8790 [--sample coffee-cart | --sample ~/my-config]
// Unlike `npm run demo` it keeps its database between runs. A new or empty data directory is seeded once; every later start
// reuses the database and the same throwaway PINs (kept in demo-pins.json beside it). A real install's database is
// refused. The analyst is off, the showcase is on (it is a demo), and TRUST_PROXY comes from the environment.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_PINS_ENV, DEMO_VPA, type DemoPins } from "../src/demo/pins.ts";
import { databaseKind } from "../src/store/node.ts";
import { buildClient } from "./build-client.ts";
import { demoConfigDir, freePort, isConfigPath, portFree, prepareDemo } from "./demo.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

interface SavedPins {
  pins: DemoPins;
  ownerPinHash: string;
  adminPinHash: string;
  sample: string;
}

export interface ServedDemo {
  base: string;
  /** Whether this start seeded the database (false: it was reused as it was). */
  seeded: boolean;
  pins: DemoPins;
  stop(): Promise<void>;
  /** Resolves with the server's exit code when it stops by itself or after `stop`. */
  exited: Promise<number | null>;
}

function readSaved(path: string): SavedPins | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedPins>;
    const ok = (v: unknown) => typeof v === "string" && /^\d{4,12}$/.test(v);
    const p = saved.pins;
    if (
      p &&
      ok(p.owner) &&
      ok(p.counter) &&
      ok(p.station) &&
      ok(p.manager) &&
      ok(p.admin) &&
      typeof saved.ownerPinHash === "string" &&
      typeof saved.adminPinHash === "string"
    ) {
      return saved as SavedPins;
    }
  } catch {}
  return undefined;
}

export async function serveDemo(opts: {
  dataDir: string;
  sample?: string;
  host?: string;
  port?: number;
  /** Settings for the server beyond the fixed ones: only `TRUST_PROXY` is read (the AI settings never are). */
  env?: Readonly<Record<string, string | undefined>>;
  quiet?: boolean;
}): Promise<ServedDemo> {
  const host = opts.host ?? "127.0.0.1";
  const sample = opts.sample ?? "tea-house";
  const dataDir = resolve(opts.dataDir);
  const dbPath = join(dataDir, "ibow.db");
  const pinsPath = join(dataDir, "demo-pins.json");
  if (opts.port !== undefined && opts.port !== 0 && !(await portFree(opts.port, host))) {
    throw new Error(`demo-serve: port ${opts.port} on ${host} is in use; pick another with --port <number>`);
  }
  const kind = databaseKind(dbPath);
  if (kind === "install") {
    throw new Error(
      `demo-serve: expected no database or a demo database at ${dbPath}, found a database that is not a demo. ` +
        "It never touches a real install's data; pick another --data directory.",
    );
  }
  mkdirSync(dataDir, { recursive: true });
  let saved = kind === "demo" ? readSaved(pinsPath) : undefined;
  const seeded = saved === undefined;
  if (saved === undefined) {
    const prepared = await prepareDemo({ sample, dataDir, now: Date.now() });
    // a sample by name stays a name; a folder is kept as its full path, so a later start finds it from anywhere
    saved = {
      pins: prepared.pins,
      ownerPinHash: prepared.ownerPinHash,
      adminPinHash: prepared.adminPinHash,
      sample: isConfigPath(sample) ? prepared.configDir : sample,
    };
    writeFileSync(`${pinsPath}.tmp`, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    renameSync(`${pinsPath}.tmp`, pinsPath);
  }
  const configDir = demoConfigDir(saved.sample);
  if (!existsSync(join(root, "dist/client/index.html"))) {
    const log = console.log;
    if (opts.quiet) console.log = () => {};
    try {
      await buildClient();
    } finally {
      console.log = log;
    }
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
        CONFIG_DIR: configDir,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: host,
        TRUST_PROXY: opts.env?.TRUST_PROXY ?? "0",
        OWNER_PIN_HASH: saved.ownerPinHash,
        ADMIN_PIN_HASH: saved.adminPinHash,
        [DEMO_PINS_ENV]: JSON.stringify(saved.pins),
        UPI_VPA: DEMO_VPA,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  await new Promise<void>((done, fail) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.includes(" listening on ")) done();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    void exited.then((code) => fail(new Error(`demo-serve: server exited with ${code} before listening:\n${output}`)));
  });
  if (!opts.quiet) {
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  }
  return {
    base: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    seeded,
    pins: saved.pins,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

function parseArgs(argv: string[], env: Readonly<Record<string, string | undefined>>) {
  const out = {
    dataDir: env.IBOW_DEMO_DATA,
    sample: env.IBOW_DEMO_SAMPLE,
    host: env.HOST,
    port: env.PORT === undefined || env.PORT === "" ? undefined : Number(env.PORT),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i] as string;
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`demo-serve: expected a value after ${a}, found nothing`);
    if (a === "--data" || a === "--db") out.dataDir = v;
    else if (a === "--sample") out.sample = v;
    else if (a === "--host") out.host = v;
    else if (a === "--port") out.port = Number(v);
    else throw new Error(`demo-serve: expected --data, --sample, --host or --port, found ${a}`);
  }
  if (out.dataDir === undefined || out.dataDir === "") {
    throw new Error("demo-serve: expected --data <directory> (or IBOW_DEMO_DATA), found nothing");
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    throw new Error(`demo-serve: expected a port between 1 and 65535, found ${out.port}`);
  }
  return out as { dataDir: string; sample?: string; host?: string; port?: number };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2), process.env);
    const demo = await serveDemo({ ...args, env: process.env });
    console.log(
      `demo-serve: ${demo.base} ${demo.seeded ? "seeded a new demo" : "reusing the demo database"}; PINs (throwaway): owner ${demo.pins.owner}, counter ${demo.pins.counter}, station ${demo.pins.station}`,
    );
    let stopping = false;
    const shutdown = () => {
      stopping = true;
      void demo.stop().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    // The server dying by itself must end this process too, with its code, so systemd restarts the whole service.
    void demo.exited.then((code) => {
      if (!stopping) process.exit(code ?? 1);
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
