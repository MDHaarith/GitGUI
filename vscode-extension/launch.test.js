const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchCommand } = require('./launch');

const folder = '/projects/repo with spaces; $(echo hello)';
const env = { HOME: '/home/test', PATH: '/usr/local/bin:/usr/bin', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' };
const appRun = '/home/test/Applications/GitGUI/current/AppRun';

function launch(platform, files, configured = '', environment = env) {
  return launchCommand(platform, folder, {
    env: environment, exists: candidate => files.includes(candidate), configured
  });
}

test('Linux prefers the installed AppRun over PATH', () => {
  assert.deepEqual(launch('linux', [appRun, '/usr/bin/gitgui']), { command: appRun, args: [folder] });
});

test('Linux falls back to gitgui on PATH', () => {
  assert.deepEqual(launch('linux', ['/usr/bin/gitgui']), { command: '/usr/bin/gitgui', args: [folder] });
});

test('Linux ignores empty and relative PATH entries', () => {
  assert.equal(launch('linux', ['gitgui', 'bin/gitgui'], '', { PATH: ':bin' }), null);
});

test('macOS opens a new app instance and passes the folder as one argument', () => {
  assert.deepEqual(launch('darwin', ['/Applications/GitGUI.app']), {
    command: 'open', args: ['-n', '-a', 'GitGUI', '--args', folder]
  });
});

for (const name of ['gitgui.exe', 'GitGUI.exe']) {
  test(`Windows detects ${name}`, () => {
    const executable = `C:\\Users\\Test\\AppData\\Local\\GitGUI\\${name}`;
    assert.deepEqual(launch('win32', [executable]), { command: executable, args: [folder] });
  });
}

test('an executable override takes precedence on every platform', () => {
  const executable = '/custom/GitGUI executable';
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(launch(platform, [executable, appRun, '/Applications/GitGUI.app'], executable), {
      command: executable, args: [folder]
    });
  }
});

test('a missing override does not fall back to another installation', () => {
  assert.equal(launch('linux', [appRun], '/missing/gitgui'), null);
});

test('missing installations return null on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32', 'unsupported']) {
    assert.equal(launch(platform, []), null);
    assert.equal(launch(platform, [], '', {}), null);
  }
});
