import * as assert from 'node:assert/strict';
import { HermesGatewayClient } from '../../gateway/HermesGatewayClient';
import type { GatewayConnection } from '../../gateway/GatewayConnectionFactory';

class FakeGatewayConnection implements GatewayConnection {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public modelOptions: unknown = { providers: [], model: '', provider: '' };
  public resumeMessages: unknown = [];
  public mutateResult: ((payload: Record<string, unknown>) => unknown) | undefined;
  public slashResult: unknown = { output: 'Command completed.' };
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
      return { session_id: params.session_id, revision: 3, execution_generation: 1, messages: this.resumeMessages };
    }
    if (method === 'session.mutate') {
      const payload = typeof params.payload === 'object' && params.payload !== null ? (params.payload as Record<string, unknown>) : {};
      if (this.mutateResult !== undefined) {
        return this.mutateResult(payload);
      }
      return { session_id: params.session_id, operation: 'model', model: payload.model, provider: payload.provider ?? '' };
    }
    if (method === 'slash.exec') {
      return this.slashResult;
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
    assert.deepEqual(connection.calls.slice(0, 3), [
      { method: 'runtime.describe', params: {} },
      { method: 'gateway.capabilities', params: {} },
      {
        method: 'session.create',
        params: { source: 'cli', cwd: '/work/project', cwd_explicit: true }
      }
    ]);
    assert.deepEqual(
      {
        method: connection.calls[3].method,
        session_id: connection.calls[3].params.session_id,
        text: connection.calls[3].params.text
      },
      { method: 'prompt.submit', session_id: 'session-1', text: 'Inspect the repository' }
    );
    assert.match(String(connection.calls[3].params.input_id), /^vscode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

  test('executes approval commands outside the prompt submission path', async () => {
    const connection = new FakeGatewayConnection();
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();
    await client.createSession('/work/project');

    connection.slashResult = { type: 'send', message: 'Continue after approval.' };
    assert.deepEqual(await client.executeSlashCommand('session-1', '/approve'), { prompt: 'Continue after approval.' });
    assert.deepEqual(connection.calls.at(-1), {
      method: 'slash.exec',
      params: { session_id: 'session-1', command: '/approve' }
    });
  });

  test('branches a session with fresh revision and generation fences', async () => {
    const connection = new FakeGatewayConnection();
    connection.mutateResult = () => ({ branched_session_id: 'branch-1' });
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();
    await client.createSession('/work/project');

    assert.equal(await client.branchSession('session-1', 'Investigate alternative'), 'branch-1');
    const branchCall = connection.calls.at(-1);
    assert.equal(branchCall?.method, 'session.mutate');
    assert.deepEqual(
      {
        session_id: branchCall?.params.session_id,
        expected_revision: branchCall?.params.expected_revision,
        expected_generation: branchCall?.params.expected_generation,
        operation: branchCall?.params.operation,
        payload: branchCall?.params.payload
      },
      {
        session_id: 'session-1',
        expected_revision: 3,
        expected_generation: 1,
        operation: 'branch',
        payload: { title: 'Investigate alternative' }
      }
    );
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
    const modelCall = connection.calls.at(-1);
    assert.equal(modelCall?.method, 'session.mutate');
    assert.deepEqual(
      {
        session_id: modelCall?.params.session_id,
        expected_revision: modelCall?.params.expected_revision,
        expected_generation: modelCall?.params.expected_generation,
        operation: modelCall?.params.operation,
        payload: modelCall?.params.payload
      },
      {
        session_id: 'session-1',
        expected_revision: 3,
        expected_generation: 1,
        operation: 'model',
        payload: { model: 'claude-4.5', provider: 'anthropic' }
      }
    );
    assert.match(String(modelCall?.params.request_id), /^vscode-model-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

    const reasoningCall = connection.calls.at(-1);
    assert.equal(reasoningCall?.method, 'session.mutate');
    assert.deepEqual(
      {
        session_id: reasoningCall?.params.session_id,
        expected_revision: reasoningCall?.params.expected_revision,
        expected_generation: reasoningCall?.params.expected_generation,
        operation: reasoningCall?.params.operation,
        payload: reasoningCall?.params.payload
      },
      {
        session_id: 'session-1',
        expected_revision: 3,
        expected_generation: 1,
        operation: 'reasoning',
        payload: { effort: 'high' }
      }
    );
    assert.match(String(reasoningCall?.params.request_id), /^vscode-reasoning-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('replays resumed transcript messages from the gateway content field', async () => {
    const connection = new FakeGatewayConnection();
    connection.resumeMessages = [
      { role: 'user', content: 'Sent from hermes-agent', row_id: 1 },
      { role: 'assistant', content: 'Replying to it', row_id: 2 }
    ];
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();

    assert.deepEqual(await client.resumeSession('session-1'), {
      sessionId: 'session-1',
      messages: [
        { role: 'user', text: 'Sent from hermes-agent' },
        { role: 'assistant', text: 'Replying to it' }
      ]
    });
  });

  test('collapses a delegation into a single spoiler entry and drops other tool rows', async () => {
    const connection = new FakeGatewayConnection();
    connection.resumeMessages = [
      { role: 'user', content: 'Do the delegated work', row_id: 1 },
      { role: 'tool', tool_name: 'delegate_task', content: '{"status":"dispatched","delegation_id":"deleg_abc","goals":["Return exactly the phrase","Also verify it"],"count":2}', row_id: 2 },
      { role: 'tool', tool_name: 'read', content: 'file contents', row_id: 3 },
      { role: 'assistant', content: 'Waiting for the subagent', row_id: 4 },
      { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE]', display_kind: 'async_delegation_complete', message_id: ['async_delegation', 'deleg_abc', ''], display_metadata: { display_text: 'Subagent Task Completed: Return exactly the phrase' }, row_id: 5 },
      { role: 'assistant', content: 'delegated smoke test passed', row_id: 6 }
    ];
    const client = new HermesGatewayClient({ async create() { return connection; } });

    await client.connect();

    assert.deepEqual((await client.resumeSession('session-1')).messages, [
      { role: 'user', text: 'Do the delegated work' },
      {
        role: 'delegation',
        subagentId: 'delegation:deleg_abc',
        title: 'Delegated task',
        status: 'completed',
        summary: 'Completed',
        details: '• Return exactly the phrase\n• Also verify it\n\nSubagent Task Completed: Return exactly the phrase'
      },
      { role: 'assistant', text: 'Waiting for the subagent' },
      { role: 'assistant', text: 'delegated smoke test passed' }
    ]);
  });
});
