import type { RepositoryIdentity, RepositoryResolution } from '../domain/RepositoryIdentity';
import type { SessionRecord } from '../domain/SessionRecord';
import { HermesGatewayClient, type GatewaySession } from '../gateway/HermesGatewayClient';
import { SessionRegistry } from './SessionRegistry';

export interface RepositoryResolver {
  resolve(cwd: string): Promise<RepositoryResolution>;
}

export type GatewaySessionOpenResult = Readonly<{
  kind: 'created' | 'resumed';
  session: GatewaySession;
}> | Readonly<{
  kind: 'resume-failed';
  sessionId: string;
}>;

export class GatewaySessionService {
  private activeRepository: RepositoryIdentity | undefined;

  public constructor(
    private readonly repositoryResolver: RepositoryResolver,
    private readonly client: HermesGatewayClient,
    private readonly registry: SessionRegistry
  ) {}

  public async open(cwd: string): Promise<GatewaySessionOpenResult> {
    const repository = await this.resolveRepository(cwd);
    this.activeRepository = repository;
    await this.client.connect();

    const existing = await this.registry.getMostRecent(repository.logicalId);
    if (existing === undefined) {
      return { kind: 'created', session: await this.client.createSession(repository.cwd) };
    }

    try {
      const session = await this.client.resumeSession(existing.sessionId);
      await this.registry.upsert({
        ...existing,
        gitRoot: repository.gitRoot,
        cwd: repository.cwd,
        ...(repository.remoteOrigin === undefined ? {} : { remoteOrigin: repository.remoteOrigin }),
        ...(repository.branch === undefined ? {} : { branchAtLastSeen: repository.branch }),
        lastActiveAt: new Date().toISOString(),
        resumeState: 'resumable'
      });
      return { kind: 'resumed', session };
    } catch {
      await this.registry.markResumeFailed(existing.sessionId);
      return { kind: 'resume-failed', sessionId: existing.sessionId };
    }
  }

  public async createNew(cwd: string): Promise<GatewaySession> {
    const repository = await this.resolveRepository(cwd);
    this.activeRepository = repository;
    await this.client.connect();
    return this.client.createSession(repository.cwd);
  }

  public async listSessions(cwd: string): Promise<readonly SessionRecord[]> {
    const repository = await this.resolveRepository(cwd);
    this.activeRepository = repository;
    return this.registry.list(repository.logicalId).filter((record) => record.resumeState !== 'resume-failed');
  }

  public async resume(cwd: string, sessionId: string): Promise<GatewaySession> {
    const repository = await this.resolveRepository(cwd);
    const record = this.registry.list(repository.logicalId).find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined || record.resumeState === 'resume-failed') {
      throw new Error('Hermes session is not available for this repository.');
    }
    this.activeRepository = repository;
    await this.client.connect();
    try {
      const session = await this.client.resumeSession(sessionId);
      await this.registry.upsert({
        ...record,
        gitRoot: repository.gitRoot,
        cwd: repository.cwd,
        ...(repository.remoteOrigin === undefined ? {} : { remoteOrigin: repository.remoteOrigin }),
        ...(repository.branch === undefined ? {} : { branchAtLastSeen: repository.branch }),
        lastActiveAt: new Date().toISOString(),
        resumeState: 'resumable'
      });
      return session;
    } catch (error) {
      await this.registry.markResumeFailed(sessionId);
      throw error;
    }
  }

  public async persistSession(sessionId: string, title: string | undefined): Promise<void> {
    const repository = this.activeRepository;
    if (repository === undefined) {
      return;
    }
    const now = new Date().toISOString();
    await this.registry.upsert({
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId,
      repositoryId: repository.logicalId,
      gitRoot: repository.gitRoot,
      cwd: repository.cwd,
      ...(repository.remoteOrigin === undefined ? {} : { remoteOrigin: repository.remoteOrigin }),
      ...(repository.branch === undefined ? {} : { branchAtLastSeen: repository.branch }),
      createdAt: now,
      lastActiveAt: now,
      ...(title === undefined ? {} : { title }),
      resumeState: 'resumable'
    });
  }

  private async resolveRepository(cwd: string): Promise<RepositoryIdentity> {
    const resolution = await this.repositoryResolver.resolve(cwd);
    if (resolution.kind !== 'repository') {
      throw new Error(`Hermes Gateway requires an opened Git repository: ${resolution.cwd}`);
    }
    return resolution.identity;
  }
}
