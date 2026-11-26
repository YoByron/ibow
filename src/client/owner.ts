/**
 * The owner's dashboard, its own page at `/owner` (owner PIN, server-side session): today's numbers and summary
 * (`#/`), the order tabs (`#/orders`), item availability (`#/items`), staff (`#/staff`) and reviews (`#/reviews`).
 * Its own bundle, so none of it reaches a customer's phone. Text only through the DOM helpers, never HTML strings.
 */

import type { CalendarEvent } from "../core/calendar.ts";
import type { Category, Zone } from "../core/config.ts";
import type { Report } from "../core/insights.ts";
import { formatPrice, formatWhole } from "../core/money.ts";
import { nameKey } from "../core/regulars.ts";
import { TINT_COUNT } from "../core/theme.ts";
import { dayKey, orderNumber } from "../core/tokens.ts";
import type { StaffOrderView } from "../core/views.ts";
import { ApiFailure, api } from "./api.ts";
import { demoNote } from "./demo-note.ts";
import { type Child, h, mount } from "./dom.ts";
import { eventCardSlot, showSplashEvent } from "./events.ts";
import { eventsBody } from "./events-editor.ts";
import { te } from "./events-strings.ts";
import { followStream, type OrderEvent } from "./live.ts";
import { appearanceView } from "./owner-appearance.ts";
import { spotsView } from "./owner-spots.ts";
import { t, tn } from "./owner-strings.ts";
import {
  axisTicks,
  chartBars,
  dayLabel,
  type Formatters,
  hourLabel,
  orderEventAction,
  paymentBadge,
  returningText,
  summaryText,
} from "./owner-view.ts";
import { roundButton, button as uiButton } from "./ui/button.ts";
import { appHeader } from "./ui/header.ts";
import { icon } from "./ui/icon.ts";
import { keypad } from "./ui/keypad.ts";
import { transition, watchBoot } from "./ui/shell.ts";
import { stat as uiStat } from "./ui/stat.ts";
import { FALLBACK, initMode, loadThemeInfo, type ThemeInfo, toggleMode, watchTheme } from "./ui/theme-client.ts";

watchBoot();
showSplashEvent();

interface OwnerCatalog {
  left?: Record<string, number>;
  business: { name: string; currency: string; timeZone: string };
  categories: Category[];
  zones?: Zone[];
}

type StaffRole = "counter" | "station" | "all" | "manager";

const root = document.getElementById("app") as HTMLElement;
const locale = navigator.language;
const cleanup: (() => void)[] = [];
let generation = 0;
let catalog: OwnerCatalog;
let theme: ThemeInfo = FALLBACK;

const money = (minor: number) => formatPrice(minor, catalog.business.currency, locale);
const whole = (minor: number) => formatWhole(minor, catalog.business.currency, locale);
const fmt: Formatters = { money, hour: (n) => hourLabel(n, locale), day: (d) => dayLabel(d, locale) };
const clock = (at: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: catalog.business.timeZone }).format(
    at,
  );
const date = (at: number) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: catalog.business.timeZone }).format(at);

function failureText(e: unknown): string {
  if (!(e instanceof ApiFailure)) return t("failed");
  if (e.code === "network") return t("offline");
  if (e.code === "bad_pin") return t("badPin");
  if (e.code === "rate_limited") return t("tooManyTries");
  return `${t("failed")} (${e.code})`;
}

function stop(): void {
  for (const fn of cleanup.splice(0)) fn();
}

const clockNow = () =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: catalog.business.timeZone }).format(
    Date.now(),
  );
/** Today's date in the business's own zone, as the header's subtitle shows it. */
const dateNow = () =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: catalog.business.timeZone,
  }).format(Date.now());
// One timer keeps every live pill on the page current.
setInterval(() => {
  for (const el of document.querySelectorAll(".live-clock")) el.textContent = t("liveAt", { time: clockNow() });
}, 30_000);

function page(...children: Child[]): void {
  const current = location.hash === "" ? "#/" : location.hash;
  const nav: [string, string, string][] = [
    ["#/", t("navToday"), "chart_increasing"],
    ["#/orders", t("navOrders"), "clipboard"],
    ["#/items", t("navItems"), "bento_box"],
    ["#/staff", t("navStaff"), "face_savoring_food"],
    ["#/reviews", t("navReviews"), "star"],
    ["#/events", t("navEvents"), "party_popper"],
    ...((catalog.zones?.length ?? 0) > 0 ? ([["#/spots", t("navSpots"), "ticket"]] as [string, string, string][]) : []),
    ["#/appearance", t("navAppearance"), "sparkles"],
  ];
  mount(
    root,
    h(
      "div",
      { class: "shell bare wide" },
      appHeader({
        title: catalog.business.name,
        subtitle: `${t("ownerDashboard")} · ${dateNow()}`,
        // The dashboard's edge is the dashed stripe in the header's own colours, not the storefront's scalloped awning.
        style: theme.header.style === "awning" ? "plain" : theme.header.style,
        logo: theme.logo,
        actions: [
          h("span", { class: "live-pill live-clock" }, t("liveAt", { time: clockNow() })),
          theme.features.darkToggle && roundButton(t("darkMode"), icon("crescent_moon"), () => void toggleMode()),
          roundButton(t("signOut"), icon("locked"), async () => {
            await api("POST", "/api/logout").catch(() => undefined);
            void start();
          }),
        ],
        below: h(
          "nav",
          { class: "owner-nav", "aria-label": t("ownerTitle") },
          ...nav.map(([href, label, ic]) =>
            h("a", { class: "chip", href, "aria-current": href === current ? "page" : undefined }, icon(ic), label),
          ),
        ),
      }),
      h("main", { class: "owner" }, ...children),
    ),
  );
}

function failed(e: unknown): void {
  if (e instanceof ApiFailure && e.status === 401) return void start();
  page(
    h("p", { class: "error", role: "alert" }, failureText(e)),
    h("button", { type: "button", class: "primary", on: { click: () => route() } }, t("retry")),
  );
}

// ── Sign in ────────────────────────────────────────────────────────────────────────────────────────────────────────

function loginView(): void {
  signedIn = false;
  const error = h("p", { class: "error", role: "alert" });
  const pin = h("input", {
    name: "pin",
    type: "password",
    inputmode: "numeric",
    autocomplete: "current-password",
    required: true,
  });
  const pad = keypad({
    max: 12,
    input: pin,
    labels: { clear: t("pinClear"), delete: t("pinDelete"), digit: (n) => n },
    onChange: () => {
      error.textContent = "";
    },
    onEnter: () => form.requestSubmit(),
  });
  const form = h(
    "form",
    { class: "login" },
    h("label", { class: "sr-only" }, t("pin"), pin),
    pad.el,
    uiButton({ kind: "accent", type: "submit" }, t("signIn")),
    error,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    try {
      await api("POST", "/api/login", { body: { user: "owner", pin: pin.value } });
      void start();
    } catch (err) {
      error.textContent = failureText(err);
      pad.clear();
    }
  });
  mount(
    root,
    h(
      "div",
      { class: "pin-screen" },
      theme.header.style === "awning" &&
        h("div", { class: "awning-wrap", "aria-hidden": "true" }, h("div", { class: "awning" })),
      h("span", { class: "logo" }, icon("locked")),
      h("h1", {}, catalog.business.name),
      h("p", { class: "sub" }, t("pinSubtitle")),
      form,
      demoNote("owner", (info) => {
        if (pad.value() === "") pad.fill(info.owner.pin);
        return undefined;
      }),
    ),
  );
}

// ── Today ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

/**
 * Orders by hour as plain SVG bars with a title on each, a labelled axis with round marks and the peak bar's count above
 * it. The peak is also a pill in the card's heading.
 */
function chart(report: Report): HTMLElement {
  const W = 640;
  const H = 180;
  const LEFT = 30;
  const bars = chartBars(report.hourly, W - LEFT, H);
  const peak = report.peak?.hour;
  const tallest = Math.max(1, ...bars.map((x) => x.orders));
  const ticks = axisTicks(tallest);
  const top = ticks.at(-1) ?? 1;
  // Bars are scaled to the tallest hour, so the marks are drawn on that scale too.
  const y = (n: number) => H - (n / tallest) * H;
  const step = Math.ceil(bars.length / 8);
  const label = t("chartLabel", { hour: peak === undefined ? "-" : fmt.hour(peak) });
  const drawing = svg(
    "svg",
    { viewBox: `0 -14 ${W} ${H + 52}`, role: "img", "aria-label": label, class: "chart" },
    ...ticks
      .filter((n) => n <= top && y(n) >= -1)
      .flatMap((n) => [
        svg("line", { x1: LEFT, x2: W, y1: y(n).toFixed(1), y2: y(n).toFixed(1), class: "grid" }),
        svg("text", { x: LEFT - 6, y: (y(n) + 4).toFixed(1), class: "axis" }, String(n)),
      ]),
    ...bars.map((b) =>
      svg(
        "rect",
        {
          x: (b.x + LEFT + b.width * 0.15).toFixed(1),
          y: b.y.toFixed(1),
          width: (b.width * 0.7).toFixed(1),
          height: b.height.toFixed(1),
          rx: 3,
          class: b.hour === peak ? "bar peak" : "bar",
          "data-hour": b.hour,
          "data-orders": b.orders,
        },
        svg("title", {}, tn("barLabel", b.orders, { hour: fmt.hour(b.hour), orders: String(b.orders) })),
      ),
    ),
    ...bars
      .filter((b) => b.hour === peak)
      .map((b) =>
        svg(
          "text",
          { x: (b.x + LEFT + b.width / 2).toFixed(1), y: (b.y - 6).toFixed(1), class: "peak-n" },
          String(b.orders),
        ),
      ),
    ...bars
      .filter((_, i) => i % step === 0)
      .map((b) =>
        svg("text", { x: (b.x + LEFT + b.width / 2).toFixed(1), y: H + 18, class: "tick" }, fmt.hour(b.hour)),
      ),
  );
  return h(
    "figure",
    { class: "chart-box" },
    h(
      "figcaption",
      {},
      t("chartTitle"),
      report.peak &&
        h(
          "span",
          { class: "chip accent" },
          t("peakPill", { hour: fmt.hour(report.peak.hour), orders: String(report.peak.orders) }),
        ),
    ),
    drawing,
  );
}

/** Today's ready-to-delivered waits, when staff have handed lines over: the minutes a ready dish stood before it was carried. */
interface Carry {
  lines: number;
  averageMs: number;
  maxMs: number;
}

function stat(
  label: string,
  value: string,
  testid: string,
  tone?: "accent" | "ok" | "warn",
  ...sub: Child[]
): HTMLElement {
  const glyph = {
    "stat-ordered": "shopping_cart",
    "stat-received": "money_bag",
    "stat-awaiting": "hourglass_not_done",
  }[testid];
  return uiStat({
    label,
    value,
    testid,
    ...(glyph ? { icon: icon(glyph) } : {}),
    ...(tone ? { tone } : {}),
    sub: sub.length === 0 ? undefined : sub,
  });
}

/** The icon of a catalog item for the top-items list: its own, else its category's. */
function itemTile(itemId: string, index: number): HTMLElement {
  const cat = catalog.categories.find((c) => c.items.some((i) => i.id === itemId));
  const own = cat?.items.find((i) => i.id === itemId)?.icon;
  const name = own ?? cat?.icon ?? "fork_and_knife_with_plate";
  const slot = Math.max(0, catalog.categories.indexOf(cat as Category)) % TINT_COUNT;
  void index;
  return h("span", { class: `pic xs t-${slot}` }, icon(name));
}

function changeChip(pct: number | null, say: (pct: string) => string): Child {
  if (pct === null) return null;
  const word = say(`${pct > 0 ? "+" : ""}${pct}`);
  return h(
    "span",
    { class: `chip ${pct > 0 ? "ok" : pct < 0 ? "warn" : ""}`.trim() },
    `${pct > 0 ? "▲" : pct < 0 ? "▼" : "■"} ${word}`,
  );
}

/** The most prep lines shown at once; the list is most needed first, so the rest is the long tail. */
const FORECAST_SHOWN = 12;

function todayView(report: Report, carry?: Carry, rooms?: { open: number; totalMinor: number }): void {
  const c = report.comparison;
  const tot = report.totals;
  const f = report.forecast;
  const topQty = report.popular.byQty.slice(0, 5);
  const widest = topQty[0]?.qty || 1;
  const split =
    tot.receivedCashMinor > 0 || tot.receivedUpiMinor > 0 || tot.receivedCardMinor > 0
      ? tot.receivedCardMinor === 0
        ? t("cashUpi", { cash: money(tot.receivedCashMinor), upi: money(tot.receivedUpiMinor) })
        : t("cashUpiCard", {
            cash: money(tot.receivedCashMinor),
            upi: money(tot.receivedUpiMinor),
            card: money(tot.receivedCardMinor),
          })
      : undefined;
  const splitBar = h(
    "div",
    { class: "split", "aria-hidden": "true" },
    h("i", { class: "cash" }),
    h("i", { class: "upi" }),
    h("i", { class: "card" }),
  );
  const mixTotal = tot.receivedCashMinor + tot.receivedUpiMinor + tot.receivedCardMinor;
  if (mixTotal > 0) {
    (splitBar.children[0] as HTMLElement).style.flexGrow = String(tot.receivedCashMinor);
    (splitBar.children[1] as HTMLElement).style.flexGrow = String(tot.receivedUpiMinor);
    (splitBar.children[2] as HTMLElement).style.flexGrow = String(tot.receivedCardMinor);
  }
  page(
    eventCardSlot(),
    h(
      "div",
      { class: "dash" },
      h(
        "div",
        { class: "dash-main" },
        h(
          "div",
          { class: "tiles" },
          stat(
            t("statOrdered"),
            money(tot.orderedMinor),
            "stat-ordered",
            undefined,
            h(
              "span",
              { "data-testid": "stat-orders" },
              tn("ordersAverage", tot.orders, { orders: String(tot.orders), average: whole(tot.averageMinor) }),
            ),
            h(
              "div",
              {},
              changeChip(c.ordersChangePct, (pct) => t("vsYesterday", { pct })),
            ),
            h(
              "div",
              { class: "muted" },
              tn("yesterdayWhole", c.yesterday.orders, {
                orders: String(c.yesterday.orders),
                amount: money(c.yesterday.orderedMinor),
              }),
            ),
          ),
          stat(
            t("statReceived"),
            money(tot.receivedMinor),
            "stat-received",
            "ok",
            split && h("span", {}, split),
            mixTotal > 0 && splitBar,
            h(
              "div",
              {},
              changeChip(c.receivedChangePct, (pct) => t("vsYesterdayReceived", { pct })),
            ),
          ),
          h(
            "div",
            { class: "tile-wrap" },
            stat(
              t("statAwaiting"),
              money(tot.awaitingMinor),
              "stat-awaiting",
              tot.awaitingOrders > 0 ? "warn" : undefined,
              tn("awaitingCount", tot.awaitingOrders, { n: String(tot.awaitingOrders) }),
              tot.awaitingOrders > 0 && h("a", { class: "btn btn-accent sm review", href: "#/orders" }, t("review")),
            ),
          ),
        ),
        rooms !== undefined &&
          h(
            "div",
            { class: "tile-wrap" },
            stat(
              t("statRoomBills"),
              money(rooms.totalMinor),
              "stat-room-bills",
              undefined,
              tn("roomBillsCount", rooms.open, { n: String(rooms.open) }),
            ),
          ),
        carry !== undefined &&
          h(
            "div",
            { class: "tile-wrap" },
            stat(
              t("statCarry"),
              t("minutes", { n: (Math.round(carry.averageMs / 6000) / 10).toString() }),
              "stat-carry",
              carry.maxMs > 10 * 60_000 ? "warn" : undefined,
              t("carrySub", { n: String(carry.lines), max: String(Math.round(carry.maxMs / 60_000)) }),
            ),
          ),
        chart(report),
        h(
          "section",
          { class: "insight", "data-testid": "summary" },
          h("span", { class: "spark" }, icon("sparkles")),
          h(
            "div",
            {},
            h("h2", {}, t("summaryTitle")),
            h("ul", { class: "plain" }, ...report.summary.map((fact) => h("li", {}, summaryText(fact, fmt)))),
          ),
        ),
        h(
          "section",
          { class: "forecast-card", "data-testid": "forecast" },
          h("h2", {}, t("forecastTitle", { day: fmt.day(f.day) })),
          h(
            "p",
            { class: "hint" },
            f.basis === "none" ? t("forecastNone") : f.basis === "recent" ? t("forecastRecentRule") : t("forecastRule"),
          ),
          h(
            "ol",
            { class: "plain" },
            ...f.lines
              .slice(0, FORECAST_SHOWN)
              .map((l) =>
                h(
                  "li",
                  {},
                  t("qtyName", { qty: String(l.qty), name: l.size === undefined ? l.name : `${l.name} ${l.size}` }),
                ),
              ),
          ),
          f.lines.length > FORECAST_SHOWN &&
            h(
              "p",
              { class: "hint" },
              tn("forecastMore", f.lines.length - FORECAST_SHOWN, { n: String(f.lines.length - FORECAST_SHOWN) }),
            ),
        ),
      ),
      h(
        "aside",
        { class: "dash-side" },
        h(
          "section",
          { class: "side-card" },
          h("div", { class: "bill" }, h("h2", {}, t("topItems")), h("small", { class: "muted" }, t("topItemsHint"))),
          h(
            "ol",
            { class: "plain top ranked" },
            ...topQty.map((s, i) => {
              const fill = h("i");
              fill.style.width = `${Math.round((s.qty / widest) * 100)}%`;
              return h(
                "li",
                {},
                h("span", { class: "rank" }, String(i + 1)),
                itemTile(s.itemId, i),
                h(
                  "div",
                  { class: "grow" },
                  h("b", {}, s.name),
                  h("div", { class: "bar", "aria-hidden": "true" }, fill),
                ),
                h(
                  "div",
                  { class: "qv" },
                  h("b", { class: "num" }, String(s.qty)),
                  h("small", {}, money(s.orderedMinor)),
                ),
              );
            }),
          ),
        ),
        h(
          "section",
          { class: "side-card" },
          h(
            "div",
            { class: "bill" },
            h("h2", {}, t("popularValue")),
            h("small", { class: "muted" }, t("topValueHint")),
          ),
          h(
            "ol",
            { class: "plain top ranked" },
            ...report.popular.byValue.slice(0, 5).map((s, i) => {
              const fill = h("i");
              fill.style.width = `${Math.round((s.orderedMinor / (report.popular.byValue[0]?.orderedMinor || 1)) * 100)}%`;
              return h(
                "li",
                {},
                h("span", { class: "rank" }, String(i + 1)),
                itemTile(s.itemId, i),
                h(
                  "div",
                  { class: "grow" },
                  h("b", {}, s.name),
                  h("div", { class: "bar", "aria-hidden": "true" }, fill),
                ),
                h(
                  "div",
                  { class: "qv" },
                  h("b", { class: "num" }, money(s.orderedMinor)),
                  h("small", {}, t("unitsSold", { n: String(s.qty) })),
                ),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

async function today(): Promise<void> {
  const gen = generation;
  const load = async () => {
    const r = await api<{ report: Report; carry?: Carry; rooms?: { open: number; totalMinor: number } }>(
      "GET",
      "/api/owner/insights",
    );
    if (gen === generation) todayView(r.report, r.carry, r.rooms);
  };
  await load();
  // Numbers move during the day; five minutes is fresh enough, and only while the tab is in view (every refresh reads
  // two days of orders on the server, and only after a change: D-044). Coming back to the tab refreshes at once if it has gone stale.
  let loadedAt = Date.now();
  const refresh = () => {
    loadedAt = Date.now();
    void load().catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 300_000);
  const onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - loadedAt > 60_000) refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  cleanup.push(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });
}

// ── Orders ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Tab = "pending" | "preparing" | "completed";
let tab: Tab = "pending";

async function orders(): Promise<void> {
  const gen = generation;
  const snap = await api<{
    day: string;
    orders: StaffOrderView[];
    regulars: Record<string, number>;
    lastEventId: number;
  }>("GET", "/api/owner/orders");
  if (gen !== generation) return;
  const list = new Map(snap.orders.map((o) => [o.id, o]));

  const card = (o: StaffOrderView) => {
    const badge = o.customerName === undefined ? undefined : returningText(snap.regulars[nameKey(o.customerName)]);
    const pay = paymentBadge(o, money);
    return h(
      "article",
      { class: "order-card", "data-testid": `order-${o.token}` },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "token" }, orderNumber(o.token)),
        h("span", {}, clock(o.createdAt)),
        o.customerName !== undefined && h("strong", {}, o.customerName),
        badge !== undefined && h("span", { class: "badge returning" }, badge),
      ),
      h(
        "ul",
        { class: "plain" },
        ...o.lines.map((l) =>
          h(
            "li",
            {},
            t("qtyName", { qty: String(l.qty), name: l.size === undefined ? l.name : `${l.name} ${l.size}` }),
          ),
        ),
      ),
      h(
        "p",
        { class: "row" },
        h("strong", {}, money(o.totalMinor)),
        h("span", { class: `pay-badge pay-${pay.kind}`, "data-testid": "payment" }, pay.text),
      ),
    );
  };

  const render = () => {
    const all = [...list.values()];
    const count = (s: Tab) => all.filter((o) => o.status === s).length;
    const button = (s: Tab, label: string) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          "aria-pressed": String(tab === s),
          on: {
            click: () => {
              tab = s;
              render();
            },
          },
        },
        label,
      );
    const shown = all.filter((o) => o.status === tab);
    if (tab === "completed") shown.reverse();
    page(
      h(
        "div",
        { class: "chips", role: "group" },
        button("pending", t("tabPending", { n: String(count("pending")) })),
        button("preparing", t("tabPreparing", { n: String(count("preparing")) })),
        button("completed", t("tabCompleted", { n: String(count("completed")) })),
      ),
      ...(shown.length === 0 ? [h("p", { class: "empty" }, t("noOrders"))] : shown.map(card)),
    );
  };
  render();

  const unfollow = followStream<StaffOrderView>({
    stream: "/api/stream/owner",
    poll: "/api/poll/owner",
    after: snap.lastEventId,
    onEvent: (e: OrderEvent<StaffOrderView>) => {
      const action = orderEventAction(snap.day, dayKey(e.order.createdAt, catalog.business.timeZone));
      if (action === "reload") return route();
      if (action === "ignore") return;
      list.set(e.order.id, e.order);
      render();
    },
  });
  // A quiet midnight brings no event: check the business day every minute and start the new day's tabs.
  const midnight = setInterval(() => {
    if (orderEventAction(snap.day, dayKey(Date.now(), catalog.business.timeZone)) === "reload") route();
  }, 60_000);
  cleanup.push(unfollow, () => clearInterval(midnight));
}

// ── Items ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Events tab: the business's events, for guests or staff only (D-084). */
async function eventsTab(): Promise<void> {
  const gen = generation;
  const error = h("p", { class: "error", role: "alert" });
  let editing: CalendarEvent | undefined;
  const draw = async () => {
    const body = await eventsBody(
      catalog.business.currency,
      () => void draw().catch(failed),
      (e) => {
        error.textContent = failureText(e);
      },
      error,
      editing,
      (e) => {
        editing = e;
        void draw().catch(failed);
      },
    );
    if (gen === generation) page(h("h2", {}, te("eventsTitle")), h("p", { class: "muted" }, te("eventsSub")), ...body);
  };
  await draw();
}

async function items(): Promise<void> {
  const gen = generation;
  // Fresh, so a switch made on another device shows here.
  catalog = await api<OwnerCatalog>("GET", "/api/catalog");
  if (gen !== generation) return;
  const error = h("p", { class: "error", role: "alert" });
  const toggle = (item: Category["items"][number]) => {
    const on = () => item.available !== false;
    const b = h(
      "button",
      {
        type: "button",
        class: "switch",
        role: "switch",
        "aria-checked": String(on()),
        "aria-label": t("itemSwitch", { name: item.name }),
        "data-item": item.id,
      },
      on() ? t("itemOn") : t("itemOff"),
    );
    b.addEventListener("click", async () => {
      b.disabled = true;
      error.textContent = "";
      try {
        const r = await api<{ available: boolean }>("PUT", `/api/owner/items/${encodeURIComponent(item.id)}`, {
          body: { available: !on() },
        });
        item.available = r.available;
        b.setAttribute("aria-checked", String(on()));
        b.textContent = on() ? t("itemOn") : t("itemOff");
      } catch (e) {
        error.textContent = failureText(e);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };
  /** A count for today, set each morning: it goes down with every order and sells the item out at zero. */
  const counter = (item: Category["items"][number]) => {
    const input = h("input", {
      type: "number",
      min: "0",
      step: "1",
      inputmode: "numeric",
      class: "count",
      placeholder: t("itemCountPlaceholder"),
      "aria-label": t("itemCountLabel", { name: item.name }),
      "data-count": item.id,
      value: catalog.left?.[item.id] === undefined ? "" : String(catalog.left[item.id]),
    }) as HTMLInputElement;
    const set = h("button", { type: "button", "data-count-set": item.id }, t("itemCountSet"));
    set.addEventListener("click", async () => {
      set.disabled = true;
      error.textContent = "";
      try {
        const text = input.value.trim();
        await api("PUT", `/api/owner/items/${encodeURIComponent(item.id)}`, {
          body: { count: text === "" ? null : Number(text) },
        });
      } catch (e) {
        error.textContent = failureText(e);
      } finally {
        set.disabled = false;
      }
    });
    return h("span", { class: "count-set" }, input, set);
  };
  page(
    h("p", { class: "hint" }, t("itemsHint")),
    error,
    ...catalog.categories.map((c) =>
      h(
        "section",
        {},
        h("h2", {}, c.name),
        h(
          "ul",
          { class: "plain switches" },
          ...c.items.map((item) =>
            h("li", { class: "row" }, h("span", { class: "line-name" }, item.name), counter(item), toggle(item)),
          ),
        ),
      ),
    ),
  );
}

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function roleText(role: StaffRole): string {
  if (role === "manager") return t("roleManager");
  return role === "all" ? t("roleAll") : role === "counter" ? t("roleCounter") : t("roleStation");
}

async function staff(): Promise<void> {
  const gen = generation;
  const { staff: members } = await api<{ staff: { id: string; name: string; role: StaffRole }[] }>("GET", "/api/staff");
  if (gen !== generation) return;
  const error = h("p", { class: "error", role: "alert" });
  const id = h("input", {
    name: "id",
    type: "text",
    autocapitalize: "none",
    required: true,
    // Browsers compile `pattern` with the `v` flag, where a literal dash in a class must be escaped.
    pattern: "[a-z0-9][a-z0-9\\-]{0,39}",
  });
  const name = h("input", { name: "name", type: "text", required: true, maxlength: 60 });
  const pin = h("input", {
    name: "pin",
    type: "password",
    inputmode: "numeric",
    required: true,
    pattern: "[0-9]{4,12}",
  });
  const role = h(
    "select",
    { name: "role" },
    ...(["all", "counter", "station", "manager"] as const).map((r) => h("option", { value: r }, roleText(r))),
  );
  const form = h(
    "form",
    { class: "login" },
    h("label", {}, t("staffId"), id),
    h("label", {}, t("staffName"), name),
    h("label", {}, t("staffPin"), pin),
    h("label", {}, t("staffRole"), role),
    h("button", { type: "submit", class: "primary" }, t("saveStaff")),
    error,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    try {
      await api("PUT", `/api/staff/${encodeURIComponent(id.value.trim())}`, {
        body: { name: name.value.trim(), pin: pin.value, role: role.value },
      });
      await staff();
    } catch (err) {
      error.textContent = failureText(err);
    }
  });
  page(
    h("p", { class: "hint" }, t("staffHint")),
    members.length === 0
      ? h("p", { class: "empty" }, t("noStaff"))
      : h(
          "ul",
          { class: "plain", "data-testid": "staff-list" },
          ...members.map((m) =>
            h(
              "li",
              { class: "row" },
              h("span", {}, t("staffLine", { name: m.name, id: m.id, role: roleText(m.role) })),
              h(
                "button",
                {
                  type: "button",
                  class: "link",
                  on: {
                    click: () => {
                      id.value = m.id;
                      name.value = m.name;
                      role.value = m.role;
                      pin.focus();
                    },
                  },
                },
                t("editStaff", { name: m.name }),
              ),
            ),
          ),
        ),
    form,
  );
}

// ── Reviews ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function reviews(): Promise<void> {
  const gen = generation;
  const r = await api<{
    reviews: { token: string; rating: number; text?: string; at: number }[];
    count: number;
    averageRating: number | null;
  }>("GET", "/api/owner/reviews");
  if (gen !== generation) return;
  const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  page(
    r.averageRating === null
      ? h("p", { class: "empty" }, t("noReviews"))
      : h(
          "p",
          { class: "lead" },
          tn("reviewAverage", r.count, { average: one.format(r.averageRating), count: String(r.count) }),
        ),
    h(
      "ul",
      { class: "plain reviews" },
      ...r.reviews.map((x) =>
        h(
          "li",
          { class: "order-card" },
          h(
            "div",
            { class: "card-head" },
            h(
              "span",
              { class: "stars-text", "aria-label": t("reviewStars", { rating: String(x.rating) }) },
              "★".repeat(x.rating) + "☆".repeat(5 - x.rating),
            ),
            h("span", {}, t("reviewToken", { token: x.token, date: date(x.at) })),
          ),
          x.text !== undefined && h("p", {}, x.text),
        ),
      ),
    ),
  );
}

// ── Routing and start ──────────────────────────────────────────────────────────────────────────────────────────────

function route(): void {
  generation++;
  stop();
  const hash = location.hash;
  const run =
    hash === "#/orders"
      ? orders()
      : hash === "#/items"
        ? items()
        : hash === "#/staff"
          ? staff()
          : hash === "#/reviews"
            ? reviews()
            : hash === "#/events"
              ? eventsTab()
              : hash === "#/spots"
                ? spotsView(page, catalog.business.name, catalog.zones ?? [], t)
                : hash === "#/appearance"
                  ? appearanceView(page, failureText)
                  : today();
  run.catch(failed);
}

async function start(): Promise<void> {
  stop();
  initMode();
  try {
    catalog = await api<OwnerCatalog>("GET", "/api/catalog");
    theme = await loadThemeInfo();
    watchTheme(theme, (next) => {
      theme = next;
    });
    document.title = `${t("ownerTitle")} · ${catalog.business.name}`;
    try {
      const me = await api<{ role: string }>("GET", "/api/me");
      if (me.role !== "owner") return loginView();
      signedIn = true;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) return loginView();
      throw e;
    }
    route();
  } catch (e) {
    mount(
      root,
      h("p", { class: "error" }, failureText(e)),
      h("button", { type: "button", class: "primary", on: { click: () => void start() } }, t("retry")),
    );
  }
}

/** Set once `/api/me` says owner: until then a link to a screen (`#/spots`) shows the PIN, not the screen. */
let signedIn = false;
window.addEventListener("hashchange", () => {
  if (signedIn) transition(() => route());
});
void start();
