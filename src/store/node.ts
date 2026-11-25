/** The Node side of the store: `node:sqlite` (D-004), a file on disk or `:memory:`, plus the file-level helpers. */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Row, SqlDriver, SqlValue, Statement } from "./driver.ts";
import { createStore, type Store } from "./store.ts";

/** SQLite's `application_id` of a demo database: "ibwD". A real install's database keeps the default, 0. */
const DEMO_APPLICATION_ID = 0x69627744;

export function nodeDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  // Deleted or overwritten content is zeroed on disk, so retention really removes a customer's name (D-016).
  db.exec("PRAGMA secure_delete = ON");
  const onDisk = path !== ":memory:";
  let written = 0;
  if (onDisk) db.exec("PRAGMA journal_mode = WAL");
  const pragma = (name: string) => (db.prepare(`PRAGMA ${name}`).get() as Row)[name] as number;
  return {
    prepare(sql): Statement {
      const st = db.prepare(sql);
      return {
        get: (...p: SqlValue[]) => st.get(...p) as Row | undefined,
        all: (...p: SqlValue[]) => st.all(...p) as Row[],
        run: (...p: SqlValue[]) => {
          const changes = Number(st.run(...p).changes);
          written += changes;
          return { changes };
        },
      };
    },
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    version: () => pragma("user_version"),
    setVersion: (n) => db.exec(`PRAGMA user_version = ${n}`),
    vacuum: () => db.exec("VACUUM"),
    markDemo() {
      db.exec(`PRAGMA application_id = ${DEMO_APPLICATION_ID}`);
      // Into the file header now, where databaseKind reads it, not only the write-ahead log.
      if (onDisk) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      // A demo's data needn't survive a power cut: no sync per commit, so seeding a week of orders takes a moment.
      db.exec("PRAGMA synchronous = OFF");
    },
    isDemo: () => pragma("application_id") === DEMO_APPLICATION_ID,
    // The old page images still sit in the write-ahead log until a checkpoint; copy them back and empty it.
    afterForget() {
      if (onDisk) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    size: () => pragma("page_count") * pragma("page_size"),
    // Rows changed by statements, indexes not counted: a lower bound of what Cloudflare would count.
    rowsWritten: () => written,
    close: () => db.close(),
  };
}

/** Opens (creating and migrating if needed) the database at `path`; `:memory:` for tests. */
export function openStore(path: string): Store {
  const driver = nodeDriver(path);
  try {
    return createStore(driver);
  } catch (e) {
    driver.close(); // a refused database must not stay open
    throw e;
  }
}

/**
 * What the file at `path` is, read without changing it: `missing`, a `demo` database, or anything else (`install`),
 * which the demo must never touch. It reads the file header's `application_id` (bytes 68 to 71) directly, because even
 * a read-only SQLite connection leaves `-wal` and `-shm` files beside a database in WAL mode.
 */
export function databaseKind(path: string): "missing" | "demo" | "install" {
  if (!existsSync(path)) return "missing";
  const header = Buffer.alloc(72);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header, 0, 72, 0) < 72) return "install";
  } finally {
    closeSync(fd);
  }
  const isSqlite = header.subarray(0, 15).toString("latin1") === "SQLite format 3" && header[15] === 0;
  return isSqlite && header.readUInt32BE(68) === DEMO_APPLICATION_ID ? "demo" : "install";
}

/**
 * Writes a consistent copy of the database at `src` to `dest` (`VACUUM INTO`), safe while the server is running. It
 * opens `src` read-only and runs no migrations, so a backup never changes what it copies, even an older schema. The
 * copy is compact, with no free pages, so nothing retention cleared comes back from it. Refuses a `dest` that exists.
 */
export function backupDatabase(src: string, dest: string): void {
  if (existsSync(dest)) throw new Error(`backupDatabase: expected no file at ${dest}, found one; pick a new name`);
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
}
