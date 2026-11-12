# ibow concept v2 tokens (mapped to the original app)

Source of truth for the mocks: `screens/ibow.css` and `screens/extra.css`. "Orig" is the value in the original `shared/styles.css`.

## Colour

| Role | Light | Dark | Orig |
|---|---|---|---|
| Header gradient | #1e3d1a to #2d5a27 (135deg) | same | #1e3d1a to #2d5a27 |
| Green primary (buttons, steppers) | #2d5a27 | #2d5a27 (text/accents #9ad48f) | --primary #2d5a27 |
| Green light (done states, bars) | #4a8b42 | #4a8b42 | --primary-light #4a8b42 |
| Green deepest (gradient start, PIN) | #16301a | same | new, darker than --primary-dark #1e3d1a |
| Awning lime | #a8d24e | #a8d24e | #a8d24e |
| Sun (accent: active pill, tab, CTA) | #f5c518 | #f5c518 | --accent #f5c518 |
| Price text on white | #946a00 | #f5c518 | #f5c518 (darkened for 4.5:1 contrast on white; sun fill stays #f5c518) |
| Sun tint (active tab bg) | #fff4cc | rgba(245,197,24,.14) | peach tint |
| Orange (pending) | #f59e0b | #f59e0b | --warning #f59e0b |
| Success / green stat | #22c55e (text #168a3f) | #22c55e (text #6ee79a) | --success #22c55e |
| Error / badge | #ef4444 | #ef4444 | --error #ef4444 |
| Background | #f5f5f5 | #121512 | #f5f5f5 / dark #1a1a1a (kitchen #101216) |
| Card | #ffffff | #1d211c | #fff / #242424 |
| Card-2 (chips, wells) | #f2f4f1 | #262b25 | n/a |
| Ink / secondary / muted | #151a14 / #4a5148 / #7a8178 | #f4f6f2 / #c3c9c0 / #8b928a | #1a1a1a / #d0d0d0 / #9a9a9a |
| Hairline | rgba(21,26,20,.08) | rgba(255,255,255,.09) | rgba(255,255,255,.1) |

Dark mode is a green-tinted neutral rather than pure #1a1a1a so the green identity carries through; the dark gradient header is unchanged.

Category tints for generated item images (no photo): tea #f9e6c6/#e8bf86, ice #d9f0ee/#a7d9d6, soda #fde4c8/#f7bd84, mocktail #d9f1d2/#a2d98f, noodle #fde7cd/#f3b97c, snack #f9e2cf/#e8b48d, green #e0efd9/#b3d8a4. A tinted gradient, a dot pattern, a soft shadow and the category's Fluent emoji tilted 6 degrees.

## Type (Inter 400/500/600/700/800, Latin subset, self-hosted woff2)

| Style | Size / weight | Orig |
|---|---|---|
| Hero token | 116 / 800, tracking -0.05em, tabular | new |
| Display (KPI) | 36 / 800 | n/a |
| Brand / page title | 22 / 800 (20 on sub-pages) | --text-xl 18 |
| Section head | 19 / 800 | 18 uppercase yellow |
| Item name | 16 / 700 | 16 |
| Price | 15 / 800 | 14 |
| Body | 14 / 400-500 | 14 (--text-base) |
| Description / meta | 12.5 / 400 | 12 (--text-sm) |
| Label (caps) | 11-12 / 700-800, tracking .07em | 11 (--text-xs) |

## Radius

| Use | Value | Orig |
|---|---|---|
| Chips, pills, round buttons | 999px | --radius-full |
| Item card | 20px | --radius-lg 16 |
| Cards | 16px (dashboard 20px) | 16 |
| Buttons / steppers | 12-16px | 12-16 |
| Bottom sheet / ticket | 28px | 24 (--radius-xl) |
| Image slot | 16px | n/a |

## Spacing

4-point grid on a 16px rhythm: 4, 8, 12, 16, 24. Page gutter 16px (dashboard 32px), card padding 14-16px, item gap 12px. Orig used 4/8/16/24/32 (--space-xs..xl).

## Shadows

- sh-1: 0 1px 2px rgba(21,40,16,.06), 0 2px 8px rgba(21,40,16,.05) (cards)
- sh-2: 0 4px 16px rgba(21,40,16,.10) (search, raised)
- sh-3: 0 12px 32px rgba(21,40,16,.18) (cart bar, sheets, ticket)
- Awning: drop-shadow 0 3px 3px rgba(0,0,0,.28)
- Dark mode uses black at .4 to .55. Orig: sm/md/lg = 0 1/4/10px with .3/.4/.5 black.

## Motion

- Ease: cubic-bezier(.2,.8,.2,1). Press: scale .92 to .98 in 120-150ms (orig 150ms ease).
- Cart bar bump 500ms; sheet slide-in 380ms; scrim fade 250ms; skeleton shimmer 1.4s linear loop; live-pill pulse 1.6s; steam float 2.4s.
- All of it is wrapped in `prefers-reduced-motion: no-preference`, and a `reduce` block sets `animation:none; transition:none`. The PNGs are rendered with reduced motion on.

## Components kept from the original, restyled

Awning (lime #a8d24e and white, 26px stripes with scallops), forest header, sun active pill, 3D Fluent emoji on categories and actions, white cards on grey, green round actions, Menu / Cart / Track tab bar with a sun-tinted active tab, favourites / recent orders / recent tokens, counter header with round icon buttons and orange/green stat chips, green PIN keypad screen, dark-mode toggle.

## Config-driven (not shown)

- Veg / non-veg marker on the item card: off by default, shown only if the catalog provides a `diet` field.
- Item photo: used when the catalog has `image`; otherwise the generated tile above.
- Item descriptions in the mocks are placeholders; the sample catalog has none, so the card collapses to name and price without a `description`.
- Cash chips come from `business.json` `cashShortcuts` (the mock shows exact and note denominations for a 110 total).

## Assets

- `screens/assets/emoji/*.png`: Microsoft Fluent Emoji 3D (MIT), licence in `screens/assets/LICENSE-fluent-emoji.txt`.
- `screens/assets/fonts/inter-*.woff2`: Inter, Latin subset via fontsource (OFL), licence in `screens/assets/LICENSE-inter-OFL.txt`.
- Regenerate: `node build.mjs && node render.mjs` in this folder.
