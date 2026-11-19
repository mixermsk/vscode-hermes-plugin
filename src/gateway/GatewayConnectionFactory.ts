import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GatewaySubagentSubscription } from './GatewaySubagentSource';

const execFileAsync = promisify(execFile);
const GATEWAY_PROTOCOL = 'hermes-gateway-v1';
const GATEWAY_TICKET_PREFIX = 'hermes-gateway-ticket.';
const RPC_TIMEOUT_MS = 10_000;

export class GatewayConnectionError extends Error {
  public constructor(public readonly kind: 'unavailable' | 'incompatible' | 'unauthorized') {
    super(kind);
  }
}

export interface GatewayConnection {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): GatewaySubagentSubscription;
  close(): void;
}

export interface GatewayConnectionFactory {
  create(): Promise<GatewayConnection>;
}

export interface GatewayAttachRunner {
  attach(): Promise<unknown>;
}

export interface GatewayWebSocket {
  readonly protocol: string;
  onopen: (() => void) | null | undefined;
  onerror: (() => void) | null | undefined;
  onclose: (() => void) | null | undefined;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null | undefined;
  send(data: string): void;
  close(): void;
}

export type GatewayWebSocketFactory = (url: string, protocols: readonly string[]) => GatewayWebSocket;

export class HermesCliGatewayAttachRunner implements GatewayAttachRunner {
  public constructor(private readonly executable = 'hermes') {}

  public async attach(): Promise<unknown> {
    try {
      const result = await execFileAsync(this.executable, ['gateway', 'attach', '--json'], { encoding: 'utf8' });
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('Local Hermes Gateway is unavailable.');
    }
  }
}

export class LocalHermesGatewayConnectionFactory implements GatewayConnectionFactory {
  public constructor(
    private readonly attachRunner: GatewayAttachRunner = new HermesCliGatewayAttachRunner(),
    private readonly webSocketFactory: GatewayWebSocketFactory = createNodeWebSocket
  ) {}

  public async create(): Promise<GatewayConnection> {
    const attach = parseAttachResult(await this.attachRunner.attach());
    const socket = this.webSocketFactory(attach.url, attach.protocols);
    await waitForOpen(socket);
    if (socket.protocol !== GATEWAY_PROTOCOL) {
      socket.close();
      throw new Error('Local Hermes Gateway protocol is incompatible.');
    }
    return new JsonRpcGatewayConnection(socket);
  }
}

class JsonRpcGatewayConnection implements GatewayConnection {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: unknown) => void>();

  public constructor(private readonly socket: GatewayWebSocket) {
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => this.rejectPending();
    socket.onclose = () => this.rejectPending();
  }

  public rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Local Hermes Gateway request timed out.'));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Local Hermes Gateway request could not be sent.'));
      }
    });
  }

  public subscribe(listener: (event: unknown) => void): GatewaySubagentSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public close(): void {
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    this.rejectPending();
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame)) {
      return;
    }
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (isRecord(frame.error)) {
        pending.reject(new Error(`Local Hermes Gateway rejected the request: ${gatewayErrorMessage(frame.error)}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method === 'event') {
      for (const listener of this.listeners) {
        listener(frame);
      }
    }
  }

  private rejectPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error('Local Hermes Gateway disconnected.'));
    }
  }
}

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}>;

type ParsedAttach = Readonly<{ url: string; protocols: readonly string[] }>;

function parseAttachResult(value: unknown): ParsedAttach {
  if (!isRecord(value) || typeof value.url !== 'string' || value.protocol !== GATEWAY_PROTOCOL || !Array.isArray(value.protocols)) {
    throw new Error('Local Hermes Gateway attach response is incompatible.');
  }
  const protocols = value.protocols.filter((protocol): protocol is string => typeof protocol === 'string');
  if (protocols.length !== 2 || protocols[0] !== GATEWAY_PROTOCOL || !protocols[1].startsWith(GATEWAY_TICKET_PREFIX)) {
    throw new Error('Local Hermes Gateway attach response is incompatible.');
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error('Local Hermes Gateway attach response is incompatible.');
  }
  if (!isLocalGatewayUrl(url)) {
    throw new Error('Only a local Hermes Gateway is supported.');
  }
  return { url: url.toString(), protocols };
}

function isLocalGatewayUrl(url: URL): boolean {
  return (url.protocol === 'ws:' || url.protocol === 'wss:')
    && (url.hostname === 'localhost' || url.hostname === '::1' || url.hostname.startsWith('127.'));
}

function createNodeWebSocket(url: string, protocols: readonly string[]): GatewayWebSocket {
  if (typeof WebSocket === 'undefined') {
    throw new Error('This VS Code runtime does not provide WebSocket support.');
  }
  return new WebSocket(url, [...protocols]) as unknown as GatewayWebSocket;
}

function waitForOpen(socket: GatewayWebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local Hermes Gateway connection timed out.')), RPC_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Local Hermes Gateway connection failed.'));
    };
    socket.onclose = () => {
      clearTimeout(timer);
      reject(new Error('Local Hermes Gateway connection closed.'));
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function gatewayErrorMessage(error: Record<string, unknown>): string {
  if (typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  if (isRecord(error.data) && typeof error.data.reason === 'string' && error.data.reason !== '') {
    return error.data.reason;
  }
  return typeof error.code === 'number' ? `code ${error.code}` : 'unknown reason';
}
