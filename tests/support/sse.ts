/** A minimal SSE reader for tests: parses `id:` and `data:` fields from a fetch response body. */

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export interface SseStream {
  status: number;
  messages: SseMessage[];
  /** Resolves once `predicate` holds over the messages so far; rejects after `timeoutMs`. */
  until(predicate: (messages: SseMessage[]) => boolean, timeoutMs?: number): Promise<SseMessage[]>;
  close(): Promise<void>;
  /** Resolves when the server ends the stream (or close() cancels it). */
  ended: Promise<void>;
}

export async function openSse(response: Response | Promise<Response>): Promise<SseStream> {
  const res = await response;
  const messages: SseMessage[] = [];
  const waiters = new Set<() => void>();
  const reader = res.body?.getReader();
  let closed = false;
  let ended: Promise<void> = Promise.resolve();

  if (reader && res.ok) {
    ended = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end = buffer.indexOf("\n\n");
          while (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const msg: SseMessage = { data: "" };
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("id:")) msg.id = line.slice(3).trim();
              else if (line.startsWith("event:")) msg.event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (data.length > 0) {
              msg.data = data.join("\n");
              messages.push(msg);
              for (const w of waiters) w();
            }
            end = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // cancelled by close()
      }
    })();
  }

  return {
    ended,
    status: res.status,
    messages,
    until(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (predicate(messages)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(messages);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`SSE: expected the condition within ${timeoutMs} ms, found ${messages.length} messages`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await reader?.cancel().catch(() => undefined);
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary JSON
export function parsed(messages: SseMessage[]): any[] {
  return messages.map((m) => JSON.parse(m.data));
}
