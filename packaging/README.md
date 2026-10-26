# Distribution handoff

Nothing here submits packages automatically. Wait for the release's Cross-platform
workflow to finish: `scripts/release.sh` initially publishes Linux checksums; the
final CI job replaces `SHA256SUMS.txt` with checksums for every uploaded asset
(excluding the checksum file itself and GitHub's generated source archives).
The checksum job still runs if a marketplace rejects a publication, provided the
installer and VSIX uploads succeeded. Downloaders refuse missing or mismatched
checksums, including while the cross-platform assets are still being published.

## Homebrew and winget

The committed files deliberately contain version and checksum placeholders.
After all platform assets are available, fill them locally with:

```sh
sh scripts/update-packaging.sh 0.20.0
```

This downloads only that release's `SHA256SUMS.txt`, requires both the universal
DMG and x64 NSIS entries, and updates the files in place. It can be rerun for the
next version. Review the diff and test the actual packages before submitting.

- **Homebrew:** use a GitHub account to create a tap (`homebrew-<tap>`), copy
  `homebrew/gitgui.rb` to its `Casks/` directory, and test with
  `brew install --cask <owner>/<tap>/gitgui`. For the community repository, fork
  `Homebrew/homebrew-cask`, copy to `Casks/g/gitgui.rb`, run
  `brew audit --cask --online gitgui` and `brew style --cask gitgui`, then open a
  pull request if the cask meets the acceptance policy. See the
  [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook) and
  [acceptable casks policy](https://docs.brew.sh/Acceptable-Casks).
- **winget:** fork `microsoft/winget-pkgs`, copy the three YAML files to
  `manifests/m/MDHaarith/GitGUI/<version>/`, and run
  `winget validate --manifest <directory>` on Windows. Test a silent install,
  upgrade and uninstall, then submit the files in a pull request. See
  [Microsoft's manifest guide](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest).

The manifests use the 1.6.0 multi-file schema and the default Tauri per-user x64
NSIS installer. Keep the scope, architecture and asset names aligned with Tauri
if its bundle configuration changes. The Linux portable archive contains the
release binary, the existing GitGUI MIT license, both font licenses and the glib
license; it still needs system Git and the Tauri WebKit/GTK runtime libraries.
The Fedora-built Linux packages retain the host's glibc requirement.
macOS and Windows binaries are currently unsigned; first submissions and signing
requirements need maintainer review.

Run `sh scripts/test-packaging.sh` for an offline check using dummy assets and a
temporary home directory. It checks checksum regeneration, tamper rejection,
Linux installation layout and repeatable manifest updates without network access.

## Editor marketplaces

On published releases, `cross-platform.yml` packages and uploads the VSIX, then
publishes that same file independently to each configured registry. Missing
secrets print a skip message. Add repository Actions secrets only when ready:

- `VSCE_PAT`: Azure DevOps personal access token with **Marketplace: Manage**
  permission for the **MDHaarith** VS Code Marketplace publisher. Create/verify
  that publisher first. See
  [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
- `OVSX_PAT`: Open VSX personal access token. Create an Open VSX account, sign
  the Eclipse publisher agreement, and create/claim the **MDHaarith** namespace
  matching `vscode-extension/package.json`. See
  [Open VSX publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).

The maintainer must assign a new extension version before each new marketplace
publication; the desktop and extension versions are independent. Re-publishing
an existing extension version is rejected by the registries. No token is needed
to build or attach the VSIX to GitHub releases.
