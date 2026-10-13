import * as assert from 'node:assert/strict';
import type { SessionRecord } from '../../domain/SessionRecord';
import { SessionRegistry, type KeyValueStore } from '../../services/SessionRegistry';

class InMemoryStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function sessionRecord(sessionId: string, repositoryId: string, timestamp: string): SessionRecord {
  return {
    schemaVersion: 1,
    agentKind: 'hermes',
    sessionId,
    repositoryId,
    gitRoot: '/work/project',
    cwd: '/work/project',
    createdAt: timestamp,
    lastActiveAt: timestamp,
    resumeState: 'unknown'
  };
}

suite('SessionRegistry', () => {
  test('replaces the existing record when the same Hermes session is updated', async () => {
    const registry = new SessionRegistry(new InMemoryStore());
    const original = sessionRecord('session-1', 'origin:example/project', '2026-10-09T10:00:00.000Z');

    await registry.upsert(original);
    await registry.upsert({
      ...original,
      branchAtLastSeen: 'feature/session-resume',
      lastActiveAt: '2026-10-09T12:00:00.000Z',
      resumeState: 'resumable'
    });

    assert.deepEqual(registry.list('origin:example/project'), [
      {
        ...original,
        branchAtLastSeen: 'feature/session-resume',
        lastActiveAt: '2026-10-09T12:00:00.000Z',
        resumeState: 'resumable'
      }
    ]);
  });

  test('retains only the newest configured number of records per repository', async () => {
    const registry = new SessionRegistry(new InMemoryStore(), 2);

    await registry.upsert(sessionRecord('session-oldest', 'origin:example/project', '2026-10-09T10:00:00.000Z'));
    await registry.upsert(sessionRecord('session-middle', 'origin:example/project', '2026-10-09T11:00:00.000Z'));
    await registry.upsert(sessionRecord('session-newest', 'origin:example/project', '2026-10-09T12:00:00.000Z'));
    await registry.upsert(sessionRecord('other-repository', 'origin:example/other', '2026-10-09T09:00:00.000Z'));

    assert.deepEqual(
      registry.list('origin:example/project').map((record) => record.sessionId),
      ['session-newest', 'session-middle']
    );
    assert.equal((await registry.getMostRecent('origin:example/other'))?.sessionId, 'other-repository');
  });

  test('updates resume state and activity without changing session identity', async () => {
    const registry = new SessionRegistry(new InMemoryStore());
    await registry.upsert(sessionRecord('session-1', 'origin:example/project', '2026-10-09T10:00:00.000Z'));

    await registry.markResumeFailed('session-1');
    await registry.touch('session-1', '2026-10-09T12:00:00.000Z');

    assert.deepEqual(await registry.getMostRecent('origin:example/project'), {
      ...sessionRecord('session-1', 'origin:example/project', '2026-10-09T10:00:00.000Z'),
      lastActiveAt: '2026-10-09T12:00:00.000Z',
      resumeState: 'resume-failed'
    });
  });

  test('stores the human-readable title separately from the session ID', async () => {
    const registry = new SessionRegistry(new InMemoryStore());
    await registry.upsert(sessionRecord('session-1', 'origin:example/project', '2026-10-09T10:00:00.000Z'));

    await registry.setTitle('session-1', 'Refactor chat transport');

    assert.equal((await registry.getMostRecent('origin:example/project'))?.title, 'Refactor chat transport');

    await registry.setTitle('session-1', undefined);

    assert.equal((await registry.getMostRecent('origin:example/project'))?.title, undefined);
  });

  test('returns the latest record for one repository', async () => {
    const registry = new SessionRegistry(new InMemoryStore());

    await registry.upsert({
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId: 'session-older',
      repositoryId: 'origin:example/project',
      gitRoot: '/work/project',
      cwd: '/work/project',
      createdAt: '2026-10-09T10:00:00.000Z',
      lastActiveAt: '2026-10-09T10:00:00.000Z',
      resumeState: 'unknown'
    });
    await registry.upsert({
      schemaVersion: 1,
      agentKind: 'hermes',
      sessionId: 'session-newer',
      repositoryId: 'origin:example/project',
      gitRoot: '/work/project',
      cwd: '/work/project',
      createdAt: '2026-10-09T11:00:00.000Z',
      lastActiveAt: '2026-10-09T12:00:00.000Z',
      resumeState: 'resumable'
    });

    assert.equal((await registry.getMostRecent('origin:example/project'))?.sessionId, 'session-newer');
  });
});
