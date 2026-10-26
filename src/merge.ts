import type { Choice } from './conflict.ts';

export type MergeKind = 'unchanged' | 'ours' | 'theirs' | 'both' | 'conflict';
export interface MergeBlock { base: string; ours: string; theirs: string; kind: MergeKind; parts?: MergeBlock[] }
interface Edit { start: number; end: number; lines: string[] }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const kindOf = (base: string, ours: string, theirs: string): MergeKind => ours === theirs ? (ours === base ? 'unchanged' : 'both') : ours === base ? 'theirs' : theirs === base ? 'ours' : 'conflict';

/** Line edits relative to the base; keep line endings and the absence of a final newline. */
function edits(base: string[], side: string[]): Edit[] {
  let prefix = 0, suffix = 0;
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix++;
  while (suffix < base.length - prefix && suffix < side.length - prefix && base[base.length - 1 - suffix] === side[side.length - 1 - suffix]) suffix++;
  const a = base.slice(prefix, base.length - suffix), b = side.slice(prefix, side.length - suffix);
  const width = b.length + 1;
  // shortcut: quadratic line comparison is bounded by the preview limits; use Myers if those limits grow.
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const result: Edit[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    const edit: Edit = { start: prefix + i, end: prefix + i, lines: [] };
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      if (j < b.length && (i === a.length || lcs[i * width + j + 1] > lcs[(i + 1) * width + j])) edit.lines.push(b[j++]);
      else i++;
    }
    edit.end = prefix + i; result.push(edit);
  }
  return result;
}

/** Yours/theirs here always mean the user's sides, including during a rebase. */
export function mergeSides(ours: string | null, theirs: string | null, rebasing: boolean) {
  return rebasing ? { ours: theirs ?? '', theirs: ours ?? '' } : { ours: ours ?? '', theirs: theirs ?? '' };
}

export function mergeBlocks(baseText: string, oursText: string, theirsText: string): MergeBlock[] {
  const base = lines(baseText);
  const changes = [...edits(base, lines(oursText)).map(edit => ({ ...edit, side: 'ours' })), ...edits(base, lines(theirsText)).map(edit => ({ ...edit, side: 'theirs' }))].sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: MergeBlock[] = [];
  let position = 0;
  const unchanged = (end: number) => {
    if (end <= position) return;
    const text = base.slice(position, end).join(''); blocks.push({ base: text, ours: text, theirs: text, kind: 'unchanged' });
  };
  for (let i = 0; i < changes.length;) {
    const start = changes[i].start;
    let end = changes[i].end;
    const group = [changes[i++]];
    // Insertions on the boundary of a replacement are ambiguous, so keep them together.
    while (i < changes.length && (changes[i].start < end || (changes[i].start === end && (changes[i].start === changes[i].end || group.some(edit => edit.start === edit.end && edit.start === end))))) {
      end = Math.max(end, changes[i].end); group.push(changes[i++]);
    }
    unchanged(start);
    const original = base.slice(start, end).join('');
    const apply = (side: string) => {
      let cursor = start; let text = '';
      for (const edit of group.filter(edit => edit.side === side)) {
        text += base.slice(cursor, edit.start).join('') + edit.lines.join(''); cursor = edit.end;
      }
      return text + base.slice(cursor, end).join('');
    };
    const ours = apply('ours'), theirs = apply('theirs');
    const kind = kindOf(original, ours, theirs);
    blocks.push({ base: original, ours, theirs, kind }); position = end;
  }
  unchanged(base.length);
  return blocks.length ? blocks : [{ base: '', ours: '', theirs: '', kind: 'unchanged' }];
}

export function chooseBlock(block: MergeBlock, choice: Choice | 'ignore'): string {
  return choice === 'ignore' ? block.base : choice === 'both' ? block.ours + (block.ours && block.theirs && !block.ours.endsWith('\n') ? '\n' : '') + block.theirs : block[choice];
}

export function simpleResolution(block: MergeBlock): string | null {
  return block.kind === 'conflict' ? null : block.kind === 'theirs' ? block.theirs : block.ours;
}

function conflictResult(block: MergeBlock): string {
  return `<<<<<<< Yours\n${block.ours}${block.ours && !block.ours.endsWith('\n') ? '\n' : ''}=======\n${block.theirs}${block.theirs && !block.theirs.endsWith('\n') ? '\n' : ''}>>>>>>> Theirs\n`;
}

function initialResult(block: MergeBlock): string { return simpleResolution(block) ?? conflictResult(block); }

/** Only automatic pieces change; unresolved pieces keep both versions for review. */
export function automaticResolution(block: MergeBlock, identical: boolean): string | null {
  const parts = block.parts ?? [block];
  const selected = (part: MergeBlock) => part.kind === 'ours' || part.kind === 'theirs' || (identical && part.kind === 'both');
  if (!parts.some(selected)) return null;
  return parts.map(part => selected(part) ? simpleResolution(part)! : part.kind === 'unchanged' ? part.base : conflictResult(part)).join('');
}

/** Align the actual working file to stage-backed blocks, preserving every existing edit and marker. */
export function workingResults(blocks: MergeBlock[], working: string): string[] {
  const defaults = blocks.map(initialResult);
  const original = lines(defaults.join('')), actual = lines(working);
  const changes = edits(original, actual);
  const boundary = (position: number) => {
    let offset = 0;
    for (const edit of changes) {
      if (position <= edit.start) break;
      if (position < edit.end) return edit.start + offset;
      offset += edit.lines.length - (edit.end - edit.start);
    }
    return position + offset;
  };
  let start = 0, position = 0;
  return defaults.map((text, index) => {
    position += lines(text).length;
    const end = index === defaults.length - 1 ? actual.length : boundary(position);
    const result = actual.slice(start, end).join(''); start = end; return result;
  });
}

/** Keep a working-file marker region in one editable block, even when Git grouped nearby edits. */
export function mergeFile(base: string, ours: string, theirs: string, working: string) {
  const blocks = mergeBlocks(base, ours, theirs), results = workingResults(blocks, working);
  const markerRanges: [number, number][] = [];
  let offset = 0, start = -1;
  for (const line of lines(working)) {
    if (/^<{7,}(?: |\r?$)/.test(line) && start < 0) start = offset;
    offset += line.length;
    if (/^>{7,}(?: |\r?$)/.test(line) && start >= 0) { markerRanges.push([start, offset]); start = -1; }
  }
  const grouped: MergeBlock[] = [], values: string[] = [];
  offset = 0;
  blocks.forEach((block, index) => {
    const previous = grouped[grouped.length - 1];
    if (previous && markerRanges.some(([start, end]) => offset > start && offset < end)) {
      previous.parts ??= [{ ...previous }]; previous.parts.push(block);
      previous.base += block.base; previous.ours += block.ours; previous.theirs += block.theirs;
      previous.kind = kindOf(previous.base, previous.ours, previous.theirs);
      values[values.length - 1] += results[index];
    } else { grouped.push({ ...block }); values.push(results[index]); }
    offset += results[index].length;
  });
  return { blocks: grouped, results: values };
}

export function operationControls(operation: string | null, conflicts: number) {
  const supported = operation !== null && ['merge', 'rebase', 'cherry-pick', 'revert'].includes(operation);
  return { supported, canContinue: supported && conflicts === 0, canSkip: supported && operation !== 'merge' };
}
