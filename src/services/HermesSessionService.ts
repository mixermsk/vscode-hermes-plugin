import { HermesAgentAdapter } from '../adapters/HermesAgentAdapter';
import type { AgentLaunchSpec } from '../adapters/AgentAdapter';
import type { RepositoryResolution } from '../domain/RepositoryIdentity';
import { SessionLifecycle, type SessionLifecycleResult } from './SessionLifecycle';
import { SessionRegistry } from './SessionRegistry';

export interface RepositoryResolver {
  resolve(cwd: string): Promise<RepositoryResolution>;
}

export interface AcpSessionControllerLike {
  initialize(): Promise<Readonly<{ protocolVersion: number }>>;
  createSession(cwd: string): Promise<Readonly<{ sessionId: string }>>;
  resumeSession(sessionId: string, cwd: string): Promise<Readonly<{ sessionId: string }>>;
  prompt(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface AcpControllerFactory {
  start(spec: AgentLaunchSpec): Promise<Readonly<{ controller: AcpSessionControllerLike }>>;
}

export class HermesSessionService {
  private activeController: AcpSessionControllerLike | undefined;

  public constructor(
    private readonly repositoryResolver: RepositoryResolver,
    private readonly controllerFactory: AcpControllerFactory,
    private readonly registry: SessionRegistry,
    private readonly adapter = new HermesAgentAdapter()
  ) {}

  public get controller(): AcpSessionControllerLike | undefined {
    return this.activeController;
  }

  public async open(cwd: string): Promise<SessionLifecycleResult> {
    const resolution = await this.repositoryResolver.resolve(cwd);
    if (resolution.kind !== 'repository') {
      throw new Error(`Hermes ACP requires a Git repository: ${resolution.cwd}`);
    }

    const connection = await this.controllerFactory.start(this.adapter.buildLaunchSpec(resolution.identity));
    this.activeController = connection.controller;
    await connection.controller.initialize();
    return new SessionLifecycle(this.registry, {
      create: (sessionCwd) => connection.controller.createSession(sessionCwd),
      resume: (sessionId, sessionCwd) => connection.controller.resumeSession(sessionId, sessionCwd)
    }).open(resolution.identity);
  }
}
