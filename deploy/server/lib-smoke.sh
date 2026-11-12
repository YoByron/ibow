#!/usr/bin/env bash
# Helpers for update.sh's smoke test (sourced, never run on its own; installed beside it in ~/apps/ibow/bin).
#
# The smoke server must never outlive the updater: an orphan that inherited the update lock (file descriptor 9) would block
# every later update. So it is started
#   - as the process itself (no wrapping subshell), so $! is its pid;
#   - without the lock (9>&-);
#   - in its own session and process group (setsid), so stopping it takes its children down too;
# and it is stopped by signalling the whole group and waiting for it.

SMOKE_PID=""

# smoke_start <log file> <command...>: runs the command in the background; its pid (also its process group) is SMOKE_PID.
smoke_start() {
  local log="$1"
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$log" 2>&1 9>&- &
  else
    "$@" >"$log" 2>&1 9>&- &
  fi
  SMOKE_PID=$!
}

# smoke_alive: whether the smoke server is still running.
smoke_alive() {
  [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null
}

# smoke_stop: asks the whole group to end, waits up to 10 seconds, then forces it, and reaps it. Safe to call twice.
smoke_stop() {
  [ -n "$SMOKE_PID" ] || return 0
  local pid="$SMOKE_PID" i
  SMOKE_PID=""
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

# lock_holder <pid file>: one line saying who holds a busy update lock, from the pid file the holder wrote.
lock_holder() {
  local file="$1" pid cmd
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    cmd="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    echo "held by pid $pid (${cmd:-command unknown}); if that process is not an update, kill it or delete $file"
  elif [ -n "$pid" ]; then
    echo "the pid file names $pid, which is not running, so something else that inherited the lock holds it; look for it with: lsof $(dirname "$file")/update.lock"
  else
    echo "holder unknown (no pid file)"
  fi
}
