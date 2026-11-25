/**
 * The owner's Spots page: one QR per table, bench or corner. Scanning it opens the storefront with that spot already
 * chosen (`/?spot=<id>`), so the order says where to bring the food. "Print" sends one card per spot to the printer.
 */

import type { Zone } from "../core/config.ts";
import { api } from "./api.ts";
import { type Child, h, mount } from "./dom.ts";
import type { ownerEn } from "./owner-strings.ts";
import { qrSvg } from "./qr.ts";
import { button } from "./ui/button.ts";
import { showDialog } from "./ui/dialog.ts";

type T = (key: keyof typeof ownerEn, vars?: Record<string, string>) => string;

/**
 * The address a spot's QR encodes: the storefront at this origin with the spot set, and for a room its key, without which
 * nobody can put an order on that room's bill (D-082).
 */
export function spotLink(origin: string, spotId: string, key?: string): string {
  return `${origin}/?spot=${encodeURIComponent(spotId)}${key === undefined ? "" : `&key=${encodeURIComponent(key)}`}`;
}

function card(business: string, label: string, link: string, scan: string): HTMLElement {
  return h(
    "section",
    { class: "slip spot-card", "data-testid": `spot-${label}` },
    h("p", { class: "t-business" }, business),
    h("p", { class: "t-token" }, label),
    qrSvg(link, label),
    h("p", { class: "t-note" }, scan),
  );
}

export async function spotsView(
  page: (...children: Child[]) => void,
  business: string,
  zones: readonly Zone[],
  t: T,
): Promise<void> {
  const all = zones.flatMap((z) => z.spots);
  const keys = zones.some((z) => z.kind === "room")
    ? (await api<{ keys: Record<string, string> }>("GET", "/api/rooms/keys")).keys
    : {};
  const link = (id: string) => spotLink(location.origin, id, keys[id]);
  const rooms = new Set(zones.filter((z) => z.kind === "room").flatMap((z) => z.spots.map((s) => s.id)));
  /** A new key for one room: its old QR stops working (D-082), so the page is drawn again with the new link. */
  const newQr = (id: string, label: string) =>
    void showDialog({
      title: t("spotNewQrTitle", { room: label }),
      body: h("p", {}, t("spotNewQrBody")),
      actions: [
        {
          label: t("spotNewQrConfirm"),
          kind: "primary",
          onClick: () =>
            void api("POST", `/api/rooms/${encodeURIComponent(id)}/new-key`).then(
              () => spotsView(page, business, zones, t),
              (e: Error) => void showDialog({ title: e.message, tone: "warn" }),
            ),
        },
        { label: t("spotNewQrCancel"), kind: "ghost" },
      ],
      testid: "new-qr-dialog",
    });
  const print = () => {
    let slot = document.getElementById("print");
    if (slot === null) {
      slot = h("div", { id: "print", "aria-hidden": "true" });
      document.body.append(slot);
    }
    mount(slot, ...all.map((s) => card(business, s.label, link(s.id), t("spotScan"))));
    window.print();
  };
  page(
    h(
      "div",
      { class: "spots" },
      h("h2", {}, t("navSpots")),
      all.length === 0
        ? h("p", { class: "empty" }, t("spotsNone"))
        : h(
            "div",
            { class: "spots-body" },
            h("p", { class: "muted" }, t("spotsHint")),
            h(
              "button",
              { type: "button", class: "primary", "data-testid": "print-spots", on: { click: print } },
              t("spotsPrint", { n: String(all.length) }),
            ),
            // One card per area; each spot is a tile that opens its own storefront link, so the owner can try a QR's target.
            ...zones.map((z) =>
              h(
                "section",
                { class: "card spot-zone" },
                h("header", {}, h("h3", {}, z.name), h("span", { class: "muted" }, String(z.spots.length))),
                h(
                  "ul",
                  { class: "plain spot-grid" },
                  ...z.spots.map((s) =>
                    h(
                      "li",
                      {},
                      h(
                        "a",
                        {
                          href: link(s.id),
                          target: "_blank",
                          rel: "noopener",
                          title: link(s.id),
                        },
                        h("b", {}, s.label),
                        h("small", {}, `?spot=${s.id}`),
                      ),
                      rooms.has(s.id) &&
                        button(
                          { kind: "ghost", small: true, testid: `new-qr-${s.id}`, onClick: () => newQr(s.id, s.label) },
                          t("spotNewQr"),
                        ),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}
