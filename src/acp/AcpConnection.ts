import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpClientCallbacks } from './AcpClient';
import {
  AcpSessionController,
  type AcpAgentTransport,
  type AcpInitializeRequest,
  type AcpInitializeResult,
  type AcpListSessionsResult,
  type AcpSessionResult
} from './AcpSessionController';

export class AcpConnection implements AcpAgentTransport {
  private constructor(
    private readonly connection: acp.ClientConnection,
    private readonly agent: acp.ClientContext
  ) {}

  public static connect(process: ChildProcess, callbacks: AcpClientCallbacks): AcpSessionController {
    if (process.stdin === null || process.stdout === null) {
      throw new Error('Hermes ACP process must have piped stdin and stdout.');
    }

    const app = acp
      .client({ name: 'Hermes ACP for VS Code' })
      .onNotification(acp.methods.client.session.update, async (context) => callbacks.onSessionUpdate(context.params))
      .onRequest(acp.methods.client.session.requestPermission, (context) => callbacks.onPermissionRequest(context.params));
    const stream = acp.ndJsonStream(Writable.toWeb(process.stdin), Readable.toWeb(process.stdout));
    const connection = app.connect(stream);
    const transport = new AcpConnection(connection, connection.agent);

    return new AcpSessionController(transport, acp.PROTOCOL_VERSION);
  }

  public async initialize(params: AcpInitializeRequest): Promise<AcpInitializeResult> {
    const response = await this.agent.request<acp.InitializeResponse, acp.InitializeRequest>(
      acp.methods.agent.initialize,
      params
    );
    return {
      protocolVersion: response.protocolVersion,
      supportsSessionList: response.agentCapabilities?.sessionCapabilities?.list != null
    };
  }

  public async newSession(params: Readonly<{ cwd: string; mcpServers: readonly [] }>): Promise<AcpSessionResult> {
    const response = await this.agent.request(acp.methods.agent.session.new, {
      cwd: params.cwd,
      mcpServers: []
    });
    return { sessionId: response.sessionId };
  }

  public async resumeSession(
    params: Readonly<{ sessionId: string; cwd: string; mcpServers: readonly [] }>
  ): Promise<AcpSessionResult> {
    await this.agent.request(acp.methods.agent.session.resume, {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: []
    });
    return { sessionId: params.sessionId };
  }

  public async listSessions(params: Readonly<{ cwd: string; cursor?: string }>): Promise<AcpListSessionsResult> {
    const response = await this.agent.request(acp.methods.agent.session.list, {
      cwd: params.cwd,
      ...(params.cursor === undefined ? {} : { cursor: params.cursor })
    });
    return {
      sessions: response.sessions.map((session) => ({
        sessionId: session.sessionId,
        ...(session.title == null ? {} : { title: session.title })
      })),
      ...(response.nextCursor == null ? {} : { nextCursor: response.nextCursor })
    };
  }

  public async prompt(params: Readonly<{ sessionId: string; text: string }>): Promise<void> {
    await this.agent.request(acp.methods.agent.session.prompt, {
      sessionId: params.sessionId,
      prompt: [{ type: 'text', text: params.text }]
    });
  }

  public async cancel(params: Readonly<{ sessionId: string }>): Promise<void> {
    await this.agent.notify(acp.methods.agent.session.cancel, { sessionId: params.sessionId });
  }

  public close(): void {
    this.connection.close();
  }
}
