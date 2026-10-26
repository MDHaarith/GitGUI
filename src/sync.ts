import { Channel, invoke } from '@tauri-apps/api/core';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { wireDropdown } from './dropdown.ts';
import { changesBlock, pullDiverged, pushRejected } from './sync-logic.ts';
import type { Preview, RefInfo, RepoInfo } from './git.ts';

export interface BranchActivity { id: string; author: string; timestamp: number }
interface Worktree { id: string; path: string; branch: string | null; head: string; bare: boolean; locked: boolean; prunable: boolean }
interface Lease { branch: string; expected: string }
interface Comparison { onlyA: Preview; onlyB: Preview; diff: Preview }
interface Response { info?: RepoInfo; activity?: BranchActivity[]; worktrees?: Worktree[]; comparison?: Comparison; lease?: Lease }
type Request =
  | { action: 'activity' | 'worktrees' | 'lease' }
  | { action: 'compare'; a: string; b: string }
  | { action: 'pull'; mode: 'ff' | 'merge' | 'rebase'; stash: boolean; token: string }
  | { action: 'switch'; referenceId: string; stash: boolean; token: string }
  | { action: 'push'; remoteId: string | null; token: string }
  | { action: 'forcePush'; token: string }
  | { action: 'branchFetch' | 'branchReset'; referenceId: string; remoteId: string; token: string }
  | { action: 'worktreeAdd'; path: string; branch: string; newBranch: boolean; token: string }
  | { action: 'worktreeRemove'; worktreeId: string; confirmed: boolean; token: string };
export function syncRequest(repoId: number, request: Request, progress: (message: string) => void = () => {}) {
  return invoke<Response>('sync_repository', { repoId, request, onProgress: new Channel<string>(progress) });
}

function choice(title: string, text: string, choices: string[]): Promise<string | null> {
  const dialog = document.createElement('dialog'); dialog.className = 'branch-dialog';
  const heading = document.createElement('h2'); heading.id = 'sync-choice-title'; heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  const note = document.createElement('p'); note.textContent = text;
  const actions = document.createElement('div'); actions.className = 'dialog-foot';
  dialog.append(heading, note, actions); document.body.append(dialog);
  return new Promise(resolve => {
    dialog.onclose = () => { const answer = dialog.returnValue || null; dialog.remove(); resolve(answer); };
    for (const name of ['Cancel', ...choices]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
      button.onclick = () => dialog.close(name === 'Cancel' ? '' : name); actions.append(button);
    }
    dialog.showModal();
  });
}

export async function pullWithChoices(repo: RepoInfo, progress: (message: string) => void) {
  let mode: 'ff' | 'merge' | 'rebase' = 'ff'; let stash = false;
  for (;;) {
    try { return (await syncRequest(repo.id, { action: 'pull', mode, stash, token: repo.token }, progress)).info!; }
    catch (error) {
      if (mode === 'ff' && pullDiverged(error)) {
        const answer = await choice('Pull diverged branches', 'Fast-forward is impossible. Choose how to combine local and remote commits for this pull only.', ['Merge', 'Rebase']);
        if (!answer) throw error;
        mode = answer === 'Merge' ? 'merge' : 'rebase';
      } else if (!stash && changesBlock(error)) {
        if (!await choice('Working changes block pull', 'Stash changes, retry the pull, then pop the stash. If the pull or pop conflicts, the stash is kept.', ['Stash & retry'])) throw error;
        stash = true;
      } else throw error;
      repo = await invoke<RepoInfo>('get_status', { repoId: repo.id });
    }
  }
}
export async function switchWithChoices(repo: RepoInfo, ref: RefInfo, progress: (message: string) => void) {
  try { return (await syncRequest(repo.id, { action: 'switch', referenceId: ref.id, stash: false, token: repo.token }, progress)).info!; }
  catch (error) {
    if (!changesBlock(error) || !await choice('Working changes block switching', 'Stash changes, switch to ' + ref.name + ', then pop the stash. A conflicting pop keeps the stash.', ['Stash & retry'])) throw error;
    repo = await invoke<RepoInfo>('get_status', { repoId: repo.id });
    return (await syncRequest(repo.id, { action: 'switch', referenceId: ref.id, stash: true, token: repo.token }, progress)).info!;
  }
}
export async function pushWithLease(repo: RepoInfo, remoteId: string | null, progress: (message: string) => void) {
  try { return (await syncRequest(repo.id, { action: 'push', remoteId, token: repo.token }, progress)).info!; }
  catch (error) {
    if (!pushRejected(error)) throw error;
    const lease = (await syncRequest(repo.id, { action: 'lease' }).catch(() => ({} as Response))).lease;
    if (!lease || !await confirm(`The push was rejected. Force push branch "${lease.branch}" with a lease on ${lease.expected}? This can replace remote commits. Git refuses if the remote branch has changed.`, { title: 'Force push ' + lease.branch, kind: 'warning' })) throw error;
    return (await syncRequest(repo.id, { action: 'forcePush', token: repo.token }, progress)).info!;
  }
}

interface Context {
  repo: () => RepoInfo | null;
  refs: () => RefInfo[];
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  mutate: (label: string, action: () => Promise<RepoInfo>) => Promise<void>;
  preview: (id: string, value: Preview) => void;
  open: (path: string) => Promise<void>;
  progress: () => (message: string) => void;
  report: (error: unknown) => void;
}
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => get<HTMLSelectElement>(id);
const input = (id: string) => get<HTMLInputElement>(id);
const dialog = (id: string) => get<HTMLDialogElement>(id);
const option = (value: string, name: string) => { const node = document.createElement('option'); node.value = value; node.textContent = name; return node; };

export function wireSync(ctx: Context) {
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="branch-dialog wide-dialog" id="sync-compare" aria-labelledby="sync-compare-title">
      <div class="dialog-head"><h2 id="sync-compare-title">Compare branches</h2><form method="dialog"><button>Close</button></form></div>
      <form id="sync-compare-form" class="form-grid"><label for="sync-a">Base A</label><select id="sync-a"></select><label for="sync-b">Compare B</label><select id="sync-b"></select><button class="primary" data-repo>Compare</button></form>
      <div class="sync-commit-lists"><section><h3>Only in A</h3><pre id="sync-only-a"></pre></section><section><h3>Only in B</h3><pre id="sync-only-b"></pre></section></div>
      <h3>Changes from the common ancestor to B</h3><div id="sync-compare-diff" class="diff"></div>
    </dialog>
    <dialog class="branch-dialog" id="sync-branch" aria-labelledby="sync-branch-title">
      <div class="dialog-head"><h2 id="sync-branch-title"></h2><form method="dialog"><button>Cancel</button></form></div>
      <form id="sync-branch-form" class="form-grid"><label for="sync-remote">Remote</label><select id="sync-remote"></select><p id="sync-branch-note" class="muted"></p><button class="primary" data-repo>Continue</button></form>
    </dialog>
    <dialog class="branch-dialog wide-dialog" id="sync-worktrees" aria-labelledby="sync-worktrees-title">
      <div class="dialog-head"><h2 id="sync-worktrees-title">Worktrees</h2><form method="dialog"><button>Close</button></form></div>
      <ol id="sync-worktree-list" class="checkpoint-list"></ol>
      <form id="sync-worktree-form" class="form-grid"><h3>Add worktree</h3>
        <label for="sync-worktree-branch">Branch</label><input id="sync-worktree-branch" required maxlength="1024" autocomplete="off" list="sync-local-branches"><datalist id="sync-local-branches"></datalist>
        <label class="row"><input type="checkbox" id="sync-worktree-new"> Create a new branch from HEAD</label>
        <label for="sync-worktree-path">Folder</label><div class="row"><input id="sync-worktree-path" required placeholder="Absolute path to a new or empty folder"><button type="button" id="sync-worktree-browse">Choose…</button></div>
        <p class="muted">Removing a dirty worktree requires confirmation. A checkpoint and a stash of all files, including ignored files, are saved first; its branch is kept.</p>
        <button class="primary" data-repo>Add worktree</button>
      </form>
    </dialog>`);
  const dropdowns = ['sync-a', 'sync-b', 'sync-remote'].map(id => wireDropdown(select(id)));
  const addTool = (text: string, action: () => void) => { const button = document.createElement('button'); button.type = 'button'; button.dataset.repo = ''; button.textContent = text; button.setAttribute('role', 'menuitem'); button.onclick = action; get('tools-menu').append(button); };
  const caught = (action: () => Promise<void>) => { void action().catch(ctx.report); };
  function compare() {
    if (!ctx.repo()) return;
    for (const id of ['sync-a', 'sync-b']) select(id).replaceChildren(...ctx.refs().filter(r => r.kind !== 'tag').map(r => option(r.id, r.name)));
    select('sync-a').value = ctx.refs().find(r => r.isHead)?.id ?? select('sync-a').value;
    select('sync-b').selectedIndex = select('sync-b').options.length > 1 ? (select('sync-a').selectedIndex + 1) % select('sync-b').options.length : 0;
    for (const id of ['sync-only-a', 'sync-only-b', 'sync-compare-diff']) get(id).replaceChildren();
    dropdowns.forEach(d => d.sync()); dialog('sync-compare').showModal();
  }
  addTool('Compare branches…', compare);
  get<HTMLFormElement>('sync-compare-form').onsubmit = event => { event.preventDefault(); caught(async () => {
    const repo = ctx.repo(); if (!repo) return;
    await ctx.run('Comparing branches…', async () => {
      const value = (await syncRequest(repo.id, { action: 'compare', a: select('sync-a').value, b: select('sync-b').value })).comparison!;
      for (const [id, preview] of [['sync-only-a', value.onlyA], ['sync-only-b', value.onlyB]] as const) get(id).textContent = (preview.text || 'No commits') + (preview.truncated ? '\n… More commits omitted.' : '');
      ctx.preview('sync-compare-diff', value.diff);
    });
  }); };
  let branchAction: { ref: RefInfo; reset: boolean } | null = null;
  function branch(ref: RefInfo, reset: boolean) {
    const repo = ctx.repo(); if (!repo) return;
    branchAction = { ref, reset };
    get('sync-branch-title').textContent = (reset ? 'Reset to remote: ' : 'Fetch branch: ') + ref.name;
    select('sync-remote').replaceChildren(...repo.remotes.map(r => option(r.id, r.name))); dropdowns[2].sync();
    get('sync-branch-note').textContent = reset ? 'Fetch this branch from the chosen remote and reset the local branch to it. A checkpoint and a recovery ref keep local work and commits.' : 'Fetch the same-named branch into this local branch without checking it out. Git refuses a non-fast-forward update.';
    dialog('sync-branch').showModal();
  }
  get<HTMLFormElement>('sync-branch-form').onsubmit = event => { event.preventDefault(); caught(async () => {
    const repo = ctx.repo(), action = branchAction, remoteId = select('sync-remote').value; if (!repo || !action || !remoteId) return;
    if (action.reset && !await confirm(`Reset branch "${action.ref.name}" to "${repo.remotes.find(r => r.id === remoteId)?.name}/${action.ref.name}"? Current tracked edits are replaced. A checkpoint and recovery ref are saved first.`, { title: 'Reset ' + action.ref.name, kind: 'warning' })) return;
    dialog('sync-branch').close();
    await ctx.mutate(action.reset ? 'Resetting branch to remote…' : 'Fetching branch without checkout…', async () => (await syncRequest(repo.id, { action: action.reset ? 'branchReset' : 'branchFetch', referenceId: action.ref.id, remoteId, token: repo.token }, ctx.progress())).info!);
  }); };
  async function renderWorktrees() {
    const repo = ctx.repo(); if (!repo) return;
    const list = (await syncRequest(repo.id, { action: 'worktrees' })).worktrees!;
    get('sync-worktree-list').replaceChildren(...list.map(worktree => {
      const item = document.createElement('li'), title = document.createElement('strong'), path = document.createElement('span'), actions = document.createElement('span'); actions.className = 'row';
      title.textContent = worktree.branch?.replace(/^refs\/heads\//, '') ?? (worktree.bare ? 'Bare repository' : 'Detached ' + worktree.head.slice(0, 8));
      path.textContent = worktree.path + (worktree.locked ? ' · locked' : '') + (worktree.prunable ? ' · missing' : ''); path.className = 'muted';
      const openButton = document.createElement('button'); openButton.type = 'button'; openButton.dataset.repo = ''; openButton.textContent = 'Open in new tab'; openButton.disabled = worktree.bare || worktree.prunable; openButton.dataset.syncDisabled = String(openButton.disabled);
      openButton.onclick = () => { dialog('sync-worktrees').close(); caught(() => ctx.run('Opening worktree…', () => ctx.open(worktree.path))); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.repo = ''; remove.textContent = 'Remove'; remove.disabled = worktree.path === repo.root || worktree.bare || worktree.locked || worktree.prunable; remove.dataset.syncDisabled = String(remove.disabled);
      remove.onclick = () => caught(async () => {
        if (!await confirm(`Remove worktree "${worktree.path}"? Its branch stays.`, { title: 'Remove worktree', kind: 'warning' })) return;
        await ctx.mutate('Removing worktree…', async () => {
          let response: Response;
          const fresh = await invoke<RepoInfo>('get_status', { repoId: repo.id });
          try { response = await syncRequest(repo.id, { action: 'worktreeRemove', worktreeId: worktree.id, confirmed: false, token: fresh.token }, ctx.progress()); }
          catch (error) {
            if (!String(error).includes('This worktree is dirty') || !await choice('Remove dirty worktree?', `Save a checkpoint and stash every file in "${worktree.path}" (including ignored files), then remove it? Recover these files from Stashes.`, ['Save & remove'])) throw error;
            response = await syncRequest(repo.id, { action: 'worktreeRemove', worktreeId: worktree.id, confirmed: true, token: fresh.token }, ctx.progress());
          }
          return response.info!;
        });
        await renderWorktrees();
      });
      actions.append(openButton, remove); item.append(title, path, actions); return item;
    }));
  }
  addTool('Worktrees…', () => caught(async () => {
    if (!ctx.repo()) return;
    await ctx.run('Loading worktrees…', async () => {
      get('sync-local-branches').replaceChildren(...ctx.refs().filter(r => r.kind === 'local').map(r => option(r.name, r.name)));
      await renderWorktrees(); dialog('sync-worktrees').showModal();
    });
  }));
  get('sync-worktree-browse').onclick = () => caught(async () => { const path = await open({ directory: true, multiple: false, title: 'Choose an empty worktree folder' }); if (typeof path === 'string') input('sync-worktree-path').value = path; });
  get<HTMLFormElement>('sync-worktree-form').onsubmit = event => { event.preventDefault(); caught(async () => {
    const repo = ctx.repo(); if (!repo) return;
    const path = input('sync-worktree-path').value, branch = input('sync-worktree-branch').value, newBranch = input('sync-worktree-new').checked;
    await ctx.mutate('Adding worktree…', async () => (await syncRequest(repo.id, { action: 'worktreeAdd', path, branch, newBranch, token: repo.token }, ctx.progress())).info!);
    await renderWorktrees();
  }); };
  return { branch, compare };
}
