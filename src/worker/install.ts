/**
 * The Durable Object that is one install (D-030): the single writer for one business, its SQLite storage, the Hono API
 * with its SSE streams, rate limits and sessions in memory, retention on an alarm. The Worker (`index.ts`) forwards
 * `/api/*` here and nothing else, so this object is reachable only through it.
 */

import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { openModel } from "../ai/index.ts";
import { localTime } from "../core/insights.ts";
import { demoMode } from "../demo/mode.ts";
import { DEMO_VPA, type DemoPins, newDemoPins } from "../demo/pins.ts";
import { seedDemo, topUpDemo } from "../demo/seed.ts";
import { type App, createApp } from "../server/app.ts";
import { assertHash, hashPin, pinDerivations } from "../server/auth.ts";
import { EVENT_WINDOW_MS } from "../server/retention.ts";
import { createStore, type Store } from "../store/store.ts";
import { config, demoBundle, looks, rush } from "./config.ts";
import { type DoDriver, doDriver } from "./do-sql.ts";
import { type Bindings, strings } from "./env.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** Header the Worker sets from `cf-connecting-ip`, for rate limits; the Worker removes any the client sent. */
export const CLIENT_IP_HEADER = "x-ibow-ip";

interface Running {
  app: App;
  store: Store;
  driver: DoDriver;
}

/**
 * The demo's seed, one step per invocation so none goes over a free-plan request's 10 ms of CPU: three PIN hashes (one
 * derivation each), then one day of orders each, oldest first. Three days at a fifth of the sample's rush is about 200
 * orders (D-039).
 */
const DEMO_PAST_DAYS = 2;
const DEMO_SCALE = 0.22;
const SEED_STEPS = [
  "pin:counter",
  "pin:station",
  "pin:owner",
  "pin:manager",
  "pin:admin",
  ...Array.from({ length: DEMO_PAST_DAYS + 1 }, (_, i) => `day:${DEMO_PAST_DAYS - i}`),
];

export class Install extends DurableObject<Bindings> {
  #running: Running | undefined;
  #failure: Error | undefined;
  #store: Store | undefined;
  #driver: DoDriver | undefined;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.#running = await this.#start();
      } catch (e) {
        this.#failure = e as Error;
        console.error(`ibow: install did not start: ${this.#failure.message}`);
      }
    });
  }

  /** The seed step to run next (an index into SEED_STEPS), or SEED_STEPS.length when done. */
  #stage(): number {
    return (this.ctx.storage.kv.get("seed_stage") as number | undefined) ?? SEED_STEPS.length;
  }

  async #start(): Promise<Running | undefined> {
    // The same driver and store across the seed's steps and the start after them, so the row counts add up.
    const driver = this.#driver ?? doDriver(this.ctx.storage);
    const store = this.#store ?? createStore(driver);
    this.#driver = driver;
    this.#store = store;
    const mode = demoMode(this.env.DEMO, store.isDemo(), store.isEmpty(), demoBundle);
    const kv = this.ctx.storage.kv;
    if (mode === "seed") {
      store.markDemo();
      kv.put("demo_pins", newDemoPins());
      kv.put("seed_stage", 0);
    }
    if (mode !== "real" && this.#stage() < SEED_STEPS.length) {
      await this.ctx.storage.setAlarm(Date.now());
      return undefined; // preparing: requests answer 503 until the last step has run
    }
    let ownerPinHash: string;
    let adminPinHash: string | undefined;
    let demo: { pins: DemoPins } | undefined;
    if (mode === "real") {
      const hash = this.env.OWNER_PIN_HASH;
      if (!hash) {
        throw new Error(
          "ibow: expected the secret OWNER_PIN_HASH, found none; run: npx wrangler secret put OWNER_PIN_HASH",
        );
      }
      ownerPinHash = hash;
      adminPinHash = this.env.ADMIN_PIN_HASH?.trim() || undefined;
    } else {
      demo = { pins: kv.get("demo_pins") as DemoPins };
      ownerPinHash = kv.get("demo_owner_pin_hash") as string;
      adminPinHash = kv.get("demo_admin_pin_hash") as string;
    }
    if (adminPinHash !== undefined) assertHash(adminPinHash, { legacy: false });
    assertHash(ownerPinHash, { legacy: false }); // throws now, at boot, if the hash is malformed or an old scrypt one
    const vpa = mode === "real" ? this.env.UPI_VPA?.trim() : config.business.currency === "INR" ? DEMO_VPA : undefined;
    const payments = vpa ? { upi: { vpa, payeeName: this.env.UPI_PAYEE_NAME?.trim() || config.business.name } } : {};
    // A demo is public, so it never spends the owner's model key: AI_* is ignored there (D-040).
    const ai = mode === "real" ? openModel(strings(this.env)) : undefined;
    const app = createApp({
      config,
      look: looks,
      store,
      ownerPinHash,
      ...(adminPinHash === undefined ? {} : { adminPinHash }),
      ...(mode === "real" && this.env.RENAME_ADMIN_STAFF ? { renameAdminStaff: this.env.RENAME_ADMIN_STAFF } : {}),
      payments,
      clientIp: (c) => c.req.header(CLIENT_IP_HEADER) ?? "unknown",
      ...(demo ? { demo } : {}),
      ...(ai ? { ai } : {}),
    });
    this.#retain(store, Date.now(), app.retentionDays());
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
    return { app, store, driver: driver as DoDriver };
  }

  /** One step of the demo seed; returns whether more remain. */
  async #seedStep(): Promise<boolean> {
    const store = this.#store as Store;
    const kv = this.ctx.storage.kv;
    const stage = this.#stage();
    const step = SEED_STEPS[stage] as string;
    const pins = kv.get("demo_pins") as DemoPins;
    if (step === "pin:counter") {
      store.putStaff({ id: "counter", name: "Counter (demo)", pinHash: await hashPin(pins.counter), role: "counter" });
    } else if (step === "pin:station") {
      store.putStaff({ id: "station", name: "Stations (demo)", pinHash: await hashPin(pins.station), role: "station" });
    } else if (step === "pin:owner") {
      kv.put("demo_owner_pin_hash", await hashPin(pins.owner));
    } else if (step === "pin:manager") {
      store.putStaff({ id: "manager", name: "Manager (demo)", pinHash: await hashPin(pins.manager), role: "manager" });
    } else if (step === "pin:admin") {
      kv.put("demo_admin_pin_hash", await hashPin(pins.admin));
    } else {
      const upi = config.business.currency === "INR";
      seedDemo(store, {
        config,
        rush,
        now: Date.now(),
        upi,
        pastDays: DEMO_PAST_DAYS,
        scale: DEMO_SCALE,
        only: Number(step.slice(4)),
      });
    }
    kv.put("seed_stage", stage + 1);
    return stage + 1 < SEED_STEPS.length;
  }

  /** Customer names and review text are cleared after retentionDays: at boot and on every alarm (D-016, D-033). */
  #retain(store: Store, now: number, days: number) {
    const result = store.forgetCustomers(now - days * DAY_MS);
    store.pruneEvents(now - EVENT_WINDOW_MS);
    return result;
  }

  async alarm(): Promise<void> {
    // Finished days are totalled one per alarm step; while some remain the next step follows at once (D-044).
    if (this.#running && this.#store) {
      const today = localTime(Date.now(), config.business.timeZone).day;
      if (this.#store.closeNextDay(today, config.business.timeZone) !== undefined) {
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }
    }
    if (!this.#running && this.#store && this.#stage() < SEED_STEPS.length) {
      const more = await this.#seedStep();
      if (more) await this.ctx.storage.setAlarm(Date.now());
      else {
        this.#running = await this.#start();
      }
      return;
    }
    if (this.#running) {
      this.#retain(this.#running.store, Date.now(), this.#running.app.retentionDays());
      // A demo keeps its day going: the orders a fresh seed would have placed since the last hour (D-086).
      if (this.#running.store.isDemo() && demoBundle) {
        const upi = config.business.currency === "INR";
        topUpDemo(this.#running.store, { config, rush, now: Date.now(), upi, scale: DEMO_SCALE });
      }
      // The counts of the last half minute reach the install's own row before the object may be evicted (D-076).
      this.#running.app.flushTelemetry();
    }
    await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#failure && !this.#running) {
      return Response.json(
        { error: "preparing", message: "ibow: the demo is being prepared; try again in a few seconds" },
        { status: 503, headers: { "retry-after": "3" } },
      );
    }
    if (this.#failure || !this.#running) {
      return Response.json(
        { error: "misconfigured", message: this.#failure?.message ?? "ibow: the install has not started" },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    // Internal paths, for tests and diagnostics: the Worker forwards only /api/*, so no client can reach these.
    if (url.pathname === "/__stats") {
      return Response.json({
        rowsWritten: this.#running.driver.rowsWritten(),
        rowsRead: this.#running.driver.rowsRead(),
        pinDerivations: pinDerivations(),
        databaseSize: this.ctx.storage.sql.databaseSize,
        alarm: await this.ctx.storage.getAlarm(),
      });
    }
    // The header colour of the look in force, for the Worker's manifest (the owner's Appearance lives in this object).
    if (url.pathname === "/__header-color") return new Response(this.#running.app.headerColor());
    if (url.pathname === "/__retention") {
      const now = Number(url.searchParams.get("now") ?? Date.now());
      return Response.json(this.#retain(this.#running.store, now, this.#running.app.retentionDays()));
    }
    // Whether `/showcase` is on now (the admin's switch), for the Worker, which serves that page from its assets.
    if (url.pathname === "/__showcase") return new Response(this.#running.app.showcaseOn() ? "1" : "0");
    return this.#running.app.http.fetch(request);
  }
}
