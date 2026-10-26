import { invoke } from '@tauri-apps/api/core';
import { wireDropdown } from './dropdown.ts';
import type { Preview, RepoInfo } from './git.ts';
import { addPending, checkSummary, type ReviewComment, type Side } from './github-model.ts';
import './github.css';

interface Person { login?: string; name?: string }
interface Item { number: number; title: string; state: string; author?: Person; body?: string }
interface Pull extends Item {
  headRefOid: string; headRefName: string; baseRefName: string; changedFiles: number;
  files: { path: string }[]; statusCheckRollup?: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[];
  reviewRequests?: Person[]; latestReviews?: { author?: Person; state: string }[];
}
interface Issue extends Item { comments: { author?: Person; body: string; createdAt: string }[] }
interface Run { databaseId: number; displayTitle: string; workflowName?: string; status: string; conclusion?: string; headBranch: string; jobs?: { name: string; status: string; conclusion?: string }[] }
interface Release { id: number; name: string | null; tag_name: string; body: string | null; published_at: string | null; draft: boolean; prerelease: boolean }
interface Notification { id: string; unread: boolean; repository: { full_name: string }; subject: { title: string; type: string }; reason: string }
type ReadRequest =
  | { kind: 'repository' | 'issues' | 'releases' | 'notifications' | 'readme' | 'branches' | 'commits' }
  | { kind: 'pulls'; filter: string } | { kind: 'pull' | 'issue'; number: number }
  | { kind: 'diff'; number: number; path: string | null } | { kind: 'runs'; branch: string | null }
  | { kind: 'run' | 'log'; number: number };
type WriteRequest =
  | { kind: 'checkout'; number: number; token: string }
  | { kind: 'merge'; number: number; method: string; head: string }
  | { kind: 'review'; number: number; head: string; event: string; body: string; comments: ReviewComment[] }
  | { kind: 'comment'; number: number; body: string } | { kind: 'issue_state'; number: number; state: string }
  | { kind: 'rerun'; number: number } | { kind: 'read_notification'; thread: string };
interface Draft { head: string; body: string; event: string; comments: ReviewComment[] }

interface Host {
  repo: () => RepoInfo | null;
  busy: () => boolean;
  change: (action: () => Promise<void>) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  preview: (id: string, preview: Preview, onLine?: (line: number, side: Side) => void) => void;
}

export function wireGithub(host: Host) {
  const panel = document.createElement('dialog'); panel.id = 'github-dialog'; panel.className = 'github-dialog';
  panel.setAttribute('aria-labelledby', 'github-title');
  panel.innerHTML = `<div class="dialog-head"><h2 id="github-title">GitHub</h2><button type="button" id="github-close">Close</button></div>
    <form id="github-repository-form" class="row"><label for="github-repository">Repository</label><input id="github-repository" placeholder="owner/repo" autocomplete="off" spellcheck="false" maxlength="240"><button type="submit">Browse read-only</button><button type="button" id="github-local">Local repository</button></form>
    <p id="github-context" class="muted"></p>
    <nav id="github-tabs" class="row" aria-label="GitHub sections"></nav>
    <p id="github-status" role="status" aria-live="polite"></p><p id="github-error" role="alert" hidden></p>
    <div id="github-controls" class="row"></div><div class="github-body"><div id="github-list" aria-label="GitHub results"></div><section id="github-detail" aria-label="Details"></section></div>`;
  document.body.append(panel);
  const get = <T extends HTMLElement = HTMLElement>(id: string) => panel.querySelector<T>('#github-' + id)!;
  const list = get('list'), detail = get('detail'), controls = get('controls');
  let local: RepoInfo | null = null, repository = '', browsing = false, loading = false;
  let section = 'pulls', filter = 'open', branch = '', browseSection = 'readme';
  const drafts = new Map<string, Draft>();
  const issueDrafts = new Map<string, string>();
  const tabs: [string, string][] = [['pulls', 'Pull requests'], ['issues', 'Issues'], ['runs', 'Actions'], ['releases', 'Releases'], ['notifications', 'Inbox'], ['browse', 'Browse']];
  let nextSelect = 0;
  let dropdowns: { control: HTMLSelectElement; dropdown: ReturnType<typeof wireDropdown> }[] = [];

  function text(tag: string, value: string, parent: HTMLElement = detail, className = '') {
    const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
  }
  function action(label: string, fn: () => Promise<void> | void, parent: HTMLElement = detail, write = false) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.disabled = loading;
    if (write) { button.dataset.githubWrite = ''; button.disabled = loading || browsing || !local; button.title = browsing || !local ? 'Writes are available for the local repository. Browsing is read-only.' : ''; }
    button.onclick = () => { void perform(fn); }; parent.append(button); return button;
  }
  function syncDisabled() {
    panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(node => {
      if (node.id === 'github-close') return;
      node.disabled = loading || (node.hasAttribute('data-github-write') && (browsing || !local));
    });
    dropdowns.forEach(({ dropdown }) => dropdown.sync());
    panel.setAttribute('aria-busy', String(loading));
  }
  async function perform(fn: () => Promise<void> | void) {
    if (loading) return;
    loading = true; syncDisabled(); get('error').hidden = true; get('status').textContent = 'Loading GitHub…';
    try { await fn(); get('status').textContent = 'Ready · lists show at most 50 items; file reviews show the first 100 files.'; }
    catch (error) { get('error').textContent = String(error); get('error').hidden = false; get('status').textContent = 'GitHub request failed. Your pending review and comment drafts are kept.'; }
    finally { loading = false; syncDisabled(); }
  }
  function read<T>(request: ReadRequest): Promise<T> {
    return invoke<T>('github_read', { repoId: local?.id ?? null, repository: repository || null, request });
  }
  async function write(request: WriteRequest) {
    if (browsing || !local || host.repo()?.id !== local.id) throw new Error('Reopen the GitHub panel for the current local repository.');
    const repoId = local.id;
    await host.change(() => invoke<void>('github_write', { repoId, repository, request }));
    local = host.repo();
  }
  function selectOptions(label: string, options: [string, string][], value: string, changed: (value: string) => void, parent = controls) {
    const select = document.createElement('select'); select.id = 'github-select-' + ++nextSelect; select.setAttribute('aria-label', label); select.disabled = loading;
    for (const [value, label] of options) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
    select.value = value; select.onchange = () => { changed(select.value); };
    parent.append(select); dropdowns.push({ control: select, dropdown: wireDropdown(select) }); return select;
  }
  function renderContext() {
    get<HTMLInputElement>('repository').value = repository;
    get('context').textContent = `${repository || 'Enter owner/repo to begin'}${browsing ? ' · Read-only browsing' : ' · Local repository'}`;
    get<HTMLButtonElement>('local').hidden = !host.repo();
    for (const button of get('tabs').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.section === section));
  }
  function clearDetail(title: string) { detail.replaceChildren(); dropdowns = dropdowns.filter(item => item.control.isConnected); text('h3', title); }
  function result(title: string, subtitle: string, open?: () => Promise<void>) {
    const row = document.createElement('div'); row.className = 'github-item'; list.append(row);
    if (open) action(title, open, row); else text('strong', title, row);
    text('span', subtitle, row, 'muted'); return row;
  }
  function empty() { if (!list.childElementCount) text('p', 'No results.', list, 'muted'); }
  function showPreview(preview: Preview) {
    const pre = text('pre', '', detail, 'diff'); pre.id = 'github-diff'; host.preview(pre.id, preview);
  }
  async function showPull(number: number) {
    const pull = await read<Pull>({ kind: 'pull', number });
    clearDetail(`#${number} ${pull.title}`);
    text('p', `${pull.state} · ${pull.author?.login || ''} · ${pull.headRefName} → ${pull.baseRefName}`, detail, 'muted');
    text('pre', pull.body || 'No description.', detail, 'message');
    text('h4', 'Checks'); text('pre', checkSummary(pull.statusCheckRollup), detail, 'message');
    text('h4', 'Reviewers'); text('p', [
      ...(pull.reviewRequests ?? []).map(person => `${person.login || person.name || 'Team'} · requested`),
      ...(pull.latestReviews ?? []).map(review => `${review.author?.login || 'Reviewer'} · ${review.state}`),
    ].join('\n') || 'No reviewers.');
    const actions = text('div', '', detail, 'row');
    if (!browsing) {
      action('Check out PR (detached)', async () => {
        if (await host.confirm(`Check out PR #${number} in detached HEAD? Commit or stash local changes first. Your previous branch is kept.`)) {
          await write({ kind: 'checkout', number, token: local!.token }); await showPull(number);
        }
      }, actions, true);
      let method = 'squash';
      selectOptions('Merge method', [['merge', 'Merge commit'], ['squash', 'Squash'], ['rebase', 'Rebase']], method, value => { method = value; }, actions);
      action('Merge…', async () => {
        if (await host.confirm(`${method} merge PR #${number} into ${pull.baseRefName} on GitHub?`)) {
          await write({ kind: 'merge', number, method, head: pull.headRefOid }); await showPull(number);
        }
      }, actions, true);
    }
    text('h4', `Files · ${pull.changedFiles}`);
    const fileControls = text('div', '', detail, 'row');
    const options: [string, string][] = [['', 'Full PR diff'], ...pull.files.slice(0, 100).map(file => [file.path, file.path] as [string, string])];
    let path = '';
    const pre = text('pre', '', detail, 'diff'); pre.id = 'github-diff';
    const editor = text('div', '', detail); editor.hidden = true;
    const key = repository + '#' + number;
    let draft = drafts.get(key);
    if (!draft) { draft = { head: pull.headRefOid, body: '', event: 'COMMENT', comments: [] }; drafts.set(key, draft); }
    const currentDraft = draft;
    const pending = text('div', '', detail);
    function drawPending() {
      pending.replaceChildren();
      if (browsing) return;
      text('h4', `Pending review · ${currentDraft.comments.length} inline comments`, pending);
      if (currentDraft.head !== pull.headRefOid) text('p', 'The PR has new commits. Pending comments refer to the previous diff. Discard this draft and review the new diff before submitting.', pending);
      for (const [index, comment] of currentDraft.comments.entries()) {
        const row = text('div', '', pending, 'github-item');
        text('strong', `${comment.path}:${comment.line} (${comment.side})`, row); text('pre', comment.body, row, 'message');
        action('Remove comment', () => { currentDraft.comments.splice(index, 1); drawPending(); }, row);
      }
    }
    function commentOn(line: number, side: Side) {
      if (browsing || !path) return;
      editor.replaceChildren(); editor.hidden = false;
      text('h4', `Comment on ${path}:${line} (${side})`, editor);
      const body = document.createElement('textarea'); body.maxLength = 64_000; body.setAttribute('aria-label', 'Inline review comment');
      body.value = currentDraft.comments.find(c => c.path === path && c.line === line && c.side === side)?.body ?? ''; editor.append(body);
      const commentPath = path;
      action('Add to pending review', () => {
        if (!body.value.trim()) throw new Error('Enter a comment.');
        currentDraft.comments = addPending(currentDraft.comments, { path: commentPath, line, side, body: body.value });
        editor.hidden = true; drawPending();
      }, editor);
      action('Cancel inline comment', () => { editor.hidden = true; }, editor); body.focus();
    }
    async function loadDiff() {
      editor.hidden = true;
      const preview = await read<Preview>({ kind: 'diff', number, path: path || null });
      host.preview(pre.id, preview, !browsing && path ? commentOn : undefined);
    }
    selectOptions('Pull request file', options, path, value => { path = value; void perform(loadDiff); }, fileControls);
    if (!browsing) {
      text('p', 'Select a file, then click an old or new line number to add a pending comment. Nothing is sent until Submit review.', fileControls, 'muted');
      const summary = document.createElement('textarea'); summary.maxLength = 64_000; summary.placeholder = 'Review summary'; summary.setAttribute('aria-label', 'Review summary'); summary.value = currentDraft.body; summary.oninput = () => { currentDraft.body = summary.value; }; detail.append(summary);
      const verdicts = text('div', '', detail, 'row');
      selectOptions('Review verdict', [['COMMENT', 'Comment'], ['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes']], currentDraft.event, value => { currentDraft.event = value; }, verdicts);
      action('Submit review', async () => {
        await write({ kind: 'review', number, head: currentDraft.head, event: currentDraft.event, body: currentDraft.body, comments: currentDraft.comments });
        drafts.delete(key); await showPull(number);
      }, verdicts, true);
      action('Discard pending review', async () => {
        if (await host.confirm('Discard this pending review and its inline comments?')) { drafts.delete(key); await showPull(number); }
      }, verdicts);
    }
    drawPending(); syncDisabled(); await loadDiff();
  }
  async function showIssue(number: number) {
    const issue = await read<Issue>({ kind: 'issue', number });
    clearDetail(`#${number} ${issue.title}`); text('p', `${issue.state} · ${issue.author?.login || ''}`, detail, 'muted'); text('pre', issue.body || 'No description.', detail, 'message');
    for (const comment of issue.comments) { text('h4', `${comment.author?.login || 'User'} · ${comment.createdAt}`); text('pre', comment.body, detail, 'message'); }
    if (browsing) return;
    const key = repository + '#' + number;
    const body = document.createElement('textarea'); body.maxLength = 64_000; body.setAttribute('aria-label', 'Issue comment'); body.placeholder = 'Add a comment'; body.value = issueDrafts.get(key) ?? ''; body.oninput = () => issueDrafts.set(key, body.value); detail.append(body);
    const actions = text('div', '', detail, 'row');
    action('Add comment', async () => {
      await write({ kind: 'comment', number, body: body.value }); issueDrafts.delete(key); await showIssue(number);
    }, actions, true);
    const state = issue.state === 'OPEN' ? 'closed' : 'open';
    action(state === 'closed' ? 'Close issue…' : 'Reopen issue…', async () => {
      if (await host.confirm(`${state === 'closed' ? 'Close' : 'Reopen'} issue #${number} on GitHub?`)) { await write({ kind: 'issue_state', number, state }); await showIssue(number); }
    }, actions, true);
  }
  async function showRun(number: number) {
    const run = await read<Run>({ kind: 'run', number });
    clearDetail(run.displayTitle); text('p', `${run.status} · ${run.conclusion || 'Pending'} · ${run.headBranch}`);
    for (const job of run.jobs ?? []) text('p', `${job.name}: ${job.conclusion || job.status}`);
    const actions = text('div', '', detail, 'row');
    action('Failed jobs log', async () => { const preview = await read<Preview>({ kind: 'log', number }); detail.querySelector('#github-diff')?.remove(); showPreview(preview); }, actions);
    if (!browsing) action('Re-run…', async () => {
      if (await host.confirm(`Re-run workflow #${number} on GitHub?`)) { await write({ kind: 'rerun', number }); await showRun(number); }
    }, actions, true);
  }
  async function load() {
    dropdowns.length = 0; controls.replaceChildren(); list.replaceChildren(); detail.replaceChildren(); renderContext();
    action('Refresh', load, controls);
    if (section === 'browse') selectOptions('Repository content', [['readme', 'README'], ['branches', 'Branches'], ['commits', 'Recent commits'], ['pulls', 'Pull requests']], browseSection, value => { browseSection = value; void perform(load); });
    if (section !== 'notifications' && !repository) { text('p', 'Enter owner/repo and choose Browse read-only.', list); return; }
    if (section === 'pulls' || (section === 'browse' && browseSection === 'pulls')) {
      selectOptions('Pull request filter', [['open', 'Open'], ['mine', 'Mine'], ['review', 'Review requested']], filter, value => { filter = value; void perform(load); });
      const pulls = await read<Item[]>({ kind: 'pulls', filter });
      pulls.forEach(pull => result(`#${pull.number} ${pull.title}`, `${pull.state} · ${pull.author?.login || ''}`, () => showPull(pull.number)));
    } else if (section === 'issues') {
      const issues = await read<Item[]>({ kind: 'issues' });
      issues.forEach(issue => result(`#${issue.number} ${issue.title}`, `${issue.state} · ${issue.author?.login || ''}`, () => showIssue(issue.number)));
    } else if (section === 'runs') {
      const form = document.createElement('form'); form.className = 'row'; const input = document.createElement('input'); input.setAttribute('aria-label', 'Workflow branch filter'); input.placeholder = 'All branches'; input.value = branch; input.maxLength = 1024;
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Filter branch'; form.append(input, submit); controls.append(form);
      form.onsubmit = event => { event.preventDefault(); branch = input.value.trim(); void perform(load); };
      const runs = await read<Run[]>({ kind: 'runs', branch: branch || null });
      runs.forEach(run => result(run.displayTitle, `${run.workflowName || ''} · ${run.conclusion || run.status} · ${run.headBranch}`, () => showRun(run.databaseId)));
    } else if (section === 'releases') {
      const releases = await read<Release[]>({ kind: 'releases' });
      releases.forEach(release => result(release.name || release.tag_name, `${release.tag_name} · ${release.draft ? 'Draft' : release.prerelease ? 'Pre-release' : 'Release'} · ${release.published_at || ''}`, async () => { clearDetail(release.name || release.tag_name); text('pre', release.body || 'No release notes.', detail, 'message'); }));
    } else if (section === 'notifications') {
      const notifications = await read<Notification[]>({ kind: 'notifications' });
      notifications.forEach(notification => {
        const row = result(notification.subject.title, `${notification.repository.full_name} · ${notification.subject.type} · ${notification.reason} · ${notification.unread ? 'Unread' : 'Read'}`);
        action('Mark as read', async () => { await write({ kind: 'read_notification', thread: notification.id }); await load(); }, row, true);
      });
    } else if (section === 'browse') {
      if (browseSection === 'readme') { const readme = await read<{ text: string; truncated: boolean }>({ kind: 'readme' }); clearDetail('README'); text('pre', readme.text, detail, 'message'); if (readme.truncated) text('p', 'README truncated at 2 MiB.'); }
      else if (browseSection === 'branches') { const branches = await read<{ name: string; protected: boolean }[]>({ kind: 'branches' }); branches.forEach(branch => result(branch.name, branch.protected ? 'Protected' : '')); }
      else { const commits = await read<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>({ kind: 'commits' }); commits.forEach(commit => result(commit.commit.message.split('\n')[0], `${commit.sha.slice(0, 8)} · ${commit.commit.author.name} · ${commit.commit.author.date}`)); }
    }
    if (!(section === 'browse' && browseSection === 'readme')) empty();
  }
  async function openLocal() {
    local = host.repo(); browsing = !local; repository = ''; section = local ? 'pulls' : 'browse';
    if (local) repository = (await read<{ name: string }>({ kind: 'repository' })).name;
    await load();
  }
  for (const [name, label] of tabs) {
    const button = action(label, async () => { section = name; await load(); }, get('tabs')); button.dataset.section = name;
  }
  get('repository-form').onsubmit = event => {
    event.preventDefault();
    void perform(async () => { repository = get<HTMLInputElement>('repository').value.trim(); browsing = true; section = 'browse'; await load(); });
  };
  get('local').onclick = () => { void perform(openLocal); };
  get('close').onclick = () => { if (!loading) panel.close(); };
  panel.addEventListener('cancel', event => { if (loading) event.preventDefault(); });
  const trigger = document.getElementById('github-button') as HTMLButtonElement;
  trigger.onclick = () => {
    if (host.busy()) return;
    panel.showModal(); void perform(openLocal);
  };
}
