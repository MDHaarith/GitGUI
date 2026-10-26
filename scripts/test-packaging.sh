#!/bin/sh
# Offline checksum smoke test; no builds, installs or release mutations.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/assets"
cat >"$tmp/assets/GitGUI_1.2.3_amd64.AppImage" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = --appimage-extract ]
mkdir squashfs-root
printf '#!/bin/sh\nexit 0\n' >squashfs-root/AppRun
chmod +x squashfs-root/AppRun
EOF
printf 'dummy DMG\n' >"$tmp/assets/GitGUI_1.2.3_universal.dmg"
printf 'dummy NSIS\n' >"$tmp/assets/GitGUI_1.2.3_x64-setup.exe"
printf 'dummy VSIX\n' >"$tmp/assets/gitgui-0.1.0.vsix"
sh scripts/checksums.sh "$tmp/assets"
cp "$tmp/assets/SHA256SUMS.txt" "$tmp/first"
sh scripts/checksums.sh "$tmp/assets"
cmp "$tmp/first" "$tmp/assets/SHA256SUMS.txt"
(cd "$tmp/assets" && sha256sum -c SHA256SUMS.txt)
[ "$(wc -l <"$tmp/assets/SHA256SUMS.txt" | tr -d ' ')" -eq 4 ]
printf 'tampered\n' >>"$tmp/assets/GitGUI_1.2.3_amd64.AppImage"
if (cd "$tmp/assets" && sha256sum -c SHA256SUMS.txt >/dev/null 2>&1); then
  echo "Tampered asset passed checksum verification" >&2
  exit 1
fi

# A fake downloader exercises the installer's refusal before it executes an asset.
mkdir "$tmp/bin" "$tmp/home"
cat >"$tmp/bin/curl" <<'EOF'
#!/bin/sh
set -eu
case "$*" in
  *url_effective*) printf 'https://github.com/MDHaarith/GitGUI/releases/tag/v1.2.3' ;;
  *)
    asset=${2##*/}
    cp "$PACKAGING_ASSETS/$asset" "$4"
    ;;
esac
EOF
cat >"$tmp/bin/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac
EOF
chmod +x "$tmp/bin/"*
if PATH="$tmp/bin:$PATH" HOME="$tmp/home" PACKAGING_ASSETS="$tmp/assets" sh "$root/scripts/get.sh" >"$tmp/log" 2>&1; then
  echo "Installer accepted a tampered asset" >&2
  exit 1
fi
case "$(cat "$tmp/log")" in
  *'Checksum mismatch'*) ;;
  *) cat "$tmp/log" >&2; exit 1 ;;
esac
[ ! -d "$tmp/home/Applications" ]
sed '$d' "$tmp/assets/GitGUI_1.2.3_amd64.AppImage" >"$tmp/original"
mv "$tmp/original" "$tmp/assets/GitGUI_1.2.3_amd64.AppImage"
PATH="$tmp/bin:$PATH" HOME="$tmp/home" XDG_DATA_HOME="$tmp/home/.local/share" PACKAGING_ASSETS="$tmp/assets" sh "$root/scripts/get.sh"
[ -x "$tmp/home/Applications/GitGUI/current/AppRun" ]
[ -f "$tmp/home/.local/share/applications/gitgui.desktop" ]
(cd "$tmp/home/Applications/GitGUI/1.2.3" && sha256sum -c GitGUI_1.2.3_amd64.AppImage.sha256)

# Update copies of the manifests twice; never fill the checked-in placeholders.
mkdir -p "$tmp/project/scripts"
cp -R packaging "$tmp/project/"
cp scripts/update-packaging.sh "$tmp/project/scripts/"
for version in 1.2.3 2.3.4; do
  PATH="$tmp/bin:$PATH" PACKAGING_ASSETS="$tmp/assets" sh "$tmp/project/scripts/update-packaging.sh" "$version"
  [ "$(awk '/^  version / { gsub(/"/, "", $2); print $2 }' "$tmp/project/packaging/homebrew/gitgui.rb")" = "$version" ]
  dmg=$(awk -v file="GitGUI_${version}_universal.dmg" '$2 == file { print $1 }' "$tmp/assets/SHA256SUMS.txt")
  exe=$(awk -v file="GitGUI_${version}_x64-setup.exe" '$2 == file { print $1 }' "$tmp/assets/SHA256SUMS.txt")
  [ "$(awk '/^  sha256 / { gsub(/"/, "", $2); print $2 }' "$tmp/project/packaging/homebrew/gitgui.rb")" = "$dmg" ]
  installer=$tmp/project/packaging/winget/MDHaarith.GitGUI.installer.yaml
  [ "$(sed -n 's/^    InstallerSha256: //p' "$installer")" = "'$exe'" ]
  [ "$(sed -n 's/^    InstallerUrl: //p' "$installer")" = "https://github.com/MDHaarith/GitGUI/releases/download/v$version/GitGUI_${version}_x64-setup.exe" ]
  for manifest in "$tmp/project/packaging/winget/"*.yaml; do
    [ "$(sed -n 's/^PackageVersion: //p' "$manifest")" = "'$version'" ]
  done
  sed 's/1\.2\.3/2.3.4/g' "$tmp/assets/SHA256SUMS.txt" >"$tmp/next"
  mv "$tmp/next" "$tmp/assets/SHA256SUMS.txt"
done
echo "Packaging checks passed (checksums, tamper rejection, dummy install and manifest updates)."
