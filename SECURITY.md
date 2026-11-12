# Security policy

## Reporting a vulnerability

Please report a security problem **privately**, not in a public issue or pull request, so it can be fixed before it is
widely known.

- If the repository's **Security** tab offers "Report a vulnerability", use it: it opens a private conversation with the
  maintainer.
- Otherwise message the author on [LinkedIn](https://www.linkedin.com/in/saket-poswal/) and say only that you have a security report; you will be
  asked for the details in a private channel. (A dedicated security contact will replace this when there is one.)

Please include what you found, the steps to reproduce it (a request, a URL, a config), which version or commit you ran
(`git rev-parse --short HEAD`), and what you think an attacker gains. Don't test against a business that isn't yours, and
don't read, change or delete other people's data: a demonstration on your own install is enough.

ibow is maintained by one person. Reports are read as soon as possible, but there is no guaranteed response time, and no
bug bounty is offered. Credit in the changelog is given on request.

## Supported versions

Only the latest commit on the default branch is supported. Upgrade with `git pull` and the steps in
[docs/install.md](docs/install.md#upgrades).

## In scope

Problems in ibow's own code and its default configuration, for example:

- Sign-in and sessions: PIN checks, session cookies, rate limits, staff roles (a station account doing a counter's work,
  a customer reaching a staff or owner route).
- Authorization of orders: one customer reading or changing another's order, or its secret order key leaking.
- Injection and scripting: SQL injection, cross-site scripting, a way around the content security policy, a config or
  strings file that can run code or reach files outside the config folder.
- Data exposure: customer names or review text surviving past `retentionDays`, personal data in an export, a log, an event
  stream or a model prompt; PIN hashes or the AI key leaking to a browser or a log.
- The AI door: the key sent where it should not be, or a model answer that can change data.
- The Cloudflare Worker and Durable Object routing; the release export leaking a secret.

## Out of scope

- Your own deployment's mistakes: a weak PIN, a shared PIN, a leaked API token or `.env`, an open firewall port, a server
  that isn't patched, a proxy that logs query strings (`?key=`) forever.
- Volume attacks that exhaust a free plan's daily limits; the limits are documented in
  [docs/install.md](docs/install.md#limits-on-the-free-plan).
- The public demo's PINs: they are shown on its sign-in screens on purpose and it holds only sample data.
- Reports that need physical access to a staff phone that is already signed in, or social engineering of the owner.
- Vulnerabilities in third-party software (Node, Cloudflare, your browser, the libraries in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)): report those upstream. If ibow uses one unsafely, that part is in scope.
- Missing hardening that has no demonstrated impact, and automated-scanner output without a working exploit.

## No warranty

As the [LICENSE](LICENSE) says, ibow comes without warranty. Running it securely, including patching, backups and who
holds the PINs, is the operator's responsibility.
