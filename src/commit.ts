export interface SummaryHint { text: string; warning: boolean }

export function summaryHint(summary: string): SummaryHint {
  const length = [...summary.trim()].length;
  if (!length) return { text: '', warning: false };
  if (length <= 50) return { text: length + '/50', warning: false };
  if (length <= 72) return { text: length + ' characters · aim for 50', warning: false };
  return { text: length + ' characters · many Git tools truncate after 72', warning: true };
}
