/**
 * The guest's messages on the token page (D-104): quick chips (water, the bill, help, to add something), a short line,
 * and the thread with the staff's replies, live from the order's own stream. The card is made once; the thread and the
 * form redraw only when what they show changed, so typed text and focus survive a live update.
 */

import { type GuestChip, MAX_MESSAGE_CHARS, type StaffChip } from "../core/messages.ts";
import type { CustomerOrderView } from "../core/views.ts";
import { ApiFailure } from "./api.ts";
import { type Child, h, mount } from "./dom.ts";
import { t } from "./strings.ts";
import { button } from "./ui/button.ts";
import { card } from "./ui/card.ts";
import { pill } from "./ui/chip.ts";

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
const CHIPS: readonly GuestChip[] = ["water", "bill", "help", "more"];

type Thread = NonNullable<CustomerOrderView["messages"]>;

/** The server's refusals of a message, in the guest's words; undefined for any other failure. */
function refusal(e: unknown): string | undefined {
  if (!(e instanceof ApiFailure)) return undefined;
  if (e.code === "too_soon") return t("messageTooSoon");
  if (e.code === "too_many_messages") return t("messageTooMany");
  if (e.code === "messages_closed" || e.code === "messages_off") return t("messagesClosed");
  return undefined;
}

/** A message in the guest's words: its text, or its chip's label. */
export function guestMessageText(m: Thread[number]): string {
  return m.text ?? (m.chip === undefined ? "" : chipText(m.chip));
}

export interface GuestMessagesDeps {
  /** Sends a message; resolves with the order as it now stands. */
  send: (body: { chip: GuestChip } | { text: string }) => Promise<CustomerOrderView>;
  clock: (at: number) => string;
  failureText: (e: unknown) => string;
  /** Called with the order a send returned, so the page redraws the rest. */
  sent: (order: CustomerOrderView) => void;
}

/** The card and its `update`, to call with each new copy of the order. */
export function guestMessages(deps: GuestMessagesDeps): { el: HTMLElement; update: (o: CustomerOrderView) => void } {
  const threadSlot = h("div");
  const formSlot = h("div");
  const error = h("p", { class: "error", role: "alert" });
  let draft = "";
  let drawnThread = "";
  let drawnForm = "";

  const send = async (body: { chip: GuestChip } | { text: string }): Promise<boolean> => {
    error.textContent = "";
    try {
      deps.sent(await deps.send(body));
      return true;
    } catch (e) {
      error.textContent = refusal(e) ?? deps.failureText(e);
      return false;
    }
  };

  function thread(list: Thread): Child {
    if (list.length === 0) return null;
    return h(
      "ul",
      { class: "msg-thread", "data-testid": "msg-thread" },
      ...list.map((m) =>
        h(
          "li",
          { class: `msg from-${m.from}` },
          h("span", { class: "who" }, m.from === "guest" ? t("messageFromYou") : t("messageFromStaff")),
          h("span", { class: "said" }, guestMessageText(m)),
          h("small", { class: "muted" }, deps.clock(m.at)),
        ),
      ),
    );
  }

  function form(): Child {
    const field = h("input", {
      type: "text",
      maxlength: String(MAX_MESSAGE_CHARS),
      placeholder: t("messagePlaceholder"),
      "aria-label": t("messageField"),
      value: draft,
      "data-testid": "msg-text",
    });
    field.addEventListener("input", () => {
      draft = field.value;
    });
    return h(
      "form",
      {
        class: "msg-form",
        on: {
          submit: async (e) => {
            e.preventDefault();
            const text = draft.trim();
            if (text === "") return;
            if (await send({ text })) {
              draft = "";
              field.value = "";
            }
          },
        },
      },
      h(
        "div",
        { class: "msg-chips" },
        ...CHIPS.map((c) =>
          pill({ label: chipText(c), testid: `msg-chip-${c}`, onClick: () => void send({ chip: c }) }),
        ),
      ),
      h(
        "div",
        { class: "msg-line" },
        field,
        button({ kind: "primary", type: "submit", testid: "msg-send", label: t("messageSendName") }, t("messageSend")),
      ),
    );
  }

  const el = card(
    { class: "messages", "data-testid": "messages" },
    h("h2", {}, t("messagesTitle")),
    h("p", { class: "muted" }, t("messagesHint")),
    threadSlot,
    formSlot,
    error,
  );

  function update(o: CustomerOrderView): void {
    const list = o.messages ?? [];
    const open = o.messagesUntil === undefined || Date.now() <= o.messagesUntil;
    const sig = JSON.stringify(list);
    if (sig !== drawnThread) {
      drawnThread = sig;
      mount(threadSlot, thread(list));
    }
    const formSig = String(open);
    if (formSig !== drawnForm) {
      drawnForm = formSig;
      mount(formSlot, open ? form() : h("p", { class: "muted", "data-testid": "msg-closed" }, t("messagesClosed")));
    }
  }

  return { el, update };
}
