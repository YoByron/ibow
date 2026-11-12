/** Runs `src/server/main.ts` as `npm start` does, on a free port, for tests of what only the process decides. */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient, CLIENT_DIR } from "../../scripts/build-client.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children: ChildProcess[] = [];

/** Stops every server started here; call it from `afterAll`. */
export function stopMainProcesses(): void {
  for (const c of children.splice(0)) c.kill();
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

/** The built client is needed; build it once if the folder is missing. */
async function ensureClient(): Promise<void> {
  if (existsSync(join(CLIENT_DIR, "index.html"))) return;
  const log = console.log;
  console.log = () => {};
  try {
    await buildClient();
  } finally {
    console.log = log;
  }
}

/** Starts the server on the tea-house sample and `dataDir` with `env` added; resolves once it listens. */
export async function startMain(dataDir: string, ownerPinHash: string, env: Record<string, string>): Promise<string> {
  await ensureClient();
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "src/server/main.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      CONFIG_DIR: join(root, "samples/tea-house"),
      DATA_DIR: dataDir,
      PORT: String(port),
      OWNER_PIN_HASH: ownerPinHash,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
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
  return `http://127.0.0.1:${port}`;
}
