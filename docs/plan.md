# ibow: plan

Each milestone ends at a **checkpoint**. It's done only when the checkpoint passes, the reviewer has approved, and the
work is committed. Tick it here and add one Log line. `[owner]` and `[device]` items need the owner; they may trail
the code, but the milestone isn't closed until they pass.

## M0 Foundation
- [x] Repo, brief, architecture, plan, decisions, gitignore
- [x] Toolchain set up (Node 24, TypeScript strict, Biome, Vitest); the gate (`npm run gate`) is green on an empty test
- [x] `LICENSE` (AGPL-3.0 full text), `.env.example`, `README.md` stub with the one-line pitch and "status: rebuilding"
- [x] Rebrand: no real business's name or brand anywhere in code, tests, fixtures or scripts; the live shop's menu becomes the fictional sample `samples/tea-house`
- [x] Business-neutral core vocabulary (`business` not `shop`, `catalog` not `menu`, `ticket` print not `kot`), recorded as a decision
- [x] Samples for different kinds of business under `samples/`, each with an invented catalog, stations and a seeded rush, all passing the core tests
**Checkpoint:** a fresh clone runs `npm ci && npm run gate` green with no browser installed (browser tests are `npm run e2e`), a search for the real shop's name finds nothing outside git history, and every sample loads, routes every item to exactly one station and replays its rush with unique tokens.

## M1 Core rules (pure TS, no I/O)
- [x] Config loading and validation for shop, menu (variants, availability) and stations; clear errors with path and field
- [x] Routing: every item goes to exactly one station, by category
- [x] Order model, money in paise, status machine with a 5-minute undo, 2-minute customer edit window, per-item served
- [x] `DD-NNN` tokens from a per-day counter in the shop's timezone
- [x] Batches: totals of open items per station, and the spoken batch text from a template
- [x] UPI intent builder; payment states `claimed` and `confirmed`
- [x] Fixtures: the live shop's menu and stations as config (shop details scrubbed), plus a synthetic 300-order rush
**Checkpoint:** tests show that the tea-house config routes tea/coffee to the tea station and everything else to the
kitchen, the 300-order rush yields 300 unique tokens, and batch text matches the live app's format
(`Tokens 26-001, 26-002 12 House Special Chai M, …`).

## M2 Server and store
- [x] Global-ready core before anything is stored: money in currency-neutral minor units (no `paise` in names), an
      ISO 4217 `currency` and a required `timeZone` in `business.json` (no country default), and at least one sample
      in another currency and zone
- [x] SQLite store behind `src/store` (migrations, one transaction per order create and token)
- [x] JSON API: catalog, create order (idempotent by a client key), edit, status, payment confirm, item served, undo, lookup by token
- [x] SSE per audience, with `Last-Event-ID` replay and a polling fallback endpoint
- [x] Server-side owner and staff auth (hashed PIN, sessions); rate limits on order create and PIN
**Checkpoint:** an end-to-end test boots the server on a temp database, replays the 300-order rush concurrently (50 in flight), and
every station stream receives exactly its own items with no gaps after a forced reconnect.

## M3 Customer flow
- [x] Catalog page (categories, search, variants, unavailable hidden), cart, optional name
- [x] Payment step: UPI QR plus intent link on mobile, or pay at counter
- [x] Live token page: status tracker, sound, vibration, notification, 2-minute edit, token lookup, review prompt
- [x] Screen ordering: the same storefront in kiosk mode on a shop-owned screen, resetting after each order
- [x] Installable PWA; works on a slow 3G profile
- [ ] [device] Order from a real Android phone and an iPhone against a LAN server
**Checkpoint:** a browser test (Playwright) places, edits and tracks an order through to "ready"; the device item passes.

## M4 Counter and stations
- [x] Counter: new-order alert, quick-order panel, configurable cash shortcuts, UPI QR for the exact amount, confirm payment,
      add to order, item served, call token by voice, undo
- [x] Station screen per `stations.json`: own items only, batch totals, speak and replay, mark ready
- [x] Top-up confirm: after a staff add-to-order on a paid order, the counter confirms the extra amount (`outstandingMinor` back to 0)
- [x] Ticket print for 80mm thermal printers (print CSS first; ESC/POS later)
- [ ] [device] A staged rush on real phones: one counter, two stations, ten customers
**Checkpoint:** the staged rush runs with no lost order, a correct spoken batch at each station, and a ticket that prints.

## M5 Owner and business analyst (rules)
- [x] Owner dashboard: order tabs, item availability, settings, repeat-customer badges, reviews
- [x] `src/core/insights`: hourly chart, peak hour, popular items, vs yesterday, prep forecast for tomorrow
- [x] Daily summary on the dashboard (no model call)
- [x] Retention: customer names and review text in orders, reviews and the event log are cleared after a configurable period (default 30 days); insights keep only anonymous counts
**Checkpoint:** insights over the fixture rush match hand-computed numbers in tests. ✔

## M6 Release
- [x] Install guide: Docker image and a plain `node` install on a small VPS (about US$5/month); demo mode with seeded data
- [ ] README with screenshots, a GIF of a rush, and the pilot shop's real numbers as an anonymous case study (README, screenshots and GIF done; the case study waits on the owner's numbers)
- [ ] [owner] Approve creating `YoByron/ibow` (public, AGPL-3.0) and the first push
- [x] Before the first push: publish from a fresh, squashed history, and check it for real-business names and secrets (`scripts/release-export.sh`; rerun it on the final commit)
- [ ] [device] Pilot at a real shop for one rush
**Checkpoint:** a stranger following only the README gets a working demo in 10 minutes, and the pilot rush runs clean.

## M7 AI business analyst (opt-in)
- [x] `src/ai`: one door to any model, configured by the owner's own key; off by default
- [x] The owner asks a question in plain language; answers are grounded in `insights` and the orders, with numbers cited
**Checkpoint:** with AI off, nothing changes; with AI on, answers to a fixed question set match the rule-based numbers. ✔

## M8 Design (owner: "looks like 2006, a regression from the original")
- [x] Concept screens from the owner's original app modernised with Zomato/Swiggy patterns; approved by the owner on 2026-11-11 as the baseline (after two rejected rounds of invented directions)
- [x] Fully customisable without code: a theme (colours, font, radius, logo, header style incl. the awning, icons per category, photos per item, labels and text, feature toggles) set in config and changeable any time by the owner from an Appearance screen with live preview; components modular so a new look is a theme, not a rewrite
- [x] A design system from the baseline: tokens (colour, type, spacing, radius, motion), light and dark, one icon set, self-hosted font; replaces the 14 KB budget with a measured one (first load under 60 KB gzip excluding the font, usable on Slow 3G)
- [x] Every screen rebuilt on it: storefront, cart, payment, token page, kiosk, counter, stations, owner dashboard, AI panel, print ticket stays plain
- [ ] [owner] Approves the screens from fresh screenshots
**Checkpoint:** the owner approves the screenshots; all e2e pass; Slow 3G stays usable.

## M9 Cloudflare (replaces Docker as the way to run it)
- [x] One Hono app on Workers: static assets, the API, and one Durable Object per install holding the business in its SQLite storage (single writer, so tokens stay atomic); live updates from the Durable Object; retention on a Durable Object alarm
- [x] Runs on the Workers free plan; limits checked against a 300-order rush and written down
- [x] Node stays only for local dev, tests and self-hosting; Docker, Dockerfile and compose removed
- [x] Demo mode on Cloudflare: a public demo install whose sign-in screens show the throwaway demo PINs (demo database only, never a real one)
- [x] Install guide: deploy with `wrangler`, secrets with `wrangler secret`, a custom domain
- [ ] [owner] `wrangler login` and the first deploy
**Checkpoint:** the 300-order rush replays in Miniflare (workerd, the runtime `wrangler dev` runs) with unique tokens and every station stream complete; the demo deploys from a fresh clone by following the README.

## M10 Order-at-counter venues (operations; from a real garden cafe's menu, reviews and busy times)
Customers queue, order and pay at the counter or on their phone, sit anywhere in a large space, and staff bring the order
out. Reviews name the failures: staff shout names to find people, orders split across stations arrive in part and the
rest never comes, changes to a dish are lost, ready drinks go cold, cakes sell out unseen. Generic for any such venue.
- [x] Spots: optional `spots.json` (zones and tables); a QR per spot opens the storefront with it set; the customer can
  also pick "where are you sitting"; the order carries the spot and every staff screen shows it; a printable QR sheet
- [x] Extras: groups of options per item or category (min/max picks, a price each, e.g. oat milk +50, gluten-free +50,
  extra shot +20), priced when added, shown in cart, token page, station batches (grouped by item and extras), speech
  and the kitchen ticket
- [x] A short note per line ("less spicy, no onion"), bounded, shown and spoken at the station and printed
- [x] Routing per item: an item may name its station, overriding its category's
- [x] Runner view: each open order with its spot and every line's station and state ("T12: 2 of 3 delivered, waiting on
  Smoothies"); an alert when part of an order was delivered and the rest is late; ready-to-delivered minutes on the
  owner's dashboard
- [x] Diet and allergen filters on the storefront from item tags
- [x] A daily count per item (set each morning, counts down, sold out at zero; not an inventory system)
- [x] Card as a payment method staff record; refunds recorded (amount, method, who, when) and netted in the totals
- [x] A last-order time: the storefront stops taking orders after it and says when it opens
**Checkpoint:** a private cafe config runs all of it through `npm run demo -- <path>`; the 300-order rush with extras
and spots replays with every line reaching one station; each change states its cost against a 300-order day.

## M11 Premium look (owner: "icons all across the web are childish and generic; we want full premium")
- [x] A theme for an order-at-counter garden cafe, decided from the research, shown before and after
- [x] One premium icon set replacing the 3D emoji-style icons: coherent, drawn for ibow, self-hosted SVG, styled by
  tokens; the theme picks it
- [x] Item photos: the business's own dish photos in its config (never in the repo), cropped and compressed, lazy,
  within the first-load budget
- [x] Fix: the owner header breaks the business name mid-word on a phone; the prep list's numbers overflow the card
- [ ] [owner] Approves the screens from fresh screenshots
**Checkpoint:** the owner approves; all e2e pass; first load stays within the measured budget.

## M12 Levels, links hub, feature flags and telemetry (owner, 2026-11-25)
- [x] Card payments staff record, and refunds (amount, method, who, when) netted in every total (M10 item 8)
- [x] Notes on lines are cleared with names after `retentionDays`; station batches show each order's spot
- [x] Three levels above the staff screens: owner, manager (day-to-day: availability, daily counts, runner, refunds up to a
  limit, staff screens) and system admin (install health, flags, retention, updates); each signs in with its own PIN; what each
  level may do is one table in code and one in the docs
- [x] A links hub at `/admin`: every screen of the install (storefront, kiosk, counter, stations, runner, owner tabs, spots
  QR sheet, manager, admin), grouped by level, each with what it is for; shows only what the signed-in level may open
- [x] Feature flags: the theme's and the business's switches changeable at run time by the level allowed to (owner for the
  look and the menu's features, admin for system ones), stored in the install, audited (who, when, from what to what)
- [x] Telemetry for the admin, kept on the install and never sent anywhere: requests and errors per hour, slowest routes,
  open live streams, rows written today against the free plan, database size, build and uptime, last backup
**Checkpoint:** each level signs in and sees exactly its links and powers; a flag flipped by the owner reaches an open
storefront without a reload and appears in the audit; the telemetry page answers "is this install healthy" on a phone.

## M13 App shell and the finish (owner, 2026-11-25)
- [x] An app shell with a native feel on phones: installable, full-screen, safe areas, no page jumps, transitions between
  screens, tab bars that stay put, pull-to-refresh only where it means something
- [x] A splash screen with the business's mark, animated, that hands over to the first screen without a flash; skeletons
  while data loads; one loading language across every screen
- [x] Proper dialogs for every "can't do that now": closed, last order passed, sold out, paused, offline, with when it opens
- [x] The customer's name first and an order number (not a token) everywhere a person reads it; the day stays in the data
- [x] Every screen checked on a phone and improved: storefront, sheet, cart, pay, order page, kiosk, counter, stations,
  runner, owner tabs, PIN screens, hub; tokens documented so the look can keep improving without code
**Checkpoint:** the owner approves fresh screenshots of every screen; all e2e pass; first load within budget.

## M14 Stays and events (lead, 2026-11-25)
- [x] Rooms: a `spots.json` zone may be `"kind": "room"`; a guest at a room's QR may choose "Add to my room bill", which
  stays unpaid and never counts as received until staff settle the room (D-082)
- [x] A Rooms screen for counter staff, a manager and the owner: each room's open bill and total, "Settle at checkout" in one
  cash, UPI or card payment covering exactly those orders, every settle audited; listed on the hub (D-083)
- [x] The owner's Today shows room-bill money as ordered, received once settled, and an "Open room bills" figure
- [x] Events in the store: title, date, start, optional end, one-line note, optional entry price, guests and staff or staff
  only, "expect a rush", an optional weekly repeat with an end date; managed on the owner's Events tab and the manager's
  screen; `events.json` seeds them once; cleared 2 days after their last day (D-084)
- [x] Banners: the next event within 7 days on each staff, owner and hub splash and as a card on the chooser, manager screen,
  Today and hub; on its day a CSS-only celebration and a countdown; for guests a dismissible banner under the storefront's
  header and a line on the order page (D-085)
- [x] Demo: the garden cafe has 6 rooms with open room bills, a rush-flagged guest event today, a weekly one and a staff-only
  one in 3 days; a kept demo is topped up to the clock every hour, so Today reads like a day in progress (D-086)
- [ ] [owner] Approves the Rooms, Events and banner screens from fresh screenshots
**Checkpoint:** unit tests for the room-bill money rules, event visibility (guest and staff, the 7-day window, cleanup) and the
seeded today; e2e: a guest in a room orders onto the room bill, staff settle it at checkout, and the owner's Received moves
only then; the event banner on the splash and the storefront; `npm run gate` and `npm run e2e` green.

## M15 Menu import (lead, 2026-11-25)
- [x] `src/ai` requests may carry images, as data URLs in OpenAI-compatible content parts; the analyst's requests unchanged (D-091)
- [x] `npm run import-menu -- <files...> --out <folder>/catalog.json [--currency] [--report] [--force]`: photos (png, jpg,
  webp) go to the model as images; text, Markdown and HTML are read in code, HTML stripped in code; a PDF is refused with
  "export its pages as images" (D-093)
- [x] The model reads the menu into one JSON shape; code checks it, makes stable ids, converts prices to minor units, merges
  pages in order with duplicates collapsed, maps add-ons to the extras library and proves the file with `parseCatalog` (D-092, D-094)
- [x] A review list (to `--report` or the screen) of everything a person should check, with its file: no price, odd price,
  unsure or unreadable names, duplicates, unknown tags and diets, add-ons offered nowhere, unread parts, categories with no
  station; exit 1 only for no model, a model error or nothing usable, each saying expected, found and where
- [x] Big menus split under a token budget, one call per photo, the call count printed (D-095); "Import a menu" in docs/configure.md
- [ ] Lead: a real menu through a real vision model on an OpenAI-compatible endpoint, with what it taught in the field notes
**Checkpoint:** unit tests against a fake model server: an image and a text input make a valid catalog; INR and a 3-decimal
currency in minor units; duplicates merged across pages; add-ons mapped to extras; a priceless item in the report; HTML
stripped in code; the failure messages; `npm run gate` green.

## Log
- 2026-11-07 Started from the owner's earlier counter app, run live at a real tea-and-snack shop since 2025-12; rebuilt as open source (AGPL-3.0) on 2026-11-07.
- 2026-11-07 M0 toolchain, .env.example, README stub; M1 core (config, routing, orders, tokens, batches, payments) and live-shop + 300-order rush fixtures, 47 tests green on a fresh clone; LICENSE still a placeholder awaiting the canonical AGPL text (32d9b86..d8035f8).
- 2026-11-07 Review fixes: paid amounts recorded, customer edits refused once paid, outstandingPaise and addLines; neutral batch comment; timezone only in shop.json; formatRupees guard; 54 tests green (7dd77a9..af2d117).
- 2026-11-07 M1 closed: reviewer's must-fix and nice-to-haves resolved and verified (gate 54/54 at 0b8d640). M0 waits only on the LICENSE text and the [owner] DB password.
- 2026-11-08 Renamed IBO → ibow (Intelligent Business Orchestration and Workflows), scope widened to global (D-008); Hostinger step dropped; kiosk screen ordering added to M3.
- 2026-11-08 M0 items done, awaiting review: rebrand to the fictional samples/tea-house (no real names or third-party brands), business/catalog/ticket vocabulary (D-009), four more invented samples (coffee cart, food truck, bakery, service desk) replayed by a parametrised test; 80 tests green on a fresh clone (75cfd10..5577724).
- 2026-11-08 M0 closed: rebrand, neutral vocabulary, five samples reviewed (one doc fix, ab53134); gate 80/80. Reviewer's global-readiness notes moved to the head of M2.
- 2026-11-08 M2 items done, awaiting review: currency-neutral minor units with required `currency` and `timeZone` (D-010; coffee-cart USD/New York, service-desk AED/Dubai), SQLite store with atomic token issue and an event log, JSON API, SSE per audience with `Last-Event-ID` replay and polling, scrypt PIN sessions and rate limits (D-011); checkpoint replays the tea-house 300-order and service-desk rushes through the real server; 120 tests green (e4532eb..36cb1f3).
- 2026-11-08 M2 review fixes: PIN attempts reserved before the check plus a per-user doubling lockout and dummy-hash timing, order changes applied to a fresh read after the body, `maxQtyPerLine` (default 99) and safe-integer totals, 16 KB body limit, `TRUST_PROXY`, streams end on logout/expiry and a PIN change ends sessions, SSE caps per order/session and 1000 sockets, clientKey and `?key=` documented; 132 tests green (2a27755..26d615a, plus this docs commit).
- 2026-11-08 M2 closed: reviewer's 4 must-fixes (parallel PIN guessing, lost updates, unbounded qty, body size) and 4 hardening items fixed and verified, incl. re-running the reviewer's probe (5 PIN guesses evaluated, 195 blocked); gate 132/132 at 37629b2. Name retention added to M5.
- 2026-11-08 M3 items done except [device], awaiting review: vanilla-TS storefront (catalog, cart within `maxQtyPerLine`, UPI QR/intent or pay at counter from config, live token page over SSE with polling fallback, 2-minute edit, lookup, review API), kiosk mode that resets by reload, PWA (generated manifest, icons, service worker), strict CSP, `HOST` loopback by default; esbuild, Playwright 1.61.1 (Chromium 1228, no download) and uqr (D-012); first load 13.7 KB gzip; gate 154 unit + 3 browser tests green in about 35 s (f022593..HEAD).
- 2026-11-09 M3 review polish (approved, no must-fix): gate split (`gate` without a browser, `e2e`, `check` before closing), steadier tests (low test scrypt cost, checkpoint keep-alive and create retry; 5 unit runs in a row green), one live status region and in-place updates that keep focus, star contrast, stale token-page guard, service worker pinned to one build (`X-Ibow-Build`), kiosk idle and back-button e2e, Slow 3G e2e (catalog usable 6.5 s first visit, 2.4 s return); 155 unit + 5 browser tests green.
- 2026-11-09 M3 code approved by review, polish verified (`npm run check`: 155 unit + 5 e2e green at 21015a2). M3 stays open only for its [device] item (real Android and iPhone order on the LAN).
- 2026-11-09 M4 items done except [device], awaiting review: `/staff` page with a counter (tabs, cash with configurable shortcuts and change due, UPI confirm, top-up after added lines, quick orders with a UPI QR, serve, call token, undo, receipt) and stations in `batch` or `jobs` view (D-013), per-line ready, one speech queue with rate and mute per device, 80mm print CSS; checkpoint e2e stages a rush (counter, tea, kitchen, ten customers, a walk-in) plus a jobs station on the AED sample; 176 unit + 7 browser tests green in about 32 s (1635733..HEAD).
- 2026-11-09 M4 review changes: station undo of the last ready (core `unmarkReady`, `/unready`, atomic like ready, tested), top-up capped at what is owed (`overpay`), walk-in cart fixed once its order exists, one service worker per page with staff strings and styles split out (storefront first load 14.2 KB gzip, size test at 14.4 KB), staff roles counter/station/all (D-014); 181 unit + 8 browser tests green.
- 2026-11-09 M4 code approved: review must-fix (undo for ready) and four changes verified (`npm run check`: 181 unit + 8 e2e green at d56f424); reads stay open to any staff role as D-014 argues. M4 stays open only for its [device] staged rush.
- 2026-11-09 M5 items done, awaiting review: `src/core/insights` (hourly, peak, popular by units and sales, vs yesterday by the same clock time, same-weekday prep forecast, summary facts; D-015), retention of names and review text after `retentionDays` (default 30) in orders, events and reviews, at startup and hourly (D-016), owner API and `/owner` dashboard (order tabs live, item switches applied at once with the storefront re-reading the catalog, staff, reviews, repeat badges by name; D-017, D-018); checkpoint matches hand counts over the tea-house (INR), service-desk (AED) and coffee-cart (USD) rushes; 208 unit + 9 browser tests green (6329d36..HEAD).
- 2026-11-09 M5 review changes: money split into Ordered, Received (confirmed, on its confirmation day) and Awaiting confirmation, with a staged confirmed/claimed/unpaid mix in the checkpoint (D-015); cleared names leave the file (secure_delete, WAL truncate, one-time VACUUM, raw-bytes test) and retention reads only rows since its last cutoff (D-016); order cards say Not paid / claimed / paid; order tabs roll over at midnight; owner reads refuse staff and order keys; New York DST tests; 217 unit + 9 browser tests green (439450d..HEAD).
- 2026-11-09 M5 closed: review must-fixes (money split into Ordered / Received / Awaiting confirmation; cleared names gone from the database file) and five nice-to-haves verified (`npm run check`: 217 unit + 9 e2e green at 2a48ad6). D-015 and D-016 were corrected in place while still under review, before approval.
- 2026-11-09 M6 code items done, awaiting review: `npm run demo` on a marked demo database with a seeded week and throwaway PINs, refusing any other database (D-019); release export into a fresh one-commit repo with no remote, scanned for the real name (hashed), brands and secrets (D-020); install guide for Docker and plain Node behind Caddy, `npm run backup` (D-021); README with screenshots and a rush GIF (`npm run screenshots`), case study left TODO; 241 unit + 10 browser tests green (23db2f5..HEAD).
- 2026-11-09 M6 review changes: assistant files export-ignored with an export-only check for assistant and hub names, home paths and the commit (D-022); owner tabs as chips; demo seeds ordinary days with three peaks, today up to now (D-023); screenshots in en-US and the sample's zone, regenerated; name scan finds substrings, letter-spacing and look-alikes; *.env and password settings flagged; busy demo port is one line; README LAN demo; Docker backup schedule and restores; read-only backup (D-024); .dockerignore; "Top item by revenue"; release author overrides; 252 unit + 11 browser tests green (952503d..HEAD).
- 2026-11-09 M6 code approved: review changes and the export prune verified (`npm run check`: 254 unit + 11 e2e green at 0bf6743; a fresh export is one commit, no remote, and holds no development files, assistant or hub mentions, home paths, the old name or secrets). M6 stays open for the owner: case-study numbers, release author email, repo URL, approving YoByron/ibow and the first push, one Docker build, and the [device] pilot.
- 2026-11-09 M7 items done, awaiting review: `src/ai` door with one Chat Completions adapter over `fetch`, off unless `AI_BASE_URL` and `AI_MODEL` are set, key optional for a local model and kept server-side (D-026); the analyst answers from named insight figures, cites their keys and has every number checked against them, anonymous counts only (D-027); owner-only `POST /api/owner/ask` with 30 questions an hour per session and an `owner-ai.js` panel, both present only with AI on, other bundles byte-identical with AI off (D-028); checkpoint: a fixed question set against a fake model server matches the rule-based numbers; 296 unit + 13 browser tests green (2f0d6ba..HEAD).
- 2026-11-09 M7 review changes: each number is backed only by a figure cited in its sentence, by unit and sign, with number words and other scripts' digits flagged (D-027 corrected); warning above an unbacked answer with its numbers marked; `AI_BASE_URL` without credentials, query or fragment, origin-only logs, key echoes scrubbed in any case or encoding (D-026); any lone `AI_` setting stops the boot; `npm run demo` passes `AI_` settings through; provider names allowed in the export (D-029); timeout capped at 290 s under fetch's own 300 s, prompt halved to plain lines under 5 KB, real-Ollama field notes; 326 unit + 13 browser tests green (c217ab8..HEAD).
- 2026-11-09 M7 closed: review must-fix (each number backed only by the figure its sentence cites, by unit and sign) and six changes verified (`npm run check`: 326 unit + 13 e2e green at 2ba52a2); checkpoint met against a fake model. A real local model is untested for answer quality (CPU-only Ollama timed out); recheck on a GPU or a small model.
- 2026-11-11 Publishing (M6) on hold at the owner's word: the UI reads as generic and dated, a regression from the original app (whose ~150 KB of styling the 14 KB budget stripped out), and Docker is out in favour of Cloudflare's free plan. Added M8 Design and M9 Cloudflare; the crew's builder and reviewer roles were reassigned.
- 2026-11-11 M8 baseline approved by the owner: the original app's identity (green awning, sun yellow, 3D icons, cards, Menu/Cart/Track) modernised with Zomato/Swiggy patterns. The owner asked for it to be fully customisable and modular, so anyone can restyle it easily.
- 2026-11-11 M8 items done, awaiting the owner's approval of the screenshots (docs/media; the baseline is in docs/design): the look is `theme.json` plus `strings.<locale>.json` and an owner override in the store, served as `/theme.css` and `/api/theme` (D-047 to D-051); components in `src/client/ui` styled only by tokens; storefront, size sheet, cart, token ticket, kiosk, counter with cash sheet, stations, PIN screens and the owner dashboard rebuilt; the Appearance screen has a live phone preview, a WCAG AA warning and reset; the coffee cart and service desk samples carry their own themes and words; the storefront's first load is about 25 KB gzip. Item photo upload is a later item. Commits f6e42a6, 2a4505e, d6b76a4, 3ad51b4, e00825d, a707ce6.
- 2026-11-11 M9 code items done, awaiting review and the owner's first deploy: the store runs over a SqlDriver, the Worker and one Durable Object per install (SSE kept, hourly alarm for retention, bundled config, scrypt under nodejs_compat), demo mode with throwaway PINs only on a seed-marked database (D-030 to D-037); the 300-order rush replays in workerd with unique tokens and complete station streams (9,004 of 100,000 free rows written); Docker removed; install guide on `wrangler deploy`.
- 2026-11-11 M9 review changes: PBKDF2-SHA256 PINs at 3 ms for the free plan's 10 ms CPU, the demo seeded in alarm steps (4,169 rows) and only from the demo bundle with a Demo label and AI off, insights cached and polled every 5 minutes, event log pruned after 2 days, same-length overwrite on retention, export paged by day, storage 1 GB per object (D-038 to D-043).
- 2026-11-11 M9 re-review changes: the owner's report reads two days of orders plus stored day totals (294 orders read over a 15-day history, same numbers as before, zone conversions cached), cache keyed on event and business day so an idle tab reads almost nothing, replay mark from sqlite_sequence, names blanked before events are pruned (D-044).
- 2026-11-11 M9 narrow review of the report: aggregated in SQL from write-time local minutes, plans checked to be searches only, forecast no longer overwritten by partial days, received exact by stored day and minute, closed days frozen; recompute about 6 ms of CPU on Node (D-045).
- 2026-11-11 M9 final review: start-up reads 3 rows at 90 days (was 24,717) through partial indexes, finished days read once and kept in memory with yesterday's per-minute record, recompute about 4.7 to 4.9 ms of workerd CPU at 15 and 90 days (was 13.4 to 14.5) (D-046).
- 2026-11-11 M8 and M9 merged (merge commit 1976394): the look runs on Workers (bundled theme, strings and images, `/theme.css`, Appearance and the storefront figures through the Durable Object, image hosts in the policy; D-052), the cash/UPI split is aggregated in SQL, demo PINs sit on the redesigned PIN screen, token prefix visible, plural strings (D-053), a demo-only fixed clock for screenshots at 6:30 PM (D-054).
- 2026-11-13 Published and live: public repo YoByron/ibow (AGPL-3.0, clean history; updates go out with scripts/release-sync.sh as ordinary commits), CI green on 1eb543d. The demo runs on the owner's own server as a systemd user service behind its own Cloudflare tunnel at https://ibow.saketposwal.com (showcase at /showcase), updated by a pull-based, CI-gated timer with smoke test and rollback; Workers stays documented as an option (the account's free quota is used up).
- 2026-11-24 M10 items 1 to 7 and 9 done on branch feat/m10-ops: spots with QR cards, extras, line notes, per-item stations, runner screen and late alerts, ready-to-delivered minutes, tag filters, daily counts, last-order time, an invented garden-cafe sample with a 300-order rush; card payments and refunds not started; the private cafe config runs it (bd61760..HEAD, D-063 to D-069).
- 2026-11-25 M12 items done, awaiting review: card as a staff-recorded method and refunds netted in every total (D-071, schema 16); line notes cleared with names and a station batch's spots and order numbers (D-073); owner, manager and system admin with one powers table, each with its own PIN, demo PINs for every level (D-072); the links hub at `/admin` (D-074), audited run-time flags (D-075, schema 17) and telemetry kept on the install (D-076, schema 18); reviewer's M10 should-fix and nits folded in; 637 unit + 31 browser tests green.
- 2026-11-25 M11 and M13 (lead): drawn line icons, Fraunces display face, photo-only tiles and a Most loved strip (D-070); app shell with a CSS-only splash, view transitions, dialogs for paused ordering, sold-out and offline, order numbers (#47) and the name first (D-080); filters, staff tiles, item counts and the hub restyled; reviewer must-fixes (Workers noindex, Fraunces licence) done. Merged M10 and M12 from the builder. Still open: the owner approves screenshots; stations, runner, Appearance, Spots and Reviews screens not yet reviewed by eye. Commits feca73d..HEAD on feat/demo-config-folder.
- 2026-11-25 Reviewer approved M12 and M13 (f03d1dc..a40de31) with no must-fix; Cloudflare facts checked against its docs (00:00 UTC row reset, 1 GB per object, 10 ms CPU, 4-hour browser TTL over no-cache, query strings in the cache key). Since: build-stamped asset URLs (D-081, 7a1c699), the hub's sign-in as level tiles with demo PINs (4b4976f, 963769c); the last screens checked by eye: order numbers on station chips, runner cards and the owner's orders, option lines above the count, Spots as a card per area, Appearance fitted to a phone, a seated guest told the order is on its way to the spot, owner screens shown only after sign-in; reviewer's should-fix and nits: test-results untracked, flags 401 before 404, a pre-D-072 staff id `admin` stops the boot loudly. Awaiting the owner's approval of screenshots.
- 2026-11-25 M14 items done, awaiting review and the owner's screenshots: room zones and the room bill, unpaid until staff settle the room at checkout in one audited payment (D-082, schema 19), a Rooms screen (D-083), events with weekly repeats and an entry price in the store (D-084, schema 20), event banners on splash, cards and storefront with a CSS-only celebration (D-085), a demo whose day keeps going with room bills and events (D-086); 686 unit + 34 browser tests green (111eadc..HEAD).
- 2026-11-25 Lead pass on M14 (merged bf04ccf): open room bills are owed at checkout and leave Awaiting confirmation (D-082 corrected while under review); Rooms settles with a confirm, whole amounts and one row of methods; event rows with readable dates and a confirm before delete; station tiles take their first category's icon; a room guest is asked about the room. Lead's storefront coherence pass (4f130e6) and closed days (D-090, 888e58e). Awaiting the reviewer and the owner's screenshots.
- 2026-11-25 M15 items done, awaiting review and a real-model run: `src/ai` requests carry images as content parts (D-091); `npm run import-menu` reads photos, text, Markdown and HTML (stripped in code), refuses PDF (D-093), the model reads and code builds a catalog that `parseCatalog` loads, with minor units, stable ids, merged pages, extras and a review list (D-092, D-094), split under a token budget (D-095); 717 unit tests green (023d147..HEAD).
- 2026-11-25 M14 review changes: only a room's own QR can charge it (HMAC key per room from a per-install secret, 403 room_key, keyed Spots print, demo keys at /api/demo), a wrong order can leave a room bill (audited, schema 21), closed days follow the business day past midnight and step by calendar day with a 409 that names them, events may end past midnight, Rooms redraws only for room-bill events, RENAME_ADMIN_STAFF (D-087), configure.md for rooms and events; D-082 to D-084 corrected; 704 unit + 34 browser tests green (5d1f5e6..HEAD).
- 2026-11-25 Release review changes: a room key of the wrong shape is a 403, not a 500; New QR on Spots rotates one room's key (D-082 corrected); the storefront takes the key out of the address bar; import price strings with more than one number are odd and currency words are dropped, unsure items written switched off (D-092 corrected) (ac6804b..HEAD).
