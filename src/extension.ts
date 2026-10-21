import * as vscode from 'vscode';
import { HermesAgentAdapter } from './adapters/HermesAgentAdapter';
import { NodeGitCommandRunner, ChildProcessAcpControllerFactory, VsCodeKeyValueStore, VsCodePermissionPresenter } from './vscode/VsCodeAdapters';
import { PermissionController } from './ui/PermissionController';
import { SessionRegistry } from './services/SessionRegistry';
import { HermesSessionService } from './services/HermesSessionService';
import { GitRepositoryResolver } from './services/GitRepositoryResolver';
import { ChatViewProvider, type ChatTool, type ChatToolContent, type ChatToolLocation } from './ui/ChatViewProvider';

const CHAT_VIEW_ID = ChatViewProvider.viewType;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes ACP');
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const chatProvider = new ChatViewProvider({
    mediaUri,
    templateUri: vscode.Uri.joinPath(mediaUri, 'chat.html'),
    stylesheetUri: vscode.Uri.joinPath(mediaUri, 'chat.css'),
    markedUri: vscode.Uri.joinPath(mediaUri, 'vendor', 'marked.js'),
    domPurifyUri: vscode.Uri.joinPath(mediaUri, 'vendor', 'purify.js'),
    scriptUri: vscode.Uri.joinPath(mediaUri, 'chat.js')
  });
  chatProvider.setLocationHandler(async ({ path, line }) => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  });
  const permissionController = new PermissionController(new VsCodePermissionPresenter());
  const registry = new SessionRegistry(new VsCodeKeyValueStore(context.globalState));
  let connection: Promise<void> | undefined;
  let activeSessionId: string | undefined;
  const controllerFactory = new ChildProcessAcpControllerFactory({
    onSessionUpdate: async (notification) => {
      output.appendLine(`session/update: ${notification.update.sessionUpdate}`);
      if (notification.update.sessionUpdate === 'agent_message_chunk' && notification.update.content.type === 'text') {
        chatProvider.appendText(notification.update.content.text);
      }
      if (notification.update.sessionUpdate === 'user_message_chunk' && notification.update.content.type === 'text') {
        chatProvider.appendUserText(notification.update.content.text);
      }
      if (notification.update.sessionUpdate === 'agent_thought_chunk') {
        chatProvider.setThinking();
      }
      if (notification.update.sessionUpdate === 'tool_call') {
        chatProvider.startTool(toChatTool(notification.update));
      }
      if (notification.update.sessionUpdate === 'tool_call_update') {
        chatProvider.updateTool(notification.update.toolCallId, toChatToolUpdate(notification.update));
      }
      if (notification.update.sessionUpdate === 'session_info_update' && notification.update.title !== undefined) {
        const title = notification.update.title ?? undefined;
        await registry.setTitle(notification.sessionId, title);
        chatProvider.setSessionTitle(notification.sessionId, title);
      }

    },
    onPermissionRequest: (request) => permissionController.requestPermission(request),
    onTransportError: (error) => {
      const message = error.message;
      output.appendLine(`Hermes ACP transport failed: ${message}`);
      connection = undefined;
      activeSessionId = undefined;
      permissionController.setWorkspaceEditAutoApproval(undefined);
      chatProvider.setDisconnected(message);
    }
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
      let result = await sessionService.open(workspaceFolder.uri.fsPath);
      if (result.kind === 'resume-failed') {
        const action = await vscode.window.showErrorMessage(
          `Could not resume Hermes session ${result.record.sessionId}.`,
          'Start New Session'
        );
        if (action !== 'Start New Session') {
          output.appendLine(`Could not resume Hermes session ${result.record.sessionId}. No new session was created.`);
          return;
        }
        result = await sessionService.createNew(workspaceFolder.uri.fsPath);
      }
      const message = `${result.kind === 'resumed' ? 'Resumed' : 'Created'} Hermes session ${result.sessionId}.`;
      const controller = sessionService.controller;
      if (controller !== undefined) {
        activeSessionId = result.sessionId;
        chatProvider.setSession(
          result.sessionId,
          async (text) => {
            output.appendLine(`Sending ${text.length}-character prompt to Hermes session ${result.sessionId}.`);
            await controller.prompt(result.sessionId, text);
            await sessionService.persistSession(result.sessionId);
            output.appendLine(`Hermes prompt completed for session ${result.sessionId}.`);
          },
          result.kind === 'resumed' ? result.title : undefined
        );
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
  chatProvider.setAcceptEditsHandler(async (enabled) => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (activeSessionId === undefined || workspaceFolder === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    permissionController.setWorkspaceEditAutoApproval(enabled ? workspaceFolder.uri.fsPath : undefined);
  });
  const openChatCommand = vscode.commands.registerCommand('hermesAcp.openChat', async () => {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    await connect();
  });

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    openChatCommand
  );
}

export function deactivate(): void {}

function toChatTool(update: Readonly<{
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: unknown;
  locations?: unknown;
}>): ChatTool {
  return {
    toolCallId: update.toolCallId,
    title: update.title,
    ...(update.name == null ? {} : { name: update.name }),
    ...(update.kind == null ? {} : { kind: update.kind }),
    ...(update.status == null ? { status: 'in_progress' } : { status: update.status }),
    ...(update.content === undefined ? {} : { content: normalizeToolContent(update.content) }),
    ...(update.locations === undefined ? {} : { locations: normalizeToolLocations(update.locations) })
  };
}

function toChatToolUpdate(update: Readonly<{
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: unknown;
  locations?: unknown;
}>): Partial<ChatTool> {
  return {
    ...(update.title == null ? {} : { title: update.title }),
    ...(update.name == null ? {} : { name: update.name }),
    ...(update.kind == null ? {} : { kind: update.kind }),
    ...(update.status == null ? {} : { status: update.status }),
    ...(update.content === undefined ? {} : { content: normalizeToolContent(update.content) }),
    ...(update.locations === undefined ? {} : { locations: normalizeToolLocations(update.locations) })
  };
}

function normalizeToolContent(value: unknown): readonly ChatToolContent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ChatToolContent[] => {
    if (!isRecord(item) || typeof item.type !== 'string') {
      return [];
    }
    if (item.type === 'content' && isRecord(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
      return [{ type: 'text', text: item.content.text }];
    }
    if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
      return [{ type: 'diff', path: item.path, ...(typeof item.oldText === 'string' ? { oldText: item.oldText } : {}), newText: item.newText }];
    }
    if (item.type === 'terminal' && typeof item.terminalId === 'string') {
      return [{ type: 'terminal', terminalId: item.terminalId }];
    }
    return [];
  });
}

function normalizeToolLocations(value: unknown): readonly ChatToolLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ChatToolLocation[] => {
    if (!isRecord(item) || typeof item.path !== 'string') {
      return [];
    }
    return [{ path: item.path, ...(typeof item.line === 'number' ? { line: item.line } : {}) }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
