#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-netbird-green/green"
grep -q 'io.github.getcolors.netbird.workflow/workflow' "$launcher"
grep -q 'def \^:private netbird-sha' "$launcher"
[[ -L "$root/green/green" ]] && [[ $(readlink "$root/green/green") == ../skills/package-netbird-green/green ]]
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "$launcher" "$tmp/green"; chmod +x "$tmp/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/colors.yml"
(cd "$tmp" && NETBIRD_LIB_ROOT="$root" ./green build >/dev/null)
[[ -f "$tmp/.colors/netbird-fixture/compute/nodes/0/node-none.tf.json" ]]
[[ -f "$tmp/.colors/netbird-fixture/netbird-ansible/compose.yml" ]]
# The launcher walks up for colors.yml, so any subdirectory works.
mkdir -p "$tmp/nested/path"
(cd "$tmp/nested/path" && NETBIRD_LIB_ROOT="$root" ../../green build >/dev/null)
# The profile guard is the whole reason COLORS_PAR_PROFILE is refused: an
# overlay would point one deployment at another's state.
out=$(cd "$tmp" && NETBIRD_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out"
[[ ! -d "$tmp/.colors/wrong" ]]
# colors-compute-red declares the Red SDK as a peer, so a cold launcher cache
# installs the SDK only because PINS names it. The pin must be the one
# red/package.json tests against, and a cold cache must actually resolve it:
# the NETBIRD_LIB_ROOT builds above reuse red/node_modules and cannot see a
# missing peer.
red_launcher="$root/skills/package-netbird-red/red"
red_sdk_sha=$(grep -oE '"red": "github:getcolors/red#[0-9a-f]{40}"' "$root/red/package.json" | grep -oE '[0-9a-f]{40}')
[[ -n $red_sdk_sha ]] || { echo 'launcher: red/package.json carries no Red SDK pin' >&2; exit 1; }
grep -q "\"red\": \"github:getcolors/red#$red_sdk_sha\"" "$red_launcher" || { echo 'launcher: red payload PINS the Red SDK at a different commit than red/package.json' >&2; exit 1; }
mkdir "$tmp/red-cold"
cp "$red_launcher" "$tmp/red-cold/red"; chmod +x "$tmp/red-cold/red"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/red-cold/colors.yml"
# One retry: a cold install fetches GitHub tarballs and a transient fetch
# failure is not a payload defect. Each attempt starts from empty caches.
cold_ok=0
for attempt in 1 2; do
  rm -rf "$tmp/red-cold/xdg" "$tmp/red-cold/bun" "$tmp/red-cold/.colors"
  if (cd "$tmp/red-cold" && XDG_CACHE_HOME="$tmp/red-cold/xdg" BUN_INSTALL_CACHE_DIR="$tmp/red-cold/bun" ./red build >"$tmp/red-cold/build.log" 2>&1); then cold_ok=1; break; fi
done
[[ $cold_ok == 1 ]] || { tail -5 "$tmp/red-cold/build.log" >&2; echo 'launcher: red payload does not build from a cold cache' >&2; exit 1; }
[[ -f "$tmp/red-cold/.colors/netbird-fixture/compute/nodes/0/node-none.tf.json" ]]
echo 'launcher: all checks passed'
