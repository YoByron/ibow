#!/usr/bin/env bash
# Pull-based update, run by ibow-update.timer (or by hand: ~/apps/ibow/bin/update.sh):
#   1. read the newest commit of the branch from the public repository;
#   2. if it is new, ask GitHub's public check-runs API (no token) and go on only when every check has passed;
#   3. fetch that commit into releases/<sha>, then npm ci and the build, with the pinned Node;
#   4. smoke-test it on a spare localhost port, on a throwaway data directory;
#   5. switch the `current` symlink atomically, restart ibow.service and health-check it;
#   6. on failure, roll back to the previous release; keep the newest 3 releases.
# One run at a time (a lock file). Everything it says goes to the journal. Exit 0 means "nothing to do or waiting",
# exit 1 means a release failed and was rolled back.
set -euo pipefail

APP="${IBOW_HOME:-$HOME/apps/ibow}"
NODE="$APP/node/bin"
export PATH="$NODE:$PATH"
log() { echo "ibow-update: $*"; }
die() {
  echo "ibow-update: $*" >&2
  exit 1
}

[ -r "$APP/ibow.env" ] || die "expected $APP/ibow.env, found none; run deploy/server/install.sh first"
set -a
# shellcheck disable=SC1091
. "$APP/ibow.env"
set +a
REPO="${IBOW_REPO:-}"
BRANCH="${IBOW_BRANCH:-main}"
PORT="${PORT:-8790}"
case "$REPO" in
  https://github.com/*/*) ;;
  *) die "expected IBOW_REPO in $APP/ibow.env to be https://github.com/<owner>/<repo>, found '$REPO'" ;;
esac
slug="${REPO#https://github.com/}"
slug="${slug%.git}"
slug="${slug%/}"

# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib-smoke.sh"

# The lock is file descriptor 9. Nothing this script starts may inherit it (every child below gets 9>&-), or a child that
# outlives the script would keep the lock and block every later update.
exec 9>>"$APP/state/update.lock"
flock -n 9 || {
  log "another update is running; skipping this one: $(lock_holder "$APP/state/update.pid")"
  exit 0
}
echo "$$" >"$APP/state/update.pid"

sha="$(git ls-remote "$REPO" "refs/heads/$BRANCH" 9>&- | cut -f1)"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "expected a 40-character commit for $BRANCH of $REPO, found '$sha'"
cur=""
[ -L "$APP/current" ] && cur="$(basename "$(readlink -f "$APP/current")")"
if [ "$sha" = "$cur" ] && systemctl --user is-active --quiet ibow.service; then
  log "up to date at ${sha:0:12}"
  exit 0
fi
if [ -e "$APP/state/failed.$sha" ]; then
  log "${sha:0:12} failed before; waiting for a newer commit"
  exit 0
fi

# CI gate: the public API, unauthenticated (60 requests an hour per address: at one look every 5 minutes this is plenty).
hdr="$(mktemp)"
body="$(mktemp)"
cleanup() {
  rm -f "$hdr" "$body" "$APP/state/update.pid"
  smoke_stop
  rm -rf "${tmpdata:-}"
}
trap cleanup EXIT
code="$(curl -sS --proto '=https' --tlsv1.2 -m 30 -D "$hdr" -o "$body" -w '%{http_code}' \
  -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/$slug/commits/$sha/check-runs?per_page=100" || echo 000)"
if [ "$code" = "403" ] || [ "$code" = "429" ]; then
  remaining="$(tr -d '\r' <"$hdr" | grep -i '^x-ratelimit-remaining:' | awk '{print $2}' || true)"
  retry="$(tr -d '\r' <"$hdr" | grep -i '^retry-after:' | awk '{print $2}' || true)"
  log "GitHub API limit reached (remaining=${remaining:-?}, retry-after=${retry:-?}s); trying again at the next timer"
  exit 0
fi
[ "$code" = "200" ] || {
  log "GitHub check-runs answered $code for ${sha:0:12}; trying again at the next timer"
  exit 0
}
state="$("$NODE/node" "$APP/bin/ci-status.ts" <"$body")" || die "could not read the check-runs reply for ${sha:0:12}"
case "$state" in
  success) log "CI passed for ${sha:0:12}" ;;
  pending | none)
    log "CI is $state for ${sha:0:12}; waiting"
    exit 0
    ;;
  failure)
    log "CI failed for ${sha:0:12}; not deploying it"
    : >"$APP/state/failed.$sha"
    exit 0
    ;;
  *) die "unexpected CI state '$state'" ;;
esac

fail_release() {
  : >"$APP/state/failed.$sha"
  die "$1"
}

# Fetch exactly that commit.
rel="$APP/releases/$sha"
if [ ! -d "$rel" ]; then
  work="$APP/releases/.building-$sha"
  rm -rf "$work"
  mkdir -p "$work"
  git -C "$work" init -q
  git -C "$work" remote add origin "$REPO"
  git -C "$work" fetch -q --depth 1 origin "$sha" 9>&-
  git -C "$work" checkout -q FETCH_HEAD
  log "building ${sha:0:12} with Node $("$NODE/node" --version)"
  if ! (cd "$work" && npm ci --no-audit --no-fund --loglevel=error 9>&- && npm run build >/dev/null 9>&-); then
    rm -rf "$work"
    fail_release "npm ci or the build failed for ${sha:0:12}"
  fi
  mv "$work" "$rel"
fi

# Smoke test on a spare port with a throwaway data directory, so it can never touch the live database.
spare="$("$NODE/node" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
tmpdata="$(mktemp -d "$APP/state/smoke.XXXXXX")"
# No wrapping subshell: smoke_start runs node itself, in its own process group and without the lock (lib-smoke.sh).
smoke_start "$tmpdata/log" env HOST=127.0.0.1 PORT="$spare" TRUST_PROXY=0 IBOW_DEMO_SAMPLE="${IBOW_DEMO_SAMPLE:-tea-house}" \
  "$NODE/node" --disable-warning=ExperimentalWarning "$rel/scripts/demo-serve.ts" --data "$tmpdata"
ok=0
for _ in $(seq 1 90); do
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$spare/healthz" 2>/dev/null; then
    ok=1
    break
  fi
  smoke_alive || break
  sleep 1
done
if [ "$ok" = 1 ]; then
  for path in / /showcase; do
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$spare$path")" = "200" ] || ok=0
  done
fi
smoke_stop
if [ "$ok" != 1 ]; then
  log "smoke test failed for ${sha:0:12}; last lines of its log:"
  tail -n 15 "$tmpdata/log" 2>/dev/null || true
  rm -rf "$rel"
  fail_release "the smoke test failed for ${sha:0:12}; the running release is unchanged"
fi
log "smoke test passed for ${sha:0:12}"

# A copy of the data first, so a rollback to older code never meets a newer database without a way back.
"$APP/bin/backup.sh" "pre-${sha:0:12}" 9>&- || log "warning: the pre-update backup failed; going on"

# Switch: a new symlink renamed over the old one is atomic.
prev="$(readlink "$APP/current" 2>/dev/null || true)"
ln -sfn "releases/$sha" "$APP/current.new"
mv -T "$APP/current.new" "$APP/current"
systemctl --user restart ibow.service 9>&-
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" = 1 ]; then
  log "switched to ${sha:0:12} and it is healthy"
else
  log "ibow did not become healthy on ${sha:0:12}; rolling back"
  : >"$APP/state/failed.$sha"
  if [ -n "$prev" ]; then
    ln -sfn "$prev" "$APP/current.new"
    mv -T "$APP/current.new" "$APP/current"
    systemctl --user restart ibow.service || true
    log "rolled back to $(basename "$prev" | cut -c1-12)"
  else
    systemctl --user stop ibow.service || true
    log "there was no previous release to roll back to; ibow.service is stopped"
  fi
  exit 1
fi

# Keep the newest 3 releases, never the live one or the one before it.
live="$(basename "$(readlink -f "$APP/current")")"
before="$(basename "${prev:-none}")"
# shellcheck disable=SC2012
ls -1dt "$APP"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  name="$(basename "$old")"
  if [ "$name" != "$live" ] && [ "$name" != "$before" ]; then
    rm -rf -- "$old"
    log "removed old release ${name:0:12}"
  fi
done
exit 0
