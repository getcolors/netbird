#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed goldens; this is the net across colours:
# each fixture is rendered by green, red, and blue into separate work
# directories and the trees must be identical — and the template trees each
# colour carries must be identical too, because the copies are the mechanism
# (red/resources and blue's embedded resources are copies of green's tree, not
# references to it).
#
# Two fixtures, because the SSH Keypair Standard has two modes and parity means
# both keygen and opt-out hold in every colour.
#
# Renders resolve each colour's package from this working tree (the *_LIB_ROOT
# overrides), while green, once, red, and blue stay on their pins — a change
# that lands here passes parity before it is pushed or pinned anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

build_variant() {
  local variant=$1
  for colour in green red blue; do
    sed "s#WORKDIR#$tmp/$variant/$colour#" "$root/test/fixtures/$variant.yml" \
      > "$tmp/$variant-$colour.yml"
  done
  (cd "$root/green" && NETBIRD_LIB_ROOT="$root" ./green build -f "$tmp/$variant-green.yml" >/dev/null)
  (cd "$root/red" && NETBIRD_LIB_ROOT="$root/red" ./red build -f "$tmp/$variant-red.yml" >/dev/null)
  (cd "$root/blue" && uv run python -m package_netbird_blue build -f "$tmp/$variant-blue.yml" >/dev/null)
  diff -r "$tmp/$variant/green" "$tmp/$variant/red"
  diff -r "$tmp/$variant/green" "$tmp/$variant/blue"
}

build_variant colors
build_variant optout

diff -r "$root/green/src/resources/io/github/getcolors/netbird" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/netbird" "$root/blue/src/package_netbird_blue/resources"

echo "green, red, and blue NetBird artifacts are byte-identical"
