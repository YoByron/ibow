/**
 * Guest messages over HTTP (D-104). The guest writes on their own order with its key; staff with `orders.view` reply. Each
 * message is saved on the order's row with one event, so it travels on the streams that already carry the order: the
 * counter's feed to every staff phone (each screen decides by the message's `to` whether to sound), and the order's own
 * feed to the guest. No new stream, no polling. The rules are `src/core/messages.ts`.
 */

import type { EventEmitter } from "node:events";
import type { Context, Hono } from "hono";
import type { Zone } from "../core/config.ts";
import type { Power } from "../core/levels.ts";
import { guestMessage, MessageError, type MessageInput, messageTo, staffReply } from "../core/messages.ts";
import type { Order } from "../core/orders.ts";
import { dayKey } from "../core/tokens.ts";
import { customerView, staffView } from "../core/views.ts";
import type { Session, Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";

export interface MessageDeps {
  store: Store;
  events: EventEmitter;
  now: () => number;
  timeZone: string;
  ownOrder: (c: Context, id: string) => Order;
  requirePower: (c: Context<Env>, power: Power) => Session;
  /** `ops.messages`: guests may message their runner. */
  on: () => boolean;
  /** The zones of the layout in force, to find an order's section. */
  zones: () => readonly Zone[];
  /** Whether a staff member has a live stream open: a message to a runner whose phone is closed goes to everyone. */
  online: (user: string) => boolean;
}

const STATUS = { bad_message: 400, too_many_messages: 409, too_soon: 429, messages_closed: 409 } as const;

export function registerMessages(http: Hono<Env>, deps: MessageDeps): void {
  const { store, events, now } = deps;

  async function read(c: Context): Promise<MessageInput> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    const b = input.object(raw);
    return { text: b.text, chip: b.chip };
  }

  /** Applies the rule to a fresh read and saves only the messages, synchronously after every await. */
  function save(c: Context, read: () => Order, next: (o: Order) => Order): Order | Response {
    try {
      const updated = next(read());
      events.emit("event", store.saveMessages(updated, now()));
      return updated;
    } catch (e) {
      if (!(e instanceof MessageError)) throw e;
      if (e.retryAfterS !== undefined) c.header("retry-after", String(e.retryAfterS));
      return c.json({ error: e.code, message: `${e.code}: ${e.message}` }, STATUS[e.code]);
    }
  }

  http.post("/api/orders/:id/messages", async (c) => {
    const id = c.req.param("id");
    const msg = await read(c);
    if (!deps.on()) {
      deps.ownOrder(c, id);
      throw new ApiError(
        403,
        "messages_off",
        "expected messages switched on (ops.messages), found them off; please ask at the counter",
      );
    }
    const out = save(
      c,
      () => deps.ownOrder(c, id),
      (o) => {
        const runners = store.sectionRunners(dayKey(now(), deps.timeZone));
        const to = messageTo(o, deps.zones(), Object.fromEntries(runners));
        return guestMessage(o, msg, now(), to !== undefined && deps.online(to) ? to : undefined);
      },
    );
    return out instanceof Response ? out : c.json({ order: customerView(out) }, 201);
  });

  http.post("/api/orders/:id/reply", async (c) => {
    const session = deps.requirePower(c, "orders.view");
    const id = c.req.param("id");
    const msg = await read(c);
    const out = save(
      c,
      () => {
        const found = store.getOrder(id);
        if (found === undefined) throw new ApiError(404, "no_such_order", `expected a known order id, found ${id}`);
        return found.order;
      },
      (o) => staffReply(o, msg, now(), session.user),
    );
    return out instanceof Response ? out : c.json({ order: staffView(out) }, 201);
  });
}
