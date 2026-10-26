import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { commandText, terminalApi } from './terminal-api.ts';
import type { RepoInfo } from './git.ts';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

interface Shell { terminal: Terminal; fit: FitAddon; host: HTMLElement; ready: boolean; exited: boolean; input: Promise<void> }

export function wireTerminalPanel() {
  const panel = document.createElement('section'); panel.className = 'terminal-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Terminal and Git output');
  panel.innerHTML = `<header class="terminal-head"><div role="tablist" aria-label="Developer panel"><button id="terminal-tab" role="tab" aria-selected="true" aria-controls="terminal-shells">Terminal</button><button id="output-tab" role="tab" aria-selected="false" aria-controls="git-output" tabindex="-1">Git output</button></div><span class="spacer"></span><button id="terminal-restart" hidden>Restart shell</button><button id="terminal-hide" aria-label="Hide terminal panel">Close</button></header><div id="terminal-shells" role="tabpanel" aria-labelledby="terminal-tab"></div><div id="git-output" role="tabpanel" aria-labelledby="output-tab" tabindex="0" hidden><p class="muted">No Git commands recorded yet.</p></div>`;
  document.querySelector('.repository-main')!.append(panel);
  const shells = panel.querySelector<HTMLElement>('#terminal-shells')!;
  const log = panel.querySelector<HTMLElement>('#git-output')!;
  const tab = panel.querySelector<HTMLButtonElement>('#terminal-tab')!;
  const outputTab = panel.querySelector<HTMLButtonElement>('#output-tab')!;
  const restart = panel.querySelector<HTMLButtonElement>('#terminal-restart')!;
  const toggle = document.getElementById('terminal-toggle') as HTMLButtonElement;
  const sessions = new Map<number, Shell>();
  let active: RepoInfo | null = null;
  let output = false;
  let loadingLog = false;
  let logVersion = '';

  function fit() {
    const shell = active && sessions.get(active.id);
    if (shell && !panel.hidden && !output) shell.fit.fit();
  }
  function updateRestart() { restart.hidden = output || !active || !sessions.get(active.id)?.exited; }
  function start(repo: RepoInfo) {
    const existing = sessions.get(repo.id);
    if (existing) { existing.host.hidden = false; fit(); updateRestart(); return; }
    const host = document.createElement('div'); host.className = 'terminal-host'; shells.append(host);
    const terminal = new Terminal({ fontFamily: '"Geist Mono", monospace', fontSize: 12, scrollback: 5000, screenReaderMode: true, theme: { background: '#0f1011', foreground: '#d0d6e0', cursor: '#828fff', selectionBackground: '#393b41' } });
    const addon = new FitAddon(); terminal.loadAddon(addon); terminal.open(host);
    const shell: Shell = { terminal, fit: addon, host, ready: false, exited: false, input: Promise.resolve() }; sessions.set(repo.id, shell);
    terminal.attachCustomKeyEventHandler(event => !(event.ctrlKey && event.code === 'Backquote'));
    terminal.onData(data => {
      if (!shell.ready) return;
      const bytes = new TextEncoder().encode(data);
      shell.input = shell.input.then(async () => {
        for (let at = 0; at < bytes.length; at += 16384) {
          if (sessions.get(repo.id) !== shell || !shell.ready) return;
          await terminalApi.input(repo.id, bytes.subarray(at, at + 16384));
        }
      }).catch(error => { terminal.writeln('\r\nInput failed: ' + String(error)); });
    });
    terminal.onResize(({ cols, rows }) => {
      if (shell.ready) void terminalApi.resize(repo.id, cols, rows).catch(error => terminal.writeln('\r\nResize failed: ' + String(error)));
    });
    addon.fit();
    void terminalApi.start(repo.id, terminal.cols, terminal.rows, event => {
      if (sessions.get(repo.id) !== shell) return;
      if (event.kind === 'data') terminal.write(new Uint8Array(event.value), () => { void terminalApi.ack(repo.id).catch(() => {}); });
      else { shell.ready = false; shell.exited = true; terminal.writeln('\r\n' + event.value); updateRestart(); }
    }).then(() => {
      if (sessions.get(repo.id) !== shell) return;
      shell.ready = !shell.exited; fit();
      if (shell.ready) void terminalApi.resize(repo.id, terminal.cols, terminal.rows).catch(error => terminal.writeln('\r\nResize failed: ' + String(error)));
      if (active?.id === repo.id && !panel.hidden && !output) terminal.focus();
    }).catch(error => { if (sessions.get(repo.id) !== shell) return; shell.exited = true; terminal.writeln('\r\nCould not open terminal: ' + String(error)); updateRestart(); });
  }
  async function refreshLog() {
    if (panel.hidden || !output || loadingLog) return;
    loadingLog = true;
    try {
      const entries = await terminalApi.log();
      const version = JSON.stringify(entries);
      if (version === logVersion) return;
      logVersion = version;
      const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
      log.replaceChildren();
      if (!entries.length) { log.textContent = 'No Git commands recorded yet.'; return; }
      for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'git-output-entry';
        const meta = document.createElement('div'); meta.className = 'muted';
        meta.textContent = new Date(entry.time).toLocaleTimeString() + ' · ' + entry.durationMs + ' ms · ' + (entry.success ? 'exit 0' : 'failed' + (entry.exitStatus === null ? '' : ' (exit ' + entry.exitStatus + ')'));
        const command = document.createElement('code'); command.textContent = commandText(entry.args);
        const root = document.createElement('div'); root.className = 'muted'; root.textContent = entry.root;
        row.append(meta, command, root);
        if (entry.stderr) { const error = document.createElement('pre'); error.textContent = entry.stderr; row.append(error); }
        log.append(row);
      }
      if (bottom) log.scrollTop = log.scrollHeight;
    } catch (error) { log.textContent = 'Could not load Git output: ' + String(error); logVersion = ''; }
    finally { loadingLog = false; }
  }
  function chooseOutput(value: boolean) {
    output = value; shells.hidden = value; log.hidden = !value;
    for (const [control, selected] of [[tab, !value], [outputTab, value]] as const) { control.setAttribute('aria-selected', String(selected)); control.tabIndex = selected ? 0 : -1; }
    updateRestart();
    if (value) void refreshLog();
    else if (active && !panel.hidden) { start(active); sessions.get(active.id)?.terminal.focus(); }
  }
  function show(value: boolean) {
    panel.hidden = !value; toggle.setAttribute('aria-expanded', String(value));
    if (value) chooseOutput(output); else toggle.focus();
  }
  toggle.onclick = () => { if (active) show(!!panel.hidden); };
  panel.querySelector<HTMLButtonElement>('#terminal-hide')!.onclick = () => show(false);
  tab.onclick = () => chooseOutput(false); outputTab.onclick = () => chooseOutput(true);
  panel.querySelector('[role="tablist"]')!.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault(); chooseOutput(key === 'End' || (key !== 'Home' && !output)); (output ? outputTab : tab).focus();
  });
  restart.onclick = () => {
    const repo = active; if (!repo) return;
    restart.disabled = true;
    void terminalApi.stop(repo.id).then(() => { close(repo.id); if (active?.id === repo.id) start(repo); }).catch(error => { sessions.get(repo.id)?.terminal.writeln('\r\nCould not restart shell: ' + String(error)); }).finally(() => { restart.disabled = false; });
  };
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Backquote' && active && !document.querySelector('dialog[open]')) {
      event.preventDefault(); show(!!panel.hidden);
    }
  });
  new ResizeObserver(fit).observe(shells);
  window.setInterval(() => { void refreshLog(); }, 1000);
  function close(id: number) {
    const shell = sessions.get(id); if (!shell) return;
    sessions.delete(id); shell.terminal.dispose(); shell.host.remove();
  }
  return {
    close,
    repository(repo: RepoInfo | null) {
      const changed = active?.id !== repo?.id; active = repo;
      for (const [id, shell] of sessions) shell.host.hidden = id !== repo?.id;
      if (!repo) show(false);
      else if (changed && !panel.hidden && !output) start(repo);
      updateRestart();
    },
  };
}
