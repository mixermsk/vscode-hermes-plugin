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
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const chatProvider = new ChatViewProvider({
    mediaUri,
    templateUri: vscode.Uri.joinPath(mediaUri, 'chat.html'),
    stylesheetUri: vscode.Uri.joinPath(mediaUri, 'chat.css'),
    scriptUri: vscode.Uri.joinPath(mediaUri, 'chat.js')
  });
  const permissionController = new PermissionController(new VsCodePermissionPresenter());
  const registry = new SessionRegistry(new VsCodeKeyValueStore(context.globalState));
  const controllerFactory = new ChildProcessAcpControllerFactory({
    onSessionUpdate: async (notification) => {
      output.appendLine(`session/update: ${notification.update.sessionUpdate}`);
      if (notification.update.sessionUpdate === 'agent_message_chunk' && notification.update.content.type === 'text') {
        chatProvider.appendText(notification.update.content.text);
      }
      if (notification.update.sessionUpdate === 'session_info_update' && notification.update.title !== undefined) {
        const title = notification.update.title ?? undefined;
        await registry.setTitle(notification.sessionId, title);
        chatProvider.setSessionTitle(notification.sessionId, title);
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
    registry,
    adapter
  );
  let connection: Promise<void> | undefined;
  const connect = async (): Promise<void> => {
    if (connection !== undefined) {
      return connection;
    }
    connection = (async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) {
      throw new Error('Hermes ACP requires an opened Git repository.');
    }

    try {
      const result = await sessionService.open(workspaceFolder.uri.fsPath);
      const message = result.kind === 'resume-failed'
        ? `Could not resume Hermes session ${result.record.sessionId}. No new session was created.`
        : `${result.kind === 'resumed' ? 'Resumed' : 'Created'} Hermes session ${result.sessionId}.`;
      if (result.kind !== 'resume-failed') {
        const controller = sessionService.controller;
        if (controller !== undefined) {
          chatProvider.setSession(
            result.sessionId,
            (text) => controller.prompt(result.sessionId, text),
            result.kind === 'resumed' ? result.title : undefined
          );
        }
      }
      output.appendLine(message);
      await vscode.window.showInformationMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Connection failed: ${message}`);
      await vscode.window.showErrorMessage(`Hermes ACP connection failed: ${message}`);
      connection = undefined;
      throw error;
    }
    })();
    return connection;
  };
  chatProvider.setConnectionHandler(connect);
  const showChat = (): void => {
    chatProvider.open(() => vscode.window.createWebviewPanel(
      CHAT_VIEW_ID,
      'Hermes',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaUri]
      }
    ));
  };
  const openChatCommand = vscode.commands.registerCommand('hermesAcp.openChat', async () => {
    showChat();
    await connect();
  });

  context.subscriptions.push(
    output,
    openChatCommand
  );
}

export function deactivate(): void {}
