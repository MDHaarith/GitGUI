import type { RepoInfo } from './git.ts';

/** Plain-English notes about the repository state, most urgent first. */
export function explainState(repo: Pick<RepoInfo, 'detached' | 'operation' | 'upstream' | 'ahead' | 'behind' | 'head' | 'branch' | 'remotes'>): string[] {
  const notes: string[] = [];
  if (repo.operation === 'unresolved conflicts') notes.push('Conflicts: two changes edited the same lines. In Changes, choose Keep mine or Keep theirs for each conflicted file (or edit it, remove the <<<<<<< ======= >>>>>>> markers, and press Mark fixed), then Continue.');
  else if (repo.operation) notes.push(`A ${repo.operation} is half-finished. Git paused it and is waiting for you: press Continue or Abort in Changes before doing anything else.`);
  if (repo.detached) notes.push('You are looking at an old snapshot, not a branch. Commits made here are easy to lose: create a branch first if you want to keep working from this point.');
  if (repo.ahead && repo.behind) notes.push(`Your copy and the server both have new commits (${repo.ahead} here, ${repo.behind} there). Pull first to combine them, then push.`);
  else if (repo.behind) notes.push(`The server has ${repo.behind} commit${repo.behind === 1 ? '' : 's'} you don't have yet. Pull to get them.`);
  else if (repo.ahead) notes.push(`${repo.ahead} commit${repo.ahead === 1 ? ' is' : 's are'} only on this computer. Push to back ${repo.ahead === 1 ? 'it' : 'them'} up.`);
  else if (repo.head && !repo.remotes.length) notes.push('Your code exists only on this computer. If the disk fails, it is gone: use Publish to GitHub to back it up.');
  else if (repo.branch && repo.head && !repo.upstream) notes.push('This branch exists only on this computer. Push it to back it up and share it.');
  return notes;
}

const errors: [RegExp, string][] = [
  [/GitGUI safeguards: a staged line looks like an API key|GitGUI safeguards: a \.env file/, 'Nothing was committed. Secrets pushed to GitHub get copied by bots within minutes; keep them in an ignored .env file.'],
  [/GitGUI safeguards: tests failed/, 'Nothing was committed because the project tests fail. Fix the failing test (or ask your AI to) and commit again.'],
  [/GitGUI (safeguards|versioning): .*version is still/, 'Nothing was committed. Choose Patch, Minor, or Major in the Version menu so this change gets its own version.'],
  [/non-fast-forward|fetch first|\[rejected\]/, 'The server has commits you don\'t have. Pull first, then push again.'],
  [/CONFLICT|Automatic merge failed/, 'Git could not combine the changes on its own because both sides edited the same lines. Resolve the conflicted files, stage them, and commit.'],
  [/would be overwritten by (merge|checkout)|Please commit your changes or stash them/, 'This would overwrite changes you haven\'t committed. Commit them (or save a checkpoint) first.'],
  [/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/, 'The server did not accept your login. Sign in with Git once in a terminal (or set up an SSH key or a credential helper), then retry.'],
  [/Could not resolve host|unable to access|Connection timed out|Network is unreachable/, 'GitGUI could not reach the server. Check your internet connection and the remote address.'],
  [/HEAD or staged changes changed since your last review/, 'Something else (often your AI agent) changed the files. Press Refresh, check the changes, and try again.'],
  [/Another Git operation is running/, 'Wait for the current operation to finish, then try again.'],
];

/** One plain-English sentence explaining a Git error, if it is a known one. */
export function explainError(message: string): string | null {
  return errors.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

export interface ChangedFile { path: string; status: string; added: number; deleted: number }

/** Why a changed file deserves a closer look, or null for ordinary edits. */
export function riskOf(file: ChangedFile): string | null {
  const path = file.path.toLowerCase();
  if (/(^|\/)\.env($|\.)|secret|credential|\.pem$|\.key$/.test(path)) return 'May contain secrets';
  if (/(^|\/)(tests?|__tests__)\/|\.test\.|_test\.|\.spec\./.test(path) && (file.status === 'D' || file.deleted > file.added)) return 'Tests removed';
  if (file.status === 'D') return 'File deleted';
  if (/(^|\/)(package\.json|cargo\.toml|requirements\.txt|pyproject\.toml|go\.mod|gemfile)$/.test(path)) return 'Dependencies changed';
  if (/migration|schema|\.sql$|(^|\/)\.github\/|dockerfile|\.ya?ml$|config/.test(path)) return 'Config or database change';
  if (file.added + file.deleted > 300) return 'Large change';
  return null;
}
/** Risky files first, then by size of change. */
export function sortByRisk<T extends ChangedFile>(files: T[]): (T & { risk: string | null })[] {
  return files.map(file => ({ ...file, risk: riskOf(file) }))
    .sort((a, b) => Number(!!b.risk) - Number(!!a.risk) || (b.added + b.deleted) - (a.added + a.deleted));
}

const crashes: [RegExp, string][] = [
  [/EADDRINUSE|address already in use/i, 'Another program already uses this port. Stop the other copy (or restart your computer) and run again.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/, 'A package is missing. Install dependencies (npm install, or pip install -r requirements.txt) and run again.'],
  [/command not found|not recognized as an internal|ENOENT.*spawn/, 'A required program is not installed or not on PATH.'],
  [/SyntaxError|Unexpected token|error\[E\d+\]|error TS\d+/, 'The code has an error the compiler found. Ask your AI to fix the first error shown above.'],
  [/permission denied|EACCES/i, 'The project tried to use a file or port it is not allowed to.'],
  [/out of memory|heap out of memory/i, 'The project ran out of memory, often from an infinite loop.'],
];
/** One plain-English hint for a crashed project's output, if the cause is recognisable. */
export function explainCrash(output: string): string | null {
  return crashes.find(([pattern]) => pattern.test(output))?.[1] ?? null;
}

/** US dollars for a Claude Opus 5.5 request ($4 / $20 per million input / output tokens). */
export function aiCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 4 + outputTokens * 20) / 1_000_000;
}
