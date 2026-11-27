# Changelog

All notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com).

## 0.1.0, unreleased

The first public version. The rebuilt app has not yet had its pilot rush; the workflow comes from an earlier counter app that ran live at a shop.

- **Foundation (M0).** Business-neutral core vocabulary and five invented sample businesses (a tea house, a coffee cart,
  a food truck, a bakery, a service desk) in different currencies and time zones; AGPL-3.0 licence.
- **Core rules (M1).** Config validation with clear errors, routing of every category to exactly one station, orders as a
  state machine with a 5-minute undo and a 2-minute customer edit window, money in integer minor units of an ISO 4217
  currency, and `DD-NNN` tokens per business day in the business's own time zone.
- **Server and store (M2).** SQLite behind one module with migrations, a JSON API, live updates by server-sent events with
  replay, PIN sign-in with hashed PINs and sessions.
- **Customer flow (M3).** A storefront on the customer's own phone with no account: browse, order, pay by UPI QR for the
  exact amount or at the counter, follow a live token with sound, vibration and notifications, and a kiosk mode for a
  shop tablet. Installable and offline-capable.
- **Counter and stations (M4).** Counter screen for walk-ins and payments (money is never shown as received until a person
  confirms it), per-line serving, spoken calls, stations that total open items across orders into one spoken batch or
  show one card per job, and 80 mm tickets printed from the browser.
- **Owner and rules-based analyst (M5).** The owner's dashboard with today in plain sentences, hourly chart, best sellers,
  comparison with yesterday, tomorrow's prep forecast, repeat-customer badges, reviews and item switches; customer names
  and review text cleared after a retention period.
- **Release tooling (M6).** `npm run demo` with a seeded week and throwaway PINs; a backup command; a release export that
  scans for secrets, brands and personal paths.
- **Opt-in AI analyst (M7).** Ask questions on the owner's dashboard, answered from the dashboard's anonymous figures with
  every number checked, through one door that works with any OpenAI-compatible provider or a local model. Off by default.
- **Design (M8).** The look is data: `theme.json`, `strings.<locale>.json` and an Appearance screen with a live preview and
  a readability warning; shared components styled only through tokens; plural-aware wording.
- **Cloudflare (M9).** Runs on Cloudflare Workers' free plan with one Durable Object per install, or as a plain Node
  process; a public-demo configuration; measured against the free plan's daily limits.
- **Order-at-counter venues (M10).** Spots (zones and tables) with a QR per spot and a printable QR sheet; extras with
  min and max picks and a price each; a short note per line, shown, spoken and printed; an item may name its own station;
  a runner screen showing each order's spot and every line's state, with an alert when part of an order is late;
  ready-to-delivered minutes on the dashboard; diet and allergen filters; a daily count per item; a last-order time.
- **Premium look (M11).** Line icons drawn for ibow in place of the 3D emoji-style icons, the Fraunces display face,
  the business's own dish photos from its config, and a Most loved strip.
- **Levels, links hub, flags and telemetry (M12).** Card payments that staff record, and refunds netted in every total;
  owner, manager and system admin levels, each with its own PIN and one table of powers; a links hub at `/admin` showing
  what the signed-in level may open; feature flags changeable at run time and audited; telemetry kept on the install and
  never sent anywhere.
- **App shell (M13).** Installable and full-screen, with a splash screen, transitions between screens, skeletons while
  loading, proper dialogs for closed, last order passed, sold out, paused and offline, and the customer's name and an
  order number (#47) wherever a person reads it.
- **Rooms and events (M14).** A room's own QR can put an order on the room bill, which never counts as received until
  staff settle it at checkout in one audited payment; a Rooms screen; events with weekly repeats and an entry price,
  shown as banners to staff and guests.
- **Menu import (M15).** `npm run import-menu` reads menu photos, text, Markdown or HTML into a checked `catalog.json`,
  with prices in minor units, duplicates merged, add-ons mapped to extras and a list of everything a person should check.
  It works with any OpenAI-compatible vision model.
- **Orders follow the floor.** A station's first ready line moves an order to preparing, and the last dish handed over
  closes it and tells the guest Served. Demo sign-in screens come filled in, with one-tap roles.
- **Contributing.** Bug and feature issue forms, a pull request template, code owners and a protected `main`: every
  change goes issue, accepted, pull request, maintainer merge.
- **Getting started.** README, install guide, a complete configure guide, a static `/showcase` page, `npm run set-links`
  to fill in the project's links, contributing and security guides, and third-party notices.
