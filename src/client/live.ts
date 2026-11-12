/**
 * Follows events live: the audience's SSE stream first, polling when SSE isn't there or keeps failing (some mobile
 * networks and proxies kill long connections). `EventSource` can't set headers, so only it takes the key as `?key=`.
 */

import type { CustomerOrderView } from "../core/views.ts";
import { api } from "./api.ts";

export interface OrderEvent<V = CustomerOrderView> {
  id: number;
  type: string;
  at: number;
  order: V;
}

export interface StreamOptions<V> {
  /** The SSE path, such as `/api/stream/counter`; `after=` is added to it. */
  stream: string;
  /** The polling path for the same audience, such as `/api/poll/counter`. */
  poll: string;
  /** The order key, sent as a header when polling (the stream path carries it itself). */
  key?: string;
  /** The `lastEventId` from the snapshot, so nothing between the snapshot and the stream is missed. */
  after: number;
  onEvent: (e: OrderEvent<V>) => void;
  pollMs?: number;
  /** Errors in a row, with no event between, before giving up on SSE. */
  maxSseErrors?: number;
}

export interface FollowOptions {
  orderId: string;
  key: string;
  after: number;
  onEvent: (e: OrderEvent) => void;
  pollMs?: number;
  maxSseErrors?: number;
}

/** Follows one customer order; the returned function stops. */
export function follow(opts: FollowOptions): () => void {
  const id = encodeURIComponent(opts.orderId);
  const { orderId: _, ...rest } = opts;
  return followStream({
    ...rest,
    stream: `/api/stream/order/${id}?key=${encodeURIComponent(opts.key)}`,
    poll: `/api/poll/order/${id}`,
  });
}

/** Follows any audience's events (an order, the counter, a station); the returned function stops. */
export function followStream<V>(opts: StreamOptions<V>): () => void {
  const pollMs = opts.pollMs ?? 4000;
  const maxErrors = opts.maxSseErrors ?? 3;
  let last = opts.after;
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const join = (path: string) => (path.includes("?") ? "&" : "?");

  const deliver = (e: OrderEvent<V>) => {
    if (e.id <= last) return;
    last = e.id;
    opts.onEvent(e);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const page = await api<{ events: OrderEvent<V>[]; lastEventId: number }>(
        "GET",
        `${opts.poll}${join(opts.poll)}after=${last}`,
        opts.key === undefined ? {} : { key: opts.key },
      );
      // The server no longer holds the events this client missed (offline for days): start over from a fresh snapshot.
      if ((page as { reset?: boolean }).reset) return location.reload();
      for (const e of page.events) deliver(e);
      last = Math.max(last, page.lastEventId);
    } catch {
      // Offline or the server restarting: try again on the next tick.
    }
    if (!stopped) timer = setTimeout(poll, pollMs);
  };

  if (typeof EventSource === "undefined") {
    void poll();
  } else {
    let errors = 0;
    source = new EventSource(`${opts.stream}${join(opts.stream)}after=${last}`);
    source.onmessage = (m) => {
      errors = 0;
      try {
        deliver(JSON.parse(m.data) as OrderEvent<V>);
      } catch {
        // A malformed event is skipped; the next one carries the whole order anyway.
      }
    };
    source.addEventListener("reset", () => location.reload());
    source.onerror = () => {
      errors++;
      // The browser retries on its own (with Last-Event-ID); fall back once it has failed a few times running.
      if (errors >= maxErrors || source?.readyState === EventSource.CLOSED) {
        source?.close();
        source = undefined;
        if (!stopped && timer === undefined) void poll();
      }
    };
  }

  return () => {
    stopped = true;
    source?.close();
    if (timer !== undefined) clearTimeout(timer);
  };
}
