/**
 * The events editor (D-084), on the owner's Events tab and the manager's screen: each event with Edit and Delete, and one
 * form to add or change one (title, date, start and end, a one-line note, an entry price, who sees it, "expect a rush",
 * and an optional weekly repeat with an end date). The server checks every field; this only gathers them.
 */

import type { CalendarEvent, EventInput } from "../core/calendar.ts";
import { WEEKDAYS } from "../core/calendar.ts";
import { formatPrice, majorAmount, parseMajor } from "../core/money.ts";
import { api } from "./api.ts";
import { type Child, h } from "./dom.ts";
import { te } from "./events-strings.ts";
import { button } from "./ui/button.ts";
import { card } from "./ui/card.ts";
import { showDialog } from "./ui/dialog.ts";

const dayName = (d: number) =>
  new Intl.DateTimeFormat(navigator.language, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + d));

/** The editor's body. `redraw` reads the events again; `fail` shows an error the way the page does. */
export async function eventsBody(
  currency: string,
  redraw: () => void,
  fail: (e: unknown) => void,
  error: HTMLElement,
  editing?: CalendarEvent,
  onEdit?: (e: CalendarEvent | undefined) => void,
): Promise<Child[]> {
  const { events } = await api<{ events: CalendarEvent[] }>("GET", "/api/events/all");
  const field = (label: string, control: HTMLElement) => h("label", { class: "field" }, h("span", {}, label), control);
  const input = (name: string, type: string, value = "", extra: Record<string, unknown> = {}) =>
    h("input", { name, type, value, "data-key": `ev-${name}`, ...extra });
  const e = editing;
  const title = input("title", "text", e?.title, { maxlength: "60", required: true });
  const date = input("date", "date", e?.date, { required: true });
  const start = input("start", "time", e?.start ?? "10:00", { required: true });
  const end = input("end", "time", e?.end ?? "");
  const note = input("note", "text", e?.note ?? "", { maxlength: "120" });
  const price = input("price", "text", e?.price === undefined ? "" : majorAmount(e.price, currency), {
    inputmode: "decimal",
  });
  const who = h(
    "select",
    { name: "audience", "data-key": "ev-audience" },
    h("option", { value: "all", selected: e?.audience !== "staff" }, te("eventWhoAll")),
    h("option", { value: "staff", selected: e?.audience === "staff" }, te("eventWhoStaff")),
  );
  const rush = h("input", { type: "checkbox", name: "rush", checked: e?.rush === true, "data-key": "ev-rush" });
  const days = WEEKDAYS.map((_, d) =>
    h("input", {
      type: "checkbox",
      name: `day-${d}`,
      checked: e?.repeat?.weekdays.includes(d) === true,
      "aria-label": dayName(d),
    }),
  );
  const until = input("until", "date", e?.repeat?.until ?? "");

  const save = async (ev: SubmitEvent) => {
    ev.preventDefault();
    error.textContent = "";
    const weekdays = days.flatMap((box, d) => (box.checked ? [d] : []));
    const priceMinor = price.value.trim() === "" ? undefined : parseMajor(price.value, currency);
    const body: Record<string, unknown> = {
      title: title.value,
      date: date.value,
      start: start.value,
      ...(end.value ? { end: end.value } : {}),
      ...(note.value.trim() ? { note: note.value } : {}),
      ...(priceMinor === undefined ? (price.value.trim() ? { price: price.value } : {}) : { price: priceMinor }),
      audience: who.value as EventInput["audience"],
      rush: rush.checked,
      ...(weekdays.length > 0 ? { repeat: { weekdays, ...(until.value ? { until: until.value } : {}) } } : {}),
    };
    try {
      if (e === undefined) await api("POST", "/api/events", { body });
      else await api("PUT", `/api/events/${e.id}`, { body });
      onEdit?.(undefined);
      redraw();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (id: number) => {
    error.textContent = "";
    try {
      await api("DELETE", `/api/events/${id}`);
      redraw();
    } catch (err) {
      fail(err);
    }
  };
  /** `2026-11-28` as people read it, "Sat, 28 Nov". The date is a calendar day, so it is read in UTC. */
  const dateName = (day: string) =>
    new Intl.DateTimeFormat(navigator.language, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(Date.parse(`${day}T00:00:00Z`));
  const confirmRemove = (x: CalendarEvent) =>
    void showDialog({
      icon: "party_popper",
      title: te("eventsDeleteTitle", { title: x.title }),
      body: h("p", {}, te("eventsDeleteBody")),
      actions: [
        { label: te("eventsDelete"), kind: "primary", onClick: () => void remove(x.id) },
        { label: te("eventsCancel"), kind: "ghost" },
      ],
      testid: "event-delete-dialog",
    });
  const when = (x: CalendarEvent) => {
    const time = x.end === undefined ? x.start : `${x.start}–${x.end}`;
    return x.repeat === undefined
      ? te("eventOnce", { day: dateName(x.date), time })
      : `${te("eventWeeklyOn", { days: x.repeat.weekdays.map(dayName).join(", ") })} · ${time}`;
  };

  return [
    error,
    events.length === 0 && h("p", { class: "empty" }, te("eventsNone")),
    events.length > 0 &&
      h(
        "ul",
        { class: "lines", "data-testid": "events-list" },
        ...events.map((x) =>
          // One row per event: what and when on the left, the two actions together on the right.
          h(
            "li",
            { class: "ev-item" },
            h(
              "span",
              { class: "ev-tx" },
              h("span", { class: "ev-title" }, x.title),
              h(
                "span",
                { class: "ev-when" },
                [
                  when(x),
                  x.audience === "staff" && te("eventStaffOnly"),
                  x.price !== undefined && formatPrice(x.price, currency),
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
              x.note !== undefined && h("span", { class: "ev-note" }, x.note),
            ),
            h(
              "span",
              { class: "ev-btns" },
              onEdit && button({ kind: "ghost", small: true, onClick: () => onEdit(x) }, te("eventsEdit")),
              button(
                { kind: "ghost", small: true, testid: `event-delete-${x.id}`, onClick: () => confirmRemove(x) },
                te("eventsDelete"),
              ),
            ),
          ),
        ),
      ),
    card(
      { class: "ev-form" },
      h(
        "form",
        { on: { submit: (ev) => void save(ev as SubmitEvent) }, "data-testid": "event-form" },
        field(te("eventTitle"), title),
        h(
          "div",
          { class: "ev-acts" },
          field(te("eventDate"), date),
          field(te("eventStart"), start),
          field(te("eventEnd"), end),
        ),
        field(te("eventNote"), note),
        h("div", { class: "ev-acts" }, field(te("eventPrice"), price), field(te("eventWho"), who)),
        h("label", { class: "ev-check" }, rush, te("eventRushFlag")),
        h(
          "fieldset",
          { class: "days" },
          h("legend", {}, te("eventRepeat")),
          ...days.map((box, d) => h("label", { class: "ev-check" }, box, dayName(d))),
        ),
        field(te("eventUntil"), until),
        h(
          "div",
          { class: "ev-acts" },
          button(
            { kind: "primary", type: "submit", testid: "event-save" },
            e === undefined ? te("eventsAdd") : te("eventsSave"),
          ),
          e !== undefined && onEdit && button({ kind: "ghost", onClick: () => onEdit(undefined) }, te("eventsCancel")),
        ),
      ),
    ),
  ];
}
