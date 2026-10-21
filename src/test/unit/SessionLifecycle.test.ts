import * as assert from 'node:assert/strict';
import { SessionLifecycle, type SessionStarter } from '../../services/SessionLifecycle';
import { SessionRegistry, type KeyValueStore } from '../../services/SessionRegistry';

class InMemoryStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, defaultValue?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

const repository = {
  logicalId: 'origin:example/project',
  gitRoot: '/work/project',
  cwd: '/work/project',
  remoteOrigin: 'git@github.com:example/project',
  branch: 'main'
};

suite('SessionLifecycle', () => {
  test('marks a stale session as failed instead of silently creating another one', async () => {
    const registry = new SessionRegistry(new InMemoryStore());
    await registry.upsert({
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId: 'stale-session',
      repositoryId: repository.logicalId,
      gitRoot: repository.gitRoot,
      cwd: repository.cwd,
      createdAt: '2026-10-09T10:00:00.000Z',
      lastActiveAt: '2026-10-09T10:00:00.000Z',
      resumeState: 'unknown'
    });
    const starter: SessionStarter = {
      async create() { throw new Error('must not create automatically'); },
      async resume() { throw new Error('session not found'); }
    };

    const result = await new SessionLifecycle(registry, starter).open(repository);

    assert.equal(result.kind, 'resume-failed');
    assert.equal(result.record.sessionId, 'stale-session');
    assert.equal((await registry.getMostRecent(repository.logicalId))?.resumeState, 'resume-failed');
  });

  test('creates an unrecorded session when the repository has no known session', async () => {
    const registry = new SessionRegistry(new InMemoryStore());
    const starter: SessionStarter = {
      async create() { return { sessionId: 'new-session' }; },
      async resume() { throw new Error('not used'); }
    };
    const lifecycle = new SessionLifecycle(registry, starter, () => '2026-10-09T12:00:00.000Z');

    const result = await lifecycle.open(repository);

    assert.deepEqual(result, { kind: 'created', sessionId: 'new-session' });
    assert.equal(await registry.getMostRecent(repository.logicalId), undefined);
  });
});
