import type { RepositoryIdentity } from '../domain/RepositoryIdentity';
import type { SessionRecord } from '../domain/SessionRecord';
import { SessionRegistry } from './SessionRegistry';

export interface SessionStarter {
  create(cwd: string): Promise<Readonly<{ sessionId: string }>>;
  resume(sessionId: string, cwd: string): Promise<Readonly<{ sessionId: string }>>;
}

export type SessionLifecycleResult =
  | Readonly<{ kind: 'created'; sessionId: string }>
  | Readonly<{ kind: 'resumed'; sessionId: string }>
  | Readonly<{ kind: 'resume-failed'; record: SessionRecord }>;

export class SessionLifecycle {
  public constructor(
    private readonly registry: SessionRegistry,
    private readonly starter: SessionStarter,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  public async open(repository: RepositoryIdentity): Promise<SessionLifecycleResult> {
    const existing = await this.registry.getMostRecent(repository.logicalId);
    if (existing === undefined) {
      const session = await this.starter.create(repository.cwd);
      await this.registry.upsert(this.record(repository, session.sessionId, 'unknown', this.now()));
      return { kind: 'created', sessionId: session.sessionId };
    }

    try {
      await this.starter.resume(existing.sessionId, repository.cwd);
      const updated = {
        ...existing,
        gitRoot: repository.gitRoot,
        cwd: repository.cwd,
        ...(repository.remoteOrigin === undefined ? {} : { remoteOrigin: repository.remoteOrigin }),
        ...(repository.branch === undefined ? {} : { branchAtLastSeen: repository.branch }),
        lastActiveAt: this.now(),
        resumeState: 'resumable' as const
      };
      await this.registry.upsert(updated);
      return { kind: 'resumed', sessionId: existing.sessionId };
    } catch {
      await this.registry.markResumeFailed(existing.sessionId);
      return { kind: 'resume-failed', record: { ...existing, resumeState: 'resume-failed' } };
    }
  }

  private record(repository: RepositoryIdentity, sessionId: string, resumeState: SessionRecord['resumeState'], timestamp: string): SessionRecord {
    return {
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId,
      repositoryId: repository.logicalId,
      gitRoot: repository.gitRoot,
      cwd: repository.cwd,
      ...(repository.remoteOrigin === undefined ? {} : { remoteOrigin: repository.remoteOrigin }),
      ...(repository.branch === undefined ? {} : { branchAtLastSeen: repository.branch }),
      createdAt: timestamp,
      lastActiveAt: timestamp,
      resumeState
    };
  }
}
