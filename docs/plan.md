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
