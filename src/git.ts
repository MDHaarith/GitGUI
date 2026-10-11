import { Channel, invoke } from '@tauri-apps/api/core';

export interface RefInfo { id: string; name: string; fullName: string; kind: 'local' | 'remote' | 'tag'; target: string; isHead: boolean }
export interface Commit { oid: string; shortOid: string; parents: string[]; subject: string; author: string; timestamp: number; shallow: boolean }
export interface GraphPage { graphId: number; commits: Commit[]; refs: RefInfo[]; head: string | null; hasMore: boolean }
export interface FileInfo { id: string; path: string; oldPath: string | null; oldId: string | null; index: string; worktree: string; untracked: boolean; conflicted: boolean; submodule: boolean }
export interface RemoteInfo { id: string; name: string; url: string }
export interface RepoInfo { id: number; root: string; branch: string | null; head: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; operation: string | null; remotes: RemoteInfo[]; files: FileInfo[]; token: string; version: string | null; versioning: boolean; refsToken: string }
export interface Preview { text: string; truncated: boolean; binary: boolean }
export interface CommitFile { id: string; path: string; oldPath: string | null; oldId: string | null; status: string }
export interface CommitDetails { oid: string; parents: string[]; author: string; email: string; timestamp: number; message: string; parent: string | null; files: CommitFile[]; shallow: boolean }
export interface RebaseCommit { oid: string; message: string }
export interface RebaseEdit extends RebaseCommit { action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' }
export interface RebasePlan { base: string; commits: RebaseCommit[] }

export interface Checkpoint { oid: string; timestamp: number; label: string; summary: string }
export interface SessionFile { path: string; status: string; added: number; deleted: number }
export interface Session { checkpoint: Checkpoint | null; files: SessionFile[] }
export interface Stash { index: number; timestamp: number; message: string }
export interface Junk { id: string; path: string; bytes: number }
export interface FileCommit { oid: string; timestamp: number; author: string; subject: string }
export interface BlameLine { oid: string; author: string; timestamp: number; text: string }
export interface Answer { text: string; inputTokens: number; outputTokens: number; provider: string }
export interface AiProvider { kind: 'claude' | 'openai' | 'command'; baseUrl: string; model: string; apiKey: string; command: string }

export const api = {
  startup: () => invoke<string | null>('startup_path'),
  open: (path: string) => invoke<RepoInfo>('open_repository', { path }),
  closeRepository: (repoId: number) => invoke<void>('close_repository', { repoId }),
  init: (path: string) => invoke<RepoInfo>('init_repository', { path }),
  enableVersioning: (repoId: number) => invoke<RepoInfo>('enable_versioning', { repoId }),
  checkpoints: (repoId: number) => invoke<Checkpoint[]>('list_checkpoints', { repoId }),
  checkpoint: (repoId: number, label: string) => invoke<Checkpoint[]>('save_checkpoint', { repoId, label }),
  restoreCheckpoint: (repoId: number, oid: string, token: string) => invoke<RepoInfo>('restore_checkpoint', { repoId, oid, token }),
  status: (repoId: number) => invoke<RepoInfo>('get_status', { repoId }),
  graph: (repoId: number, scope: string | null, limit: number, graphId: number | null = null) => invoke<GraphPage>('get_graph', { repoId, scope, limit, graphId }),
  details: (repoId: number, oid: string, parent: string | null = null) => invoke<CommitDetails>('get_commit', { repoId, oid, parent }),
  commitDiff: (repoId: number, oid: string, parent: string | null, fileId: string | null = null) => invoke<Preview>('get_commit_diff', { repoId, oid, parent, fileId }),
  workingDiff: (repoId: number, fileId: string, staged: boolean) => invoke<Preview>('get_working_diff', { repoId, fileId, staged }),
  stage: (repoId: number, fileIds: string[], unstage: boolean, token: string) => invoke<RepoInfo>('stage_files', { repoId, fileIds, unstage, token }),
  commit: (repoId: number, message: string, token: string, detachedOk: boolean, bump: string | null, amend = false) => invoke<RepoInfo>('create_commit', { repoId, message, token, detachedOk, bump, amend }),
  createBranch: (repoId: number, name: string, oid: string | null, token: string) => invoke<RepoInfo>('create_branch', { repoId, name, oid, token }),
  switchBranch: (repoId: number, referenceId: string, token: string) => invoke<RepoInfo>('switch_branch', { repoId, referenceId, token }),
  renameBranch: (repoId: number, referenceId: string, name: string, token: string) => invoke<RepoInfo>('rename_branch', { repoId, referenceId, name, token }),
  deleteBranch: (repoId: number, referenceId: string, force: boolean, token: string) => invoke<RepoInfo>('delete_branch', { repoId, referenceId, force, token }),
  fetch: (repoId: number, remoteId: string, progress: (message: string) => void) => invoke<RepoInfo>('fetch_remote', { repoId, remoteId, onProgress: new Channel<string>(progress) }),
  pull: (repoId: number, token: string, progress: (message: string) => void) => invoke<RepoInfo>('pull_remote', { repoId, token, onProgress: new Channel<string>(progress) }),
  push: (repoId: number, remoteId: string | null, token: string, progress: (message: string) => void) => invoke<RepoInfo>('push_remote', { repoId, remoteId, token, onProgress: new Channel<string>(progress) }),
  session: (repoId: number) => invoke<Session>('get_session', { repoId }),
  sessionDiff: (repoId: number, path: string) => invoke<Preview>('get_session_diff', { repoId, path }),
  undoFiles: (repoId: number, paths: string[], token: string) => invoke<RepoInfo>('undo_files', { repoId, paths, token }),
  health: (repoId: number) => invoke<string[]>('get_health', { repoId }),
  startExperiment: (repoId: number, name: string, token: string) => invoke<RepoInfo>('start_experiment', { repoId, name, token }),
  finishExperiment: (repoId: number, keep: boolean, token: string) => invoke<RepoInfo>('finish_experiment', { repoId, keep, token }),
  resolveConflict: (repoId: number, fileId: string, choice: 'ours' | 'theirs' | 'resolved', token: string) => invoke<RepoInfo>('resolve_conflict', { repoId, fileId, choice, token }),
  finishOperation: (repoId: number, abort: boolean, token: string) => invoke<RepoInfo>('finish_operation', { repoId, abort, token }),
  undoCommit: (repoId: number, token: string) => invoke<RepoInfo>('undo_commit', { repoId, token }),
  publish: (repoId: number, main: string, url: string | null, token: string) => invoke<RepoInfo>('publish', { repoId, main, url, token }),
  agentRules: (repoId: number) => invoke<string>('get_agent_rules', { repoId }),
  saveAgentRules: (repoId: number, rules: string) => invoke<null>('save_agent_rules', { repoId, rules }),
  ask: (repoId: number, request: 'explain' | 'message' | 'conflict' | 'pr', scope: string) => invoke<Answer>('ask_claude', { repoId, request, scope }),
  pullRequestBase: (repoId: number) => invoke<string>('pull_request_base', { repoId }),
  createPullRequest: (repoId: number, title: string, body: string, base: string) => invoke<string>('create_pull_request', { repoId, title, body, base }),
  openPullRequest: (url: string) => invoke<void>('open_pull_request', { url }),
  aiProvider: () => invoke<AiProvider>('get_ai_provider'),
  saveAiProvider: (provider: AiProvider) => invoke<null>('save_ai_provider', { provider }),
  setApiKey: (key: string) => invoke<null>('set_api_key', { key }),
  runProject: (repoId: number, output: (line: string) => void) => invoke<string>('run_project', { repoId, onOutput: new Channel<string>(output) }),
  stopProject: () => invoke<null>('stop_project'),
  stashes: (repoId: number) => invoke<Stash[]>('list_stashes', { repoId }),
  stash: (repoId: number, message: string, token: string) => invoke<RepoInfo>('save_stash', { repoId, message, token }),
  applyStash: (repoId: number, stash: Stash, pop: boolean, token: string) => invoke<RepoInfo>('apply_stash', { repoId, index: stash.index, message: stash.message, pop, token }),
  dropStash: (repoId: number, stash: Stash, token: string) => invoke<RepoInfo>('drop_stash', { repoId, index: stash.index, message: stash.message, token }),
  clone: (url: string, parent: string, progress: (message: string) => void) => invoke<RepoInfo>('clone_repository', { url, parent, onProgress: new Channel<string>(progress) }),
  checkoutRemote: (repoId: number, referenceId: string, token: string) => invoke<RepoInfo>('checkout_remote', { repoId, referenceId, token }),
  rebasePlan: (repoId: number, token: string) => invoke<RebasePlan>('rebase_plan', { repoId, token }),
  cleanCommits: (repoId: number, base: string, commits: RebaseEdit[], token: string) => invoke<RepoInfo>('clean_commits', { repoId, base, commits, token }),
  stageHunk: (repoId: number, fileId: string, hunk: number, header: string, unstage: boolean, token: string) => invoke<RepoInfo>('stage_hunk', { repoId, fileId, hunk, header, unstage, token }),
  mergeRef: (repoId: number, referenceId: string, token: string) => invoke<RepoInfo>('merge_ref', { repoId, referenceId, token }),
  applyCommit: (repoId: number, oid: string, revert: boolean, token: string) => invoke<RepoInfo>('apply_commit', { repoId, oid, revert, token }),
  createTag: (repoId: number, name: string, message: string, oid: string, token: string) => invoke<RepoInfo>('create_tag', { repoId, name, message, oid, token }),
  deleteTag: (repoId: number, referenceId: string, token: string) => invoke<RepoInfo>('delete_tag', { repoId, referenceId, token }),
  resetCommit: (repoId: number, oid: string, mode: string, token: string) => invoke<RepoInfo>('reset_commit', { repoId, oid, mode, token }),
  discard: (repoId: number, fileIds: string[], token: string) => invoke<RepoInfo>('discard_files', { repoId, fileIds, token }),
  ignore: (repoId: number, fileId: string, folder: boolean, token: string) => invoke<RepoInfo>('ignore_file', { repoId, fileId, folder, token }),
  fileHistory: (repoId: number, fileId: string, commit: string | null = null) => invoke<FileCommit[]>('file_history', { repoId, fileId, commit }),
  fileBlame: (repoId: number, fileId: string, commit: string | null = null) => invoke<BlameLine[]>('file_blame', { repoId, fileId, commit }),
  conflict: (repoId: number, fileId: string) => invoke<string>('get_conflict', { repoId, fileId }),
  saveResolution: (repoId: number, fileId: string, content: string, token: string) => invoke<RepoInfo>('save_resolution', { repoId, fileId, content, token }),
  junk: (repoId: number) => invoke<Junk[]>('list_junk', { repoId }),
  deleteJunk: (repoId: number, ids: string[], token: string) => invoke<RepoInfo>('delete_junk', { repoId, ids, token }),
  compact: (repoId: number) => invoke<RepoInfo>('compact_repository', { repoId }),
  latestRelease: () => invoke<[string, string] | null>('latest_release'),
  openRelease: (url: string) => invoke<null>('open_release', { url }),
};
