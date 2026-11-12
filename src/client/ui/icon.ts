/** The bundled 3D icons and config images, as elements. Images come only from this server or an https host the config names. */

import type { IconRef } from "../../core/theme.ts";
import { h } from "../dom.ts";

/** Where an image reference is served from: an https URL as it is, a config-folder file under `/media`. */
export const mediaUrl = (ref: string): string => (ref.startsWith("https://") ? ref : `/media/${ref}`);

/** A bundled icon: `<img class="em">`, sized by the font size around it. */
export function icon(name: string): HTMLImageElement {
  return h("img", {
    class: "em",
    src: `/assets/emoji/${name}.png`,
    alt: "",
    width: 28,
    height: 28,
    loading: "lazy",
    decoding: "async",
  });
}

/** An icon from the set or an image from the config, at the size of the surrounding text. */
export function iconRef(ref: IconRef): HTMLImageElement {
  if ("icon" in ref) return icon(ref.icon);
  return h("img", { class: "em img-ref", src: mediaUrl(ref.image), alt: "", loading: "lazy", decoding: "async" });
}
