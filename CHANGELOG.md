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
- **Getting started.** README, install guide, a complete configure guide, a static `/showcase` page, `npm run set-links`
  to fill in the project's links, contributing and security guides, and third-party notices.
