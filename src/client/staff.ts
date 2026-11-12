/**
 * The staff screens, one page at `/staff`: sign in, then the counter (`#/counter`) or one station (`#/station/<id>`).
 * Built for one hand on a cheap phone: big targets, one column, and anything staff must act on can also be spoken.
 */

import {
  BATCH_TEMPLATES,
  type BatchTemplate,
  displayBatch,
  groupBatch,
  openBatch,
  renderBatch,
} from "../core/batches.ts";
import type { CatalogItem, StationView } from "../core/config.ts";
import { formatMoney, formatPrice } from "../core/money.ts";
import { isReady, UNDO_WINDOW_MS } from "../core/orders.ts";
import type { PaymentMethod } from "../core/payments.ts";
import type { StaffOrderView, StationLine, StationOrderView } from "../core/views.ts";
import { announce, primeSound } from "./alerts.ts";
import { ApiFailure, api } from "./api.ts";
import { addOne, type Cart, cartTotal, itemCount, qtyOf, setQty } from "./cart.ts";
import { cashOptions, changeDue } from "./cash.ts";
import { findItem, priceOf, type StoreCatalog, visibleCategories } from "./catalog.ts";
import { demoNote } from "./demo-note.ts";
import { type Child, h, mount } from "./dom.ts";
import { followStream, type OrderEvent } from "./live.ts";
import { printTickets, type Ticket } from "./print.ts";
import { qrSvg } from "./qr.ts";
import { newClientKey, tabStore } from "./session.ts";
import { t } from "./staff-strings.ts";
import { lang } from "./strings.ts";
import { roundButton, button as uiButton } from "./ui/button.ts";
import { appHeader } from "./ui/header.ts";
import { icon, iconRef } from "./ui/icon.ts";
import { keypad } from "./ui/keypad.ts";
import { stat } from "./ui/stat.ts";
import { FALLBACK, initMode, loadThemeInfo, type ThemeInfo, toggleMode, watchTheme } from "./ui/theme-client.ts";
import { browserVoice } from "./voice.ts";

interface StaffCatalog extends StoreCatalog {
  business: StoreCatalog["business"] & { timeZone: string; cashShortcutsMinor?: number[] };
}

interface StationInfo {
  id: string;
  name: string;
  view: StationView;
  speak: boolean;
  print: "ticket-80mm" | null;
}

const root = document.getElementById("app") as HTMLElement;
const locale = navigator.language;
const template = BATCH_TEMPLATES[lang] as BatchTemplate;
const voice = browserVoice(tabStore(localStorageOrUndefined()), lang);
const cleanup: (() => void)[] = [];
let generation = 0;
let catalog: StaffCatalog;
let theme: ThemeInfo = FALLBACK;
let stations: StationInfo[] = [];
/** What this staff member may open: station staff see only stations. */
let access: "counter" | "station" | "all" = "all";

function localStorageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const money = (minor: number) => formatPrice(minor, catalog.business.currency, locale);
/** The change to hand back keeps every digit. */
const exactMoney = (minor: number) => formatMoney(minor, catalog.business.currency, locale);
const price = (itemId: string, size?: string) => priceOf(catalog.categories, itemId, size);
const max = () => catalog.business.maxQtyPerLine;
const stationName = (id: string) => stations.find((s) => s.id === id)?.name ?? id;
const lineText = (l: { qty: number; name: string; size?: string }) =>
  t("lineQty", { qty: String(l.qty), name: l.size === undefined ? l.name : `${l.name} (${l.size})` });

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

/** Re-render keeps focus on the control that had it, found again by its `data-key`. */
function keepFocus(render: () => void): void {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.key;
  render();
  if (key !== undefined) (root.querySelector(`[data-key="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus();
}

/** A button that reports a failure in `error` and stays disabled while its call runs. */
function action(label: string, key: string, run: () => Promise<unknown>, error: HTMLElement, cls = ""): HTMLElement {
  const b = h("button", { type: "button", class: cls, "data-key": key }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    error.textContent = "";
    try {
      await run();
    } catch (e) {
      error.textContent = failureText(e);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** Sets the accessible name of a button whose visible text is a symbol. */
function labelled(name: string, button: HTMLElement): HTMLElement {
  button.setAttribute("aria-label", name);
  return button;
}

function header(title: string, subtitle?: string): HTMLElement {
  const mute = h(
    "button",
    {
      type: "button",
      class: "rbtn",
      "aria-label": t("muteVoice"),
      "aria-pressed": String(voice.muted()),
      on: {
        click: () => {
          voice.setMuted(!voice.muted());
          mute.setAttribute("aria-pressed", String(voice.muted()));
        },
      },
    },
    icon("speaker_high_volume"),
  );
  const rate = h(
    "select",
    { "aria-label": t("speechRate"), on: { change: () => voice.setRate(Number(rate.value)) } },
    ...[0.75, 1, 1.25, 1.5].map((r) => h("option", { value: String(r), selected: voice.rate() === r }, `${r}×`)),
  );
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: catalog.business.timeZone,
  }).format(Date.now());
  return appHeader({
    title,
    titleHref: "#/",
    subtitle: subtitle ?? `${catalog.business.name} · ${day}`,
    style: theme.header.style,
    logo: theme.logo,
    actions: [
      h("span", { class: "voice" }, mute, rate),
      theme.features.darkToggle && roundButton(t("darkMode"), icon("crescent_moon"), () => void toggleMode()),
      roundButton(t("signOut"), icon("locked"), async () => {
        await api("POST", "/api/logout").catch(() => undefined);
        location.hash = "#/";
        void start();
      }),
    ],
  });
}

/**
 * Browsers let a page play sound and speech only after a tap on it, so a screen opened straight from a link or a
 * reload mid-shift asks for one tap first. Tracked here rather than with `navigator.userActivation`, which some
 * browsers lack and headless ones report as already active.
 */
let tapped = false;
for (const type of ["pointerdown", "keydown"]) {
  window.addEventListener(
    type,
    () => {
      tapped = true;
    },
    { capture: true },
  );
}

function startGate(then: () => void): void {
  if (tapped) {
    then();
    return;
  }
  mount(
    root,
    h(
      "main",
      { class: "gate" },
      uiButton(
        {
          kind: "primary",
          onClick: () => {
            primeSound();
            then();
          },
        },
        t("startShift"),
      ),
    ),
  );
}

// ── Sign in and choose a screen ────────────────────────────────────────────────────────────────────────────────────

function loginView(): void {
  const error = h("p", { class: "error", role: "alert" });
  const user = h("input", { name: "user", autocomplete: "username", autocapitalize: "none", required: true });
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
    h("label", {}, t("staffUser"), user),
    h("label", { class: "sr-only" }, t("pin"), pin),
    pad.el,
    uiButton({ kind: "accent", type: "submit" }, t("signIn")),
    error,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    primeSound();
    error.textContent = "";
    try {
      await api("POST", "/api/login", { body: { user: user.value.trim(), pin: pin.value } });
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
      h("span", { class: "logo" }, icon("teacup_without_handle")),
      h("h1", {}, catalog.business.name),
      h("p", { class: "sub" }, t("pinSubtitle")),
      form,
      demoNote("staff"),
    ),
  );
}

function chooserView(): void {
  mount(
    root,
    header(catalog.business.name),
    h(
      "main",
      { class: "chooser" },
      h("h2", {}, t("chooseScreen")),
      access !== "station" && h("a", { class: "button primary", href: "#/counter" }, t("counterTitle")),
      ...stations.map((s) =>
        h("a", { class: "button secondary", href: `#/station/${encodeURIComponent(s.id)}` }, s.name),
      ),
    ),
  );
}

// ── Counter ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Tab = "pending" | "preparing" | "ready";

function tabOf(o: StaffOrderView): Tab {
  if (isReady(o)) return "ready";
  return o.status === "pending" ? "pending" : "preparing";
}

function receipt(o: StaffOrderView): Ticket {
  const paid = o.payment.state === "confirmed" ? o.payment.amountMinor : 0;
  return {
    kind: "receipt",
    business: catalog.business.name,
    token: o.token,
    at: o.createdAt,
    timeZone: catalog.business.timeZone,
    ...(o.customerName === undefined ? {} : { customerName: o.customerName }),
    lines: o.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      unitMinor: l.unitMinor,
      ...(l.size === undefined ? {} : { size: l.size }),
    })),
    money: {
      currency: o.currency,
      totalMinor: o.totalMinor,
      paidMinor: paid,
      dueMinor: Math.max(0, o.outstandingMinor),
    },
  };
}

/** The quick-order panel: a walk-in's new order, or staff adding lines to an open one. */
interface Quick {
  addTo?: StaffOrderView;
  cart: Cart;
  categoryId?: string;
  step: "pick" | "cash" | "upi";
  received?: number;
  /** The walk-in order once created, so a retried payment can't create it twice. */
  created?: { order: StaffOrderView; key: string };
  clientKey: string;
}

async function counterView(): Promise<void> {
  const gen = ++generation;
  const snap = await api<{ orders: StaffOrderView[]; lastEventId: number }>("GET", "/api/orders");
  if (gen !== generation) return;
  const orders = new Map(snap.orders.map((o) => [o.id, o]));
  /** Completed in the last 5 minutes, so a wrong "collected" can be undone. */
  const recent = new Map<string, StaffOrderView>();
  let tab: Tab = "pending";
  let cashFor: { id: string; received?: number } | undefined;
  let quick: Quick | undefined;
  const error = h("p", { class: "error", role: "alert" });

  const apply = (o: StaffOrderView) => {
    if (o.status === "completed") {
      orders.delete(o.id);
      recent.set(o.id, o);
    } else {
      recent.delete(o.id);
      orders.set(o.id, o);
    }
  };
  const post = async (path: string, body?: unknown) => {
    const r = await api<{ order: StaffOrderView }>("POST", path, body === undefined ? {} : { body });
    apply(r.order);
    render();
    return r.order;
  };
  const path = (o: StaffOrderView, rest: string) => `/api/orders/${encodeURIComponent(o.id)}/${rest}`;

  function paymentBlock(o: StaffOrderView): Child {
    const p = o.payment;
    const due = o.outstandingMinor;
    if (due <= 0) return h("p", { class: "paid" }, t("paidLabel", { amount: money(o.totalMinor) }));
    const topUp = p.state === "confirmed";
    const confirm = (method: PaymentMethod) =>
      post(path(o, topUp ? "topup" : "confirm"), { method, amountMinor: due }).then(() => {
        cashFor = undefined;
      });
    const parts: Child[] = [
      h("p", { class: "due" }, topUp ? t("topUpDue", { amount: money(due) }) : t("due", { amount: money(due) })),
      p.state === "claimed" && h("p", { class: "hint" }, t("claimedUpi", { amount: money(p.amountMinor) })),
    ];
    if (cashFor?.id === o.id) {
      const closeSheet = () => {
        cashFor = undefined;
        keepFocus(render);
      };
      parts.push(
        h("div", { class: "scrim", on: { click: closeSheet } }),
        h(
          "div",
          { class: "sheet cash-sheet", role: "dialog", "aria-label": t("cashReceived") },
          h("div", { class: "grab" }),
          h(
            "div",
            { class: "sheet-head" },
            h("span", { class: "token" }, o.token),
            h(
              "div",
              { class: "tt" },
              h("h2", {}, t("collectCash")),
              h("p", {}, o.lines.map((l) => lineText(l)).join(", ")),
            ),
            h("button", { type: "button", class: "xbtn", "aria-label": t("cancel"), on: { click: closeSheet } }, "×"),
          ),
          h(
            "div",
            { class: "due-tiles" },
            h("div", {}, h("small", {}, t("totalDue")), h("b", {}, money(due))),
            changeTile(due, cashFor.received),
          ),
          cashPanel(
            due,
            cashFor.received,
            (m) => {
              cashFor = { id: o.id, received: m };
              keepFocus(render);
            },
            false,
          ),
          action(t("confirmCash", { amount: money(due) }), `cash-ok-${o.id}`, () => confirm("cash"), error, "primary"),
        ),
      );
    } else {
      parts.push(
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              type: "button",
              "data-key": `cash-${o.id}`,
              on: {
                click: () => {
                  cashFor = { id: o.id };
                  keepFocus(render);
                },
              },
            },
            t("cashReceived"),
          ),
          action(t("upiReceived"), `upi-${o.id}`, () => confirm("upi"), error),
        ),
      );
    }
    return h("div", { class: "pay-block" }, ...parts);
  }

  function card(o: StaffOrderView): HTMLElement {
    const last = o.history.at(-1);
    const canUndo = last !== undefined && Date.now() - last.at <= UNDO_WINDOW_MS;
    const next =
      o.status === "pending"
        ? action(t("startPreparing"), `adv-${o.id}`, () => post(path(o, "advance")), error, "primary")
        : action(t("markDone"), `adv-${o.id}`, () => post(path(o, "advance")), error, "primary");
    return h(
      "article",
      { class: `order-card${isReady(o) ? " is-ready" : ""}`, "data-testid": `order-${o.token}` },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "token" }, o.token),
        o.customerName !== undefined && h("span", {}, o.customerName),
        isReady(o) && h("span", { class: "badge ready" }, t("readyBadge")),
      ),
      h(
        "ul",
        { class: "lines" },
        ...o.lines.map((l, i) =>
          h(
            "li",
            { class: l.served ? "served" : "" },
            h("span", { class: "line-name" }, lineText(l)),
            h(
              "span",
              { class: "hint" },
              stationName(l.stationId),
              " · ",
              l.served ? t("servedBadge") : l.ready ? t("readyBadge") : t("waitingBadge"),
            ),
            !l.served && action(t("serve"), `serve-${o.id}-${i}`, () => post(path(o, `lines/${i}/served`)), error),
          ),
        ),
      ),
      paymentBlock(o),
      next,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            type: "button",
            "data-key": `call-${o.id}`,
            on: { click: () => voice.say(t("callText", { token: o.token })) },
          },
          t("callToken"),
        ),
        h(
          "button",
          {
            type: "button",
            "data-key": `add-${o.id}`,
            on: {
              click: () => {
                quick = { addTo: o, cart: [], step: "pick", clientKey: newClientKey() };
                render();
              },
            },
          },
          t("addItems"),
        ),
        h(
          "button",
          { type: "button", "data-key": `print-${o.id}`, on: { click: () => printTickets([receipt(o)], locale) } },
          t("printReceipt"),
        ),
        canUndo && action(t("undo"), `undo-${o.id}`, () => post(path(o, "undo")), error),
      ),
    );
  }

  function render(): void {
    if (gen !== generation) return;
    if (quick) {
      quickView();
      return;
    }
    const all = [...orders.values()];
    const count = (x: Tab) => all.filter((o) => tabOf(o) === x).length;
    const tabButton = (x: Tab, label: string) =>
      h(
        "button",
        {
          type: "button",
          class: `sg ${x}`,
          "data-key": `tab-${x}`,
          "aria-pressed": String(tab === x),
          "aria-label": label,
          on: {
            click: () => {
              tab = x;
              keepFocus(render);
            },
          },
        },
        h("b", {}, String(count(x))),
        h("small", {}, label.replace(/\s*\d+\s*$/, "")),
      );
    const shown = all.filter((o) => tabOf(o) === tab);
    const now = Date.now();
    for (const [id, o] of recent) {
      const at = o.history.at(-1)?.at ?? 0;
      if (now - at > UNDO_WINDOW_MS) recent.delete(id);
    }
    mount(
      root,
      header(t("counterTitle")),
      h(
        "main",
        { class: "counter" },
        h(
          "button",
          {
            type: "button",
            class: "primary",
            "data-key": "new-order",
            on: {
              click: () => {
                quick = { cart: [], step: "pick", clientKey: newClientKey() };
                render();
              },
            },
          },
          t("walkIn"),
        ),
        h(
          "div",
          { class: "seg", role: "group" },
          tabButton("pending", t("tabPending", { n: String(count("pending")) })),
          tabButton("preparing", t("tabPreparing", { n: String(count("preparing")) })),
          tabButton("ready", t("tabReady", { n: String(count("ready")) })),
        ),
        error,
        ...(shown.length === 0 ? [h("p", { class: "empty" }, t("noOrders"))] : shown.map(card)),
        recent.size > 0 && h("h2", {}, t("recentlyDone")),
        ...[...recent.values()].map((o) =>
          h(
            "div",
            { class: "row recent", "data-testid": `done-${o.token}` },
            h("span", { class: "token" }, o.token),
            action(t("undo"), `undo-${o.id}`, () => post(path(o, "undo")), error),
          ),
        ),
      ),
    );
  }

  function quickView(): void {
    const q = quick as Quick;
    const total = cartTotal(q.cart, price);
    const close = () => {
      quick = undefined;
      render();
    };
    const lines = () =>
      q.cart.map((l) => ({ itemId: l.itemId, qty: l.qty, ...(l.size === undefined ? {} : { size: l.size }) }));
    const createOnce = async () => {
      if (q.created) return q.created;
      const r = await api<{ order: { id: string }; key: string }>("POST", "/api/orders", {
        body: { clientKey: q.clientKey, lines: lines() },
      });
      const full = await api<{ order: StaffOrderView }>("GET", `/api/orders/${encodeURIComponent(r.order.id)}`);
      apply(full.order);
      q.created = { order: full.order, key: r.key };
      return q.created;
    };
    const pay = async (method: PaymentMethod) => {
      const c = await createOnce();
      await api("POST", `/api/orders/${encodeURIComponent(c.order.id)}/confirm`, {
        body: { method, amountMinor: c.order.totalMinor },
      }).then((r) => apply((r as { order: StaffOrderView }).order));
      quick = undefined;
      tab = "pending";
      render();
    };

    const body: Child[] = [];
    if (q.step === "pick") {
      const chips = visibleCategories(catalog.categories);
      body.push(
        h(
          "div",
          { class: "chips", role: "group", "aria-label": t("categories") },
          h(
            "button",
            {
              type: "button",
              class: "chip",
              "data-key": "cat-all",
              "aria-pressed": String(q.categoryId === undefined),
              on: {
                click: () => {
                  delete q.categoryId;
                  keepFocus(render);
                },
              },
            },
            t("allCategories"),
          ),
          ...chips.map((c) =>
            h(
              "button",
              {
                type: "button",
                class: "chip",
                "data-key": `cat-${c.id}`,
                "aria-pressed": String(q.categoryId === c.id),
                on: {
                  click: () => {
                    q.categoryId = c.id;
                    keepFocus(render);
                  },
                },
              },
              c.name,
            ),
          ),
        ),
      );
      const add = (itemId: string, size?: string) => {
        q.cart = addOne(q.cart, itemId, size, max());
        keepFocus(render);
      };
      const itemButtons = (item: CatalogItem): Child[] =>
        item.variants
          ? item.variants.map((v) =>
              h(
                "button",
                {
                  type: "button",
                  class: "size",
                  "data-key": `add-${item.id}-${v.size}`,
                  "aria-label": t("addSize", { item: item.name, size: v.size }),
                  on: { click: () => add(item.id, v.size) },
                },
                h("span", { class: "size-name" }, v.size),
                h("span", { class: "price" }, money(v.price)),
                qtyOf(q.cart, item.id, v.size) > 0 &&
                  h("span", { class: "badge" }, `×${qtyOf(q.cart, item.id, v.size)}`),
              ),
            )
          : [
              h(
                "button",
                {
                  type: "button",
                  class: "add",
                  "data-key": `add-${item.id}`,
                  "aria-label": t("addItem", { item: item.name }),
                  on: { click: () => add(item.id) },
                },
                h("span", { class: "price" }, money(item.price ?? 0)),
                qtyOf(q.cart, item.id) > 0 && h("span", { class: "badge" }, `×${qtyOf(q.cart, item.id)}`),
              ),
            ];
      for (const cat of visibleCategories(catalog.categories, "", q.categoryId)) {
        body.push(
          h(
            "section",
            {},
            h("h2", {}, cat.name),
            ...cat.items.map((item) =>
              h(
                "article",
                { class: "item" },
                h("h3", {}, item.name),
                h("div", { class: "sizes" }, ...itemButtons(item)),
              ),
            ),
          ),
        );
      }
    }

    const cartList = h(
      "ul",
      { class: "lines" },
      ...q.cart.map((l) => {
        const name = findItem(catalog.categories, l.itemId)?.name ?? l.itemId;
        const label = l.size === undefined ? name : `${name} (${l.size})`;
        const step = (d: number) => {
          q.cart = setQty(q.cart, l.itemId, l.size, l.qty + d, max());
          keepFocus(render);
        };
        // Once the walk-in's order exists (a UPI QR is showing its total), its lines can't change here.
        if (q.created) return h("li", {}, h("span", { class: "line-name" }, label), h("span", { class: "qty" }, l.qty));
        return h(
          "li",
          {},
          h("span", { class: "line-name" }, label),
          h(
            "span",
            { class: "stepper" },
            h(
              "button",
              {
                type: "button",
                "data-key": `less-${l.itemId}-${l.size ?? ""}`,
                "aria-label": t("less", { item: label }),
                on: { click: () => step(-1) },
              },
              "−",
            ),
            h("span", { class: "qty" }, l.qty),
            h(
              "button",
              {
                type: "button",
                "data-key": `more-${l.itemId}-${l.size ?? ""}`,
                "aria-label": t("more", { item: label }),
                on: { click: () => step(1) },
              },
              "+",
            ),
          ),
        );
      }),
    );

    const footer: Child[] = [];
    const error = h("p", { class: "error", role: "alert" });
    if (itemCount(q.cart) > 0) {
      footer.push(h("p", { class: "total" }, h("span", {}, t("total")), h("strong", {}, money(total))));
      if (q.addTo) {
        const target = q.addTo;
        footer.push(
          action(
            t("addToOrder", { token: target.token }),
            "add-ok",
            async () => {
              const r = await api<{ order: StaffOrderView }>(
                "POST",
                `/api/orders/${encodeURIComponent(target.id)}/lines`,
                { body: { lines: lines() } },
              );
              apply(r.order);
              quick = undefined;
              render();
            },
            error,
            "primary",
          ),
        );
      } else if (q.step === "pick") {
        footer.push(
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                type: "button",
                class: "primary",
                "data-key": "pay-cash",
                on: {
                  click: () => {
                    q.step = "cash";
                    render();
                  },
                },
              },
              t("payCash"),
            ),
            catalog.payments.upi &&
              action(
                t("payUpi"),
                "pay-upi",
                async () => {
                  await createOnce();
                  q.step = "upi";
                  render();
                },
                error,
                "primary",
              ),
          ),
        );
      } else if (q.step === "cash") {
        footer.push(
          cashPanel(total, q.received, (m) => {
            q.received = m;
            keepFocus(render);
          }),
          action(t("confirmCash", { amount: money(total) }), "cash-ok", () => pay("cash"), error, "primary"),
        );
      } else if (q.step === "upi" && q.created) {
        const c = q.created;
        const slot = h("div", { class: "qr-slot" });
        footer.push(
          h("p", {}, t("showQr", { amount: money(c.order.totalMinor) })),
          slot,
          action(t("upiReceived"), "upi-ok", () => pay("upi"), error, "primary"),
        );
        void api<{ intent: string }>("GET", `/api/orders/${encodeURIComponent(c.order.id)}/upi`, { key: c.key })
          .then((r) => mount(slot, qrSvg(r.intent, t("qrLabel", { amount: money(c.order.totalMinor) }))))
          .catch((e) => {
            error.textContent = failureText(e);
          });
      }
    }

    mount(
      root,
      header(t("counterTitle")),
      h(
        "main",
        { class: "quick" },
        h(
          "div",
          { class: "row" },
          h("h2", {}, q.addTo ? t("addingTo", { token: q.addTo.token }) : t("walkIn")),
          h("button", { type: "button", class: "link", "data-key": "quick-cancel", on: { click: close } }, t("cancel")),
        ),
        ...body,
        q.cart.length > 0 && h("h2", {}, q.addTo ? t("addingTo", { token: q.addTo.token }) : t("yourOrder")),
        cartList,
        ...footer,
        error,
      ),
    );
  }

  cleanup.push(
    followStream<StaffOrderView>({
      stream: "/api/stream/counter",
      poll: "/api/poll/counter",
      after: snap.lastEventId,
      onEvent: (e: OrderEvent<StaffOrderView>) => {
        const before = orders.get(e.order.id);
        apply(e.order);
        if (e.type === "order.created") announce(t("newOrderAlert", { token: e.order.token }), "");
        else if (e.order.status !== "completed" && isReady(e.order) && (before === undefined || !isReady(before))) {
          announce(t("readyAlert", { token: e.order.token }), "");
        }
        if (!quick) keepFocus(render);
      },
    }),
  );
  // Undo buttons expire on their own; a slow tick keeps them honest without a re-render on every second.
  const tick = setInterval(() => {
    if (!quick) keepFocus(render);
  }, 30_000);
  cleanup.push(() => clearInterval(tick));
  render();
}

/** The cash helper: what the customer handed over (one tap), and the change to give back. */
/** The big green "Change due" tile beside the total in the cash sheet; "Still short" when the cash doesn't cover it. */
function changeTile(dueMinor: number, received: number | undefined): HTMLElement {
  const change = received === undefined ? undefined : changeDue(received, dueMinor);
  return h(
    "div",
    { class: "chg", "data-testid": "change", role: "status" },
    h("small", {}, change !== undefined && change < 0 ? t("stillShort") : t("changeDueTile")),
    h("b", {}, change === undefined ? "–" : exactMoney(Math.abs(change))),
  );
}

function cashPanel(
  dueMinor: number,
  received: number | undefined,
  pick: (m: number) => void,
  showChange = true,
): HTMLElement {
  const options = cashOptions(dueMinor, catalog.business.currency, catalog.business.cashShortcutsMinor);
  const change = received === undefined ? undefined : changeDue(received, dueMinor);
  return h(
    "div",
    { class: "cash" },
    h("p", { class: "hint" }, t("cashGiven")),
    h(
      "div",
      { class: "chips", role: "group", "aria-label": t("cashGiven") },
      ...options.map((m) =>
        h(
          "button",
          {
            type: "button",
            class: "chip",
            "data-key": `tender-${m}`,
            "aria-pressed": String(received === m),
            on: { click: () => pick(m) },
          },
          money(m),
        ),
      ),
    ),
    showChange &&
      change !== undefined &&
      h(
        "p",
        { class: "change", "data-testid": "change", role: "status" },
        change >= 0 ? t("changeLabel", { amount: exactMoney(change) }) : t("shortBy", { amount: exactMoney(-change) }),
      ),
  );
}

// ── Station ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isOpen = (o: StationOrderView, l: StationLine) => o.status !== "completed" && !l.served && !l.ready;

function stationTicket(o: StationOrderView, info: StationInfo): Ticket {
  return {
    kind: "station",
    business: catalog.business.name,
    token: o.token,
    at: o.createdAt,
    timeZone: catalog.business.timeZone,
    station: info.name,
    ...(o.customerName === undefined ? {} : { customerName: o.customerName }),
    lines: o.lines
      .filter((l) => isOpen(o, l))
      .map((l) => ({ name: l.name, qty: l.qty, ...(l.size === undefined ? {} : { size: l.size }) })),
  };
}

async function stationScreen(id: string): Promise<void> {
  const info = stations.find((s) => s.id === id);
  if (info === undefined) return chooserView();
  const gen = ++generation;
  const snap = await api<{ orders: StationOrderView[]; lastEventId: number }>(
    "GET",
    `/api/stations/${encodeURIComponent(id)}/orders`,
  );
  if (gen !== generation) return;
  const orders = new Map(snap.orders.map((o) => [o.id, o]));
  const error = h("p", { class: "error", role: "alert" });
  const openKeys = () => {
    const keys = new Set<string>();
    for (const o of orders.values()) for (const l of o.lines) if (isOpen(o, l)) keys.add(`${o.id}:${l.index}`);
    return keys;
  };
  let known = openKeys();
  let arrival: ReturnType<typeof setTimeout> | undefined;
  cleanup.push(() => clearTimeout(arrival));

  /** Oldest first, as the server lists them; only orders with something still to make here. */
  const open = () =>
    [...orders.values()].filter((o) => o.lines.some((l) => isOpen(o, l))).sort((a, b) => a.createdAt - b.createdAt);
  /** How long the oldest open ticket has waited, as of this draw; a timer redraws it every 30 s. */
  const oldestAge = () => {
    const first = open()[0];
    return first === undefined
      ? "–"
      : t("oldestAge", { n: String(Math.max(0, Math.floor((Date.now() - first.createdAt) / 60_000))) });
  };
  const tick = setInterval(() => keepFocus(render), 30_000);
  cleanup.push(() => clearInterval(tick));
  const batchText = () => renderBatch(openBatch(open(), id), template);

  /** The last "ready" tap, which an Undo chip can take back for UNDO_WINDOW_MS: one mis-tap must not stand. */
  let lastReady: { lines: { orderId: string; index: number }[]; at: number } | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup.push(() => clearTimeout(undoTimer));
  const setReady = async (verb: "ready" | "unready", lines: { orderId: string; index: number }[]) => {
    if (lines.length === 0) return;
    const r = await api<{ orders: StationOrderView[] }>("POST", `/api/stations/${encodeURIComponent(id)}/${verb}`, {
      body: { lines },
    });
    for (const o of r.orders) orders.set(o.id, o);
    // Lines that come back after an undo are not new arrivals, so they are not spoken again.
    known = openKeys();
    clearTimeout(undoTimer);
    lastReady = verb === "ready" ? { lines, at: Date.now() } : undefined;
    if (lastReady) {
      undoTimer = setTimeout(() => {
        lastReady = undefined;
        keepFocus(render);
      }, UNDO_WINDOW_MS);
    }
    keepFocus(render);
  };
  const ready = (lines: { orderId: string; index: number }[]) => setReady("ready", lines);
  const refsOf = (match: (l: StationLine) => boolean) =>
    open().flatMap((o) =>
      o.lines.filter((l) => isOpen(o, l) && match(l)).map((l) => ({ orderId: o.id, index: l.index })),
    );

  /** The item's own icon, else its category's (a theme's category icon included). */
  function groupIcon(itemId: string): Node {
    const cat = catalog.categories.find((c) => c.items.some((i) => i.id === itemId));
    const own = cat?.items.find((i) => i.id === itemId)?.icon;
    if (own !== undefined) return icon(own);
    const ref = cat === undefined ? undefined : theme.categoryIcons[cat.id];
    return iconRef(ref ?? { icon: cat?.icon ?? "teacup_without_handle" });
  }

  const CHIPS = 4;
  /** The day is the same on every chip, so a chip shows the number after it and the full token is its label. */
  const chipText = (token: string) => token.slice(token.indexOf("-") + 1);

  function batchBody(): Child[] {
    const list = open();
    const batch = openBatch(list, id);
    return [
      h(
        "div",
        { class: "row" },
        batch.lines.length > 0 && action(t("allReady"), "all-ready", () => ready(refsOf(() => true)), error, "primary"),
      ),
      ...groupBatch(list, id).map((g, gi) =>
        h(
          "section",
          { class: "bgroup", "data-testid": `item-${g.itemId}` },
          h(
            "header",
            {},
            h("span", { class: "gic" }, groupIcon(g.itemId)),
            h("h2", {}, g.name),
            h("span", { class: "tot" }, t("groupTotal", { n: String(g.total) })),
          ),
          h(
            "ul",
            { class: "brows" },
            ...g.rows.map((r, ri) =>
              h(
                "li",
                {},
                h("span", { class: "sz" }, r.size ?? ""),
                h(
                  "span",
                  { class: `count${gi === 0 && ri === 0 ? " first" : ""}` },
                  String(r.qty),
                  h("small", {}, "×"),
                ),
                h(
                  "span",
                  { class: "chips", "aria-label": t("tokensFor", { tokens: r.tokens.join(", ") }) },
                  ...r.tokens
                    .slice(0, r.tokens.length > CHIPS + 1 ? CHIPS : r.tokens.length)
                    .map((tk) => h("i", { title: tk }, chipText(tk))),
                  r.tokens.length > CHIPS + 1 && h("i", {}, t("moreTokens", { n: String(r.tokens.length - CHIPS) })),
                ),
                labelled(
                  t("markReady"),
                  action(
                    "✓",
                    `ready-${g.itemId}-${r.size ?? ""}`,
                    () => ready(refsOf((l) => l.itemId === g.itemId && l.size === r.size)),
                    error,
                    "check",
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ];
  }

  /** The spoken text for assistive tech (its format is fixed), and the bar that shows what is being read out. */
  function readingBar(): Child[] {
    const batch = openBatch(open(), id);
    return [
      h("p", { class: "sr-only", "data-testid": "batch-text", "aria-live": "polite" }, batchText()),
      h(
        "div",
        { class: "reading" },
        h("span", { class: "wave", "aria-hidden": "true" }, ...Array.from({ length: 8 }, () => h("i"))),
        h(
          "p",
          { "aria-hidden": "true", "data-testid": "reading" },
          h("b", {}, t("reading")),
          " ",
          displayBatch(batch, template),
        ),
        h(
          "button",
          {
            type: "button",
            class: "replay",
            "data-key": "replay",
            "aria-label": t("replay"),
            on: { click: () => voice.say(batchText()) },
          },
          icon("counterclockwise_arrows_button"),
        ),
      ),
    ];
  }

  function jobsBody(): Child[] {
    const list = open();
    if (list.length === 0) return [h("p", { class: "empty" }, t("noJobs"))];
    return list.map((o) =>
      h(
        "article",
        { class: "order-card", "data-testid": `job-${o.token}` },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "token" }, o.token),
          o.customerName !== undefined && h("span", {}, o.customerName),
        ),
        h(
          "ul",
          { class: "lines" },
          ...o.lines
            .filter((l) => isOpen(o, l))
            .map((l) =>
              h(
                "li",
                {},
                h("span", { class: "line-name" }, lineText(l)),
                action(
                  t("markReady"),
                  `ready-${o.id}-${l.index}`,
                  () => ready([{ orderId: o.id, index: l.index }]),
                  error,
                ),
              ),
            ),
        ),
        h(
          "div",
          { class: "row" },
          action(
            t("jobReady"),
            `job-ready-${o.id}`,
            () => ready(o.lines.filter((l) => isOpen(o, l)).map((l) => ({ orderId: o.id, index: l.index }))),
            error,
            "primary",
          ),
          h(
            "button",
            {
              type: "button",
              "data-key": `print-${o.id}`,
              on: { click: () => printTickets([stationTicket(o, info as StationInfo)], locale) },
            },
            t("printTicket"),
          ),
        ),
      ),
    );
  }

  function render(): void {
    if (gen !== generation) return;
    mount(
      root,
      header(info?.name ?? id, info?.view === "jobs" ? undefined : t("stationLive")),
      h(
        "main",
        { class: `station station-${info?.view}` },
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              type: "button",
              "data-key": "print-all",
              on: {
                click: () =>
                  printTickets(
                    open().map((o) => stationTicket(o, info as StationInfo)),
                    locale,
                  ),
              },
            },
            t("printAll"),
          ),
        ),
        h(
          "div",
          { class: "station-tiles" },
          stat({ label: t("tickets"), value: String(open().length) }),
          stat({
            label: t("itemsTotal"),
            value: String(
              open().reduce((n, o) => n + o.lines.filter((l) => isOpen(o, l)).reduce((m, l) => m + l.qty, 0), 0),
            ),
          }),
          stat({ label: t("oldest"), value: oldestAge() }),
        ),
        error,
        lastReady &&
          h(
            "div",
            { class: "row" },
            action(
              t("undoReady"),
              "undo-ready",
              () => setReady("unready", (lastReady as { lines: { orderId: string; index: number }[] }).lines),
              error,
              "chip",
            ),
          ),
        ...(info?.view === "jobs" ? jobsBody() : [...batchBody(), ...readingBar()]),
      ),
    );
  }

  cleanup.push(
    followStream<StationOrderView>({
      stream: `/api/stream/station/${encodeURIComponent(id)}`,
      poll: `/api/poll/station/${encodeURIComponent(id)}`,
      after: snap.lastEventId,
      onEvent: (e) => {
        if (e.order.status === "completed" || e.order.lines.length === 0) orders.delete(e.order.id);
        else orders.set(e.order.id, e.order);
        const now = openKeys();
        const fresh = [...now].filter((k) => !known.has(k));
        known = now;
        keepFocus(render);
        if (fresh.length === 0 || !info?.speak) return;
        if (info.view === "jobs") {
          const o = e.order;
          const items = o.lines
            .filter((l) => fresh.includes(`${o.id}:${l.index}`))
            .map((l) => lineText(l))
            .join(", ");
          voice.say(t("newJob", { token: o.token, items }));
        } else {
          // A burst of orders becomes one call-out of the whole batch.
          clearTimeout(arrival);
          arrival = setTimeout(() => voice.say(batchText()), 1200);
        }
      },
    }),
  );
  render();
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function route(): Promise<void> {
  generation++;
  stop();
  window.scrollTo(0, 0);
  const hash = location.hash;
  try {
    if (hash === "#/counter" && access !== "station") return startGate(() => void counterView().catch(showFailure));
    const m = /^#\/station\/(.+)$/.exec(hash);
    if (m) return startGate(() => void stationScreen(decodeURIComponent(m[1] as string)).catch(showFailure));
    chooserView();
  } catch (e) {
    showFailure(e);
  }
}

function showFailure(e: unknown): void {
  if (e instanceof ApiFailure && e.status === 401) return void start();
  mount(
    root,
    h(
      "main",
      {},
      h("p", { class: "error" }, failureText(e)),
      h("button", { type: "button", class: "primary", on: { click: () => void route() } }, t("retry")),
    ),
  );
}

async function start(): Promise<void> {
  initMode();
  try {
    catalog ??= await api<StaffCatalog>("GET", "/api/catalog");
    theme = await loadThemeInfo();
    watchTheme(theme, (next) => {
      theme = next;
    });
    document.title = `${t("staffTitle")} · ${catalog.business.name}`;
    try {
      access = (await api<{ access: typeof access }>("GET", "/api/me")).access;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) return loginView();
      throw e;
    }
    stations = (await api<{ stations: StationInfo[] }>("GET", "/api/stations")).stations;
    await route();
  } catch (e) {
    showFailure(e);
  }
}

window.addEventListener("hashchange", () => void route());
void start();
if ("serviceWorker" in navigator && window.isSecureContext) {
  // Its own worker, scoped to the staff page, so the storefront's never fetches staff files and this one no customer's.
  navigator.serviceWorker.register("/staff-sw.js", { scope: "/staff" }).catch(() => {});
}
