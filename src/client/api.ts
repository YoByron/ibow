/** JSON calls to the server. The order's key travels in the `X-Order-Key` header, never in a fetched URL. */

export class ApiFailure extends Error {
  readonly status: number;
  /** The server's error code (`edit_expired`, `rate_limited`, …), or `network` when no reply came. */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Server clock minus this device's, learnt from each reply's `Date` header (whole seconds), so ages compare like with like. */
let skewMs = 0;

/** The server's current time as best known: a phone with a wrong clock still reads server timestamps correctly. */
export function serverNow(): number {
  return Date.now() + skewMs;
}

/** Learns the skew from a reply's `Date` header; a missing or odd one changes nothing. */
export function learnSkew(dateHeader: string | null, localAt: number): void {
  const at = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
  // The header has second resolution, so it reads up to a second behind: half a second is added back.
  if (Number.isFinite(at)) skewMs = at + 500 - localAt;
}

export async function api<T>(method: string, path: string, opts: { body?: unknown; key?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key !== undefined) headers["x-order-key"] = opts.key;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      cache: "no-store",
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch (e) {
    throw new ApiFailure(0, "network", (e as Error).message);
  }
  learnSkew(res.headers.get("date"), Date.now());
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiFailure(res.status, "bad_reply", `expected JSON from ${path}, found something else`);
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    throw new ApiFailure(res.status, err.error ?? "unknown", err.message ?? `${res.status} from ${path}`);
  }
  return data as T;
}
