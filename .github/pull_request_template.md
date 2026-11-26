## What and why

<!-- One logical change. What it does and why, in a few sentences. -->

Closes #<!-- the accepted issue this fixes; a pull request without one is closed unless it is a typo fix -->

## How it was tested

<!-- The test that failed before this change and passes now, and anything you checked by hand. For a screen change,
attach a screenshot before and after. -->

## Checklist

- [ ] The issue is marked `accepted` (or this is a typo or docs-only fix).
- [ ] A test fails without this change and passes with it.
- [ ] `npm run check` passes locally (the gate plus the browser tests).
- [ ] One logical change; conventional commit messages (`fix:`, `feat:`, `docs:` ...).
- [ ] Nothing about a business is hard-coded, and the look comes only from theme tokens.
- [ ] No secrets, `.env`, `.dev.vars`, database or customer data.
- [ ] A new runtime dependency, if any, has an entry in `docs/decisions.md`.
- [ ] I wrote this change or have the right to submit it under AGPL-3.0-only (see CONTRIBUTING.md).
