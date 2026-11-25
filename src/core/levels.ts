/**
 * Who may do what (D-072). One table, here, read by the server for every check, by the links hub for what to show, and
 * rendered into `docs/architecture.md` (a test keeps the two equal). Pure: no I/O, no business knowledge.
 *
 * Four levels, each signing in with its own PIN: `staff` (the people at the counter and stations, narrowed further by
 * their own `counter`/`station`/`all` role), `manager` (day to day), `owner` (the business) and `admin` (the install:
 * health, system switches, updates; it sees no customer or sales data).
 */

export const LEVELS = ["staff", "manager", "owner", "admin"] as const;
export type Level = (typeof LEVELS)[number];

export const POWERS = [
  "orders.view",
  "orders.run",
  "refund",
  "menu.switch",
  "events.manage",
  "reports",
  "staff.manage",
  "look.edit",
  "flags.look",
  "ai.ask",
  "flags.system",
  "telemetry",
  "hub",
] as const;
export type Power = (typeof POWERS)[number];

interface PowerRow {
  levels: readonly Level[];
  /** One line, as the docs table and the hub say it. */
  what: string;
}

const STAFF_UP: readonly Level[] = ["staff", "manager", "owner"];

export const TABLE: Readonly<Record<Power, PowerRow>> = {
  "orders.view": { levels: STAFF_UP, what: "See open orders on the counter, stations and runner screens" },
  "orders.run": {
    levels: STAFF_UP,
    what: "Take payment, serve, advance and add to orders (a staff member's own role may narrow it)",
  },
  refund: {
    levels: ["manager", "owner"],
    what: "Hand money back on an order (a manager up to `managerRefundLimit` on one order)",
  },
  "menu.switch": { levels: ["manager", "owner"], what: "Switch items on or off and set today's counts" },
  "events.manage": {
    levels: ["manager", "owner"],
    what: "Add, change and delete the business's events, and who sees each",
  },
  reports: { levels: ["owner"], what: "Read the dashboard, orders, reviews and the export" },
  "staff.manage": { levels: ["owner"], what: "Add staff and managers, change their PINs and roles" },
  "look.edit": { levels: ["owner"], what: "Change the Appearance and the spots" },
  "flags.look": { levels: ["owner"], what: "Flip the look and menu switches (the theme's features)" },
  "ai.ask": { levels: ["owner"], what: "Ask the AI analyst (when it is on)" },
  "flags.system": {
    levels: ["admin"],
    what: "Flip the system switches: AI analyst on or off, retention days, showcase",
  },
  telemetry: {
    levels: ["admin"],
    what: "Read the install's health: requests, errors, streams, rows, size, uptime, backup",
  },
  hub: { levels: LEVELS, what: "Open the links hub at /admin and see the links your level may open" },
};

export function can(level: Level, power: Power): boolean {
  return TABLE[power].levels.includes(level);
}

/**
 * The most this level may refund on one order, in minor units: `undefined` for no limit (the owner), 0 for none. A manager
 * gets what `business.json` allows, nothing when it names no limit; staff and the admin never refund.
 */
export function refundCeiling(level: Level, managerLimitMinor: number | undefined): number | undefined {
  if (level === "owner") return undefined;
  if (level === "manager") return managerLimitMinor ?? 0;
  return 0;
}

/** Whether this level may hand back `amountMinor` on one order (its whole refunded sum, this one included). */
export function mayRefund(level: Level, totalRefundedMinor: number, managerLimitMinor: number | undefined): boolean {
  const ceiling = refundCeiling(level, managerLimitMinor);
  return ceiling === undefined || (ceiling > 0 && totalRefundedMinor <= ceiling);
}

/** The table as Markdown, for `docs/architecture.md`. */
export function powerTableMarkdown(): string {
  const mark = (p: Power, l: Level) => (can(l, p) ? "yes" : "");
  const rows = POWERS.map((p) => `| \`${p}\` | ${TABLE[p].what} | ${LEVELS.map((l) => mark(p, l)).join(" | ")} |`);
  return [
    `| Power | What it lets a person do | ${LEVELS.join(" | ")} |`,
    `|---|---|${LEVELS.map(() => ":-:").join("|")}|`,
    ...rows,
  ].join("\n");
}
