# Decisions (append only: id, date, decision, why)

- **D-001 2026-11-07 Build it ourselves, as open source.** The owner's earlier counter app proved the workflow live at a real shop. No
  existing tool fits it: open-source restaurant software is either a full POS/KDS for table service (Odoo,
  TastyIgniter, URY, nodedr, TavoloFlow) or a bare QR menu, and none batches prep by station, speaks to staff or is
  UPI-first. Forking a POS would mean fighting its model, and the old app is a single-shop prototype with hard-coded
  routing, client-side auth and leaked secrets in its history. So: a clean rebuild in a new repo with no history, and
  the old repo stays private.
- **D-002 2026-11-07 License AGPL-3.0.** Shops and freelancers self-host for free. Anyone who runs a modified version
  as a service must publish their changes, which protects a hosted offering of ibow from closed resellers.
- **D-003 2026-11-07 Business analyst is staged.** Rule-based insights first (`src/core/insights`, no model, in v1 scope
  at M5), then an opt-in AI analyst (M7) over the same data through one model module, using the owner's own key.
  Everything works with AI off.
- **D-004 2026-11-07 Stack: Node 24 + TypeScript + SQLite.** The owner's choice over modern PHP: one language end to
  end, and SSE fits a long-running process. Accepted cost: it needs a VPS or Docker, not shared PHP hosting.
  - Runtime dependencies: `hono` + `@hono/node-server` (small, standards-based HTTP and SSE). No UI framework.
  - SQLite through `node:sqlite` (built in, no native build). It is still marked experimental in Node 24, so only
    `src/store` touches it; swapping to `better-sqlite3` is a one-module change.
  - Dev tooling: TypeScript (strict), Biome (lint and format), Vitest, esbuild (client bundle), Playwright from M3.
- **D-005 2026-11-07 Core conventions from M1.** Tokens never wrap: past 999 the sequence widens (`26-1000`), because a
  repeated token in a rush is worse than an odd-looking one. Payment has a third state, `unpaid`, before `claimed`;
  cash goes straight to `confirmed` by a named staff member. The UPI VPA and payee name are deployment config
  (`UPI_VPA`, `UPI_PAYEE_NAME`), not menu data, so `shop.json` holds no payment details. Undo reverts one status
  change at a time, each within 5 minutes of that change.
- **D-006 2026-11-07 Dev tooling detail.** Exact versions are pinned and `package-lock.json` is committed. `@types/node`
  (types only) is a dev dependency so tests and scripts can type `node:` imports. TypeScript runs with
  `allowImportingTsExtensions` and `erasableSyntaxOnly`, so every source file also runs under Node's type stripping
  with no build step. hono and esbuild are added when M2 and M3 need them.
- **D-007 2026-11-07 Paid means the confirmed amount covers the total.** A claim and a confirmation both record
  `amountPaise`. Customer edits stop once payment is claimed (`already_paid`); staff may still add lines, which leaves
  the payment as it is and shows the difference through `outstandingPaise(order)`. No screen may show "paid" from the
  payment state alone.
- **D-008 2026-11-08 Renamed to ibow, with a global scope.** The project was named IBO ("Indian Business
  Orchestration"); it is now **ibow, Intelligent Business Orchestration and Workflows**. The owner's reasons: it is
  free, full-stack, AI-enabled orchestration for any business worldwide, and it is the owner's public portfolio for
  consulting (Dubai, the US and beyond), so tying it to one country is wrong. The name is free as `YoByron/ibow` and
  on npm; the only notable namesake is `ibow-lcd`, a robotics library in an unrelated field. What changes: no
  country-specific wording in the product; UPI stays the first payment adapter, not the identity. The old Hostinger
  deployment is gone, so its database-password step was dropped.
- **D-009 2026-11-08 Business-neutral vocabulary; one business per install in v1.** The core and the config contract
  speak of a **business** (`business.json`: name, timeZone, contact), its **catalog** (`catalog.json`: categories of
  items, an item having one price or size variants) and its **stations** (`stations.json`), not of a shop and its
  menu. Station print is `"ticket-80mm"`, not a kitchen order ticket. An item is anything sold (a drink, a packed
  good, a repair) and a station is wherever that work happens, so the same model runs a tea house, a bakery or a
  service desk with no code change; `samples/` holds one invented business of each kind, each replayed by the tests.
  One business per install is v1, confirmed by the owner on 2026-11-08: a chain runs one install per outlet. This is a
  rename only, with no new abstraction. Kept as they are, knowingly: the variant field is `size` (a service's
  "Standard"/"Express" tier fits it well enough), order status `preparing`, money in integer `paise` with UPI first
  (D-005, D-008), and `Asia/Kolkata` as the default time zone; renaming those belongs with multi-currency work, not here.
- **D-010 2026-11-08 Money in minor units of a configured currency; time zone required.** Supersedes the paise wording
  of D-005, D-007 and D-009. Every amount is an integer count of the business currency's minor unit (`unitMinor`,
  `amountMinor`, `outstandingMinor(order)`; a catalog `price` is in minor units too), and an order records its
  `currency`. `business.json` must name an ISO 4217 `currency` and an IANA `timeZone`; neither has a default, because a
  silent India default is wrong for a business in Dubai or New York and would only show up as wrong prices or tokens
  rolling over at the wrong midnight. The exponent comes from `Intl` (JPY 0, KWD 3), never from a hard-coded 100. UPI
  stays the first payment adapter and refuses a non-INR currency rather than converting. `samples/coffee-cart` (USD,
  America/New_York) and `samples/service-desk` (AED, Asia/Dubai) keep the other currencies and zones under test.
- **D-011 2026-11-08 HTTP runtime and auth for M2.** Runtime dependencies, pinned exactly: `hono` 4.13.17 and
  `@hono/node-server` 2.1.6 (the pair D-004 named). Auth adds none: PINs are hashed with `node:crypto` scrypt
  (N=16384, r=8, p=1, 16-byte salt), the owner's in `OWNER_PIN_HASH` and staff PINs in the database, set by the owner.
  A login gets a random 256-bit session id in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS); the
  database keeps only its SHA-256 and expiry (12 hours), so a restart mid-rush logs nobody out and no signing secret
  is needed, which is why `SESSION_SECRET` is gone. A customer acts on an order only with its random secret key,
  returned once at create; the short token is for reading status aloud, never for access. Rate limits live in memory,
  which is enough for one business per install (D-009).
- **D-012 2026-11-08 Client build and browser tests for M3.** Dev dependencies, pinned exactly: `esbuild` 0.28.2
  bundles `src/client` (vanilla TS, no UI framework) into `dist/client`, and `@playwright/test` 1.61.1 drives the
  checkpoint in a browser. 1.61.1 is chosen because it expects Chromium build 1228, which is already installed on the
  dev machine, so no browser is downloaded; a newer Playwright needs `npx playwright install chromium` first. One
  runtime dependency, bundled into the client rather than loaded from a CDN: `uqr` 0.1.3 (MIT, no dependencies) encodes
  the UPI QR, because a QR encoder is easy to get subtly wrong and this one is small and tested. Biome's Playwright
  lint rules apply only under `e2e/`.
- **D-013 2026-11-09 Station view modes, cash shortcuts, ready lines and top-ups (M4).** A station's `view` in
  `stations.json` is `batch` (the default and the live app's way: open lines totalled across orders, spoken as one
  batch) or `jobs` (one card per order), because a workshop's job belongs to one customer's device and totalling
  "6 Water Damage Check" says nothing useful there; it is config, so a business picks it per station with no code.
  Cash shortcuts are per business in `business.json` (`cashShortcuts`, major units, kept in minor units), since the
  notes a counter handles depend on the country; without them the counter offers the next notes up in 1-2-5 steps of
  the major unit, which suits INR, USD, AED and JPY alike with no currency table and no symbol in code. A station's
  "ready" is a per-line flag, not a new order status: the status machine and its undo stay as M1 made them, an order is
  ready when every line is ready or served, and the customer sees "ready" from that. Staff adding lines makes the order
  not ready again. A top-up is a separate staff action on a confirmed payment that records each extra amount (method,
  amount, time, staff member) and adds it to the confirmed total, so D-007's `outstandingMinor` needs no change and
  nothing becomes paid without a person. Staff are not split into counter and station roles: any staff session opens
  any screen, as in M2; a role per staff member can come if a business asks for it.
- **D-014 2026-11-09 Minimal staff roles (supersedes the last sentence of D-013).** Each staff member has a `role`:
  `counter`, `station` or `all` (the default, so existing staff keep working). The counter's actions (confirm, top-up,
  add lines, advance, undo, served) need `counter` or `all`; station routes (orders, ready, unready) take any staff
  role; the owner keeps everything. The owner sets it with `PUT /api/staff/:id {name, pin, role?}`, which ends that
  user's sessions as a PIN change does, and the server reads the role at each request, so a change applies at once.
  The staff page offers only the screens a role may use. Why: a station phone left on a counter top must not be able
  to mark money received. Reads (the open-order list and counter stream) stay open to any staff role; nothing on them
  moves money.
- **D-015 2026-11-09 What insights count, and the prep forecast rule (M5; money split after review).** Three figures,
  never mixed, because no screen may show money as received unless a person confirmed it (Principle 6, D-007), and a
  UPI claim that is never paid must not inflate the till for good (ibow has no cancel): **Ordered** is the value of the
  orders placed in the business-local day at their totals, paid or not (demand); **Received** is the money staff
  confirmed in the day (each confirmation and each top-up counts on the business-local day it was confirmed, whenever
  its order was placed); **Awaiting confirmation** is the orders placed in the day whose confirmed money doesn't cover
  them yet (`outstandingMinor > 0`), with what they still owe. The summary and the comparison with yesterday report
  orders and Received; the hourly chart, popular items and the forecast count placed orders, since they measure demand.
  Hours are business-local (`timeZone`), 0 to 23; on the night the clocks go back
  the repeated hour shares one bucket. The peak is the hour with the most orders, the earlier one on a tie. Popular
  items add all sizes of an item, ranked by units and, separately, by order value. Today is compared with yesterday up to the
  same clock time (a fair race while the day runs); yesterday's whole day is shown beside it. **Tomorrow's prep:** for
  each item and size, the mean units sold on the same weekday over the last 4 weeks, counting only those weekdays that
  had orders (a shut day says nothing about demand); if none had orders, the mean over the last 7 days that did;
  rounded up, so the prep doesn't fall short. The daily summary is a list of facts chosen by plain rules (a change under
  10% either way is "about the same"), worded on the dashboard, with no model call (D-003). All of it is pure code in
  `src/core/insights.ts`, reads no customer name, and formats nothing: amounts and hours go through `Intl` at the edge.
- **D-016 2026-11-09 Retention of customer details (M5).** `business.json` may set `retentionDays` (1 to 3650, default
  30). The store's `forgetCustomers(cutoff)` clears, in one transaction, the customer name of every order placed before
  the cutoff, the name in every logged event snapshot of those orders (so SSE replay can't bring it back), and the text
  of every review written before it. Orders, lines, totals and ratings stay: they are anonymous counts, which is all
  insights read. The server runs it at startup and then hourly (`src/server/retention.ts`, its clock passed in), so a
  name outlives the period by at most an hour. Why the business's config and not `.env`: how long a shop keeps customer
  details is its own policy, like its currency, and it travels with the other business files. Cleared means gone from
  the file, not only from queries: the store opens with `PRAGMA secure_delete = ON` (overwritten and deleted content is
  zeroed), checkpoints the write-ahead log with `TRUNCATE` after a retention pass that changed anything, and a one-time
  migration runs `VACUUM` so free pages from before this release are rewritten. A test reads the raw `.db`, `-wal` and
  `-shm` bytes after a pass and finds no cleared name or review text. Each pass reads only the rows between the last
  pass's cutoff (a mark kept in the store) and its own, by indexed time, so the hourly cost stays an hour's worth of
  rows however long the history; a cutoff earlier than the mark (`retentionDays` raised) has nothing left to do.
- **D-017 2026-11-09 Item availability is a runtime switch the owner holds (M5).** The owner turns an item off or on
  with `PUT /api/owner/items/:id {available}`; the store keeps the switch (`item_availability`) and it overrides
  `catalog.json`'s `available` until switched again, across restarts. The server applies the switches to the loaded
  config (`withAvailability`), so `/api/catalog`, order creates, customer edits and staff additions all see the same
  catalog at once, and an order for an item switched off is refused (`unavailable_item`). An open storefront menu
  re-reads the catalog every 30 s and redraws only when it changed; a kiosk reloads after each order anyway. Why a
  poll and not a public stream: every customer phone would hold one more socket under the 1000 cap for an event that
  happens a few times a day, while the server's refusal already keeps a stale menu from selling what is off. Nothing
  else in `business.json`, `catalog.json` or `stations.json` becomes runtime: config, never code, describes the business,
  and an edit to those files is a deploy. Staff (name, PIN, role) were already runtime through the staff API.
- **D-018 2026-11-09 Repeat-customer badges come from the optional name only (M5).** ibow keeps no phone, account or
  device id (brief, "Not"), and the client key is random per order, so the only signal is the name a customer chose to
  type. A name (Unicode-normalised, spaces collapsed, case folded: `nameKey`) that ordered on earlier business days
  within `retentionDays` gets a badge with its number of earlier visit days; several orders in one day are one visit.
  `GET /api/owner/orders` returns those counts by name key beside the day's orders, so the dashboard badges orders that
  arrive live without asking again. Two customers who give the same name look like one: the badge is a hint for the
  owner, never an identity, and it disappears with the name when retention clears it.
- **D-019 2026-11-09 Demo mode works only on a database it marked (M6).** `npm run demo [sample]` seeds a sample into
  a temporary data directory (or `--data <dir>`), builds the client and starts the real server with fresh random PINs
  (owner 6 digits; staff `counter` and `station`, 4 digits each) and, for an INR sample, UPI to `ibow-demo@example`, a
  handle no payment app accepts, so the demo's QR can never move real money. The seed (`src/demo/seed.ts`) replays the
  sample's `rush.json` through the real order and payment rules on today and the 7 days before, at the clock time the
  demo starts (so "vs yesterday" is a fair race and tomorrow's weekday has a day to forecast from), keeps 60 to 100% of
  it on each past day, leaves today's 12 latest orders open (pending, some claimed; preparing, some lines ready),
  names about 30% of customers from a short invented list (repeat badges) and adds a few reviews. The demo marks its
  database with SQLite's `application_id` and reads it back from the file header (`databaseKind`), not through SQLite,
  because even a read-only connection leaves `-wal`/`-shm` files beside a database: anything else at the path is a
  real install's and is refused before anything is opened for writing; its own database from an earlier run is wiped
  and reseeded. The demo passes the server only the settings it chose, never the shell's `.env`, so a real `DATA_DIR`
  can't leak in. A demo database skips the sync per commit (`synchronous = OFF`): its data needn't survive a power cut.
- **D-020 2026-11-09 The first public push is a fresh, scanned, one-commit export (M6).** `bash
  scripts/release-export.sh <dir>` refuses a dirty tree, a non-empty target and one inside the repo, then writes `git
  archive HEAD` into the target as a new repository with one commit by the repo's git user ("ibow: first public
  release") and no remote; it never adds one or pushes, so publishing stays the owner's step by hand. It then runs
  `scripts/release-scan.ts` over the export and fails on: the real business's name, its app's and host's names, or a
  brand once in its menu (kept in the script only as salted SHA-256 hashes of normalised words, matched against every
  word and every run of 2 or 3 adjacent words, so "A B", "A-B", "AB" and accented forms all hit; two unrelated words
  that happen to join into a blocked one are a rare false alarm, resolved by rewording), API keys, private keys, scrypt
  PIN hashes, UPI IDs other than placeholders (the `example` handle, `your…@` and `name@`), `.env` files other than
  `.env.example`, database files and key files; and on attribution in the commit. Findings print file, line and rule,
  never the matched text. A unit test runs the scan over the repo's own tracked files, so a leak fails the gate long
  before a release. To this end the test fixtures' UPI IDs moved to the `example` handle (a real app's handle with an
  invented name could be someone's), and a brand word left in D-002's wording was removed.
- **D-021 2026-11-09 How an install runs, and how it is backed up (M6).** Two supported ways, in `docs/install.md`:
  Docker (`Dockerfile`, `compose.yaml`) and plain Node under systemd, each behind Caddy for HTTPS with `TRUST_PROXY=1`.
  The image is two-stage on `node:24-slim`: the build stage bundles the client, the runtime stage carries production
  dependencies, `src/`, `dist/`, the samples and the two operator scripts, runs as the image's unprivileged `node`
  user, keeps `ibow.db` on a `/data` volume and checks its health on `/api/catalog`. `.env` reaches the server the same
  way everywhere: node reads it itself (`--env-file`), mounted into the container rather than passed as compose's
  `env_file` and not as systemd's `EnvironmentFile`, because those may read the `$` signs in a scrypt PIN hash as
  variables. The image's own `ENV` (`HOST`, `PORT`, `CONFIG_DIR`, `DATA_DIR`) wins over the file, so a copied
  `.env.example` can't point the container at the wrong paths. Backups are `npm run backup -- <file>`
  (`store.backupTo`, SQLite's `VACUUM INTO`): a consistent copy taken while the server runs, and a compact file with
  no free pages, so nothing retention cleared (D-016) comes back from a backup; copying the live file by hand could
  miss what is still in its `-wal`. A unit test checks the Dockerfile's sources exist and that `src/` imports nothing
  outside itself, since Docker isn't available to the gate.
- **D-022 2026-11-09 Development files stay out of the export; an export-only check (M6 review; extends D-020).** The
  assistant instruction file and folder are marked `export-ignore` in `.gitattributes`, so `git archive` in
  `release-export.sh` leaves them out and `.gitattributes` alone decides what ships. The export is scanned with
  `--export`, which adds: assistant and vendor names, an attribution trailer and the private hub's names (hashed like
  the business names, matched as whole words or runs), absolute paths into a home folder (Windows, Linux or macOS), and
  the same names in the export commit's message and author fields; the plain-text word list in the export script is
  gone. The `.gitattributes` lines that export-ignore those files are the only place allowed to name them. The plan's
  wording that described how the project is built (crew, instruction file, the hub) was reworded for the public.
- **D-023 2026-11-09 The demo seeds ordinary days, not a replayed rush (M6 review; supersedes D-019's seed).** Each of
  the 7 days before today is a whole day and today runs only up to the demo's start (so "Yesterday by now" and
  "Yesterday, whole day" differ), across one generic opening profile, 07:00 to 22:00 business-local, with relative
  weights per hour: a breakfast peak (09), a lunch peak (13) and the evening rush (19), quieter between. A day's size
  is 75 to 105% of the sample's `rush.json` order count, each hour jittered by ±15%; baskets and payment methods are
  drawn from that rush, not its times. Business-local wall-clock hours are turned into instants through `Intl`, so a
  zone's clock change moves nothing. Today's orders from the last 30 minutes stay open (at most 12: the newest 5
  pending, some UPI claimed; the rest being prepared, some lines ready); started outside opening hours or just after
  midnight, today is empty and nothing is open, while yesterday and the forecast still have numbers. The samples have
  no opening hours in their config, so the profile is the seed's, not the business's; it is a demo, not a model.
- **D-024 2026-11-09 A backup opens the database read-only (M6 review; amends D-021).** `npm run backup` calls
  `backupDatabase(src, dest)` in `src/store`, which opens `ibow.db` read-only and runs `VACUUM INTO` without running
  migrations, in place of `store.backupTo` on a store opened for writing: a backup must never change what it copies,
  even a database from an older version waiting for its upgrade.
- **D-025 2026-11-09 Nothing public mentions the assistant (M6 review; supersedes D-022's export-ignore and its
  allowance).** The tracked `.gitattributes` no longer lists development files. After `git archive`,
  `release-export.sh` runs `release-scan.ts --prune`, which removes every file or folder whose name contains an
  export term (found by the hashed names, so no list of them lives in the repo) and drops the lines of `.dockerignore`
  and `.gitignore` that name them; in the dev repo those lines stay. The export check has no allowance left: any
  mention anywhere in the export fails it.
- **D-026 2026-11-09 The one door to a model: a Chat Completions adapter over `fetch`, off by default (M7).** `src/ai`
  holds a small `Adapter` interface (`create(settings) → ChatModel`, whose `complete({system, user, maxTokens})`
  returns text) and one adapter, `chat-completions`: `POST {AI_BASE_URL}/chat/completions`, the wire format most
  hosted providers and every common local model server (Ollama, llama.cpp, LM Studio, vLLM) speak, so one adapter
  covers a paid key and a free model on the owner's own machine. No vendor SDK and no new dependency: Node's `fetch`.
  Settings come from `.env`: `AI_BASE_URL` and `AI_MODEL` turn AI on, `AI_API_KEY` is optional (a local model needs
  none), `AI_TIMEOUT_SECONDS` (1 to 290, default 30; local models on small machines are slow, and Node's fetch stops
  waiting at 300 s whatever the signal says) and `AI_ADAPTER`
  (default `chat-completions`). No `AI_*` setting means AI is off; a half-set one (`AI_TIMEOUT_SECONDS` alone included) stops the boot and
  names what is missing, and a key is refused over plain `http://` to any host but loopback. Each call has a timeout, asks for a
  bounded answer (`max_tokens`), reads at most 64 KB of reply and follows no redirect. Failures are an `AiError`
  (`ai_timeout`, `ai_unreachable`, `ai_refused` with the provider's status and message, `ai_bad_reply`), worded for
  the owner, with the key cut out of anything the provider echoes (as written, URL-encoded or in another case). `AI_BASE_URL`
  may not carry a user, password, query or fragment, and logs and errors show only its origin (corrected in review). The key lives only in the server process: it is
  never logged, stored, put in the event log or sent to a browser. A second wire format is one file exporting an
  `Adapter`, added to `ADAPTERS` in `src/ai/index.ts`. The adapter is named after the API, not a company (D-029 lets the
  docs name the providers). Some newer hosted models refuse
  `max_tokens` or `temperature: 0`; such a provider is a second adapter, not a branch in this one.
- **D-027 2026-11-09 The analyst's answers come from named figures, cited and checked (M7).** Code computes; the
  model phrases (Principle 1). For each question `src/ai/analyst.ts` builds a compact context from
  `src/core/insights` with the dashboard's own rules: today's and yesterday's totals (orders, Ordered, Received, awaiting orders and amount; units and average for today),
  yesterday up to now, the changes against it, the peak hour and each busy hour,
  today's top 3 items by units and by value, each of the last 7 days with activity (orders, Ordered, Received), their sums and top
  items, and tomorrow's prep forecast with its basis. Each figure has a key, a label that carries its meaning and a
  value written as the answer must write it (money in major units, `1234.50`; hours `18:00`). Sums the owner is likely
  to ask for (the last 7 days) are computed in code, because the model is told never to calculate. The system prompt
  says: copy numbers exactly, cite `[key]` after each sentence that uses one, say a figure isn't available rather than
  estimate, and keep Ordered (orders placed, paid or not), Received (money staff confirmed) and Awaiting confirmation
  apart (D-015). Why a fixed context and not tool calls: one request works on every Chat Completions server, small
  local models included. The figures go as plain `key | meaning | value` lines, with no empty hours, no empty
  days and top-3 lists, under 5 KB on the fixture, so they fit a small local model's default context. After the reply, `checkAnswer`
  (`src/ai/grounding.ts`) splits it into sentences and backs a number only by a figure cited in the same sentence, in
  that figure's unit: money in minor units of the currency (so `₹1,960.00`, `1960` and `1960.00` agree, `1960.005`
  doesn't), counts exactly, percentages with their sign, written or said ("down 12%" is -12, "up 12%" is not),
  hours by the hour ("6 PM" is 18:00), dates exactly. A figure also backs the day, hour, clock time, span of days and
  item it is about (`date`, `hour`, `at`, `days`, `item` beside its value), never anything in its key or label or in
  `asOf`. So a real figure passed off as another (Ordered as Received, yesterday as today), a flipped sign or a stray
  small number is flagged, as are numbers in words and digits other than 0-9 (they can't be checked) and citations of
  unknown keys. (Corrected in review: the first version accepted any number found anywhere in the context.) The
  dashboard shows the answer with the figures it cited and, when any number is unbacked, a warning above it with
  those numbers marked. The context holds anonymous counts and catalog item names only: no customer
  name, no review text, no token, no order id (D-016); `Sale` carries none of them, so the code can't send them.
- **D-028 2026-11-09 With AI off nothing changes; with it on, one owner route and one extra script (M7).** The route
  `POST /api/owner/ask {question}` (1 to 500 characters) is registered only when a model is configured; without one it
  is a 404 like any unknown path. It takes the owner's session alone (staff 403, none 401) and is limited to 30
  questions an hour per sign-in, counted per session in memory like the other limits, because each question may cost
  the owner money at a hosted provider; a failed model call answers `502` with the `AiError` code and message. The
  dashboard's analyst panel is its own bundle, `owner-ai.js`, built always but served only with AI on, when the server
  also adds its `<script>` to `owner.html`; with AI off it is a 404 and `owner.html` is served as built. So the
  storefront, staff and owner bundles carry no AI code (the build test checks), keep their exact bytes with AI off,
  and the browser only ever calls this server: the model is reached by the server alone, under the same strict CSP.
  The panel sits below the dashboard on the Today page, outside the part `owner.js` redraws, so a typed question
  survives the live refresh. Asking writes nothing to the store or the event log.
- **D-029 2026-11-09 Model providers may be named; attribution still may not (M7 review; amends D-025).** The export
  check no longer lists the two model-provider words it held. They name companies and APIs the AI analyst connects
  to, which an owner needs in order to set it up, not the tool the code was written with. The docs now say "the
  OpenAI-compatible Chat Completions API" and give example providers (OpenAI, Gemini's OpenAI-compatible endpoint,
  OpenRouter, Groq, and local Ollama, LM Studio or llama.cpp). The coding assistants' product names, their maker's
  name, attribution trailers and the hub's names stay blocked in the export, as D-025 says. The adapter keeps its
  file name, `chat-completions.ts`.
- **D-030 2026-11-11 ibow runs on Cloudflare Workers' free plan, which replaces Docker (M9).** One Worker serves the
  built client as static assets (free and unlimited, never running our code) and forwards `/api/*` to **one Durable
  Object per install** (D-009): the single writer, holding the business in its SQLite storage, so token issue stays
  atomic as it was under one Node process. Only four paths run the Worker before the assets (`run_worker_first`): the
  API, `/manifest.webmanifest` (it carries the business's name), `/owner` and `/owner-ai.js` (the AI script is added
  only when AI is on, D-028). Node stays for local development, tests and self-hosting; the Dockerfile, `compose.yaml`
  and `.dockerignore` are gone (amends D-021). Facts checked on 2026-11-11 and what rests on them:
  [Durable Objects on the free plan are SQLite-backed only](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  (100,000 requests, 13,000 GB-s, 5 million rows read and 100,000 rows written a day; daily limits reset at 00:00 UTC
  and operations past them fail); [static asset requests are free and
  unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), and on the free plan a
  `run_worker_first` request past the limit gets a 429; [`_headers` works for assets but not for responses a Worker
  makes](https://developers.cloudflare.com/workers/static-assets/headers/), so the build writes it
  (`scripts/build-client.ts`) and the Worker sets the same headers on the pages it makes (`src/server/page.ts` is the
  one list); [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (30 s CPU per
  request on a paid plan, 10 ms on free: corrected by D-038; 100 bound parameters and 100 KB per statement, 1,000 requests a second per object, soft);
  [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) (10 ms CPU per Worker request on free:
  our Worker only forwards, the work, scrypt included, is in the object). `wrangler.toml` is a real install
  (`config/*.json` bundled by aliases), `wrangler.demo.toml` the public demo; two files because wrangler does not
  apply an environment's own `alias`. Dev dependencies, pinned: `wrangler` 4.160.0 (deploy and `wrangler dev`) and
  `miniflare` 4.20260730.0 (tests). `@cloudflare/vitest-pool-workers` was not used: its newest release needs vitest
  4.x and this repo is on 5.1.0, so the Worker tests drive Miniflare from ordinary vitest tests instead.
- **D-031 2026-11-11 The store runs over a `SqlDriver`; Durable Object SQL is synchronous, so the interface stayed
  synchronous.** `src/store/store.ts` no longer imports any engine: `createStore(driver)` (migrations, queries,
  events) over `SqlDriver` (`src/store/driver.ts`), with `node:sqlite` in `src/store/node.ts` (also `openStore`,
  `databaseKind`, `backupDatabase`) and Durable Object storage in `src/worker/do-sql.ts`. The core, the API and the
  streams are unchanged. What the [Durable Object SQL
  API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) forced, found by probing workerd:
  no `BEGIN`/`SAVEPOINT` (use `transactionSync`, which rolls back when the callback throws); `PRAGMA user_version`,
  `application_id`, `secure_delete` and `VACUUM` are refused (SQLITE_AUTH), so the schema version and the demo mark
  live in the object's key-value storage (`ctx.storage.kv`, same SQLite file) and the driver's `vacuum` is a no-op;
  `RETURNING` and `changes()` work (the event insert uses `RETURNING id` on both engines instead of
  `lastInsertRowid`); foreign keys are already on; cursors are read with `toArray()` before any await. Consequence for
  D-016: on Workers retention clears names logically (the rows are updated), but we can't zero freed pages or
  rewrite the file, so the guarantee that a cleared name is gone from the bytes holds for Node installs only; the
  install guide says so.
- **D-032 2026-11-11 Live updates stay SSE, served from the Durable Object, with the same `Last-Event-ID` replay and
  polling fallback.** The stream code is unchanged (`streams.ts`: every stream pulls events after the last id it
  sent, from the store). It works from an object because a Worker passes a streamed response through, and the
  checkpoint proves it in workerd (D-036). The cost question is [duration
  billing](https://developers.cloudflare.com/durable-objects/platform/pricing/): wall-clock time while the object is
  active, 128 MB fixed, shared by every request active on the object at once, not per connection. An open stream keeps
  the object in memory, so the worst case is the object awake all day: 24 h x 3,600 s x 0.125 GB = 10,800 GB-s of the
  13,000 free GB-s (28.9 hours a day fit); a shop open 12 hours uses 5,400. Hibernatable WebSockets would stop the
  charge between messages, [but incoming messages are billed 20:1 as
  requests](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and the live client, the
  replay and the tests would all change for a saving the free plan does not need: a day has 24 hours, so the object
  can never exceed the 28.9 that fit, for this object alone (duration is per account: D-038). Revisit if the plan's numbers change. Each stream connect or reconnect is one
  Worker request and one object request; heartbeats are fifteen seconds apart.
- **D-033 2026-11-11 Retention runs on an hourly alarm; rate limits and sessions live in the object.** The object sets
  an alarm one hour ahead at boot (if none is set) and each `alarm()` runs `forgetCustomers` and sets the next; each
  `setAlarm` is [one row written](https://developers.cloudflare.com/durable-objects/platform/pricing/), 24 a day.
  Sessions are rows in the store, as before. The rate limiters and PIN lockouts are in the object's memory, as they
  were in the Node process (D-011), so they reset when the object is evicted, which an idle install can be and an
  install with a stream open is not; a lockout is therefore as strong as the Node one while anyone is connected and
  restarts from zero after a quiet spell. The client address is Cloudflare's `cf-connecting-ip`, which the Worker
  copies into a header the object trusts, deleting any such header the client sent.
- **D-034 2026-11-11 Configuration is bundled, secrets are secrets, PINs stay scrypt (superseded by D-038), the AI door is unchanged.**
  `business.json`, `catalog.json` and `stations.json` are imported through the aliases `ibow-business`, `ibow-catalog`
  and `ibow-stations` (`wrangler.toml` points them at `config/`, `wrangler.demo.toml` at `samples/tea-house`) and
  validated by `loadConfig` when the Worker starts, so a bad file fails the deploy, not a customer. The owner's PIN
  hash is the secret `OWNER_PIN_HASH` (`wrangler secret put`); `UPI_VPA`, `UPI_PAYEE_NAME` and the `AI_*` settings are
  vars or secrets; a missing hash makes every request answer 503 saying to run the command. PIN hashing: `node:crypto`
  `scrypt`, `randomBytes`, `createHash` and `timingSafeEqual` are [supported under
  `nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) (only argon2 and a few key
  types are not), so the hash format and parameters (N=16384, r=8, p=1) are unchanged and a hash made by
  `npm run hash-pin` works on both; the tests sign in through workerd. One thing to confirm at the first deploy: a
  sign-in takes about 0.1 to 0.2 s of CPU, which is inside the object's documented 30 s but not inside the 10 ms of a
  free Worker request; if Cloudflare enforces the smaller figure for the object, sign-in fails with "exceeded CPU" and
  the fix is a lower cost parameter (`hashPin` takes a cost) or PBKDF2 through WebCrypto with a new hash prefix that
  `verifyPin` reads beside `scrypt$`. The AI door is `fetch`, which a Worker has; `nodejs_compat` also gives
  `node:events`. `compatibility_date` is 2026-08-06, the newest the pinned workerd runs.
- **D-035 2026-11-11 Demo mode on Cloudflare: PINs are shown only by a database the seed marked, under `DEMO=1`.**
  `wrangler.demo.toml` sets `DEMO=1`. On a fresh database the object seeds the week of orders, marks the database as
  a demo's (a key in its key-value storage, written only by the seed), makes PINs for this seed (six digits for the
  owner, four each for counter and stations), hashes them, and keeps them. `GET /api/demo` holds PINs only then; the
  staff and owner sign-in screens (`src/client/demo-note.ts`) fetch it and show the PINs; on a real install it answers
  `{demo: false}` (not a 404, which would log a console error on every sign-in) and the note stays empty and hidden.
  Three refusals, each answering every request with a 503 that says why (`src/demo/mode.ts`): `DEMO` set to anything but `1`; `DEMO=1` on a database that is not a demo's and already
  holds orders or staff; and a demo's database without `DEMO`, because its PINs were public. The tests cover a real
  install never answering with a PIN, `DEMO=1` over a real install's data, and a demo's data run as real. The demo's
  UPI ID is the unusable `ibow-demo@example`. Seeding costs rows written once (D-036) and the PINs survive restarts.
  To reset a demo: delete its Worker and deploy again, which gives a new object and new PINs.
- **D-036 2026-11-11 Free-plan budget against the 300-order tea-house rush, measured.** The checkpoint
  (`tests/worker-checkpoint.test.ts`) replays the rush in workerd: 300 creates, 50 in flight, then 300 moves to
  preparing, with five station streams, the counter stream and one forced reconnect: 607 requests and 9,004 rows
  written (indexes included, the number the plan counts), 8,769 rows read. That is about 15 rows written per save of
  an order, because a save rewrites the order's lines, history and payment and appends an event. An order that lives
  its whole life (create, payment, three or four status steps, ready marks, served) is about eight saves, so about
  120 rows written: the 100,000-row day holds roughly 800 full orders, 2.7 times a 300-order rush. Requests: the rush
  used 607 of 100,000; polling fallback and reconnects add some. Duration: D-032. Storage: a few KB an order against
  5 GB. So the first limit a busy shop meets is rows written, at around 800 orders a day; past it, writes fail until
  00:00 UTC. The Workers Paid plan (US$5 a month) lifts it with no code change. Writing only the changed lines is
  the cheap way to roughly halve the rows if a shop needs the headroom; not done, as nothing needs it yet.
- **D-037 2026-11-11 Backups on Cloudflare: an owner export, and Cloudflare's 30-day recovery left unexposed.** A
  Durable Object's database is not a file anyone can copy, and wrangler has no export for it
  ([storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)); its point-in-time recovery
  (any moment in 30 days; `getBookmarkForTime` then `onNextSessionRestoreBookmark`) is callable only from code in the
  object and is not supported in local development. So `GET /api/owner/export` (owner session only, `no-store`,
  a download named by the business's day) returns every table as JSON: orders and their lines, history, payments,
  top-ups, reviews, staff names and roles, item switches and token counters; no sessions, no PIN hashes, no event log.
  It is a ledger for the owner's own books, not an importer, on Node as well as Workers. Recovery is not wired to any
  route: that would be a way to roll a business back by anyone who gets an owner session, and the guide tells a
  developer how to add it for the one day it is needed. `npm run backup` stays the Node install's backup (D-021).
- **D-038 2026-11-11 PIN hashes are PBKDF2-SHA256, not scrypt; this corrects D-030, D-032, D-034 and D-036 (M9 review).**
  I had taken the 30 s CPU figure of the paid plan. The [Durable Objects
  FAQ](https://developers.cloudflare.com/durable-objects/platform/faq/) says an object has the same per-invocation CPU
  limit as a Worker, and on the free plan that is [10 ms](https://developers.cloudflare.com/workers/platform/limits/).
  scrypt at N=16384 measured about 110 ms in workerd (62 ms on Node here), and ran at every sign-in, at boot and three
  times in the demo seed. New hashes are `pbkdf2-sha256$iterations$salt$key` through `crypto.subtle`, at 3,000
  iterations: measured in workerd at 3.0 ms (1,000: 1.0 ms; 5,000: 5.0 ms; 10,000: 9.1 ms), so a sign-in is one
  derivation of about 3 ms and fits. `verifyPin` dispatches on the prefix; `npm run hash-pin` emits the new format.
  Node still verifies `scrypt$` hashes and replaces a staff member's with a PBKDF2 one at their next good sign-in; the
  owner's hash lives in the settings, so an old one keeps working on Node until the owner re-runs `hash-pin`. The
  Worker refuses a `scrypt$` `OWNER_PIN_HASH` at boot ("re-run npm run hash-pin"). The boot check parses the hash and
  derives nothing; unknown users are checked against a constant dummy hash (one derivation, not two), and
  `tests/worker.test.ts` fails if any request path does more than one derivation. The honest cost: 3,000 PBKDF2
  iterations is weak against an offline attacker holding a stolen hash. The defence that matters is the lockouts on
  guessing (5 tries per address and user per 15 minutes, doubling lockouts per user up to a day, D-011), and a PIN is
  4 to 12 digits behind them; the hash only protects PINs if the database leaks, where the owner export (D-043) and
  Cloudflare's own access are the larger exposures. A shop on Node that wants more work per guess can still set a
  higher count with `hashPin(pin, iterations)`, since the count is read from each hash.
  The same review corrected three other figures. Storage is [1 GB per object on the free
  plan](https://developers.cloudflare.com/durable-objects/platform/faq/), not 5 GB (D-030, D-036). Duration and rows are
  limits of the *account*, summed over every Worker and object on it, so D-032's "can never exceed" was wrong for an
  account that also hosts other things (and for the demo, D-039). Row counts on the dashboard: D-041, corrected by D-044.
- **D-039 2026-11-11 The demo seeds three small days in alarm steps, 4,169 rows, and should live on its own account.** The
  first demo seeded eight days (63,900 rows written, 64% of an account's day) in one 6 s invocation. Now it seeds
  today and the two days before at 22% of the sample's rush (about 200 orders), one step per alarm: three PIN hashes
  (one derivation each), then one day of orders each, so no invocation is a long one; requests answer `503 preparing`
  with `Retry-After` until the last step. Measured in the test: 4,169 rows written (about 4% of the day). Miniflare does
  not enforce CPU limits, so each step's 10 ms is argued from the work (about 70 orders, a few hundred statements),
  not measured, and the first deploy should be watched (`npx wrangler tail`). The guide says to put the public demo on
  its own Cloudflare account, because a public link spends the account's daily requests, duration and rows.
- **D-040 2026-11-11 A demo is only ever a demo bundle on a demo database, ignores AI, and says "Demo" on every customer
  page; amends D-035.** `DEMO=1` is no longer enough: `demoMode` also needs the *demo bundle*, an explicit marker file
  (`src/worker/demo-bundle.json`, aliased as `ibow-demo-bundle` only by `wrangler.demo.toml`; `wrangler.toml` aliases
  `no-demo-bundle.json`). `DEMO=1` over a real config answers every request with a 503 saying so, before anything is
  written, so an empty real install cannot be turned into a public-PIN demo; the demo bundle without `DEMO=1` is
  refused too. Under a demo `AI_*` is ignored (the analyst stays off, its route is a 404 and its script is not
  linked), so visitors cannot spend a key. The demo's Worker runs for `/` as well and adds a visible "Demo" label to
  the storefront page, which is also the token and kiosk page; the staff and owner sign-in screens already name the
  PINs. Tests cover each refusal, the label and its absence on a real install, and AI being off.
- **D-041 2026-11-11 Dashboard reads are cached and polled slowly; the replay log is pruned; storage is estimated.** The
  insights report reads every order of its history window (7 rows an order). It is now kept in the object keyed on the
  last event id and the minute, so an unchanged report costs a couple of rows (the session lookup), and the Today tab
  polls every 5 minutes, only while visible, refreshing when the tab comes back after more than a minute. Measured:
  the 300-order rush's report reads 2,095 rows, a repeat 2. At 300 orders a day the 15-day window is about 4,500
  orders, 31,000 rows a report; if an event arrived before every refresh that is 12 an hour, 380,000 an hour, so the 5
  million of a free day would take about 13 hours of an open tab with orders streaming in all of them; typically
  far less, and the old minute poll would have reached it in under three hours. The event log keeps 2 days
  (`EVENT_WINDOW_MS`), pruned with retention (hourly, Node and Workers); insights read orders, not events. A client
  whose last event is older than the log gets `reset: true` from polling or a `reset` event from the stream, and
  reloads for a fresh snapshot; a client within the window replays as before. Storage: the rush's 300 orders came to
  782,336 bytes, 2,608 bytes an order with its event log; at 300 orders a day that is about 0.8 MB a day, so the free
  1 GB per object lasts about 3.5 years, and at 800 a day about 1.3 years (less, since pruning drops most event
  bytes, so these are upper bounds on use). Beyond that the Paid plan, or the owner exports and starts a new year.
- **D-042 2026-11-11 Retention on Workers overwrites before it nulls, and the remaining caveat is stated.** A cleared name
  or review text is first replaced by spaces of the same byte length, in the same transaction, in orders, the event
  snapshots and reviews, then set to NULL (tested on Node with triggers that record each value). A Durable Object cannot
  run `secure_delete` or `VACUUM`, and the local check showed what remains: Miniflare keeps everything in the SQLite
  write-ahead log, whose earlier frames still hold the original name after retention, until the log is compacted,
  and nothing here can force that. So on Cloudflare a cleared name is gone from queries and overwritten in the current
  pages, but earlier log frames may keep it for as long as Cloudflare keeps the log (its recovery window is 30 days);
  the guide says so without a promise of "30 days" as a limit. A business that needs the bytes gone uses Node (D-016).
- **D-043 2026-11-11 The owner export is paged by day.** `GET /api/owner/export` takes `?from=YYYY-MM-DD&to=YYYY-MM-DD`
  (inclusive, business days), defaults to the last 7 days, and refuses more than 31 days with `range_too_wide` or a
  bad day with `bad_day`, so one request reads a bounded number of rows and answers a bounded body. Staff, item
  switches and token counters come with every page; orders, lines, history, payments, top-ups and reviews are the
  range's. Amends D-037.
- **D-044 2026-11-11 The owner's report reads two days of orders and stored day totals; this corrects D-041's dashboard
  figures (M9 re-review).** D-041 keyed the cache on the minute, so an open tab recomputed on every 5-minute poll even
  with nothing happening, and "an idle tab stays inside the limit" was false (about 13 hours to the 5 million reads at
  300 orders a day, half that with two devices). Worse, the report converted every order's time with
  `Intl.DateTimeFormat.formatToParts` several times over (`localTime`), which on a 15-day history of 4,062 orders took
  1.1 to 3.6 s of CPU in `dailyReport` and 110 to 400 ms in `salesSince`, against the free plan's 10 ms. Now:
  (a) **Day totals.** Table `day_totals` keeps, per finished business day, the orders, units, ordered and confirmed
  money, 24 hourly buckets and units and value per item and size (`DayRecord`). The hourly alarm closes one day per
  step, oldest first, and re-arms at once while days remain (Node closes all at its hourly pass), so a long backlog is
  worked off a step at a time; a day not yet closed is read live from its orders, so reports are right either way.
  (b) **The report** is built from the orders of today and yesterday (read from `historyStart`, the start of yesterday
  anywhere on earth: yesterday "so far" needs the clock) plus the stored totals of the older days the forecast averages
  over. Money confirmed today on an order older than yesterday is no longer counted in today's received: orders are
  paid within minutes, and the alternative was reading a month of orders. (c) **Zone conversion** finds a zone's UTC
  offset once per half hour with `Intl` and does the rest in arithmetic, so a report costs a few dozen `Intl` calls at
  most (zero when warm), not thousands. (d) **Cache key** is the last event id and the business day, no minute, shared by
  every tab; "yesterday so far" is therefore as of the last change, not the clock. (e) A test proves it: over a 15-day
  history of 2,049 orders a request reads 294 orders (two days), makes no cold `formatToParts` calls, takes 50 to 65 ms
  on a loaded machine, and returns exactly the report the old code computed from the whole history, from live and from
  stored day totals. On Workers the checkpoint measures an idle hour of an open tab: 12 polls read a couple of rows each.
  A recompute after an event reads about 7 rows an order for two days: at 300 orders a day about 4,000 to 5,000 rows,
  so even a recompute at every one of 12 polls an hour is 60,000 an hour, and the 5 million is 80 hours away. CPU of a
  recompute on Workers is still unmeasured (Miniflare enforces no limit): watch the first deploy.
- **D-045 2026-11-11 The report is aggregated in SQL from write-time local fields; D-044 corrected again (M9 narrow
  review of 7e23b40).** D-044 still read all of today's and yesterday's orders into JavaScript and converted each time,
  and `salesSince` joined `order_lines` and `payment_top_ups` from the wrong side, so SQLite scanned both whole
  tables (plan: `SCAN l USING INDEX sqlite_autoindex_order_lines_1`): rows read grew with all history. Now:
  (1) **Plans.** The report's queries (`REPORT_SQL`) drive every join from orders (`CROSS JOIN`) or from an index, and
  a test asks SQLite for each plan and fails on any `SCAN` of a table. The plan of the main one: `SEARCH o USING INDEX
  sqlite_autoindex_orders_3 (day=?)`, `SEARCH l USING INDEX sqlite_autoindex_order_lines_1 (order_id=?)`, `SEARCH p
  USING INDEX sqlite_autoindex_payments_1 (order_id=?) LEFT-JOIN`; `salesLines` is `SEARCH o USING INDEX
  orders_created (created_at>?)` then the same `l` search. (2) **Local fields at write time.** Migration 11 adds
  `orders.local_min` (minute of the business-local day) and `day` and `local_min` to `payments` and
  `payment_top_ups`, set when the row is written (`Store.useTimeZone`, called by `createApp`; the first order also
  tells it) and filled in for older rows the first time the zone is given. Indexes `payments(day, local_min)` and
  `payment_top_ups(day, local_min)` serve received. (3) **The report is O(hours + items) in JavaScript**:
  `Store.dayStats(day, tz, {untilMinute, full})` returns a day's totals, 24 hourly buckets and units per item and size,
  grouped in SQL (so "yesterday up to 15:30" is `local_min <= 930`), and `reportFromDays` assembles the report; no
  order or payment time is converted per request. (4) **Received stays exact**: confirmations and top-ups are read by
  their own stored day and minute, so money confirmed today on an older order still counts today (tested). (5) **The
  forecast fallback** no longer lets a partial day overwrite a stored one: today and yesterday come from their own
  aggregates, older days from their stored or live totals; a 4-day-old shop's report equals the old code's (a test
  against a copy of the old algorithms, `tests/support/old-insights.ts`, live and stored). (6) **Closed days are frozen**
  (this amends D-044): a day's stored totals are as they were when it was closed, and lines or money added after the
  close are not counted there; that is fine for the forecast, which averages whole past days. Yesterday and today are
  never stored, always read live. Measured on Node (`process.cpuUsage`, batches of 40, median of 30; 3,786 orders
  seeded, 131 today so far, 227 yesterday, 13 closed days): the SQL of one report 5.5 ms (today 1.6, yesterday so far
  0.8, yesterday 2.7, stored days 0.8), `reportFromDays` 0.4 ms, serialising it 0.4 ms, the whole recompute 6.3 to
  6.6 ms. That is over the 5 ms aimed at and unmeasured on workerd, so on the free plan's 10 ms a recompute is
  plausible but tight; it runs only after an order changes (D-044). Rows returned by one request's queries: 30 at 15
  days of history, 28 at 40 and at 90 (flat past the forecast's 28 days; the plans are all searches, so rows scanned
  are the rows matched). A covering index on `order_lines` would cut a millisecond but adds a row written per line on
  every save, against the free plan's 100,000 a day, so it was not added.
- **D-046 2026-11-11 Finished days are read once and kept; start-up reads nothing; recompute CPU measured on workerd
  (M9 final review of 875fccc; corrects D-045's CPU figure).** The reviewer measured D-045's recompute on workerd, not
  Node: medians of 13.4 to 14.5 ms, over the free plan's 10 ms, with 90 days costing more than 15 at flat rows read. Two
  changes. (1) **Start-up.** `useTimeZone` looked for rows lacking local fields with an unindexed `WHERE local_min IS
  NULL`, which reads every order on every Durable Object start (4,065 rows at 15 days, 24,717 at 90). Migration 12 adds
  partial indexes (`orders_unlocal`, `payments_unlocal`, `payment_top_ups_unlocal`, each holding only rows still
  lacking the fields, so empty once filled and free to maintain) and the three lookups name them (`INDEXED BY`, because
  the planner otherwise preferred `payments_day`, which holds every unpaid payment); a test checks the plans, and
  another that a restart of a store with 90 days of history reads no rows. Measured in Miniflare through the cursor's
  `rowsRead`: 3 rows at start-up at 90 days (the schema version and the like), where there were 24,717. (2) **Finished
  days in memory.** A finished day is frozen (D-045), so `createReportBuilder` (`src/server/report.ts`) reads each once
  (`Store.closeDay`: the stored record, or computed once and stored) and keeps it in memory: yesterday in full, and the
  older days the forecast averages over. "Yesterday so far" no longer re-queries yesterday: its record carries the
  minutes in which something happened (`MinuteSlot`, about 200 entries) and `recordUpTo` sums those up to the clock time.
  A recompute is now one SQL pass over today. Because yesterday is frozen at its first read of the day, what yesterday's
  orders still owed (`awaiting*`) is as it was then, not as of now; the dashboard shows awaiting for today only, and
  received, orders and ordered value for yesterday cannot change after midnight. Measured on workerd (Miniflare, process
  CPU of the `workerd` child over 200 recomputes per batch, five batches, the cost of an empty request subtracted; the
  reviewer's `loop.mjs`): median 4.92 ms at 15 days of history (4,062 orders) and 4.69 and 4.92 ms at 90 days
  (24,714 orders), against 13.44 ms and 14.06 and 14.46 ms before: under the 6 ms aimed at, and flat with history, which
  also settles the 90-days-costs-more question (it was yesterday's and the older days' re-reads). I did not merge the
  lines query into the hourly one: with these numbers it was not needed. What is still unmeasured is a real deploy.

- **D-047 2026-11-11 The look is data: `theme.json` beside the business config, never a block inside it (M8).** One
  optional file in the config folder, validated at boot like the others: a bad one stops the server with the file, the
  field path, what was expected and what was found; unknown fields are refused, so a typo can't silently do nothing.
  Every field is optional and the defaults are the approved green and yellow look, so the tea-house sample has no
  theme file. Fields: `colors` (`primary`, `accent`, `header`, and `light` and `dark` each with `surface` and `text`),
  `font` (`inter`, `lora`, `nunito`, `space-grotesk` or `system`), `radius` (`sharp`, `soft`, `round`), `density`
  (`comfortable`, `compact`), `header` (`style` `awning`, `plain` or `image`, `awning` two stripe colours, `image`), `logo`
  and `categoryIcons` (a bundled icon name, a file in the config folder, or an https URL), `features` (`favourites`,
  `recent`, `tags` off, catalog or auto, `veg`, `darkToggle`, `cartEta`). The catalog gains optional `description`,
  `image` (file or https URL) and `diet` on items and `icon` on categories. Labels are `strings.<locale>.json`, a map
  from a known label key (`src/core/labels.ts`) to a text that keeps the default's `{placeholders}`; the page picks the
  browser's language, then its base, then English. Every colour not named is derived (`src/core/theme.ts`): the card,
  the muted inks, the soft tints, the on-colours (white or near-black, whichever reads) and the text colours
  (the brand colour moved toward black or white until it reads at 4.5:1 on its card), in both modes, so a brand colour
  can't produce unreadable text on a derived surface. Four open-licence typefaces (Inter, Lora, Nunito, Space
  Grotesk; OFL, Latin subset, one variable file each) are bundled with the 3D icon set (Fluent Emoji, MIT).
- **D-048 2026-11-11 Tokens are the only source of design; screens compose components (M8).** `/theme.css` (served
  by `src/server/theme.ts`, with an ETag of build and theme version, so it is cached and revalidated for a few bytes) holds
  every colour, radius, space and font as a custom property, light, dark by the system or by `data-theme`, and the
  chosen font's `@font-face`. `src/client/ui/ui.css` and the components in `src/client/ui/` (button, chip and badge,
  card, sheet, stepper, tab bar, header with the awning, stat, timeline, keypad, toast, skeleton) use only those
  properties; a build test fails if the shared stylesheet holds a brand colour. A new look is a theme, and the samples
  prove it: the same bundles render the default green, an espresso serif look and a compact square blue one. The strict
  content security policy stays and there is still no innerHTML; a style the page sets goes through CSSOM, which the
  policy allows, and `img-src` admits `'self'`, `data:` and only the https origins the config names. Config-folder
  images are served at `/media/<file>`, only the ones the theme and catalog name, read at boot (at most 2 MB each).
  The theme-colour meta and the manifest follow the header colour; the home-screen icon is made at build time and
  does not.
- **D-049 2026-11-11 The owner's Appearance is an override in the store, like availability (M8).** One row
  (`theme_override`, a migration) holds the owner's JSON over the config's theme; `PUT /api/owner/theme`
  validates the whole result with the same parser, `DELETE` resets to the config, `GET` returns the config's theme, the
  effective one and the contrast failures. Only what the screen edits can be overridden (colours, font, corners,
  spacing, header style and stripes, the logo icon, toggles); images and per-category icons stay with the config. A saved
  override that no longer validates is ignored at boot, never a reason not to start. The screen warns before saving a
  pair under WCAG AA (text on the page in each mode at 4.5:1, the main colour against the cards at 3:1): the first press
  warns, the second saves. Open pages poll `/api/theme` every 30 s and on becoming visible; a new version swaps the
  stylesheet with no reload, and what the toggles change shows on the next draw. Photo upload is not in M8: item photos
  come from the config; it is a later item.
- **D-050 2026-11-11 Two storefront figures come from bounded aggregate queries, off the request path (M8, review).**
  The bestseller and popular tags (the top seller by units, then the next two; none under 5 units) and the typical wait
  (the median minutes from placing to completing; none under 5 orders) are computed by two SQL aggregates in
  `src/store` (`FIGURE_SQL`), not by reading orders into JavaScript. The first sums units per item over the newest 500
  orders of the last 7 days and returns three rows; the second takes the newest 200 completed orders of the last 3 days
  and returns their waits. Both walk an index range (`orders_created`, `orders_status`) and the primary keys of the lines
  and status changes, with no table scan (a test reads their query plans); each is bounded by its LIMIT, so a compute
  reads about 4,000 rows at the caps, as the Durable Object counts them (index entries included; the
  first draft of this text said 2,800, counting table rows only; 1,374 measured on the demo's 200 orders), and took 3.5 ms and 1.9 ms on the demo's week (the first version read about 9,000 rows
  and took over a second). They are computed at boot and when the owner saves a look, and refreshed in the background
  when older than 30 minutes, so a request only reads the cache: at most 48 computes a day, about 190,000 rows read
  (48 times 4,000), plus a few thousand for each save of a look, against the 5 million a day of Principle 10. They hold no customer data and show only when the theme turns them on.
  No "average prep" or "cancelled" figure is shown anywhere: the analyst computes neither.
- **D-051 2026-11-11 The storefront's first load is budgeted at 60 KB gzip, fonts and images apart (M8).** The page,
  script, the two stylesheets and `theme.css` measure about 25 KB, checked by the build test. Fonts and icons are
  self-hosted under `/assets` and cached by the service worker as they are first used (cache-first, filled only from
  replies of the same build); the theme sheet is served stale while it revalidates; the API is never cached. Slow 3G
  still shows the menu within the same bounds (the e2e keeps its 12 s and 8 s limits).
- **D-052 2026-11-11 The look on Workers: bundled like the business, served by the Worker and the object (merge of M8 and M9).**
  A Worker has no config folder, so `scripts/bundle-look.ts <dir> <out.json>` loads the folder with the same `loadLook`
  Node uses (`src/server/look.ts`, the one place that reads files), and the result, theme, strings per locale, image
  hosts and the images as base64, is bundled as the alias `ibow-look`. Each `wrangler*.toml` build command writes it
  (`dist/look.json`, `dist/look-demo.json`) before building the client, so a bad theme file fails the deploy, as the
  business files do (D-034). `src/server/theme.ts` no longer reads files, so the Durable Object runs the same
  `registerTheme` as Node: `/theme.css`, `/api/theme`, the Appearance routes and the figures (D-050) go through the
  Worker to the object, which keeps the override in its SQL (`theme_override`, migration 13). The Worker forwards
  `/theme.css` and stamps the assets' build id on it (the service worker caches only its own build), serves `/media/*`
  from the bundle without waking the object, and builds the manifest with the header colour the object holds
  (`/__header-color`). The image hosts the config names reach the policy of every page: `_headers` carries them for the
  static pages (`build-client.ts --look`), and the Worker's own pages use `contentSecurityPolicy(look.imageOrigins)`.
  Cost: a page view adds one object request for `theme.css` (a 304 from memory, 0 rows) beside `/api/theme` (cached); a
  save recomputes the two figures, a few thousand rows (a test bounds it against the demo's week). Two gaps, accepted:
  the page's `<meta name="theme-color">` is the build's default on Workers (the manifest and `theme.css` follow the
  owner's colour; Node rewrites the tag per request), and a config image is capped at 2 MB, which counts against the
  Worker's 3 MB compressed size. Migrations: 10 to 12 are the Worker branch's (day totals, local minutes, partial
  indexes) and 13 is the theme override; the placeholder steps main carried for 10 to 12 are gone.
  A database that an unmerged build of main made before 2026-11-11 sits at version 13 with migrations 10 to 12 run as
  no-ops, so it lacks `day_totals` and the local-time columns; `migrate` detects that (version 13 or more, no
  `day_totals`) and refuses with the file to delete, instead of failing later with a missing column.
- **D-053 2026-11-11 Counts are words, not a number glued to a plural noun: plural forms live in the strings (M8).** A
  string that counts something keeps its general text under `key` and the singular beside it as `key_one`; other
  languages may add `key_zero`, `key_two`, `key_few` and `key_many`. `tn(key, count, vars)` picks the form with
  `Intl.PluralRules` for the browser's language (the owner's dashboard is English only), falling back to the general
  text; when a `strings.<locale>.json` overrides the general text its forms come from the file alone, so a translation
  never shows an English form. A strings file may carry any of these keys for a known label, and a form need not repeat
  the count. A test scans the customer, owner and staff tables so that no text counting orders, items, sizes, lines,
  reviews or visits lacks its `_one` form. This replaced two one-off pairs (`returningOne`, `sumAwaitingOne`).
- **D-054 2026-11-11 A demo may fix the server's clock, for screenshots only.** `IBOW_DEMO_NOW` (ms since 1970) is read
  by `src/server/main.ts` through `serverClock` (`src/demo/clock.ts`) and honoured only when the database carries the
  demo seed's mark; a real install ignores it whatever it holds and logs that it did (a test starts both servers and
  checks the order times). `startDemo({ now })` seeds the day up to that instant and passes it on; `scripts/screenshots.ts`
  uses 6:30 PM today in the sample's zone, installs the same time in every page with Playwright's clock, and fails if the
  storefront does not read "Open now". Not for the Worker: it has no such setting.
- **D-055 2026-11-12 A showcase page at `/showcase`, on in a demo and off in a real install unless the owner opts in.** A static
  page (`src/client/showcase.html` and `showcase.css`) with the pitch, the approved screenshots from `docs/media` (copied into
  `dist/client/showcase/` by the build, so there is one copy of each picture), the demo and source links, the no-warranty
  line and the consultancy line. It has no script, no inline style and no request to another host, so the pages' strict
  policy applies unchanged, and it is styled only through the install's own tokens (`/theme.css`). It is in no service
  worker's precache and outside the storefront's 60 KB first-load budget (a test pins both). A real shop's customers must
  not see an advertisement for the author's consultancy on the shop's own domain, so it answers 404 by default. It is on
  in a demo (Node: the same marker as the demo PINs; Workers: a demo bundle with `DEMO=1`) and on a real install that sets
  `"showcase": true` in `business.json`. The switch lives in `business.json`, not `theme.json`: it is a deployment choice,
  not a look, so the Appearance screen never touches it. On Workers the paths run the Worker first (`/showcase*` in both
  wrangler files) so the Worker can refuse them; on Node the files are left out of the served set. Its links are
  placeholders that `npm run set-links` fills in and the release scan refuses to let ship.
- **D-056 2026-11-12 Link placeholders are filled by a script and the export refuses any that remain.** The README,
  SECURITY.md and the showcase carry five placeholders for the owner's LinkedIn, Instagram, the live demo, the showcase
  (the demo plus `/showcase`) and the repository, in double braces with a `_URL` suffix. `npm run set-links -- --linkedin
  URL --instagram URL --demo URL --repo URL` replaces them in every text file, after checking that each address is https,
  carries no credentials, quotes or brackets, and sits on linkedin.com, instagram.com or github.com (the demo may be
  anywhere); nothing is written unless every address given is valid. `scripts/release-scan.ts --export` fails with the
  rule `link-placeholder` for any left, so an export cannot publish a dead link. The script builds the names at run time,
  so no file that has to survive the export holds one by accident.
- **D-057 2026-11-12 The repo ships a starter `config/`, `.dev.vars.example` and `.node-version`.** A stranger's first
  `npx wrangler deploy`, `npm start` or Cloudflare deploy button runs from a fresh clone only if `config/` exists, because
  `wrangler.toml` aliases `./config/*.json` and the server reads `./config` by default. `config/` therefore holds a copy
  of the `tea-house` sample's three files (a test loads it, so it cannot rot); the owner edits it in a fork or replaces it
  from another sample. `.dev.vars.example` names the one secret, `OWNER_PIN_HASH`, so a deploy button knows what to ask
  for (the release scan lets `.dev.vars.example` through, as it does `.env.example`). `.node-version` (24) tells hosted
  builds and version managers which Node the `.ts` scripts need.
- **D-058 2026-11-13 The public demo can run as a persistent Node service behind a tunnel (pull-based).** Workers' free quota
  is a daily account limit, and a demo anyone can click will spend it. `scripts/demo-serve.ts` (`npm run demo:serve`) runs
  the demo on plain Node: a data directory that holds `ibow.db` and `demo-pins.json`, seeded once when the database is
  missing or its PINs file is gone, never re-seeded on a restart, so the throwaway PINs and visitors' orders survive. It
  refuses a database that is not a demo's, serves the showcase (a demo), keeps the AI settings out, takes `TRUST_PROXY` from
  the environment and ends cleanly on SIGTERM. `/healthz` answers `ok` with no session and no database access, for the
  smoke test and the supervisor. `deploy/server/` is a self-contained user-level systemd kit for it (D-059). The seeded days
  age: after a few weeks the dashboard's "today" is empty until the data directory is cleared and the service restarted.
- **D-059 2026-11-13 A self-host kit of systemd user units, with pull-based updates (`deploy/server/`).** For a box the owner
  shares with other projects and cannot give sudo to, everything lives under `~/apps/ibow` and `~/.config/systemd/user`:
  `install.sh` unpacks the pinned official Node 24 tarball after checking it against nodejs.org's `SHASUMS256.txt`, installs
  the units and enables only its own; `ibow.service` runs `demo-serve` with `MemoryMax=300M`, `CPUQuota=50%` and the
  hardening an unprivileged user manager accepts (no `ProtectSystem` or `PrivateTmp`, which need a mount namespace).
  `update.sh`, run by a timer, takes the newest commit of the public repository only when GitHub's unauthenticated
  check-runs API says every check passed (`deploy/server/ci-status.ts`, tested), builds it in `releases/<sha>`, smoke-tests it
  on a spare port with a throwaway data directory, backs the data up, switches `current` by renaming a symlink, health-checks
  `/healthz`, and rolls back on failure, keeping three releases. A commit that failed is remembered and not retried. Pull
  replaced the push-based Workers deploy workflow, which is gone: no secret ever sits in GitHub, and the server needs no
  inbound port because a Cloudflare Tunnel dials out. Shell scripts are checked with `bash -n` only; shellcheck's npm
  package downloads its binary from GitHub, which this project's tests do not do.
- **D-060 2026-11-13 Releases after the first are ordinary commits made by `scripts/release-sync.sh`.** The export script makes
  a fresh one-commit repository, which is right once and wrong for every change after it. `release-sync.sh <clone> "<message>"`
  builds the same pruned, scanned tree, scans the message too, makes a clone of the public repository match it (deleting
  vanished tracked files, never touching `.git` or ignored files) and commits as the release author or a no-reply identity,
  or makes no commit when nothing changed. It cannot push or fetch. Tests that assume development-only files (the assistant
  folder and its instructions) must hold in the published tree, where they do not exist, so they derive their expectation
  from what is present.

- **D-061 2026-11-24 A demo runs any config folder, across the business's own hours.** `npm run demo -- <path>` and
  `demo-serve --sample <path>` accept a folder holding `business.json`, `catalog.json`, `stations.json` and `rush.json`
  besides a bundled sample's name, so a freelancer can show an owner their own menu without adding a sample to the repo
  (a business's real name never enters it). The seeder places orders only inside `business.hours` (the open part of a
  partly open hour, with its share of the weight) and takes an optional `hourWeights` from `rush.json` for a business
  busy at other times than the default morning, lunch and evening peaks. Without hours or a profile, every sample seeds
  exactly as before.

- **D-062 2026-11-24 A demo asks search engines not to index it.** A demo built from a real business's menu (D-061) must
  never be listed as that business's ordering page. On a demo install (the throwaway PINs are set) every response the
  app serves carries `X-Robots-Tag: noindex, nofollow`; on Workers that covers `/`, the API and the other worker-first
  paths, and static scripts and images, which nobody searches for, go without it. A real install is unchanged.

- **D-063 2026-11-24 Spots: where the customer sits, as config.** An optional `spots.json` lists zones and tables (a count with a
  prefix, or named spots). A QR per spot opens `/?spot=<id>`; the cart page also offers the list ("where are you sitting?"), and
  the counter's walk-in panel the same. The order stores the spot's label ("Garden T4") as a snapshot, so a later edit of
  `spots.json` never rewrites a past order, and every staff screen, ticket and token page shows it. The owner's Spots page prints
  the QR cards through the 80mm print path. An unknown spot is refused (`bad_spot`) on the API but ignored by the client when
  its QR is stale. Cost on a 300-order day: one TEXT column on `orders`, no new rows, no new reads. The Worker bundles the file
  through an `ibow-spots` alias (`[]` when a business has none).
- **D-064 2026-11-24 Extras are a library of groups named by id; the line's unit price includes them.** Items and categories
  name groups (`min`, `max`, options with a price, 0 allowed). An option id is unique across the library, so an order names its
  extras as a flat list of ids and the server finds each one's group; the line stores each extra's name and price as they were,
  and `unitMinor` already includes them, so every total, report, payment and top-up works on integer minor units unchanged.
  A batch row is item, size, extras and note, so "2 Latte Oat milk" and "1 Latte" are separate rows and are spoken so.
  Extras are stored as JSON in one column of `order_lines`: no extra rows (the 300-order rush writes the same rows as before).
  Variants that were really add-ons ("With egg") move to extras in the business's own config.
- **D-065 2026-11-24 A note per line: 80 characters, trimmed, shown and spoken everywhere the line is.** Free text for the
  kitchen. It is part of a batch row's identity, is never sent to a model, and is not personal data by design, but retention
  does not clear it: a customer who writes a name there keeps it until the order is pruned. Revisit if it matters.
- **D-066 2026-11-24 An item may name its station; lines carry when they were ready and handed over.** `station` on an item
  overrides its category's (validated against `stations.json` at load, so a typo stops the boot). Every category still needs a
  station. `readyAt` and `servedAt` are columns on `order_lines`, set by the same calls that already rewrite the order's lines,
  so no extra writes. Schema version 14.
- **D-067 2026-11-24 The runner view, and one "late" number.** `business.lateMinutes` (default 6) decides two things: part of an
  order was handed over and the rest has not followed within it, and a line standing ready that long without being carried (the
  cold chai). Late orders sort first, are announced once per order and reason, and are spoken. An order with every line
  delivered leaves the list even before the counter marks it collected. The owner's dashboard shows today's average and longest
  ready-to-delivered wait from one aggregate over the day's lines (about 700 rows read on a 300-order day, only when an event
  changed something since the last read; the insights answer is cached until then).
- **D-068 2026-11-24 A daily count per item, and a last-order time.** The owner sets how many are left in the morning
  (`daily_counts`: item, day, remaining; schema 15). Orders spend it inside the order's own transaction, an edit gives units
  back or takes more, zero switches the item off for new orders, and a count from another day is ignored, so nothing to reset.
  It is not an inventory system. Cost: a read of the few counted rows per order and per save, a write only for an item whose
  quantity changed (at most the counted items an order holds). `hours.lastOrder` turns customers away with `409 closed` after
  it and the storefront header shows the time; staff at the counter can still key an order in, and without it hours stay a label.
- **D-069 2026-11-24 Diet and allergen filters come from tags, and say so.** `filters` in `catalog.json` map a chip to a tag, to keep
  (`include`) or drop (`exclude`) items carrying it. An exclude filter cannot know about an untagged item, so the storefront
  says the filters follow the menu's tags and asks guests to tell staff about any allergy. Not done in M10: card payments and
  refunds (they touch every report that splits money by method); see the plan.
- **D-070 2026-11-24 A premium layer on the baseline: drawn line icons, a display face, photos only where there are photos.**
  The owner judged the 3D emoji icons "childish and generic" and asked for a premium look. (1) The Fluent PNGs are gone; one
  icon set drawn for ibow (`src/client/ui/icons.ts`: 24 px grid, 1.5 px line, round joins, an optional soft fill) renders as
  inline SVG built element by element (the strict policy holds), takes the text colour and the theme's tokens, and keeps
  every old icon name, so configs still validate; five names were added (cake, pancakes, salad, map_pin, sun). It costs
  about 6 KB gzip in the bundle and removes 58 image requests and 2 MB of PNGs. (2) `display` in the theme names a second
  bundled face for headings, prices, totals and the token (`--font-display`); Fraunces (OFL, Latin subset, 67 KB, loaded
  only by themes that name it) joins the fonts. (3) `features.tiles: "photos"` gives a card a picture only when the item
  has a photo, so a menu with a few real photos reads as an editorial menu, not rows of identical placeholders; the
  default stays `"always"`. (4) The component layer is quieter: semibold instead of extra-bold, neutral sentence-case tags,
  hairline cards, the primary colour for the selected pill and tab instead of an accent glow. Every sample keeps its own
  colours and words; none needed an edit. (5) `features.featured` opens the menu with a "Most loved" strip of the items
  that have a photo, best sellers first, on the unfiltered menu only; a card shows the item in the menu, where its own Add
  and choices are, so no second ordering path exists. Off by default.
- **D-071 2026-11-25 Card is a method staff record; a refund is its own row, netted where it was handed back.** `card` joins
  cash and UPI (`card: true` in `business.json` shows the button; ibow never touches a card, a person confirms it, as with cash).
  A refund records amount, method, who and when (`payment_refunds`, schema 16, one row per refund, none for an order without
  one) and is allowed only on money a person confirmed and only up to what that method took in (`over_refund`). Ordered is
  unchanged and an order refunded is not "awaiting": only Received falls, by the amount, on the business day and minute the
  money went back, so a refund made the next day shows on the next day's report as a negative. In memory it is a receipt with a
  negative amount, so insights, the SQL report, the cash/UPI/card split, the day records and the export all net it the same way
  (`tests/refunds.test.ts` compares the SQL and in-memory answers). Day records stored before this build have no card figure and
  read as 0. Cost: an order read does one more indexed lookup by order id (no rows when there is no refund); a refund writes the
  order's refund rows again (a handful), so a 300-order day with 10 refunds adds about 10 writes and 3 000 empty lookups.
- **D-073 2026-11-25 Notes are cleared with names; a station's batch shows where each order sits; D-068 stated more exactly.**
  A line's note is free text and can hold a name ("for Priya"), so retention clears it with names: the same pass overwrites it
  with spaces of the same byte length and then sets it NULL, in `order_lines` and in every snapshot of the order in `events`
  (`json_each` rebuilds `$.lines`), on Node and in a Durable Object alike (tests: the trigger-recorded values, the raw file bytes,
  and the Worker). Cost: three more statements an hour over the hour's rows only (the same bound as names). A batch row carries
  `spots` by token, a chip shows the spot, and the spoken batch reads "26-001 Garden T4" (no spot, no change). Corrections to
  D-068: `saveOrder` now reads the day's counts first and the order's stored lines only when some item has a count, so a venue
  with no counts pays none of the line reads it paid before (about 5 000 rows on a 300-order day); counts are keyed on the
  calendar day (`dayKey`), so a business open past midnight loses its counts at 00:00 and sets them again. The runner's "late"
  and the oldest-ticket age read the server's time, learnt from each reply's `Date` header (`serverNow`), not the phone's. Two
  cart lines that would merge past `maxQtyPerLine` stay two lines.
- **D-072 2026-11-25 Three levels above the staff screens, one powers table, each with its own PIN.** `src/core/levels.ts` holds
  the table (powers by level: `staff`, `manager`, `owner`, `admin`); every protected route asks `requirePower`, the hub reads
  it, and `docs/architecture.md` carries the same table, kept equal by a test. The owner's PIN is as it was (`OWNER_PIN_HASH`).
  The admin's is `ADMIN_PIN_HASH` (Node `.env`, Cloudflare `wrangler secret put`), made by `npm run hash-pin`; unset, nobody can
  sign in as admin and the answer is the same `bad_pin`. A manager is a staff member whose role is `manager`, created by the
  owner; ids `owner` and `admin` are reserved. The admin holds only system powers and no customer or sales route answers it. A
  manager works every staff screen, switches items and sets counts (`/api/menu/items/:id`, also at its old owner path), and
  refunds up to `managerRefundLimit` of `business.json` on one order, the order's whole refunded sum counted (`refund_limit`,
  403); without the field a manager may not refund, the owner always may. Demo mode shows a throwaway PIN for every level
  (five PINs; `ADMIN_PIN_HASH` is set by `npm run demo` for the child server). Schema: no change for levels (a manager is a
  `staff.role`, sessions already stored a role). Cost: none per request beyond the table lookup; a login is still one PIN
  derivation.
- **D-074 2026-11-25 The links hub is one page at `/admin`, and the server decides what it shows.** `src/core/hub.ts` lists every
  screen (storefront, screen ordering, counter, each station from `stations.json`, runner, the manager's menu screen, each
  owner tab, the spots QR sheet only where the config has spots, switches, health), each with a line saying what it is for and
  a power from the table; `GET /api/hub` returns only the groups the signed-in level may open, and, signed out, the public
  links with no level, so the page offers the four sign-in choices beside them. Station-only staff are not offered the counter
  or the runner. A person who chooses "Manager" and signs in with a staff ID that is not a manager is signed out again, not
  shown a hub of another level. The page is a static asset (`admin.html`, `admin.js`, `admin.css`, no service worker, no code of
  any other page in its bundle and none of it in theirs); on Cloudflare it runs no Worker code. Cost: one small JSON request
  per visit; no polling except the health view's 30-second refresh while it is open.
- **D-075 2026-11-25 Feature flags: the look's by the owner, the system's by the admin, stored in the install and audited.**
  Look flags are the theme's `features` (named `features.<name>`): the owner flips them on the hub or in Appearance, both
  through the same override row (`theme_override`), so there is one source of truth; system flags are `ai`, `retentionDays`
  and `showcase` (`flags` table, schema 17), flipped by the admin. Every change writes who, when, level, from and to to
  `flag_audit` (an Appearance save writes one row per feature it changed, a reset too); no change, no row. The theme's `version`
  now hashes the features, header, logo and icons as well as the CSS, so an open storefront's 30-second check (and the check
  when it comes back into view) sees a flipped switch and redraws without a reload. System flags are held in memory (the
  single writer) and loaded once. Effects: `retentionDays` applies at the next hourly pass and to the owner's repeat-customer
  window; `ai` can switch an analyst that is set up off (`ai_off`, 409; the panel asks `/api/owner/ai` and hides itself) and
  never one on where no model is set up; `showcase` is read per request (on Cloudflare, the Worker asks the object at most
  every 30 s). Cost: a flip is one flag row and one audit row; no per-request reads; `GET /api/flags` reads the audit
  (bounded to 200 rows).
- **D-076 2026-11-25 Telemetry for the admin: counted in memory, one row per hour, kept on the install.** Per request the
  middleware adds to a few counters (requests, 5xx answers, per route a count, total and worst time, keyed by the route's
  pattern, never the path); they are written to `telemetry_hours` (schema 18, one row per UTC hour, 7 days kept, 20 routes per
  hour) at most every 30 s while requests come in and with the hourly pass, so a 300-order day of about 3 600 requests over 12
  busy hours writes at most about 1 440 upserts, about 1 to 3% of the free plan's 100 000 rows, and a quiet install writes
  none (`tests/telemetry.test.ts`). Rows written come from the driver (a Durable Object reports them, indexes included; on Node
  they are rows changed, a lower bound), counted per flush and summed from 00:00 UTC. Also shown: open live streams (from the
  streams module), database size (`databaseSize` in a Durable Object, page count by page size on Node), build, uptime, and the
  last backup: the newest file in `BACKUP_DIR` on Node, else the time of the last export, else unknown. Nothing is sent
  anywhere. Eviction of a Durable Object can lose up to half a minute of counts. On Workers, `Date.now()` stands still during
  synchronous work, so route times there measure waiting, not CPU. The verdict is one line: more than 2% of 50 or more
  requests ending in an error, 80% of the day's free rows, or 80% of the free storage.

- **D-080 2026-11-25 An app shell, order numbers and the name first (M13).** (1) Every page opens on a splash drawn by CSS
  alone from `/theme.css` (`--brand-name`, `--brand-mark`; the policy allows no inline script or style), and hands over to
  the first screen once `#app` holds one (`watchBoot`, at least 650 ms, at most 6 s). Screens inside a page change in a
  view transition where the browser has them; cross-document view transitions are off, since after a back navigation and a
  reload they left the page stuck mid-transition. The shell adds safe areas, no rubber-band scroll, no text selection on
  controls and 16 px inputs (no zoom on focus). (2) Every "can't do that now" is a native `<dialog>` (focus held, Escape
  closes): ordering paused (closed, or past the last-order time; the server's own rule), an item gone, offline. The menu
  also shows a slim banner while ordering is paused and says "Last orders taken" in its header, not "Open now". (3) People
  read and hear an order number, `#47`, never the stored `25-047`: every label's `{token}` is shown through `orderNumber`,
  lookup accepts the number alone (`tokenForNumber`, today's order), and the data keeps the day. (4) The cart asks
  "What's your name?" first, still optional (principle 7), and the order page shows the name large under the number.

- **D-081 2026-11-25 Pages name their scripts and sheets with the build.** `buildClient` stamps every `href="/x.css"` and
  `src="/x.js"` of the built pages as `?b=<build>`. A cache in front of the server that ignores `no-cache` (Cloudflare's
  default Browser Cache TTL makes it four hours) can then never pair one build's page with another build's files. Both
  servers look files up by path, so the stamp costs nothing; the service worker keys its cache by path too, and only the
  live-theme swap's `?v=` (not `?b=`) sends `/theme.css` to the network.

- **D-082 2026-11-25 The room bill: an order a guest puts on their room stays unpaid until staff settle the room.** A zone in
  `spots.json` may be `"kind": "room"` (default `table`); its spots are rooms, and its QR opens the storefront with that room
  set like any spot. An order from a room's spot may carry `pay: "room"` (else `400 bad_room`); it stores `roomBill: {room}`
  (the spot id, column `orders.room`) and its payment stays `unpaid`, so it counts in Ordered, under Open room bills (not Awaiting confirmation: nothing waits on a confirm) and
  never in Received (principle 6). While open, the counter's confirm and the guest's claim are refused (`409 room_bill`): the
  money is taken once, at checkout, in Rooms. `POST /api/rooms/:room/settle {method, amountMinor}` confirms every open
  room-bill order of that room, each for its own total, by the person signed in, at that moment, and writes one
  `room_settlements` row (who, level, when, method, amount, the order ids), in one transaction. `amountMinor` must equal the
  open total the screen showed, else `409 room_changed` and nothing changes, so a guest is never charged for an order that
  arrived while they stood at the desk; all or nothing, no partial settlement. Received then moves on the settle day by the
  method chosen, through the existing per-payment SQL, with no new report query. A refund after checkout is an ordinary
  refund. Who may settle is the counter's power (`orders.run`, station-only staff refused). A guest at a room's spot who
  doesn't stay just pays the usual way; without a room zone nothing changes. Cost on a 300-order day: no new reads or writes
  for orders not on a room bill; a room order writes the same rows as any order; open room bills are found through a partial
  index (`orders_room_open`) holding only unsettled room orders, so the owner's figure and the Rooms list read those few
  orders; a settlement writes one audit row plus the payment and event rows its orders would write at the counter anyway
  (schema 19).
  **Only the room's own QR can charge it.** Threat (review, 2026-11-25): the server checked only that the spot was a room,
  and the cart's picker listed every room, so any guest could put an order on someone else's bill. Fix: each room's QR
  carries a key (`/?spot=rooms-3&key=…`), an HMAC-SHA256 of the spot id under a 32-byte secret made once per install and
  kept in `meta.room_key_secret` (no table of keys; 22 base64url characters, 132 bits, compared in constant time).
  `pay: "room"` needs `roomKey` to match, else `403 room_key` naming the room and saying to scan its QR or pay the usual
  way; nothing is stored, and the same guest can still order and pay at the counter. Staff who may run orders
  (`orders.run`, not station-only staff) may key a room's order in without it. The owner reads the keyed links at
  `GET /api/rooms/keys` (`look.edit`) for the Spots page and its print; a reprint gives the same codes, a new install new
  ones. The cart's picker lists a room only to the guest who opened that room's QR, and offers the room bill only with its
  key. A demo publishes its rooms' keys in `GET /api/demo` (`roomKeys`, demo installs only), and the storefront, opened
  on a room without a key, asks for it there once, so a plain `/?spot=rooms-1` link (a proposal page's) opens the room on a
  demo and never on a real install. Cost: one HMAC per room-bill order, no rows.
  **A key is a bearer token, so the owner can replace one (release review, 2026-11-25).** Limit: a key never expires by
  itself, and a guest who checked out keeps a photo of the QR, so until the owner acts that photo can still charge the room.
  "New QR" on the owner's Spots page (`POST /api/rooms/:room/new-key`, `look.edit`, after a confirm) bumps that room's key
  number (`meta.room_key_number:<room>`, absent means 0); the key is the HMAC of `room:<id>:<number>` (`room:<id>` at 0, so
  QRs printed before rotation existed still work), the old key is refused at once with `403 room_key`, and every other room
  keeps its own. The owner prints the new card and replaces the old one; doing it at each checkout is the owner's call,
  not automatic. A key is checked for its shape (`^[A-Za-z0-9_-]{22}$`) before the constant-time compare, which compares
  bytes, so an odd key is a 403, never a 500. The storefront keeps the key in the tab's session storage for its room and
  removes it from the address bar (`history.replaceState`), so a link the guest shares does not pass it on. Cost: one `meta`
  row read per key check and per room listed on Spots (6 for six rooms), one row written per press; nothing on a 300-order
  day that has no room orders.
  **A wrong order can leave the bill.** `POST /api/orders/:id/off-room {reason?}` (`orders.run`) takes an order open on a
  room bill off it: it becomes an ordinary unpaid order, paid at the counter like any other, and one `room_bill_moves`
  row keeps who, level, when, which order, from which room and why (optional, 120 characters), in the same transaction
  (schema 21). Rooms lists the moves beside the settlements. An order settled, paid or never on a bill answers
  `409 not_on_room_bill`.

- **D-083 2026-11-25 Rooms is a staff screen with the counter's power.** `/staff#/rooms` lists each room with open room-bill
  orders (order number, name if given, time, amount) and its total, with one button per method the business takes (cash;
  UPI with `UPI_VPA`; card with `"card": true`) that settles the room for exactly that total. Below it, the latest 20
  settlements: room, who, when, method, amount. It opens for whoever may work the counter (`orders.run`: counter and all
  staff, a manager, the owner), never station-only staff, and only when `spots.json` has a room zone; the links hub lists
  it under staff on the same terms. The counter shows a room-bill order as "On the room bill" with no payment buttons. The
  screen reads `/api/rooms` when opened, after each settle or move, and when the counter stream it follows brings an event
  about a room-bill order or an order on screen: no polling. Cost (corrected in review): as first built it re-read on every
  counter event, about 1 500 reads of `/api/rooms` on a 300-order day (some 5 events per order) for each open Rooms screen,
  each reading the open room orders (about 6 rows each) and 40 audit rows, so some 150 000 rows read a day, 3% of the free
  plan's 5 million. Redrawing only for room-bill events brings it to the room orders' own events: with 20 room orders a day,
  about 100 re-reads of some 100 rows, 10 000 rows a day per open screen. Nothing per request elsewhere.

- **D-084 2026-11-25 Events live in the store, held in memory, public only for guests.** An event is a title (60), a date,
  a start time, an optional end time (before the start means the next morning, so a late night runs 21:00 to 01:00 and is
  "on now" until then; equal to the start is refused), a one-line note (120), an optional entry price in minor units (shown to guests; no
  booking or tickets), who sees it (`all`: guests and staff; `staff`) and an "expect a rush" flag; it is one day, or
  repeats weekly on one or more weekdays from its date up to an optional end date. Owners and managers manage them
  (`events.manage`) on the owner's Events tab and the manager's screen; `events.json` in the config folder (the same
  fields, checked at boot, bundled with the look for a Worker) seeds the calendar once (`meta.events_seeded`), so an event
  deleted later never returns. `GET /api/events` answers the next occurrence of each event in the coming 7 days, soonest
  first: guest events to anyone, every event to any signed-in session; `GET /api/events/all` and the writes need the
  power. Events are deleted 2 days after a one-off's day or a repeat's end date, checked once per business day on read; an
  open-ended repeat stays; at most 100 are kept (`409 too_many_events`). The single writer (D-031) holds them in memory,
  loaded once at boot, so a page asking for its banner costs no row read: on a 300-order day of about 3 600 requests the
  calendar adds no reads, a handful of writes when someone edits, and one delete a day at most (schema 20, one JSON row
  per event).

- **D-086 2026-11-25 The demo's day keeps going, with rooms and events.** Each seeded day's order times and baskets now come
  from a random stream of that day alone, so the same day always gets the same orders; the seed records how far it placed
  them (`meta.demo_seeded_until`). `topUpDemo` places what a fresh seed would have placed since then, day by day up to the
  clock (at most 8 days back), and is run when a kept demo starts (`demo-serve`, which reuses its database) and every hour
  (the Node server on a demo database with a `rush.json` beside its config, and the Worker's hourly alarm on a demo bundle).
  That fixes a kept demo's next day opening on "2 orders, down 85% on yesterday": a fresh `npm run demo` already seeded
  today up to the clock, along `hourWeights` and inside the opening hours. With a room zone, 4 of today's collected orders
  (yesterday's before today has enough) are delivered to rooms 1 to 3 and left on their bills. The sample's `rush.json`
  carries `events` relative to the demo's day (`inDays`; today's without a `start` begins two hours on), written by the
  rush generator from `SAMPLE_RUSHES`; café orders in a generated rush sit only at tables. The garden cafe has 6 rooms, a
  rush-flagged guest event today, a weekly Sunday one with an entry price and a staff-only delivery in 3 days, all
  invented. Cost: a top-up on a 300-order sample writes about an hour of orders per hour, what a real day would; the
  Worker's demo at its 0.22 scale stays a few hundred rows an hour, far under the free plan's 100 000 a day.

- **D-085 2026-11-25 Event banners are one client module over the shell, drawn by tokens.** `src/client/events.ts` reads
  `/api/events` once per page and builds every banner from one function: on the splash of the staff, owner and hub pages
  (`showSplashEvent`, which keeps the splash up 2 s from the page's start so it can be read, and lets it go at once when
  there is no event; `holdSplash` in `ui/shell.ts`), as a card at the top of the staff chooser, the manager's screen, the
  owner's Today and the hub, as a slim banner under the storefront's header that a guest can hide for that occurrence (kept
  on the phone), and as one line on the order page. It shows the title, when ("In 2 days · Sat 10:00", "Tomorrow · 10:00",
  "Today · starts in 2 h 15 min", "Today · on now"), the note and the price, "Expect a rush" for staff, and "Weekly" for a
  repeat. On its day the banner celebrates: a confetti burst of 14 `<i>` drawn and placed by `ui/events.css` alone (theme
  tokens, `nth-child` positions, no inline style, nothing at all under `prefers-reduced-motion`) and a countdown that moves
  every 30 s from the server's clock. Every word is a key in `src/core/labels.ts`, so `strings.<locale>.json` can change
  it; the editor's labels are their own table (`events-strings.ts`). Cost: one cached request per page load; the storefront
  grows by about 2 KB gzip.

- **D-090 2026-11-25 Closed days in the opening hours.** `hours.closedDays` lists whole weekdays a business is shut
  (`"mon"` to `"sun"`, business-local; all seven is refused as a mistake). On such a day the storefront and the server
  take no orders, exactly like the time past `lastOrder`, and the closed dialog names the next open day
  ("We open again Tuesday at 09:00") in the customer's language. Many small businesses close one day a week, and a
  storefront that cheerfully takes Monday's orders for a shut kitchen is worse than none. Cost: one weekday lookup per
  order placed and per page render; no rows.
- **D-091 2026-11-25 A model request may carry images, as data URLs in content parts (M15).** `ChatRequest.images` is a
  list of `data:image/...;base64,` URLs. The Chat Completions adapter sends the user message as
  `[{type: "text"}, {type: "image_url", image_url: {url}}...]`, the OpenAI-compatible form that hosted vision models and
  local servers (Ollama, llama.cpp, vLLM) accept; without images it is the plain string it always was, so the analyst's
  requests are byte for byte unchanged. Data URLs, not hosted links, because nothing is uploaded anywhere and a local
  model can read them. Still no vendor SDK and no model name in code; a model that can't see images refuses the call
  and the importer says so.
- **D-092 2026-11-25 Menu import: the model reads the menu, code builds the catalog (M15).** `npm run import-menu` sends
  each page or piece of a menu to the model (`src/ai/menu-reader.ts`) and asks for one JSON shape: sections, items (name,
  a price or prices per size, a printed description, tags from a short known list, a diet marker, add-on groups by name,
  `unsure`) and add-on groups with option prices. Reading a photo or a messy page is judgement, which is the model's job
  (Principle 1). Everything after the reply is code (`src/import/catalog.ts`): the JSON is found and checked, prices become
  integer minor units by decimal arithmetic on the digits (half up, so 20.555 is 2056 paise, not float's 2055), ids are made,
  pages merged, add-ons mapped to extras, and the result goes through `parseCatalog`, so a written file always loads. An item
  without a usable price is left out of the file and listed, never given a placeholder price someone might switch on. A price
  printed as text loses a currency word or symbol (with its dot) before or after the number ("Rs. 120", "INR 120", "₹120",
  "120/-"); what is left must be one number, so a range, a deal or a minus sign ("10-12", "2 for 5", "-5") is odd, never
  merged into 1012 or 25, and the item is left out and listed (corrected in release review). An item the model marked
  `unsure` is written with `available: false`, so nobody can order a misread name or price before a person switches it on,
  and the list says so (corrected in release review). An unknown
  tag is kept and listed; an unknown diet marker is dropped and listed. The command exits 1 only when no model is set (or it is
  half-set), a model call fails (nothing is written), or no item with a price came back; an unreadable reply for one part is
  listed and skipped. It uses the analyst's settings (`AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_ADAPTER`), waits 120 s per
  call unless `AI_TIMEOUT_SECONDS` is set, never names a model, and never replaces an existing file without `--force`. A menu
  holds nothing personal, and the model is told "part 2 of 3", never a path. It is a developer command, not a screen: an install
  without AI never loads it.
- **D-093 2026-11-25 A PDF is refused; export its pages as images.** Text in a PDF sits in compressed content streams drawn with
  fonts whose codes map to letters only through each font's encoding or ToUnicode table; reading that honestly is a PDF library
  (pdf.js is megabytes), and a scanned menu PDF has no text at all. Every PDF viewer exports pages as images in one step, and
  a page image is what a vision model reads best, so the importer refuses a `.pdf` before any call and says exactly that. No new
  dependency. Revisit if owners hit it often: a page renderer is the step, not a text extractor.
- **D-094 2026-11-25 Imported ids are stable slugs; pages merge by name.** A category's id is its name as a slug (accents
  dropped); a section with the same slug on a later page or part is the same category, items appended in reading order. An item
  with the same slug in the same section is one item: the first price is kept, later description, diet and tags fill gaps, and
  the duplicate is listed with both prices when they differ. The same name in another section is kept, with the section's id in
  front (`kids-lemonade`), and listed. Names with no Latin letters get `section-<n>` and `<category>-item` ids. Add-on groups
  become the `extras` library (D-064): a group's id is its slug, an option's id is its slug unless another group took it (then
  `<group>-<option>`), `min`/`max` from the reply when valid (else 0 and all options); a group goes on the categories it names
  and on the items that name it, and one offered nowhere stays in the library and is listed. A price over 50 times the menu's
  middle price (with 5 or more items) is listed as a likely misread decimal point. The same input gives the same file.
- **D-095 2026-11-25 Big menus are split under a token budget; one call per photo.** A photo is one call (one page). Text is cut
  at blank lines (whole lines when a paragraph is longer, hard cuts for a longer line) into parts of at most 8,000 characters,
  about 2,000 tokens: a menu line becomes about three times as many tokens of JSON, and a reply is capped at 8,192 tokens and
  64 KB (D-026). Cost: calls = photos + the sum over text files of ceil(characters / 8,000) at most, in order, one at a time; a
  four-page photographed menu is 4 calls, a 30 KB menu page saved as HTML (about 12 KB of text once stripped) is 2. The
  command prints the number of calls it made. A busy model (429, 5xx, a timeout or no answer) is asked again after 5, 15 and 30 s, at most three extra calls per piece; any other refusal fails at once. A shared proxy that is out of capacity for a minute then costs a wait, not the pages already read (found on the first real run).


- **D-087 2026-11-25 A staff record named `admin` is renamed by a setting, on Node and on a Worker alike.** Since D-072 the
  id `admin` is the system admin's sign-in, so a staff member saved under it earlier stops the boot. The message now names
  the fix: set `RENAME_ADMIN_STAFF=<new id>` (`.env` on Node; `npx wrangler secret put RENAME_ADMIN_STAFF` on Cloudflare,
  where a Durable Object's SQL can't be reached from outside) and start again, or on Node run the one `UPDATE staff` it
  prints. At start the setting renames the record once (an id like any staff id, free, not `admin` or `owner`, else the
  boot stops naming the setting) and ends that person's sessions; set again later it does nothing. Cost: one staff read at
  start, as before.

