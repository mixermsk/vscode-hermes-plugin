import { readFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import type { SubagentSnapshot } from '../domain/Subagent';

export type ChatPromptHandler = (text: string) => Promise<void>;
export type ChatCancelHandler = () => Promise<void>;
export type ChatConnectionHandler = () => Promise<void>;
export type ChatLocationHandler = (location: ChatToolLocation) => Promise<void>;

export interface ChatMessage {
  role: 'user' | 'agent' | 'error';
  text: string;
}

export interface ChatToolContent {
  type: 'text' | 'diff' | 'terminal';
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

export interface ChatToolLocation {
  path: string;
  line?: number;
}

export interface ChatTool {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
  status?: string;
  content?: readonly ChatToolContent[];
  locations?: readonly ChatToolLocation[];
}

export interface ChatSubagentTrackingStatus {
  kind: 'connected' | 'unavailable' | 'incompatible' | 'unauthorized';
  message: string;
}

export type ChatTranscriptEntry = ChatMessage | ChatTool;

export interface ChatViewAssets {
  mediaUri: vscode.Uri;
  templateUri: vscode.Uri;
  stylesheetUri: vscode.Uri;
  markedUri: vscode.Uri;
  domPurifyUri: vscode.Uri;
  scriptUri: vscode.Uri;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hermesGateway.chat';
  private view: vscode.WebviewView | undefined;
  private promptHandler: ChatPromptHandler | undefined;
  private cancelHandler: ChatCancelHandler | undefined;
  private connectionHandler: ChatConnectionHandler | undefined;
  private locationHandler: ChatLocationHandler | undefined;
  private sessionId: string | undefined;
  private sessionTitle: string | undefined;
  private subagentTracking: ChatSubagentTrackingStatus | undefined;
  private subagents: readonly SubagentSnapshot[] = [];
  private promptRunning = false;
  private readonly entries: ChatTranscriptEntry[] = [];
  private activity: string | undefined;
  private activityPosted = false;
  private readonly activeTools = new Map<string, string>();
  private readonly tools = new Map<string, ChatTool>();

  public constructor(private readonly assets: ChatViewAssets) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.assets.mediaUri]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isOpenLocationMessage(message)) {
        await this.locationHandler?.(message);
        return;
      }

      if (isCancelMessage(message)) {
        if (!this.promptRunning || this.cancelHandler === undefined) {
          return;
        }
        try {
          await this.cancelHandler();
          this.setActivity('Cancelling…');
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          await view.webview.postMessage({ type: 'cancel-error', text });
        }
        return;
      }
      if (!isPromptMessage(message)) {
        return;
      }
      const handler = this.promptHandler;
      if (handler === undefined) {
        await view.webview.postMessage({ type: 'error', text: 'Hermes is not connected. Reopen the chat and try again.' });
        return;
      }
      try {
        this.promptRunning = true;
        this.setActivity('Working…');
        this.appendMessage('user', message.text);
        await handler(message.text);
        this.clearActivity();
        await view.webview.postMessage({ type: 'ready' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.clearActivity();
        await view.webview.postMessage({ type: 'error', text });
      } finally {
        this.promptRunning = false;
      }
    });
    this.postState();
    void this.connect();
  }

  public setConnectionHandler(handler: ChatConnectionHandler): void {
    this.connectionHandler = handler;
  }

  public setCancelHandler(handler: ChatCancelHandler): void {
    this.cancelHandler = handler;
  }

  public setLocationHandler(handler: ChatLocationHandler): void {
    this.locationHandler = handler;
  }

  public setSession(sessionId: string, handler: ChatPromptHandler, title?: string): void {
    this.sessionId = sessionId;
    this.sessionTitle = title;
    this.promptHandler = handler;
    this.postState();
  }

  public setSubagentTrackingStatus(status: ChatSubagentTrackingStatus | undefined): void {
    this.subagentTracking = status;
    void this.view?.webview.postMessage({ type: 'subagent-tracking', status });
  }

  public setSubagents(subagents: readonly SubagentSnapshot[]): void {
    this.subagents = subagents.map((subagent) => ({ ...subagent }));
    void this.view?.webview.postMessage({ type: 'subagents', subagents: this.subagents });
  }

  public setSessionTitle(sessionId: string, title: string | undefined): void {
    if (this.sessionId !== sessionId) {
      return;
    }
    this.sessionTitle = title;
    this.postState();
  }

  public setDisconnected(message: string): void {
    this.sessionId = undefined;
    this.sessionTitle = undefined;
    this.promptHandler = undefined;
    this.subagentTracking = undefined;
    this.subagents = [];
    this.promptRunning = false;
    this.entries.length = 0;
    this.tools.clear();
    this.clearActivity();
    void this.view?.webview.postMessage({ type: 'disconnected', text: message });
  }

  public setThinking(): void {
    this.activity = 'Thinking…';
    this.postActivity();
  }

  public startTool(tool: ChatTool): void {
    this.tools.set(tool.toolCallId, tool);
    this.entries.push(tool);
    if (tool.status === 'completed' || tool.status === 'failed') {
      this.activeTools.delete(tool.toolCallId);
    } else {
      this.activeTools.set(tool.toolCallId, tool.title);
    }
    this.postActivity();
    void this.view?.webview.postMessage({ type: 'tool', tool: cloneTool(tool) });
  }

  public updateTool(toolCallId: string, update: Partial<ChatTool>): void {
    const tool = this.tools.get(toolCallId);
    if (tool === undefined) {
      return;
    }
    Object.assign(tool, update);
    this.activeTools.set(toolCallId, tool.title);
    if (tool.status === 'completed' || tool.status === 'failed') {
      this.activeTools.delete(toolCallId);
    }
    this.postActivity();
    void this.view?.webview.postMessage({ type: 'tool-update', tool: cloneTool(tool) });
  }

  public appendText(text: string): void {
    const previous = this.entries.at(-1);
    if (isChatMessage(previous) && previous.role === 'agent') {
      previous.text += text;
    } else {
      this.entries.push({ role: 'agent', text });
    }
    void this.view?.webview.postMessage({ type: 'text', text });
  }

  public appendUserText(text: string): void {
    const previous = this.entries.at(-1);
    if (isChatMessage(previous) && previous.role === 'user') {
      previous.text += text;
      return;
    }
    this.entries.push({ role: 'user', text });
  }

  private async connect(): Promise<void> {
    if (this.sessionId !== undefined || this.connectionHandler === undefined) {
      return;
    }
    try {
      await this.connectionHandler();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.view?.webview.postMessage({ type: 'error', text });
    }
  }

  private appendMessage(role: ChatMessage['role'], text: string): void {
    this.entries.push({ role, text });
    void this.view?.webview.postMessage({ type: 'message', role, text });
  }

  private setActivity(text: string): void {
    this.activity = text;
    this.postActivity();
  }

  private clearActivity(): void {
    this.activity = undefined;
    this.activeTools.clear();
    this.postActivity();
  }

  private postActivity(): void {
    const tools = [...this.activeTools.values()];
    const text = tools.length === 0
      ? this.activity
      : `Running: ${tools[0]}${tools.length === 1 ? '' : ` (+${tools.length - 1})`}`;
    if (text === undefined && !this.activityPosted) {
      return;
    }
    this.activityPosted = text !== undefined;
    void this.view?.webview.postMessage({ type: 'activity', text });
  }

  private postState(): void {
    if (this.sessionId === undefined) {
      return;
    }
    void this.view?.webview.postMessage({
      type: 'restore',
      sessionId: this.sessionId,
      title: this.sessionTitle,
      ...(this.subagentTracking === undefined ? {} : { subagentTracking: this.subagentTracking }),
      subagents: this.subagents.map((subagent) => ({ ...subagent })),
      entries: this.entries.map((entry) => isChatMessage(entry) ? { ...entry } : cloneTool(entry))
    });
    this.postActivity();
  }

  private html(webview: vscode.Webview): string {
    const template = readFileSync(this.assets.templateUri.fsPath, 'utf8');

    return renderChatHtml(template, {
      cspSource: webview.cspSource,
      stylesheetUri: webview.asWebviewUri(this.assets.stylesheetUri).toString(),
      markedUri: webview.asWebviewUri(this.assets.markedUri).toString(),
      domPurifyUri: webview.asWebviewUri(this.assets.domPurifyUri).toString(),
      scriptUri: webview.asWebviewUri(this.assets.scriptUri).toString()
    });
  }
}

function isChatMessage(entry: ChatTranscriptEntry | undefined): entry is ChatMessage {
  return entry !== undefined && 'role' in entry;
}

function cloneTool(tool: ChatTool): ChatTool {
  return {
    ...tool,
    ...(tool.content === undefined ? {} : { content: tool.content.map((content) => ({ ...content })) }),
    ...(tool.locations === undefined ? {} : { locations: tool.locations.map((location) => ({ ...location })) })
  };
}

export function renderChatHtml(template: string, resources: ChatWebviewResources): string {
  return template
    .replaceAll('{{cspSource}}', resources.cspSource)
    .replace('{{stylesheetUri}}', resources.stylesheetUri)
    .replace('{{markedUri}}', resources.markedUri)
    .replace('{{domPurifyUri}}', resources.domPurifyUri)
    .replace('{{scriptUri}}', resources.scriptUri);
}

export interface ChatWebviewResources {
  cspSource: string;
  stylesheetUri: string;
  markedUri: string;
  domPurifyUri: string;
  scriptUri: string;
}

function isPromptMessage(value: unknown): value is { type: 'prompt'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'prompt' && typeof (value as { text?: unknown }).text === 'string';
}

function isOpenLocationMessage(value: unknown): value is ChatToolLocation & { type: 'open-location' } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'open-location'
    && typeof (value as { path?: unknown }).path === 'string'
    && ((value as { line?: unknown }).line === undefined || typeof (value as { line?: unknown }).line === 'number');
}

function isCancelMessage(value: unknown): value is { type: 'cancel' } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'cancel';
}
