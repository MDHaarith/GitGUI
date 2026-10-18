export interface SummaryHint { text: string; warning: boolean }

export function summaryHint(summary: string): SummaryHint {
  const length = [...summary.trim()].length;
  if (!length) return { text: '', warning: false };
  if (length <= 50) return { text: length + '/50', warning: false };
  if (length <= 72) return { text: length + ' characters · aim for 50', warning: false };
  return { text: length + ' characters · many Git tools truncate after 72', warning: true };
}

/** An AI reply without the Markdown code fence some models wrap around a commit message or PR text. */
export function unfence(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) return lines.slice(1, -1).join('\n').trim();
  return text.trim();
}
