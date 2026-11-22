#!/usr/bin/env bash
# Publish every bddr package to npm from your own machine, dependencies first.
#
#   scripts/publish-all.sh --dry-run     check what would be published (nothing is uploaded)
#   scripts/publish-all.sh               publish for real
#
# Authentication: run `npm login` once, or export NPM_TOKEN in this shell (never commit it or paste it anywhere).
# Prerequisite: the "@bddr" organisation exists on npmjs.com and you are a member with publish rights.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

if [ -n "${NPM_TOKEN:-}" ]; then
  export NPM_CONFIG_USERCONFIG="$(mktemp)"
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$NPM_CONFIG_USERCONFIG"
  trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT
fi

if [ -z "$DRY" ]; then
  echo "npm user: $(npm whoami)"
fi

npm ci
npm run build
npm run verify

for d in packages/core packages/runtime packages/reporters packages/cli packages/bddr; do
  echo "=== $d"
  (cd "$d" && npm publish --access public $DRY)
done
for d in plugins/playwright plugins/selenium plugins/axios; do
  echo "=== $d"
  (cd "$d" && npm ci && npm run build && npm publish --access public $DRY)
done
echo "Done. Next: add a Trusted Publisher on each package (repo afsarali273/bddr, workflow release.yml), then revoke the token."
