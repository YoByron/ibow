import { h } from "../dom.ts";

let current: HTMLElement | undefined;

/** A short message at the bottom of the screen, announced politely, gone after a few seconds. */
export function toast(text: string, tone: "ok" | "err" = "ok", ms = 3500): void {
  current?.remove();
  const el = h("div", { class: `toast${tone === "err" ? " err" : ""}`, role: "status" }, text);
  current = el;
  document.body.append(el);
  setTimeout(() => {
    el.remove();
    if (current === el) current = undefined;
  }, ms);
}
