/** M6 install guide: `npm run backup` writes a consistent copy of the live database, safe to take while it serves. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createOrder } from "../src/core/orders.ts";
import { backupDatabase, openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { loadSample } from "./support/samples.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = loadSample("tea-house");
const at = Date.UTC(2026, 10, 26, 12, 0);
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ibow-backup-test-"));
  dirs.push(d);
  return d;
}

function liveStore(dir: string): Store {
  const store = openStore(join(dir, "ibow.db"));
  stores.push(store);
  for (let i = 1; i <= 3; i++) {
    store.createOrder({
      id: `o-${i}`,
      secret: `s-${i}`,
      clientKey: `backup-client-key-${i}`,
      now: at + i,
      timeZone: config.business.timeZone,
      build: (token) =>
        createOrder(config, { id: `o-${i}`, token, now: at + i, lines: [{ itemId: "masala-soda", qty: i }] }),
    });
  }
  return store;
}

test("backupDatabase copies every order while the database stays open, and refuses to overwrite a file", () => {
  const dir = tempDir();
  liveStore(dir);
  const copy = join(dir, "copy.db");
  backupDatabase(join(dir, "ibow.db"), copy);
  const restored = openStore(copy);
  stores.push(restored);
  expect(restored.ordersOnDay("2026-11-26").map((o) => o.token)).toEqual(["26-001", "26-002", "26-003"]);
  expect(() => backupDatabase(join(dir, "ibow.db"), copy)).toThrow(/expected no file at .*copy\.db, found one/);
});

test("backupDatabase reads the database as it is: read-only, no migrations run on it", () => {
  const dir = tempDir();
  const db = join(dir, "ibow.db");
  openStore(db).close();
  // An older schema version, as an install not yet upgraded has: a backup must not migrate it.
  const raw = new DatabaseSync(db);
  raw.exec("PRAGMA user_version = 3");
  raw.close();
  backupDatabase(db, join(dir, "copy.db"));
  const after = new DatabaseSync(db, { readOnly: true });
  expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
  after.close();
});

test("scripts/backup.ts writes DATA_DIR's database to the path given, beside a running server's open store", () => {
  const dir = tempDir();
  liveStore(dir);
  const dest = join(dir, "backups", "ibow-2026-11-26.db");
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/backup.ts", dest], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", DATA_DIR: dir },
  });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(dest);
  const copy = openStore(dest);
  stores.push(copy);
  expect(copy.ordersOnDay("2026-11-26")).toHaveLength(3);
});

test("scripts/backup.ts fails loudly with no database to back up", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "note.txt"), "no database here");
  const run = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/backup.ts", join(dir, "out.db")],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", DATA_DIR: dir },
    },
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("expected a database at");
  expect(existsSync(join(dir, "out.db"))).toBe(false);
  expect(existsSync(join(dir, "ibow.db"))).toBe(false);
});
