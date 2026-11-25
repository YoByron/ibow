/**
 * The one door to a model (Principle 2, D-026): the adapter interface every provider implements, the settings that
 * turn the AI analyst on, and the error the owner sees when a model call fails. Off unless the owner configures it;
 * nothing else in ibow needs it. No vendor SDK: an adapter speaks HTTP with `fetch`.
 */

/** One question to a model: a system prompt and one user message, answered with text. */
export interface ChatRequest {
  system: string;
  user: string;
  /** Pictures that go with the user message, as `data:image/...;base64,` URLs (a photographed menu page). */
  images?: readonly string[];
  /** The most tokens the model may write. */
  maxTokens: number;
  /** Overrides the configured timeout for this call. */
  timeoutMs?: number;
}

export interface ChatModel {
  /** The model's reply, trimmed. Throws `AiError` on any failure. */
  complete(req: ChatRequest): Promise<string>;
}

/** A provider's wire format. A new one is one file exporting an `Adapter`, listed in `ADAPTERS` (`src/ai/index.ts`). */
export interface Adapter {
  /** The value of `AI_ADAPTER` that picks it. */
  id: string;
  create(settings: AiSettings): ChatModel;
}

export interface AiSettings {
  adapter: string;
  /** No trailing slash. Used for requests only. */
  baseUrl: string;
  /** Scheme, host and port: all that logs and error messages show of the URL. */
  origin: string;
  model: string;
  /** Absent for a local model that needs none. Never logged, never sent to a client, never stored. */
  apiKey?: string;
  timeoutMs: number;
}

export type AiErrorCode = "ai_timeout" | "ai_unreachable" | "ai_refused" | "ai_bad_reply";

/** A model call that failed, in words the owner can act on. The message never holds the key. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AiError";
    this.code = code;
  }
}

export const DEFAULT_ADAPTER = "chat-completions";
const DEFAULT_TIMEOUT_S = 30;
/**
 * Node's fetch (undici) gives up by itself after 300 s without a reply's headers, or between body chunks, whatever
 * the signal says; the timeout stays below that so it is always ours that fires, with our message.
 */
const MAX_TIMEOUT_S = 290;
/** The most of a reply an adapter reads; a chat answer of a few sentences is far smaller. */
export const MAX_REPLY_BYTES = 64 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Env = Readonly<Record<string, string | undefined>>;

function setting(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The AI settings from the environment, or undefined when AI is off (every `AI_*` setting empty). A half-set
 * configuration throws at boot, saying what is missing. A key is refused over plain HTTP to another machine.
 */
export function aiSettings(env: Env): AiSettings | undefined {
  const baseUrl = setting(env, "AI_BASE_URL");
  const model = setting(env, "AI_MODEL");
  const apiKey = setting(env, "AI_API_KEY");
  const adapter = setting(env, "AI_ADAPTER");
  const timeout = setting(env, "AI_TIMEOUT_SECONDS");
  // Any AI_ setting at all means the owner meant AI on: a half-set one stops the boot rather than leaving AI off.
  if ([baseUrl, model, apiKey, adapter, timeout].every((v) => v === undefined)) return undefined;
  if (baseUrl === undefined) {
    throw new Error("ibow: AI settings found but no AI_BASE_URL; set it (and AI_MODEL) or unset every AI_ setting");
  }
  if (model === undefined) throw new Error("ibow: AI_BASE_URL is set but AI_MODEL is empty; name the model to use");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("ibow: expected AI_BASE_URL to be a URL like https://host/v1, found something that doesn't parse");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(
      "ibow: expected AI_BASE_URL without a user name, password, query or fragment (a key goes in AI_API_KEY), found one",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`ibow: expected AI_BASE_URL to start with https:// or http://, found ${url.protocol}`);
  }
  if (apiKey !== undefined && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new Error(
      `ibow: AI_API_KEY would travel in clear text to ${url.hostname}; use an https:// AI_BASE_URL, or a local model on this machine`,
    );
  }
  const seconds = timeout === undefined ? DEFAULT_TIMEOUT_S : Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S) {
    throw new Error(
      `ibow: expected AI_TIMEOUT_SECONDS between 1 and ${MAX_TIMEOUT_S} (Node's fetch stops waiting at 300), found ${timeout}`,
    );
  }
  return {
    adapter: adapter ?? DEFAULT_ADAPTER,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    origin: url.origin,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    timeoutMs: seconds * 1000,
  };
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with the key cut out, as written, URL-encoded and in any case, and at most `max` characters: for a
 * provider's message shown to the owner.
 */
export function scrub(text: string, key: string | undefined, max = 200): string {
  let clean = text;
  if (key) {
    const forms = [...new Set([key, encodeURIComponent(key), encodeURI(key)])].sort((a, b) => b.length - a.length);
    clean = clean.replace(new RegExp(forms.map(literal).join("|"), "gi"), "[key]");
  }
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** The body of `res` as text, refusing more than `MAX_REPLY_BYTES`. */
export async function readBounded(res: Response, where: string): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel();
      throw new AiError("ai_bad_reply", `the reply from ${where} was longer than ${MAX_REPLY_BYTES / 1024} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
