const path = require('node:path');

function launchCommand(platform, folder, { env, exists, configured }) {
  if (configured) {
    return exists(configured) ? { command: configured, args: [folder] } : null;
  }

  if (platform === 'darwin') {
    return exists('/Applications/GitGUI.app')
      ? { command: 'open', args: ['-n', '-a', 'GitGUI', '--args', folder] }
      : null;
  }

  let candidates = [];
  if (platform === 'linux') {
    if (env.HOME) {
      candidates.push(path.posix.join(env.HOME, 'Applications/GitGUI/current/AppRun'));
    }
    candidates.push(...(env.PATH || '').split(':')
      .filter(directory => path.posix.isAbsolute(directory))
      .map(directory => path.posix.join(directory, 'gitgui')));
  } else if (platform === 'win32' && env.LOCALAPPDATA) {
    candidates = ['gitgui.exe', 'GitGUI.exe'].map(name =>
      path.win32.join(env.LOCALAPPDATA, 'GitGUI', name));
  }

  const command = candidates.find(candidate => exists(candidate));
  return command ? { command, args: [folder] } : null;
}

module.exports = { launchCommand };
