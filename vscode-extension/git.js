const { execFile } = require('node:child_process');
const path = require('node:path');
const { stat } = require('node:fs/promises');
const { LOG_FORMAT, revision, filePath, relativePath, parseLog, parseFiles, parseHistory, parseBlame } = require('./git-data');

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
      cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout, stderr) => {
      if (error) { error.message = (stderr || error.message).trim(); reject(error); }
      else resolve(stdout);
    });
  });
}

async function repository(directory) {
  // Discovery is the only call made before the repository root is known.
  const root = (await run(directory, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  if (!path.isAbsolute(root)) throw new Error('Git returned an invalid repository root.');
  return new Repository(root);
}

class Repository {
  constructor(root) { this.root = root; }
  run(args) { return run(this.root, args); }
  async log({ limit = 50, skip = 0, all = false, file } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(skip) || skip < 0) {
      throw new Error('Invalid history limit.');
    }
    const args = ['log', '--no-show-signature', '--topo-order', `--max-count=${limit}`, `--skip=${skip}`,
      `--format=${LOG_FORMAT}`];
    if (all) args.push('--all');
    if (file) args.push('--follow');
    if (!all) args.push('HEAD');
    args.push('--');
    if (file) args.push(filePath(file));
    try { return parseLog(await this.run(args)); }
    catch (error) {
      // An unborn branch has no HEAD; failures with an existing HEAD must surface.
      if (!all) {
        try { await this.run(['rev-parse', '--verify', 'HEAD']); }
        catch { if (/unknown revision|bad revision|does not have any commits|ambiguous argument/.test(error.message)) return []; }
      }
      throw error;
    }
  }
  async commit(oid) {
    return parseLog(await this.run(['show', '--no-show-signature', '--no-patch', `--format=${LOG_FORMAT}`, revision(oid), '--']))[0];
  }
  async history(file) {
    return parseHistory(await this.run(['log', '--no-show-signature', '--follow', '--name-status', '-z',
      '-M', '--max-count=200', `--format=${LOG_FORMAT}`, 'HEAD', '--', filePath(file)]), file);
  }
  async files(commit) {
    const args = ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', '--no-ext-diff', '--no-textconv'];
    if (commit.parents.length) args.push(revision(commit.parents[0]));
    else args.push('--root');
    args.push(revision(commit.oid), '--');
    return parseFiles(await this.run(args));
  }
  show(oid, file) {
    return this.run(['show', '--no-ext-diff', '--no-textconv', `${revision(oid)}:${filePath(file)}`]);
  }
  async clean(file) {
    filePath(file);
    try {
      await this.run(['ls-files', '--error-unmatch', '--', file]);
      await this.run(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file]);
      return true;
    } catch (error) {
      if (error.code === 1 || error.code === 128) return false;
      throw error;
    }
  }
  async blame(file, line) {
    if (!Number.isInteger(line) || line < 1) throw new Error('Invalid blame line.');
    return parseBlame(await this.run(['blame', '--porcelain', '-L', `${line},${line}`, 'HEAD', '--', filePath(file)]));
  }
  async fileRevision(file) {
    const info = await stat(path.join(this.root, filePath(file)));
    const head = revision((await this.run(['rev-parse', 'HEAD'])).trim());
    return `${head}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  }
  relative(absolute) { return relativePath(this.root, absolute); }
}

module.exports = { repository, Repository };
