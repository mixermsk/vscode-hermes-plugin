export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type SubagentSnapshot = Readonly<{
  id: string;
  parentId?: string;
  title: string;
  status: SubagentStatus;
  activity?: string;
  startedAt?: number;
  summary?: string;
}>;

export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
