#!/usr/bin/env bash
# Behaviour check for deploy/server/lib-smoke.sh (run by tests/server-kit.test.ts on Linux, where flock and setsid exist):
# a stub server that has a child of its own is started and stopped the way update.sh does it, while this script holds the
# update lock on file descriptor 9. Afterwards nothing may be left running or holding the lock.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() {
  echo "smoke-check: FAIL: $*" >&2
  exit 1
}

# shellcheck disable=SC1091
. "$here/deploy/server/lib-smoke.sh"

# The stub: a "server" (this bash) with a child of its own (sleep), as node has with demo-serve's server.
cat >"$work/stub.sh" <<'STUB'
#!/usr/bin/env bash
sleep 300 &
echo $! >"$1/child.pid"
echo $$ >"$1/stub.pid"
wait
STUB

exec 9>>"$work/update.lock"
flock -n 9 || fail "could not take the lock in the first place"

smoke_start "$work/log" bash "$work/stub.sh" "$work"
for _ in $(seq 1 50); do
  [ -s "$work/child.pid" ] && [ -s "$work/stub.pid" ] && break
  sleep 0.1
done
[ -s "$work/stub.pid" ] || fail "the stub never started"
stub="$(cat "$work/stub.pid")"
child="$(cat "$work/child.pid")"

[ "$SMOKE_PID" = "$stub" ] || fail "expected \$! ($SMOKE_PID) to be the server's own pid ($stub), found a wrapper's"
kill -0 "$child" 2>/dev/null || fail "the stub's child is not running before the stop"
if [ -e "/proc/$stub/fd/9" ] || [ -e "/proc/$child/fd/9" ]; then fail "the server or its child inherited the lock (fd 9)"; fi

smoke_stop
sleep 0.3
kill -0 "$stub" 2>/dev/null && fail "the server is still running after smoke_stop"
kill -0 "$child" 2>/dev/null && fail "the server's child is still running after smoke_stop (it was orphaned)"
smoke_stop # a second call is harmless

# With the updater's own hold released, the lock must be free: nobody else holds it.
exec 9>&-
flock -n "$work/update.lock" true || fail "something still holds the update lock"

# A busy lock names its holder.
echo "$$" >"$work/update.pid"
out="$(lock_holder "$work/update.pid")"
case "$out" in *"held by pid $$"*) ;; *) fail "lock_holder did not name the holder: $out" ;; esac
echo 999999 >"$work/update.pid"
out="$(lock_holder "$work/update.pid")"
case "$out" in *"not running"*) ;; *) fail "lock_holder did not flag a dead holder: $out" ;; esac

echo "smoke-check: OK"
