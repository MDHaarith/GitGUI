import { Channel, invoke } from '@tauri-apps/api/core';

export type TerminalOutput = { kind: 'data'; value: number[] } | { kind: 'exit'; value: string };
export interface GitOutput { time: number; root: string; args: string[]; durationMs: number; exitStatus: number | null; success: boolean; stderr: string }

export const terminalApi = {
  start: (repoId: number, cols: number, rows: number, output: (data: TerminalOutput) => void) => invoke<void>('start_terminal', { repoId, cols, rows, onOutput: new Channel<TerminalOutput>(output) }),
  input: (repoId: number, data: Uint8Array) => invoke<void>('terminal_input', { repoId, data: Array.from(data) }),
  resize: (repoId: number, cols: number, rows: number) => invoke<void>('resize_terminal', { repoId, cols, rows }),
  ack: (repoId: number) => invoke<void>('terminal_ack', { repoId }),
  stop: (repoId: number) => invoke<void>('stop_terminal', { repoId }),
  log: () => invoke<GitOutput[]>('git_output_log'),
};

export function commandText(args: string[]): string {
  return 'git ' + args.map(arg => /^[\w./:@=+-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ');
}
