#!/usr/bin/env bash
# Exports the committed tree as a fresh repository with one commit, for the first public push, then scans it:
#   bash scripts/release-export.sh <target-dir>
# Run `npm run set-links` first and commit: the export fails while any link placeholder is left (D-056).
# The target must be outside this repo and empty (or not exist yet). The message is plain. The commit's author is
# this repo's git user unless overridden, for example to publish under a public address:
#   RELEASE_AUTHOR_NAME="Your Name" RELEASE_AUTHOR_EMAIL="you@example.org" bash scripts/release-export.sh <target-dir> This script never adds a remote and never pushes: publishing is the owner's step, by hand.
set -euo pipefail

die() {
  echo "release-export: $*" >&2
  exit 1
}

[ $# -eq 1 ] || die "expected one argument, the target directory, found $#"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
target="$1"

created=0
if [ -e "$target" ]; then
  [ -d "$target" ] || die "expected a directory at $target, found a file"
  [ -z "$(ls -A "$target")" ] || die "expected an empty or new directory at $target, found files in it"
else
  mkdir -p "$target"
  created=1
fi
target="$(cd "$target" && pwd -P)"
case "$target/" in
  "$here"/*)
    [ "$created" -eq 0 ] || rmdir "$target"
    die "expected a target outside this repo ($here), found $target"
    ;;
esac

cd "$here"
[ -z "$(git status --porcelain)" ] || die "expected a clean working tree, so the export is exactly what is committed; commit or stash first"
name="${RELEASE_AUTHOR_NAME:-$(git config user.name || true)}"
email="${RELEASE_AUTHOR_EMAIL:-$(git config user.email || true)}"
[ -n "$name" ] && [ -n "$email" ] || die "expected RELEASE_AUTHOR_NAME/RELEASE_AUTHOR_EMAIL or git config user.name and user.email, found them unset"
head="$(git rev-parse --short HEAD)"

# The committed tree only: no history, nothing untracked or ignored (.env, data/, runs/ never leave).
git archive --format=tar HEAD | tar -x -C "$target"
# Development files (found by name, so no list of them is published) and the ignore-file lines naming them stay home.
node --disable-warning=ExperimentalWarning "$here/scripts/release-scan.ts" --prune "$target"

cd "$target"
git init -q -b main
git add -A
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
  git commit -q -m "ibow: first public release"
echo "release-export: $target holds the tree of $head as one commit ($(git rev-parse --short HEAD)), with no remote"

# Checks: nothing that names the real business, a brand, an assistant or the hub, no secret and no home path, in the
# files or the commit (the word lists are hashed in release-scan.ts), and no remote.
status=0
node --disable-warning=ExperimentalWarning "$here/scripts/release-scan.ts" --export "$target" || status=1
if [ -n "$(git remote)" ]; then
  echo "release-export: expected no remote, found $(git remote | tr '
' ' ')" >&2
  status=1
fi
[ "$status" -eq 0 ] || die "the export at $target failed its checks; fix them in ibow, empty the target and run again"
echo "release-export: checks passed. To publish, the owner adds the remote and pushes by hand."
