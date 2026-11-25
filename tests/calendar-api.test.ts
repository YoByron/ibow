import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { EventInput } from "../src/core/calendar.ts";
import { DEFAULT_THEME } from "../src/core/theme.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("garden-cafe");
/** Wednesday 2 December 2026, 11:00 in Lisbon. */
const t0 = Date.UTC(2026, 11, 2, 11, 0);
const DAY = 86_400_000;
const PIN = "908172";
const STAFF_PIN = "246810";
let hash = "";
let staffHash = "";
let now = t0;
let store: Store;
let http: ReturnType<typeof createApp>["http"];

beforeAll(async () => {
  [hash, staffHash] = await Promise.all([hashPin(PIN, TEST_PIN_COST), hashPin(STAFF_PIN, TEST_PIN_COST)]);
});
afterEach(() => store.close());

function boot(seed?: EventInput[], keep = false): void {
  if (!keep) {
    now = t0;
    store = openStore(":memory:");
    store.putStaff({ id: "desk", name: "Desk", pinHash: staffHash, role: "counter" });
    store.putStaff({ id: "boss", name: "Boss", pinHash: staffHash, role: "manager" });
  }
  const look = {
    theme: DEFAULT_THEME,
    strings: {},
    media: new Map(),
    imageOrigins: [],
    ...(seed ? { events: seed } : {}),
  };
  http = createApp({ config, store, ownerPinHash: hash, now: () => now, look }).http;
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
  const json = (await res.json()) as any;
  return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const login = async (user: string, pin = STAFF_PIN) =>
  (await call("POST", "/api/login", { user, pin })).cookie as string;
const titles = (r: { body: { events: { title: string }[] } }) => r.body.events.map((e) => e.title);

const market: EventInput = { title: "Flea market", date: "2026-12-05", start: "10:00", audience: "all", rush: true };
const delivery: EventInput = {
  title: "Big delivery",
  date: "2026-12-04",
  start: "08:00",
  audience: "staff",
  rush: false,
};

describe("events over HTTP (D-084)", () => {
  test("anyone reads the week's guest events; a signed-in level also sees staff-only ones", async () => {
    boot([market, delivery]);
    expect(titles(await call("GET", "/api/events"))).toEqual(["Flea market"]);
    expect((await call("GET", "/api/events")).body.events[0]).toMatchObject({
      day: "2026-12-05",
      inDays: 3,
      rush: true,
    });
    expect(titles(await call("GET", "/api/events", undefined, await login("desk")))).toEqual([
      "Big delivery",
      "Flea market",
    ]);
    expect(titles(await call("GET", "/api/events", undefined, await login("owner", PIN)))).toHaveLength(2);
  });

  test("events.json seeds once: an event deleted later does not come back at the next start", async () => {
    boot([market]);
    const owner = await login("owner", PIN);
    const all = await call("GET", "/api/events/all", undefined, owner);
    expect(all.body.events).toHaveLength(1);
    expect((await call("DELETE", `/api/events/${all.body.events[0].id}`, undefined, owner)).status).toBe(200);
    boot([market], true);
    expect((await call("GET", "/api/events/all", undefined, await login("owner", PIN))).body.events).toEqual([]);
  });

  test("the owner and a manager add, change and delete; staff and guests may not", async () => {
    boot();
    const boss = await login("boss");
    const added = await call(
      "POST",
      "/api/events",
      {
        title: "Folk dance",
        date: "2026-12-06",
        start: "16:30",
        repeat: { weekdays: ["sun"] },
        price: 700,
        note: "€7 entry",
      },
      boss,
    );
    expect(added.status).toBe(201);
    expect(added.body.event).toMatchObject({ title: "Folk dance", repeat: { weekdays: [0] }, price: 700 });
    const id = added.body.event.id;
    const changed = await call(
      "PUT",
      `/api/events/${id}`,
      { ...added.body.event, id: undefined, start: "17:00" },
      boss,
    );
    expect(changed.body.event.start).toBe("17:00");
    expect((await call("GET", "/api/events")).body.events[0]).toMatchObject({
      title: "Folk dance",
      start: "17:00",
      inDays: 4,
    });

    const desk = await login("desk");
    expect((await call("POST", "/api/events", market, desk)).status).toBe(403);
    expect((await call("POST", "/api/events", market)).status).toBe(401);
    expect((await call("GET", "/api/events/all", undefined, desk)).status).toBe(403);
    const bad = await call("POST", "/api/events", { ...market, start: "25:00" }, boss);
    expect([bad.status, bad.body.error]).toEqual([400, "bad_event"]);
    expect(bad.body.message).toContain("start");
    expect((await call("DELETE", "/api/events/9999", undefined, boss)).status).toBe(404);
    expect((await call("DELETE", `/api/events/${id}`, undefined, boss)).status).toBe(200);
    expect((await call("GET", "/api/events")).body.events).toEqual([]);
  });

  test("past events are deleted a couple of days after their day; a weekly one stays", async () => {
    boot([market, { ...market, title: "Every Sunday", date: "2026-11-01", repeat: { weekdays: [0] } }]);
    now = t0 + 10 * DAY;
    const owner = await login("owner", PIN);
    expect(titles(await call("GET", "/api/events/all", undefined, owner))).toEqual(["Every Sunday"]);
    expect(store.calendarEvents().map((e) => e.title)).toEqual(["Every Sunday"]);
  });
});
