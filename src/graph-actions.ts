import type { RebaseEdit } from './git.ts';

export function selectCommits(order: string[], current: Set<string>, anchor: string | null, oid: string, toggle: boolean, range: boolean): Set<string> {
  if (range && anchor && order.includes(anchor) && order.includes(oid)) {
    const [start, end] = [order.indexOf(anchor), order.indexOf(oid)].sort((a, b) => a - b);
    return new Set([...(toggle ? current : []), ...order.slice(start, end + 1)]);
  }
  if (!toggle) return new Set([oid]);
  const next = new Set(current);
  if (next.has(oid)) next.delete(oid); else next.add(oid);
  return next;
}

export function batchRebase(commits: RebaseEdit[], selected: Set<string>, action: 'squash' | 'drop'): RebaseEdit[] {
  if (action === 'drop') return commits.map(commit => ({ ...commit, action: selected.has(commit.oid) ? 'drop' : 'pick' }));
  const group = commits.filter(commit => selected.has(commit.oid));
  const first = commits.findIndex(commit => selected.has(commit.oid));
  return [...commits.slice(0, first), ...group.map((commit, index): RebaseEdit => ({ ...commit, action: index ? 'squash' : 'pick' })), ...commits.slice(first).filter(commit => !selected.has(commit.oid))];
}

export function resultingCommits(commits: RebaseEdit[]): number {
  return commits.filter(commit => !['drop', 'squash', 'fixup'].includes(commit.action)).length;
}

export const graphActionsMarkup = `
  <div class="graph-actions" id="graph-actions" hidden>
    <span id="graph-selection-count" aria-live="polite"></span>
    <button id="graph-actions-button" aria-haspopup="menu" aria-expanded="false">Commit actions</button>
    <button id="graph-compare" hidden>Compare two commits</button>
    <button id="graph-clear">Clear selection</button>
    <span class="muted">Ctrl/Cmd-click to add · Shift-click for a range</span>
  </div>`;

export const graphDialogsMarkup = `
  <dialog class="branch-dialog wide-dialog" id="reword-dialog" aria-labelledby="reword-title">
    <div class="dialog-head"><h2 id="reword-title">Reword commit</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <p class="muted">Changes this message and replays later parent links, preserving files and merge resolutions. Commit IDs change and rewritten signatures are removed. A history checkpoint is saved first.</p>
    <form id="reword-form" class="form-grid"><label for="reword-message">New message</label><textarea id="reword-message" rows="8" maxlength="131072" required></textarea>
      <label class="choice"><input type="checkbox" id="reword-published"> Allow already-pushed commits. The next push must use --force-with-lease in the terminal.</label>
      <div class="dialog-foot"><button class="primary" type="submit">Reword commit</button></div></form>
  </dialog>
  <dialog class="branch-dialog commit-diff-dialog" id="commit-diff-dialog" aria-labelledby="commit-diff-title">
    <div class="dialog-head"><h2 id="commit-diff-title">Commit diff</h2><button type="button" class="diff-toggle" aria-pressed="false">Side by side</button><form method="dialog"><button type="submit">Close</button></form></div>
    <pre class="diff" id="commit-full-diff"></pre>
  </dialog>
  <dialog class="branch-dialog wide-dialog" id="rebase-edit-dialog" aria-labelledby="rebase-edit-title">
    <div class="dialog-head"><h2 id="rebase-edit-title">Amend paused commit</h2><form method="dialog"><button type="submit">Cancel</button></form></div>
    <p class="muted">Stage the file changes you want to include, amend this commit, then Continue the rebase in Changes.</p>
    <form id="rebase-edit-form" class="form-grid"><label for="rebase-edit-message">Commit message</label><textarea id="rebase-edit-message" required maxlength="131072" rows="8"></textarea><div class="dialog-foot"><button type="submit" class="primary">Amend commit</button></div></form>
  </dialog>`;
