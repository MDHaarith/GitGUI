import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, confirm, message as nativeMessage } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, type Checkpoint, type RepoInfo, type GraphPage, type CommitDetails, type Preview, type FileInfo } from './git.ts';
import { findCommits, layoutHistory, paintGraph, type Layout } from './graph.ts';
import { numberDiff } from './diff.ts';
import { wireDropdown } from './dropdown.ts';
import { explainError, explainState } from './explain.ts';
import './styles.css';

const app = document.getElementById('app')!;
app.innerHTML = `
  <svg class="chrome-symbols" aria-hidden="true"><defs>
    <symbol id="chrome-branch" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/></symbol>
    <symbol id="chrome-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
    <symbol id="chrome-fetch" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></symbol>
    <symbol id="chrome-pull" viewBox="0 0 24 24"><path d="M12 3v13M7 11l5 5 5-5"/></symbol>
    <symbol id="chrome-push" viewBox="0 0 24 24"><path d="M12 21V8M7 13l5-5 5 5"/></symbol>
    <symbol id="chrome-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></symbol>
    <symbol id="chrome-panel" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/></symbol>
    <symbol id="chrome-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></symbol>
    <symbol id="chrome-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
    <symbol id="chrome-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></symbol>
  </defs></svg>
  <header class="toolbar">
    <span class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v10a4 4 0 0 0 4 4h1m5-14v2a5 5 0 0 1-5 5H7"/><circle cx="7" cy="5" r="2.5"/><circle cx="17" cy="5" r="2.5"/><circle cx="15" cy="19" r="2.5"/></svg>GitGUI<span class="app-version" id="app-version" hidden></span></span>
    <button class="secondary" id="open-repo">Open repository</button><button class="secondary" id="init-repo">Init repository</button>
    <select id="recent-repos" aria-label="Repository"><option value="">Recent repositories</option></select>
    <div class="toolbar-actions"><button id="fetch" data-repo><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-fetch"/></svg>Fetch</button><button id="pull" data-repo><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-pull"/></svg>Pull</button><button id="push" data-repo><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-push"/></svg>Push</button>
    <button id="refresh" data-repo><svg class="chrome-icon" id="refresh-icon" aria-hidden="true"><use href="#chrome-refresh"/></svg>Refresh</button></div>
    <span class="repo-name" id="repo-name"><span id="repo-label">No repository selected</span><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-chevron"/></svg><span class="context-branch" id="repo-branch" hidden></span></span>
  </header>
  <nav class="scopebar" aria-label="History and repository actions">
    <label class="muted" for="scope">Scope</label><select id="scope" data-repo><option value="">All branches</option></select>
    <div class="history-search" role="search" aria-label="Search loaded history">
      <div class="search-field"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-search"/></svg><input id="history-search" type="search" aria-label="Search loaded commits by message, author, or hash" placeholder="Search loaded commits" autocomplete="off"></div>
      <span id="search-count" class="muted" aria-live="polite"></span>
      <button id="search-prev" aria-label="Previous matching commit" title="Previous match (Shift+Enter)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-up"/></svg></button><button id="search-next" aria-label="Next matching commit" title="Next match (Enter)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-down"/></svg></button>
    </div>
    <span class="spacer"></span>
    <button id="details-button" data-repo><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-panel"/></svg>Details</button>
    <button id="checkpoints-button" data-repo title="Save or restore snapshots of your files">Checkpoints</button>
    <button class="chip" id="changes-button" data-repo>Changes <span class="mono" id="changes-count">0</span></button>
  </nav>
  <div class="errorbar" id="error" role="alert" hidden><p id="error-text"></p><button id="dismiss-error" aria-label="Dismiss error">Close</button></div>
  <div class="hintbar" id="git-hint" role="status" hidden></div>
  <main class="workspace" id="workspace">
    <aside class="branch-sidebar" id="branch-sidebar" aria-label="Branches and tags" hidden>
      <header class="panelbar"><h2>Repository</h2><span class="spacer"></span><button id="branch-actions" aria-label="Manage branches" data-repo>Manage</button></header>
      <nav class="ref-list" id="ref-list" aria-label="History scopes"></nav>
    </aside>
    <div class="repository-main">
    <div class="history-review">
    <section class="history" id="history" aria-label="Repository history">
      <div class="empty" id="welcome"><span class="eyebrow">A clear view of your code</span><h1>Your repository,<br>in view.</h1><p>Follow branches and merges. Review changes.<br>Make your next commit with confidence.</p><button class="primary" id="welcome-open">Open repository <span aria-hidden="true">↗</span></button><span class="welcome-note">Local repositories. Offline fonts. Your workflow.</span></div>
      <div class="empty" id="empty-history" hidden><h1>No commits yet</h1><p>Open Changes to stage files and create the first commit.</p></div>
      <div class="graph-scene" id="graph-scene" hidden>
        <table class="history-table" aria-label="Commit graph and history">
          <colgroup><col class="graph"><col><col class="author"><col class="date"><col class="sha"></colgroup>
          <thead><tr><th scope="col" aria-label="Graph"></th><th class="description" scope="col">Description</th><th scope="col">Author</th><th class="date-heading" scope="col">Date</th><th scope="col">Commit</th></tr></thead>
          <tbody id="history-rows"></tbody>
        </table>
        <svg class="graph-svg" id="graph" role="img" aria-label="Commit parent relationships"></svg>
      </div>
      <button class="load-more" id="load-more" hidden>Load more history</button>
    </section>
    <aside id="details" class="details-panel" aria-labelledby="detail-title" tabindex="-1" hidden>
      <div class="dialog-head"><h2 id="detail-title">Commit details</h2><button id="close-details">Close</button></div>
      <div class="metadata"><span id="detail-author"></span><span id="detail-date"></span><input id="detail-sha" readonly aria-label="Full commit object ID"></div>
      <pre class="message" id="detail-message"></pre><div class="parents" id="detail-parents"></div>
      <div class="detail-controls"><label for="detail-parent">Compare to</label><select id="detail-parent"></select><label for="detail-file">Files</label><select id="detail-file"></select><button id="detail-file-prev" aria-label="Previous changed file" title="Previous file (Alt+Up)">↑</button><button id="detail-file-next" aria-label="Next changed file" title="Next file (Alt+Down)">↓</button></div>
      <pre class="diff" id="detail-diff"></pre>
    </aside>
    </div>
    <section class="changes" id="changes" aria-label="Working changes" hidden>
      <header class="panelbar"><h2>Working changes</h2><span id="operation-note" class="muted"></span><span class="spacer"></span><button id="close-changes">Close</button></header>
      <div class="changes-body">
        <div class="file-list" id="file-list"></div>
        <div class="working-preview"><div class="preview-label" id="working-path">Select a file to review its diff.</div><pre class="diff" id="working-diff"></pre></div>
        <form class="composer" id="commit-form">
          <label for="summary">Summary</label><input id="summary" required maxlength="1000" autocomplete="off" placeholder="Describe this commit">
          <label for="body">Description <span class="muted">(optional)</span></label><textarea id="body" maxlength="64000" rows="3"></textarea>
          <div class="commit-row"><span id="version-controls"><label for="bump">Version <span class="mono" id="repo-version"></span></label> <select id="bump" data-repo><option value="minor">Minor · feature</option><option value="patch">Patch · fix</option><option value="major">Major · breaking</option><option value="">No bump</option></select></span><button id="enable-versioning" data-repo title="Block secrets and failing tests, and give every code commit its own version">Enable safeguards</button></div>
          <div class="commit-row"><span id="staged-count">0 staged files</span><button class="primary" id="commit-button" type="submit" data-repo>Commit staged</button></div>
        </form>
      </div>
    </section>
    </div>
  </main>
  <footer class="footer"><span class="footer-segment"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-branch"/></svg><span id="branch-status">No repository</span></span><span class="footer-segment" id="sync-status" hidden><span id="ahead-count">+0</span><span id="behind-count">−0</span></span><span class="footer-segment" id="loaded-count" hidden></span><span class="footer-segment" id="status" role="status" aria-live="polite">Ready</span><span class="footer-segment" id="operation-feedback" hidden><progress id="operation-progress" aria-label="Git operation progress" max="100"></progress><span id="operation-elapsed"></span></span></footer>
  <dialog class="branch-dialog" id="branches" aria-labelledby="branches-title">
    <div class="dialog-head"><h2 id="branches-title">Branches</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <div class="form-grid"><label for="branch-select">Switch to a local branch</label><select id="branch-select"></select><div class="row"><button class="chip" id="switch-branch">Switch branch</button></div>
      <label for="branch-name">Create branch</label><input id="branch-name" placeholder="feature/name" maxlength="1024" autocomplete="off">
      <label for="branch-start">Start at</label><select id="branch-start"><option value="head">Current HEAD</option><option value="selected">Selected commit</option></select>
      <div class="row"><button class="chip" id="create-branch">Create branch</button></div><p id="branch-note"></p>
    </div>
  </dialog>
  <dialog class="branch-dialog" id="checkpoint-dialog" aria-labelledby="checkpoint-title">
    <div class="dialog-head"><h2 id="checkpoint-title">Checkpoints</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="checkpoint-form" class="form-grid"><label for="checkpoint-name">Save your current files</label><input id="checkpoint-name" maxlength="200" autocomplete="off" placeholder="Before asking the AI to …"><div class="row"><button class="chip" type="submit">Save checkpoint</button></div></form>
    <p class="muted">GitGUI also saves one automatically when you come back to the window (at most every 10 minutes). Restoring puts files back exactly as they were; your current files are saved as a checkpoint first, and files created later are kept.</p>
    <ol class="checkpoint-list" id="checkpoint-list"></ol>
  </dialog>
  <dialog class="branch-dialog" id="remote-dialog" aria-labelledby="remote-title">
    <div class="dialog-head"><h2 id="remote-title">Choose remote</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="remote-form" class="form-grid"><label for="remote-select">Remote</label><select id="remote-select"></select><p id="remote-url"></p><p id="remote-note"></p><button class="primary" id="remote-submit" type="submit">Continue</button></form>
  </dialog>
`;

function get<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
function button(id: string) { return get<HTMLButtonElement>(id); }
function input(id: string) { return get<HTMLInputElement>(id); }
function select(id: string) { return get<HTMLSelectElement>(id); }
function dialog(id: string) { return get<HTMLDialogElement>(id); }
function option(value: string, label: string) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
const scopeDropdown = wireDropdown(select('scope'));
const repoDropdown = wireDropdown(select('recent-repos'), () => button('open-repo').click());

let repo: RepoInfo | null = null;
let page: GraphPage | null = null;
let layout: Layout = layoutHistory([]);
let selected: string | null = null;
let details: CommitDetails | null = null;
let scope: string | null = null;
let limit = 200;
let busy = false;
let writing = false;
let epoch = 0;
let detailRequest = 0;
let workingRequest = 0;
let workingFile: { id: string; staged: boolean } | null = null;
let remoteAction: 'fetch' | 'push' = 'fetch';
const checked = { staged: new Set<string>(), unstaged: new Set<string>() };
const historyRows = new Map<string, HTMLTableRowElement>();
const graphNodes = new Map<string, Element>();
const detailReads = new Set<Promise<unknown>>();
let renderedSelection: string | null = null;
let searchMatches: string[] = [];
let operationSequence = 0;
let operationLabel = '';

function stored(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable; the current draft remains in memory. */ } }
function removeStored(key: string) { try { localStorage.removeItem(key); } catch { /* Keep the successful commit usable without storage. */ } }
function recentRepositories(): string[] {
  try {
    const paths: unknown = JSON.parse(stored('recentRepositories') ?? '[]');
    return Array.isArray(paths) ? [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.startsWith('/') && path.length <= 32768 && !path.includes('\0')))].slice(0, 8) : [];
  } catch { return []; }
}
function renderRecentRepositories() {
  const control = select('recent-repos'); control.replaceChildren(option('', 'Recent repositories'));
  for (const path of recentRepositories()) control.append(option(path, path.split('/').filter(Boolean).pop() + ' · ' + path));
  control.value = repo?.root ?? ''; control.disabled = busy || !recentRepositories().length;
  control.title = busy ? 'Wait for the current Git operation to finish.' : 'Switch to a recently opened repository';
}
function draftKey() { return 'draft:' + (repo?.root ?? ''); }
function saveDraft() { if (repo) save(draftKey(), JSON.stringify({ summary: input('summary').value, body: get<HTMLTextAreaElement>('body').value })); }
function restoreDraft() {
  input('summary').value = ''; get<HTMLTextAreaElement>('body').value = '';
  try { const value = JSON.parse(stored(draftKey()) ?? '{}'); input('summary').value = typeof value.summary === 'string' ? value.summary : ''; get<HTMLTextAreaElement>('body').value = typeof value.body === 'string' ? value.body : ''; } catch { /* Ignore a malformed saved draft. */ }
}
function notify(message: string) { get('status').textContent = message; }
function report(error: unknown) { const why = explainError(String(error)); get('error-text').textContent = (why ? why + '\n\n' : '') + String(error).slice(0, 4000); get('error').hidden = false; notify('Operation failed. Review the message and refresh if needed.'); }
function normal() { return !!repo && !repo.operation; }
function stagedFiles() { return repo?.files.filter(file => file.index !== '.' && !file.untracked && !file.conflicted) ?? []; }
function disable(id: string, reason: string) {
  const control = get<HTMLButtonElement | HTMLSelectElement>(id);
  control.disabled = !!reason; control.title = reason;
  if (reason) control.setAttribute('aria-description', reason); else control.removeAttribute('aria-description');
}
function updateControls() {
  const unavailable = busy ? 'Wait for the current Git operation to finish.' : !repo ? 'Open a repository first.' : '';
  const blocked = unavailable || (repo?.operation ? 'Finish the ' + repo.operation + ' in the terminal, then refresh.' : '');
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-repo]').forEach(node => { node.disabled = !!unavailable; if (unavailable) node.setAttribute('aria-description', unavailable); else node.removeAttribute('aria-description'); });
  disable('open-repo', busy ? unavailable : ''); disable('init-repo', busy ? unavailable : ''); disable('welcome-open', busy ? unavailable : '');
  disable('details-button', unavailable || (!selected ? 'Select a commit to review its details.' : ''));
  disable('fetch', blocked || (!repo?.remotes.length ? 'Configure a remote with Git, then refresh.' : ''));
  disable('pull', blocked || (!repo?.upstream ? 'Publish this branch to set its upstream before pulling.' : repo.files.length ? 'Commit or resolve working changes before pulling.' : ''));
  disable('push', blocked || (!repo?.branch ? 'Switch to a local branch before pushing.' : !repo.remotes.length ? 'Configure a remote with Git, then refresh.' : ''));
  disable('load-more', unavailable || (limit >= 10000 ? '10,000 commits loaded. Choose a narrower history scope.' : ''));
  disable('commit-button', blocked || (!stagedFiles().length ? 'Stage at least one file before committing.' : !input('summary').value.trim() ? 'Enter a commit summary.' : ''));
  disable('switch-branch', blocked || (!select('branch-select').value ? 'Choose a local branch.' : ''));
  disable('create-branch', blocked || (!repo?.head ? 'Create the first commit before creating another branch.' : !input('branch-name').value.trim() ? 'Enter a branch name.' : ''));
  disable('remote-submit', unavailable || (!select('remote-select').value ? 'Choose a configured remote.' : ''));
  select('scope').disabled = busy || !repo;
  input('history-search').disabled = busy || !repo;
  button('search-prev').disabled = busy || !searchMatches.length; button('search-next').disabled = busy || !searchMatches.length;
  button('details-button').setAttribute('aria-expanded', String(!get('details').hidden));
  updateDetailControls();
  renderRecentRepositories();
  scopeDropdown.sync(); repoDropdown.sync();
  get('loaded-count').hidden = !repo; get('loaded-count').textContent = (page?.commits.length ?? 0) + ' commits loaded';
  get('app').setAttribute('aria-busy', String(busy));
}
async function run(label: string, action: () => Promise<void>, mutating = false) {
  if (busy) return;
  busy = true; writing = mutating; operationLabel = label; operationSequence++;
  if (mutating) {
    detailRequest++; details = null;
    if (!get('details').hidden) get('detail-diff').textContent = 'Waiting for the Git operation to finish…';
  }
  get('history').inert = true; notify(label); updateControls();
  const start = performance.now();
  get('operation-feedback').hidden = false; get('operation-progress').removeAttribute('value'); get('operation-elapsed').textContent = '0s';
  const timer = window.setInterval(() => { get('operation-elapsed').textContent = Math.floor((performance.now() - start) / 1000) + 's'; }, 1000);
  try {
    // Finish preview reads before writes try to lock the shared repository state.
    if (mutating) await Promise.allSettled(detailReads);
    await action();
  }
  catch (error) {
    report(error);
    if (repo) {
      try { repo = await api.status(repo.id); epoch++; renderInfo(); renderFiles(); await loadGraph(); await refreshWorkingPreview(); } catch { clearWorkingPreview(); }
    }
  } finally {
    window.clearInterval(timer); get('operation-feedback').hidden = true;
    busy = false; writing = false; get('history').inert = false; if (repo) renderFiles(); updateControls();
    if (!get('details').hidden && selected && details?.oid !== selected) void openDetails();
  }
}
function progressReporter() {
  const sequence = operationSequence;
  return (message: string) => {
    if (!busy || sequence !== operationSequence) return;
    notify(operationLabel + ' · ' + message);
    const percent = /\b(\d{1,3})%/.exec(message);
    if (percent && Number(percent[1]) <= 100) get<HTMLProgressElement>('operation-progress').value = Number(percent[1]);
    else get('operation-progress').removeAttribute('value');
  };
}
function short(oid: string) { return oid.slice(0, 8); }
function relative(timestamp: number) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const age = (Date.now() - date.getTime()) / 1000;
  if (age < 0) return date.toLocaleDateString();
  if (age < 60) return 'now';
  if (age < 3600) return Math.floor(age / 60) + ' min';
  if (age < 86400) return Math.floor(age / 3600) + ' h';
  if (age < 604800) return Math.floor(age / 86400) + ' d';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(age > 31536000 ? { year: 'numeric' } : {}) });
}
function renderInfo() {
  get('welcome').hidden = !!repo;
  get('branch-sidebar').hidden = !repo;
  get('workspace').classList.toggle('repository-open', !!repo);
  get('repo-label').textContent = repo ? repo.root.split('/').filter(Boolean).pop()! : 'No repository selected';
  get('repo-branch').textContent = repo?.branch ?? 'detached HEAD'; get('repo-branch').hidden = !repo;
  get('repo-name').title = repo?.root ?? '';
  get('branch-status').textContent = repo ? (repo.branch ?? 'detached ' + short(repo.head ?? '')) : 'No repository';
  get('sync-status').hidden = !repo; get('ahead-count').textContent = '+' + (repo?.ahead ?? 0); get('behind-count').textContent = '−' + (repo?.behind ?? 0);
  get('branch-status').title = repo?.upstream ? 'Upstream: ' + repo.upstream : 'No upstream';
  get('changes-count').textContent = String(repo?.files.length ?? 0);
  get('staged-count').textContent = stagedFiles().length + ' staged ' + (stagedFiles().length === 1 ? 'file' : 'files');
  get('version-controls').hidden = !repo?.versioning; get('enable-versioning').hidden = !repo || repo.versioning;
  get('repo-version').textContent = repo?.version ? 'v' + repo.version : 'none';
  const notes = repo ? explainState(repo) : []; get('git-hint').textContent = notes.join(' '); get('git-hint').hidden = !notes.length;
  get('operation-note').textContent = repo?.operation ? 'Finish ' + repo.operation + ' in the terminal, then refresh.' : '';
}
function scopeOptions() {
  const control = select('scope'); control.replaceChildren(option('', 'All branches'));
  const list = get('ref-list'); const scroll = list.scrollTop; list.replaceChildren();
  const all = document.createElement('button'); all.type = 'button'; all.className = 'ref-item'; all.dataset.repo = ''; all.dataset.scope = '';
  all.textContent = 'All branches'; all.setAttribute('aria-pressed', String(scope === null));
  all.addEventListener('click', () => { void changeScope(null); }); list.append(all);
  for (const kind of ['local', 'remote', 'tag']) {
    const refs = page?.refs.filter(reference => reference.kind === kind) ?? [];
    if (!refs.length) continue;
    const group = document.createElement('optgroup'); group.label = kind === 'local' ? 'Local branches' : kind === 'remote' ? 'Remote branches' : 'Tags';
    const section = document.createElement('section'); section.className = 'ref-group';
    const title = document.createElement('h3'); title.textContent = group.label + ' · ' + refs.length; section.append(title);
    for (const ref of refs) {
      const scopeOption = option(ref.id, ref.name); scopeOption.dataset.current = String(ref.isHead); group.append(scopeOption);
      const item = document.createElement('button'); item.type = 'button'; item.className = 'ref-item'; item.dataset.repo = ''; item.dataset.scope = ref.id; item.dataset.kind = kind;
      item.title = ref.fullName; item.setAttribute('aria-label', kind + ' ' + ref.name + (ref.isHead ? ', current branch' : ''));
      item.setAttribute('aria-pressed', String(scope === ref.id));
      const name = document.createElement('span'); name.className = 'ref-label'; name.textContent = ref.name; item.append(name);
      if (ref.isHead) { const head = document.createElement('span'); head.className = 'ref-head'; head.textContent = 'HEAD'; item.append(head); }
      item.addEventListener('click', () => { void changeScope(ref.id); }); section.append(item);
    }
    control.append(group); list.append(section);
  }
  control.value = scope ?? ''; list.scrollTop = scroll;
}
async function changeScope(next: string | null) {
  if (busy || !repo || next === scope) return;
  const fromSidebar = get('ref-list').contains(document.activeElement);
  scope = next; limit = 200; get('history').scrollTop = 0;
  await run('Loading branch history…', async () => { await loadGraph(); notify('History scope updated'); });
  if (fromSidebar) [...get('ref-list').querySelectorAll<HTMLButtonElement>('button')].find(item => item.dataset.scope === (scope ?? ''))?.focus({ preventScroll: true });
}
function updateSelection() {
  for (const oid of new Set([renderedSelection, selected])) {
    if (!oid) continue;
    const active = oid === selected; const row = historyRows.get(oid);
    row?.classList.toggle('selected', active);
    row?.querySelector('button.subject')?.setAttribute('aria-pressed', String(active));
    graphNodes.get(oid)?.setAttribute('stroke-width', active ? '2' : '1.75');
  }
  renderedSelection = selected;
  updateSearchCount();
  updateControls();
}
function choose(oid: string, focus = false) {
  if (busy) return;
  selected = oid; updateSelection();
  if (focus) historyRows.get(oid)?.querySelector<HTMLButtonElement>('button.subject')?.focus({ preventScroll: true });
  if (!get('details').hidden && !busy) void openDetails();
}
function updateSearchCount() {
  const index = selected ? searchMatches.indexOf(selected) : -1;
  get('search-count').textContent = input('history-search').value.trim() ? (searchMatches.length ? (index >= 0 ? (index + 1) + '/' : '') + searchMatches.length + ' matches' : 'No matches') + (page?.hasMore ? ' · more history available' : '') : '';
  get('search-count').title = get('search-count').textContent ?? '';
}
function searchHistory(jump = false) {
  searchMatches = findCommits(page?.commits ?? [], input('history-search').value);
  for (const row of historyRows.values()) row.classList.remove('search-match');
  for (const oid of searchMatches) historyRows.get(oid)?.classList.add('search-match');
  updateSearchCount(); updateControls();
  if (jump && searchMatches.length) {
    choose(searchMatches[0]); historyRows.get(searchMatches[0])?.scrollIntoView({ block: 'nearest' });
  }
}
function nextMatch(direction: number) {
  if (!searchMatches.length) return;
  const current = selected ? searchMatches.indexOf(selected) : -1;
  const index = current < 0 ? (direction > 0 ? 0 : searchMatches.length - 1) : (current + direction + searchMatches.length) % searchMatches.length;
  choose(searchMatches[index]); historyRows.get(searchMatches[index])?.scrollIntoView({ block: 'nearest' });
}
function renderGraph() {
  const scroll = get('history').scrollTop;
  layout = layoutHistory(page?.commits ?? [], page?.refs ?? []);
  document.documentElement.style.setProperty('--graph-width', Math.max(132, layout.lanes * 18 + 28) + 'px');
  const rows = get('history-rows'); const fragment = document.createDocumentFragment();
  historyRows.clear(); graphNodes.clear(); renderedSelection = null;
  const refsByCommit = new Map<string, GraphPage['refs']>();
  for (const reference of page?.refs ?? []) {
    const refs = refsByCommit.get(reference.target) ?? []; refs.push(reference); refsByCommit.set(reference.target, refs);
  }
  get('graph-scene').hidden = !page?.commits.length;
  get('empty-history').hidden = !repo || !!page?.commits.length;
  get('load-more').hidden = !page?.hasMore;
  if (limit >= 10000 && page?.hasMore) button('load-more').textContent = '10,000 commits loaded; choose a narrower scope';
  else button('load-more').textContent = 'Load more history';
  for (const row of layout.rows) {
    const commit = row.commit;
    const tr = document.createElement('tr'); tr.dataset.oid = commit.oid; historyRows.set(commit.oid, tr);
    const gutter = document.createElement('td');
    const description = document.createElement('td'); description.className = 'description';
    const content = document.createElement('div'); content.className = 'commit-content';
    for (const reference of refsByCommit.get(commit.oid) ?? []) {
      const ref = document.createElement('button'); ref.type = 'button'; ref.className = 'ref ' + reference.kind;
      ref.textContent = (reference.isHead ? 'HEAD → ' : '') + reference.name;
      ref.style.color = row.color; ref.title = reference.fullName;
      ref.setAttribute('aria-label', reference.kind + ' ' + reference.name + ', select its tip');
      ref.addEventListener('click', () => choose(commit.oid)); content.append(ref);
    }
    const subject = document.createElement('button'); subject.type = 'button'; subject.className = 'subject'; subject.textContent = commit.subject || '(no subject)';
    subject.title = commit.subject; subject.setAttribute('aria-label', commit.subject + ', ' + commit.author + ', ' + short(commit.oid) + ', ' + commit.parents.length + ' parents');
    subject.addEventListener('click', () => choose(commit.oid));
    subject.addEventListener('dblclick', () => { if (get('details').hidden) void openDetails(); });
    subject.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); const wasHidden = get('details').hidden; choose(commit.oid); if (wasHidden) void openDetails(); return; }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const index = layout.rows.indexOf(row); const next = layout.rows[Math.max(0, Math.min(layout.rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      choose(next.commit.oid, true);
      historyRows.get(next.commit.oid)?.scrollIntoView({ block: 'nearest' });
    });
    if (page?.head === commit.oid && !refsByCommit.get(commit.oid)?.some(ref => ref.isHead)) {
      const head = document.createElement('span'); head.className = 'ref'; head.textContent = 'HEAD (detached)'; head.style.color = row.color; content.prepend(head);
    }
    content.append(subject); description.append(content);
    const author = document.createElement('td'); author.className = 'author-cell'; author.textContent = commit.author; author.title = commit.author;
    const date = document.createElement('td'); date.className = 'date-cell'; date.textContent = relative(commit.timestamp); date.title = new Date(commit.timestamp * 1000).toString();
    const sha = document.createElement('td'); sha.className = 'sha-cell'; sha.textContent = commit.shortOid; sha.title = commit.oid;
    tr.append(gutter, description, author, date, sha); fragment.append(tr);
  }
  rows.replaceChildren(fragment);
  paintGraph(get('graph') as unknown as SVGSVGElement, layout, layout.rows.length * 28 + (layout.pending.length ? 10 : 0), 28, selected, page?.head ?? null);
  for (const node of get('graph').querySelectorAll('[data-node]')) graphNodes.set(node.getAttribute('data-node')!, node);
  scopeOptions(); searchHistory(); updateSelection(); get('history').scrollTop = scroll;
}
async function loadGraph(more = false) {
  if (!repo) return;
  const id = repo.id; const currentEpoch = epoch;
  let result: GraphPage;
  try { result = await api.graph(id, scope, limit, more ? page?.graphId ?? null : null); }
  catch (error) {
    if (!scope || !String(error).includes('Unknown history scope')) throw error;
    scope = null; result = await api.graph(id, null, limit);
  }
  if (currentEpoch !== epoch || repo?.id !== id) return;
  page = result;
  if (!page.commits.some(commit => commit.oid === selected)) selected = page.commits.find(commit => commit.oid === page?.head)?.oid ?? page.commits[0]?.oid ?? null;
  renderGraph();
}
async function refresh() {
  if (!repo) return;
  get('working-diff').replaceChildren();
  epoch++; repo = await api.status(repo.id); renderInfo(); renderFiles(); await loadGraph();
  await refreshWorkingPreview();
  notify('Refreshed ' + new Date().toLocaleTimeString());
}
async function chooseRepository() {
  await run('Opening repository…', async () => {
    const path = await open({ directory: true, multiple: false, title: 'Open a Git repository' });
    if (typeof path !== 'string') { notify('Ready'); return; }
    await openPath(path);
  });
}
async function initRepository() {
  await run('Initializing repository…', async () => {
    const path = await open({ directory: true, multiple: false, title: 'Choose a folder for the new repository' });
    if (typeof path !== 'string') { notify('Ready'); return; }
    await openPath(path, api.init);
  });
}
async function enableVersioning() {
  if (!repo || busy) return;
  if (!await confirm('GitGUI will install pre-commit and post-commit hooks and add VERSION, CHANGELOG.md, .env in .gitignore, and an AGENTS.md section where missing. Commits will then be blocked if they contain API keys or .env files, and code commits need passing tests, a version bump, and a changelog entry. Each new version is tagged.', { title: 'Enable safeguards', kind: 'info' })) return;
  await mutate('Enabling safeguards…', () => api.enableVersioning(repo!.id));
}
let lastAutoCheckpoint = 0;
async function autoCheckpoint() {
  if (!repo?.files.length || Date.now() - lastAutoCheckpoint < 10 * 60_000) return;
  lastAutoCheckpoint = Date.now();
  await api.checkpoint(repo.id, 'Automatic checkpoint').catch(() => { /* Best effort: never interrupt the user. */ });
}
function renderCheckpoints(list: Checkpoint[]) {
  const items = list.map(checkpoint => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = checkpoint.label;
    const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = new Date(checkpoint.timestamp * 1000).toLocaleString() + ' · ' + checkpoint.summary;
    const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = 'Restore'; restore.setAttribute('aria-label', 'Restore checkpoint ' + checkpoint.label);
    restore.onclick = () => { void restoreCheckpoint(checkpoint); };
    item.append(title, meta, restore); return item;
  });
  if (!items.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = 'No checkpoints yet. Save one before letting an AI change your code.'; items.push(empty); }
  get('checkpoint-list').replaceChildren(...items);
}
async function openCheckpoints() {
  if (!repo || busy) return;
  await run('Loading checkpoints…', async () => { renderCheckpoints(await api.checkpoints(repo!.id)); dialog('checkpoint-dialog').showModal(); notify('Ready'); });
}
async function saveCheckpoint() {
  if (!repo || busy) return;
  const name = input('checkpoint-name').value.trim() || 'Checkpoint';
  await run('Saving checkpoint…', async () => {
    const before = (await api.checkpoints(repo!.id))[0]?.oid;
    const list = await api.checkpoint(repo!.id, name); renderCheckpoints(list); input('checkpoint-name').value = '';
    notify(list[0]?.oid !== before ? 'Checkpoint saved' : 'Nothing changed since HEAD or the last checkpoint');
  }, true);
}
async function restoreCheckpoint(checkpoint: Checkpoint) {
  if (!repo || busy) return;
  if (!await confirm(`Restore "${checkpoint.label}" (${new Date(checkpoint.timestamp * 1000).toLocaleString()})? Your current files are saved as a checkpoint first.`, { title: 'Restore checkpoint', kind: 'warning' })) return;
  dialog('checkpoint-dialog').close();
  await mutate('Restoring checkpoint…', () => api.restoreCheckpoint(repo!.id, checkpoint.oid, repo!.token));
}
async function openPath(path: string, load = api.open) {
  const next = await load(path); saveDraft();
  for (const id of ['branches', 'remote-dialog']) if (dialog(id).open) dialog(id).close();
  get('details').hidden = true;
  details = null; detailRequest++; workingRequest++;
  repo = next; epoch++; scope = null; limit = 200; page = null; selected = null; workingFile = null;
  checked.staged.clear(); checked.unstaged.clear(); input('branch-name').value = '';
  input('history-search').value = ''; searchMatches = [];
  save('recentRepositories', JSON.stringify([repo.root, ...recentRepositories().filter(path => path !== repo!.root)].slice(0, 8)));
  save('lastRepository', repo.root); restoreDraft(); renderInfo(); renderFiles();
  get('working-diff').replaceChildren(); get('working-path').textContent = 'Select a file to review its diff.';
  get('error').hidden = true; await loadGraph(); notify('Opened ' + repo.root);
}
function previewInto(id: string, preview: Preview) {
  const container = get(id); container.replaceChildren();
  // shortcut: render 5,000 diff lines, add virtualization when larger previews are needed.
  const lines = numberDiff(preview.text, preview.binary);
  for (const line of lines.slice(0, 5000)) {
    const span = document.createElement('span'); span.className = 'diff-line ' + line.kind;
    for (const value of [line.oldLine, line.newLine]) {
      const number = document.createElement('span'); number.className = 'line-number'; number.setAttribute('aria-hidden', 'true'); number.textContent = value === null ? '' : String(value); span.append(number);
    }
    const text = document.createElement('span'); text.className = 'diff-text'; text.textContent = line.text || ' '; span.append(text); container.append(span);
  }
  if (preview.truncated || lines.length > 5000) { const note = document.createElement('span'); note.className = 'diff-line note'; note.textContent = 'Preview truncated. Inspect the complete diff in Git for the remaining content.'; container.append(note); }
  if (!preview.text) container.textContent = 'No differences to display.';
}
async function openDetails(oid = selected, parent: string | null = null) {
  if (!repo || !oid || busy) return;
  const id = repo.id; const request = ++detailRequest;
  get('details').hidden = false; get('details').setAttribute('aria-busy', 'true'); details = null;
  get('detail-title').textContent = 'Reading ' + short(oid) + '…';
  for (const name of ['detail-author', 'detail-date', 'detail-message', 'detail-parents']) get(name).replaceChildren();
  input('detail-sha').value = oid; select('detail-parent').replaceChildren(); select('detail-file').replaceChildren(); updateDetailControls();
  get('detail-diff').textContent = 'Reading commit…'; updateControls();
  try {
    const result = await readDetail(api.details(id, oid, parent));
    if (repo?.id !== id || request !== detailRequest) return;
    details = result;
    renderDetails();
    await loadDetailDiff(request);
    if (request === detailRequest) notify('Inspecting ' + short(oid));
  } catch (error) {
    if (request === detailRequest) { get('detail-diff').textContent = 'Unable to load this commit. Select it again to retry.'; report(error); }
  } finally {
    if (request === detailRequest) { get('details').setAttribute('aria-busy', 'false'); updateDetailControls(); }
  }
}
function renderDetails() {
  if (!details) return;
  get('detail-title').textContent = details.message.split('\n')[0] || '(no subject)';
  get('detail-author').textContent = details.author + ' <' + details.email + '>';
  get('detail-date').textContent = new Date(details.timestamp * 1000).toLocaleString(); input('detail-sha').value = details.oid;
  get('detail-message').textContent = details.message.split('\n').slice(1).join('\n').trim();
  const parents = get('detail-parents'); parents.replaceChildren();
  const label = document.createElement('span'); label.className = 'muted'; label.textContent = details.shallow ? 'Shallow history boundary' : details.parents.length ? 'Parents' : 'Root commit'; parents.append(label);
  for (const parent of details.parents) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = short(parent);
    b.addEventListener('click', () => { if (busy || !repo) return; if (historyRows.has(parent)) choose(parent); else void openDetails(parent); });
    parents.append(b);
  }
  const comparisons = select('detail-parent'); comparisons.replaceChildren();
  if (!details.parents.length) comparisons.append(option('', details.shallow ? 'Parent unavailable' : 'Empty tree'));
  else details.parents.forEach((parent, index) => comparisons.append(option(parent, 'Parent ' + (index + 1) + ' · ' + short(parent))));
  comparisons.value = details.parent ?? '';
  comparisons.disabled = details.parents.length < 2;
  const files = select('detail-file'); files.replaceChildren(option('', 'All changed files (' + details.files.length + ')'));
  details.files.forEach(file => files.append(option(file.id, file.status + ' · ' + (file.oldPath ? file.oldPath + ' → ' : '') + file.path)));
  updateDetailControls();
}
function updateDetailControls() {
  const files = select('detail-file');
  files.disabled = busy || !details;
  select('detail-parent').disabled = busy || !details || details.parents.length < 2;
  button('detail-file-prev').disabled = files.disabled || files.selectedIndex <= 0;
  button('detail-file-next').disabled = files.disabled || files.selectedIndex >= files.options.length - 1;
}
function moveDetailFile(direction: number) {
  const files = select('detail-file');
  if (files.disabled) return;
  const next = Math.max(0, Math.min(files.options.length - 1, files.selectedIndex + direction));
  if (next !== files.selectedIndex) { files.selectedIndex = next; void loadDetailDiff(); }
}
async function readDetail<T>(promise: Promise<T>): Promise<T> {
  detailReads.add(promise);
  try { return await promise; } finally { detailReads.delete(promise); }
}
async function loadDetailDiff(request = ++detailRequest) {
  if (!repo || !details) return;
  const id = repo.id; const oid = details.oid;
  get('details').setAttribute('aria-busy', 'true'); get('detail-diff').textContent = 'Reading diff…'; updateDetailControls();
  try {
    const preview = await readDetail(api.commitDiff(id, oid, details.parent, select('detail-file').value || null));
    if (repo?.id === id && details?.oid === oid && request === detailRequest) previewInto('detail-diff', preview);
  } catch (error) {
    if (request === detailRequest) { get('detail-diff').textContent = 'Unable to load this diff. Select the file again to retry.'; report(error); }
  } finally {
    if (request === detailRequest) get('details').setAttribute('aria-busy', 'false');
  }
}
function closeDetails() {
  get('details').hidden = true; detailRequest++; updateControls(); button('details-button').focus();
}
function toggleChanges() {
  get('changes').hidden = !get('changes').hidden;
  button('changes-button').setAttribute('aria-pressed', String(!get('changes').hidden));
  if (!get('changes').hidden) { renderFiles(); input('summary').focus(); }
}
function renderFiles() {
  const list = get('file-list'); list.replaceChildren();
  const groups: [string, FileInfo[], boolean | null][] = [
    ['Staged', stagedFiles(), true],
    ['Unstaged / untracked', repo?.files.filter(file => !file.conflicted && (file.worktree !== '.' || file.untracked)) ?? [], false],
    ['Conflicts', repo?.files.filter(file => file.conflicted) ?? [], null],
  ];
  for (const [set, files] of [[checked.staged, groups[0][1]], [checked.unstaged, groups[1][1]]] as const) {
    const available = new Set(files.map(file => file.id));
    for (const id of set) if (!available.has(id)) set.delete(id);
  }
  for (const [name, files, staged] of groups) {
    if (!files.length && staged === null) continue;
    const heading = document.createElement('div'); heading.className = 'file-group-title';
    const label = document.createElement('span'); label.textContent = name + ' · ' + files.length; heading.append(label);
    if (staged !== null) {
      const action = document.createElement('button'); action.type = 'button'; action.dataset.stageGroup = staged ? 'staged' : 'unstaged';
      const selection = staged ? checked.staged : checked.unstaged;
      action.textContent = (staged ? 'Unstage' : 'Stage') + (selection.size ? ' selected' : ' all');
      action.disabled = busy || !normal() || !files.some(file => !file.submodule);
      action.title = busy ? 'Wait for the current Git operation to finish.' : !normal() ? 'Finish the current Git operation in the terminal, then refresh.' : !files.some(file => !file.submodule) ? 'No stageable files in this group.' : '';
      action.setAttribute('aria-label', (staged ? 'Unstage' : 'Stage') + ' selected files, or all files in this group');
      action.addEventListener('click', () => {
        const checkedIds = staged ? checked.staged : checked.unstaged;
        const ids = files.filter(file => !file.submodule && (!checkedIds.size || checkedIds.has(file.id))).map(file => file.id);
        if (repo && ids.length) void mutate(staged ? 'Unstaging files…' : 'Staging files…', () => api.stage(repo!.id, ids, staged, repo!.token));
      }); heading.append(action);
    }
    list.append(heading);
    if (!files.length) { const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = 'None'; empty.style.padding = '4px'; list.append(empty); }
    for (const file of files) {
      const row = document.createElement('div'); row.className = 'file-row' + (workingFile?.id === file.id && workingFile.staged === !!staged ? ' selected' : '');
      if (staged !== null) {
        const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = file.submodule || busy || !normal();
        const set = staged ? checked.staged : checked.unstaged; check.checked = set.has(file.id);
        check.setAttribute('aria-label', 'Select ' + file.path + ' in ' + name);
        check.addEventListener('change', () => { if (check.checked) set.add(file.id); else set.delete(file.id); const action = list.querySelector<HTMLButtonElement>('[data-stage-group="' + (staged ? 'staged' : 'unstaged') + '"]'); if (action) action.textContent = (staged ? 'Unstage' : 'Stage') + (set.size ? ' selected' : ' all'); }); row.append(check);
      }
      const kind = document.createElement('span'); kind.className = 'file-kind'; kind.textContent = file.submodule ? 'S' : file.conflicted ? 'U' : file.untracked ? '?' : staged ? file.index : file.worktree; row.append(kind);
      const nameButton = document.createElement('button'); nameButton.type = 'button'; nameButton.textContent = (file.oldPath ? file.oldPath + ' → ' : '') + file.path; nameButton.title = nameButton.textContent;
      nameButton.addEventListener('click', () => { void showWorkingFile(file, !!staged); }); row.append(nameButton); list.append(row);
    }
  }
  renderInfo();
}
async function showWorkingFile(file: FileInfo, staged: boolean) {
  if (!repo || busy) return;
  workingFile = { id: file.id, staged }; renderFiles();
  await run('Reading diff…', refreshWorkingPreview);
}
function clearWorkingPreview() {
  workingFile = null; workingRequest++; get('working-diff').replaceChildren();
  get('working-path').textContent = 'Select a file to review its diff.';
}
async function refreshWorkingPreview() {
  const selection = workingFile;
  const file = repo?.files.find(file => file.id === selection?.id && !file.conflicted && (selection.staged ? file.index !== '.' && !file.untracked : file.worktree !== '.' || file.untracked));
  if (!repo || !selection || !file) { clearWorkingPreview(); renderFiles(); return; }
  const id = repo.id; const request = ++workingRequest;
  get('working-path').textContent = (selection.staged ? 'Staged · ' : 'Working tree · ') + file.path;
  get('working-diff').textContent = 'Reading diff…';
  const preview = await api.workingDiff(id, file.id, selection.staged);
  if (repo?.id === id && request === workingRequest) previewInto('working-diff', preview);
}
async function mutate(label: string, action: () => Promise<RepoInfo>, committed = false) {
  await run(label, async () => {
    const info = await action(); repo = info; epoch++;
    checked.staged.clear(); checked.unstaged.clear(); clearWorkingPreview();
    if (committed) {
      input('summary').value = ''; get<HTMLTextAreaElement>('body').value = ''; removeStored(draftKey());
      selected = repo.head; scope = null; limit = 200;
    }
    get('working-diff').replaceChildren(); get('working-path').textContent = 'Select a file to review its diff.';
    renderInfo(); renderFiles(); await loadGraph(); get('error').hidden = true; notify('Done · repository refreshed');
  }, true);
}
async function commitChanges() {
  if (!repo || busy || button('commit-button').disabled) return;
  const message = input('summary').value.trim() + (get<HTMLTextAreaElement>('body').value.trim() ? '\n\n' + get<HTMLTextAreaElement>('body').value.trim() : '');
  let detachedOk = false;
  if (repo.detached) detachedOk = await confirm('HEAD is detached. This commit will not belong to a branch. Continue?', { title: 'Commit on detached HEAD', kind: 'warning' });
  if (repo.detached && !detachedOk) return;
  saveDraft(); await mutate('Creating commit…', () => api.commit(repo!.id, message, repo!.token, detachedOk, repo!.versioning ? select('bump').value || null : null), true);
}
function openBranches() {
  if (!repo || busy) return;
  const branches = select('branch-select'); branches.replaceChildren();
  for (const ref of page?.refs.filter(ref => ref.kind === 'local') ?? []) branches.append(option(ref.id, (ref.isHead ? '✓ ' : '') + ref.name));
  get('branch-note').textContent = repo.head ? 'Creating a branch adds a name at the chosen commit. Switching keeps Git’s normal protection for working changes.' : 'Create the first commit before creating another branch.';
  select('branch-start').options[1].disabled = !selected;
  updateControls(); dialog('branches').showModal();
}
function chooseRemote(action: 'fetch' | 'push') {
  if (!repo || busy) return;
  if (!repo.remotes.length) { report('No remote is configured. Add a remote with Git, then refresh.'); return; }
  remoteAction = action;
  const remotes = select('remote-select'); remotes.replaceChildren();
  repo.remotes.forEach(remote => remotes.append(option(remote.id, remote.name)));
  remotes.value = repo.remotes.find(remote => remote.name === 'origin')?.id ?? repo.remotes[0].id;
  get('remote-title').textContent = action === 'fetch' ? 'Fetch remote' : 'Publish branch';
  get('remote-note').textContent = action === 'fetch' ? 'Fetch updates remote-tracking history. Your checked-out branch stays in place.' : 'Publish ' + repo.branch + ' and set its upstream on this remote.';
  button('remote-submit').textContent = action === 'fetch' ? 'Fetch' : 'Publish';
  remoteUrl(); updateControls(); dialog('remote-dialog').showModal();
}
function remoteUrl() { get('remote-url').textContent = repo?.remotes.find(remote => remote.id === select('remote-select').value)?.url ?? ''; }

button('open-repo').onclick = () => { void chooseRepository(); };
select('recent-repos').onchange = () => { const path = select('recent-repos').value; if (path && path !== repo?.root) void run('Opening repository…', () => openPath(path)); };
button('welcome-open').onclick = () => { void chooseRepository(); };
button('init-repo').onclick = () => { void initRepository(); };
button('enable-versioning').onclick = () => { void enableVersioning(); };
button('checkpoints-button').onclick = () => { void openCheckpoints(); };
get<HTMLFormElement>('checkpoint-form').onsubmit = event => { event.preventDefault(); void saveCheckpoint(); };
button('refresh').onclick = () => {
  const icon = get('refresh-icon'); icon.classList.remove('spinning'); void icon.getBoundingClientRect(); icon.classList.add('spinning');
  void run('Refreshing…', refresh);
};
button('fetch').onclick = () => chooseRemote('fetch');
button('pull').onclick = () => { if (repo) void mutate('Pulling fast-forward update…', () => api.pull(repo!.id, repo!.token, progressReporter())); };
button('push').onclick = () => { if (!repo) return; if (!repo.upstream) chooseRemote('push'); else void mutate('Pushing current branch…', () => api.push(repo!.id, null, repo!.token, progressReporter())); };
button('details-button').onclick = () => { if (get('details').hidden) { void openDetails(); get('details').focus(); } else closeDetails(); };
button('close-details').onclick = closeDetails;
input('history-search').oninput = () => searchHistory(true);
input('history-search').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); input('history-search').value = ''; searchHistory(); }
};
button('search-prev').onclick = () => nextMatch(-1); button('search-next').onclick = () => nextMatch(1);
button('detail-file-prev').onclick = () => moveDetailFile(-1); button('detail-file-next').onclick = () => moveDetailFile(1);
button('branch-actions').onclick = openBranches;
button('changes-button').onclick = toggleChanges;
button('close-changes').onclick = toggleChanges;
button('dismiss-error').onclick = () => { get('error').hidden = true; };
button('load-more').onclick = () => { if (!page || busy) return; limit += 200; void run('Loading history…', async () => { await loadGraph(true); notify(page!.commits.length + ' commits loaded'); }); };
select('scope').onchange = () => { void changeScope(select('scope').value || null); };
select('detail-file').onchange = () => { void loadDetailDiff(); };
select('detail-parent').onchange = () => { if (details) void openDetails(details.oid, select('detail-parent').value || null); };
input('detail-sha').onclick = () => input('detail-sha').select();
input('summary').oninput = () => { saveDraft(); updateControls(); };
get<HTMLTextAreaElement>('body').oninput = saveDraft;
get<HTMLFormElement>('commit-form').onsubmit = event => { event.preventDefault(); void commitChanges(); };
input('branch-name').oninput = updateControls;
select('branch-select').onchange = updateControls;
button('switch-branch').onclick = () => { if (!repo) return; const id = select('branch-select').value; dialog('branches').close(); scope = null; void mutate('Switching branch…', () => api.switchBranch(repo!.id, id, repo!.token)); };
button('create-branch').onclick = () => { if (!repo) return; const name = input('branch-name').value.trim(); const oid = select('branch-start').value === 'selected' ? selected : null; dialog('branches').close(); void mutate('Creating branch…', () => api.createBranch(repo!.id, name, oid, repo!.token)); };
select('remote-select').onchange = remoteUrl;
get<HTMLFormElement>('remote-form').onsubmit = event => { event.preventDefault(); if (!repo || busy) return; const remoteId = select('remote-select').value; dialog('remote-dialog').close(); if (remoteAction === 'fetch') void mutate('Fetching remote…', () => api.fetch(repo!.id, remoteId, progressReporter())); else void mutate('Publishing current branch…', () => api.push(repo!.id, remoteId, repo!.token, progressReporter())); };
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && repo) { event.preventDefault(); input('history-search').focus(); input('history-search').select(); }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && !get('details').hidden) { event.preventDefault(); moveDetailFile(event.key === 'ArrowDown' ? 1 : -1); }
  if (event.key === 'Escape' && !get('details').hidden && !document.querySelector('dialog[open]') && document.activeElement !== input('history-search')) closeDetails();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!busy) void chooseRepository(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); if (repo && !busy) void run('Refreshing…', refresh); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && get('commit-form').contains(document.activeElement)) { event.preventDefault(); void commitChanges(); }
});
window.addEventListener('focus', () => { if (repo && !busy && !document.querySelector('dialog[open]')) void run('Refreshing…', async () => { await refresh(); await autoCheckpoint(); }); });
updateControls();
if (isTauri()) {
  void getVersion().then(version => { get('app-version').textContent = 'v' + version; get('app-version').hidden = false; }).catch(report);
  void getCurrentWindow().onCloseRequested(async event => {
    if (writing) { event.preventDefault(); await nativeMessage('A Git operation is still running. Wait for it to finish before closing GitGUI.', { title: 'Git operation in progress', kind: 'info' }); }
  }).catch(report);
  void run('Starting…', async () => {
    const path = await api.startup() ?? stored('lastRepository');
    if (path) await openPath(path); else notify('Open a repository to begin.');
  });
} else {
  get('welcome').querySelector('p')!.textContent = 'Launch the GitGUI desktop app to work with local repositories.';
  button('welcome-open').disabled = true; button('open-repo').disabled = true; button('init-repo').disabled = true; notify('Desktop runtime required');
}
