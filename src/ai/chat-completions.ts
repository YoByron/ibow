/**
 * The OpenAI-compatible Chat Completions adapter (`AI_ADAPTER=chat-completions`, the default): one
 * `POST {AI_BASE_URL}/chat/completions`. Hosted providers (OpenAI, Gemini's compatible endpoint, OpenRouter, Groq) and
 * local servers (Ollama, llama.cpp, LM Studio, vLLM) speak it, so one adapter covers both.
 */

import { type Adapter, AiError, type AiSettings, type ChatModel, readBounded, scrub } from "./model.ts";

interface Completion {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: unknown } | string;
}

/** The provider's own error message when it sent one, else the raw text. */
function providerMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as Completion;
    if (typeof body.error === "string") return body.error;
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not JSON: the start of the text says more than nothing.
  }
  return raw;
}

function create(s: AiSettings): ChatModel {
  const url = `${s.baseUrl}/chat/completions`;
  return {
    async complete(req) {
      const timeoutMs = req.timeoutMs ?? s.timeoutMs;
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (s.apiKey !== undefined) headers.authorization = `Bearer ${s.apiKey}`;
      let raw: string;
      let status: number;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: s.model,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            max_tokens: req.maxTokens,
            temperature: 0,
            stream: false,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        raw = await readBounded(res, s.origin);
      } catch (e) {
        if (e instanceof AiError) throw e;
        const name = (e as Error).name;
        const cause = ((e as Error).cause as { code?: unknown } | undefined)?.code;
        const fetchTimeout = cause === "UND_ERR_HEADERS_TIMEOUT" || cause === "UND_ERR_BODY_TIMEOUT";
        if (name === "TimeoutError" || name === "AbortError" || fetchTimeout) {
          throw new AiError("ai_timeout", `the AI model did not answer within ${timeoutMs / 1000} s (${s.origin})`);
        }
        throw new AiError(
          "ai_unreachable",
          `could not reach the AI model at ${s.origin}; check that it is running and the URL is right`,
        );
      }
      if (status < 200 || status > 299) {
        throw new AiError(
          "ai_refused",
          `the AI model at ${s.origin} answered ${status}: ${scrub(providerMessage(raw), s.apiKey)}`,
        );
      }
      let content: unknown;
      try {
        content = (JSON.parse(raw) as Completion).choices?.[0]?.message?.content;
      } catch {
        content = undefined;
      }
      if (typeof content !== "string" || content.trim() === "") {
        throw new AiError(
          "ai_bad_reply",
          `expected a chat completion with text from ${s.origin}, found: ${scrub(raw, s.apiKey, 80)}`,
        );
      }
      return content.trim();
    },
  };
}

export const chatCompletions: Adapter = { id: "chat-completions", create };
