import * as vscode from 'vscode';
import { HermesAgentAdapter } from './adapters/HermesAgentAdapter';
import { NodeGitCommandRunner, ChildProcessAcpControllerFactory, VsCodeKeyValueStore, VsCodePermissionPresenter } from './vscode/VsCodeAdapters';
import { PermissionController } from './ui/PermissionController';
import { SessionRegistry } from './services/SessionRegistry';
import { HermesSessionService } from './services/HermesSessionService';
import { GitRepositoryResolver } from './services/GitRepositoryResolver';

const CHAT_VIEW_ID = 'hermesAcp.chat';

class ChatPlaceholderViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_ID;

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>',
      '<body><h2>Hermes ACP</h2><p>Connecting to the repository session…</p></body>',
      '</html>'
    ].join('');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes ACP');
  const permissionController = new PermissionController(new VsCodePermissionPresenter());
  const controllerFactory = new ChildProcessAcpControllerFactory({
    onSessionUpdate: async (notification) => output.appendLine(`session/update: ${notification.update.sessionUpdate}`),
    onPermissionRequest: (request) => permissionController.requestPermission(request)
  });
  const configuration = vscode.workspace.getConfiguration('hermesAcp');
  const adapter = new HermesAgentAdapter({
    executable: configuration.get<string>('executable', 'hermes'),
    arguments: configuration.get<string[]>('arguments', ['acp']),
    environment: configuration.get<Record<string, string>>('environment', {})
  });
  const sessionService = new HermesSessionService(
    new GitRepositoryResolver(new NodeGitCommandRunner()),
    controllerFactory,
    new SessionRegistry(new VsCodeKeyValueStore(context.globalState)),
    adapter
  );
  const chatProvider = new ChatPlaceholderViewProvider();
  const openChatCommand = vscode.commands.registerCommand('hermesAcp.openChat', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.hermes-acp');
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) {
      await vscode.window.showWarningMessage('Hermes ACP requires an opened Git repository.');
      return;
    }

    try {
      const result = await sessionService.open(workspaceFolder.uri.fsPath);
      const message = result.kind === 'resume-failed'
        ? `Could not resume Hermes session ${result.record.sessionId}. No new session was created.`
        : `${result.kind === 'resumed' ? 'Resumed' : 'Created'} Hermes session ${result.sessionId}.`;
      output.appendLine(message);
      await vscode.window.showInformationMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Connection failed: ${message}`);
      await vscode.window.showErrorMessage(`Hermes ACP connection failed: ${message}`);
    }
  });

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatPlaceholderViewProvider.viewType, chatProvider),
    openChatCommand
  );
}

export function deactivate(): void {}
