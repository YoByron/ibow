import { type Child, h, type Props } from "../dom.ts";

export function card(props: Props, ...children: Child[]): HTMLElement {
  return h("div", { ...props, class: `card${props.class ? ` ${props.class}` : ""}` }, ...children);
}

/** A small tappable card with an icon, a title and a hint: favourites, recent orders, the live token. */
export function quickCard(opts: {
  icon: Node;
  title: string;
  hint: string;
  live?: string | undefined;
  href?: string;
  onClick?: () => void;
  testid?: string;
}): HTMLElement {
  const body = [
    opts.live && h("span", { class: "live" }, opts.live),
    h("span", { class: "ic" }, opts.icon),
    h("b", {}, opts.title),
    h("small", {}, opts.hint),
  ];
  if (opts.href !== undefined) return h("a", { class: "qc", href: opts.href, "data-testid": opts.testid }, ...body);
  return h(
    "button",
    { type: "button", class: "qc", "data-testid": opts.testid, on: opts.onClick ? { click: opts.onClick } : {} },
    ...body,
  );
}
