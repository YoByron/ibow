/**
 * A guest's messages on a runner or counter card (D-104): the last few lines of the thread, and while the guest waits
 * for an answer, one-tap replies ("Coming", "2 minutes") and a short line. A chip is shown in the staff's own words.
 */

import type { GuestChip, OrderMessage, StaffChip } from "../core/messages.ts";
import { MAX_MESSAGE_CHARS, unanswered } from "../core/messages.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";

/** A chip's label, each written out so the string check sees it used. */
const chipText = (c: GuestChip | StaffChip): string =>
  ({
    water: t("chipWater"),
    bill: t("chipBill"),
    help: t("chipHelp"),
    more: t("chipMore"),
    coming: t("replyComing"),
    twoMinutes: t("replyTwoMinutes"),
  })[c];

/** What a message says, in the staff's words: its text, or its chip's label. */
export function messageText(m: Pick<OrderMessage, "text" | "chip">): string {
  return m.text ?? (m.chip === undefined ? "" : chipText(m.chip));
}

/** The newest guest message nobody answered, if the thread waits for an answer. */
export function waitingMessage(o: { messages?: readonly OrderMessage[] }): OrderMessage | undefined {
  return unanswered(o) ? o.messages?.at(-1) : undefined;
}

/** Shown on a card: at most this many of the newest messages. */
const SHOWN = 3;

export interface ThreadDeps {
  /** Sends a reply: a chip or a line. */
  reply: (body: { chip: StaffChip } | { text: string }) => Promise<unknown>;
  /** A button that runs a call and reports its failure the way the screen does. */
  action: (label: string, key: string, run: () => Promise<unknown>, cls?: string) => HTMLElement;
  /** The screen's unsent replies by order id, so a live update doesn't wipe what is being typed. */
  drafts: Map<string, string>;
  clock: (at: number) => string;
}

/** The thread block of a card, or nothing when the order has no messages. */
export function threadBlock(
  o: { id: string; token: string; messages?: readonly OrderMessage[] },
  deps: ThreadDeps,
): Child {
  const thread = o.messages ?? [];
  if (thread.length === 0) return null;
  const waiting = unanswered(o);
  const field = h("input", {
    type: "text",
    maxlength: String(MAX_MESSAGE_CHARS),
    placeholder: t("replyPlaceholder"),
    "aria-label": t("replyField", { token: o.token }),
    value: deps.drafts.get(o.id) ?? "",
    "data-key": `reply-text-${o.id}`,
  });
  field.addEventListener("input", () => deps.drafts.set(o.id, field.value));
  const sendLine = async () => {
    const text = field.value.trim();
    if (text === "") return;
    await deps.reply({ text });
    deps.drafts.delete(o.id);
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendLine().catch(() => undefined);
  });
  return h(
    "div",
    { class: `thread${waiting ? " waiting" : ""}`, "data-testid": `thread-${o.token}` },
    h(
      "ul",
      { class: "thread-lines" },
      ...thread
        .slice(-SHOWN)
        .map((m) =>
          h(
            "li",
            { class: `msg from-${m.from}` },
            h("b", {}, m.from === "guest" ? t("messageFromGuest") : t("messageFromStaff")),
            " ",
            messageText(m),
            h("small", { class: "hint" }, " · ", deps.clock(m.at)),
          ),
        ),
    ),
    waiting &&
      h(
        "div",
        { class: "thread-reply" },
        deps.action(t("replyComing"), `reply-coming-${o.id}`, () => deps.reply({ chip: "coming" }), "primary"),
        deps.action(t("replyTwoMinutes"), `reply-two-${o.id}`, () => deps.reply({ chip: "twoMinutes" })),
        h("div", { class: "thread-line" }, field, deps.action(t("replySend"), `reply-send-${o.id}`, sendLine)),
      ),
  );
}
