/**
 * The store's SQL driver over a SQLite-backed Durable Object (`ctx.storage.sql`, synchronous like node:sqlite). The DO
 * is the single writer, so `transactionSync` is all the atomicity token issue needs (D-030, D-031).
 *
 * What the engine does not allow, found by probing it: `PRAGMA user_version`, `application_id` and `secure_delete` are
 * refused (SQLITE_AUTH), so the schema version and the demo mark live in the DO's key-value storage (`ctx.storage.kv`,
 * the same SQLite file); `VACUUM` is refused; foreign keys are already on.
 */

import type { DurableObjectStorage } from "cloudflare:workers";
import type { Row, SqlDriver, SqlValue, Statement } from "../store/driver.ts";

export interface DoDriver extends SqlDriver {
  /** Rows written since this driver was made, indexes included: what the free plan's daily row limit counts. */
  rowsWritten(): number;
  rowsRead(): number;
}

const VERSION_KEY = "schema_version";
const DEMO_KEY = "demo";

export function doDriver(storage: DurableObjectStorage): DoDriver {
  const { sql, kv } = storage;
  let written = 0;
  let read = 0;
  function run(query: string, params: SqlValue[]): Row[] {
    const cursor = sql.exec(query, ...params);
    const rows = cursor.toArray();
    written += cursor.rowsWritten;
    read += cursor.rowsRead;
    return rows;
  }
  return {
    prepare(query): Statement {
      return {
        get: (...p) => run(query, p)[0],
        all: (...p) => run(query, p),
        run(...p) {
          run(query, p);
          return { changes: (run("SELECT changes() AS n", [])[0] as Row).n as number };
        },
      };
    },
    exec(query) {
      run(query, []);
    },
    tx: (fn) => storage.transactionSync(fn),
    version: () => (kv.get(VERSION_KEY) as number | undefined) ?? 0,
    setVersion: (n) => kv.put(VERSION_KEY, n),
    // A Durable Object's file can't be rewritten from inside; the free pages it leaves are its own (see D-016 note).
    vacuum() {},
    markDemo: () => kv.put(DEMO_KEY, true),
    isDemo: () => kv.get(DEMO_KEY) === true,
    afterForget() {},
    close() {},
    rowsWritten: () => written,
    rowsRead: () => read,
  };
}
