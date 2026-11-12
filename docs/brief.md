# ibow: brief

## Vision
**ibow (Intelligent Business Orchestration and Workflows)** is free, full-stack, AI-enabled orchestration for any
business, anywhere. Running operations (taking orders, moving work between people, handling money, knowing the numbers)
is as old as business itself, and the tools that do it well are paid, closed and built for big operators. ibow does it
in the open:
- **Front:** a storefront the customer opens on their own phone, plus screen ordering (a counter screen or kiosk).
- **Back:** work routed to staff stations as batched, spoken lists; payments; the owner's dashboard.
- **Brain:** an AI manager and business analyst beside the owner, built on rule-based insights and opt-in AI with no
  vendor lock-in (D-003).

Workflows are config, so a counter, a clinic queue or a service desk is a new workflow, not a new product. Food
counters come first because they're proven live. ibow is also the owner's public portfolio for workflow-design
consulting worldwide (D-008).

## Problem (first workflow)
A busy counter anywhere (a chai or coffee stall, a food truck, a juice bar, a campus canteen) gets hundreds of orders in a short rush,
for example 300 orders in two hours. Orders are shouted, the money gets confused, tea and kitchen staff work from
memory, and customers crowd the counter asking "is mine ready?". POS and kitchen-display products assume
trained staff, bought hardware and a sit-down restaurant pace. QR-menu apps stop at "order placed".

**Evidence (first-hand):** the owner designed and built an earlier counter app and ran it live at a real tea-and-snack
shop from December 2025: 78 items in 14 categories, two prep stations, a counter and an owner dashboard. ibow's first
workflow is that app's workflow. The real shop is never named in this repo (we don't own its brand); its menu shape
survives only as the fictional sample `samples/tea-house`. The owner's method is to watch the real friction
first, then remove steps rather than add a system.

**Landscape (checked 2026-11-07):** open-source restaurant tools are either a full POS (Odoo, TastyIgniter 3.8k★,
NexoPOS 1.3k★, URY 411★) or a QR menu (about 3,900 new repos in a year, almost none used). The closest projects,
nodedr-restaurant-pos (289★) and TavoloFlow (4★), are table-service POS/KDS systems. None is UPI-first, none batches
prep by station, and none speaks to staff.

## Wedge
The customer's phone is the front desk. The counter only takes money and calls tokens. Each prep station gets one
batched, spoken prep list instead of a pile of tickets.
- No hardware and no training: works on the shop's existing cheap phones and the customers' own phones.
- Station-routed batch prep: "12 chai M, 3 coffee" across all open orders, read out loud, with a replay button.
- Local payments first: UPI (India) ships first as a static intent/QR with the amount and token filled in, so there is
  no gateway, no KYC and no fee. Payment methods are adapters, so other countries' methods plug in later.
- Tokens that survive a rush: `DD-NNN`, unique per day, never duplicated across devices.
- Self-hosted and AGPL-3.0: a shop, or the freelancer who serves it, owns the install and the data.

## v1
The proven counter workflow, rebuilt so any business can run it from config alone. These are the owner's steps, as the
live app runs them:

1. **Customer orders.** Scans the QR at the counter, browses the menu (categories, search, size variants such as S/M/L,
   unavailable items hidden), builds a cart, and optionally enters a name.
2. **Customer pays.** Picks UPI (the QR/intent shows the amount, with the token in the note), or pay at the counter.
   UPI payment is marked "customer says paid" until staff confirm it.
3. **Customer gets a token.** `DD-NNN` (day of month plus that day's sequence, for example `26-001`), on a token page
   that stays live: pending → preparing → ready, with sound, vibration and a notification on each change. The
   customer can edit the order for 2 minutes while it is still pending, and can look up a token later.
4. **Counter (staff phone).** Sees new orders with a sound alert. Takes walk-in orders through a quick-order panel,
   with cash shortcuts ₹5/10/20/30/40/50 or a UPI QR for the exact amount. Confirms payment, moves an order to
   preparing, adds items to an existing order, marks items served one by one, calls a token out loud, and can undo a
   status change within 5 minutes.
5. **Prep stations.** Each station (in the tea-house sample: the tea/coffee station and the kitchen) sees only its own
   items, totalled across open orders and spoken as one batch with replay. The kitchen prints an 80mm KOT and marks
   tickets ready.
6. **Owner.** PIN-locked dashboard: the order tabs (pending/preparing/completed), item availability on/off, settings,
   and today's numbers (hourly chart, peak hour, popular items, comparison with yesterday), plus repeat-customer
   badges and customer reviews.

**Done when:** a fresh install, set up with only a menu file and a stations file (no code changes), runs steps 1–6
end to end on phones. A recorded 300-order, two-hour rush replays through it with every token unique, every item
reaching exactly one station, and every status change reaching the customer's page.

### Open questions for the owner
- Real numbers from the live pilot shop (unnamed): peak orders per hour, staff count, how long it ran, and what changed
  for the staff. These go in the README as an anonymous case study.
- Settled 2026-11-08: one business per install in v1. Multiple outlets come later.

## Later (not v1)
- **Business analyst, staged** (D-003): rule-based daily and weekly insights first (peaks, item trends, a prep forecast
  for tomorrow's rush), then an opt-in AI analyst that answers the owner's questions over the same data, using the
  owner's own model key.
- Multiple outlets per install; WhatsApp order alerts; a simple GST bill; regional languages (Hindi first); offline
  counter mode; a one-command installer for a cheap VPS.
- Other queue verticals on the same token core (clinic queue, donations), only after food counters adopt it.

## Not
- Not a full POS, accounting or inventory system. Integrate with those; don't become one.
- Not a payment gateway. Never claim money arrived unless a person (or, later, a gateway) confirmed it.
- Not a delivery or marketplace app, and never a customer account system: name optional, phone never required.
