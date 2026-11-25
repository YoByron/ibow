/**
 * Rooms (D-083): each room with orders on its room bill and their total, and "Settle at checkout": one payment by cash, UPI
 * or card covering exactly those orders. The server refuses a total that changed since this screen read it, so the guest
 * pays what staff showed them. The latest settlements are listed below, as the audit: who, when, how much, how.
 */

import { formatPrice } from "../core/money.ts";
import type { PaymentMethod } from "../core/payments.ts";
import type { RoomBillMove, RoomBillSummary, RoomSettlement } from "../core/rooms.ts";
import { orderNumber } from "../core/tokens.ts";
import { api } from "./api.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";
import { button } from "./ui/button.ts";
import { card } from "./ui/card.ts";
import { showDialog } from "./ui/dialog.ts";

export interface RoomsOptions {
  currency: string;
  timeZone: string;
  upi: boolean;
  card: boolean;
}

/** The Rooms screen's body. `redraw` reads the rooms again; `fail` shows an error the way the staff screens do. */
export async function roomsBody(
  opts: RoomsOptions,
  redraw: () => void,
  fail: (e: unknown) => void,
  error: HTMLElement,
  /** Filled with the ids of the orders on screen, so the page redraws only for events about them or a room bill. */
  shown?: Set<string>,
): Promise<Child[]> {
  const data = await api<{
    rooms: RoomBillSummary[];
    settlements: RoomSettlement[];
    moves?: (RoomBillMove & { label: string })[];
  }>("GET", "/api/rooms");
  if (shown) {
    shown.clear();
    for (const r of data.rooms) for (const o of r.orders) shown.add(o.id);
  }
  // Whole amounts without the paise, as on every other screen.
  const money = (m: number) => formatPrice(m, opts.currency);
  const clock = (at: number) =>
    new Intl.DateTimeFormat(navigator.language, { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone }).format(
      at,
    );
  const methods: [PaymentMethod, string][] = [
    ["cash", t("roomSettleCash")],
    ...(opts.upi ? ([["upi", t("roomSettleUpi")]] as [PaymentMethod, string][]) : []),
    ...(opts.card ? ([["card", t("roomSettleCard")]] as [PaymentMethod, string][]) : []),
  ];
  /** Settling records money and can't be undone, so the amount and method are confirmed first. */
  const confirmSettle = (r: RoomBillSummary, method: PaymentMethod) =>
    void showDialog({
      icon: "money_bag",
      title: t("roomSettleTitle", { room: r.label }),
      body: h("p", {}, t("roomSettleBody", { amount: money(r.totalMinor), method: methodName(method) })),
      actions: [
        { label: t("roomSettleConfirm"), kind: "primary", onClick: () => void settle(r, method) },
        { label: t("cancel"), kind: "ghost" },
      ],
      testid: "settle-dialog",
    });
  const settle = async (r: RoomBillSummary, method: PaymentMethod) => {
    error.textContent = "";
    try {
      await api("POST", `/api/rooms/${encodeURIComponent(r.room)}/settle`, {
        body: { method, amountMinor: r.totalMinor },
      });
      redraw();
    } catch (e) {
      fail(e);
      // A total that moved is shown again at once, so staff read the new one to the guest.
      redraw();
    }
  };
  /** An order put on the wrong room leaves the bill, audited, and is then paid at the counter (D-082). */
  const confirmMove = (r: RoomBillSummary, o: RoomBillSummary["orders"][number]) => {
    const reason = h("input", {
      type: "text",
      maxlength: "120",
      "data-testid": "move-reason",
      "aria-label": t("roomMoveReason"),
      placeholder: t("roomMoveReason"),
    });
    void showDialog({
      icon: "receipt",
      title: t("roomMoveTitle", { token: o.token, room: r.label }),
      body: h("div", {}, h("p", {}, t("roomMoveBody")), h("label", { class: "field" }, reason)),
      actions: [
        {
          label: t("roomMoveConfirm"),
          kind: "primary",
          onClick: () =>
            void (async () => {
              error.textContent = "";
              try {
                const why = reason.value.trim();
                await api("POST", `/api/orders/${encodeURIComponent(o.id)}/off-room`, {
                  body: why === "" ? {} : { reason: why },
                });
              } catch (e) {
                fail(e);
              }
              redraw();
            })(),
        },
        { label: t("cancel"), kind: "ghost" },
      ],
      testid: "move-dialog",
    });
  };
  const methodName = (m: PaymentMethod) =>
    m === "cash" ? t("methodCash") : m === "upi" ? t("methodUpi") : t("methodCard");
  return [
    error,
    data.rooms.length === 0 && h("p", { class: "empty" }, t("roomsNone")),
    ...data.rooms.map((r) =>
      card(
        { class: "room-card", "data-testid": `room-${r.room}` },
        h("div", { class: "room-acts" }, h("h2", {}, r.label), h("b", { class: "num" }, money(r.totalMinor))),
        h(
          "ul",
          { class: "lines" },
          ...r.orders.map((o) =>
            h(
              "li",
              {},
              h("span", { class: "line-name" }, orderNumber(o.token), o.customerName && ` · ${o.customerName}`),
              h("span", { class: "hint" }, clock(o.createdAt)),
              h("b", { class: "num" }, money(o.totalMinor)),
              button(
                { kind: "ghost", small: true, testid: `move-${o.token}`, onClick: () => confirmMove(r, o) },
                t("roomMoveOff"),
              ),
            ),
          ),
        ),
        h("p", { class: "hint" }, t("roomSettleHint", { amount: money(r.totalMinor) })),
        h(
          "div",
          { class: "settle-row" },
          ...methods.map(([m, label]) =>
            button(
              {
                kind: m === "cash" ? "primary" : "ghost",
                testid: `settle-${r.room}-${m}`,
                onClick: () => confirmSettle(r, m),
              },
              label,
            ),
          ),
        ),
      ),
    ),
    (data.moves?.length ?? 0) > 0 &&
      h(
        "section",
        { class: "settled" },
        h("h2", {}, t("roomsMoved")),
        h(
          "ul",
          { class: "lines", "data-testid": "moves" },
          ...(data.moves ?? []).map((m) =>
            h(
              "li",
              {},
              h("span", { class: "line-name" }, m.label),
              h("span", { class: "hint" }, t("roomMovedBy", { by: m.by, time: clock(m.at), reason: m.reason ?? "" })),
            ),
          ),
        ),
      ),
    data.settlements.length > 0 &&
      h(
        "section",
        { class: "settled" },
        h("h2", {}, t("roomsSettled")),
        h(
          "ul",
          { class: "lines", "data-testid": "settlements" },
          ...data.settlements.map((s) =>
            h(
              "li",
              {},
              h("span", { class: "line-name" }, s.label),
              h(
                "span",
                { class: "hint" },
                t("roomSettledBy", { by: s.by, time: clock(s.at), method: methodName(s.method) }),
              ),
              h("b", { class: "num" }, money(s.amountMinor)),
            ),
          ),
        ),
      ),
  ];
}
