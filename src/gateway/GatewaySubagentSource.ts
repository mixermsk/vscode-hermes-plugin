import {
  type SubagentSnapshot,
  type SubagentStatus,
  isTerminalSubagentStatus
} from '../domain/Subagent';

export type GatewayAvailability =
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'unavailable' | 'incompatible' | 'unauthorized'; message: string }>;

export interface GatewaySubagentSource {
  connect(): Promise<GatewayAvailability>;
  getSnapshot(parentSessionId: string): Promise<readonly SubagentSnapshot[]>;
  subscribe(parentSessionId: string, listener: (snapshot: SubagentSnapshot) => void): GatewaySubagentSubscription;
  dispose(): void;
}

export interface GatewaySubagentSubscription {
  dispose(): void;
}

const MAX_ID_LENGTH = 160;
const MAX_PARENT_ID_LENGTH = 160;
const MAX_TITLE_LENGTH = 80;
const supportedEventTypes = new Set([
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete'
]);

export function parseGatewaySubagentEvent(value: unknown): SubagentSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return undefined;
  }

  const payload = value.payload;
  const eventType = boundedString(value.type, 64);
  if (eventType === undefined || !supportedEventTypes.has(eventType)) {
    return undefined;
  }
  const id = boundedString(payload.subagent_id, MAX_ID_LENGTH);
  if (id === undefined) {
    return undefined;
  }

  const parentId = boundedString(payload.parent_id, MAX_PARENT_ID_LENGTH);
  const status = eventType === 'subagent.complete'
    ? normalizeSubagentStatus(payload.status)
    : eventType === 'subagent.spawn_requested'
      ? 'queued'
      : 'running';
  const title = taskTitle(payload.task_index, payload.task_count);
  const terminal = isTerminalSubagentStatus(status);

  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    title,
    status,
    ...(terminal ? { summary: terminalSummary(status) } : { activity: activityFor(eventType) })
  };
}

export function parseGatewaySubagentSnapshot(value: unknown): SubagentSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = boundedString(value.subagent_id, MAX_ID_LENGTH);
  if (id === undefined) {
    return undefined;
  }
  const parentId = boundedString(value.parent_id, MAX_PARENT_ID_LENGTH);
  const status = normalizeSubagentStatus(value.status);
  const startedAt = typeof value.started_at === 'number' && Number.isFinite(value.started_at)
    ? value.started_at
    : undefined;
  const terminal = isTerminalSubagentStatus(status);

  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    title: 'Delegated task',
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(terminal ? { summary: terminalSummary(status) } : { activity: activityForStatus(status) })
  };
}

export function parseGatewaySubagentList(value: unknown): readonly SubagentSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }
  const snapshots = Array.isArray(value.subagents)
    ? value.subagents.flatMap((item) => {
      const snapshot = parseGatewaySubagentSnapshot(item);
      return snapshot === undefined ? [] : [snapshot];
    })
    : [];
  const failedDelegations = Array.isArray(value.delegations)
    ? value.delegations.flatMap((item) => parseFailedDelegation(item))
    : [];

  return [...snapshots, ...failedDelegations];
}

export function mergeSubagentSnapshot(
  current: SubagentSnapshot | undefined,
  next: SubagentSnapshot
): SubagentSnapshot {
  if (current !== undefined && isTerminalSubagentStatus(current.status) && !isTerminalSubagentStatus(next.status)) {
    return current;
  }
  const merged = {
    ...current,
    ...next,
    ...(current?.startedAt === undefined || next.startedAt === undefined
      ? {}
      : { startedAt: Math.min(current.startedAt, next.startedAt) })
  };
  if (isTerminalSubagentStatus(merged.status)) {
    const terminal = { ...merged };
    delete terminal.activity;
    return terminal;
  }
  const active = { ...merged };
  delete active.summary;
  return active;
}

export function normalizeSubagentStatus(value: unknown): SubagentStatus {
  switch (value) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed':
    case 'error':
    case 'timeout': return 'failed';
    case 'interrupted':
    case 'cancelled': return 'cancelled';
    default: return 'unknown';
  }
}

function taskTitle(taskIndex: unknown, taskCount: unknown): string {
  if (isNonNegativeInteger(taskIndex) && isNonNegativeInteger(taskCount) && taskCount > taskIndex) {
    return `Delegated task ${taskIndex + 1} of ${taskCount}`.slice(0, MAX_TITLE_LENGTH);
  }
  return 'Delegated task';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function activityFor(eventType: string): string {
  switch (eventType) {
    case 'subagent.spawn_requested': return 'Queued';
    case 'subagent.start': return 'Started';
    case 'subagent.tool': return 'Using a tool';
    default: return 'Working';
  }
}

function activityForStatus(status: SubagentStatus): string {
  return status === 'queued' ? 'Queued' : 'Working';
}

function parseFailedDelegation(value: unknown): SubagentSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }
  const delegationId = boundedString(value.delegation_id, MAX_ID_LENGTH);
  if (delegationId === undefined) {
    return [];
  }
  const status = normalizeSubagentStatus(value.status);
  return [{
    id: `delegation:${delegationId}`,
    title: 'Delegated task',
    status,
    ...(isTerminalSubagentStatus(status) ? { summary: terminalSummary(status) } : { activity: activityForStatus(status) })
  }];
}

function terminalSummary(status: SubagentStatus): string {
  switch (status) {
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'failed': return 'Failed';
    default: return 'Finished with an unknown status';
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
