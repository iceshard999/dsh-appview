#!/usr/bin/env bash
# Isolated install check for dsh-appview.
#
# Proves the packed tgz is a real DSH plugin package on this host:
#   * `dsh plugin --profile web add <tgz>` (pnpm, offline) installs it into a
#     throwaway profile under this workspace;
#   * the profile manifest records it and adds it to `dsh.profile.bundles`;
#   * `dsh --profile web --dump-config` composes the plugin's own layer and
#     inserts its loader row `id: dsh-appview`.
#
# Nothing outside this workspace is written: DSH_HOME, the pnpm store and the
# XDG dirs are all redirected below `.test-home/`. The real ~/.dsh profile and
# the running GUI are untouched.
#
# Usage: bash verify/install-check.sh [path/to/package.tgz]
# Env:   DSH_TEST_HOME  override the throwaway home (must stay under the workspace)
#        DSH_CLI        dsh executable (default: `dsh` from PATH)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(dirname "$here")"
tgz="${1:-$workspace/dist/dsh-appview-0.3.1.tgz}"
test_home="${DSH_TEST_HOME:-$workspace/.test-home}"
dsh_cli="${DSH_CLI:-dsh}"

case "$test_home" in
  "$workspace"/*) ;;
  *)
    echo "refusing to run: DSH_TEST_HOME must live inside $workspace (got $test_home)" >&2
    exit 1
    ;;
esac
if [[ ! -f "$tgz" ]]; then
  echo "missing tarball: $tgz (run: npm run pack)" >&2
  exit 1
fi
if ! command -v "$dsh_cli" >/dev/null 2>&1; then
  echo "dsh executable not found: $dsh_cli (set DSH_CLI=/path/to/dsh)" >&2
  exit 1
fi

echo "== isolated install check =="
echo "tarball : $tgz"
echo "DSH_HOME: $test_home"
echo "dsh     : $(command -v "$dsh_cli")"

# Fresh home every run; the path guard above keeps this inside the workspace.
rm -rf -- "$test_home"
mkdir -p -- "$test_home"

export DSH_HOME="$test_home"
export XDG_CONFIG_HOME="$test_home/xdg/config"
export XDG_DATA_HOME="$test_home/xdg/data"
export XDG_CACHE_HOME="$test_home/xdg/cache"
export XDG_STATE_HOME="$test_home/xdg/state"

echo
echo "== dsh plugin --profile web add (offline) =="
"$dsh_cli" plugin --profile web add "$tgz" --offline --store-dir "$test_home/pnpm-store"

profile="$test_home/profiles/web"
installed="$profile/node_modules/dsh-appview"
test -f "$installed/package.json"
test -f "$installed/lib/client.js"
test -f "$installed/lib/index.js"
test -f "$installed/cordis.patch.yml"
echo "installed package: $installed"

node -e '
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (!manifest.dsh.profile.bundles.includes("dsh-appview"))
  throw new Error("profile bundle list misses dsh-appview");
if (!manifest.dependencies["dsh-appview"])
  throw new Error("profile dependencies miss dsh-appview");
console.log("profile manifest: dependency + dsh.profile.bundles recorded");
' "$profile/package.json"

echo
echo "== dsh --profile web --dump-config (listen check) =="
"$dsh_cli" --profile web --dump-config > "$test_home/config-dump.yml"
if ! grep -q "^- id: dsh-appview$" "$test_home/config-dump.yml"; then
  echo "composed config has no dsh-appview loader row" >&2
  exit 1
fi
echo "composed config contains:"
grep -n -B1 -A1 "^- id: dsh-appview$" "$test_home/config-dump.yml"

echo
echo "PASS: tgz installs via dsh plugin add, is recorded in the profile, and its loader row is composed."
echo "Full home left at $test_home (delete it to reclaim space)."
