# ibow: architecture

```
 customer phone ──┐                              ┌── counter screen (staff phone)
 (catalog, cart,  │   HTTP (JSON)                │
  token page)     ├──────────►  server  ◄────────┼── station screens (one per station)
                  │   SSE (events)   │           │
                  └──────────────────┤           └── owner dashboard
                                     ▼
                       core (pure TS)  ──►  store (SQLite)
```

One Hono app serves the JSON API and server-sent events (SSE); the static client is files. It runs two ways: as a
plain Node process (`src/server/main.ts`: local development, tests, self-hosting), or on Cloudflare Workers
(`src/worker`, D-030): the Worker serves the files as static assets and sends `/api/*` to one Durable Object per
install, which is the single writer and holds the business in its SQLite storage. The core holds every rule as pure
functions, so all behaviour is unit-testable with no server.

## Modules
| Module | Job | Must not |
|---|---|---|
| `src/core/config` | Load and validate `business`, `catalog` and `stations` config; route an item to exactly one station | Know any business, item, category or station by name, or assume a kind of business |
| `src/core/orders` | Order model, status machine (pending → preparing → completed, undo window), customer edit window, per-line ready (a station's step) and served (the counter's), money totals in integer minor units | Do I/O or read the clock (time is passed in) |
| `src/core/tokens` | `DD-NNN` token from a per-day counter; unique under concurrent creates | Reset on anything but the date in the business's timezone |
| `src/core/batches` | Total open items per station; build the spoken batch text | Format for one language only (text comes from a template) |
| `src/core/money` | Minor-unit exponent per ISO 4217 currency, plain amounts for payment links, display through `Intl` | Assume a currency or a locale |
| `src/core/payments` | Payment states (`claimed`, `confirmed`), staff top-ups of a confirmed payment; the UPI adapter's intent (`upi://pay?pa=…&am=…&tn=Token …`), INR only | Mark anything `confirmed` without a staff action |
| `src/core/insights` | Rule-based reports over orders: hourly, peak, popular, vs yesterday, prep forecast, the daily summary's facts (D-015) | Call a model (that is `src/ai`), read a customer name, or format for display |
| `src/core/regulars` | Repeat-customer visit counts from the optional name, within retention (D-018) | Use a phone, account or device id |
| `src/core/sections` | The table sections edited at run time, checked with the `spots.json` rules; the layout in force (`withLayout`); which section an order sits in (D-102) | Edit a room zone, whose QR keys depend on `spots.json` |
| `src/core/floor` | A runner's own sections first (`mineFirst`) and each spot's state on the floor (`floorState`), from the runner's rows (D-103) | Read the clock or show a staff name to a guest |
| `src/store` | The only module that touches SQL: migrations, queries, transactions, over a `SqlDriver` (`driver.ts`); `node.ts` is `node:sqlite` plus the file helpers (D-031) | Leak SQL or the driver outside its API, or import an engine in `store.ts` |
| `src/worker` | The Cloudflare side: the Worker (`index.ts`), the Durable Object that is one install (`install.ts`: boot, demo mode, alarm), its SQL driver (`do-sql.ts`), bundled config (`config.ts`) (D-030 to D-035) | Hold a rule, or be imported by Node code |
| `src/server` | HTTP routes, SSE streams per audience (order, counter, station, owner), auth sessions, static client | Hold business rules (delegate to core) |
| `src/client` | Customer, counter, station and owner pages: vanilla TS, Web Speech, Vibration and Notification APIs, 80mm print CSS | Depend on a UI framework or a CDN at runtime |
| `src/demo` | Seed a demo database from a sample's rush (today and the past week, through the real rules; D-019) | Run on a database the demo didn't mark |
| `src/ai` | The one door to any model (`model.ts`: the `Adapter` interface, settings, `AiError`; `chat-completions.ts`: the one adapter; `index.ts`: the adapter list; D-026), and the AI analyst (`analyst.ts`: named figures from insights, the prompt, the number check; D-027), and the menu reader (`menu-reader.ts`: the prompt that turns a menu page into JSON; requests may carry images, D-091, D-092) | Be required (everything works without it), hold a vendor SDK, or see a customer name, review text or the key outside the server |
| `src/import` | Menu import for `npm run import-menu` (M15): files to model parts, HTML stripped in code, PDF refused, text split under a budget (`inputs.ts`; D-093, D-095); the model's readings to a checked catalog with a review list (`catalog.ts`; D-092, D-094) | Call a model itself (it goes through `src/ai`), guess a price, or write a catalog `parseCatalog` refuses |

## Contracts
- **Config** (`config/business.json`, `config/catalog.json`, `config/stations.json`), validated at boot; a bad file
  stops the server with the path and the field. One business per install (D-009). Sample businesses live in
  `samples/<name>/` (the same three files plus a seeded `rush.json`).
  - business: `{name, currency, timeZone, maxQtyPerLine?, retentionDays?, cashShortcuts?, phone?, address?}`; `retentionDays` (1 to
    3650, default 30) is how long customer names and review text are kept (D-016); `currency` is an ISO 4217 code and
    `timeZone` an IANA zone, both required with no default. `maxQtyPerLine` (1 to 10000, default 99) caps one line's
    quantity, and core refuses any order whose total isn't a safe integer (`total_too_large`). `cashShortcuts` lists
    the cash amounts the counter offers as one-tap "handed over" buttons, in major units of the currency (`[5, 10, 20,
    50]`); core keeps them as `cashShortcutsMinor`. Without them, or when none covers the amount due, the counter offers
    the next notes up (1-2-5 steps of the major unit), so no currency needs a table (D-013).
  - catalog: `categories[{id, name, icon?, items[{id, name, price? | variants[{size, price}], tags?, description?, image?, diet?, available?}]}]`. An item
    is anything sold: a dish, a drink, a packed good or a service. `icon` is a bundled icon name; `image` a file in the config
    folder or an https URL; `diet` is `veg`, `non-veg` or `egg`; `description` shows only when present.
  - Order-at-counter venues (M10, D-063 to D-068). `business.json` also takes `lateMinutes` (1 to 120, default 6: after it, an
    order handed over in part or a line left ready counts as late for the runner) and `hours.lastOrder` (`HH:MM` inside the
    open hours: customers' orders stop after it, `409 closed`; staff can still key one in; without it hours only describe the shop).
    `catalog.json` may hold `extras`: a library `[{id, name, min?, max?, options: [{id, name, price}]}]` (option ids unique across
    the whole library; `price` may be 0; `min` default 0, `max` default the option count), named by id in `extras: [groupId]` on a
    category (all its items) or an item, and `station` on an item (its own station, overriding its category's), and `filters`:
    `[{id, name, tag, mode?: "include"|"exclude"}]`, chips on the storefront from item `tags`. `spots.json` (optional, `[]` allowed): zones
    `[{id, name, count, prefix?} | {id, name, spots: [name]}]`; a spot's id is `<zone>-<slug>` and its label `<zone name> <spot>`
    ("Garden T4"). An order line is `{itemId, size?, qty, extras?: [optionId], note?}` (note trimmed, at most 80 characters) and the order
    takes `spot` (a spot id) on creation. The order stores the label as `spot`, each line its extras as `[{id, name, priceMinor}]`
    (names and prices fixed when added, like the unit price, which includes them), its note, and `readyAt`/`servedAt`.
    Errors: `bad_extras`, `bad_note`, `bad_spot` (400), `sold_out` (409).
  - Stays and events (M14). A zone may be `"kind": "room"`: its spots are rooms, and an order from one may carry `pay: "room"`
    (the room bill, `roomBill: {room, settlement?}`; customers see `roomBill: "open" | "settled"`; `400 bad_room` elsewhere;
    the counter's confirm and the guest's claim answer `409 room_bill` while it is open; D-082). `GET /api/rooms` and
    `POST /api/rooms/:room/settle {method, amountMinor}` (`orders.run`; `409 room_changed` / `nothing_to_settle`; D-083).
    `events.json` (optional): `[{title, date, start, end?, note?, price?, audience?: "all"|"staff", rush?, repeat?: {weekdays:
    ["sun", …], until?}}]`, seeded once; `GET /api/events` (anyone: guest events; signed in: all; the next occurrence of
    each in 7 days), `GET /api/events/all`, `POST /api/events`, `PUT` and `DELETE /api/events/:id` (`events.manage`;
    `400 bad_event`, `409 too_many_events`; D-084). The owner's insights carry `rooms: {open, totalMinor}` with a room zone.
  - theme (optional, `theme.json`, D-047) and strings (optional, `strings.<locale>.json`): the look and the customer's words, below.
  - stations: `[{id, name, categories[], view?: "batch"|"jobs", speak: true|false, print: "ticket-80mm"|null}]`.
    `view` (default `batch`) is how the station screen shows its work: `batch` totals open lines across orders and
    speaks them as one batch (the core batch text); `jobs` shows one card per order, for work that belongs to one
    customer, such as a repair (D-013). `speak` says arrivals aloud: the whole batch once a burst settles, or each new job. A station is wherever work
    happens (a tea counter, a grill, a packing table, a workshop). Every category maps to exactly one station; the
    counter is a role, not a station.
- **Order event** (SSE, all audiences): `{id, type: "order.created"|"order.updated"|"order.status", at, order}`, the
  SSE `id:` equal to `id`. Each audience gets a filtered view of `order` (`src/core/views.ts`): a customer sees no staff
  details, a station sees only its own lines (each with its `index` in the order, empty when an edit removed them).
  Ids increase monotonically, so a client reconnects with `Last-Event-ID` and misses nothing.
  - Streams: `GET /api/stream/counter` and `/station/:id` (staff), `/owner` (owner), `/order/:id?key=` (customer).
    A first connect may pass `?after=<lastEventId>` from the snapshot route; with neither, a stream starts at "now".
  - Polling fallback: the same paths under `/api/poll/…?after=<id>` return `{events, lastEventId}`.
- **Ready and paid.** A station marks its lines `ready`; an order is ready when every line is ready or served
  (`isReady`), which the counter shows as its Ready tab and the customer as "Ready" before staff mark it collected
  (`completed`). Ready and served lines leave the batch. A top-up adds to a confirmed payment's `amountMinor` and
  records `{method, amountMinor, at, by}` in `topUps`, so `outstandingMinor` stays total minus confirmed (D-007).
- **Money** is integer minor units of the business currency everywhere (`price`, `unitMinor`, `amountMinor`); an order
  carries its `currency`. Major units appear only in display (`formatMoney`, via `Intl`) and in a payment link's amount
  (`majorAmount`). UPI is one payment adapter and refuses any currency but INR (D-010).
- **Time** is epoch milliseconds in the store; the "day" for tokens and reports uses `timeZone` from `business.json`, its only source.

## Look (`theme.json`, `strings.<locale>.json`, the Appearance override; D-047 to D-051)
Every field is optional; defaults are the approved green and yellow look. Unknown fields are refused.
```json
{ "colors": { "primary": "#2d5a27", "accent": "#f5c518", "header": "#1e3d1a",
              "light": { "surface": "#f5f5f5", "text": "#151a14" }, "dark": { "surface": "#121512", "text": "#f4f6f2" } },
  "font": "inter | lora | nunito | space-grotesk | system", "radius": "sharp | soft | round",
  "density": "comfortable | compact",
  "header": { "style": "awning | plain | image", "awning": ["#a8d24e", "#ffffff"], "image": "banner.jpg" },
  "logo": "hot_beverage | logo.png | https://…", "categoryIcons": { "<category id>": "bell | icon.png | https://…" },
  "features": { "favourites": true, "recent": true, "tags": "off | catalog | auto", "veg": true, "darkToggle": true, "cartEta": true } }
```
Everything else is derived in `src/core/theme.ts` (card, inks, tints, on-colours, readable text colours, shadows, tile
tints). `GET /theme.css` is the whole theme as custom properties; the shared stylesheet and the components in
`src/client/ui/` read only those. `strings.<locale>.json` overrides any key of `src/core/labels.ts` (the customer's
labels) and must keep the default's `{placeholders}`. The owner's Appearance override lives in the store and is merged
over the config's theme (the same parser checks the result); reset removes it.

## Config (`.env`, gitignored; `.env.example` committed)
`PORT` (default 3000), `HOST` (default `127.0.0.1`; `0.0.0.0` for phones on the LAN or a proxy on another host), `CONFIG_DIR` (the three config files; default `./config`), `DATA_DIR` (holds `ibow.db`; default
`./data`), `OWNER_PIN_HASH` (required; `node scripts/hash-pin.ts` reads the PIN from stdin and prints it), `UPI_VPA`,
`UPI_PAYEE_NAME` (UPI is offered only when `UPI_VPA` is set; the server refuses to boot if it is set for a non-INR
business or isn't a UPI ID; the payee defaults to the business name), `TRUST_PROXY` (default 0: use the socket address; N: N reverse proxies in front, so the client
address is the Nth from the right of `X-Forwarded-For` and `X-Forwarded-Proto: https` makes the session cookie
`Secure`; set it only if every request passes through those proxies). Staff PINs are set by the owner through the API and stored hashed in the database. No session secret:
session ids are random and held server-side (D-011). `npm start` builds the client (`npm run build`, esbuild into
`dist/client`) and runs `src/server/main.ts`, which fails at boot on a missing setting, a malformed PIN hash, a bad
config file or a missing client build. `npm run backup -- <file>` writes a consistent copy of `ibow.db` while the
server runs (D-021); `npm run demo` runs a seeded sample on a database of its own (D-019). On Cloudflare the same settings are Worker vars and secrets, not `.env` (D-034): `wrangler.toml` for your business,
`wrangler.demo.toml` for the demo. Installing on Cloudflare or a VPS: `docs/install.md`.
AI (optional, D-026): `AI_BASE_URL` and `AI_MODEL` turn the analyst on (both empty: off), `AI_API_KEY` (optional; refused over
`http://` to anything but loopback), `AI_TIMEOUT_SECONDS` (1 to 290, default 30), `AI_ADAPTER` (default `chat-completions`).
A half-set configuration stops the boot.

Anyone: `GET /api/demo` → `{demo: false}`, or on a demo install `{demo: true, staff: [{id, pin, role}], owner: {pin}}` (D-035).

## Client (`src/client`)
One page for the customer: `/` is the storefront and `/?kiosk=1` the same page on a shop-owned screen (`&reset=<s>`
sets the reset delay, default 20 s; `&idle=<s>` the reset after no touch mid-order, default 120 s; `&name=1` asks for a
name). Hash routes: `#/` catalog, `#/cart`, `#/order` (the
token page, with the payment step on it), `#/lookup`. Modules: `app.ts` (views), `cart.ts` and `catalog.ts` (pure,
unit-tested), `session.ts` (client key and order key), `api.ts` (fetch, `X-Order-Key`), `live.ts` (SSE then polling),
`alerts.ts` (tone, vibration, notification), `qr.ts`, `dom.ts` (elements and text only, never HTML strings), `strings.ts`
(every UI string; money via `formatMoney`), `sw.ts`.

The staff page is `/staff` (`staff.html`, `staff.ts`): sign in with a staff ID and PIN, then `#/counter` or
`#/station/<id>`. Opened straight from a link or a reload, a screen first asks for one tap, because browsers allow
sound and speech only after one. Counter: Pending, Preparing and Ready tabs (Ready = `isReady`), confirm cash (with
the change helper) or UPI for the amount due, top-up after added lines, start preparing, collected, serve line by
line, add items, call the token aloud, print a receipt, undo within 5 minutes (collected orders stay listed for that
long), and a quick-order panel for walk-ins (catalog, cart, cash or a UPI QR for the exact total). Station: own open
lines only, live over its SSE stream; batch view (the core batch text, replay, ready per batch line or all) or jobs
view (a card per order, ready per line or per job); an Undo chip takes back the last ready tap for 5 minutes.
Station staff (role `station`) see only stations. `#/runner` (any non-station role) lists open orders with their spot and each line's station and state ("2 of 3 delivered, waiting on Smoothies"), late ones first, announced once and spoken; "Delivered" marks a line served (D-067). `options-sheet.ts` is the one sheet (size, extras within each group's min and max, note, quantity) the storefront and the counter's walk-in panel both open for an item with sizes or extras; the cart page has a note field per line and a "where are you sitting" choice preset by `/?spot=<id>`. The owner's `#/spots` page (shown only with spots) prints one QR card per spot (`owner-spots.ts`), from the layout in force. `#/sections` (`staff-sections.ts`, power `sections.edit`) edits the table sections and their spots (D-102); `#/floor` (`staff-floor.ts`, counter, manager, owner) shows each section's spots coloured by `floorState` with its runner picker, and with `ops.sections` the runner lists "My sections" first with an "All" switch (`mineFirst`, D-103). Shared modules: `voice.ts` (one speech queue, so call-outs never
overlap; rate and mute kept per device in localStorage), `staff-strings.ts` (the staff strings, apart so the storefront doesn't carry them), `staff.css`, `cash.ts` (cash options and change due), `print.ts` (80mm
station ticket and counter receipt into `#print`, which only `@media print` shows, 72 mm wide), `live.ts`
(`followStream` for any audience). Every page links `/theme.css` before `style.css` (the components, `ui/ui.css`); the storefront adds `store.css`. Components in `src/client/ui/`: `button`, `chip` (pill and badge), `card` (and quick card), `sheet`, `stepper` (and the ADD button), `tabbar`, `header` (the awning), `stat`, `timeline`, `keypad`, `toast`, `skeleton`, `icon`, plus `theme-client` (the toggles from `/api/theme`, the dark-mode choice kept on the device, the live sheet swap). The storefront is a menu (header with search, category rail, favourites, recent and live-token cards, item cards with tags, description, veg marker, photo or tinted tile, ADD to stepper; a size sheet for items with sizes), a cart (lines, payment choice, name, total, place order), the token page (a ticket with the token large and the day small, status pill, typical wait when known, items, total and payment, a timeline built from what the order really holds, payment, edit, review) and token lookup, under a Menu, Cart and Track tab bar and a floating cart bar. Favourites and the last ten orders are kept on the phone only (`local.ts`); a kiosk keeps nothing. The owner's dashboard is `/owner` (`owner.html`, `owner.ts`, `owner-appearance.ts` for the Appearance screen, `owner-view.ts` for the pure parts, `owner-strings.ts`,
`owner.css`; plus `owner-ai.ts` and `owner-ai-strings.ts`, the AI analyst's panel, built as `owner-ai.js` and linked by the server only with AI on, D-028): the owner PIN only, then Today (summary sentences from the core facts; Ordered, Received and Awaiting confirmation kept apart, D-015; an SVG chart of orders
by hour, popular items, tomorrow's prep), Orders (Pending, Preparing and Completed tabs for the day, live over the owner
stream, with a "Returning" badge), Items (on/off switches), Staff and Reviews. It has no service worker, and the
storefront's worker leaves any navigation but `/` alone, since its scope `/` covers `/owner` too. The storefront menu
re-reads `/api/catalog` every 30 s (`&catalog=<s>`) and redraws when an item was switched. The server reads `dist/client` into memory at boot
(`src/server/static.ts`), serves it gzipped with a strict CSP, and generates `manifest.webmanifest` from `business.json`.
A kiosk keeps everything in memory and resets by reloading, so nothing of one customer reaches the next.

## HTTP API (`src/server/app.ts`; JSON in and out, errors as `{error: <code>, message}`)
| Who | Routes |
|---|---|
| Anyone | `GET /theme.css` (the tokens; ETag of build and theme version) · `GET /api/theme` (version, header style, logo, category icons, toggles, labels per locale, the computed `popular` tags and `etaMinutes`) · `GET /media/<file>` (only config-folder images the theme or catalog names) · `GET /api/catalog` (business `{name, currency, timeZone, maxQtyPerLine, lateMinutes, cashShortcutsMinor?, hours?}`, `payments: {upi}`, `zones?`, `extras?`, `filters?`, `left?` (today's counts), categories) · `POST /api/orders` `{clientKey, lines, customerName?, spot?}` (idempotent by `clientKey`; returns the order, its secret `key` and `lastEventId`) · `GET /api/tokens/:token` (today's status and whether it is ready, nothing else) · `POST /api/login` `{user, pin}` · `POST /api/logout` |
| Customer, with `X-Order-Key` or `?key=` | `GET /api/orders/:id` · `POST /api/orders/:id/messages` (`{chip}` or `{text}` to the staff, with `ops.messages`; `429 too_soon` with `Retry-After`, `409 too_many_messages` or `messages_closed`, `403 messages_off`; D-104) · `PUT /api/orders/:id/lines` (edit) · `POST /api/orders/:id/claim` · `GET /api/orders/:id/upi` (`{intent}` for the exact total, `404 no_upi` if not offered) · `POST /api/orders/:id/review` `{rating: 1–5, text?}` (once, after completion; stores no customer details) |
| Staff or owner session (confirm, top-up, add lines, advance, undo and served need a `counter` or `all` role) | `GET /api/orders` (open, plus completed ones whose guest waits for an answer within 30 minutes of closing, with `lastEventId`) · `POST /api/orders/:id/reply` (`{chip}` or `{text}`, power `orders.view`; D-104) · `GET /api/stations` (`{id, name, view, speak, print}` each) · `GET /api/stations/:id/orders` · `POST /api/stations/:id/ready` and `…/unready` `{lines: [{orderId, index}]}` (several orders at once; all checked before any changes; lines already in that state or served are left as they are) · `POST /api/orders/:id/confirm` `{method, amountMinor}` · `…/topup` `{method, amountMinor}` (only on a confirmed payment, at most what is owed: `409 overpay`) · `…/advance` · `…/undo` · `POST /api/orders/:id/lines` (add) · `…/lines/:index/served` · `GET /api/me` |
| Owner session | `GET /api/owner/theme` (config theme, effective theme, whether overridden, contrast failures) · `PUT /api/owner/theme` (the override; 400 `bad_theme` names the field) · `DELETE /api/owner/theme` (reset to config) · `GET /api/staff` · `PUT /api/staff/:id` `{name, pin, role?}` (`counter`, `station` or `all`, the default; D-014) · `PUT /api/owner/items/:id` `{available?, count?}` (kept in the store, applied to the catalog and order rules at once; D-017; `count` is how many are left today, 0 sells out, `null` lifts the limit; D-068) · `GET /api/owner/orders?day=YYYY-MM-DD` (the day's orders in every status, default today, plus `regulars`: earlier visit days by name key; D-018) · `GET /api/owner/insights` (`{currency, timeZone, report, carry?: {lines, averageMs, maxMs}}`) · `GET /api/owner/reviews` (latest 50 with tokens, `count`, `averageRating`) · `GET /api/owner/export?from=&to=` (a day range, 7 days by default, 31 at most, as JSON with no sessions or PIN hashes; D-037, D-043) · with AI on only: `POST /api/owner/ask` `{question}` (1 to 500 characters; 30 an hour per session, `429 rate_limited`) → `{answer: {text, figures: [{key, label, value, unit}], unverified, grounded}}`, or `502` with `ai_timeout`, `ai_unreachable`, `ai_refused` or `ai_bad_reply` (D-027, D-028) |
| By power (`src/core/levels.ts`; D-072 to D-076) | `GET /api/me` (any level: `{user, role, access, canRefund, refundLimitMinor?, powers}`) · `GET /api/hub` (anyone: the links the level may open, grouped; D-074) · `POST /api/orders/:id/refund` `{method, amountMinor}` (`refund`: a manager up to `managerRefundLimit` on one order, `403 refund_limit`; the owner any; `409 over_refund` / `bad_state`; D-071) · `PUT /api/menu/items/:id` (`menu.switch`, the same as the owner path) · `GET /api/flags` and `PUT /api/flags/:key` `{value}` (the look's by the owner, the system's by the admin, audited; D-075) · `GET /api/admin/health` (`telemetry`: counts, verdict, rows today, size, uptime, backup; D-076) · `GET /api/owner/ai` (`ai.ask`: `{on}`) · `GET /api/sections` (`orders.view`: `{on, edited, sections, zones, runners, staff}`) · `PUT /api/sections` `{sections: [{id?, name, spots: [name]}]}` (`sections.edit`; table sections only, `400 bad_sections` naming the field, `400 room_section`; D-102) · `PUT /api/sections/:id/runner` `{user | null}` (`orders.run`; for the business day; `404 no_such_section`, `400 bad_runner`; D-103) |

Request bodies over 16 KB get `413 too_large`. Open SSE streams are capped at 3 per customer order and 5 per staff session (`429 too_many_streams`), and the
server accepts at most 1000 sockets. Rate limits (in memory, per install): 60 new orders a minute per client address, staff sessions exempt; 5 PIN
attempts per address and user per 15 minutes, counted before the PIN is checked so parallel guesses can't slip past;
10 attempts per user from any address lock that user out for 15 minutes, doubling each time up to 24 hours (anyone
can trigger that lockout for the owner by guessing, a known cost of stopping brute force). Unknown user ids are checked
against a dummy hash, so timing doesn't reveal which exist.

Credentials a client holds:
- `clientKey` is a credential, not a label: a retry with the same key returns the order **and its secret key**. The
  client must generate it randomly, with at least 128 bits (for example `crypto.randomUUID()` or 16 random bytes in
  base64url), and never derive it from the token, the time or the cart.
- The order's secret key goes in the `X-Order-Key` header on every `fetch`. Only the customer's SSE stream takes it as
  `?key=` (`EventSource` can't set headers), so it may appear in a reverse proxy's access log; keep those logs private
  and short-lived, or strip the query string from them.

## Levels and powers (D-072)

Four levels, each signing in with its own PIN at `/admin` or at a screen's own sign-in: **staff** (counter and stations,
narrowed further by the staff member's own `counter`, `station` or `all` role), **manager** (a staff member the owner
creates with the role `manager`; day to day), **owner** (`OWNER_PIN_HASH`) and **admin** (`ADMIN_PIN_HASH`, the install
itself: it sees no customer or sales data). The one table is `src/core/levels.ts`; every route asks it, the links hub reads
it, and `tests/levels.test.ts` fails if this copy drifts from it.

<!-- powers:start -->
| Power | What it lets a person do | staff | manager | owner | admin |
|---|---|:-:|:-:|:-:|:-:|
| `orders.view` | See open orders on the counter, stations and runner screens | yes | yes | yes |  |
| `orders.run` | Take payment, serve, advance and add to orders (a staff member's own role may narrow it) | yes | yes | yes |  |
| `refund` | Hand money back on an order (a manager up to `managerRefundLimit` on one order) |  | yes | yes |  |
| `menu.switch` | Switch items on or off and set today's counts |  | yes | yes |  |
| `events.manage` | Add, change and delete the business's events, and who sees each |  | yes | yes |  |
| `sections.edit` | Add, rename and delete the table sections and their spots |  | yes | yes |  |
| `reports` | Read the dashboard, orders, reviews and the export |  |  | yes |  |
| `staff.manage` | Add staff and managers, change their PINs and roles |  |  | yes |  |
| `look.edit` | Change the Appearance and the spots |  |  | yes |  |
| `flags.look` | Flip the look and menu switches (the theme's features) |  |  | yes |  |
| `flags.ops` | Flip the operations switches: UPI, counter first, guest messages, sections |  | yes | yes |  |
| `ai.ask` | Ask the AI analyst (when it is on) |  |  | yes |  |
| `flags.system` | Flip the system switches: AI analyst on or off, retention days, showcase |  |  |  | yes |
| `telemetry` | Read the install's health: requests, errors, streams, rows, size, uptime, backup |  |  |  | yes |
| `hub` | Open the links hub at /admin and see the links your level may open | yes | yes | yes | yes |
<!-- powers:end -->

## Field notes (append what the real world taught us; keep it short)
- M16 part B: orders stored only their spot's label, so nothing could place an old order in a section once spots became
  editable; orders now keep `spotId` too, and `sectionOf` falls back to the label for orders taken before. A staff
  session lasts 12 hours, so a test that moves the clock to the next business day must sign in again. The staff page
  keeps the catalog it loaded at sign-in; a screen that changes the layout reloads it, or the walk-in spot list goes stale.
- M16 part A: a station stream that must not show an order yet skips its events rather than holding them, so the first event
  it sends of a counter-first order is the confirmation, and the station adds it like a new order (and speaks it). A staff
  screen re-renders by replacing everything, so a control that must keep its text and open pad (the search) is made once
  and placed in each render; class names in `src/client/ui/ui.css` are shared, so a staff component needs its own
  (`.search` is the storefront's fixed-height bar). The runner screen offers Deliver on every line not yet handed over, ready
  or not, so a kitchen without a station screen still works from the runner's phone.
- M15 (menu import, against a fake model only so far): prices must not be converted with floats (`20.555 * 100` is
  2055.4999…), so the importer works on the digits. A menu page whose items are drawn by scripts has no menu in its HTML;
  the importer says so and asks for a screenshot or saved text. A model reply cut off at `max_tokens` is invalid JSON, so the
  part is listed as unread rather than half-imported. Still to learn from a real vision model: how often it marks
  `unsure`, keeps sizes apart, and returns bare JSON.
- M12: an open page learns the look changed by comparing the theme's `version`, which hashed only the CSS, so a switch (a feature,
  the logo) changed no version and never reached it; the version now covers everything `/api/theme` carries. Free-plan rows
  are counted per UTC day; a Durable Object reports rows written itself (indexes included), Node only rows changed. Durations
  on Workers measure waiting, not CPU, because the clock stands still during synchronous work. A link in the hub must be
  filtered by the page's own gate, not only the API's: the owner's tabs open for the owner only, so the manager's menu is its
  own staff screen (`#/manager`).
- M10 (a garden cafe, from its reviews): the failures were operational, not menu: orders split across stations arrived in part
  and the rest never came, changes to a dish (vegan mayo, less spice) were lost, drinks stood ready until cold, cakes sold out
  unseen, staff shouted names to find people. Hence a spot on every order, extras and notes on every line, the runner screen
  with a late alert, ready-to-delivered minutes, a daily count and a last-order time. A station's batch rows show each
  order's spot beside its token, and the spoken batch says it after the token (D-073), so the person carrying a drink knows
  where to take it; the runner and the counter show it as before. Notes are customer-typed text and can hold a name, so
  they are cleared with names (D-073).
- M10: a count that reaches zero switches the item off for new orders, but must not stop the customer editing an order that
  already holds it, so edits check the count in the store, not the switch.
- M8: a page may set styles through CSSOM (`el.style.width = …`), which the strict policy allows, but not through a
  `style` attribute or `setAttribute("style")`. A preview that must not touch the page around it sets the theme's custom
  properties on its own frame. A service worker that precaches the theme sheet must serve it stale while revalidating
  and fetch a versioned request (`?v=`) from the network, or a saved look never reaches an installed page.
- From the owner's earlier counter app (live 2025-12): SSE on shared PHP hosting needed NULL-safe "changed since" queries and a
  reconnect guard against loops. Keep a polling fallback for networks that kill long connections.
- Routing items to stations by name patterns broke on new items; v1 routes by category, from config.
- A client-side PIN and paywall were bypassable from browser dev tools. All auth is server-side, with hashed secrets.
- Token generation had to sync through the server first to avoid duplicates across devices; the counter is a single
  SQLite transaction.
- The old app's tokens wrapped at 1000 (`counter % 1000`), so order 1001 reused `DD-001`. v1 widens to `DD-1000`.
- The old batch call-out listed every open order's token, even orders with nothing for that station. v1 lists only
  tokens with unserved items at the station; the text format is unchanged.
- The old app's UPI `am` was whole rupees and its payee name was hard-coded; `am` is now rupees from paise (`90`,
  `90.50`) and both VPA and payee come from config.
- Biome 2.6 formats Markdown too; `biome.json` limits it to code and JSON so the docs keep their hand wrapping.
- Node 24 runs `.ts` files directly (type stripping), so scripts need no build step; imports use `.ts` extensions.
- The five samples (tea house, coffee cart, food truck, bakery, service desk) all run on the same model with no code
  change. One misfit, for M4: a batch totals identical items across tokens (`6 Water Damage Check`), which suits
  prep but not a workshop, where each job belongs to one customer's device; a station may need a per-token view.
- Currency facts come from the runtime, not a table: `Intl.supportedValuesOf("currency")` lists the ISO 4217 codes and
  `Intl.NumberFormat(…, {style: "currency"}).resolvedOptions().maximumFractionDigits` gives the minor-unit exponent
  (INR, USD, AED 2; JPY 0; KWD 3). Node 24 ships full ICU, so this needs no data file.
- `node:sqlite` (Node 24.11, SQLite 3.50) still prints an `ExperimentalWarning` on first use; the server starts with
  `--disable-warning=ExperimentalWarning`. It is synchronous, so a `BEGIN IMMEDIATE … COMMIT` block can't interleave
  with another request in the same process: token issue and order insert are atomic without locks. Rows come back
  with a null prototype and `lastInsertRowid` is `number | bigint`, so the store maps every row to a plain object.
- The store keeps orders in tables (lines, status changes, payment) as the source of truth and also appends a full
  order snapshot to `events`. Each event lists the stations the order touched before and after the change, so a
  station hears of an edit that removed its last line and can drop the order.
- SSE without gaps or duplicates: an event only wakes a stream, which then pulls everything after the last id it sent
  from the event log. Replay after `Last-Event-ID` and live delivery are one code path, and an event committed while a
  write is in flight is picked up by the next pull. A browser's `EventSource` sends `Last-Event-ID` only on reconnect
  and can't set headers, so the first connect takes `?after=` from the snapshot route instead.
- hono's `streamSSE` fires `onAbort` when the client goes away (the response stream is cancelled), on Node too; the
  stream unsubscribes and stops its 15-second keep-alive comment there.
- A per-job station view (the service-desk misfit above) needs no new event shape: station events carry the order id,
  its token and each line's index, so a client can group by token instead of by item.
- On Windows, a few hundred TCP connects in the same instant are refused (`ECONNREFUSED`) whatever the listen
  backlog: plain `node:http` refused 368 of 600. The checkpoint replay keeps 50 requests in flight, which is still
  concurrent at the server; real phones never arrive in the same millisecond.
- Client payload (M3, esbuild, ES2020, minified): first load is 13.7 KB gzipped (app.js 30.7 KB raw / 11.7 KB gzip,
  of which the QR encoder is a good part; style.css 1.6 KB; index.html 0.3 KB). `npm run build` prints the table.
- Measured on DevTools' Slow 3G profile (CDP: 2 s round trip, 50 KB/s; `e2e/slow3g.spec.ts`, three runs): the catalog
  is usable 6.5 s after navigation on a first visit (page, then script and styles, then `/api/catalog`: three round
  trips, so latency, not size, dominates) and 2.4 s on a return visit, when the service worker serves the page and
  only the catalog call crosses the network. The test fails above 12 s and 8 s.
- esbuild 0.28 refuses engine targets like `chrome80`/`safari14` for destructuring ("not supported yet") even though
  those browsers support it; the build targets plain `es2020`.
- A phone on the LAN over plain HTTP is not a secure context: no service worker (so no install or offline cache) and no
  Notification. Ordering, SSE, sound and vibration still work. `crypto.randomUUID` also needs a secure context, which
  is why the client key comes from `crypto.getRandomValues`.
- Customer edits end when payment is claimed (D-007), so the flow is: order, change it if needed, then "I've paid".
  The edit countdown uses the phone's clock; the server's check is the one that counts (`edit_expired`).
- `EventSource` given a non-200 reply closes for good (`readyState` CLOSED), so the client falls back to polling at
  once; on a dropped connection it retries by itself and polling starts after 3 errors in a row.
- Biome turns on its Playwright lint rules once `@playwright/test` is installed and then flags any function named
  `describe`; the rules are limited to `e2e/`. Vitest runs with `--dir tests` so it doesn't pick up `e2e/*.spec.ts`.
- The browser checkpoint takes about 13 s. It is `npm run e2e`, outside the gate, so a fresh clone without Chromium
  is green; `npm run check` runs both and must pass before a milestone closes.
  Under heavy machine load the M2 checkpoint has once reset a connection (`ECONNRESET`) and a scrypt-heavy lockout test
  has once passed its 5 s timeout; both passed on rerun.
- Web Speech (M4, Chromium): `speechSynthesis.speak` stays silent until the page has had a tap, so a staff screen
  opened from a link or a reload shows a one-tap start button. The page tracks its own taps: Playwright's headless
  Chromium reports `navigator.userActivation.hasBeenActive` as true with no tap at all. Some engines now and then never
  fire `end`, which would stall a queue; the voice moves on after 4 s plus 120 ms a character. Tests replace
  `window.speechSynthesis` with an own property (an init script) and read what was spoken. Not yet heard on a real
  phone: how an engine reads a token like `26-001` ("twenty-six, zero zero one" or "twenty-six minus one").
- Print (M4): `@page { size: 80mm auto; margin: 0 }` with a 72 mm body is an 80 mm roll's printable width; 72 mm is
  272 CSS px, which the checkpoint measures under `page.emulateMedia({media: "print"})`. Tickets live in `#print`
  outside `#app`, so print CSS can hide everything else with `body > :not(#print)`. `window.print()` blocks the page
  until the dialog closes, so the tests stub it. Not yet tried on a real thermal printer.
- Client payload after M4: app.js 33.6 KB raw / 12.9 KB gzip (the strings table now holds the staff strings too),
  staff.js 38.3 KB / 14.4 KB, style.css 2.2 KB gzip; storefront first load 15.4 KB gzip.
- Each page has its own service worker, precaching only its files: `sw.js` (scope `/`) for the storefront and
  `staff-sw.js` (scope `/staff`, the longer scope wins for the staff page) for staff, with separate cache prefixes so
  neither deletes the other's cache. With the staff strings and styles split out, the storefront first load is back to
  14.2 KB gzip; `tests/build.test.ts` fails above 14.4 KB.
- Retention (M5) runs inside the server process (startup, then hourly), not as a cron job, so a plain `node` install
  needs nothing else; `json_remove` on the event log's snapshots works in Node 24's bundled SQLite.
- Chromium compiles an input's `pattern` with the `v` flag, where `[a-z0-9-]` is an invalid class (it logs an error
  and drops the check); the dash must be escaped, `[a-z0-9\-]`.
- Client payload after M5: app.js 12.3 KB gzip (the catalog re-read), storefront first load 14.3 KB gzip under the
  14.4 KB test; owner.js 6.3 KB gzip, loaded only at `/owner`.
- README media (M6) come from `npm run screenshots`: the demo on a free port, Playwright's installed Chromium at a
  390 px phone width and device scale 1 (PNGs of 24 to 64 KB), and a station's rush recorded as Playwright video and
  turned into a GIF by ffmpeg when it is on the PATH (4 fps, 270 px, 24 colours: about 340 KB). On Windows the browser
  may hold the video file for a moment after its context closes, so the temp folder is removed with retries. Killing
  `npm run demo` (rather than Ctrl+C) can't delete its temporary data, so the e2e passes its own `--data` folder.
- The AI analyst (M7) is proved against a fake Chat Completions server on loopback (`tests/support/fake-model.ts`):
  it records each request and answers by reading the figures back out of the prompt, so a fixed question set checks
  the whole path (figures, prompt, adapter, citations, number check) with no network and no key. No real model has
  answered yet: how well a small local model keeps to "copy numbers, cite keys" is untested; the number check is there
  for when it doesn't. The release export's scan blocks vendor names in code and docs (D-025), so the adapter is named
  after the API. With AI off the built `app.js`, `staff.js`, `owner.js`, the stylesheets and the pages are byte for
  byte what they were before M7 (`owner-ai.js` is 2.3 KB gzip, loaded only with AI on); only the build id in the two
  service workers moved, at the same size. CSP blocks `style` attributes but not CSSOM writes (`el.style.x = …`),
  which is how the panel sets its width without a stylesheet of its own.
- Tried against a real Ollama (M7 review), on a CPU-only machine: a 9-billion-parameter model took over 3 minutes to
  answer "Say OK", so a small model or a GPU is the advice. Node's `fetch` (undici) has its own 300 s limits for a
  reply's headers and between body chunks, whatever the abort signal says, so `AI_TIMEOUT_SECONDS` stops at 290 and
  undici's own timeouts are reported as `ai_timeout` too. Ollama's default context is 4096 tokens, tight for the
  first prompt (about 9.4 KB of JSON); the prompt is now plain `key | meaning | value` lines with no empty hours, no
  empty days and top-3 lists (under 5 KB on the tea-house fixture, `tests/ai-analyst.test.ts` holds it there), and the
  install guide says to set `OLLAMA_CONTEXT_LENGTH=8192`.
- Cloudflare Durable Object SQL, probed in workerd (2026-11-11): `PRAGMA user_version`, `application_id`, `secure_delete`
  and `VACUUM` are refused; `RETURNING`, `changes()`, JSON functions and foreign keys work; `cursor.rowsWritten` counts index
  rows, and it is what the free plan's 100,000 a day counts (about 15 rows per saved order here). `scrypt` works under `nodejs_compat` but costs about 110 ms, over the free plan's 10 ms of CPU per request (D-038): PINs use PBKDF2 at 3 ms. Compatibility dates newer than the pinned workerd's (2026-08-06) refuse to start.
- Wrangler's `alias` maps one exact module name to one file (no prefix mapping), is not overridden by an environment's own
  `[env.x.alias]`, and loses to a `paths` entry in `tsconfig.json`: so there are four `ibow-*` aliases, a second config
  file for the demo, and no `paths`. `wrangler deploy --dry-run --outdir` builds and checks everything without logging in.
- `@cloudflare/vitest-pool-workers` wants vitest 4.x; the Worker tests use Miniflare from plain vitest (`tests/support/worker.ts`).
- Windows: run vitest from a working directory spelled with a capital drive letter (`C:\…`). From `c:\…` every test file
  fails with "Vitest failed to find the current suite": the runner and the test files load two copies of vitest. Under
  PowerShell, `bash` is WSL's, which mangles Windows paths, so the shell-script tests (`release-sync`, `server-kit`) pass
  only from Git Bash; `npm run gate` from Git Bash in `C:/…` is the clean run.
- The Node server reads `dist/client` into memory when it starts: after `npm run build` a running server keeps serving the
  old client until it restarts. Screenshots of a changed client also need the origin's storage cleared first, or the
  service worker serves the cached build.
- Behind Cloudflare (a tunnel or a proxied domain), the zone's default Browser Cache TTL rewrites our `cache-control:
  no-cache` on `.js`, `.css` and images to `max-age=14400`, so a returning phone kept the old scripts and sheets for four
  hours after an update while the page itself was new. Pages now name their files with the build (`/app.js?b=<build>`,
  D-081); HTML and the API stay uncached (`DYNAMIC`). An install can also set the zone to "Respect existing headers".
- M14: Hono keeps one `onError` per app, and a later `http.onError` in a route module replaces the app's own, so every error
  became a 500 (seen when the events module added one). A route module throws `ApiError` (or a core error the app already
  maps) and never registers its own handler.
- M14: a nested `d.tx` throws "cannot start a transaction within a transaction" on `node:sqlite`; a store method that saves
  several orders at once (a room's settlement) writes them through the inner `writeOrder`, inside its own one transaction.
- M14: class names in `staff.css` are broad (`.row>button`, `.check`): a new component that reuses `row` or `check` gets
  their look and loses its own (a primary button turned pale). New screens use prefixed names (`ev-`, `room-`).
- M14: a demo kept running (`demo-serve`) used to show the day after its seed as almost empty, since only that first day was
  seeded; seeding from one random stream per day lets an hourly top-up add exactly what a fresh seed would have (D-086).
- M14 review: a room spot alone is not proof of being in the room; a spot id is guessable ("rooms-3"), so anything that
  charges a person must carry something only that place holds (the QR's HMAC key, D-082). A demo is the exception that
  publishes its keys.
- M14 review: a Durable Object's SQL can't be reached by `wrangler` or any script from outside; a one-time data fix on a
  Worker has to be a setting the object reads at start (`RENAME_ADMIN_STAFF`, D-087) or a route.
- M16: a guest message saved through `saveOrder` would rewrite the order's lines, history and payment (about a dozen rows
  for a three-line order); `saveMessages` writes the one column and the event. Any frequent, narrow change to an order
  (messages now) deserves its own store method rather than the whole-order write.
- M16: the driver's `rowsWritten` counts `run()` changes only; the event insert goes through `get()` (`RETURNING id`), so
  every save's event row is outside that count. Read row costs from the statements, not from that counter alone.
- M16: Playwright's `getByRole({name})` matches a substring: a second button whose name contains "Send" (the message form's
  "Send message") broke the review test's `name: "Send"`. Use `exact: true` for short button names.
- M16 review: a staff snapshot of open orders only lost a completed order whose guest had just asked for the bill when a
  runner reloaded; `/api/orders` now adds those, found through a partial index on completed orders with a thread.
- M16 review: "the runner of the section" is not enough to reach a person: a runner whose phone is closed would get a guest's
  message alone and nobody would hear it. The streams module now counts open staff streams per user, and a message to an
  absent runner is sent to everyone. Presence costs no rows; it lives with the sockets.
