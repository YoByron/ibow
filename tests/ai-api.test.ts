/**
 * M7 checkpoint, the server half: `POST /api/owner/ask` exists only with AI on, takes the owner alone, is rate limited
 * per session, sends the model anonymous figures only, and never lets the key out (replies, errors, logs, event log).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { openModel } from "../src/ai/index.ts";
import type { ChatModel } from "../src/ai/model.ts";
import { type App, createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import { analystRequest, chat, type FakeModel, startFakeModel } from "./support/fake-model.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const KEY = "test-key-not-real-abcdefghijklmnop";
const OWNER_PIN = "908172";
const STAFF_PIN = "4321";
// 17:30 on 26 November in the tea house's zone.
const now = Date.UTC(2026, 10, 26, 12, 0);
let ownerPinHash = "";
let fake: FakeModel;
let model: ChatModel;
let store: Store | undefined;
let app: App;

beforeAll(async () => {
  ownerPinHash = await hashPin(OWNER_PIN, TEST_PIN_COST);
  fake = await startFakeModel();
  model = openModel({ AI_BASE_URL: fake.baseUrl, AI_MODEL: "fake", AI_API_KEY: KEY }) as ChatModel;
});
afterAll(() => fake.close());
afterEach(() => {
  store?.close();
  store = undefined;
  fake.seen.length = 0;
  fake.reply = () => chat("ok");
  vi.restoreAllMocks();
});

function boot(ai: ChatModel | undefined, ask?: { max: number; windowMs: number }): void {
  store = openStore(":memory:");
  app = createApp({
    config,
    store,
    ownerPinHash,
    now: () => now,
    ...(ai === undefined ? {} : { ai }),
    ...(ask === undefined ? {} : { limits: { ask } }),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
type Reply = { status: number; body: any; raw: string; cookie?: string };

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["x-order-key"] = opts.key;
  const res = await app.http.request(path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const raw = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const reply: Reply = { status: res.status, body, raw };
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) reply.cookie = setCookie.split(";")[0] as string;
  return reply;
}

async function login(user: string, pin: string): Promise<string> {
  const r = await call("POST", "/api/login", { body: { user, pin } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.cookie as string;
}

const askBody = (question: string) => ({ body: { question } });

describe("with AI off", () => {
  test("there is no ask route, even for the owner, and the rest is as before", async () => {
    boot(undefined);
    const owner = await login("owner", OWNER_PIN);
    const r = await call("POST", "/api/owner/ask", { ...askBody("How many orders?"), cookie: owner });
    expect(r.status).toBe(404);
    expect((await call("GET", "/api/owner/insights", { cookie: owner })).status).toBe(200);
    expect(fake.seen).toHaveLength(0);
  });
});

describe("with AI on", () => {
  test("only the owner may ask: no session 401, staff 403", async () => {
    boot(model);
    expect((await call("POST", "/api/owner/ask", askBody("How many orders?"))).status).toBe(401);
    const owner = await login("owner", OWNER_PIN);
    expect(
      (await call("PUT", "/api/staff/c1", { body: { name: "Counter", pin: STAFF_PIN }, cookie: owner })).status,
    ).toBe(200);
    const staff = await login("c1", STAFF_PIN);
    expect((await call("POST", "/api/owner/ask", { ...askBody("How many orders?"), cookie: staff })).status).toBe(403);
    expect(fake.seen).toHaveLength(0);
  });

  test("a question must be 1 to 500 characters of text", async () => {
    boot(model);
    const owner = await login("owner", OWNER_PIN);
    for (const question of ["", "   ", "x".repeat(501), 42]) {
      const r = await call("POST", "/api/owner/ask", { body: { question }, cookie: owner });
      expect(r.status, JSON.stringify(question)).toBe(400);
      expect(r.body.error).toBe("bad_input");
    }
    expect(fake.seen).toHaveLength(0);
  });

  test("the owner gets the answer with the figures it cited", async () => {
    boot(model);
    const owner = await login("owner", OWNER_PIN);
    await call("POST", "/api/orders", {
      body: { clientKey: "ai-api-key-0001-abcdef", lines: [{ itemId: "masala-soda", qty: 3 }] },
    });
    fake.reply = (req) => {
      const f = analystRequest(req).figures.find((x) => x.key === "today.orders");
      return chat(`You have ${f?.value} order so far today [today.orders].`);
    };
    const r = await call("POST", "/api/owner/ask", { ...askBody("How many orders today?"), cookie: owner });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.answer.text).toBe("You have 1 order so far today [today.orders].");
    expect(r.body.answer.figures).toEqual([
      { key: "today.orders", label: "Orders placed today", value: "1", unit: "orders", date: "2026-11-26" },
    ]);
    expect(r.body.answer.grounded).toBe(true);
    expect(r.body.answer.unverified).toEqual([]);
  });

  test("the model gets anonymous counts only: no customer name, review text, token or order id", async () => {
    boot(model);
    const owner = await login("owner", OWNER_PIN);
    const placed = await call("POST", "/api/orders", {
      body: {
        clientKey: "ai-api-key-0002-abcdef",
        lines: [{ itemId: "masala-soda", qty: 1 }],
        customerName: "Zenobia Quillfeather",
      },
    });
    const { id } = placed.body.order;
    const token = placed.body.order.token as string;
    await call("POST", `/api/orders/${id}/confirm`, { body: { method: "cash", amountMinor: 3000 }, cookie: owner });
    await call("POST", `/api/orders/${id}/advance`, { cookie: owner });
    await call("POST", `/api/orders/${id}/advance`, { cookie: owner });
    const review = await call("POST", `/api/orders/${id}/review`, {
      body: { rating: 5, text: "Velvety cardamom marvel" },
      key: placed.body.key,
    });
    expect(review.status, review.raw).toBe(201);
    expect((await call("POST", "/api/owner/ask", { ...askBody("Who ordered?"), cookie: owner })).status).toBe(200);
    const sent = fake.seen[0]?.raw ?? "";
    expect(sent).toContain("today.orders");
    for (const secret of ["Zenobia", "Quillfeather", "Velvety", "cardamom marvel", id, token, placed.body.key]) {
      expect(sent).not.toContain(secret);
    }
  });

  test("the key never reaches a reply, an error, the console or the event log", async () => {
    boot(model);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const owner = await login("owner", OWNER_PIN);
    const events = store?.lastEventId();
    const ok = await call("POST", "/api/owner/ask", { ...askBody("Anything?"), cookie: owner });
    expect(ok.status).toBe(200);
    expect(fake.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    fake.reply = () => ({ status: 401, json: { error: { message: `Incorrect API key provided: ${KEY}` } } });
    const refused = await call("POST", "/api/owner/ask", { ...askBody("Anything?"), cookie: owner });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe("ai_refused");
    expect(refused.body.message).toMatch(/answered 401/);
    for (const r of [ok, refused]) expect(r.raw).not.toContain(KEY);
    const printed = [...log.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
    expect(printed).not.toContain(KEY);
    // Asking writes nothing to the event log.
    expect(store?.lastEventId()).toBe(events);
  });

  test("a slow or missing model is a plain 502 for the owner", async () => {
    boot(openModel({ AI_BASE_URL: "http://127.0.0.1:9/v1", AI_MODEL: "m" }));
    const owner = await login("owner", OWNER_PIN);
    const r = await call("POST", "/api/owner/ask", { ...askBody("Anything?"), cookie: owner });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("ai_unreachable");
    expect(r.body.message).toMatch(/could not reach the AI model/);
  });

  test("questions are rate limited per session", async () => {
    boot(model, { max: 2, windowMs: 60_000 });
    const first = await login("owner", OWNER_PIN);
    for (let i = 0; i < 2; i++) {
      expect((await call("POST", "/api/owner/ask", { ...askBody("Q?"), cookie: first })).status).toBe(200);
    }
    const over = await call("POST", "/api/owner/ask", { ...askBody("Q?"), cookie: first });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("rate_limited");
    expect(fake.seen).toHaveLength(2);
    const second = await login("owner", OWNER_PIN);
    expect((await call("POST", "/api/owner/ask", { ...askBody("Q?"), cookie: second })).status).toBe(200);
  });
});
