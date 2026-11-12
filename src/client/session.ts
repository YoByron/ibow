/**
 * What the browser keeps. The `clientKey` and the order's secret key are credentials (docs/architecture.md): the
 * client key is random, and the order key lives only in memory or sessionStorage, never in a URL the page shows.
 */

/** 16 random bytes (128 bits) as base64url: the idempotency key for one order create. */
export function newClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface KeyValue {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Memory only: a kiosk keeps nothing between customers. */
export function memoryStore(): KeyValue {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

/** sessionStorage, which ends with the tab; memory if the browser refuses it (private modes, storage off). */
export function tabStore(storage: Storage | undefined): KeyValue {
  const fallback = memoryStore();
  if (storage === undefined) return fallback;
  const attempt = <T>(fn: () => T, otherwise: () => T): T => {
    try {
      return fn();
    } catch {
      return otherwise();
    }
  };
  return {
    get: (k) =>
      attempt(
        () => storage.getItem(k) ?? undefined,
        () => fallback.get(k),
      ),
    set: (k, v) =>
      attempt(
        () => storage.setItem(k, v),
        () => fallback.set(k, v),
      ),
    remove: (k) =>
      attempt(
        () => storage.removeItem(k),
        () => fallback.remove(k),
      ),
  };
}

export interface OrderRef {
  id: string;
  key: string;
}

const ORDER = "ibow.order";

export function loadOrder(kv: KeyValue): OrderRef | undefined {
  const raw = kv.get(ORDER);
  if (raw === undefined) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<OrderRef>;
    return typeof o.id === "string" && typeof o.key === "string" ? { id: o.id, key: o.key } : undefined;
  } catch {
    return undefined;
  }
}

export function saveOrder(kv: KeyValue, ref: OrderRef): void {
  kv.set(ORDER, JSON.stringify(ref));
}

export function forgetOrder(kv: KeyValue): void {
  kv.remove(ORDER);
}
