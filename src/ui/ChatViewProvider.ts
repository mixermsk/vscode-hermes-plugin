import { readFileSync } from 'node:fs';
import type * as vscode from 'vscode';

export type ChatPromptHandler = (text: string) => Promise<void>;
export type ChatConnectionHandler = () => Promise<void>;

export interface ChatMessage {
  role: 'user' | 'agent' | 'error';
  text: string;
}

export interface ChatViewAssets {
  mediaUri: vscode.Uri;
  templateUri: vscode.Uri;
  stylesheetUri: vscode.Uri;
  scriptUri: vscode.Uri;
}

export class ChatViewProvider {
  public static readonly viewType = 'hermesAcp.chat';
  private panel: vscode.WebviewPanel | undefined;
  private promptHandler: ChatPromptHandler | undefined;
  private connectionHandler: ChatConnectionHandler | undefined;
  private sessionId: string | undefined;
  private sessionTitle: string | undefined;
  private readonly messages: ChatMessage[] = [];

  public constructor(private readonly assets: ChatViewAssets) {}

  public open(createPanel: () => vscode.WebviewPanel): void {
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }

    const panel = createPanel();
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.assets.mediaUri]
    };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isPromptMessage(message) || this.promptHandler === undefined) {
        return;
      }
      try {
        this.appendMessage('user', message.text);
        await this.promptHandler(message.text);
        await panel.webview.postMessage({ type: 'ready' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await panel.webview.postMessage({ type: 'error', text });
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.postState();
    void this.connect();
  }

  public setConnectionHandler(handler: ChatConnectionHandler): void {
    this.connectionHandler = handler;
  }

  public setSession(sessionId: string, handler: ChatPromptHandler, title?: string): void {
    this.sessionId = sessionId;
    this.sessionTitle = title;
    this.promptHandler = handler;
    this.postState();
  }

  public setSessionTitle(sessionId: string, title: string | undefined): void {
    if (this.sessionId !== sessionId) {
      return;
    }
    this.sessionTitle = title;
    this.postState();
  }

  public appendText(text: string): void {
    const previous = this.messages.at(-1);
    if (previous?.role === 'agent') {
      previous.text += text;
    } else {
      this.messages.push({ role: 'agent', text });
    }
    void this.panel?.webview.postMessage({ type: 'text', text });
  }

  private async connect(): Promise<void> {
    if (this.sessionId !== undefined || this.connectionHandler === undefined) {
      return;
    }
    try {
      await this.connectionHandler();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.panel?.webview.postMessage({ type: 'error', text });
    }
  }

  private appendMessage(role: ChatMessage['role'], text: string): void {
    this.messages.push({ role, text });
    void this.panel?.webview.postMessage({ type: 'message', role, text });
  }

  private postState(): void {
    if (this.sessionId === undefined) {
      return;
    }
    void this.panel?.webview.postMessage({
      type: 'restore',
      sessionId: this.sessionId,
      title: this.sessionTitle,
      messages: this.messages
    });
  }

  private html(webview: vscode.Webview): string {
    const template = readFileSync(this.assets.templateUri.fsPath, 'utf8');

    return renderChatHtml(template, {
      cspSource: webview.cspSource,
      stylesheetUri: webview.asWebviewUri(this.assets.stylesheetUri).toString(),
      scriptUri: webview.asWebviewUri(this.assets.scriptUri).toString()
    });
  }
}

export function renderChatHtml(template: string, resources: ChatWebviewResources): string {
  return template
    .replaceAll('{{cspSource}}', resources.cspSource)
    .replace('{{stylesheetUri}}', resources.stylesheetUri)
    .replace('{{scriptUri}}', resources.scriptUri);
}

export interface ChatWebviewResources {
  cspSource: string;
  stylesheetUri: string;
  scriptUri: string;
}

function isPromptMessage(value: unknown): value is { type: 'prompt'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'prompt' && typeof (value as { text?: unknown }).text === 'string';
}
