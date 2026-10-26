export type Side = 'LEFT' | 'RIGHT';
export interface ReviewComment { path: string; line: number; side: Side; body: string }

export function checkSummary(checks: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[] | null | undefined): string {
  return checks?.map(check => `${check.name || check.context || 'Check'}: ${check.conclusion || check.state || check.status || 'Pending'}`).join('\n') || 'No checks reported.';
}
export function addPending(comments: ReviewComment[], next: ReviewComment): ReviewComment[] {
  const index = comments.findIndex(comment => comment.path === next.path && comment.line === next.line && comment.side === next.side);
  return index === -1 ? [...comments, next] : comments.map((comment, i) => i === index ? next : comment);
}
