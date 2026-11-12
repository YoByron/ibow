/**
 * A stand-in for a server speaking the Chat Completions API, on loopback with a free port, for the AI tests: no
 * network, no real key, the same reply every time. It records every request so a test can read what reached "the
 * model", and `reply` decides what it answers.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The raw body as it arrived, for searching. */
  raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: the parsed request body is arbitrary JSON
  body: any;
}

export interface FakeReply {
  status?: number;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is, in place of `json`. */
  raw?: string;
  /** Waits this long before answering. */
  delayMs?: number;
}

export interface FakeModel {
  /** The base URL to put in `AI_BASE_URL`, ending in `/v1`. */
  baseUrl: string;
  seen: SeenRequest[];
  reply: (req: SeenRequest) => FakeReply;
  close(): Promise<void>;
}

/** A Chat Completions reply whose one choice says `content`. */
export function chat(content: string): FakeReply {
  return {
    json: { id: "fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content } }] },
  };
}

/** The question and the figures of an analyst request, read back out of its user message. */
export function analystRequest(req: SeenRequest): {
  question: string;
  figures: { key: string; label: string; value: string }[];
} {
  const user = (req.body.messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
  const question = /Question: ([^\n]*)/.exec(user)?.[1] ?? "";
  const block = /Figures \(key \| meaning \| value\):\n([\s\S]*?)\n\nQuestion:/.exec(user)?.[1] ?? "";
  const figures = block
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [key = "", label = "", value = ""] = l.split(" | ");
      return { key, label, value };
    });
  return { question, figures };
}

export async function startFakeModel(reply: FakeModel["reply"] = () => chat("ok")): Promise<FakeModel> {
  const fake: Omit<FakeModel, "baseUrl" | "close"> = { seen: [], reply };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const seen: SeenRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, raw, body };
      fake.seen.push(seen);
      const r = fake.reply(seen);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(r.raw ?? JSON.stringify(r.json ?? {}));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as FakeModel;
}
