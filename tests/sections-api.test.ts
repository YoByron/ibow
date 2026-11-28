/**
 * Sections over HTTP (D-102, D-103): the owner and the manager edit the table sections, which the catalog, new orders and
 * the hub follow at once; room sections are refused. The manager, the owner and counter staff give each section a runner
 * for the day; every handover records who made it, which the owner's report counts per runner.
 */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const t0 = Date.UTC(2026, 11, 1, 11, 0); // 11:00 in Lisbon: open
const PINS = { owner: "908172", manager: "3344", counter: "5566", station: "7788", runner: "1122" };
let hashes: Record<string, string> = {};
let store: Store;
let http: ReturnType<typeof createApp>["http"];
let now = t0;

beforeAll(async () => {
  const entries = await Promise.all(
    Object.entries(PINS).map(async ([k, p]) => [k, await hashPin(p, TEST_PIN_COST)] as const),
  );
  hashes = Object.fromEntries(entries);
});
afterEach(() => (store as Store | undefined)?.close());

function boot(existing?: Store): void {
  now = t0;
  store = existing ?? openStore(":memory:");
  store.putStaff({ id: "mgr", name: "Manager", pinHash: hashes.manager as string, role: "manager" });
  store.putStaff({ id: "till", name: "Till", pinHash: hashes.counter as string, role: "counter" });
  store.putStaff({ id: "barista", name: "Barista", pinHash: hashes.station as string, role: "station" });
  store.putStaff({ id: "asha", name: "Asha", pinHash: hashes.runner as string, role: "counter" });
  http = createApp({ config: cafe, store, ownerPinHash: hashes.owner as string, now: () => now }).http;
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
const login = async (user: string, pin: string) => (await call("POST", "/api/login", { user, pin })).cookie as string;

let n = 0;
async function place(spot: string, cookie?: string) {
  const r = await call(
    "POST",
    "/api/orders",
    { clientKey: `sections-key-${++n}-abcdefgh`, lines: [{ itemId: "carrot-cake", qty: 1 }], spot },
    cookie,
  );
  return r;
}

const PATIO = [
  { id: "garden", name: "Garden", spots: ["T1", "T2"] },
  { name: "Patio", spots: ["P1"] },
];

describe("editing sections (D-102)", () => {
  test("the owner and the manager edit; counter staff may not; the catalog and new orders follow at once", async () => {
    boot();
    const manager = await login("mgr", PINS.manager);
    const till = await login("till", PINS.counter);
    expect((await call("PUT", "/api/sections", { sections: PATIO }, till)).status).toBe(403);
    const put = await call("PUT", "/api/sections", { sections: PATIO }, manager);
    expect(put.status).toBe(200);
    expect(put.body.sections).toEqual([
      {
        id: "garden",
        name: "Garden",
        spots: [
          { id: "garden-t1", name: "T1" },
          { id: "garden-t2", name: "T2" },
        ],
      },
      { id: "patio", name: "Patio", spots: [{ id: "patio-p1", name: "P1" }] },
    ]);
    // Renamed by the editor, which sends each spot's id back: the id and so its printed QR card stay.
    const renamed = put.body.sections.map((s: { id: string; spots: { id: string; name: string }[] }) =>
      s.id === "patio" ? { ...s, spots: [{ ...s.spots[0], name: "Window" }] } : s,
    );
    const again = await call("PUT", "/api/sections", { sections: renamed }, manager);
    expect(again.body.sections[1].spots).toEqual([{ id: "patio-p1", name: "Window" }]);
    expect((await place("patio-p1")).body.order.spot).toBe("Patio Window");
    await call("PUT", "/api/sections", { sections: put.body.sections }, manager);
    const zones = (await call("GET", "/api/catalog")).body.zones as { id: string; spots: { id: string }[] }[];
    expect(zones.map((z) => z.id)).toEqual(["garden", "patio", "rooms"]);
    expect((await place("patio-p1")).body.order.spot).toBe("Patio P1");
    // A spot no longer in the layout is refused for a new order.
    expect((await place("garden-t9")).body.error).toBe("bad_spot");
    const owner = await login("owner", PINS.owner);
    expect((await call("PUT", "/api/sections", { sections: [] }, owner)).status).toBe(200);
    expect(((await call("GET", "/api/catalog")).body.zones as { id: string }[]).map((z) => z.id)).toEqual(["rooms"]);
  });

  test("bad input names the field; a room section is refused with its reason", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const bad = await call("PUT", "/api/sections", { sections: [{ id: "x", name: "", spots: [] }] }, owner);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_sections");
    expect(bad.body.message).toMatch(/\[0\]\.name/);
    const room = await call("PUT", "/api/sections", { sections: [{ id: "rooms", name: "Room", spots: ["9"] }] }, owner);
    expect(room.status).toBe(400);
    expect(room.body.error).toBe("room_section");
    expect(room.body.message).toMatch(/QR key/);
  });

  test("a deleted spot's open order keeps its label, and the edit survives a restart", async () => {
    boot();
    const owner = await login("owner", PINS.owner);
    const placed = (await place("garden-t4")).body.order;
    await call("PUT", "/api/sections", { sections: PATIO }, owner);
    const open = (await call("GET", "/api/orders", undefined, owner)).body.orders as { id: string; spot: string }[];
    expect(open.find((o) => o.id === placed.id)?.spot).toBe("Garden T4");
    const kept = store;
    boot(kept);
    const zones = (await call("GET", "/api/catalog")).body.zones as { id: string }[];
    expect(zones.map((z) => z.id)).toEqual(["garden", "patio", "rooms"]);
  });

  test("GET /api/sections gives staff the layout, the day's runners, who may run, and whether sections are on", async () => {
    boot();
    const till = await login("till", PINS.counter);
    const got = await call("GET", "/api/sections", undefined, till);
    expect(got.status).toBe(200);
    expect(got.body.on).toBe(true);
    expect(got.body.edited).toBe(false);
    expect(got.body.sections[0]).toEqual({ id: "garden", name: "Garden", spots: expect.any(Array) });
    expect((got.body.zones as { id: string }[]).map((z) => z.id)).toEqual(["garden", "terrace", "other", "rooms"]);
    expect(got.body.runners).toEqual({});
    expect(got.body.staff).toEqual(expect.arrayContaining([{ id: "asha", name: "Asha" }]));
    expect((await call("GET", "/api/sections")).status).toBe(401);
  });
});

describe("runners (D-103)", () => {
  test("counter staff, the manager and the owner give a section a runner for the day; station staff may not", async () => {
    boot();
    const till = await login("till", PINS.counter);
    const barista = await login("barista", PINS.station);
    expect((await call("PUT", "/api/sections/garden/runner", { user: "asha" }, barista)).status).toBe(403);
    expect((await call("PUT", "/api/sections/garden/runner", { user: "asha" }, till)).status).toBe(200);
    expect((await call("PUT", "/api/sections/terrace/runner", { user: "asha" }, till)).status).toBe(200);
    expect((await call("GET", "/api/sections", undefined, till)).body.runners).toEqual({
      garden: "asha",
      terrace: "asha",
    });
    expect((await call("PUT", "/api/sections/garden/runner", { user: null }, till)).status).toBe(200);
    expect((await call("GET", "/api/sections", undefined, till)).body.runners).toEqual({ terrace: "asha" });
    expect((await call("PUT", "/api/sections/nowhere/runner", { user: "asha" }, till)).body.error).toBe(
      "no_such_section",
    );
    expect((await call("PUT", "/api/sections/garden/runner", { user: "nobody" }, till)).body.error).toBe("bad_runner");
    // The next business day starts with nobody assigned.
    now += 24 * 60 * 60_000;
    const tomorrow = await login("till", PINS.counter);
    expect((await call("GET", "/api/sections", undefined, tomorrow)).body.runners).toEqual({});
  });

  test("a handover records who made it; the guest never sees it; the owner's report counts handovers per runner", async () => {
    boot();
    const asha = await login("asha", PINS.runner);
    const placed = await place("garden-t4");
    const { id } = placed.body.order;
    now += 60_000;
    const served = await call("POST", `/api/orders/${id}/lines/0/served`, {}, asha);
    expect(served.body.order.lines[0].servedBy).toBe("asha");
    const guest = await http.request(`/api/orders/${id}`, { headers: { "x-order-key": placed.body.key } });
    expect(JSON.stringify(await guest.json())).not.toMatch(/asha|servedBy/i);
    const owner = await login("owner", PINS.owner);
    const insights = (await call("GET", "/api/owner/insights", undefined, owner)).body;
    expect(insights.runners).toEqual([{ user: "asha", name: "Asha", handovers: 1 }]);
  });
});
