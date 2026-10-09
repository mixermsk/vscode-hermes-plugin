import type * as vscode from 'vscode';

export type ChatPromptHandler = (text: string) => Promise<void>;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hermesAcp.chat';
  private view: vscode.WebviewView | undefined;
  private promptHandler: ChatPromptHandler | undefined;

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isPromptMessage(message) || this.promptHandler === undefined) {
        return;
      }
      await this.promptHandler(message.text);
    });
  }

  public setSession(sessionId: string, handler: ChatPromptHandler): void {
    this.promptHandler = handler;
    void this.view?.webview.postMessage({ type: 'session', sessionId });
  }

  public appendText(text: string): void {
    void this.view?.webview.postMessage({ type: 'text', text });
  }

  private html(): string {
    return `<!DOCTYPE html><html><body><h2>Hermes ACP</h2><div id="session">No session connected.</div><pre id="messages"></pre><form id="form"><textarea id="prompt" rows="4" placeholder="Ask Hermes…"></textarea><button>Send</button></form><script>const vscode=acquireVsCodeApi();const session=document.getElementById('session');const messages=document.getElementById('messages');document.getElementById('form').addEventListener('submit',event=>{event.preventDefault();const prompt=document.getElementById('prompt');const text=prompt.value.trim();if(text){vscode.postMessage({type:'prompt',text});messages.textContent+='You: '+text+'\n';prompt.value='';}});window.addEventListener('message',event=>{const message=event.data;if(message.type==='session'){session.textContent='Session: '+message.sessionId;}if(message.type==='text'){messages.textContent+=message.text;}});</script></body></html>`;
  }
}

function isPromptMessage(value: unknown): value is { type: 'prompt'; text: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'prompt' && typeof (value as { text?: unknown }).text === 'string';
}
