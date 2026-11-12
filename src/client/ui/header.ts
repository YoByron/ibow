import type { IconRef } from "../../core/theme.ts";
import { type Child, h } from "../dom.ts";
import { iconRef } from "./icon.ts";

export interface HeaderOptions {
  title: Child;
  subtitle?: Child;
  /** `awning`, `plain` or `image`: from the theme. */
  style: "awning" | "plain" | "image";
  logo?: IconRef | undefined;
  /** A back link before the title. */
  back?: Child;
  /** Round buttons on the right. */
  actions?: Child[];
  /** Anything below the row: the search box. */
  below?: Child;
  titleHref?: string;
}

/** The awning (or plain, or image) header: logo, title, subtitle, round actions. Colours come from tokens. */
export function appHeader(o: HeaderOptions): HTMLElement {
  const title = o.titleHref ? h("a", { href: o.titleHref }, o.title) : o.title;
  return h(
    "header",
    { class: "hdr", "data-style": o.style },
    o.style === "awning" && h("div", { class: "awning-wrap", "aria-hidden": "true" }, h("div", { class: "awning" })),
    h(
      "div",
      { class: "hrow" },
      o.back,
      o.logo && h("span", { class: "logo" }, iconRef(o.logo)),
      h("div", { class: "brand" }, h("h1", {}, title), o.subtitle && h("p", {}, o.subtitle)),
      ...(o.actions ?? []),
    ),
    o.below,
  );
}
