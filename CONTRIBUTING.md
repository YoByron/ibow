# Contributing to ibow

Thank you for helping. ibow is small on purpose: every change should be the smallest one that does the job, with a test
that proves it. This page is the whole process.

## Set up

You need [Node 24](https://nodejs.org) or newer and git. On Windows use PowerShell.

```sh
git clone https://github.com/YoByron/ibow ibow
cd ibow
npm ci
npm run gate
```

`npm run gate` runs the type check, the linter and the unit tests. It needs no browser and takes about a minute. If it is
green on a fresh clone, you are ready.

## The loop

1. **Open an issue first** for anything bigger than a typo, so we agree on the problem before you spend time on code.
2. **Write a failing test first**, then the code that makes it pass. Run the narrow test while you work, for example
   `npx vitest run --dir tests config`.
3. **`npm run gate` must be green before every commit.** It runs `npm run typecheck`, `npm run lint` (Biome; `npx biome
   check --write .` fixes formatting) and `npm run test`.
4. **`npm run check` before you open a pull request.** It is the gate plus the browser tests (`npm run e2e`, Playwright).
   Run `npx playwright install chromium` once on a new machine to get the browser those tests use. A browser test that
   only times out when the machine is busy is not a defect: rerun it alone.
5. **One logical change per commit and per pull request.** A commit that mixes a refactor with a fix is two commits.

## Commits

[Conventional commits](https://www.conventionalcommits.org): a prefix, a short summary in the imperative, and a body that
says why when it isn't obvious.

```text
fix(store): refuse a development-build database that lacks the merged migrations
feat(showcase): a static /showcase page on every install
docs: configure guide covering every config field
test(api): the catalog carries the opening hours
```

Prefixes used here: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`. Keep the summary under about 72
characters.

**No attribution of any kind.** No co-author trailers, no generated-by lines and no tool names in commit
messages, code, comments or docs. The commit is yours.

## What a good change looks like

- It follows the principles in `docs/architecture.md` and the decisions in `docs/decisions.md`: money is integer minor
  units, time follows the business's zone, nothing about a business is hard-coded (samples live in `samples/`), the
  look comes from theme tokens and never from code, and no model, vendor or endpoint is wired in.
- It fails loudly: an error says what was expected, what was found and where.
- It keeps per-request work small. ibow has to fit Cloudflare's free plan (10 ms of CPU per request, 100,000 rows written
  per day); a change that adds requests, rows or polling states its cost in a test or in a decision.
- A new runtime dependency needs an entry in `docs/decisions.md` saying why. There are three today.
- Every staff screen works one-handed on a cheap Android phone, and anything staff must act on can also be spoken.
- Customer data stays minimal: a name is optional, a phone number is never required, and nothing personal goes to a model.
- Public text (README, docs, screens) is plain: short sentences, exact commands that work on Windows, macOS and Linux.
- Never commit secrets, `.env`, `.dev.vars` or a database. `npm run gate` includes a scan for common leaks, and
  `scripts/release-scan.ts` runs again on every release export.

## Licence of your contribution

ibow is licensed under the [GNU AGPL-3.0-only](LICENSE). There is **no contributor licence agreement and no DCO
sign-off** (no `Signed-off-by` line is needed). By opening a pull request you state that you wrote the change, or have the
right to submit it, and that it may be distributed under the same AGPL-3.0-only licence as the rest of the project: what
comes in is licensed as the project is licensed out. Don't paste in code from a source whose licence is incompatible with
the AGPL-3.0. If you add a bundled asset (a font, an icon set, a library) add its licence to
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Where things are

| Need | Look at |
|---|---|
| Layers, contracts, API, field notes | `docs/architecture.md` |
| Why a choice was made | `docs/decisions.md` (append a new entry; don't rewrite an approved one) |
| Milestones and status | `docs/plan.md` |
| Config fields | `docs/configure.md` |
| Running and deploying | `docs/install.md` |
| Security reports | [SECURITY.md](SECURITY.md) |

## Be kind

Disagree with the code, not the person. A maintainer's time is the scarce resource: a small, tested, well-described pull
request is the best way to spend it.

## Maintainers: publishing to the public repository

Changes reach the public repository as ordinary commits, never as a fresh repository. From a clone of the public repo
(`git clone https://github.com/YoByron/ibow`, kept outside your working copy), with this repo committed and clean:

```sh
RELEASE_AUTHOR_NAME="Your Name" RELEASE_AUTHOR_EMAIL="you@users.noreply.github.com" \
  bash scripts/release-sync.sh /path/to/public-clone "fix: a short message"
cd /path/to/public-clone && npm ci && npm run gate    # the published tree must pass on its own
git push                                              # by hand, when you are happy
```

`release-sync.sh` builds the committed tree without the development-only files, runs the release scans on it and on your
message (it refuses if either fails), makes the clone's files match (deleting files that no longer exist, leaving `.git` and
ignored files such as `node_modules` alone) and commits there. A run with nothing new makes no commit. It never pushes, fetches
or adds a remote. If the author variables are not set it commits as a no-reply identity. Fill in the project links first with
`npm run set-links` (the scan refuses leftover placeholders). `scripts/release-export.sh` is only for the very first, one-commit
release.
