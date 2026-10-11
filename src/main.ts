import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, confirm, message as nativeMessage } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, type AiProvider, type Answer, type Checkpoint, type Session, type SessionFile, type RepoInfo, type GraphPage, type CommitDetails, type Preview, type FileInfo, type RefInfo, type Stash, type Junk, type RebaseEdit } from './git.ts';
import { findCommits, layoutHistory, paintGraph, type Layout } from './graph.ts';
import { changedRange, numberDiff, pairLines, type DiffLine } from './diff.ts';
import { isBlock, parseConflicts, resolveConflicts, type Choice, type Segment } from './conflict.ts';
import { isNewer } from './update.ts';
import { wireDropdown } from './dropdown.ts';
import { aiCost, explainCrash, explainError, explainState, sortByRisk } from './explain.ts';
import { forgetRecent, isUnavailable, parseRecent, rememberRecent } from './recent.ts';
import { summaryHint } from './commit.ts';
import { markup } from './template.ts';
import { PRESETS, STARTER_RULES } from './ai.ts';
import './styles.css';

const app = document.getElementById('app')!;
app.innerHTML = markup;

function get<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
function button(id: string) { return get<HTMLButtonElement>(id); }
function input(id: string) { return get<HTMLInputElement>(id); }
function select(id: string) { return get<HTMLSelectElement>(id); }
function dialog(id: string) { return get<HTMLDialogElement>(id); }
function option(value: string, label: string) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
const scopeDropdown = wireDropdown(select('scope'));
const repoDropdown = wireDropdown(select('recent-repos'), () => button('open-repo').click());

let repo: RepoInfo | null = null;
let openRepos: RepoInfo[] = [];
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
function recentRepositories() { return parseRecent(stored('recentRepositories')); }
function forgetRepository(path: string) {
  save('recentRepositories', JSON.stringify(forgetRecent(recentRepositories(), path)));
  if (stored('lastRepository') === path) removeStored('lastRepository');
  removeStored('draft:' + path);
}
async function openSaved(path: string) {
  try { await openPath(path); }
  catch (error) {
    if (!isUnavailable(error)) throw error;
    forgetRepository(path); renderRecentRepositories();
    let paths: unknown;
    try { paths = JSON.parse(stored('openRepositories') ?? '[]'); } catch { paths = []; }
    if (Array.isArray(paths)) save('openRepositories', JSON.stringify(paths.filter(item => item !== path)));
    throw new Error(path + ' is no longer available and was removed from recent repositories.');
  }
}
function renderRepoTabs() {
  const tabs = get('repo-tabs'); tabs.replaceChildren();
  for (const item of openRepos) {
    const tab = document.createElement('span'); tab.className = 'repo-tab';
    const activate = document.createElement('button'); activate.type = 'button'; activate.className = 'repo-tab-name'; activate.textContent = item.root.split('/').filter(Boolean).pop() || item.root; activate.title = item.root; activate.setAttribute('aria-pressed', String(item.id === repo?.id)); activate.disabled = busy;
    activate.onclick = () => { if (!busy && item.id !== repo?.id) void run('Opening repository…', () => activateRepository(item)); };
    const close = document.createElement('button'); close.type = 'button'; close.className = 'repo-tab-close'; close.textContent = '×'; close.title = 'Close ' + item.root; close.setAttribute('aria-label', 'Close repository ' + item.root); close.disabled = busy; close.onclick = () => { if (!busy) void closeRepository(item); };
    tab.append(activate, close); tabs.append(tab);
  }
}
function rememberOpenRepos() { save('openRepositories', JSON.stringify(openRepos.map(item => item.root))); renderRepoTabs(); }
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
  renderSummaryHint();
}
function renderSummaryHint() {
  const hint = summaryHint(input('summary').value);
  get('summary-hint').textContent = hint.text; get('summary-hint').classList.toggle('warning', hint.warning);
}
function notify(message: string) { get('status').textContent = message; }
function report(error: unknown) { const why = explainError(String(error)); get('error-text').textContent = (why ? why + '\n\n' : '') + String(error).slice(0, 4000); get('error').hidden = false; notify(why ?? String(error).split('\n')[0]); }
function normal() { return !!repo && !repo.operation; }
function stagedFiles() { return repo?.files.filter(file => file.index !== '.' && !file.untracked && !file.conflicted) ?? []; }
function disable(id: string, reason: string) {
  const control = get<HTMLButtonElement | HTMLSelectElement>(id);
  control.disabled = !!reason; control.title = reason || control.dataset.tip || '';
  if (reason) control.setAttribute('aria-description', reason); else control.removeAttribute('aria-description');
}
function updateControls() {
  const unavailable = busy ? 'Wait for the current Git operation to finish.' : !repo ? 'Open a repository first.' : '';
  const blocked = unavailable || (repo?.operation ? 'Finish the ' + repo.operation + ' first (Continue or Abort in Changes).' : '');
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-repo]').forEach(node => { node.disabled = !!unavailable; if (unavailable) node.setAttribute('aria-description', unavailable); else node.removeAttribute('aria-description'); });
  disable('open-repo', busy ? unavailable : ''); disable('init-repo', busy ? unavailable : ''); disable('welcome-open', busy ? unavailable : '');
  disable('details-button', unavailable || (!selected ? 'Select a commit to review its details.' : ''));
  disable('rebase-button', blocked || (repo?.detached ? 'Switch to a branch before cleaning up commits.' : ''));
  disable('commit-explain', unavailable || (!details ? 'Open a commit first.' : ''));
  const githubRemote = repo?.remotes.some(remote => /github\.com[:/]/i.test(remote.url)) ?? false;
  button('create-pr-button').hidden = !repo?.branch || !repo.upstream || repo.ahead !== 0 || !githubRemote;
  for (const id of ['commit-revert', 'commit-cherry-pick', 'commit-tag', 'commit-reset']) disable(id, blocked || (!details ? 'Open a commit first.' : repo?.detached ? 'Switch to a branch first.' : ''));
  // Without a remote these buttons open Publish instead.
  const offline = !!repo && !repo.remotes.length;
  disable('fetch', blocked);
  disable('pull', blocked || (offline ? '' : !repo?.upstream ? 'Publish this branch to set its upstream before pulling.' : repo.files.length ? 'Commit or resolve working changes before pulling.' : ''));
  disable('push', blocked || (!repo?.branch ? 'Switch to a local branch before pushing.' : ''));
  for (const id of ['clone-repo', 'welcome-clone']) disable(id, busy ? unavailable : '');
  disable('stash-changes', blocked || (!repo?.files.length ? 'There are no changes to put aside.' : ''));
  disable('load-more', unavailable || (limit >= 10000 ? '10,000 commits loaded. Choose a narrower history scope.' : ''));
  const amend = input('amend').checked;
  disable('commit-button', blocked || (amend && !repo?.head ? 'There is no commit to amend yet.' : !amend && !stagedFiles().length ? 'Stage at least one file before committing.' : !input('summary').value.trim() ? 'Enter a commit summary.' : ''));
  disable('switch-branch', blocked || (!select('branch-select').value ? 'Choose a local branch.' : ''));
  const chosen = page?.refs.find(ref => ref.id === select('branch-select').value);
  const newName = input('branch-rename').value.trim();
  disable('rename-branch', blocked || (!chosen ? 'Choose a local branch.' : !newName || newName === chosen.name ? 'Enter a new name for the branch.' : ''));
  disable('delete-branch', blocked || (!chosen ? 'Choose a local branch.' : chosen.isHead ? 'You are on this branch. Switch to another branch first.' : ''));
  disable('create-branch', blocked || (!repo?.head ? 'Create the first commit before creating another branch.' : !input('branch-name').value.trim() ? 'Enter a branch name.' : ''));
  disable('ai-message', blocked || (!stagedFiles().length ? 'Stage the files to describe first.' : ''));
  disable('ai-explain', unavailable || (!stagedFiles().length ? 'Stage the files to explain first.' : ''));
  disable('publish', blocked || (!repo?.head ? 'Create the first commit before publishing.' : ''));
  disable('undo-commit', blocked || (!repo?.head ? 'There is no commit yet.' : ''));
  for (const id of ['operation-continue', 'operation-abort']) button(id).disabled = busy;
  disable('remote-submit', unavailable || (!select('remote-select').value ? 'Choose a configured remote.' : ''));
  select('scope').disabled = busy || !repo;
  input('history-search').disabled = busy || !repo;
  button('search-prev').disabled = busy || !searchMatches.length; button('search-next').disabled = busy || !searchMatches.length;
  button('details-button').setAttribute('aria-expanded', String(!get('details').hidden));
  updateDetailControls();
  renderRecentRepositories();
  renderRepoTabs();
  scopeDropdown.sync(); repoDropdown.sync();
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
    if (backgroundFetch) await backgroundFetch;
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
  // Ahead/behind only mean something against an upstream.
  get('behind-count').textContent = String(repo?.behind ?? 0); get('behind-count').hidden = !repo?.behind || !repo.upstream;
  get('ahead-count').textContent = String(repo?.ahead ?? 0); get('ahead-count').hidden = !repo?.ahead || !repo.upstream;
  const offline = !!repo && !repo.remotes.length;
  get('publish').hidden = !offline;
  get('changes-count').textContent = String(repo?.files.length ?? 0);
  get('staged-count').textContent = stagedFiles().length + ' staged ' + (stagedFiles().length === 1 ? 'file' : 'files');
  get('version-controls').hidden = !repo?.versioning; get('enable-versioning').hidden = !repo || repo.versioning;
  get('repo-version').textContent = repo?.version ? 'v' + repo.version : 'none';
  renderHints(repo ? explainState(repo) : [], repo ? health : []);
  get('operation-note').textContent = repo?.operation === 'unresolved conflicts' ? 'Resolve each conflicted file below.' : repo?.operation ? 'A ' + repo.operation + ' is in progress.' : '';
  get('operation-continue').hidden = !repo?.operation || repo.operation === 'unresolved conflicts'; get('operation-abort').hidden = !repo?.operation;
  const trying = !!repo?.branch?.startsWith('try/');
  get('experiment-button').hidden = trying; get('experiment-bar').hidden = !trying;
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
      item.setAttribute('aria-label', kind + ' ' + ref.name + (ref.isHead ? ', current branch' : ''));
      item.setAttribute('aria-pressed', String(scope === ref.id));
      const name = document.createElement('span'); name.className = 'ref-label'; name.textContent = ref.name; name.title = ref.fullName; item.append(name);
      if (ref.isHead) { const head = document.createElement('span'); head.className = 'ref-head'; head.textContent = 'HEAD'; item.append(head); }
      item.addEventListener('click', () => { void changeScope(ref.id); });
      const line = document.createElement('div'); line.className = 'ref-row'; line.append(item);
      const actions: [string, () => void][] = [];
      if (kind !== 'tag' && !ref.isHead) actions.push([kind === 'remote' ? 'Check out' : 'Switch to this branch', () => { void switchTo(ref); }], ['Merge into current branch', () => { void mergeRef(ref); }]);
      if (kind !== 'tag') actions.push(['Explain with AI', () => { void explainChanges('branch:' + ref.id, 'Branch ' + ref.name + ' explained'); }]);
      else actions.push(['Delete tag', () => { void removeTag(ref); }]);
      const more = document.createElement('button'); more.type = 'button'; more.className = 'ref-more'; more.dataset.repo = ''; more.textContent = '⋯';
      more.title = 'More actions'; more.setAttribute('aria-label', 'Actions for ' + ref.name); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.onclick = event => { event.stopPropagation(); openRefMenu(more, actions); };
      item.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); if (!more.disabled) openRefMenu(more, actions); });
      line.append(more);
      section.append(line);
    }
    control.append(group); list.append(section);
  }
  if (scope === null && layout.lanes === 1 && (page?.refs.filter(ref => ref.kind === 'local').length ?? 0) > 1) {
    const note = document.createElement('p'); note.className = 'ref-note';
    note.textContent = 'These branches are stacked: each one continues from the one below it, so the history is one straight line.'; list.append(note);
  }
  control.value = scope ?? ''; list.scrollTop = scroll;
}
async function switchTo(ref: RefInfo) {
  if (!repo || busy) return;
  scope = null;
  await mutate((ref.kind === 'remote' ? 'Checking out ' : 'Switching to ') + ref.name + '…', () => ref.kind === 'remote' ? api.checkoutRemote(repo!.id, ref.id, repo!.token) : api.switchBranch(repo!.id, ref.id, repo!.token));
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
  get('search-all').hidden = !input('history-search').value.trim() || !page?.hasMore || limit >= 10000;
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
  epoch++; repo = await api.status(repo.id); renderInfo(); renderFiles(); loadHealth(); await loadGraph();
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
let rebasePlan: { base: string; commits: RebaseEdit[] } | null = null;
function renderRebase() {
  const list = get('rebase-commits');
  list.replaceChildren(...(rebasePlan?.commits ?? []).map((commit, index) => {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('span'); label.textContent = commit.oid.slice(0, 8) + ' ' + commit.message.split('\n')[0];
    const action = document.createElement('select');
    for (const [value, name] of [['pick', 'Keep'], ['reword', 'Edit message'], ['squash', 'Combine with previous'], ['fixup', 'Combine and drop message'], ['drop', 'Delete']]) action.append(option(value, name));
    action.value = commit.action; if (index === 0) { action.querySelector<HTMLOptionElement>('option[value="squash"]')!.disabled = true; action.querySelector<HTMLOptionElement>('option[value="fixup"]')!.disabled = true; } action.onchange = () => { commit.action = action.value as RebaseEdit['action']; renderRebase(); };
    row.append(label, action);
    if (commit.action === 'reword') { const message = document.createElement('textarea'); message.value = commit.message; message.setAttribute('aria-label', 'New commit message'); message.oninput = () => { commit.message = message.value; }; row.append(message); }
    for (const [name, offset] of [['Move up', -1], ['Move down', 1]] as const) { const move = document.createElement('button'); move.textContent = name; move.disabled = index + offset < 0 || index + offset >= rebasePlan!.commits.length; move.onclick = () => { const to = index + offset; [rebasePlan!.commits[index], rebasePlan!.commits[to]] = [rebasePlan!.commits[to], rebasePlan!.commits[index]]; renderRebase(); }; row.append(move); }
    return row;
  }));
  button('rebase-apply').disabled = !rebasePlan?.commits.length;
}
async function openRebase() {
  if (!repo || busy) return;
  await run('Loading commits…', async () => { const plan = await api.rebasePlan(repo!.id, repo!.token); rebasePlan = { base: plan.base, commits: plan.commits.map(commit => ({ ...commit, action: 'pick' })) }; renderRebase(); dialog('rebase-dialog').showModal(); notify('Ready'); });
}
async function applyRebase() {
  if (!repo || !rebasePlan || busy) return;
  if (!await confirm('Rewrite these commits? Their IDs will change. A checkpoint is saved first.', { title: 'Clean up commits', kind: 'warning' })) return;
  const plan = rebasePlan; dialog('rebase-dialog').close();
  await mutate('Cleaning up commits…', () => api.cleanCommits(repo!.id, plan.base, plan.commits, repo!.token));
}
async function activateRepository(next: RepoInfo, refresh = false) {
  saveDraft();
  if (refresh) next = await api.status(next.id);
  for (const id of ['branches', 'remote-dialog', 'rebase-dialog']) if (dialog(id).open) dialog(id).close();
  get('details').hidden = true;
  details = null; detailRequest++; workingRequest++;
  repo = next; epoch++; scope = null; limit = 200; page = null; selected = null; workingFile = null;
  checked.staged.clear(); checked.unstaged.clear(); input('branch-name').value = ''; setAmend(false); lastFetch = Date.now() - 4 * 60_000;
  input('history-search').value = ''; searchMatches = [];
  if (!openRepos.some(item => item.id === repo!.id)) openRepos.push(repo);
  openRepos = openRepos.map(item => item.id === repo!.id ? repo! : item); rememberOpenRepos();
  save('recentRepositories', JSON.stringify(rememberRecent(recentRepositories(), repo.root)));
  health = []; loadHealth();
  save('lastRepository', repo.root); restoreDraft(); renderInfo(); renderFiles();
  get('working-diff').replaceChildren(); get('working-path').textContent = 'Select a file to review its diff.';
  get('error').hidden = true; await loadGraph(); notify('Opened ' + repo.root);
}
async function openPath(path: string, load = api.open) { await activateRepository(await load(path)); }
async function closeRepository(item: RepoInfo) {
  if (busy) return;
  await api.closeRepository(item.id); openRepos = openRepos.filter(repo => repo.id !== item.id); rememberOpenRepos();
  if (repo?.id !== item.id) return;
  saveDraft();
  const next = openRepos[0];
  if (next) await run('Opening repository…', () => activateRepository(next, true));
  else {
    repo = null; page = null; selected = null; details = null; scope = null; epoch++; renderInfo(); renderFiles(); renderRepoTabs();
    get('welcome').hidden = false; get('graph-scene').hidden = true; get('empty-history').hidden = true; get('changes').hidden = true; notify('Open a repository to begin.'); updateControls();
  }
}
let splitDiff = stored('diffSplit') === '1';
const shownPreviews = new Map<string, [Preview, ((hunk: number, header: string) => void) | undefined]>();
function lineNumber(value: number | null) {
  const number = document.createElement('span'); number.className = 'line-number'; number.setAttribute('aria-hidden', 'true'); number.textContent = value === null ? '' : String(value); return number;
}
/** A diff line's text; when it replaces a similar line, only the changed words are marked. */
function diffText(line: DiffLine | null, other?: DiffLine) {
  const text = document.createElement('span'); text.className = 'diff-text' + (line?.kind ? ' ' + line.kind : '');
  if (!line) return text;
  if (other && other.kind !== line.kind && (line.kind === 'added' || line.kind === 'removed')) {
    const [start, end] = changedRange(line.text.slice(1), other.text.slice(1));
    if ((start || end) && line.text.length - 1 - start - end > 0) {
      const mark = document.createElement('mark'); mark.textContent = line.text.slice(1 + start, line.text.length - end);
      text.append(line.text.slice(0, 1 + start), mark, line.text.slice(line.text.length - end)); return text;
    }
  }
  text.textContent = line.text || ' '; return text;
}
/** Renders a diff, unified or side by side; `onHunk` adds a stage/unstage button to each hunk. */
function previewInto(id: string, preview: Preview, onHunk?: (hunk: number, header: string) => void, hunkLabel = 'Stage hunk') {
  shownPreviews.set(id, [preview, onHunk]);
  const container = get(id); container.replaceChildren(); container.dataset.hunkLabel = hunkLabel;
  // shortcut: render 5,000 diff lines, add virtualization when larger previews are needed.
  const all = numberDiff(preview.text, preview.binary); const lines = all.slice(0, 5000);
  const rows = pairLines(lines); const partner = new Map<DiffLine, DiffLine>();
  for (const [left, right] of rows) if (left && right && left !== right) { partner.set(left, right); partner.set(right, left); }
  const split = splitDiff && lines.some(line => line.kind === 'hunk');
  container.classList.toggle('split', split);
  const row = (kind: string) => { const span = document.createElement('span'); span.className = 'diff-line ' + kind; container.append(span); return span; };
  let hunk = -1;
  const hunkRow = (line: DiffLine) => {
    const span = row('hunk wide'); span.append(diffText(line)); const index = ++hunk;
    if (!onHunk) return;
    const action = document.createElement('button'); action.type = 'button'; action.className = 'hunk-action'; action.textContent = hunkLabel; action.disabled = busy;
    action.setAttribute('aria-label', hunkLabel + ' ' + (index + 1)); action.onclick = () => onHunk(index, line.text); span.append(action);
  };
  if (!split) {
    for (const line of lines) {
      if (line.kind === 'hunk') hunkRow(line);
      else row(line.kind).append(lineNumber(line.oldLine), lineNumber(line.newLine), diffText(line, partner.get(line)));
    }
  } else {
    for (const [left, right] of rows) {
      if (left === right && left?.kind === 'hunk') hunkRow(left);
      else if (left === right && left && left.oldLine === null && left.newLine === null) row('wide').append(diffText(left));
      else row('pair').append(lineNumber(left?.oldLine ?? null), diffText(left, left ? partner.get(left) : undefined), lineNumber(right?.newLine ?? null), diffText(right, right ? partner.get(right) : undefined));
    }
  }
  if (preview.truncated || all.length > 5000) { const note = document.createElement('span'); note.className = 'diff-line note'; note.textContent = 'Preview truncated. Inspect the complete diff in Git for the remaining content.'; container.append(note); }
  if (!preview.text) container.textContent = 'No differences to display.';
}
document.querySelectorAll<HTMLButtonElement>('.diff-toggle').forEach(toggle => {
  toggle.setAttribute('aria-pressed', String(splitDiff));
  toggle.onclick = () => {
    splitDiff = !splitDiff; save('diffSplit', splitDiff ? '1' : '0');
    document.querySelectorAll('.diff-toggle').forEach(other => other.setAttribute('aria-pressed', String(splitDiff)));
    for (const [id, [preview, onHunk]] of shownPreviews) if (get(id).querySelector('.diff-line')) previewInto(id, preview, onHunk, get(id).dataset.hunkLabel);
  };
});
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
  button('detail-file-history').disabled = files.disabled || !files.value;
  disable('copy-sha', !details ? 'Open a commit to copy its ID.' : '');
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
let health: string[] = [];
function loadHealth() {
  const id = repo?.id; if (id === undefined) return;
  api.health(id).then(notes => { if (repo?.id === id) { health = notes; renderInfo(); } }).catch(() => { /* Warnings are advisory; never block the user. */ });
}
function openPublish() {
  if (!repo || busy) return;
  const branches = page?.refs.filter(ref => ref.kind === 'local').map(ref => ref.name) ?? [];
  select('publish-main').replaceChildren(...branches.map(name => option(name, name)));
  select('publish-main').value = ['main', 'master'].find(name => branches.includes(name)) ?? repo.branch ?? branches[0] ?? '';
  dialog('publish-dialog').showModal();
}
async function publish() {
  if (!repo || busy) return;
  const useUrl = get<HTMLFormElement>('publish-form').querySelector<HTMLInputElement>('input[name="publish-mode"]:checked')?.value === 'url';
  const main = select('publish-main').value; const url = useUrl ? input('publish-url').value.trim() : null;
  if (useUrl && !url) { input('publish-url').focus(); return; }
  dialog('publish-dialog').close();
  await mutate('Publishing…', () => api.publish(repo!.id, main, url, repo!.token));
}
const dismissedHints = new Set<string>((() => { try { return JSON.parse(stored('dismissedHints') ?? '[]') as string[]; } catch { return []; } })());
function renderHints(state: string[], warnings: string[]) {
  const items = [...state.map(text => ({ text, kind: 'state' })), ...warnings.map(text => ({ text, kind: 'warning' }))]
    .filter(note => !dismissedHints.has(note.text))
    .map(note => {
      const item = document.createElement('li'); item.className = 'hint hint-' + note.kind;
      const text = document.createElement('span'); text.textContent = note.text;
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss this tip');
      close.onclick = () => { dismissedHints.add(note.text); save('dismissedHints', JSON.stringify([...dismissedHints])); renderInfo(); };
      item.append(text, close); return item;
    });
  if (update && !dismissedHints.has('update:' + update[0])) {
    const [version, url] = update;
    const item = document.createElement('li'); item.className = 'hint hint-state';
    const text = document.createElement('span'); text.textContent = `GitGUI ${version} is available.`;
    const download = document.createElement('button'); download.type = 'button'; download.className = 'chip hint-action'; download.textContent = 'Download';
    download.onclick = () => { void api.openRelease(url).catch(report); };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss this tip');
    close.onclick = () => { dismissedHints.add('update:' + version); save('dismissedHints', JSON.stringify([...dismissedHints])); renderInfo(); };
    item.append(text, download, close); items.unshift(item);
  }
  get('git-hint').replaceChildren(...items); get('git-hint').hidden = !items.length;
}
async function finishExperiment(keep: boolean) {
  if (!repo || busy) return;
  const text = keep ? 'Keep this experiment? Its commits are merged into the branch it started from. Commit its changes first.' : 'Throw this experiment away? Its commits and changes are deleted and you return to where you started. A checkpoint is saved first.';
  if (!await confirm(text, { title: keep ? 'Keep experiment' : 'Throw away experiment', kind: keep ? 'info' : 'warning' })) return;
  await mutate(keep ? 'Keeping experiment…' : 'Throwing experiment away…', () => api.finishExperiment(repo!.id, keep, repo!.token));
}
async function abortOperation() {
  if (!repo?.operation || busy) return;
  if (!await confirm('Abort and go back to how everything was before it started? Conflict choices made so far are lost.', { title: 'Abort', kind: 'warning' })) return;
  await mutate('Aborting…', () => api.finishOperation(repo!.id, true, repo!.token));
}
async function undoCommit() {
  if (!repo || busy) return;
  if (!await confirm('Undo the last commit? Nothing is lost: its changes go back to Staged so you can fix them and commit again. Pushed commits cannot be undone this way.', { title: 'Undo last commit', kind: 'warning' })) return;
  await mutate('Undoing last commit…', () => api.undoCommit(repo!.id, repo!.token));
}

function presetFor(provider: AiProvider) {
  return Object.keys(PRESETS).find(key => { const p = PRESETS[key].provider; return p.kind === provider.kind && p.baseUrl === provider.baseUrl && p.command === provider.command; })
    ?? (provider.kind === 'command' ? 'command' : provider.kind === 'openai' ? 'api' : 'claude');
}
function showProviderFields() {
  const preset = PRESETS[select('ai-preset').value];
  document.querySelectorAll<HTMLElement>('#key-form [data-ai]').forEach(node => { node.hidden = !node.dataset.ai!.split(' ').includes(preset.provider.kind); });
  get('ai-provider-note').textContent = preset.note;
}
select('ai-preset').replaceChildren(...Object.entries(PRESETS).map(([key, preset]) => option(key, preset.label)));
select('ai-preset').onchange = () => {
  const preset = PRESETS[select('ai-preset').value].provider;
  input('ai-base-url').value = preset.baseUrl; input('ai-model').value = preset.model; input('ai-command').value = preset.command; input('api-key').value = '';
  showProviderFields();
};
function recordUsage(answer: Answer) {
  let usage = { calls: 0, input: 0, output: 0 };
  try { usage = { ...usage, ...JSON.parse(stored('aiUsage') ?? '{}') }; } catch { /* Start a fresh log. */ }
  usage.calls++;
  // Only Claude requests are priced; other providers charge different rates.
  if (answer.provider === 'claude') { usage.input += answer.inputTokens; usage.output += answer.outputTokens; }
  save('aiUsage', JSON.stringify(usage));
  const tokens = answer.inputTokens + answer.outputTokens;
  get('ai-usage').textContent = `Answered by ${answer.provider}` + (tokens ? ` · ${tokens} tokens` : '') + (answer.provider === 'claude' ? `, about $${aiCost(answer.inputTokens, answer.outputTokens).toFixed(3)}` : '')
    + `. All GitGUI AI requests: ${usage.calls}` + (usage.input ? `, Claude about $${aiCost(usage.input, usage.output).toFixed(2)}` : '') + '.';
}
async function showKeyForm() {
  const provider = await api.aiProvider().catch(() => PRESETS.claude.provider);
  select('ai-preset').value = presetFor(provider);
  input('ai-base-url').value = provider.baseUrl; input('ai-model').value = provider.model; input('ai-command').value = provider.command; input('api-key').value = '';
  showProviderFields();
  get('ai-title').textContent = 'AI settings'; get('key-form').hidden = false; get('ai-answer').textContent = ''; get('ai-usage').textContent = '';
  if (!dialog('ai-dialog').open) dialog('ai-dialog').showModal(); select('ai-preset').focus();
}
async function saveKey() {
  try {
    const kind = PRESETS[select('ai-preset').value].provider.kind;
    const key = input('api-key').value.trim();
    await api.saveAiProvider({ kind, baseUrl: input('ai-base-url').value, model: input('ai-model').value, apiKey: kind === 'openai' ? key : '', command: input('ai-command').value });
    if (kind === 'claude' && key) await api.setApiKey(key);
    input('api-key').value = ''; get('key-form').hidden = true; get('ai-answer').textContent = 'AI settings saved. Run your request again.';
  } catch (error) { report(error); }
}
/** Asks the chosen AI; returns null after showing AI settings when no working key is set. */
async function ask(request: 'explain' | 'message' | 'conflict' | 'pr', scope: string): Promise<Answer | null> {
  try { const answer = await api.ask(repo!.id, request, scope); recordUsage(answer); return answer; }
  catch (error) { if (/No Claude API key|x-api-key|authentication|unauthorized|invalid api key|incorrect api key/i.test(String(error))) { void showKeyForm(); notify('Check your AI settings'); return null; } throw error; }
}
async function explainChanges(scope: string, title: string) {
  if (!repo || busy) return;
  await run('The AI is reading the changes…', async () => {
    const answer = await ask(scope.startsWith('conflict:') ? 'conflict' : 'explain', scope); if (!answer) return;
    get('ai-title').textContent = title; get('key-form').hidden = true; get('ai-answer').textContent = answer.text;
    if (!dialog('ai-dialog').open) dialog('ai-dialog').showModal(); notify('Ready');
  });
}
async function writeMessage() {
  if (!repo || busy) return;
  await run('The AI is writing the commit message…', async () => {
    const answer = await ask('message', 'staged'); if (!answer) return;
    const [summary, ...rest] = answer.text.split('\n');
    input('summary').value = summary.trim(); get<HTMLTextAreaElement>('body').value = rest.join('\n').trim(); saveDraft();
    notify('Message drafted. Read it before committing.');
  });
}

async function openPullRequest() {
  if (!repo || busy) return;
  await run('Loading pull request details…', async () => {
    input('pr-base').value = await api.pullRequestBase(repo!.id);
    input('pr-title').value = repo!.branch ?? ''; get<HTMLTextAreaElement>('pr-body').value = '';
    dialog('pull-request-dialog').showModal(); input('pr-title').focus(); notify('Ready');
  });
}
async function writePullRequestWithAi() {
  if (!repo || busy || !repo.branch) return;
  await run('The AI is drafting the pull request…', async () => {
    const ref = page?.refs.find(item => item.isHead && item.kind === 'local');
    if (!ref) throw new Error('Could not identify the current branch. Refresh and try again.');
    const answer = await ask('pr', 'branch:' + ref.id); if (!answer) return;
    const [title, ...body] = answer.text.split('\n'); input('pr-title').value = title.trim();
    get<HTMLTextAreaElement>('pr-body').value = body.join('\n').trim(); notify('Draft ready. Review it before creating the pull request.');
  });
}
async function createPullRequest() {
  if (!repo || busy) return;
  let url = '';
  await run('Creating pull request…', async () => {
    url = await api.createPullRequest(repo!.id, input('pr-title').value, get<HTMLTextAreaElement>('pr-body').value, input('pr-base').value);
    dialog('pull-request-dialog').close();
  }, true);
  if (url) { try { await api.openPullRequest(url); } catch (error) { report(error); notify('Pull request created: ' + url); } }
}

let sessionFiles: (SessionFile & { risk: string | null })[] = [];
const STATUS_WORDS: Record<string, string> = { A: 'new', M: 'edited', D: 'deleted', T: 'type changed' };
function renderSession(session: Session, notes: string[]) {
  sessionFiles = sortByRisk(session.files);
  const since = session.checkpoint ? `checkpoint "${session.checkpoint.label}" (${new Date(session.checkpoint.timestamp * 1000).toLocaleString()})` : 'your last commit';
  get('session-note').textContent = `${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} changed since ${since}. Risky files come first. Undo puts a file back; a checkpoint is saved first, so undo can be undone too.`;
  get('health-list').replaceChildren(...notes.map(note => { const item = document.createElement('li'); item.textContent = note; return item; }));
  const items = sessionFiles.map(file => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = file.path;
    const meta = document.createElement('span'); meta.className = file.risk ? 'risk' : 'muted'; meta.textContent = `${STATUS_WORDS[file.status] ?? file.status} · +${file.added} −${file.deleted}` + (file.risk ? ' · ⚠ ' + file.risk : '');
    const actions = document.createElement('span'); actions.className = 'row';
    const diff = document.createElement('button'); diff.type = 'button'; diff.textContent = 'Diff'; diff.setAttribute('aria-label', 'Show changes in ' + file.path);
    diff.onclick = () => { if (repo && !busy) void run('Reading diff…', async () => { previewInto('session-diff', await api.sessionDiff(repo!.id, file.path)); notify('Ready'); }); };
    const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = 'Undo'; undo.setAttribute('aria-label', 'Undo changes to ' + file.path);
    undo.onclick = () => { void undoSession([file.path]); };
    actions.append(diff, undo); item.append(title, meta, actions); return item;
  });
  if (!items.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = 'Nothing changed.'; items.push(empty); }
  get('session-list').replaceChildren(...items);
  button('session-undo-all').disabled = !sessionFiles.length; button('session-explain').disabled = !sessionFiles.length;
}
async function openSession() {
  if (!repo || busy) return;
  await run('Reviewing changes…', async () => {
    const [session, notes] = await Promise.all([api.session(repo!.id), api.health(repo!.id)]);
    renderSession(session, notes); get('session-diff').replaceChildren();
    if (!dialog('session-dialog').open) dialog('session-dialog').showModal(); notify('Ready');
  });
}
async function undoSession(paths: string[]) {
  if (!repo || busy || !paths.length) return;
  if (paths.length > 1 && !await confirm(`Undo all ${paths.length} changed files? A checkpoint of the current files is saved first.`, { title: 'Undo all', kind: 'warning' })) return;
  await mutate(paths.length === 1 ? 'Undoing ' + paths[0] + '…' : 'Undoing all changes…', () => api.undoFiles(repo!.id, paths, repo!.token));
  if (dialog('session-dialog').open) await openSession();
}

async function openRules() {
  if (!repo || busy) return;
  await run('Loading AI rules…', async () => { get<HTMLTextAreaElement>('rules-text').value = await api.agentRules(repo!.id); dialog('rules-dialog').showModal(); notify('Ready'); });
}
async function saveRules() {
  if (!repo || busy) return;
  await run('Saving AI rules…', async () => { await api.saveAgentRules(repo!.id, get<HTMLTextAreaElement>('rules-text').value); dialog('rules-dialog').close(); await refresh(); notify('Rules saved to AGENTS.md'); }, true);
}

let running = false;
async function startRun() {
  if (!repo || running) return;
  running = true; button('run-start').disabled = true; button('run-stop').disabled = false; button('run-button').textContent = 'Running…';
  const lines: string[] = []; let queued = false; get('run-hint').hidden = true;
  const output = get('run-output');
  const append = (line: string) => {
    lines.push(line); if (lines.length > 2000) lines.shift();
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; output.textContent = lines.join('\n'); output.scrollTop = output.scrollHeight; }); }
  };
  try {
    const status = await api.runProject(repo.id, append);
    append('— stopped: ' + status);
    if (!/exit status: 0|signal: 15/.test(status)) { get('run-hint').textContent = explainCrash(lines.join('\n')) ?? 'The app stopped with an error. Show the last lines above to your AI and ask it to fix the first error.'; get('run-hint').hidden = false; }
  } catch (error) { append(String(error)); }
  finally { running = false; button('run-start').disabled = false; button('run-stop').disabled = true; button('run-button').textContent = 'Run'; }
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
      const nameButton = document.createElement('button'); nameButton.type = 'button'; nameButton.className = 'file-name'; nameButton.dataset.key = (staged ? 's' : 'u') + file.id; nameButton.textContent = (file.oldPath ? file.oldPath + ' → ' : '') + file.path; nameButton.title = nameButton.textContent;
      nameButton.addEventListener('click', () => { void showWorkingFile(file, !!staged); }); row.append(nameButton);
      if (staged === null) {
        const resolve = document.createElement('button'); resolve.type = 'button'; resolve.textContent = 'Resolve…'; resolve.title = 'Pick yours, theirs, or both for each conflicting block'; resolve.disabled = busy;
        resolve.setAttribute('aria-label', 'Resolve ' + file.path + ' block by block');
        resolve.addEventListener('click', () => { void openConflict(file); }); row.append(resolve);
        for (const [label, choice, tip] of [['Keep ours', 'ours', 'Use the version from your current branch (during a rebase: the branch you rebase onto)'], ['Keep theirs', 'theirs', 'Use the incoming version'], ['Mark fixed', 'resolved', 'You edited the file and removed the <<<<<<< ======= >>>>>>> markers']] as const) {
          const action = document.createElement('button'); action.type = 'button'; action.textContent = label; action.title = tip; action.disabled = busy;
          action.setAttribute('aria-label', label + ' for ' + file.path);
          action.addEventListener('click', () => { if (repo) void mutate('Resolving ' + file.path + '…', () => api.resolveConflict(repo!.id, file.id, choice, repo!.token)); }); row.append(action);
        }
        const explain = document.createElement('button'); explain.type = 'button'; explain.textContent = 'Explain'; explain.title = 'Let the AI explain both sides of this conflict'; explain.disabled = busy;
        explain.addEventListener('click', () => { void explainChanges('conflict:' + file.id, 'Conflict in ' + file.path); }); row.append(explain);
      }
      if (staged !== null && !file.submodule) {
        const quick = document.createElement('button'); quick.type = 'button'; quick.className = 'row-action';
        quick.className = 'row-action stage-action'; quick.title = 'Space';
        quick.textContent = staged ? 'Unstage' : 'Stage'; quick.setAttribute('aria-label', quick.textContent + ' ' + file.path);
        quick.disabled = busy || !normal();
        quick.addEventListener('click', () => { if (repo) void mutate(staged ? 'Unstaging ' + file.path + '…' : 'Staging ' + file.path + '…', () => api.stage(repo!.id, [file.id], staged, repo!.token)); });
        row.append(quick);
      }
      if (staged !== null && !file.untracked && !file.submodule) {
        const action = document.createElement('button'); action.type = 'button'; action.className = 'row-action'; action.textContent = 'History';
        action.setAttribute('aria-label', 'Show history for ' + file.path); action.disabled = busy;
        action.addEventListener('click', () => { void openFileHistory(file.id, null, file.path); }); row.append(action);
      }
      if (staged === false && file.untracked && !file.submodule) {
        const action = document.createElement('button'); action.type = 'button'; action.className = 'row-action'; action.textContent = 'Ignore';
        action.setAttribute('aria-label', 'Ignore ' + file.path); action.disabled = busy;
        action.addEventListener('click', () => openIgnore(file)); row.append(action);
      }
      if (staged === false && !file.submodule) {
        const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'row-action'; discard.textContent = 'Discard';
        discard.title = 'Throw away these edits (a checkpoint is saved first)'; discard.setAttribute('aria-label', 'Discard changes to ' + file.path);
        discard.disabled = busy || !normal(); discard.addEventListener('click', () => { void discardFiles([file]); }); row.append(discard);
      }
      list.append(row);
    }
  }
  // Keyboard navigation re-renders the list; put focus back on the file the user moved to.
  if (fileFocus && (!document.activeElement || document.activeElement === document.body)) list.querySelector<HTMLButtonElement>(`button.file-name[data-key="${CSS.escape(fileFocus)}"]`)?.focus();
  renderInfo();
}
let fileFocus: string | null = null;
get('file-list').addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains('file-name')) return;
  const names = [...get('file-list').querySelectorAll<HTMLButtonElement>('button.file-name')]; const index = names.indexOf(target as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const next = names[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { fileFocus = next.dataset.key ?? null; next.focus(); next.click(); }
  }
  if (event.key === ' ') {
    const action = target.closest('.file-row')?.querySelector<HTMLButtonElement>('.stage-action');
    if (!action || action.disabled) return;
    event.preventDefault(); fileFocus = (names[index + 1] ?? names[index - 1])?.dataset.key ?? null; action.click();
  }
});
get('file-list').addEventListener('focusout', event => { if (!get('file-list').contains(event.relatedTarget as Node)) fileFocus = null; });

let ignoreTarget: FileInfo | null = null;
function openIgnore(file: FileInfo) {
  ignoreTarget = file; get('ignore-path').textContent = file.path;
  button('ignore-folder').hidden = !file.path.includes('/'); dialog('ignore-dialog').showModal();
}
async function ignoreTargetAs(folder: boolean) {
  if (!repo || !ignoreTarget) return;
  const target = ignoreTarget; dialog('ignore-dialog').close();
  await mutate('Updating .gitignore…', () => api.ignore(repo!.id, target.id, folder, repo!.token));
}
async function openFileHistory(fileId: string, commit: string | null, path: string) {
  if (!repo || busy) return;
  const id = repo.id; get('file-history-title').textContent = 'History · ' + path;
  const listing = get('file-history-list'); const blame = get('file-blame-list');
  listing.replaceChildren(document.createTextNode('Loading history…')); blame.replaceChildren(); dialog('file-history-dialog').showModal();
  await run('Loading file history…', async () => {
    const commits = await api.fileHistory(id, fileId, commit);
    if (repo?.id !== id || !dialog('file-history-dialog').open) return;
    listing.replaceChildren();
    for (const item of commits) {
      const row = document.createElement('div'); row.className = 'row';
      const summary = document.createElement('span'); summary.textContent = new Date(item.timestamp * 1000).toLocaleDateString() + ' · ' + item.author + ' · ' + item.subject; row.append(summary);
      const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = 'Open'; jump.addEventListener('click', () => { dialog('file-history-dialog').close(); if (historyRows.has(item.oid)) choose(item.oid); else void openDetails(item.oid); }); row.append(jump);
      const showBlame = document.createElement('button'); showBlame.type = 'button'; showBlame.textContent = 'Blame'; showBlame.addEventListener('click', () => { void renderFileBlame(id, fileId, item.oid); }); row.append(showBlame); listing.append(row);
    }
    if (!commits.length) listing.textContent = 'No commits found for this file.';
    await renderFileBlame(id, fileId, commit);
  });
}
async function renderFileBlame(id: number, fileId: string, commit: string | null) {
  const list = get('file-blame-list'); list.textContent = 'Loading line history…';
  try {
    const lines = await api.fileBlame(id, fileId, commit);
    if (repo?.id !== id || !dialog('file-history-dialog').open) return;
    list.replaceChildren(); let previous = '';
    lines.forEach((line, index) => {
      const row = document.createElement('div'); row.className = line.oid === previous ? 'muted' : 'row'; previous = line.oid;
      if (index === 0 || lines[index - 1].oid !== line.oid) {
        const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = short(line.oid) + ' · ' + line.author; jump.title = new Date(line.timestamp * 1000).toLocaleString();
        jump.addEventListener('click', () => { dialog('file-history-dialog').close(); if (historyRows.has(line.oid)) choose(line.oid); else void openDetails(line.oid); }); row.append(jump);
      }
      const text = document.createElement('span'); text.textContent = (index + 1) + ': ' + line.text; row.append(text); list.append(row);
    });
    if (lines.length === 5000) { const note = document.createElement('p'); note.textContent = 'Showing the first 5,000 lines.'; list.append(note); }
    if (!lines.length) list.textContent = 'No line history available.';
  } catch (error) { list.textContent = error instanceof Error ? error.message : String(error); }
}

let conflictFile: FileInfo | null = null;
let conflictSegments: Segment[] = [];
function conflictChoices() {
  return conflictSegments.filter(isBlock).map((_, n) => get('conflict-blocks').querySelector<HTMLInputElement>(`input[name="conflict-${n}"]:checked`)?.value as Choice | undefined);
}
async function openConflict(file: FileInfo) {
  if (!repo || busy) return;
  await run('Reading conflict…', async () => {
    conflictSegments = parseConflicts(await api.conflict(repo!.id, file.id)); conflictFile = file;
    const blocks = conflictSegments.filter(isBlock);
    if (!blocks.length) throw new Error('No conflict markers are left in ' + file.path + '. If you fixed it by hand, press Mark fixed.');
    get('conflict-title').textContent = 'Resolve ' + file.path;
    get('conflict-blocks').replaceChildren(...blocks.map((block, n) => {
      const section = document.createElement('fieldset'); section.className = 'conflict-block';
      const legend = document.createElement('legend'); legend.textContent = `Conflict ${n + 1} of ${blocks.length}`; section.append(legend);
      const sides = document.createElement('div'); sides.className = 'conflict-sides';
      for (const [title, lines] of [['Yours · ' + (block.oursLabel || 'current branch'), block.ours], ['Incoming · ' + (block.theirsLabel || 'other branch'), block.theirs]] as const) {
        const side = document.createElement('figure'); const caption = document.createElement('figcaption'); caption.textContent = title;
        const code = document.createElement('pre'); code.className = 'diff'; code.textContent = lines.join('\n') || '(nothing)'; side.append(caption, code); sides.append(side);
      }
      const choices = document.createElement('div'); choices.className = 'row';
      for (const [value, label] of [['ours', 'Keep yours'], ['theirs', 'Keep incoming'], ['both', 'Keep both']] as const) {
        const choice = document.createElement('label'); choice.className = 'choice';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'conflict-' + n; radio.value = value; radio.onchange = updateConflictSave;
        choice.append(radio, ' ' + label); choices.append(choice);
      }
      section.append(sides, choices); return section;
    }));
    updateConflictSave(); dialog('conflict-dialog').showModal(); notify('Ready');
  });
}
function updateConflictSave() { disable('conflict-save', conflictChoices().includes(undefined) ? 'Choose what to keep for every conflict.' : ''); }
button('conflict-save').onclick = () => {
  const file = conflictFile; const choices = conflictChoices();
  if (!repo || !file || choices.includes(undefined)) return;
  const content = resolveConflicts(conflictSegments, choices as Choice[]); dialog('conflict-dialog').close();
  void mutate('Resolving ' + file.path + '…', () => api.saveResolution(repo!.id, file.id, content, repo!.token));
};
async function showWorkingFile(file: FileInfo, staged: boolean) {
  if (!repo || busy) return;
  workingFile = { id: file.id, staged }; renderFiles();
  await run('Reading diff…', refreshWorkingPreview);
}
function clearWorkingPreview() {
  workingFile = null; workingRequest++; get('working-diff').replaceChildren();
  get('working-path').textContent = 'Select a file to review its diff.';
}
async function refreshWorkingPreview(quiet = false) {
  const selection = workingFile;
  const file = repo?.files.find(file => file.id === selection?.id && !file.conflicted && (selection.staged ? file.index !== '.' && !file.untracked : file.worktree !== '.' || file.untracked));
  if (!repo || !selection || !file) { clearWorkingPreview(); renderFiles(); return; }
  const id = repo.id; const request = ++workingRequest;
  get('working-path').textContent = (selection.staged ? 'Staged · ' : 'Working tree · ') + file.path;
  if (!quiet) get('working-diff').textContent = 'Reading diff…';
  let preview: Awaited<ReturnType<typeof api.workingDiff>>;
  try { preview = await readDetail(api.workingDiff(id, file.id, selection.staged)); }
  catch (error) {
    // The file list went stale (saved, committed, or reverted elsewhere): reload it instead of showing an error.
    if (!/File changed/.test(String(error)) || repo?.id !== id) throw error;
    await refresh(); return;
  }
  const hunks = !file.untracked && !file.oldId && !file.submodule;
  if (repo?.id === id && request === workingRequest) previewInto('working-diff', preview, hunks ? (hunk, header) => { void stageHunk(file, selection.staged, hunk, header); } : undefined, selection.staged ? 'Unstage hunk' : 'Stage hunk');
}
async function stageHunk(file: FileInfo, staged: boolean, hunk: number, header: string) {
  if (!repo || busy) return;
  const keep = workingFile;
  await mutate(staged ? 'Unstaging hunk…' : 'Staging hunk…', () => api.stageHunk(repo!.id, file.id, hunk, header, staged, repo!.token));
  workingFile = keep; renderFiles();
  await refreshWorkingPreview(true).catch(report);
}
async function discardFiles(files: FileInfo[]) {
  if (!repo || busy || !files.length) return;
  const what = files.length === 1 ? files[0].path : files.length + ' files';
  if (!await confirm(`Throw away the unsaved edits in ${what}? Staged changes stay. A checkpoint is saved first, so Checkpoints can bring them back.`, { title: 'Discard changes', kind: 'warning' })) return;
  await mutate('Discarding ' + what + '…', () => api.discard(repo!.id, files.map(file => file.id), repo!.token));
}
async function mutate(label: string, action: () => Promise<RepoInfo>, committed = false) {
  await run(label, async () => {
    const info = await action(); repo = info; epoch++;
    checked.staged.clear(); checked.unstaged.clear(); clearWorkingPreview();
    if (committed) {
      input('summary').value = ''; get<HTMLTextAreaElement>('body').value = ''; removeStored(draftKey()); renderSummaryHint(); setAmend(false);
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
  const amend = input('amend').checked;
  saveDraft(); await mutate(amend ? 'Amending last commit…' : 'Creating commit…', () => api.commit(repo!.id, message, repo!.token, detachedOk, repo!.versioning ? select('bump').value || null : null, amend), true);
}
function renderStashes(list: Stash[]) {
  const items = list.map(stash => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = stash.message;
    const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = new Date(stash.timestamp * 1000).toLocaleString();
    const actions = document.createElement('span'); actions.className = 'row';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'chip'; back.textContent = 'Bring back'; back.dataset.repo = '';
    back.title = 'Put these changes back into your files and remove the stash'; back.setAttribute('aria-label', 'Bring back ' + stash.message);
    back.onclick = () => { void stashAction('Bringing changes back…', () => api.applyStash(repo!.id, stash, true, repo!.token)); };
    const drop = document.createElement('button'); drop.type = 'button'; drop.textContent = 'Delete'; drop.dataset.repo = ''; drop.setAttribute('aria-label', 'Delete ' + stash.message);
    drop.onclick = async () => { if (await confirm(`Delete the stash "${stash.message}"? Its changes are lost.`, { title: 'Delete stash', kind: 'warning' })) void stashAction('Deleting stash…', () => api.dropStash(repo!.id, stash, repo!.token)); };
    actions.append(back, drop); item.append(title, meta, actions); return item;
  });
  if (!items.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = 'No stashes. Stash your changes to switch tasks without committing half-done work.'; items.push(empty); }
  get('stash-list').replaceChildren(...items); updateControls();
}
async function openStashes() {
  if (!repo || busy) return;
  await run('Loading stashes…', async () => { renderStashes(await api.stashes(repo!.id)); input('stash-name').value = ''; dialog('stash-dialog').showModal(); notify('Ready'); });
}
async function stashAction(label: string, action: () => Promise<RepoInfo>) {
  if (!repo || busy) return;
  await mutate(label, action);
  if (repo && dialog('stash-dialog').open) renderStashes(await api.stashes(repo.id).catch(() => []));
}
const size = (bytes: number) => bytes < 1e6 ? Math.ceil(bytes / 1e3) + ' KB' : bytes < 1e9 ? (bytes / 1e6).toFixed(1) + ' MB' : (bytes / 1e9).toFixed(1) + ' GB';
let junk: Junk[] = [];
function renderJunk() {
  const items = junk.map(entry => {
    const item = document.createElement('li');
    const label = document.createElement('label'); label.className = 'row';
    const box = document.createElement('input'); box.type = 'checkbox'; box.value = entry.id; box.onchange = updateJunkTotal;
    const title = document.createElement('strong'); title.textContent = entry.path;
    const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = size(entry.bytes);
    label.append(box, title); item.append(label, meta); return item;
  });
  if (!items.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = 'Nothing ignored to clean up.'; items.push(empty); }
  get('cleanup-list').replaceChildren(...items); updateJunkTotal();
}
function chosenJunk() { return junk.filter(entry => get('cleanup-list').querySelector<HTMLInputElement>(`input[value="${entry.id}"]`)?.checked); }
function updateJunkTotal() {
  const chosen = chosenJunk();
  button('cleanup-delete').textContent = chosen.length ? `Delete selected (${size(chosen.reduce((sum, entry) => sum + entry.bytes, 0))})` : 'Delete selected';
}
async function openCleanup() {
  if (!repo || busy) return;
  await run('Measuring ignored files…', async () => { junk = await api.junk(repo!.id); renderJunk(); dialog('cleanup-dialog').showModal(); notify('Ready'); });
}
async function cleanupAction(label: string, action: () => Promise<RepoInfo>) {
  if (!repo || busy) return;
  await mutate(label, action);
  if (repo && dialog('cleanup-dialog').open) { junk = await api.junk(repo.id).catch(() => []); renderJunk(); }
}
async function mergeRef(ref: RefInfo) {
  if (!repo || busy) return;
  if (await confirm(`Merge "${ref.name}" into ${repo.branch ?? 'the current branch'}?`, { title: 'Merge branch', kind: 'warning' })) await mutate('Merging ' + ref.name + '…', () => api.mergeRef(repo!.id, ref.id, repo!.token));
}
async function removeTag(ref: RefInfo) {
  if (!repo || busy) return;
  if (await confirm(`Delete the local tag "${ref.name}"?`, { title: 'Delete tag', kind: 'warning' })) await mutate('Deleting tag…', () => api.deleteTag(repo!.id, ref.id, repo!.token));
}
function beginTag() { if (!details || busy) return; input('tag-name').value = ''; input('tag-message').value = ''; dialog('tag-dialog').showModal(); input('tag-name').focus(); }
function beginReset() { if (details && !busy) dialog('reset-dialog').showModal(); }
async function applySelectedCommit(revert: boolean) {
  if (!repo || !details || busy) return;
  const verb = revert ? 'Revert' : 'Cherry-pick';
  const mergeNote = details.parents.length > 1 ? ' This is a merge commit; Git will use parent 1 (the branch it was merged into).' : '';
  if (await confirm(`${verb} ${short(details.oid)}?${mergeNote}`, { title: verb + ' commit', kind: 'warning' })) await mutate(verb + ' commit…', () => api.applyCommit(repo!.id, details!.oid, revert, repo!.token));
}
let bumpBeforeAmend: string | null = null;
function setAmend(on: boolean) {
  input('amend').checked = on; button('commit-button').textContent = on ? 'Amend commit' : 'Commit staged';
  // The commit being replaced usually carries its version bump already.
  if (on && bumpBeforeAmend === null) { bumpBeforeAmend = select('bump').value; select('bump').value = ''; }
  if (!on && bumpBeforeAmend !== null) { select('bump').value = bumpBeforeAmend; bumpBeforeAmend = null; }
  updateControls();
}
input('amend').onchange = async () => {
  setAmend(input('amend').checked);
  if (!input('amend').checked || input('summary').value.trim() || !repo?.head) return;
  // Start from the message being replaced.
  try {
    const [summary, ...rest] = (await api.details(repo.id, repo.head)).message.split('\n');
    input('summary').value = summary; get<HTMLTextAreaElement>('body').value = rest.join('\n').trim(); saveDraft(); renderSummaryHint(); updateControls();
  } catch (error) { report(error); }
};
function openClone() {
  if (busy) return;
  input('clone-url').value = ''; input('clone-parent').value = stored('cloneParent') ?? '';
  dialog('clone-dialog').showModal(); input('clone-url').focus();
}
button('clone-browse').onclick = async () => {
  const path = await open({ directory: true, multiple: false, title: 'Choose where to put the project' }).catch(report);
  if (typeof path === 'string') { input('clone-parent').value = path; save('cloneParent', path); }
};
get<HTMLFormElement>('clone-form').onsubmit = event => {
  event.preventDefault();
  const url = input('clone-url').value.trim(); const parent = input('clone-parent').value;
  if (!url || !parent) { (url ? button('clone-browse') : input('clone-url')).focus(); return; }
  dialog('clone-dialog').close();
  void run('Cloning…', () => openPath(url, () => api.clone(url, parent, progressReporter())));
};
let backgroundFetch: Promise<unknown> | null = null;
let lastFetch = 0;
/** Fetches the upstream remote every few minutes so "behind" counts stay true; failures stay silent. */
function fetchQuietly() {
  if (!repo?.remotes.length || busy || backgroundFetch || repo.operation || Date.now() - lastFetch < 5 * 60_000) return;
  const id = repo.id; const currentEpoch = epoch;
  const remote = repo.remotes.find(remote => repo!.upstream?.startsWith(remote.name + '/')) ?? repo.remotes.find(remote => remote.name === 'origin') ?? repo.remotes[0];
  lastFetch = Date.now();
  const fetching = api.fetch(repo.id, remote.id, () => {}).catch(() => null);
  backgroundFetch = fetching;
  void fetching.then(info => { backgroundFetch = null; if (info && repo?.id === id && epoch === currentEpoch) void checkForChanges(); });
}
let update: [string, string] | null = null;
async function checkUpdates(manual = false) {
  if (!manual && Date.now() - Number(stored('updateChecked') ?? 0) < 86_400_000) return;
  save('updateChecked', String(Date.now()));
  const [latest, current] = await Promise.all([api.latestRelease(), getVersion()]);
  update = latest && isNewer(latest[0], current) ? latest : null;
  renderInfo();
  if (manual) notify(update ? 'GitGUI ' + update[0] + ' is available' : 'GitGUI ' + current + ' is the newest version');
}
function openBranches() {
  if (!repo || busy) return;
  const branches = select('branch-select'); branches.replaceChildren();
  for (const ref of page?.refs.filter(ref => ref.kind === 'local') ?? []) branches.append(option(ref.id, (ref.isHead ? '✓ ' : '') + ref.name));
  get('branch-note').textContent = repo.head ? 'Creating a branch adds a name at the chosen commit. Switching keeps Git’s normal protection for working changes.' : 'Create the first commit before creating another branch.';
  select('branch-start').options[1].disabled = !selected;
  input('branch-rename').value = page?.refs.find(ref => ref.id === branches.value)?.name ?? '';
  updateControls(); dialog('branches').showModal();
}
async function deleteBranch() {
  if (!repo || busy) return;
  const id = select('branch-select').value; const name = page?.refs.find(ref => ref.id === id)?.name ?? '';
  if (!await confirm(`Delete the branch "${name}"? Git refuses if its commits exist nowhere else.`, { title: 'Delete branch', kind: 'warning' })) return;
  dialog('branches').close(); scope = null;
  await mutate('Deleting branch…', () => api.deleteBranch(repo!.id, id, false, repo!.token));
  if (!get('error').hidden && /exist nowhere else/.test(get('error-text').textContent ?? '') && await confirm(`"${name}" has commits that exist nowhere else. Delete it anyway and lose them?`, { title: 'Force delete branch', kind: 'warning' })) {
    await mutate('Deleting branch…', () => api.deleteBranch(repo!.id, id, true, repo!.token));
  }
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
select('recent-repos').onchange = () => { const path = select('recent-repos').value; if (path && path !== repo?.root) void run('Opening repository…', () => openSaved(path)); };
button('welcome-open').onclick = () => { void chooseRepository(); };
button('init-repo').onclick = () => { void initRepository(); };
button('clone-repo').onclick = openClone;
button('welcome-clone').onclick = openClone;
button('stash-button').onclick = () => { void openStashes(); };
button('commit-revert').onclick = () => { void applySelectedCommit(true); };
button('commit-cherry-pick').onclick = () => { void applySelectedCommit(false); };
button('commit-tag').onclick = beginTag;
button('commit-reset').onclick = beginReset;
get<HTMLFormElement>('tag-form').onsubmit = event => { event.preventDefault(); if (!repo || !details) return; const name = input('tag-name').value.trim(), message = input('tag-message').value.trim(), oid = details.oid; dialog('tag-dialog').close(); void mutate('Creating tag…', () => api.createTag(repo!.id, name, message, oid, repo!.token)); };
get<HTMLFormElement>('reset-form').onsubmit = async event => { event.preventDefault(); if (!repo || !details) return; const oid = details.oid, mode = select('reset-mode').value; const effects = mode === 'soft' ? 'keep changes staged' : mode === 'mixed' ? 'keep changes unstaged' : 'discard tracked changes (untracked files stay; a checkpoint is saved first)'; if (!await confirm(`Reset ${repo.branch ?? 'the current branch'} to ${short(oid)} and ${effects}?`, { title: 'Reset branch', kind: 'warning' })) return; dialog('reset-dialog').close(); await mutate('Resetting branch…', () => api.resetCommit(repo!.id, oid, mode, repo!.token)); };
button('cleanup-button').onclick = () => { void openCleanup(); };
button('ignore-close').onclick = () => dialog('ignore-dialog').close();
button('ignore-file').onclick = () => { void ignoreTargetAs(false); };
button('ignore-folder').onclick = () => { void ignoreTargetAs(true); };
button('file-history-close').onclick = () => dialog('file-history-dialog').close();
button('detail-file-history').onclick = () => {
  const file = details?.files.find(item => item.id === select('detail-file').value);
  if (file) void openFileHistory(file.id, details!.oid, file.path);
};
button('cleanup-delete').onclick = async () => {
  const chosen = chosenJunk(); if (!chosen.length) return;
  const names = chosen.map(entry => entry.path).join(', ');
  if (await confirm(`Permanently delete ${names}? Git cannot bring these back; build tools recreate what they need.`, { title: 'Free up space', kind: 'warning' })) void cleanupAction('Deleting ignored files…', () => api.deleteJunk(repo!.id, chosen.map(entry => entry.id), repo!.token));
};
button('cleanup-compact').onclick = () => { void cleanupAction('Compacting Git data…', () => api.compact(repo!.id)); };
button('stash-changes').onclick = () => { void openStashes().then(() => input('stash-name').focus()); };
get<HTMLFormElement>('stash-form').onsubmit = event => { event.preventDefault(); const name = input('stash-name').value; input('stash-name').value = ''; void stashAction('Stashing changes…', () => api.stash(repo!.id, name, repo!.token)); };
button('update-button').onclick = () => { void run('Checking for updates…', () => checkUpdates(true)); };
button('enable-versioning').onclick = () => { void enableVersioning(); };
button('checkpoints-button').onclick = () => { void openCheckpoints(); };
get<HTMLFormElement>('checkpoint-form').onsubmit = event => { event.preventDefault(); void saveCheckpoint(); };
button('refresh').onclick = () => {
  const icon = get('refresh-icon'); icon.classList.remove('spinning'); void icon.getBoundingClientRect(); icon.classList.add('spinning');
  void run('Refreshing…', refresh);
};
// Fetch/Pull/Push stay visible in every repository; without a remote they lead to Publish.
button('fetch').onclick = () => { if (repo && !repo.remotes.length) openPublish(); else chooseRemote('fetch'); };
button('pull').onclick = () => { if (repo && !repo.remotes.length) openPublish(); else if (repo) void mutate('Pulling fast-forward update…', () => api.pull(repo!.id, repo!.token, progressReporter())); };
button('push').onclick = () => { if (!repo) return; if (!repo.remotes.length) openPublish(); else if (!repo.upstream) chooseRemote('push'); else void mutate('Pushing current branch…', () => api.push(repo!.id, null, repo!.token, progressReporter())); };
button('details-button').onclick = () => { if (get('details').hidden) { void openDetails(); get('details').focus(); } else closeDetails(); };
button('close-details').onclick = closeDetails;
input('history-search').oninput = () => searchHistory(true);
input('history-search').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); input('history-search').value = ''; searchHistory(); }
};
button('search-all').onclick = () => {
  if (!repo || busy) return;
  limit = 10000;
  void run('Loading all history…', async () => { await loadGraph(); searchHistory(true); notify(page!.commits.length + ' commits searched'); });
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
button('copy-sha').onclick = async () => {
  if (!details) return;
  const oid = details.oid;
  try { await navigator.clipboard.writeText(oid); }
  catch { input('detail-sha').select(); if (!document.execCommand('copy')) { notify('Select the commit ID and copy it manually.'); return; } }
  notify('Copied ' + short(oid));
};
input('summary').oninput = () => { saveDraft(); renderSummaryHint(); updateControls(); };
get<HTMLTextAreaElement>('body').oninput = saveDraft;
get<HTMLFormElement>('commit-form').onsubmit = event => { event.preventDefault(); void commitChanges(); };
input('branch-name').oninput = updateControls;
select('branch-select').onchange = () => { input('branch-rename').value = page?.refs.find(ref => ref.id === select('branch-select').value)?.name ?? ''; updateControls(); };
input('branch-rename').oninput = updateControls;
button('rename-branch').onclick = () => { if (!repo) return; const id = select('branch-select').value; const name = input('branch-rename').value.trim(); dialog('branches').close(); scope = null; void mutate('Renaming branch…', () => api.renameBranch(repo!.id, id, name, repo!.token)); };
button('delete-branch').onclick = () => { void deleteBranch(); };
button('switch-branch').onclick = () => { if (!repo) return; const id = select('branch-select').value; dialog('branches').close(); scope = null; void mutate('Switching branch…', () => api.switchBranch(repo!.id, id, repo!.token)); };
button('create-branch').onclick = () => { if (!repo) return; const name = input('branch-name').value.trim(); const oid = select('branch-start').value === 'selected' ? selected : null; dialog('branches').close(); void mutate('Creating branch…', () => api.createBranch(repo!.id, name, oid, repo!.token)); };
select('remote-select').onchange = remoteUrl;
get<HTMLFormElement>('remote-form').onsubmit = event => { event.preventDefault(); if (!repo || busy) return; const remoteId = select('remote-select').value; dialog('remote-dialog').close(); if (remoteAction === 'fetch') void mutate('Fetching remote…', () => api.fetch(repo!.id, remoteId, progressReporter())); else void mutate('Publishing current branch…', () => api.push(repo!.id, remoteId, repo!.token, progressReporter())); };
button('publish').onclick = openPublish;
get<HTMLFormElement>('publish-form').onsubmit = event => { event.preventDefault(); void publish(); };
get<HTMLFormElement>('publish-form').onchange = () => { const useUrl = get<HTMLFormElement>('publish-form').querySelector<HTMLInputElement>('input[name="publish-mode"]:checked')?.value === 'url'; input('publish-url').disabled = !useUrl; if (useUrl) input('publish-url').focus(); };
const refMenu = document.createElement('div'); refMenu.className = 'menu-list ref-menu'; refMenu.setAttribute('role', 'menu'); refMenu.hidden = true; document.body.append(refMenu);
let refMenuOwner: HTMLButtonElement | null = null;
function closeRefMenu() { refMenu.hidden = true; refMenuOwner?.setAttribute('aria-expanded', 'false'); refMenuOwner = null; }
function openRefMenu(owner: HTMLButtonElement, actions: [string, () => void][]) {
  const reopen = refMenuOwner !== owner; closeRefMenu(); if (!reopen) return;
  refMenu.replaceChildren(...actions.map(([label, run]) => {
    const entry = document.createElement('button'); entry.type = 'button'; entry.setAttribute('role', 'menuitem'); entry.textContent = label;
    entry.onclick = () => { closeRefMenu(); owner.focus(); run(); }; return entry;
  }));
  refMenu.hidden = false; refMenuOwner = owner; owner.setAttribute('aria-expanded', 'true');
  const box = owner.getBoundingClientRect(), width = refMenu.offsetWidth, height = refMenu.offsetHeight;
  // Fixed to the viewport so the scrolling sidebar never clips it; flips up near the bottom edge.
  // Right-aligned to the button so the menu opens away from the list scrollbar on its right.
  refMenu.style.left = Math.max(8, box.right - width) + 'px';
  refMenu.style.top = (box.bottom + 4 + height > innerHeight - 8 ? Math.max(8, box.top - 4 - height) : box.bottom + 4) + 'px';
  refMenu.querySelector('button')?.focus();
}
refMenu.addEventListener('keydown', event => {
  const items = [...refMenu.querySelectorAll('button')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); const owner = refMenuOwner; closeRefMenu(); owner?.focus(); }
});
document.addEventListener('click', event => { if (!refMenu.hidden && !refMenu.contains(event.target as Node)) closeRefMenu(); });
get('ref-list').addEventListener('scroll', closeRefMenu); window.addEventListener('resize', closeRefMenu);
function closeTools() { get('tools-menu').hidden = true; button('tools-button').setAttribute('aria-expanded', 'false'); }
button('tools-button').onclick = event => {
  event.stopPropagation(); const menu = get('tools-menu'); menu.hidden = !menu.hidden;
  button('tools-button').setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
};
get('tools-menu').addEventListener('click', closeTools);
get('tools-menu').addEventListener('keydown', event => {
  const items = [...get('tools-menu').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  if (event.key === 'Escape') { event.stopPropagation(); closeTools(); button('tools-button').focus(); }
});
document.addEventListener('click', event => { if (!get('tools-menu').hidden && !get('tools-menu').contains(event.target as Node)) closeTools(); });
button('ai-settings-menu').onclick = () => { void showKeyForm(); };
button('session-button').onclick = () => { void openSession(); };
button('session-explain').onclick = () => { void explainChanges('session', 'What the AI changed'); };
button('session-undo-all').onclick = () => { void undoSession(sessionFiles.map(file => file.path)); };
button('experiment-button').onclick = () => { if (repo && !busy) { input('experiment-name').value = ''; dialog('experiment-dialog').showModal(); } };
get<HTMLFormElement>('experiment-form').onsubmit = event => { event.preventDefault(); const name = input('experiment-name').value.trim(); dialog('experiment-dialog').close(); if (repo && name) void mutate('Starting experiment…', () => api.startExperiment(repo!.id, name, repo!.token)); };
button('experiment-keep').onclick = () => { void finishExperiment(true); };
button('experiment-discard').onclick = () => { void finishExperiment(false); };
button('operation-continue').onclick = () => { if (repo) void mutate('Continuing ' + repo.operation + '…', () => api.finishOperation(repo!.id, false, repo!.token)); };
button('operation-abort').onclick = () => { void abortOperation(); };
button('undo-commit').onclick = () => { void undoCommit(); };
button('rebase-button').onclick = () => { void openRebase(); };
button('rebase-apply').onclick = () => { void applyRebase(); };
button('ai-message').onclick = () => { void writeMessage(); };
button('ai-settings').onclick = () => { void showKeyForm(); };
button('ai-settings-open').onclick = () => { void showKeyForm(); };
button('ai-explain').onclick = () => { void explainChanges('staged', 'Staged changes explained'); };
button('commit-explain').onclick = () => { if (details) void explainChanges('commit:' + details.oid, 'Commit ' + short(details.oid) + ' explained'); };
button('create-pr-button').onclick = () => { void openPullRequest(); };
button('pr-write-ai').onclick = () => { void writePullRequestWithAi(); };
get<HTMLFormElement>('pull-request-form').onsubmit = event => { event.preventDefault(); void createPullRequest(); };
get<HTMLFormElement>('key-form').onsubmit = event => { event.preventDefault(); void saveKey(); };
button('run-button').onclick = () => { if (repo) dialog('run-dialog').showModal(); };
button('run-start').onclick = () => { void startRun(); };
button('run-stop').onclick = () => { void api.stopProject().catch(report); };
button('rules-button').onclick = () => { void openRules(); };
button('rules-starter').onclick = () => { const text = get<HTMLTextAreaElement>('rules-text'); if (!text.value.includes(STARTER_RULES.split('\n')[0])) text.value = (text.value.trim() ? text.value.trimEnd() + '\n\n' : '') + STARTER_RULES; };
get<HTMLFormElement>('rules-form').onsubmit = event => { event.preventDefault(); void saveRules(); };
button('help-button').onclick = () => dialog('help-dialog').showModal();
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && repo) { event.preventDefault(); input('history-search').focus(); input('history-search').select(); }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && !get('details').hidden) { event.preventDefault(); moveDetailFile(event.key === 'ArrowDown' ? 1 : -1); }
  if (event.key === 'Escape' && !get('details').hidden && !document.querySelector('dialog[open]') && document.activeElement !== input('history-search')) closeDetails();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!busy) void chooseRepository(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); if (repo && !busy) void run('Refreshing…', refresh); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); if (!button('push').disabled) button('push').click(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && get('commit-form').contains(document.activeElement)) { event.preventDefault(); void commitChanges(); }
});
let focusCheck: Promise<void> | null = null;
// Returning to the window re-reads status quietly and reloads history only when something changed.
async function checkForChanges() {
  if (!repo || busy || document.querySelector('dialog[open]')) return;
  const id = repo.id; const currentEpoch = epoch;
  let next: RepoInfo;
  try { next = await readDetail(api.status(id)); } catch { return; }
  if (busy || currentEpoch !== epoch || repo?.id !== id) return;
  if (JSON.stringify(next) !== JSON.stringify(repo)) { await run('Refreshing…', refresh); return; }
  if (workingFile && !get('changes').hidden) {
    try { await refreshWorkingPreview(true); } catch { /* The next explicit refresh reports preview errors. */ }
  }
}
// Refresh quietly, then save a checkpoint if the window has been away for a while.
window.addEventListener('focus', () => { focusCheck ??= checkForChanges().then(() => autoCheckpoint()).finally(() => { focusCheck = null; fetchQuietly(); }); });
window.setInterval(fetchQuietly, 60_000);
updateControls();
if (isTauri()) {
  get('window-controls').hidden = false;
  button('window-minimize').onclick = () => { void getCurrentWindow().minimize(); };
  button('window-maximize').onclick = () => { void getCurrentWindow().toggleMaximize(); };
  button('window-close').onclick = () => { void getCurrentWindow().close(); };
  void getVersion().then(version => { get('app-version').textContent = 'v' + version; get('app-version').hidden = false; }).catch(report);
  void getCurrentWindow().onCloseRequested(async event => {
    if (writing) { event.preventDefault(); await nativeMessage('A Git operation is still running. Wait for it to finish before closing GitGUI.', { title: 'Git operation in progress', kind: 'info' }); }
  }).catch(report);
  void run('Starting…', async () => {
    const requested = await api.startup();
    const last = requested ?? stored('lastRepository');
    let paths: string[] = [];
    try { const saved = JSON.parse(stored('openRepositories') ?? '[]'); if (Array.isArray(saved)) paths = saved.filter((path): path is string => typeof path === 'string'); } catch { /* Ignore malformed tab state. */ }
    if (requested) paths = [requested, ...paths.filter(path => path !== requested)];
    if (last && !paths.includes(last)) paths.unshift(last);
    for (const path of paths.slice(0, 12)) {
      // openSaved forgets folders that were moved or deleted.
      try { await openSaved(path); } catch (error) { if (!String(error).includes('no longer available')) throw error; }
    }
    const active = openRepos.find(item => item.root === last);
    if (active) { save('lastRepository', active.root); if (active.id !== repo?.id) await activateRepository(active, true); }
    if (!repo) notify('Open a repository to begin.');
  });
  if (!stored('onboarded')) { save('onboarded', '1'); dialog('help-dialog').showModal(); }
  void checkUpdates().catch(() => { /* Offline: try again tomorrow. */ });
} else {
  get('welcome').querySelector('p')!.textContent = 'Launch the GitGUI desktop app to work with local repositories.';
  button('welcome-open').disabled = true; button('open-repo').disabled = true; button('init-repo').disabled = true; button('clone-repo').disabled = true; button('welcome-clone').disabled = true; notify('Desktop runtime required');
}
