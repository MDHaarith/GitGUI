#!/bin/sh
# Fill the cask and winget manifests from a published release's final checksums.
set -eu
[ "$#" -eq 1 ] || { echo "Usage: $0 <version>" >&2; exit 1; }
version=${1#v}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Invalid version: $version" >&2; exit 1; }
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/MDHaarith/GitGUI/releases/download/v$version/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt"
checksum() {
  hash=$(awk -v file="$1" '$2 == file { print tolower($1) }' "$tmp/SHA256SUMS.txt")
  case "$hash" in
    '' | *[!0-9a-f]*) echo "Missing or invalid checksum for $1" >&2; exit 1 ;;
  esac
  [ "${#hash}" -eq 64 ] || { echo "Invalid checksum for $1" >&2; exit 1; }
  printf '%s\n' "$hash"
}
dmg=$(checksum "GitGUI_${version}_universal.dmg")
exe=$(checksum "GitGUI_${version}_x64-setup.exe")
sed -e "s/^  version \".*\"/  version \"$version\"/" \
    -e "s/^  sha256 \".*\"/  sha256 \"$dmg\"/" \
    packaging/homebrew/gitgui.rb >"$tmp/gitgui.rb"
mv "$tmp/gitgui.rb" packaging/homebrew/gitgui.rb
for manifest in packaging/winget/*.yaml; do
  sed -e "s/^PackageVersion: .*/PackageVersion: '$version'/" \
      -e "s|^    InstallerUrl: .*|    InstallerUrl: https://github.com/MDHaarith/GitGUI/releases/download/v$version/GitGUI_${version}_x64-setup.exe|" \
      -e "s/^    InstallerSha256: .*/    InstallerSha256: '$exe'/" \
      "$manifest" >"$tmp/manifest.yaml"
  mv "$tmp/manifest.yaml" "$manifest"
done
echo "Updated Homebrew and winget files for $version. Review before submitting."
