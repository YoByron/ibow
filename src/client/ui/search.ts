import { h } from "../dom.ts";
import { keypad } from "./keypad.ts";

export interface SearchBox {
  /** Made once per screen and placed in every render, so its text, its pad and its focus survive a re-render. */
  el: HTMLElement;
  value(): string;
}

/**
 * One search control for a staff screen (D-106): a field that takes letters from the phone's keyboard, and a button that
 * opens the digit keypad, which types into the same field. `onChange` runs with the text on every change.
 */
export function searchBox(opts: {
  labels: { search: string; placeholder: string; keypad: string; clear: string; delete: string };
  onChange: (query: string) => void;
}): SearchBox {
  const input = h("input", {
    type: "search",
    class: "order-search-input",
    "data-key": "search",
    "data-testid": "search",
    autocomplete: "off",
    enterkeyhint: "search",
    "aria-label": opts.labels.search,
    placeholder: opts.labels.placeholder,
  });
  input.addEventListener("input", () => opts.onChange(input.value));
  const pad = keypad({
    max: 20,
    input,
    labels: { clear: opts.labels.clear, delete: opts.labels.delete, digit: (n) => n },
    onChange: (q) => opts.onChange(q),
  });
  const keys = h("div", { class: "order-search-keys", hidden: true }, pad.el);
  const toggle = h(
    "button",
    {
      type: "button",
      class: "order-search-pad",
      "data-key": "search-pad",
      "data-testid": "search-pad",
      "aria-expanded": "false",
      "aria-label": opts.labels.keypad,
      on: {
        click: () => {
          keys.hidden = !keys.hidden;
          toggle.setAttribute("aria-expanded", String(!keys.hidden));
        },
      },
    },
    "123",
  );
  const clear = h(
    "button",
    {
      type: "button",
      class: "order-search-clear",
      "data-key": "search-clear",
      "aria-label": opts.labels.clear,
      on: {
        click: () => {
          pad.clear();
          keys.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
        },
      },
    },
    "×",
  );
  const el = h(
    "div",
    { class: "order-search", role: "search" },
    h("div", { class: "order-search-row" }, input, toggle, clear),
    keys,
  );
  return { el, value: () => input.value };
}
