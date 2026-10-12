import { readFileSync } from 'node:fs';
import type * as vscode from 'vscode';

export type ChatPromptHandler = (text: string) => Promise<void>;

export interface ChatViewAssets {
  mediaUri: vscode.Uri;
  templateUri: vscode.Uri;
  stylesheetUri: vscode.Uri;
  scriptUri: vscode.Uri;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hermesAcp.chat';
  private view: vscode.WebviewView | undefined;
  private promptHandler: ChatPromptHandler | undefined;

  public constructor(private readonly assets: ChatViewAssets) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.assets.mediaUri]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isPromptMessage(message) || this.promptHandler === undefined) {
        return;
      }
      try {
        await this.promptHandler(message.text);
        await view.webview.postMessage({ type: 'ready' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await view.webview.postMessage({ type: 'error', text });
      }
    });
  }

  public setSession(sessionId: string, handler: ChatPromptHandler): void {
    this.promptHandler = handler;
    void this.view?.webview.postMessage({ type: 'session', sessionId });
  }

  public appendText(text: string): void {
    void this.view?.webview.postMessage({ type: 'text', text });
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
