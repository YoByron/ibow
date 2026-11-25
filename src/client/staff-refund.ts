/** The counter's card line and refund box for one order (D-071), kept apart from the counter's own code. */

import { parseMajor } from "../core/money.ts";
import { PAYMENT_METHODS, type PaymentMethod } from "../core/payments.ts";
import type { StaffOrderView } from "../core/views.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";

export interface RefundDeps {
  currency: string;
  money(minor: number): string;
  /** Methods this business takes (card only where `business.json` says so). */
  methods: readonly PaymentMethod[];
  /** Whether the signed-in person may refund, and up to how much on one order (undefined: no limit). */
  canRefund: boolean;
  limitMinor?: number | undefined;
  give(o: StaffOrderView, body: { method: PaymentMethod; amountMinor: number }): Promise<unknown>;
  /** A button that shows a failure and stays disabled while its call runs (the counter's own). */
  action(label: string, key: string, run: () => Promise<unknown>, cls?: string): HTMLElement;
  rerender(): void;
}

const methodName = (m: PaymentMethod) => {
  if (m === "cash") return t("methodCash");
  return m === "upi" ? t("methodUpi") : t("methodCard");
};

/** Which orders have the box open, and what is typed in it. */
const open = new Map<string, { method: PaymentMethod; text: string }>();

/** What was handed back so far, and for a person who may, the box to hand back more. Empty for an unpaid order. */
export function refundBlock(o: StaffOrderView, d: RefundDeps): Child {
  const p = o.payment;
  if (p.state !== "confirmed") return null;
  const refunds = p.refunds ?? [];
  const given = refunds.reduce((n, r) => n + r.amountMinor, 0);
  const kept = p.amountMinor - given;
  const parts: Child[] = refunds.map((r) =>
    h(
      "p",
      { class: "hint refunded" },
      t("refundedLine", { amount: d.money(r.amountMinor), method: methodName(r.method), by: r.by }),
    ),
  );
  if (!d.canRefund || kept <= 0) return parts.length === 0 ? null : h("div", { class: "refund-block" }, ...parts);
  const draft = open.get(o.id);
  if (draft === undefined) {
    parts.push(
      h(
        "button",
        {
          type: "button",
          "data-key": `refund-open-${o.id}`,
          on: {
            click: () => {
              open.set(o.id, { method: d.methods.includes(p.method) ? p.method : (d.methods[0] ?? "cash"), text: "" });
              d.rerender();
            },
          },
        },
        t("refundAction"),
      ),
    );
    return h("div", { class: "refund-block" }, ...parts);
  }
  const ceiling = d.limitMinor === undefined ? kept : Math.min(kept, d.limitMinor);
  const input = h("input", {
    type: "text",
    inputmode: "decimal",
    "data-key": `refund-amount-${o.id}`,
    "aria-label": t("refundAmount"),
    placeholder: d.money(ceiling),
    value: draft.text,
    on: {
      input: (e) => {
        draft.text = (e.target as HTMLInputElement).value;
      },
    },
  });
  const select = h(
    "select",
    {
      "data-key": `refund-method-${o.id}`,
      "aria-label": t("refundMethod"),
      on: {
        change: (e) => {
          draft.method = (e.target as HTMLSelectElement).value as PaymentMethod;
        },
      },
    },
    ...PAYMENT_METHODS.filter((m) => d.methods.includes(m)).map((m) =>
      h("option", { value: m, selected: m === draft.method }, methodName(m)),
    ),
  );
  parts.push(
    h("p", { class: "hint" }, t("refundUpTo", { amount: d.money(ceiling) })),
    h("div", { class: "row" }, input, select),
    d.action(
      t("refundGive"),
      `refund-ok-${o.id}`,
      async () => {
        const amountMinor = parseMajor(draft.text, d.currency);
        if (amountMinor === undefined) throw new Error("bad amount");
        await d.give(o, { method: draft.method, amountMinor });
        open.delete(o.id);
        d.rerender();
      },
      "primary",
    ),
    h(
      "button",
      {
        type: "button",
        "data-key": `refund-cancel-${o.id}`,
        on: {
          click: () => {
            open.delete(o.id);
            d.rerender();
          },
        },
      },
      t("cancel"),
    ),
  );
  return h("div", { class: "refund-block" }, ...parts);
}
