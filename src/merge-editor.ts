import type { FileInfo, MergeVersions, RepoInfo } from './git.ts';
import { isBlock, parseConflicts } from './conflict.ts';
import { chooseBlock, mergeFile, mergeSides, automaticResolution, type MergeKind } from './merge.ts';
import './merge.css';

const labels: Record<MergeKind, string> = { unchanged: 'Unchanged', ours: 'Yours only', theirs: 'Theirs only', both: 'Both · same change', conflict: 'Conflict' };

export function openMergeEditor(file: FileInfo, versions: MergeVersions, save: (content: string) => Promise<boolean>) {
  const dialog = document.getElementById('conflict-dialog') as HTMLDialogElement;
  const container = document.getElementById('conflict-blocks')!;
  document.getElementById('conflict-title')!.textContent = 'Merge ' + file.path;
  const sides = mergeSides(versions.ours, versions.theirs, versions.rebasing);
  const { blocks, results } = mergeFile(versions.base ?? '', sides.ours, sides.theirs, versions.working);
  container.replaceChildren();
  const note = document.createElement('p'); note.className = 'muted';
  note.textContent = versions.rebasing ? 'Yours is your commit being replayed (Git stage 3). Theirs is the branch you are rebasing onto (Git stage 2).' : 'Yours is your current branch (Git stage 2). Theirs is the incoming branch (Git stage 3).';
  if (versions.ours === null || versions.theirs === null) note.textContent += ' A missing side means deletion; Accept on the file dashboard preserves that deletion. Saving text here keeps the file.';
  const legend = document.createElement('div'); legend.className = 'merge-legend'; legend.setAttribute('aria-label', 'Change kinds');
  for (const kind of ['ours', 'theirs', 'both', 'conflict'] as const) {
    const item = document.createElement('span'); item.className = 'merge-kind merge-' + kind; item.textContent = labels[kind]; legend.append(item);
  }
  const toolbar = document.createElement('div'); toolbar.className = 'row';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const editors: HTMLTextAreaElement[] = [];
  const edited = new Set<number>();
  const saveButton = document.getElementById('conflict-save') as HTMLButtonElement;
  const update = () => {
    const content = results.join('');
    const remaining = parseConflicts(content).filter(isBlock).length;
    const markers = /^(?:<{7,}|>{7,})(?: |$)/m.test(content);
    status.textContent = remaining ? remaining + ' unresolved blocks' : markers ? 'Remove incomplete conflict markers before saving.' : 'Ready to save · saving marks this file resolved.';
    saveButton.disabled = markers;
  };
  for (const [label, onlyOneSide] of [['Apply non-conflicting changes', true], ['Resolve simple', false]] as const) {
    const action = document.createElement('button'); action.type = 'button'; action.textContent = label;
    action.title = 'Preserves blocks you have edited or accepted in this editor';
    action.onclick = () => {
      blocks.forEach((block, index) => {
        if (edited.has(index)) return;
        const result = automaticResolution(block, !onlyOneSide);
        if (result !== null) { results[index] = result; editors[index].value = result; }
      }); update();
    }; toolbar.append(action);
  }
  const headings = document.createElement('div'); headings.className = 'merge-columns merge-headings';
  for (const title of [versions.rebasing ? 'Yours · replayed commit' : 'Yours', 'Result · editable', versions.rebasing ? 'Theirs · rebase target' : 'Theirs']) {
    const heading = document.createElement('strong'); heading.textContent = title; headings.append(heading);
  }
  container.append(note, legend, toolbar, headings);
  blocks.forEach((block, index) => {
    const section = document.createElement('section'); section.className = 'merge-block merge-' + block.kind;
    const title = document.createElement('div'); title.className = 'merge-block-title'; title.textContent = `${index + 1} · ${labels[block.kind]}`;
    const columns = document.createElement('div'); columns.className = 'merge-columns';
    const ours = document.createElement('pre'); ours.className = 'diff'; ours.textContent = block.ours || '(empty)';
    const theirs = document.createElement('pre'); theirs.className = 'diff'; theirs.textContent = block.theirs || '(empty)';
    const result = document.createElement('textarea'); result.value = results[index]; result.spellcheck = false; result.wrap = 'off'; result.rows = Math.min(18, Math.max(2, results[index].split('\n').length)); result.setAttribute('aria-label', `Result block ${index + 1} · ${labels[block.kind]}`); result.oninput = () => { edited.add(index); results[index] = result.value.replace(/\n/g, /\r\n/.test(results[index] || block.base || block.ours || block.theirs) ? '\r\n' : '\n'); update(); };
    editors.push(result); columns.append(ours, result, theirs); section.append(title, columns);
    if (block.kind !== 'unchanged') {
      const choices = document.createElement('div'); choices.className = 'row';
      for (const [choice, label] of [['ours', 'Accept Yours'], ['theirs', 'Accept Theirs'], ['both', 'Accept Both'], ['ignore', 'Ignore']] as const) {
        const action = document.createElement('button'); action.type = 'button'; action.textContent = label; action.title = choice === 'ignore' ? 'Keep the base text for this block' : label + ' for this block';
        action.onclick = () => { edited.add(index); results[index] = chooseBlock(block, choice); result.value = results[index]; update(); }; choices.append(action);
      }
      section.append(choices);
    }
    container.append(section);
  });
  container.append(status); update();
  saveButton.onclick = async () => {
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    try { if (await save(results.join(''))) dialog.close(); update(); }
    catch (error) { update(); status.textContent = String(error); status.setAttribute('role', 'alert'); }
  };
  dialog.showModal();
}

export function renderConflictsDashboard(container: HTMLElement, repo: RepoInfo | null, busy: boolean, merge: (file: FileInfo) => void, resolve: (file: FileInfo, choice: 'ours' | 'theirs') => void) {
  const files = repo?.files.filter(file => file.conflicted) ?? [];
  container.hidden = !files.length;
  container.replaceChildren();
  if (!files.length) return;
  const title = document.createElement('h3'); title.textContent = `Conflicts · ${files.length} files left`;
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = repo?.operation === 'rebase' ? 'Yours = your commit being replayed. Theirs = the rebase target.' : 'Resolve each file, then continue the operation.';
  container.append(title, note);
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'merge-file-name'; name.textContent = file.path; row.append(name);
    for (const [label, choice] of [['Accept Yours', 'ours'], ['Accept Theirs', 'theirs'], ['Merge…', 'merge']] as const) {
      const action = document.createElement('button'); action.type = 'button'; action.textContent = label; action.disabled = busy; action.setAttribute('aria-label', label + ' · ' + file.path);
      action.onclick = () => choice === 'merge' ? merge(file) : resolve(file, choice); row.append(action);
    }
    container.append(row);
  }
}
