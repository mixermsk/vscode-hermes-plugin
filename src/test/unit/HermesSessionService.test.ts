import * as assert from 'node:assert/strict';
import type { AgentLaunchSpec } from '../../adapters/AgentAdapter';
import type { RepositoryIdentity } from '../../domain/RepositoryIdentity';
import { SessionRegistry, type KeyValueStore } from '../../services/SessionRegistry';
import { HermesSessionService, type AcpControllerFactory, type RepositoryResolver } from '../../services/HermesSessionService';

class InMemoryStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, defaultValue?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

const repository: RepositoryIdentity = {
  logicalId: 'origin:example/project', gitRoot: '/work/project', cwd: '/work/project'
};

suite('HermesSessionService', () => {
  test('starts Hermes in the repository cwd before creating the first session', async () => {
    const resolver: RepositoryResolver = { async resolve() { return { kind: 'repository', identity: repository }; } };
    let launchSpec: AgentLaunchSpec | undefined;
    const factory: AcpControllerFactory = {
      async start(spec) {
        launchSpec = spec;
        return {
          controller: {
            async initialize() { return { protocolVersion: 1, supportsSessionList: false }; },
            async createSession() { return { sessionId: 'session-1' }; },
            async resumeSession() { throw new Error('not used'); },
            async getSessionInfo() { throw new Error('not used'); },
            async prompt() { throw new Error('not used'); },
            async cancel() { throw new Error('not used'); }
          }
        };
      }
    };
    const service = new HermesSessionService(resolver, factory, new SessionRegistry(new InMemoryStore()));

    const result = await service.open('/work/project');

    assert.deepEqual(result, { kind: 'created', sessionId: 'session-1' });
    assert.deepEqual(launchSpec, { command: 'hermes', args: ['acp'], cwd: '/work/project', environment: {} });
  });

  test('loads the persisted display title from an advertised ACP session list', async () => {
    const resolver: RepositoryResolver = { async resolve() { return { kind: 'repository', identity: repository }; } };
    const store = new InMemoryStore();
    const factory: AcpControllerFactory = {
      async start() {
        return {
          controller: {
            async initialize() { return { protocolVersion: 1, supportsSessionList: true }; },
            async createSession() { return { sessionId: 'session-1' }; },
            async resumeSession() { throw new Error('not used'); },
            async getSessionInfo() { return { sessionId: 'session-1', title: 'Refactor chat transport' }; },
            async prompt() { throw new Error('not used'); },
            async cancel() { throw new Error('not used'); }
          }
        };
      }
    };
    const registry = new SessionRegistry(store);
    const service = new HermesSessionService(resolver, factory, registry);

    const result = await service.open('/work/project');

    assert.deepEqual(result, { kind: 'created', sessionId: 'session-1', title: 'Refactor chat transport' });
    assert.equal(await registry.getMostRecent(repository.logicalId), undefined);
  });

  test('marks a resumed session failed when Hermes no longer lists it', async () => {
    const resolver: RepositoryResolver = { async resolve() { return { kind: 'repository', identity: repository }; } };
    const store = new InMemoryStore();
    const registry = new SessionRegistry(store);
    await registry.upsert({
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId: 'stale-session',
      repositoryId: repository.logicalId,
      gitRoot: repository.gitRoot,
      cwd: repository.cwd,
      createdAt: '2026-10-20T12:00:00.000Z',
      lastActiveAt: '2026-10-20T12:00:00.000Z',
      resumeState: 'resumable'
    });
    const factory: AcpControllerFactory = {
      async start() {
        return {
          controller: {
            async initialize() { return { protocolVersion: 1, supportsSessionList: true }; },
            async createSession() { throw new Error('not used'); },
            async resumeSession() { return { sessionId: 'stale-session' }; },
            async getSessionInfo() { return undefined; },
            async prompt() { throw new Error('not used'); },
            async cancel() { throw new Error('not used'); }
          }
        };
      }
    };
    const service = new HermesSessionService(resolver, factory, registry);

    const result = await service.open('/work/project');

    assert.equal(result.kind, 'resume-failed');
    assert.equal(result.record.sessionId, 'stale-session');
    assert.equal((await registry.getMostRecent(repository.logicalId))?.resumeState, 'resume-failed');
  });

  test('persists a new session after its first completed prompt', async () => {
    const resolver: RepositoryResolver = { async resolve() { return { kind: 'repository', identity: repository }; } };
    const store = new InMemoryStore();
    const registry = new SessionRegistry(store);
    const factory: AcpControllerFactory = {
      async start() {
        return {
          controller: {
            async initialize() { return { protocolVersion: 1, supportsSessionList: false }; },
            async createSession() { return { sessionId: 'session-1' }; },
            async resumeSession() { throw new Error('not used'); },
            async getSessionInfo() { throw new Error('not used'); },
            async prompt() { throw new Error('not used'); },
            async cancel() { throw new Error('not used'); }
          }
        };
      }
    };
    const service = new HermesSessionService(resolver, factory, registry);

    await service.open('/work/project');
    await service.persistSession('session-1');

    assert.equal((await registry.getMostRecent(repository.logicalId))?.sessionId, 'session-1');
  });
});
