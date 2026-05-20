#!/usr/bin/env bash
# Extract the section for a given version from CHANGELOG.md.
# Format expected (Keep a Changelog):
#   ## [X.Y.Z] - YYYY-MM-DD
#   ...content...
#   ## [next] ...
#
# Usage:
#   scripts/extract-changelog.sh <version> [changelog-file]
# Exits non-zero if the section is missing or empty.

set -euo pipefail

VERSION="${1:?usage: $0 <version> [changelog-file]}"
CHANGELOG="${2:-CHANGELOG.md}"

if [ ! -f "$CHANGELOG" ]; then
  echo "extract-changelog: $CHANGELOG not found" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

awk -v ver="$VERSION" '
  /^## \[/ {
    if (in_section) exit
    if (index($0, "[" ver "]")) { in_section = 1; next }
  }
  in_section { print }
' "$CHANGELOG" > "$tmp"

if [ ! -s "$tmp" ]; then
  echo "extract-changelog: no section for version '$VERSION' in $CHANGELOG" >&2
  echo "  → add a '## [$VERSION] - YYYY-MM-DD' section before tagging" >&2
  exit 1
fi

cat "$tmp"
