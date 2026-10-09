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
            async initialize() { return { protocolVersion: 1 }; },
            async createSession() { return { sessionId: 'session-1' }; },
            async resumeSession() { throw new Error('not used'); },
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
});
