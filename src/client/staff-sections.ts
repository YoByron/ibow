/**
 * The sections editor (D-102): the owner and the manager add, rename and delete table sections and their spots. Rooms are
 * listed but fixed, since their QR keys depend on spots.json. A draft is edited in place and saved in one PUT, which the
 * server checks with the spots.json rules; its message names the field when something is wrong.
 */

import type { Zone } from "../core/config.ts";
import type { EditableSection } from "../core/sections.ts";
import { api } from "./api.ts";
import { type Child, h } from "./dom.ts";
import { t } from "./staff-strings.ts";
import { button } from "./ui/button.ts";

/** A spot in the draft: the id it was saved with, which a rename keeps (absent on a spot added here). */
interface DraftSpot {
  id?: string;
  name: string;
}
interface DraftSection {
  id?: string;
  name: string;
  spots: DraftSpot[];
}

export interface SectionsData {
  sections: EditableSection[];
  zones: Zone[];
}

const copy = (sections: SectionsData["sections"]): DraftSection[] =>
  sections.map((s) => ({ ...s, spots: s.spots.map((x) => ({ ...x })) }));

/**
 * The editor's body. `saved` runs after a save, with the zones now in force, so the page can refresh what it holds;
 * `fail` shows an error the way the staff screens do.
 */
export async function sectionsBody(
  saved: () => void,
  fail: (e: unknown) => void,
  error: HTMLElement,
): Promise<Child[]> {
  const data = await api<SectionsData>("GET", "/api/sections");
  const draft: DraftSection[] = copy(data.sections);
  const rooms = data.zones.filter((z) => z.kind === "room");
  const list = h("div", { class: "sec-list" });
  const status = h("p", { class: "hint", role: "status" });

  function input(value: string, label: string, testid: string, set: (v: string) => void): HTMLInputElement {
    const el = h("input", { type: "text", maxlength: "40", value, "aria-label": label, "data-testid": testid });
    el.addEventListener("input", () => set(el.value));
    return el;
  }

  function draw(): void {
    list.replaceChildren(
      ...draft.map((s, i) =>
        h(
          "section",
          { class: "sec-card", "data-testid": `sec-${i}` },
          h(
            "div",
            { class: "sec-head" },
            input(s.name, t("sectionName"), `sec-name-${i}`, (v) => {
              s.name = v;
            }),
            button(
              {
                kind: "ghost",
                small: true,
                testid: `sec-delete-${i}`,
                onClick: () => {
                  draft.splice(i, 1);
                  draw();
                },
              },
              t("deleteSection"),
            ),
          ),
          h(
            "ul",
            { class: "sec-spots" },
            ...s.spots.map((spot, j) =>
              h(
                "li",
                {},
                input(spot.name, t("spotName"), `sec-spot-${i}-${j}`, (v) => {
                  spot.name = v;
                }),
                button(
                  {
                    kind: "ghost",
                    small: true,
                    label: t("deleteSpot", { spot: spot.name || t("spotName") }),
                    onClick: () => {
                      s.spots.splice(j, 1);
                      draw();
                    },
                  },
                  "×",
                ),
              ),
            ),
          ),
          button(
            {
              kind: "ghost",
              small: true,
              testid: `sec-add-spot-${i}`,
              onClick: () => {
                s.spots.push({ name: "" });
                draw();
                (
                  list.querySelector(`[data-testid="sec-spot-${i}-${s.spots.length - 1}"]`) as HTMLElement | null
                )?.focus();
              },
            },
            t("addSpot"),
          ),
        ),
      ),
    );
  }

  const save = async () => {
    error.textContent = "";
    status.textContent = "";
    try {
      // A spot left empty is dropped rather than refused: it is how a row is abandoned. Each keeps its id (D-102).
      const sections = draft.map((s) => ({
        ...s,
        spots: s.spots.map((x) => ({ ...x, name: x.name.trim() })).filter((x) => x.name !== ""),
      }));
      const r = await api<SectionsData>("PUT", "/api/sections", { body: { sections } });
      draft.splice(0, draft.length, ...copy(r.sections));
      draw();
      status.textContent = t("sectionsSaved");
      saved();
    } catch (e) {
      fail(e);
    }
  };

  draw();
  return [
    error,
    status,
    list,
    h(
      "div",
      { class: "sec-actions" },
      button(
        {
          kind: "ghost",
          testid: "sec-add",
          onClick: () => {
            draft.push({ name: t("newSection"), spots: [] });
            draw();
          },
        },
        t("addSection"),
      ),
      button({ kind: "primary", testid: "sec-save", onClick: () => void save() }, t("saveSections")),
    ),
    rooms.length > 0 &&
      h(
        "section",
        { class: "sec-card sec-rooms" },
        h("h2", {}, rooms.map((z) => z.name).join(", ")),
        h("p", { class: "hint" }, t("roomsFixed")),
      ),
  ];
}
