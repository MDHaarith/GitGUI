/** A conflicted region: the two sides Git could not merge, with the branch labels from its markers. */
export interface ConflictBlock { ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string }
export type Segment = string[] | ConflictBlock;
export type Choice = 'ours' | 'theirs' | 'both';

/** Splits a file with <<<<<<< / ||||||| / ======= / >>>>>>> markers into plain lines and conflict blocks. */
export function parseConflicts(text: string): Segment[] {
  const lines = text.split('\n'); const segments: Segment[] = []; let plain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) { plain.push(lines[i]); continue; }
    // Markers in a CRLF file end in \r; content lines keep theirs so the resolved file keeps its line endings.
    const block: ConflictBlock = { ours: [], theirs: [], oursLabel: lines[i].slice(8).replace(/\r$/, ''), theirsLabel: '' };
    let part: string[] | null = block.ours; let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (part === block.ours && line.startsWith('|||||||')) part = null; // diff3 base: dropped from both choices
      else if (part !== block.theirs && /^=======\r?$/.test(line)) part = block.theirs;
      else if (part === block.theirs && line.startsWith('>>>>>>>')) { block.theirsLabel = line.slice(8).replace(/\r$/, ''); end = j; break; }
      else part?.push(line);
    }
    if (end < 0) { plain.push(lines[i]); continue; } // an unterminated marker is ordinary text
    if (plain.length) segments.push(plain);
    plain = []; segments.push(block); i = end;
  }
  if (plain.length) segments.push(plain);
  return segments;
}

export function isBlock(segment: Segment): segment is ConflictBlock { return !Array.isArray(segment); }

/** Rebuilds the file with each block replaced by the chosen side(s). */
export function resolveConflicts(segments: Segment[], choices: Choice[]): string {
  let n = 0;
  return segments.flatMap(segment => {
    if (!isBlock(segment)) return segment;
    const choice = choices[n++];
    return choice === 'ours' ? segment.ours : choice === 'theirs' ? segment.theirs : [...segment.ours, ...segment.theirs];
  }).join('\n');
}
