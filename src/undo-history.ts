import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { api, type BlameLine, type Preview, type RepoInfo } from './git.ts';
import { blameHeat, headLine, isTextField, lineRange } from './history-logic.ts';
import './undo-history.css';

interface ReflogEntry { oid: string; selector: string; timestamp: number; action: string; message: string; source: string }
interface FileRange { repoId: number; fileId: string; commit: string | null; path: string; side: 'old' | 'new'; index?: boolean }
interface Host {
  current: () => RepoInfo | null;
  busy: () => boolean;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  mutate: (label: string, action: () => Promise<RepoInfo>) => Promise<void>;
  preview: (id: string, preview: Preview) => void;
}
const historyApi = {
  label: (repoId: number) => invoke<string | null>('undo_label', { repoId }),
  undo: (repoId: number, token: string) => invoke<RepoInfo>('undo_action', { repoId, token }),
  reflog: (repoId: number) => invoke<ReflogEntry[]>('get_reflog', { repoId }),
  restore: (repoId: number, oid: string, token: string) => invoke<RepoInfo>('restore_reflog', { repoId, oid, token }),
  lines: (file: FileRange, start: number, end: number) => invoke<Preview>('line_history', { repoId: file.repoId, fileId: file.fileId, commit: file.commit, start, end }),
};
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const historyMarkup = `
  <dialog class="branch-dialog wide-dialog" id="time-machine-dialog" aria-labelledby="time-machine-title">
    <div class="dialog-head"><h2 id="time-machine-title">Time machine</h2><form method="dialog"><button>Close</button></form></div>
    <p class="muted">Latest 500 reflog entries each for HEAD and the current branch. Select an entry to preview its commit and diff.</p>
    <div id="reflog-list" class="history-list"></div><pre class="message" id="reflog-message"></pre><pre class="diff dialog-pre" id="reflog-diff"></pre>
    <div class="dialog-foot"><button id="reflog-restore" class="primary" disabled>Restore to here</button></div>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="line-history-dialog" aria-labelledby="line-history-title">
    <div class="dialog-head"><h2 id="line-history-title">History of these lines</h2><form method="dialog"><button>Close</button></form></div>
    <p class="muted">Up to 100 commits. Each commit is followed by its diff for this range.</p><pre class="diff dialog-pre" id="line-history-diff"></pre>
  </dialog>`;

export function wireHistory(host: Host) {
  const labels = new Map<number, string | null>();
  let reflogSelection: { repoId: number; entry: ReflogEntry } | null = null;
  let reflogRequest = 0;
  function updateControls() {
    const repo = host.current(), label = repo ? labels.get(repo.id) : null;
    const undo = get<HTMLButtonElement>('undo-action'); undo.hidden = !label;
    undo.disabled = host.busy() || !repo; undo.title = label ? 'Undo ' + label + ' (Ctrl+Z / ⌘Z)' : '';
    get('undo-action-label').textContent = label ? 'Last action: ' + label : '';
    get('undo-notice').hidden = !label;
    get<HTMLButtonElement>('time-machine-button').disabled = host.busy() || !repo;
    get<HTMLButtonElement>('reflog-restore').disabled = host.busy() || !reflogSelection || repo?.id !== reflogSelection.repoId || !!repo.operation || repo.detached;
  }
  async function refreshUndo() {
    const repo = host.current();
    if (repo) {
      try { labels.set(repo.id, await historyApi.label(repo.id)); }
      catch { labels.set(repo.id, null); }
    }
    updateControls();
  }
  async function undo() {
    const repo = host.current();
    if (!repo || host.busy() || !labels.get(repo.id)) return;
    await host.mutate('Undoing last action…', () => historyApi.undo(repo.id, repo.token));
  }
  get('undo-action').onclick = () => { void undo(); };
  document.addEventListener('keydown', event => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const text = target && isTextField(target.tagName, target.isContentEditable, target.closest('[role="textbox"]')?.getAttribute('role') ?? null);
    if (event.defaultPrevented || event.repeat || text || document.querySelector('dialog[open]') || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    const repo = host.current();
    if (repo && !host.busy() && labels.get(repo.id)) { event.preventDefault(); void undo(); }
  });
  get('time-machine-button').onclick = () => {
    const repo = host.current(); if (!repo || host.busy()) return;
    reflogSelection = null; get('reflog-message').textContent = ''; get('reflog-diff').replaceChildren(); updateControls();
    get<HTMLDialogElement>('time-machine-dialog').showModal(); get('reflog-list').textContent = 'Loading reflog…';
    void host.run('Reading reflog…', async () => {
      const entries = await historyApi.reflog(repo.id).catch(error => { get('reflog-list').textContent = String(error); throw error; });
      if (host.current()?.id !== repo.id) return;
      const list = get('reflog-list'); list.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'reflog-entry';
        row.textContent = `${new Date(entry.timestamp * 1000).toLocaleString()} · ${entry.source} · ${entry.oid.slice(0, 8)} · ${entry.action} · ${entry.message}`;
        row.title = entry.selector;
        row.onclick = () => {
          if (host.busy()) return;
          const request = ++reflogRequest; reflogSelection = null; updateControls();
          void host.run('Previewing reflog entry…', async () => {
            const [commit, diff] = await Promise.all([api.details(repo.id, entry.oid), api.commitDiff(repo.id, entry.oid, null)]).catch(error => { get('reflog-message').textContent = String(error); throw error; });
            if (request !== reflogRequest || host.current()?.id !== repo.id || !get<HTMLDialogElement>('time-machine-dialog').open) return;
            list.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === row)));
            get('reflog-message').textContent = `${commit.oid}\n${commit.author} · ${new Date(commit.timestamp * 1000).toLocaleString()}\n\n${commit.message}`;
            host.preview('reflog-diff', diff); reflogSelection = { repoId: repo.id, entry }; updateControls();
          });
        };
        list.append(row);
      }
      if (!entries.length) list.textContent = 'No reflog entries yet.';
    });
  };
  get('reflog-restore').onclick = async () => {
    const selection = reflogSelection, repo = host.current();
    if (!selection || !repo || host.busy() || repo.id !== selection.repoId) return;
    if (!await confirm(`Restore ${repo.branch ?? 'the current branch'} to ${selection.entry.oid.slice(0, 8)}? Tracked files will be replaced. A checkpoint saves your current files first.`, { title: 'Restore to here', kind: 'warning' })) return;
    if (host.current()?.id !== repo.id || host.busy()) return;
    get<HTMLDialogElement>('time-machine-dialog').close();
    await host.mutate('Restoring from time machine…', () => historyApi.restore(repo.id, selection.entry.oid, repo.token));
  };

  async function showLines(file: FileRange, start: number, end: number) {
    const range = lineRange(start, end);
    if (!range || host.busy() || host.current()?.id !== file.repoId) return;
    get('line-history-title').textContent = `History · ${file.path}:${range[0]}–${range[1]}`;
    get('line-history-diff').textContent = 'Reading line history…'; get<HTMLDialogElement>('line-history-dialog').showModal();
    await host.run('Reading line history…', async () => {
      try {
        let target = range;
        if (file.index) {
          const staged = await api.workingDiff(file.repoId, file.fileId, true);
          if (staged.truncated || staged.binary) throw new Error('Cannot map this range to HEAD. Choose its lines in File history instead.');
          const start = headLine(range[0], staged.text), end = headLine(range[1], staged.text);
          if (start === null || end === null) { get('line-history-diff').textContent = 'This range includes newly staged lines. Choose committed lines, or select a range in File history.'; return; }
          target = [start, end];
        }
        const preview = await historyApi.lines(file, ...target);
        if (host.current()?.id === file.repoId) host.preview('line-history-diff', preview);
      } catch (error) { get('line-history-diff').textContent = String(error); throw error; }
    });
  }

  const bindings = new Map<string, { file: FileRange; start: HTMLInputElement; end: HTMLInputElement; toolbar: HTMLElement }>();
  function bindDiff(id: string, file: FileRange | null) {
    let binding = bindings.get(id);
    if (!file) { if (binding) binding.toolbar.hidden = true; return; }
    if (!binding) {
      const toolbar = document.createElement('div'); toolbar.className = 'line-history-controls';
      const inputs = ['From line', 'To line'].map(label => {
        const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '1000000'; input.value = '1'; input.setAttribute('aria-label', label);
        const wrapper = document.createElement('label'); wrapper.append(label + ' ', input); toolbar.append(wrapper); return input;
      });
      const action = document.createElement('button'); action.type = 'button'; action.textContent = 'History of these lines'; toolbar.append(action);
      const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = 'Select lines, or click then Shift-click a line.'; toolbar.append(hint);
      get(id).before(toolbar);
      action.onclick = () => { const current = bindings.get(id); if (current && !current.toolbar.hidden) void showLines(current.file, Number(current.start.value), Number(current.end.value)); };
      const pick = (node: Node | null) => {
        const row = (node instanceof Element ? node : node?.parentElement)?.closest('.diff-line');
        const current = bindings.get(id); if (!row || !current) return null;
        if (id === 'file-blame-list') return Number((row as HTMLElement).dataset.line);
        const numbers = row.querySelectorAll<HTMLElement>('.line-number');
        return Number(numbers[current.file.side === 'old' ? 0 : 1]?.textContent) || null;
      };
      get(id).addEventListener('click', event => {
        const current = bindings.get(id), line = pick(event.target as Node);
        if (!current || !line || (event.target as Element).closest('button')) return;
        if (!event.shiftKey) current.start.value = String(line);
        current.end.value = String(line);
      });
      get(id).addEventListener('mouseup', () => {
        const selection = window.getSelection(), current = bindings.get(id);
        if (!selection || selection.isCollapsed || !current) return;
        if (!get(id).contains(selection.anchorNode) || !get(id).contains(selection.focusNode)) return;
        const start = pick(selection.anchorNode), end = pick(selection.focusNode);
        if (start && end) { current.start.value = String(start); current.end.value = String(end); }
      });
      binding = { file, start: inputs[0], end: inputs[1], toolbar }; bindings.set(id, binding);
    }
    binding.file = file; binding.toolbar.hidden = false; binding.start.value = '1'; binding.end.value = '1';
  }
  function heatmap(id: number, fileId: string, commit: string | null, path: string, lines: BlameLine[]) {
    const container = get('file-blame-list');
    const times = lines.map(line => line.timestamp); const oldest = Math.min(...times), newest = Math.max(...times);
    [...container.children].forEach((node, index) => {
      const line = lines[index]; if (!line || !(node instanceof HTMLElement)) return;
      node.classList.add('blame-heat', 'diff-line'); node.dataset.line = String(index + 1);
      node.style.backgroundColor = `rgba(94, 106, 210, ${blameHeat(line.timestamp, oldest, newest)})`;
      node.title = new Date(line.timestamp * 1000).toLocaleString();
    });
    get('file-history-dialog').querySelector('.blame-legend')?.remove();
    const legend = document.createElement('p'); legend.className = 'blame-legend muted';
    legend.append('Commit age: ');
    for (const [label, alpha] of [['Newest', 0.22], ['Oldest', 0.04]] as const) {
      const item = document.createElement('span'); item.textContent = label; item.style.backgroundColor = `rgba(94, 106, 210, ${alpha})`; legend.append(item);
    }
    if (lines.length) container.before(legend);
    bindDiff('file-blame-list', lines.length ? { repoId: id, fileId, commit, path, side: 'new' } : null);
  }
  return { refreshUndo, updateControls, bindDiff, heatmap };
}
