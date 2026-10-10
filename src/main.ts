import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, confirm, message as nativeMessage } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, type AiProvider, type Answer, type Checkpoint, type Session, type SessionFile, type RepoInfo, type GraphPage, type CommitDetails, type Preview, type FileInfo } from './git.ts';
import { findCommits, layoutHistory, paintGraph, type Layout } from './graph.ts';
import { numberDiff } from './diff.ts';
import { wireDropdown } from './dropdown.ts';
import { aiCost, explainCrash, explainError, explainState, sortByRisk } from './explain.ts';
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
    <span class="toolbar-status"><span id="status" role="status" aria-live="polite">Ready</span><span id="operation-feedback" hidden><progress id="operation-progress" aria-label="Git operation progress" max="100"></progress><span id="operation-elapsed"></span></span></span>
    <div class="toolbar-actions"><button id="publish" data-repo hidden title="Back up this project online: a new private GitHub repository or one you already made">Publish</button><button id="fetch" data-repo data-tip="Fetch: download news from the server without changing your files"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-fetch"/></svg>Fetch</button><button id="pull" data-repo data-tip="Pull: download the server's new commits into your branch"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-pull"/></svg>Pull<span class="count" id="behind-count" hidden></span></button><button id="push" data-repo data-tip="Push: upload your commits to the server (your backup)"><svg class="chrome-icon" aria-hidden="true"><use href="#chrome-push"/></svg>Push<span class="count" id="ahead-count" hidden></span></button>
    <button id="refresh" data-repo><svg class="chrome-icon" id="refresh-icon" aria-hidden="true"><use href="#chrome-refresh"/></svg>Refresh</button></div>
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
    <span class="experiment-bar" id="experiment-bar" hidden>Experiment<button id="experiment-keep" data-repo title="Merge this experiment into the branch it started from">Keep it</button><button id="experiment-discard" data-repo title="Delete this experiment and return to where you were">Throw it away</button></span>
    <div class="menu"><button id="tools-button" aria-haspopup="menu" aria-expanded="false" aria-controls="tools-menu">Tools<svg class="chrome-icon" aria-hidden="true"><use href="#chrome-chevron"/></svg></button>
      <div class="menu-list" id="tools-menu" role="menu" hidden>
        <button role="menuitem" id="session-button" data-repo title="See what changed since your last checkpoint or commit, riskiest first, and undo single files">Review AI changes</button>
        <button role="menuitem" id="experiment-button" data-repo title="Work on a throwaway copy (a branch) that you can keep or discard">Try something risky</button>
        <button role="menuitem" id="run-button" data-repo title="Start your app and watch its output">Run project</button>
        <button role="menuitem" id="rules-button" data-repo title="Rules every AI agent reads before changing this project (AGENTS.md)">AI rules</button>
        <button role="menuitem" id="ai-settings-menu" title="Choose Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI">AI settings</button>
        <button role="menuitem" id="help-button" title="How GitGUI works and what the Git words mean">Help</button>
      </div>
    </div>
    <button class="chip" id="changes-button" data-repo>Changes <span class="mono" id="changes-count">0</span></button>
  </nav>
  <div class="errorbar" id="error" role="alert" hidden><p id="error-text"></p><button id="dismiss-error" aria-label="Dismiss error">Close</button></div>
  <ul class="hintbar" id="git-hint" aria-label="Tips about this repository" hidden></ul>
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
      <header class="panelbar"><h2>Working changes</h2><span id="operation-note" class="muted"></span><button id="operation-continue" class="chip" hidden title="Finish the merge, rebase, cherry-pick or revert now that conflicts are resolved">Continue</button><button id="operation-abort" hidden title="Cancel it and go back to how things were before it started">Abort</button><span class="spacer"></span><button id="undo-commit" data-repo title="Take back the last commit (if not pushed yet); its changes stay staged">Undo last commit</button><button id="close-changes">Close</button></header>
      <div class="changes-body">
        <div class="file-list" id="file-list"></div>
        <div class="working-preview"><div class="preview-label" id="working-path">Select a file to review its diff.</div><pre class="diff" id="working-diff"></pre></div>
        <form class="composer" id="commit-form">
          <label for="summary">Summary</label><input id="summary" required maxlength="1000" autocomplete="off" placeholder="Describe this commit">
          <label for="body">Description <span class="muted">(optional)</span></label><textarea id="body" maxlength="64000" rows="3"></textarea>
          <div class="commit-row"><button type="button" id="ai-message" data-repo title="Let the AI write the commit message from the staged changes">Write message with AI</button><button type="button" id="ai-explain" data-repo title="Let the AI explain the staged changes in plain English">Explain staged changes</button><button type="button" id="ai-settings" title="Choose Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI">AI settings</button></div>
          <div class="commit-row"><span id="version-controls"><label for="bump">Version <span class="mono" id="repo-version"></span></label> <select id="bump" data-repo><option value="minor">Minor · feature</option><option value="patch">Patch · fix</option><option value="major">Major · breaking</option><option value="">No bump</option></select></span><button id="enable-versioning" data-repo title="Block secrets and failing tests, and give every code commit its own version">Enable safeguards</button></div>
          <div class="commit-row"><span id="staged-count">0 staged files</span><button class="primary" id="commit-button" type="submit" data-repo>Commit staged</button></div>
        </form>
      </div>
    </section>
    </div>
  </main>
  <dialog class="branch-dialog" id="branches" aria-labelledby="branches-title">
    <div class="dialog-head"><h2 id="branches-title">Branches</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <div class="form-grid"><label for="branch-select">Switch to a local branch</label><select id="branch-select"></select><div class="row"><button class="chip" id="switch-branch">Switch branch</button></div>
      <label for="branch-rename">Rename the chosen branch</label><input id="branch-rename" maxlength="1024" autocomplete="off" placeholder="new-name">
      <div class="row"><button class="chip" id="rename-branch">Rename branch</button><button id="delete-branch" title="Delete the chosen branch (not the one you are on)">Delete branch</button></div>
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
  <dialog class="branch-dialog wide-dialog" id="session-dialog" aria-labelledby="session-title">
    <div class="dialog-head"><h2 id="session-title">What did the AI change?</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <p id="session-note" class="muted"></p><ul class="health-list" id="health-list"></ul>
    <div class="row"><button class="chip" id="session-explain">Explain with AI</button><button id="session-undo-all">Undo all</button></div>
    <ol class="checkpoint-list" id="session-list"></ol><pre class="diff dialog-pre" id="session-diff"></pre>
  </dialog>
  <dialog class="branch-dialog" id="publish-dialog" aria-labelledby="publish-title">
    <div class="dialog-head"><h2 id="publish-title">Back up your code online</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="publish-form" class="form-grid">
      <label for="publish-main">Main branch (GitHub shows this one first)</label><select id="publish-main"></select>
      <label class="choice"><input type="radio" name="publish-mode" value="github" checked> Create a new private GitHub repository (needs the GitHub CLI, signed in once with <code>gh auth login</code>)</label>
      <label class="choice"><input type="radio" name="publish-mode" value="url"> Use an empty repository I already made</label>
      <input id="publish-url" aria-label="Repository address" autocomplete="off" placeholder="https://github.com/you/project.git" disabled>
      <p class="muted">GitGUI uploads the main branch first, then the branch you are on.</p>
      <div class="row"><button class="primary" type="submit">Publish</button></div>
    </form>
  </dialog>
  <dialog class="branch-dialog" id="experiment-dialog" aria-labelledby="experiment-title">
    <div class="dialog-head"><h2 id="experiment-title">Try something risky</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <form id="experiment-form" class="form-grid"><p>GitGUI makes a separate copy of your code (a branch). Let the AI try anything there, then <strong>Keep it</strong> to bring the changes back or <strong>Throw it away</strong> to return exactly to where you were.</p><label for="experiment-name">What are you trying?</label><input id="experiment-name" maxlength="80" required autocomplete="off" placeholder="new login page"><div class="row"><button class="primary" type="submit">Start experiment</button></div></form>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="run-dialog" aria-labelledby="run-title">
    <div class="dialog-head"><h2 id="run-title">Run project</h2><span class="spacer"></span><button class="primary" id="run-start">Start</button><button id="run-stop" disabled>Stop</button><form method="dialog"><button type="submit">Close</button></form></div>
    <p class="muted">GitGUI guesses the start command (npm run dev, cargo run, python main.py…). Change it with <code>git config gitgui.runCommand "&lt;command&gt;"</code>.</p>
    <p class="run-hint" id="run-hint" role="alert" hidden></p><pre class="diff dialog-pre" id="run-output" aria-live="off"></pre>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="rules-dialog" aria-labelledby="rules-title">
    <div class="dialog-head"><h2 id="rules-title">AI rules (AGENTS.md)</h2><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="rules-form" class="form-grid"><p class="muted">Claude Code, Codex, Cursor and other agents read these rules before changing your project. GitGUI also links them from CLAUDE.md.</p><textarea id="rules-text" rows="16" maxlength="200000" aria-label="Rules for AI agents"></textarea><div class="row"><button type="button" id="rules-starter">Add starter rules</button><button class="primary" type="submit">Save rules</button></div></form>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="ai-dialog" aria-labelledby="ai-title">
    <div class="dialog-head"><h2 id="ai-title">AI</h2><span class="spacer"></span><button type="button" id="ai-settings-open">AI settings</button><form method="dialog"><button type="submit">Close</button></form></div>
    <form id="key-form" class="form-grid" hidden>
      <label for="ai-preset">AI provider</label><select id="ai-preset"></select>
      <label for="ai-base-url" data-ai="openai">API address</label><input id="ai-base-url" data-ai="openai" autocomplete="off" placeholder="https://api.example.com/v1">
      <label for="ai-model" data-ai="openai">Model</label><input id="ai-model" data-ai="openai" autocomplete="off" placeholder="model name">
      <label for="ai-command" data-ai="command">Command (reads the request on stdin, prints the answer)</label><input id="ai-command" data-ai="command" autocomplete="off" placeholder="codex exec -">
      <label for="api-key" data-ai="claude openai">API key</label><input id="api-key" data-ai="claude openai" type="password" autocomplete="off" placeholder="Leave empty to keep the saved key">
      <p class="muted" id="ai-provider-note"></p>
      <div class="row"><button class="primary" type="submit">Save AI settings</button></div>
    </form>
    <pre class="message ai-answer" id="ai-answer"></pre><p class="muted" id="ai-usage"></p>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="help-dialog" aria-labelledby="help-title">
    <div class="dialog-head"><h2 id="help-title">Welcome to GitGUI</h2><form method="dialog"><button type="submit">Got it</button></form></div>
    <ol class="tour">
      <li><strong>New project:</strong> Init repository creates one with safeguards: secrets and failing tests are blocked and every feature gets its own version.</li>
      <li><strong>Before asking an AI to change things:</strong> save a Checkpoint, or use Try something risky for big ideas.</li>
      <li><strong>After the AI is done:</strong> Review AI changes shows every changed file, riskiest first. Undo single files, or let the AI explain them. Pick Claude, DeepSeek, OpenAI, Ollama, Codex, opencode, or any other AI in AI settings.</li>
      <li><strong>Happy with it?</strong> In Changes, stage the files, press Write message with AI, choose a version, and Commit.</li>
      <li><strong>Back it up:</strong> Publish to GitHub once, then Push after each commit.</li>
      <li><strong>Something broke?</strong> Run shows your app's output and explains common crashes; Checkpoints and Undo last commit take you back.</li>
    </ol>
    <dl class="glossary">
      <dt>Commit</dt><dd>A saved version of your project with a message saying what changed.</dd>
      <dt>Stage</dt><dd>Choose which changed files go into the next commit.</dd>
      <dt>Branch</dt><dd>A separate line of work. Experiments are branches.</dd>
      <dt>Remote / GitHub</dt><dd>A copy of your project on a server: your backup and how you share code.</dd>
      <dt>Push / Pull / Fetch</dt><dd>Upload your commits / download others' commits / check for news without changing files.</dd>
      <dt>Merge conflict</dt><dd>Two changes edited the same lines; you pick which one to keep.</dd>
      <dt>Checkpoint</dt><dd>A GitGUI snapshot of all files that is not a commit; restore it any time.</dd>
      <dt>HEAD</dt><dd>The commit you are on right now.</dd>
    </dl>
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
  control.disabled = !!reason; control.title = reason || control.dataset.tip || '';
  if (reason) control.setAttribute('aria-description', reason); else control.removeAttribute('aria-description');
}
function updateControls() {
  const unavailable = busy ? 'Wait for the current Git operation to finish.' : !repo ? 'Open a repository first.' : '';
  const blocked = unavailable || (repo?.operation ? 'Finish the ' + repo.operation + ' first (Continue or Abort in Changes).' : '');
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-repo]').forEach(node => { node.disabled = !!unavailable; if (unavailable) node.setAttribute('aria-description', unavailable); else node.removeAttribute('aria-description'); });
  disable('open-repo', busy ? unavailable : ''); disable('init-repo', busy ? unavailable : ''); disable('welcome-open', busy ? unavailable : '');
  disable('details-button', unavailable || (!selected ? 'Select a commit to review its details.' : ''));
  disable('fetch', blocked || (!repo?.remotes.length ? 'Configure a remote with Git, then refresh.' : ''));
  disable('pull', blocked || (!repo?.upstream ? 'Publish this branch to set its upstream before pulling.' : repo.files.length ? 'Commit or resolve working changes before pulling.' : ''));
  disable('push', blocked || (!repo?.branch ? 'Switch to a local branch before pushing.' : !repo.remotes.length ? 'Configure a remote with Git, then refresh.' : ''));
  disable('load-more', unavailable || (limit >= 10000 ? '10,000 commits loaded. Choose a narrower history scope.' : ''));
  disable('commit-button', blocked || (!stagedFiles().length ? 'Stage at least one file before committing.' : !input('summary').value.trim() ? 'Enter a commit summary.' : ''));
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
  get('behind-count').textContent = String(repo?.behind ?? 0); get('behind-count').hidden = !repo?.behind;
  get('ahead-count').textContent = String(repo?.ahead ?? 0); get('ahead-count').hidden = !repo?.ahead;
  const offline = !!repo && !repo.remotes.length;
  for (const id of ['fetch', 'pull', 'push']) get(id).hidden = offline;
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
async function openPath(path: string, load = api.open) {
  const next = await load(path); saveDraft();
  for (const id of ['branches', 'remote-dialog']) if (dialog(id).open) dialog(id).close();
  get('details').hidden = true;
  details = null; detailRequest++; workingRequest++;
  repo = next; epoch++; scope = null; limit = 200; page = null; selected = null; workingFile = null;
  checked.staged.clear(); checked.unstaged.clear(); input('branch-name').value = '';
  input('history-search').value = ''; searchMatches = [];
  save('recentRepositories', JSON.stringify([repo.root, ...recentRepositories().filter(path => path !== repo!.root)].slice(0, 8)));
  health = []; loadHealth();
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
const dismissedHints = new Set<string>();
function renderHints(state: string[], warnings: string[]) {
  const items = [...state.map(text => ({ text, kind: 'state' })), ...warnings.map(text => ({ text, kind: 'warning' }))]
    .filter(note => !dismissedHints.has(note.text))
    .map(note => {
      const item = document.createElement('li'); item.className = 'hint hint-' + note.kind;
      const text = document.createElement('span'); text.textContent = note.text;
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss this tip');
      close.onclick = () => { dismissedHints.add(note.text); renderInfo(); };
      item.append(text, close); return item;
    });
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

interface Preset { label: string; provider: AiProvider; note: string }
const PRESETS: Record<string, Preset> = {
  claude: { label: 'Claude (Anthropic)', provider: { kind: 'claude', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Uses claude-opus-5-5. Key from console.anthropic.com, or ANTHROPIC_API_KEY.' },
  deepseek: { label: 'DeepSeek', provider: { kind: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '', command: '' }, note: 'Key from platform.deepseek.com.' },
  openai: { label: 'OpenAI', provider: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', command: '' }, note: 'Key from platform.openai.com. Enter a model name.' },
  openrouter: { label: 'OpenRouter (many models)', provider: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', apiKey: '', command: '' }, note: 'Key from openrouter.ai. Model names look like vendor/model.' },
  groq: { label: 'Groq', provider: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: '', apiKey: '', command: '' }, note: 'Key from console.groq.com.' },
  ollama: { label: 'Ollama (local, free)', provider: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '', command: '' }, note: 'Runs on your computer; no key needed. Pull the model with ollama pull first.' },
  api: { label: 'Other OpenAI-compatible API', provider: { kind: 'openai', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Any service with an OpenAI-style /chat/completions endpoint (LM Studio, Together, Mistral, xAI…).' },
  codex: { label: 'Codex CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'codex exec --skip-git-repo-check -' }, note: 'Uses your Codex login. Agents run in an empty temporary folder, so they cannot edit your project.' },
  claudecode: { label: 'Claude Code CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'claude -p' }, note: 'Uses your Claude Code login. Runs in an empty temporary folder.' },
  opencode: { label: 'opencode CLI', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: 'opencode run "$(cat)"' }, note: 'Uses your opencode setup. Runs in an empty temporary folder.' },
  command: { label: 'Other command-line agent', provider: { kind: 'command', baseUrl: '', model: '', apiKey: '', command: '' }, note: 'Any command that reads the request on stdin and prints the answer. Runs in an empty temporary folder, for up to 10 minutes.' },
};
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
async function ask(request: 'explain' | 'message' | 'conflict', scope: string): Promise<Answer | null> {
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

const STARTER_RULES = `# Rules for AI agents
- Make one small change at a time and explain what you changed in plain English.
- Never delete, skip, or weaken tests to make them pass; fix the code instead.
- Never write API keys, passwords, or tokens into code; read them from an ignored .env file.
- Ask before adding a dependency, and only use well-known, maintained packages.
- Keep files under about 500 lines; split large files into modules.
- Run the tests before saying you are done, and report any that fail.
- Never use git commit --no-verify, force-push, or rewrite history.
- Do not change files unrelated to the task.`;
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
      const nameButton = document.createElement('button'); nameButton.type = 'button'; nameButton.textContent = (file.oldPath ? file.oldPath + ' → ' : '') + file.path; nameButton.title = nameButton.textContent;
      nameButton.addEventListener('click', () => { void showWorkingFile(file, !!staged); }); row.append(nameButton);
      if (staged === null) {
        for (const [label, choice, tip] of [['Keep ours', 'ours', 'Use the version from your current branch (during a rebase: the branch you rebase onto)'], ['Keep theirs', 'theirs', 'Use the incoming version'], ['Mark fixed', 'resolved', 'You edited the file and removed the <<<<<<< ======= >>>>>>> markers']] as const) {
          const action = document.createElement('button'); action.type = 'button'; action.textContent = label; action.title = tip; action.disabled = busy;
          action.setAttribute('aria-label', label + ' for ' + file.path);
          action.addEventListener('click', () => { if (repo) void mutate('Resolving ' + file.path + '…', () => api.resolveConflict(repo!.id, file.id, choice, repo!.token)); }); row.append(action);
        }
        const explain = document.createElement('button'); explain.type = 'button'; explain.textContent = 'Explain'; explain.title = 'Let the AI explain both sides of this conflict'; explain.disabled = busy;
        explain.addEventListener('click', () => { void explainChanges('conflict:' + file.id, 'Conflict in ' + file.path); }); row.append(explain);
      }
      list.append(row);
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
button('ai-message').onclick = () => { void writeMessage(); };
button('ai-settings').onclick = () => { void showKeyForm(); };
button('ai-settings-open').onclick = () => { void showKeyForm(); };
button('ai-explain').onclick = () => { void explainChanges('staged', 'Staged changes explained'); };
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
  if (!stored('onboarded')) { save('onboarded', '1'); dialog('help-dialog').showModal(); }
} else {
  get('welcome').querySelector('p')!.textContent = 'Launch the GitGUI desktop app to work with local repositories.';
  button('welcome-open').disabled = true; button('open-repo').disabled = true; button('init-repo').disabled = true; notify('Desktop runtime required');
}
