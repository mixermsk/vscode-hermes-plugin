import type { GatewayConnection, GatewayConnectionFactory } from './GatewayConnectionFactory';

interface Subscription {
  dispose(): void;
}

export interface GatewayTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface GatewaySession {
  sessionId: string;
  title?: string;
  messages: readonly GatewayTranscriptMessage[];
}

export interface GatewayPromptEvent {
  sessionId: string;
  type: 'message.delta' | 'message.complete' | 'thinking.delta' | 'reasoning.delta' | 'status.update';
  text?: string;
}

export interface GatewaySubagentEvent {
  sessionId: string;
  type: string;
  payload: unknown;
}

export interface GatewayApprovalEvent {
  sessionId: string;
  type: 'approval.request' | 'approval.cancelled';
}

export type GatewayEventListener = (event: GatewayPromptEvent | GatewaySubagentEvent | GatewayApprovalEvent) => void;

export interface GatewayModelProvider {
  slug: string;
  name: string;
  models: readonly string[];
  isCurrent?: boolean;
}

export interface GatewayModelOptions {
  providers: readonly GatewayModelProvider[];
  model: string;
  provider: string;
}

export type GatewayModelSwitchOutcome =
  | { kind: 'applied'; model: string; provider: string }
  | { kind: 'noop'; model: string }
  | { kind: 'confirmation_required'; confirm: string; model: string; provider: string; message: string };

export class HermesGatewayClient {
  private connection: GatewayConnection | undefined;
  private eventSubscription: Subscription | undefined;
  private readonly listeners = new Set<GatewayEventListener>();
  private readonly completions = new Map<string, Deferred<void>>();
  private readonly executionGenerations = new Map<string, number>();
  private nextInputId = 1;
  private nextMutationId = 1;

  public constructor(private readonly connectionFactory: GatewayConnectionFactory) {}

  public async connect(): Promise<void> {
    if (this.connection !== undefined) {
      return;
    }
    const connection = await this.connectionFactory.create();
    try {
      const descriptor = await connection.rpc('runtime.describe');
      if (!isGatewayCompatible(descriptor)) {
        throw new Error('Local Hermes Gateway does not support direct Gateway sessions.');
      }
      const capabilities = await connection.rpc('gateway.capabilities');
      if (!isRecord(capabilities) || capabilities.per_session_exclusive_submit !== true) {
        throw new Error('Local Hermes Gateway does not support exclusive prompt submission.');
      }
      const eventSubscription = connection.subscribe((event) => this.handleEvent(event));
      this.connection = connection;
      this.eventSubscription = eventSubscription;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  public onEvent(listener: GatewayEventListener): Subscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async createSession(cwd: string): Promise<GatewaySession> {
    return this.parseSession(await this.rpc('session.create', {
      source: 'cli',
      cwd,
      cwd_explicit: true
    }));
  }

  public async resumeSession(sessionId: string): Promise<GatewaySession> {
    return this.parseSession(await this.rpc('session.resume', { session_id: sessionId }));
  }


  public async submitPrompt(sessionId: string, text: string): Promise<void> {
    if (this.completions.has(sessionId)) {
      throw new Error('Hermes is already processing a prompt for this session.');
    }
    const completion = deferred<void>();
    this.completions.set(sessionId, completion);
    try {
      const result = await this.rpc('prompt.submit', {
        session_id: sessionId,
        input_id: `vscode-${this.nextInputId++}`,
        text
      });
      if (!isRecord(result) || (result.status !== 'streaming' && result.status !== 'queued')) {
        throw new Error('Local Hermes Gateway did not accept the prompt.');
      }
      if (typeof result.execution_generation === 'number' && Number.isInteger(result.execution_generation)) {
        this.executionGenerations.set(sessionId, result.execution_generation);
      }
      await completion.promise;
    } finally {
      this.completions.delete(sessionId);
      this.executionGenerations.delete(sessionId);
    }
  }

  public async interrupt(sessionId: string): Promise<void> {
    const executionGeneration = this.executionGenerations.get(sessionId);
    await this.rpc('session.interrupt', {
      session_id: sessionId,
      ...(executionGeneration === undefined ? {} : { execution_generation: executionGeneration })
    });
  }

  public async getSubagents(sessionId: string): Promise<unknown> {
    return this.rpc('subagent.list', { session_id: sessionId });
  }

  public async pendingApprovals(sessionId: string): Promise<readonly GatewayApproval[]> {
    const result = await this.rpc('approval.pending', { session_id: sessionId });
    if (!isRecord(result) || !Array.isArray(result.approvals)) {
      return [];
    }
    return result.approvals.flatMap((approval): GatewayApproval[] => {
      if (!isRecord(approval) || typeof approval.request_id !== 'string' || approval.request_id.length === 0 || !Array.isArray(approval.choices)) {
        return [];
      }
      const choices = approval.choices.filter((choice): choice is string => typeof choice === 'string');
      return choices.length === 0 ? [] : [{
        requestId: approval.request_id,
        choices,
        ...(typeof approval.description === 'string' ? { description: approval.description } : {}),
        ...(typeof approval.tool_name === 'string' ? { toolName: approval.tool_name } : {})
      }];
    });
  }

  public async respondApproval(sessionId: string, requestId: string, choice: string): Promise<void> {
    await this.rpc('approval.respond', { session_id: sessionId, request_id: requestId, choice });
  }

  public async getModelOptions(sessionId: string): Promise<GatewayModelOptions> {
    return parseModelOptions(await this.rpc('model.options', { session_id: sessionId }));
  }

  public async setModel(sessionId: string, model: string, provider: string | undefined, confirm?: string): Promise<GatewayModelSwitchOutcome> {
    const { revision, executionGeneration } = await this.sessionFences(sessionId);
    const payload: Record<string, unknown> = { model };
    if (provider !== undefined && provider !== '') {
      payload.provider = provider;
    }
    if (confirm !== undefined) {
      payload.confirm = confirm;
    }
    const result = await this.rpc('session.mutate', {
      session_id: sessionId,
      request_id: `vscode-model-${this.nextMutationId++}`,
      expected_revision: revision,
      expected_generation: executionGeneration,
      operation: 'model',
      payload
    });
    return parseModelSwitchOutcome(result);
  }

  public async getReasoning(sessionId: string): Promise<string> {
    const result = await this.rpc('config.get', { session_id: sessionId, key: 'reasoning' });
    if (!isRecord(result) || typeof result.value !== 'string') {
      throw new Error('Local Hermes Gateway did not report a reasoning level.');
    }
    return result.value;
  }

  public async setReasoning(sessionId: string, effort: string): Promise<void> {
    const { revision, executionGeneration } = await this.sessionFences(sessionId);
    await this.rpc('session.mutate', {
      session_id: sessionId,
      request_id: `vscode-reasoning-${this.nextMutationId++}`,
      expected_revision: revision,
      expected_generation: executionGeneration,
      operation: 'reasoning',
      payload: { effort }
    });
  }

  private async sessionFences(sessionId: string): Promise<{ revision: number; executionGeneration: number }> {
    const result = await this.rpc('session.resume', { session_id: sessionId });
    if (!isRecord(result) || typeof result.revision !== 'number' || typeof result.execution_generation !== 'number') {
      throw new Error('Local Hermes Gateway did not report a session revision.');
    }
    return { revision: result.revision, executionGeneration: result.execution_generation };
  }

  public dispose(): void {
    for (const completion of this.completions.values()) {
      completion.resolve();
    }
    this.completions.clear();
    this.executionGenerations.clear();
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.listeners.clear();
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new Error('Local Hermes Gateway is not connected.');
    }
    return connection.rpc(method, params);
  }

  private parseSession(value: unknown): GatewaySession {
    if (!isRecord(value) || typeof value.session_id !== 'string' || value.session_id.length === 0) {
      throw new Error('Local Hermes Gateway returned an invalid session.');
    }
    const info = isRecord(value.info) ? value.info : undefined;
    return {
      sessionId: value.session_id,
      ...(typeof info?.title === 'string' ? { title: info.title } : {}),
      messages: parseTranscript(value.messages)
    };
  }

  private handleEvent(value: unknown): void {
    if (!isRecord(value) || value.method !== 'event' || !isRecord(value.params) || typeof value.params.session_id !== 'string' || typeof value.params.type !== 'string') {
      return;
    }
    const { session_id: sessionId, type, payload } = value.params;
    if (type === 'session.info' && this.completions.has(sessionId) && isRecord(payload)
      && typeof payload.execution_generation === 'number' && Number.isInteger(payload.execution_generation)) {
      this.executionGenerations.set(sessionId, payload.execution_generation);
    }
    const promptEvent = parsePromptEvent(sessionId, type, payload);
    if (promptEvent !== undefined) {
      if (promptEvent.type === 'message.complete') {
        this.completions.get(sessionId)?.resolve();
      }
      for (const listener of this.listeners) {
        listener(promptEvent);
      }
      return;
    }
    if (type.startsWith('subagent.')) {
      for (const listener of this.listeners) {
        listener({ sessionId, type, payload });
      }
      return;
    }
    if (type === 'approval.request' || type === 'approval.cancelled') {
      for (const listener of this.listeners) {
        listener({ sessionId, type });
      }
    }
  }
}

export interface GatewayApproval {
  requestId: string;
  choices: readonly string[];
  description?: string;
  toolName?: string;
}

function isGatewayCompatible(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.capabilities)
    && value.capabilities.includes('durable-admission-v1')
    && value.capabilities.includes('session-transcript-v1')
    && isRecord(value.session_create)
    && Array.isArray(value.session_create.sources)
    && value.session_create.sources.includes('cli');
}

function parseTranscript(value: unknown): readonly GatewayTranscriptMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): GatewayTranscriptMessage[] => {
    if (!isRecord(entry) || typeof entry.text !== 'string') {
      return [];
    }
    if (entry.role === 'user') {
      return [{ role: 'user', text: entry.text }];
    }
    if (entry.role === 'assistant') {
      return [{ role: 'assistant', text: entry.text }];
    }
    return [];
  });
}

function parsePromptEvent(sessionId: string, type: string, payload: unknown): GatewayPromptEvent | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (type === 'message.delta' && typeof payload.text === 'string') {
    return { sessionId, type, text: payload.text };
  }
  if (type === 'message.complete') {
    return { sessionId, type, ...(typeof payload.text === 'string' ? { text: payload.text } : {}) };
  }
  if ((type === 'thinking.delta' || type === 'reasoning.delta' || type === 'status.update') && typeof payload.text === 'string') {
    return { sessionId, type, text: payload.text };
  }
  return undefined;
}

function parseModelOptions(value: unknown): GatewayModelOptions {
  if (!isRecord(value)) {
    throw new Error('Local Hermes Gateway returned no model options.');
  }
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((row): GatewayModelProvider[] => {
      if (!isRecord(row) || typeof row.slug !== 'string') {
        return [];
      }
      const models = Array.isArray(row.models)
        ? row.models.filter((model): model is string => typeof model === 'string' && model.length > 0)
        : [];
      if (models.length === 0) {
        return [];
      }
      return [{
        slug: row.slug,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.slug,
        models,
        ...(row.is_current === true ? { isCurrent: true } : {})
      }];
    })
    : [];
  return {
    providers,
    model: typeof value.model === 'string' ? value.model : '',
    provider: typeof value.provider === 'string' ? value.provider : ''
  };
}

function parseModelSwitchOutcome(value: unknown): GatewayModelSwitchOutcome {
  if (!isRecord(value)) {
    throw new Error('Local Hermes Gateway rejected the model switch.');
  }
  if (value.status === 'confirmation_required' && typeof value.confirm === 'string' && typeof value.target_model === 'string') {
    return {
      kind: 'confirmation_required',
      confirm: value.confirm,
      model: value.target_model,
      provider: typeof value.target_provider === 'string' ? value.target_provider : '',
      message: typeof value.confirm_message === 'string' ? value.confirm_message : 'The model switch needs confirmation.'
    };
  }
  if (value.status === 'noop' && typeof value.model === 'string') {
    return { kind: 'noop', model: value.model };
  }
  if (typeof value.model === 'string') {
    return { kind: 'applied', model: value.model, provider: typeof value.provider === 'string' ? value.provider : '' };
  }
  throw new Error('Local Hermes Gateway returned an unrecognized model switch result.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
