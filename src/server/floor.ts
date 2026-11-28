/**
 * The floor over HTTP (D-102, D-103): the table sections the owner and the manager edit (one stored row overriding
 * `spots.json`'s tables; rooms stay in `spots.json`), and each section's runner for the business day, set by the counter,
 * the manager or the owner. The rules are `src/core/sections.ts`; this module checks who may and persists.
 */

import type { Context, Hono } from "hono";
import type { Config, Zone } from "../core/config.ts";
import type { Power } from "../core/levels.ts";
import { editableSections, parseSections, SectionError, withLayout } from "../core/sections.ts";
import { dayKey } from "../core/tokens.ts";
import type { Session, Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";

export interface FloorDeps {
  config: Config;
  store: Store;
  now: () => number;
  requirePower: (c: Context<Env>, power: Power) => Session;
  /** `ops.sections`: runners see their own sections first. */
  sectionsOn: () => boolean;
  /** The edited table sections in force, or undefined while `spots.json`'s are. */
  tables: () => Zone[] | undefined;
  setTables: (tables: Zone[]) => void;
}

const rooms = (config: Config) => config.zones.filter((z) => z.kind === "room");

/**
 * The stored layout, parsed against today's rooms; undefined when the owner never edited one. A stored layout that no
 * longer fits (a room added to spots.json since, under a table's id) stops the boot with what to change.
 */
export function loadTables(config: Config, store: Store): Zone[] | undefined {
  const raw = store.sectionsLayout();
  if (raw === undefined) return undefined;
  try {
    return parseSections(JSON.parse(raw), rooms(config));
  } catch (e) {
    throw new Error(
      `ibow: the sections edited at run time no longer fit spots.json (${(e as Error).message}); expected room ids and spot names apart from the edited tables; rename the room zone in spots.json, or edit the sections back on an older spots.json first`,
    );
  }
}

export function registerFloor(http: Hono<Env>, deps: FloorDeps): void {
  const { config, store, now, requirePower } = deps;
  const today = () => dayKey(now(), config.business.timeZone);
  const current = () => withLayout(config, deps.tables());

  async function body(c: Context): Promise<Record<string, unknown>> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    return input.object(raw);
  }

  // What the runner, the floor and the editor read: one stored row and the day's runners, never an order.
  http.get("/api/sections", (c) => {
    requirePower(c, "orders.view");
    const live = current();
    const ids = new Set(live.zones.map((z) => z.id));
    const runners = Object.fromEntries([...store.sectionRunners(today())].filter(([section]) => ids.has(section)));
    return c.json({
      on: deps.sectionsOn(),
      edited: deps.tables() !== undefined,
      sections: editableSections(live),
      zones: live.zones,
      runners,
      staff: store.listStaff().map(({ id, name }) => ({ id, name })),
    });
  });

  http.put("/api/sections", async (c) => {
    requirePower(c, "sections.edit");
    const b = await body(c);
    let tables: Zone[];
    try {
      tables = parseSections(b.sections, rooms(config));
    } catch (e) {
      if (e instanceof SectionError) throw new ApiError(400, e.code, e.message.replace(/^\w+: /, ""));
      throw e;
    }
    const live = withLayout(config, tables);
    // Stored in the editor's form, so the next boot parses it with the same rules.
    store.setSectionsLayout(JSON.stringify(editableSections(live)));
    deps.setTables(tables);
    return c.json({ sections: editableSections(live), zones: live.zones });
  });

  http.put("/api/sections/:id/runner", async (c) => {
    requirePower(c, "orders.run");
    const section = c.req.param("id");
    const b = await body(c);
    if (!current().zones.some((z) => z.id === section)) {
      throw new ApiError(404, "no_such_section", `expected a section of the layout in force, found ${section}`);
    }
    if (b.user !== null && (typeof b.user !== "string" || store.getStaff(b.user) === undefined)) {
      throw new ApiError(400, "bad_runner", `expected a staff id or null (nobody), found ${JSON.stringify(b.user)}`);
    }
    store.setSectionRunner(section, today(), b.user === null ? undefined : (b.user as string));
    return c.json({ section, user: b.user });
  });
}
