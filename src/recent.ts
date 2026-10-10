const LIMIT = 8;

export function parseRecent(raw: string | null): string[] {
  try {
    const paths: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(paths) ? [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.startsWith('/') && path.length <= 32768 && !path.includes('\0')))].slice(0, LIMIT) : [];
  } catch { return []; }
}
export function rememberRecent(paths: string[], path: string) { return [path, ...paths.filter(entry => entry !== path)].slice(0, LIMIT); }
export function forgetRecent(paths: string[], path: string) { return paths.filter(entry => entry !== path); }
// Only a missing folder or a folder that is no longer a repository should drop a saved path.
export function isUnavailable(error: unknown) { return /Cannot open this folder|not a git repository/i.test(String(error)); }
