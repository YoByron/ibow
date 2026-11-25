/** Each level signs in with its own PIN and holds exactly its powers (D-072), checked over HTTP. */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { can, LEVELS, type Level, POWERS } from "../src/core/levels.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("garden-cafe");
const t0 = Date.UTC(2026, 11, 1, 12, 0);
const PINS = { owner: "908172", admin: "445566", manager: "3344", staff: "5566" };
let hashes: Record<string, string> = {};
let store: Store;
let http: ReturnType<typeof createApp>["http"];

beforeAll(async () => {
  hashes = {
    owner: await hashPin(PINS.owner, TEST_PIN_COST),
    admin: await hashPin(PINS.admin, TEST_PIN_COST),
  };
});
afterEach(() => store.close());

function boot(withAdmin = true): void {
  store = openStore(":memory:");
  http = createApp({
    config,
    store,
    ownerPinHash: hashes.owner as string,
    ...(withAdmin ? { adminPinHash: hashes.admin as string } : {}),
    now: () => t0,
  }).http;
}

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await http.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const login = (user: string, pin: string) => call("POST", "/api/login", { user, pin });

/** Signs in as each level; the owner makes a manager and a counter staff member first. */
async function everyone(): Promise<Record<Level, string>> {
  const owner = (await login("owner", PINS.owner)).cookie as string;
  await call("PUT", "/api/staff/mgr", { name: "Manager", pin: PINS.manager, role: "manager" }, owner);
  await call("PUT", "/api/staff/till", { name: "Till", pin: PINS.staff, role: "counter" }, owner);
  return {
    owner,
    admin: (await login("admin", PINS.admin)).cookie as string,
    manager: (await login("mgr", PINS.manager)).cookie as string,
    staff: (await login("till", PINS.staff)).cookie as string,
  };
}

describe("sign-in at each level", () => {
  test("each level has its own PIN and its own role; the owner PIN never opens another level", async () => {
    boot();
    const c = await everyone();
    for (const level of LEVELS) {
      const me = await call("GET", "/api/me", undefined, c[level]);
      expect(me.status, level).toBe(200);
      expect(me.body.role, level).toBe(level);
      expect(me.body.powers, level).toEqual(POWERS.filter((p) => can(level, p)));
    }
    expect((await login("admin", PINS.owner)).status).toBe(401);
    expect((await login("owner", PINS.admin)).status).toBe(401);
    expect((await login("mgr", PINS.owner)).status).toBe(401);
  });

  test("without ADMIN_PIN_HASH nobody can sign in as admin, and the answer is the same as for a wrong PIN", async () => {
    boot(false);
    const r = await login("admin", PINS.admin);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("bad_pin");
  });

  test("staff ids owner and admin are reserved, and a manager role is the owner to give", async () => {
    boot();
    const c = await everyone();
    const bad = await call("PUT", "/api/staff/admin", { name: "X", pin: "1234" }, c.owner);
    expect(bad.status).toBe(400);
    const byManager = await call("PUT", "/api/staff/other", { name: "O", pin: "1234", role: "manager" }, c.manager);
    expect(byManager.status).toBe(403);
  });
});

describe("what each level may open", () => {
  const routes: [string, string, unknown, (typeof POWERS)[number]][] = [
    ["GET", "/api/orders", undefined, "orders.view"],
    ["GET", "/api/owner/insights", undefined, "reports"],
    ["GET", "/api/owner/orders", undefined, "reports"],
    ["GET", "/api/owner/reviews", undefined, "reports"],
    ["GET", "/api/owner/export", undefined, "reports"],
    ["GET", "/api/staff", undefined, "staff.manage"],
    ["PUT", "/api/menu/items/latte", { available: true }, "menu.switch"],
    ["GET", "/api/owner/theme", undefined, "look.edit"],
    ["GET", "/api/me", undefined, "hub"],
  ];

  test("every route answers 403 to a level without its power and not 403 to one with it", async () => {
    boot();
    const c = await everyone();
    for (const [method, path, body, power] of routes) {
      for (const level of LEVELS) {
        const r = await call(method, path, body, c[level]);
        expect(r.status === 403, `${level} ${method} ${path} -> ${r.status}`).toBe(!can(level, power));
        if (can(level, power)) expect(r.status, `${level} ${method} ${path}`).toBeLessThan(400);
      }
      expect((await call(method, path, body)).status, `signed out ${path}`).toBe(401);
    }
  });

  test("station-only staff keep the counter actions out of reach, as before", async () => {
    boot();
    const owner = (await login("owner", PINS.owner)).cookie as string;
    await call("PUT", "/api/staff/kitchen", { name: "K", pin: "7788", role: "station" }, owner);
    const k = (await login("kitchen", "7788")).cookie as string;
    expect((await call("GET", "/api/orders", undefined, k)).status).toBe(200);
    expect((await call("POST", "/api/orders/x/advance", undefined, k)).status).toBe(403);
  });
});

describe("refunds by level", () => {
  async function paidOrder(c: Record<Level, string>, qty = 6) {
    const made = await call("POST", "/api/orders", {
      clientKey: `levels-client-key-${Math.random().toString(36).slice(2, 12)}`,
      lines: [{ itemId: "carrot-cake", qty }],
    });
    const id = made.body.order.id as string;
    const total = made.body.order.totalMinor as number;
    await call("POST", `/api/orders/${id}/confirm`, { method: "cash", amountMinor: total }, c.owner);
    return { id, total };
  }

  test("a manager refunds up to the limit in business.json on one order, the whole of it counted; the owner has none", async () => {
    boot();
    const c = await everyone();
    const { id, total } = await paidOrder(c);
    expect(total).toBeGreaterThan(2000);
    const me = await call("GET", "/api/me", undefined, c.manager);
    expect(me.body).toMatchObject({ canRefund: true, refundLimitMinor: 2000 });
    const give = (cookie: string, amountMinor: number) =>
      call("POST", `/api/orders/${id}/refund`, { method: "cash", amountMinor }, cookie);
    expect((await give(c.manager, 1500)).status).toBe(200);
    const over = await give(c.manager, 501);
    expect(over.status).toBe(403);
    expect(over.body.error).toBe("refund_limit");
    expect((await give(c.manager, 500)).status).toBe(200);
    const owner = await give(c.owner, total - 2000);
    expect(owner.status).toBe(200);
    expect(owner.body.order.payment.refunds.map((r: { by: string }) => r.by)).toEqual(["mgr", "mgr", "owner"]);
    expect((await give(c.staff, 1)).status).toBe(403);
    expect((await give(c.admin, 1)).status).toBe(403);
    expect((await call("GET", "/api/me", undefined, c.staff)).body.canRefund).toBe(false);
  });
});

describe("an install from before the admin level (D-072)", () => {
  test('a staff member saved as "admin" stops the boot with a message that says what to do', () => {
    store = openStore(":memory:");
    store.putStaff({ id: "admin", name: "Old admin", pinHash: "hash-1", role: "counter" });
    expect(() => createApp({ config, store, ownerPinHash: hashes.owner as string, now: () => t0 })).toThrow(
      /staff member has the id "admin".*expected no such staff record, found one.*RENAME_ADMIN_STAFF.*wrangler secret put RENAME_ADMIN_STAFF.*UPDATE staff SET id/,
    );
  });

  test("RENAME_ADMIN_STAFF renames that staff member once, ends their sessions, and the boot goes on", () => {
    store = openStore(":memory:");
    store.putStaff({ id: "admin", name: "Old admin", pinHash: "hash-1", role: "counter" });
    store.putSession({ idHash: "s1", user: "admin", role: "staff", expiresAt: t0 + 60_000 }, t0);
    createApp({ config, store, ownerPinHash: hashes.owner as string, now: () => t0, renameAdminStaff: "till-old" });
    expect(store.getStaff("admin")).toBeUndefined();
    expect(store.getStaff("till-old")).toMatchObject({ name: "Old admin", pinHash: "hash-1", role: "counter" });
    expect(store.getSession("s1", t0)).toBeUndefined();
    // Set again on a later start, it does nothing.
    createApp({ config, store, ownerPinHash: hashes.owner as string, now: () => t0, renameAdminStaff: "till-old" });
  });

  test("a rename to a bad or taken id is refused loudly", () => {
    store = openStore(":memory:");
    store.putStaff({ id: "admin", name: "Old admin", pinHash: "hash-1", role: "counter" });
    store.putStaff({ id: "till", name: "Till", pinHash: "hash-2", role: "counter" });
    const boot = (to: string) => () =>
      createApp({ config, store, ownerPinHash: hashes.owner as string, now: () => t0, renameAdminStaff: to });
    expect(boot("Not An Id")).toThrow(/RENAME_ADMIN_STAFF.*expected a staff id/);
    expect(boot("till")).toThrow(/RENAME_ADMIN_STAFF.*already taken/);
    expect(boot("admin")).toThrow(/RENAME_ADMIN_STAFF/);
  });
});
