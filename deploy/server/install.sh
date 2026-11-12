#!/usr/bin/env bash
# One-time setup of the self-host kit, run as the ordinary user that will run ibow (never root, never sudo):
#   bash deploy/server/install.sh
# It creates ~/apps/ibow/{releases,data,backups,node,bin,state}, downloads the pinned official Node tarball from nodejs.org
# and verifies it against the published SHASUMS256.txt, installs the systemd USER units into ~/.config/systemd/user/ and
# enables ibow's own. It touches nothing else: no other unit, port, cloudflared config or system file.
set -euo pipefail

NODE_VERSION="24.11.1"
APP="${IBOW_HOME:-$HOME/apps/ibow}"
UNITS="$HOME/.config/systemd/user"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

die() {
  echo "install: $*" >&2
  exit 1
}
say() { echo "install: $*"; }

[ "$(id -u)" -ne 0 ] || die "expected to run as an ordinary user, found root; run it as the user that will run ibow"
[ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || die "expected Linux on x86_64 (the pinned Node is linux-x64), found $(uname -s) $(uname -m)"
for tool in curl tar xz sha256sum git systemctl flock; do
  command -v "$tool" >/dev/null 2>&1 || die "expected $tool on the PATH, found none; install it with your package manager first"
done
systemctl --user show-environment >/dev/null 2>&1 || die "expected a systemd user session, found none; log in normally (not su) and try again"
[ "$APP" = "$HOME/apps/ibow" ] || die "expected IBOW_HOME unset: the unit files fix the location at ~/apps/ibow"

mkdir -p "$APP"/{releases,data,backups,node,bin,state} "$UNITS"
chmod 700 "$APP" "$APP/data" "$APP/backups"

# Node: only if the pinned version is not already there.
if [ "$("$APP/node/bin/node" --version 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
  say "Node v$NODE_VERSION is already in $APP/node"
else
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  tmp="$(mktemp -d "$APP/state/node-download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  say "downloading $tarball from nodejs.org"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$tarball" "$base/$tarball"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "expected $tarball to match SHASUMS256.txt, found a mismatch; nothing was installed"
  say "checksum verified, unpacking"
  tar -xJf "$tmp/$tarball" -C "$tmp"
  rm -rf "$APP/node.new"
  mv "$tmp/node-v$NODE_VERSION-linux-x64" "$APP/node.new"
  rm -rf "$APP/node"
  mv "$APP/node.new" "$APP/node"
  [ "$("$APP/node/bin/node" --version)" = "v$NODE_VERSION" ] || die "expected $APP/node/bin/node to report v$NODE_VERSION"
fi

# The scripts the timers run live outside the releases, so an update never changes the script that is running it.
install -m 0755 "$here/update.sh" "$APP/bin/update.sh"
install -m 0755 "$here/backup.sh" "$APP/bin/backup.sh"
install -m 0644 "$here/ci-status.ts" "$APP/bin/ci-status.ts"
if [ ! -e "$APP/ibow.env" ]; then
  install -m 0600 "$here/ibow.env.example" "$APP/ibow.env"
  say "wrote $APP/ibow.env: check IBOW_REPO in it"
else
  say "kept your existing $APP/ibow.env"
fi

# The units: copies, with the cloudflared path set to the one on this machine.
for unit in ibow.service ibow-update.service ibow-update.timer ibow-backup.service ibow-backup.timer; do
  install -m 0644 "$here/$unit" "$UNITS/$unit"
done
cf="$(command -v cloudflared || true)"
if [ -n "$cf" ]; then
  sed "s|/usr/local/bin/cloudflared|$cf|" "$here/cloudflared-ibow.service" >"$UNITS/cloudflared-ibow.service"
  chmod 0644 "$UNITS/cloudflared-ibow.service"
fi
systemctl --user daemon-reload
systemctl --user enable ibow.service ibow-update.timer ibow-backup.timer
systemctl --user start ibow-backup.timer
if [ -n "$cf" ] && [ -e "$HOME/.cloudflared/ibow.yml" ]; then
  systemctl --user enable cloudflared-ibow.service
  say "enabled cloudflared-ibow.service (it starts when you start it, see the guide)"
fi

if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
  say "warning: lingering is off, so user services stop when you log out; ask an administrator to run: loginctl enable-linger $(id -un)"
fi

cat <<EOF

install: done. Nothing is running yet. Next, as this user:
  1. Check $APP/ibow.env (IBOW_REPO, PORT).
  2. Build and start the first release:   $APP/bin/update.sh
  3. Start the update timer:              systemctl --user start ibow-update.timer
  4. Logs:                                journalctl --user -u ibow -u ibow-update -f
The tunnel steps (cloudflared tunnel create / route dns) are in docs/install.md.
EOF
