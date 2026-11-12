/**
 * The customer storefront: menu, size sheet, cart, payment and the live token page, plus token lookup. With
 * `?kiosk=1` the same page runs on a shop-owned screen: big targets, no name prompt, the token shown big, then a
 * fresh start. Screens compose the components in `ui/`; every colour and size comes from the theme's tokens.
 */

import type { CatalogItem, Category } from "../core/config.ts";
import { isOpenAt } from "../core/hours.ts";
import { formatPrice } from "../core/money.ts";
import type { OrderStatus } from "../core/orders.ts";
import { TINT_COUNT } from "../core/theme.ts";
import type { CustomerOrderView } from "../core/views.ts";
import { announce, askToNotify, canNotify, primeSound } from "./alerts.ts";
import { ApiFailure, api } from "./api.ts";
import { addOne, type Cart, cartFromLines, cartTotal, itemCount, qtyOf, setQty } from "./cart.ts";
import { findItem, priceOf, type StoreCatalog, visibleCategories } from "./catalog.ts";
import { type Child, h, mount } from "./dom.ts";
import { follow } from "./live.ts";
import { addRecent, isId, isRecent, parseList, type RecentOrder, toggleFavourite } from "./local.ts";
import { qrSvg } from "./qr.ts";
import {
  forgetOrder,
  type KeyValue,
  loadOrder,
  memoryStore,
  newClientKey,
  type OrderRef,
  saveOrder,
  tabStore,
} from "./session.ts";
import { lang, t, tn, useStrings } from "./strings.ts";
import { button, linkButton, roundButton } from "./ui/button.ts";
import { card, quickCard } from "./ui/card.ts";
import { badge, pill } from "./ui/chip.ts";
import { appHeader } from "./ui/header.ts";
import { icon, iconRef, mediaUrl } from "./ui/icon.ts";
import { openSheet } from "./ui/sheet.ts";
import { menuSkeleton } from "./ui/skeleton.ts";
import { addButton, stepper } from "./ui/stepper.ts";
import { tabBar } from "./ui/tabbar.ts";
import { initMode, loadThemeInfo, type ThemeInfo, toggleMode, watchTheme } from "./ui/theme-client.ts";
import { type Step, timeline } from "./ui/timeline.ts";
import { toast } from "./ui/toast.ts";

interface Created {
  order: CustomerOrderView;
  key: string;
  lastEventId: number;
}

const params = new URLSearchParams(location.search);
const kiosk = params.get("kiosk") === "1";
const askName = kiosk ? params.get("name") === "1" : true;
/** A whole number of seconds from the query string, within bounds, or the default. */
function seconds(name: string, fallback: number, min: number, maxS: number): number {
  const raw = Number(params.get(name) ?? fallback);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), min), maxS) : fallback;
}
const resetSeconds = seconds("reset", 20, 2, 600);
/** A kiosk left mid-order goes back to a fresh start after this long without a touch. */
const IDLE_MS = seconds("idle", 120, 2, 3600) * 1000;
/** An open menu re-reads the catalog this often, so the owner's availability switches reach it (`&catalog=<s>`). */
const CATALOG_MS = seconds("catalog", 30, 2, 600) * 1000;
const locale = navigator.language;
const coarse = matchMedia("(pointer: coarse)").matches;
const kv: KeyValue = kiosk ? memoryStore() : tabStore(storage("sessionStorage"));
/** Starred items and recent orders live on this phone only; a kiosk keeps nothing. */
const local: KeyValue = kiosk ? memoryStore() : tabStore(storage("localStorage"));
const root = document.getElementById("app") as HTMLElement;
const FAVOURITES = "__favourites";
const DEFAULT_ICON = "fork_and_knife_with_plate";

let catalog: StoreCatalog;
let theme: ThemeInfo;
let cart: Cart = [];
let query = "";
let categoryId: string | undefined;
let customerName = "";
/** How the customer means to pay, chosen on the cart page. */
let payChoice: "upi" | "counter" = "upi";
/** The order being changed within its edit window, and its token for the banner. */
let editing: (OrderRef & { token: string }) | undefined;
/** The client key of a create that hasn't been answered yet, so a retry can't make a second order. */
let pendingKey: string | undefined;
const cleanup: (() => void)[] = [];
let lastTouch = Date.now();
let kioskBusy = false;
let upiCache: { orderId: string; total: number; intent: string } | undefined;
/** Bumped on every route change, so a slow load for a view the customer has left neither renders nor subscribes. */
let generation = 0;

function storage(name: "sessionStorage" | "localStorage"): Storage | undefined {
  try {
    return window[name];
  } catch {
    return undefined;
  }
}

const money = (minor: number) => formatPrice(minor, catalog.business.currency, locale);
const max = () => catalog.business.maxQtyPerLine;
const price = (itemId: string, size?: string) => priceOf(catalog.categories, itemId, size);
const favourites = () => parseList(local.get("ibow.fav"), isId);
const recents = () => parseList(local.get("ibow.recent"), isRecent);

function statusText(s: OrderStatus): string {
  return { pending: t("statusPending"), preparing: t("statusPreparing"), completed: t("statusCompleted") }[s];
}

/** What the customer sees: "ready" as soon as every line is, even before staff mark the order collected. */
function shown(o: { status: OrderStatus; ready: boolean }): OrderStatus {
  return o.ready ? "completed" : o.status;
}

function failureText(e: unknown): string {
  if (!(e instanceof ApiFailure)) return t("failed");
  if (e.code === "network") return t("offline");
  if (e.code === "rate_limited") return t("tooMany");
  if (e.code === "unavailable_item" || e.code === "unknown_item" || e.code === "bad_size") return t("itemGone");
  if (e.code === "edit_expired" || e.code === "already_paid" || e.code === "not_pending") return t("editClosed");
  return t("failed");
}

function lineName(itemId: string, size: string | undefined, fallback?: string): string {
  const name = findItem(catalog.categories, itemId)?.name ?? fallback ?? itemId;
  return size === undefined ? name : `${name} (${size})`;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const clock = (at: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: catalog.business.timeZone }).format(
    at,
  );

// ── Items: icon, tile, price ───────────────────────────────────────────────────────────────────────────────────────

function categoryOf(itemId: string): { cat: Category; index: number } | undefined {
  const index = catalog.categories.findIndex((c) => c.items.some((i) => i.id === itemId));
  const cat = catalog.categories[index];
  return cat === undefined ? undefined : { cat, index };
}

function categoryIcon(cat: Category): Node {
  const ref = theme.categoryIcons[cat.id];
  return iconRef(ref ?? { icon: cat.icon ?? DEFAULT_ICON });
}

/** The item's photo, or a tinted tile with its category's icon. */
function tile(item: CatalogItem, size?: "sm" | "xs"): HTMLElement {
  const found = categoryOf(item.id);
  const sz = size ? ` ${size}` : "";
  if (item.image !== undefined) {
    return h("div", { class: `pic photo${sz}` }, h("img", { src: mediaUrl(item.image), alt: "", loading: "lazy" }));
  }
  const tint = (found?.index ?? 0) % TINT_COUNT;
  // The item's own icon, else its category's (a theme's category icon included), never one global picture.
  const own = item.icon === undefined ? undefined : icon(item.icon);
  return h("div", { class: `pic t-${tint}${sz}` }, own ?? (found ? categoryIcon(found.cat) : icon(DEFAULT_ICON)));
}

function priceText(item: CatalogItem): Child[] {
  if (item.variants === undefined) return [money(item.price ?? 0)];
  const prices = item.variants.map((v) => v.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return [
    lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`,
    h("small", {}, tn("sizesCount", prices.length, { n: String(prices.length) })),
  ];
}

function tagFor(item: CatalogItem): Child {
  const mode = theme.features.tags;
  if (mode === "off") return null;
  const computed = mode === "auto" ? theme.popular[item.id] : undefined;
  if (computed === "bestseller") return h("span", { class: "tag" }, icon("fire"), t("tagBestseller"));
  if (computed === "popular") return h("span", { class: "tag" }, icon("star"), t("tagPopular"));
  const own = item.tags?.[0];
  if (own === undefined) return null;
  const known =
    own.toLowerCase() === "bestseller" ? t("tagBestseller") : own.toLowerCase() === "popular" ? t("tagPopular") : own;
  return h("span", { class: "tag no-icon" }, known);
}

// ── Frame: header, cart bar, tabs ──────────────────────────────────────────────────────────────────────────────────

function modeButton(): Child {
  return theme.features.darkToggle ? roundButton(t("darkMode"), icon("crescent_moon"), () => void toggleMode()) : null;
}

/** "Open now · Token pickup" with the green dot when the business states hours; just the line otherwise. */
function tagline(): Child {
  const hours = catalog.business.hours;
  if (hours === undefined) return t("tagline");
  const open = isOpenAt(hours, Date.now(), catalog.business.timeZone);
  return [open && h("span", { class: "dot" }), open ? t("openNow") : t("closedNow"), " · ", t("tagline")];
}

function header(
  opts: { title?: string; subtitle?: Child; back?: boolean; below?: Node; style?: "plain" } = {},
): HTMLElement {
  const back = opts.back ? h("a", { class: "rbtn", href: "#/", "aria-label": t("backToMenu") }, "←") : undefined;
  return appHeader({
    title: opts.title ?? catalog.business.name,
    subtitle: opts.subtitle ?? tagline(),
    style: opts.style ?? theme.header.style,
    logo: opts.back ? undefined : theme.logo,
    back,
    actions: [modeButton()],
    below: opts.below,
    ...(opts.back ? {} : { titleHref: "#/" }),
  });
}

function tabs(current: "menu" | "cart" | "track"): HTMLElement {
  const saved = kiosk ? undefined : loadOrder(kv);
  const all = [
    { id: "menu", label: t("tabMenu"), icon: icon("clipboard"), href: "#/" },
    { id: "cart", label: t("tabCart"), icon: icon("shopping_cart"), href: "#/cart", badge: itemCount(cart) },
    { id: "track", label: t("tabTrack"), icon: icon("ticket"), href: saved ? "#/order" : "#/lookup" },
  ];
  return tabBar(kiosk ? all.slice(0, 2) : all, current, t("tabs"));
}

function cartBar(bump = false): Child {
  const n = itemCount(cart);
  if (n === 0) return null;
  return h(
    "a",
    { class: `cartbar${bump ? " bump" : ""}`, href: "#/cart", "data-testid": "cart-bar" },
    h("span", { class: "bag" }, icon("shopping_cart")),
    h(
      "div",
      { class: "l" },
      h("small", {}, t("itemsInCart", { n: String(n) })),
      h("b", { class: "num" }, money(cartTotal(cart, price))),
    ),
    theme.features.cartEta &&
      theme.etaMinutes !== undefined && [
        h("span", { class: "sep" }),
        h("span", { class: "eta" }, t("etaAbout", { n: String(theme.etaMinutes) })),
      ],
    h("span", { class: "go" }, editing ? t("reviewChange") : t("reviewOrder"), " ›"),
  );
}

function stop(): void {
  for (const fn of cleanup.splice(0)) fn();
}

function route(scroll = true): void {
  generation++;
  stop();
  if (scroll) window.scrollTo(0, 0);
  const hash = location.hash;
  if (hash === "#/cart") {
    cartView();
    return;
  }
  if (hash === "#/lookup" && !kiosk) {
    lookupView();
    return;
  }
  if (hash === "#/order" && !kiosk) {
    const ref = loadOrder(kv);
    if (ref) return void orderView(ref);
  }
  menuView();
}

// ── Menu ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function menuView(): void {
  const gen = generation;
  const list = h("div", { class: "items" });
  const rail = h("div", { class: "rail", role: "group", "aria-label": t("categories") });
  const quick = h("div");
  const bar = h("div");
  const tabsSlot = h("div");
  const redraws = new Map<string, () => void>();

  const refreshCart = (bump = false) => {
    mount(bar, cartBar(bump));
    mount(tabsSlot, tabs("menu"));
    for (const fn of redraws.values()) fn();
  };

  function openSizes(item: CatalogItem): void {
    const variants = item.variants ?? [];
    let size = variants[0]?.size as string;
    let qty = 1;
    const opts = h("div", { role: "radiogroup", "aria-label": t("chooseSize") });
    const foot = h("div", { class: "sheet-foot" });
    const sizePrice = () => variants.find((v) => v.size === size)?.price ?? 0;
    const sheet = openSheet({
      title: item.name,
      ...(item.description ? { subtitle: item.description } : {}),
      lead: tile(item, "xs"),
      label: t("sizesFor", { item: item.name }),
      closeLabel: t("close"),
      body: [
        h("div", { class: "bill" }, h("span", { class: "label" }, t("chooseSize")), badge(t("required"))),
        opts,
        foot,
      ],
    });
    const draw = () => {
      mount(
        opts,
        ...variants.map((v) =>
          h(
            "button",
            {
              type: "button",
              class: "opt",
              role: "radio",
              "aria-checked": String(v.size === size),
              on: {
                click: () => {
                  size = v.size;
                  draw();
                },
              },
            },
            h("div", { class: "nm" }, h("b", {}, v.size)),
            h("span", { class: "pr num" }, money(v.price)),
            h("span", { class: "radio", "aria-hidden": "true" }),
          ),
        ),
      );
      mount(
        foot,
        stepper({
          qty,
          max: Math.max(1, max() - qtyOf(cart, item.id, size)),
          less: t("less", { item: item.name }),
          more: t("more", { item: item.name }),
          size: "lg",
          onChange: (q) => {
            qty = Math.max(1, q);
            draw();
          },
        }),
        button(
          {
            kind: "primary",
            testid: "sheet-add",
            disabled: qtyOf(cart, item.id, size) >= max(),
            onClick: () => {
              cart = setQty(cart, item.id, size, qtyOf(cart, item.id, size) + qty, max());
              sheet.close();
              refreshCart(true);
            },
          },
          t("addWithPrice", { price: money(sizePrice() * qty) }),
        ),
      );
    };
    draw();
  }

  const card_ = (item: CatalogItem) => {
    const ctl = h("div", { class: "ctl" });
    const draw = (focus?: "less" | "more") => {
      if (item.variants) {
        const n = item.variants.reduce((sum, v) => sum + qtyOf(cart, item.id, v.size), 0);
        mount(
          ctl,
          addButton({
            label: t("addItem", { item: item.name }),
            text: t("add"),
            count: n,
            onClick: () => openSizes(item),
          }),
        );
        return;
      }
      const qty = qtyOf(cart, item.id);
      if (qty === 0) {
        const btn = addButton({
          label: t("addItem", { item: item.name }),
          text: t("add"),
          disabled: max() < 1,
          onClick: () => {
            cart = addOne(cart, item.id, undefined, max());
            refreshCart(true);
            ctl.querySelectorAll("button")[1]?.focus();
          },
        });
        mount(ctl, btn);
        if (focus === "less") btn.focus();
        return;
      }
      mount(
        ctl,
        stepper({
          qty,
          max: max(),
          less: t("less", { item: item.name }),
          more: t("more", { item: item.name }),
          onChange: (q) => {
            cart = setQty(cart, item.id, undefined, q, max());
            refreshCart();
            ctl.querySelectorAll("button")[q === 0 ? 0 : q > qty ? 1 : 0]?.focus();
          },
        }),
      );
    };
    redraws.set(item.id, draw);
    draw();
    const starred = favourites().includes(item.id);
    return h(
      "article",
      { class: "item", "data-item": item.id },
      h(
        "div",
        { class: "tx" },
        tagFor(item),
        h(
          "h3",
          {},
          item.name,
          theme.features.veg &&
            item.diet &&
            h("span", { class: `diet ${item.diet}`, role: "img", "aria-label": item.diet }),
        ),
        h("div", { class: "price num" }, ...priceText(item)),
        item.description && h("p", { class: "desc" }, item.description),
      ),
      h(
        "div",
        { class: "pic-wrap" },
        tile(item),
        theme.features.favourites &&
          !kiosk &&
          h(
            "button",
            {
              type: "button",
              class: "fav",
              "aria-pressed": String(starred),
              "aria-label": t("favourite", { item: item.name }),
              on: {
                click: () => {
                  local.set("ibow.fav", JSON.stringify(toggleFavourite(favourites(), item.id)));
                  renderList();
                  renderQuick();
                },
              },
            },
            icon("star"),
          ),
        ctl,
      ),
    );
  };

  function renderRail(): void {
    const all = visibleCategories(catalog.categories);
    const pairs: [string | undefined, HTMLElement][] = [];
    const chip = (id: string | undefined, label: string, ic?: Node) => {
      const el = pill({
        label,
        icon: ic,
        selected: categoryId === id,
        onClick: () => {
          categoryId = id;
          // Update in place, so focus stays on the pill that was tapped.
          for (const [cid, b] of pairs) b.setAttribute("aria-pressed", String(cid === categoryId));
          renderList();
        },
      });
      pairs.push([id, el]);
      return el;
    };
    mount(
      rail,
      chip(undefined, t("allCategories"), icon("fork_and_knife_with_plate")),
      ...all.map((c: Category) => chip(c.id, c.name, categoryIcon(c))),
    );
  }

  function renderQuick(): void {
    if (kiosk) return;
    const cards: Child[] = [];
    if (theme.features.favourites) {
      const n = favourites().filter((id) => findItem(catalog.categories, id)).length;
      cards.push(
        quickCard({
          icon: icon("star"),
          title: t("favourites"),
          hint: n === 0 ? t("favouritesHint") : t("favouritesCount", { n: String(n) }),
          testid: "quick-favourites",
          onClick: () => {
            categoryId = categoryId === FAVOURITES ? undefined : FAVOURITES;
            renderRail();
            renderList();
          },
        }),
      );
    }
    if (theme.features.recent) {
      const n = recents().length;
      cards.push(
        quickCard({
          icon: icon("receipt"),
          title: t("recent"),
          hint: n === 0 ? t("recentHint") : t("recentCount", { n: String(n) }),
          testid: "quick-recent",
          onClick: openRecent,
        }),
      );
    }
    const saved = loadOrder(kv);
    if (saved) cards.push(liveCard);
    mount(quick, cards.length > 0 && h("div", { class: "quick-cards" }, ...cards));
  }

  const liveCard = quickCard({
    icon: icon("ticket"),
    title: t("yourToken"),
    hint: t("loading"),
    href: "#/order",
    live: t("live"),
    testid: "quick-token",
  });
  function fillLiveCard(): void {
    const saved = loadOrder(kv);
    if (!saved) return;
    api<{ order: CustomerOrderView }>("GET", `/api/orders/${encodeURIComponent(saved.id)}`, { key: saved.key }).then(
      (r) => {
        if (gen !== generation) return;
        const done = shown(r.order) === "completed";
        const fresh = quickCard({
          icon: icon("ticket"),
          title: t("tokenCard", { token: r.order.token }),
          hint: statusText(shown(r.order)),
          href: "#/order",
          live: done ? undefined : t("live"),
          testid: "quick-token",
        });
        liveCard.replaceWith(fresh);
      },
      () => undefined,
    );
  }

  function openRecent(): void {
    const orders = recents();
    openSheet({
      title: t("recent"),
      label: t("recent"),
      closeLabel: t("close"),
      body: [
        orders.length === 0
          ? h("p", { class: "muted" }, t("recentEmpty"))
          : h(
              "div",
              {},
              ...orders.map((o) =>
                card(
                  { class: "recent-order" },
                  h("div", { class: "bill" }, h("b", {}, o.token), h("span", { class: "num" }, money(o.totalMinor))),
                  h(
                    "p",
                    { class: "muted" },
                    o.lines.map((l) => `${l.qty} × ${l.name}${l.size ? ` (${l.size})` : ""}`).join(", "),
                  ),
                  button(
                    {
                      kind: "ghost",
                      small: true,
                      onClick: () => {
                        let next = cart;
                        for (const l of o.lines) {
                          if (price(l.itemId, l.size) !== undefined)
                            next = setQty(next, l.itemId, l.size, qtyOf(next, l.itemId, l.size) + l.qty, max());
                        }
                        if (next === cart) toast(t("itemGone"), "err");
                        else {
                          cart = next;
                          location.hash = "#/cart";
                        }
                        document.querySelector<HTMLButtonElement>(".sheet .xbtn")?.click();
                      },
                    },
                    t("orderAgain"),
                  ),
                ),
              ),
            ),
      ],
    });
  }

  function renderList(): void {
    redraws.clear();
    let cats = visibleCategories(catalog.categories, query, categoryId === FAVOURITES ? undefined : categoryId);
    if (categoryId === FAVOURITES) {
      const stars = new Set(favourites());
      cats = cats
        .map((c) => ({ ...c, items: c.items.filter((i) => stars.has(i.id)) }))
        .filter((c) => c.items.length > 0);
    }
    mount(
      list,
      ...(cats.length === 0
        ? [h("p", { class: "page muted" }, categoryId === FAVOURITES ? t("favouritesHint") : t("noMatch"))]
        : cats.map((cat) =>
            h(
              "section",
              {},
              h(
                "div",
                { class: "sec" },
                categoryIcon(cat),
                h("h2", {}, cat.name),
                h("small", {}, tn("itemsCount", cat.items.length, { n: String(cat.items.length) })),
              ),
              ...cat.items.map(card_),
            ),
          )),
    );
    mount(bar, cartBar());
  }

  const search = h(
    "label",
    { class: "search" },
    icon("magnifying_glass_tilted_left"),
    h("input", {
      type: "search",
      placeholder: t("search"),
      "aria-label": t("search"),
      autocomplete: "off",
      value: query,
      on: {
        input: (e) => {
          query = (e.target as HTMLInputElement).value;
          renderList();
        },
      },
    }),
  );

  mount(
    root,
    h(
      "div",
      { class: "shell" },
      header({ below: search }),
      editing &&
        h(
          "p",
          { class: "banner" },
          t("editingBanner", { token: editing.token }),
          " ",
          button(
            {
              kind: "link",
              onClick: () => {
                editing = undefined;
                cart = [];
                location.hash = "#/order";
              },
            },
            t("cancelChange"),
          ),
        ),
      rail,
      h("main", {}, quick, list),
      bar,
      tabsSlot,
    ),
  );
  mount(tabsSlot, tabs("menu"));
  renderRail();
  renderQuick();
  renderList();
  fillLiveCard();
  const poll = setInterval(async () => {
    const fresh = await api<StoreCatalog>("GET", "/api/catalog").catch(() => undefined);
    if (fresh && JSON.stringify(fresh.categories) !== JSON.stringify(catalog.categories)) {
      catalog = fresh;
      renderRail();
      renderList();
    }
  }, CATALOG_MS);
  cleanup.push(() => clearInterval(poll));
}

// ── Cart and placing the order ─────────────────────────────────────────────────────────────────────────────────────

function cartView(): void {
  if (itemCount(cart) === 0) {
    location.hash = "#/";
    return;
  }
  const error = h("p", { class: "error", role: "alert" });
  const total = cartTotal(cart, price);
  const hasUpi = catalog.payments.upi && !editing && !kiosk;
  const place = button(
    { kind: "accent", type: "button", testid: "place-order", onClick: () => void submit() },
    editing ? t("updateOrder") : t("placeOrder"),
    " · ",
    money(total),
  );

  const step = (itemId: string, size: string | undefined, qty: number) => {
    cart = setQty(cart, itemId, size, qty, max());
    cartView();
  };

  async function submit(): Promise<void> {
    primeSound();
    place.disabled = true;
    error.textContent = "";
    const lines = cart.map((l) => ({
      itemId: l.itemId,
      qty: l.qty,
      ...(l.size === undefined ? {} : { size: l.size }),
    }));
    try {
      if (editing) {
        const ref = editing;
        await api("PUT", `/api/orders/${encodeURIComponent(ref.id)}/lines`, { key: ref.key, body: { lines } });
        editing = undefined;
        cart = [];
        location.hash = "#/order";
        return;
      }
      pendingKey ??= newClientKey();
      const name = customerName.trim();
      const created = await api<Created>("POST", "/api/orders", {
        body: { clientKey: pendingKey, lines, ...(name ? { customerName: name } : {}) },
      });
      pendingKey = undefined;
      if (!kiosk) {
        const entry: RecentOrder = {
          token: created.order.token,
          at: Date.now(),
          totalMinor: created.order.totalMinor,
          lines: created.order.lines.map((l) => ({
            itemId: l.itemId,
            qty: l.qty,
            name: l.name,
            ...(l.size === undefined ? {} : { size: l.size }),
          })),
        };
        local.set("ibow.recent", JSON.stringify(addRecent(recents(), entry)));
      }
      cart = [];
      customerName = "";
      if (kiosk) return kioskPay(created);
      saveOrder(kv, { id: created.order.id, key: created.key });
      if (payChoice === "counter") kv.set(`ibow.counter.${created.order.id}`, "1");
      location.hash = "#/order";
    } catch (e) {
      error.textContent = failureText(e);
      place.disabled = false;
      if (e instanceof ApiFailure && ["unavailable_item", "unknown_item", "bad_size"].includes(e.code)) {
        catalog = await api<StoreCatalog>("GET", "/api/catalog").catch(() => catalog);
      }
      if (editing && e instanceof ApiFailure && ["edit_expired", "already_paid", "not_pending"].includes(e.code)) {
        editing = undefined;
        cart = [];
      }
    }
  }

  const payRow = (id: "upi" | "counter", ic: string, title: string, sub: string) =>
    h(
      "button",
      {
        type: "button",
        class: "pay-opt",
        role: "radio",
        "aria-checked": String(payChoice === id),
        on: {
          click: () => {
            payChoice = id;
            cartView();
          },
        },
      },
      h("span", { class: "pi" }, icon(ic)),
      h("div", { class: "nm" }, h("b", {}, title), h("small", {}, sub)),
      h("span", { class: "radio", "aria-hidden": "true" }),
    );

  const cartHeader = appHeader({
    title: editing ? t("changeTitle", { token: editing.token }) : t("yourOrder"),
    subtitle: catalog.business.name,
    style: "plain",
    back: h("a", { class: "rbtn", href: "#/", "aria-label": t("backToMenu") }, "←"),
    actions: [
      theme.features.cartEta &&
        theme.etaMinutes !== undefined &&
        badge(t("etaAbout", { n: String(theme.etaMinutes) }), "accent"),
      modeButton(),
    ],
  });

  mount(
    root,
    h(
      "div",
      { class: "shell" },
      cartHeader,
      h(
        "main",
        { class: "page cart" },
        card(
          {},
          ...cart.map((l) => {
            const item = findItem(catalog.categories, l.itemId);
            const name = item?.name ?? l.itemId;
            return h(
              "div",
              { class: "line" },
              item ? tile(item, "sm") : null,
              h(
                "div",
                { class: "nm" },
                h("b", {}, name),
                h(
                  "small",
                  {},
                  l.size && h("span", { class: "sz" }, l.size),
                  t("each", { price: money(price(l.itemId, l.size) ?? 0) }),
                ),
              ),
              h(
                "div",
                { class: "rt" },
                stepper({
                  qty: l.qty,
                  max: max(),
                  size: "sm",
                  less: t("less", { item: lineName(l.itemId, l.size) }),
                  more: t("more", { item: lineName(l.itemId, l.size) }),
                  onChange: (q) => step(l.itemId, l.size, q),
                }),
                h("b", { class: "num" }, money((price(l.itemId, l.size) ?? 0) * l.qty)),
              ),
            );
          }),
        ),
        hasUpi && [
          h(
            "div",
            { class: "bill" },
            h("span", { class: "label" }, t("payWith")),
            h("small", { class: "muted" }, t("noFees")),
          ),
          h(
            "div",
            { role: "radiogroup", "aria-label": t("payWith"), class: "page" },
            payRow("upi", "mobile_phone", t("payUpiTitle"), t("payUpiSub")),
            payRow("counter", "money_bag", t("payCounterTitle"), t("payCounterSub")),
          ),
        ],
        askName &&
          !editing &&
          card(
            {},
            h(
              "label",
              { class: "field" },
              t("yourName"),
              h("input", {
                type: "text",
                maxlength: "60",
                autocomplete: "given-name",
                value: customerName,
                on: {
                  input: (e) => {
                    customerName = (e.target as HTMLInputElement).value;
                  },
                },
              }),
            ),
          ),
        card({}, h("div", { class: "bill t" }, h("span", {}, t("total")), h("strong", { class: "num" }, money(total)))),
        error,
      ),
      h(
        "div",
        { class: "footbar" },
        h(
          "div",
          { class: "footbar-in" },
          h("div", { class: "tot" }, h("small", {}, t("toPay")), h("b", { class: "num" }, money(total))),
          place,
        ),
      ),
    ),
  );
}

// ── Payment ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function upiIntent(order: CustomerOrderView, key: string): Promise<string> {
  if (upiCache?.orderId === order.id && upiCache.total === order.totalMinor) return upiCache.intent;
  const { intent } = await api<{ intent: string }>("GET", `/api/orders/${encodeURIComponent(order.id)}/upi`, { key });
  if (!intent.startsWith("upi://pay?")) throw new ApiFailure(200, "bad_reply", "expected a upi://pay link");
  upiCache = { orderId: order.id, total: order.totalMinor, intent };
  return intent;
}

/** The QR for the exact amount, a `upi://` link on a phone, "I've paid" and "pay at the counter instead". */
function upiPanel(
  order: CustomerOrderView,
  key: string,
  onClaimed: (o: CustomerOrderView) => void,
  onCounter: () => void,
): HTMLElement {
  const slot = h("div", { class: "qr-slot" }, t("loading"));
  const error = h("p", { class: "error", role: "alert" });
  const paid = button(
    {
      kind: "primary",
      onClick: async () => {
        paid.disabled = true;
        try {
          const r = await api<{ order: CustomerOrderView }>(
            "POST",
            `/api/orders/${encodeURIComponent(order.id)}/claim`,
            {
              key,
              body: { method: "upi" },
            },
          );
          onClaimed(r.order);
        } catch (e) {
          error.textContent = failureText(e);
          paid.disabled = false;
        }
      },
    },
    t("iPaid"),
  );
  upiIntent(order, key).then(
    (intent) =>
      mount(
        slot,
        qrSvg(intent, t("qrLabel", { amount: money(order.totalMinor) })),
        coarse && !kiosk && linkButton(intent, "accent", t("openUpiApp")),
      ),
    (e) => mount(slot, h("p", { class: "error" }, failureText(e))),
  );
  return card(
    { class: "pay upi" },
    h("h2", {}, t("payTitle", { amount: money(order.totalMinor) })),
    slot,
    h("p", { class: "muted" }, t("upiHint")),
    error,
    paid,
    button({ kind: "ghost", onClick: onCounter }, t("payAtCounterInstead")),
  );
}

// ── Token page ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `11-047` as a large number with the day small before it. */
function tokenView(token: string, huge = false): HTMLElement {
  const dash = token.indexOf("-");
  return h(
    "p",
    { class: `tk${huge ? " huge" : ""}`, "data-testid": "token" },
    dash > 0 ? h("small", {}, token.slice(0, dash + 1)) : null,
    dash > 0 ? token.slice(dash + 1) : token,
  );
}

async function orderView(ref: OrderRef): Promise<void> {
  const gen = generation;
  const view = h("main", { class: "page order" }, h("p", { class: "muted" }, t("loading")));
  mount(
    root,
    h(
      "div",
      { class: "shell" },
      header({ title: t("trackTitle"), subtitle: t("trackSub"), back: true }),
      view,
      h("div", {}, tabs("track")),
    ),
  );
  let order: CustomerOrderView;
  let after: number;
  let ahead: number | undefined;
  try {
    const snap = await api<{ order: CustomerOrderView; lastEventId: number; ahead?: number }>(
      "GET",
      `/api/orders/${encodeURIComponent(ref.id)}`,
      { key: ref.key },
    );
    order = snap.order;
    after = snap.lastEventId;
    ahead = snap.ahead;
  } catch (e) {
    if (gen !== generation) return;
    if (e instanceof ApiFailure && e.status === 404) forgetOrder(kv);
    mount(
      view,
      h("p", { class: "error" }, e instanceof ApiFailure && e.status === 404 ? t("orderGone") : failureText(e)),
      linkButton("#/", "primary", t("newOrder")),
    );
    return;
  }
  if (gen !== generation) return;

  let rating = 0;
  let reviewText = "";
  let editButton: HTMLButtonElement | undefined;
  const counterKey = `ibow.counter.${order.id}`;
  const reviewedKey = `ibow.reviewed.${order.id}`;
  const editableLeft = () => (order.editableUntil === undefined ? 0 : order.editableUntil - Date.now());

  function payment(): Child {
    const p = order.payment;
    if (p.state === "confirmed") {
      return order.outstandingMinor <= 0
        ? card({ class: "pay paid" }, h("p", {}, t("paid")))
        : card({ class: "pay" }, h("p", {}, t("stillToPay", { amount: money(order.outstandingMinor) })));
    }
    if (p.state === "claimed")
      return card({ class: "pay claimed" }, h("p", {}, t("claimedNote", { amount: money(p.amountMinor) })));
    if (catalog.payments.upi && kv.get(counterKey) !== "1" && order.status !== "completed") {
      return upiPanel(
        order,
        ref.key,
        (o) => {
          order = o;
          render();
        },
        () => {
          kv.set(counterKey, "1");
          render();
        },
      );
    }
    return card(
      { class: "pay" },
      h("p", {}, t("payAtCounter", { amount: money(order.outstandingMinor) })),
      catalog.payments.upi &&
        order.status !== "completed" &&
        button(
          {
            kind: "ghost",
            onClick: () => {
              kv.remove(counterKey);
              render();
            },
          },
          t("payByUpiInstead"),
        ),
    );
  }

  function review(): Child {
    if (order.status !== "completed") return null;
    if (kv.get(reviewedKey) === "1") return card({}, h("p", { class: "thanks" }, t("thanksReview")));
    const error = h("p", { class: "error", role: "alert" });
    const send = button({ kind: "primary", type: "submit", disabled: rating === 0 }, t("sendReview"));
    const stars: HTMLButtonElement[] = [];
    const paint = () => {
      stars.forEach((b, i) => {
        b.setAttribute("aria-pressed", String(i < rating));
      });
      send.disabled = rating === 0;
    };
    for (let n = 1; n <= 5; n++) {
      stars.push(
        h(
          "button",
          {
            type: "button",
            class: "star",
            "aria-pressed": String(n <= rating),
            "aria-label": t("stars", { n: String(n) }),
            on: {
              click: () => {
                rating = n;
                paint();
              },
            },
          },
          "★",
        ),
      );
    }
    return h(
      "form",
      {
        class: "card review",
        on: {
          submit: async (e) => {
            e.preventDefault();
            send.disabled = true;
            try {
              await api("POST", `/api/orders/${encodeURIComponent(order.id)}/review`, {
                key: ref.key,
                body: { rating, ...(reviewText.trim() ? { text: reviewText.trim() } : {}) },
              });
            } catch (err) {
              if (!(err instanceof ApiFailure && err.code === "already_reviewed")) {
                error.textContent = failureText(err);
                send.disabled = false;
                return;
              }
            }
            kv.set(reviewedKey, "1");
            render();
          },
        },
      },
      h("h2", {}, t("reviewTitle")),
      h("div", { class: "stars", role: "group", "aria-label": t("rating") }, ...stars),
      h(
        "label",
        { class: "field" },
        t("reviewText"),
        h("textarea", {
          maxlength: "500",
          rows: "3",
          value: reviewText,
          on: {
            input: (e) => {
              reviewText = (e.target as HTMLTextAreaElement).value;
            },
          },
        }),
      ),
      error,
      send,
    );
  }

  /** The steps, each from what the order really holds: when it was placed, whether the money is confirmed, its status. */
  function steps(): Child {
    const now = shown(order);
    const at = ["pending", "preparing", "completed"].indexOf(now);
    const list: Step[] = [
      {
        title: t("stepPlaced"),
        sub: t("stepPlacedSub", { name: catalog.business.name }),
        time: clock(order.createdAt),
        state: "done",
      },
    ];
    if (order.payment.state === "confirmed" && order.outstandingMinor <= 0) {
      list.push({ title: t("stepPaid"), sub: money(order.totalMinor), state: "done" });
    }
    list.push(
      {
        title: t("stepPreparing"),
        ...(at === 1 ? { time: t("now") } : {}),
        state: at > 1 ? "done" : at === 1 ? "now" : "todo",
      },
      {
        title: t("stepReady"),
        sub: t("stepReadySub", { token: order.token }),
        ...(at === 2 ? { time: t("now") } : {}),
        state: at === 2 ? "now" : "todo",
      },
    );
    return timeline(list);
  }

  // One live region for the whole visit, updated in place, so a screen reader announces each change once.
  const pillEl = h("p", { role: "status", "aria-live": "polite", "data-testid": "status", class: "live-pill" });
  const etaEl = h("p", { class: "muted" });
  const statsEl = h("div", { class: "stats3" });
  const slots = {
    tracker: h("div"),
    payment: h("div"),
    edit: h("div"),
    actions: h("div"),
    review: h("div"),
  };
  const drawn = new Map<HTMLElement, string>();
  /** Rebuilds a slot only when what it shows changed, so focus and typed text inside it survive other updates. */
  const slot = (el: HTMLElement, signature: string, build: () => Child) => {
    if (drawn.get(el) === signature) return;
    drawn.set(el, signature);
    mount(el, build());
  };

  function paymentLabel(): string {
    const p = order.payment;
    if (p.state === "confirmed") return order.outstandingMinor <= 0 ? t("statPaid") : t("statPartPaid");
    return p.state === "claimed" ? t("statChecking") : t("statDue");
  }

  function openOrder(): void {
    openSheet({
      title: t("orderSummary", { total: money(order.totalMinor) }),
      label: t("viewOrder"),
      closeLabel: t("close"),
      body: [
        card(
          {},
          ...order.lines.map((l) =>
            h(
              "div",
              { class: "bill" },
              h("span", {}, `${l.qty} × ${lineName(l.itemId, l.size, l.name)}`),
              h("span", { class: "num" }, money(l.unitMinor * l.qty)),
            ),
          ),
        ),
      ],
    });
  }

  function render(): void {
    const now = shown(order);
    pillEl.className = `live-pill${now === "completed" ? " done" : ""}`;
    mount(pillEl, h("i"), statusText(now));
    const showEta = theme.features.cartEta && theme.etaMinutes !== undefined && now !== "completed";
    etaEl.textContent = showEta ? t("etaReady", { n: String(theme.etaMinutes) }) : "";
    const items = order.lines.reduce((n, l) => n + l.qty, 0);
    mount(
      statsEl,
      ahead !== undefined &&
        now !== "completed" &&
        h("div", {}, h("b", { class: "num" }, ahead), h("small", {}, t("statAhead"))),
      h("div", {}, h("b", { class: "num" }, items), h("small", {}, t("statItems"))),
      h("div", {}, h("b", { class: "num" }, money(order.totalMinor)), h("small", {}, paymentLabel())),
    );
    slot(slots.tracker, `${now}|${order.payment.state}|${order.outstandingMinor}`, steps);
    const p = order.payment;
    slot(
      slots.payment,
      [p.state, order.totalMinor, order.outstandingMinor, kv.get(counterKey) ?? "", order.status === "completed"].join(
        "|",
      ),
      payment,
    );
    const editable = editableLeft() > 0;
    slot(slots.edit, String(editable), () => {
      editButton = editable
        ? button(
            {
              kind: "ghost",
              onClick: () => {
                editing = { ...ref, token: order.token };
                cart = cartFromLines(order.lines, max());
                location.hash = "#/";
              },
            },
            t("editFor", { left: mmss(editableLeft()) }),
          )
        : undefined;
      return editButton;
    });
    const showNotify = canNotify() && order.status !== "completed";
    slot(slots.actions, `${showNotify}|${order.totalMinor}|${JSON.stringify(order.lines)}`, () =>
      h(
        "div",
        { class: "pairs" },
        h("button", { type: "button", class: "btn", on: { click: openOrder } }, icon("receipt"), t("viewOrder")),
        showNotify &&
          h(
            "button",
            {
              type: "button",
              class: "btn",
              on: {
                click: async () => {
                  await askToNotify();
                  render();
                },
              },
            },
            icon("bell"),
            t("notifyMe"),
          ),
      ),
    );
    slot(slots.review, `${order.status}|${kv.get(reviewedKey) ?? ""}`, review);
  }

  const ticket = h(
    "section",
    { class: "ticket" },
    h("span", { class: "tkicon" }, icon("ticket")),
    h("p", { class: "label" }, t("yourToken")),
    tokenView(order.token),
    order.customerName !== undefined && h("p", { class: "for muted" }, t("forName", { name: order.customerName })),
    pillEl,
    etaEl,
    h("div", { class: "perf" }),
    statsEl,
  );

  mount(
    root,
    h(
      "div",
      { class: "shell" },
      h(
        "div",
        { class: "ticket-wrap" },
        header({
          title: t("trackTitle"),
          subtitle: [h("span", { class: "dot" }), t("trackSub")],
          back: true,
          style: "plain",
        }),
      ),
      h(
        "main",
        { class: "order-main" },
        ticket,
        h(
          "div",
          { class: "page" },
          card({}, slots.tracker),
          slots.payment,
          slots.edit,
          slots.actions,
          slots.review,
          kiosk ? null : linkButton("#/lookup", "link", t("findToken")),
          button(
            {
              kind: "link",
              onClick: () => {
                forgetOrder(kv);
                location.hash = "#/";
              },
            },
            t("newOrder"),
          ),
        ),
      ),
      tabs("track"),
    ),
  );
  render();
  const tick = setInterval(() => {
    if (editButton === undefined) return;
    const left = editableLeft();
    if (left <= 0) render();
    else editButton.textContent = t("editFor", { left: mmss(left) });
  }, 1000);
  const unfollow = follow({
    orderId: ref.id,
    key: ref.key,
    after,
    onEvent: (e) => {
      const before = shown(order);
      order = e.order;
      if (shown(order) !== before) {
        announce(t("alertTitle", { token: order.token }), statusText(shown(order)));
      }
      render();
      // Orders ahead changes as other orders finish; the snapshot route is the one place that counts them.
      void api<{ ahead?: number }>("GET", `/api/orders/${encodeURIComponent(ref.id)}`, { key: ref.key }).then(
        (r) => {
          if (gen === generation && r.ahead !== ahead) {
            ahead = r.ahead;
            render();
          }
        },
        () => undefined,
      );
    },
  });
  cleanup.push(() => clearInterval(tick), unfollow);
}

// ── Token lookup ───────────────────────────────────────────────────────────────────────────────────────────────────

function lookupView(): void {
  const result = h("div", { class: "lookup-result", role: "status" });
  const input = h("input", {
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    placeholder: t("tokenExample"),
    "aria-label": t("tokenNumber"),
    pattern: "\\d{2}-\\d{3,}",
    required: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup.push(() => clearTimeout(timer));

  async function check(token: string): Promise<void> {
    clearTimeout(timer);
    try {
      const r = await api<{ token: string; status: OrderStatus; ready: boolean }>(
        "GET",
        `/api/tokens/${encodeURIComponent(token)}`,
      );
      mount(result, tokenView(r.token), h("p", { class: `status status-${shown(r)}` }, statusText(shown(r))));
      if (r.status !== "completed") timer = setTimeout(() => void check(token), 5000);
    } catch (e) {
      mount(
        result,
        h("p", { class: "error" }, e instanceof ApiFailure && e.status === 404 ? t("tokenNotFound") : failureText(e)),
      );
    }
  }

  mount(
    root,
    h(
      "div",
      { class: "shell" },
      header({ title: t("findToken"), subtitle: t("trackSub"), back: true }),
      h(
        "main",
        { class: "page lookup" },
        card(
          {},
          h(
            "form",
            {
              class: "page",
              on: {
                submit: (e) => {
                  e.preventDefault();
                  void check(input.value.trim());
                },
              },
            },
            h("label", { class: "field" }, t("tokenNumber"), input),
            button({ type: "submit", kind: "primary" }, t("check")),
          ),
        ),
        card({ class: "tk-result" }, result),
      ),
      tabs("track"),
    ),
  );
}

// ── Kiosk ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A fresh page: nothing of the last customer survives, because a kiosk keeps everything in memory only. */
function kioskReset(): void {
  location.replace(location.pathname + location.search);
}

function kioskPay(created: Created): void {
  kioskBusy = true;
  if (!catalog.payments.upi) {
    kioskDone(created.order);
    return;
  }
  mount(
    root,
    h(
      "div",
      { class: "shell bare" },
      header({ title: t("yourToken"), subtitle: catalog.business.name }),
      h(
        "main",
        { class: "page order" },
        h("section", { class: "ticket" }, tokenView(created.order.token, true)),
        upiPanel(created.order, created.key, kioskDone, () => kioskDone(created.order)),
      ),
    ),
  );
}

function kioskDone(order: CustomerOrderView): void {
  kioskBusy = true;
  let left = resetSeconds;
  const countdown = h("p", { class: "muted" }, t("newOrderIn", { seconds: String(left) }));
  mount(
    root,
    h(
      "div",
      { class: "shell bare" },
      header({ title: t("yourToken"), subtitle: catalog.business.name }),
      h(
        "main",
        { class: "page order done" },
        h(
          "section",
          { class: "ticket" },
          h("p", { class: "label" }, t("yourToken")),
          tokenView(order.token, true),
          h(
            "p",
            { class: "pay" },
            order.payment.state === "claimed"
              ? t("claimedNote", { amount: money(order.payment.amountMinor) })
              : t("payAtCounter", { amount: money(order.totalMinor) }),
          ),
          h("p", {}, t("listenForToken")),
          countdown,
        ),
        button({ kind: "primary", onClick: kioskReset }, t("startNewOrder")),
      ),
    ),
  );
  const timer = setInterval(() => {
    left--;
    if (left <= 0) kioskReset();
    else countdown.textContent = t("newOrderIn", { seconds: String(left) });
  }, 1000);
  cleanup.push(() => clearInterval(timer));
}

function watchIdle(): void {
  const touch = () => {
    lastTouch = Date.now();
  };
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, touch, { passive: true });
  setInterval(() => {
    if ((itemCount(cart) > 0 || kioskBusy) && Date.now() - lastTouch > IDLE_MS) kioskReset();
  }, 1000);
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  initMode();
  mount(
    root,
    h(
      "div",
      { class: "shell bare" },
      h("div", { class: "hdr", "data-style": "plain" }, h("div", { class: "brand" }, h("h1", {}, " "))),
      menuSkeleton(),
    ),
  );
  const [loadedCatalog, loadedTheme] = await Promise.all([
    api<StoreCatalog>("GET", "/api/catalog").catch((e: unknown) => e),
    loadThemeInfo(),
  ]);
  theme = loadedTheme;
  useStrings(theme.strings, locale);
  if (!("categories" in (loadedCatalog as object))) {
    mount(
      root,
      h("p", { class: "page error" }, failureText(loadedCatalog)),
      h("div", { class: "page" }, button({ kind: "primary", onClick: () => location.reload() }, t("retry"))),
    );
    return;
  }
  catalog = loadedCatalog as StoreCatalog;
  document.title = catalog.business.name;
  document.documentElement.lang = lang;
  if (kiosk) {
    document.body.classList.add("kiosk");
    watchIdle();
  }
  window.addEventListener("hashchange", () => route());
  route();
  // A look the owner saves reaches an open page: the sheet swaps at once, what the toggles change on the next draw.
  watchTheme(theme, (next) => {
    theme = next;
    useStrings(theme.strings, locale);
    if (document.querySelector(".sheet") === null && (location.hash === "" || location.hash === "#/")) route(false);
  });
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

void start();
