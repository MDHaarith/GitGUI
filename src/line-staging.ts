/** Click toggles one changed line; Shift extends the selection from the last click. */
export function selectLines(selected: Set<number>, available: number[], line: number, anchor: number | null, shift: boolean): Set<number> {
  const next = new Set(selected);
  if (shift && anchor !== null) {
    for (const n of available) if (n >= Math.min(anchor, line) && n <= Math.max(anchor, line)) next.add(n);
  } else if (next.has(line)) next.delete(line); else next.add(line);
  return next;
}

export function wireLineStaging(container: HTMLElement, action: (lines: number[]) => void, label: string, blocked: () => boolean) {
  const nodes = [...container.querySelectorAll<HTMLElement>('[data-diff-line]')];
  if (!nodes.length) return;
  const available = nodes.map(node => Number(node.dataset.diffLine));
  let selected = new Set<number>(), anchor: number | null = null;
  const toolbar = document.createElement('span'); toolbar.className = 'line-staging wide';
  const stage = document.createElement('button'); stage.type = 'button'; stage.textContent = label; stage.disabled = true;
  const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = 'Click changed lines · Shift-click for a range';
  toolbar.append(stage, hint); container.prepend(toolbar);
  stage.onclick = () => { if (!blocked() && selected.size) action([...selected].sort((a, b) => a - b)); };
  for (const node of nodes) {
    const line = Number(node.dataset.diffLine);
    node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-pressed', 'false');
    node.setAttribute('aria-label', 'Select changed line: ' + node.textContent);
    const choose = (shift: boolean) => {
      if (blocked()) return;
      selected = selectLines(selected, available, line, anchor, shift); if (!shift) anchor = line;
      for (const item of nodes) item.setAttribute('aria-pressed', String(selected.has(Number(item.dataset.diffLine))));
      stage.disabled = !selected.size; stage.textContent = label + (selected.size ? ` (${selected.size})` : '');
    };
    node.onclick = event => choose(event.shiftKey);
    node.onkeydown = event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); choose(event.shiftKey); } };
  }
}
