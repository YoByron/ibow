/**
 * The menu reader (M15, D-092): the judging part of a menu import. The model reads one page or piece of a menu, as a
 * picture or as text, and writes what it sees as JSON in one fixed shape. Everything after that (checking the JSON,
 * ids, minor units, merging, extras, the catalog) is code in `src/import`. A menu holds nothing personal; the file's
 * path is never sent.
 */

import { AiError, type ChatModel } from "./model.ts";

/** The most tokens a reply may hold: a page of 60 items is about 3,000 tokens of this JSON. */
export const MENU_MAX_TOKENS = 8192;

/** Tags the importer knows, offered to the model; any other a reply holds is kept and flagged for a person. */
export const KNOWN_TAGS = [
  "vegan",
  "vegetarian",
  "gluten-free",
  "dairy-free",
  "contains-nuts",
  "spicy",
  "halal",
  "sugar-free",
  "hot",
  "cold",
] as const;

export const MENU_SYSTEM = `You read a menu so it can become a point-of-sale catalog. Reply with one JSON object and nothing else, in this shape:
{"sections":[{"name":"Coffee","items":[{"name":"Flat white","price":null,"sizes":[{"size":"Regular","price":3.5},{"size":"Large","price":4.2}],"description":"Double shot, steamed milk.","tags":["vegan"],"diet":"veg","addons":["Syrups"],"unsure":false}]}],"addons":[{"name":"Milk","min":0,"max":1,"sections":["Coffee"],"options":[{"name":"Oat milk","price":0.5}]}]}
Rules:
- Copy section and item names as printed, in the menu's own language and spelling. Sections in the order printed; a section that continues from an earlier page keeps its printed name.
- price: a JSON number in the menu's main currency unit exactly as printed (3.50 is 3.5; 1,200 is 1200). null when no price is printed. Never guess a price or convert a currency.
- sizes: only when an item has more than one price (sizes, portions, half and full); then price is null.
- description: the printed description, at most one short sentence. Leave it out when none is printed; never invent one.
- tags: only from ${KNOWN_TAGS.join(", ")}, and only when the menu marks the item so (a word or a symbol with a key).
- diet: "veg", "non-veg" or "egg" only when the menu marks it (such as a green or red dot); otherwise leave it out.
- addons: groups of extras a customer adds to an item (milks, an extra shot, toppings), each option with its price (0 when free). sections: the names of the sections the group is offered on. An item's own "addons" lists the groups offered only on it, by name.
- unsure: true when you could not read the item's name or price clearly.
- A page without a menu: {"sections":[]}.`;

/** One page or piece of a menu, as the model is shown it. */
export interface MenuPiece {
  /** "part 2 of 3" or "one page". */
  label: string;
  text?: string;
  /** A `data:image/...;base64,` URL. */
  image?: string;
}

/** Waits before each retry of a busy model: a shared proxy or a provider's rate limit clears in seconds, not minutes. */
export const MENU_RETRY_WAITS_MS = [5_000, 15_000, 30_000] as const;

/**
 * Whether a failed call is worth trying again: the model was busy (429, 5xx), slow or unreachable. A refusal for any
 * other reason (a bad key, a bad request) fails at once, since asking again would get the same answer.
 */
export function retryable(e: unknown): boolean {
  if (!(e instanceof AiError)) return false;
  if (e.code === "ai_timeout" || e.code === "ai_unreachable") return true;
  return e.code === "ai_refused" && / answered (429|5\d\d)\b/.test(e.message);
}

/**
 * The model's reply to one piece, as text. A busy model is asked again after each of `waits` (D-095: at most three
 * extra calls per piece); any other failure, or the last busy answer, throws `AiError`.
 */
export async function readMenuPiece(
  model: ChatModel,
  piece: MenuPiece,
  timeoutMs?: number,
  waits: readonly number[] = MENU_RETRY_WAITS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readOnce(model, piece, timeoutMs);
    } catch (e) {
      const wait = waits[attempt];
      if (wait === undefined || !retryable(e)) throw e;
      console.warn(
        `  ${piece.label}: the model was busy (${(e as Error).message.slice(0, 80)}); trying again in ${wait / 1000} s`,
      );
      await sleep(wait);
    }
  }
}

function readOnce(model: ChatModel, piece: MenuPiece, timeoutMs?: number): Promise<string> {
  const user =
    piece.image === undefined
      ? `Menu text, ${piece.label}:\n\n${piece.text ?? ""}`
      : `Menu photo, ${piece.label}. Read every section, item and price on it.`;
  return model.complete({
    system: MENU_SYSTEM,
    user,
    ...(piece.image === undefined ? {} : { images: [piece.image] }),
    maxTokens: MENU_MAX_TOKENS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
