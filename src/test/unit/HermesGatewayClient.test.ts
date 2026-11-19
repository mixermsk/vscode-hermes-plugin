import * as assert from 'node:assert/strict';
import { HermesGatewayClient } from '../../gateway/HermesGatewayClient';
import type { GatewayConnection } from '../../gateway/GatewayConnectionFactory';

class FakeGatewayConnection implements GatewayConnection {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public modelOptions: unknown = { providers: [], model: '', provider: '' };
  public mutateResult: ((payload: Record<string, unknown>) => unknown) | undefined;
  private listener: ((event: unknown) => void) | undefined;

  public async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'runtime.describe') {
      return {
        capabilities: ['durable-admission-v1', 'session-transcript-v1'],
        session_create: { sources: ['cli'] }
      };
    }
    if (method === 'gateway.capabilities') {
      return { per_session_exclusive_submit: true };
    }
    if (method === 'session.create') {
      return { session_id: 'session-1', messages: [{ role: 'user', text: 'Earlier prompt' }], info: { title: 'Gateway chat' } };
    }
    if (method === 'prompt.submit') {
      return { status: 'queued' };
    }
    if (method === 'session.interrupt') {
      return { status: 'interrupted' };
    }
    if (method === 'model.options') {
      return this.modelOptions;
    }
    if (method === 'config.get') {
      return { value: 'medium', display: 'show' };
    }
    if (method === 'session.resume') {
      return { session_id: params.session_id, revision: 3, execution_generation: 1, messages: [] };
    }
    if (method === 'session.mutate') {
      const payload = typeof params.payload === 'object' && params.payload !== null ? (params.payload as Record<string, unknown>) : {};
      if (this.mutateResult !== undefined) {
        return this.mutateResult(payload);
      }
      return { session_id: params.session_id, operation: 'model', model: payload.model, provider: payload.provider ?? '' };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  }

  public subscribe(listener: (event: unknown) => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => { this.listener = undefined; } };
  }

  public close(): void {}

  public emit(event: unknown): void { this.listener?.(event); }
}

suite('HermesGatewayClient', () => {
  test('creates a direct cli Gateway session and completes a prompt from lifecycle events', async () => {
    const connection = new FakeGatewayConnection();
    const client = new HermesGatewayClient({ async create() { return connection; } });
    const events: unknown[] = [];

    await client.connect();
    client.onEvent((event) => events.push(event));
    const session = await client.createSession('/work/project');
    const submit = client.submitPrompt('session-1', 'Inspect the repository');
    await new Promise((resolve) => setImmediate(resolve));
    connection.emit({ method: 'event', params: { session_id: 'session-1', type: 'message.delta', payload: { text: 'Done' } } });
    connection.emit({ method: 'event', params: { session_id: 'session-1', type: 'message.complete', payload: { text: 'Done', status: 'complete' } } });
    await submit;

    assert.deepEqual(session, {
      sessionId: 'session-1',
      title: 'Gateway chat',
      messages: [{ role: 'user', text: 'Earlier prompt' }]
    });
    assert.deepEqual(connection.calls, [
      { method: 'runtime.describe', params: {} },
      { method: 'gateway.capabilities', params: {} },
      {
        method: 'session.create',
        params: { source: 'cli', cwd: '/work/project', cwd_explicit: true }
      },
      {
        method: 'prompt.submit',
        params: {
          session_id: 'session-1',
          input_id: 'vscode-1',
          text: 'Inspect the repository'
        }
      }
    ]);
    assert.deepEqual(events, [
      { sessionId: 'session-1', type: 'message.delta', text: 'Done' },
      { sessionId: 'session-1', type: 'message.complete', text: 'Done' }
    ]);
  });

  test('refuses a Gateway that does not expose direct cli session creation', async () => {
    const connection: GatewayConnection = {
      async rpc(method) {
        if (method === 'runtime.describe') {
          return { capabilities: ['durable-admission-v1', 'session-transcript-v1'], session_create: { sources: ['tui'] } };
        }
        throw new Error('not used');
      },
      subscribe() { return { dispose() {} }; },
      close() {}
    };
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await assert.rejects(() => client.connect(), /direct Gateway sessions/);
  });

  test('can reconnect after event subscription setup fails', async () => {
    const failedConnection: GatewayConnection = {
      async rpc(method) {
        if (method === 'runtime.describe') {
          return {
            capabilities: ['durable-admission-v1', 'session-transcript-v1'],
            session_create: { sources: ['cli'] }
          };
        }
        if (method === 'gateway.capabilities') {
          return { per_session_exclusive_submit: true };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
      subscribe() { throw new Error('subscription failed'); },
      close() {}
    };
    const connectedConnection = new FakeGatewayConnection();
    const connections = [failedConnection, connectedConnection];
    const client = new HermesGatewayClient({
      async create() {
        const connection = connections.shift();
        assert.ok(connection, 'expected a Gateway connection');
        return connection;
      }
    });

    await assert.rejects(() => client.connect(), /subscription failed/);
    await client.connect();
    await client.createSession('/work/project');

    assert.equal(connectedConnection.calls.at(-1)?.method, 'session.create');
  });
  test('interrupts the active prompt with the generation returned by Gateway', async () => {
    const connection = new FakeGatewayConnection();
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();
    await client.createSession('/work/project');
    const prompt = client.submitPrompt('session-1', 'Stop this prompt');
    await new Promise((resolve) => setImmediate(resolve));
    connection.emit({ method: 'event', params: { session_id: 'session-1', type: 'session.info', payload: { execution_generation: 7, running: true } } });
    await client.interrupt('session-1');
    connection.emit({ method: 'event', params: { session_id: 'session-1', type: 'message.complete', payload: {} } });
    await prompt;

    assert.deepEqual(connection.calls.at(-1), {
      method: 'session.interrupt',
      params: { session_id: 'session-1', execution_generation: 7 }
    });
  });

  test('lists the session model options and switches to another model', async () => {
    const connection = new FakeGatewayConnection();
    connection.modelOptions = {
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      providers: [
        { slug: 'deepseek', name: 'DeepSeek', is_current: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'], total_models: 2 },
        { slug: 'anthropic', name: 'Anthropic', models: ['claude-4.5'], total_models: 1 }
      ]
    };
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();
    await client.createSession('/work/project');

    assert.deepEqual(await client.getModelOptions('session-1'), {
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      providers: [
        { slug: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], isCurrent: true },
        { slug: 'anthropic', name: 'Anthropic', models: ['claude-4.5'] }
      ]
    });

    const outcome = await client.setModel('session-1', 'claude-4.5', 'anthropic');

    assert.deepEqual(outcome, { kind: 'applied', model: 'claude-4.5', provider: 'anthropic' });
    assert.deepEqual(connection.calls.at(-1), {
      method: 'session.mutate',
      params: {
        session_id: 'session-1',
        request_id: 'vscode-model-1',
        expected_revision: 3,
        expected_generation: 1,
        operation: 'model',
        payload: { model: 'claude-4.5', provider: 'anthropic' }
      }
    });
  });

  test('surfaces a confirmation-required model switch without applying it', async () => {
    const connection = new FakeGatewayConnection();
    connection.modelOptions = { providers: [], model: '', provider: '' };
    const client = new HermesGatewayClient({ async create() { return connection; } });
    connection.mutateResult = (payload: Record<string, unknown>) => ({
      status: 'confirmation_required',
      confirm: 'bound-token',
      target_model: payload.model,
      target_provider: payload.provider ?? '',
      confirm_message: 'Switching may exceed your plan.'
    });

    await client.connect();
    await client.createSession('/work/project');
    const outcome = await client.setModel('session-1', 'gpt-5', 'openai');

    assert.deepEqual(outcome, {
      kind: 'confirmation_required',
      confirm: 'bound-token',
      model: 'gpt-5',
      provider: 'openai',
      message: 'Switching may exceed your plan.'
    });
  });

  test('reads and sets the session reasoning level', async () => {
    const connection = new FakeGatewayConnection();
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();
    await client.createSession('/work/project');

    assert.equal(await client.getReasoning('session-1'), 'medium');

    await client.setReasoning('session-1', 'high');

    assert.deepEqual(connection.calls.at(-1), {
      method: 'session.mutate',
      params: {
        session_id: 'session-1',
        request_id: 'vscode-reasoning-1',
        expected_revision: 3,
        expected_generation: 1,
        operation: 'reasoning',
        payload: { effort: 'high' }
      }
    });
  });
});
