/** A QR code as an SVG path, built with DOM calls (no markup strings), so any text is safe to encode. */

import { encode } from "uqr";

/** The QR's side in modules (border included) and an SVG path with one unit square per dark module. */
export function qrPath(text: string): { size: number; d: string } {
  const { size, data } = encode(text, { ecc: "M", border: 1 });
  let d = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return { size, d };
}

const SVG = "http://www.w3.org/2000/svg";

export function qrSvg(text: string, label: string): SVGSVGElement {
  const { size, d } = qrPath(text);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.classList.add("qr");
  const bg = document.createElementNS(SVG, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}
