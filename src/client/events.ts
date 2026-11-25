/**
 * The business's events on every page (D-085): a banner on the splash, a card at the top of the staff, manager, owner and
 * hub screens, and a slim dismissible banner for guests. One fetch of `/api/events` per page; the server sends guests only
 * guest events. On the event's day the banner celebrates (a CSS-only burst, `ui/events.css`) and counts down to its start.
 */

import { formatPrice } from "../core/money.ts";
import { api, serverNow } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./strings.ts";
import { holdSplash } from "./ui/shell.ts";

export interface EventOccurrence {
  id: number;
  title: string;
  day: string;
  start: string;
  end?: string;
  note?: string;
  audience: "all" | "staff";
  rush: boolean;
  repeat?: { weekdays: number[]; until?: string };
  price?: number;
  inDays: number;
  startsInMinutes?: number;
}

export interface EventList {
  timeZone: string;
  currency?: string;
  events: EventOccurrence[];
  /** When the list was read, by the server's clock, so a countdown moves on from there. */
  readAt: number;
}

const BURST = 14;
const SPLASH_HOLD_MS = 2000;

let loaded: Promise<EventList> | undefined;

/** The coming week's events this page may show, read once per page; an error shows nothing rather than failing a screen. */
export function loadEvents(): Promise<EventList> {
  loaded ??= api<Omit<EventList, "readAt">>("GET", "/api/events")
    .then((r) => ({ ...r, readAt: serverNow() }))
    .catch(() => ({ timeZone: "UTC", events: [], readAt: serverNow() }));
  return loaded;
}

/** Forgets the list, so a sign-in (which may add staff-only events) reads it again. */
export function reloadEvents(): void {
  loaded = undefined;
}

/** "Sat" for a YYYY-MM-DD day, in the browser's language. */
function weekday(day: string): string {
  return new Intl.DateTimeFormat(navigator.language, { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

/** "2 h 15 min", "40 min". */
function span(min: number): string {
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours === 0) return t("eventMinutes", { m: String(rest) });
  return rest === 0
    ? t("eventHours", { h: String(hours) })
    : t("eventHoursMinutes", { h: String(hours), m: String(rest) });
}

/** When, as a banner says it: "Today · starts in 2 h", "Tomorrow · 10:00", "In 3 days · Sat 10:00". */
export function whenText(e: EventOccurrence, list: Pick<EventList, "readAt">, at = serverNow()): string {
  if (e.inDays === 0) {
    const left = (e.startsInMinutes ?? 0) - Math.floor((at - list.readAt) / 60_000);
    return left > 0
      ? `${t("eventToday")} · ${t("eventStartsIn", { time: span(left) })}`
      : `${t("eventToday")} · ${t("eventOnNow")}`;
  }
  const time = e.end === undefined ? e.start : `${e.start}–${e.end}`;
  if (e.inDays === 1) return `${t("eventTomorrow")} · ${time}`;
  return `${t("eventInDays", { n: String(e.inDays) })} · ${weekday(e.day)} ${time}`;
}

/**
 * One event as a banner: title, when, the note and price, "Expect a rush" for staff when flagged. `kind` picks the look:
 * the splash's, a card at the top of a screen, or the guests' slim line. On its day it gets the celebration.
 */
export function eventBanner(
  e: EventOccurrence,
  list: EventList,
  kind: "splash" | "card" | "guest",
  onDismiss?: () => void,
): HTMLElement {
  const when = h("span", { class: "ev-when" }, whenText(e, list));
  const today = e.inDays === 0;
  const price = e.price !== undefined && list.currency !== undefined ? formatPrice(e.price, list.currency) : undefined;
  const extra = [e.note, price].filter((x) => x !== undefined && x !== "").join(" · ");
  const el = h(
    "div",
    {
      class: `ev ev-${kind}${today ? " is-today" : ""}`,
      role: kind === "splash" ? undefined : "status",
      "data-testid": `event-${kind}`,
    },
    today && h("span", { class: "ev-burst", "aria-hidden": "true" }, ...Array.from({ length: BURST }, () => h("i"))),
    h(
      "span",
      { class: "ev-tx" },
      h("b", { class: "ev-title" }, e.title),
      when,
      extra !== "" && h("small", { class: "ev-note" }, extra),
    ),
    e.rush && kind !== "guest" && h("span", { class: "ev-rush" }, t("eventRush")),
    e.repeat !== undefined && kind !== "splash" && h("span", { class: "ev-weekly" }, t("eventWeekly")),
    onDismiss &&
      h("button", { type: "button", class: "ev-x", "aria-label": t("eventDismiss"), on: { click: onDismiss } }, "×"),
  );
  // The countdown moves while the banner is on the page; it stops by itself once the banner is gone.
  if (today) {
    const tick = setInterval(() => {
      if (!el.isConnected && kind !== "splash") return clearInterval(tick);
      when.textContent = whenText(e, list);
    }, 30_000);
  }
  return el;
}

/** The next event on the splash, which then stays a moment longer so it can be read. */
export function showSplashEvent(): void {
  const host = document.querySelector("#splash .splash-in");
  if (host === null) return;
  holdSplash(SPLASH_HOLD_MS);
  void loadEvents().then((list) => {
    const next = list.events[0];
    if (next === undefined) return holdSplash(0);
    host.append(eventBanner(next, list, "splash"));
  });
}

/** A card for the next event, filled in once the list is read; empty (and taking no room) when there is none. */
export function eventCardSlot(): HTMLElement {
  const slot = h("div", { class: "ev-slot" });
  void loadEvents().then((list) => {
    const next = list.events[0];
    if (next !== undefined) slot.replaceChildren(eventBanner(next, list, "card"));
  });
  return slot;
}

const dismissedKey = (e: EventOccurrence) => `ibow.event.${e.id}.${e.day}`;

/** The guests' slim banner under the header: the next guest event, until they dismiss it for this occurrence. */
export function guestEventSlot(store?: Pick<Storage, "getItem" | "setItem">): HTMLElement {
  const slot = h("div", { class: "ev-slot" });
  void loadEvents().then((list) => {
    const next = list.events.find((e) => {
      try {
        return store?.getItem(dismissedKey(e)) !== "1";
      } catch {
        return true;
      }
    });
    if (next === undefined) return;
    slot.replaceChildren(
      eventBanner(next, list, "guest", () => {
        try {
          store?.setItem(dismissedKey(next), "1");
        } catch {
          // a private window: hidden for now, shown again next visit
        }
        slot.replaceChildren();
      }),
    );
  });
  return slot;
}

/** A line on the order page: "While you're here: Flea market, Today · starts in 2 h". */
export function eventLineSlot(): HTMLElement {
  const slot = h("p", { class: "ev-line" });
  void loadEvents().then((list) => {
    const next = list.events[0];
    if (next !== undefined) slot.textContent = t("eventOrderLine", { title: next.title, when: whenText(next, list) });
  });
  return slot;
}
