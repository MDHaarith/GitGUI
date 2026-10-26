import type { AiPermission } from './git.ts';
export function writeTool(name: string): boolean { return ['stage', 'commit', 'create_branch', 'switch_branch', 'stash'].includes(name); }
export function toolAllowed(name: string, permission: AiPermission): boolean {
  if (['status', 'diff', 'log', 'show_file', 'branches'].includes(name)) return true;
  if (['stage', 'commit'].includes(name)) return permission !== 'read-only';
  return ['create_branch', 'switch_branch', 'stash'].includes(name) && permission === 'everything';
}
