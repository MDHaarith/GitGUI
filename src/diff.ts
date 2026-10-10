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
