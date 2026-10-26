#!/bin/sh
# Download, verify and install the latest Linux or macOS release.
set -eu
base=https://github.com/MDHaarith/GitGUI/releases
os=$(uname -s)
case "$os/$(uname -m)" in
  Linux/x86_64 | Darwin/arm64 | Darwin/x86_64) ;;
  *) echo "Unsupported platform: $os/$(uname -m)" >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'if [ -d "$tmp/mount" ]; then hdiutil detach "$tmp/mount" >/dev/null 2>&1 || true; fi; rm -rf "$tmp"' EXIT
# Resolve latest once so a release published during installation cannot mix versions.
release=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$base/latest")
case "$release" in
  "$base/tag/v"*) version=${release#"$base/tag/v"} ;;
  *) echo "Unexpected release URL: $release" >&2; exit 1 ;;
esac
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Invalid release version" >&2; exit 1; }
case "$os" in
  Linux) asset=GitGUI_${version}_amd64.AppImage ;;
  Darwin) asset=GitGUI_${version}_universal.dmg ;;
esac
url=$base/download/v$version
curl -fsSL "$url/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt"
curl -fsSL "$url/$asset" -o "$tmp/$asset"
expected=$(awk -v file="$asset" '$2 == file { print tolower($1) }' "$tmp/SHA256SUMS.txt")
case "$expected" in
  '' | *[!0-9a-f]*) echo "Missing or invalid checksum for $asset" >&2; exit 1 ;;
esac
[ "${#expected}" -eq 64 ] || { echo "Invalid checksum for $asset" >&2; exit 1; }
case "$os" in
  Linux) actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1) ;;
  Darwin) actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1) ;;
esac
[ "$actual" = "$expected" ] || { echo "Checksum mismatch for $asset; refusing to install." >&2; exit 1; }

case "$os" in
Linux)
  chmod +x "$tmp/$asset"
  (cd "$tmp" && env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH -u TARGET_APPIMAGE -u REDIRECT_APPIMAGE -u APPIMAGE_SILENT_INSTALL "./$asset" --appimage-extract >/dev/null)
  [ -x "$tmp/squashfs-root/AppRun" ] || { echo "AppImage contains no AppRun" >&2; exit 1; }
  apps=$HOME/Applications/GitGUI
  target=$apps/$version
  launchers=${XDG_DATA_HOME:-$HOME/.local/share}/applications
  mkdir -p "$target" "$launchers"
  rm -rf "$target/AppDir"
  mv "$tmp/squashfs-root" "$target/AppDir"
  cp "$tmp/$asset" "$target/"
  printf '%s  %s\n' "$expected" "$asset" >"$target/$asset.sha256"
  ln -sfn "$target/AppDir" "$apps/current"
  cat >"$launchers/gitgui.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=GitGUI
GenericName=Git Client
Comment=Visual Git history and everyday repository workflows
Exec=env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u REDIRECT_APPIMAGE -u TARGET_APPIMAGE -u APPIMAGE_SILENT_INSTALL -u LD_LIBRARY_PATH "$apps/current/AppRun" %F
TryExec=$apps/current/AppRun
Path=$apps/current
Icon=$apps/current/usr/share/icons/hicolor/128x128/apps/gitgui.png
StartupWMClass=gitgui
Terminal=false
Categories=Development;
EOF
  update-desktop-database "$launchers" 2>/dev/null || true
  echo "Installed GitGUI $version in $target. Launch GitGUI from the application menu."
  ;;
Darwin)
  mkdir "$tmp/mount"
  hdiutil attach "$tmp/$asset" -readonly -nobrowse -mountpoint "$tmp/mount" >/dev/null
  [ -d "$tmp/mount/GitGUI.app" ] || { echo "DMG contains no GitGUI.app" >&2; exit 1; }
  # Stage the mounted app before replacing the installed copy.
  ditto "$tmp/mount/GitGUI.app" "$tmp/GitGUI.app"
  if [ -w /Applications ]; then
    rm -rf /Applications/GitGUI.app
    ditto "$tmp/GitGUI.app" /Applications/GitGUI.app
  else
    sudo rm -rf /Applications/GitGUI.app
    sudo ditto "$tmp/GitGUI.app" /Applications/GitGUI.app
  fi
  echo "Installed GitGUI $version in /Applications."
  ;;
esac
