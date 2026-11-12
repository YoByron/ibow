/** Boots `src/server/main.ts` as `npm start` would, on a free port and a temporary database, with a sample's config. */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPin } from "../src/server/auth.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const OWNER_PIN = "908172";

export interface RunningServer {
  base: string;
  /** Logs in as the owner (a staff session) and calls the staff API, as the counter screen will. */
  staff(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(sample: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "ibow-e2e-"));
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "src/server/main.ts")],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        CONFIG_DIR: join(root, "samples", sample),
        DATA_DIR: dataDir,
        PORT: String(port),
        OWNER_PIN_HASH: await hashPin(OWNER_PIN),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.includes(" listening on ")) resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`server exited with ${code} before listening:\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie: string | undefined;

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: (await res.json()) as unknown };
  }

  return {
    base,
    async staff(method, path, body) {
      if (cookie === undefined) {
        const login = await call("POST", "/api/login", { user: "owner", pin: OWNER_PIN });
        if (login.status !== 200) throw new Error(`owner login failed: ${JSON.stringify(login.body)}`);
      }
      return call(method, path, body);
    },
    async stop() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
