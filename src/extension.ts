import * as vscode from 'vscode';
import { NodeGitCommandRunner, VsCodeKeyValueStore } from './vscode/VsCodeAdapters';
import { SessionRegistry } from './services/SessionRegistry';
import { GatewaySessionService } from './services/GatewaySessionService';
import { GitRepositoryResolver } from './services/GitRepositoryResolver';
import { canAutoApproveFileEdit } from './services/ApprovalPolicy';
import { LocalHermesGatewayConnectionFactory } from './gateway/GatewayConnectionFactory';
import { HermesGatewayClient, type GatewayApproval } from './gateway/HermesGatewayClient';
import { mergeSubagentSnapshot, parseGatewaySubagentEvent, parseGatewaySubagentList } from './gateway/GatewaySubagentSource';
import type { SubagentSnapshot } from './domain/Subagent';
import { ChatViewProvider } from './ui/ChatViewProvider';

const CHAT_VIEW_ID = ChatViewProvider.viewType;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes Gateway');
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

  const registry = new SessionRegistry(new VsCodeKeyValueStore(context.globalState));
  const gateway = new HermesGatewayClient(new LocalHermesGatewayConnectionFactory());
  const sessionService = new GatewaySessionService(
    new GitRepositoryResolver(new NodeGitCommandRunner()),
    gateway,
    registry
  );
  let connection: Promise<void> | undefined;
  let activeSessionId: string | undefined;
  let activeSessionTitle: string | undefined;
  let autoApproveEditSessionId: string | undefined;
  let approvalDialogOpen = false;
  const streamedSessions = new Set<string>();
  const subagents = new Map<string, SubagentSnapshot>();

  const publishSubagents = (): void => chatProvider.setSubagents([...subagents.values()]);
  const applyGatewaySessionTitle = async (sessionId: string, title: string | undefined): Promise<string | undefined> => {
    if (activeSessionId === sessionId) {
      activeSessionTitle = title;
      chatProvider.setSessionTitle(sessionId, title);
    }
    await registry.setTitle(sessionId, title);
    return title;
  };
  const refreshSubagents = async (sessionId: string): Promise<void> => {
    const snapshot = parseGatewaySubagentList(await gateway.getSubagents(sessionId));
    subagents.clear();
    for (const subagent of snapshot) {
      subagents.set(subagent.id, subagent);
    }
    publishSubagents();
  };
  const refreshModelOptions = async (sessionId: string): Promise<void> => {
    try {
      chatProvider.setModelOptions(await gateway.getModelOptions(sessionId));
    } catch (error) {
      output.appendLine(`Gateway model options failed: ${messageOf(error)}`);
    }
  };
  const refreshReasoning = async (sessionId: string): Promise<void> => {
    try {
      chatProvider.setReasoningEffort(await gateway.getReasoning(sessionId));
    } catch (error) {
      output.appendLine(`Gateway reasoning read failed: ${messageOf(error)}`);
    }
  };
  const applyModelSelection = async (sessionId: string, model: string, provider: string | undefined, confirm?: string): Promise<void> => {
    const outcome = await gateway.setModel(sessionId, model, provider, confirm);
    if (outcome.kind === 'confirmation_required') {
      const choice = await vscode.window.showWarningMessage(outcome.message, { modal: true }, 'Switch model', 'Cancel');
      if (choice === 'Switch model') {
        await applyModelSelection(sessionId, model, provider, outcome.confirm);
        return;
      }
    }
    await refreshModelOptions(sessionId);
  };
  const requestApprovals = async (sessionId: string): Promise<void> => {
    if (approvalDialogOpen || activeSessionId !== sessionId) {
      return;
    }
    approvalDialogOpen = true;
    try {
      const approvals = await gateway.pendingApprovals(sessionId);
      for (const approval of approvals) {
        if (autoApproveEditSessionId === sessionId && canAutoApproveFileEdit(approval)) {
          await respondApproval(gateway, sessionId, approval.requestId, 'session');
        } else {
          await resolveApproval(gateway, sessionId, approval);
        }
      }
    } catch (error) {
      output.appendLine(`Gateway approval handling failed: ${messageOf(error)}`);
    } finally {
      approvalDialogOpen = false;
    }
  };
  const handlePrompt = async (text: string): Promise<void> => {
    if (activeSessionId === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    const command = text.trim();
    if (command === '/new' || command === '/reset') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder === undefined) {
        throw new Error('Hermes Gateway requires an opened Git repository.');
      }
      const session = await sessionService.createNew(workspaceFolder.uri.fsPath);
      activeSessionId = session.sessionId;
      activeSessionTitle = await applyGatewaySessionTitle(activeSessionId, session.title);
      autoApproveEditSessionId = undefined;
      subagents.clear();
      chatProvider.clearTranscript();
      chatProvider.setSession(activeSessionId, handlePrompt, activeSessionTitle);
      chatProvider.setSubagentTrackingStatus({ kind: 'connected', message: 'Gateway connected' });
      await refreshSubagents(activeSessionId);
      await refreshModelOptions(activeSessionId);
      await refreshReasoning(activeSessionId);
      await sessionService.persistSession(activeSessionId, activeSessionTitle);
      return;
    }
    const branchMatch = /^\/branch(?:\s+(.*))?$/.exec(command);
    if (branchMatch !== null) {
      let title = branchMatch[1]?.trim() || undefined;
      if (title === '--here') {
        title = undefined;
      } else if (title?.startsWith('--here ')) {
        title = title.slice('--here '.length).trim() || undefined;
      }
      const session = await gateway.resumeSession(await gateway.branchSession(activeSessionId, title));
      activeSessionId = session.sessionId;
      activeSessionTitle = await applyGatewaySessionTitle(activeSessionId, session.title);
      autoApproveEditSessionId = undefined;
      subagents.clear();
      chatProvider.clearTranscript();
      chatProvider.setSession(activeSessionId, handlePrompt, activeSessionTitle);
      for (const message of session.messages) {
        if (message.role === 'delegation') {
          chatProvider.upsertDelegation({
            subagentId: message.subagentId,
            title: message.title,
            status: message.status,
            summary: message.summary,
            details: message.details
          });
        } else if (message.role === 'user') {
          chatProvider.appendUserText(message.text);
        } else {
          chatProvider.appendText(message.text);
        }
      }
      chatProvider.setSubagentTrackingStatus({ kind: 'connected', message: 'Gateway connected' });
      await refreshSubagents(activeSessionId);
      await refreshModelOptions(activeSessionId);
      await refreshReasoning(activeSessionId);
      await sessionService.persistSession(activeSessionId, activeSessionTitle);
      return;
    }
    if (command.startsWith('/')) {
      const result = await gateway.executeSlashCommand(activeSessionId, command);
      if ('output' in result) {
        chatProvider.appendText(result.output);
      } else {
        await gateway.submitPrompt(activeSessionId, result.prompt);
      }
    } else {
      await gateway.submitPrompt(activeSessionId, text);
    }
    await sessionService.persistSession(activeSessionId, activeSessionTitle);
  };

  gateway.onEvent((event) => {
    if (event.sessionId !== activeSessionId) {
      return;
    }
    if ('payload' in event) {
      const subagent = parseGatewaySubagentEvent({ type: event.type, payload: event.payload });
      if (subagent !== undefined) {
        subagents.set(subagent.id, mergeSubagentSnapshot(subagents.get(subagent.id), subagent));
        publishSubagents();
      }
      return;
    }
    if (event.type === 'approval.request') {
      void requestApprovals(event.sessionId);
      return;
    }
    if (event.type === 'approval.cancelled') {
      output.appendLine('Gateway cancelled a pending approval.');
      return;
    }
    if (event.type === 'message.delta' && event.text !== undefined) {
      streamedSessions.add(event.sessionId);
      chatProvider.appendText(event.text);
      return;
    }
    if (event.type === 'message.complete') {
      if (!streamedSessions.delete(event.sessionId) && event.text !== undefined) {
        chatProvider.appendText(event.text);
      }
      return;
    }
    if (event.type === 'thinking.delta' || event.type === 'reasoning.delta' || event.type === 'status.update') {
      chatProvider.setThinking();
      return;
    }
  });

  const connect = async (): Promise<void> => {
    if (connection !== undefined) {
      return connection;
    }
    connection = (async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder === undefined) {
        throw new Error('Hermes Gateway requires an opened Git repository.');
      }
      try {
        let result = await sessionService.open(workspaceFolder.uri.fsPath);
        if (result.kind === 'resume-failed') {
          const action = await vscode.window.showErrorMessage(
            `Could not resume Hermes session ${result.sessionId}.`,
            'Start New Session'
          );
          if (action !== 'Start New Session') {
            return;
          }
          result = { kind: 'created', session: await sessionService.createNew(workspaceFolder.uri.fsPath) };
        }
        activeSessionId = result.session.sessionId;
        activeSessionTitle = await applyGatewaySessionTitle(activeSessionId, result.session.title);
        if (autoApproveEditSessionId !== activeSessionId) {
          autoApproveEditSessionId = undefined;
        }
        subagents.clear();
        chatProvider.setSession(
          activeSessionId,
          handlePrompt,
          activeSessionTitle
        );
        for (const message of result.session.messages) {
          if (message.role === 'delegation') {
            chatProvider.upsertDelegation({
              subagentId: message.subagentId,
              title: message.title,
              status: message.status,
              summary: message.summary,
              details: message.details
            });
          } else if (message.role === 'user') {
            chatProvider.appendUserText(message.text);
          } else {
            chatProvider.appendText(message.text);
          }
        }
        chatProvider.setSubagentTrackingStatus({ kind: 'connected', message: 'Gateway connected' });
        await refreshSubagents(activeSessionId);
        await refreshModelOptions(activeSessionId);
        await refreshReasoning(activeSessionId);
        void requestApprovals(activeSessionId);
        output.appendLine(`${result.kind === 'resumed' ? 'Resumed' : 'Created'} Gateway session.`);
      } catch (error) {
        const message = messageOf(error);
        output.appendLine(`Gateway connection failed: ${message}`);
        activeSessionId = undefined;
        activeSessionTitle = undefined;
        autoApproveEditSessionId = undefined;
        subagents.clear();
        chatProvider.setDisconnected(message);
        connection = undefined;
        throw error;
      }
    })();
    return connection;
  };

  chatProvider.setConnectionHandler(connect);
  chatProvider.setCancelHandler(async () => {
    if (activeSessionId === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    await gateway.interrupt(activeSessionId);
  });
  chatProvider.setAutoApproveEditsHandler(async (enabled) => {
    if (enabled && activeSessionId === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    autoApproveEditSessionId = enabled ? activeSessionId : undefined;
  });
  chatProvider.setModelSelectionHandler(async (model, provider) => {
    if (activeSessionId === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    await applyModelSelection(activeSessionId, model, provider);
  });
  chatProvider.setReasoningSelectionHandler(async (effort) => {
    if (activeSessionId === undefined) {
      throw new Error('Hermes is not connected. Reopen the chat and try again.');
    }
    await gateway.setReasoning(activeSessionId, effort);
    chatProvider.setReasoningEffort(effort);
  });

  const openChatCommand = vscode.commands.registerCommand('hermesGateway.openChat', async () => {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    await connect();
  });
  const pickSessionCommand = vscode.commands.registerCommand('hermesGateway.pickSession', async () => {
    await connect();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) {
      throw new Error('Hermes Gateway requires an opened Git repository.');
    }
    const sessions = await sessionService.listSessions(workspaceFolder.uri.fsPath);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No saved Hermes sessions exist for this Git repository.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.title ?? `Session ${shortSessionId(session.sessionId)}`,
        description: session.branchAtLastSeen === undefined ? undefined : `Branch: ${session.branchAtLastSeen}`,
        detail: `${new Date(session.lastActiveAt).toLocaleString()} · ${session.sessionId}`,
        sessionId: session.sessionId
      })),
      { placeHolder: 'Switch to a Hermes session for this Git repository' }
    );
    if (picked === undefined || picked.sessionId === activeSessionId) {
      return;
    }
    const session = await sessionService.resume(workspaceFolder.uri.fsPath, picked.sessionId);
    activeSessionId = session.sessionId;
    activeSessionTitle = await applyGatewaySessionTitle(activeSessionId, session.title);
    autoApproveEditSessionId = undefined;
    subagents.clear();
    chatProvider.clearTranscript();
    chatProvider.setSession(activeSessionId, handlePrompt, activeSessionTitle);
    for (const message of session.messages) {
      if (message.role === 'delegation') {
        chatProvider.upsertDelegation({
          subagentId: message.subagentId,
          title: message.title,
          status: message.status,
          summary: message.summary,
          details: message.details
        });
      } else if (message.role === 'user') {
        chatProvider.appendUserText(message.text);
      } else {
        chatProvider.appendText(message.text);
      }
    }
    chatProvider.setSubagentTrackingStatus({ kind: 'connected', message: 'Gateway connected' });
    await refreshSubagents(activeSessionId);
    await refreshModelOptions(activeSessionId);
    await refreshReasoning(activeSessionId);
    await sessionService.persistSession(activeSessionId, activeSessionTitle);
    void requestApprovals(activeSessionId);
  });

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    openChatCommand,
    pickSessionCommand,
    { dispose: () => gateway.dispose() }
  );
}

export function deactivate(): void {}

async function resolveApproval(gateway: HermesGatewayClient, sessionId: string, approval: GatewayApproval): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    approval.description ?? `${approval.toolName ?? 'Hermes'} requests approval.`,
    { modal: true },
    ...approval.choices
  );
  const selected = choice ?? 'deny';
  if (!approval.choices.includes(selected)) {
    return;
  }
  await respondApproval(gateway, sessionId, approval.requestId, selected);
}

async function respondApproval(gateway: HermesGatewayClient, sessionId: string, requestId: string, choice: string): Promise<void> {
  await gateway.respondApproval(sessionId, requestId, choice);
  const remaining = await gateway.pendingApprovals(sessionId);
  if (remaining.some((pending) => pending.requestId === requestId)) {
    throw new Error('Local Hermes Gateway did not resolve the approval.');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}