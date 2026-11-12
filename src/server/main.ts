/** Boots one install: reads `.env` settings and the three config files, opens the store, serves HTTP. */

import { mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openModel } from "../ai/index.ts";
import { aiSettings } from "../ai/model.ts";
import { loadConfig } from "../core/config.ts";
import { DEMO_NOW_ENV, serverClock } from "../demo/clock.ts";
import { demoPinsFrom } from "../demo/pins.ts";
import { openStore } from "../store/node.ts";
import { createApp } from "./app.ts";
import { assertHash } from "./auth.ts";
import { loadLook } from "./look.ts";
import { startRetention } from "./retention.ts";
import { loadClient } from "./static.ts";

const MAX_CONNECTIONS = 1000;

function setting(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`ibow: expected ${name} in the environment or .env, found nothing; see .env.example`);
}

const configDir = resolve(setting("CONFIG_DIR", "./config"));
function readConfig(file: string): unknown {
  const path = join(configDir, file);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`ibow: expected a JSON file at ${path}, found: ${(e as Error).message}`);
  }
}

const config = loadConfig({
  business: readConfig("business.json"),
  catalog: readConfig("catalog.json"),
  stations: readConfig("stations.json"),
});
const look = loadLook(configDir, config.catalog);
const ownerPinHash = setting("OWNER_PIN_HASH");
assertHash(ownerPinHash, { legacy: true }); // throws now, at boot, if the hash is malformed
const port = Number(setting("PORT", "3000"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`ibow: expected PORT between 1 and 65535, found ${process.env.PORT}`);
}
const dataDir = resolve(setting("DATA_DIR", "./data"));
mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, "ibow.db"));
// Only a demo database may fix the clock (for screenshots, D-054); a real install ignores the setting and says so.
const demoPins = demoPinsFrom(process.env, store.isDemo());
const clock = serverClock(process.env, store.isDemo());
if (clock.ignored) console.warn(`ibow: ignoring ${DEMO_NOW_ENV}: this is not a demo database`);
// Customer names and review text are cleared after retentionDays: now, then every hour.
startRetention({ store, days: config.business.retentionDays, now: clock.now, timeZone: config.business.timeZone });
const trustProxy = Number(setting("TRUST_PROXY", "0"));
if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
  throw new Error(
    `ibow: expected TRUST_PROXY to be the number of proxies in front (0 to 10), found ${process.env.TRUST_PROXY}`,
  );
}
const vpa = process.env.UPI_VPA?.trim();
const payments = vpa ? { upi: { vpa, payeeName: setting("UPI_PAYEE_NAME", config.business.name) } } : {};
const client = loadClient(fileURLToPath(new URL("../../dist/client/", import.meta.url)));
// The AI analyst is off unless AI_BASE_URL and AI_MODEL are set (D-026); the key stays in this process.
const ai = openModel(process.env);
const app = createApp({
  config,
  store,
  ownerPinHash,
  trustProxy,
  payments,
  client,
  look,
  now: clock.now,
  ...(demoPins ? { demo: { pins: demoPins } } : {}),
  ...(ai ? { ai } : {}),
});

// Loopback by default; HOST=0.0.0.0 opens it to the LAN (phones on the shop's Wi-Fi) or, on a VPS, to a proxy.
const hostname = setting("HOST", "127.0.0.1");
const server = serve({ fetch: app.http.fetch, port, hostname }, (info) => {
  console.log(
    `ibow: ${config.business.name} listening on ${hostname} port ${info.port} (config ${configDir}, data ${dataDir})`,
  );
}) as Server;
const aiOn = aiSettings(process.env);
if (aiOn !== undefined) console.log(`ibow: AI analyst on: model ${aiOn.model} at ${aiOn.origin}`);
// One business per install: far more than a rush needs, and a ceiling on open sockets (each SSE stream holds one).
server.maxConnections = MAX_CONNECTIONS;
