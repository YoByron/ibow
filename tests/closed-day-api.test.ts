import { afterEach, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { sampleRaw } from "./support/samples.ts";

const raw = sampleRaw("garden-cafe");
let store: Store;
let hash = "";
beforeAll(async () => {
  hash = await hashPin("908172", TEST_PIN_COST);
});
afterEach(() => store.close());

function app(hours: Record<string, unknown>, now: number) {
  store = openStore(":memory:");
  const config = loadConfig({ ...raw, business: { ...(raw.business as object), hours } });
  return createApp({ config, store, ownerPinHash: hash, now: () => now }).http;
}

const order = (http: ReturnType<typeof app>) =>
  http.request("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey: "closed-day-client-key-abc", lines: [{ itemId: "espresso", qty: 1 }] }),
  });

test("on a closed day the 409 names the day and the next open day, never an undefined last-order time", async () => {
  // Wednesday 2 December 2026, 11:00 in Lisbon; shut on Wednesdays and Thursdays, no last-order time.
  const http = app({ open: "09:00", close: "19:00", closedDays: ["wed", "thu"] }, Date.UTC(2026, 11, 2, 11, 0));
  const r = await order(http);
  expect(r.status).toBe(409);
  const body = (await r.json()) as { error: string; message: string };
  expect(body.error).toBe("closed");
  expect(body.message).not.toContain("undefined");
  expect(body.message).toContain("Wednesday");
  expect(body.message).toContain("Friday at 09:00");
});

test("past the last-order time the message is the last-order one", async () => {
  const http = app({ open: "09:00", close: "19:00", lastOrder: "18:30" }, Date.UTC(2026, 11, 2, 18, 45));
  const body = (await (await order(http)).json()) as { message: string };
  expect(body.message).toContain("last-order time 18:30");
  expect(body.message).toContain("we open at 09:00");
});
