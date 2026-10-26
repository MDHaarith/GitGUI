export function blameHeat(timestamp: number, oldest: number, newest: number): number {
  if (![timestamp, oldest, newest].every(Number.isFinite)) return 0.04;
  if (newest <= oldest) return 0.22;
  return 0.04 + 0.18 * Math.max(0, Math.min(1, (timestamp - oldest) / (newest - oldest)));
}

export function lineRange(start: number, end: number): [number, number] | null {
  if (![start, end].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000)) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

export function isTextField(tag: string, editable: boolean, role: string | null): boolean {
  return editable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || role === 'textbox';
}

/** Translate index line numbers back to HEAD; newly staged lines have no committed history. */
export function headLine(indexLine: number, stagedDiff: string): number | null {
  let oldLine = 0, newLine = 0, offset = 0, inHunk = false;
  for (const text of stagedDiff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      const oldCount = Number(hunk[2] ?? 1), newCount = Number(hunk[4] ?? 1);
      oldLine = Number(hunk[1]) + (oldCount === 0 ? 1 : 0); newLine = Number(hunk[3]) + (newCount === 0 ? 1 : 0);
      if (indexLine < newLine) return indexLine + offset;
      const oldEnd = oldLine + oldCount, newEnd = newLine + newCount;
      offset = oldEnd - newEnd; inHunk = indexLine < newEnd;
    } else if (inHunk) {
      if (text.startsWith('-')) oldLine++;
      else if (text.startsWith('+')) { if (newLine++ === indexLine) return null; }
      else if (text.startsWith(' ')) { if (newLine++ === indexLine) return oldLine; oldLine++; }
    }
  }
  return indexLine + offset;
}
