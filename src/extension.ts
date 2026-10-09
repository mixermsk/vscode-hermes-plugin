import * as vscode from 'vscode';

const CHAT_VIEW_ID = 'hermesAcp.chat';

class ChatPlaceholderViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_ID;

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: false
    };
    webviewView.webview.html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>',
      '<body><h2>Hermes ACP</h2><p>Chat connection will be added in the next implementation step.</p></body>',
      '</html>'
    ].join('');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const chatProvider = new ChatPlaceholderViewProvider();
  const openChatCommand = vscode.commands.registerCommand('hermesAcp.openChat', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.hermes-acp');
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPlaceholderViewProvider.viewType, chatProvider),
    openChatCommand
  );
}

export function deactivate(): void {
  // No child processes or connections exist in the scaffold.
}
