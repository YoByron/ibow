import { h } from "../dom.ts";

export interface Step {
  title: string;
  sub?: string;
  /** A time or "Now". */
  time?: string;
  state: "done" | "now" | "todo";
}

/** The live tracking steps: done ones filled, the current one in the accent, the rest quiet. */
export function timeline(steps: readonly Step[]): HTMLElement {
  return h(
    "ol",
    { class: "tl" },
    ...steps.map((s, i) =>
      h(
        "li",
        { class: `step ${s.state}`, "aria-current": s.state === "now" ? "step" : undefined },
        h("span", { class: "nd", "aria-hidden": "true" }, s.state === "done" ? "✓" : s.state === "now" ? "•" : i + 1),
        s.time && h("span", { class: "tm" }, s.time),
        h("b", {}, s.title),
        s.sub && h("small", {}, s.sub),
      ),
    ),
  );
}
