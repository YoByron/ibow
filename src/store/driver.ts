/** What the store needs from an SQL engine: `node:sqlite` on Node (`./node.ts`), Durable Object storage on Workers. */

export type Row = Record<string, unknown>;
export type SqlValue = string | number | null;

export interface Statement {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  /** Runs it and reports how many rows it changed. */
  run(...params: SqlValue[]): { changes: number };
}

export interface SqlDriver {
  prepare(sql: string): Statement;
  /** One or more statements, no parameters. */
  exec(sql: string): void;
  /** Runs `fn` atomically: a throw rolls everything back. Synchronous, so no other request runs inside it. */
  tx<T>(fn: () => T): T;
  /** The schema version, 0 for a new database. */
  version(): number;
  setVersion(n: number): void;
  /** Rewrites the file to drop free pages, where the engine can; a no-op elsewhere. */
  vacuum(): void;
  /** Marks this database as a demo's, in a place only the seed writes (D-019, D-035). */
  markDemo(): void;
  isDemo(): boolean;
  /** After retention cleared rows: flushes old page images where the engine allows it. */
  afterForget(): void;
  /** The database's size in bytes, as the engine reports it. */
  size(): number;
  /** Rows this connection has written since it opened (the free plan counts them per day); a lower bound where the engine can't say. */
  rowsWritten(): number;
  close(): void;
}
