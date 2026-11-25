import { h } from "../dom.ts";

export interface StepperOptions {
  qty: number;
  max: number;
  /** Names for the two buttons, for screen readers: "One less Chai". */
  less: string;
  more: string;
  size?: "sm" | "lg";
  onChange: (qty: number) => void;
}

/** − qty +, with the plus held at `max` (aria-disabled, so focus stays on it). */
export function stepper(o: StepperOptions): HTMLElement {
  return h(
    "div",
    { class: `stepper${o.size ? ` ${o.size}` : ""}` },
    h("button", { type: "button", "aria-label": o.less, on: { click: () => o.onChange(o.qty - 1) } }, "−"),
    h("b", { class: "num" }, o.qty),
    h(
      "button",
      {
        type: "button",
        "aria-label": o.more,
        "aria-disabled": String(o.qty >= o.max),
        on: { click: () => o.qty < o.max && o.onChange(o.qty + 1) },
      },
      "+",
    ),
  );
}

/** The ADD button of an item card. */
export function addButton(opts: {
  label: string;
  text: string;
  disabled?: boolean;
  testid?: string;
  /** Units already in the cart, shown in place of the plus. */
  count?: number;
  onClick: () => void;
}): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: "add",
      "aria-label": opts.label,
      "aria-disabled": String(opts.disabled ?? false),
      "data-testid": opts.testid,
      on: { click: opts.onClick },
    },
    opts.text,
    h("i", opts.count ? { class: "n" } : {}, opts.count ? `×${opts.count}` : "+"),
  );
}
