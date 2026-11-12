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
