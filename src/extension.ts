import * as vscode from 'vscode';
import { HermesAgentAdapter } from './adapters/HermesAgentAdapter';
import { NodeGitCommandRunner, ChildProcessAcpControllerFactory, VsCodeKeyValueStore, VsCodePermissionPresenter } from './vscode/VsCodeAdapters';
import { PermissionController } from './ui/PermissionController';
import { SessionRegistry } from './services/SessionRegistry';
import { HermesSessionService } from './services/HermesSessionService';
import { GitRepositoryResolver } from './services/GitRepositoryResolver';
import { ChatViewProvider } from './ui/ChatViewProvider';

const CHAT_VIEW_ID = ChatViewProvider.viewType;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes ACP');
  const chatProvider = new ChatViewProvider();
  const permissionController = new PermissionController(new VsCodePermissionPresenter());
  const controllerFactory = new ChildProcessAcpControllerFactory({
    onSessionUpdate: async (notification) => {
      output.appendLine(`session/update: ${notification.update.sessionUpdate}`);
      if (notification.update.sessionUpdate === 'agent_message_chunk' && notification.update.content.type === 'text') {
        chatProvider.appendText(notification.update.content.text);
      }
    },
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
      if (result.kind !== 'resume-failed') {
        const controller = sessionService.controller;
        if (controller !== undefined) {
          chatProvider.setSession(result.sessionId, (text) => controller.prompt(result.sessionId, text));
        }
      }
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
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
    openChatCommand
  );
}

export function deactivate(): void {}
