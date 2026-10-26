#!/bin/sh
# Write checksums for every asset in a directory, excluding the checksum file itself.
set -eu
cd "${1:?Usage: checksums.sh <asset-directory>}"
export LC_ALL=C
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for asset in *; do
  [ -f "$asset" ] && [ "$asset" != SHA256SUMS.txt ] || continue
  sha256sum "$asset"
done >"$tmp"
mv "$tmp" SHA256SUMS.txt
