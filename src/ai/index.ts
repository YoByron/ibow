/** The AI door's entry: every adapter ibow knows, and the model the environment configures (or none: AI off). */

import { chatCompletions } from "./chat-completions.ts";
import { type Adapter, aiSettings, type ChatModel } from "./model.ts";

/** A second provider's wire format is one more file exporting an `Adapter`, added to this list. */
export const ADAPTERS: readonly Adapter[] = [chatCompletions];

/** The configured model, or undefined when AI is off. Throws at boot on a bad or half-set configuration. */
export function openModel(env: Readonly<Record<string, string | undefined>>): ChatModel | undefined {
  const settings = aiSettings(env);
  if (settings === undefined) return undefined;
  const adapter = ADAPTERS.find((a) => a.id === settings.adapter);
  if (adapter === undefined) {
    throw new Error(
      `ibow: expected AI_ADAPTER to be one of ${ADAPTERS.map((a) => a.id).join(", ")}, found ${settings.adapter}`,
    );
  }
  return adapter.create(settings);
}
