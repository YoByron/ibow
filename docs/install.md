# Installing ibow for a business

This guide is for whoever sets ibow up for a shop: often a freelancer doing it for a client. By the end the business
has its own storefront, counter and station screens and an owner dashboard on its own domain, over HTTPS. One install
serves one business.

Three ways to run it (the third, your own server behind a Cloudflare Tunnel, has [its own section](#your-own-server-with-cloudflare-tunnel-pull-based-updates)):

- **A. Cloudflare Workers, free plan (recommended).** No server to look after: `wrangler deploy` puts the screens and
  the API on Cloudflare, and the business's data lives in a Durable Object's SQLite storage. The free plan holds a busy
  counter (about 800 orders a day; the numbers are in [Limits](#limits-on-the-free-plan)).
- **B. Plain Node on a small VPS** (1 vCPU, 1 GB RAM, about US$5 a month) or any always-on machine, behind Caddy. Pick
  this to keep the data on your own disk.

Either way the steps are the same: try the demo, write the business's config, set the owner PIN and payments, start it
or deploy it, put your domain on it, keep backups. Every setting and config field is explained in
[configure.md](configure.md); this page is about getting it running.

## 0. Before you start

You need three things on the computer you work from, on Windows, macOS or Linux:

| Tool | Check it | Get it |
|---|---|---|
| Node 24 or newer | `node --version` prints `v24` or higher | [nodejs.org](https://nodejs.org), the current LTS or newer; it includes `npm` |
| git | `git --version` | [git-scm.com](https://git-scm.com/downloads) |
| A terminal | | Windows: **PowerShell** (not the old `cmd`). macOS: Terminal. Linux: any. |

An older Node fails with errors about `.ts` files or `node:sqlite`: install Node 24 and try again. Commands below are
the same on all three systems unless a note says otherwise. Copy a command in full; lines starting with `#` are
comments.

## 1. Try the demo first

On your own computer, with Node 24 and git:

```sh
git clone https://github.com/YoByron/ibow ibow
cd ibow
npm ci
npm run demo
```

It prints the storefront, staff and owner URLs and PINs that work only for this demo. The demo runs a sample business
with the past week of orders on a temporary database and deletes it when you press Ctrl+C. Other samples:
`npm run demo -- coffee-cart` (also `food-truck`, `bakery`, `service-desk`). It refuses to start on a real install's
database, so it's safe to run anywhere.

The same demo can run on Cloudflare, so you can show a client a link: see [The public demo](#the-public-demo-on-cloudflare).

## 2. Describe the business: three config files

ibow knows nothing about a business except what three JSON files say. The repo already has a `config/` folder holding the
tea-house sample as a starting point: edit those three files, or replace them with the sample closest to your business
(this overwrites what is in `config/`).

macOS, Linux, or Git Bash on Windows:

```sh
cp samples/coffee-cart/* config/
```

Windows PowerShell:

```powershell
Copy-Item samples\coffee-cart\* config\
```

(Then delete `config/rush.json`, which is only the demo's sample orders. `theme.json`, `strings.*.json` and
images are optional extras that some samples carry; empty `config/` first if it held your own files.) The files are explained field by field in
[configure.md](configure.md), which ends with a worked example that turns a sample into your own café.

- **`business.json`**: `name`, `currency` (ISO 4217, such as `INR`, `USD`, `AED`) and `timeZone` (IANA, such as
  `Asia/Kolkata`); both are required, with no default, because tokens and reports follow the business's own day.
  Optional: `cashShortcuts` (the notes the counter offers as one-tap buttons, in whole units, such as `[10, 20, 50]`),
  `retentionDays` (how long customer names and review text are kept; default 30), `maxQtyPerLine`, `phone`,
  `address`.
- **`catalog.json`**: categories, each with items; an item has a `price` in minor units (paise, cents: `9000` is
  ₹90.00) or `variants` with a size and price each. `"available": false` hides an item; the owner can also switch
  items off and on from the dashboard.
- **`stations.json`**: where work happens (a tea counter, a grill, a workshop) and which categories go there. Every
  category goes to exactly one station. `view` is `batch` (open items totalled and read out as one list, the default)
  or `jobs` (one card per order, for work that belongs to one customer); `speak` reads arrivals aloud; `print` is
  `"ticket-80mm"` or `null`.

The full contract is in [architecture.md](architecture.md#contracts). If a file is wrong, the server refuses to start
(on Cloudflare, `wrangler deploy` fails) and says which file and field. An edit to these files takes effect at the next
restart or deploy.

## 3. The owner PIN and payments

The owner's PIN is stored nowhere, only its hash. Make the hash and keep it for the next step (type the PIN when it asks
and press Enter; it prints one long line starting `pbkdf2-sha256$`):

```sh
npm run hash-pin       # type the owner's PIN (4 to 12 digits); it prints a hash
```

| Setting | What to put |
|---|---|
| `OWNER_PIN_HASH` | Required. The output of `npm run hash-pin`. To change the PIN, make a new hash and set it again. |
| `UPI_VPA` | INR businesses only: the shop's UPI ID (`yourbusiness@upi`), so customers can pay by UPI QR or app. Leave it unset to offer only "pay at the counter". ibow never marks money received by itself: staff confirm each payment. |
| `UPI_PAYEE_NAME` | The payee name shown in the customer's UPI app (default: the business name). |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_SECONDS` | Optional: the AI business analyst ([below](#the-ai-business-analyst-optional)). Leave them unset and it stays off. |
| `CONFIG_DIR`, `DATA_DIR`, `HOST`, `PORT`, `TRUST_PROXY` | Plain Node only ([part B](#b-plain-node-on-a-vps)). Cloudflare has no use for them. |

Staff accounts are made by the owner from the dashboard (Staff tab): an ID, a PIN and a role (counter, station, or
both). Nothing else needs a password.

## A. Cloudflare Workers, free plan

You need Node 24 and git (step 0), the three config files in `config/` (step 2) and the owner PIN hash (step 3).

### From zero: the account

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) with an email and a password, and click
   the link in the verification email. No card is needed for the free plan.
2. In a terminal, in the ibow folder, install what ibow needs and sign wrangler (Cloudflare's command-line tool, already
   one of ibow's dependencies) in to the account:

   ```sh
   npm ci
   npx wrangler login      # opens a browser; click Allow
   npx wrangler whoami     # prints your account name and id: proof that you are signed in
   ```

   On a machine with no browser (a server), use an API token instead: create one in the dashboard from the *Edit
   Cloudflare Workers* template, then set it in the shell as `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if the
   token covers several accounts).

### Deploy

Check the config first without touching Cloudflare: `npx wrangler deploy --dry-run` builds everything and prints the
size, and fails on a wrong config file (or a missing `config/`) exactly as the real deploy would. Then:

```sh
npx wrangler deploy                      # builds the screens, bundles config/ (and its theme.json, strings and images), and publishes the Worker named "ibow"
npx wrangler secret put OWNER_PIN_HASH   # paste the hash from step 3, then Enter
```

The first deploy of an account may ask you to register a `workers.dev` name (the `<your-subdomain>` below); type one and
confirm. `wrangler deploy` then prints the address, `https://ibow.<your-subdomain>.workers.dev`. Until the secret is set every
request answers `503` with the sentence "expected the secret OWNER_PIN_HASH ... run: npx wrangler secret put
OWNER_PIN_HASH"; set it and reload. Then the storefront is `/`, screen ordering is `/?kiosk=1` on a shop-owned tablet,
staff use `/staff`, and the owner uses `/owner`. Print the storefront address as a QR code for the counter with any QR
maker. `/showcase` is a static page about ibow itself (no shop data). It is off on a real install (404); add
`"showcase": true` to `config/business.json` to serve it. The public demo serves it by default.

Optional settings, each a `wrangler secret put` (or a line under `[vars]` in `wrangler.toml` for the ones that are not
secret): `UPI_VPA`, `UPI_PAYEE_NAME`, and the `AI_*` settings. A change to a secret applies at once. A change to the
config files, or to ibow, needs another `npx wrangler deploy`.

To rename the Worker (and so its address), change `name` in `wrangler.toml` before the first deploy. The data belongs
to the Worker's name: deploying under another name starts an empty business.

### Trying the Worker on your computer

`npx wrangler dev` runs the Worker locally (nothing is deployed). Local secrets go in `.dev.vars`, wrangler's counterpart of
`.env`: copy the template and fill in the hash (never commit `.dev.vars`; it is ignored by git):

```sh
cp .dev.vars.example .dev.vars        # PowerShell: Copy-Item .dev.vars.example .dev.vars
npm run hash-pin                      # paste the printed hash after OWNER_PIN_HASH= in .dev.vars
npx wrangler dev
```

### Your own domain

Phones need HTTPS to install the storefront as an app, keep its offline cache and show notifications; the
`workers.dev` address has it, and so does your domain. The domain's DNS has to be on Cloudflare (add the site to your
account and point its nameservers at Cloudflare; the free plan does this). Then add to `wrangler.toml`:

```toml
[[routes]]
pattern = "order.yourbusiness.com"
custom_domain = true
```

and run `npx wrangler deploy` again. Cloudflare creates the DNS record and the certificate itself. The hostname must
not already have a CNAME record. Or do it in the dashboard: Workers & Pages, your Worker, Settings, Domains & Routes,
Add, Custom Domain.

### The public demo on Cloudflare

To put the demo online as a link for a client. Do it on a **separate Cloudflare account** from your shop's: the free plan's
daily limits are per account, and a demo anyone can click must not be able to spend your shop's day. Sign up a second
account with another email, then:

```sh
npx wrangler logout                      # leave your shop's account (skip if you have not signed in yet)
npx wrangler login                       # sign in as the demo account in the browser
npx wrangler whoami                      # check it names the demo account
npx wrangler deploy -c wrangler.demo.toml
```

When you go back to deploy the shop, `npx wrangler logout` and `npx wrangler login` as the shop's account again; `whoami`
before every `deploy` is a cheap habit. With API tokens, keep two tokens and set `CLOUDFLARE_API_TOKEN` to the right one
for each command.

It publishes a second Worker, `ibow-demo`, running the tea-house sample with three days of seeded orders (about 200) and **throwaway
PINs shown on the staff, counter and owner sign-in screens**, so a visitor can try every role. The PINs are made once,
when the demo first starts; to get new ones delete the `ibow-demo` Worker in the dashboard and deploy again. It is a
different Worker from yours, so it never touches your business's data, and it refuses to run on any database that is
not a demo's (and your business refuses to run on a demo's). It needs no secrets. To demo another sample, point the
four `[alias]` lines in `wrangler.demo.toml` at it.

### Limits on the free plan

Checked against Cloudflare's documentation on 2026-11-11 (links in `docs/decisions.md`, D-030 to D-036):

| Limit (per day, reset 00:00 UTC) | Free plan | The 300-order tea-house rush | What it means |
|---|---|---|---|
| Durable Object rows written | 100,000 | 9,004 (measured, indexes included) | About 800 orders a day, each handled from order to served. **This is the limit a busy shop meets first.** Past it, writes fail until midnight UTC. |
| Durable Object rows read | 5 million | 8,769 | Not a concern. |
| Requests (Worker and object each) | 100,000 | 607 | Static screens are free and don't count. Live streams and their reconnects do. |
| Object duration | 13,000 GB-s, per account | n/a | An open live stream keeps the object awake: 24 hours is 10,800 GB-s, which is most of an account's day. |
| Storage | 1 GB per object | 2.6 KB an order (782 KB for the rush) | About 3.5 years at 300 orders a day, 1.3 years at 800. |
| CPU per request | 10 ms | a sign-in is about 3 ms | Why PINs are hashed with PBKDF2 (D-038). |
| Owner's Today tab | within the 5 million reads | 2,095 reads a report | Kept until an order changes or the day turns, shared by every tab, and polled every 5 minutes while the tab is visible: an idle tab costs a couple of rows per poll, and a busy day recomputes from two days of orders, never the history (D-044). |

The daily limits belong to the **account**, summed over every Worker on it. Put the public demo, which anyone can click, on its own Cloudflare account, so it can't spend your shop's day.

If a shop outgrows it, the Workers Paid plan (US$5 a month) lifts these with no change to ibow.

### Backups and export

The data is in the Durable Object's SQLite storage. Two safety nets:

- **Export.** Signed in as the owner at `/owner`, open `/api/owner/export` in the same browser: it downloads the last 7
  days of orders, lines, payments and reviews, and the staff names (no PIN hashes, no sessions), as one JSON file.
  Ask for other days with `?from=2026-11-01&to=2026-11-30` (at most 31 days a request; page through a longer span).
  It is not an importer; use it as a ledger. Do it weekly if the shop's books depend on it.
- **Point-in-time recovery.** Cloudflare keeps 30 days of history for a SQLite-backed Durable Object and can restore
  the whole database to a moment in it, but only through code running inside the object
  ([the storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/): `getBookmarkForTime`, then
  `onNextSessionRestoreBookmark`), and not in local development. ibow does not expose this to anyone, on purpose. If
  you ever need it, a developer adds a one-off route that calls it, deploys, restores, and removes the route.

Customer names are cleared after `retentionDays` by an hourly job in the object, which overwrites each with spaces
and then clears it. Cloudflare's storage doesn't let ibow run `secure_delete` or compact the file, and its earlier
log frames may still hold the old name for as long as Cloudflare keeps that log (its recovery window is 30 days; no
guarantee is made either way). Unlike a Node install (D-016), you can't promise a customer that the bytes are gone. If
that matters for the business, use part B.

### Upgrades

```sh
git pull && npm ci && npx wrangler deploy
```

The database is migrated forward automatically when the object starts. `npx wrangler rollback` returns the code to an
earlier version but not the database to an earlier schema: export first, and upgrade outside the rush. Open screens
reconnect and catch up on what they missed.

### The AI business analyst on Cloudflare

See [below](#the-ai-business-analyst-optional); on Cloudflare the model has to be a hosted provider reachable from the
internet (a model on the shop's laptop can't be reached). Set `AI_BASE_URL` and `AI_MODEL` as vars and the key with
`npx wrangler secret put AI_API_KEY`.

## B. Plain Node on a VPS

### Settings

Settings live in `.env` beside the code (it's never committed):

```sh
cp .env.example .env
npm run hash-pin       # type the owner's PIN; paste the hash into .env as OWNER_PIN_HASH=...
```

`CONFIG_DIR` is the folder with the three files (`./config`), `DATA_DIR` where `ibow.db` is kept (`./data`), `HOST` and
`PORT` are `127.0.0.1` and `3000` behind a proxy on the same machine, and `TRUST_PROXY` is `1` when Caddy or nginx is in
front (so ibow sees real client addresses and marks cookies `Secure`; leave `0` with no proxy, or clients could fake
their address). The other settings are in the table in step 3.

To check it works before you set up a service, run `npm start` in the ibow folder (it builds the client, then listens on
http://127.0.0.1:3000) and stop it with Ctrl+C.

### Run it with Node and systemd

As root on the VPS (Ubuntu 24.04 assumed):

```sh
# Node 24 from NodeSource, and a user that owns nothing but ibow's data
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs git
useradd --system --home /var/lib/ibow --create-home ibow

git clone https://github.com/YoByron/ibow /opt/ibow && cd /opt/ibow
npm ci && npm run build && npm prune --omit=dev     # the build tools are needed only to bundle the client
cp -r /path/to/your/config /etc/ibow-config     # the three files from step 2
cp .env.example /etc/ibow.env && chmod 640 /etc/ibow.env && chgrp ibow /etc/ibow.env
```

In `/etc/ibow.env` set `OWNER_PIN_HASH` (step 3), `CONFIG_DIR=/etc/ibow-config`, `DATA_DIR=/var/lib/ibow`,
`HOST=127.0.0.1`, `TRUST_PROXY=1` and, for UPI, `UPI_VPA`. Then save this as `/etc/systemd/system/ibow.service`:

```ini
[Unit]
Description=ibow
After=network-online.target
Wants=network-online.target

[Service]
User=ibow
Group=ibow
WorkingDirectory=/opt/ibow
# node reads the env file itself, so the "$" signs in the PIN hash stay as written
ExecStart=/usr/bin/node --env-file=/etc/ibow.env --disable-warning=ExperimentalWarning src/server/main.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/ibow

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now ibow
journalctl -u ibow -f            # "listening on 127.0.0.1 port 3000"
```

### HTTPS in front (Caddy)

Point the domain's DNS (an `A` record such as `order.yourbusiness.com`) at the VPS, then install Caddy, which fetches
and renews the certificate by itself:

```sh
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
order.yourbusiness.com {
	reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl reload caddy
```

Caddy streams the live updates (server-sent events) without extra settings. Set `TRUST_PROXY=1` in `/etc/ibow.env` and
restart ibow. Open only ports 22, 80 and 443 (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`).

**nginx instead of Caddy:** get a certificate with certbot, and in the `location /` block use
`proxy_pass http://127.0.0.1:3000;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
`proxy_set_header X-Forwarded-Proto $scheme;`, `proxy_http_version 1.1;`, `proxy_buffering off;` and
`proxy_read_timeout 1h;`, or the live updates stall.

**Logs:** a customer's live order stream carries its order key in the URL (`?key=`). Caddy keeps no access log unless
you add one; if you do, or use nginx's, keep it private and short-lived.

### Backups

Everything the business has (orders, staff, reviews, switches) is in one SQLite file, `ibow.db`. `npm run backup`
writes a consistent copy while ibow keeps serving (never copy the live file by hand: recent changes may still be in its
`-wal` file). Daily at 03:00 with two weeks kept: `crontab -u ibow -e` and add

```cron
0 3 * * * cd /opt/ibow && node --env-file=/etc/ibow.env --disable-warning=ExperimentalWarning scripts/backup.ts /var/lib/ibow/backups/ibow-$(date +\%F).db && find /var/lib/ibow/backups -name 'ibow-*.db' -mtime +14 -delete
```

Copy backups off the machine too (to your laptop or object storage): a backup on the same disk doesn't survive the
disk. A backup holds customer names given in the last `retentionDays`, so treat it as private.

**Restore:**

```sh
systemctl stop ibow
cp ibow-2026-11-09.db /var/lib/ibow/ibow.db
rm -f /var/lib/ibow/ibow.db-wal /var/lib/ibow/ibow.db-shm
chown ibow:ibow /var/lib/ibow/ibow.db       # the service runs as ibow and must be able to write it
systemctl start ibow
```

### Upgrades

Take a backup first. The database is migrated forward automatically at start-up; there is no going back to an older
version except by restoring a backup taken before the upgrade.

```sh
cd /opt/ibow && git pull && npm ci && npm run build && npm prune --omit=dev && systemctl restart ibow
```

Restarting mid-rush is safe: staff stay signed in, open screens reconnect and catch up on what they missed. A few
seconds is still a few seconds; upgrade outside the rush.

### Phones on a shop's Wi-Fi, with no server at all

For a trial with no VPS, any computer at the shop can serve phones on the same Wi-Fi: set `HOST=0.0.0.0` in `.env`,
run `npm start`, find the computer's address (`ipconfig` on Windows, `ip addr` on Linux, such as `192.168.1.20`),
allow port 3000 through its firewall, and open `http://192.168.1.20:3000/` on the phones. Ordering, payment and the
live token page work over plain HTTP; installing the app, the offline cache and notifications need HTTPS.

## Your own server with Cloudflare Tunnel (pull-based updates)

A third way, for a server you already have (a home server, a VPS) and a domain on Cloudflare: ibow runs as an ordinary
user's services, a **Cloudflare Tunnel** carries traffic to it (the server opens no inbound port and needs no certificate),
and the server **pulls** new versions from the public repository by itself, only when that commit's GitHub checks passed.
No secret is kept in GitHub and nothing is pushed to the server. It is the way to run the public demo once Cloudflare's free
Workers quota is not enough, and works for any number of visitors the box can serve.

What the kit (`deploy/server/`) does, and does not do:

- Everything lives in `~/apps/ibow` and `~/.config/systemd/user`. It never uses `sudo` and never touches other units,
  other ports, other tunnels or the system's Node. It downloads its own pinned Node 24 from nodejs.org and verifies it
  against nodejs.org's published checksums.
- `ibow.service` listens on `127.0.0.1:8790` only, limited to 300 MB of memory and half a CPU.
- `ibow-update.timer` looks for a new commit every 5 minutes, builds it in `releases/<commit>`, smoke-tests it on a spare
  port, switches to it, health-checks `/healthz` and rolls back on failure. The last three releases are kept.
- `ibow-backup.timer` copies the database daily into `~/apps/ibow/backups` and keeps 14.
- It runs the **demo** (the tea-house sample with throwaway PINs and the showcase page). For a real shop use part B above.

You need: Linux x86_64 with systemd, `curl`, `git`, `tar`, `xz` and `flock` (all standard), an ordinary user whose
systemd services keep running after logout (an administrator runs `loginctl enable-linger <user>` once), `cloudflared`
([install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)) and a domain
whose DNS is on Cloudflare.

### One-time setup (as that user, no sudo)

```sh
git clone https://github.com/YoByron/ibow ~/ibow-src
bash ~/ibow-src/deploy/server/install.sh
```

`install.sh` prints what it did. Then check `~/apps/ibow/ibow.env` (the repository address, the port) and build the first
release, which also starts the service:

```sh
~/apps/ibow/bin/update.sh
systemctl --user start ibow-update.timer
curl -s http://127.0.0.1:8790/healthz        # prints: ok
journalctl --user -u ibow -u ibow-update -n 50
```

The first start seeds the demo and prints its throwaway PINs to the journal (and they are shown on the sign-in screens).
The database is kept; a restart or an update never re-seeds it, so the PINs stay the same. The seeded days age: after a few
weeks the owner's "today" is empty. To refresh the demo, stop the service, delete `~/apps/ibow/data` and start it again.

### The tunnel

One tunnel, one config file of its own (`~/.cloudflared/ibow.yml`), one unit. Log in once if this user has not:

```sh
cloudflared tunnel login                                   # opens a browser; pick the domain
cloudflared tunnel create ibow                             # prints the tunnel id (a UUID) and writes ~/.cloudflared/<id>.json
cp ~/ibow-src/deploy/server/cloudflared-ibow.yml.example ~/.cloudflared/ibow.yml
```

Edit `~/.cloudflared/ibow.yml`: your home directory and the tunnel id in `credentials-file` (an absolute path, as `cloudflared tunnel create` printed it), and your hostname.
The ingress sends that one hostname to `http://127.0.0.1:8790` and answers `404` for anything else.

Only now create the DNS record, in this order and with these flags. `cloudflared` also reads a default `~/.cloudflared/config.yml`
if you have one (an older tunnel on the same machine), and without `--config` `route dns` can attach the hostname to **that**
tunnel instead of the new one, even when you name `ibow`. Passing this tunnel's own config and its id avoids it;
`--overwrite-dns` replaces a record that was already created pointing at the wrong tunnel:

```sh
cloudflared --config ~/.cloudflared/ibow.yml tunnel route dns --overwrite-dns <TUNNEL-ID> ibow.example.com
```

**Check the tunnelID in the output.** It prints a line such as `Added CNAME ibow.example.com which will route to this tunnel
tunnelID=<id>`; that id must be the one `tunnel create` printed. If it is another id, run the command again with the right
`<TUNNEL-ID>`. Then:

```sh
bash ~/ibow-src/deploy/server/install.sh        # again: it now finds the config and enables the tunnel unit
systemctl --user enable --now cloudflared-ibow
journalctl --user -u cloudflared-ibow -n 20
curl -s https://ibow.example.com/healthz        # prints: ok
```

`install.sh` is safe to run again: it keeps your `ibow.env` and changes nothing that is already right.

### Day to day

| Task | Command |
|---|---|
| Is it up, which release? | `systemctl --user status ibow`, `readlink ~/apps/ibow/current` |
| Look for an update now | `systemctl --user start ibow-update.service`, then `journalctl --user -u ibow-update -n 30` |
| Pause updates | `systemctl --user stop ibow-update.timer` |
| A backup now | `~/apps/ibow/bin/backup.sh` |
| Restore a backup | stop `ibow`, copy a file from `~/apps/ibow/backups/` over `~/apps/ibow/data/ibow.db`, delete `ibow.db-wal` and `ibow.db-shm` beside it, start `ibow` |
| Remove it all | disable the units (`systemctl --user disable --now ibow ibow-update.timer ibow-backup.timer cloudflared-ibow`), delete the unit files in `~/.config/systemd/user/` and `~/apps/ibow`, and `cloudflared tunnel delete ibow` |

If an update ever fails its smoke test or its health check, the journal says why, the running release stays (or is rolled
back to), and that commit is not tried again; the next commit is. The update only deploys commits whose GitHub checks have
all passed; if GitHub's public API limit is reached it waits for the next run.

## The AI business analyst (optional)

With it on, the owner's Today page gets an "Ask the analyst" box: a question in plain words ("Which hour was busiest
today?", "How much have we received this week?") gets a short answer that cites the dashboard figures it used. The
model is sent the dashboard's anonymous figures and item names only, never a customer name or a review, and every
number in its answer is checked against those figures; an answer with a number that isn't among them says so. Only
the ibow server talks to the model; customers and staff never see the box. It is off until you set two settings.

A free model on the same computer, with [Ollama](https://ollama.com) (plain Node installs and local trials). On a
machine without a graphics card, pick a small model (1 to 4 billion parameters, such as `llama3.2`): a 9-billion one on
a plain CPU took over three minutes to answer "Say OK". Give Ollama a context of at least 8192 tokens, since its default
4096 is tight for the figures ibow sends:

```sh
ollama pull llama3.2           # about 2 GB
OLLAMA_CONTEXT_LENGTH=8192 ollama serve
```

```sh
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.2
AI_TIMEOUT_SECONDS=120         # small machines answer slowly; at most 290
```

`AI_TIMEOUT_SECONDS` stops at 290 because `fetch` gives up after 300 seconds without an answer, whatever the setting; a
model that needs longer needs a smaller model or a GPU. LM Studio and llama.cpp's server work locally like Ollama, at
their own ports.

A hosted provider: any that offers the OpenAI-compatible Chat Completions API, such as OpenAI
(`https://api.openai.com/v1`), Gemini's OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), OpenRouter (`https://openrouter.ai/api/v1`) or Groq
(`https://api.groq.com/openai/v1`); the provider's own docs have the current URL. Set its base URL, a model name it
offers, and your own key in `AI_API_KEY`. Each question is one request billed to your key; the dashboard allows 30
questions an hour per sign-in. The key stays on the server (`.env`, or a Cloudflare secret): it never reaches a browser,
a log or the database, and ibow refuses to send it over plain `http://` to another machine.

Restart ibow (or redeploy) after changing these settings. To turn it off, unset all the `AI_` settings; ibow refuses to
start with only some of them set.

## Troubleshooting

ibow stops at start-up with a message saying what it expected and what it found, and the message is the fix list. The ones
a newcomer meets:

| You see | Cause and fix |
|---|---|
| Every page on Cloudflare answers `503` with "expected the secret OWNER_PIN_HASH" | The secret is not set (or was set on another Worker). `npx wrangler secret put OWNER_PIN_HASH`, paste the hash from `npm run hash-pin`, reload. A secret applies at once; no redeploy. |
| Node: a stack trace ending "expected OWNER_PIN_HASH in the environment or .env, found nothing" (the message is the first line) | `.env` is missing or has no hash. `cp .env.example .env` (Windows PowerShell: `Copy-Item .env.example .env`), run `npm run hash-pin`, paste its output after `OWNER_PIN_HASH=`. Run from the ibow folder: `.env` is read from the current directory. |
| "expected a pbkdf2-sha256 hash, found an older scrypt one", or any complaint that the hash is malformed | The hash is from an older version or was cut in the paste. Make a new one with `npm run hash-pin` and set it again. Paste the whole line; it has `$` signs in it. |
| `wrangler deploy` fails with "Could not resolve ./config/business.json" or "expected a JSON file" | There is no `config/` folder, or a file in it is missing. Step 2. |
| `wrangler deploy` fails naming a file and field, such as `catalog.json: categories[1].items[0].price` | A config file is wrong. The message says what was expected and found; see the table at the end of [configure.md](configure.md). Check any change with `npx wrangler deploy --dry-run`. |
| Node: "expected a database made by this build, found one made by a development build before 2026-11-11; delete it (data/ibow.db)" | An old database from an early development build. If it holds nothing you need, delete `data/ibow.db` (and any `ibow.db-wal` or `ibow.db-shm` beside it) and start again. A new install never meets this. |
| Node: `EADDRINUSE`, or the demo says "port 3000 is in use" | Another program (or an ibow you forgot to stop) has the port. Pick another: `PORT=3001` in `.env`, or for the demo `npm run demo -- --port 3001`. To find the program: Windows `netstat -ano | findstr :3000`, macOS and Linux `lsof -i :3000`. |
| Sign-in on Cloudflare fails and `npx wrangler tail` shows a CPU time limit error | The free plan allows 10 ms of CPU per request and a sign-in hashes the PIN (about 3 ms measured). Try again once. If it keeps failing, lower `PIN_ITERATIONS` in `src/server/auth.ts` (decision D-038), run `npm run hash-pin` again, set the new hash and the staff PINs again, and redeploy. Or use the Workers Paid plan (US$5 a month), whose limit is far higher. |
| `wrangler` says "Authentication error" or you are not logged in | `npx wrangler whoami`; sign in again with `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. |
| `npm ci` ends with "vulnerabilities" and `npm audit` lists `sharp`, `miniflare` or `undici` | These are inside development tools (wrangler's local simulator), not in what runs for your customers. Don't run `npm audit fix --force`: it would downgrade the tools and break the build. |
| `npm ci` fails with "Unsupported engine" | Node is older than 24. Install the current Node (step 0) and open a new terminal. |
| "UPI_VPA is set, but UPI takes INR only" | `UPI_VPA` is set for a business whose `currency` is not INR. Unset it. |
| "AI settings found but no AI_BASE_URL" | Any lone `AI_` setting stops the start. Set `AI_BASE_URL` and `AI_MODEL` together, or unset every `AI_` setting. |

If the analyst answers with an error, it names the cause: the model server can't be reached, it didn't answer in time
(raise `AI_TIMEOUT_SECONDS`), or it refused the request (its own message follows, such as a wrong key or model name). On
Cloudflare the same start-up messages come back as a `503` from every request and appear in `npx wrangler tail`. Fix what
the message names and start or deploy again.

Still stuck? The design is in [architecture.md](architecture.md). Paid setup help is described in the
[README](../README.md#consultancy-and-support).
