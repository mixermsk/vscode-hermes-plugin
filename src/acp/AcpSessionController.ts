export type AcpInitializeRequest = Readonly<{
  protocolVersion: number;
  clientCapabilities: Record<string, never>;
  clientInfo: Readonly<{ name: string; version: string }>;
}>;

export type AcpInitializeResult = Readonly<{
  protocolVersion: number;
}>;

export type AcpSessionResult = Readonly<{
  sessionId: string;
}>;

export interface AcpAgentTransport {
  initialize(params: AcpInitializeRequest): Promise<AcpInitializeResult>;
  newSession(params: Readonly<{ cwd: string; mcpServers: readonly [] }>): Promise<AcpSessionResult>;
  resumeSession(params: Readonly<{ sessionId: string; cwd: string; mcpServers: readonly [] }>): Promise<AcpSessionResult>;
  prompt(params: Readonly<{ sessionId: string; text: string }>): Promise<void>;
  cancel(params: Readonly<{ sessionId: string }>): Promise<void>;
  close(): void;
}

export class AcpSessionController {
  public constructor(
    private readonly transport: AcpAgentTransport,
    private readonly protocolVersion: number,
    private readonly clientVersion = '0.0.1'
  ) {}

  public initialize(): Promise<AcpInitializeResult> {
    return this.transport.initialize({
      protocolVersion: this.protocolVersion,
      clientCapabilities: {},
      clientInfo: { name: 'Hermes ACP for VS Code', version: this.clientVersion }
    });
  }

  public createSession(cwd: string): Promise<AcpSessionResult> {
    return this.transport.newSession({ cwd, mcpServers: [] });
  }

  public resumeSession(sessionId: string, cwd: string): Promise<AcpSessionResult> {
    return this.transport.resumeSession({ sessionId, cwd, mcpServers: [] });
  }

  public prompt(sessionId: string, text: string): Promise<void> {
    return this.transport.prompt({ sessionId, text });
  }

  public cancel(sessionId: string): Promise<void> {
    return this.transport.cancel({ sessionId });
  }

  public dispose(): void {
    this.transport.close();
  }
}
