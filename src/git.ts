import { Channel, invoke } from '@tauri-apps/api/core';

export interface RefInfo { id: string; name: string; fullName: string; kind: 'local' | 'remote' | 'tag'; target: string; isHead: boolean }
export interface Commit { oid: string; shortOid: string; parents: string[]; subject: string; author: string; timestamp: number; shallow: boolean }
export interface GraphPage { graphId: number; commits: Commit[]; refs: RefInfo[]; head: string | null; hasMore: boolean }
export interface FileInfo { id: string; path: string; oldPath: string | null; oldId: string | null; index: string; worktree: string; untracked: boolean; conflicted: boolean; submodule: boolean }
export interface RemoteInfo { id: string; name: string; url: string }
export interface RepoInfo { id: number; root: string; branch: string | null; head: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; operation: string | null; remotes: RemoteInfo[]; files: FileInfo[]; token: string; version: string | null; versioning: boolean }
export interface Preview { text: string; truncated: boolean; binary: boolean }
export interface CommitFile { id: string; path: string; oldPath: string | null; oldId: string | null; status: string }
export interface CommitDetails { oid: string; parents: string[]; author: string; email: string; timestamp: number; message: string; parent: string | null; files: CommitFile[]; shallow: boolean }

export interface Checkpoint { oid: string; timestamp: number; label: string; summary: string }
export interface SessionFile { path: string; status: string; added: number; deleted: number }
export interface Session { checkpoint: Checkpoint | null; files: SessionFile[] }
export interface Answer { text: string; inputTokens: number; outputTokens: number; provider: string }
export interface AiProvider { kind: 'claude' | 'openai' | 'command'; baseUrl: string; model: string; apiKey: string; command: string }

export const api = {
  startup: () => invoke<string | null>('startup_path'),
  open: (path: string) => invoke<RepoInfo>('open_repository', { path }),
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
  commit: (repoId: number, message: string, token: string, detachedOk: boolean, bump: string | null) => invoke<RepoInfo>('create_commit', { repoId, message, token, detachedOk, bump }),
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
  publish: (repoId: number, token: string) => invoke<RepoInfo>('publish_github', { repoId, token }),
  agentRules: (repoId: number) => invoke<string>('get_agent_rules', { repoId }),
  saveAgentRules: (repoId: number, rules: string) => invoke<null>('save_agent_rules', { repoId, rules }),
  ask: (repoId: number, request: 'explain' | 'message' | 'conflict', scope: string) => invoke<Answer>('ask_claude', { repoId, request, scope }),
  aiProvider: () => invoke<AiProvider>('get_ai_provider'),
  saveAiProvider: (provider: AiProvider) => invoke<null>('save_ai_provider', { provider }),
  setApiKey: (key: string) => invoke<null>('set_api_key', { key }),
  runProject: (repoId: number, output: (line: string) => void) => invoke<string>('run_project', { repoId, onOutput: new Channel<string>(output) }),
  stopProject: () => invoke<null>('stop_project'),
};
