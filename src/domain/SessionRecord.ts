export type ResumeState = 'unknown' | 'resumable' | 'resume-failed';

export type SessionRecord = Readonly<{
  schemaVersion: 1;
  agentKind: 'hermes';
  sessionId: string;
  repositoryId: string;
  gitRoot: string;
  cwd: string;
  remoteOrigin?: string;
  branchAtLastSeen?: string;
  createdAt: string;
  lastActiveAt: string;
  title?: string;
  resumeState: ResumeState;
}>;
