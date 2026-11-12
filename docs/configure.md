# Configure ibow for your business

ibow knows nothing about a business except what its config files say. You never edit code. This page is the complete
reference to those files and to the settings (environment variables and secrets), then a worked example that turns a
sample into your own café in about 15 minutes.

Setting up a whole install (Cloudflare account, domain, backups) is in [install.md](install.md). This page is about
what goes in the files.

## The config folder

The `config/` folder in the ibow folder holds your business. A fresh clone has the `tea-house` sample in it, so ibow runs
before you change anything; edit those files. Three are required and the rest optional:

| File | Required | What it describes |
|---|---|---|
| `business.json` | yes | Who the business is: name, currency, time zone, hours, cash buttons, how long names are kept |
| `catalog.json` | yes | What it sells: categories, items, sizes, prices, photos, icons |
| `stations.json` | yes | Where the work happens and which categories go to which station |
| `theme.json` | no | The look: colours, typeface, corners, header, logo, icons, feature switches |
| `strings.<locale>.json` | no | Your own wording for the customer screens, per language (`strings.hi.json`) |
| image files | no | Photos and logos that the files above name (`png`, `jpg`, `jpeg`, `webp`, `svg`) |

To start from another sample, copy its files over the ones in `config/` (macOS, Linux and Git Bash:
`cp samples/coffee-cart/* config/`; PowerShell: `Copy-Item samples\coffee-cart\* config\`) and delete `rush.json` (empty `config/` first if you had your own files there). The
[worked example](#worked-example-your-own-cafe-in-15-minutes) edits the starter instead. The five samples in `samples/` are `tea-house`, `coffee-cart`, `food-truck`, `bakery` and
`service-desk`; `coffee-cart` and `service-desk` also show a `theme.json`, and `service-desk` a `strings.en.json` and a
logo.

Rules that apply to every file:

- Plain JSON: double quotes, no comments, no trailing commas. A JSON checker (or your editor) will catch slips.
- `business.json` and `theme.json` refuse a field they don't know, naming it (`business.json: showCase: expected one of name, currency, ..., found an unknown field`), so a typo can't silently do nothing.
- A wrong file is refused loudly. The server will not start (on Cloudflare, `wrangler deploy` fails) and the message names
  the file, the field, what was expected and what was found, such as
  `catalog.json: categories[0].items[2].price: expected a price in integer minor units (such as cents) greater than 0, found number 4.5`.
- An `id` is lowercase letters, digits and dashes, starting with a letter or digit: `masala-chai`, not `Masala Chai`.
  Ids are how files refer to each other and how the owner's switches and reports remember things, so don't rename one
  after you have orders.
- Edits take effect at the next start (Node) or the next `npx wrangler deploy` (Cloudflare).

### Money is in minor units

Every price is a whole number of the currency's smallest unit: cents, paise, fils. `9000` is 90.00 in INR, `350` is
3.50 in USD or EUR. The exception is `cashShortcuts` below, which is written in whole notes and coins. For a currency
with no minor unit (JPY) the price is in whole yen.

## business.json

```json
{
  "name": "The Tea House",
  "currency": "INR",
  "timeZone": "Asia/Kolkata",
  "cashShortcuts": [5, 10, 20, 50],
  "hours": { "open": "07:00", "close": "22:00" },
  "retentionDays": 30,
  "maxQtyPerLine": 99,
  "showcase": false,
  "phone": "+91 00000 00000",
  "address": "Example Street, Example City"
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The business's name: the header, the installed app's name, the UPI payee name unless `UPI_PAYEE_NAME` is set. |
| `currency` | yes | An ISO 4217 code: `INR`, `USD`, `EUR`, `AED`, `GBP`... No default. Every price and payment is in its minor unit. |
| `timeZone` | yes | An IANA zone: `Asia/Kolkata`, `America/New_York`, `Europe/Lisbon`... No default. The business's "day" (token numbers restart each day, reports start and end at midnight) follows it, not the server's clock. |
| `cashShortcuts` | no | The cash notes the counter offers as one-tap "received" buttons, in whole units of the currency, such as `[5, 10, 20, 50]`. At least one entry, each above 0, with no more decimals than the currency has. Left out, the counter works the buttons out from the amount due. |
| `hours` | no | `{"open": "07:00", "close": "22:00"}`, 24-hour `HH:MM`, in the business's time zone. A close earlier than the open means past midnight (`18:00` to `02:00`). The storefront then says "Open now" or "Closed". It is a label only: it does not stop anyone ordering. Without `hours` the storefront says nothing about it. |
| `retentionDays` | no | Whole days, 1 to 3650, default 30. Customer names and review text are cleared after this many days. Phone numbers are never collected. |
| `maxQtyPerLine` | no | Most units of one item in one order line, 1 to 10000, default 99. |
| `showcase` | no | `true` serves ibow's own showcase page at `/showcase` (a marketing page about ibow, with the author's consultancy contact). Default `false`: a real shop's customers see a 404 there. The public demo always serves it. |
| `phone`, `address` | no | Free text. They are checked and kept with the business but no screen shows them today. |

## catalog.json

```json
{
  "categories": [
    {
      "id": "hot-drinks",
      "name": "Hot drinks",
      "icon": "hot_beverage",
      "items": [
        {
          "id": "flat-white",
          "name": "Flat white",
          "description": "Double shot, steamed milk.",
          "icon": "hot_beverage",
          "diet": "veg",
          "tags": ["bestseller"],
          "variants": [
            { "size": "Regular", "price": 350 },
            { "size": "Large", "price": 420 }
          ]
        },
        { "id": "espresso", "name": "Espresso", "price": 250, "image": "espresso.jpg" }
      ]
    }
  ]
}
```

**Category** (the top-level `categories` array must have at least one):

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across categories. `stations.json` refers to it. |
| `name` | yes | The chip and heading customers see. |
| `icon` | no | A name from the [bundled icons](#bundled-icons), shown on the category's chip and heading and as the default tile for its items. |
| `items` | yes | An array of items (it may be empty, but then the category shows nothing). |

**Item:**

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across the **whole** catalog, not just the category. |
| `name` | yes | What customers and staff read, and what stations call out. |
| `price` | one of | Integer minor units, above 0. An item has **either** `price` **or** `variants`, never both and never neither. |
| `variants` | one of | A non-empty array of `{"size": "Large", "price": 420}`. Each `size` is unique within the item. The customer picks one in a sheet. |
| `description` | no | A sentence under the name. Shown only when present. |
| `icon` | no | A [bundled icon](#bundled-icons) for the item's tile. Without one the tile shows its category's icon. |
| `image` | no | A photo: a file in the config folder (`espresso.jpg`) or an `https://` URL. Without one the storefront draws a tile. |
| `diet` | no | `"veg"`, `"non-veg"` or `"egg"`. Shown as a marker on the card while the theme's `veg` switch is on. |
| `tags` | no | An array of words. Only the first is shown, as a badge on the card (`"bestseller"` and `"popular"` use the built-in wording, anything else is shown as written). See `features.tags` under [theme.json](#themejson). |
| `available` | no | Defaults to `true`. `false` hides the item from ordering. The owner can also switch items on and off from the dashboard, which overrides this without a redeploy. |

Images: a file name has only letters, digits, dots, dashes and underscores, ends in `.png`, `.jpg`, `.jpeg`, `.webp` or
`.svg`, and sits directly in the config folder (no sub-folders). Each file is capped at 2 MB; use small, compressed photos
(a few hundred pixels across is plenty for a tile). An `https://` URL is allowed too, and the host joins the page's
content security policy automatically. A file that the config names but is missing stops the start with the file name.

### Bundled icons

`icon` fields (and `logo` and `categoryIcons` in the theme) take one of these names, the 3D Fluent set that ships with
ibow:

```text
bank, bar_chart, bell, bento_box, beverage_box, bubble_tea, chart_increasing, check_mark_button, cheese_wedge,
chequered_flag, clipboard, cocktail_glass, cooking, counterclockwise_arrows_button, credit_card, crescent_moon,
croissant, cup_with_straw, dollar_banknote, dumpling, ear_of_corn, face_savoring_food, fire, fork_and_knife_with_plate,
french_fries, hamburger, honey_pot, hot_beverage, hot_pepper, hourglass_not_done, ice, leaf_fluttering_in_wind, lemon,
locked, magnifying_glass_tilted_left, megaphone, mobile_phone, money_bag, party_popper, peach, pot_of_food, receipt,
sandwich, shopping_cart, spaghetti, sparkles, speaker_high_volume, star, steaming_bowl, stopwatch, takeout_box,
teacup_without_handle, teapot, thinking_face, ticket, tropical_drink, watermelon, wrapped_gift
```

(The list lives in `ICONS` in `src/core/theme.ts`.) For anything else, use your own `image`.

## stations.json

A station is a place where work happens: a tea counter, a grill, a workshop bench. This file is an array (not an object)
with at least one station:

```json
[
  { "id": "bar", "name": "Coffee bar", "categories": ["hot-drinks"], "speak": true, "print": null },
  { "id": "kitchen", "name": "Kitchen", "categories": ["pastries", "toasties"], "speak": true, "print": "ticket-80mm" }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique station id. |
| `name` | yes | Shown on the staff screen. |
| `categories` | yes | A non-empty array of category ids from `catalog.json`. **Every category must be on exactly one station**: a category on two stations, on none, or not in the catalog is refused. |
| `speak` | yes | `true` or `false`. Whether the station screen reads new work aloud (the phone's own voice, in the browser). |
| `print` | yes | `"ticket-80mm"` to offer an 80 mm ticket printed from the browser, or `null` for none. Write `null` explicitly. |
| `view` | no | `"batch"` (the default): open items are totalled across orders and read out as one list ("12 Masala Chai M, 3 Hot Coffee"). `"jobs"`: one card per order, for work that belongs to one customer, such as a repair. |

`speak` and `print` are required even when you want them off (`false` and `null`); only `view` has a default.

## theme.json

Optional. Everything missing takes the default (the forest-green awning, sun-yellow accent, Inter). A typo is refused
rather than ignored: an unknown field is an error naming it. Here is every field with its default:

```json
{
  "colors": {
    "primary": "#2d5a27",
    "accent": "#f5c518",
    "header": "#1e3d1a",
    "light": { "surface": "#f5f5f5", "text": "#151a14" },
    "dark": { "surface": "#121512", "text": "#f4f6f2" }
  },
  "font": "inter",
  "radius": "round",
  "density": "comfortable",
  "header": { "style": "awning", "awning": ["#a8d24e", "#ffffff"] },
  "logo": "hot_beverage",
  "categoryIcons": { "hot-drinks": "teapot" },
  "features": {
    "favourites": true,
    "recent": true,
    "tags": "auto",
    "veg": true,
    "darkToggle": true,
    "cartEta": true
  }
}
```

(`logo` and `categoryIcons` have no default: with neither, the header shows no logo and categories use their own `icon`.)

| Field | Values | Meaning |
|---|---|---|
| `colors.primary` | hex `#rgb` or `#rrggbb` | Buttons, steppers, links. |
| `colors.accent` | hex | The highlight colour (sun yellow by default). |
| `colors.header` | hex | The header background (it blends toward `primary`). |
| `colors.light.surface`, `colors.light.text` | hex | Page background and text colour in light mode. |
| `colors.dark.surface`, `colors.dark.text` | hex | The same in dark mode (phones that prefer dark, or the customer's toggle). |
| `font` | `inter`, `lora`, `nunito`, `space-grotesk`, `system` | The typeface. The first four ship with ibow (nothing is fetched from another site); `system` uses the device's own. |
| `radius` | `sharp`, `soft`, `round` | How rounded buttons, cards and sheets are. |
| `density` | `comfortable`, `compact` | Spacing and control height. |
| `header.style` | `awning`, `plain`, `image` | The scalloped awning, a flat header, or a photo header. `image` requires `header.image`. |
| `header.awning` | two hex colours | The stripe colours of the awning, for example `["#a8d24e", "#ffffff"]`. |
| `header.image` | image file name or `https://` URL | The header photo (used with `"style": "image"`). |
| `logo` | an icon name, an image file name or an `https://` URL | Shown in the header. |
| `categoryIcons` | `{"<category id>": <same as logo>}` | Overrides one category's icon with another icon or an image. |
| `features.favourites` | `true` / `false` | The star on items and the Favourites section. |
| `features.recent` | `true` / `false` | "Order again" from the customer's recent orders on their own phone. |
| `features.tags` | `off`, `catalog`, `auto` | Item badges: none; only the first word of an item's own `tags`; or `auto`, where the top sellers of the last seven days are tagged Bestseller or Popular and an item's own `tags` fill in the rest. |
| `features.veg` | `true` / `false` | The veg / non-veg marker from each item's `diet`. Turn it off for a business where it makes no sense. |
| `features.darkToggle` | `true` / `false` | The dark-mode button in the header. |
| `features.cartEta` | `true` / `false` | A "Usually ready in about N min" line in the cart and on the token. |

Colours are checked for readability. The owner's **Appearance** screen (`/owner`, then Appearance) shows the same
settings with a live phone preview and warns when text on the page, or buttons on the cards, would be hard to read
(WCAG AA). Whatever the owner saves there sits on top of `theme.json` for the colours, font, radius, density, header
style and awning, logo and the feature switches; the images always come from the files. The owner can reset it to
`theme.json` at any time.

## strings.\<locale\>.json

Optional. Replaces the wording of the **customer** screens (storefront, cart, token page), one language per file. The
staff screens and owner dashboard are English only for now.

The file is named for the language: `strings.hi.json` is used for browsers set to `hi` or any `hi-…` such as `hi-IN`
(an exact match such as `strings.pt-BR.json` wins over `strings.pt.json`). Other browsers get the English default.
`strings.en.json` is a way to reword the English text, as the `service-desk` sample does.

```json
{
  "yourOrder": "Your request",
  "placeOrder": "Submit request",
  "itemsCount": "{n} items",
  "itemsCount_one": "{n} item"
}
```

- Keys are the names in the `LABELS` table in `src/core/labels.ts`, which also holds every English default. An unknown
  key is refused, and a value must be non-empty text.
- A value must keep the `{placeholders}` of the default it replaces (`"Token {token}"` stays `"Token {token}"`-shaped).
  Only the keys you list are replaced.
- Words that count something have plural forms: `itemsCount` (general), `itemsCount_one` (singular), and for other
  languages `_zero`, `_two`, `_few` and `_many`. A form may leave the count out.
- Money is never written into a string: amounts arrive already formatted for the currency.

## Settings: environment variables and secrets

Settings are values a business owner must not put in a file anyone can read, or that depend on the machine. On plain Node
they live in `.env` (copy `.env.example`; it is never committed) or in the shell. On Cloudflare a secret is set with
`npx wrangler secret put NAME` and a plain value with a line under `[vars]` in `wrangler.toml`.

| Name | Where | Default | What it does |
|---|---|---|---|
| `OWNER_PIN_HASH` | Node, Cloudflare (secret) | none, **required** | The hash of the owner's PIN, made by `npm run hash-pin`. Without it ibow does not start (Node) or answers every request `503` (Cloudflare). To change the PIN, make a new hash and set it again. |
| `UPI_VPA` | both | unset | The shop's UPI ID, such as `yourbusiness@upi`, for INR businesses only (any other currency with it set is refused). Unset: customers can only pay at the counter. ibow never marks a payment received by itself; staff confirm each one. |
| `UPI_PAYEE_NAME` | both | the business `name` | The payee name shown in the customer's UPI app. Not secret, so a `[vars]` line is fine. |
| `AI_BASE_URL` | both | unset | The base address of an OpenAI-compatible Chat Completions API, such as `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1` (Ollama). With `AI_MODEL`, turns the owner's AI analyst on. |
| `AI_MODEL` | both | unset | The model name that provider offers. |
| `AI_API_KEY` | both (secret on Cloudflare) | unset | Your key for that provider; a local model needs none. Never sent to a browser or logged. |
| `AI_TIMEOUT_SECONDS` | both | 30 | Seconds to wait for an answer, 1 to 290. A small local model needs more. |
| `AI_ADAPTER` | both | `chat-completions` | Which adapter speaks to the model. There is one today; leave it unset. |
| `CONFIG_DIR` | Node only | `./config` | The folder with the config files. On Cloudflare the folder is always `config/` at deploy time. |
| `DATA_DIR` | Node only (and `npm run backup`) | `./data` | Where the SQLite file `ibow.db` is kept. Created if missing. |
| `HOST` | Node only | `127.0.0.1` | The address to listen on. `127.0.0.1` is this machine only; `0.0.0.0` lets phones on the same Wi-Fi (or a proxy on another machine) reach it. |
| `PORT` | Node only | `3000` | The port, 1 to 65535. |
| `TRUST_PROXY` | Node only | `0` | The number of proxies (Caddy, nginx, a load balancer) in front of ibow, 0 to 10. Set it only when every request really passes through them, or a client could fake its address; it also marks cookies `Secure`. |

Rule of thumb for the AI settings: set **all** of the ones you need, or none. Any `AI_` setting on its own stops the start
and says which is missing. The public Cloudflare demo ignores them.

Two more names exist and are not for businesses: `IBOW_DEMO_PINS` and `IBOW_DEMO_NOW` are read only on a demo database
(`npm run demo` sets them) and are ignored by a real install.

## Staff, PINs and roles

- **The owner** has one PIN, 4 to 12 digits. It is stored nowhere, only its hash in `OWNER_PIN_HASH`. The owner signs in at
  `/owner` and can do everything.
- **Staff** are made by the owner, not in a file: sign in at `/owner`, open the **Staff** tab, and add a person with an
  ID (lowercase letters, digits and dashes, up to 40 characters, not `owner`), a name, a PIN (4 to 12 digits) and a role.
  They sign in at `/staff` with the ID and PIN.
- **Roles:** `counter` takes orders and payments, calls tokens and serves; `station` sees the station screens only and
  cannot touch payments; `all` (the default) does both. Saving a new PIN or role signs that person out at once.
- Nothing else has a password. Customers have no account.

Pick PINs that staff can remember and that aren't their birthdays; four digits is short, so give a PIN only to people you
trust, and change it when someone leaves.

## Worked example: your own café in 15 minutes

We turn the `tea-house` sample into "Mill Lane Café" in Lisbon: euros, a coffee bar and a kitchen, a brown-and-cream look.
Allow 15 minutes. You need ibow installed (`npm ci` done), as in the [README](../README.md).

**1. Open the starter (1 minute).** The `config/` folder is already in the ibow folder, holding the `tea-house` sample.
There is nothing to copy: open `business.json`, `catalog.json` and `stations.json` in any editor (VS Code, Notepad) and
replace each one, as below.

**2. Make it yours: `config/business.json` (2 minutes).** Replace the whole file. Note that prices are now in euro cents.

```json config/business.json
{
  "name": "Mill Lane Café",
  "currency": "EUR",
  "timeZone": "Europe/Lisbon",
  "cashShortcuts": [5, 10, 20],
  "hours": { "open": "08:00", "close": "18:00" }
}
```

**3. Write your menu: `config/catalog.json` (5 minutes).** The sample's 78 items are far more than you need. Replace the
file with your own menu, small to start; add more later by copying an item. Every category you add here needs a home in
the next step.

```json config/catalog.json
{
  "categories": [
    {
      "id": "coffee",
      "name": "Coffee",
      "icon": "hot_beverage",
      "items": [
        { "id": "espresso", "name": "Espresso", "price": 120, "diet": "veg" },
        {
          "id": "flat-white",
          "name": "Flat white",
          "description": "Double shot, steamed milk.",
          "diet": "veg",
          "tags": ["bestseller"],
          "variants": [
            { "size": "Regular", "price": 260 },
            { "size": "Large", "price": 320 }
          ]
        }
      ]
    },
    {
      "id": "pastries",
      "name": "Pastries",
      "icon": "croissant",
      "items": [
        { "id": "pastel-de-nata", "name": "Pastel de nata", "price": 150, "icon": "honey_pot", "diet": "egg" },
        { "id": "croissant", "name": "Butter croissant", "price": 180, "diet": "veg" }
      ]
    }
  ]
}
```

**4. Say who makes what: `config/stations.json` (1 minute).** Every category above goes on exactly one station.

```json config/stations.json
[
  { "id": "bar", "name": "Coffee bar", "categories": ["coffee"], "speak": true, "print": null },
  { "id": "counter-display", "name": "Pastry display", "categories": ["pastries"], "speak": false, "print": null }
]
```

**5. Give it a look: `config/theme.json` (2 minutes).** Optional, and the owner can change all of it later from the
Appearance screen.

```json config/theme.json
{
  "colors": {
    "primary": "#7a4a2a",
    "accent": "#e8b04a",
    "header": "#3b2314",
    "light": { "surface": "#f6efe6", "text": "#2a1a10" },
    "dark": { "surface": "#171009", "text": "#f3e9de" }
  },
  "font": "lora",
  "radius": "soft",
  "header": { "style": "plain" },
  "logo": "hot_beverage",
  "features": { "veg": false, "cartEta": false }
}
```

**6. Run it and look (3 minutes).** The owner PIN hash and the settings go in `.env`:

```sh
cp .env.example .env
npm run hash-pin
```

Type a PIN of 4 to 12 digits; copy the line it prints into `.env` as `OWNER_PIN_HASH=` (everything after the equals
sign, as printed). Then:

```sh
npm start
```

Open `http://127.0.0.1:3000/` for the storefront, `/owner` to sign in with your PIN, add a staff member in the Staff tab,
then `/staff` to sign in as them. If a file is wrong, the message names it and the field; fix the file and run `npm start`
again. To see the screens full of orders first, run `npm run demo` against a sample instead (the demo ignores `config/`).

**7. Go live.** Deploy to Cloudflare or a small server with [install.md](install.md). Add photos last: put
`flat-white.jpg` in `config/`, then add `"image": "flat-white.jpg"` to the item.

## When a file is refused

| Message begins | Fix |
|---|---|
| `business.json: currency: expected an ISO 4217 currency code` | Use a three-letter code in capitals, such as `EUR`. |
| `business.json: timeZone: expected an IANA time zone` | Use a name from the [tz list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), such as `Europe/Lisbon`; not `GMT+1` or `PST`. |
| `catalog.json: ...: expected exactly one of price or variants` | An item needs a `price` or a `variants` list, not both and not neither. |
| `catalog.json: ...price: expected a price in integer minor units` | Prices are whole numbers of cents: `350`, not `3.50`. |
| `stations.json: ...: expected a station for every catalog category` | A category isn't on any station; add it to one. |
| `stations.json: ...: expected a category no other station prepares` | A category is on two stations; keep it on one. |
| `theme.json: ...: expected one of ..., found an unknown field` | A misspelt field; compare with the table above. |
| `config folder: <file>: expected an image file in ...` | The config names an image that isn't in the folder, or is over 2 MB. |
