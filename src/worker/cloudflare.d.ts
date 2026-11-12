/**
 * The few Workers types ibow uses, declared here so the project keeps one tsconfig (Node types, no DOM clash with
 * @cloudflare/workers-types). They mirror https://developers.cloudflare.com/durable-objects/api/ .
 */

declare module "cloudflare:workers" {
  export interface SqlStorageCursor {
    toArray(): Record<string, unknown>[];
    one(): Record<string, unknown>;
    readonly rowsRead: number;
    readonly rowsWritten: number;
  }
  export interface SqlStorage {
    readonly databaseSize: number;
    exec(query: string, ...bindings: (string | number | null)[]): SqlStorageCursor;
  }
  export interface DurableObjectStorage {
    sql: SqlStorage;
    kv: { get(key: string): unknown; put(key: string, value: unknown): void; delete(key: string): boolean };
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number | Date): Promise<void>;
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export interface DurableObjectId {
    toString(): string;
  }
  export interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }
  export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }
  export interface Fetcher {
    fetch(request: Request): Promise<Response>;
  }
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    protected ctx: DurableObjectState;
    protected env: Env;
  }
}

// The business files are bundled through the `ibow-business`, `ibow-catalog`, `ibow-stations` and `ibow-rush` aliases (wrangler.toml), which tsc can't
// resolve; loadConfig validates their shape at startup, so they are typed unknown here.
declare module "ibow-business" {
  const value: unknown;
  export default value;
}
declare module "ibow-catalog" {
  const value: unknown;
  export default value;
}
declare module "ibow-stations" {
  const value: unknown;
  export default value;
}
declare module "ibow-demo-bundle" {
  const value: unknown;
  export default value;
}
// `ibow-look` is the look of the config folder as JSON (scripts/bundle-look.ts, run by the build command in wrangler.toml).
declare module "ibow-look" {
  const value: unknown;
  export default value;
}
declare module "ibow-rush" {
  const value: unknown;
  export default value;
}
