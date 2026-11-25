/**
 * The business in SQL (D-004, D-031). Orders, their lines, status history and payment live in tables; every change also
 * appends a full snapshot to the event log, whose integer id is what SSE clients resume from. This module knows no
 * engine: it runs over a `SqlDriver`, which is `node:sqlite` in `./node.ts` and a Durable Object's storage on Workers.
 */

import type { CalendarEvent, EventInput } from "../core/calendar.ts";
import type { FlagChange, FlagValue } from "../core/flags.ts";
import {
  type DayRecord,
  type DayStats,
  emptyHourly,
  localTime,
  type MinuteSlot,
  type Receipt,
  type Sale,
} from "../core/insights.ts";
import type { Level } from "../core/levels.ts";
import {
  type LineExtra,
  type Order,
  OrderError,
  type OrderLine,
  type OrderStatus,
  type StatusChange,
} from "../core/orders.ts";
import type { Payment, PaymentMethod, Refund, TopUp } from "../core/payments.ts";
import type { Review } from "../core/reviews.ts";
import type { RoomBillMove, RoomSettlement } from "../core/rooms.ts";
import { nextToken, type TokenCounter } from "../core/tokens.ts";
import type { Row, SqlDriver } from "./driver.ts";

export type EventType = "order.created" | "order.updated" | "order.status";

export interface StoredEvent {
  id: number;
  type: EventType;
  at: number;
  orderId: string;
  /** Stations whose lines the order had before or after this change, sorted. */
  stations: string[];
  /** The whole order after the change. Audiences get a filtered view of it. */
  order: Order;
}

export interface EventFilter {
  orderId?: string;
  stationId?: string;
}

/**
 * What a staff member may work: the counter's actions (payments, status, adding and serving lines), stations, or both; or
 * `manager`, who works every screen and holds the manager level's powers (D-072).
 */
export type StaffRole = "counter" | "station" | "all" | "manager";

export interface StaffMember {
  id: string;
  name: string;
  pinHash: string;
  role: StaffRole;
}

/** The level a session signed in at: its own PIN, its own powers (`src/core/levels.ts`). */
export type Role = Level;

export interface Session {
  /** SHA-256 of the session id; the id itself only ever lives in the client's cookie. */
  idHash: string;
  user: string;
  role: Role;
  expiresAt: number;
}

export interface ForgetResult {
  orders: number;
  events: number;
  reviews: number;
  /** Order lines whose note was cleared: a note can carry a name ("for Priya"), so it goes with names (D-073). */
  notes: number;
}

export interface FlagAuditRow {
  id: number;
  at: number;
  by: string;
  level: Level;
  key: string;
  from: FlagValue | null;
  to: FlagValue;
}

/** What a process counted since its last flush: requests, 5xx answers, rows written, and per route a count, total and worst time. */
export interface TelemetryAdd {
  requests: number;
  errors: number;
  rowsWritten: number;
  routes: Record<string, { n: number; totalMs: number; maxMs: number }>;
}

export interface TelemetryHour extends TelemetryAdd {
  hour: number;
}

export interface CreateOrderInput {
  id: string;
  secret: string;
  /** Chosen by the client; a retry with the same key returns the first order instead of a second one. */
  clientKey: string;
  now: number;
  timeZone: string;
  /** Builds the order once the token is known; a throw rolls the whole create back, token included. */
  build: (token: string) => Order;
}

export interface CreateOrderResult {
  order: Order;
  secret: string;
  created: boolean;
  /** Present only when this call created the order. */
  event?: StoredEvent;
}

export interface Store {
  schemaVersion(): number;
  createOrder(input: CreateOrderInput): CreateOrderResult;
  getOrder(id: string): { order: Order; secret: string } | undefined;
  findByToken(token: string, day: string): Order | undefined;
  /** Orders not yet completed, oldest first. */
  openOrders(): Order[];
  /** Persists the changed order and appends its event, in one transaction. */
  saveOrder(order: Order, type: EventType, now: number): StoredEvent;
  eventsAfter(afterId: number, filter: EventFilter, limit?: number): StoredEvent[];
  lastEventId(): number;
  /** Deletes events logged before `before` (the replay log only; orders stay) and returns how many went. */
  pruneEvents(before: number): number;
  putStaff(member: StaffMember): void;
  /** Gives a staff member a new id and ends their sessions, in one transaction. */
  renameStaff(from: string, to: string): void;
  getStaff(id: string): StaffMember | undefined;
  listStaff(): { id: string; name: string; role: StaffRole }[];
  /** Stores a new session and drops any that expired by `now`. */
  putSession(session: Session, now: number): void;
  getSession(idHash: string, now: number): Session | undefined;
  deleteSession(idHash: string): void;
  /** Ends every session of one user, for a PIN change. */
  deleteSessionsFor(user: string): void;
  /** Stores the order's review; false if it already has one. */
  putReview(review: Review): boolean;
  getReview(orderId: string): Review | undefined;
  /**
   * Retention: clears customer names from orders placed before `cutoff` (and from every logged snapshot of them) and
   * the text of reviews written before it. Orders, lines and ratings stay, as anonymous counts. Returns what changed.
   * Rows before the last pass's cutoff were cleared by it, so only those from there on are read: the cost of an hourly
   * pass stays the hour's worth of rows, however long the history.
   */
  forgetCustomers(cutoff: number): ForgetResult;
  /** The cutoff of the last retention pass (0 before the first): each pass reads only rows from there to its own. */
  retentionMark(): number;
  /** The owner's switch for one item: on or off, overriding catalog.json until switched again. */
  setAvailability(itemId: string, available: boolean): void;
  availability(): Map<string, boolean>;
  /** Sets how many of an item are left on a business day, or clears its count (`undefined`: no limit). */
  setDailyCount(itemId: string, day: string, remaining: number | undefined): void;
  /** What is left today of each counted item; counts set for another day are not listed. */
  dailyCounts(day: string): Map<string, number>;
  /** The owner's Appearance override as saved JSON text, or undefined when the config's theme is in use. */
  themeOverride(): string | undefined;
  /** Saves the override, or clears it (`undefined`: reset to the config's theme). */
  setThemeOverride(json: string | undefined): void;
  /** Every order of a business-local day (the token day), oldest first. */
  ordersOnDay(day: string): Order[];
  /** Times, lines and confirmed money of every order placed at or after `from`, for insights: no names. */
  salesSince(from: number): Sale[];
  /**
   * The best sellers by units over the newest orders since `from` (at most FIGURE_ORDERS of them), as one aggregate query
   * on indexes: the storefront's bestseller tags. At most `FIGURE_TOP` rows.
   */
  topSellers(from: number): { itemId: string; qty: number }[];
  /** Minutes-to-ready of the newest completed orders since `from`, in ms, at most `FIGURE_WAITS` of them. */
  recentWaitsMs(from: number): number[];
  /** Names customers gave on orders placed at or after `from`, for repeat-customer badges. */
  namedOrdersSince(from: number): { name: string; createdAt: number }[];
  /** The latest reviews, newest first, each with its order's token. */
  recentReviews(limit: number): (Review & { token: string })[];
  /** Every table the business keeps, as rows, for the owner's export: no sessions, no PIN hashes, no event log. */
  exportData(fromDay: string, toDay: string): Record<string, Row[]>;
  /**
   * Tells the store the business's time zone, which fixes each order's, payment's and top-up's business-local day and
   * minute at write time, and fills them in for rows written before they existed. Called once when the app starts.
   */
  useTimeZone(timeZone: string): void;
  /**
   * A business day aggregated in SQL: orders placed in it and money confirmed in it, up to `untilMinute` of its clock
   * (the whole day by default), as the report reads them (D-044). `full` adds the hourly buckets and per-item lines.
   * Work is bounded by the day's orders, never by how long the history is.
   */
  dayStats(day: string, timeZone: string, opts?: { untilMinute?: number; full?: boolean }): DayStats;
  /**
   * How long lines of a business day stood ready before being handed over: how many have both times, their summed and
   * their longest wait in ms. One aggregate over the day's lines (reached through the day index), no row per order.
   */
  carryStats(day: string): { lines: number; totalMs: number; maxMs: number };
  /**
   * The totals of these days: stored ones as they were closed, the others read live (a day with no orders is left out).
   * Bounded by the number of days asked for, never by how many orders there are.
   */
  dayRecords(days: readonly string[], timeZone: string): Map<string, DayRecord>;
  /**
   * A finished day's record: the stored one, or, if there is none yet, computed now and stored (a day with orders only).
   * It is frozen from then on, so a caller may keep it in memory.
   */
  closeDay(day: string, timeZone: string): DayRecord | undefined;
  /**
   * Stores the totals of the earliest day before `today` that has orders and none stored yet, and returns it; undefined
   * when every finished day is stored. One day per call, so a long backlog is worked off a step at a time.
   */
  closeNextDay(today: string, timeZone: string): string | undefined;
  /** Orders on a room bill not yet settled, every day's, oldest first (D-082): a partial index, never a scan. */
  openRoomOrders(): Order[];
  /**
   * Records a room's settlement and saves the orders it settled, with their events, in one transaction: `build` gets the
   * new settlement's id and returns the settled orders (a throw rolls everything back).
   */
  settleRoom(
    settlement: Omit<RoomSettlement, "id" | "orderIds">,
    build: (id: number) => Order[],
  ): { settlement: RoomSettlement; events: StoredEvent[] };
  /** The latest settlements, newest first: the audit of who took what at checkout. */
  roomSettlements(limit: number): RoomSettlement[];
  /** Saves an order taken off its room bill and the audit row of the move, in one transaction. */
  moveOffRoomBill(order: Order, move: Omit<RoomBillMove, "id">): { move: RoomBillMove; event: StoredEvent };
  /** The latest moves off a room bill, newest first. */
  roomBillMoves(limit: number): RoomBillMove[];
  /** Every stored event of the business's calendar (D-084), oldest first: at most `MAX_EVENTS`. */
  calendarEvents(): CalendarEvent[];
  /** Stores a new event and returns it with its id; `by` is who wrote it. */
  addCalendarEvent(input: EventInput, by: string, at: number): CalendarEvent;
  /** Replaces an event's fields; false when there is no such event. */
  updateCalendarEvent(id: number, input: EventInput): boolean;
  /** Deletes events by id and returns how many went. */
  deleteCalendarEvents(ids: readonly number[]): number;
  /** The system switches' values, by key (D-075). */
  flags(): Map<string, FlagValue>;
  /** Sets a flag and writes who, when, from what and to what in the audit, in one transaction; no change, no audit row. */
  setFlag(change: {
    key: string;
    value: FlagValue;
    /** What it was in force before (a stored value, or the default when none was stored). */
    from: FlagValue;
    by: string;
    level: Level;
    at: number;
  }): FlagChange | undefined;
  /** Records changes made elsewhere (the theme's features, saved with the Appearance) in the same audit. */
  auditFlags(changes: readonly FlagChange[], by: string, level: Level, at: number): void;
  /** The latest flag changes, newest first. */
  flagAudit(limit: number): FlagAuditRow[];
  /** Adds one process's counts to an hour's row (D-076): one row per hour, written at most every half minute. */
  addTelemetry(hour: number, add: TelemetryAdd): void;
  /** The stored hours from `fromHour` on, oldest first, and the oldest ones are dropped (`keepFromHour`). */
  telemetryHours(fromHour: number): TelemetryHour[];
  pruneTelemetry(beforeHour: number): void;
  /** A small named value the install keeps about itself (the time of the last export). */
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  databaseSize(): number;
  /** Rows written by this process so far (see `SqlDriver.rowsWritten`). */
  rowsWritten(): number;
  /** Marks this database as a demo's (`npm run demo`), so the demo can tell its own data from a real install's. */
  markDemo(): void;
  isDemo(): boolean;
  /** Whether nothing has been stored yet: no orders and no staff. */
  isEmpty(): boolean;
  close(): void;
}

/** A migration step that can't run inside a transaction. */
const VACUUM = "VACUUM";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE token_counters (day TEXT PRIMARY KEY, value INTEGER NOT NULL);
   CREATE TABLE orders (
     id TEXT PRIMARY KEY,
     secret TEXT NOT NULL,
     client_key TEXT NOT NULL UNIQUE,
     day TEXT NOT NULL,
     token TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     currency TEXT NOT NULL,
     customer_name TEXT,
     status TEXT NOT NULL,
     UNIQUE (day, token)
   );
   CREATE INDEX orders_status ON orders (status, created_at);
   CREATE TABLE order_lines (
     order_id TEXT NOT NULL REFERENCES orders (id),
     idx INTEGER NOT NULL,
     item_id TEXT NOT NULL,
     name TEXT NOT NULL,
     size TEXT,
     qty INTEGER NOT NULL,
     unit_minor INTEGER NOT NULL,
     station_id TEXT NOT NULL,
     served INTEGER NOT NULL,
     PRIMARY KEY (order_id, idx)
   );
   CREATE TABLE status_changes (
     order_id TEXT NOT NULL REFERENCES orders (id),
     seq INTEGER NOT NULL,
     from_status TEXT NOT NULL,
     to_status TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (order_id, seq)
   );
   CREATE TABLE payments (
     order_id TEXT PRIMARY KEY REFERENCES orders (id),
     state TEXT NOT NULL,
     method TEXT,
     amount_minor INTEGER,
     currency TEXT NOT NULL,
     at INTEGER,
     by_staff TEXT
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL,
     at INTEGER NOT NULL,
     order_id TEXT NOT NULL REFERENCES orders (id),
     stations TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX events_order ON events (order_id, id);
   CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL);
   CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL);`,
  `CREATE TABLE reviews (
     order_id TEXT PRIMARY KEY REFERENCES orders (id),
     rating INTEGER NOT NULL,
     text TEXT,
     at INTEGER NOT NULL
   );`,
  "ALTER TABLE order_lines ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;",
  `CREATE TABLE payment_top_ups (
     order_id TEXT NOT NULL REFERENCES orders (id),
     seq INTEGER NOT NULL,
     method TEXT NOT NULL,
     amount_minor INTEGER NOT NULL,
     at INTEGER NOT NULL,
     by_staff TEXT NOT NULL,
     PRIMARY KEY (order_id, seq)
   );`,
  "ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'all';",
  "CREATE INDEX orders_created ON orders (created_at);",
  "CREATE TABLE item_availability (item_id TEXT PRIMARY KEY, available INTEGER NOT NULL);",
  // Once: rewrites the file so free pages left by earlier deletes (old customer names among them) are gone.
  VACUUM,
  `CREATE TABLE retention (id INTEGER PRIMARY KEY CHECK (id = 1), cutoff INTEGER NOT NULL);
   INSERT INTO retention (id, cutoff) VALUES (1, 0);
   CREATE INDEX reviews_at ON reviews (at);`,
  // Totals of finished business days (D-044), so the owner's report reads two days of orders, not a month.
  `CREATE TABLE day_totals (day TEXT PRIMARY KEY, data TEXT NOT NULL);`,
  // Each order's, payment's and top-up's business-local day and minute of the day, fixed at write time (D-045), so the
  // report asks SQL for 'yesterday up to 15:30' instead of converting times row by row.
  `ALTER TABLE orders ADD COLUMN local_min INTEGER;
   ALTER TABLE payments ADD COLUMN day TEXT;
   ALTER TABLE payments ADD COLUMN local_min INTEGER;
   ALTER TABLE payment_top_ups ADD COLUMN day TEXT;
   ALTER TABLE payment_top_ups ADD COLUMN local_min INTEGER;
   CREATE INDEX payments_day ON payments (day, local_min);
   CREATE INDEX payment_top_ups_day ON payment_top_ups (day, local_min);`,
  // The start-up check for rows still lacking local fields reads these empty partial indexes, not whole tables (D-046).
  `CREATE INDEX orders_unlocal ON orders (id) WHERE local_min IS NULL;
   CREATE INDEX payments_unlocal ON payments (order_id) WHERE day IS NULL AND at IS NOT NULL;
   CREATE INDEX payment_top_ups_unlocal ON payment_top_ups (order_id, seq) WHERE day IS NULL;`,
  // The owner's Appearance override of the config's theme (D-049): one JSON row, absent when none is set.
  "CREATE TABLE theme_override (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);",
  // Order-at-counter venues (D-063 to D-066): where the customer sits, a line's extras (JSON, fixed at ordering) and note,
  // and when each line was ready and handed over. Columns only: no new table, no extra row per order or line.
  `ALTER TABLE orders ADD COLUMN spot TEXT;
   ALTER TABLE order_lines ADD COLUMN extras TEXT;
   ALTER TABLE order_lines ADD COLUMN note TEXT;
   ALTER TABLE order_lines ADD COLUMN ready_at INTEGER;
   ALTER TABLE order_lines ADD COLUMN served_at INTEGER;`,
  // A count per item for one business day (D-068): set in the morning, spent by orders, ignored once its day has passed.
  "CREATE TABLE daily_counts (item_id TEXT PRIMARY KEY, day TEXT NOT NULL, remaining INTEGER NOT NULL);",
  // Money handed back (D-071): a refund is its own row, with its business-local day and minute like a top-up, so the
  // report nets it in SQL on the day it was handed back. Orders without one cost no row.
  `CREATE TABLE payment_refunds (
     order_id TEXT NOT NULL REFERENCES orders (id),
     seq INTEGER NOT NULL,
     method TEXT NOT NULL,
     amount_minor INTEGER NOT NULL,
     at INTEGER NOT NULL,
     by_staff TEXT NOT NULL,
     day TEXT,
     local_min INTEGER,
     PRIMARY KEY (order_id, seq)
   );
   CREATE INDEX payment_refunds_day ON payment_refunds (day, local_min);`,
  // Run-time switches and who flipped them (D-075); one row per flag, one audit row per change.
  `CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE flag_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     by_user TEXT NOT NULL,
     level TEXT NOT NULL,
     key TEXT NOT NULL,
     from_value TEXT,
     to_value TEXT NOT NULL
   );`,
  // The install's own health, kept on the install (D-076): one row per UTC hour, and a few named values.
  `CREATE TABLE telemetry_hours (
     hour INTEGER PRIMARY KEY,
     requests INTEGER NOT NULL,
     errors INTEGER NOT NULL,
     rows_written INTEGER NOT NULL,
     routes TEXT NOT NULL
   );
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // The room bill (D-082): the room an order is charged to, the settlement that paid it, and every settlement as its own
  // audit row. Only room-bill orders carry the columns; the open ones are found through a partial index.
  `ALTER TABLE orders ADD COLUMN room TEXT;
   ALTER TABLE orders ADD COLUMN room_settled INTEGER;
   CREATE INDEX orders_room_open ON orders (created_at) WHERE room IS NOT NULL AND room_settled IS NULL;
   CREATE TABLE room_settlements (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     room TEXT NOT NULL,
     label TEXT NOT NULL,
     at INTEGER NOT NULL,
     by_user TEXT NOT NULL,
     level TEXT NOT NULL,
     method TEXT NOT NULL,
     amount_minor INTEGER NOT NULL,
     orders TEXT NOT NULL
   );`,
  // The business's events (D-084): one row each, a repeat as its weekdays; deleted a few days after their last day.
  `CREATE TABLE calendar_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     by_user TEXT NOT NULL
   );`,
  // An order taken off a room bill by mistake put on it (D-082): who, when, which order, from which room, and why.
  `CREATE TABLE room_bill_moves (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id TEXT NOT NULL REFERENCES orders (id),
     room TEXT NOT NULL,
     at INTEGER NOT NULL,
     by_user TEXT NOT NULL,
     level TEXT NOT NULL,
     reason TEXT
   );`,
];

/** How many of the newest orders the best-seller query reads, and how many waits the median reads: the cost is bounded. */
export const FIGURE_ORDERS = 500;
export const FIGURE_WAITS = 200;
export const FIGURE_TOP = 3;
/** The storefront figures' queries (D-050): indexed ranges over a bounded window, aggregated in SQL. */
export const FIGURE_SQL = {
  topSellers: `SELECT l.item_id AS item_id, SUM(l.qty) AS qty
    FROM (SELECT id FROM orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT ${FIGURE_ORDERS}) recent
    JOIN order_lines l ON l.order_id = recent.id
    GROUP BY l.item_id ORDER BY qty DESC, l.item_id LIMIT ${FIGURE_TOP}`,
  waits: `SELECT MAX(c.at) - recent.created_at AS wait
    FROM (SELECT id, created_at FROM orders WHERE status = 'completed' AND created_at >= ? ORDER BY created_at DESC LIMIT ${FIGURE_WAITS}) recent
    JOIN status_changes c ON c.order_id = recent.id AND c.to_status = 'completed'
    GROUP BY recent.id`,
} as const;

/** The start-up backfill's lookups, exported so a test can check each is served by its partial index. */
export const CARRY_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(l.served_at - l.ready_at), 0) AS total,
    COALESCE(MAX(l.served_at - l.ready_at), 0) AS worst
  FROM orders o JOIN order_lines l ON l.order_id = o.id
  WHERE o.day = ? AND l.ready_at IS NOT NULL AND l.served_at IS NOT NULL`;

export const BACKFILL_SQL = {
  orders: "SELECT id, created_at FROM orders INDEXED BY orders_unlocal WHERE local_min IS NULL",
  payments: "SELECT order_id, at FROM payments INDEXED BY payments_unlocal WHERE day IS NULL AND at IS NOT NULL",
  topUps: "SELECT order_id, seq, at FROM payment_top_ups INDEXED BY payment_top_ups_unlocal WHERE day IS NULL",
} as const;

/**
 * Money confirmed in a day up to a minute, in all and by method: each payment less its top-ups, plus the top-ups, less
 * the refunds handed back in that time. Numbered parameters: ?1 the day and ?2 the minute for payments, ?3 and ?4 the
 * same for top-ups and refunds. Searches only, no scan.
 */
const RECEIVED_SQL = `SELECT ${(["n", "cash", "upi", "card"] as const)
  .map((col) => {
    const by = (alias: string) => (col === "n" ? "" : ` AND ${alias}.method = '${col}'`);
    return `(SELECT COALESCE(SUM(p.amount_minor - COALESCE((SELECT SUM(x.amount_minor) FROM payment_top_ups x
        WHERE x.order_id = p.order_id), 0)), 0) FROM payments p
        WHERE p.state = 'confirmed' AND p.day = ?1 AND p.local_min <= ?2${by("p")})
      + (SELECT COALESCE(SUM(t.amount_minor), 0) FROM payment_top_ups t
        WHERE t.day = ?3 AND t.local_min <= ?4${by("t")})
      - (SELECT COALESCE(SUM(f.amount_minor), 0) FROM payment_refunds f
        WHERE f.day = ?3 AND f.local_min <= ?4${by("f")}) AS ${col}`;
  })
  .join(", ")}`;

/** The report's queries, exported so a test can ask SQLite for their plans (none may scan a big table). */
export const REPORT_SQL = {
  hourly: `WITH ord AS (
      SELECT o.local_min AS m, SUM(l.qty) AS q, SUM(l.qty * l.unit_minor) AS v,
             CASE WHEN p.state = 'confirmed' THEN p.amount_minor ELSE 0 END AS paid,
             CASE WHEN o.room IS NOT NULL AND o.room_settled IS NULL THEN 1 ELSE 0 END AS onroom
      FROM orders o CROSS JOIN order_lines l ON l.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.day = ? AND o.local_min <= ? GROUP BY o.id)
    SELECT m / 60 AS hour, COUNT(*) AS n, SUM(q) AS q, SUM(v) AS v,
           SUM(CASE WHEN v > paid AND onroom = 0 THEN 1 ELSE 0 END) AS aw,
           SUM(CASE WHEN v > paid AND onroom = 0 THEN v - paid ELSE 0 END) AS awm
    FROM ord GROUP BY m / 60`,
  lines: `SELECT l.item_id, MIN(l.name) AS name, l.size, SUM(l.qty) AS qty, SUM(l.qty * l.unit_minor) AS v
    FROM orders o CROSS JOIN order_lines l ON l.order_id = o.id
    WHERE o.day = ? AND o.local_min <= ? GROUP BY l.item_id, l.size ORDER BY l.item_id, l.size`,
  received: RECEIVED_SQL,
  minutes: `WITH ord AS (
      SELECT o.local_min AS m, SUM(l.qty) AS q, SUM(l.qty * l.unit_minor) AS v,
             CASE WHEN p.state = 'confirmed' THEN p.amount_minor ELSE 0 END AS paid,
             CASE WHEN o.room IS NOT NULL AND o.room_settled IS NULL THEN 1 ELSE 0 END AS onroom
      FROM orders o CROSS JOIN order_lines l ON l.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.day = ? GROUP BY o.id)
    SELECT m, COUNT(*) AS n, SUM(q) AS q, SUM(v) AS v,
           SUM(CASE WHEN v > paid AND onroom = 0 THEN 1 ELSE 0 END) AS aw,
           SUM(CASE WHEN v > paid AND onroom = 0 THEN v - paid ELSE 0 END) AS awm
    FROM ord GROUP BY m`,
  receivedBaseByMinute: `SELECT p.local_min AS m, p.method AS method, SUM(p.amount_minor - COALESCE((SELECT SUM(t.amount_minor) FROM payment_top_ups t
                                                                       WHERE t.order_id = p.order_id), 0)) AS n
    FROM payments p WHERE p.state = 'confirmed' AND p.day = ? GROUP BY p.local_min, p.method`,
  receivedTopUpsByMinute: `SELECT t.local_min AS m, t.method AS method, SUM(t.amount_minor) AS n FROM payment_top_ups t WHERE t.day = ?
    GROUP BY t.local_min, t.method`,
  refundsByMinute: `SELECT f.local_min AS m, f.method AS method, SUM(f.amount_minor) AS n FROM payment_refunds f WHERE f.day = ?
    GROUP BY f.local_min, f.method`,
  salesRefunds: `SELECT f.order_id, f.amount_minor, f.at, f.method FROM orders o CROSS JOIN payment_refunds f ON f.order_id = o.id
    WHERE o.created_at >= ?`,
  confirmed: `SELECT COALESCE(SUM(p.amount_minor), 0) AS n FROM orders o CROSS JOIN payments p ON p.order_id = o.id
    WHERE o.day = ? AND p.state = 'confirmed'`,
  salesLines: `SELECT l.order_id, l.item_id, l.name, l.size, l.qty, l.unit_minor FROM orders o
    CROSS JOIN order_lines l ON l.order_id = o.id WHERE o.created_at >= ?`,
  salesTopUps: `SELECT t.order_id, t.amount_minor, t.at, t.method FROM orders o CROSS JOIN payment_top_ups t ON t.order_id = o.id
    WHERE o.created_at >= ?`,
  salesPayments: `SELECT p.order_id, p.amount_minor, p.at, p.method FROM orders o CROSS JOIN payments p ON p.order_id = o.id
    WHERE o.created_at >= ? AND p.state = 'confirmed'`,
} as const;

/** A stored payment method, or none for anything else. */
const method = (v: unknown): PaymentMethod | undefined => (v === "cash" || v === "upi" || v === "card" ? v : undefined);

/** Whether a table exists, asked by a query that reads no rows (the free plan counts every row read). */
function hasTable(d: SqlDriver, name: string): boolean {
  try {
    d.prepare(`SELECT 1 FROM ${name} LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

function migrate(d: SqlDriver): void {
  const current = d.version();
  if (current > MIGRATIONS.length) {
    throw new Error(`openStore: expected a schema version up to ${MIGRATIONS.length}, found ${current}`);
  }
  // Main before the merge ran migrations 10 to 12 as no-ops, so its version-13 database lacks what they add.
  if (current >= 13 && !hasTable(d, "day_totals")) {
    throw new Error(
      "openStore: expected a database made by this build, found one made by a development build before 2026-11-11; delete it (data/ibow.db) and start again",
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    if (MIGRATIONS[v] === VACUUM) {
      d.vacuum();
      d.setVersion(v + 1);
      continue;
    }
    d.tx(() => {
      d.exec(MIGRATIONS[v] as string);
      d.setVersion(v + 1);
    });
  }
}

/** Builds the store over a driver, creating and migrating the schema if needed. */
/** SQL for a string of spaces as many bytes long as the text in `column`. */
function blank(column: string): string {
  return `substr(replace(hex(zeroblob(length(CAST(${column} AS BLOB)))), '0', ' '), 1, length(CAST(${column} AS BLOB)))`;
}

/**
 * Rewrites `$.lines[*]` of the snapshots of orders placed in a window, applying `edit` to each line that has a note.
 * Parameters: the window's start and end. The lines are rebuilt in order from `json_each`.
 */
function eventNotesSql(edit: string): string {
  // json(...) around the subquery: newer SQLite drops the JSON subtype across a subquery, and json_set would then
  // store the list as a string (found on CI, SQLite 3.5x).
  return `UPDATE events SET data = json_set(data, '$.lines', json((
      SELECT json_group_array(json(CASE WHEN json_extract(v.value, '$.note') IS NOT NULL THEN ${edit} ELSE v.value END))
      FROM (SELECT value, key FROM json_each(events.data, '$.lines') ORDER BY key) v)))
    WHERE order_id IN (SELECT id FROM orders WHERE created_at >= ? AND created_at < ?)
      AND data LIKE '%"note":%'`;
}

function rowToLine(l: Row): OrderLine {
  const line: OrderLine = {
    itemId: l.item_id as string,
    name: l.name as string,
    qty: l.qty as number,
    unitMinor: l.unit_minor as number,
    stationId: l.station_id as string,
    served: l.served === 1,
    ready: l.ready === 1,
  };
  if (l.extras !== null) line.extras = JSON.parse(l.extras as string) as LineExtra[];
  if (l.note !== null) line.note = l.note as string;
  if (l.ready_at !== null) line.readyAt = l.ready_at as number;
  if (l.served_at !== null) line.servedAt = l.served_at as number;
  return l.size === null ? line : { ...line, size: l.size as string };
}

export function createStore(d: SqlDriver): Store {
  migrate(d);
  /** The business time zone, once known (`useTimeZone`, or the first order); local fields are NULL before that. */
  let zone: string | undefined;
  function zoned(at: number): { day: string | null; min: number | null } {
    if (zone === undefined) return { day: null, min: null };
    const t = localTime(at, zone);
    return { day: t.day, min: t.hour * 60 + t.minute };
  }

  const q = {
    putReview: d.prepare("INSERT OR IGNORE INTO reviews (order_id, rating, text, at) VALUES (?, ?, ?, ?)"),
    review: d.prepare("SELECT * FROM reviews WHERE order_id = ?"),
    // Before a name or review text is set to NULL it is overwritten with spaces of the same byte length, in the same
    // transaction, so the bytes in the page change in place (D-042): a Durable Object can't run secure_delete or VACUUM.
    getFlags: d.prepare("SELECT key, value FROM flags"),
    getFlag: d.prepare("SELECT value FROM flags WHERE key = ?"),
    putFlag: d.prepare(
      "INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ),
    putAudit: d.prepare(
      "INSERT INTO flag_audit (at, by_user, level, key, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    audit: d.prepare("SELECT * FROM flag_audit ORDER BY id DESC LIMIT ?"),
    hour: d.prepare("SELECT * FROM telemetry_hours WHERE hour = ?"),
    putHour: d.prepare(
      `INSERT INTO telemetry_hours (hour, requests, errors, rows_written, routes) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (hour) DO UPDATE SET requests = excluded.requests, errors = excluded.errors,
         rows_written = excluded.rows_written, routes = excluded.routes`,
    ),
    hours: d.prepare("SELECT * FROM telemetry_hours WHERE hour >= ? ORDER BY hour"),
    pruneHours: d.prepare("DELETE FROM telemetry_hours WHERE hour < ?"),
    getMeta: d.prepare("SELECT value FROM meta WHERE key = ?"),
    putMeta: d.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ),
    blankNames: d.prepare(
      `UPDATE orders SET customer_name = ${blank("customer_name")}
       WHERE created_at >= ? AND created_at < ? AND customer_name IS NOT NULL`,
    ),
    blankEventNames: d.prepare(
      `UPDATE events SET data = json_set(data, '$.customerName', ${blank("json_extract(data, '$.customerName')")})
       WHERE order_id IN (SELECT id FROM orders WHERE created_at >= ? AND created_at < ?)
         AND json_extract(data, '$.customerName') IS NOT NULL`,
    ),
    blankReviewText: d.prepare(
      `UPDATE reviews SET text = ${blank("text")} WHERE at >= ? AND at < ? AND text IS NOT NULL`,
    ),
    // Notes go the same way as names: spaces of the same byte length, then NULL, in the lines and in every snapshot.
    blankNotes: d.prepare(
      `UPDATE order_lines SET note = ${blank("note")}
       WHERE note IS NOT NULL AND order_id IN (SELECT id FROM orders WHERE created_at >= ? AND created_at < ?)`,
    ),
    forgetNotes: d.prepare(
      `UPDATE order_lines SET note = NULL
       WHERE note IS NOT NULL AND order_id IN (SELECT id FROM orders WHERE created_at >= ? AND created_at < ?)`,
    ),
    blankEventNotes: d.prepare(
      eventNotesSql(`json_set(v.value, '$.note', ${blank("json_extract(v.value, '$.note')")})`),
    ),
    forgetEventNotes: d.prepare(eventNotesSql("json_remove(v.value, '$.note')")),
    forgetNames: d.prepare(
      "UPDATE orders SET customer_name = NULL WHERE created_at >= ? AND created_at < ? AND customer_name IS NOT NULL",
    ),
    forgetEventNames: d.prepare(
      `UPDATE events SET data = json_remove(data, '$.customerName')
       WHERE order_id IN (SELECT id FROM orders WHERE created_at >= ? AND created_at < ?)
         AND json_extract(data, '$.customerName') IS NOT NULL`,
    ),
    setAvailability: d.prepare(
      `INSERT INTO item_availability (item_id, available) VALUES (?, ?)
       ON CONFLICT (item_id) DO UPDATE SET available = excluded.available`,
    ),
    availability: d.prepare("SELECT item_id, available FROM item_availability"),
    setCount: d.prepare(
      `INSERT INTO daily_counts (item_id, day, remaining) VALUES (?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET day = excluded.day, remaining = excluded.remaining`,
    ),
    clearCount: d.prepare("DELETE FROM daily_counts WHERE item_id = ?"),
    counts: d.prepare("SELECT item_id, remaining FROM daily_counts WHERE day = ?"),
    spendCount: d.prepare("UPDATE daily_counts SET remaining = remaining - ? WHERE item_id = ? AND day = ?"),
    carry: d.prepare(CARRY_SQL),
    topSellers: d.prepare(FIGURE_SQL.topSellers),
    waits: d.prepare(FIGURE_SQL.waits),
    themeGet: d.prepare("SELECT json FROM theme_override WHERE id = 1"),
    themeSet: d.prepare(
      "INSERT INTO theme_override (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
    ),
    themeClear: d.prepare("DELETE FROM theme_override WHERE id = 1"),
    onDay: d.prepare("SELECT id FROM orders WHERE day = ? ORDER BY created_at, rowid"),
    salesPayments: d.prepare(REPORT_SQL.salesPayments),
    salesTopUps: d.prepare(REPORT_SQL.salesTopUps),
    salesOrders: d.prepare("SELECT id, created_at FROM orders WHERE created_at >= ? ORDER BY created_at, rowid"),
    salesLines: d.prepare(REPORT_SQL.salesLines),
    named: d.prepare(
      "SELECT customer_name, created_at FROM orders WHERE created_at >= ? AND customer_name IS NOT NULL",
    ),
    recentReviews: d.prepare(
      `SELECT r.order_id, r.rating, r.text, r.at, o.token FROM reviews r JOIN orders o ON o.id = r.order_id
       ORDER BY r.at DESC LIMIT ?`,
    ),
    forgetReviewText: d.prepare("UPDATE reviews SET text = NULL WHERE at >= ? AND at < ? AND text IS NOT NULL"),
    retentionMark: d.prepare("SELECT cutoff FROM retention WHERE id = 1"),
    setRetentionMark: d.prepare("UPDATE retention SET cutoff = ? WHERE id = 1"),
    byClientKey: d.prepare("SELECT id FROM orders WHERE client_key = ?"),
    lastCounter: d.prepare("SELECT day, value FROM token_counters ORDER BY day DESC LIMIT 1"),
    putCounter: d.prepare(
      "INSERT INTO token_counters (day, value) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET value = excluded.value",
    ),
    insertOrder: d.prepare(
      `INSERT INTO orders (id, secret, client_key, day, token, created_at, currency, customer_name, status, local_min, spot, room)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateOrder: d.prepare("UPDATE orders SET customer_name = ?, status = ?, room = ?, room_settled = ? WHERE id = ?"),
    insertMove: d.prepare(
      "INSERT INTO room_bill_moves (order_id, room, at, by_user, level, reason) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    ),
    moves: d.prepare("SELECT * FROM room_bill_moves ORDER BY id DESC LIMIT ?"),
    roomOpen: d.prepare(
      "SELECT id FROM orders INDEXED BY orders_room_open WHERE room IS NOT NULL AND room_settled IS NULL ORDER BY created_at",
    ),
    insertSettlement: d.prepare(
      `INSERT INTO room_settlements (room, label, at, by_user, level, method, amount_minor, orders)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]') RETURNING id`,
    ),
    settlementOrders: d.prepare("UPDATE room_settlements SET orders = ? WHERE id = ?"),
    settlements: d.prepare("SELECT * FROM room_settlements ORDER BY id DESC LIMIT ?"),
    calendar: d.prepare("SELECT id, data FROM calendar_events ORDER BY id"),
    addCalendar: d.prepare("INSERT INTO calendar_events (data, created_at, by_user) VALUES (?, ?, ?) RETURNING id"),
    updateCalendar: d.prepare("UPDATE calendar_events SET data = ? WHERE id = ?"),
    deleteCalendar: d.prepare("DELETE FROM calendar_events WHERE id = ?"),
    order: d.prepare("SELECT * FROM orders WHERE id = ?"),
    byToken: d.prepare("SELECT id FROM orders WHERE token = ? AND day = ?"),
    open: d.prepare("SELECT id FROM orders WHERE status != 'completed' ORDER BY created_at, rowid"),
    lines: d.prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY idx"),
    lineStations: d.prepare("SELECT DISTINCT station_id FROM order_lines WHERE order_id = ?"),
    deleteLines: d.prepare("DELETE FROM order_lines WHERE order_id = ?"),
    insertLine: d.prepare(
      `INSERT INTO order_lines (order_id, idx, item_id, name, size, qty, unit_minor, station_id, served, ready, extras, note, ready_at, served_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    history: d.prepare("SELECT * FROM status_changes WHERE order_id = ? ORDER BY seq"),
    deleteHistory: d.prepare("DELETE FROM status_changes WHERE order_id = ?"),
    insertChange: d.prepare(
      "INSERT INTO status_changes (order_id, seq, from_status, to_status, at) VALUES (?, ?, ?, ?, ?)",
    ),
    payment: d.prepare("SELECT * FROM payments WHERE order_id = ?"),
    putPayment: d.prepare(
      `INSERT INTO payments (order_id, state, method, amount_minor, currency, at, by_staff, day, local_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_id) DO UPDATE SET state = excluded.state, method = excluded.method,
         amount_minor = excluded.amount_minor, currency = excluded.currency, at = excluded.at,
         by_staff = excluded.by_staff, day = excluded.day, local_min = excluded.local_min`,
    ),
    topUps: d.prepare("SELECT * FROM payment_top_ups WHERE order_id = ? ORDER BY seq"),
    refunds: d.prepare("SELECT * FROM payment_refunds WHERE order_id = ? ORDER BY seq"),
    deleteRefunds: d.prepare("DELETE FROM payment_refunds WHERE order_id = ?"),
    insertRefund: d.prepare(
      "INSERT INTO payment_refunds (order_id, seq, method, amount_minor, at, by_staff, day, local_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    refundsQ: d.prepare(REPORT_SQL.refundsByMinute),
    salesRefunds: d.prepare(REPORT_SQL.salesRefunds),
    deleteTopUps: d.prepare("DELETE FROM payment_top_ups WHERE order_id = ?"),
    insertTopUp: d.prepare(
      "INSERT INTO payment_top_ups (order_id, seq, method, amount_minor, at, by_staff, day, local_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertEvent: d.prepare(
      "INSERT INTO events (type, at, order_id, stations, data) VALUES (?, ?, ?, ?, ?) RETURNING id",
    ),
    eventsAll: d.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?"),
    eventsOrder: d.prepare("SELECT * FROM events WHERE id > ? AND order_id = ? ORDER BY id LIMIT ?"),
    eventsStation: d.prepare("SELECT * FROM events WHERE id > ? AND stations LIKE ? ORDER BY id LIMIT ?"),
    // From sqlite_sequence, not MAX(id): pruning every event must not send the high-water mark back to 0 (D-041).
    lastEvent: d.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS id"),
    hourlyQ: d.prepare(REPORT_SQL.hourly),
    linesQ: d.prepare(REPORT_SQL.lines),
    receivedQ: d.prepare(REPORT_SQL.received),
    confirmedQ: d.prepare(REPORT_SQL.confirmed),
    minutesQ: d.prepare(REPORT_SQL.minutes),
    receivedBaseQ: d.prepare(REPORT_SQL.receivedBaseByMinute),
    receivedTopUpsQ: d.prepare(REPORT_SQL.receivedTopUpsByMinute),
    storedDay: d.prepare("SELECT data FROM day_totals WHERE day = ?"),
    putDay: d.prepare("INSERT OR REPLACE INTO day_totals (day, data) VALUES (?, ?)"),
    lastClosed: d.prepare("SELECT MAX(day) AS day FROM day_totals"),
    nextDay: d.prepare("SELECT MIN(day) AS day FROM orders WHERE day > ? AND day < ?"),
    // Names in the snapshots are overwritten with spaces first, as retention does (D-042), so a pruned event leaves none.
    blankOldEventNames: d.prepare(
      `UPDATE events SET data = json_set(data, '$.customerName', ${blank("json_extract(data, '$.customerName')")})
       WHERE at < ? AND json_extract(data, '$.customerName') IS NOT NULL`,
    ),
    pruneEvents: d.prepare("DELETE FROM events WHERE at < ?"),
    putStaff: d.prepare(
      `INSERT INTO staff (id, name, pin_hash, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, pin_hash = excluded.pin_hash, role = excluded.role`,
    ),
    staff: d.prepare("SELECT * FROM staff WHERE id = ?"),
    staffList: d.prepare("SELECT id, name, role FROM staff ORDER BY id"),
    putSession: d.prepare("INSERT INTO sessions (id_hash, user, role, expires_at) VALUES (?, ?, ?, ?)"),
    session: d.prepare("SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?"),
    deleteSession: d.prepare("DELETE FROM sessions WHERE id_hash = ?"),
    deleteUserSessions: d.prepare("DELETE FROM sessions WHERE user = ?"),
    expireSessions: d.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  };

  const tx = <T>(fn: () => T): T => d.tx(fn);

  function readOrder(id: string): { order: Order; secret: string } | undefined {
    const row = q.order.get(id) as Row | undefined;
    if (row === undefined) return undefined;
    const lines = (q.lines.all(id) as Row[]).map(rowToLine);
    const history = (q.history.all(id) as Row[]).map(
      (h): StatusChange => ({ from: h.from_status as OrderStatus, to: h.to_status as OrderStatus, at: h.at as number }),
    );
    const p = q.payment.get(id) as Row;
    let payment: Payment;
    if (p.state === "unpaid") payment = { state: "unpaid" };
    else {
      const base = { method: p.method as PaymentMethod, amountMinor: p.amount_minor as number, at: p.at as number };
      if (p.state === "claimed") payment = { state: "claimed", ...base };
      else {
        const topUps = (q.topUps.all(id) as Row[]).map(
          (t): TopUp => ({
            method: t.method as PaymentMethod,
            amountMinor: t.amount_minor as number,
            at: t.at as number,
            by: t.by_staff as string,
          }),
        );
        const refunds = (q.refunds.all(id) as Row[]).map(
          (f): Refund => ({
            method: f.method as PaymentMethod,
            amountMinor: f.amount_minor as number,
            at: f.at as number,
            by: f.by_staff as string,
          }),
        );
        payment = {
          state: "confirmed",
          ...base,
          by: p.by_staff as string,
          ...(topUps.length > 0 ? { topUps } : {}),
          ...(refunds.length > 0 ? { refunds } : {}),
        };
      }
    }
    const order: Order = {
      id,
      token: row.token as string,
      createdAt: row.created_at as number,
      currency: row.currency as string,
      lines,
      status: row.status as OrderStatus,
      history,
      payment,
    };
    if (row.customer_name !== null) order.customerName = row.customer_name as string;
    if (row.spot !== null) order.spot = row.spot as string;
    if (row.room !== null) {
      order.roomBill =
        row.room_settled === null
          ? { room: row.room as string }
          : { room: row.room as string, settlement: row.room_settled as number };
    }
    return { order, secret: row.secret as string };
  }

  /**
   * Spends today's counts for the change from `before` to `after` (units added use some up, units taken away give
   * them back). An item with no count today is untouched; one without enough left refuses the whole change. Reads the few
   * counted rows and writes only the items whose quantity changed.
   */
  function spendCounts(day: string, beforeLines: () => readonly OrderLine[], after: readonly OrderLine[]): void {
    const left = new Map<string, number>();
    for (const r of q.counts.all(day) as Row[]) left.set(r.item_id as string, r.remaining as number);
    // No counts today (the usual case): the order's stored lines are not even read.
    if (left.size === 0) return;
    const before = beforeLines();
    const delta = new Map<string, number>();
    for (const l of after) delta.set(l.itemId, (delta.get(l.itemId) ?? 0) + l.qty);
    for (const l of before) delta.set(l.itemId, (delta.get(l.itemId) ?? 0) - l.qty);
    for (const [itemId, change] of delta) {
      const have = left.get(itemId);
      if (have === undefined || change === 0) continue;
      if (change > have) {
        throw new OrderError("sold_out", `at most ${have} of ${itemId} left today`, `${change} more asked for`);
      }
      q.spendCount.run(change, itemId, day);
    }
  }

  function writeParts(order: Order): void {
    q.deleteLines.run(order.id);
    order.lines.forEach((l, i) => {
      q.insertLine.run(
        order.id,
        i,
        l.itemId,
        l.name,
        l.size ?? null,
        l.qty,
        l.unitMinor,
        l.stationId,
        l.served ? 1 : 0,
        l.ready ? 1 : 0,
        l.extras === undefined ? null : JSON.stringify(l.extras),
        l.note ?? null,
        l.readyAt ?? null,
        l.servedAt ?? null,
      );
    });
    q.deleteHistory.run(order.id);
    order.history.forEach((h, i) => {
      q.insertChange.run(order.id, i, h.from, h.to, h.at);
    });
    const p = order.payment;
    q.deleteTopUps.run(order.id);
    q.deleteRefunds.run(order.id);
    if (p.state === "confirmed") {
      p.refunds?.forEach((r, i) => {
        const z = zoned(r.at);
        q.insertRefund.run(order.id, i, r.method, r.amountMinor, r.at, r.by, z.day, z.min);
      });
      p.topUps?.forEach((t, i) => {
        const z = zoned(t.at);
        q.insertTopUp.run(order.id, i, t.method, t.amountMinor, t.at, t.by, z.day, z.min);
      });
    }
    if (p.state === "unpaid") q.putPayment.run(order.id, "unpaid", null, null, order.currency, null, null, null, null);
    else {
      q.putPayment.run(
        order.id,
        p.state,
        p.method,
        p.amountMinor,
        order.currency,
        p.at,
        p.state === "confirmed" ? p.by : null,
        zoned(p.at).day,
        zoned(p.at).min,
      );
    }
  }

  function appendEvent(order: Order, type: EventType, now: number, before: Iterable<string>): StoredEvent {
    const stations = [...new Set([...before, ...order.lines.map((l) => l.stationId)])].sort();
    const row = q.insertEvent.get(type, now, order.id, `,${stations.join(",")},`, JSON.stringify(order)) as Row;
    return { id: row.id as number, type, at: now, orderId: order.id, stations, order };
  }

  function useZone(timeZone: string): void {
    if (zone === timeZone) return;
    zone = timeZone;
    // Rows written before the local fields existed: fill them in once (a year of orders is a few seconds).
    tx(() => {
      for (const r of d.prepare(BACKFILL_SQL.orders).all()) {
        d.prepare("UPDATE orders SET local_min = ? WHERE id = ?").run(
          zoned(r.created_at as number).min,
          r.id as string,
        );
      }
      for (const r of d.prepare(BACKFILL_SQL.payments).all()) {
        const z = zoned(r.at as number);
        d.prepare("UPDATE payments SET day = ?, local_min = ? WHERE order_id = ?").run(
          z.day,
          z.min,
          r.order_id as string,
        );
      }
      for (const r of d.prepare(BACKFILL_SQL.topUps).all()) {
        const z = zoned(r.at as number);
        d.prepare("UPDATE payment_top_ups SET day = ?, local_min = ? WHERE order_id = ? AND seq = ?").run(
          z.day,
          z.min,
          r.order_id as string,
          r.seq as number,
        );
      }
    });
  }

  function aggregate(day: string, timeZone: string, opts: { untilMinute?: number; full?: boolean } = {}): DayStats {
    useZone(timeZone);
    const until = opts.untilMinute ?? 24 * 60;
    const hourly = emptyHourly();
    let orders = 0;
    let items = 0;
    let orderedMinor = 0;
    let awaitingOrders = 0;
    let awaitingMinor = 0;
    for (const r of q.hourlyQ.all(day, until)) {
      const b = hourly[r.hour as number] as (typeof hourly)[number];
      b.orders = r.n as number;
      b.items = r.q as number;
      b.orderedMinor = r.v as number;
      orders += r.n as number;
      items += r.q as number;
      orderedMinor += r.v as number;
      awaitingOrders += r.aw as number;
      awaitingMinor += r.awm as number;
    }
    const got = q.receivedQ.get(day, until, day, until) as Row;
    const receivedMinor = got.n as number;
    const receivedCashMinor = got.cash as number;
    const receivedUpiMinor = got.upi as number;
    const receivedCardMinor = got.card as number;
    const lines = opts.full
      ? q.linesQ.all(day, until).map((r) => ({
          itemId: r.item_id as string,
          name: r.name as string,
          ...(r.size === null ? {} : { size: r.size as string }),
          qty: r.qty as number,
          orderedMinor: r.v as number,
        }))
      : [];
    const averageMinor = orders === 0 ? 0 : Math.round(orderedMinor / orders);
    return {
      orders,
      items,
      orderedMinor,
      averageMinor,
      receivedMinor,
      receivedCashMinor,
      receivedUpiMinor,
      receivedCardMinor,
      awaitingOrders,
      awaitingMinor,
      hourly,
      lines,
    };
  }

  function liveDay(day: string, timeZone: string): DayRecord {
    const stats = aggregate(day, timeZone, { full: true });
    const slots = new Map<number, MinuteSlot>();
    const slot = (m: number) => {
      let s = slots.get(m);
      if (s === undefined) {
        s = {
          m,
          orders: 0,
          items: 0,
          orderedMinor: 0,
          awaitingOrders: 0,
          awaitingMinor: 0,
          receivedMinor: 0,
          receivedCashMinor: 0,
          receivedUpiMinor: 0,
          receivedCardMinor: 0,
        };
        slots.set(m, s);
      }
      return s;
    };
    for (const r of q.minutesQ.all(day)) {
      const s = slot(r.m as number);
      s.orders = r.n as number;
      s.items = r.q as number;
      s.orderedMinor = r.v as number;
      s.awaitingOrders = r.aw as number;
      s.awaitingMinor = r.awm as number;
    }
    const signed = (rows: Row[], sign: number) =>
      rows.map((r) => ({ m: r.m as number, method: r.method, n: (r.n as number) * sign }));
    const moves = [
      ...signed([...q.receivedBaseQ.all(day), ...q.receivedTopUpsQ.all(day)], 1),
      ...signed(q.refundsQ.all(day), -1),
    ];
    for (const r of moves) {
      const s = slot(r.m);
      const { n } = r;
      s.receivedMinor += n;
      if (r.method === "cash") s.receivedCashMinor += n;
      else if (r.method === "upi") s.receivedUpiMinor += n;
      else if (r.method === "card") s.receivedCardMinor += n;
    }
    const minutes = [...slots.values()].sort((a, b) => a.m - b.m);
    return { day, ...stats, minutes, confirmedMinor: (q.confirmedQ.get(day) as Row).n as number };
  }

  function toEvent(row: Row): StoredEvent {
    return {
      id: row.id as number,
      type: row.type as EventType,
      at: row.at as number,
      orderId: row.order_id as string,
      stations: (row.stations as string).split(",").filter((s) => s !== ""),
      order: JSON.parse(row.data as string) as Order,
    };
  }

  /** Persists a changed order and appends its event; the caller holds the transaction. */
  function writeOrder(order: Order, type: EventType, now: number): StoredEvent {
    const before = (q.lineStations.all(order.id) as Row[]).map((r) => r.station_id as string);
    const changed = q.updateOrder.run(
      order.customerName ?? null,
      order.status,
      order.roomBill?.room ?? null,
      order.roomBill?.settlement ?? null,
      order.id,
    );
    if (changed.changes !== 1) throw new Error(`saveOrder: expected a stored order ${order.id}, found none`);
    const day = (q.order.get(order.id) as Row).day as string;
    spendCounts(day, () => (q.lines.all(order.id) as Row[]).map(rowToLine), order.lines);
    writeParts(order);
    return appendEvent(order, type, now, before);
  }

  const store: Store = {
    schemaVersion: () => d.version(),

    setDailyCount(itemId, day, remaining) {
      if (remaining === undefined) q.clearCount.run(itemId);
      else q.setCount.run(itemId, day, remaining);
    },

    dailyCounts(day) {
      return new Map((q.counts.all(day) as Row[]).map((r) => [r.item_id as string, r.remaining as number]));
    },

    carryStats(day) {
      const r = q.carry.get(day) as Row;
      return { lines: r.n as number, totalMs: r.total as number, maxMs: r.worst as number };
    },

    createOrder(input) {
      return tx(() => {
        const existing = q.byClientKey.get(input.clientKey) as Row | undefined;
        if (existing !== undefined) {
          const found = readOrder(existing.id as string) as { order: Order; secret: string };
          return { ...found, created: false };
        }
        const last = q.lastCounter.get() as Row | undefined;
        const counter: TokenCounter | null = last ? { day: last.day as string, value: last.value as number } : null;
        zone ??= input.timeZone;
        const next = nextToken(counter, input.now, input.timeZone);
        const order = input.build(next.token);
        if (order.id !== input.id || order.token !== next.token) {
          throw new Error(
            `createOrder: expected the built order to carry id ${input.id} and token ${next.token}, found ${order.id} and ${order.token}`,
          );
        }
        spendCounts(next.counter.day, () => [], order.lines);
        q.putCounter.run(next.counter.day, next.counter.value);
        q.insertOrder.run(
          order.id,
          input.secret,
          input.clientKey,
          next.counter.day,
          order.token,
          order.createdAt,
          order.currency,
          order.customerName ?? null,
          order.status,
          zoned(order.createdAt).min,
          order.spot ?? null,
          order.roomBill?.room ?? null,
        );
        writeParts(order);
        const event = appendEvent(order, "order.created", input.now, []);
        return { order, secret: input.secret, created: true, event };
      });
    },

    getOrder: readOrder,

    findByToken(token, day) {
      const row = q.byToken.get(token, day) as Row | undefined;
      return row === undefined ? undefined : readOrder(row.id as string)?.order;
    },

    openOrders() {
      return (q.open.all() as Row[]).map((r) => (readOrder(r.id as string) as { order: Order }).order);
    },

    saveOrder(order, type, now) {
      return tx(() => writeOrder(order, type, now));
    },

    openRoomOrders() {
      return (q.roomOpen.all() as Row[]).map((r) => (readOrder(r.id as string) as { order: Order }).order);
    },

    settleRoom(settlement, build) {
      return tx(() => {
        const { id } = q.insertSettlement.get(
          settlement.room,
          settlement.label,
          settlement.at,
          settlement.by,
          settlement.level,
          settlement.method,
          settlement.amountMinor,
        ) as { id: number };
        const orders = build(id);
        if (orders.some((o) => o.roomBill?.settlement !== id)) {
          throw new Error(`settleRoom: expected every settled order to carry settlement ${id}, found one without`);
        }
        const orderIds = orders.map((o) => o.id);
        q.settlementOrders.run(JSON.stringify(orderIds), id);
        const events = orders.map((o) => writeOrder(o, "order.updated", settlement.at));
        return { settlement: { ...settlement, id, orderIds }, events };
      });
    },

    calendarEvents() {
      return (q.calendar.all() as Row[]).map((r) => ({
        ...(JSON.parse(r.data as string) as EventInput),
        id: r.id as number,
      }));
    },

    addCalendarEvent(input, by, at) {
      const { id } = q.addCalendar.get(JSON.stringify(input), at, by) as { id: number };
      return { ...input, id };
    },

    updateCalendarEvent(id, input) {
      return q.updateCalendar.run(JSON.stringify(input), id).changes === 1;
    },

    deleteCalendarEvents(ids) {
      return tx(() => ids.reduce((n, id) => n + Number(q.deleteCalendar.run(id).changes), 0));
    },

    moveOffRoomBill(order, move) {
      return tx(() => {
        const { id } = q.insertMove.get(move.orderId, move.room, move.at, move.by, move.level, move.reason ?? null) as {
          id: number;
        };
        return { move: { ...move, id }, event: writeOrder(order, "order.updated", move.at) };
      });
    },

    roomBillMoves(limit) {
      return (q.moves.all(limit) as Row[]).map(
        (r): RoomBillMove => ({
          id: r.id as number,
          orderId: r.order_id as string,
          room: r.room as string,
          at: r.at as number,
          by: r.by_user as string,
          level: r.level as string,
          ...(r.reason === null ? {} : { reason: r.reason as string }),
        }),
      );
    },

    roomSettlements(limit) {
      return (q.settlements.all(limit) as Row[]).map(
        (r): RoomSettlement => ({
          id: r.id as number,
          room: r.room as string,
          label: r.label as string,
          at: r.at as number,
          by: r.by_user as string,
          level: r.level as string,
          method: r.method as PaymentMethod,
          amountMinor: r.amount_minor as number,
          orderIds: JSON.parse(r.orders as string) as string[],
        }),
      );
    },

    eventsAfter(afterId, filter, limit = 500) {
      let rows: Row[];
      if (filter.orderId !== undefined) rows = q.eventsOrder.all(afterId, filter.orderId, limit) as Row[];
      else if (filter.stationId !== undefined) {
        rows = q.eventsStation.all(afterId, `%,${filter.stationId},%`, limit) as Row[];
      } else rows = q.eventsAll.all(afterId, limit) as Row[];
      return rows.map(toEvent);
    },

    lastEventId: () => (q.lastEvent.get() as Row).id as number,

    pruneEvents: (before) =>
      tx(() => {
        q.blankOldEventNames.run(before);
        return q.pruneEvents.run(before).changes;
      }),

    putStaff(member) {
      q.putStaff.run(member.id, member.name, member.pinHash, member.role);
    },

    renameStaff(from, to) {
      tx(() => {
        d.prepare("UPDATE staff SET id = ? WHERE id = ?").run(to, from);
        q.deleteUserSessions.run(from);
      });
    },

    getStaff(id) {
      const row = q.staff.get(id) as Row | undefined;
      return row === undefined
        ? undefined
        : {
            id: row.id as string,
            name: row.name as string,
            pinHash: row.pin_hash as string,
            role: row.role as StaffRole,
          };
    },

    listStaff: () =>
      (q.staffList.all() as Row[]).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        role: r.role as StaffRole,
      })),

    putSession(s, now) {
      q.expireSessions.run(now);
      q.putSession.run(s.idHash, s.user, s.role, s.expiresAt);
    },

    getSession(idHash, now) {
      const row = q.session.get(idHash, now) as Row | undefined;
      return row === undefined
        ? undefined
        : {
            idHash: row.id_hash as string,
            user: row.user as string,
            role: row.role as Role,
            expiresAt: row.expires_at as number,
          };
    },

    deleteSession(idHash) {
      q.deleteSession.run(idHash);
    },

    deleteSessionsFor(user) {
      q.deleteUserSessions.run(user);
    },

    putReview(r) {
      return Number(q.putReview.run(r.orderId, r.rating, r.text ?? null, r.at).changes) === 1;
    },

    getReview(orderId) {
      const row = q.review.get(orderId) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        orderId: row.order_id as string,
        rating: row.rating as number,
        ...(row.text === null ? {} : { text: row.text as string }),
        at: row.at as number,
      };
    },

    forgetCustomers(cutoff) {
      const result = tx(() => {
        const from = (q.retentionMark.get() as Row).cutoff as number;
        if (cutoff <= from) return { orders: 0, events: 0, reviews: 0, notes: 0 };
        q.blankNotes.run(from, cutoff);
        q.blankEventNotes.run(from, cutoff);
        q.blankNames.run(from, cutoff);
        q.blankEventNames.run(from, cutoff);
        q.blankReviewText.run(from, cutoff);
        const changed = {
          orders: Number(q.forgetNames.run(from, cutoff).changes),
          events: Number(q.forgetEventNames.run(from, cutoff).changes),
          reviews: Number(q.forgetReviewText.run(from, cutoff).changes),
          notes: Number(q.forgetNotes.run(from, cutoff).changes),
        };
        q.forgetEventNotes.run(from, cutoff);
        q.setRetentionMark.run(cutoff);
        return changed;
      });
      // The old page images may still sit in a write-ahead log until a checkpoint; the driver flushes it where it can.
      if (result.orders + result.events + result.reviews + result.notes > 0) d.afterForget();
      return result;
    },

    setAvailability(itemId, available) {
      q.setAvailability.run(itemId, available ? 1 : 0);
    },

    topSellers(from) {
      return (q.topSellers.all(from) as Row[]).map((r) => ({ itemId: r.item_id as string, qty: r.qty as number }));
    },
    recentWaitsMs(from) {
      return (q.waits.all(from) as Row[]).map((r) => r.wait as number);
    },
    themeOverride() {
      return (q.themeGet.get() as Row | undefined)?.json as string | undefined;
    },
    setThemeOverride(json) {
      if (json === undefined) q.themeClear.run();
      else q.themeSet.run(json);
    },
    availability() {
      return new Map((q.availability.all() as Row[]).map((r) => [r.item_id as string, r.available === 1]));
    },

    ordersOnDay(day) {
      return (q.onDay.all(day) as Row[]).map((r) => (readOrder(r.id as string) as { order: Order }).order);
    },

    salesSince(from) {
      const lines = new Map<string, Sale["lines"][number][]>();
      for (const l of q.salesLines.all(from) as Row[]) {
        const id = l.order_id as string;
        const line = {
          itemId: l.item_id as string,
          name: l.name as string,
          qty: l.qty as number,
          unitMinor: l.unit_minor as number,
          ...(l.size === null ? {} : { size: l.size as string }),
        };
        lines.set(id, [...(lines.get(id) ?? []), line]);
      }
      // A confirmed amount already includes its top-ups; each part counts on the day it was confirmed.
      const topUps = new Map<string, Receipt[]>();
      for (const t of q.salesTopUps.all(from) as Row[]) {
        const id = t.order_id as string;
        topUps.set(id, [
          ...(topUps.get(id) ?? []),
          { amountMinor: t.amount_minor as number, at: t.at as number, method: method(t.method) },
        ]);
      }
      const received = new Map<string, Receipt[]>();
      for (const p of q.salesPayments.all(from) as Row[]) {
        const id = p.order_id as string;
        const extra = topUps.get(id) ?? [];
        const base = (p.amount_minor as number) - extra.reduce((n, t) => n + t.amountMinor, 0);
        received.set(id, [{ amountMinor: base, at: p.at as number, method: method(p.method) }, ...extra]);
      }
      for (const f of q.salesRefunds.all(from) as Row[]) {
        const id = f.order_id as string;
        received.set(id, [
          ...(received.get(id) ?? []),
          { amountMinor: -(f.amount_minor as number), at: f.at as number, method: method(f.method) },
        ]);
      }
      return (q.salesOrders.all(from) as Row[]).map((r) => ({
        createdAt: r.created_at as number,
        lines: lines.get(r.id as string) ?? [],
        received: received.get(r.id as string) ?? [],
      }));
    },

    namedOrdersSince(from) {
      return (q.named.all(from) as Row[]).map((r) => ({
        name: r.customer_name as string,
        createdAt: r.created_at as number,
      }));
    },

    recentReviews(limit) {
      return (q.recentReviews.all(limit) as Row[]).map((r) => ({
        orderId: r.order_id as string,
        token: r.token as string,
        rating: r.rating as number,
        ...(r.text === null ? {} : { text: r.text as string }),
        at: r.at as number,
      }));
    },

    retentionMark: () => (q.retentionMark.get() as Row).cutoff as number,

    exportData(fromDay, toDay) {
      const all = (table: string, columns = "*") => d.prepare(`SELECT ${columns} FROM ${table}`).all();
      // The tables that hang off an order, limited to the orders of the day range.
      const ofRange = (table: string, columns = "*") =>
        d
          .prepare(
            `SELECT ${columns} FROM ${table} WHERE order_id IN (SELECT id FROM orders WHERE day >= ? AND day <= ?)`,
          )
          .all(fromDay, toDay);
      return {
        orders: d
          .prepare(
            "SELECT id, day, token, created_at, currency, customer_name, status FROM orders WHERE day >= ? AND day <= ? ORDER BY created_at",
          )
          .all(fromDay, toDay),
        order_lines: ofRange("order_lines"),
        status_changes: ofRange("status_changes"),
        payments: ofRange("payments"),
        payment_top_ups: ofRange("payment_top_ups"),
        payment_refunds: ofRange("payment_refunds"),
        room_settlements: d
          .prepare("SELECT id, room, label, at, by_user, level, method, amount_minor, orders FROM room_settlements")
          .all(),
        reviews: ofRange("reviews"),
        staff: all("staff", "id, name, role"),
        calendar_events: all("calendar_events", "id, data, created_at"),
        item_availability: all("item_availability"),
        token_counters: all("token_counters"),
      };
    },
    useTimeZone: useZone,

    dayStats: aggregate,

    dayRecords(days, timeZone) {
      const found = new Map<string, DayRecord>();
      for (const day of days) {
        const row = q.storedDay.get(day) as Row | undefined;
        const record = row === undefined ? liveDay(day, timeZone) : (JSON.parse(row.data as string) as DayRecord);
        if (record.orders > 0) found.set(day, record);
      }
      return found;
    },

    closeDay(day, timeZone) {
      const row = q.storedDay.get(day) as Row | undefined;
      if (row !== undefined) return JSON.parse(row.data as string) as DayRecord;
      const record = liveDay(day, timeZone);
      if (record.orders === 0) return undefined;
      q.putDay.run(day, JSON.stringify(record));
      return record;
    },

    closeNextDay(today, timeZone) {
      const after = ((q.lastClosed.get() as Row).day as string | null) ?? "";
      const day = (q.nextDay.get(after, today) as Row).day as string | null;
      if (day === null) return undefined;
      q.putDay.run(day, JSON.stringify(liveDay(day, timeZone)));
      return day;
    },

    flags() {
      return new Map(
        (q.getFlags.all() as Row[]).map((r) => [r.key as string, JSON.parse(r.value as string) as FlagValue]),
      );
    },

    setFlag({ key, value, from, by, level, at }) {
      return tx(() => {
        if (from === value) return undefined;
        q.putFlag.run(key, JSON.stringify(value));
        q.putAudit.run(at, by, level, key, JSON.stringify(from), JSON.stringify(value));
        return { key, from, to: value };
      });
    },

    auditFlags(changes, by, level, at) {
      tx(() => {
        for (const c of changes) {
          q.putAudit.run(at, by, level, c.key, c.from === null ? null : JSON.stringify(c.from), JSON.stringify(c.to));
        }
      });
    },

    flagAudit: (limit) =>
      (q.audit.all(limit) as Row[]).map((r) => ({
        id: r.id as number,
        at: r.at as number,
        by: r.by_user as string,
        level: r.level as Level,
        key: r.key as string,
        from: r.from_value === null ? null : (JSON.parse(r.from_value as string) as FlagValue),
        to: JSON.parse(r.to_value as string) as FlagValue,
      })),

    addTelemetry(hour, add) {
      tx(() => {
        const row = q.hour.get(hour) as Row | undefined;
        const routes = row === undefined ? {} : (JSON.parse(row.routes as string) as TelemetryAdd["routes"]);
        for (const [name, r] of Object.entries(add.routes)) {
          const had = routes[name];
          routes[name] =
            had === undefined
              ? r
              : { n: had.n + r.n, totalMs: had.totalMs + r.totalMs, maxMs: Math.max(had.maxMs, r.maxMs) };
        }
        q.putHour.run(
          hour,
          ((row?.requests as number | undefined) ?? 0) + add.requests,
          ((row?.errors as number | undefined) ?? 0) + add.errors,
          ((row?.rows_written as number | undefined) ?? 0) + add.rowsWritten,
          JSON.stringify(routes),
        );
      });
    },

    telemetryHours: (fromHour) =>
      (q.hours.all(fromHour) as Row[]).map((r) => ({
        hour: r.hour as number,
        requests: r.requests as number,
        errors: r.errors as number,
        rowsWritten: r.rows_written as number,
        routes: JSON.parse(r.routes as string) as TelemetryAdd["routes"],
      })),

    pruneTelemetry(beforeHour) {
      q.pruneHours.run(beforeHour);
    },

    meta: (key) => (q.getMeta.get(key) as Row | undefined)?.value as string | undefined,
    setMeta(key, value) {
      q.putMeta.run(key, value);
    },
    databaseSize: () => d.size(),
    rowsWritten: () => d.rowsWritten(),

    markDemo: () => d.markDemo(),
    isDemo: () => d.isDemo(),
    isEmpty: () =>
      (d.prepare("SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM staff) AS n").get() as Row).n === 0,

    close() {
      d.close();
    },
  };
  return store;
}
