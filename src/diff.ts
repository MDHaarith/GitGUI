export interface DiffLine { text: string; oldLine: number | null; newLine: number | null; kind: string }

export function numberDiff(text: string, binary = false): DiffLine[] {
  const lines = text.split('\n', 5001);
  const unified = lines.some(line => line.startsWith('diff --git ') || /^@@ -\d/.test(line));
  let oldLine = 0, newLine = 0, inHunk = false;
  return lines.map((text, index) => {
    const line: DiffLine = { text, oldLine: null, newLine: null, kind: '' };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; line.kind = 'hunk';
    } else if (unified && text.startsWith('diff --git ')) {
      inHunk = false;
    } else if (inHunk) {
      if (text.startsWith('+')) { line.newLine = newLine++; line.kind = 'added'; }
      else if (text.startsWith('-')) { line.oldLine = oldLine++; line.kind = 'removed'; }
      else if (text.startsWith(' ')) { line.oldLine = oldLine++; line.newLine = newLine++; }
    } else if (!unified && !binary) {
      line.newLine = index + 1;
    }
    return line;
  });
}

/** Lengths of the unchanged start and end of two lines, so only the changed middle is highlighted. */
export function changedRange(a: string, b: string): [number, number] {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a[start] === b[start]) start++;
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [start, end];
}

/** Rows for a side-by-side view: each run of removed lines is paired with the added lines after it. */
export function pairLines(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const rows: [DiffLine | null, DiffLine | null][] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'removed' && lines[i].kind !== 'added') { rows.push([lines[i], lines[i]]); i++; continue; }
    const removed: DiffLine[] = [], added: DiffLine[] = [];
    while (lines[i]?.kind === 'removed') removed.push(lines[i++]);
    while (lines[i]?.kind === 'added') added.push(lines[i++]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) rows.push([removed[k] ?? null, added[k] ?? null]);
  }
  return rows;
}
