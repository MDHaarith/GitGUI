# GitGUI for VS Code

Open a workspace repository in the [GitGUI desktop app](https://github.com/MDHaarith/GitGUI/releases) using **GitGUI: Open Repository in GitGUI**, the Git Source Control title bar button, or a folder's Explorer context menu. With several workspace folders and no active editor, choose a folder from the picker.

The GitGUI desktop app must be installed separately. The extension detects the Linux AppRun installation (then `gitgui` on PATH), `/Applications/GitGUI.app` on macOS, and the per-user Windows installation. Set `gitgui.executablePath` in User Settings to the absolute executable path to override detection (on macOS, use the binary inside the app bundle).

Install a downloaded or locally packaged VSIX:

```sh
code --install-extension gitgui-0.1.0.vsix
```

To package from this directory, run `npm run package`. Tests use `npm test`. There is no build step or runtime dependency. Local folders are supported; remote workspace folders cannot be opened in the local desktop app.
