#!/usr/bin/env bash
# A consistent copy of the database into ~/apps/ibow/backups (VACUUM INTO, through scripts/backup.ts, the script behind
# `npm run backup`), keeping the newest 14 dated copies. Safe while ibow is serving. Run daily by ibow-backup.timer; also
# called by update.sh with a label before a switch.
#   backup.sh [label]      (default label: the date)
set -euo pipefail

APP="${IBOW_HOME:-$HOME/apps/ibow}"
label="${1:-$(date +%F)}"
dest="$APP/backups/ibow-$label.db"

if [ ! -e "$APP/data/ibow.db" ]; then
  echo "ibow-backup: no database at $APP/data/ibow.db yet; nothing to back up"
  exit 0
fi
if [ -e "$dest" ]; then
  echo "ibow-backup: $dest already exists; keeping it"
else
  (cd "$APP/current" && DATA_DIR="$APP/data" "$APP/node/bin/node" --disable-warning=ExperimentalWarning scripts/backup.ts "$dest")
fi
chmod 600 "$dest" 2>/dev/null || true
# Keep the newest 14 (the daily ones and the pre-update ones together).
# shellcheck disable=SC2012
ls -1t "$APP"/backups/ibow-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f --
echo "ibow-backup: done ($(ls -1 "$APP"/backups/ibow-*.db | wc -l) kept)"
