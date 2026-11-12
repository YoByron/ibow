/** M7: the one door to a model. Off unless configured; a Chat Completions adapter over plain fetch; plain errors. */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ADAPTERS, openModel } from "../src/ai/index.ts";
import { AiError, aiSettings, scrub } from "../src/ai/model.ts";
import { chat, type FakeModel, startFakeModel } from "./support/fake-model.ts";

const KEY = "test-key-not-real-0123456789";
let fake: FakeModel;
beforeAll(async () => {
  fake = await startFakeModel();
});
afterAll(() => fake.close());

function model(extra: Record<string, string> = {}) {
  const m = openModel({ AI_BASE_URL: fake.baseUrl, AI_MODEL: "tiny-test-model", AI_API_KEY: KEY, ...extra });
  if (m === undefined) throw new Error("expected a model");
  return m;
}

async function failure(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    return e as AiError;
  }
  throw new Error("expected the call to fail");
}

describe("AI settings", () => {
  test("off by default: no setting, or only empty ones, means no model", () => {
    expect(aiSettings({})).toBeUndefined();
    expect(aiSettings({ AI_BASE_URL: "", AI_MODEL: "", AI_API_KEY: "" })).toBeUndefined();
    expect(openModel({})).toBeUndefined();
  });

  test("a local model needs no key; defaults are a 30 s timeout and the Chat Completions adapter", () => {
    expect(aiSettings({ AI_BASE_URL: "http://127.0.0.1:11434/v1/", AI_MODEL: "llama3.2" })).toEqual({
      adapter: "chat-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      origin: "http://127.0.0.1:11434",
      model: "llama3.2",
      timeoutMs: 30_000,
    });
  });

  test("a half-set configuration stops the boot and says what is missing", () => {
    expect(() => aiSettings({ AI_MODEL: "x" })).toThrow(/AI_BASE_URL/);
    expect(() => aiSettings({ AI_BASE_URL: "https://api.example.com/v1" })).toThrow(/AI_MODEL/);
    expect(() => aiSettings({ AI_API_KEY: KEY })).toThrow(/AI_BASE_URL/);
    expect(() => aiSettings({ AI_TIMEOUT_SECONDS: "60" })).toThrow(/AI_BASE_URL/);
    expect(() => aiSettings({ AI_ADAPTER: "chat-completions" })).toThrow(/AI_BASE_URL/);
    expect(() => aiSettings({ AI_BASE_URL: "ftp://x/v1", AI_MODEL: "m" })).toThrow(/http/);
    expect(() => aiSettings({ AI_BASE_URL: "not a url", AI_MODEL: "m" })).toThrow(/AI_BASE_URL/);
    expect(() => aiSettings({ AI_BASE_URL: "https://a.example/v1", AI_MODEL: "m", AI_TIMEOUT_SECONDS: "0" })).toThrow(
      /AI_TIMEOUT_SECONDS/,
    );
    expect(() => openModel({ AI_BASE_URL: "https://a.example/v1", AI_MODEL: "m", AI_ADAPTER: "nope" })).toThrow(
      /chat-completions/,
    );
  });

  test("the timeout stops below what Node's fetch itself waits for a reply's headers (300 s)", () => {
    expect(
      aiSettings({ AI_BASE_URL: "http://127.0.0.1:11434/v1", AI_MODEL: "m", AI_TIMEOUT_SECONDS: "290" })?.timeoutMs,
    ).toBe(290_000);
    expect(() =>
      aiSettings({ AI_BASE_URL: "http://127.0.0.1:11434/v1", AI_MODEL: "m", AI_TIMEOUT_SECONDS: "300" }),
    ).toThrow(/between 1 and 290/);
  });

  test("a key is never sent in clear text to another machine", () => {
    expect(() => aiSettings({ AI_BASE_URL: "http://models.example.com/v1", AI_MODEL: "m", AI_API_KEY: KEY })).toThrow(
      /https/,
    );
    expect(aiSettings({ AI_BASE_URL: "http://localhost:11434/v1", AI_MODEL: "m", AI_API_KEY: KEY })?.apiKey).toBe(KEY);
    expect(aiSettings({ AI_BASE_URL: "http://models.example.com/v1", AI_MODEL: "m" })?.apiKey).toBeUndefined();
  });

  test("a base URL with a user, password, query or fragment is refused, without echoing it", () => {
    for (const url of [
      "https://me:hunter2@models.example.com/v1",
      "https://models.example.com/v1?key=hunter2",
      "https://models.example.com/v1#hunter2",
      "not a url hunter2",
    ]) {
      let message = "";
      try {
        aiSettings({ AI_BASE_URL: url, AI_MODEL: "m" });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, url).toMatch(/AI_BASE_URL/);
      expect(message, url).not.toContain("hunter2");
    }
  });

  test("scrub removes the key as written, URL-encoded and in any case", () => {
    const key = "Sk/Abc+Def=123";
    const echoed = `bad key ${key}, ${encodeURIComponent(key)}, ${key.toLowerCase()}, ${key.toUpperCase()}`;
    const clean = scrub(echoed, key);
    for (const v of [key, encodeURIComponent(key), key.toLowerCase(), key.toUpperCase()])
      expect(clean).not.toContain(v);
    expect(clean).toBe("bad key [key], [key], [key], [key]");
  });

  test("the error messages never contain the key", () => {
    try {
      aiSettings({ AI_BASE_URL: "http://models.example.com/v1", AI_MODEL: "m", AI_API_KEY: KEY });
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
    }
  });

  test("every adapter has a distinct id", () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chat-completions");
  });
});

describe("the Chat Completions adapter", () => {
  test("posts one Chat Completions request with the model, bounded output and the key as a bearer token", async () => {
    fake.seen.length = 0;
    fake.reply = () => chat("  Ten orders [today.orders]  ");
    const text = await model().complete({ system: "Be brief.", user: "How many?", maxTokens: 300 });
    expect(text).toBe("Ten orders [today.orders]");
    expect(fake.seen).toHaveLength(1);
    const req = fake.seen[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/v1/chat/completions");
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req?.body).toEqual({
      model: "tiny-test-model",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "How many?" },
      ],
      max_tokens: 300,
      temperature: 0,
      stream: false,
    });
    expect(req?.raw).not.toContain(KEY);
  });

  test("without a key no authorization header is sent", async () => {
    fake.seen.length = 0;
    fake.reply = () => chat("ok");
    const m = openModel({ AI_BASE_URL: fake.baseUrl, AI_MODEL: "m" });
    await m?.complete({ system: "s", user: "u", maxTokens: 10 });
    expect(fake.seen[0]?.headers.authorization).toBeUndefined();
  });

  test("a refusal says the status and the provider's message, with the key scrubbed out", async () => {
    fake.reply = () => ({ status: 401, json: { error: { message: `Incorrect API key provided: ${KEY}` } } });
    const e = await failure(model().complete({ system: "s", user: "u", maxTokens: 10 }));
    expect(e.code).toBe("ai_refused");
    expect(e.message).toContain("401");
    expect(e.message).toContain("Incorrect API key");
    expect(e.message).not.toContain(KEY);
  });

  test("a slow model times out with a plain message", async () => {
    fake.reply = () => ({ ...chat("late"), delayMs: 3000 });
    const m = model();
    const e = await failure(m.complete({ system: "s", user: "u", maxTokens: 10, timeoutMs: 200 }));
    expect(e.code).toBe("ai_timeout");
    expect(e.message).toMatch(/did not answer within/);
  });

  test("fetch's own header or body timeout is reported as a timeout too", async () => {
    for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      vi.stubGlobal("fetch", () =>
        Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("t"), { code }) })),
      );
      try {
        expect((await failure(model().complete({ system: "s", user: "u", maxTokens: 10 }))).code).toBe("ai_timeout");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  test("an unreachable server is reported as such", async () => {
    const m = openModel({ AI_BASE_URL: "http://127.0.0.1:9/v1", AI_MODEL: "m" });
    const e = await failure(m?.complete({ system: "s", user: "u", maxTokens: 10 }) as Promise<string>);
    expect(e.code).toBe("ai_unreachable");
    expect(e.message).toContain("http://127.0.0.1:9;");
    expect(e.message).not.toContain("/v1");
  });

  test("a reply that isn't a chat completion, or is too long, is refused", async () => {
    fake.reply = () => ({ raw: "<html>gateway</html>" });
    expect((await failure(model().complete({ system: "s", user: "u", maxTokens: 10 }))).code).toBe("ai_bad_reply");
    fake.reply = () => ({ json: { choices: [] } });
    expect((await failure(model().complete({ system: "s", user: "u", maxTokens: 10 }))).code).toBe("ai_bad_reply");
    fake.reply = () => chat("x".repeat(70_000));
    const e = await failure(model().complete({ system: "s", user: "u", maxTokens: 10 }));
    expect(e.code).toBe("ai_bad_reply");
    expect(e.message).toMatch(/KB/);
  });
});
