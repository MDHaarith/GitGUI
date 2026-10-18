#!/bin/sh
# Build the GitGUI AppImage and copy it, with its SHA-256, into an output folder.
# Usage: npm run appimage [-- <output folder>]   (default: artifacts/appimage)
# CI runs this on every push (.github/workflows/appimage.yml).
set -eu
cd "$(dirname "$0")/.."
out=${1:-artifacts/appimage}
version=$(node -p 'require("./package.json").version')
commit=$(git rev-parse --short=8 HEAD 2>/dev/null || echo unknown)
bundle=src-tauri/target/release/bundle/appimage
built=$bundle/GitGUI_${version}_amd64.AppImage

# AppImage-based IDEs leak launcher variables that break packaging.
# APPIMAGE_EXTRACT_AND_RUN lets the bundler's linuxdeploy run without FUSE (CI runners, containers).
rm -f "$built"
env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  npm run tauri -- build --bundles appimage

# The bundler can report success without writing the file (AppImageLauncher intercepts linuxdeploy).
[ -s "$built" ] || { echo "The build finished but produced no AppImage at $built" >&2; exit 1; }
# An AppImage is an ELF executable with the type-2 magic "AI\2" at offset 8.
[ "$(head -c 4 "$built" | od -An -c | tr -d ' ')" = "177ELF" ] &&
  [ "$(dd if="$built" bs=1 skip=8 count=3 2>/dev/null | od -An -tx1 | tr -d ' ')" = "414902" ] ||
  { echo "$built is not a type-2 AppImage" >&2; exit 1; }

mkdir -p "$out"
name=GitGUI_${version}_${commit}_x86_64.AppImage
cp "$built" "$out/$name"
chmod +x "$out/$name"
(cd "$out" && sha256sum "$name" >"$name.sha256")
echo "Built $out/$name ($(du -h "$out/$name" | cut -f1))"
