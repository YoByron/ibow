/** The bundled icons and config images, as elements. Images come only from this server or an https host the config names. */

import type { IconRef } from "../../core/theme.ts";
import { h } from "../dom.ts";
import { DRAWINGS } from "./icons.ts";

/** Where an image reference is served from: an https URL as it is, a config-folder file under `/media`. */
export const mediaUrl = (ref: string): string => (ref.startsWith("https://") ? ref : `/media/${ref}`);

const SVG = "http://www.w3.org/2000/svg";
const PART_CLASS = { s: "", f: "f", d: "d" } as const;

/**
 * A bundled icon as inline SVG (`<svg class="em">`), sized by the font size around it and coloured by the text colour
 * and the theme's tokens (`--ic-fill` for the soft fill). Built element by element, so the strict policy holds.
 */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "em");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = name;
  for (const [kind, d] of DRAWINGS[name] ?? DRAWINGS.sparkles ?? []) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (PART_CLASS[kind]) path.setAttribute("class", PART_CLASS[kind]);
    svg.append(path);
  }
  return svg;
}

/** An icon from the set or an image from the config, at the size of the surrounding text. */
export function iconRef(ref: IconRef): Element {
  if ("icon" in ref) return icon(ref.icon);
  return h("img", { class: "em img-ref", src: mediaUrl(ref.image), alt: "", loading: "lazy", decoding: "async" });
}
