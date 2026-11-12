/**
 * Builds DOM nodes. Text is only ever set as text (`textContent` or text nodes), never parsed as HTML, so a business
 * name, an item or a customer's name can't inject markup.
 */

export type Child = Node | string | number | false | null | undefined | readonly Child[];

export interface Props {
  class?: string;
  /** Event listeners: `{ click: fn }`. */
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  /** Anything else is set as an attribute; `false` and `undefined` leave it off, `true` sets it empty. */
  [attr: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "on") {
      for (const [type, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(type, fn);
    } else if (name === "class") {
      el.className = String(value);
    } else if (name === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      el.value = String(value);
    } else if (value === true) {
      el.setAttribute(name, "");
    } else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(name, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    if (Array.isArray(c)) {
      append(el, c);
      continue;
    }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : (c as Node));
  }
}

/** Replaces everything inside `el`. */
export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}
