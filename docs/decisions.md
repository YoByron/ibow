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
