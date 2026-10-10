import { invoke } from '@tauri-apps/api/core';

export interface RefInfo { id: string; name: string; fullName: string; kind: 'local' | 'remote' | 'tag'; target: string; isHead: boolean }
export interface Commit { oid: string; shortOid: string; parents: string[]; subject: string; author: string; timestamp: number; shallow: boolean }
export interface GraphPage { graphId: number; commits: Commit[]; refs: RefInfo[]; head: string | null; hasMore: boolean }
export interface FileInfo { id: string; path: string; oldPath: string | null; oldId: string | null; index: string; worktree: string; untracked: boolean; conflicted: boolean; submodule: boolean }
export interface RemoteInfo { id: string; name: string; url: string }
export interface RepoInfo { id: number; root: string; branch: string | null; head: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; operation: string | null; remotes: RemoteInfo[]; files: FileInfo[]; token: string }
export interface Preview { text: string; truncated: boolean; binary: boolean }
export interface CommitFile { id: string; path: string; oldPath: string | null; oldId: string | null; status: string }
export interface CommitDetails { oid: string; parents: string[]; author: string; email: string; timestamp: number; message: string; parent: string | null; files: CommitFile[]; shallow: boolean }

export const api = {
  startup: () => invoke<string | null>('startup_path'),
  open: (path: string) => invoke<RepoInfo>('open_repository', { path }),
  status: (repoId: number) => invoke<RepoInfo>('get_status', { repoId }),
  graph: (repoId: number, scope: string | null, limit: number, graphId: number | null = null) => invoke<GraphPage>('get_graph', { repoId, scope, limit, graphId }),
  details: (repoId: number, oid: string, parent: string | null = null) => invoke<CommitDetails>('get_commit', { repoId, oid, parent }),
  commitDiff: (repoId: number, oid: string, parent: string | null, fileId: string | null = null) => invoke<Preview>('get_commit_diff', { repoId, oid, parent, fileId }),
  workingDiff: (repoId: number, fileId: string, staged: boolean) => invoke<Preview>('get_working_diff', { repoId, fileId, staged }),
  stage: (repoId: number, fileIds: string[], unstage: boolean, token: string) => invoke<RepoInfo>('stage_files', { repoId, fileIds, unstage, token }),
  commit: (repoId: number, message: string, token: string, detachedOk: boolean) => invoke<RepoInfo>('create_commit', { repoId, message, token, detachedOk }),
  createBranch: (repoId: number, name: string, oid: string | null, token: string) => invoke<RepoInfo>('create_branch', { repoId, name, oid, token }),
  switchBranch: (repoId: number, referenceId: string, token: string) => invoke<RepoInfo>('switch_branch', { repoId, referenceId, token }),
  fetch: (repoId: number, remoteId: string) => invoke<RepoInfo>('fetch_remote', { repoId, remoteId }),
  pull: (repoId: number, token: string) => invoke<RepoInfo>('pull_remote', { repoId, token }),
  push: (repoId: number, remoteId: string | null, token: string) => invoke<RepoInfo>('push_remote', { repoId, remoteId, token }),
};
