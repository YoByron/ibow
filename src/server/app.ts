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
import { type Config, isRoom, withAvailability } from "../core/config.ts";
import { FlagError } from "../core/flags.ts";
import { businessWeekday, closedDayAt, nextOpenDay, takesOrdersAt } from "../core/hours.ts";
import { localTime } from "../core/insights.ts";
import { can, type Level, mayRefund, POWERS, type Power, refundCeiling, TABLE } from "../core/levels.ts";
import {
  addLines,
  advanceStatus,
  closeIfHandedOver,
  createOrder,
  customerEdit,
  isReady,
  isServed,
  markReady,
  markServed,
  type Order,
  OrderError,
  type OrderErrorCode,
  orderTotal,
  outstandingMinor,
  topUp,
  undoStatus,
  unmarkReady,
} from "../core/orders.ts";
import {
  claimPayment,
  confirmPayment,
  PaymentError,
  type PaymentMethod,
  refundPayment,
  upiIntent,
} from "../core/payments.ts";
import { earlierVisits } from "../core/regulars.ts";
import { MAX_REVIEW_TEXT, reviewOrder } from "../core/reviews.ts";
import { assertNotOnRoomBill, openRoomOrders } from "../core/rooms.ts";
import { ordersAhead } from "../core/storefront.ts";
import { DEFAULT_THEME } from "../core/theme.ts";
import { dayKey, tokenForNumber } from "../core/tokens.ts";
import { customerView, staffView, stationView } from "../core/views.ts";
import type { EventType, Session, Store } from "../store/store.ts";
import { registerAdmin, systemFlags } from "./admin.ts";
import { DUMMY_HASH, hashPin, hashSessionId, isPin, needsRehash, newSessionId, sameSecret, verifyPin } from "./auth.ts";
import { registerCalendar } from "./calendar.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";
import { InputError } from "./input.ts";
import { type Backoff, createLimiter, createLockout, type Limit } from "./limits.ts";
import { createReportBuilder } from "./report.ts";
import { roomKeys } from "./room-keys.ts";
import { registerRooms } from "./rooms.ts";
import { type ClientFiles, registerClient } from "./static.ts";
import { registerStreams } from "./streams.ts";
import { createTelemetry } from "./telemetry.ts";
import { type Look, registerTheme } from "./theme.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  /** From `OWNER_PIN_HASH`; see scripts/hash-pin.ts. */
  ownerPinHash: string;
  /**
   * `RENAME_ADMIN_STAFF`: a new id for a staff member saved as `admin` before D-072, applied once at start; without it such
   * a record stops the boot.
   */
  renameAdminStaff?: string;
  /** From `ADMIN_PIN_HASH`, the system admin's own PIN (D-072); without it nobody can sign in as admin. */
  adminPinHash?: string;
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
  demo?: { pins: { owner: string; counter: string; station: string; manager: string; admin: string } };
  /** The newest backup of the database this install can see (ms), for the admin's health page; Node reads `BACKUP_DIR`. */
  lastBackup?: () => number | undefined;
  /** When this process started (ms), for uptime; defaults to when the app was made. */
  startedAt?: number;
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
  /** Days before names, review text and notes are cleared: the admin's switch, else `business.json`. */
  retentionDays(): number;
  /** Whether the showcase page is served now. */
  showcaseOn(): boolean;
  /** Writes the health counts now (before a process stops). */
  flushTelemetry(): void;
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
  "bad_extras",
  "bad_note",
  "bad_spot",
  "bad_room",
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
  // "admin" signs in as the system admin since D-072; a staff member saved under that id before then could never sign in again.
  // RENAME_ADMIN_STAFF renames that record once; on a Worker it is the only way in, since a Durable Object's SQL can't be
  // reached from outside.
  if (store.getStaff("admin") !== undefined) {
    const to = deps.renameAdminStaff?.trim();
    if (to === undefined || to === "") {
      throw new Error(
        "ibow: a staff member has the id \"admin\", which is now the system admin's sign-in (D-072); expected no such staff record, found one; set RENAME_ADMIN_STAFF=<new staff id> and start again (Node: in .env; Cloudflare: npx wrangler secret put RENAME_ADMIN_STAFF, then deploy), or on Node stop the server and run: sqlite3 data/ibow.db \"UPDATE staff SET id = '<new staff id>' WHERE id = 'admin'; DELETE FROM sessions WHERE user = 'admin'\"",
      );
    }
    if (!STAFF_ID.test(to) || to === "admin" || to === "owner") {
      throw new Error(
        `ibow: RENAME_ADMIN_STAFF: expected a staff id (lowercase letters, digits and dashes, not admin or owner), found ${JSON.stringify(to)}`,
      );
    }
    if (store.getStaff(to) !== undefined) {
      throw new Error(`ibow: RENAME_ADMIN_STAFF: expected a free staff id, found ${JSON.stringify(to)} already taken`);
    }
    store.renameStaff("admin", to);
    console.warn(
      `ibow: renamed the staff member "admin" to "${to}" (RENAME_ADMIN_STAFF); they sign in with that id now; unset the setting`,
    );
  }

  /**
   * The catalog as customers see it: catalog.json with the owner's availability switches from the store, and any item
   * whose count for today has run out switched off. Rebuilt (two tiny reads) before each place it matters.
   */
  let live = config;
  function refreshLive(withCounts = true): void {
    const switches = store.availability();
    // Changing an order that already holds an item must not fail because the item has just run out: the store checks
    // such a change against what is left, so edits and added lines ask for the switches alone.
    if (withCounts) {
      for (const [itemId, left] of store.dailyCounts(dayKey(now(), config.business.timeZone))) {
        if (left <= 0) switches.set(itemId, false);
      }
    }
    live = withAvailability(config, switches);
  }
  refreshLive();
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
  const system = systemFlags(store, {
    retentionDays: config.business.retentionDays,
    ai: deps.ai !== undefined,
    showcase: deps.demo !== undefined || config.business.showcase === true,
  });
  let streamsHandle: { open(): number } | undefined;
  const telemetry = createTelemetry({
    store,
    now,
    build: deps.client?.build ?? "dev",
    startedAt: deps.startedAt ?? now(),
    openStreams: () => streamsHandle?.open() ?? 0,
    ...(deps.lastBackup === undefined ? {} : { lastBackup: deps.lastBackup }),
  });
  http.use("*", telemetry.middleware);

  http.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof InputError) return c.json({ error: err.code, message: err.message }, 400);
    if (err instanceof OrderError) {
      return c.json({ error: err.code, message: err.message }, BAD_REQUEST.has(err.code) ? 400 : 409);
    }
    // Already worded for the owner, and never holding the key (D-026).
    if (err instanceof AiError) return c.json({ error: err.code, message: err.message }, 502);
    if (err instanceof FlagError) {
      return c.json({ error: err.code, message: err.message }, err.code === "no_such_flag" ? 404 : 400);
    }
    if (err instanceof PaymentError) {
      return c.json({ error: err.code, message: err.message }, err.code === "bad_amount" ? 400 : 409);
    }
    console.error(err);
    return c.json(
      { error: "internal", message: "internal: unexpected server error; the server log has the details" },
      500,
    );
  });

  // A demo is never a business's real ordering page: search engines are told not to list it or follow its links.
  if (deps.demo !== undefined) {
    http.use("*", async (c, next) => {
      await next();
      c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
    });
  }

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

  /** What a session may work: the owner and a manager everything, a staff member what their role says. */
  function accessOf(session: Session): "counter" | "station" | "all" {
    if (session.role === "owner" || session.role === "manager") return "all";
    const role = store.getStaff(session.user)?.role ?? "all";
    return role === "manager" ? "all" : role;
  }

  /**
   * One check for every protected route: a session whose level the table in `src/core/levels.ts` gives `power`. The
   * counter's actions (`orders.run`) also refuse station-only staff.
   */
  function requirePower(c: Context<Env>, power: Power): Session {
    const session = c.get("session");
    if (session === undefined) {
      throw new ApiError(401, "no_session", `expected a signed-in ${TABLE[power].levels.join(", ")}, found none`);
    }
    if (!can(session.role, power)) {
      throw new ApiError(
        403,
        "forbidden",
        `expected ${TABLE[power].levels.join(" or ")} for ${power}, found ${session.role} ${session.user}`,
      );
    }
    if (power === "orders.run" && accessOf(session) === "station") {
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
    // A rule may move the status as a consequence (the first ready line, the last line handed over, D-097).
    const event = store.saveOrder(updated, updated.status === current.status ? type : "order.status", now());
    events.emit("event", event);
    return updated;
  }

  const keys = roomKeys(store);
  const rooms = config.zones.filter((z) => z.kind === "room").flatMap((z) => z.spots.map((s) => s.id));
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
              { id: "manager", pin: demo.pins.manager, role: "manager" },
            ],
            owner: { pin: demo.pins.owner },
            admin: { pin: demo.pins.admin },
            // A demo's room QRs are public anyway: the storefront picks a room's key from here when a link (a proposal
            // page's `/?spot=rooms-1`) carries none (D-082). A real install never answers with a key.
            ...(rooms.length === 0 ? {} : { roomKeys: Object.fromEntries(rooms.map((r) => [r, keys.keyFor(r)])) }),
          },
    ),
  );

  http.get("/api/catalog", (c) => {
    refreshLive();
    const left = Object.fromEntries(store.dailyCounts(dayKey(now(), config.business.timeZone)));
    const { name, currency, timeZone, maxQtyPerLine, lateMinutes, cashShortcutsMinor, hours } = config.business;
    return c.json({
      business: {
        name,
        currency,
        timeZone,
        maxQtyPerLine,
        lateMinutes,
        ...(cashShortcutsMinor ? { cashShortcutsMinor } : {}),
        ...(hours ? { hours } : {}),
      },
      payments: { upi: upi !== undefined, card: config.business.card === true },
      ...(config.zones.length === 0 ? {} : { zones: config.zones }),
      ...(Object.keys(left).length === 0 ? {} : { left }),
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
    const spotId = b.spot === undefined ? undefined : input.text(b.spot, "spot", 100);
    if (b.pay !== undefined && b.pay !== "room")
      throw new InputError("pay", '"room" (the room bill) or nothing', b.pay);
    const pay = b.pay === "room" ? ("room" as const) : undefined;
    // Only the QR in a room can charge it: its key, or staff who may run orders keying one in (D-082).
    const session = c.get("session");
    const staffMay = session !== undefined && can(session.role, "orders.run") && accessOf(session) !== "station";
    if (
      pay === "room" &&
      spotId !== undefined &&
      isRoom(config, spotId) &&
      !staffMay &&
      !keys.check(spotId, b.roomKey)
    ) {
      throw new ApiError(
        403,
        "room_key",
        `expected the key from the QR in ${config.spots.get(spotId)?.label ?? spotId} to put the order on its room bill, found ${b.roomKey === undefined ? "none" : "a key that does not match"}; scan the QR in your room, or pay the usual way`,
      );
    }
    const hours = config.business.hours;
    // Past the last-order time customers are turned away at once; staff at the counter may still key an order in.
    if (
      c.get("session") === undefined &&
      hours !== undefined &&
      !takesOrdersAt(hours, now(), config.business.timeZone)
    ) {
      const zone = config.business.timeZone;
      // A whole closed day names itself and the day ordering opens again; otherwise it is past the last-order time.
      if (closedDayAt(hours, now(), zone)) {
        const names: Record<string, string> = {
          sun: "Sunday",
          mon: "Monday",
          tue: "Tuesday",
          wed: "Wednesday",
          thu: "Thursday",
          fri: "Friday",
          sat: "Saturday",
        };
        const day = (at: number) => names[businessWeekday(hours, at, zone)] as string;
        throw new ApiError(
          409,
          "closed",
          `expected an order on an open day, found ${day(now())}, a closed day; we open again on ${day(nextOpenDay(hours, now(), zone))} at ${hours.open}`,
        );
      }
      throw new ApiError(
        409,
        "closed",
        `expected an order before the last-order time ${hours.lastOrder}, found it after; we open at ${hours.open}`,
      );
    }
    if (c.get("session") === undefined && !orderLimiter.hit(clientIp(c), now())) {
      throw new ApiError(
        429,
        "rate_limited",
        "expected fewer new orders from this address, found too many; wait a minute",
      );
    }
    const at = now();
    refreshLive();
    const id = randomUUID();
    const result = store.createOrder({
      id,
      secret: randomBytes(24).toString("base64url"),
      clientKey,
      now: at,
      timeZone: config.business.timeZone,
      build: (token) =>
        createOrder(live, {
          id,
          token,
          now: at,
          lines,
          ...(name ? { customerName: name } : {}),
          ...(spotId === undefined ? {} : { spotId }),
          ...(pay === undefined ? {} : { pay }),
        }),
    });
    if (result.event) events.emit("event", result.event);
    const lastEventId = result.event?.id ?? store.lastEventId();
    return c.json({ order: customerView(result.order), key: result.secret, lastEventId }, result.created ? 201 : 200);
  });

  http.get("/api/orders", (c) => {
    requirePower(c, "orders.view");
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
    refreshLive(false);
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
      (o) => {
        assertNotOnRoomBill(o, "a customer's claim");
        return {
          ...o,
          payment: claimPayment(o.payment, { method, amountMinor: orderTotal(o), now: now() }),
        };
      },
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

  /** Card is a method staff record only where `business.json` says the counter has a terminal. */
  function checkMethod(method: PaymentMethod): void {
    if (method === "card" && config.business.card !== true) {
      throw new ApiError(
        409,
        "no_card",
        'expected a business that takes card ("card": true in business.json), found none',
      );
    }
  }

  http.post("/api/orders/:id/confirm", async (c) => {
    const session = requirePower(c, "orders.run");
    const b = await body(c);
    const method = input.method(b.method, "method");
    checkMethod(method);
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => {
        assertNotOnRoomBill(o, "a counter payment");
        // Paid for food already handed over: nothing is left to do, so the order closes (D-097).
        const at = now();
        return closeIfHandedOver(
          { ...o, payment: confirmPayment(o.payment, { by: session.user, method, amountMinor, now: at }) },
          at,
        );
      },
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/topup", async (c) => {
    const session = requirePower(c, "orders.run");
    const b = await body(c);
    const method = input.method(b.method, "method");
    checkMethod(method);
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => {
        const at = now();
        return closeIfHandedOver(topUp(o, { by: session.user, method, amountMinor, now: at }), at);
      },
    );
    return c.json({ order: staffView(updated) });
  });

  /** Money handed back: amount, method, who and when go on the order and are netted in every total (D-071). */
  http.post("/api/orders/:id/refund", async (c) => {
    const session = requirePower(c, "refund");
    const b = await body(c);
    const method = input.method(b.method, "method");
    checkMethod(method);
    const amountMinor = input.wholeNumber(b.amountMinor, "amountMinor");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => {
        // A manager's limit is on the whole of one order's refunds, this one included (D-072).
        const before = o.payment.state === "confirmed" ? (o.payment.refunds ?? []) : [];
        const total = before.reduce((n, r) => n + r.amountMinor, 0) + amountMinor;
        if (!mayRefund(session.role, total, config.business.managerRefundLimitMinor)) {
          throw new ApiError(
            403,
            "refund_limit",
            `expected refunds on one order up to ${refundCeiling(session.role, config.business.managerRefundLimitMinor) ?? 0} minor units for ${session.role} ${session.user}, found ${total}; ask the owner`,
          );
        }
        return { ...o, payment: refundPayment(o.payment, { by: session.user, method, amountMinor, now: now() }) };
      },
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/advance", (c) => {
    requirePower(c, "orders.run");
    // `from`: the status the screen showed. The kitchen may have moved the order since (D-097); a tap on a screen a moment
    // behind then changes nothing instead of skipping a step, and the answer brings the screen up to date.
    const from = c.req.query("from");
    if (from !== undefined && !["pending", "preparing", "completed"].includes(from)) {
      throw new ApiError(
        400,
        "bad_input",
        `expected from to be pending, preparing or completed, found ${JSON.stringify(from)}`,
      );
    }
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.status",
      (o) => (from !== undefined && from !== o.status ? o : advanceStatus(o, now())),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/undo", (c) => {
    requirePower(c, "orders.run");
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.status",
      (o) => undoStatus(o, now()),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/lines", async (c) => {
    requirePower(c, "orders.run");
    const lines = input.lines((await body(c)).lines);
    refreshLive(false);
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => addLines(live, o, lines),
    );
    return c.json({ order: staffView(updated) });
  });

  http.post("/api/orders/:id/lines/:index/served", (c) => {
    requirePower(c, "orders.run");
    const index = Number(c.req.param("index"));
    const updated = change(
      () => load(c.req.param("id")).order,
      "order.updated",
      (o) => markServed(o, index, now()),
    );
    return c.json({ order: staffView(updated) });
  });

  http.get("/api/tokens/:token", (c) => {
    const day = dayKey(now(), config.business.timeZone);
    // A person may type the order number alone ("47"): that is today's `DD-047` (M13).
    const token = tokenForNumber(c.req.param("token"), day) ?? c.req.param("token");
    const order = store.findByToken(token, day);
    if (order === undefined) throw new ApiError(404, "no_such_token", `expected a token issued today, found ${token}`);
    return c.json({ token: order.token, status: order.status, ready: isReady(order), served: isServed(order) });
  });

  function station(id: string): string {
    if (!config.stations.some((s) => s.id === id)) {
      throw new ApiError(404, "no_such_station", `expected a station from stations.json, found ${id}`);
    }
    return id;
  }

  http.get("/api/stations", (c) => {
    requirePower(c, "orders.view");
    return c.json({
      stations: config.stations.map(({ id, name, view, speak, print, categories }) => ({
        id,
        name,
        view,
        speak,
        print,
        categories,
      })),
    });
  });

  /** Ready or take back lines of several orders; every order is checked before any changes, so a bad line undoes it all. */
  function readyRoute(rule: (o: Order, stationId: string, indexes: readonly number[], now?: number) => Order) {
    return async (c: Context<Env>) => {
      requirePower(c, "orders.view");
      const at = now();
      const stationId = station(c.req.param("id") ?? "");
      const refs = input.lineRefs((await body(c)).lines);
      const byOrder = new Map<string, number[]>();
      for (const r of refs) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r.index]);
      for (const [orderId, indexes] of byOrder) rule(load(orderId).order, stationId, indexes, at);
      const orders = [...byOrder].map(([orderId, indexes]) =>
        stationView(
          change(
            () => load(orderId).order,
            "order.updated",
            (o) => rule(o, stationId, indexes, at),
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
    requirePower(c, "orders.view");
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
    let role: Level = "staff";
    let hash: string | undefined;
    if (user === "owner") {
      role = "owner";
      hash = deps.ownerPinHash;
    } else if (user === "admin") {
      role = "admin";
      hash = deps.adminPinHash;
    } else {
      const member = store.getStaff(user);
      hash = member?.pinHash;
      if (member?.role === "manager") role = "manager";
    }
    const known = hash !== undefined;
    // Unknown user ids are checked against a dummy hash, so a reply's timing doesn't reveal which ids exist.
    const checked = await verifyPin(isPin(b.pin) ? b.pin : "00000000", hash ?? DUMMY_HASH);
    if (!(known && isPin(b.pin) && checked)) {
      throw new ApiError(401, "bad_pin", "expected a known user and the right PIN, found no match");
    }
    userLockout.reset(user);
    pinLimiter.reset(key);
    if (role !== "owner" && role !== "admin" && hash !== undefined && needsRehash(hash)) {
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
    const s = requirePower(c, "hub");
    const ceiling = can(s.role, "refund") ? refundCeiling(s.role, config.business.managerRefundLimitMinor) : 0;
    return c.json({
      user: s.user,
      role: s.role,
      access: accessOf(s),
      canRefund: ceiling === undefined || ceiling > 0,
      ...(ceiling === undefined || ceiling === 0 ? {} : { refundLimitMinor: ceiling }),
      powers: POWERS.filter((p) => can(s.role, p)),
    });
  });

  http.get("/api/staff", (c) => {
    requirePower(c, "staff.manage");
    return c.json({ staff: store.listStaff() });
  });

  http.put("/api/staff/:id", async (c) => {
    requirePower(c, "staff.manage");
    const id = c.req.param("id");
    if (!STAFF_ID.test(id) || id === "owner" || id === "admin") {
      throw new InputError("id", "a staff id of lowercase letters, digits and dashes, not owner or admin", id);
    }
    const b = await body(c);
    const name = input.text(b.name, "name", 60);
    if (!isPin(b.pin)) throw new InputError("pin", "a PIN of 4 to 12 digits", "something else");
    const role = b.role === undefined ? "all" : b.role;
    if (role !== "counter" && role !== "station" && role !== "all" && role !== "manager") {
      throw new InputError("role", '"counter", "station", "all" or "manager"', role);
    }
    const pinHash = await hashPin(b.pin);
    store.putStaff({ id, name, pinHash, role });
    // A new PIN or role takes effect at once: every session of this user ends.
    store.deleteSessionsFor(id);
    return c.json({ id, name, role });
  });

  // ── Owner dashboard ──────────────────────────────────────────────────────────────────────────────────────────────

  // The menu switches are the manager's too, so their path carries no level; the owner's dashboard keeps its old one.
  http.put("/api/menu/items/:id", menuSwitch);
  http.put("/api/owner/items/:id", menuSwitch);
  async function menuSwitch(c: Context<Env>) {
    requirePower(c, "menu.switch");
    const itemId = c.req.param("id") ?? "";
    if (!config.items.has(itemId)) {
      throw new ApiError(404, "no_such_item", `expected an item id from the catalog, found ${itemId}`);
    }
    const b = await body(c);
    if (b.available === undefined && b.count === undefined) {
      throw new InputError("available", "true or false, or a count for today", "neither");
    }
    if (b.available !== undefined) {
      if (typeof b.available !== "boolean") throw new InputError("available", "true or false", typeof b.available);
      store.setAvailability(itemId, b.available);
    }
    // `count` is how many are left today (a whole number, 0 sells the item out), or null to lift the limit.
    if (b.count !== undefined) {
      if (
        b.count !== null &&
        (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 0 || b.count > 100000)
      ) {
        throw new InputError("count", "a whole number from 0 to 100000, or null", b.count);
      }
      store.setDailyCount(itemId, dayKey(now(), config.business.timeZone), b.count ?? undefined);
    }
    refreshLive();
    return c.json({
      itemId,
      available: live.items.get(itemId)?.item.available !== false,
      ...(typeof b.count === "number" ? { count: b.count } : {}),
    });
  }

  http.get("/api/owner/orders", (c) => {
    requirePower(c, "reports");
    const { timeZone } = config.business;
    const day = c.req.query("day") ?? dayKey(now(), timeZone);
    if (!DAY_KEY.test(day)) throw new InputError("day", "a date as YYYY-MM-DD", day);
    const named = store
      .namedOrdersSince(now() - system.retentionDays() * DAY_MS)
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
    requirePower(c, "reports");
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
    store.setMeta("last_export", String(at));
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
    requirePower(c, "reports");
    const { currency, timeZone } = config.business;
    const at = now();
    const key = `${store.lastEventId()}:${localTime(at, timeZone).day}`;
    if (insightsCache?.key !== key) {
      const carry = store.carryStats(localTime(at, timeZone).day);
      insightsCache = {
        key,
        body: {
          currency,
          timeZone,
          report: buildReport(at),
          // Open room bills (D-082): ordered, not received, until the room is settled at checkout.
          ...(config.zones.some((z) => z.kind === "room")
            ? (() => {
                const open = openRoomOrders(store.openRoomOrders());
                return { rooms: { open: open.length, totalMinor: open.reduce((n, o) => n + outstandingMinor(o), 0) } };
              })()
            : {}),
          ...(carry.lines === 0
            ? {}
            : {
                carry: { lines: carry.lines, averageMs: Math.round(carry.totalMs / carry.lines), maxMs: carry.maxMs },
              }),
        },
      };
    }
    return c.json(insightsCache.body);
  });

  http.get("/api/owner/reviews", (c) => {
    requirePower(c, "reports");
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
    // The analyst panel asks first whether it is on, so the admin's switch reaches an open dashboard (D-075).
    http.get("/api/owner/ai", (c) => {
      requirePower(c, "ai.ask");
      return c.json({ on: system.aiOn() });
    });
    http.post("/api/owner/ask", async (c) => {
      const session = requirePower(c, "ai.ask");
      if (!system.aiOn()) {
        throw new ApiError(409, "ai_off", "expected the AI analyst to be on, found it switched off by the admin");
      }
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

  const look: Look = deps.look ?? { theme: DEFAULT_THEME, strings: {}, media: new Map(), imageOrigins: [] };
  const themeHandle = registerTheme(http, {
    look,
    store,
    build: deps.client?.build ?? "dev",
    timeZone: config.business.timeZone,
    now,
    brandName: config.business.name,
  });
  streamsHandle = registerStreams(http, {
    config,
    store,
    events,
    now,
    ownOrder,
    requirePower,
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
      showcase: () => system.showcaseOn(),
    });
  }
  registerCalendar(http, {
    store,
    timeZone: config.business.timeZone,
    currency: config.business.currency,
    now,
    requirePower,
    ...(look.events === undefined ? {} : { seed: look.events }),
  });
  registerRooms(http, { config, store, now, requirePower, events, checkMethod });
  registerAdmin(http, {
    config,
    accessOf,
    store,
    now,
    requirePower,
    system,
    aiConfigured: deps.ai !== undefined,
    theme: themeHandle,
    telemetry,
  });
  return {
    http,
    events,
    headerColor: themeHandle.headerColor,
    retentionDays: system.retentionDays,
    showcaseOn: system.showcaseOn,
    flushTelemetry: () => telemetry.flush(true),
  };
}
