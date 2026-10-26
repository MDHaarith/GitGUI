#!/bin/sh
# Build the Linux installers on this machine and publish them as the latest GitHub release.
# Usage: npm run release (after the version commit; the post-commit hook made the tag).
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
bundle=src-tauri/target/release/bundle
git rev-parse -q --verify "refs/tags/v$version" >/dev/null || { echo "No tag v$version; commit the version bump first." >&2; exit 1; }
env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH -u TARGET_APPIMAGE -u REDIRECT_APPIMAGE -u APPIMAGE_SILENT_INSTALL npm run tauri -- build --bundles appimage rpm deb
image=$bundle/appimage/GitGUI_${version}_amd64.AppImage
rpm=$bundle/rpm/GitGUI-${version}-1.x86_64.rpm
deb=$bundle/deb/GitGUI_${version}_amd64.deb
[ -f "$image" ] && [ -f "$rpm" ] && [ -f "$deb" ] || { echo "Build did not produce $image, $rpm and $deb" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
portable=GitGUI_${version}_linux_x86_64
mkdir "$tmp/$portable" "$tmp/assets"
cp src-tauri/target/release/gitgui "$tmp/$portable/"
cp vscode-extension/LICENSE src/assets/fonts/*-OFL.txt "$tmp/$portable/"
cp vendor/glib/LICENSE "$tmp/$portable/GLIB-LICENSE"
tar -czf "$tmp/assets/$portable.tar.gz" -C "$tmp" "$portable"
cp "$image" "$rpm" "$deb" "$tmp/assets/"
sh scripts/checksums.sh "$tmp/assets"
git push origin HEAD "v$version"
notes=$(awk "/^## $version /{f=1;next} /^## /{f=0} f" CHANGELOG.md)
gh release create "v$version" "$tmp/assets/"* --title "GitGUI v$version" --notes "$notes" --latest
