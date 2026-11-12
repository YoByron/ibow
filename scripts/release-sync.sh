#!/usr/bin/env bash
# Brings the published repository up to date as an ordinary commit, from a clone of it:
#   bash scripts/release-sync.sh <clone-of-the-public-repo> "<commit message>"
# It builds the same pruned tree as release-export.sh (the committed tree, development files removed) in a temporary
# directory, runs the same scans on it and on the message, and refuses if either fails. Then it makes the clone's files
# match that tree (files that no longer exist are deleted; .git, and anything the clone ignores such as node_modules,
# are left alone) and commits there. The author is RELEASE_AUTHOR_NAME and RELEASE_AUTHOR_EMAIL, a no-reply identity by
# default. If nothing changed it makes no commit. It never pushes, fetches or touches a remote: publishing is by hand,
# with `git push` from the clone.
set -euo pipefail

die() {
  echo "release-sync: $*" >&2
  exit 1
}

[ $# -eq 2 ] || die "expected a clone directory and a commit message, found $# arguments"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
message="$2"
[ -n "${message// /}" ] || die "expected a commit message, found an empty one"
[ -d "$1" ] || die "expected a directory at $1, found none"
dest="$(cd "$1" && pwd -P)"
case "$dest/" in
  "$here"/*) die "expected a clone outside this repo ($here), found $dest" ;;
esac
git -C "$dest" rev-parse --git-dir >/dev/null 2>&1 || die "expected $dest to be a git clone, found none"
# Empty when $dest is the top of its clone (no path comparison, which differs between Windows and POSIX spellings).
[ -z "$(git -C "$dest" rev-parse --show-prefix)" ] || die "expected $dest to be the top of a git clone, found a folder inside one"
[ -z "$(git -C "$dest" status --porcelain)" ] || die "expected a clean clone at $dest, found uncommitted changes; commit or discard them first"
cd "$here"
[ -z "$(git status --porcelain)" ] || die "expected a clean working tree here, so the sync is exactly what is committed; commit or stash first"

name="${RELEASE_AUTHOR_NAME:-ibow}"
email="${RELEASE_AUTHOR_EMAIL:-noreply@users.noreply.github.com}"
head="$(git rev-parse --short HEAD)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/tree" "$work/msg"
git archive --format=tar HEAD | tar -x -C "$work/tree"
node --disable-warning=ExperimentalWarning "$here/scripts/release-scan.ts" --prune "$work/tree" >/dev/null

# The same scans as the export; the message is scanned as a file of its own.
printf '%s\n' "$message" >"$work/msg/message.txt"
status=0
node --disable-warning=ExperimentalWarning "$here/scripts/release-scan.ts" --export "$work/tree" || status=1
node --disable-warning=ExperimentalWarning "$here/scripts/release-scan.ts" --export "$work/msg" || status=1
[ "$status" -eq 0 ] || die "the tree or the message failed its checks; nothing was changed in $dest"

# Make the clone match the tree: delete tracked files that are gone, then copy everything over.
(cd "$work/tree" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) >"$work/new.txt"
git -C "$dest" ls-files | LC_ALL=C sort >"$work/old.txt"
comm -23 "$work/old.txt" "$work/new.txt" | while IFS= read -r gone; do
  rm -f -- "$dest/$gone"
done
(cd "$work/tree" && tar -c .) | tar -x -C "$dest"
# Empty folders left behind by deletions.
find "$dest" -mindepth 1 -type d -empty -not -path "$dest/.git/*" -not -path "$dest/.git" -delete 2>/dev/null || true

git -C "$dest" add -A
if git -C "$dest" diff --cached --quiet; then
  echo "release-sync: nothing changed; no commit made in $dest"
  exit 0
fi
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
  git -C "$dest" -c commit.gpgsign=false commit -q -m "$message"
echo "release-sync: committed $(git -C "$dest" rev-parse --short HEAD) in $dest from $head (nothing was sent anywhere; publishing is by hand from there)"
