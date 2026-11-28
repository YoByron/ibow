/**
 * The switches and the health of an install over HTTP (D-075, D-076): `GET/PUT /api/flags` for the flags the signed-in
 * level may flip, and `GET /api/admin/health` for the admin. The levels and what they may do are `src/core/levels.ts`; this
 * file only asks. Flag values live in the install (`flags` table), every flip is audited (who, when, from what to what).
 */

import type { Context, Hono } from "hono";
import type { Config, Zone } from "../core/config.ts";
import {
  checkFlag,
  type FlagDef,
  FlagError,
  type FlagValue,
  lookFlags,
  OPS_DEFAULTS,
  OPS_FLAGS,
  SYSTEM_FLAGS,
} from "../core/flags.ts";
import { verdict } from "../core/health.ts";
import { grouped, hubLinks, linksFor } from "../core/hub.ts";
import { can, type Power } from "../core/levels.ts";
import type { Theme } from "../core/theme.ts";
import type { Session, Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";
import * as input from "./input.ts";
import type { Telemetry } from "./telemetry.ts";

/** The system switches in force: what the admin set, else what the config and the deployment say. Held in memory, loaded once. */
export interface SystemFlags {
  retentionDays(): number;
  aiOn(): boolean;
  showcaseOn(): boolean;
  /** An operations switch (D-101) as it stands; `ops.upi` is on only where UPI is set up as well. */
  opsOn(key: "ops.upi" | "ops.counterFirst" | "ops.messages" | "ops.sections"): boolean;
  value(key: string): FlagValue;
  set(key: string, value: FlagValue): void;
}

export function systemFlags(
  store: Store,
  defaults: { retentionDays: number; ai: boolean; showcase: boolean; upi: boolean },
): SystemFlags {
  const stored = store.flags();
  const get = (key: string): FlagValue | undefined => stored.get(key);
  const value = (key: string): FlagValue => {
    const v = get(key);
    if (v !== undefined) return v;
    const ops = OPS_DEFAULTS[key];
    if (ops !== undefined) return ops;
    return key === "retentionDays" ? defaults.retentionDays : key === "ai" ? defaults.ai : defaults.showcase;
  };
  return {
    retentionDays: () => value("retentionDays") as number,
    // Off wins: a flag can switch an AI that is set up off, never switch one on where no model is set up.
    aiOn: () => defaults.ai && value("ai") === true,
    showcaseOn: () => value("showcase") === true,
    // The same for UPI: the switch can take it away, never offer it where no UPI ID is set up.
    opsOn: (key) => value(key) === true && (key !== "ops.upi" || defaults.upi),
    value,
    set: (key, v) => void stored.set(key, v),
  };
}

export interface AdminDeps {
  config: Config;
  /** The zones in force: spots.json's, or the owner's edited tables with spots.json's rooms (D-102). */
  zones: () => Zone[];
  store: Store;
  now: () => number;
  requirePower: (c: Context<Env>, power: Power) => Session;
  system: SystemFlags;
  /** What screens a session's staff role leaves open (the counter's, the stations', or all). */
  accessOf: (s: Session) => "counter" | "station" | "all";
  /** Whether a model is set up at all, so the AI switch can say so. */
  aiConfigured: boolean;
  /** Whether a UPI ID is set up, so the UPI switch can say so. */
  upiConfigured: boolean;
  theme: {
    features(): Theme["features"];
    /** Sets one feature through the Appearance override, auditing it. */
    setFeature(name: string, value: FlagValue, by: Session): void;
  };
  telemetry: Telemetry;
}

const AUDIT_SHOWN = 50;

export function registerAdmin(http: Hono<Env>, deps: AdminDeps): void {
  const { store } = deps;

  function defs(): FlagDef[] {
    return [...lookFlags(deps.theme.features()), ...OPS_FLAGS, ...SYSTEM_FLAGS];
  }
  const POWER_OF: Record<FlagDef["scope"], Power> = { look: "flags.look", ops: "flags.ops", system: "flags.system" };
  const power = (d: FlagDef): Power => POWER_OF[d.scope];

  function currentValue(d: FlagDef): FlagValue {
    if (d.scope !== "look") return deps.system.value(d.key);
    return (deps.theme.features() as unknown as Record<string, FlagValue>)[
      d.key.slice("features.".length)
    ] as FlagValue;
  }

  http.get("/api/flags", (c) => {
    const s = deps.requirePower(c, "hub");
    const mine = defs().filter((d) => can(s.role, power(d)));
    const keys = new Set(mine.map((d) => d.key));
    return c.json({
      flags: mine.map((d) => ({
        key: d.key,
        scope: d.scope,
        kind: d.kind,
        what: d.what,
        value: currentValue(d),
        ...(d.choices === undefined ? {} : { choices: d.choices }),
        ...(d.min === undefined ? {} : { min: d.min, max: d.max }),
        ...(d.key === "ai" && !deps.aiConfigured
          ? { note: "No model is set up (AI_BASE_URL and AI_MODEL), so it stays off." }
          : {}),
        ...(d.key === "ops.upi" && !deps.upiConfigured
          ? { note: "No UPI ID is set up (UPI_VPA), so it stays off." }
          : {}),
      })),
      // Each level reads the changes of the switches it holds, no others.
      audit: store
        .flagAudit(AUDIT_SHOWN * 4)
        .filter((a) => keys.has(a.key))
        .slice(0, AUDIT_SHOWN),
    });
  });

  http.put("/api/flags/:key", async (c) => {
    // Signed in first: the list of switches in the 404 below is not for strangers.
    deps.requirePower(c, "hub");
    const key = c.req.param("key") ?? "";
    const def = defs().find((d) => d.key === key);
    if (def === undefined) {
      throw new ApiError(
        404,
        "no_such_flag",
        `expected one of ${defs()
          .map((d) => d.key)
          .join(", ")}, found ${key}`,
      );
    }
    const s = deps.requirePower(c, power(def));
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    const value = checkFlag(def, input.object(raw).value);
    if (def.scope === "look") deps.theme.setFeature(key.slice("features.".length), value, s);
    else {
      const changed = store.setFlag({
        key,
        value,
        from: deps.system.value(key),
        by: s.user,
        level: s.role,
        at: deps.now(),
      });
      if (changed !== undefined) deps.system.set(key, value);
    }
    return c.json({ key, value: currentValue(def) });
  });

  http.get("/api/admin/health", (c) => {
    deps.requirePower(c, "telemetry");
    deps.telemetry.flush(true);
    const report = deps.telemetry.snapshot();
    return c.json({ ...report, verdict: verdict(report, report.databaseBytes) }, 200, { "cache-control": "no-store" });
  });

  /**
   * The links hub: every screen of this install that the signed-in level may open, grouped. Signed out it answers 200 with
   * the public links and no level, so the page can offer the sign-in choices beside them.
   */
  http.get("/api/hub", (c) => {
    // Built per request: the owner may add or delete every table section at run time (D-102).
    const all = hubLinks({
      stations: deps.config.stations,
      hasSpots: deps.zones().length > 0,
      hasRooms: deps.config.zones.some((z) => z.kind === "room"),
      ai: deps.aiConfigured,
    });
    const s = c.get("session");
    const access = s === undefined ? "all" : deps.accessOf(s);
    const links = linksFor(all, s?.role, access);
    return c.json({
      user: s?.user ?? null,
      level: s?.role ?? null,
      groups: grouped(links).map((g) => ({
        group: g.group,
        links: g.links.map(({ id, href, title, what }) => ({ id, href, title, what })),
      })),
    });
  });
}

export { FlagError };
