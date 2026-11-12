/**
 * 80mm thermal tickets through the browser's print dialog: a station ticket (what to make) and a counter receipt (what
 * was paid). The tickets go into `#print`, which only print CSS shows (style.css, `@media print`). ESC/POS comes later.
 */

import { formatMoney } from "../core/money.ts";
import { type Child, h, mount } from "./dom.ts";
import { t } from "./staff-strings.ts";

export interface TicketLine {
  name: string;
  size?: string;
  qty: number;
  /** Receipts only. */
  unitMinor?: number;
}

export interface Ticket {
  kind: "station" | "receipt";
  business: string;
  token: string;
  /** Epoch ms of the order, shown in the business's time zone. */
  at: number;
  timeZone: string;
  /** Station tickets: which station it is for. */
  station?: string;
  customerName?: string;
  lines: readonly TicketLine[];
  /** Receipts: the order's money, in minor units of `currency`. */
  money?: { currency: string; totalMinor: number; paidMinor: number; dueMinor: number };
}

function when(at: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone }).format(at);
}

export function ticketNode(ticket: Ticket, locale: string): HTMLElement {
  const cur = ticket.money?.currency;
  const fmt = (minor: number) => (cur === undefined ? "" : formatMoney(minor, cur, locale));
  const rows: Child[] = ticket.lines.map((l) =>
    h(
      "li",
      {},
      h("span", { class: "t-qty" }, `${l.qty} ×`),
      h("span", { class: "t-name" }, l.size === undefined ? l.name : `${l.name} (${l.size})`),
      l.unitMinor !== undefined && h("span", { class: "t-amount" }, fmt(l.unitMinor * l.qty)),
    ),
  );
  const m = ticket.money;
  return h(
    "section",
    { class: `slip slip-${ticket.kind}`, "data-testid": `ticket-${ticket.token}` },
    h("p", { class: "t-business" }, ticket.business),
    ticket.station !== undefined && h("p", { class: "t-station" }, ticket.station),
    h("p", { class: "t-token" }, t("ticketToken", { token: ticket.token })),
    h("p", { class: "t-time" }, when(ticket.at, ticket.timeZone, locale)),
    ticket.customerName !== undefined && h("p", { class: "t-note" }, t("forName", { name: ticket.customerName })),
    h("ul", { class: "t-lines" }, ...rows),
    m &&
      h(
        "dl",
        { class: "t-money" },
        h("dt", {}, t("total")),
        h("dd", {}, fmt(m.totalMinor)),
        h("dt", {}, t("receiptPaid")),
        h("dd", {}, fmt(m.paidMinor)),
        m.dueMinor > 0 && h("dt", {}, t("receiptDue")),
        m.dueMinor > 0 && h("dd", {}, fmt(m.dueMinor)),
      ),
  );
}

/** Puts the tickets into `#print`, each on its own paper cut, and opens the print dialog. */
export function printTickets(tickets: readonly Ticket[], locale: string): void {
  const slot = document.getElementById("print");
  if (slot === null || tickets.length === 0) return;
  mount(slot, ...tickets.map((tk) => ticketNode(tk, locale)));
  window.print();
}
