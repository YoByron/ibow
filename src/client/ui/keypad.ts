import { h } from "../dom.ts";

export interface Keypad {
  el: HTMLElement;
  /** The digits entered so far. */
  value(): string;
  clear(): void;
}

/**
 * A PIN pad: nine digits, clear, zero, delete, and the dots above. A hardware keyboard works too. `onChange` runs on
 * every change with the digits so far; the caller decides when the PIN is complete and what to do with it.
 */
export function keypad(opts: {
  max: number;
  labels: { clear: string; delete: string; digit: (n: string) => string };
  onChange: (digits: string) => void;
  /** A real input the pad types into and reads from, so a typed PIN and a tapped one are the same. */
  input?: HTMLInputElement;
  onEnter?: () => void;
}): Keypad {
  let own = "";
  const get = () => opts.input?.value ?? own;
  const put = (v: string) => {
    own = v;
    if (opts.input) opts.input.value = v;
  };
  const dots = h("div", { class: "pdots", "aria-hidden": "true" });
  const draw = () => {
    dots.replaceChildren(
      ...Array.from({ length: Math.max(4, get().length) }, (_, i) => h("i", { class: i < get().length ? "f" : "" })),
    );
  };
  const set = (next: string) => {
    put(next.slice(0, opts.max));
    draw();
    opts.onChange(get());
  };
  const key = (text: string, label: string, fn: () => void, fnKey = false) =>
    h("button", { type: "button", class: `key${fnKey ? " fn" : ""}`, "aria-label": label, on: { click: fn } }, text);
  const pad = h(
    "div",
    { class: "keypad" },
    ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => key(d, opts.labels.digit(d), () => set(get() + d))),
    key("✕", opts.labels.clear, () => set(""), true),
    key("0", opts.labels.digit("0"), () => set(`${get()}0`)),
    key("⌫", opts.labels.delete, () => set(get().slice(0, -1)), true),
  );
  const el = h("div", { class: "keypad-wrap" }, dots, pad);
  if (!opts.input)
    document.addEventListener("keydown", (e) => {
      if (!el.isConnected) return;
      if (/^\d$/.test(e.key)) set(get() + e.key);
      else if (e.key === "Backspace") set(get().slice(0, -1));
      else if (e.key === "Enter") opts.onEnter?.();
    });
  draw();
  return { el, value: () => get(), clear: () => set("") };
}
