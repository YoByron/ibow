/**
 * The JSON API. Each route validates input, calls `src/core` for the rule, persists through `src/store`, and emits
 * the stored event for the SSE streams. No business rule lives here.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { analystContext, ask, MAX_QUESTION_CHARS } from "../ai/analyst.ts";
import { AiError, type ChatModel } from "../ai/model.ts";
import { type Config, withAvailability } from "../core/config.ts";
import { localTime } from "../core/insights.ts";
import {
  addLines,
  advanceStatus,
  createOrder,
  customerEdit,
  isReady,
  markReady,
  markServed,
  type Order,
  OrderError,
  type OrderErrorCode,
  orderTotal,
  topUp,
  undoStatus,
  unmarkReady,
} from "../core/orders.ts";
import { claimPayment, confirmPayment, PaymentError, upiIntent } from "../core/payments.ts";
import { earlierVisits } from "../core/regulars.ts";
import { MAX_REVIEW_TEXT, reviewOrder } from "../core/reviews.ts";
import { ordersAhead } from "../core/storefront.ts";
import { DEFAULT_THEME } from "../core/theme.ts";
import { dayKey } from "../core/tokens.ts";
import { customerView, staffView, stationView } from "../core/views.ts";
import type { EventType, Role, Session, StaffRole, Store } from "../store/store.ts";
import { DUMMY_HASH, hashPin, hashSessionId, isPin, needsRehash, newSessionId, sameSecret, verifyPin } from "./auth.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";
import { InputError } from "./input.ts";
import { type Backoff, createLimiter, createLockout, type Limit } from "./limits.ts";
import { createReportBuilder } from "./report.ts";
import { type ClientFiles, registerClient } from "./static.ts";
import { registerStreams } from "./streams.ts";
import { type Look, registerTheme } from "./theme.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  /** From `OWNER_PIN_HASH`; see scripts/hash-pin.ts. */
  ownerPinHash: string;
  now?: () => number;
  /** The caller's address, for rate limits. Defaults to the socket's remote address, or see `trustProxy`. */
  clientIp?: (c: Context) => string;
  /**
   * `TRUST_PROXY`: how many reverse proxies stand in front (0, the default, trusts none). With N, the client is the
   * Nth address from the right of `X-Forwarded-For` (the left-most one no trusted proxy added, since anything further
   * left the client wrote itself), and `X-Forwarded-Proto: https` marks the session cookie `Secure`.
   */
  trustProxy?: number;
  limits?: {
    orderCreate?: Limit;
    /** PIN attempts per address and user. */
    pinFailures?: Limit;
    /** PIN attempts per user across all addresses, with doubling lockouts. */
    pinUser?: Backoff;
    /** Questions to the AI analyst per owner session. */
    ask?: Limit;
  };
  /** The model behind the AI analyst (`src/ai`); without it AI is off and its route and script don't exist. */
  ai?: ChatModel;
  /** The built client from `loadClient`, served at `/`; without it the server is API only (as in most tests). */
  client?: ClientFiles;
  /** Theme, labels and images from the config folder (`loadLook`); without it the default look and no images. */
  look?: Look;
  /** Payment options beyond paying at the counter, from deployment config (`UPI_VPA`, `UPI_PAYEE_NAME`). */
  payments?: { upi?: { vpa: string; payeeName: string } };
  /**
   * Set only on a demo install (D-035): the throwaway PINs the sign-in screens show, at `GET /api/demo`. Without it the
   * route answers `{demo: false}`, so a real install can never answer with a PIN.
   */
  demo?: { pins: { owner: string; counter: string; station: string } };
  sessionTtlMs?: number;
  /** Comment lines on idle SSE streams, so proxies keep them open. */
  heartbeatMs?: number;
}

export interface App {
  http: Hono<Env>;
  /** Emits `"event"` with each `StoredEvent`, after it is committed. */
  events: EventEmitter;
  /** The header colour of the look in force, which the manifest and the page's theme colour follow. */
  headerColor(): string;
}

export const SESSION_COOKIE = "ibow_session";
const MAX_BODY_BYTES = 16 * 1024;
const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const REVIEWS_SHOWN = 50;
/** An export covers a day range, 7 days unless asked, and at most 31, so one request stays small (D-043). */
const EXPORT_DEFAULT_DAYS = 7;
const EXPORT_MAX_DAYS = 31;
const CLIENT_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const STAFF_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BAD_REQUEST: ReadonlySet<OrderErrorCode> = new Set([
  "empty_order",
  "unknown_item",
  "unavailable_item",
  "bad_size",
  "bad_quantity",
  "total_too_large",
  "bad_rating",
]);

function forwardedFor(c: Context, hops: number): string | undefined {
  const list = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (list.length === 0) return undefined;
  return list[Math.max(0, list.length - hops)];
}

function remoteAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createApp(deps: AppDeps): App {
  const { config, store } = deps;
  const upi = deps.payments?.upi;
  if (upi !== undefined) {
    const { currency } = config.business;
    if (currency !== "INR") {
      throw new Error(`ibow: UPI_VPA is set, but UPI takes INR only and this business uses ${currency}; unset UPI_VPA`);
    }
    try {
      upiIntent({ ...upi, amountMinor: 100, currency, token: "01-001" });
    } catch (e) {
      throw new Error(`ibow: UPI_VPA must be a UPI ID like name@bank: ${(e as Error).message}`);
    }
  }
  const now = deps.now ?? Date.now;
  store.useTimeZone(config.business.timeZone);
  /** The catalog as customers see it: catalog.json with the owner's availability switches from the store. */
  let live = withAvailability(config, store.availability());
  const trustProxy = deps.trustProxy ?? 0;
  const clientIp =
    deps.clientIp ?? (trustProxy > 0 ? (c: Context) => forwardedFor(c, trustProxy) ?? remoteAddress(c) : remoteAddress);
  function isHttps(c: Context): boolean {
    if (trustProxy > 0) {
      const proto = c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim();
      if (proto !== undefined) return proto === "https";
    }
    return new URL(c.req.url).protocol === "https:";
  }
  const sessionTtlMs = deps.sessionTtlMs ?? 12 * 60 * 60_000;
  const orderLimiter = createLimiter(deps.limits?.orderCreate ?? { max: 60, windowMs: 60_000 });
  const pinLimiter = createLimiter(deps.limits?.pinFailures ?? { max: 5, windowMs: 15 * 60_000 });
  const userLockout = createLockout(
    deps.limits?.pinUser ?? { max: 10, windowMs: 15 * 60_000, maxMs: 24 * 60 * 60_000 },
  );
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const http = new Hono<Env>();

  http.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof InputError) return c.json({ error: err.code, message: err.message }, 400);
    if (err instanceof OrderError) {
      return c.json({ error: err.code, message: err.message }, BAD_REQUEST.has(err.code) ? 400 : 409);
    }
    // Already worded for the owner, and never holding the key (D-026).
    if (err instanceof AiError) return c.json({ error: err.code, message: err.message }, 502);
    if (err instanceof PaymentError) {
      return c.json({ error: err.code, message: err.message }, err.code === "bad_amount" ? 400 : 409);
    }
    console.error(err);
    return c.json(
      { error: "internal", message: "internal: unexpected server error; the server log has the details" },
      500,
    );
  });

  http.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "too_large", message: `too_large: expected a body up to ${MAX_BODY_BYTES} bytes` }, 413),
    }),
  );

  http.use("/api/*", async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE);
    c.set("session", id ? store.getSession(hashSessionId(id), now()) : undefined);
    await next();
  });

  async function body(c: Context): Promise<Record<string, unknown>> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    return input.object(raw);
  }

  /** What a session may work: the owner everything, a staff member what their role says. */
  function accessOf(session: Session): StaffRole {
    return session.role === "owner" ? "all" : (store.getStaff(session.user)?.role ?? "all");
  }

  /** `counter` means the counter's actions (payments, status, adding and serving lines): counter or all roles, or the owner. */
  function requireRole(c: Context<Env>, role: Role | "counter"): Session {
    const session = c.get("session");
    if (session === undefined) throw new ApiError(401, "no_session", "expected a staff or owner session, found none");
    if (role === "owner" && session.role !== "owner") {
      throw new ApiError(403, "forbidden", `expected the owner, found ${session.role} ${session.user}`);
    }
    if (role === "counter" && accessOf(session) === "station") {
      throw new ApiError(403, "forbidden", `expected a counter role, found station staff ${session.user}`);
    }
    return session;
  }

  function load(id: string): { order: Order; secret: string } {
    const found = store.getOrder(id);
    if (found === undefined) throw new ApiError(404, "no_such_order", `expected a known order id, found ${id}`);
    return found;
  }

  /** The customer's own order, proven by its secret key (header `X-Order-Key` or `?key=`). */
  function ownOrder(c: Context, id: string): Order {
    const key = c.req.header("x-order-key") ?? c.req.query("key");
    if (!key) throw new ApiError(401, "no_key", "expected the order's key, found none");
    const found = store.getOrder(id);
    if (found === undefined || !sameSecret(key, found.secret)) {
      throw new ApiError(404, "no_such_order", "expected a known order id and its key, found no match");
    }
    return found.order;
  }

  /**
   * Re-read the order, apply a core rule, persist and emit, all synchronously: no other request can run between the
   * read and the write. Callers must finish every `await` (such as reading the body) before calling this.
   */
  function change(read: () => Order, type: EventType, next: (o: Order) => Order): Order {
    const current = read();
    const updated = next(current);
    // A rule that changed nothing (marking ready what already is) returns the same order: nothing to store or send.
    if (updated === current) return updated;
    const event = store.saveOrder(updated, type, now());
    events.emit("event", event);
    return updated;
  }

  const demo = deps.demo;
  // Always answers, so a sign-in screen can ask without a console error; only a demo's answer holds PINs.
  http.get("/api/demo", (c) =>
    c.json(
      demo === undefined
        ? { demo: false }
        : {
            demo: true,
            staff: [
              { id: "counter", pin: demo.pins.counter, role: "counter" },
              { id: "station", pin: demo.pins.station, role: "station" },
            ],
            owner: { pin: demo.pins.owner },
          },
    ),
  );

  http.get("/api/catalog", (c) => {
    const { name, currency, timeZone, maxQtyPerLine, cashShortcutsMinor, hours } = config.business;
    return c.json({
      business: {
        name,
        currency,
        timeZone,
        maxQtyPerLine,
        ...(cashShortcutsMinor ? { cashShortcutsMinor } : {}),
        ...(hours ? { hours } : {}),
      },
      payments: { upi: upi !== undefined },
      ...live.catalog,
    });
  });

  http.get("/api/orders/:id/upi", (c) => {
    const order = ownOrder(c, c.req.param("id"));
    if (upi === undefined) throw new ApiError(404, "no_upi", "expected a business that takes UPI, found none set up");
    const intent = upiIntent({ ...upi, amountMinor: orderTotal(order), currency: order.currency, token: order.token });
    return c.json({ intent });
  });

  http.post("/api/orders", async (c) => {
    const b = await body(c);
    const clientKey = input.text(b.clientKey, "clientKey", 128, CLIENT_KEY);
    const lines = input.lines(b.lines);
    const name = b.customerName === undefined ? undefined : input.text(b.customerName, "customerName", 60);
    if (c.get("session") === undefined && !orderLimiter.hit(clientIp(c), now())) {
      throw new ApiError(
        429,
        "rate_limited",
        "expected fewer new orders from this address, found too many; wait a minute",
      );
    }
    const at = now();
    const id = randomUUID();
    const result = store.createOrder({
      id,
      secret: randomBytes(24).toString("base64url"),
      clientKey,
      now: at,
      timeZone: config.business.timeZone,
      build: (token) => createOrder(live, { id, token, now: at, lines, ...(name ? { customerName: name } : {}) }),
    });
    if (result.event) events.emit("event", result.event);
    const lastEventId = result.event?.id ?? store.lastEventId();
    return c.json({ order: customerView(result.order), key: result.secret, lastEventId }, result.created ? 201 : 200);
  });

  http.get("/api/orders", (c) => {
    requireRole(c, "staff");
    return c.json({ orders: store.openOrders().map(staffView), lastEventId: store.lastEventId() });
  });

  http.get("/api/orders/:id", (c) => {
    const id = c.req.param("id");
    if (c.get("session") !== undefined)
      return c.json({ order: staffView(load(id).order), lastEventId: store.lastEventId() });
    const own = ownOrder(c, id);
    return c.json({
      order: customerView(own),
      lastEventId: store.lastEventId(),
      ahead: ordersAhead(own, store.openOrders()),
    });
  });

  http.put("/api/orders/:id/lines", async (c) => {
    const lines = input.lines((await body(c)).lines);
    const updated = change(
      () => ownOrder(c, c.req.param("id")),
      "order.updated",
      (o) => customerEdit(live, o, lines, now()),
    );
    return c.json({ order: customerView(updated) });
  });

  http.post("/api/orders/:id/claim", async (c) => {
    const b = await body(c);
    const method = b.method === undefined ? "upi" : input.method(b.method, "method");
    const updated = change(
      () => ownOrder(c, c.req.param("id")),
      "order.updated",
      (o) => ({
        ...o,
        payment: claimPayment(o.payment, { method, amountMinor: orderTotal(o), now: now() }),
      }),
    );
    return c.json({ order: customerView(updated) });
  });

  http.post("/api/orders/:id/review", async (c) => {
    const b = await body(c);
    const rating = input.wholeNumber(b.rating, "rating");
    const text = b.text === undefined || b.text === "" ? undefined : input.text(b.text, "text", MAX_REVIEW_TEXT);
    const review = reviewOrder(ownOrder(c, c.req.param("id")), { rating, ...(text ? { text } : {}), now: now() });
    if (!store.putReview(review)) {
      throw new ApiError(409, "already_reviewed", "expected an order without a review, found one already");
    }
    return c.json({ ok: true }, 201);
  });

  http.post("/api/orders/:id/confirm", async (c) => {
    const session = requireRole(c, "counter");
    const b = await body(c);
    const method = input.method(b.method, "method");
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => ({
        ...o,
        payment: confirmPayment(o.payment, { by: session.user, method, amountMinor, now: now() }),
      }),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/topup", async (c) => {
    const session = requireRole(c, "counter");
    const b = await body(c);
    const method = input.method(b.method, "method");
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => topUp(o, { by: session.user, method, amountMinor, now: now() }),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/advance", (c) => {
    requireRole(c, "counter");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.status",
      (o) => advanceStatus(o, now()),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/undo", (c) => {
    requireRole(c, "counter");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.status",
      (o) => undoStatus(o, now()),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/lines", async (c) => {
    requireRole(c, "counter");
    const lines = input.lines((await body(c)).lines);
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => addLines(live, o, lines),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/lines/:index/served", (c) => {
    requireRole(c, "counter");
    const index = Number(c.req.param("index"));
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => markServed(o, index),
    );
    return c.json({ order: staffView(updated) });
  });

  http.get("/api/tokens/:token", (c) => {
    const token = c.req.param("token");
    const order = store.findByToken(token, dayKey(now(), config.business.timeZone));
    if (order === undefined) throw new ApiError(404, "no_such_token", `expected a token issued today, found ${token}`);
    return c.json({ token: order.token, status: order.status, ready: isReady(order) });
  });

  function station(id: string): string {
    if (!config.stations.some((s) => s.id === id)) {
      throw new ApiError(404, "no_such_station", `expected a station from stations.json, found ${id}`);
    }
    return id;
  }

  http.get("/api/stations", (c) => {
    requireRole(c, "staff");
    return c.json({
      stations: config.stations.map(({ id, name, view, speak, print }) => ({ id, name, view, speak, print })),
    });
  });

  /** Ready or take back lines of several orders; every order is checked before any changes, so a bad line undoes it all. */
  function readyRoute(rule: (o: Order, stationId: string, indexes: readonly number[]) => Order) {
    return async (c: Context<Env>) => {
      requireRole(c, "staff");
      const stationId = station(c.req.param("id") ?? "");
      const refs = input.lineRefs((await body(c)).lines);
      const byOrder = new Map<string, number[]>();
      for (const r of refs) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r.index]);
      for (const [orderId, indexes] of byOrder) rule(load(orderId).order, stationId, indexes);
      const orders = [...byOrder].map(([orderId, indexes]) =>
        stationView(
          change(
            () => load(orderId).order,
            "order.updated",
            (o) => rule(o, stationId, indexes),
          ),
          stationId,
        ),
      );
      return c.json({ orders });
    };
  }

  http.post("/api/stations/:id/ready", readyRoute(markReady));
  http.post("/api/stations/:id/unready", readyRoute(unmarkReady));

  http.get("/api/stations/:id/orders", (c) => {
    requireRole(c, "staff");
    const stationId = station(c.req.param("id"));
    const orders = store
      .openOrders()
      .map((o) => stationView(o, stationId))
      .filter((v) => v.lines.length > 0);
    return c.json({ orders, lastEventId: store.lastEventId() });
  });

  http.post("/api/login", async (c) => {
    const b = await body(c);
    const user = input.text(b.user, "user", 40, STAFF_ID);
    const key = `${clientIp(c)}|${user}`;
    const at = now();
    // Reserve the attempt before the (slow, async) check, so parallel guesses can't all be evaluated.
    if (!pinLimiter.hit(key, at) || !userLockout.attempt(user, at)) {
      throw new ApiError(429, "rate_limited", "expected fewer PIN attempts, found too many; wait and try again");
    }
    let role: Role = "staff";
    let hash: string | undefined;
    if (user === "owner") {
      role = "owner";
      hash = deps.ownerPinHash;
    } else hash = store.getStaff(user)?.pinHash;
    const known = hash !== undefined;
    // Unknown user ids are checked against a dummy hash, so a reply's timing doesn't reveal which ids exist.
    const checked = await verifyPin(isPin(b.pin) ? b.pin : "00000000", hash ?? DUMMY_HASH);
    if (!(known && isPin(b.pin) && checked)) {
      throw new ApiError(401, "bad_pin", "expected a known user and the right PIN, found no match");
    }
    userLockout.reset(user);
    pinLimiter.reset(key);
    if (user !== "owner" && hash !== undefined && needsRehash(hash)) {
      // An older-format hash is replaced now, while the right PIN is in hand (the owner's lives in the settings).
      const member = store.getStaff(user);
      if (member) store.putStaff({ ...member, pinHash: await hashPin(b.pin as string) });
    }
    const id = newSessionId();
    store.putSession({ idHash: hashSessionId(id), user, role, expiresAt: at + sessionTtlMs }, at);
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(sessionTtlMs / 1000),
      secure: isHttps(c),
    });
    return c.json({ user, role });
  });

  http.post("/api/logout", (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) store.deleteSession(hashSessionId(id));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  http.get("/api/me", (c) => {
    const s = requireRole(c, "staff");
    return c.json({ user: s.user, role: s.role, access: accessOf(s) });
  });

  http.get("/api/staff", (c) => {
    requireRole(c, "owner");
    return c.json({ staff: store.listStaff() });
  });

  http.put("/api/staff/:id", async (c) => {
    requireRole(c, "owner");
    const id = c.req.param("id");
    if (!STAFF_ID.test(id) || id === "owner") {
      throw new InputError("id", "a staff id of lowercase letters, digits and dashes, not owner", id);
    }
    const b = await body(c);
    const name = input.text(b.name, "name", 60);
    if (!isPin(b.pin)) throw new InputError("pin", "a PIN of 4 to 12 digits", "something else");
    const role = b.role === undefined ? "all" : b.role;
    if (role !== "counter" && role !== "station" && role !== "all") {
      throw new InputError("role", '"counter", "station" or "all"', role);
    }
    const pinHash = await hashPin(b.pin);
    store.putStaff({ id, name, pinHash, role });
    // A new PIN or role takes effect at once: every session of this user ends.
    store.deleteSessionsFor(id);
    return c.json({ id, name, role });
  });

  // ── Owner dashboard ──────────────────────────────────────────────────────────────────────────────────────────────

  http.put("/api/owner/items/:id", async (c) => {
    requireRole(c, "owner");
    const itemId = c.req.param("id");
    if (!config.items.has(itemId)) {
      throw new ApiError(404, "no_such_item", `expected an item id from the catalog, found ${itemId}`);
    }
    const b = await body(c);
    if (typeof b.available !== "boolean") throw new InputError("available", "true or false", typeof b.available);
    store.setAvailability(itemId, b.available);
    live = withAvailability(config, store.availability());
    return c.json({ itemId, available: b.available });
  });

  http.get("/api/owner/orders", (c) => {
    requireRole(c, "owner");
    const { timeZone, retentionDays } = config.business;
    const day = c.req.query("day") ?? dayKey(now(), timeZone);
    if (!DAY_KEY.test(day)) throw new InputError("day", "a date as YYYY-MM-DD", day);
    const named = store
      .namedOrdersSince(now() - retentionDays * DAY_MS)
      .map((o) => ({ name: o.name, day: dayKey(o.createdAt, timeZone) }));
    return c.json({
      day,
      orders: store.ordersOnDay(day).map(staffView),
      regulars: earlierVisits(named, day),
      lastEventId: store.lastEventId(),
    });
  });

  /** The business's records as one JSON file, for the owner's own keeping (no sessions, no PIN hashes; docs/install.md). */
  http.get("/api/owner/export", (c) => {
    requireRole(c, "owner");
    const at = now();
    const to = c.req.query("to") ?? dayKey(at, config.business.timeZone);
    const isDay = (v: string) => {
      const ms = Date.parse(`${v}T00:00:00Z`);
      return DAY_KEY.test(v) && !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
    };
    if (!isDay(to)) throw new ApiError(400, "bad_day", `expected to as a day like 2026-11-26, found ${to}`);
    const from =
      c.req.query("from") ??
      new Date(Date.parse(`${to}T00:00:00Z`) - (EXPORT_DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    if (!isDay(from)) throw new ApiError(400, "bad_day", `expected from as a day like 2026-11-26, found ${from}`);
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
    if (span < 1) throw new ApiError(400, "bad_day", `expected from not after to, found ${from} after ${to}`);
    if (span > EXPORT_MAX_DAYS) {
      throw new ApiError(
        400,
        "range_too_wide",
        `expected at most ${EXPORT_MAX_DAYS} days per export, found ${span}; ask for it in pages with from and to`,
      );
    }
    const body = {
      exportedAt: at,
      range: { from, to },
      schemaVersion: store.schemaVersion(),
      tables: store.exportData(from, to),
    };
    return c.json(body, 200, {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="ibow-export-${dayKey(at, config.business.timeZone)}.json"`,
    });
  });

  const buildReport = createReportBuilder(store, config.business.timeZone);

  // Kept until an event changes something or the business day turns, shared by every tab and device: an open dashboard
  // with nothing happening costs no reads at all after the first (D-044). "Yesterday so far" is therefore as of the
  // last change, not of the clock.
  let insightsCache: { key: string; body: unknown } | undefined;
  http.get("/api/owner/insights", (c) => {
    requireRole(c, "owner");
    const { currency, timeZone } = config.business;
    const at = now();
    const key = `${store.lastEventId()}:${localTime(at, timeZone).day}`;
    if (insightsCache?.key !== key) {
      insightsCache = { key, body: { currency, timeZone, report: buildReport(at) } };
    }
    return c.json(insightsCache.body);
  });

  http.get("/api/owner/reviews", (c) => {
    requireRole(c, "owner");
    const reviews = store.recentReviews(REVIEWS_SHOWN);
    const sum = reviews.reduce((n, r) => n + r.rating, 0);
    return c.json({
      reviews,
      count: reviews.length,
      averageRating: reviews.length === 0 ? null : sum / reviews.length,
    });
  });

  // ── AI analyst (opt-in; D-026, D-027): no route at all unless a model is configured ─────────────────────────────

  if (deps.ai !== undefined) {
    const model = deps.ai;
    const askLimit = deps.limits?.ask ?? { max: 30, windowMs: 60 * 60_000 };
    const askLimiter = createLimiter(askLimit);
    http.post("/api/owner/ask", async (c) => {
      const session = requireRole(c, "owner");
      const b = await body(c);
      const question = input.text(b.question, "question", MAX_QUESTION_CHARS);
      if (question.trim() === "") throw new InputError("question", "a question in words", question);
      const at = now();
      if (!askLimiter.hit(session.idHash, at)) {
        const minutes = Math.round(askLimit.windowMs / 60_000);
        throw new ApiError(
          429,
          "rate_limited",
          `expected at most ${askLimit.max} questions in ${minutes} minutes per sign-in, found more; wait and ask again`,
        );
      }
      const { currency, timeZone } = config.business;
      return c.json({
        answer: await ask(
          model,
          question,
          analystContext(store.salesSince(at - 8 * DAY_MS), at, timeZone, currency, buildReport(at)),
        ),
      });
    });
  }

  const look = deps.look ?? { theme: DEFAULT_THEME, strings: {}, media: new Map(), imageOrigins: [] };
  const themeHandle = registerTheme(http, {
    look,
    store,
    build: deps.client?.build ?? "dev",
    timeZone: config.business.timeZone,
    now,
  });
  registerStreams(http, {
    config,
    store,
    events,
    now,
    ownOrder,
    requireRole,
    heartbeatMs: deps.heartbeatMs ?? 15_000,
  });
  // A liveness check for a supervisor or a smoke test: no session, no database, nothing to rate-limit.
  http.get("/healthz", (c) => c.text("ok", 200, { "cache-control": "no-store" }));
  if (deps.client) {
    registerClient(http, deps.client, {
      name: config.business.name,
      ai: deps.ai !== undefined,
      imageOrigins: look.imageOrigins,
      themeColor: themeHandle.headerColor,
      showcase: deps.demo !== undefined || config.business.showcase === true,
    });
  }
  return { http, events, headerColor: themeHandle.headerColor };
}
