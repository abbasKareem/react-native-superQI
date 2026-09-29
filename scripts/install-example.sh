#!/usr/bin/env bash
# Packs the package exactly as `npm publish` would and installs that tarball into example/,
# so the example exercises the published files rather than the source tree.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
rm -f example/*.tgz
tarball="$(npm pack --silent --pack-destination example | tail -n 1)"
cd example
npm install --no-audit --no-fund "./$tarball"
echo "Installed example/$tarball"
