#!/bin/sh
# Build GitGUI for this operating system and install it, removing older versions first.
# Usage: npm run install:app
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
bundle=src-tauri/target/release/bundle
# AppImage-based IDEs leak launcher variables that break packaging and the launched app.
clean="env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH -u TARGET_APPIMAGE -u REDIRECT_APPIMAGE -u APPIMAGE_SILENT_INSTALL"

case "$(uname -s)" in
Linux)
  appdir=$bundle/appimage/GitGUI.AppDir
  rm -rf "$appdir"
  # The bundler can fail after the AppDir is complete (AppImageLauncher intercepts linuxdeploy); only the AppDir is installed.
  $clean npm run tauri -- build --bundles appimage || [ -x "$appdir/AppRun" ] || { echo "Build failed: no AppDir at $appdir" >&2; exit 1; }
  [ -x "$appdir/AppRun" ] || { echo "Build produced no AppDir at $appdir" >&2; exit 1; }

  apps=$HOME/Applications/GitGUI
  launchers=${XDG_DATA_HOME:-$HOME/.local/share}/applications
  if pgrep -f "$apps/current/" >/dev/null 2>&1; then echo "Note: a running GitGUI keeps the old version until you close it."; fi
  # Remove every older install: versioned folders and AppImageLauncher copies with their launchers.
  for old in "$apps"/*/; do [ -d "$old" ] && [ "$(basename "$old")" != current ] && rm -rf "$old" && echo "Removed $old"; done
  for old in "$HOME"/Applications/GitGUI_*.AppImage; do [ -e "$old" ] && rm -f "$old" && echo "Removed $old"; done
  grep -l "Applications/GitGUI_" "$launchers"/appimagekit_*.desktop 2>/dev/null | while read -r entry; do rm -f "$entry" && echo "Removed $entry"; done

  target=$apps/$version
  mkdir -p "$target" "$launchers"
  cp -a "$appdir" "$target/AppDir"
  image=$bundle/appimage/GitGUI_${version}_amd64.AppImage
  if [ -f "$image" ]; then cp "$image" "$target/" && (cd "$target" && sha256sum "$(basename "$image")" >"$(basename "$image").sha256"); fi
  ln -sfn "$target/AppDir" "$apps/current"
  cat >"$launchers/gitgui.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=GitGUI
GenericName=Git Client
Comment=Visual Git history and everyday repository workflows
Exec=env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE -u REDIRECT_APPIMAGE -u TARGET_APPIMAGE -u APPIMAGE_SILENT_INSTALL -u LD_LIBRARY_PATH $apps/current/AppRun %F
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
  # shortcut: untested on macOS; needs an .icns icon in tauri.conf.json if the build asks for one.
  $clean npm run tauri -- build --bundles app
  rm -rf /Applications/GitGUI.app
  cp -R "$bundle/macos/GitGUI.app" /Applications/
  echo "Installed GitGUI $version in /Applications."
  ;;
MINGW* | MSYS* | CYGWIN*)
  # shortcut: untested on Windows (run from Git Bash); the NSIS installer replaces the previous install in place.
  npm run tauri -- build --bundles nsis
  installer=$(ls "$bundle"/nsis/GitGUI_"${version}"_*-setup.exe)
  "$installer" /S
  echo "Installed GitGUI $version."
  ;;
*)
  echo "Unsupported operating system: $(uname -s)" >&2
  exit 1
  ;;
esac
