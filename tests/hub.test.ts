/** The links hub (D-074): every screen listed once, grouped, and each level sees exactly the links it may open. */

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { grouped, hubLinks, linksFor } from "../src/core/hub.ts";
import { can, LEVELS, type Level } from "../src/core/levels.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { loadSample } from "./support/samples.ts";

const stations = [
  { id: "bar", name: "Bar" },
  { id: "kitchen", name: "Kitchen" },
];
const all = hubLinks({ stations, hasSpots: true, ai: false });

describe("the list", () => {
  test("every link has a line saying what it is for, ids and addresses are unique, stations come from the config", () => {
    for (const l of all) expect(l.what.length, l.id).toBeGreaterThan(20);
    expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
    expect(all.filter((l) => l.id.startsWith("station-")).map((l) => l.href)).toEqual([
      "/staff#/station/bar",
      "/staff#/station/kitchen",
    ]);
    expect(hubLinks({ stations: [], hasSpots: false, ai: false }).some((l) => l.id === "owner-spots")).toBe(false);
    // Without spots there is no floor to show; the sections editor stays, since it is where the first section is added.
    const bare = hubLinks({ stations: [], hasSpots: false, ai: false }).map((l) => l.id);
    expect(bare).not.toContain("floor");
    expect(bare).toContain("sections");
  });

  test("a signed-out visitor sees only the public links", () => {
    expect(linksFor(all, undefined).map((l) => l.id)).toEqual(["storefront", "kiosk"]);
  });

  test("each level sees a link exactly when the table gives it the link's power", () => {
    for (const level of LEVELS) {
      const seen = linksFor(all, level);
      for (const l of all) {
        const expected = l.power === undefined || can(level, l.power);
        expect(seen.includes(l), `${level} ${l.id}`).toBe(expected);
      }
    }
    const ids = (level: Level) => linksFor(all, level).map((l) => l.id);
    expect(ids("staff")).toEqual([
      "storefront",
      "kiosk",
      "counter",
      "station-bar",
      "station-kitchen",
      "runner",
      "floor",
    ]);
    expect(ids("manager")).toEqual([...ids("staff"), "manager", "sections", "switches"]);
    expect(ids("admin")).toEqual(["storefront", "kiosk", "health", "system-switches"]);
    expect(ids("owner")).not.toContain("health");
    expect(ids("owner")).toContain("owner-appearance");
  });

  test("the owner is offered one link to the switches page, not one per scope", () => {
    const toSwitches = linksFor(all, "owner").filter((l) => l.href === "/admin#/switches");
    expect(toSwitches.map((l) => l.id)).toEqual(["switches"]);
  });

  test("station-only staff are not offered the counter or the runner", () => {
    const ids = linksFor(all, "staff", "station").map((l) => l.id);
    expect(ids).not.toContain("counter");
    expect(ids).not.toContain("runner");
    expect(ids).not.toContain("floor");
    expect(ids).toContain("station-bar");
  });

  test("groups come in the order a person meets them, empty ones left out", () => {
    expect(grouped(linksFor(all, "admin")).map((g) => g.group)).toEqual(["everyone", "admin"]);
    expect(grouped(linksFor(all, "owner")).map((g) => g.group)).toEqual(["everyone", "staff", "manager", "owner"]);
  });
});

describe("GET /api/hub", () => {
  const config = loadSample("garden-cafe");
  let store: Store;
  let http: ReturnType<typeof createApp>["http"];
  let hashes = { owner: "", admin: "" };
  beforeAll(async () => {
    hashes = { owner: await hashPin("908172", TEST_PIN_COST), admin: await hashPin("445566", TEST_PIN_COST) };
  });
  afterEach(() => store.close());

  async function get(cookie?: string) {
    const res = await http.request("/api/hub", { headers: cookie ? { cookie } : {} });
    return {
      status: res.status,
      body: (await res.json()) as { level: string | null; groups: { group: string; links: { id: string }[] }[] },
    };
  }

  test("signed out it answers with the public links and no level; the owner and the admin each get their own", async () => {
    store = openStore(":memory:");
    http = createApp({ config, store, ownerPinHash: hashes.owner, adminPinHash: hashes.admin }).http;
    const out = await get();
    expect(out.status).toBe(200);
    expect(out.body.level).toBeNull();
    expect(out.body.groups.map((g) => g.group)).toEqual(["everyone"]);
    const login = async (user: string, pin: string) =>
      (
        await http.request("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user, pin }),
        })
      ).headers
        .get("set-cookie")
        ?.split(";")[0] as string;
    const owner = await get(await login("owner", "908172"));
    expect(owner.body.level).toBe("owner");
    const ownerIds = owner.body.groups.flatMap((g) => g.links.map((l) => l.id));
    // The garden cafe's stations and spots come from its config, not from code.
    expect(ownerIds).toEqual(expect.arrayContaining(["station-bar", "owner-spots", "owner-appearance", "switches"]));
    const admin = await get(await login("admin", "445566"));
    expect(admin.body.groups.flatMap((g) => g.links.map((l) => l.id))).toEqual([
      "storefront",
      "kiosk",
      "health",
      "system-switches",
    ]);
  });
});
